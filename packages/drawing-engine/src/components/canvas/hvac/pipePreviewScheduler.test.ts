import { describe, expect, it } from 'vitest';

import { createPipePreviewScheduler } from './pipePreviewScheduler';

describe('pipe preview frame scheduling', () => {
  const setup = () => {
    let id = 0; const callbacks = new Map<number, () => void>(); const values: number[] = [];
    const scheduler = createPipePreviewScheduler<number>(value => values.push(value), callback => { callbacks.set(++id, callback); return id; }, key => { callbacks.delete(key); });
    return { scheduler, callbacks, values };
  };
  it('coalesces a pointer burst into the last sample for the frame', () => {
    const { scheduler, callbacks, values } = setup();
    for (let i = 1; i <= 100; i++) scheduler.schedule(i);
    expect(callbacks.size).toBe(1); expect(values).toEqual([]);
    callbacks.values().next().value!(); expect(values).toEqual([100]); expect(callbacks.size).toBe(0);
  });
  it('flushes the final release coordinate once even before a frame runs', () => {
    const { scheduler, callbacks, values } = setup();
    scheduler.schedule(1); scheduler.schedule(2); scheduler.flush(); scheduler.flush();
    expect(values).toEqual([2]); expect(callbacks.size).toBe(0);
  });
  it('discards pending work on Escape or source changes and supports another drag', () => {
    const { scheduler, callbacks, values } = setup();
    scheduler.schedule(5); scheduler.cancel(); scheduler.flush();
    expect(values).toEqual([]); expect(callbacks.size).toBe(0);
    scheduler.schedule(7); scheduler.flush(); expect(values).toEqual([7]);
  });
});
