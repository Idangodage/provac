/**
 * A condensate drain run's pieces as its segment card shows them, in flow order:
 *  - the unit connection (`start`): the unit's flexible drain hose (pumped) or
 *    its outlet stub, from the drain socket to the riser foot, with its trap;
 *  - the riser (`riser`): a pumped unit's lift, straight up from the foot;
 *  - the legs (`leg:n`): the straight falls between plan bends, their 45°
 *    level changes (and a branch's crown step into its main) included;
 *  - the bends (`bend:n`): the plan bends (90° and 45° elbows);
 *  - how the run ends (`end`): a wye into a main from the top, a joint the run
 *    continues through, or the head of the drop;
 *  - a drop's or a wall outlet's run as a whole (`termination`);
 *  - its rodding eyes (`eye:n`), air vents (`vent:n`) and wall sleeves
 *    (`sleeve:n`).
 *
 * Every piece has its own centreline (a leg's trimmed where its bends take
 * over; a fitting's a short stretch of the run through it) for outlines and
 * picking, and its centre-to-centre length for the figures. Keys are ordinals
 * along the run: a re-solved network keeps them while its shape holds, and a
 * card re-keys by kind and ordinal after its own edits.
 *
 * PURE: elements in, pieces out (cached per element).
 */
import type { HvacElement, Point2D } from '../../../../types';
import type { SegmentFocus } from '../segments/segmentUiStore';

import {
  condensateInsulatedRadiusMm,
  isCondensatePipe,
  readCondensatePipeSpec,
  type CondensateFitting,
  type CondensatePipeSpec,
  type CondensateSegmentRole,
  type Point3,
} from './condensateTypes';

export type CondensatePieceKind = 'connection' | 'riser' | 'leg' | 'bend' | 'end' | 'termination' | 'eye' | 'vent' | 'sleeve';

export interface CondensatePiece {
  key: string;
  kind: CondensatePieceKind;
  /** 1-based among the run's pieces of its kind, in flow order. */
  ordinal: number;
  /** Its centreline, in the direction of flow (a fitting's: a short stretch of the run through it). */
  path: Point3[];
  /** A fitting's point, a junction's, a riser's foot; null for a stretch of pipe. */
  point: Point3 | null;
  /** Where it starts and stops, centre to centre: a leg's bend centres, a riser's foot and top (a fitting: its point). */
  from: Point3;
  to: Point3;
  /** Centre to centre (mm): a leg's from bend to bend, a riser's height, the hose's or stub's length. */
  lengthMm: number;
  /** Its length in plan, centre to centre (mm). */
  planLengthMm: number;
  /** How far along the run's centreline it starts (mm): the flow order. */
  stationMm: number;
  /** Its drop from start to end, centre to centre (mm; + falls with the flow). */
  fallMm: number;
  /** A bend's plan angle (deg); else null. */
  angleDeg: number | null;
  /** The fittings that are part of it: its elbows, a unit's trap, the wye, the tundish. */
  fittings: CondensateFitting[];
}

export interface CondensateRun {
  elementId: string;
  spec: CondensatePipeSpec;
  role: CondensateSegmentRole;
  /** The run's centreline as generated: risers, 45° offsets, crown steps. */
  nodes: Point3[];
  /** Its insulated outside radius (mm). */
  radiusMm: number;
  pieces: CondensatePiece[];
}

const PLAN_EPS_MM = 0.5;
const BEND_MIN_DEG = 1;

