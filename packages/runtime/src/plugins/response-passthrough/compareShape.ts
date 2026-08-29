import {
  createRequest,
  Transformer,
  type DelegationContext,
  type Subschema,
} from '@graphql-tools/delegate';
import {
  getArgumentValues,
  getDefinedRootType,
  getOperationASTFromDocument,
} from '@graphql-tools/utils';
import {
  getNamedType,
  Kind,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLNamedType,
  type GraphQLResolveInfo,
  type GraphQLSchema,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';

/**
 * Proves — rather than guesses — that relaying a subgraph response verbatim
 * would produce exactly what executing the operation would have produced.
 *
 * `checkEligibility` is a screen built from what we know about the gateway;
 * this module asks the gateway itself. It builds the outgoing subgraph document
 * through the very pipeline delegation uses (`createRequest` plus
 * `Transformer#transformRequest`, which runs `prepareGatewayDocument`,
 * subschema transforms and `finalizeGatewayRequest`) and compares the
 * response-key skeleton of the result against the client's selection.
 *
 * Anything the gateway adds — an injected `__typename`, a merge key, a
 * `@provides` selection — or anything it drops shows up as a differing
 * response key and disqualifies the relay. That makes this check the
 * authoritative gate: it stays correct even when the delegation pipeline gains
 * behaviour this plugin knows nothing about.
 */

export interface ShapeComparison {
  matches: boolean;
  /** why it did not match, for the onSkip diagnostic callback */
  mismatch?: string;
  /** maps the subgraph's top-level data key -> the client's response key */
  rootKeyMap?: Map<string, string>;
}

export interface CompareShapeOptions {
  /** The gateway's unified schema — the one the client's document is written against. */
  unifiedSchema: GraphQLSchema;
  /** The client's document, including any fragment definitions it uses. */
  document: DocumentNode;
  /** The operation within `document` that is being executed. */
  operation: OperationDefinitionNode;
  /** The subgraph `checkEligibility` picked to answer the whole operation. */
  subschema: Subschema;
  /** Coerced variable values for this request. */
  variableValues?: Record<string, unknown>;
  /** The GraphQL context, passed through to subschema transforms and override handlers. */
  context?: Record<string, unknown>;
  rootValue?: unknown;
}

/**
 * A selection set reduced to what an observer of the JSON response could see:
 * which keys appear, how they nest, and under which type conditions.
 */
interface ShapeNode {
  /** response key (alias ?? name) -> nested shape, or null for a leaf */
  fields: Map<string, ShapeNode | null>;
  /** type condition name -> shape contributed only for that type */
  conditions: Map<string, ShapeNode>;
}

/** Batch execution prefixes root fields when it merges several requests into one. */
const BATCH_PREFIX = /^_v\d+_/;

/** Signals a shape that could not be built, which is always a decline. */
class ShapeError extends Error {}

function emptyShape(): ShapeNode {
  return { fields: new Map(), conditions: new Map() };
}

function mergeField(
  shape: ShapeNode,
  key: string,
  child: ShapeNode | null,
  path: string,
): void {
  if (!shape.fields.has(key)) {
    shape.fields.set(key, child);
    return;
  }
  const existing = shape.fields.get(key) ?? null;
  if (existing === null || child === null) {
    if (existing !== child) {
      throw new ShapeError(`"${key}" at ${path} is both a leaf and composite`);
    }
    return;
  }
  mergeShape(existing, child, `${path}.${key}`);
}

function mergeShape(target: ShapeNode, source: ShapeNode, path: string): void {
  for (const [key, child] of source.fields) {
    mergeField(target, key, child, path);
  }
  for (const [name, child] of source.conditions) {
    const existing = target.conditions.get(name);
    if (existing) {
      mergeShape(existing, child, `${path} on ${name}`);
    } else {
      target.conditions.set(name, child);
    }
  }
}

function collectShape(
  shape: ShapeNode,
  schema: GraphQLSchema,
  parentType: GraphQLNamedType,
  selectionSet: SelectionSetNode,
  fragments: Record<string, FragmentDefinitionNode>,
  path: string,
  visiting: Set<string>,
): void {
  const fields = 'getFields' in parentType ? parentType.getFields() : undefined;

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const key = selection.alias?.value ?? selection.name.value;
      if (!selection.selectionSet) {
        mergeField(shape, key, null, path);
        continue;
      }
      const field = fields?.[selection.name.value];
      if (!field) {
        throw new ShapeError(
          `unknown field ${parentType.name}.${selection.name.value}`,
        );
      }
      mergeField(
        shape,
        key,
        buildShape(
          schema,
          getNamedType(field.type),
          selection.selectionSet,
          fragments,
          `${path}.${key}`,
          visiting,
        ),
        path,
      );
      continue;
    }

    let conditionName: string | undefined;
    let conditionSet: SelectionSetNode;
    let spreadName: string | undefined;

    if (selection.kind === Kind.INLINE_FRAGMENT) {
      conditionName = selection.typeCondition?.name.value;
      conditionSet = selection.selectionSet;
    } else {
      spreadName = selection.name.value;
      const fragment = fragments[spreadName];
      if (!fragment) {
        throw new ShapeError(`undefined fragment "${spreadName}"`);
      }
      if (visiting.has(spreadName)) {
        throw new ShapeError(`recursive fragment "${spreadName}"`);
      }
      conditionName = fragment.typeCondition.name.value;
      conditionSet = fragment.selectionSet;
    }

    if (spreadName) {
      visiting.add(spreadName);
    }
    try {
      // A fragment whose condition is the enclosing type always applies, so it
      // contributes the same keys as if it had been written inline. Flattening
      // it is what lets a named spread compare equal to a pipeline that
      // inlined it.
      if (conditionName == null || conditionName === parentType.name) {
        collectShape(
          shape,
          schema,
          parentType,
          conditionSet,
          fragments,
          path,
          visiting,
        );
        continue;
      }

      const conditionType = schema.getType(conditionName);
      if (!conditionType) {
        throw new ShapeError(`unknown type condition "${conditionName}"`);
      }
      const child = buildShape(
        schema,
        conditionType,
        conditionSet,
        fragments,
        `${path} on ${conditionName}`,
        visiting,
      );
      const existing = shape.conditions.get(conditionName);
      if (existing) {
        mergeShape(existing, child, `${path} on ${conditionName}`);
      } else {
        shape.conditions.set(conditionName, child);
      }
    } finally {
      if (spreadName) {
        visiting.delete(spreadName);
      }
    }
  }
}

