import { describe, expect, it } from 'vitest';

import { LatestOnlyAsyncQueue } from './latestOnlyAsyncQueue';

interface DeferredExecution<Input, Output> {
  input: Input;
  resolve: (value: Output) => void;
  reject: (reason: unknown) => void;
}

function createControlledQueue<Input, Output>() {
  const executions: Array<DeferredExecution<Input, Output>> = [];
  const queue = new LatestOnlyAsyncQueue<Input, Output>((input) => (
    new Promise<Output>((resolve, reject) => {
      executions.push({ input, resolve, reject });
    })
  ));
  return { queue, executions };
}

describe('LatestOnlyAsyncQueue', () => {
  it('runs one job and retains only the newest queued input', async () => {
    const { queue, executions } = createControlledQueue<number, string>();

    const active = queue.enqueue(1);
    const superseded = queue.enqueue(2);
    const latest = queue.enqueue(3);

    expect(executions.map(({ input }) => input)).toEqual([1]);
    expect(superseded).toBe(latest);

    executions[0]!.resolve('first');
    await expect(active).resolves.toBe('first');
    expect(executions.map(({ input }) => input)).toEqual([1, 3]);

    executions[1]!.resolve('latest');
    await expect(Promise.all([superseded, latest])).resolves.toEqual([
      'latest',
      'latest',
    ]);
  });

  it('starts the newest queued job after an active failure', async () => {
    const { queue, executions } = createControlledQueue<string, string>();
    const error = new Error('worker failed');

    const active = queue.enqueue('active');
    const superseded = queue.enqueue('old');
    const latest = queue.enqueue('newest');

    executions[0]!.reject(error);
    await expect(active).rejects.toBe(error);
    expect(executions.map(({ input }) => input)).toEqual(['active', 'newest']);

    executions[1]!.resolve('fallback result');
    await expect(Promise.all([superseded, latest])).resolves.toEqual([
      'fallback result',
      'fallback result',
    ]);
  });

  it('does not wedge when the executor throws synchronously', async () => {
    const executed: string[] = [];
    const queue = new LatestOnlyAsyncQueue<string, string>((input) => {
      executed.push(input);
      if (input === 'bad') {
        throw new Error('synchronous failure');
      }
      return Promise.resolve(input);
    });

    const failed = queue.enqueue('bad');
    const recovered = queue.enqueue('good');

    await expect(failed).rejects.toThrow('synchronous failure');
    await expect(recovered).resolves.toBe('good');
    expect(executed).toEqual(['bad', 'good']);
  });

  it('returns to idle after draining', async () => {
    const { queue, executions } = createControlledQueue<number, number>();

    const first = queue.enqueue(1);
    executions[0]!.resolve(10);
    await expect(first).resolves.toBe(10);

    const second = queue.enqueue(2);
    expect(executions.map(({ input }) => input)).toEqual([1, 2]);
    executions[1]!.resolve(20);
    await expect(second).resolves.toBe(20);
  });
});