const sub = (a: Point3, b: Point3): Point3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Point3, b: Point3): Point3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: Point3, s: number): Point3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a: Point3, b: Point3) => a.x * b.x + a.y * b.y + a.z * b.z;
const length3 = (a: Point3) => Math.hypot(a.x, a.y, a.z);
const distance3 = (a: Point3, b: Point3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const planDistance = (a: Point2D, b: Point2D) => Math.hypot(a.x - b.x, a.y - b.y);
const xy = (point: Point3): Point2D => ({ x: point.x, y: point.y });
const isVertical = (a: Point3, b: Point3) => planDistance(a, b) < PLAN_EPS_MM;

function pathLength(path: readonly Point3[]): number {
  let total = 0;
  for (let index = 1; index < path.length; index += 1) total += distance3(path[index - 1]!, path[index]!);
  return total;
}

function planLength(path: readonly Point3[]): number {
  let total = 0;
  for (let index = 1; index < path.length; index += 1) total += planDistance(path[index - 1]!, path[index]!);
  return total;
}

/** The point `distanceMm` along a polyline from its start (clamped to it). */
function pointAlong(path: readonly Point3[], distanceMm: number): Point3 {
  let walked = 0;
  for (let index = 1; index < path.length; index += 1) {
    const a = path[index - 1]!;
    const b = path[index]!;
    const span = distance3(a, b);
    if (walked + span >= distanceMm && span > 1e-9) return add(a, scale(sub(b, a), Math.max(0, distanceMm - walked) / span));
    walked += span;
  }
  return { ...path[path.length - 1]! };
}

/** The stretch of a polyline between two distances along it. */
function slice(path: readonly Point3[], from: number, to: number): Point3[] {
  const total = pathLength(path);
  const start = Math.max(0, Math.min(from, total));
  const end = Math.max(start, Math.min(to, total));
  const out: Point3[] = [pointAlong(path, start)];
  let walked = 0;
  for (let index = 1; index < path.length; index += 1) {
    walked += distance3(path[index - 1]!, path[index]!);
    if (walked > start + 1e-6 && walked < end - 1e-6) out.push({ ...path[index]! });
  }
  out.push(pointAlong(path, end));
  return out;
}

/** Where a point lies along a polyline: the distance to its nearest point, and that point. */
function project(path: readonly Point3[], point: Point3): { stationMm: number; on: Point3; distanceMm: number } {
  let best = { stationMm: 0, on: { ...path[0]! }, distanceMm: Infinity };
  let walked = 0;
  for (let index = 1; index < path.length; index += 1) {
    const a = path[index - 1]!;
    const ab = sub(path[index]!, a);
    const squared = dot(ab, ab);
    const t = squared > 1e-9 ? Math.max(0, Math.min(1, dot(sub(point, a), ab) / squared)) : 0;
    const on = add(a, scale(ab, t));
    const d = distance3(point, on);
    if (d < best.distanceMm) best = { stationMm: walked + Math.sqrt(squared) * t, on, distanceMm: d };
    walked += Math.sqrt(squared);
  }
  return best;
}

const planHeading = (a: Point3, b: Point3): Point2D => {
  const d = planDistance(a, b) || 1;
  return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
};
const turnDeg = (from: Point2D, to: Point2D) => (Math.acos(Math.max(-1, Math.min(1, from.x * to.x + from.y * to.y))) * 180) / Math.PI;

type Draft = Omit<CondensatePiece, 'ordinal' | 'key'> & { key?: string };

const RUN_CACHE = new WeakMap<HvacElement, CondensateRun | null>();

/** A condensate pipe's pieces (null for anything else, or a run with no route). */
export function condensateRunOf(element: HvacElement): CondensateRun | null {
  if (RUN_CACHE.has(element)) return RUN_CACHE.get(element)!;
  const run = buildRun(element);
  RUN_CACHE.set(element, run);
  return run;
}

function buildRun(element: HvacElement): CondensateRun | null {
  if (!isCondensatePipe(element)) return null;
  const spec = readCondensatePipeSpec(element);
  const nodes = spec.routeNodes3d.length >= 2 ? spec.routeNodes3d : spec.routePoints.map((point) => ({ ...point, z: element.elevation }));
  if (nodes.length < 2) return null;
  const radiusMm = condensateInsulatedRadiusMm(spec);
  const stations = [0];
  for (let index = 1; index < nodes.length; index += 1) stations.push(stations[index - 1]! + distance3(nodes[index - 1]!, nodes[index]!));
  const total = stations[stations.length - 1]!;
  const drafts: Draft[] = [];
  const stretch = (kind: CondensatePieceKind, from: number, to: number, extra: Partial<Draft> = {}): Draft => {
    const path = nodes.slice(from, to + 1).map((node) => ({ ...node }));
    return {
      kind, path, point: null, from: { ...nodes[from]! }, to: { ...nodes[to]! }, lengthMm: pathLength(path), planLengthMm: planLength(path),
      stationMm: stations[from]!, fallMm: nodes[from]!.z - nodes[to]!.z, angleDeg: null, fittings: [], ...extra,
    };
  };

  // ---- A drop, a stack branch or a wall outlet: one piece, its whole run.
  if (spec.segmentRole === 'drop' || spec.segmentRole === 'terminal') {
    drafts.push({ ...stretch('termination', 0, nodes.length - 1, { point: { ...nodes[nodes.length - 1]! }, fittings: [...spec.fittings] }), key: 'termination' });
    return finish(element, spec, nodes, radiusMm, drafts);
  }

  let cursor = 0;
  // ---- A unit's branch: its hose or outlet stub to the riser foot (the route's second point), then a pumped unit's lift.
  if (spec.drainStart?.kind === 'unit-drain') {
    const foot = spec.routePoints[1];
    let footIndex = 1;
    if (foot) while (footIndex < nodes.length - 1 && planDistance(nodes[footIndex]!, foot) > PLAN_EPS_MM) footIndex += 1;
    drafts.push({ ...stretch('connection', 0, footIndex), key: 'start' });
    cursor = footIndex;
    let top = cursor;
    while (top + 1 < nodes.length && isVertical(nodes[top]!, nodes[top + 1]!) && nodes[top + 1]!.z > nodes[top]!.z) top += 1;
    if (top > cursor && nodes[top]!.z - nodes[cursor]!.z > 1) {
      drafts.push({ ...stretch('riser', cursor, top, { point: { ...nodes[cursor]! } }), key: 'riser', lengthMm: nodes[top]!.z - nodes[cursor]!.z });
      cursor = top;
    }
  }

  // ---- The run on: legs between plan bends.
  const corners: Array<{ index: number; angleDeg: number; before: Point2D; after: Point2D }> = [];
  let heading: Point2D | null = null;
  for (let index = cursor; index < nodes.length - 1; index += 1) {
    const a = nodes[index]!;
    const b = nodes[index + 1]!;
    if (isVertical(a, b)) continue;
    const next = planHeading(a, b);
    if (heading) {
      const angle = turnDeg(heading, next);
      if (angle > BEND_MIN_DEG) corners.push({ index, angleDeg: angle, before: heading, after: next });
    }
    heading = next;
  }
  const bounds = [cursor, ...corners.map((corner) => corner.index), nodes.length - 1];
  // Where a bend takes over from its legs: its elbow's reach, at most 40 % of either leg.
  const legPlan = (from: number, to: number) => planLength(nodes.slice(from, to + 1));
  const trims = corners.map((corner, n) => {
    const before = legPlan(bounds[n]!, corner.index);
    const after = legPlan(corner.index, bounds[n + 2]!);
    return Math.max(0, Math.min(Math.max(40, 2.2 * radiusMm), 0.4 * before, 0.4 * after));
  });
  const ending = spec.drainEnd?.kind === 'junction';
  const endReach = Math.max(30, 2.5 * radiusMm);
  for (let n = 0; n + 1 < bounds.length; n += 1) {
    const from = bounds[n]!;
    const to = bounds[n + 1]!;
    if (to <= from) continue;
    const leg = stretch('leg', from, to);
    const length = leg.lengthMm;
    // Drawn and picked between its bends (and clear of the joint at the run's end).
    const head = n > 0 ? trims[n - 1]! : 0;
    const tail = n < corners.length ? trims[n]! : ending ? Math.min(endReach, 0.3 * length) : 0;
    drafts.push({ ...leg, path: length > head + tail + 1 ? slice(leg.path, head, length - tail) : leg.path });
  }
  corners.forEach((corner, n) => {
    const at = nodes[corner.index]!;
    const trim = Math.max(trims[n]!, 1);
    const inbound = { x: corner.before.x, y: corner.before.y, z: 0 };
    const outbound = { x: corner.after.x, y: corner.after.y, z: 0 };
    drafts.push({
      kind: 'bend', path: [sub(at, scale(inbound, trim)), { ...at }, add(at, scale(outbound, trim))], point: { ...at }, from: { ...at }, to: { ...at },
      lengthMm: 2 * trim, planLengthMm: 2 * trim, stationMm: stations[corner.index]! - 1e-3, fallMm: 0, angleDeg: corner.angleDeg, fittings: [],
    });
  });

  // ---- How it ends: into a main (a wye from the top, or the main it continues as), or the head of the drop.
  if (ending) {
    const last = nodes[nodes.length - 1]!;
    let back = nodes.length - 2;
    while (back > 0 && isVertical(nodes[back]!, last)) back -= 1;
    const tailPath = slice(nodes, total - Math.min(endReach, total), total);
    const wye = spec.fittings.find((fitting) => fitting.kind === 'wye') ?? null;
    drafts.push({
      key: 'end', kind: 'end', path: tailPath, point: wye ? { ...wye.point } : { ...last }, from: { ...last }, to: { ...last },
      lengthMm: 0, planLengthMm: 0, stationMm: total, fallMm: 0, angleDeg: null, fittings: wye ? [wye] : [],
    });
  }

  // ---- Its rodding eyes, air vents and wall sleeves, where they sit along it.
  const reach = Math.max(30, 2.5 * radiusMm);
  for (const fitting of spec.fittings) {
    const kind: CondensatePieceKind | null = fitting.kind === 'cleanout' ? 'eye' : fitting.kind === 'air-vent' ? 'vent' : fitting.kind === 'wall-sleeve' ? 'sleeve' : null;
    if (!kind) continue;
    const at = project(nodes, fitting.point);
    // Keyed by its order along the run: a re-solve renames fittings.
    drafts.push({
      kind, path: slice(nodes, at.stationMm - reach, at.stationMm + reach), point: { ...fitting.point }, from: { ...at.on }, to: { ...at.on },
      lengthMm: 0, planLengthMm: 0, stationMm: at.stationMm, fallMm: 0, angleDeg: null, fittings: [fitting],
    });
  }
  return finish(element, spec, nodes, radiusMm, drafts);
}

/** In flow order; where two share a station, the order a fitter meets them. */
const KIND_ORDER: Record<CondensatePieceKind, number> = { connection: 0, riser: 1, eye: 2, vent: 3, sleeve: 4, bend: 5, leg: 6, end: 7, termination: 8 };

/** Which fittings belong to which piece: elbows to their bend (or riser, or the leg whose 45° offset they make). */
function assignFittings(drafts: Draft[], fittings: readonly CondensateFitting[], nodes: readonly Point3[], radiusMm: number): void {
  const pathPieces = drafts.filter((draft) => draft.kind === 'connection' || draft.kind === 'riser' || draft.kind === 'leg' || draft.kind === 'bend');
  for (const fitting of fittings) {
    // Eyes, vents, sleeves and the wye are pieces (or part of one) of their own.
    if (fitting.kind === 'cleanout' || fitting.kind === 'air-vent' || fitting.kind === 'wall-sleeve' || fitting.kind === 'wye') continue;
    let best: { draft: Draft; d: number } | null = null;
    for (const draft of pathPieces) {
      // A plan bend owns the elbow at its corner; otherwise the nearest stretch, whole (untrimmed).
      const target = draft.kind === 'bend' && draft.point ? [draft.point] : draft.kind === 'leg' ? untrimmed(draft, nodes) : draft.path;
      const d = target.length === 1 ? distance3(target[0]!, fitting.point) : project(target, fitting.point).distanceMm;
      // The elbows at a riser's foot and top are the riser's; a plan bend's elbow is the bend's.
      const bias = draft.kind === 'bend' || draft.kind === 'riser' ? -radiusMm : 0;
      if (!best || d + bias < best.d) best = { draft, d: d + bias };
    }
    if (best) best.draft.fittings.push(fitting);
  }
}

/** A leg's centreline from bend to bend (its path is trimmed where the bends take over). */
function untrimmed(draft: Draft, nodes: readonly Point3[]): Point3[] {
  const first = project(nodes, draft.path[0]!);
  const last = project(nodes, draft.path[draft.path.length - 1]!);
  return slice(nodes, first.stationMm - 1, last.stationMm + 1);
}

function finish(element: HvacElement, spec: CondensatePipeSpec, nodes: Point3[], radiusMm: number, drafts: Draft[]): CondensateRun {
  if (spec.segmentRole !== 'drop' && spec.segmentRole !== 'terminal') assignFittings(drafts, spec.fittings, nodes, radiusMm);
  drafts.sort((a, b) => a.stationMm - b.stationMm || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const counts = new Map<CondensatePieceKind, number>();
  const pieces = drafts.map((draft): CondensatePiece => {
    const ordinal = (counts.get(draft.kind) ?? 0) + 1;
    counts.set(draft.kind, ordinal);
    const { key, ...rest } = draft;
    return { ...rest, key: key ?? `${draft.kind}:${ordinal}`, ordinal };
  });
  return { elementId: element.id, spec, role: spec.segmentRole, nodes, radiusMm, pieces };
}

export function condensatePieceOf(run: CondensateRun, key: string): CondensatePiece | null {
  return run.pieces.find((piece) => piece.key === key) ?? null;
}

/** The piece before or after one, in flow order. */
export function neighbourCondensatePiece(run: CondensateRun, key: string, step: -1 | 1): CondensatePiece | null {
  const index = run.pieces.findIndex((piece) => piece.key === key);
  return index < 0 ? null : run.pieces[index + step] ?? null;
}

// ---------------------------------------------------------------------------------------------------- picking

/** The piece's plan polyline (repeats dropped; a riser or a drop is one point). */
export function condensatePiecePlanPath(piece: CondensatePiece): Point2D[] {
  const out: Point2D[] = [];
  for (const point of piece.path) {
    const last = out[out.length - 1];
    if (!last || planDistance(point, last) > PLAN_EPS_MM) out.push(xy(point));
  }
  return out;
}

function distanceToPolyline2D(point: Point2D, polyline: readonly Point2D[]): number {
  if (polyline.length === 1) return planDistance(point, polyline[0]!);
  let best = Infinity;
  for (let index = 1; index < polyline.length; index += 1) {
    const a = polyline[index - 1]!;
    const b = polyline[index]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const squared = dx * dx + dy * dy;
    const t = squared > 1e-9 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared)) : 0;
    best = Math.min(best, Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy));
  }
  return best;
}

