/**
 * Branch-kit proposal scheduler — the "advisory work waits for stillness" boundary.
 *
 * `proposeBranchKit` runs a whole-network level re-plan. Measured on this engine
 * it costs 11 ms on a 4-element scene and 440 ms on a 154-element one, and it was
 * being called from `handleMouseMove` on every pointer sample. The pointer queue
 * cannot drain at that rate, so the route preview trailed the cursor.
 *
 * The proposal is a *suggestion*, not the thing the user is steering — the route
 * preview is. So it is debounced on pointer stillness: each new sample restarts
 * the timer and replaces the pending input, and the proposal runs once, when the
 * cursor actually stops.
 *
 * This is a debounce, deliberately, not the throttle in
 * {@link ./pipePreviewScheduler}. A throttle at 100 ms would still admit ten
 * 200 ms proposals per second — worse than the budget it was meant to protect.
 *
 * `flush` exists for discrete commit actions (Enter / double-click): those must
 * decide against the same proposal the user would have seen, so they run the
 * pending input synchronously rather than silently committing a plain route.
 *
 * Pure and timer-injected, so the "one run per still period, newest input wins"
 * invariant is unit-tested with fake timers and no React.
 */

/**
 * Decides whether the proposal still fits on the pointer path for this document.
 *
 * The cost is a property of the scene, not of the session, so the estimate is
 * keyed on the scene's identity and reset when a commit replaces it.
 *
 * **The statistic is the maximum over a sliding window, and that matters.** The
 * proposal's cost is bimodal, not "steady state plus noise": it returns in ~4 ms
 * when no run is near enough to tee into, and takes hundreds of milliseconds
 * when a candidate is found and the network level re-plan runs. Measured on the
 * canvas, a 24-element document alternated between 4 ms and 1 100 ms on the same
 * gesture. A minimum (tried first) or a mean therefore both track the cheap mode
 * and never defer anything; only a recent maximum answers the question actually
 * being asked, which is "could the next run blow the frame budget?".
 *
 * The window slides so the answer can change back: a document that becomes cheap
 * again returns to the pointer path once the expensive samples age out. Recovery
 * is deliberately slower than banishment, because a stall is more visible than a
 * suggestion that waits for stillness.
 *
 * The first sample is still warmup and never decides alone — cold-start cost is
 * environment-dependent and unbounded, so one slow sample proves nothing.
 */
export interface ProposalCostEstimator<Scene> {
  /** True while the proposal may run synchronously on the pointer path. */
  canRunInline(scene: Scene): boolean;
  /** Records an observed duration in milliseconds for `scene`. */
  record(scene: Scene, durationMs: number): void;
}

/** How many recent durations the decision looks at. */
const COST_WINDOW = 8;

export function createProposalCostEstimator<Scene>(
  budgetMs: number,
  windowSize = COST_WINDOW,
): ProposalCostEstimator<Scene> {
  let scene: Scene | null = null;
  let recent: number[] = [];

  return {
    canRunInline(next: Scene): boolean {
      if (scene !== next) return true;
      // One sample is warmup and never decides on its own.
      if (recent.length < 2) return true;
      return Math.max(...recent) <= budgetMs;
    },
    record(next: Scene, durationMs: number): void {
      if (scene !== next) { scene = next; recent = []; }
      recent.push(durationMs);
      if (recent.length > windowSize) recent.shift();
    },
  };
}

export interface BranchProposalScheduler<T> {
  /** Replaces any pending input and restarts the idle timer. */
  schedule(value: T): void;
  /** Runs the pending input now, if any. Returns whether anything ran. */
  flush(): boolean;
  /** Drops the pending input without running it. */
  cancel(): void;
  /** True while an input is waiting to run. */
  readonly pending: boolean;
}

export function createBranchProposalScheduler<T>(
  consume: (value: T) => void,
  idleMs = 110,
  request: (callback: () => void, delayMs: number) => number =
    (callback, delayMs) => setTimeout(callback, delayMs) as unknown as number,
  cancelRequest: (id: number) => void = (id) => clearTimeout(id),
): BranchProposalScheduler<T> {
  let timer: number | null = null;
  let queued: { value: T } | null = null;

  const stopTimer = (): void => {
    if (timer !== null) cancelRequest(timer);
    timer = null;
  };

  const run = (): boolean => {
    stopTimer();
    const next = queued;
    queued = null;
    if (!next) return false;
    consume(next.value);
    return true;
  };

  return {
    schedule(value: T): void {
      queued = { value };
      // Restart, so a moving cursor keeps pushing the work out instead of
      // firing one proposal per idle window while it is still moving.
      stopTimer();
      timer = request(run, idleMs);
    },
    flush(): boolean {
      return run();
    },
    cancel(): void {
      stopTimer();
      queued = null;
    },
    get pending(): boolean {
      return queued !== null;
    },
  };
}
