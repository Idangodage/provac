interface QueuedJob<Input, Output> {
  input: Input;
  promise: Promise<Output>;
  resolve: (value: Output) => void;
  reject: (reason: unknown) => void;
}

/**
 * Runs one asynchronous job at a time and retains only the newest waiting input.
 *
 * Calls made while a job is already queued share that queued job's promise. Replacing
 * its input therefore does not orphan earlier callers: every superseded caller settles
 * with the result (or error) of the newest queued input. The queue retains a constant
 * amount of state regardless of how frequently producers call enqueue().
 */
export class LatestOnlyAsyncQueue<Input, Output> {
  private running = false;
  private queuedJob: QueuedJob<Input, Output> | null = null;

  constructor(private readonly execute: (input: Input) => Promise<Output>) {}

  enqueue(input: Input): Promise<Output> {
    if (!this.running) {
      this.running = true;
      return this.executeAndDrain(input);
    }

    if (this.queuedJob) {
      this.queuedJob.input = input;
      return this.queuedJob.promise;
    }

    let resolve!: (value: Output) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<Output>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });

    this.queuedJob = { input, promise, resolve, reject };
    return promise;
  }

  private executeAndDrain(input: Input): Promise<Output> {
    let execution: Promise<Output>;
    try {
      execution = Promise.resolve(this.execute(input));
    } catch (error) {
      execution = Promise.reject(error);
    }

    void execution.then(
      () => this.startNextJob(),
      () => this.startNextJob()
    );
    return execution;
  }

  private startNextJob(): void {
    const nextJob = this.queuedJob;
    if (!nextJob) {
      this.running = false;
      return;
    }

    this.queuedJob = null;
    void this.executeAndDrain(nextJob.input).then(nextJob.resolve, nextJob.reject);
  }
}
