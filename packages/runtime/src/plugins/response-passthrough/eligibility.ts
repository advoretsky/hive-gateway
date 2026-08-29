import {
  extractUnavailableFieldsFromSelectionSet,
  type StitchingInfo,
  type Subschema,
} from '@graphql-tools/delegate';
import {
  getDefinedRootType,
  getOperationASTFromDocument,
} from '@graphql-tools/utils';
import {
  getNamedType,
  isAbstractType,
  isEnumType,
  isScalarType,
  Kind,
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLNamedType,
  type GraphQLSchema,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';
import type { PassthroughCheck } from './directive';

/**
 * Decides whether an operation's response can be relayed from a single
 * subgraph without the gateway deserializing, walking and re-serializing it.
 *
 * The check is deliberately one-sided: it must never say "eligible" for an
 * operation the gateway would have contributed something to, but it is free to
 * say "not eligible" whenever it cannot prove otherwise. Every unproven case is
 * a decline, because the failure mode of a wrong answer here is not an error —
 * it is a silently incorrect response served to a client.
 *
 * It is also not the last line of defence. The caller is expected to build the
 * outgoing document through the normal pipeline and compare its response-key
 * shape before actually relaying anything; see `compareResponseShape`.
 */

export type IneligibleReason =
  | 'not-a-query'
  | 'multiple-operations'
  | 'incremental-delivery'
  | 'no-root-fields'
  | 'root-field-not-owned'
  | 'root-fields-span-subgraphs'
  | 'not-enabled-by-config'
  | 'gateway-side-resolver'
  | 'abstract-type-in-selection'
  | 'fields-missing-from-subgraph'
  | 'dynamic-selection-set'
  | 'merged-type-dependency'
  | 'custom-scalar-serializer'
  | 'inaccessible-enum-value'
  | 'subschema-transforms';

export interface EligibilityDecision {
  eligible: boolean;
  reason?: IneligibleReason;
  /** The single subgraph that would answer the whole operation. */
  subschema?: Subschema;
  /** Root field response keys, in the order the client asked for them. */
  responseKeys?: string[];
}

export interface EligibilityOptions {
  /**
   * Consulted once per root field, with the subgraph that would answer it.
   * Every root field must be allowed for the operation to be relayed.
   */
  isEnabled?(payload: {
    subgraphName: string;
    typeName: string;
    fieldName: string;
    operationName?: string;
  }): boolean;
  /**
   * The `@passthrough` checks in force for a subgraph. Consulted once, for
   * the subgraph that would answer the operation: without `LEAF_VALUES` the
   * custom-scalar and `@inaccessible`-enum declines are waived, because the
   * subgraph declared its leaves safe to relay uncoerced. When absent, every
   * check runs — direct callers that never read the directive stay on the
   * conservative side.
   */
  checksFor?(subgraphName: string): ReadonlySet<PassthroughCheck>;
}

const EMPTY_SELECTION_SET: SelectionSetNode = {
  kind: Kind.SELECTION_SET,
  selections: [],
};

const eligibleFor = (
  subschema: Subschema,
  responseKeys: string[],
): EligibilityDecision => ({ eligible: true, subschema, responseKeys });

const ineligible = (reason: IneligibleReason): EligibilityDecision => ({
  eligible: false,
  reason,
});

function collectFragments(document: DocumentNode) {
  const fragments: Record<string, FragmentDefinitionNode> = {};
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments[definition.name.value] = definition;
    }
  }
  return fragments;
}

function hasIncrementalDirective(document: DocumentNode): boolean {
  let found = false;
  JSON.stringify(document, (key, value) => {
    if (found) {
      return undefined;
    }
    if (
      key === 'name' &&
      value &&
      typeof value === 'object' &&
      'value' in value &&
      (value.value === 'defer' || value.value === 'stream')
    ) {
      found = true;
    }
    return value;
  });
  return found;
}

