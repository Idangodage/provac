/**
 * Centerline geometry as an exact sequence of LINE and ARC segments (world mm).
 * This is the single source of truth a filleted spine produces and everything
 * downstream (offset, sampling, tube body, hit-test) consumes. Pure functions.
 */

import type { Point } from '../model/types';

export type { Point };

export interface LineSeg {
  kind: 'line';
  a: Point;
  b: Point;
}
export interface ArcSeg {
  kind: 'arc';
  center: Point;
  radius: number;
  /** Start / end angles (rad). Swept from a0→a1 in the `ccw` sense. */
  a0: number;
  a1: number;
  ccw: boolean;
}
export type Seg = LineSeg | ArcSeg;
export type Path = Seg[];

// --- tiny vector helpers -------------------------------------------------
export const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
export const mul = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
export const len = (a: Point): number => Math.hypot(a.x, a.y);
export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
export const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
export const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x;
export const norm = (a: Point): Point => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
/** Left-hand normal of a direction (90° CCW). */
export const perpLeft = (d: Point): Point => ({ x: -d.y, y: d.x });

export function arcPoint(s: ArcSeg, t: number): Point {
  const ang = s.a0 + (s.a1 - s.a0) * t;
  return { x: s.center.x + s.radius * Math.cos(ang), y: s.center.y + s.radius * Math.sin(ang) };
}

/** Unit tangent at parameter t along a segment (direction of travel). */
export function tangentAt(s: Seg, t: number): Point {
  if (s.kind === 'line') return norm(sub(s.b, s.a));
  const ang = s.a0 + (s.a1 - s.a0) * t;
  // d/dθ of (cos,sin) = (-sin,cos); flip if the sweep is negative (cw).
  const dir = s.a1 >= s.a0 ? 1 : -1;
  return norm({ x: -Math.sin(ang) * dir, y: Math.cos(ang) * dir });
}

export function segLength(s: Seg): number {
  if (s.kind === 'line') return dist(s.a, s.b);
  return Math.abs(s.a1 - s.a0) * s.radius;
}

export function segStart(s: Seg): Point {
  return s.kind === 'line' ? s.a : arcPoint(s, 0);
}
export function segEnd(s: Seg): Point {
  return s.kind === 'line' ? s.b : arcPoint(s, 1);
}

/** Flatten a segment to points [start..end] with chord error ≤ maxChordMm. */
export function sampleSeg(s: Seg, maxChordMm: number): Point[] {
  if (s.kind === 'line') return [s.a, s.b];
  const sweep = Math.abs(s.a1 - s.a0);
  // chord error e = r(1-cos(dθ/2)) ≤ maxChord  ->  dθ ≤ 2·acos(1 - maxChord/r)
  const ratio = Math.min(1, maxChordMm / Math.max(s.radius, 1e-6));
  const dTheta = ratio >= 1 ? sweep : 2 * Math.acos(1 - ratio);
  const steps = Math.max(2, Math.ceil(sweep / Math.max(dTheta, 1e-4)));
  const out: Point[] = [];
  for (let i = 0; i <= steps; i += 1) out.push(arcPoint(s, i / steps));
  return out;
}

/** Flatten a whole path to a de-duplicated polyline. */
export function samplePath(path: Path, maxChordMm: number): Point[] {
  const out: Point[] = [];
  for (const s of path) {
    const pts = sampleSeg(s, maxChordMm);
    for (const p of pts) {
      const last = out[out.length - 1];
      if (!last || dist(last, p) > 1e-6) out.push(p);
    }
  }
  return out;
}

export function pathLength(path: Path): number {
  return path.reduce((sum, s) => sum + segLength(s), 0);
}

/** Closest point on a spine polyline to p, with its segment index + parameter t. */
export function nearestPointOnSpine(
  spine: Point[],
  p: Point,
): { segIndex: number; t: number; point: Point; distMm: number } | null {
  if (spine.length < 2) return null;
  let best: { segIndex: number; t: number; point: Point; distMm: number } | null = null;
  for (let i = 0; i < spine.length - 1; i += 1) {
    const a = spine[i]!;
    const ab = sub(spine[i + 1]!, a);
    const l2 = dot(ab, ab);
    const tRaw = l2 > 1e-12 ? dot(sub(p, a), ab) / l2 : 0;
    const t = Math.min(1, Math.max(0, tRaw));
    const foot = { x: a.x + ab.x * t, y: a.y + ab.y * t };
    const d = dist(foot, p);
    if (!best || d < best.distMm) best = { segIndex: i, t, point: foot, distMm: d };
  }
  return best;
}
