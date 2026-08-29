import {
  createGatewayTester,
  type GatewayTesterRemoteSchemaConfig,
} from '@graphql-hive/gateway-testing';
import { describe, expect, it, vi } from 'vitest';
import { useResponsePassthrough } from '../src/plugins/response-passthrough';
import type { ResponsePassthroughOptions } from '../src/plugins/response-passthrough/options';
import type { GatewayPlugin } from '../src/types';

const LINK = `extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@shareable", "@external"])`;

const products = [
  { upc: 'u1', name: 'Table', price: 899, reviews: [{ id: 'r1', body: 'ok' }] },
  { upc: 'u2', name: 'Couch', price: 1299, reviews: [] },
];

// Exercises the byte relay on content JSON has to escape and on non-ASCII
// bytes, where a naive slice would cut a multi-byte sequence in half.
const bulky = Array.from({ length: 500 }, (_, i) => ({
  upc: `u${i}`,
  name: `Ünïcøde "quoted" \\ back\\slash \u2603 ${'x'.repeat(80)}`,
  price: i,
  reviews: [{ id: `r${i}`, body: 'line\nbreak\ttab' }],
}));

function subgraphs(failing = false): GatewayTesterRemoteSchemaConfig[] {
  return [
    {
      name: 'products',
      schema: {
        typeDefs: /* GraphQL */ `
          ${LINK}
          type Query {
            products: [Product!]!
            bulkyProducts: [Product!]!
            productsBy(prefix: String!): [Product!]!
            featured: Product
          }
          type Product @key(fields: "upc") {
            upc: String!
            name: String
            price: Int
            reviews: [Review!]
          }
          type Review {
            id: ID!
            body: String
          }
        `,
        resolvers: {
          Query: {
            products: () => {
              if (failing) {
                throw new Error('products exploded');
              }
              return products;
            },
            bulkyProducts: () => bulky,
            productsBy: (_: unknown, { prefix }: { prefix: string }) =>
              products.filter((p) => p.upc.startsWith(prefix)),
            featured: () => products[0],
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
        `,
        resolvers: {
          Query: {
            warehouses: () => [{ id: 'w1', region: 'eu' }],
          },
        },
      },
    },
  ];
}

function makeGateway(options?: ResponsePassthroughOptions, failing = false) {
  return createGatewayTester({
    transportEntries: {
      '*': { options: { deduplicateInflightRequests: false } },
    },
    subgraphs: subgraphs(failing),
    ...(options
      ? { plugins: () => [useResponsePassthrough(options)] }
      : { plugins: () => [] }),
  });
}

async function gwFetch(
  gw: { fetch: typeof fetch },
  query: string,
  init: { accept?: string; variables?: Record<string, unknown> } = {},
): Promise<{ status: number; contentType: string | null; text: string }> {
  const response = await gw.fetch('http://gateway/graphql', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: init.accept ?? 'application/json',
    },
    body: JSON.stringify({ query, variables: init.variables }),
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    text: await response.text(),
  };
}

function post(
  gw: { fetch: typeof fetch },
  query: string,
  variables?: Record<string, unknown>,
) {
  return gwFetch(gw, query, { variables });
}

describe('useResponsePassthrough', () => {
  it('relays an eligible query byte-identically to the plain gateway', async () => {
    const onPassthrough = vi.fn();
    await using plain = createGatewayTester({ subgraphs: subgraphs() });
    await using relayed = makeGateway({ onPassthrough });
    const query = `{ products { upc name price reviews { id body } } }`;

    const expected = await post(plain, query);
    const actual = await post(relayed, query);

    expect(onPassthrough).toHaveBeenCalledTimes(1);
    expect(actual.status).toBe(expected.status);
    expect(actual.text).toBe(expected.text);
  });

  it('returns the client response key for an aliased root field', async () => {
    const onPassthrough = vi.fn();
    await using plain = createGatewayTester({ subgraphs: subgraphs() });
    await using relayed = makeGateway({ onPassthrough });
    const query = `{ p: products { u: upc name } }`;

    const expected = await post(plain, query);
    const actual = await post(relayed, query);

    expect(onPassthrough).toHaveBeenCalledTimes(1);
    expect(JSON.parse(actual.text)).toEqual({
      data: {
        p: [
          { u: 'u1', name: 'Table' },
          { u: 'u2', name: 'Couch' },
        ],
      },
    });
    expect(actual.text).toBe(expected.text);
  });

  it('relays several root fields owned by one subgraph', async () => {
    const onPassthrough = vi.fn();
    await using plain = createGatewayTester({ subgraphs: subgraphs() });
    await using relayed = makeGateway({ onPassthrough });
    const query = `{ products { upc } f: featured { name } }`;

    const expected = await post(plain, query);
    const actual = await post(relayed, query);

    expect(onPassthrough).toHaveBeenCalledTimes(1);
    expect(actual.text).toBe(expected.text);
  });

  it('keeps the negotiated content-type the plain gateway would send', async () => {
    const onPassthrough = vi.fn();
    await using plain = createGatewayTester({ subgraphs: subgraphs() });
    await using relayed = makeGateway({ onPassthrough });
    const query = `{ products { upc } }`;

    for (const accept of [
      'application/json',
      'application/graphql-response+json, application/json',
      '*/*',
    ]) {
      const expected = await gwFetch(plain, query, { accept });
      const actual = await gwFetch(relayed, query, { accept });
      expect(actual.contentType).toBe(expected.contentType);
      expect(actual.text).toBe(expected.text);
    }
    expect(onPassthrough).toHaveBeenCalledTimes(3);
  });

  it('relays a bulky response containing escapes and non-ASCII bytes', async () => {
    const onPassthrough = vi.fn();
    await using plain = createGatewayTester({ subgraphs: subgraphs() });
    await using relayed = makeGateway({ onPassthrough });
    const query = `{ bulkyProducts { upc name price reviews { id body } } }`;

    const expected = await post(plain, query);
    const actual = await post(relayed, query);

    expect(onPassthrough).toHaveBeenCalledTimes(1);
    expect(onPassthrough.mock.calls[0]![0].bytes).toBeGreaterThan(50_000);
    expect(actual.text).toBe(expected.text);
  });

  it('relays a query that uses variables', async () => {
    const onPassthrough = vi.fn();
    await using plain = createGatewayTester({ subgraphs: subgraphs() });
    await using relayed = makeGateway({ onPassthrough });
    const query = `query Q($p: String!) { productsBy(prefix: $p) { upc name } }`;
    const variables = { p: 'u1' };

    const expected = await post(plain, query, variables);
    const actual = await post(relayed, query, variables);

    expect(onPassthrough).toHaveBeenCalledTimes(1);
    expect(JSON.parse(actual.text)).toEqual({
      data: { productsBy: [{ upc: 'u1', name: 'Table' }] },
    });
    expect(actual.text).toBe(expected.text);
  });

  it('composes with a plugin that already replaced executeFn', async () => {
    const wrapped = vi.fn();
    const onPassthrough = vi.fn();
    await using plain = createGatewayTester({ subgraphs: subgraphs() });
    await using relayed = createGatewayTester({
      transportEntries: {
        '*': { options: { deduplicateInflightRequests: false } },
      },
      subgraphs: subgraphs(),
      plugins: () => [
        {
          onExecute({ executeFn, setExecuteFn }) {
            setExecuteFn((args) => {
              wrapped();
              return executeFn(args);
            });
          },
        } satisfies GatewayPlugin,
        useResponsePassthrough({ onPassthrough }),
      ],
    });
    const query = `{ products { upc name } }`;

    const expected = await post(plain, query);
    const actual = await post(relayed, query);

    expect(wrapped).toHaveBeenCalledTimes(1);
    expect(onPassthrough).toHaveBeenCalledTimes(1);
    expect(actual.text).toBe(expected.text);
  });

  it('declines when batching is off and each root field is fetched alone', async () => {
    const onSkip = vi.fn();
    const onPassthrough = vi.fn();
    await using plain = createGatewayTester({
      transportEntries: {
        '*': { options: { deduplicateInflightRequests: false } },
      },
      subgraphs: subgraphs(),
      __experimental__batchExecution: false,
    });
    await using relayed = createGatewayTester({
      transportEntries: {
        '*': { options: { deduplicateInflightRequests: false } },
      },
      subgraphs: subgraphs(),
      __experimental__batchExecution: false,
      plugins: () => [useResponsePassthrough({ onSkip, onPassthrough })],
    });
    const query = `{ products { upc } f: featured { name } }`;

    const expected = await post(plain, query);
    const actual = await post(relayed, query);

    // Relaying is destructive, so a request that is only part of the answer
    // must be refused before its response is touched at all.
    expect(actual.text).toBe(expected.text);
    expect(onPassthrough).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledWith(
      'partial-subgraph-request',
      expect.objectContaining({ subgraphName: 'products' }),
    );
  });

  it('falls back when the subgraph responds with errors', async () => {
    const onSkip = vi.fn();
    await using plain = createGatewayTester({ subgraphs: subgraphs(true) });
    await using relayed = makeGateway({ onSkip }, true);
    const query = `{ products { upc } }`;

    const expected = await post(plain, query);
    const actual = await post(relayed, query);

    const parsed = JSON.parse(actual.text);
    expect(parsed.errors?.[0]?.message).toContain('products exploded');
    expect(parsed.errors?.[0]?.path).toEqual(['products']);
    expect(actual.text).toBe(expected.text);
    expect(onSkip).toHaveBeenCalledWith(
      'errors-present',
      expect.objectContaining({ subgraphName: 'products' }),
    );
  });

  it('leaves a cross-subgraph query untouched', async () => {
    const onPassthrough = vi.fn();
    await using plain = createGatewayTester({ subgraphs: subgraphs() });
    await using relayed = makeGateway({ onPassthrough });
    const query = `{ products { upc } warehouses { id region } }`;

    const expected = await post(plain, query);
    const actual = await post(relayed, query);

    expect(actual.text).toBe(expected.text);
    expect(onPassthrough).not.toHaveBeenCalled();
  });

  it('reports a reason through onSkip for an ineligible query', async () => {
    const onSkip = vi.fn();
    await using gw = makeGateway({ onSkip });

    await post(gw, `{ products { upc } warehouses { id } }`);

    expect(onSkip).toHaveBeenCalledWith(
      'root-fields-span-subgraphs',
      expect.objectContaining({ operationName: undefined }),
    );
  });

  it('reports a relayed response through onPassthrough', async () => {
    const onPassthrough = vi.fn();
    await using gw = makeGateway({ onPassthrough });

    await post(gw, `query Named { products { upc name } }`);

    expect(onPassthrough).toHaveBeenCalledTimes(1);
    expect(onPassthrough).toHaveBeenCalledWith(
      expect.objectContaining({
        operationName: 'Named',
        subgraphName: 'products',
      }),
    );
    expect(onPassthrough.mock.calls[0]![0].bytes).toBeGreaterThan(0);
  });

  it('takes the normal path below minBytes', async () => {
    const onSkip = vi.fn();
    const onPassthrough = vi.fn();
    await using plain = createGatewayTester({ subgraphs: subgraphs() });
    await using relayed = makeGateway({
      minBytes: 1_000_000,
      onSkip,
      onPassthrough,
    });
    const query = `{ products { upc } }`;

    const expected = await post(plain, query);
    const actual = await post(relayed, query);

    expect(actual.text).toBe(expected.text);
    expect(onPassthrough).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledWith(
      'below-min-bytes',
      expect.objectContaining({ subgraphName: 'products' }),
    );
  });

  it('declines a subgraph the configuration disables', async () => {
    const onSkip = vi.fn();
    const onPassthrough = vi.fn();
    await using plain = createGatewayTester({ subgraphs: subgraphs() });
    await using relayed = makeGateway({
      enabled: ({ subgraphName }) => subgraphName !== 'products',
      onSkip,
      onPassthrough,
    });
    const query = `{ products { upc } }`;

    expect((await post(relayed, query)).text).toBe(
      (await post(plain, query)).text,
    );
    expect(onPassthrough).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledWith(
      'not-enabled-by-config',
      expect.anything(),
    );
  });

  it('serves repeated requests of the same document from the cached verdict', async () => {
    const onPassthrough = vi.fn();
    await using plain = createGatewayTester({ subgraphs: subgraphs() });
    await using relayed = makeGateway({ onPassthrough });
    const query = `{ products { upc name } }`;

    const expected = await post(plain, query);
    const first = await post(relayed, query);
    const second = await post(relayed, query);

    expect(first.text).toBe(expected.text);
    expect(second.text).toBe(expected.text);
    expect(onPassthrough).toHaveBeenCalledTimes(2);
  });
});