/**
 * Walks every type reachable through a selection set, reporting the first one
 * that would make a relayed response differ from an executed one.
 *
 * Custom scalars matter because the stitching runtime coerces every leaf twice
 * — `parseValue` inbound and `serialize` outbound — so a scalar that actually
 * transforms its value would render differently if the bytes were relayed.
 * Enums matter because the subgraph, not the client, chooses the value, and an
 * `@inaccessible` member is nulled during projection today.
 */
function findLeafHazard(
  schema: GraphQLSchema,
  type: GraphQLNamedType,
  selectionSet: SelectionSetNode,
  fragments: Record<string, FragmentDefinitionNode>,
  checkLeafValues: boolean,
  seen = new Set<string>(),
): IneligibleReason | undefined {
  const named = getNamedType(type);

  if (isAbstractType(named)) {
    return 'abstract-type-in-selection';
  }

  if (isScalarType(named)) {
    if (!checkLeafValues) {
      // The subgraph opted out of LEAF_VALUES: it vouches that its scalars
      // serialize to what it already emitted.
      return undefined;
    }
    const isBuiltIn = ['String', 'Int', 'Float', 'Boolean', 'ID'].includes(
      named.name,
    );
    // A custom scalar is only safe when serialization is the identity, which we
    // cannot inspect — so treat every custom scalar as a hazard.
    return isBuiltIn ? undefined : 'custom-scalar-serializer';
  }

  if (isEnumType(named)) {
    if (!checkLeafValues) {
      // Same waiver: an @inaccessible member the subgraph emits anyway is the
      // subgraph's own declared risk.
      return undefined;
    }
    for (const value of named.getValues()) {
      const directives = value.astNode?.directives;
      if (directives?.some((d) => d.name.value === 'inaccessible')) {
        return 'inaccessible-enum-value';
      }
    }
    return undefined;
  }

  if (!('getFields' in named)) {
    return undefined;
  }

  const fields = named.getFields();

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (selection.name.value === '__typename') {
        continue;
      }
      const field = fields[selection.name.value];
      if (!field) {
        return 'fields-missing-from-subgraph';
      }
      const fieldType = getNamedType(field.type);
      // Every selection is walked, even a second selection of a field already
      // seen: sibling selections of the same field can request different
      // subfields, so skipping one would leave its leaves unchecked. The
      // document is a finite tree, so field recursion terminates on its own;
      // only fragment spreads can cycle, and they are guarded below.
      const hazard = findLeafHazard(
        schema,
        fieldType,
        selection.selectionSet ?? EMPTY_SELECTION_SET,
        fragments,
        checkLeafValues,
        seen,
      );
      if (hazard) {
        return hazard;
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      // Any inline fragment implies an abstract parent in practice; the
      // abstract-type check above already rejects those, but a fragment on the
      // same concrete type is harmless and still walked.
      const conditionName = selection.typeCondition?.name.value;
      const conditionType = conditionName
        ? schema.getType(conditionName)
        : named;
      if (!conditionType) {
        return 'fields-missing-from-subgraph';
      }
      const hazard = findLeafHazard(
        schema,
        conditionType,
        selection.selectionSet,
        fragments,
        checkLeafValues,
        seen,
      );
      if (hazard) {
        return hazard;
      }
    } else {
      const fragmentName = selection.name.value;
      const fragment = fragments[fragmentName];
      if (!fragment) {
        return 'fields-missing-from-subgraph';
      }
      const conditionType = schema.getType(fragment.typeCondition.name.value);
      if (!conditionType) {
        return 'fields-missing-from-subgraph';
      }
      // Fragment spreads are the only way this walk can cycle. A cyclic
      // document is invalid GraphQL and would be rejected before reaching us,
      // but refusing to recurse costs nothing and cannot hang a request.
      if (seen.has(fragmentName)) {
        continue;
      }
      seen.add(fragmentName);
      const hazard = findLeafHazard(
        schema,
        conditionType,
        fragment.selectionSet,
        fragments,
        checkLeafValues,
        seen,
      );
      seen.delete(fragmentName);
      if (hazard) {
        return hazard;
      }
    }
  }

  return undefined;
}

