import {
  buildSchema,
  execute,
  Kind,
  parse,
  type ExecutionResult,
  type FragmentDefinitionNode,
  type GraphQLSchema,
  type OperationDefinitionNode,
} from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  synthesizeStubBody,
  synthesizeStubValue,
} from '../src/plugins/response-passthrough/stubValue';

/**
 * The stub's whole contract is "graphql-js completes it with zero errors" —
 * so every case here EXECUTES the operation over the synthesized value
 * instead of asserting on the value's shape. If graphql's completion rules
 * ever tighten, these tests fail with them.
 */

const schema = buildSchema(/* GraphQL */ `
  scalar DateTime

  enum Status {
    DRAFT
    PUBLISHED
  }

  interface Node {
    id: ID!
  }

  type Product implements Node {
    id: ID!
    name: String!
    price: Float!
    inStock: Boolean!
    quantity: Int!
    createdAt: DateTime!
    updatedAt: DateTime
    status: Status!
    tags: [String!]!
    reviews: [Review!]!
    vendor: Vendor!
    description: String
  }

  type Review implements Node {
    id: ID!
    body: String!
    product: Product!
  }

  type Vendor {
    name: String!
    address: Address!
  }

  type Address {
    street: String!
    city: String!
  }

  union SearchResult = Product | Review

  type Loop {
    name: String!
    next: Loop!
  }

  interface Ghost {
    id: ID!
  }

  type Query {
    featured: Product
    product: Product!
    products: [Product!]!
    maybeTags: [String]
    title: String
    status: Status!
    createdAt: DateTime!
    node: Node!
    search: SearchResult!
    loop: Loop!
    ghost: Ghost!
  }

  type Mutation {
    publish: Product!
  }
`);

function operationAndFragments(source: string): {
  operation: OperationDefinitionNode;
  fragments: Record<string, FragmentDefinitionNode>;
} {
  const document = parse(source);
  let operation: OperationDefinitionNode | undefined;
  const fragments: Record<string, FragmentDefinitionNode> = {};
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      operation = definition;
    } else if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments[definition.name.value] = definition;
    }
  }
  if (!operation) {
    throw new Error('test document has no operation');
  }
  return { operation, fragments };
}

/**
 * Synthesizes one root value per root field — keyed by field NAME, because
 * that is where the default resolver looks — and executes the operation over
 * it. This is exactly how the plugin's stub is consumed.
 */
async function executeOverStub(
  testSchema: GraphQLSchema,
  source: string,
): Promise<ExecutionResult> {
  const { operation, fragments } = operationAndFragments(source);
  const rootType =
    operation.operation === 'mutation'
      ? testSchema.getMutationType()
      : testSchema.getQueryType();
  const rootValue: Record<string, unknown> = {};
  for (const selection of operation.selectionSet.selections) {
    if (
      selection.kind !== Kind.FIELD ||
      selection.name.value === '__typename'
    ) {
      continue;
    }
    const field = rootType?.getFields()[selection.name.value];
    if (!field) {
      throw new Error(
        `test query selects unknown field ${selection.name.value}`,
      );
    }
    rootValue[selection.name.value] = synthesizeStubValue(
      testSchema,
      field.type,
      selection.selectionSet,
      fragments,
    );
  }
  return await execute({
    schema: testSchema,
    document: parse(source),
    rootValue,
  });
}

function synthesizeFor(source: string): unknown {
  const { operation, fragments } = operationAndFragments(source);
  const selection = operation.selectionSet.selections[0];
  if (selection?.kind !== Kind.FIELD) {
    throw new Error('test query root selection is not a field');
  }
  const field = schema.getQueryType()?.getFields()[selection.name.value];
  if (!field) {
    throw new Error(`test query selects unknown field ${selection.name.value}`);
  }
  return synthesizeStubValue(
    schema,
    field.type,
    selection.selectionSet,
    fragments,
  );
}