function buildShape(
  schema: GraphQLSchema,
  parentType: GraphQLNamedType,
  selectionSet: SelectionSetNode,
  fragments: Record<string, FragmentDefinitionNode>,
  path: string,
  visiting: Set<string> = new Set(),
): ShapeNode {
  const shape = emptyShape();
  collectShape(
    shape,
    schema,
    parentType,
    selectionSet,
    fragments,
    path,
    visiting,
  );
  return shape;
}

function diffShapes(
  client: ShapeNode,
  outgoing: ShapeNode,
  path: string,
  tolerateAddedTypename = false,
): string | undefined {
  for (const key of outgoing.fields.keys()) {
    if (!client.fields.has(key)) {
      // An added unaliased `__typename` is the one extra key the gateway is
      // allowed to relay when the EXACT_FIELDS check is off: the delegation
      // pipeline injects it for its own bookkeeping, its value is the type
      // name the client could have asked for anyway, and it can only occupy
      // the reserved `__typename` response key. Anything else — an *aliased*
      // `__typename` like the response cache's `__responseCacheTypeName`
      // included — lands under a different key and still declines.
      if (
        tolerateAddedTypename &&
        key === '__typename' &&
        (outgoing.fields.get(key) ?? null) === null
      ) {
        continue;
      }
      return `subgraph document adds "${key}" at ${path}`;
    }
  }
  for (const [key, clientChild] of client.fields) {
    if (!outgoing.fields.has(key)) {
      return `subgraph document drops "${key}" at ${path}`;
    }
    const outgoingChild = outgoing.fields.get(key) ?? null;
    if ((clientChild === null) !== (outgoingChild === null)) {
      return `"${key}" at ${path} changes between leaf and composite`;
    }
    if (clientChild && outgoingChild) {
      const mismatch = diffShapes(
        clientChild,
        outgoingChild,
        `${path}.${key}`,
        tolerateAddedTypename,
      );
      if (mismatch) {
        return mismatch;
      }
    }
  }

  for (const name of outgoing.conditions.keys()) {
    if (!client.conditions.has(name)) {
      return `subgraph document adds a "... on ${name}" at ${path}`;
    }
  }
  for (const [name, clientChild] of client.conditions) {
    const outgoingChild = outgoing.conditions.get(name);
    if (!outgoingChild) {
      return `subgraph document drops the "... on ${name}" at ${path}`;
    }
    const mismatch = diffShapes(
      clientChild,
      outgoingChild,
      `${path} on ${name}`,
      tolerateAddedTypename,
    );
    if (mismatch) {
      return mismatch;
    }
  }

  return undefined;
}

function collectFragments(
  document: DocumentNode,
): Record<string, FragmentDefinitionNode> {
  const fragments: Record<string, FragmentDefinitionNode> = Object.create(null);
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments[definition.name.value] = definition;
    }
  }
  return fragments;
}

const mismatched = (mismatch: string): ShapeComparison => ({
  matches: false,
  mismatch,
});