/** True when any type reachable from `typeName` carries stitching metadata. */
function hasMergeMetadata(
  stitchingInfo: StitchingInfo,
  typeName: string,
  subschema: Subschema,
): boolean {
  if (stitchingInfo.dynamicSelectionSetsByField[typeName]) {
    return true;
  }
  if (stitchingInfo.fieldNodesByType[typeName]?.length) {
    return true;
  }
  const merged = stitchingInfo.mergedTypes[typeName];
  if (merged) {
    if (merged.fieldSelectionSets?.get(subschema)) {
      return true;
    }
    if (merged.providedSelectionsByField?.get(subschema)) {
      return true;
    }
  }
  return false;
}

/** Collects every named composite type reachable through a selection set. */
function reachableTypeNames(
  schema: GraphQLSchema,
  type: GraphQLNamedType,
  selectionSet: SelectionSetNode,
  fragments: Record<string, FragmentDefinitionNode>,
  out = new Set<string>(),
): Set<string> {
  const named = getNamedType(type);
  if (!('getFields' in named)) {
    return out;
  }
  if (out.has(named.name)) {
    return out;
  }
  out.add(named.name);
  const fields = named.getFields();
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (!selection.selectionSet) {
        continue;
      }
      const field = fields[selection.name.value];
      if (!field) {
        continue;
      }
      reachableTypeNames(
        schema,
        getNamedType(field.type),
        selection.selectionSet,
        fragments,
        out,
      );
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      const conditionName = selection.typeCondition?.name.value;
      const conditionType = conditionName
        ? schema.getType(conditionName)
        : named;
      if (conditionType) {
        reachableTypeNames(
          schema,
          conditionType,
          selection.selectionSet,
          fragments,
          out,
        );
      }
    } else {
      const fragment = fragments[selection.name.value];
      if (fragment) {
        const conditionType = schema.getType(fragment.typeCondition.name.value);
        if (conditionType) {
          reachableTypeNames(
            schema,
            conditionType,
            fragment.selectionSet,
            fragments,
            out,
          );
        }
      }
    }
  }
  return out;
}

