/**
 * Differential suite: the same corpus of operations through two gateways over
 * the same subgraphs — one with `useResponsePassthrough` installed, one plain —
 * asserting the two answers are semantically identical.
 *
 * Two guards make the suite meaningful rather than merely green:
 *
 *  - the RELAY oracle: every case marked `relayed` must actually have taken the
 *    fast path (`onPassthrough` fired). Without it the whole suite would still
 *    pass if the plugin silently declined everything;
 *  - the DELEGATION oracle: `onDelegationPlan` fires only when type merging
 *    actually happens, i.e. when the gateway itself contributes to the answer.
 *    If it ever fires for an operation that was relayed, the eligibility
 *    decision was wrong and the client was served an incomplete response.
 */

import {
  createGatewayTester,
  type GatewayTesterRemoteSchemaConfig,
} from '@graphql-hive/gateway-testing';
import { getIntrospectionQuery } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useResponsePassthrough } from '../src/plugins/response-passthrough';
import type { GatewayPlugin } from '../src/types';

const LINK = `extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@shareable", "@external"])`;

const products = [
  {
    __typename: 'Product',
    upc: 'u1',
    name: 'Table',
    price: 899,
    description: 'A table',
    tags: ['wood', 'brown'],
    reviews: [
      { id: 'r1', body: 'ok', rating: 3 },
      { id: 'r2', body: null, rating: 5 },
    ],
  },
  {
    __typename: 'Product',
    upc: 'u2',
    name: 'Couch',
    price: null,
    description: null,
    tags: [],
    reviews: [],
  },
];

const media = [
  { __typename: 'Photo', id: 'p1', title: 'Front', width: 1024 },
  { __typename: 'Video', id: 'v1', title: 'Unboxing', duration: 42 },
];

