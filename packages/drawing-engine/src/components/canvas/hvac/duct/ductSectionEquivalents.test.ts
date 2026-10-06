import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  aspectOf,
  outerHeightMm,
  rectangularEquivalents,
  roundEquivalents,
  sameSectionSize,
  widthForEquivalent,
} from './ductSectionEquivalents';
import { equivalentDiameterMm } from './ductSizing';
import { roundLeg } from './ductTypes';

const STOCK = [100, 125, 150, 160, 200, 250, 300, 315, 355, 400, 450, 500];

describe('equal-friction equivalents (Huebscher, ASHRAE Fundamentals ch. 21)', () => {
  it('600×300 is a Ø457 duct: Ø500 spiral at or above it, Ø450 just below', () => {
    const { deMm, atOrAbove, below } = roundEquivalents({ widthMm: 600, heightMm: 300 }, STOCK);
    expect(deMm).toBeCloseTo(456.8, 0);
    expect(atOrAbove).toEqual(roundLeg(500));
    expect(below).toEqual(roundLeg(450));
  });

  it('a round duct\'s equivalents are itself and the size below; none past the stock', () => {
    expect(roundEquivalents(roundLeg(355), STOCK)).toMatchObject({ deMm: 355, atOrAbove: roundLeg(355), below: roundLeg(315) });
    expect(roundEquivalents({ widthMm: 1200, heightMm: 600 }, STOCK).atOrAbove).toBeNull();
  });

  it('the narrowest rectangle at a height that reaches an equivalent diameter', () => {
    // Ø457 at 250 high: 750 wide (De 456.5 falls short by a hair, so 800).
    const width = widthForEquivalent(456.8, 250)!;
    expect(equivalentDiameterMm({ widthMm: width, heightMm: 250 })).toBeGreaterThanOrEqual(456.3);
    expect(equivalentDiameterMm({ widthMm: width - 50, heightMm: 250 })).toBeLessThan(456.3);
    expect(widthForEquivalent(456.8, 50, 50, 600)).toBeNull();
  });

  it('rectangles of a round duct\'s friction, flat in the ceiling, within the aspect limit and the void', () => {
    const options = { maxHeightMm: 400, maxAspect: 4 };
    const list = rectangularEquivalents(457, options);
    expect(list.length).toBeGreaterThan(2);
    for (const leg of list) {
      expect(equivalentDiameterMm(leg)).toBeGreaterThanOrEqual(456.5);
      expect(leg.widthMm).toBeGreaterThanOrEqual(leg.heightMm);
      expect(leg.heightMm).toBeLessThanOrEqual(400);
      expect(aspectOf(leg)).toBeLessThanOrEqual(4);
      // Each is the narrowest at its height (the square, where narrower would stand on end).
      if (leg.widthMm > leg.heightMm) expect(equivalentDiameterMm({ widthMm: leg.widthMm - 50, heightMm: leg.heightMm })).toBeLessThan(456.5);
    }
    // Lowest first.
    expect(list.map((leg) => leg.heightMm)).toEqual([...list.map((leg) => leg.heightMm)].sort((a, b) => a - b));
  });

  it('every rectangle offered carries at least the friction-equivalent it was asked for', () => {
    fc.assert(fc.property(fc.integer({ min: 150, max: 900 }), fc.integer({ min: 150, max: 600 }), fc.integer({ min: 2, max: 6 }), (de, maxHeight, aspect) => {
      for (const leg of rectangularEquivalents(de, { maxHeightMm: maxHeight, maxAspect: aspect })) {
        expect(equivalentDiameterMm(leg)).toBeGreaterThanOrEqual(de - 0.5);
        expect(aspectOf(leg)).toBeLessThanOrEqual(aspect + 1e-9);
        expect(leg.widthMm % 50).toBe(0);
        expect(leg.heightMm % 50).toBe(0);
      }
    }));
  });

  it('outside height, aspect and sameness', () => {
    expect(outerHeightMm({ widthMm: 600, heightMm: 300 }, 0.8, 19)).toBeCloseTo(339.6, 6);
    expect(outerHeightMm(roundLeg(450), 0.6, 0)).toBeCloseTo(451.2, 6);
    expect(aspectOf({ widthMm: 800, heightMm: 200 })).toBe(4);
    expect(aspectOf(roundLeg(300))).toBe(1);
    expect(sameSectionSize(roundLeg(300), { widthMm: 300, heightMm: 300 })).toBe(false);
    expect(sameSectionSize({ widthMm: 600, heightMm: 300 }, { widthMm: 600.2, heightMm: 300 })).toBe(true);
  });
});
