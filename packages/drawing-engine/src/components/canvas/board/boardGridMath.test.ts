import { describe, expect, it } from 'vitest';

import { MM_TO_PX } from '../scale';

import {
  computeBoardGridSteps,
  formatBoardLabel,
  niceCeilPow,
  prevLadder,
} from './boardGridMath';

/** A value is on the 1-2-5 ladder if its leading significant digit is 1, 2 or 5. */
function isLadderValue(v: number): boolean {
  const exp = Math.floor(Math.log10(v) + 1e-9);
  const lead = Math.round(v / 10 ** exp);
  return lead === 1 || lead === 2 || lead === 5 || lead === 10;
}

describe('niceCeilPow', () => {
  it('rounds up to the next 1-2-5 ladder value', () => {
    expect(niceCeilPow(0.4)).toBeCloseTo(0.5);
    expect(niceCeilPow(0.9)).toBeCloseTo(1);
    expect(niceCeilPow(1)).toBeCloseTo(1);
    expect(niceCeilPow(1.1)).toBeCloseTo(2);
    expect(niceCeilPow(3)).toBeCloseTo(5);
    expect(niceCeilPow(6)).toBeCloseTo(10);
    expect(niceCeilPow(120)).toBeCloseTo(200);
  });
});

describe('prevLadder', () => {
  it('steps down one 1-2-5 rung', () => {
    expect(prevLadder(1)).toBeCloseTo(0.5);
    expect(prevLadder(2)).toBeCloseTo(1);
    expect(prevLadder(5)).toBeCloseTo(2);
    expect(prevLadder(10)).toBeCloseTo(5);
    expect(prevLadder(100)).toBeCloseTo(50);
  });
});

describe('computeBoardGridSteps', () => {
  it('keeps minor spacing in a comfortable band across zoom decades', () => {
    for (let exp = -4; exp <= 4; exp += 0.13) {
      const zoom = 10 ** exp;
      const steps = computeBoardGridSteps(zoom);

      // minor spacing lands in a sane on-screen band (>= ~8px, not wildly large)
      expect(steps.minorPx).toBeGreaterThanOrEqual(8);
      expect(steps.minorPx).toBeLessThan(120);

      // ordering: sub < minor < major
      expect(steps.subMm).toBeLessThan(steps.minorMm);
      expect(steps.minorMm).toBeLessThan(steps.majorMm);

      // all levels sit on the 1-2-5 ladder
      expect(isLadderValue(steps.minorMm)).toBe(true);
      expect(isLadderValue(steps.majorMm)).toBe(true);

      // pxPerMm matches the transform
      expect(steps.pxPerMm).toBeCloseTo(MM_TO_PX * zoom);
    }
  });
});

describe('formatBoardLabel', () => {
  it('formats in the active unit and trims zeros', () => {
    expect(formatBoardLabel(0, 'mm')).toBe('0');
    expect(formatBoardLabel(1000, 'mm')).toBe('1000');
    expect(formatBoardLabel(1000, 'cm')).toBe('100');
    expect(formatBoardLabel(1000, 'm')).toBe('1');
    expect(formatBoardLabel(1500, 'm')).toBe('1.5');
  });
});