function subgraphs(): GatewayTesterRemoteSchemaConfig[] {
  return [
    {
      name: 'catalog',
      schema: {
        typeDefs: /* GraphQL */ `
          ${LINK}
          type Query {
            products: [Product!]!
            productsBy(prefix: String!): [Product!]!
            featured: Product
            missing: Product
            noProducts: [Product!]!
            media: [Media!]!
            search(term: String!): [SearchResult!]!
            boom: [Product!]!
          }
          type Mutation {
            rename(upc: String!, name: String!): Product
          }
          type Product @key(fields: "upc") {
            upc: String!
            name: String
            price: Int
            description: String
            tags: [String!]
            reviews: [Review!]
            flaky: String
          }
          type Review {
            id: ID!
            body: String
            rating: Int
          }
          interface Media {
            id: ID!
            title: String
          }
          type Photo implements Media {
            id: ID!
            title: String
            width: Int
          }
          type Video implements Media {
            id: ID!
            title: String
            duration: Int
          }
          union SearchResult = Product | Photo
        `,
        resolvers: {
          Query: {
            products: () => products,
            productsBy: (_: unknown, { prefix }: { prefix: string }) =>
              products.filter((p) => p.upc.startsWith(prefix)),
            featured: () => products[0],
            missing: () => null,
            noProducts: () => [],
            media: () => media,
            search: () => [products[0], media[0]],
            boom: () => {
              throw new Error('boom exploded');
            },
          },
          Mutation: {
            rename: (
              _: unknown,
              { upc, name }: { upc: string; name: string },
            ) => ({ ...products.find((p) => p.upc === upc), name }),
          },
          Product: {
            // Field-level failure on an otherwise healthy response: the answer
            // carries `data` and `errors` together.
            flaky: () => {
              throw new Error('flaky exploded');
            },
          },
        },
      },
    },
    {
      name: 'warehouse',
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
        `,
        resolvers: {
          Query: {
            warehouses: () => [
              { id: 'w1', region: 'eu' },
              { id: 'w2', region: null },
            ],
          },
        },
      },
    },
    {
      name: 'orders',
      schema: {
        typeDefs: /* GraphQL */ `
          ${LINK}
          type Query {
            orders: [Order!]!
          }
          type Order @key(fields: "id") {
            id: ID!
            total: Int
          }
        `,
        resolvers: {
          Query: {
            orders: () => [
              { id: 'o1', total: 10 },
              { id: 'o2', total: 20 },
            ],
          },
          Order: {
            __resolveReference: (ref: { id: string }) => ({
              id: ref.id,
              total: ref.id === 'o1' ? 10 : 20,
            }),
          },
        },
      },
    },
    {
      name: 'shipping',
      schema: {
        typeDefs: /* GraphQL */ `
          ${LINK}
          type Query {
            carriers: [String!]!
          }
          type Order @key(fields: "id") {
            id: ID!
            carrier: String
          }
        `,
        resolvers: {
          Query: {
            carriers: () => ['dhl', 'ups'],
          },
          Order: {
            __resolveReference: (ref: { id: string }) => ({
              id: ref.id,
              carrier: ref.id === 'o1' ? 'dhl' : 'ups',
            }),
          },
        },
      },
    },
  ];
}

interface Case {
  name: string;
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  /** Whether this operation MUST take the byte-relay path. */
  relayed: boolean;
}

const cases: Case[] = [
  {
    name: 'plain scalar fields',
    query: `{ products { upc name price } }`,
    relayed: true,
  },
  {
    name: 'nested objects and lists',
    query: `{ products { upc reviews { id body rating } } }`,
    relayed: true,
  },
  {
    name: 'null object field and null leaf',
    query: `{ missing { upc } featured { upc description price } }`,
    relayed: true,
  },
  {
    name: 'empty list',
    query: `{ noProducts { upc } }`,
    relayed: true,
  },
  {
    name: 'list of scalars, empty and populated',
    query: `{ products { upc tags } }`,
    relayed: true,
  },
  {
    name: 'aliased root field',
    query: `{ p: products { upc name } }`,
    relayed: true,
  },
  {
    name: 'aliased nested fields',
    query: `{ products { u: upc n: name rs: reviews { i: id } } }`,
    relayed: true,
  },
  {
    name: 'several root fields from one subgraph',
    query: `{ products { upc } f: featured { name } noProducts { upc } }`,
    relayed: true,
  },
  {
    name: 'named fragment spread',
    query: `
      { products { ...Fields } }
      fragment Fields on Product { upc name reviews { id } }
    `,
    relayed: true,
  },
  {
    name: 'inline fragment on the enclosing concrete type',
    query: `{ products { upc ... on Product { name } } }`,
    relayed: true,
  },
  {
    name: '__typename at several depths',
    query: `{ products { __typename upc reviews { __typename id } } }`,
    relayed: true,
  },
  {
    name: 'variables with a root argument',
    query: `query Prefixed($p: String!) { productsBy(prefix: $p) { upc name } }`,
    variables: { p: 'u1' },
    relayed: true,
  },
  {
    name: '@skip that excludes a field',
    query: `query Skipping($s: Boolean!) { products { upc name @skip(if: $s) } }`,
    variables: { s: true },
    relayed: true,
  },
  {
    name: '@skip that keeps a field',
    query: `query Skipping($s: Boolean!) { products { upc name @skip(if: $s) } }`,
    variables: { s: false },
    relayed: true,
  },
  {
    name: '@include that keeps a field',
    query: `query Including($i: Boolean!) { products { upc price @include(if: $i) } }`,
    variables: { i: true },
    relayed: true,
  },
  {
    name: '@include that excludes a field',
    query: `query Including($i: Boolean!) { products { upc price @include(if: $i) } }`,
    variables: { i: false },
    relayed: true,
  },
  {
    name: 'inline fragments on an interface',
    query: `{ media { id title ... on Photo { width } ... on Video { duration } } }`,
    relayed: false,
  },
  {
    name: 'inline fragments on a union',
    query: `{ search(term: "t") { ... on Product { upc name } ... on Photo { id width } } }`,
    relayed: false,
  },
  {
    name: 'root fields spanning two subgraphs',
    query: `{ products { upc } warehouses { id region } }`,
    relayed: false,
  },
  {
    name: 'entity resolution across subgraphs',
    query: `{ orders { id total carrier } }`,
    relayed: false,
  },
  {
    name: 'subgraph answering with errors only',
    query: `{ boom { upc } }`,
    relayed: false,
  },
  {
    name: 'partial answer, data alongside a field error',
    query: `{ products { upc flaky } }`,
    relayed: false,
  },
  {
    name: 'introspection of the schema',
    query: `{ __schema { queryType { name } types { name kind } } }`,
    relayed: false,
  },
  {
    name: 'full introspection query',
    query: getIntrospectionQuery(),
    relayed: false,
  },
  {
    name: '__typename on the root type',
    query: `{ __typename products { upc } }`,
    relayed: false,
  },
  {
    name: 'a mutation',
    query: `mutation Rename { rename(upc: "u1", name: "Desk") { upc name } }`,
    relayed: false,
  },
  {
    name: 'a document holding several operations',
    query: `
      query One { products { upc } }
      query Two { featured { name } }
    `,
    operationName: 'One',
    relayed: false,
  },
];

interface PassthroughInfo {
  operationName?: string;
  subgraphName?: string;
  bytes: number;
}

const passedThrough: PassthroughInfo[] = [];
const delegationPlans: string[] = [];

let plain: Awaited<ReturnType<typeof createGatewayTester>>;
let relaying: Awaited<ReturnType<typeof createGatewayTester>>;

beforeAll(() => {
  plain = createGatewayTester({ subgraphs: subgraphs() });
  relaying = createGatewayTester({
    transportEntries: {
      '*': { options: { deduplicateInflightRequests: false } },
    },
    subgraphs: subgraphs(),
    plugins: () => [
      useResponsePassthrough({
        onPassthrough: (info) => {
          passedThrough.push(info);
        },
      }),
      {
        // The oracle: type merging happened, so the gateway itself contributed
        // to this answer and its bytes cannot have come from one subgraph.
        onDelegationPlan({ typeName }) {
          delegationPlans.push(typeName);
        },
      } satisfies GatewayPlugin,
    ],
  });
});

afterAll(async () => {
  await plain?.dispose();
  await relaying?.dispose();
});

beforeEach(() => {
  passedThrough.length = 0;
  delegationPlans.length = 0;
});

async function post(gw: { fetch: typeof fetch }, testCase: Case) {
  const response = await gw.fetch('http://gateway/graphql', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      query: testCase.query,
      variables: testCase.variables,
      operationName: testCase.operationName,
    }),
  });
  const text = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: JSON.parse(text) as Record<string, unknown>,
  };
}

describe('response pass-through differential', () => {
  for (const testCase of cases) {
    it(`answers identically: ${testCase.name}`, async () => {
      const expected = await post(plain, testCase);
      const actual = await post(relaying, testCase);

      // Key order may legitimately differ between the relayed bytes and an
      // executed result, so compare the parsed documents, never the text.
      expect(actual.body).toEqual(expected.body);
      expect(actual.status).toBe(expected.status);
      expect(actual.contentType).toBe(expected.contentType);

      expect(passedThrough).toHaveLength(testCase.relayed ? 1 : 0);
      if (testCase.relayed) {
        // Nothing was merged, so nothing the gateway alone knew is missing.
        expect(delegationPlans).toEqual([]);
      }
    });
  }

  it('keeps a corpus that actually exercises the fast path', () => {
    // Guards against the suite quietly degrading into "both gateways decline".
    expect(cases.filter((c) => c.relayed).length).toBeGreaterThanOrEqual(12);
    expect(cases.filter((c) => !c.relayed).length).toBeGreaterThanOrEqual(8);
  });
});
