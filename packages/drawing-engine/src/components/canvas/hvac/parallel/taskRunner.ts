/**
 * Auto route's independent searches, run in parallel where the platform
 * allows: on a pool of background workers in the browser (the Auto route
 * worker owns it, workerPool.ts), one after another anywhere else (tests, a
 * browser without nested module workers).
 *
 * Either way a task is a pure function of its input: no shared memory, no
 * clock, and everything it reads arrives in the input (the routing and duct
 * settings included: a worker starts with none of the caller's). Outputs come
 * back in the order the tasks were given, and callers merge them in that
 * order, so the answer is exactly the one-after-another answer.
 */
import { runAutoRouteTask, type AutoRouteTaskKind, type AutoRouteTaskInput, type AutoRouteTaskOutput } from './autoRouteTasks';
import { setTaskProgressReporter, type TaskProgress } from './taskProgress';

export interface ParallelTask<K extends AutoRouteTaskKind = AutoRouteTaskKind> {
  kind: K;
  input: AutoRouteTaskInput<K>;
}

/** A task started in case its answer is wanted. */
export interface SpeculativeTask<K extends AutoRouteTaskKind = AutoRouteTaskKind> {
  /** Its answer is wanted now: it goes first if it has not started. */
  want(): Promise<AutoRouteTaskOutput<K>>;
  /** Its answer is not wanted: stop it. */
  cancel(): void;
}

export interface TaskRunner {
  /** How many tasks can run at once (1: one after another). */
  readonly concurrency: number;
  /** Runs the tasks; resolves with their outputs, in the tasks' order. */
  all<K extends AutoRouteTaskKind>(tasks: ReadonlyArray<ParallelTask<K>>,
    onProgress?: (index: number, progress: TaskProgress) => void): Promise<Array<AutoRouteTaskOutput<K>>>;
  /**
   * Gives a task to whatever workers the others leave free, in case its answer
   * is wanted. Absent where there are no spare workers: the caller then
   * computes the answer if and when it is wanted.
   */
  speculate?<K extends AutoRouteTaskKind>(task: ParallelTask<K>): SpeculativeTask<K>;
}

let inlineTail: Promise<unknown> = Promise.resolve();

/**
 * Runs each task here, one after another, through the same boundary a worker
 * has: its input and output are structured-cloned, so nothing is shared with
 * the caller, and it runs in a routing session of its own.
 */
export const inlineTaskRunner: TaskRunner = {
  concurrency: 1,
  all<K extends AutoRouteTaskKind>(tasks: ReadonlyArray<ParallelTask<K>>, onProgress?: (index: number, progress: TaskProgress) => void) {
    // One at a time, also across calls made together: a task owns this thread's session and settings while it runs.
    const run = inlineTail.then(async () => {
      const outputs: Array<AutoRouteTaskOutput<K>> = [];
      for (const [index, task] of tasks.entries()) {
        const previous = setTaskProgressReporter(onProgress ? (progress) => onProgress(index, progress) : null);
        try {
          outputs.push(structuredClone(await runAutoRouteTask(task.kind, structuredClone(task.input))));
        } finally {
          setTaskProgressReporter(previous);
        }
      }
      return outputs;
    });
    inlineTail = run.then(() => undefined, () => undefined);
    return run;
  },
};

let active: TaskRunner = inlineTaskRunner;

/** The runner Auto route's searches use now. */
export function activeTaskRunner(): TaskRunner {
  return active;
}

/** Runs `plan` with `runner` for its searches (the Auto route worker, with its pool). */
export async function withTaskRunner<T>(runner: TaskRunner, plan: () => Promise<T>): Promise<T> {
  const previous = active;
  active = runner;
  try {
    return await plan();
  } finally {
    active = previous;
  }
}
