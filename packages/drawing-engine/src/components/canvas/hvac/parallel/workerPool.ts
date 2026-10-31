/**
 * A pool of background workers for Auto route's searches (taskRunner.ts).
 * Workers start on demand, up to the pool's size; each runs one task at a
 * time, and a task waits for the next free worker. Speculative tasks only get
 * workers no other task is waiting for. Terminating the pool (Cancel, or the
 * run is over) stops every worker and fails what is pending.
 */
import { runAutoRouteTask, type AutoRouteTaskKind, type AutoRouteTaskInput, type AutoRouteTaskOutput } from './autoRouteTasks';
import type { TaskProgress } from './taskProgress';
import type { ParallelTask, SpeculativeTask, TaskRunner } from './taskRunner';

export interface PoolRequest { id: number; kind: AutoRouteTaskKind; input: unknown }
export type PoolReply =
  | { id: number; progress: TaskProgress }
  | { id: number; ok: true; output: unknown; workMs: number }
  | { id: number; ok: false; message: string };

interface Job {
  id: number;
  kind: AutoRouteTaskKind;
  input: unknown;
  resolve: (output: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: TaskProgress) => void;
  speculative?: boolean;
  /** A speculative task whose answer has been asked for. */
  wanted?: boolean;
  /** Given to the pool, and to a worker (performance.now()). */
  queuedAt: number;
  startedAt?: number;
  worker?: number;
}

/** What one task took, as the pool saw it (ms). It measures the run, not its answer. */
export interface PoolTaskReport {
  kind: AutoRouteTaskKind;
  /** Which worker ran it, in the order they started (0: it ran where the pool is; absent: it never ran). */
  worker?: number;
  /** When it was given to the pool, from the pool's start. */
  atMs: number;
  /** Waiting for a worker, from the moment it was given to the pool. */
  waitMs: number;
  /** On the worker, its message passing and (a new worker's first task) its loading included. */
  ranMs?: number;
  /** The task itself, as the worker timed it. */
  workMs?: number;
  speculative?: true;
  /** Stopped before it answered: not wanted any more. */
  cancelled?: true;
}

export interface PoolReport {
  size: number;
  workersStarted: number;
  /** Workers stopped with a task no longer wanted. */
  workersStopped: number;
  tasks: PoolTaskReport[];
}

/**
 * Workers for a machine: all its cores but two (the page and the run's own
 * worker), at most four. More gain nothing: the searches use no more (three
 * starts and a speculative one), and on a laptop's shared power and memory each
 * extra busy worker slows the others (measured on 8 cores, 16 threads: the same
 * work took 2.1 times the CPU on six workers).
 */
export function poolSizeFor(hardwareConcurrency: number | undefined): number {
  return Math.max(1, Math.min(4, (hardwareConcurrency || 4) - 2));
}

export class WorkerPool implements TaskRunner {
  readonly concurrency: number;
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Job[] = [];
  private readonly background: Job[] = [];
  private readonly running = new Map<Worker, Job>();
  private nextId = 0;
  private closed = false;
  private workersFailed = false;
  private runningHere = false;
  private workersStarted = 0;
  private workersStopped = 0;
  private readonly numbers = new Map<Worker, number>();
  private readonly tasks: PoolTaskReport[] = [];
  private readonly createdAt = performance.now();

  constructor(size: number, private readonly spawn: () => Worker) {
    this.concurrency = Math.max(1, size);
  }

  all<K extends AutoRouteTaskKind>(tasks: ReadonlyArray<ParallelTask<K>>, onProgress?: (index: number, progress: TaskProgress) => void): Promise<Array<AutoRouteTaskOutput<K>>> {
    return Promise.all(tasks.map((task, index) => this.run(task.kind, task.input, onProgress && ((progress) => onProgress(index, progress)))));
  }

