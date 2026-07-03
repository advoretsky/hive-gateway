import { getUnifiedGraphGracefully } from '@graphql-mesh/fusion-composition';
import { createDefaultExecutor } from '@graphql-tools/delegate';
import { createDeferred, type Executor } from '@graphql-tools/utils';
import { DisposableSymbols } from '@whatwg-node/disposablestack';
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
});
