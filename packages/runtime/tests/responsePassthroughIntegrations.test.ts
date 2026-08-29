/**
 * How the pass-through plugin behaves alongside other gateway features.
 *
 * Each case pairs a gateway that has the plugin with one that does not and
 * asserts they answer identically — these are the interactions where the
 * plugin previously diverged, so the point is the comparison, not the payload.
 */
import { createGatewayTester } from '@graphql-hive/gateway-testing';
import { expect, it } from 'vitest';
import { useResponsePassthrough } from '../src/plugins/response-passthrough';

const LINK = `extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key"])`;
const NO_DEDUPE = {
  '*': { options: { deduplicateInflightRequests: false } },
} as any;

let calls = 0;
function subgraphs() {
  return [
    {
      name: 'products',
      schema: {
        typeDefs: `${LINK}
          type Query { products: [Product!]! }
          type Product @key(fields: "upc") { upc: String! name: String }`,
        resolvers: {
          Query: {
            products: () => {
              calls++;
              return [{ upc: 'u1', name: 'One' }];
            },
          },
        },
      },
    },
  ];
}

const post = async (gw: any, headers: Record<string, string> = {}) => {
  const r = await gw.fetch('http://gw/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query: '{ products { upc name } }' }),
  });
  return { status: r.status, text: await r.text(), headers: r.headers };
};

it('does not make upstreamRetry re-fetch an eligible query', async () => {
  calls = 0;
  await using gw = createGatewayTester({
    subgraphs: subgraphs(),
    transportEntries: NO_DEDUPE,
    upstreamRetry: { maxRetries: 2 },
    plugins: () => [useResponsePassthrough()],
  });
  const r = await post(gw);
  expect(r.text).toBe('{"data":{"products":[{"upc":"u1","name":"One"}]}}');
  expect(calls).toBe(1);
});

it('honours extensions.http and keeps it out of the body', async () => {
  const httpExt = {
    onExecutionResult({ result, setResult }: any) {
      if (!result || typeof result !== 'object' || result.errors) return;
      setResult({
        ...result,
        extensions: {
          ...result.extensions,
          http: { status: 201, headers: { 'x-marker': 'yes' } },
        },
      });
    },
  };
  await using plain = createGatewayTester({
    subgraphs: subgraphs(),
    plugins: () => [httpExt],
  });
  await using relayed = createGatewayTester({
    subgraphs: subgraphs(),
    transportEntries: NO_DEDUPE,
    plugins: () => [httpExt, useResponsePassthrough()],
  });

  const p = await post(plain);
  const a = await post(relayed);
  expect(a.status).toBe(p.status);
  expect(a.headers.get('x-marker')).toBe(p.headers.get('x-marker'));
  expect(a.text).not.toContain('"http"');
  expect(a.text).toBe(p.text);
});

it('declines batched requests and answers both operations correctly', async () => {
  const skips: string[] = [];
  await using plain = createGatewayTester({
    subgraphs: subgraphs(),
    batching: true,
  });
  await using relayed = createGatewayTester({
    subgraphs: subgraphs(),
    transportEntries: NO_DEDUPE,
    batching: true,
    plugins: () => [useResponsePassthrough({ onSkip: (r) => skips.push(r) })],
  });

  const body = JSON.stringify([
    { query: '{ products { upc } }' },
    { query: '{ products { name } }' },
  ]);
  const call = async (gw: any) => {
    const r = await gw.fetch('http://gw/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    return await r.text();
  };

  const p = await call(plain);
  const a = await call(relayed);
  expect(a).toBe(p);
});