/** Where pieces overlap, the smaller one wins: a fitting over its leg, a riser over the hose at its foot. */
const PICK_PRIORITY: Record<CondensatePieceKind, number> = { eye: 0, vent: 0, sleeve: 0, end: 1, riser: 1, bend: 2, connection: 3, leg: 4, termination: 5 };
const POINT_KINDS = new Set<CondensatePieceKind>(['eye', 'vent', 'sleeve', 'end']);

/** How far from its centreline a piece answers a pick: the pipe's outside, fittings a little more (they are small). */
export function condensatePieceReachMm(run: CondensateRun, piece: CondensatePiece): number {
  return POINT_KINDS.has(piece.kind) || piece.kind === 'riser' ? Math.max(run.radiusMm * 1.6, 24) : run.radiusMm;
}

/**
 * The piece under a plan point, within its reach and `toleranceMm`, or null: the nearest, a fitting (or a riser)
 * favoured by its own size so it can be hit where it sits on its leg, without swallowing the leg round it.
 */
export function condensatePieceAtPlanPoint(run: CondensateRun, point: Point2D, toleranceMm = 0): CondensatePiece | null {
  let best: { piece: CondensatePiece; score: number } | null = null;
  for (const piece of run.pieces) {
    const d = distanceToPolyline2D(point, POINT_KINDS.has(piece.kind) && piece.point ? [xy(piece.point)] : condensatePiecePlanPath(piece));
    const reach = condensatePieceReachMm(run, piece);
    if (d > reach + toleranceMm) continue;
    const score = POINT_KINDS.has(piece.kind) || piece.kind === 'riser' ? d - reach : d;
    if (!best || score < best.score - 0.5 || (Math.abs(score - best.score) <= 0.5 && PICK_PRIORITY[piece.kind] < PICK_PRIORITY[best.piece.kind])) best = { piece, score };
  }
  return best?.piece ?? null;
}

