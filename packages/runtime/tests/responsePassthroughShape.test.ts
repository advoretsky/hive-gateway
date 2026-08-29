import { createGatewayTester } from '@graphql-hive/gateway-testing';
import type { StitchingInfo, Subschema } from '@graphql-tools/delegate';
import {
  Kind,
  parse,
  type GraphQLSchema,
  type OperationDefinitionNode,
} from 'graphql';
import { beforeAll, describe, expect, it } from 'vitest';
import { compareShape } from '../src/plugins/response-passthrough/compareShape';

const LINK = `extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@shareable", "@external", "@requires"])`;

let schema: GraphQLSchema;
let subschemas: Map<string, Subschema>;

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
            type Query {
              products: [Product!]!
              featured: Product
              node: Node
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
          `,
          resolvers: {
            Query: {
              products: () => [],
              featured: () => null,
              node: () => null,
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
  const stitchingInfo = schema.extensions?.['stitchingInfo'] as StitchingInfo;
  subschemas = new Map(
    [...stitchingInfo.subschemaMap.values()].map((subschema) => [
      subschema.name!,
      subschema as Subschema,
    ]),
  );
});

function compare(
  query: string,
  subgraph = 'products',
  variableValues: Record<string, unknown> = {},
) {
  const document = parse(query);
  const operation = document.definitions.find(
    (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION,
  )!;
  return compareShape({
    unifiedSchema: schema,
    document,
    operation,
    subschema: subschemas.get(subgraph)!,
    variableValues,
  });
}

describe('response pass-through shape comparison', () => {
  describe('matches', () => {
    it('plain fields', () => {
      const c = compare(`{ products { upc name price } }`);
      expect(c.mismatch).toBeUndefined();
      expect(c.matches).toBe(true);
      expect([...c.rootKeyMap!]).toEqual([['products', 'products']]);
    });

    it('nested selections', () => {
      const c = compare(`{ products { upc reviews { id body rating } } }`);
      expect(c.mismatch).toBeUndefined();
      expect(c.matches).toBe(true);
    });

    it('an aliased root field, mapping the subgraph key back', () => {
      const c = compare(`{ p: products { upc name } }`);
      expect(c.mismatch).toBeUndefined();
      expect(c.matches).toBe(true);
      expect(c.rootKeyMap!.get('products')).toBe('p');
    });

    it('aliased nested fields', () => {
      const c = compare(`{ p: products { u: upc r: reviews { b: body } } }`);
      expect(c.mismatch).toBeUndefined();
      expect(c.matches).toBe(true);
      expect(c.rootKeyMap!.get('products')).toBe('p');
    });

    it('a fragment spread', () => {
      const c = compare(
        `{ products { ...P } } fragment P on Product { upc name }`,
      );
      expect(c.mismatch).toBeUndefined();
      expect(c.matches).toBe(true);
    });

    it('multiple root fields on the same subgraph', () => {
      const c = compare(`{ products { upc } f: featured { name } }`);
      expect(c.mismatch).toBeUndefined();
      expect(c.matches).toBe(true);
      expect([...c.rootKeyMap!]).toEqual([
        ['products', 'products'],
        ['featured', 'f'],
      ]);
    });

    it('an explicitly selected __typename', () => {
      const c = compare(`{ products { __typename upc } }`);
      expect(c.mismatch).toBeUndefined();
      expect(c.matches).toBe(true);
    });

    it('a @skip-guarded field, which is relayed with the directive intact', () => {
      const c = compare(
        `query Q($s: Boolean!) { products { upc name @skip(if: $s) } }`,
        'products',
        { s: false },
      );
      expect(c.mismatch).toBeUndefined();
      expect(c.matches).toBe(true);
    });

    it('an inline fragment on the enclosing concrete type', () => {
      const c = compare(`{ products { ... on Product { upc name } } }`);
      expect(c.mismatch).toBeUndefined();
      expect(c.matches).toBe(true);
    });
  });

  describe('declines', () => {
    it('a field selected on an interface, because __typename is injected', () => {
      const c = compare(`{ node { id } }`);
      expect(c.matches).toBe(false);
      expect(c.mismatch).toBe('subgraph document adds "__typename" at node');
      expect(c.rootKeyMap).toBeUndefined();
    });

    it('an inline fragment on an interface', () => {
      const c = compare(`{ node { ... on Product { upc } } }`);
      expect(c.matches).toBe(false);
      expect(c.mismatch).toBe('subgraph document adds "__typename" at node');
    });

    it('a query needing a second subgraph', () => {
      const c = compare(`{ products { upc inStock } }`);
      expect(c.matches).toBe(false);
      // `Product` is a merged type here, so the pipeline injects the key
      // discriminator before it ever gets to dropping the foreign field.
      expect(c.mismatch).toBe(
        'subgraph document adds "__typename" at products',
      );
    });

    it('a root field the chosen subgraph does not own', () => {
      const c = compare(`{ warehouses { id } }`, 'products');
      expect(c.matches).toBe(false);
      expect(c.mismatch).toContain('at least one operation');
    });

    it('an operation with no root fields it can prove', () => {
      const c = compare(`{ ...R } fragment R on Query { products { upc } }`);
      expect(c.matches).toBe(false);
      expect(c.mismatch).toBe('root selection is not a field');
    });
  });
});
