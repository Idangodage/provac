import { describe, it, expect } from 'vitest';

import {
  clampBendRadius,
  innerLineRadiusMm,
  minSpineBendRadiusMm,
  outerLineRadiusMm,
} from './bend';
import { buildPairedGeometry } from './offset';
import { PIPE_SIZES } from '../model/types';

const size = PIPE_SIZES[3]!; // '15.88', minBendRadiusMm 120
const GAP = 40;

describe('invariant D — bend radius is never tighter than the pipe minimum', () => {
  it('a request below the floor is clamped up and warned', () => {
    const c = clampBendRadius(50, size, GAP);
    expect(c.clamped).toBe(true);
    expect(c.value).toBe(minSpineBendRadiusMm(size, GAP));
    expect(c.value).toBeGreaterThanOrEqual(size.minBendRadiusMm);
    expect(c.warning).toBeTruthy();
  });

  it('a legal request passes through untouched, no warning', () => {
    const c = clampBendRadius(400, size, GAP);
    expect(c.clamped).toBe(false);
    expect(c.value).toBe(400);
    expect(c.warning).toBeUndefined();
  });
});

describe('invariant C — the INNER line (r − gap/2), not the spine, is the binding radius', () => {
  it('the floor is minBendRadius + gap/2 so the inner line exactly clears the minimum', () => {
    const floor = minSpineBendRadiusMm(size, GAP);
    expect(floor).toBe(size.minBendRadiusMm + GAP / 2);
    expect(innerLineRadiusMm(floor, GAP)).toBeCloseTo(size.minBendRadiusMm, 9);
    expect(outerLineRadiusMm(floor, GAP)).toBeCloseTo(size.minBendRadiusMm + GAP, 9);
  });

  it('a spine-only check would wrongly pass; the inner-aware clamp rejects it', () => {
    // Spine radius == minBendRadius looks fine to a naive (outer/spine) check, but the
    // inner line would be min − gap/2 < min. The inner-aware clamp must lift it.
    const c = clampBendRadius(size.minBendRadiusMm, size, GAP);
    expect(innerLineRadiusMm(size.minBendRadiusMm, GAP)).toBeLessThan(size.minBendRadiusMm);
    expect(c.clamped).toBe(true);
    expect(c.value).toBe(size.minBendRadiusMm + GAP / 2);
  });

  it('the clamp floor matches the ACTUAL inner arc radius produced by the geometry', () => {
    const floor = minSpineBendRadiusMm(size, GAP);
    // A right-angle corner with legs long enough that the fillet applies fully.
    const geom = buildPairedGeometry([{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 2000 }], GAP, floor);
    const arcRadii = [...geom.gas, ...geom.liquid].filter((s) => s.kind === 'arc').map((s) => (s as { radius: number }).radius);
    expect(arcRadii.length).toBeGreaterThan(0);
    const innerArc = Math.min(...arcRadii);
    // The tightest copper arc equals floor − gap/2 = the size minimum, and clears it.
    expect(innerArc).toBeCloseTo(size.minBendRadiusMm, 6);
    expect(innerArc).toBeGreaterThanOrEqual(size.minBendRadiusMm - 1e-6);
  });
});