export function checkEligibility(
  unifiedSchema: GraphQLSchema,
  document: DocumentNode,
  operationName: string | undefined,
  options: EligibilityOptions = {},
): EligibilityDecision {
  const operations = document.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION,
  );
  if (operations.length !== 1) {
    return ineligible('multiple-operations');
  }

  const operation = getOperationASTFromDocument(document, operationName);
  if (!operation || operation.operation !== 'query') {
    return ineligible('not-a-query');
  }

  if (hasIncrementalDirective(document)) {
    return ineligible('incremental-delivery');
  }

  const stitchingInfo = unifiedSchema.extensions?.['stitchingInfo'] as
    | StitchingInfo
    | undefined;
  if (!stitchingInfo) {
    return ineligible('root-field-not-owned');
  }

  // The gate reports the operation's own name when the client did not name it
  // in the request, so a predicate can match on it either way.
  const gateOperationName = operationName ?? operation.name?.value;

  const rootType = getDefinedRootType(unifiedSchema, operation.operation);
  const fragments = collectFragments(document);
  const subschemas = [...stitchingInfo.subschemaMap.values()];

  let chosen: Subschema | undefined;
  const responseKeys: string[] = [];

  for (const selection of operation.selectionSet.selections) {
    // Fragments and inline fragments at the root would need the same handling
    // as fields but are vanishingly rare; decline rather than special-case.
    if (selection.kind !== Kind.FIELD) {
      return ineligible('abstract-type-in-selection');
    }

    const fieldName = selection.name.value;
    if (fieldName.startsWith('__')) {
      return ineligible('root-field-not-owned');
    }

    const rootField = rootType.getFields()[fieldName];
    if (!rootField) {
      return ineligible('root-field-not-owned');
    }

    // A root field is statically bound to one subgraph only when exactly one
    // declares it. With several, the gateway scores candidates per request
    // against live context; that is not worth reproducing.
    const owners = subschemas.filter((subschema) => {
      const schema = subschema.transformedSchema ?? subschema.schema;
      const subRoot = schema.getType(rootType.name);
      return (
        subRoot != null &&
        'getFields' in subRoot &&
        subRoot.getFields()[fieldName] != null
      );
    });
    if (owners.length !== 1) {
      return ineligible(
        owners.length === 0 ? 'root-field-not-owned' : 'root-field-not-owned',
      );
    }
    const owner = owners[0]!;

    if (
      options.isEnabled?.({
        subgraphName: owner.name ?? '',
        typeName: rootType.name,
        fieldName,
        operationName: gateOperationName,
      }) === false
    ) {
      return ineligible('not-enabled-by-config');
    }

    if (chosen && chosen !== owner) {
      return ineligible('root-fields-span-subgraphs');
    }
    chosen = owner;

    responseKeys.push(selection.alias?.value ?? fieldName);
  }

  if (!chosen || responseKeys.length === 0) {
    return ineligible('no-root-fields');
  }

  // Subschema transforms rewrite requests and results in ways this path cannot
  // reproduce; their mere presence is a reason to decline.
  if (chosen.transforms?.length) {
    return ineligible('subschema-transforms');
  }

  const subgraphSchema = chosen.transformedSchema ?? chosen.schema;

  // The leaf-value hazards are the subgraph's to waive: its `@passthrough`
  // directive (or the plugin's fallback) says whether LEAF_VALUES runs.
  const checkLeafValues =
    options.checksFor?.(chosen.name ?? '').has('LEAF_VALUES') ?? true;

  for (const selection of operation.selectionSet.selections) {
    if (selection.kind !== Kind.FIELD) {
      continue;
    }
    const rootField = rootType.getFields()[selection.name.value]!;
    const namedReturn = getNamedType(rootField.type);

    if (!selection.selectionSet) {
      // A root field returning a leaf. It has no sub-selection to compare, but
      // its own type still decides whether the subgraph's raw value is what the
      // client would have been served. The type must be resolved against the
      // SUBGRAPH schema: the unified schema has already had `@inaccessible`
      // enum values filtered out of it, so it cannot reveal that the subgraph
      // is able to answer with one.
      const subgraphLeaf = subgraphSchema.getType(namedReturn.name);
      if (!subgraphLeaf) {
        return ineligible('fields-missing-from-subgraph');
      }
      const leafHazard = findLeafHazard(
        subgraphSchema,
        subgraphLeaf,
        EMPTY_SELECTION_SET,
        fragments,
        checkLeafValues,
      );
      if (leafHazard) {
        return ineligible(leafHazard);
      }
      continue;
    }

    const subgraphReturn = subgraphSchema.getType(namedReturn.name);
    if (!subgraphReturn) {
      return ineligible('fields-missing-from-subgraph');
    }

    // Cheap structural screen first: anything reported missing definitely
    // requires merging.
    const unavailable = extractUnavailableFieldsFromSelectionSet(
      subgraphSchema,
      subgraphReturn as never,
      selection.selectionSet,
      () => true,
      fragments,
    );
    if (unavailable.length) {
      return ineligible('fields-missing-from-subgraph');
    }

    // Note: this module only screens. It never authorises a relay on its own —
    // the caller must still build the outgoing document through the real
    // pipeline and compare its response-key shape (see `compareShape`). That
    // comparison is what actually proves the subgraph is asked for exactly
    // what the client asked for.
    const hazard = findLeafHazard(
      subgraphSchema,
      subgraphReturn,
      selection.selectionSet,
      fragments,
      checkLeafValues,
    );
    if (hazard) {
      return ineligible(hazard);
    }

    for (const typeName of reachableTypeNames(
      unifiedSchema,
      namedReturn,
      selection.selectionSet,
      fragments,
    )) {
      if (hasMergeMetadata(stitchingInfo, typeName, chosen)) {
        return ineligible('merged-type-dependency');
      }
    }
  }

  return eligibleFor(chosen, responseKeys);
}
