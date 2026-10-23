/**
 * Flexible runouts (SMACNA §3.5–3.7, Figs 2-15, 3-9, 3-10): the flexible duct
 * between the end of a rigid run (or a spigot's collar and damper) and an air
 * terminal's spigot.
 *
 * Its centreline is a smooth 3D curve: a straight lead off each collar (the
 * duct "should extend straight for several inches from a connection before
 * bending", Fig. 3-9; 100 mm here, practice) and, between them, the duct bent
 * as a fitter bends it: straight, then arcs as large as the space allows, then
 * straight (see `flexCurve`). Bends are checked against one diameter (S3.24), the length
 * against the project maximum (institutional 1.5 m; S3.23 asks for the
 * minimum). Horizontal supports follow ASHRAE 2024 chapter 19 / ADC:
 * ≤ 1.2 m spacing, ≥ 40 mm saddles (rounded conservatively from 4 ft and
 * 1.5 in), and sag within 41.7 mm per metre of span. Connections count as
 * supports; a selected product's stricter installation instructions apply.
 */
import type { DuctPoint3 } from './ductTypes';

/** Galvanised hanger wire diameter used by the model and BOM (project practice). */
export const FLEX_HANGER_WIRE_DIAMETER_MM = 2.7;

export const FLEX_RULES = {
  /** S3.24: bend centreline radius ≥ 1 duct diameter. */
  minBendDiameters: 1,
  /** ASHRAE 2024 ch. 19 / ADC: horizontal spacing ≤ 4 ft; conservative metric value. */
  maxSupportSpacingMm: 1200,
  /** ASHRAE 2024 ch. 19 / ADC: maximum sag 1/2 in per ft (mm/m). */
  maxSagMmPerM: 41.7,
  /** ASHRAE 2024 ch. 19 / ADC: support width ≥ 1.5 in; conservative metric value. */
  minStrapWidthMm: 40,
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
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
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
  const area2 = norm(cross(sub(b, a), sub(c, a)));
  return area2 < 1e-9 ? Number.POSITIVE_INFINITY : (ab * bc * ca) / (2 * area2);
}

/** Tangent of half the angle between two unit vectors (0 when they point the same way). */
function tanHalfAngle(a: Vec3, b: Vec3): number {
  const sin = norm(cross(a, b));
  return sin < 1e-12 ? 0 : sin / (1 + dot(a, b));
}

/** A runout's samples with their stations, length and tightest bend (measured on the samples unless given). */
function geometry(points: Vec3[], minBendRadiusMm?: number, tightestAt?: Vec3): DuctFlexGeometry {
  const stations = [0];
  for (let index = 1; index < points.length; index += 1) stations.push(stations[index - 1]! + norm(sub(points[index]!, points[index - 1]!)));
  if (minBendRadiusMm === undefined) {
    // Measured on the samples: the tightest circle through three in a row.
    minBendRadiusMm = Number.POSITIVE_INFINITY;
    for (let index = 1; index + 1 < points.length; index += 1) {
      const radius = circumradius(points[index - 1]!, points[index]!, points[index + 1]!);
      if (radius < minBendRadiusMm) {
        minBendRadiusMm = radius;
        tightestAt = points[index]!;
      }
    }
  }
  return { points, stations, lengthMm: stations[stations.length - 1]!, minBendRadiusMm, tightestAt: tightestAt ?? points[0]! };
}

/** The runout drawn as one cubic Bezier between the leads, its handles 0.4 of the chord (the model before 23 October 2026). */
function bezierRunout(start: Vec3, d0: Vec3, end: Vec3, d1: Vec3, lead: number, samples: number): DuctFlexGeometry {
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
  return geometry(points);
}

/**
 * A runout bent as a fitter bends it, between the ends of its leads: the
 * polyline from `p0` through `corners` to `p3`, each corner rounded by an arc
 * of `radiusMm`.
 */
interface BendPath { corners: Vec3[]; radiusMm: number }

/** Arcs are drawn at 5° a sample at most. */
const ARC_STEP_RAD = Math.PI / 36;
/** The two-bend search: a grid over the corners' places, then a pattern search down to this step (mm). */
const SEARCH_GRID = 10;
const SEARCH_STEP_MM = 0.05;
/**
 * Bends within this share of the largest radius count as large as it: the
 * shortest runout among them is taken (the largest radius is often a plateau,
 * a drop or an offset fixing it while the corners can still slide).
 */
