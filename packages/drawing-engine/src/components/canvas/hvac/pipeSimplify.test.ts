import { describe, it, expect } from 'vitest';

import { simplifyPath } from './pipeInteractionCore';
import type { Point2D } from '../../../types';

describe('simplifyPath (RDP)', () => {
  it('collapses a near-straight jittery trail to its endpoints', () => {
    const pts: Point2D[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0.3 },
      { x: 20, y: -0.2 },
      { x: 30, y: 0.25 },
      { x: 40, y: 0 },
    ];
    expect(simplifyPath(pts, 1)).toEqual([{ x: 0, y: 0 }, { x: 40, y: 0 }]);
  });

  it('keeps a real corner beyond epsilon and preserves order', () => {
    const pts: Point2D[] = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 },
    ];
    const out = simplifyPath(pts, 2);
    expect(out).toContainEqual({ x: 50, y: 0 });
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
  });

  it('is a no-op for <=2 points or non-positive epsilon', () => {
    const two: Point2D[] = [{ x: 0, y: 0 }, { x: 9, y: 9 }];
    expect(simplifyPath(two, 1)).toEqual(two);
    const many: Point2D[] = [{ x: 0, y: 0 }, { x: 1, y: 8 }, { x: 2, y: 0 }];
    expect(simplifyPath(many, 0)).toEqual(many);
  });

  it('handles a long stroke without stack overflow', () => {
    const pts: Point2D[] = Array.from({ length: 6000 }, (_, i) => ({ x: i, y: (i % 2 ? 1 : -1) * 0.2 }));
    expect(simplifyPath(pts, 1)).toEqual([pts[0], pts[pts.length - 1]]);
  });
});
