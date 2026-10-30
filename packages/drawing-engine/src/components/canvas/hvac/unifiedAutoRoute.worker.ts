import { inlineTaskRunner, withTaskRunner } from './parallel/taskRunner';
import { poolSizeFor, WorkerPool } from './parallel/workerPool';
import { planUnifiedAutoRoute } from './unifiedAutoRoute';
import type { UnifiedAutoRouteRequest, UnifiedAutoRouteResponse } from './unifiedAutoRouteProtocol';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<UnifiedAutoRouteRequest>) => void) | null;
  postMessage: (response: UnifiedAutoRouteResponse) => void;
};

scope.onmessage = async ({ data }) => {
  if (data?.type !== 'route') return;
  // The run's independent searches go to a pool of workers of its own, stopped with it (so is it, by Cancel).
  const pool = data.inlineTasks ? null : new WorkerPool(data.poolSize ?? poolSizeFor(navigator.hardwareConcurrency),
    () => new Worker(new URL('./parallel/autoRoutePool.worker.ts', import.meta.url), { type: 'module' }));
  try {
    const result = await withTaskRunner(pool ?? inlineTaskRunner, () => planUnifiedAutoRoute(data.scene, {
      ...data.options,
      onProgress: (progress) => scope.postMessage({ type: 'progress', progress }),
    }));
    scope.postMessage({ type: 'result', result: pool && result.timings ? { ...result, timings: { ...result.timings, pool: pool.report() } } : result });
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Unable to calculate the network.' });
  } finally {
    pool?.terminate();
  }
};
