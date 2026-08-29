/**
 * Regression tests for the four failure modes that made pass-through unsafe
 * to combine with everyday gateway features:
 *
 *  1. errors attached to the result after execution were silently dropped
 *     while the payload was still relayed;
 *  2. a batched request whose body held ONE operation armed, committed, and
 *     then fell back to serializing the stub as fabricated nulls;
 *  3. anything throwing after the stub was committed made the fallback
 *     processor serialize the stub as a 200;
 *  4. inbound in-flight request deduplication shared the stub-derived result
 *     with follower requests, serving them all-null data.
 *
 * Every test compares against a plain gateway (same subgraphs and plugins,
 * no pass-through) because "identical to not having the plugin" is the
 * plugin's core promise.
 */

import {
  createGatewayTester,
  type GatewayTesterRemoteSchemaConfig,
} from '@graphql-hive/gateway-testing';
import { isAsyncIterable } from '@graphql-tools/utils';
import {
  GraphQLError,
  Kind,
  visit,
  type DocumentNode,
  type FieldNode,
} from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { useResponsePassthrough } from '../src/plugins/response-passthrough';
import type { ResponsePassthroughOptions } from '../src/plugins/response-passthrough/options';
import type { GatewayPlugin } from '../src/types';

const LINK = `extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key"])`;

const products = [
  { upc: 'u1', name: 'Table', price: 899, reviews: [{ id: 'r1', body: 'ok' }] },
  { upc: 'u2', name: 'Couch', price: 1299, reviews: [] },
];

