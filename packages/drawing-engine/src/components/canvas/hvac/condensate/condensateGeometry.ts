/**
 * Small pure geometry helpers shared by the condensate engine, renderers and
 * hit testing. Plan coordinates are model millimetres (y down), Z is mm above
 * finished floor level.
 */
import type { HvacElement, Point2D } from '../../../../types';

import { condensateInsulatedRadiusMm, isCondensatePipe, readCondensatePipeSpec, type Point3 } from './condensateTypes';

export const EPS = 1e-6;

export function sub(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function add(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function scale(a: Point2D, factor: number): Point2D {
  return { x: a.x * factor, y: a.y * factor };
}

export function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

export function cross(a: Point2D, b: Point2D): number {
  return a.x * b.y - a.y * b.x;
}

export function length(a: Point2D): number {
  return Math.hypot(a.x, a.y);
}

export function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function normalize(a: Point2D): Point2D {
  const magnitude = length(a);
  return magnitude > EPS ? { x: a.x / magnitude, y: a.y / magnitude } : { x: 0, y: 0 };
}

export function samePoint(a: Point2D, b: Point2D, tolerance = 0.01): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
}

export function pointToSegmentDistance(point: Point2D, a: Point2D, b: Point2D): number {
  const ab = sub(b, a);
  const lengthSquared = dot(ab, ab);
  if (lengthSquared <= EPS) return distance(point, a);
  const t = Math.max(0, Math.min(1, dot(sub(point, a), ab) / lengthSquared));
  return distance(point, add(a, scale(ab, t)));
}

/** Closest point on a segment and its parameter t ∈ [0, 1]. */
export function closestOnSegment(point: Point2D, a: Point2D, b: Point2D): { point: Point2D; t: number } {
  const ab = sub(b, a);
  const lengthSquared = dot(ab, ab);
  if (lengthSquared <= EPS) return { point: { ...a }, t: 0 };
  const t = Math.max(0, Math.min(1, dot(sub(point, a), ab) / lengthSquared));
  return { point: add(a, scale(ab, t)), t };
}

export function polylineLength(points: readonly Point2D[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += distance(points[index - 1]!, points[index]!);
  return total;
}

/** Removes consecutive duplicates and collinear interior vertices. */
export function simplifyPolyline(points: readonly Point2D[], tolerance = 0.05): Point2D[] {
  const deduped: Point2D[] = [];
  for (const point of points) {
    if (!deduped.length || !samePoint(deduped[deduped.length - 1]!, point, tolerance)) deduped.push({ x: point.x, y: point.y });
  }
  if (deduped.length <= 2) return deduped;
  const result: Point2D[] = [deduped[0]!];
  for (let index = 1; index < deduped.length - 1; index += 1) {
    const previous = result[result.length - 1]!;
    const current = deduped[index]!;
    const next = deduped[index + 1]!;
    const u = normalize(sub(current, previous));
    const v = normalize(sub(next, current));
    if (Math.abs(cross(u, v)) <= 1e-6 && dot(u, v) > 0) continue;
    result.push(current);
  }
  result.push(deduped[deduped.length - 1]!);
  return result;
}

/** Proper intersection of two plan segments (touching endpoints excluded when `strict`). */
export function segmentIntersection(
  a: Point2D,
  b: Point2D,
  c: Point2D,
  d: Point2D,
  strict = true,
): { point: Point2D; t: number; u: number } | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const denominator = cross(r, s);
  if (Math.abs(denominator) <= EPS) return null;
  const qp = sub(c, a);
  const t = cross(qp, s) / denominator;
  const u = cross(qp, r) / denominator;
  const lo = strict ? 1e-6 : -1e-9;
  const hi = strict ? 1 - 1e-6 : 1 + 1e-9;
  if (t < lo || t > hi || u < lo || u > hi) return null;
  return { point: add(a, scale(r, t)), t, u };
}

/** Plan distance between two segments (0 when they intersect). */
export function segmentSegmentDistance(a: Point2D, b: Point2D, c: Point2D, d: Point2D): number {
  if (segmentIntersection(a, b, c, d, false)) return 0;
  return Math.min(
    pointToSegmentDistance(a, c, d),
    pointToSegmentDistance(b, c, d),
    pointToSegmentDistance(c, a, b),
    pointToSegmentDistance(d, a, b),
  );
}

export function point3Distance(a: Point3, b: Point3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Cumulative plan stations of a 3D polyline. */
export function planStations(nodes: readonly Point2D[]): number[] {
  const stations = [0];
  for (let index = 1; index < nodes.length; index += 1) {
    stations.push(stations[index - 1]! + distance(nodes[index - 1]!, nodes[index]!));
  }
  return stations;
}

/** Plan distance within which a condensate pipe is picked (mm). */
export function pickCondensatePipeAtWorldPoint(
  point: Point2D,
  elements: Iterable<HvacElement>,
  paddingMm: number,
): { id: string; distanceMm: number; elevationMm: number } | null {
  let best: { id: string; distanceMm: number; elevationMm: number } | null = null;
  for (const element of elements) {
    if (!isCondensatePipe(element)) continue;
    const spec = readCondensatePipeSpec(element);
    const nodes = spec.routeNodes3d.length >= 2 ? spec.routeNodes3d : spec.routePoints.map((p) => ({ ...p, z: element.elevation }));
    const tolerance = condensateInsulatedRadiusMm(spec) + paddingMm;
    for (let index = 1; index < nodes.length; index += 1) {
      const a = nodes[index - 1]!;
      const b = nodes[index]!;
      const d = pointToSegmentDistance(point, a, b);
      if (d > tolerance) continue;
      const z = Math.max(a.z, b.z);
      if (!best || d < best.distanceMm - 0.01 || (Math.abs(d - best.distanceMm) <= 0.01 && z > best.elevationMm)) {
        best = { id: element.id, distanceMm: d, elevationMm: z };
      }
    }
  }
  return best;
}