/** The piece nearest a model point (a pick on the drain's surface in 3D), within `reachMm` of its centreline, or null. */
export function condensatePieceAtModelPoint(run: CondensateRun, point: Point3, reachMm = run.radiusMm + 60): CondensatePiece | null {
  let best: { piece: CondensatePiece; distance: number } | null = null;
  for (const piece of run.pieces) {
    const d = POINT_KINDS.has(piece.kind) && piece.point ? distance3(point, piece.point) : project(piece.path, point).distanceMm;
    const reach = POINT_KINDS.has(piece.kind) ? Math.max(reachMm, 2.5 * run.radiusMm) * 0.6 : reachMm;
    if (d > reach) continue;
    if (!best || d < best.distance - 1 || (Math.abs(d - best.distance) <= 1 && PICK_PRIORITY[piece.kind] < PICK_PRIORITY[best.piece.kind])) best = { piece, distance: d };
  }
  return best?.piece ?? null;
}

/** The piece of a drain run at a model point on it, as the segment focus of a view, or null. */
export function condensateFocusAtPoint(scene: readonly HvacElement[], runId: string, point: Point3, view: '2d' | '3d'): SegmentFocus | null {
  const element = scene.find((candidate) => candidate.id === runId);
  const run = element ? condensateRunOf(element) : null;
  const piece = run ? condensatePieceAtModelPoint(run, point) : null;
  return piece ? { domain: 'condensate', runId, key: piece.key, anchorMark: null, view } : null;
}