export function compareShape(options: CompareShapeOptions): ShapeComparison {
  const {
    unifiedSchema,
    document,
    operation,
    subschema,
    variableValues = {},
    context,
    rootValue,
  } = options;

  try {
    const rootType = getDefinedRootType(unifiedSchema, operation.operation);
    const clientFragments = collectFragments(document);
    const fragmentDefinitions = Object.values(clientFragments);
    const rootKeyMap = new Map<string, string>();

    for (const selection of operation.selectionSet.selections) {
      if (selection.kind !== Kind.FIELD) {
        return mismatched('root selection is not a field');
      }

      const fieldName = selection.name.value;
      const clientKey = selection.alias?.value ?? fieldName;
      const rootField = rootType.getFields()[fieldName];
      if (!rootField) {
        return mismatched(`unknown root field "${fieldName}"`);
      }

      const args = getArgumentValues(rootField, selection, variableValues);

      // Mirrors what a proxying resolver hands to `delegateToSchema`; the
      // pipeline reads `info.schema` for stitching metadata and `info.fragments`
      // for the spreads the client used, so both have to be the real ones.
      const info = {
        fieldName,
        fieldNodes: [selection],
        returnType: rootField.type,
        parentType: rootType,
        path: { prev: undefined, key: clientKey, typename: undefined },
        schema: unifiedSchema,
        fragments: clientFragments,
        rootValue,
        operation,
        variableValues,
      } as unknown as GraphQLResolveInfo;

      const transformedSchema = subschema.transformedSchema;
      const targetRootType =
        operation.operation === 'query'
          ? transformedSchema.getQueryType()
          : operation.operation === 'mutation'
            ? transformedSchema.getMutationType()
            : transformedSchema.getSubscriptionType();

      const request = createRequest({
        subgraphName: subschema.name,
        fragments: fragmentDefinitions,
        targetSchema:
          targetRootType?.getFields()[fieldName] == null
            ? subschema.schema
            : transformedSchema,
        rootValue,
        targetOperationName: operation.name?.value,
        targetOperation: operation.operation,
        targetFieldName: fieldName,
        fieldNodes: [selection],
        context,
        info,
        args,
      });

      const delegationContext: DelegationContext = {
        subschema,
        subschemaConfig: subschema,
        targetSchema: subschema.schema,
        operation: operation.operation,
        fieldName,
        args,
        context,
        info,
        returnType: rootField.type,
        transforms: subschema.transforms ?? [],
        transformedSchema,
        skipTypeMerging: false,
      };

      const transformed = new Transformer(delegationContext).transformRequest(
        request,
      );

      const outgoingOperation = transformed.document.definitions.find(
        (definition): definition is OperationDefinitionNode =>
          definition.kind === Kind.OPERATION_DEFINITION,
      );
      if (!outgoingOperation) {
        return mismatched(
          `subgraph document for "${clientKey}" has no operation`,
        );
      }
      const outgoingSelections = outgoingOperation.selectionSet.selections;
      if (outgoingSelections.length !== 1) {
        return mismatched(
          `subgraph document for "${clientKey}" has ${outgoingSelections.length} root selections`,
        );
      }
      const outgoingField = outgoingSelections[0];
      if (outgoingField?.kind !== Kind.FIELD) {
        return mismatched(
          `subgraph root selection for "${clientKey}" is not a field`,
        );
      }

      const outgoingKey =
        outgoingField.alias?.value ?? outgoingField.name.value;
      // Delegation rebuilds the root field without the client's alias, and
      // batching may prefix it. Both are top-level renames only, so they are
      // recorded rather than rejected.
      if (
        outgoingField.name.value.replace(BATCH_PREFIX, '') !== fieldName ||
        outgoingKey.replace(BATCH_PREFIX, '') !== fieldName
      ) {
        return mismatched(
          `subgraph renames root field "${fieldName}" to "${outgoingKey}"`,
        );
      }
      if (rootKeyMap.has(outgoingKey)) {
        return mismatched(`subgraph root key "${outgoingKey}" is not unique`);
      }
      rootKeyMap.set(outgoingKey, clientKey);

      if (!selection.selectionSet || !outgoingField.selectionSet) {
        if (selection.selectionSet || outgoingField.selectionSet) {
          return mismatched(
            `root field "${fieldName}" changes between leaf and composite`,
          );
        }
        continue;
      }

      const subgraphRootType = getDefinedRootType(
        subschema.schema,
        operation.operation,
      );
      const outgoingRootField =
        subgraphRootType.getFields()[outgoingField.name.value];
      if (!outgoingRootField) {
        return mismatched(
          `subgraph has no root field "${outgoingField.name.value}"`,
        );
      }

      const clientShape = buildShape(
        unifiedSchema,
        getNamedType(rootField.type),
        selection.selectionSet,
        clientFragments,
        clientKey,
      );
      const outgoingShape = buildShape(
        subschema.schema,
        getNamedType(outgoingRootField.type),
        outgoingField.selectionSet,
        collectFragments(transformed.document),
        clientKey,
      );

      const mismatch = diffShapes(clientShape, outgoingShape, clientKey);
      if (mismatch) {
        return mismatched(mismatch);
      }
    }

    if (rootKeyMap.size === 0) {
      return mismatched('operation selects no root fields');
    }

    return { matches: true, rootKeyMap };
  } catch (error) {
    // Building the outgoing document is the gateway's own code path; if it
    // throws for this operation we simply cannot prove anything about it.
    return mismatched(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Compares the document the subgraph is *actually* being sent against what the
 * client asked for.
 *
 * `compareShape` predicts the outgoing document by running the delegation
 * pipeline itself, which proves what the gateway alone would send. It cannot
 * account for plugins that rewrite the document afterwards — the response cache
 * injects `__responseCacheTypeName` aliases that way, and their values would be
 * relayed to the client as though they had been requested.
 *
 * So the real request is checked again here, at the last moment before its
 * response is committed to. This is deliberately generic: it does not know
 * about any particular plugin, only that the outgoing document must still ask
 * for exactly what the client asked for.
 */
export function compareOutgoingShape(options: {
  unifiedSchema: GraphQLSchema;
  subgraphSchema: GraphQLSchema;
  clientDocument: DocumentNode;
  clientOperation: OperationDefinitionNode;
  outgoingDocument: DocumentNode;
  outgoingOperationName?: string;
  /** outgoing root response key -> client root response key */
  outgoingKeyMap: Map<string, string>;
  /**
   * Accept one added unaliased `__typename` per level instead of declining.
   * Set when the subgraph's `EXACT_FIELDS` check is off; every other added
   * key still declines unconditionally.
   */
  tolerateAddedTypename?: boolean;
}): string | undefined {
  const {
    unifiedSchema,
    subgraphSchema,
    clientDocument,
    clientOperation,
    outgoingDocument,
    outgoingOperationName,
    outgoingKeyMap,
    tolerateAddedTypename = false,
  } = options;

  try {
    const outgoingOperation = getOperationASTFromDocument(
      outgoingDocument,
      outgoingOperationName,
    );
    if (!outgoingOperation) {
      return 'outgoing document has no operation';
    }

    const clientRootType = getDefinedRootType(
      unifiedSchema,
      clientOperation.operation,
    );
    const subgraphRootType = getDefinedRootType(
      subgraphSchema,
      outgoingOperation.operation,
    );
    const clientFragments = collectFragments(clientDocument);
    const outgoingFragments = collectFragments(outgoingDocument);

    const clientByKey = new Map<string, FieldNode>();
    for (const selection of clientOperation.selectionSet.selections) {
      if (selection.kind !== Kind.FIELD) {
        return 'client operation root selection is not a field';
      }
      clientByKey.set(
        selection.alias?.value ?? selection.name.value,
        selection,
      );
    }

    for (const selection of outgoingOperation.selectionSet.selections) {
      if (selection.kind !== Kind.FIELD) {
        return 'outgoing root selection is not a field';
      }
      const outgoingKey = selection.alias?.value ?? selection.name.value;
      const clientKey = outgoingKeyMap.get(outgoingKey);
      if (clientKey === undefined) {
        return `outgoing document adds root field "${outgoingKey}"`;
      }
      const clientField = clientByKey.get(clientKey);
      if (!clientField) {
        return `outgoing root field "${outgoingKey}" has no client counterpart`;
      }

      if (!selection.selectionSet || !clientField.selectionSet) {
        if (selection.selectionSet || clientField.selectionSet) {
          return `root field "${outgoingKey}" changes between leaf and composite`;
        }
        continue;
      }

      const clientRootField =
        clientRootType.getFields()[clientField.name.value];
      const outgoingRootField =
        subgraphRootType.getFields()[selection.name.value];
      if (!clientRootField || !outgoingRootField) {
        return `root field "${outgoingKey}" is not defined on both schemas`;
      }

      const clientShape = buildShape(
        unifiedSchema,
        getNamedType(clientRootField.type),
        clientField.selectionSet,
        clientFragments,
        clientKey,
      );
      const outgoingShape = buildShape(
        subgraphSchema,
        getNamedType(outgoingRootField.type),
        selection.selectionSet,
        outgoingFragments,
        clientKey,
      );

      const mismatch = diffShapes(
        clientShape,
        outgoingShape,
        clientKey,
        tolerateAddedTypename,
      );
      if (mismatch) {
        return mismatch;
      }
    }

    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
