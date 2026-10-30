/**
 * One of Auto route's pool workers (workerPool.ts): runs the tasks it is sent,
 * one at a time, and answers each with its output or why it failed.
 */
import { runAutoRouteTask } from './autoRouteTasks';
import { setTaskProgressReporter } from './taskProgress';
import type { PoolReply, PoolRequest } from './workerPool';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PoolRequest>) => void) | null;
  postMessage: (reply: PoolReply) => void;
};

scope.onmessage = async ({ data }) => {
  setTaskProgressReporter((progress) => scope.postMessage({ id: data.id, progress }));
  try {
    const started = performance.now();
    const output = await runAutoRouteTask(data.kind, data.input as never);
    scope.postMessage({ id: data.id, ok: true, output, workMs: performance.now() - started });
  } catch (error) {
    scope.postMessage({ id: data.id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
};