// ---------------------------------------------------------------------------------------------------- outlines

/** The point a leader line ends on: a fitting's own point, else half way along the piece. */
export function condensatePieceMidpoint(piece: CondensatePiece): Point3 {
  if (piece.point && (POINT_KINDS.has(piece.kind) || piece.kind === 'bend')) return { ...piece.point };
  return pointAlong(piece.path, pathLength(piece.path) / 2);
}

const circle = (centre: Point2D, r: number): Point2D[] => Array.from({ length: 28 }, (_, index) => {
  const angle = (index / 28) * Math.PI * 2;
  return { x: centre.x + Math.cos(angle) * r, y: centre.y + Math.sin(angle) * r };
});

/** The piece seen from above: a band of the pipe's outside along it, or a ring round a fitting, a riser or a drop. */
export function condensatePieceOutline(run: CondensateRun, piece: CondensatePiece): Point2D[] {
  const path = condensatePiecePlanPath(piece);
  if (POINT_KINDS.has(piece.kind) && piece.point) return circle(xy(piece.point), condensatePieceReachMm(run, piece));
  if (path.length < 2) return circle(path[0] ?? xy(piece.path[0]!), Math.max(run.radiusMm * 1.3, 16));
  const r = run.radiusMm;
  const normals = path.map((_, index) => {
    const a = path[Math.max(0, index - 1)]!;
    const b = path[Math.min(path.length - 1, index + 1)]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
  });
  const left = path.map((point, index) => ({ x: point.x + normals[index]!.x * r, y: point.y + normals[index]!.y * r }));
  const right = path.map((point, index) => ({ x: point.x - normals[index]!.x * r, y: point.y - normals[index]!.y * r }));
  return [...left, ...right.reverse()];
}

