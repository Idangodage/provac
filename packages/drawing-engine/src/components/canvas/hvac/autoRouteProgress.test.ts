import { describe, expect, it } from 'vitest';

import { autoRouteEstimator, formatAutoRouteTimeLeft } from './autoRouteProgress';
import type { AutoRouteServices } from './unifiedAutoRoute';

const EVERYTHING: AutoRouteServices = { gas: true, liquid: true, condensate: true, supplyDuct: true, returnDuct: true };
const WORK = { terminals: 20, units: 7 };

function clock(start = 1000) {
  let time = start;
  return { now: () => time, pass: (ms: number) => { time += ms; } };
}

describe('Auto route progress', () => {
  it('moves through the planned steps in order, and reaches the end', () => {
    const { now } = clock();
    const estimate = autoRouteEstimator(EVERYTHING, WORK, now);
    const seen = [
      estimate({ stage: 'Designing ducts', completed: 0, total: 0, step: 'ducts' }),
      estimate({ stage: 'Ducts', completed: 1, total: 3, step: 'ducts' }),
      estimate({ stage: 'Refrigerant', completed: 0, total: 0, step: 'refrigerant' }),
      estimate({ stage: 'Refrigerant', completed: 5, total: 7, step: 'refrigerant' }),
      estimate({ stage: 'Condensate', completed: 1, total: 2, step: 'condensate' }),
      estimate({ stage: 'Clashes', completed: 1, total: 1, step: 'audit' }),
    ].map((entry) => entry.fraction);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[0]).toBeLessThan(0.01);
    expect(seen.at(-1)).toBe(0.97);
  });

  it('starts at the start, with the cassettes being turned', () => {
    const { now } = clock();
    const estimate = autoRouteEstimator(EVERYTHING, WORK, now);
    expect(estimate({ stage: 'Turning cassettes', completed: 0, total: 0, step: 'turns' }).fraction).toBe(0);
    expect(estimate({ stage: 'Designing ducts', completed: 0, total: 0, step: 'ducts' }).fraction).toBeLessThan(0.01);
  });

  it('only counts the services ticked', () => {
    const { now } = clock();
    const ducts = autoRouteEstimator({ gas: false, liquid: false, condensate: false, supplyDuct: true }, WORK, now);
    expect(ducts({ stage: 'Ducts', completed: 3, total: 6, step: 'ducts' }).fraction).toBeGreaterThan(0.45);
    const pipes = autoRouteEstimator({ gas: true, liquid: true, condensate: false }, WORK, now);
    expect(pipes({ stage: 'Refrigerant', completed: 7, total: 7, step: 'refrigerant' }).fraction).toBeGreaterThan(0.95);
  });

  it('follows the run\'s own pace for the time left, and says nothing too early', () => {
    const { now, pass } = clock();
    const estimate = autoRouteEstimator(EVERYTHING, WORK, now);
    expect(estimate({ stage: 'Preparing', completed: 0, total: 0, step: 'ducts' }).timeLeftMs).toBeNull();
    pass(10_000);
    const half = estimate({ stage: 'Refrigerant', completed: 0, total: 0, step: 'refrigerant' });
    // Ten seconds for the ducts' share: the shares left at that pace.
    const share = (0.27 * 49 + 0.06 * 49 + 0.1) / (0.1 + 0.6 * 20);
    expect(half.timeLeftMs).toBeCloseTo(10_000 * share, 3);
    expect(half.estimatedAt).toBe(11_000);
  });

  it('never moves back or fills up early, even when an alternative layout is added to compare', () => {
    const { now, pass } = clock();
    const estimate = autoRouteEstimator(EVERYTHING, WORK, now);
    pass(20_000);
    const last = estimate({ stage: 'Clashes', completed: 1, total: 1, step: 'audit' });
    expect(last.fraction).toBe(0.97);
    expect(last.timeLeftMs).toBe(0);
    pass(100);
    const after = estimate({ stage: 'Comparing a drainage-first layout', completed: 0, total: 1, step: 'drainage-first' });
    expect(after.fraction).toBe(0.97);
    expect(after.timeLeftMs).toBeGreaterThan(5000);
  });

  it('when the count of a step starts again, the time left does not jump back up', () => {
    const { now, pass } = clock();
    const estimate = autoRouteEstimator(EVERYTHING, WORK, now);
    pass(5000);
    const ahead = estimate({ stage: 'Refrigerant', completed: 6, total: 7, step: 'refrigerant' });
    const again = estimate({ stage: 'Starting a network from another unit', completed: 0, total: 7, step: 'refrigerant' });
    expect(again.fraction).toBe(ahead.fraction);
    expect(again.timeLeftMs).toBe(ahead.timeLeftMs);
  });

  it('a message without a step leaves the bar where it is', () => {
    const { now } = clock();
    const estimate = autoRouteEstimator(EVERYTHING, WORK, now);
    const moved = estimate({ stage: 'Ducts', completed: 3, total: 3, step: 'ducts' }).fraction;
    expect(estimate({ stage: 'Something', completed: 0, total: 0 }).fraction).toBe(moved);
  });

  it('says the time left plainly', () => {
    expect(formatAutoRouteTimeLeft(3000)).toBe('a few seconds left');
    expect(formatAutoRouteTimeLeft(11_000)).toBe('about 15 s left');
    expect(formatAutoRouteTimeLeft(59_000)).toBe('about 60 s left');
    expect(formatAutoRouteTimeLeft(150_000)).toBe('about 3 min left');
  });
});
