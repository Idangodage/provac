import type { Point2D } from '../../../types';

import { buildOrthogonalConnectionRouteCandidates, getOrthogonalConnectionRouteCost, type OrthogonalConnectionRouteOptions } from './orthogonalConnectionRoute';

/** Positions where a translated physical kit can first admit a direct approach.
 * These are search candidates, not permission to move a fitting or waive a
 * clearance: the caller must rebuild both services and validate the full tree. */
export function directBranchApproachStations(options: {
  route: OrthogonalConnectionRouteOptions;
  station: Point2D;
  segmentStart: Point2D;
  segmentEnd: Point2D;
}): Point2D[] {
  const { route, station, segmentStart: a, segmentEnd: b } = options;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (!Number.isFinite(length) || length < 1 || !route.startDirection) return [];
  const axis = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  if (Math.abs(axis.x) > 1e-6 && Math.abs(axis.y) > 1e-6) return [];
  const dot = (point: Point2D) => point.x * axis.x + point.y * axis.y;
  const radius = route.bendRadiusMm ?? 0;
  const departure = dot(route.startDirection);
  const outlet = dot(route.endDirection);
  const startClear = route.startStraightMm + radius;
  const endClear = route.endStraightMm + radius;
  const start = dot(route.start);
  // Opposed parallel sockets need room for BOTH protected straights and elbow
  // setbacks. Perpendicular sockets need one projected approach; same-facing
  // sockets share an outside lane. The route solver checks the normal axis too.
  const boundaries = [
    start + departure * startClear - outlet * endClear,
    start + departure * startClear,
    start - outlet * endClear,
    start,
  ];
  const currentStation = dot(station) - dot(a);
  const candidates = new Map<string, { point: Point2D; bends: number; lengthMm: number; movementMm: number; shiftMm: number }>();
  for (const boundary of boundaries) for (const slack of [0, -2 * radius, 2 * radius]) {
    const position = Math.max(0, Math.min(length, currentStation + boundary + slack - dot(route.end)));
    const shift = position - currentStation;
    if (Math.abs(shift) < 0.5) continue;
    const point = { x: station.x + axis.x * shift, y: station.y + axis.y * shift };
    const shiftedRoute = { ...route, end: { x: route.end.x + axis.x * shift, y: route.end.y + axis.y * shift } };
    const best = buildOrthogonalConnectionRouteCandidates(shiftedRoute)[0];
    if (!best) continue;
    const cost = getOrthogonalConnectionRouteCost(best);
    if (cost.bends > 2) continue;
    candidates.set(`${point.x.toFixed(3)}:${point.y.toFixed(3)}`, { point, ...cost, movementMm: Math.abs(shift), shiftMm: shift });
  }
  return [...candidates.values()].sort((left, right) => left.bends - right.bends
    || left.lengthMm - right.lengthMm || left.movementMm - right.movementMm
    || left.shiftMm - right.shiftMm).slice(0, 6).map(candidate => candidate.point);
}
