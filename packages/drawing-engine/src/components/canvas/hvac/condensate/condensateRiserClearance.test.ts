import { describe, expect, it } from 'vitest';

import { riserTopBelowPipe } from './condensateRiserClearance';

describe('continuous pump riser clearance', () => {
  const foot = { x: 0, y: 0 };

  it('finds a grazing contact on a long service without sampling gaps', () => {
    const cap = riserTopBelowPipe(foot, 0, 600,
      { x: -10003, y: 99.9, z: 500 }, { x: 10007, y: 99.9, z: 500 }, 100);
    expect(cap).toBeCloseTo(500 - Math.sqrt(100 ** 2 - 99.9 ** 2), 6);
  });

  it('handles vertical services, point fittings and already obstructed feet', () => {
    expect(riserTopBelowPipe(foot, 0, 600, { x: 0, y: 0, z: 400 }, { x: 0, y: 0, z: 800 }, 50)).toBeCloseTo(350, 6);
    expect(riserTopBelowPipe(foot, 0, 600, { x: 0, y: 0, z: 400 }, { x: 0, y: 0, z: 400 }, 50)).toBeCloseTo(350, 6);
    expect(riserTopBelowPipe(foot, 380, 600, { x: 0, y: 0, z: 400 }, { x: 0, y: 0, z: 800 }, 50)).toBeNull();
  });

  it('keeps full lift above a lower service and beside a safely separated run', () => {
    expect(riserTopBelowPipe(foot, 200, 600, { x: -100, y: 0, z: 100 }, { x: 100, y: 0, z: 100 }, 50)).toBe(600);
    expect(riserTopBelowPipe(foot, 0, 600, { x: 100, y: 0, z: 0 }, { x: 100, y: 0, z: 800 }, 50)).toBe(600);
  });
});