function subgraphs(delayMs = 0): GatewayTesterRemoteSchemaConfig[] {
  return [
    {
      name: 'products',
      schema: {
        typeDefs: /* GraphQL */ `
          ${LINK}
          type Query {
            products: [Product!]!
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
            products: async () => {
              if (delayMs) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
              }
              return products;
            },
            featured: () => products[0],
          },
        },
      },
    },
  ];
}

const QUERY = `{ products { upc name price reviews { id body } } }`;

function passthroughGateway(
  options: ResponsePassthroughOptions,
  extras: {
    plugins?: GatewayPlugin[];
    batching?: boolean;
    inboundDedupe?: boolean;
    delayMs?: number;
  } = {},
) {
  return createGatewayTester({
    transportEntries: {
      '*': { options: { deduplicateInflightRequests: false } },
    },
    subgraphs: subgraphs(extras.delayMs ?? 0),
    ...(extras.batching ? { batching: true } : {}),
    ...(extras.inboundDedupe
      ? { inboundInflightRequestDeduplication: true }
      : {}),
    plugins: () => [useResponsePassthrough(options), ...(extras.plugins ?? [])],
  });
}

function plainGateway(
  extras: { plugins?: GatewayPlugin[]; batching?: boolean } = {},
) {
  return createGatewayTester({
    subgraphs: subgraphs(),
    ...(extras.batching ? { batching: true } : {}),
    plugins: () => extras.plugins ?? [],
  });
}

async function post(
  gw: { fetch: typeof fetch },
  body: unknown,
): Promise<{ status: number; text: string; contentLength: string | null }> {
  const response = await gw.fetch('http://gateway/graphql', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    text: await response.text(),
    contentLength: response.headers.get('content-length'),
  };
}

/** An authorization-style plugin: attaches an error AFTER execution. */
function forbiddenPlugin(): GatewayPlugin {
  return {
    onExecutionResult({ result, setResult }) {
      if (result && !isAsyncIterable(result)) {
        setResult({
          ...result,
          errors: [
            ...(result.errors ?? []),
            new GraphQLError('Forbidden', {
              extensions: { http: { status: 403 } },
            }),
          ],
        });
      }
    },
  };
}

/** Poisons the result extensions with a value JSON cannot serialize. */
function bigintExtensionsPlugin(): GatewayPlugin {
  return {
    onExecutionResult({ result, setResult }) {
      if (result && !isAsyncIterable(result)) {
        setResult({
          ...result,
          extensions: { ...(result.extensions ?? {}), poison: BigInt(1) },
        });
      }
    },
  };
}

/**
 * Appends a `__typename` selection (optionally aliased, the way the response
 * cache aliases `__responseCacheTypeName`) to every composite field of the
 * outgoing subgraph document — after the pass-through verdict was reached.
 */
function injectTypename(document: DocumentNode, alias?: string): DocumentNode {
  const injected: FieldNode = {
    kind: Kind.FIELD,
    name: { kind: Kind.NAME, value: '__typename' },
    ...(alias ? { alias: { kind: Kind.NAME, value: alias } } : {}),
  };
  return visit(document, {
    Field(node) {
      if (!node.selectionSet) {
        return undefined;
      }
      return {
        ...node,
        selectionSet: {
          ...node.selectionSet,
          selections: [...node.selectionSet.selections, injected],
        },
      };
    },
  });
}

function injectTypenamePlugin(alias?: string): GatewayPlugin {
  return {
    onSubgraphExecute({ executionRequest, setExecutionRequest }) {
      setExecutionRequest({
        ...executionRequest,
        document: injectTypename(executionRequest.document, alias),
      });
    },
  };
}

describe('response pass-through criticals', () => {
  describe('errors attached after execution (critical 1)', () => {
    it('serves the 403 with real data byte-identically to the plain gateway', async () => {
      const onSkip = vi.fn();
      const onPassthrough = vi.fn();
      await using plain = plainGateway({ plugins: [forbiddenPlugin()] });
      await using relayed = passthroughGateway(
        { onSkip, onPassthrough },
        { plugins: [forbiddenPlugin()] },
      );

      const expected = await post(plain, { query: QUERY });
      const actual = await post(relayed, { query: QUERY });

      expect(expected.status).toBe(403);
      expect(actual.status).toBe(expected.status);
      expect(actual.text).toBe(expected.text);
      // The error is present AND the data is the subgraph's, not the stub's.
      expect(actual.text).toContain('"Forbidden"');
      expect(actual.text).toContain('"Table"');
      expect(onPassthrough).not.toHaveBeenCalled();
      expect(onSkip).toHaveBeenCalledWith(
        'result-has-errors',
        expect.anything(),
      );
    });

    it('still relays when no error is attached', async () => {
      const onPassthrough = vi.fn();
      await using plain = plainGateway();
      await using relayed = passthroughGateway({ onPassthrough });

      const expected = await post(plain, { query: QUERY });
      const actual = await post(relayed, { query: QUERY });

      expect(onPassthrough).toHaveBeenCalledTimes(1);
      expect(actual.status).toBe(expected.status);
      expect(actual.text).toBe(expected.text);
    });
  });

  describe('batched requests (critical 2)', () => {
    it('declines a single-element array body and answers like the plain gateway', async () => {
      const onSkip = vi.fn();
      const onPassthrough = vi.fn();
      await using plain = plainGateway({ batching: true });
      await using relayed = passthroughGateway(
        { onSkip, onPassthrough },
        { batching: true },
      );

      const expected = await post(plain, [{ query: QUERY }]);
      const actual = await post(relayed, [{ query: QUERY }]);

      expect(actual.status).toBe(expected.status);
      expect(actual.text).toBe(expected.text);
      // The array framing survives and nothing inside is a fabricated null.
      expect(JSON.parse(actual.text)).toEqual([
        { data: { products: expect.any(Array) } },
      ]);
      expect(actual.text).toContain('"Table"');
      expect(onPassthrough).not.toHaveBeenCalled();
      expect(onSkip).toHaveBeenCalledWith('batched-request', expect.anything());
    });

    it('declines a two-element array body and answers like the plain gateway', async () => {
      const onPassthrough = vi.fn();
      await using plain = plainGateway({ batching: true });
      await using relayed = passthroughGateway(
        { onPassthrough },
        { batching: true },
      );
      const body = [{ query: QUERY }, { query: `{ featured { upc name } }` }];

      const expected = await post(plain, body);
      const actual = await post(relayed, body);

      expect(actual.status).toBe(expected.status);
      expect(actual.text).toBe(expected.text);
      expect(onPassthrough).not.toHaveBeenCalled();
    });

    it('still relays a non-batched request on a batching-enabled gateway', async () => {
      const onPassthrough = vi.fn();
      await using plain = plainGateway({ batching: true });
      await using relayed = passthroughGateway(
        { onPassthrough },
        { batching: true },
      );

      const expected = await post(plain, { query: QUERY });
      const actual = await post(relayed, { query: QUERY });

      expect(onPassthrough).toHaveBeenCalledTimes(1);
      expect(actual.status).toBe(expected.status);
      expect(actual.text).toBe(expected.text);
    });
  });

  describe('post-commit failures (critical 3)', () => {
    it('never serializes the stub when the extensions cannot be serialized', async () => {
      const onSkip = vi.fn();
      const onPassthrough = vi.fn();
      await using plain = plainGateway({ plugins: [bigintExtensionsPlugin()] });
      await using relayed = passthroughGateway(
        { onSkip, onPassthrough },
        { plugins: [bigintExtensionsPlugin()] },
      );

      const expected = await post(plain, { query: QUERY });
      const actual = await post(relayed, { query: QUERY });

      // Whatever the plain gateway does with unserializable extensions —
      // today that is an error response — the relayed gateway must do the
      // same thing, and must never answer with the stub's fabricated nulls.
      expect(actual.status).toBe(expected.status);
      expect(actual.text).toBe(expected.text);
      expect(actual.text).not.toContain('"products":null');
      expect(onPassthrough).not.toHaveBeenCalled();
      expect(onSkip).toHaveBeenCalled();
    });
  });

  describe('inbound in-flight request deduplication (critical 4)', () => {
    it('never serves a follower the stub-derived nulls', async () => {
      const onSkip = vi.fn();
      await using relayed = passthroughGateway(
        { onSkip },
        { inboundDedupe: true, delayMs: 50 },
      );

      const [first, second] = await Promise.all([
        post(relayed, { query: QUERY }),
        post(relayed, { query: QUERY }),
      ]);

      for (const response of [first, second]) {
        // The one failure mode that must be impossible: a 200 whose data is
        // the stub. Any successful response must carry the subgraph's data.
        if (response.status === 200) {
          const parsed = JSON.parse(response.text) as {
            data?: { products?: unknown };
          };
          expect(parsed.data?.products).toEqual(products);
        }
      }
      // The requests overlapped (the resolver sleeps), so the deduplicating
      // plugin shared one execution result: the leader relays, the follower
      // must fail loudly rather than serialize the shared stub.
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 500]);
      const loud = first.status === 500 ? first : second;
      expect(loud.text).toContain('inboundInflightRequestDeduplication');
      expect(onSkip).toHaveBeenCalledWith(
        'stub-result-shared',
        expect.anything(),
      );
    });
  });

  describe('added outgoing fields (EXACT_FIELDS)', () => {
    it('declines an added ALIASED __typename such as __responseCacheTypeName', async () => {
      const onSkip = vi.fn();
      const onPassthrough = vi.fn();
      await using plain = plainGateway();
      await using relayed = passthroughGateway(
        { onSkip, onPassthrough },
        { plugins: [injectTypenamePlugin('__responseCacheTypeName')] },
      );

      const expected = await post(plain, { query: QUERY });
      const actual = await post(relayed, { query: QUERY });

      expect(onPassthrough).not.toHaveBeenCalled();
      expect(onSkip).toHaveBeenCalledWith(
        expect.stringContaining('adds "__responseCacheTypeName"'),
        expect.anything(),
      );
      expect(actual.status).toBe(expected.status);
      expect(actual.text).toBe(expected.text);
    });

    it('tolerates an added unaliased __typename when EXACT_FIELDS is off', async () => {
      const onPassthrough = vi.fn();
      await using relayed = passthroughGateway(
        { onPassthrough },
        { plugins: [injectTypenamePlugin()] },
      );

      const actual = await post(relayed, { query: QUERY });

      expect(onPassthrough).toHaveBeenCalledTimes(1);
      expect(actual.status).toBe(200);
      const parsed = JSON.parse(actual.text) as {
        data: { products: Array<Record<string, unknown>> };
      };
      // The extra key is the documented, accepted divergence.
      expect(parsed.data.products[0]).toMatchObject({
        upc: 'u1',
        __typename: 'Product',
      });
    });

    it('declines an added unaliased __typename when EXACT_FIELDS is on', async () => {
      const onSkip = vi.fn();
      const onPassthrough = vi.fn();
      await using plain = plainGateway();
      await using relayed = passthroughGateway(
        { onSkip, onPassthrough, checks: ['EXACT_FIELDS'] },
        { plugins: [injectTypenamePlugin()] },
      );

      const expected = await post(plain, { query: QUERY });
      const actual = await post(relayed, { query: QUERY });

      expect(onPassthrough).not.toHaveBeenCalled();
      expect(onSkip).toHaveBeenCalledWith(
        expect.stringContaining('adds "__typename"'),
        expect.anything(),
      );
      expect(actual.status).toBe(expected.status);
      expect(actual.text).toBe(expected.text);
    });
  });

  describe('content-length', () => {
    it('sets content-length on a relayed response', async () => {
      const onPassthrough = vi.fn();
      await using relayed = passthroughGateway({ onPassthrough });

      const actual = await post(relayed, { query: QUERY });

      expect(onPassthrough).toHaveBeenCalledTimes(1);
      expect(actual.contentLength).toBe(
        String(new TextEncoder().encode(actual.text).length),
      );
    });
  });
});
