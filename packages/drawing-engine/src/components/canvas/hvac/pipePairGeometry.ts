/**
 * VRF refrigerant pipe-pair geometry (T2 / "how the pipe should be visible").
 *
 * A single drawn centerline becomes the visible gas + liquid PAIR by offsetting
 * the canonical arc-spline centerline (see {@link ./pipeCenterline}) to either
 * side. Because the offset is taken perpendicular to each leg and the arc centre
 * is shared, the two pipes turn through **concentric** elbows — the correct
 * fitting geometry for a VRF bundle (inner pipe radius = R - gap/2, outer =
 * R + gap/2), not two independently-rounded sharp corners.
 *
 * Pure and engine-free: emits SVG path data consumable by `fabric.Path`,
 * `Konva.Path`, or any SVG renderer, so the 2D plan, the Konva edit overlay, and
 * a future SVG export all draw the identical pair from one source.
 */

import type { Point2D } from '../../../types';

import {
  buildPipeCenterline,
  toSvgPathData,
  type BendRadius,
  type CenterlineSegment,
  type PipeCenterline,
} from './pipeCenterline';

const EPSILON = 1e-6;

function sub(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}
function add(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}
function mul(v: Point2D, s: number): Point2D {
  return { x: v.x * s, y: v.y * s };
}
function len(v: Point2D): number {
  return Math.hypot(v.x, v.y);
}
function normalizeOr(v: Point2D, fallback: Point2D): Point2D {
  const l = len(v);
  return l < EPSILON ? fallback : { x: v.x / l, y: v.y / l };
}
/** Left-hand normal of a direction (perpendicular, +90deg in screen space). */
function leftNormal(dir: Point2D): Point2D {
  return { x: -dir.y, y: dir.x };
}

/**
 * Offsets a centerline by a signed perpendicular distance (mm). Positive and
 * negative offsets give the two pipes of a bundle. Straight segments shift by
 * the leg normal; arcs keep the same centre and shift their tangent points along
 * each leg normal, so the result is concentric with the centerline arc.
 */
export function offsetCenterline(centerline: PipeCenterline, offsetMm: number): PipeCenterline {
  const segments: CenterlineSegment[] = centerline.segments.map((seg) => {
    if (seg.type === 'line') {
      const dir = normalizeOr(sub(seg.b, seg.a), { x: 1, y: 0 });
      const n = leftNormal(dir);
      return { type: 'line', a: add(seg.a, mul(n, offsetMm)), b: add(seg.b, mul(n, offsetMm)) };
    }
    const n1 = leftNormal(seg.inDir);
    const n2 = leftNormal(seg.outDir);
    const start = add(seg.start, mul(n1, offsetMm));
    const end = add(seg.end, mul(n2, offsetMm));
    const radius = len(sub(seg.center, start));
    return {
      type: 'arc',
      center: seg.center,
      radius,
      start,
      end,
      startAngle: Math.atan2(start.y - seg.center.y, start.x - seg.center.x),
      endAngle: Math.atan2(end.y - seg.center.y, end.x - seg.center.x),
      anticlockwise: seg.anticlockwise,
      sweepFlag: seg.sweepFlag,
      inDir: seg.inDir,
      outDir: seg.outDir,
    };
  });

  let start = centerline.start;
  const first = segments[0];
  if (first) {
    start = first.type === 'line' ? first.a : first.start;
  }
  return { start, segments };
}

export interface PipePairOptions {
  /** Elbow centerline radius (mm). One value, or one per interior corner. */
  bendRadiusMm: BendRadius;
  /** Centre-to-centre distance between the gas and liquid pipes (mm). */
  gapMm: number;
}

export interface PipePair {
  /** The shared centerline arc-spline both pipes derive from. */
  centerline: PipeCenterline;
  /** Gas pipe (offset +gap/2) centerline. */
  gas: PipeCenterline;
  /** Liquid pipe (offset -gap/2) centerline. */
  liquid: PipeCenterline;
  /** SVG path data (true `A` arcs) for each, ready for fabric/Konva `Path`. */
  gasPath: string;
  liquidPath: string;
  centerlinePath: string;
}

/**
 * Builds the visible VRF pair (gas + liquid + shared centerline) for a route.
 * Both pipes turn through concentric arc elbows of the given bend radius.
 */
export function buildPipePair(routePoints: Point2D[], options: PipePairOptions): PipePair {
  const centerline = buildPipeCenterline(routePoints, options.bendRadiusMm);
  const half = Math.max(0, options.gapMm) / 2;
  const gas = offsetCenterline(centerline, half);
  const liquid = offsetCenterline(centerline, -half);
  return {
    centerline,
    gas,
    liquid,
    gasPath: toSvgPathData(gas),
    liquidPath: toSvgPathData(liquid),
    centerlinePath: toSvgPathData(centerline),
  };
}