describe('synthesizeStubValue', () => {
  it('answers nullable positions with null and nothing more', async () => {
    const result = await executeOverStub(
      schema,
      '{ title maybeTags featured { name vendor { name } } }',
    );
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      title: null,
      maybeTags: null,
      featured: null,
    });
  });

  it('satisfies every kind of non-null built-in scalar', async () => {
    const result = await executeOverStub(
      schema,
      '{ product { id name price inStock quantity } }',
    );
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      product: {
        id: '',
        name: '',
        price: 0,
        inStock: false,
        quantity: 0,
      },
    });
  });

  it('satisfies a non-null enum with its first value', async () => {
    const result = await executeOverStub(schema, '{ status }');
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ status: 'DRAFT' });
  });

  // No value can be proven acceptable to a custom scalar's `serialize`, and a
  // stub that fails to complete would raise an error the plugin is entitled to
  // read as the subgraph's. Declining is the only safe answer.
  it('declines a non-null custom scalar rather than inventing a value', () => {
    const { operation, fragments } = operationAndFragments('{ createdAt }');
    expect(
      synthesizeStubBody(
        schema,
        operation,
        fragments,
        new Map([['createdAt', 'createdAt']]),
      ),
    ).toBeUndefined();
  });

  it('satisfies a NULLABLE custom scalar with null, never calling serialize', async () => {
    const result = await executeOverStub(schema, '{ product { updatedAt } }');
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ product: { updatedAt: null } });
  });

  it('answers a non-null list with an empty list, owing no items', async () => {
    const result = await executeOverStub(
      schema,
      '{ products { id name vendor { address { street } } } }',
    );
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ products: [] });
  });

  it('recurses through non-null objects nested two deep', async () => {
    const result = await executeOverStub(
      schema,
      '{ product { vendor { name address { street city } } } }',
    );
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      product: {
        vendor: { name: '', address: { street: '', city: '' } },
      },
    });
  });

  it('nulls nullable fields inside a non-null object', async () => {
    const result = await executeOverStub(
      schema,
      '{ product { name description } }',
    );
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ product: { name: '', description: null } });
  });

  it('picks a concrete type for a non-null interface', async () => {
    const result = await executeOverStub(
      schema,
      `{
        node {
          __typename
          id
          ... on Product { name vendor { name } }
          ... on Review { body }
        }
      }`,
    );
    expect(result.errors).toBeUndefined();
    const node = (result.data as { node: { __typename: string; id: string } })
      .node;
    expect(['Product', 'Review']).toContain(node.__typename);
    expect(node.id).toBe('');
  });

  it('resolves a non-null union without __typename being selected', async () => {
    // defaultTypeResolver still needs __typename on the VALUE even when the
    // client never asked for it — the stub must volunteer it.
    const result = await executeOverStub(
      schema,
      `{
        search {
          ... on Product { name price }
          ... on Review { body }
        }
      }`,
    );
    expect(result.errors).toBeUndefined();
    expect(result.data).toHaveProperty('search');
    expect(result.data!['search']).not.toBeNull();
  });

  it('resolves named fragment spreads', async () => {
    const result = await executeOverStub(
      schema,
      `
        query { product { ...ProductBits } }
        fragment ProductBits on Product {
          name
          vendor { ...VendorBits }
        }
        fragment VendorBits on Vendor { name address { city } }
      `,
    );
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      product: { name: '', vendor: { name: '', address: { city: '' } } },
    });
  });

  it('applies an interface-conditioned fragment to the chosen concrete type', async () => {
    const result = await executeOverStub(
      schema,
      '{ product { ... on Node { id } name } }',
    );
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ product: { id: '', name: '' } });
  });

  it('merges repeated selections of one field under different aliases', async () => {
    // Both aliases complete against the SAME source property, so the value
    // must satisfy the union of their sub-selections.
    const result = await executeOverStub(
      schema,
      `{
        product {
          a: vendor { name }
          b: vendor { address { street } }
        }
      }`,
    );
    expect(result.errors).toBeUndefined();
    // Each alias is completed with only its own sub-selection; the merge is
    // about the shared SOURCE value satisfying both, which zero errors proves.
    expect(result.data).toEqual({
      product: {
        a: { name: '' },
        b: { address: { street: '' } },
      },
    });
  });

  it('includes __typename on plain objects when asked', async () => {
    const result = await executeOverStub(
      schema,
      '{ product { __typename id } }',
    );
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ product: { __typename: 'Product', id: '' } });
  });

  it('survives a deep but finite non-null chain', async () => {
    const nested = Array.from({ length: 10 }).reduce<string>(
      (inner) => `next { ${inner} }`,
      'name',
    );
    const result = await executeOverStub(schema, `{ loop { ${nested} } }`);
    expect(result.errors).toBeUndefined();
  });

  it('gives up past the depth guard instead of looping', () => {
    const nested = Array.from({ length: 40 }).reduce<string>(
      (inner) => `next { ${inner} }`,
      'name',
    );
    expect(synthesizeFor(`{ loop { ${nested} } }`)).toBeNull();
  });

  it('gives up on a cyclic fragment spread', () => {
    const value = synthesizeFor(`
      query { loop { ...Spin } }
      fragment Spin on Loop { name next { ...Spin } }
    `);
    expect(value).toBeNull();
  });

  it('gives up on an undefined fragment spread', () => {
    expect(synthesizeFor('{ product { ...Missing } }')).toBeNull();
  });

  it('gives up on a non-null abstract type with no possible types', () => {
    expect(synthesizeFor('{ ghost { id } }')).toBeNull();
  });
});

