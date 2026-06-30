/**
 * Canonical refrigerant-pipe centerline (T1 / foundation).
 *
 * A pipe route is stored as sharp vertices (`routePoints: Point2D[]`). Until now
 * each renderer rounded those corners independently and differently — the 2D
 * Fabric plan used a cosmetic `strokeLineJoin:'round'` + a Catmull-Rom wobble,
 * the 3D builder used a `QuadraticBezierCurve3` fillet, and the one true
 * plan-space fillet (`pipeTopology.filletPolyline`) was consumed by nobody in
 * 2D. Three different curves for one corner is the root of the 2D/3D bend
 * mismatch.
 *
 * This module is the SINGLE source of derived pipe geometry. It turns a route
 * polyline + a bend radius into a structured **arc-spline**: an ordered list of
 * `line` and constant-radius `arc` segments (a pipe bend is a constant-radius
 * elbow tangent to its two legs — G1 continuity — NOT a free Bezier/NURBS whose
 * curvature wanders and cannot honour a minimum bend radius).
 *
 * The structured representation is then projected, ONCE, into whatever each
 * renderer needs:
 *   - {@link toSvgPathData}  — SVG `A` arc commands for `fabric.Path` / `Konva.Path`
 *   - {@link toPolyline}     — adaptive chord sampling for hit-testing
 *   - `toCurvePath3D` (see `./pipeCenterline3d`) — a three.js curve for the 3D sweep
 *
 * Corners are rounded EXACTLY ONCE, here. The setback/clamp math mirrors
 * {@link ./pipeTopology#filletPolyline} and
 * {@link ./three3d/pipeJointGeometry#buildTubeCurve} so the 2D and 3D outputs
 * agree by construction.
 *
 * PURE: no fabric / konva / three / React / store imports, so it is unit-tested
 * in isolation and is cheap enough to rebuild for a live drag ghost.
 */

import type { Point2D } from '../../../types';

/** One primitive of the centerline arc-spline. */
export type CenterlineSegment =
  | { type: 'line'; a: Point2D; b: Point2D }
  | {
      type: 'arc';
      /** Arc centre (mm, world). */
      center: Point2D;
      /** Constant radius (mm) after any short-leg clamp. */
      radius: number;
      /** Tangent point where the arc begins (lies on the incoming leg). */
      start: Point2D;
      /** Tangent point where the arc ends (lies on the outgoing leg). */
      end: Point2D;
      /** `atan2` of `start` about `center` (radians). */
      startAngle: number;
      /** `atan2` of `end` about `center` (radians). */
      endAngle: number;
      /** Canvas/three arc direction: `ctx.arc(...,anticlockwise)`. */
      anticlockwise: boolean;
      /** SVG arc `sweep-flag` (0|1) for this same arc. */
      sweepFlag: 0 | 1;
    };

export interface PipeCenterline {
  /** First point of the path (route start). */
  start: Point2D;
  /** Ordered line/arc primitives from `start` to the route end. */
  segments: CenterlineSegment[];
}

const EPSILON = 1e-6;
/** Below this turn (rad) a corner is a straight pass-through (no fillet). */
const STRAIGHT_TURN_EPSILON = 1e-3;

