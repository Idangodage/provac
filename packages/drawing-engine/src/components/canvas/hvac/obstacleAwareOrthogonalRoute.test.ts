import { describe, expect, it } from 'vitest';

import type { Point2D } from '../../../types';

import {
  findObstacleAwareOrthogonalRoute,
  type ObstacleAwareOrthogonalRouteOptions,
} from './obstacleAwareOrthogonalRoute';

const defaults: ObstacleAwareOrthogonalRouteOptions = {
  start: { x: 0, y: 0 }, end: { x: 3000, y: 0 },
  startDirection: { x: 1, y: 0 }, endDirection: { x: -1, y: 0 },
  startStraightMm: 200, endStraightMm: 300, bendRadiusMm: 50,
};

function length(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

describe('findObstacleAwareOrthogonalRoute', () => {
  it('connects unobstructed facing equipment sockets directly and preserves exact coordinates', () => {
    const start = { x: 0.123456789, y: 0.654321789 };
    const end = { x: 3000.987654321, y: start.y };
    const result = findObstacleAwareOrthogonalRoute({ ...defaults, start, end });
    expect(result?.points).toEqual([start, end]);
    expect(result?.bends).toBe(0);
    expect(result?.objectiveMm).toBeCloseTo(end.x - start.x, 6);
  });

  it('uses the nearest obstacle boundary lane with the necessary four turns and elbow clearance', () => {
    const result = findObstacleAwareOrthogonalRoute({
      ...defaults, clearanceMm: 100,
      obstacles: [{ minX: 1000, maxX: 2000, minY: -500, maxY: 500 }],
    });
    expect(result).not.toBeNull();
    expect(result?.bends).toBe(4);
    expect(result?.lengthMm).toBe(4300);
    expect(result?.points[0]).toEqual(defaults.start);
    expect(result?.points.at(-1)).toEqual(defaults.end);
    expect(result?.points.some(point => Math.abs(point.y) === 650)).toBe(true);
    const points = result!.points;
    expect(length(points[0]!, points[1]!)).toBeGreaterThanOrEqual(250);
    expect(length(points.at(-2)!, points.at(-1)!)).toBeGreaterThanOrEqual(350);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]!.x === points[i - 1]!.x || points[i]!.y === points[i - 1]!.y).toBe(true);
    }
  });

  it('routes through staggered keep-outs instead of using a fixed set of outside offsets', () => {
    const result = findObstacleAwareOrthogonalRoute({
      ...defaults, end: { x: 6000, y: 0 }, bendRadiusMm: 25,
      obstacles: [
        { minX: 1000, maxX: 1600, minY: -2000, maxY: 700 },
        { minX: 2400, maxX: 3000, minY: -700, maxY: 2500 },
        { minX: 3800, maxX: 4400, minY: -2000, maxY: 700 },
      ],
    });
    expect(result).not.toBeNull();
    expect(result?.points[0]).toEqual(defaults.start);
    expect(result?.points.at(-1)).toEqual({ x: 6000, y: 0 });
    expect(result?.bends).toBeGreaterThanOrEqual(4);
  });

  it('tries the opposite equipment detour when the physical network rejects the shortest side', () => {
    const checked: Point2D[][] = [];
    const result = findObstacleAwareOrthogonalRoute({
      ...defaults, clearanceMm: 100,
      obstacles: [{ minX: 1000, maxX: 2000, minY: -500, maxY: 500 }],
      acceptRoute: points => { checked.push([...points]); return points.every(point => point.y >= 0); },
    });
    expect(result?.bends).toBe(4);
    expect(result?.lengthMm).toBe(4300);
    expect(result?.points.some(point => point.y === 650)).toBe(true);
    expect(result?.points.every(point => point.y >= 0)).toBe(true);
    expect(checked.some(points => points.some(point => point.y < 0))).toBe(true);
  });

  it('keeps a branch approach below an existing main when the shorter equipment detour crosses that main', () => {
    const result = findObstacleAwareOrthogonalRoute({
      start: { x: 1111.283962, y: 648 }, end: { x: 4336.3372745, y: 274 },
      startDirection: { x: 1, y: 0 }, endDirection: { x: -1, y: 0 },
      startStraightMm: 339.7, endStraightMm: 300, bendRadiusMm: 69.85, clearanceMm: 100,
      obstacles: [{ minX: 2900, maxX: 3500, minY: 300, maxY: 900 }],
      acceptRoute: points => !points.slice(1).some((point, index) => {
        const previous = points[index]!;
        return Math.min(point.y, previous.y) < 183.5 && Math.max(point.y, previous.y) > 183.5
          && point.x > 2500 && point.x < 5200;
      }),
    });
    expect(result).not.toBeNull();
    expect(result?.points.some(point => point.y >= 1069.85 - 1e-6)).toBe(true);
  });

  it('bounds expensive physical checks when all candidate approaches are rejected', () => {
    let checks = 0;
    const result = findObstacleAwareOrthogonalRoute({
      ...defaults, maxCandidateChecks: 3,
      acceptRoute: () => { checks += 1; return false; },
    });
    expect(result).toBeNull();
    expect(checks).toBe(3);
  });

  it('rejects a blocked mandatory socket straight without silently reversing or shortening it', () => {
    const result = findObstacleAwareOrthogonalRoute({
      ...defaults,
      obstacles: [{ minX: 100, maxX: 500, minY: -200, maxY: 200 }],
    });
    expect(result).toBeNull();
  });

  it('finds no route out of a sealed enclosure and does not invent an elevation bypass', () => {
    const result = findObstacleAwareOrthogonalRoute({
      ...defaults, startStraightMm: 25, endStraightMm: 25, bendRadiusMm: 0,
      obstacles: [
        { minX: -500, maxX: -400, minY: -500, maxY: 500 },
        { minX: 400, maxX: 500, minY: -500, maxY: 500 },
        { minX: -500, maxX: 500, minY: -500, maxY: -400 },
        { minX: -500, maxX: 500, minY: 400, maxY: 500 },
      ],
    });
    expect(result).toBeNull();
  });

  it('reports the explicit economic proxy and honors a zero elbow penalty', () => {
    const options = { ...defaults, end: { x: 3000, y: 1000 }, endDirection: { x: 0, y: -1 } };
    const result = findObstacleAwareOrthogonalRoute({ ...options, bendPenaltyMm: 850 });
    expect(result).toMatchObject({ bends: 1, lengthMm: 4000, objectiveMm: 4850 });
    expect(findObstacleAwareOrthogonalRoute({ ...options, bendPenaltyMm: 0 })?.objectiveMm).toBe(4000);
  });

  it('produces deterministic results independent of obstacle order', () => {
    const obstacles = [
      { minX: 1000, maxX: 1300, minY: -200, maxY: 200 },
      { minX: 1800, maxX: 2000, minY: -300, maxY: 300 },
    ];
    const first = findObstacleAwareOrthogonalRoute({ ...defaults, obstacles });
    expect(first).not.toBeNull();
    expect(findObstacleAwareOrthogonalRoute({ ...defaults, obstacles: [...obstacles].reverse() })).toEqual(first);
  });

  it('keeps a validated analytic route when the visibility grid cap is reached', () => {
    const result = findObstacleAwareOrthogonalRoute({
      ...defaults, maxGridNodes: 1, maxExpandedStates: 1,
      obstacles: [{ minX: 1500, maxX: 1700, minY: 1000, maxY: 1200 }],
    });
    expect(result?.points).toEqual([defaults.start, defaults.end]);
  });

  it.each([
    { startDirection: { x: 1, y: 1 } },
    { endDirection: { x: 0.8, y: 0.2 } },
    { startStraightMm: -5 },
    { clearanceMm: Number.NaN },
    { obstacles: [{ minX: 100, maxX: 50, minY: 100, maxY: 200 }] },
  ])('rejects unsupported or corrupt geometry instead of claiming a valid connection: %j', (overrides) => {
    expect(findObstacleAwareOrthogonalRoute({ ...defaults, ...overrides })).toBeNull();
  });
});
