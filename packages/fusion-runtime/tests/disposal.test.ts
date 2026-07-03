import { getUnifiedGraphGracefully } from '@graphql-mesh/fusion-composition';
import { createDefaultExecutor } from '@graphql-tools/delegate';
import { normalizedExecutor } from '@graphql-tools/executor';
import { createDeferred, type Executor } from '@graphql-tools/utils';
import { DisposableSymbols } from '@whatwg-node/disposablestack';
import { parse, type GraphQLError } from 'graphql';
import { createSchema } from 'graphql-yoga';
import { describe, expect, it, vi } from 'vitest';
import { handleFederationSupergraph } from '../src/federation/supergraph';
import { UnifiedGraphManager } from '../src/unifiedGraphManager';

describe('UnifiedGraphManager disposal', () => {
  const makeSdl = (field: string) =>
    getUnifiedGraphGracefully([
      {
        name: 'Test',
        schema: createSchema({
          typeDefs: /* GraphQL */ `
            type Query {
              ${field}: String
            }
          `,
          resolvers: {
            Query: {
              [field]: () => 'hi',
            },
          },
        }),
      },
    ]);

  it('does not resurrect a generation from a reload that resolves after dispose', async () => {
    const sdlV1 = makeSdl('hello');
    const sdlV2 = makeSdl('helloAgain');

    let loads = 0;
    const secondLoad = createDeferred<string>();
    const executorDisposeFns: Array<ReturnType<typeof vi.fn>> = [];

    const manager = new UnifiedGraphManager({
      getUnifiedGraph: () => {
        loads++;
        if (loads === 1) {
          return sdlV1;
        }
        return secondLoad.promise;
      },
      // Attach a disposable executor to each generation (the router-runtime
      // shape) so leaking a generation's resources is observable.
      handleUnifiedGraph: (opts) => {
        const result = handleFederationSupergraph(opts);
        const executor: Executor = createDefaultExecutor(result.unifiedGraph);
        const disposeFn = vi.fn();
        Object.defineProperty(executor, DisposableSymbols.asyncDispose, {
          value: disposeFn,
        });
        executorDisposeFns.push(disposeFn);
        return { ...result, executor };
      },
      transports() {
        return {
          getSubgraphExecutor() {
            throw new Error('unexpected subgraph execution in this test');
          },
        };
      },
    });

    await manager.getUnifiedGraph();
    expect(executorDisposeFns).toHaveLength(1);

    // A reload is in flight when the manager is disposed...
    const reload$ = manager.invalidateUnifiedGraph();
    await manager[DisposableSymbols.asyncDispose]();
    expect(executorDisposeFns[0]).toHaveBeenCalled();

    // ...and resolves only afterwards: the freshly built generation must be
    // torn down instead of being installed on the disposed manager.
    secondLoad.resolve(sdlV2);
    await reload$;

    expect(executorDisposeFns).toHaveLength(2);
    expect(executorDisposeFns[1]).toHaveBeenCalled();
  });

  it('keeps the SHUTTING_DOWN abort reason when a pending load fails during shutdown', async () => {
    const subgraphSchema = createSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          hello: String
        }
      `,
      resolvers: {
        Query: {
          hello: () => 'hi',
        },
      },
    });
    const sdl = getUnifiedGraphGracefully([
      { name: 'Test', schema: subgraphSchema },
    ]);

    let loads = 0;
    const secondLoad = createDeferred<string>();
    let capturedGetDisposeReason: (() => GraphQLError | undefined) | undefined;

    const manager = new UnifiedGraphManager({
      getUnifiedGraph: () => {
        loads++;
        if (loads === 1) {
          return sdl;
        }
        return secondLoad.promise;
      },
      transports() {
        return {
          getSubgraphExecutor(payload) {
            // The reason consulted when this transport's in-flight requests
            // are aborted at disposal time.
            capturedGetDisposeReason = payload.getDisposeReason;
            return createDefaultExecutor(subgraphSchema);
          },
        };
      },
    });

    // Execute once so the transport is instantiated for the generation. Under
    // the router runtime, execution goes through the manager's executor
    // rather than the schema's own resolvers.
    const schema = await manager.getUnifiedGraph();
    const contextValue = await manager.getContext({});
    const document = parse(/* GraphQL */ `
      {
        hello
      }
    `);
    const executor = await manager.getExecutor();
    const result = await (executor
      ? executor({ document, context: contextValue })
      : normalizedExecutor({ schema, document, contextValue }));
    if (Symbol.asyncIterator in result) {
      throw new Error('unexpected incremental result');
    }
    expect(result.data?.hello).toBe('hi');
    expect(capturedGetDisposeReason).toBeDefined();

    // A reload is in flight when shutdown starts, and it FAILS afterwards: the
    // failure must not erase the SHUTTING_DOWN reason that in-flight subgraph
    // requests are aborted with.
    const reload$ = manager.invalidateUnifiedGraph();
    const disposed$ = manager[DisposableSymbols.asyncDispose]();
    secondLoad.reject(new Error('schema registry unavailable'));
    await expect(reload$).rejects.toThrow('schema registry unavailable');
    await disposed$;

    expect(capturedGetDisposeReason!()?.extensions?.['code']).toBe(
      'SHUTTING_DOWN',
    );
  });
});
