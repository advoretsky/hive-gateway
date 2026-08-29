import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createGatewayTester,
  type GatewayTester,
  type GatewayTesterRemoteSchemaConfig,
} from '@graphql-hive/gateway-testing';
import { benchConfig } from '@internal/testing';
import { fetch } from '@whatwg-node/fetch';
import { afterAll, bench, describe, expect } from 'vitest';
import { useResponsePassthrough } from '../../packages/runtime/src/plugins/response-passthrough';

const LINK = `extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key"])`;

// The pass-through win scales with payload size: parsing, graphql-js
// completion and re-serialization are all O(bytes). ~2000 products with
// nested reviews put the response well past 1MB, the region where the
// gateway's normal path visibly dominates request latency.
const PRODUCT_COUNT = 2000;
const REVIEWS_PER_PRODUCT = 5;

const products = Array.from({ length: PRODUCT_COUNT }, (_, i) => ({
  upc: `upc-${i}`,
  name: `Product ${i} ${'well built and beautifully finished '.repeat(2)}`,
  price: i % 1000,
  reviews: Array.from({ length: REVIEWS_PER_PRODUCT }, (_, r) => ({
    id: `review-${i}-${r}`,
    body: `Review ${r} of product ${i}: ${'sturdy and reliable, would buy again '.repeat(2)}`,
  })),
}));

function subgraphs(): GatewayTesterRemoteSchemaConfig[] {
  return [
    {
      name: 'products',
      schema: {
        typeDefs: /* GraphQL */ `
          ${LINK}
          type Query {
            products: [Product!]!
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
            products: () => products,
          },
        },
      },
    },
  ];
}

describe('Response pass-through', async () => {
  const query = `{ products { upc name price reviews { id body } } }`;
  const requestBody = JSON.stringify({ query });

  let relayed = 0;
  const gateways: Record<string, GatewayTester> = {
    'Hive Gateway': createGatewayTester({
      transportEntries: {
        '*': { options: { deduplicateInflightRequests: false } },
      },
      subgraphs: subgraphs(),
    }),
    'Hive Gateway w/ Response Passthrough': createGatewayTester({
      transportEntries: {
        '*': { options: { deduplicateInflightRequests: false } },
      },
      subgraphs: subgraphs(),
      plugins: () => [
        useResponsePassthrough({
          onPassthrough: () => {
            relayed++;
          },
        }),
      ],
    }),
  };

  const servers: Server[] = [];
  afterAll(async () => {
    for (const server of servers) {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
    for (const gw of Object.values(gateways)) {
      await gw.dispose();
    }
  });

  // Both variants are measured over a real node:http socket because the
  // pass-through exists to cut per-request gateway work; an in-process
  // fetch would skip the transport both variants share in production.
  async function serve(gw: GatewayTester): Promise<string> {
    const server = createServer(gw.runtime);
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/graphql`;
  }

  async function post(url: string): Promise<string> {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: requestBody,
    });
    return response.text();
  }

  const plainUrl = await serve(gateways['Hive Gateway']!);
  const relayUrl = await serve(
    gateways['Hive Gateway w/ Response Passthrough']!,
  );

  // Prime both variants once so the benchmark bodies can assert against a
  // known-good byte-exact answer: the pass-through is required to produce
  // the very bytes the normal path would, so a divergence — or a silently
  // declined relay — must fail the setup, not get benchmarked.
  const expectedText = await post(plainUrl);
  expect(JSON.parse(expectedText)).toEqual({ data: { products } });
  expect(expectedText.length).toBeGreaterThan(1_000_000);
  expect(await post(relayUrl)).toBe(expectedText);
  expect(relayed).toBeGreaterThan(0);

  const urls: Record<string, string> = {
    'Hive Gateway': plainUrl,
    'Hive Gateway w/ Response Passthrough': relayUrl,
  };

  for (const [gwName, url] of Object.entries(urls)) {
    bench(
      gwName,
      async () => {
        const text = await post(url);
        expect(text).toBe(expectedText);
      },
      benchConfig,
    );
  }
});