function sub(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function len(v: Point2D): number {
  return Math.hypot(v.x, v.y);
}

function normalizeOrNull(v: Point2D): Point2D | null {
  const l = len(v);
  if (l < EPSILON) return null;
  return { x: v.x / l, y: v.y / l };
}

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function clampUnit(x: number): number {
  return Math.max(-1, Math.min(1, x));
}

function signedDelta(startAngle: number, endAngle: number): number {
  // Shortest signed sweep in (-PI, PI]. Fillet arcs are always < 180deg.
  let d = endAngle - startAngle;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Per-corner bend radius: a single radius, or one entry per interior vertex. */
export type BendRadius = number | number[];

function radiusForCorner(bendRadius: BendRadius, interiorIndex: number): number {
  if (Array.isArray(bendRadius)) {
    return Math.max(0, bendRadius[interiorIndex] ?? 0);
  }
  return Math.max(0, bendRadius);
}

/**
 * Builds the canonical arc-spline centerline for a route.
 *
 * The setback at each corner is clamped to half of the *remaining* incoming leg
 * (after the previous fillet) and half of the outgoing leg, so consecutive
 * fillets never overlap and a tight corner relaxes its radius instead of
 * overshooting. Collinear and degenerate (zero-length) corners pass straight
 * through; endpoints are preserved.
 */
export function buildPipeCenterline(
  routePoints: Point2D[],
  bendRadius: BendRadius,
): PipeCenterline {
  const pts = routePoints ?? [];
  if (pts.length === 0) {
    return { start: { x: 0, y: 0 }, segments: [] };
  }
  if (pts.length === 1) {
    return { start: { x: pts[0]!.x, y: pts[0]!.y }, segments: [] };
  }

  const start: Point2D = { x: pts[0]!.x, y: pts[0]!.y };
  const segments: CenterlineSegment[] = [];
  let cursor: Point2D = start;

  for (let i = 1; i < pts.length - 1; i += 1) {
    const vertex = pts[i]!;
    const next = pts[i + 1]!;
    const inDir = sub(vertex, cursor);
    const outDir = sub(next, vertex);
    const inLen = len(inDir);
    const outLen = len(outDir);
    if (inLen < EPSILON || outLen < EPSILON) {
      // Degenerate leg — keep travelling; the vertex is absorbed into the next
      // straight run (do not emit a spurious zero-length primitive).
      continue;
    }
    const inU = { x: inDir.x / inLen, y: inDir.y / inLen };
    const outU = { x: outDir.x / outLen, y: outDir.y / outLen };

    const turn = Math.acos(clampUnit(dot(inU, outU))); // 0 = straight, PI = hairpin
    if (turn < STRAIGHT_TURN_EPSILON || turn > Math.PI - STRAIGHT_TURN_EPSILON) {
      // Straight pass-through (or un-filletable hairpin): leave the vertex for
      // the next line to run through.
      continue;
    }

    const radius = radiusForCorner(bendRadius, i - 1);
    const halfAngle = (Math.PI - turn) / 2; // interior half-angle between the legs
    const tanHalf = Math.tan(halfAngle);
    const desiredSetback = radius > 0 && tanHalf > EPSILON ? radius / tanHalf : 0;
    const setback = Math.min(desiredSetback, inLen * 0.5, outLen * 0.5);

    // A real corner we can't fillet (radius 0, or clamped to nothing) must keep
    // its SHARP vertex — skipping it here would cut the corner into a diagonal.
    if (setback >= EPSILON) {
      const effRadius = setback * tanHalf;
      const t1: Point2D = { x: vertex.x - inU.x * setback, y: vertex.y - inU.y * setback };
      const t2: Point2D = { x: vertex.x + outU.x * setback, y: vertex.y + outU.y * setback };

      // Bisector of the two legs, pointing away from the vertex toward the arc
      // centre (uPrev = -inU points back along the incoming leg).
      const bisector = normalizeOrNull({ x: -inU.x + outU.x, y: -inU.y + outU.y });
      if (bisector) {
        const sinHalf = Math.sin(halfAngle);
        const centerDist = sinHalf > EPSILON ? effRadius / sinHalf : effRadius;
        const center: Point2D = {
          x: vertex.x + bisector.x * centerDist,
          y: vertex.y + bisector.y * centerDist,
        };
        const startAngle = Math.atan2(t1.y - center.y, t1.x - center.x);
        const endAngle = Math.atan2(t2.y - center.y, t2.x - center.x);
        const delta = signedDelta(startAngle, endAngle);

        if (len(sub(t1, cursor)) > EPSILON) {
          segments.push({ type: 'line', a: cursor, b: t1 });
        }
        segments.push({
          type: 'arc',
          center,
          radius: effRadius,
          start: t1,
          end: t2,
          startAngle,
          endAngle,
          anticlockwise: delta < 0,
          sweepFlag: delta >= 0 ? 1 : 0,
        });
        cursor = t2;
        continue;
      }
    }

    // Sharp-corner fallback: run the line up to the vertex and keep it.
    if (len(sub(vertex, cursor)) > EPSILON) {
      segments.push({ type: 'line', a: cursor, b: { x: vertex.x, y: vertex.y } });
    }
    cursor = { x: vertex.x, y: vertex.y };
  }

  const last = pts[pts.length - 1]!;
  if (len(sub(last, cursor)) > EPSILON) {
    segments.push({ type: 'line', a: cursor, b: { x: last.x, y: last.y } });
  }

  return { start, segments };
}

function arcSweep(seg: Extract<CenterlineSegment, { type: 'arc' }>): number {
  return Math.abs(signedDelta(seg.startAngle, seg.endAngle));
}

/** Total arc-length (mm) of the filleted centerline. */
export function centerlineLength(centerline: PipeCenterline): number {
  let total = 0;
  for (const seg of centerline.segments) {
    if (seg.type === 'line') {
      total += len(sub(seg.b, seg.a));
    } else {
      total += seg.radius * arcSweep(seg);
    }
  }
  return total;
}

function fmt(n: number): string {
  // Trim float noise; SVG path numbers do not need more than ~4 dp at mm scale.
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? '0' : String(r);
}

/**
 * SVG path data for the centerline. Lines become `L`, constant-radius arcs
 * become a single `A rx ry 0 large-arc sweep x y` command (fillet arcs are
 * always < 180deg, so `large-arc` is always 0). Consumed directly by
 * `fabric.Path` and `Konva.Path`, so a bend renders as a true arc with no
 * tessellation.
 */
export function toSvgPathData(centerline: PipeCenterline): string {
  const { start, segments } = centerline;
  let d = `M ${fmt(start.x)} ${fmt(start.y)}`;
  for (const seg of segments) {
    if (seg.type === 'line') {
      d += ` L ${fmt(seg.b.x)} ${fmt(seg.b.y)}`;
    } else {
      d += ` A ${fmt(seg.radius)} ${fmt(seg.radius)} 0 0 ${seg.sweepFlag} ${fmt(seg.end.x)} ${fmt(seg.end.y)}`;
    }
  }
  return d;
}

/** Steps needed to keep an arc's chord error within `tolMm`. */
function arcSteps(radius: number, sweep: number, tolMm: number): number {
  if (radius <= EPSILON || sweep <= EPSILON) return 1;
  const safeTol = Math.max(tolMm, 1e-4);
  if (safeTol >= radius) return 1;
  // Max central angle whose chord deviates from the arc by <= tol.
  const maxStep = 2 * Math.acos(clampUnit(1 - safeTol / radius));
  if (!Number.isFinite(maxStep) || maxStep <= EPSILON) return 1;
  return Math.max(1, Math.ceil(sweep / maxStep));
}

/**
 * Samples the centerline into a polyline whose chords stay within `tolMm` of the
 * true arcs. Used for hit-testing, length readouts, and as the bridge to a 3D
 * curve. Returns the route start followed by each segment's points.
 */
export function toPolyline(centerline: PipeCenterline, tolMm = 0.5): Point2D[] {
  const { start, segments } = centerline;
  const out: Point2D[] = [{ x: start.x, y: start.y }];
  for (const seg of segments) {
    if (seg.type === 'line') {
      out.push({ x: seg.b.x, y: seg.b.y });
      continue;
    }
    const sweep = signedDelta(seg.startAngle, seg.endAngle);
    const steps = arcSteps(seg.radius, Math.abs(sweep), tolMm);
    for (let s = 1; s <= steps; s += 1) {
      const a = seg.startAngle + (sweep * s) / steps;
      out.push({
        x: seg.center.x + seg.radius * Math.cos(a),
        y: seg.center.y + seg.radius * Math.sin(a),
      });
    }
  }
  return out;
}

/** Convenience: the canonical centerline for a uniform-diameter route. */
export function buildPipeCenterlineFromDiameter(
  routePoints: Point2D[],
  diameterMm: number,
  bendRadiusFactor: number,
): PipeCenterline {
  const radius = Math.max(0, diameterMm) * Math.max(0, bendRadiusFactor);
  return buildPipeCenterline(routePoints, radius);
}
