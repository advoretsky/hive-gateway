/**
 * Adversarial differential cases for `useResponsePassthrough`.
 *
 * Every case here is an operation the plugin declares eligible and relays,
 * whose relayed bytes differ from what the gateway answers without the plugin.
 * These are the failure mode that matters: silent, client-visible divergence.
 *
 * Each `it` asserts the relayed answer equals the plain answer, so a passing
 * suite means the hole is closed.
 */

import {
  createGatewayTester,
  type GatewayTesterRemoteSchemaConfig,
} from '@graphql-hive/gateway-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useResponsePassthrough } from '../src/plugins/response-passthrough';

const LINK = `extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@inaccessible"])`;

function subgraphs(): GatewayTesterRemoteSchemaConfig[] {
  return [
    {
      name: 'catalog',
      schema: {
        typeDefs: /* GraphQL */ `
          ${LINK}
          enum Status {
            OK
            HIDDEN @inaccessible
          }
          type Query {
            products: [Product!]!
            status: Status
            statuses: [Status!]!
            padding: String
          }
          type Product @key(fields: "upc") {
            upc: String!
            name: String
            reviews: [Review!]
          }
          type Review {
            id: ID!
            body: String
            status: Status
          }
        `,
        resolvers: {
          Query: {
            products: () => [
              {
                __typename: 'Product',
                upc: 'u1',
                name: 'Table',
                reviews: [{ id: 'r1', body: 'ok', status: 'HIDDEN' }],
              },
            ],
            status: () => 'HIDDEN',
            statuses: () => ['OK', 'HIDDEN'],
            // Keeps every response large enough that a decline could never be
            // an artefact of a `minBytes` threshold.
            padding: () => 'x'.repeat(512),
          },
        },
      },
    },
  ];
}

interface Case {
  name: string;
  query: string;
  /** the accept header the client sends */
  accept?: string;
}

const cases: Case[] = [
  {
    // `checkEligibility` only screens root fields that HAVE a selection set
    // (eligibility.ts: `if (selection.kind !== Kind.FIELD || !selection.selectionSet) continue`),
    // so a root field that is itself a leaf never reaches `findLeafHazard`
    // and its enum / custom-scalar hazards go unchecked.
    name: 'root leaf enum with an @inaccessible value',
    query: `{ padding status }`,
  },
  {
    // Same hole, and here the gateway would not merely null the value: the
    // list is non-null, so execution propagates the null all the way to
    // `data: null` plus an error. The relay answers with full data instead.
    name: 'root leaf enum list holding an @inaccessible value',
    query: `{ padding statuses }`,
  },
  {
    // `findLeafHazard` keys its `seen` set on `Type.field` alone and shares it
    // across the whole walk, so the SECOND selection of the same field is
    // skipped even though its sub-selection is completely different. The
    // `status` enum below is never screened.
    name: 'repeated field whose second selection hides an @inaccessible enum',
    query: `{ padding products { reviews { id } reviews { status } } }`,
  },
  {
    // The same, reached the way a real client reaches it: one fragment adds a
    // second selection of `reviews`.
    name: 'fragment adding a second selection of an already-walked field',
    query: `
      { padding products { reviews { id } ...Extra } }
      fragment Extra on Product { reviews { status } }
    `,
  },
  {
    // `negotiatedJsonMediaType` re-negotiates from the accept header on its
    // own and always lands on a JSON media type, overriding the SSE result
    // processor Yoga had selected.
    name: 'client accepting only text/event-stream',
    query: `{ padding products { upc name } }`,
    accept: 'text/event-stream',
  },
  {
    name: 'client accepting only multipart/mixed',
    query: `{ padding products { upc name } }`,
    accept: 'multipart/mixed',
  },
];

const passedThrough: unknown[] = [];

let plain: ReturnType<typeof createGatewayTester>;
let relaying: ReturnType<typeof createGatewayTester>;

beforeAll(() => {
  plain = createGatewayTester({ subgraphs: subgraphs() });
  relaying = createGatewayTester({
    transportEntries: {
      '*': { options: { deduplicateInflightRequests: false } },
    },
    subgraphs: subgraphs(),
    plugins: () => [
      useResponsePassthrough({
        minBytes: 0,
        // These cases exist to prove the LEAF_VALUES protection closes the
        // enum/scalar holes, so the check the default trusts away is opted
        // back in here.
        checks: ['LEAF_VALUES'],
        onPassthrough: (info) => {
          passedThrough.push(info);
        },
      }),
    ],
  });
});

afterAll(async () => {
  await plain?.dispose();
  await relaying?.dispose();
});

beforeEach(() => {
  passedThrough.length = 0;
});

async function post(gw: { fetch: typeof fetch }, testCase: Case) {
  const response = await gw.fetch('http://gateway/graphql', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: testCase.accept ?? 'application/json',
    },
    body: JSON.stringify({ query: testCase.query }),
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    text: await response.text(),
  };
}

describe('response pass-through adversarial', () => {
  for (const testCase of cases) {
    it(`answers identically: ${testCase.name}`, async () => {
      const expected = await post(plain, testCase);
      const actual = await post(relaying, testCase);

      expect(actual.contentType).toBe(expected.contentType);
      expect(actual.status).toBe(expected.status);
      expect(actual.text).toBe(expected.text);
    });
  }
});
