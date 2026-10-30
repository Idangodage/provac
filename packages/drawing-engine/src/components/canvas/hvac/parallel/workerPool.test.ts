import { describe, expect, it } from 'vitest';

import { resolveDuctSettings } from '../duct/ductSettings';
import type { SizeTreesRequest } from '../duct/optimizer/ductOptimizer';

import { sizeTreesOn, type SizeTreesTask } from './autoRouteTasks';
import { runSteps, runStepsAsync, scopedSteps } from './steps';
import { inlineTaskRunner, type TaskRunner } from './taskRunner';
import { poolSizeFor, WorkerPool, type PoolReply, type PoolRequest } from './workerPool';

class FakeWorker {
  onmessage: ((event: { data: PoolReply }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault?: () => void }) => void) | null = null;
  posted: PoolRequest[] = [];
  terminated = false;
  postMessage(request: PoolRequest): void { this.posted.push(request); }
  terminate(): void { this.terminated = true; }
  answer(output: unknown): void {
    const request = this.posted.at(-1)!;
    this.onmessage?.({ data: { id: request.id, ok: true, output, workMs: 1 } });
  }
}

function pool(size: number) {
  const workers: FakeWorker[] = [];
  const instance = new WorkerPool(size, () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  return { instance, workers };
}

const settings = resolveDuctSettings({});
const emptyTask = (): SizeTreesTask => ({
  ctx: { service: 'supply', construction: 'gi-nbr', settings, maxHeightMm: 500 } as unknown as SizeTreesTask['ctx'],
  designs: [], shape: 'optimal', unitAirflowM3h: 1000, budgetPa: 150,
});
const task = () => ({ kind: 'size-trees' as const, input: emptyTask() });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('WorkerPool', () => {
  it('starts workers on demand up to its size, and answers in the tasks’ order whatever order they finish in', async () => {
    const { instance, workers } = pool(2);
    const all = instance.all([task(), task(), task()]);
    expect(workers).toHaveLength(2);
    expect(workers.map((worker) => worker.posted.length)).toEqual([1, 1]);
    workers[1]!.answer('second');
    // The freed worker takes the task that waited.
    expect(workers[1]!.posted).toHaveLength(2);
    workers[1]!.answer('third');
    workers[0]!.answer('first');
    await expect(all).resolves.toEqual(['first', 'second', 'third']);
    instance.terminate();
  });

  it('passes each task’s progress on, by its place in the list', async () => {
    const { instance, workers } = pool(2);
    const heard: Array<[number, number]> = [];
    const all = instance.all([task(), task()], (index, progress) => heard.push([index, progress.completed]));
    workers[1]!.onmessage?.({ data: { id: workers[1]!.posted[0]!.id, progress: { completed: 3, total: 7 } } });
    workers[0]!.onmessage?.({ data: { id: workers[0]!.posted[0]!.id, progress: { completed: 1, total: 7 } } });
    expect(heard).toEqual([[1, 3], [0, 1]]);
    workers[0]!.answer(0); workers[1]!.answer(1);
    await all;
    instance.terminate();
  });

  it('gives speculative tasks only workers no other task wants, and never ahead of one', async () => {
    const { instance, workers } = pool(2);
    const speculative = instance.speculate(task());
    expect(workers).toHaveLength(1);
    const normal = instance.run('size-trees', emptyTask());
    const later = instance.speculate(task());
    expect(workers).toHaveLength(2);
    // Both workers are busy: the later speculative task waits, and a normal task goes before it.
    const next = instance.run('size-trees', emptyTask());
    workers[1]!.answer('normal');
    await expect(normal).resolves.toBe('normal');
    expect(workers[1]!.posted).toHaveLength(2);
    workers[1]!.answer('next');
    await expect(next).resolves.toBe('next');
    expect(workers[1]!.posted).toHaveLength(3);
    workers[1]!.answer('later');
    await expect(later.want()).resolves.toBe('later');
    workers[0]!.answer('speculative');
    await expect(speculative.want()).resolves.toBe('speculative');
    instance.terminate();
  });

  it('runs a wanted speculative task first, and drops one no longer wanted', async () => {
    const { instance, workers } = pool(1);
    const running = instance.speculate(task());
    const waiting = instance.speculate(task());
    const wanted = instance.speculate(task());
    waiting.cancel();
    const answer = wanted.want();
    // Off the running worker: stopped, and a new one takes the wanted task.
    running.cancel();
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    workers[1]!.answer('wanted');
    await expect(answer).resolves.toBe('wanted');
    expect(workers[1]!.posted).toHaveLength(1);
    instance.terminate();
  });

  it('runs tasks here when no worker can start', async () => {
    const instance = new WorkerPool(3, () => { throw new Error('no nested workers'); });
    await expect(instance.all([task(), task()])).resolves.toEqual([[], []]);
    const speculative = instance.speculate(task());
    await expect(speculative.want()).resolves.toEqual([]);
    instance.terminate();
  });

  it('runs a task again elsewhere when its worker fails, and does not use that worker again', async () => {
    const { instance, workers } = pool(2);
    const first = instance.run('size-trees', emptyTask());
    const second = instance.run('size-trees', emptyTask());
    workers[0]!.onerror?.({ message: 'out of memory' });
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    workers[1]!.answer('second');
    await expect(second).resolves.toBe('second');
    // The failed worker's task went to the one left.
    expect(workers[1]!.posted).toHaveLength(2);
    workers[1]!.answer('first');
    await expect(first).resolves.toBe('first');
    instance.terminate();
  });

  it('a speculative task that loses its worker waits, unless its answer has been asked for', async () => {
    const { instance, workers } = pool(2);
    const speculative = instance.speculate(task());
    const asked = instance.speculate(task());
    workers[0]!.onerror?.({ message: 'could not load' });
    workers[1]!.onerror?.({ message: 'could not load' });
    // No worker is left, and nothing here runs a task nobody asked for: asking for it is what runs it.
    let answered = false;
    const answer = asked.want().then((output) => { answered = true; return output; });
    await flush();
    expect(answered).toBe(true);
    await expect(answer).resolves.toEqual([]);
    expect(instance.report().tasks.filter((entry) => entry.ranMs !== undefined && entry.worker === 0)).toHaveLength(1);
    speculative.cancel();
    instance.terminate();
  });

  it('a task asked for while its worker fails is run again here', async () => {
    const { instance, workers } = pool(1);
    const speculative = instance.speculate(task());
    const answer = speculative.want();
    workers[0]!.onerror?.({ message: 'could not load' });
    await expect(answer).resolves.toEqual([]);
    instance.terminate();
  });

  it('with no worker left, runs a failed worker’s task here', async () => {
    const { instance, workers } = pool(1);
    const only = instance.run('size-trees', emptyTask());
    workers[0]!.onerror?.({ message: 'could not load' });
    await expect(only).resolves.toEqual([]);
    expect(workers).toHaveLength(1);
    instance.terminate();
  });

  it('stops every worker and fails what is pending when terminated; a speculative task’s failure bothers nobody', async () => {
    const { instance, workers } = pool(1);
    const running = instance.run('size-trees', emptyTask());
    const queued = instance.run('size-trees', emptyTask());
    instance.speculate(task());
    instance.terminate();
    await expect(running).rejects.toThrow(/stopped/);
    await expect(queued).rejects.toThrow(/stopped/);
    expect(workers[0]!.terminated).toBe(true);
    await expect(instance.run('size-trees', emptyTask())).rejects.toThrow(/stopped/);
    await flush();
  });

  it('sizes itself to the machine: all cores but two, at most four, at least one', () => {
    expect(poolSizeFor(16)).toBe(4);
    expect(poolSizeFor(5)).toBe(3);
    expect(poolSizeFor(2)).toBe(1);
    expect(poolSizeFor(undefined)).toBe(2);
  });
});

describe('the inline runner', () => {
  it('passes tasks through the boundary a worker has, one at a time even when called together', async () => {
    const [a, b] = await Promise.all([inlineTaskRunner.all([task()]), inlineTaskRunner.all([task(), task()])]);
    expect(a).toEqual([[]]);
    expect(b).toEqual([[], []]);
    const notCloneable = { kind: 'size-trees' as const, input: { ...emptyTask(), ids: () => 'x' } as unknown as SizeTreesTask };
    await expect(inlineTaskRunner.all([notCloneable])).rejects.toThrow();
  });
});

describe('sizeTreesOn', () => {
  const request = (count: number): SizeTreesRequest => ({
    ctx: { ...emptyTask().ctx, baseScene: [{ id: 'scene' }], ids: () => 'x', crossing: { allows: () => true } },
    designs: Array.from({ length: count }, (_, index) => ({ label: `tree ${index}` })),
    shape: 'optimal', unitAirflowM3h: 1000, budgetPa: 150, model: {}, grid: { stepPa: 0.2, size: 10 },
  } as unknown as SizeTreesRequest);
  const runner = (concurrency: number) => {
    const sizes: number[] = [];
    const seen: SizeTreesTask[] = [];
    const fake: TaskRunner = {
      concurrency,
      all: (tasks) => {
        const inputs = tasks.map((entry) => entry.input as SizeTreesTask);
        seen.push(...inputs);
        sizes.push(...inputs.map((input) => input.designs.length));
        return Promise.resolve(inputs.map((input) => input.designs.map((design) => ({ tree: null, failures: [{ runKey: (design as unknown as { label: string }).label }] })))) as never;
      },
    };
    return { fake, sizes, seen };
  };

  it('sends one run where there is one worker, about two per worker otherwise, and puts the answers back in the trees’ order', async () => {
    const one = runner(1);
    const answers = await sizeTreesOn(one.fake, request(7));
    expect(one.sizes).toEqual([7]);
    expect(answers.map((answer) => (answer.failures[0] as unknown as { runKey: string }).runKey)).toEqual(Array.from({ length: 7 }, (_, index) => `tree ${index}`));
    const three = runner(3);
    const threeAnswers = await sizeTreesOn(three.fake, request(13));
    expect(three.sizes).toEqual([3, 3, 3, 3, 1]);
    expect(threeAnswers.map((answer) => (answer.failures[0] as unknown as { runKey: string }).runKey)).toEqual(Array.from({ length: 13 }, (_, index) => `tree ${index}`));
    expect(await sizeTreesOn(three.fake, request(0))).toEqual([]);
  });

  it('leaves out of a task what a worker cannot be sent and sizing never reads', async () => {
    const { fake, seen } = runner(2);
    await sizeTreesOn(fake, request(1));
    expect(Object.keys(seen[0]!.ctx)).not.toEqual(expect.arrayContaining(['ids']));
    expect(seen[0]!.ctx).not.toHaveProperty('crossing');
    expect(seen[0]!.ctx).not.toHaveProperty('baseScene');
  });
});

describe('steps', () => {
  function* doubling(values: number[]): Generator<number, number, number> {
    let total = 0;
    for (const value of values) total += yield value;
    return total;
  }

  it('run here or asynchronously, with the same answer', async () => {
    expect(runSteps(doubling([1, 2, 3]), (value) => value * 2)).toBe(12);
    await expect(runStepsAsync(doubling([1, 2, 3]), (value) => Promise.resolve(value * 2))).resolves.toBe(12);
  });

  it('keep a scope only around their own stretches, not the work handed off', () => {
    let inScope = false;
    const seen: boolean[] = [];
    function* inner(): Generator<string, string, string> {
      seen.push(inScope);
      const answer = yield 'request';
      seen.push(inScope);
      return answer;
    }
    const scope = <T>(run: () => T): T => {
      const before = inScope;
      inScope = true;
      try { return run(); } finally { inScope = before; }
    };
    const result = runSteps(scopedSteps(scope, inner()), (request) => { seen.push(inScope); return `${request} answered`; });
    expect(result).toBe('request answered');
    expect(seen).toEqual([true, false, true]);
  });
});
