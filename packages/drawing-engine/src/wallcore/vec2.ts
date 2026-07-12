/**
 * 2D vector math over plain tuples (JSON-friendly, mm float64) — verbatim port
 * of the reference app's `core/math/vec2.ts` (D:\myWorks\Advance canvas board).
 * Headless: no three/fabric/react imports anywhere in `wallcore/`.
 */
export type Vec2 = readonly [number, number];

export const v2 = (x: number, y: number): Vec2 => [x, y];
export const add2 = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const scale2 = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const dot2 = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
/** 2D cross product (z of the 3D cross). */
export const cross2 = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
export const len2 = (a: Vec2): number => Math.hypot(a[0], a[1]);
export const dist2 = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const distSq2 = (a: Vec2, b: Vec2): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
export const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];
/** Left-hand perpendicular (rotate +90°). */
export const perp2 = (a: Vec2): Vec2 => [-a[1], a[0]];
export const neg2 = (a: Vec2): Vec2 => [-a[0], -a[1]];

export function norm2(a: Vec2): Vec2 {
  const l = len2(a);
  return l === 0 ? [0, 0] : [a[0] / l, a[1] / l];
}
export function rot2(a: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [a[0] * c - a[1] * s, a[0] * s + a[1] * c];
}
export const angleOf2 = (a: Vec2): number => Math.atan2(a[1], a[0]);
export const eq2 = (a: Vec2, b: Vec2, eps: number): boolean => distSq2(a, b) <= eps * eps;

/** Distance from point p to segment ab, plus the clamped parameter t along ab. */
export function pointSegment2(p: Vec2, a: Vec2, b: Vec2): { dist: number; t: number; closest: Vec2 } {
  const ab = sub2(b, a);
  const l2 = dot2(ab, ab);
  const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, dot2(sub2(p, a), ab) / l2));
  const closest = add2(a, scale2(ab, t));
  return { dist: dist2(p, closest), t, closest };
}

/**
 * Segment/segment intersection. Returns intersection point + params when the (infinite)
 * lines cross within both segments (inclusive with eps slack), else null.
 */
export function segSegIntersect2(
  a1: Vec2,
  a2: Vec2,
  b1: Vec2,
  b2: Vec2,
  eps = 1e-9,
): { p: Vec2; ta: number; tb: number } | null {
  const r = sub2(a2, a1);
  const s = sub2(b2, b1);
  const denom = cross2(r, s);
  if (Math.abs(denom) < eps) return null; // parallel or collinear — handled by overlap logic elsewhere
  const qp = sub2(b1, a1);
  const ta = cross2(qp, s) / denom;
  const tb = cross2(qp, r) / denom;
  if (ta < -eps || ta > 1 + eps || tb < -eps || tb > 1 + eps) return null;
  return { p: add2(a1, scale2(r, ta)), ta, tb };
}

/** Intersection of two infinite lines given as point+direction. Null when parallel. */
export function lineLineIntersect2(p1: Vec2, d1: Vec2, p2: Vec2, d2: Vec2, eps = 1e-9): Vec2 | null {
  const denom = cross2(d1, d2);
  if (Math.abs(denom) < eps) return null;
  const t = cross2(sub2(p2, p1), d2) / denom;
  return add2(p1, scale2(d1, t));
}
