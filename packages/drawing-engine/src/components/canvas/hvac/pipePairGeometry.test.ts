import { describe, expect, it } from 'vitest';

import type { Point2D } from '../../../types';

import { buildPipeCenterline, type CenterlineSegment } from './pipeCenterline';
import { buildPipePair, offsetCenterline } from './pipePairGeometry';

const p = (x: number, y: number): Point2D => ({ x, y });
const arcs = (segs: CenterlineSegment[]) =>
  segs.filter((s): s is Extract<CenterlineSegment, { type: 'arc' }> => s.type === 'arc');

describe('offsetCenterline — straight run', () => {
  it('offsets a straight pair to parallel lines at +/- the offset', () => {
    const cl = buildPipeCenterline([p(0, 0), p(100, 0)], 0);
    const gas = offsetCenterline(cl, 10);
    const liquid = offsetCenterline(cl, -10);
    // E direction -> left normal is (0,1); +10 shifts +y, -10 shifts -y.
    expect(gas.segments[0]).toMatchObject({ type: 'line', a: p(0, 10), b: p(100, 10) });
    expect(liquid.segments[0]).toMatchObject({ type: 'line', a: p(0, -10), b: p(100, -10) });
  });
});

describe('buildPipePair — concentric elbow at a 90deg corner', () => {
  const route = [p(0, 0), p(100, 0), p(100, 100)];
  const pair = buildPipePair(route, { bendRadiusMm: 20, gapMm: 20 });

  it('shares one arc centre and gives inner/outer radii R-/+ gap/2', () => {
    const cArc = arcs(pair.centerline.segments)[0]!;
    const gArc = arcs(pair.gas.segments)[0]!;
    const lArc = arcs(pair.liquid.segments)[0]!;

    // centerline elbow: r = 20, centre (80,20)
    expect(cArc.radius).toBeCloseTo(20, 6);
    expect(cArc.center.x).toBeCloseTo(80, 6);
    expect(cArc.center.y).toBeCloseTo(20, 6);

    // both pipe elbows share the SAME centre (concentric)
    expect(gArc.center.x).toBeCloseTo(80, 6);
    expect(gArc.center.y).toBeCloseTo(20, 6);
    expect(lArc.center.x).toBeCloseTo(80, 6);
    expect(lArc.center.y).toBeCloseTo(20, 6);

    // gas (inner) = R - gap/2 = 10, liquid (outer) = R + gap/2 = 30
    expect(gArc.radius).toBeCloseTo(10, 6);
    expect(lArc.radius).toBeCloseTo(30, 6);
  });

  it('emits SVG path data with true arc commands for both pipes', () => {
    expect(pair.gasPath).toContain('A 10 10 0 0 1');
    expect(pair.liquidPath).toContain('A 30 30 0 0 1');
    expect(pair.gasPath.startsWith('M ')).toBe(true);
    expect(pair.liquidPath.startsWith('M ')).toBe(true);
  });

  it('keeps the two pipes exactly gap apart on the straight runs', () => {
    // first segment of each pipe is the incoming straight run along y; the gas
    // and liquid offsets are +/-10 from the centerline -> 20 apart.
    const gasFirst = pair.gas.segments[0];
    const liqFirst = pair.liquid.segments[0];
    if (gasFirst?.type === 'line' && liqFirst?.type === 'line') {
      const dist = Math.hypot(gasFirst.a.x - liqFirst.a.x, gasFirst.a.y - liqFirst.a.y);
      expect(dist).toBeCloseTo(20, 6);
    } else {
      throw new Error('expected leading line segments');
    }
  });
});

describe('buildPipePair — multi-bend route stays finite and paired', () => {
  it('produces valid paths for a realistic route', () => {
    const route = [p(80, 330), p(80, 120), p(260, 120), p(360, 220), p(560, 220), p(560, 330)];
    const pair = buildPipePair(route, { bendRadiusMm: 40, gapMm: 24 });
    expect(pair.gasPath.length).toBeGreaterThan(10);
    expect(pair.liquidPath.length).toBeGreaterThan(10);
    // every arc on both pipes has a positive, finite radius
    for (const seg of [...pair.gas.segments, ...pair.liquid.segments]) {
      if (seg.type === 'arc') {
        expect(Number.isFinite(seg.radius)).toBe(true);
        expect(seg.radius).toBeGreaterThan(0);
      }
    }
  });
});