/** Where a stretch starts and stops in plan, for a pinned piece's brackets; none for a fitting, a riser or a drop. */
export function condensatePieceEnds(run: CondensateRun, piece: CondensatePiece): Array<{ point: Point2D; direction: Point2D; halfWidthMm: number }> {
  if (POINT_KINDS.has(piece.kind)) return [];
  const path = condensatePiecePlanPath(piece);
  if (path.length < 2) return [];
  const heading = (a: Point2D, b: Point2D) => {
    const d = planDistance(a, b) || 1;
    return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
  };
  return [
    { point: path[0]!, direction: heading(path[0]!, path[1]!), halfWidthMm: run.radiusMm },
    { point: path[path.length - 1]!, direction: heading(path[path.length - 2]!, path[path.length - 1]!), halfWidthMm: run.radiusMm },
  ];
}

/** The piece's box in model space, the pipe's outside round its centreline (a fitting's, round its point). */
export function condensatePieceBounds3D(run: CondensateRun, piece: CondensatePiece): { min: Point3; max: Point3 } {
  const r = POINT_KINDS.has(piece.kind) ? condensatePieceReachMm(run, piece) : run.radiusMm;
  const points = POINT_KINDS.has(piece.kind) && piece.point ? [piece.point] : piece.path;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const zs = points.map((point) => point.z);
  return {
    min: { x: Math.min(...xs) - r, y: Math.min(...ys) - r, z: Math.min(...zs) - r },
    max: { x: Math.max(...xs) + r, y: Math.max(...ys) + r, z: Math.max(...zs) + r },
  };
}