const RADIUS_SLACK = 0.005;

/**
 * A turn in one plane, the lead lines meeting ahead of both leads: one arc as
 * large as the shorter leg allows, the rest straight. The largest bend a turn
 * can have without swinging past either end.
 */
function singleBend(p0: Vec3, d0: Vec3, p3: Vec3, d1: Vec3): BendPath | null {
  const w = sub(p3, p0);
  const normal = cross(d0, d1);
  const sin = norm(normal);
  if (sin < 1e-9 || Math.abs(dot(w, normal)) / sin > 1e-6 * Math.max(1, norm(w))) return null;
  const c = dot(d0, d1);
  const s = (dot(w, d0) - c * dot(w, d1)) / (1 - c * c);
  const u = (dot(w, d1) - c * dot(w, d0)) / (1 - c * c);
  if (s < -1e-6 || u < -1e-6) return null;
  return { corners: [add(p0, scale(d0, Math.max(0, s)))], radiusMm: Math.max(0, Math.min(s, u)) / tanHalfAngle(d0, d1) };
}

/**
 * Leads parallel and offset: two equal arcs (an S), each turning
 * 2·atan(offset / run) and so as large as the offset allows; past 90° each
 * turns 90° with a straight across between them. Straight ahead when in line.
 */
function offsetBends(p0: Vec3, d: Vec3, p3: Vec3): BendPath | null {
  const w = sub(p3, p0);
  const run = dot(w, d);
  if (run <= 1e-6) return null;
  const offset = norm(sub(w, scale(d, run)));
  if (offset < 1e-9) return { corners: [], radiusMm: Number.POSITIVE_INFINITY };
  const turn = 2 * Math.atan2(offset, run);
  const radiusMm = turn < Math.PI / 2 ? run / (2 * Math.sin(turn)) : run / 2;
  const tangent = turn < Math.PI / 2 ? radiusMm * Math.tan(turn / 2) : radiusMm;
  return { corners: [add(p0, scale(d, tangent)), sub(p3, scale(d, tangent))], radiusMm };
}

/** Two bends placed at `s` along the first lead and `u` back along the second: the largest equal radius and the runout's length then. */
interface TwoBendFit { s: number; u: number; radiusMm: number; lengthMm: number }

/**
 * Two bends at `p0 + s·d0` and `p3 − u·d1`, the straight between them heading
 * on (not back against either lead): the largest equal radius they take, and
 * the length of the runout between the leads (each bend takes its two
 * tangent lengths off the polyline and adds its arc). Null where the straight
 * would head back.
 */
function twoBendFit(p0: Vec3, d0: Vec3, p3: Vec3, d1: Vec3, s: number, u: number): TwoBendFit | null {
  if (s < 0 || u < 0) return null;
  const between = sub(sub(p3, scale(d1, u)), add(p0, scale(d0, s)));
  const length = norm(between);
  if (length < 1e-9) return null;
  const m = scale(between, 1 / length);
  if (dot(m, d0) < -1e-9 || dot(m, d1) < -1e-9) return null;
  const t1 = tanHalfAngle(d0, m);
  const t2 = tanHalfAngle(m, d1);
  let radiusMm = Number.POSITIVE_INFINITY;
  if (t1 > 0) radiusMm = Math.min(radiusMm, s / t1);
  if (t2 > 0) radiusMm = Math.min(radiusMm, u / t2);
  if (t1 + t2 > 0) radiusMm = Math.min(radiusMm, length / (t1 + t2));
  const lengthMm = s + length + u + (Number.isFinite(radiusMm) ? radiusMm * (2 * Math.atan(t1) + 2 * Math.atan(t2) - 2 * (t1 + t2)) : 0);
  return { s, u, radiusMm, lengthMm };
}

/**
 * Any other runout (a turn with a drop, a top collar off to one side, a turn
 * whose lead lines meet behind one end): a bend off each lead with a straight
 * between, placed for the largest radius, and the shortest runout among bends
 * within 0.5% of it. Null where the duct would have to head back to reach the
 * spigot.
 */
