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

describe('condensate branch router: low bodies', () => {
  // A duct across the drain's way, wall to wall: 5 m of detour round it.
  const duct: RouterBox = { id: 'duct', minX: 4000, maxX: 4500, minY: -2500, maxY: 2500, passOverAtZ: 2700 };
  const high = (pathLengthMm: number) => 2850 - pathLengthMm * 0.01;

  it('crosses one the drain is still high enough to clear, straight over', () => {
    const route = routeCondensateBranch(request(duct, { levelAt: high }));
    expect(route?.accepted).toBe(true);
    expect(route!.points).toEqual([{ x: 0, y: 0 }, { x: 10000, y: 0 }]);
  });

  it('goes round one it has fallen too low to clear', () => {
    const route = routeCondensateBranch(request(duct, { levelAt: (length) => 2720 - length * 0.01 }));
    expect(route?.accepted).toBe(true);
    expect(clearOf(route!.points, duct)).toBe(true);
  });

  it('with no level to judge by, a low body blocks like any other', () => {
    const route = routeCondensateBranch(request(duct));
    expect(clearOf(route!.points, duct)).toBe(true);
  });

  it('goes round a small one rather than pay to run over it', () => {
    const small: RouterBox = { id: 'small', minX: 4000, maxX: 6000, minY: -100, maxY: 100, passOverAtZ: 2700 };
    const route = routeCondensateBranch(request(small, { levelAt: high }));
    expect(clearOf(route!.points, small)).toBe(true);
  });
});

describe('condensate branch router: the network\'s own lines', () => {
  it('join the main where they first meet it, however crowded the drawing thins the grid', () => {
    // A main along y = 1234.5, a branch starting due south of it, and enough small boxes to the east to thin the grid
    // well below every line (none of them near the branch).
    const clutter: RouterBox[] = [];
    for (let i = 0; i < 160; i += 1) clutter.push({ id: `b${i}`, minX: 20000 + i * 37, maxX: 20020 + i * 37, minY: 3000 + i * 41, maxY: 3020 + i * 41 });
    const route = routeCondensateBranch({
      start: { x: 5003, y: 0 }, startHeading: { x: 0, y: 1 }, sink: null, obstacles: clutter, walls: [], services: [], costs,
      treeSegments: [{ edgeId: 'main', a: { x: 0, y: 1234.5 }, b: { x: 9000, y: 1234.5 }, minStation: 0, maxStation: 9000 }],
      marginMm: 30000,
    });
    expect(route?.accepted).toBe(true);
    expect(route!.target).toMatchObject({ kind: 'tree', point: { x: 5003, y: 1234.5 } });
    expect(route!.lengthMm).toBeCloseTo(1234.5, 3);
  });
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