  run<K extends AutoRouteTaskKind>(kind: K, input: AutoRouteTaskInput<K>, onProgress?: (progress: TaskProgress) => void): Promise<AutoRouteTaskOutput<K>> {
    if (this.closed) return Promise.reject(new Error('Auto route was stopped.'));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.nextId, kind, input, resolve: resolve as (output: unknown) => void, reject, queuedAt: performance.now(), ...(onProgress ? { onProgress } : {}) });
      this.pump();
    });
  }

  speculate<K extends AutoRouteTaskKind>(task: ParallelTask<K>): SpeculativeTask<K> {
    let job: Job | undefined;
    const result = new Promise<AutoRouteTaskOutput<K>>((resolve, reject) => {
      job = { id: ++this.nextId, kind: task.kind, input: task.input, resolve: resolve as (output: unknown) => void, reject, speculative: true, queuedAt: performance.now() };
    });
    // Its answer may never be wanted: a failure matters only to one who awaits it.
    result.catch(() => undefined);
    if (this.closed) job!.reject(new Error('Auto route was stopped.'));
    else {
      this.background.push(job!);
      this.pump();
    }
    return {
      want: () => {
        job!.wanted = true;
        // Still waiting for a free worker: now it goes first.
        const waiting = this.background.indexOf(job!);
        if (waiting >= 0) {
          this.background.splice(waiting, 1);
          this.queue.unshift(job!);
          this.pump();
        }
        return result;
      },
      cancel: () => this.cancel(job!),
    };
  }

  /** What the pool has done so far. */
  report(): PoolReport {
    return { size: this.concurrency, workersStarted: this.workersStarted, workersStopped: this.workersStopped, tasks: [...this.tasks] };
  }

  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    for (const worker of this.workers) worker.terminate();
    const stopped = new Error('Auto route was stopped.');
    for (const job of [...this.queue, ...this.background, ...this.running.values()]) job.reject(stopped);
    this.queue.length = 0;
    this.background.length = 0;
    this.running.clear();
    this.idle.length = 0;
    this.workers.length = 0;
  }

  /** A speculative task no longer wanted: off the queue, or its worker stopped (the next task starts another). */
  private cancel(job: Job): void {
    for (const list of [this.background, this.queue]) {
      const queued = list.indexOf(job);
      if (queued >= 0) {
        list.splice(queued, 1);
        this.record(job, { cancelled: true });
        return;
      }
    }
    for (const [worker, running] of this.running) {
      if (running !== job) continue;
      this.running.delete(worker);
      this.workers.splice(this.workers.indexOf(worker), 1);
      worker.terminate();
      this.workersStopped += 1;
      this.record(job, { cancelled: true });
      this.pump();
      return;
    }
  }

  private record(job: Job, end: { workMs?: number; cancelled?: true }): void {
    const now = performance.now();
    this.tasks.push({ kind: job.kind, atMs: job.queuedAt - this.createdAt, waitMs: (job.startedAt ?? now) - job.queuedAt,
      ...(job.worker !== undefined ? { worker: job.worker } : {}),
      ...(job.startedAt !== undefined ? { ranMs: now - job.startedAt } : {}),
      ...(job.speculative ? { speculative: true as const } : {}), ...end });
  }

  private nextJob(): Job | undefined {
    return this.queue.shift() ?? this.background.shift();
  }

  private pump(): void {
    while ((this.queue.length || this.background.length) && !this.closed) {
      const worker = this.idle.pop() ?? (!this.workersFailed && this.workers.length < this.concurrency ? this.start() : undefined);
      if (!worker) {
        // No worker can start and none is left (no nested workers in this browser): the tasks run here, one by one.
        if (this.workersFailed && !this.workers.length) this.runHere();
        return;
      }
      const job = this.nextJob()!;
      job.startedAt = performance.now();
      job.worker = this.numbers.get(worker);
      this.running.set(worker, job);
      worker.postMessage({ id: job.id, kind: job.kind, input: job.input } satisfies PoolRequest);
    }
  }

  private runHere(): void {
    if (this.runningHere) return;
    // (Only what is awaited: a speculative task here would hold up the run it was to speed up.)
    const job = this.queue.shift();
    if (!job) return;
    this.runningHere = true;
    job.startedAt = performance.now();
    job.worker = 0;
    void runAutoRouteTask(job.kind, job.input as never).then(job.resolve, job.reject).then(() => {
      this.runningHere = false;
      this.record(job, {});
      this.pump();
    });
  }

  private start(): Worker | undefined {
    let worker: Worker;
    try {
      worker = this.spawn();
    } catch {
      this.workersFailed = true;
      return undefined;
    }
    worker.onmessage = ({ data }: MessageEvent<PoolReply>) => {
      const job = this.running.get(worker);
      if (!job || job.id !== data.id) return;
      if ('progress' in data) {
        job.onProgress?.(data.progress);
        return;
      }
      this.running.delete(worker);
      this.idle.push(worker);
      this.record(job, data.ok ? { workMs: data.workMs } : {});
      if (data.ok) job.resolve(data.output);
      else job.reject(new Error(data.message));
      this.pump();
    };
    // A worker that failed (it could not load, it ran out of memory) is not used again or replaced, and what it was
    // doing runs again elsewhere: a task is a pure function of its input.
    worker.onerror = (event) => {
      event.preventDefault?.();
      const job = this.running.get(worker);
      this.running.delete(worker);
      this.workers.splice(this.workers.indexOf(worker), 1);
      const idleAt = this.idle.indexOf(worker);
      if (idleAt >= 0) this.idle.splice(idleAt, 1);
      worker.terminate();
      this.workersFailed = true;
      // (A speculative task nobody has asked for goes back to wait for a spare worker, if there ever is one.)
      if (job) (job.speculative && !job.wanted ? this.background : this.queue).unshift(job);
      this.pump();
    };
    this.workers.push(worker);
    this.workersStarted += 1;
    this.numbers.set(worker, this.workersStarted);
    return worker;
  }
}
