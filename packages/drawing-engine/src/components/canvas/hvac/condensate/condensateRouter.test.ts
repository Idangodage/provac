import { describe, expect, it } from 'vitest';

import { routeCondensateBranch, type CondensateRouteRequest, type RouterBox } from './condensateRouter';

const costs = {
  bendPenaltyMm: 300, wallPenaltyMm: 2000, crossingPenaltyMm: 1500,
  corridorBonusRatio: 0.15, overlapPenaltyRatio: 2, junctionPenaltyMm: 300,
};

/** A drain from (0, 0) to a termination 10 m east, with a box across its way. */
function request(box: RouterBox, extra: Partial<CondensateRouteRequest> = {}): CondensateRouteRequest {
  return {
    start: { x: 0, y: 0 }, startHeading: { x: 1, y: 0 }, sink: { x: 10000, y: 0 }, treeSegments: [],
    obstacles: [box], walls: [], services: [], costs, ...extra,
  };
}

const clearOf = (points: Array<{ x: number; y: number }>, box: RouterBox) => points.slice(1).every((point, index) => {
  const previous = points[index]!;
  const minX = Math.min(previous.x, point.x); const maxX = Math.max(previous.x, point.x);
  const minY = Math.min(previous.y, point.y); const maxY = Math.max(previous.y, point.y);
  return maxX <= box.minX || minX >= box.maxX || maxY <= box.minY || minY >= box.maxY;
});

describe('condensate branch router: the search area', () => {
  // A row of ducts across the drain's way, 5 m long: the local area (1.5 m round the ends) has no way past it.
  const ducts: RouterBox = { id: 'ducts', minX: 4000, maxX: 6000, minY: -2500, maxY: 2500 };

  it('widens when the local area is walled off, and goes round', () => {
    const route = routeCondensateBranch(request(ducts));
    expect(route?.accepted).toBe(true);
    expect(route!.points.at(-1)).toEqual({ x: 10000, y: 0 });
    expect(clearOf(route!.points, ducts)).toBe(true);
    expect(Math.max(...route!.points.map((point) => Math.abs(point.y)))).toBeGreaterThanOrEqual(2500);
  });

  it('keeps an area the caller set', () => {
    expect(routeCondensateBranch(request(ducts, { marginMm: 1500 }))).toBeNull();
  });

  it('takes in the whole drawing when 6 m round the ends is not enough', () => {
    const long: RouterBox = { id: 'long', minX: 4000, maxX: 6000, minY: -7000, maxY: 7000 };
    const route = routeCondensateBranch(request(long));
    expect(route?.accepted).toBe(true);
    expect(clearOf(route!.points, long)).toBe(true);
    expect(Math.max(...route!.points.map((point) => Math.abs(point.y)))).toBeGreaterThanOrEqual(7000);
  });

  it('returns nothing when even the whole drawing has no way', () => {
    // Walled all round: the termination sits inside a closed box of obstacles.
    const walls: RouterBox[] = [
      { id: 'n', minX: 8000, maxX: 12000, minY: 1000, maxY: 1200 },
      { id: 's', minX: 8000, maxX: 12000, minY: -1200, maxY: -1000 },
      { id: 'w', minX: 8000, maxX: 8200, minY: -1200, maxY: 1200 },
      { id: 'e', minX: 11800, maxX: 12000, minY: -1200, maxY: 1200 },
    ];
    expect(routeCondensateBranch({ ...request(walls[0]!), obstacles: walls })).toBeNull();
  });
});
