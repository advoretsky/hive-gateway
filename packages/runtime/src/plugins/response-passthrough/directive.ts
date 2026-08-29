/**
 * Per-subgraph pass-through configuration, read from a composed directive.
 *
 * A subgraph opts into being relayed by declaring, importing (via `@link` from
 * `https://the-guild.dev/mesh/v1.0`) and composing (via `@composeDirective`):
 *
 * ```graphql
 * directive @passthrough(check: [PassthroughCheck!]) on SCHEMA | OBJECT
 * ```
 *
 * The default — no `check` argument — is maximum performance: the gateway
 * relays the subgraph's bytes trusting it for both values and JSON validity.
 * Each named check adds a specific verification back, at a cost:
 *
 * - `JSON`: validate the subgraph's JSON while scanning it, rejecting
 *   everything `JSON.parse` would reject. Costs roughly 27% of the scan;
 *   without it a subgraph that emits broken JSON is relayed verbatim.
 * - `LEAF_VALUES`: decline pass-through when the selection reaches a custom
 *   scalar or an enum carrying `@inaccessible` values, because on the normal
 *   path the gateway would have coerced those leaves (serializing the scalar,
 *   filtering the hidden enum values) and a relay skips that coercion.
 * - `EXACT_FIELDS`: decline pass-through when the gateway's own outgoing
 *   document adds a field the client did not request — an injected
 *   `__typename` on abstract types. Without it those relays are allowed and
 *   the client may receive an extra unaliased `__typename`.
 *
 * In the supergraph, schema-level applications of a composed directive are
 * attributed to their subgraph with `@join__directive(graphs: [...])`, which
 * the supergraph splitter turns back into a plain application on exactly that
 * subgraph's schema. This module therefore reads each subschema's own
 * directive extensions rather than the merged supergraph's, and resolves the
 * `as:` rename case off each subschema's `@link` table the way demand control
 * resolves `@cost`.
 */

import type { StitchingInfo } from '@graphql-tools/delegate';
import { getDirectiveExtensions } from '@graphql-tools/utils';
import type { GraphQLSchema } from 'graphql';

/**
 * Resolves the local name of a `@link`-imported directive, honouring an `as:`
 * rename.
 *
 * Vendored rather than imported: the gateway has an identical helper, but it is
 * internal to the runtime package and not part of its published surface, and
 * this plugin is meant to be liftable into a consuming project with no
 * unresolvable imports.
 */
function urlMatches(url: string, specUrl: string | RegExp): boolean {
  return typeof specUrl === 'string' ? url === specUrl : specUrl.test(url);
}

function normalizeDirectiveName(directiveName: string): string {
  return directiveName.startsWith('@') ? directiveName.slice(1) : directiveName;
}

function getDirectiveNameForFederationDirective({
  schema,
  directiveName,
  specUrl,
}: {
  schema: GraphQLSchema;
  directiveName: string;
  specUrl: string | RegExp;
}): string {
  const onSchemaDef = getDirectiveExtensions<{
    link: { url: string; import: (string | { name: string; as: string })[] };
  }>(schema, schema);
  const wanted = normalizeDirectiveName(directiveName);
  for (const link of onSchemaDef?.['link'] ?? []) {
    if (!urlMatches(link.url, specUrl)) {
      continue;
    }
    for (const imported of link.import ?? []) {
      if (typeof imported === 'string') {
        if (normalizeDirectiveName(imported) === wanted) {
          return wanted;
        }
      } else if (normalizeDirectiveName(imported.name) === wanted) {
        return normalizeDirectiveName(imported.as);
      }
    }
  }
  return wanted;
}

const PASSTHROUGH_CHECKS = ['JSON', 'LEAF_VALUES', 'EXACT_FIELDS'] as const;

export type PassthroughCheck = (typeof PASSTHROUGH_CHECKS)[number];

export interface PassthroughPolicy {
  enabled: boolean;
  checks: ReadonlySet<PassthroughCheck>;
}

/**
 * The directive is published under the Guild mesh spec. Fusion composition
 * rewrites that link to its own `graphql/mesh/spec` URL, so both prefixes
 * count as the same feature when resolving a rename.
 */
const GUILD_MESH_SPEC =
  /^https:\/\/the-guild\.dev\/(mesh|graphql\/mesh\/spec)\//;

function isPassthroughCheck(value: unknown): value is PassthroughCheck {
  return (PASSTHROUGH_CHECKS as readonly unknown[]).includes(value);
}

function collectChecks(
  into: Set<PassthroughCheck>,
  applications: { check?: unknown }[],
): void {
  for (const application of applications) {
    const list = application?.check;
    if (Array.isArray(list)) {
      for (const value of list) {
        // The subgraph's enum already constrains the vocabulary; anything else
        // survived composition by accident and cannot be honoured, so it is
        // dropped rather than allowed to disable the relay wholesale.
        if (isPassthroughCheck(value)) {
          into.add(value);
        }
      }
    }
  }
}

/** Reads `@passthrough` off each subgraph in the supergraph. */
export function readPassthroughDirectives(
  schema: GraphQLSchema,
): Map<string, PassthroughPolicy> {
  const policies = new Map<string, PassthroughPolicy>();
  const stitchingInfo = schema.extensions?.['stitchingInfo'] as
    | StitchingInfo
    | undefined;
  if (!stitchingInfo) {
    return policies;
  }
  for (const subschema of stitchingInfo.subschemaMap.values()) {
    const subgraphName = subschema.name;
    if (!subgraphName) {
      continue;
    }
    const subgraphSchema = subschema.transformedSchema ?? subschema.schema;
    // The subgraph may have imported the directive under another name
    // (`import: [{ name: "@passthrough", as: "@relay" }]`); its own `@link`
    // table says which name its applications actually carry.
    const directiveName = getDirectiveNameForFederationDirective({
      schema: subgraphSchema,
      directiveName: 'passthrough',
      specUrl: GUILD_MESH_SPEC,
    });
    const applications: { check?: unknown }[] = [];
    const schemaLevel =
      getDirectiveExtensions<Record<string, any>>(subgraphSchema)?.[
        directiveName
      ];
    if (Array.isArray(schemaLevel)) {
      applications.push(...schemaLevel);
    }
    // The OBJECT location exists so a subgraph can annotate its root operation
    // types instead of the schema definition; both mean "this subgraph".
    for (const rootType of [
      subgraphSchema.getQueryType(),
      subgraphSchema.getMutationType(),
      subgraphSchema.getSubscriptionType(),
    ]) {
      if (rootType) {
        const onRoot =
          getDirectiveExtensions<Record<string, any>>(rootType)?.[
            directiveName
          ];
        if (Array.isArray(onRoot)) {
          applications.push(...onRoot);
        }
      }
    }
    if (applications.length === 0) {
      continue;
    }
    // A subgraph can appear under several subschema entries; every sighting of
    // the directive contributes to one union of checks for that subgraph.
    const checks = new Set<PassthroughCheck>(
      policies.get(subgraphName)?.checks,
    );
    collectChecks(checks, applications);
    policies.set(subgraphName, { enabled: true, checks });
  }
  return policies;
}

/** The policy for one subgraph, falling back to the plugin's own options. */
export function policyFor(
  subgraphName: string,
  directives: Map<string, PassthroughPolicy>,
  fallback: PassthroughPolicy,
): PassthroughPolicy {
  return directives.get(subgraphName) ?? fallback;
}
