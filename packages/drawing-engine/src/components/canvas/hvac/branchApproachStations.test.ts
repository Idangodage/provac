import { describe, expect, it } from 'vitest';

import type { Point2D } from '../../../types';

import { directBranchApproachStations } from './branchApproachStations';
import { buildOrthogonalConnectionRouteCandidates, type OrthogonalConnectionRouteOptions } from './orthogonalConnectionRoute';

const rotate = (point: Point2D, degrees: number): Point2D => {
  const c = Math.round(Math.cos(degrees * Math.PI / 180));
  const s = Math.round(Math.sin(degrees * Math.PI / 180));
  return { x: c * point.x - s * point.y, y: s * point.x + c * point.y };
};

const opposed: OrthogonalConnectionRouteOptions = {
  start: { x: 0, y: 1000 }, end: { x: -200, y: 0 },
  startDirection: { x: 1, y: 0 }, endDirection: { x: -1, y: 0 },
  startStraightMm: 200, endStraightMm: 300, bendRadiusMm: 100,
};

function optionsFor(route = opposed, rotation = 0) {
  return {
    route: { ...route, start: rotate(route.start, rotation), end: rotate(route.end, rotation),
      startDirection: route.startDirection && rotate(route.startDirection, rotation), endDirection: rotate(route.endDirection, rotation) },
    station: rotate({ x: 0, y: 0 }, rotation),
    segmentStart: rotate({ x: -1000, y: 0 }, rotation), segmentEnd: rotate({ x: 3000, y: 0 }, rotation),
  };
}

function routeAtStation(options: ReturnType<typeof optionsFor>, point: Point2D): OrthogonalConnectionRouteOptions {
  return { ...options.route, end: { x: options.route.end.x + point.x - options.station.x,
    y: options.route.end.y + point.y - options.station.y } };
}

describe('direct copper branch approach stations', () => {
  it.each([0, 90, 180, 270])('finds the exact first two-elbow station after a %s-degree rotation', angle => {
    const options = optionsFor(opposed, angle);
    const candidates = directBranchApproachStations(options);
    // Two 100 mm elbow setbacks plus 200/300 mm protected straights need
    // 700 mm between the opposed socket axes. The outlet is 200 mm behind
    // its fitting station, placing the first feasible station at 900 mm.
    expect(candidates[0]).toEqual(rotate({ x: 900, y: 0 }, angle));
    const direct = buildOrthogonalConnectionRouteCandidates(routeAtStation(options, candidates[0]!))[0]!;
    expect(direct).toHaveLength(4);
    const startLeg = Math.hypot(direct[1]!.x - direct[0]!.x, direct[1]!.y - direct[0]!.y);
    const endLeg = Math.hypot(direct[3]!.x - direct[2]!.x, direct[3]!.y - direct[2]!.y);
    expect(startLeg - 100).toBeCloseTo(200, 6);
    expect(endLeg - 100).toBeCloseTo(300, 6);
    const beforeBoundary = routeAtStation(options, rotate({ x: 899, y: 0 }, angle));
    expect(buildOrthogonalConnectionRouteCandidates(beforeBoundary).some(route => route.length <= 4)).toBe(false);
  });

  it.each([0, 90, 180, 270])('finds a one-elbow station for perpendicular socket directions at %s degrees', angle => {
    const route = { ...opposed, startDirection: { x: 0, y: -1 } };
    const options = optionsFor(route, angle);
    const candidates = directBranchApproachStations(options);
    // The unit can reach the main elevation on its own axis. The final
    // horizontal leg needs 300 mm straight plus its 100 mm elbow setback.
    expect(candidates[0]).toEqual(rotate({ x: 600, y: 0 }, angle));
    const direct = buildOrthogonalConnectionRouteCandidates(routeAtStation(options, candidates[0]!))[0]!;
    expect(direct).toHaveLength(3);
    expect(direct[1]).toEqual(rotate({ x: 0, y: 0 }, angle));
    expect(buildOrthogonalConnectionRouteCandidates(routeAtStation(options, rotate({ x: 599, y: 0 }, angle)))
      .some(candidate => candidate.length <= 3)).toBe(false);
  });

  it('keeps every fitting station inside its host and returns no direct station on an insufficient host', () => {
    const options = optionsFor();
    const candidates = directBranchApproachStations(options);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every(point => point.y === 0 && point.x >= -1000 && point.x <= 3000)).toBe(true);
    expect(directBranchApproachStations({ ...options, segmentEnd: { x: 800, y: 0 } })).toEqual([]);
    expect(directBranchApproachStations({ ...options, segmentStart: options.segmentEnd, segmentEnd: options.segmentStart })).toEqual(candidates);
  });

  it.each([{ x: 1, y: 0 }, { x: 0, y: -1 }])('does not invent a direct approach when fixed transverse clearance is insufficient: %j', startDirection => {
    const options = optionsFor({ ...opposed, start: { x: 0, y: 150 }, startDirection });
    // Moving a kit along the host cannot increase this 150 mm normal gap.
    // It cannot hold two opposed 100 mm bends or a 200 mm unit straight.
    expect(directBranchApproachStations(options)).toEqual([]);
  });
});
