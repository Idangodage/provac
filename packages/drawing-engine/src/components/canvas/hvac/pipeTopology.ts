/**
 * Pipe connection-graph primitives (W3).
 *
 * A typed node/edge view of refrigerant routes so junctions can be classified by
 * valence + incident angles/diameters and the correct fitting inserted. This
 * module is PURE geometry/topology — no React, no store, no Three.js — so it can
 * be unit-tested in isolation and reused by:
 *   - the branch-kit accept path (W3b), to split a tapped main into two edges at
 *     a real, flow-connected tee node (replacing the cosmetic overlay), and
 *   - the 3D generator (W4), to place real elbow/tee meshes at nodes.
 *
 * Scope for this pass: tee + elbow are the load-bearing classifications;
 * coupling / reducer / cap are classified too (cheap and useful to the renderer)
 * but only tee + elbow drive behaviour downstream. 4+ valence is reported as
 * 'cross' rather than silently treated as a tee.
 */

import type { Point2D } from '../../../types';

export type PipeNodeType =
  | 'cap' // 1 segment — a dead end / open terminal
  | 'coupling' // 2 collinear segments, same diameter — a straight joiner
  | 'reducer' // 2 collinear segments, different diameter
  | 'elbow' // 2 segments meeting at an angle
  | 'tee' // 3 segments — a branch takeoff
  | 'cross'; // 4+ segments — out of scope this pass, surfaced explicitly

/** One pipe segment meeting at a node, described looking outward from the node. */
export interface IncidentSegment {
  /** Id of the segment/edge this belongs to (e.g. an HvacElement id). */
  segmentId: string;
  /** Unit direction pointing AWAY from the node along the segment. */
  direction: Point2D;
  /** Outer (insulated) diameter of the segment at the node, mm. */
  diameterMm: number;
}

export interface NodeClassificationOptions {
  /**
   * Two outward directions whose in-between angle is within this of 180° are
   * treated as collinear (a straight pass-through). Degrees.
   */
  collinearToleranceDeg?: number;
  /** Diameter delta (mm) above which a straight 2-valent node is a reducer. */
  reducerThresholdMm?: number;
}

const DEFAULT_COLLINEAR_TOLERANCE_DEG = 5;
const DEFAULT_REDUCER_THRESHOLD_MM = 1;

/**
 * Long-radius copper default: elbow centerline radius = k × outer diameter.
 * Chosen per the W2/W3 design discussion (k = 1.5 = typical long-radius bend),
 * overridable by the caller.
 */
export const DEFAULT_BEND_RADIUS_FACTOR = 1.5;

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function pointsClose(a: Point2D, b: Point2D, toleranceMm: number): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= toleranceMm;
}

/**
 * Classifies a node from the segments incident to it. `direction` on each
 * segment must point AWAY from the node, so a straight pass-through has two
 * opposite directions (in-between angle ≈ 180°) and a 90° elbow has an
 * in-between angle ≈ 90°.
 *
 * Geometry wins over diameter at a bend: a bent node is an `elbow` even if the
 * two diameters differ (a reducing elbow still renders as an elbow); `reducer`
 * is reserved for straight inline diameter changes.
 */
export function classifyNode(
  incident: IncidentSegment[],
  options?: NodeClassificationOptions,
): PipeNodeType {
  const valence = incident.length;
  if (valence <= 1) {
    return 'cap';
  }
  if (valence === 2) {
    const [a, b] = incident as [IncidentSegment, IncidentSegment];
    const cosAngle = Math.max(-1, Math.min(1, dot(a.direction, b.direction)));
    const betweenDeg = (Math.acos(cosAngle) * 180) / Math.PI; // 0..180
    const collinearTol = options?.collinearToleranceDeg ?? DEFAULT_COLLINEAR_TOLERANCE_DEG;
    const straight = betweenDeg >= 180 - collinearTol;
    if (!straight) {
      return 'elbow';
    }
    const reducerThreshold = options?.reducerThresholdMm ?? DEFAULT_REDUCER_THRESHOLD_MM;
    return Math.abs(a.diameterMm - b.diameterMm) > reducerThreshold ? 'reducer' : 'coupling';
  }
  if (valence === 3) {
    return 'tee';
  }
  return 'cross';
}

export interface PolylineSplit {
  /** Run-in half: original start … station (station appended). */
  before: Point2D[];
  /** Run-out half: station … original end (station prepended). */
  after: Point2D[];
  /** The resolved split point on the polyline (projected onto the nearest leg). */
  station: Point2D;
}

/**
 * Splits a polyline at the station nearest to `station`, projecting it onto the
 * closest leg. Both halves share the station vertex so they stay connected (a
 * tee's run-in and run-out). Returns null when the polyline is degenerate or the
 * resolved split lands on an endpoint of the whole run (nothing to split off).
 */
export function splitPolylineAtStation(
  points: Point2D[],
  station: Point2D,
  toleranceMm = 1e-3,
): PolylineSplit | null {
  if (points.length < 2) {
    return null;
  }
  let bestIndex = -1;
  let bestDistSq = Infinity;
  let bestProj: Point2D = station;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const lenSq = abx * abx + aby * aby;
    if (lenSq < 1e-12) {
      continue;
    }
    let t = ((station.x - a.x) * abx + (station.y - a.y) * aby) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const proj = { x: a.x + abx * t, y: a.y + aby * t };
    const dx = station.x - proj.x;
    const dy = station.y - proj.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestIndex = i;
      bestProj = proj;
    }
  }
  if (bestIndex < 0) {
    return null;
  }
  if (
    pointsClose(bestProj, points[0]!, toleranceMm) ||
    pointsClose(bestProj, points[points.length - 1]!, toleranceMm)
  ) {
    return null;
  }
  const before = dedupeTail([...points.slice(0, bestIndex + 1), bestProj], toleranceMm);
  const after = dedupeHead([bestProj, ...points.slice(bestIndex + 1)], toleranceMm);
  return { before, after, station: bestProj };
}

function dedupeTail(points: Point2D[], toleranceMm: number): Point2D[] {
  // When the appended station coincides with the prior vertex, keep the station
  // (the exact split point) and drop the duplicate before it.
  if (
    points.length >= 2 &&
    pointsClose(points[points.length - 1]!, points[points.length - 2]!, toleranceMm)
  ) {
    return [...points.slice(0, points.length - 2), points[points.length - 1]!];
  }
  return points;
}

function dedupeHead(points: Point2D[], toleranceMm: number): Point2D[] {
  if (points.length >= 2 && pointsClose(points[0]!, points[1]!, toleranceMm)) {
    return points.slice(1);
  }
  return points;
}

/** Elbow centerline radius (mm) for a pipe of the given outer diameter. */
export function bendRadiusFromDiameterMm(
  diameterMm: number,
  k: number = DEFAULT_BEND_RADIUS_FACTOR,
): number {
  return Math.max(0, diameterMm) * k;
}
