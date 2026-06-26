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

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function normalizeOrNull(v: Point2D): Point2D | null {
  const length = Math.hypot(v.x, v.y);
  if (length < 1e-9) {
    return null;
  }
  return { x: v.x / length, y: v.y / length };
}

/**
 * Rounds the interior corners of a polyline into circular arcs of the given
 * radius, approximated by `segmentsPerCorner` short chords each. The setback at
 * a corner is clamped to half the shorter adjacent leg so arcs of consecutive
 * corners never overlap. Straight / degenerate corners and very short legs pass
 * through unchanged; endpoints are preserved. Pure geometry — this is what W4's
 * swept-radius elbow rendering builds its path from, and it is unit-tested in
 * isolation.
 */
export function filletPolyline(
  points: Point2D[],
  radiusMm: number,
  segmentsPerCorner = 6,
): Point2D[] {
  if (points.length < 3 || radiusMm <= 0) {
    return points.slice();
  }
  const out: Point2D[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const next = points[i + 1]!;
    const uPrev = normalizeOrNull(subtract(prev, curr));
    const uNext = normalizeOrNull(subtract(next, curr));
    const lenPrev = Math.hypot(prev.x - curr.x, prev.y - curr.y);
    const lenNext = Math.hypot(next.x - curr.x, next.y - curr.y);
    if (!uPrev || !uNext) {
      out.push(curr);
      continue;
    }
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(uPrev, uNext)))); // 0..PI
    if (angle > Math.PI - 1e-3 || angle < 1e-3) {
      // Straight pass-through (or hairpin we can't fillet) — keep the vertex.
      out.push(curr);
      continue;
    }
    const halfAngle = angle / 2;
    const maxSetback = Math.min(lenPrev, lenNext) / 2;
    const setback = Math.min(radiusMm / Math.tan(halfAngle), maxSetback);
    const effectiveRadius = setback * Math.tan(halfAngle);
    const t1 = { x: curr.x + uPrev.x * setback, y: curr.y + uPrev.y * setback };
    const t2 = { x: curr.x + uNext.x * setback, y: curr.y + uNext.y * setback };
    const bisector = normalizeOrNull({ x: uPrev.x + uNext.x, y: uPrev.y + uNext.y });
    if (!bisector) {
      out.push(curr);
      continue;
    }
    const centerDist = effectiveRadius / Math.sin(halfAngle);
    const center = { x: curr.x + bisector.x * centerDist, y: curr.y + bisector.y * centerDist };
    const a1 = Math.atan2(t1.y - center.y, t1.x - center.x);
    const a2 = Math.atan2(t2.y - center.y, t2.x - center.x);
    let delta = a2 - a1;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    const steps = Math.max(1, Math.floor(segmentsPerCorner));
    out.push(t1);
    for (let s = 1; s < steps; s += 1) {
      const a = a1 + (delta * s) / steps;
      out.push({ x: center.x + effectiveRadius * Math.cos(a), y: center.y + effectiveRadius * Math.sin(a) });
    }
    out.push(t2);
  }
  out.push(points[points.length - 1]!);
  return out;
}

/** A classified interior vertex of a drawn route polyline. */
export interface RouteCornerNode {
  /** Index of the vertex within the route's points array. */
  index: number;
  position: Point2D;
  /** 'elbow' at a bend, 'coupling' where the route runs straight through. */
  type: Extract<PipeNodeType, 'elbow' | 'coupling'>;
  /** Deviation from straight, degrees: 0 = straight, 90 = right angle. */
  turnAngleDeg: number;
  /** Elbow centerline radius (mm); 0 for a straight pass-through. */
  bendRadiusMm: number;
}

export interface RouteCornerOptions {
  collinearToleranceDeg?: number;
  bendRadiusFactor?: number;
}

/**
 * Walks a route polyline and classifies each INTERIOR vertex as an elbow (a real
 * bend that W4 renders as a swept-radius fitting) or a coupling (straight
 * pass-through). Endpoints are not corners. Degenerate (zero-length) legs are
 * skipped. The pipe diameter is uniform along a route, so a corner is never a
 * reducer.
 */
export function buildRouteCornerNodes(
  points: Point2D[],
  diameterMm: number,
  options?: RouteCornerOptions,
): RouteCornerNode[] {
  const nodes: RouteCornerNode[] = [];
  if (points.length < 3) {
    return nodes;
  }
  const collinearToleranceDeg = options?.collinearToleranceDeg ?? DEFAULT_COLLINEAR_TOLERANCE_DEG;
  const k = options?.bendRadiusFactor ?? DEFAULT_BEND_RADIUS_FACTOR;
  for (let i = 1; i < points.length - 1; i += 1) {
    const current = points[i]!;
    // Outward directions from the vertex along each incident leg.
    const toPrev = normalizeOrNull(subtract(points[i - 1]!, current));
    const toNext = normalizeOrNull(subtract(points[i + 1]!, current));
    if (!toPrev || !toNext) {
      continue;
    }
    const type = classifyNode(
      [
        { segmentId: `${i - 1}`, direction: toPrev, diameterMm },
        { segmentId: `${i}`, direction: toNext, diameterMm },
      ],
      { collinearToleranceDeg },
    );
    const betweenDeg = (Math.acos(Math.max(-1, Math.min(1, dot(toPrev, toNext)))) * 180) / Math.PI;
    const turnAngleDeg = 180 - betweenDeg; // 0 straight … 180 hairpin
    const isElbow = type === 'elbow';
    nodes.push({
      index: i,
      position: current,
      type: isElbow ? 'elbow' : 'coupling',
      turnAngleDeg,
      bendRadiusMm: isElbow ? bendRadiusFromDiameterMm(diameterMm, k) : 0,
    });
  }
  return nodes;
}
