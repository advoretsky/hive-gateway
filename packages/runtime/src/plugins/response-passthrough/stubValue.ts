import {
  isAbstractType,
  isEnumType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  Kind,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLScalarType,
  type GraphQLSchema,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';

/**
 * Synthesizes the smallest value that lets graphql-js complete a selection
 * set with ZERO errors.
 *
 * The pass-through stub used to null every root field, which trips graphql's
 * non-null completion for fields like `products: [Product!]!`. Those
 * self-inflicted violations were indistinguishable from real errors, so the
 * plugin had to discard `result.errors` wholesale whenever it kept the
 * subgraph bytes — silently dropping errors that other plugins (an
 * authorization check, most painfully) attached to the result on purpose.
 *
 * A stub that satisfies nullability produces no errors at all, so any error
 * that does appear on the result is real *by construction* and the plugin can
 * simply decline the relay instead of guessing provenance.
 *
 * The cheapest valid value at each position, mirroring what `completeValue`
 * demands:
 *
 *  - nullable anything -> `null` (always valid, ends the recursion);
 *  - non-null list -> `[]` (satisfies the list without owing any items);
 *  - non-null scalar/enum -> a placeholder its `serialize` accepts;
 *  - non-null object -> an object with every selected field satisfied;
 *  - non-null interface/union -> one possible concrete type, announced via
 *    `__typename` so `defaultTypeResolver` can identify it.
 */

/**
 * Distinguishes "this position is validly null" from "no valid value exists".
 * A plain `null` cannot carry that difference — for a non-null field it is a
 * failure, for a nullable one it is the answer — so failure propagates as a
 * sentinel and each public entry point maps it to its own decline value.
 */
const FAILED = Symbol('response-passthrough-stub-failed');

/**
 * Recursion only continues through chains of selected non-null object fields,
 * so real queries stay shallow; the bound exists for the degenerate case (a
 * self-referential non-null type selected very deep, or an adversarial
 * document) where declining beats unbounded work. Deliberately above any
 * plausible legitimate selection depth.
 */
const MAX_DEPTH = 32;

const encoder = new TextEncoder();

/**
 * Matched by name rather than by identity against the spec scalar singletons:
 * the schema may have been built by a different graphql module instance
 * (dual-package installs), and the names are reserved by the spec anyway.
 */
function scalarPlaceholder(scalar: GraphQLScalarType): unknown | typeof FAILED {
  switch (scalar.name) {
    case 'Int':
    case 'Float':
      return 0;
    case 'Boolean':
      return false;
    case 'String':
    case 'ID':
      return '';
    default:
      // A custom scalar in a non-nullable position cannot be satisfied: the
      // schema may carry a real `serialize` that rejects whatever we invent,
      // and a stub that fails to complete would raise an error the plugin is
      // entitled to read as the subgraph's. There is no value we can prove is
      // acceptable, so decline instead of guessing.
      //
      // Nullable custom scalars never reach here — `null` satisfies them and
      // `serialize` is not called.
      return FAILED;
  }
}

/**
 * Whether a fragment conditioned on `conditionName` applies to a value whose
 * runtime type is `objectType` — same question the executor asks, so a field
 * is synthesized exactly when execution would try to complete it.
 */
function conditionApplies(
  schema: GraphQLSchema,
  conditionName: string,
  objectType: GraphQLObjectType,
): boolean {
  if (conditionName === objectType.name) {
    return true;
  }
  const conditionType = schema.getType(conditionName);
  return (
    conditionType != null &&
    isAbstractType(conditionType) &&
    schema.isSubType(conditionType, objectType)
  );
}

/**
 * The same field name selected twice (different aliases, or repeated) is one
 * property on the source object, and the executor completes each occurrence's
 * sub-selection against that one value — so the value has to satisfy the
 * union of all of them.
 */
function mergeSelectionSets(
  nodes: readonly FieldNode[],
): SelectionSetNode | undefined {
  const sets: SelectionSetNode[] = [];
  for (const node of nodes) {
    if (node.selectionSet) {
      sets.push(node.selectionSet);
    }
  }
  if (sets.length === 0) {
    return undefined;
  }
  if (sets.length === 1) {
    return sets[0];
  }
  return {
    kind: Kind.SELECTION_SET,
    selections: sets.flatMap((set) => set.selections),
  };
}

function synthesizeObject(
  schema: GraphQLSchema,
  objectType: GraphQLObjectType,
  selectionSet: SelectionSetNode,
  fragments: Record<string, FragmentDefinitionNode>,
  visiting: Set<string>,
  depth: number,
  // Abstract positions always need `__typename`: `defaultTypeResolver` reads
  // it off the value to find the runtime type, selected or not.
  forceTypename: boolean,
): Record<string, unknown> | typeof FAILED {
  const fieldNodes = new Map<string, FieldNode[]>();
  let wantsTypename = forceTypename;

  function collect(set: SelectionSetNode): true | typeof FAILED {
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        const name = selection.name.value;
        if (name === '__typename') {
          wantsTypename = true;
          continue;
        }
        if (name.startsWith('__')) {
          // __schema / __type are answered by the executor from the schema,
          // never read from the source value.
          continue;
        }
        const group = fieldNodes.get(name);
        if (group) {
          group.push(selection);
        } else {
          fieldNodes.set(name, [selection]);
        }
        continue;
      }

      let conditionName: string | undefined;
      let subSelections: SelectionSetNode;
      let spreadName: string | undefined;
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        conditionName = selection.typeCondition?.name.value;
        subSelections = selection.selectionSet;
      } else {
        spreadName = selection.name.value;
        const fragment = fragments[spreadName];
        // An undefined or cyclic spread means the document is not one we can
        // reason about; validation forbids both, but this runs on documents
        // we did not validate ourselves.
        if (!fragment || visiting.has(spreadName)) {
          return FAILED;
        }
        conditionName = fragment.typeCondition.name.value;
        subSelections = fragment.selectionSet;
      }

      if (
        conditionName != null &&
        !conditionApplies(schema, conditionName, objectType)
      ) {
        // The executor skips this fragment for our chosen runtime type, so
        // its fields never need values.
        continue;
      }

      if (spreadName) {
        visiting.add(spreadName);
      }
      try {
        if (collect(subSelections) === FAILED) {
          return FAILED;
        }
      } finally {
        if (spreadName) {
          visiting.delete(spreadName);
        }
      }
    }
    return true;
  }

  if (collect(selectionSet) === FAILED) {
    return FAILED;
  }

  const value: Record<string, unknown> = {};
  if (wantsTypename) {
    value['__typename'] = objectType.name;
  }
  const fields = objectType.getFields();
  for (const [name, nodes] of fieldNodes) {
    const field = fields[name];
    if (!field) {
      return FAILED;
    }
    // Keyed by field NAME, not response key: `defaultFieldResolver` reads
    // `source[fieldName]`, and the alias only names the output slot.
    const fieldValue = synthesize(
      schema,
      field.type,
      mergeSelectionSets(nodes),
      fragments,
      visiting,
      depth + 1,
    );
    if (fieldValue === FAILED) {
      return FAILED;
    }
    value[name] = fieldValue;
  }
  return value;
}

