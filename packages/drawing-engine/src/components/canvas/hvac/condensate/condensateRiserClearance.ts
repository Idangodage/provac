import type { Point2D } from '../../../../types';

import type { Point3 } from './condensateTypes';

const EPS = 1e-12;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const sub = (a: Point3, b: Point3): Point3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Point3, b: Point3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Analytical closest distance between two finite segments, including risers and points. */
export function condensateSegmentDistance(a: Point3, b: Point3, c: Point3, d: Point3): number {
  const u = sub(b, a); const v = sub(d, c); const w = sub(a, c);
  const uu = dot(u, u); const vv = dot(v, v); const uv = dot(u, v);
  const uw = dot(u, w); const vw = dot(v, w);
  let s = 0; let t = 0;
  if (uu <= EPS) t = vv <= EPS ? 0 : clamp(vw / vv);
  else if (vv <= EPS) s = clamp(-uw / uu);
  else {
    const determinant = uu * vv - uv * uv;
    s = determinant > EPS * uu * vv ? clamp((uv * vw - uw * vv) / determinant) : 0;
    t = (uv * s + vw) / vv;
    if (t < 0) { t = 0; s = clamp(-uw / uu); }
    else if (t > 1) { t = 1; s = clamp((uv - uw) / uu); }
  }
  return Math.hypot(w.x + s * u.x - t * v.x, w.y + s * u.y - t * v.y, w.z + s * u.z - t * v.z);
}

/**
 * Highest collision-free vertical riser endpoint. Expanding a fixed-start
 * segment can only decrease its distance to a service capsule, so bisection
 * finds the first contact without length-dependent sampling or missed gaps.
 */
export function riserTopBelowPipe(
  foot: Point2D, baseZ: number, topZ: number, serviceStart: Point3, serviceEnd: Point3, requiredDistanceMm: number,
): number | null {
  const start = { ...foot, z: baseZ };
  const distanceAt = (z: number) => condensateSegmentDistance(start, { ...foot, z }, serviceStart, serviceEnd);
  if (distanceAt(topZ) >= requiredDistanceMm) return topZ;
  if (distanceAt(baseZ) < requiredDistanceMm) return null;
  let clear = baseZ;
  let blocked = topZ;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const mid = (clear + blocked) / 2;
    if (distanceAt(mid) < requiredDistanceMm) blocked = mid;
    else clear = mid;
  }
  return clear;
}
