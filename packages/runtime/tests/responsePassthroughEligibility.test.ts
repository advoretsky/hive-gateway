import { createGatewayTester } from '@graphql-hive/gateway-testing';
import { parse, type GraphQLSchema } from 'graphql';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  checkEligibility,
  type EligibilityOptions,
} from '../src/plugins/response-passthrough/eligibility';

const LINK = `extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@inaccessible", "@shareable", "@external", "@requires"])`;

let schema: GraphQLSchema;

beforeAll(async () => {
  await using gw = createGatewayTester({
    transportEntries: {
      '*': { options: { deduplicateInflightRequests: false } },
    },
    subgraphs: [
      {
        name: 'products',
        schema: {
          typeDefs: /* GraphQL */ `
            ${LINK}
            scalar DateTime
            enum Visibility {
              PUBLIC
              INTERNAL @inaccessible
            }
            enum Status {
              ACTIVE
              ARCHIVED
            }
            type Query {
              products: [Product!]!
              node: Node
              featured: Product
              withScalar: HasScalar
              withHiddenEnum: HasHiddenEnum
              withPlainEnum: HasPlainEnum
            }
            interface Node {
              id: ID!
            }
            type Product implements Node @key(fields: "upc") {
              id: ID!
              upc: String!
              name: String
              price: Int
              reviews: [Review!]
            }
            type Review {
              id: ID!
              body: String
              rating: Int
            }
            type HasScalar {
              at: DateTime
            }
            type HasHiddenEnum {
              visibility: Visibility
            }
            type HasPlainEnum {
              status: Status
            }
          `,
          resolvers: {
            Query: {
              products: () => [],
              node: () => null,
              featured: () => null,
              withScalar: () => null,
              withHiddenEnum: () => null,
              withPlainEnum: () => null,
            },
          },
        },
      },
      {
        name: 'inventory',
        schema: {
          typeDefs: /* GraphQL */ `
            ${LINK}
            type Query {
              warehouses: [Warehouse!]!
            }
            type Warehouse {
              id: ID!
              region: String
            }
            type Product @key(fields: "upc") {
              upc: String!
              inStock: Boolean
            }
          `,
          resolvers: { Query: { warehouses: () => [] } },
        },
      },
    ],
  });
  schema = await gw.runtime.getSchema();
});

function check(query: string, options?: EligibilityOptions) {
  return checkEligibility(schema, parse(query), undefined, options);
}

describe('response pass-through eligibility', () => {
  describe('accepts', () => {
    it('a plain single-subgraph query', () => {
      const d = check(`{ products { upc name price } }`);
      expect(d.eligible).toBe(true);
      expect(d.subschema?.name).toBe('products');
      expect(d.responseKeys).toEqual(['products']);
    });

    it('a query with nested selections', () => {
      expect(check(`{ products { upc reviews { id body } } }`).eligible).toBe(
        true,
      );
    });

    it('a query with aliases, reporting the client response key', () => {
      const d = check(`{ p: products { u: upc n: name } }`);
      expect(d.eligible).toBe(true);
      expect(d.responseKeys).toEqual(['p']);
    });

    it('a query selecting __typename', () => {
      expect(check(`{ products { __typename upc } }`).eligible).toBe(true);
    });

    it('a query using @skip', () => {
      expect(
        check(`query Q($s: Boolean!) { products { upc name @skip(if: $s) } }`)
          .eligible,
      ).toBe(true);
    });

    it('a query using a fragment', () => {
      expect(
        check(`{ products { ...P } } fragment P on Product { upc name }`)
          .eligible,
      ).toBe(true);
    });

    it('multiple root fields owned by the same subgraph', () => {
      const d = check(`{ products { upc } featured { name } }`);
      expect(d.eligible).toBe(true);
      expect(d.responseKeys).toEqual(['products', 'featured']);
    });

    it('an enum with no inaccessible values', () => {
      expect(check(`{ withPlainEnum { status } }`).eligible).toBe(true);
    });
  });

  describe('declines', () => {
    const declines = (label: string, query: string, reason: string) =>
      it(label, () => {
        const d = check(query);
        expect(d.eligible).toBe(false);
        expect(d.reason).toBe(reason);
      });

    declines(
      'a query needing a second subgraph',
      `{ products { upc inStock } }`,
      'fields-missing-from-subgraph',
    );

    declines(
      'root fields spanning subgraphs',
      `{ products { upc } warehouses { id } }`,
      'root-fields-span-subgraphs',
    );

    declines(
      'a field selected on an interface',
      `{ node { id } }`,
      'abstract-type-in-selection',
    );

    // `isSelectionSetSatisfiedBySchema` accepts this shape — it only rejects
    // fields selected *directly* on an abstract type — but it is exactly the
    // case where the gateway injects `__typename` into the outgoing document,
    // so the separate abstract-type rejection is what declines it.
    declines(
      'an inline fragment on an interface',
      `{ node { ... on Product { upc } } }`,
      'abstract-type-in-selection',
    );

    declines('a mutation', `mutation { products { upc } }`, 'not-a-query');

    declines(
      'an introspection query',
      `{ __schema { types { name } } }`,
      'root-field-not-owned',
    );

    declines(
      'a custom scalar in the selection',
      `{ withScalar { at } }`,
      'custom-scalar-serializer',
    );

    declines(
      'an enum carrying an @inaccessible value',
      `{ withHiddenEnum { visibility } }`,
      'inaccessible-enum-value',
    );

    declines(
      'a deferred selection',
      `{ products { upc ... @defer { name } } }`,
      'incremental-delivery',
    );

    declines(
      'an unknown root field',
      `{ nope { id } }`,
      'root-field-not-owned',
    );

    it('two operations in one document', () => {
      const d = check(
        `query A { products { upc } } query B { featured { upc } }`,
      );
      expect(d.eligible).toBe(false);
      expect(d.reason).toBe('multiple-operations');
    });
  });

  describe('the configuration gate', () => {
    it('receives the subgraph, type, field and operation', () => {
      const seen: unknown[] = [];
      check(`query GetProducts { products { upc } }`, {
        isEnabled: (payload) => {
          seen.push(payload);
          return true;
        },
      });
      expect(seen).toEqual([
        {
          subgraphName: 'products',
          typeName: 'Query',
          fieldName: 'products',
          operationName: 'GetProducts',
        },
      ]);
    });

    it('accepts when the gate allows', () => {
      expect(
        check(`{ products { upc } }`, { isEnabled: () => true }).eligible,
      ).toBe(true);
    });

    it('declines by subgraph', () => {
      const d = check(`{ products { upc } }`, {
        isEnabled: ({ subgraphName }) => subgraphName !== 'products',
      });
      expect(d.eligible).toBe(false);
      expect(d.reason).toBe('not-enabled-by-config');
    });

    it('declines by root field', () => {
      const d = check(`{ products { upc } }`, {
        isEnabled: ({ typeName, fieldName }) =>
          !(typeName === 'Query' && fieldName === 'products'),
      });
      expect(d.eligible).toBe(false);
      expect(d.reason).toBe('not-enabled-by-config');
    });

    // Relaying is all-or-nothing: the bytes replace the whole response, so one
    // excluded root field disqualifies the operation rather than part of it.
    it('declines the whole operation when any root field is excluded', () => {
      const d = check(`{ products { upc } featured { name } }`, {
        isEnabled: ({ fieldName }) => fieldName !== 'featured',
      });
      expect(d.eligible).toBe(false);
      expect(d.reason).toBe('not-enabled-by-config');
    });
  });
});