/** The steepest-down direction of a stretch where it starts (for figures that ask which way it falls). */
export function condensatePieceHeading(piece: CondensatePiece): Point3 | null {
  for (let index = 1; index < piece.path.length; index += 1) {
    const d = sub(piece.path[index]!, piece.path[index - 1]!);
    const l = length3(d);
    if (l > 1e-6) return scale(d, 1 / l);
  }
  return null;
}

/** The run's direction in plan where a piece is (a riser or a drop: the run leaving it), or null for a run with none. */
export function condensatePieceRunDirection(run: CondensateRun, piece: CondensatePiece): Point2D | null {
  const at = xy(piece.from);
  let best: { direction: Point2D; distance: number } | null = null;
  for (let index = 1; index < run.nodes.length; index += 1) {
    const a = run.nodes[index - 1]!;
    const b = run.nodes[index]!;
    const length = planDistance(a, b);
    if (length < 1) continue;
    const d = distanceToPolyline2D(at, [xy(a), xy(b)]);
    if (!best || d < best.distance - 0.5) best = { direction: { x: (b.x - a.x) / length, y: (b.y - a.y) / length }, distance: d };
  }
  return best?.direction ?? null;
}

/** A stretch's centreline centre to centre (a leg from bend to bend; its drawn path stops where the bends take over). */
export function condensatePieceSpan(run: CondensateRun, piece: CondensatePiece): Point3[] {
  if (piece.kind !== 'leg') return piece.lengthMm > 0 ? piece.path.map((point) => ({ ...point })) : [{ ...piece.from }];
  return slice(run.nodes, piece.stationMm, piece.stationMm + piece.lengthMm);
}
