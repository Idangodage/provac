/** Angle helpers — port of the reference `core/math/angle.ts`. Radians internally. */
const DEG = Math.PI / 180;

export const degToRad = (d: number): number => d * DEG;
export const radToDeg = (r: number): number => r / DEG;

/** Normalize to (−π, π]. */
export function normalizeAngle(a: number): number {
  let x = a % (Math.PI * 2);
  if (x <= -Math.PI) x += Math.PI * 2;
  if (x > Math.PI) x -= Math.PI * 2;
  return x;
}

/** Absolute smallest delta between two angles. */
export function angleDelta(a: number, b: number): number {
  return Math.abs(normalizeAngle(a - b));
}
