/**
 * Flexible runouts (SMACNA §3.5–3.7, Figs 2-15, 3-9, 3-10): the flexible duct
 * between the end of a rigid run (or a spigot's collar and damper) and an air
 * terminal's spigot.
 *
 * Its centreline is a smooth 3D curve: a straight lead off each collar (the
 * duct "should extend straight for several inches from a connection before
 * bending", Fig. 3-9; 100 mm here, practice) and a cubic Bezier between them,
 * tangent to both. Bends are checked against one diameter (S3.24), the length
 * against the project maximum (institutional 1.5 m; S3.23 asks for the
 * minimum), supports placed at ≤ 1.5 m along it with the connections counting
 * as supports (S3.35), and the sag drawn within 41.7 mm per metre of span.
 */
import type { DuctPoint3 } from './ductTypes';

export const FLEX_RULES = {
  /** S3.24: bend centreline radius ≥ 1 duct diameter. */
  minBendDiameters: 1,
  /** S3.35: supports at least every 1.5 m (mm). */
  maxSupportSpacingMm: 1500,
  /** S3.35: maximum sag per metre of support spacing (mm/m). */
  maxSagMmPerM: 41.7,
  /** S3.36: hanger or saddle at least this wide (mm). */
  minStrapWidthMm: 25,
  /** S3.30 / S3.31: collar length and insertion (mm). */
  minCollarMm: 51,
  minInsertionMm: 25,
  /** Fig. 2-15: add supports where the drop to a terminal exceeds this (mm). */
  terminalDropSupportMm: 910,
} as const;

/** Straight lead off each collar before the flex bends (mm). Practice for "several inches" (Fig. 3-9). */
export const FLEX_STRAIGHT_LEAD_MM = 100;

type Vec3 = DuctPoint3;

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const norm = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const unit3 = (a: Vec3): Vec3 => {
  const length = norm(a);
  return length < 1e-9 ? { x: 1, y: 0, z: 0 } : scale(a, 1 / length);
};

export interface DuctFlexGeometry {
  /** Centreline samples (z = centre), from the rigid end to the terminal spigot. */
  points: Vec3[];
  /** Arc length at each sample (mm). */
  stations: number[];
  lengthMm: number;
  /** Tightest bend along the curve (mm; Infinity when straight). */
  minBendRadiusMm: number;
  /** Where along the curve the tightest bend is. */
  tightestAt: Vec3;
}

/** Radius of the circle through three points (Infinity when collinear). */
function circumradius(a: Vec3, b: Vec3, c: Vec3): number {
  const ab = norm(sub(b, a));
  const bc = norm(sub(c, b));
  const ca = norm(sub(a, c));
  const u = sub(b, a);
  const v = sub(c, a);
  const cross = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x };
  const area2 = norm(cross);
  return area2 < 1e-9 ? Number.POSITIVE_INFINITY : (ab * bc * ca) / (2 * area2);
}

/**
 * The runout from `start` (leaving along `startDirection`) to `end` (arriving
 * along `endDirection`, i.e. into the spigot).
 */
export function flexCurve(
  start: Vec3,
  startDirection: Vec3,
  end: Vec3,
  endDirection: Vec3,
  options: { leadMm?: number; samples?: number } = {},
): DuctFlexGeometry {
  const lead = options.leadMm ?? FLEX_STRAIGHT_LEAD_MM;
  const samples = options.samples ?? 32;
  const d0 = unit3(startDirection);
  const d1 = unit3(endDirection);
  const p0 = add(start, scale(d0, lead));
  const p3 = sub(end, scale(d1, lead));
  const handle = Math.max(1, 0.4 * norm(sub(p3, p0)));
  const p1 = add(p0, scale(d0, handle));
  const p2 = sub(p3, scale(d1, handle));
  const points: Vec3[] = [start];
  for (let index = 0; index <= samples; index += 1) {
    const t = index / samples;
    const u = 1 - t;
    points.push(add(add(scale(p0, u * u * u), scale(p1, 3 * u * u * t)), add(scale(p2, 3 * u * t * t), scale(p3, t * t * t))));
  }
  points.push(end);
  const stations = [0];
  for (let index = 1; index < points.length; index += 1) stations.push(stations[index - 1]! + norm(sub(points[index]!, points[index - 1]!)));
  let minBendRadiusMm = Number.POSITIVE_INFINITY;
  let tightestAt = points[0]!;
  for (let index = 1; index + 1 < points.length; index += 1) {
    const radius = circumradius(points[index - 1]!, points[index]!, points[index + 1]!);
    if (radius < minBendRadiusMm) {
      minBendRadiusMm = radius;
      tightestAt = points[index]!;
    }
  }
  return { points, stations, lengthMm: stations[stations.length - 1]!, minBendRadiusMm, tightestAt };
}

/** The point at arc length `station` along the curve. */
export function flexPointAt(flex: Pick<DuctFlexGeometry, 'points' | 'stations'>, station: number): Vec3 {
  const { points, stations } = flex;
  if (station <= 0) return points[0]!;
  for (let index = 1; index < points.length; index += 1) {
    if (stations[index]! >= station) {
      const span = stations[index]! - stations[index - 1]!;
      const t = span > 1e-9 ? (station - stations[index - 1]!) / span : 0;
      return add(points[index - 1]!, scale(sub(points[index]!, points[index - 1]!), t));
    }
  }
  return points[points.length - 1]!;
}

/**
 * Supports along the runout: the two connections count, so only the stations
 * between them that keep every span within the spacing (S3.35).
 */
export function flexSupportStations(lengthMm: number, spacingMm: number = FLEX_RULES.maxSupportSpacingMm): number[] {
  const spans = Math.max(1, Math.ceil(lengthMm / spacingMm - 1e-9));
  return Array.from({ length: spans - 1 }, (_, index) => (lengthMm * (index + 1)) / spans);
}

/**
 * The runout as installed: sagging between its supports by half the allowed
 * 41.7 mm per metre (drawn, not a check: the supports keep it within the limit).
 */
export function saggedFlexPoints(flex: Pick<DuctFlexGeometry, 'points' | 'stations' | 'lengthMm'>, supportStations: readonly number[]): Vec3[] {
  const fixed = [0, ...supportStations, flex.lengthMm];
  return flex.points.map((point, index) => {
    const station = flex.stations[index]!;
    const span = fixed.findIndex((value, k) => k > 0 && station <= value + 1e-6);
    if (span <= 0) return point;
    const a = fixed[span - 1]!;
    const b = fixed[span]!;
    const length = b - a;
    if (length < 1) return point;
    const s = (station - a) / length;
    const sag = 0.5 * FLEX_RULES.maxSagMmPerM * (length / 1000) * 4 * s * (1 - s);
    return { ...point, z: point.z - sag };
  });
}
