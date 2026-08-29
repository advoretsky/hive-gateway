import { createGatewayTester } from '@graphql-hive/gateway-testing';
import { GraphQLSchema } from 'graphql';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  policyFor,
  readPassthroughDirectives,
  type PassthroughPolicy,
} from '../src/plugins/response-passthrough/directive';
import { normalizeOptions } from '../src/plugins/response-passthrough/options';

/**
 * A composed schema-level directive reaches the supergraph attributed to its
 * subgraph as `@join__directive(graphs: [...], name, args)`, which the
 * supergraph splitter turns back into a plain application on exactly that
 * subgraph's schema. This supergraph carries the four cases the reader must
 * distinguish: a bare `@passthrough`, one with a check list, one imported
 * under another name (`as: "@relay"`), and a subgraph with no directive.
 */
const SUPERGRAPH = /* GraphQL */ `
  schema
    @link(url: "https://specs.apollo.dev/link/v1.0")
    @link(url: "https://specs.apollo.dev/join/v0.5", for: EXECUTION)
    @join__directive(
      graphs: [PRODUCTS]
      name: "link"
      args: { url: "https://the-guild.dev/mesh/v1.0", import: ["@passthrough"] }
    )
    @join__directive(graphs: [PRODUCTS], name: "passthrough")
    @join__directive(
      graphs: [REVIEWS]
      name: "link"
      args: { url: "https://the-guild.dev/mesh/v1.0", import: ["@passthrough"] }
    )
    @join__directive(
      graphs: [REVIEWS]
      name: "passthrough"
      args: { check: ["JSON", "LEAF_VALUES"] }
    )
    @join__directive(
      graphs: [RENAMED]
      name: "link"
      args: {
        url: "https://the-guild.dev/mesh/v1.0"
        import: [{ name: "@passthrough", as: "@relay" }]
      }
    )
    @join__directive(
      graphs: [RENAMED]
      name: "relay"
      args: { check: ["EXACT_FIELDS"] }
    ) {
    query: Query
  }

  directive @join__directive(
    graphs: [join__Graph!]
    name: String!
    args: join__DirectiveArguments
  ) repeatable on SCHEMA | OBJECT | INTERFACE | FIELD_DEFINITION

  directive @join__field(
    graph: join__Graph
    requires: join__FieldSet
    provides: join__FieldSet
    type: String
    external: Boolean
    override: String
    usedOverridden: Boolean
  ) repeatable on FIELD_DEFINITION | INPUT_FIELD_DEFINITION

  directive @join__graph(name: String!, url: String!) on ENUM_VALUE

  directive @join__type(
    graph: join__Graph!
    key: join__FieldSet
    extension: Boolean! = false
    resolvable: Boolean! = true
    isInterfaceObject: Boolean! = false
  ) repeatable on OBJECT | INTERFACE | UNION | ENUM | INPUT_OBJECT | SCALAR

  directive @link(
    url: String
    as: String
    for: link__Purpose
    import: [link__Import]
  ) repeatable on SCHEMA

  scalar join__DirectiveArguments
  scalar join__FieldSet
  scalar link__Import

  enum link__Purpose {
    SECURITY
    EXECUTION
  }

  enum join__Graph {
    PRODUCTS @join__graph(name: "products", url: "http://products/graphql")
    REVIEWS @join__graph(name: "reviews", url: "http://reviews/graphql")
    INVENTORY @join__graph(name: "inventory", url: "http://inventory/graphql")
    RENAMED @join__graph(name: "renamed", url: "http://renamed/graphql")
  }

  type Query
    @join__type(graph: PRODUCTS)
    @join__type(graph: REVIEWS)
    @join__type(graph: INVENTORY)
    @join__type(graph: RENAMED) {
    products: [String!]! @join__field(graph: PRODUCTS)
    reviews: [String!]! @join__field(graph: REVIEWS)
    warehouses: [String!]! @join__field(graph: INVENTORY)
    renamedThings: [String!]! @join__field(graph: RENAMED)
  }
`;

let schema: GraphQLSchema;

beforeAll(async () => {
  await using gw = createGatewayTester({
    transportEntries: {
      '*': { options: { deduplicateInflightRequests: false } },
    },
    supergraph: SUPERGRAPH,
  });
  schema = await gw.runtime.getSchema();
});

describe('response pass-through directive', () => {
  describe('readPassthroughDirectives', () => {
    it('reads a bare @passthrough as maximum performance', () => {
      const policies = readPassthroughDirectives(schema);
      expect(policies.get('products')).toEqual({
        enabled: true,
        checks: new Set(),
      });
    });

    it('reads the check list', () => {
      const policies = readPassthroughDirectives(schema);
      expect(policies.get('reviews')).toEqual({
        enabled: true,
        checks: new Set(['JSON', 'LEAF_VALUES']),
      });
    });

    it('resolves an import renamed with as:', () => {
      const policies = readPassthroughDirectives(schema);
      expect(policies.get('renamed')).toEqual({
        enabled: true,
        checks: new Set(['EXACT_FIELDS']),
      });
    });

    it('yields no policy for a subgraph without the directive', () => {
      const policies = readPassthroughDirectives(schema);
      expect(policies.has('inventory')).toBe(false);
    });

    it('yields nothing for a schema without stitching info', () => {
      expect(readPassthroughDirectives(new GraphQLSchema({})).size).toBe(0);
    });
  });

  describe('policyFor', () => {
    const fallback: PassthroughPolicy = {
      enabled: true,
      checks: new Set(['JSON']),
    };

    it('prefers the subgraph directive over the fallback', () => {
      const policies = readPassthroughDirectives(schema);
      expect(policyFor('reviews', policies, fallback)).toEqual({
        enabled: true,
        checks: new Set(['JSON', 'LEAF_VALUES']),
      });
    });

    it('falls back for a subgraph without a directive', () => {
      const policies = readPassthroughDirectives(schema);
      expect(policyFor('inventory', policies, fallback)).toBe(fallback);
    });
  });

  describe('options fallback policy', () => {
    it('defaults to enabled with no checks', () => {
      expect(normalizeOptions().fallbackPolicy).toEqual({
        enabled: true,
        checks: new Set(),
      });
    });

    it('carries configured checks, deduplicated', () => {
      expect(
        normalizeOptions({ checks: ['JSON', 'EXACT_FIELDS', 'JSON'] })
          .fallbackPolicy,
      ).toEqual({
        enabled: true,
        checks: new Set(['JSON', 'EXACT_FIELDS']),
      });
    });

    it('is disabled only when the plugin is statically off', () => {
      expect(normalizeOptions({ enabled: false }).fallbackPolicy.enabled).toBe(
        false,
      );
      // A predicate still gates per root field; the policy itself stays on.
      expect(
        normalizeOptions({ enabled: () => false }).fallbackPolicy.enabled,
      ).toBe(true);
    });
  });
});
