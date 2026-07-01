import { describe, it, expect } from 'vitest';

import { simplifyRDP, type Point } from './path';

describe('simplifyRDP', () => {
  it('collapses near-collinear points to the endpoints', () => {
    const pts: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0.2 },
      { x: 20, y: -0.1 },
      { x: 30, y: 0.15 },
      { x: 40, y: 0 },
    ];
    expect(simplifyRDP(pts, 1)).toEqual([{ x: 0, y: 0 }, { x: 40, y: 0 }]);
  });

  it('keeps a genuine corner beyond epsilon', () => {
    const pts: Point[] = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 }, // sharp corner, far from the 0,0→50,50 chord
      { x: 0, y: 50 },
    ];
    const out = simplifyRDP(pts, 2);
    expect(out).toContainEqual({ x: 50, y: 0 });
    expect(out.length).toBeGreaterThanOrEqual(3);
  });

  it('preserves endpoints and never reorders', () => {
    const pts: Point[] = Array.from({ length: 50 }, (_, i) => ({ x: i, y: Math.sin(i / 5) * 20 }));
    const out = simplifyRDP(pts, 1.5);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
    // monotonic x (order preserved) and a real reduction
    for (let i = 1; i < out.length; i += 1) expect(out[i]!.x).toBeGreaterThan(out[i - 1]!.x);
    expect(out.length).toBeLessThan(pts.length);
  });

  it('is a no-op for 2 points or non-positive epsilon', () => {
    const two: Point[] = [{ x: 0, y: 0 }, { x: 5, y: 5 }];
    expect(simplifyRDP(two, 1)).toEqual(two);
    const many: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 9 }, { x: 2, y: 0 }];
    expect(simplifyRDP(many, 0)).toEqual(many);
  });

  it('handles a long noisy stroke without overflowing (iterative)', () => {
    const pts: Point[] = Array.from({ length: 5000 }, (_, i) => ({ x: i, y: (i % 2 ? 1 : -1) * 0.3 }));
    const out = simplifyRDP(pts, 1); // jitter < 1 -> collapses to endpoints
    expect(out).toEqual([pts[0], pts[pts.length - 1]]);
  });
});