function twoBends(p0: Vec3, d0: Vec3, p3: Vec3, d1: Vec3): BendPath | null {
  const w = sub(p3, p0);
  if (norm(w) < 1e-6) return null;
  // The straight between the bends heads on: with the leads turning 90° at most, s ≤ w·d0 and u ≤ w·d1.
  const sMax = dot(w, d0);
  const uMax = dot(w, d1);
  if (sMax < 0 || uMax < 0) return null;
  const fit = (s: number, u: number) => twoBendFit(p0, d0, p3, d1, s, u);
  // A pattern search from `from`, taking a neighbour wherever `better` says so, its step halving down to the last.
  const climb = (from: TwoBendFit, better: (candidate: TwoBendFit, current: TwoBendFit) => boolean): TwoBendFit => {
    let current = from;
    for (let step = Math.max(sMax, uMax) / SEARCH_GRID; step > SEARCH_STEP_MM;) {
      let moved = false;
      for (const [ds, du] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
        const candidate = fit(current.s + ds * step, current.u + du * step);
        if (candidate && better(candidate, current)) [current, moved] = [candidate, true];
      }
      if (!moved) step /= 2;
    }
    return current;
  };
  const grid: TwoBendFit[] = [];
  for (let i = 0; i <= SEARCH_GRID; i += 1) {
    for (let j = 0; j <= SEARCH_GRID; j += 1) {
      const point = fit((sMax * i) / SEARCH_GRID, (uMax * j) / SEARCH_GRID);
      if (point) grid.push(point);
    }
  }
  const start = grid.reduce<TwoBendFit | null>((best, point) => (!best || point.radiusMm > best.radiusMm ? point : best), null);
  if (!start || !(start.radiusMm > 0)) return null;
  // The largest radius first …
  const largest = climb(start, (candidate, current) => candidate.radiusMm > current.radiusMm + 1e-9);
  if (!Number.isFinite(largest.radiusMm)) return { corners: [], radiusMm: Number.POSITIVE_INFINITY };
  // … then, among bends as large within the slack, the shortest runout.
  const floor = largest.radiusMm * (1 - RADIUS_SLACK);
  const shortest = climb(
    grid.filter((point) => point.radiusMm >= floor).reduce((best, point) => (point.lengthMm < best.lengthMm ? point : best), largest),
    (candidate, current) => candidate.radiusMm >= floor && candidate.lengthMm < current.lengthMm - 1e-9,
  );
  return { corners: [add(p0, scale(d0, shortest.s)), sub(p3, scale(d1, shortest.u))], radiusMm: shortest.radiusMm };
}

/** The runout along a bend path: straights and arcs sampled about every `stepMm`, the arcs at 5° at most. */
function bendRunout(start: Vec3, p0: Vec3, path: BendPath, p3: Vec3, end: Vec3, stepMm: number): DuctFlexGeometry {
  const polyline = [p0, ...path.corners, p3];
  const points: Vec3[] = [start, p0];
  let from = p0;
  let tightestAt = p0;
  let widestTurn = -1;
  const straightTo = (to: Vec3) => {
    const length = norm(sub(to, from));
    // A straight shorter than this is the float noise of an arc meeting its lead: no point of its own.
    if (length < 0.01) return;
    const count = Math.max(1, Math.ceil(length / stepMm - 1e-9));
    for (let index = 1; index <= count; index += 1) points.push(index === count ? to : add(from, scale(sub(to, from), index / count)));
  };
  for (let index = 1; index + 1 < polyline.length; index += 1) {
    const a = unit3(sub(polyline[index]!, polyline[index - 1]!));
    const b = unit3(sub(polyline[index + 1]!, polyline[index]!));
    const tanHalf = tanHalfAngle(a, b);
    if (tanHalf === 0 || !Number.isFinite(path.radiusMm)) continue;
    const cos = Math.max(-1, Math.min(1, dot(a, b)));
    const turn = Math.acos(cos);
    const tangent = path.radiusMm * tanHalf;
    const arcStart = sub(polyline[index]!, scale(a, tangent));
    const inward = unit3(sub(b, scale(a, cos)));
    const centre = add(arcStart, scale(inward, path.radiusMm));
    const at = (angle: number) => add(sub(centre, scale(inward, path.radiusMm * Math.cos(angle))), scale(a, path.radiusMm * Math.sin(angle)));
    straightTo(arcStart);
    const count = Math.max(2, Math.ceil((path.radiusMm * turn) / stepMm - 1e-9), Math.ceil(turn / ARC_STEP_RAD - 1e-9));
    for (let step = 1; step <= count; step += 1) points.push(at((turn * step) / count));
    if (turn > widestTurn) [widestTurn, tightestAt] = [turn, at(turn / 2)];
    from = points[points.length - 1]!;
  }
  straightTo(p3);
  // The last sample is the lead's end exactly (an arc ending on it lands within float noise).
  if (points.length > 2) points[points.length - 1] = p3;
  else points.push(p3);
  points.push(end);
  return geometry(points, path.radiusMm, tightestAt);
}

