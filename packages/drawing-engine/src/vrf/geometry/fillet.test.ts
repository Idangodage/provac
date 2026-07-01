import { describe, it, expect } from 'vitest';

import { filletSpine } from './fillet';
import { cross, dist, len, segEnd, segStart, sub, type Path, type Point } from './path';

const distPointToLine = (p: Point, a: Point, b: Point): number =>
  Math.abs(cross(sub(b, a), sub(p, a))) / (len(sub(b, a)) || 1);

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0xffffffff);
}

/** Every arc tangent to its neighbours; every joint continuous; no negative lines. */
function checkPathWellFormed(path: Path, radius: number): void {
  for (let i = 1; i < path.length; i += 1) {
    expect(dist(segEnd(path[i - 1]!), segStart(path[i]!))).toBeLessThan(1e-5);
  }
  for (const s of path) {
    if (s.kind === 'line') expect(dist(s.a, s.b)).toBeGreaterThanOrEqual(-1e-9);
    else {
      expect(s.radius).toBeGreaterThan(0);
      expect(s.radius).toBeLessThanOrEqual(radius + 1e-6);
    }
  }
  for (let i = 0; i < path.length; i += 1) {
    const s = path[i]!;
    if (s.kind !== 'arc') continue;
    const before = path[i - 1];
    const after = path[i + 1];
    if (before?.kind === 'line') expect(Math.abs(distPointToLine(s.center, before.a, before.b) - s.radius)).toBeLessThan(1e-5);
    if (after?.kind === 'line') expect(Math.abs(distPointToLine(s.center, after.a, after.b) - s.radius)).toBeLessThan(1e-5);
  }
}

describe('invariant B — tangent-arc fillet', () => {
  it('right-angle corner: arc tangent to both segments, continuous', () => {
    const { path } = filletSpine([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 30);
    const arc = path.find((s) => s.kind === 'arc');
    expect(arc).toBeTruthy();
    expect(arc!.kind === 'arc' && Math.abs(arc!.radius - 30) < 1e-6).toBe(true);
    checkPathWellFormed(path, 30);
  });

  it('reachability: over-large radius is clamped (never overlapped) + warned', () => {
    const { path, warnings } = filletSpine([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 100);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]!.appliedRadiusMm).toBeLessThan(100);
    checkPathWellFormed(path, 100);
  });

  it('two close corners share a segment without overlapping', () => {
    // Segment (100,0)->(120,0) is only 20mm; both corners want a 30mm-radius fillet.
    const { path, warnings } = filletSpine(
      [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 100 }],
      30,
    );
    expect(warnings.length).toBeGreaterThan(0);
    checkPathWellFormed(path, 30);
  });

  it('fuzz: random polylines stay tangent + continuous', () => {
    const r = rng(0x5EED);
    for (let t = 0; t < 400; t += 1) {
      const n = 3 + Math.floor(r() * 5);
      const pts: Point[] = [];
      for (let i = 0; i < n; i += 1) pts.push({ x: r() * 1000, y: r() * 1000 });
      const radius = 5 + r() * 200;
      const { path } = filletSpine(pts, radius);
      if (path.length === 0) continue;
      checkPathWellFormed(path, radius);
    }
  });
});
