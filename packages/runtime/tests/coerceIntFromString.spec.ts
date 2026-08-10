import { buildSubgraphSchema } from '@apollo/subgraph';
import { createGatewayRuntime } from '@graphql-hive/gateway-runtime';
import { Logger, MemoryLogWriter } from '@graphql-hive/logger';
import {
  composeLocalSchemasWithApollo,
  createDisposableServer,
} from '@internal/testing';
import { AsyncDisposableStack } from '@whatwg-node/disposablestack';
import { buildSchema, parse } from 'graphql';
import { createYoga } from 'graphql-yoga';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  useCoerceIntFromString,
  type CoerceIntFromStringOptions,
} from '../src/plugins/useCoerceIntFromString';

const typeDefs = parse(/* GraphQL */ `
  input Paging {
    first: Int
    label: String
  }

  input Filter {
    paging: Paging
    ids: [Int!]
    nested: [Filter!]
    label: String
  }

  type Query {
    add(a: Int!, b: Int!): Int!
    echo(filter: Filter!): String!
  }
`);

const resolvers = {
  Query: {
    add: (_root: unknown, { a, b }: { a: number; b: number }) => a + b,
    // Stringifying proves what actually reached the subgraph: 10 vs "10".
    echo: (_root: unknown, { filter }: { filter: unknown }) =>
      JSON.stringify(filter),
  },
};

const ADD = /* GraphQL */ `
  query Add($a: Int!, $b: Int!) {
    add(a: $a, b: $b)
  }
`;

let supergraph: string;
let stack: AsyncDisposableStack;

beforeAll(async () => {
  stack = new AsyncDisposableStack();
  const schema = buildSubgraphSchema({ typeDefs, resolvers });
  const upstream = stack.use(createYoga({ schema, logging: false }));
  const server = stack.use(await createDisposableServer(upstream));
  supergraph = await composeLocalSchemasWithApollo([
    {
      name: 'sub',
      schema,
      url: `${server.url}/graphql`,
    },
  ]);
});

afterAll(() => stack.disposeAsync());

async function execute(
  query: string,
  variables?: Record<string, unknown>,
  headers: Record<string, string> = {},
  opts?: CoerceIntFromStringOptions,
) {
  const writer = new MemoryLogWriter();
  await using gw = createGatewayRuntime({
    supergraph,
    logging: new Logger({ level: 'trace', writers: [writer] }),
    plugins: () => [useCoerceIntFromString(opts)],
  });
  const response = await gw.fetch('http://localhost:4000/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  const logs = writer.logs.filter((l) => l.msg?.includes('Coerced'));
  return { body, logs };
}

describe('useCoerceIntFromString', () => {
  it('coerces integer strings in top level variables', async () => {
    const { body, logs } = await execute(ADD, { a: '40', b: 2 });

    expect(body).toEqual({ data: { add: 42 } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: 'warn',
      attrs: {
        operationName: 'Add',
        coercions: [{ path: '$a', from: '40', to: 40 }],
      },
    });
  });

  it('coerces through input objects, lists and nesting, leaving String alone', async () => {
    const { body, logs } = await execute(
      /* GraphQL */ `
        query Echo($filter: Filter!) {
          echo(filter: $filter)
        }
      `,
      {
        filter: {
          paging: { first: '10', label: '7' },
          ids: ['1', 2, '-3'],
          nested: [{ paging: { first: '5' } }],
          label: '99',
        },
      },
    );

    expect(JSON.parse(body.data.echo)).toEqual({
      paging: { first: 10, label: '7' },
      ids: [1, 2, -3],
      nested: [{ paging: { first: 5 } }],
      label: '99',
    });
    expect(logs[0]?.attrs).toMatchObject({
      coercions: [
        { path: '$filter.paging.first', from: '10', to: 10 },
        { path: '$filter.ids[0]', from: '1', to: 1 },
        { path: '$filter.ids[2]', from: '-3', to: -3 },
        { path: '$filter.nested[0].paging.first', from: '5', to: 5 },
      ],
    });
  });

  it('records the client that sent the strings', async () => {
    const { logs } = await execute(
      ADD,
      { a: '1', b: '2' },
      {
        'graphql-client-name': 'legacy-app',
        'graphql-client-version': '1.2.3',
      },
    );

    expect(logs[0]?.attrs).toMatchObject({
      clientName: 'legacy-app',
      clientVersion: '1.2.3',
    });
  });

  it('does not log or coerce when every value is already an Int', async () => {
    const { body, logs } = await execute(ADD, { a: 40, b: 2 });

    expect(body).toEqual({ data: { add: 42 } });
    expect(logs).toHaveLength(0);
  });

  it.each([
    ['42.5', 'Int cannot represent'],
    ['abc', 'Int cannot represent'],
    ['', 'Int cannot represent'],
    ['1e3', 'Int cannot represent'],
    [' 42 ', 'Int cannot represent'],
    ['+42', 'Int cannot represent'],
    ['0x2a', 'Int cannot represent'],
    // Past Number.MAX_SAFE_INTEGER, so not coerced and not logged either.
    ['9007199254740993', 'Int cannot represent non-integer value'],
  ])('still rejects %o', async (value, message) => {
    const { body, logs } = await execute(ADD, { a: value, b: 2 });

    expect(body.data).toBeUndefined();
    expect(body.errors?.[0]?.message).toContain(message);
    expect(logs).toHaveLength(0);
  });

  it('logs at the configured level', async () => {
    const { logs } = await execute(
      ADD,
      { a: '1', b: 2 },
      {},
      { level: 'debug' },
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe('debug');
  });

  it('coerces out of range integers and lets GraphQL report the range error', async () => {
    const { body, logs } = await execute(ADD, { a: '99999999999', b: 2 });

    expect(body.errors?.[0]?.message).toContain(
      'Int cannot represent non 32-bit signed integer value',
    );
    expect(logs).toHaveLength(1);
  });

  // Envelop hands the very same `args` object to `subscribeFn`, so mutating it
  // in `onSubscribe` lands the same way it does for `execute`.
  it('coerces subscription variables as well', () => {
    const schema = buildSchema(/* GraphQL */ `
      type Query {
        _: Boolean
      }
      type Subscription {
        counter(from: Int!): Int!
      }
    `);
    const args = {
      schema,
      document: parse(/* GraphQL */ `
        subscription Counter($from: Int!) {
          counter(from: $from)
        }
      `),
      variableValues: { from: '7' } as Record<string, unknown>,
      contextValue: {},
    };

    useCoerceIntFromString().onSubscribe!({ args } as never);

    expect(args.variableValues).toEqual({ from: 7 });
  });

  it('does not reach inline literals', async () => {
    const { body, logs } = await execute(/* GraphQL */ `
      query Add {
        add(a: "40", b: 2)
      }
    `);

    expect(body.errors?.[0]?.message).toContain('Int cannot represent');
    expect(logs).toHaveLength(0);
  });
});
