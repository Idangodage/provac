import { describe, expect, it, vi } from 'vitest';

import { createBranchProposalScheduler, createProposalCostEstimator } from './branchProposalScheduler';

/** A controllable timer, so the debounce is asserted rather than waited on. */
function fakeTimers() {
  let nextId = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  let now = 0;
  return {
    request: (callback: () => void, delayMs: number) => {
      const id = nextId++;
      pending.set(id, { at: now + delayMs, run: callback });
      return id;
    },
    cancel: (id: number) => { pending.delete(id); },
    advance(ms: number) {
      now += ms;
      for (const [id, entry] of [...pending]) {
        if (entry.at <= now) { pending.delete(id); entry.run(); }
      }
    },
    get armed() { return pending.size; },
  };
}

describe('createBranchProposalScheduler', () => {
  it('runs nothing until the pointer has been still for the idle window', () => {
    const timers = fakeTimers();
    const consume = vi.fn();
    const scheduler = createBranchProposalScheduler<string>(consume, 100, timers.request, timers.cancel);

    scheduler.schedule('a');
    timers.advance(99);
    expect(consume).not.toHaveBeenCalled();

    timers.advance(1);
    expect(consume).toHaveBeenCalledExactlyOnceWith('a');
  });

  it('debounces rather than throttles: a moving pointer never runs the proposal', () => {
    const timers = fakeTimers();
    const consume = vi.fn();
    const scheduler = createBranchProposalScheduler<number>(consume, 100, timers.request, timers.cancel);

    // 30 samples at 50 ms — five times the idle window in total elapsed time.
    // A throttle would have fired here; a debounce must not.
    for (let sample = 0; sample < 30; sample++) {
      scheduler.schedule(sample);
      timers.advance(50);
    }
    expect(consume).not.toHaveBeenCalled();

    // The proposal runs once, for the newest sample, when movement stops.
    timers.advance(100);
    expect(consume).toHaveBeenCalledExactlyOnceWith(29);
  });

  it('keeps only the newest input', () => {
    const timers = fakeTimers();
    const consume = vi.fn();
    const scheduler = createBranchProposalScheduler<string>(consume, 100, timers.request, timers.cancel);

    scheduler.schedule('stale');
    scheduler.schedule('newer');
    scheduler.schedule('newest');
    timers.advance(100);

    expect(consume).toHaveBeenCalledExactlyOnceWith('newest');
  });

  it('flushes synchronously so a commit decides against the pending proposal', () => {
    const timers = fakeTimers();
    const consume = vi.fn();
    const scheduler = createBranchProposalScheduler<string>(consume, 100, timers.request, timers.cancel);

    scheduler.schedule('pending');
    expect(scheduler.pending).toBe(true);

    expect(scheduler.flush()).toBe(true);
    expect(consume).toHaveBeenCalledExactlyOnceWith('pending');
    expect(scheduler.pending).toBe(false);

    // The flushed input is consumed, not left armed to fire a second time.
    timers.advance(1000);
    expect(consume).toHaveBeenCalledOnce();
    expect(timers.armed).toBe(0);
  });

  it('reports nothing to flush when no input is pending', () => {
    const timers = fakeTimers();
    const consume = vi.fn();
    const scheduler = createBranchProposalScheduler<string>(consume, 100, timers.request, timers.cancel);

    expect(scheduler.flush()).toBe(false);
    expect(consume).not.toHaveBeenCalled();
  });

  it('cancels without consuming, and leaves no timer armed', () => {
    const timers = fakeTimers();
    const consume = vi.fn();
    const scheduler = createBranchProposalScheduler<string>(consume, 100, timers.request, timers.cancel);

    scheduler.schedule('dropped');
    scheduler.cancel();
    expect(scheduler.pending).toBe(false);
    expect(timers.armed).toBe(0);

    timers.advance(1000);
    expect(consume).not.toHaveBeenCalled();
  });

  it('accepts new work after a cancel', () => {
    const timers = fakeTimers();
    const consume = vi.fn();
    const scheduler = createBranchProposalScheduler<string>(consume, 100, timers.request, timers.cancel);

    scheduler.schedule('dropped');
    scheduler.cancel();
    scheduler.schedule('kept');
    timers.advance(100);

    expect(consume).toHaveBeenCalledExactlyOnceWith('kept');
  });
});

describe('createProposalCostEstimator', () => {
  const smallScene = ['a'];
  const largeScene = ['a', 'b'];

  it('keeps the proposal inline before anything is known', () => {
    const estimator = createProposalCostEstimator<string[]>(12);
    expect(estimator.canRunInline(smallScene)).toBe(true);
  });

  it('never decides on the warmup sample alone, however slow it was', () => {
    const estimator = createProposalCostEstimator<string[]>(12);
    // Cold-start cost is environment-dependent, so one sample proves nothing.
    estimator.record(largeScene, 440);
    expect(estimator.canRunInline(largeScene)).toBe(true);
  });

  it('defers once a recent run has exceeded the budget', () => {
    const estimator = createProposalCostEstimator<string[]>(12);
    estimator.record(largeScene, 400);
    estimator.record(largeScene, 213);
    expect(estimator.canRunInline(largeScene)).toBe(false);
  });

  it('keeps deferring when the cost is bimodal, not just when every run is slow', () => {
    // The real distribution: the proposal returns in a few ms when no run is
    // near enough to tee into, and takes hundreds of ms when one is. A minimum
    // or a mean tracks the cheap mode and never defers; the recent maximum is
    // what answers "could the next run blow the frame budget?".
    const estimator = createProposalCostEstimator<string[]>(12);
    for (const ms of [4, 1100, 4, 4, 4, 1050, 4]) estimator.record(largeScene, ms);
    expect(estimator.canRunInline(largeScene)).toBe(false);
  });

  it('stays inline while every recent run fits the budget', () => {
    const estimator = createProposalCostEstimator<string[]>(12);
    for (const ms of [3, 2, 4, 2, 3]) estimator.record(smallScene, ms);
    expect(estimator.canRunInline(smallScene)).toBe(true);
  });

  it('returns to the pointer path once the slow runs age out of the window', () => {
    const estimator = createProposalCostEstimator<string[]>(12, 4);
    estimator.record(smallScene, 2);
    estimator.record(smallScene, 400);
    expect(estimator.canRunInline(smallScene)).toBe(false);
    // Four cheap samples push the slow one out of a four-wide window.
    for (const ms of [3, 3, 3, 3]) estimator.record(smallScene, ms);
    expect(estimator.canRunInline(smallScene)).toBe(true);
  });

  it('re-measures when a commit replaces the scene', () => {
    const estimator = createProposalCostEstimator<string[]>(12);
    estimator.record(largeScene, 400);
    estimator.record(largeScene, 213);
    expect(estimator.canRunInline(largeScene)).toBe(false);

    const next = ['a'];
    expect(estimator.canRunInline(next)).toBe(true);
    estimator.record(next, 30);
    estimator.record(next, 1);
    // The replaced scene's samples are gone, so the new one is judged alone.
    estimator.record(next, 2);
    expect(estimator.canRunInline(next)).toBe(false);
  });
});