function synthesize(
  schema: GraphQLSchema,
  type: GraphQLOutputType,
  selectionSet: SelectionSetNode | undefined,
  fragments: Record<string, FragmentDefinitionNode>,
  visiting: Set<string>,
  depth: number,
): unknown {
  if (!isNonNullType(type)) {
    return null;
  }
  if (depth > MAX_DEPTH) {
    return FAILED;
  }
  const inner = type.ofType;
  if (isListType(inner)) {
    // An empty list satisfies any list type without owing a single item, so
    // the item type — however deeply non-null — never has to be produced.
    return [];
  }
  if (isScalarType(inner)) {
    return scalarPlaceholder(inner);
  }
  if (isEnumType(inner)) {
    const first = inner.getValues()[0];
    return first ? first.value : FAILED;
  }
  if (isObjectType(inner)) {
    if (!selectionSet) {
      return FAILED;
    }
    return synthesizeObject(
      schema,
      inner,
      selectionSet,
      fragments,
      visiting,
      depth,
      false,
    );
  }
  if (isAbstractType(inner)) {
    if (!selectionSet) {
      return FAILED;
    }
    // Any possible type will do — the executor only checks that the value's
    // `__typename` names one of them. An abstract type with no possible
    // types has no valid non-null value at all.
    const concrete = schema.getPossibleTypes(inner)[0];
    if (!concrete) {
      return FAILED;
    }
    return synthesizeObject(
      schema,
      concrete,
      selectionSet,
      fragments,
      visiting,
      depth,
      true,
    );
  }
  return FAILED;
}

/**
 * The smallest value for one position that completes without errors, or
 * `null` when none exists (a depth-guard hit, a cyclic spread, an abstract
 * type with no possible types). For a nullable position `null` IS the valid
 * answer, so a caller that must distinguish failure should use
 * `synthesizeStubBody`, which declines explicitly.
 */
export function synthesizeStubValue(
  schema: GraphQLSchema,
  type: GraphQLOutputType,
  selectionSet: SelectionSetNode | undefined,
  fragments: Record<string, FragmentDefinitionNode>,
): unknown {
  const value = synthesize(schema, type, selectionSet, fragments, new Set(), 0);
  return value === FAILED ? null : value;
}

/**
 * The whole stub response body for an operation: `{"data":{...}}` with one
 * synthesized value per root selection, emitted under the key
 * `keyByClientKey` dictates (the subgraph body's key, which may carry a batch
 * prefix or drop a client alias). Returns `undefined` when any root value
 * cannot be synthesized — the caller then declines the relay instead of
 * arming a stub that would produce errors.
 */
export function synthesizeStubBody(
  schema: GraphQLSchema,
  operation: OperationDefinitionNode,
  fragments: Record<string, FragmentDefinitionNode>,
  /** client response key -> the key to emit it under in the subgraph body */
  keyByClientKey: Map<string, string>,
): Uint8Array | undefined {
  const rootType =
    operation.operation === 'query'
      ? schema.getQueryType()
      : operation.operation === 'mutation'
        ? schema.getMutationType()
        : schema.getSubscriptionType();
  if (!rootType) {
    return undefined;
  }
  const rootFields = rootType.getFields();
  // Null prototype so a key like "toString" cannot collide with Object.prototype
  // in the duplicate check below.
  const data: Record<string, unknown> = Object.create(null);
  for (const selection of operation.selectionSet.selections) {
    if (selection.kind !== Kind.FIELD) {
      return undefined;
    }
    const clientKey = selection.alias?.value ?? selection.name.value;
    const emitKey = keyByClientKey.get(clientKey);
    if (emitKey === undefined || emitKey in data) {
      return undefined;
    }
    if (selection.name.value === '__typename') {
      data[emitKey] = rootType.name;
      continue;
    }
    const field = rootFields[selection.name.value];
    if (!field) {
      return undefined;
    }
    const value = synthesize(
      schema,
      field.type,
      selection.selectionSet,
      fragments,
      new Set(),
      0,
    );
    if (value === FAILED) {
      return undefined;
    }
    data[emitKey] = value;
  }
  return encoder.encode(JSON.stringify({ data }));
}
