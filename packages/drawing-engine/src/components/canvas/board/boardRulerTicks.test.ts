import { describe, expect, it } from 'vitest';

import { getBoardRulerTicks } from './boardRulerTicks';

describe('board ruler ticks', () => {
  it('preserves ordinary major and fractional ticks across negative and positive coordinates', () => {
    expect(getBoardRulerTicks(-240, 510, 100, 800)).toEqual([-200, -100, 0, 100, 200, 300, 400, 500]);
    expect(getBoardRulerTicks(-0.3, 1.1, 0.25, 800)).toEqual([-0.25, 0, 0.25, 0.5, 0.75, 1]);
  });

  it('finishes when the world origin is too large for adding one tick to advance', () => {
    const start = 1e19;
    expect(start + 10).toBe(start);
    const ticks = getBoardRulerTicks(start, start + 4096, 10, 800);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThanOrEqual(802);
    expect(new Set(ticks).size).toBe(ticks.length);
    expect(ticks.every((tick, index) => Number.isFinite(tick) && tick >= start &&
      tick <= start + 4096 && (index === 0 || tick > ticks[index - 1]!))).toBe(true);
  });

  it('bounds work for unexpectedly dense ticks and overflowed range arithmetic', () => {
    expect(getBoardRulerTicks(0, 1e20, 0.001, 800)).toHaveLength(802);
    const ticks = getBoardRulerTicks(-Number.MAX_VALUE / 2, Number.MAX_VALUE, 1, 500);
    expect(ticks.length).toBeLessThanOrEqual(502);
    expect(ticks.every(Number.isFinite)).toBe(true);
  });

  it('rejects invalid axes and tick spacing', () => {
    expect(getBoardRulerTicks(0, Infinity, 100, 800)).toEqual([]);
    expect(getBoardRulerTicks(NaN, 1000, 100, 800)).toEqual([]);
    expect(getBoardRulerTicks(0, 1000, 0, 800)).toEqual([]);
    expect(getBoardRulerTicks(0, 1000, -1, 800)).toEqual([]);
    expect(getBoardRulerTicks(1000, 0, 100, 800)).toEqual([]);
  });
});
