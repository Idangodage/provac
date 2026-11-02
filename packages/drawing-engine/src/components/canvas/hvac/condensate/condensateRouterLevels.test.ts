import { describe, expect, it } from 'vitest';

import type { Point2D } from '../../../../types';

import { segmentSegmentDistance } from './condensateGeometry';
import { routeCondensateBranch, type CondensateRouteRequest, type RouteTarget, type RouterBox, type RouterServiceLine } from './condensateRouter';

const costs = {
  bendPenaltyMm: 300, wallPenaltyMm: 2000, crossingPenaltyMm: 1500,
  corridorBonusRatio: 0.15, overlapPenaltyRatio: 2, junctionPenaltyMm: 300,
};

/** A drain from (0, 0) to a termination 10 m east. */
function request(extra: Partial<CondensateRouteRequest>): CondensateRouteRequest {
  return { start: { x: 0, y: 0 }, startHeading: { x: 1, y: 0 }, sink: { x: 10000, y: 0 }, treeSegments: [],
    obstacles: [], walls: [], services: [], costs, ...extra };
}

/** The termination is high: the drain cannot be held down far on its way. */
const keepsItsHeight = (_target: RouteTarget, _length: number, heldDownMm = 0) => heldDownMm < 50;

const straight = [{ x: 0, y: 0 }, { x: 10000, y: 0 }];

function level(id: string, a: Point2D, b: Point2D, z: number, extra: Partial<RouterServiceLine> = {}): RouterServiceLine {
  return { id, a, b, halfWidthMm: 95, segments3d: [{ a: { ...a, z }, b: { ...b, z } }], ...extra };
}

const clearOfLine = (points: Point2D[], line: RouterServiceLine) => points.slice(1)
  .every((point, index) => segmentSegmentDistance(points[index]!, point, line.a, line.b) >= line.halfWidthMm);

describe('condensate branch router: passing beside a line', () => {
  // A refrigerant run at 2700 whose end stops 60 mm short of the drain's straight way: not crossed, but within its width.
  const short = level('gas#0', { x: 5000, y: 60 }, { x: 5000, y: 3000 }, 2700);
  const atItsLevel = (length: number) => 2745 - length * 0.001;

  it('is judged by its height as a crossing is: kept off it where the drain could only pass under', () => {
    const route = routeCondensateBranch(request({ services: [short], levelAt: atItsLevel, acceptTarget: keepsItsHeight }));
    expect(route?.accepted).toBe(true);
    expect(clearOfLine(route!.points, short)).toBe(true);
  });

  it('is passed close by where the drain is high enough over it, or with no level to judge by', () => {
    expect(routeCondensateBranch(request({ services: [short], levelAt: (length) => 2900 - length * 0.001, acceptTarget: keepsItsHeight }))!.points)
      .toEqual(straight);
    expect(routeCondensateBranch(request({ services: [short] }))!.points).toEqual(straight);
  });

  it('is not judged in the connection zone of a unit it serves', () => {
    const own = level('gas#0', { x: 300, y: 60 }, { x: 300, y: 3000 }, 2700, { ownZone: { ports: [{ x: 0, y: 0 }], radiusMm: 550 } });
    expect(routeCondensateBranch(request({ services: [own], levelAt: atItsLevel, acceptTarget: keepsItsHeight }))!.points).toEqual(straight);
    const another = { ...own, ownZone: undefined };
    expect(clearOfLine(routeCondensateBranch(request({ services: [another], levelAt: atItsLevel, acceptTarget: keepsItsHeight }))!.points, another))
      .toBe(true);
  });
});

describe('condensate branch router: a line that can hop', () => {
  // A refrigerant run across the drain's way at 2700: the drain, at about 2740, is neither over it nor under it.
  const across = (extra: Partial<RouterServiceLine> = {}) => level('liquid#0', { x: 5000, y: -3000 }, { x: 5000, y: 3000 }, 2700,
    { hop: { topMm: 2880, minRiseMm: 60 }, ...extra });
  const atItsLevel = (length: number) => 2745 - length * 0.001;
  // A box well clear of the way, for grid lines at y = 2000 and 2100.
  const aside: RouterBox = { id: 'aside', minX: -5000, maxX: -4900, minY: 2000, maxY: 2100 };

  it('is crossed where it can rise over the drain', () => {
    const route = routeCondensateBranch(request({ services: [across()], levelAt: atItsLevel, acceptTarget: keepsItsHeight }));
    expect(route!.points).toEqual(straight);
  });

  it('only on the stretches a hop can stand on: never on a port stub, a riser or at a corner', () => {
    const line = across({ hop: { topMm: 2880, minRiseMm: 60, stretches: [{ a: { x: 5000, y: 1000 }, b: { x: 5000, y: 3000 } }], windowMm: 80 } });
    const route = routeCondensateBranch(request({ services: [line], obstacles: [aside], levelAt: atItsLevel, acceptTarget: keepsItsHeight }));
    expect(route?.accepted).toBe(true);
    expect(route!.serviceCrossings).toHaveLength(1);
    expect(route!.serviceCrossings[0]!.point.y).toBeGreaterThanOrEqual(1080);
    expect(route!.serviceCrossings[0]!.point.y).toBeLessThanOrEqual(2920);
  });
});

describe('condensate branch router: a branch kit', () => {
  // A kit's box across the way, wall to wall, its body from 2780 to 2840.
  const kit: RouterBox = { id: 'kit', minX: 4000, maxX: 4500, minY: -2500, maxY: 2500, clearBand: { zMin: 2780, zMax: 2840, gapMm: 70 } };
  const high = (length: number) => 2850 - length * 0.01;
  const clearOf = (points: Point2D[], box: RouterBox) => points.slice(1).every((point, index) => {
    const previous = points[index]!;
    return Math.max(previous.x, point.x) <= box.minX || Math.min(previous.x, point.x) >= box.maxX
      || Math.max(previous.y, point.y) <= box.minY || Math.min(previous.y, point.y) >= box.maxY;
  });

  it('is passed under where the drain can be held down', () => {
    const route = routeCondensateBranch(request({ obstacles: [kit], levelAt: high }));
    expect(route?.accepted).toBe(true);
    expect(route!.points).toEqual(straight);
  });

  it('is gone round where the drain must keep its height, and blocks like any box with no level to judge by', () => {
    const kept = routeCondensateBranch(request({ obstacles: [kit], levelAt: high, acceptTarget: keepsItsHeight }));
    expect(kept?.accepted).toBe(true);
    expect(clearOf(kept!.points, kit)).toBe(true);
    expect(clearOf(routeCondensateBranch(request({ obstacles: [kit] }))!.points, kit)).toBe(true);
  });

  it('lets a drain start under one', () => {
    const over: RouterBox = { ...kit, minX: -200, maxX: 300, minY: -150, maxY: 150 };
    const route = routeCondensateBranch(request({ obstacles: [over], levelAt: (length) => 2700 - length * 0.01 }));
    expect(route?.accepted).toBe(true);
    expect(route!.points).toEqual(straight);
  });
});