describe('synthesizeStubBody', () => {
  function body(
    source: string,
    keyByClientKey: Map<string, string>,
  ): Uint8Array | undefined {
    const { operation, fragments } = operationAndFragments(source);
    return synthesizeStubBody(schema, operation, fragments, keyByClientKey);
  }

  function decode(bytes: Uint8Array): unknown {
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  it('builds {"data":{...}} keyed as the subgraph body would be', () => {
    const bytes = body(
      '{ title product { id } }',
      new Map([
        ['title', '_v0_title'],
        ['product', '_v0_product'],
      ]),
    );
    expect(bytes).toBeDefined();
    expect(decode(bytes!)).toEqual({
      data: { _v0_title: null, _v0_product: { id: '' } },
    });
  });

  it('emits an aliased client key under the subgraph key', () => {
    const bytes = body('{ p: product { name } }', new Map([['p', 'product']]));
    expect(bytes).toBeDefined();
    expect(decode(bytes!)).toEqual({ data: { product: { name: '' } } });
  });

  it('produces a body that executes with zero errors', async () => {
    const source =
      '{ title products { id } product { vendor { name } } status }';
    const bytes = body(
      source,
      new Map([
        ['title', 'title'],
        ['products', 'products'],
        ['product', 'product'],
        ['status', 'status'],
      ]),
    );
    expect(bytes).toBeDefined();
    const parsed = decode(bytes!) as { data: Record<string, unknown> };
    const result = await execute({
      schema,
      document: parse(source),
      rootValue: parsed.data,
    });
    expect(result.errors).toBeUndefined();
  });

  it('handles mutations', () => {
    const bytes = body(
      'mutation { publish { id name } }',
      new Map([['publish', 'publish']]),
    );
    expect(bytes).toBeDefined();
    expect(decode(bytes!)).toEqual({
      data: { publish: { id: '', name: '' } },
    });
  });

  it('declines when a root value cannot be synthesized', () => {
    expect(
      body('{ ghost { id } }', new Map([['ghost', 'ghost']])),
    ).toBeUndefined();
  });

  it('declines when a client key has no emit key', () => {
    expect(
      body('{ title product { id } }', new Map([['title', 'title']])),
    ).toBeUndefined();
  });

  it('declines when two client keys collapse onto one emit key', () => {
    const bytes = body(
      '{ a: product { id } b: product { id } }',
      new Map([
        ['a', 'product'],
        ['b', 'product'],
      ]),
    );
    expect(bytes).toBeUndefined();
  });
});
