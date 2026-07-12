import { describe, it, expect } from 'vitest';

import { buildPairedGeometry } from './offset';
import { add, dist, dot, mul, samplePath, sub, type Point } from './path';

function distPointToSeg(p: Point, a: Point, b: Point): number {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  return dist(p, add(a, mul(ab, t)));
}
function distToPolyline(p: Point, poly: Point[]): number {
  let m = Infinity;
  for (let i = 0; i < poly.length - 1; i += 1) m = Math.min(m, distPointToSeg(p, poly[i]!, poly[i + 1]!));
  return m;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0xffffffff);
}

/** Measure the gas↔liquid gap at every sampled gas point. */
function gapStats(spine: Point[], gapMm: number, radiusMm: number) {
  const g = buildPairedGeometry(spine, gapMm, radiusMm);
  const gas = samplePath(g.gas, 0.15);
  const liq = samplePath(g.liquid, 0.15);
  let mn = Infinity;
  let mx = -Infinity;
  for (const p of gas) {
    const d = distToPolyline(p, liq);
    mn = Math.min(mn, d);
    mx = Math.max(mx, d);
  }
  return { mn, mx };
}

describe('invariant A — constant gap through bends', () => {
  it('right-angle bends: gap stays constant (no pinch, no split)', () => {
    const spine = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 420, y: 200 }];
    const gap = 40;
    const { mn, mx } = gapStats(spine, gap, 60);
    expect(mn).toBeGreaterThan(gap - 0.35);
    expect(mx).toBeLessThan(gap + 0.35);
  });

  it('acute + obtuse bends across gaps and radii', () => {
    for (const gap of [20, 40, 80]) {
      for (const r of [40, 90, 160]) {
        const spine = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 500, y: 260 }, { x: 800, y: 200 }];
        const { mn, mx } = gapStats(spine, gap, r);
        expect(mn).toBeGreaterThan(gap - 0.4);
        expect(mx).toBeLessThan(gap + 0.4);
      }
    }
  });

  it('fuzz: random spines keep the gap within ε', () => {
    const rand = rng(0xA11CE);
    for (let t = 0; t < 120; t += 1) {
      const n = 3 + Math.floor(rand() * 4);
      const pts: Point[] = [{ x: 0, y: 0 }];
      for (let i = 1; i < n; i += 1) {
        pts.push({ x: pts[i - 1]!.x + 150 + rand() * 300, y: (rand() - 0.5) * 500 });
      }
      const gap = 20 + rand() * 60;
      const r = 40 + rand() * 140;
      const { mn, mx } = gapStats(pts, gap, r);
      expect(mn).toBeGreaterThan(gap - 0.5);
      expect(mx).toBeLessThan(gap + 0.5);
    }
  });
});