/** Runouts already worked out, by their ends, directions and options: Auto duct fits the same ones many times over. */
const RUNOUTS = new Map<string, DuctFlexGeometry>();
/** At most this many are kept, the oldest going first. */
const RUNOUTS_KEPT = 4096;

/**
 * The runout from `start` (leaving along `startDirection`) to `end` (arriving
 * along `endDirection`, i.e. into the spigot): straight for the lead off each
 * collar, then bent as a fitter bends it, with bends as large as the space
 * allows:
 * - a turn in one plane (the lead lines meet ahead of both): one arc as large
 *   as the shorter leg allows, the rest straight; in the plane of the turn, so
 *   a top collar straight ahead of its duct too;
 * - leads parallel and offset: two equal arcs (an S);
 * - otherwise (a turn with a drop, a top collar off to one side): a bend off
 *   each lead with a straight between, placed for the largest radius.
 * Bent so, the runout heads on toward the spigot all the way: it never passes
 * the spigot's face, so never into its terminal's box. A runout turning more
 * than 90° (its spigot facing away) would have to, round the back of the box:
 * it keeps the earlier model's curve (one cubic Bezier between the leads), as
 * does any runout that curve bends more gently, so none bends tighter than it
 * did before 23 October 2026; on an equal bend, the shorter.
 *
 * The result is shared with every caller asking for the same runout, so it is
 * frozen: read it, do not change it.
 */
export function flexCurve(
  start: Vec3,
  startDirection: Vec3,
  end: Vec3,
  endDirection: Vec3,
  options: { leadMm?: number; samples?: number } = {},
): DuctFlexGeometry {
  const key = `${start.x},${start.y},${start.z},${startDirection.x},${startDirection.y},${startDirection.z},${end.x},${end.y},${end.z},${endDirection.x},${endDirection.y},${endDirection.z},${options.leadMm ?? ''},${options.samples ?? ''}`;
  const kept = RUNOUTS.get(key);
  if (kept) return kept;
  const curve = runoutBetween(start, startDirection, end, endDirection, options);
  Object.freeze(curve.points);
  Object.freeze(curve.stations);
  Object.freeze(curve);
  if (RUNOUTS.size >= RUNOUTS_KEPT) RUNOUTS.delete(RUNOUTS.keys().next().value!);
  RUNOUTS.set(key, curve);
  return curve;
}

function runoutBetween(start: Vec3, startDirection: Vec3, end: Vec3, endDirection: Vec3, options: { leadMm?: number; samples?: number }): DuctFlexGeometry {
  const lead = options.leadMm ?? FLEX_STRAIGHT_LEAD_MM;
  const samples = options.samples ?? 32;
  const d0 = unit3(startDirection);
  const d1 = unit3(endDirection);
  const bezier = bezierRunout(start, d0, end, d1, lead, samples);
  const p0 = add(start, scale(d0, lead));
  const p3 = sub(end, scale(d1, lead));
  if (norm(sub(p3, p0)) < 0.01 || dot(d0, d1) < -1e-9) return bezier;
  const path = norm(cross(d0, d1)) < 1e-9 ? offsetBends(p0, d0, p3) : singleBend(p0, d0, p3, d1) ?? twoBends(p0, d0, p3, d1);
  if (!path || !(path.radiusMm > 0)) return bezier;
  const polylineMm = [p0, ...path.corners, p3].reduce((sum, point, index, all) => (index ? sum + norm(sub(point, all[index - 1]!)) : 0), 0);
  const bent = bendRunout(start, p0, path, p3, end, Math.max(5, polylineMm / samples));
  const tie = bent.minBendRadiusMm === bezier.minBendRadiusMm
    || Math.abs(bent.minBendRadiusMm - bezier.minBendRadiusMm) <= 1e-9 * bezier.minBendRadiusMm;
  if (tie) return bent.lengthMm < bezier.lengthMm ? bent : bezier;
  return bent.minBendRadiusMm > bezier.minBendRadiusMm ? bent : bezier;
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
 * between them that keep every span within the horizontal spacing limit.
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
