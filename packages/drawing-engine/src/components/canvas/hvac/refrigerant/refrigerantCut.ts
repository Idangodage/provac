/**
 * Deleting pieces of refrigerant lines rather than whole lines (a segment
 * card's piece, picked on the plan or in 3D):
 *
 *  - a straight or a riser, a bend, or the stub at a unit's or a branch kit's
 *    port: the line is cut out there. What stays keeps its fittings (a straight
 *    deleted between two bends leaves both bends, open), the part from the
 *    line's start keeps its id, and each part after a cut is a new line. Every
 *    open end a cut leaves remembers the gap (`pipeGap`): the other end, the
 *    stretch deleted, and for a lone end the connection it had.
 *  - an inline accessory goes and the line stays whole.
 *
 * A coordinated pair (gas and liquid drawn together, one bundle) loses the
 * same stretch on both lines unless `pairs` is false (Alt + Delete: only the
 * line picked); the parts of the two lines pair up again (each part's bundle).
 * Accessories go with the part they are on (they re-attach by where they were
 * placed); the design of each part is derived again from its route. A locked
 * line, or one stored as an old pair element, is left as it is. Pure.
 */
import type { HvacElement, Point2D } from '../../../../types';
import { authoredGuideForHalf, bypassesForStationRange, materialsForSubroute, readRoutePoints } from '../branchKitProposal';
import { PIPE_DESIGN_PROPERTY, readPipeRouteNodes } from '../pipeDesignModel';
import { isPipeRouteLocked } from '../pipeEditRetention';
import { normalizePipeRouteNodes3d, splitPipeRoute3dAtPlanInterval, type PipeRouteNode3D } from '../pipeRoute3d';
import {
  buildRefrigerantPipeElement,
  resolveRefrigerantPipeSpec,
  type RefrigerantPipeConnection,
  type RefrigerantPipeLineKind,
} from '../refrigerantPipePairModel';

import { readRefrigerantAccessories } from './refrigerantAccessories';
import { refrigerantLineOf, type RefrigerantPiece } from './refrigerantPieces';

export interface PipePiecePick {
  runId: string;
  key: string;
}

/** A gap left in a line where pieces were deleted, kept on each open end it left until reconnected. */
export interface PipeGapRef {
  id: string;
  lineKind: RefrigerantPipeLineKind;
  /** The other open end of the gap: its line and which end; null for a lone end. */
  partner: { runId: string; end: 'start' | 'end' } | null;
  /** The stretch deleted, from cut to cut (model mm, centreline). */
  removed: PipeRouteNode3D[] | null;
  /** A lone end: the connection it had (a unit's port, a branch kit's). */
  was: RefrigerantPipeConnection | null;
  /**
   * The line had no 3D route of its own (its level came from its start port, its risers from its ports): its parts
   * store one only to keep that level, and a line put back together leaves it to be derived again.
   */
  levelKept?: true;
}

export interface RefrigerantCutResult {
  updates: HvacElement[];
  add: HvacElement[];
  removeIds: string[];
  pieces: number;
  /** Gaps left in the lines (a pair's two lines count once each). */
  gaps: number;
  refused: Array<{ runId: string; reason: string }>;
}

export const PIPE_GAP_PROPERTY = 'pipeGap';
const EPS = 0.5;

let counter = 0;
function uniqueId(kind: 'run' | 'gap'): string {
  counter += 1;
  return `${kind === 'run' ? 'refrigerant-pipe' : 'gap'}-${Date.now().toString(36)}-${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function readGap(value: unknown): PipeGapRef | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string') return null;
  const partner = raw.partner as Record<string, unknown> | null | undefined;
  return {
    id: raw.id,
    lineKind: raw.lineKind === 'liquid' ? 'liquid' : 'gas',
    partner: partner && typeof partner.runId === 'string' && (partner.end === 'start' || partner.end === 'end')
      ? { runId: partner.runId, end: partner.end } : null,
    removed: Array.isArray(raw.removed) ? normalizePipeRouteNodes3d(raw.removed) : null,
    was: raw.was && typeof raw.was === 'object' ? raw.was as RefrigerantPipeConnection : null,
    ...(raw.levelKept === true ? { levelKept: true as const } : {}),
  };
}

/**
 * A line's connection at one end as it is stored (else as resolved): what a cut keeps on a part and a reconnect
 * puts back, so a line put back as it was stores exactly what it stored.
 */
export function storedPipeConnection(element: Pick<HvacElement, 'properties'>, end: 'start' | 'end', resolved: RefrigerantPipeConnection | null): RefrigerantPipeConnection | null {
  if (!resolved) return null;
  const raw = element.properties[end === 'start' ? 'startConnection' : 'endConnection'];
  return raw && typeof raw === 'object' ? raw as RefrigerantPipeConnection : resolved;
}

/** The gaps a line's open ends remember. */
export function readPipeGaps(element: Pick<HvacElement, 'properties'>): { start: PipeGapRef | null; end: PipeGapRef | null } {
  const raw = element.properties[PIPE_GAP_PROPERTY] as Record<string, unknown> | undefined;
  return { start: readGap(raw?.start), end: readGap(raw?.end) };
}

// ---- Stations along a plan route. ----

function cumulative(route: readonly Point2D[]): number[] {
  const out = [0];
  for (let index = 1; index < route.length; index += 1) out.push(out[index - 1]! + Math.hypot(route[index]!.x - route[index - 1]!.x, route[index]!.y - route[index - 1]!.y));
  return out;
}

function stationOf(route: readonly Point2D[], point: Point2D): number {
  const at = cumulative(route);
  let best = { distance: Infinity, station: 0 };
  for (let index = 1; index < route.length; index += 1) {
    const a = route[index - 1]!;
    const b = route[index]!;
    const ab = { x: b.x - a.x, y: b.y - a.y };
    const lengthSq = ab.x * ab.x + ab.y * ab.y;
    const t = lengthSq < 1e-9 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * ab.x + (point.y - a.y) * ab.y) / lengthSq));
    const distance = Math.hypot(a.x + ab.x * t - point.x, a.y + ab.y * t - point.y);
    if (distance < best.distance - 1e-9) best = { distance, station: at[index - 1]! + t * Math.sqrt(lengthSq) };
  }
  return best.station;
}

function pointAt(route: readonly Point2D[], station: number): Point2D {
  const at = cumulative(route);
  for (let index = 1; index < route.length; index += 1) {
    if (station <= at[index]! + 1e-9 || index === route.length - 1) {
      const span = at[index]! - at[index - 1]!;
      const t = span < 1e-9 ? 0 : Math.max(0, Math.min(1, (station - at[index - 1]!) / span));
      return { x: route[index - 1]!.x + (route[index]!.x - route[index - 1]!.x) * t, y: route[index - 1]!.y + (route[index]!.y - route[index - 1]!.y) * t };
    }
  }
  return { ...route[route.length - 1]! };
}

/** The plan route from station `from` to station `to`. */
function subRoute(route: readonly Point2D[], from: number, to: number): Point2D[] {
  const at = cumulative(route);
  const inner: Point2D[] = [];
  for (let index = 1; index < route.length - 1; index += 1) if (at[index]! > from + EPS && at[index]! < to - EPS) inner.push({ ...route[index]! });
  // (A riser keeps its two plan points one on the other; only a cut point on its neighbour is dropped.)
  const first = pointAt(route, from);
  const last = pointAt(route, to);
  const same = (a: Point2D, b: Point2D | undefined) => Boolean(b) && Math.hypot(a.x - b!.x, a.y - b!.y) <= 1e-3;
  return [...(same(first, inner[0]) ? [] : [first]), ...inner, ...(same(last, inner[inner.length - 1]) ? [] : [last])];
}

/** A cut along a line: plan stations, and the levels at its two ends where it is a riser's (one plan point). */
interface Cut {
  from: number;
  to: number;
  zFrom?: number;
  zTo?: number;
}

function merge(cuts: readonly Cut[]): Cut[] {
  const sorted = [...cuts].sort((a, b) => a.from - b.from);
  const out: Cut[] = [];
  for (const cut of sorted) {
    const last = out[out.length - 1];
    if (last && cut.from <= last.to + EPS && (cut.to - cut.from > EPS || last.to - last.from > EPS)) {
      if (cut.to >= last.to) { last.to = cut.to; last.zTo = cut.zTo; }
    } else out.push({ ...cut });
  }
  return out;
}

/** The 3D route between two cuts (`from` / `to` plan stations; a riser cut's level at the end it leaves). */
function slice3d(route: Point2D[], nodes: PipeRouteNode3D[], from: number, to: number, zFrom: number | undefined, zTo: number | undefined, total: number): PipeRouteNode3D[] {
  if (nodes.length < 2) return [];
  let currentRoute = route;
  let currentNodes = nodes;
  if (from > EPS) {
    const cut = pointAt(route, from);
    const split = splitPipeRoute3dAtPlanInterval(currentRoute, currentNodes, cut, cut, { second: zFrom });
    if (!split) return [];
    currentNodes = split.after;
    currentRoute = subRoute(route, from, total);
  }
  if (to < total - EPS) {
    const cut = pointAt(route, to);
    const split = splitPipeRoute3dAtPlanInterval(currentRoute, currentNodes, cut, cut, { first: zTo });
    if (!split) return [];
    currentNodes = split.before;
  }
  return currentNodes;
}

/** What one line's cut makes of it: its parts' elements and the ends they leave. */
interface LineCut {
  parts: HvacElement[];
  gaps: number;
  /** The gap ids at each cut (shared with the partner line's same cut). */
  gapIds: string[];
}

function cutLine(
  element: HvacElement,
  scene: readonly HvacElement[],
  cuts: Cut[],
  removeAccessories: ReadonlySet<string>,
  gapIds: string[],
  bundleOf: (index: number) => string | undefined,
  newId: (kind: 'run' | 'gap') => string,
): LineCut {
  const spec = resolveRefrigerantPipeSpec(element.properties, scene as HvacElement[]);
  const route = readRoutePoints(element);
  const total = cumulative(route)[route.length - 1] ?? 0;
  const nodes = normalizePipeRouteNodes3d(element.properties.routeNodes3d);
  // A line with no 3D route of its own takes its level from its start port (its risers from its ports): a part that
  // no longer starts at that port stores the route at that level, so it stays where it was.
  const keepLevel = nodes.length < 2;
  const traced = keepLevel ? readPipeRouteNodes(element) : nodes;
  const merged = merge(cuts.map((cut) => ({ ...cut, from: Math.max(0, cut.from), to: Math.min(total, cut.to) })));
  // The parts kept between the cuts (a riser's cut is one plan point, with its two levels).
  const kept: Array<{ from: number; to: number; zFrom?: number; zTo?: number; cutBefore: number; cutAfter: number }> = [];
  let cursor = 0;
  let zCursor: number | undefined;
  merged.forEach((cut, index) => {
    if (cut.from > cursor + EPS) {
      kept.push({ from: cursor, to: cut.from, zFrom: zCursor, zTo: cut.zFrom, cutBefore: index - 1, cutAfter: index });
    }
    cursor = Math.max(cursor, cut.to);
    zCursor = cut.zTo;
  });
  if (total > cursor + EPS) kept.push({ from: cursor, to: total, zFrom: zCursor, cutBefore: merged.length - 1, cutAfter: -1 });
  while (gapIds.length < merged.length) gapIds.push(newId('gap'));
  const ids = kept.map((_, index) => (index === 0 ? element.id : newId('run')));
  const baseProps = element.properties;
  const accessories = readRefrigerantAccessories(element).filter((item) => !removeAccessories.has(item.id));
  let gaps = 0;
  const parts = kept.map((range, index) => {
    const routePart = subRoute(route, range.from, range.to);
    const removedOf = (cutIndex: number) => {
      const cut = merged[cutIndex]!;
      const stretch = slice3d(route, traced, cut.from, cut.to, cut.zFrom, cut.zTo, total);
      return stretch.length >= 2 ? stretch : null;
    };
    const atStart = range.from <= EPS;
    const atEnd = range.to >= total - EPS;
    const levelKept = keepLevel ? { levelKept: true as const } : {};
    const startGap: PipeGapRef | null = atStart ? null : {
      id: gapIds[range.cutBefore]!, lineKind: spec.lineKind,
      partner: index > 0 ? { runId: ids[index - 1]!, end: 'end' } : null,
      removed: removedOf(range.cutBefore), was: index > 0 ? null : storedPipeConnection(element, 'start', spec.startConnection), ...levelKept,
    };
    const endGap: PipeGapRef | null = atEnd ? null : {
      id: gapIds[range.cutAfter]!, lineKind: spec.lineKind,
      partner: index < kept.length - 1 ? { runId: ids[index + 1]!, end: 'start' } : null,
      removed: removedOf(range.cutAfter), was: index < kept.length - 1 ? null : storedPipeConnection(element, 'end', spec.endConnection), ...levelKept,
    };
    if (startGap) gaps += startGap.partner ? 0.5 : startGap.was ? 1 : 0;
    if (endGap) gaps += endGap.partner ? 0.5 : endGap.was ? 1 : 0;
    const startConnection = atStart ? storedPipeConnection(element, 'start', spec.startConnection) : null;
    const endConnection = atEnd ? storedPipeConnection(element, 'end', spec.endConnection) : null;
    const bundleId = bundleOf(index);
    const built = buildRefrigerantPipeElement(routePart, {
      lineKind: spec.lineKind, label: element.label,
      segmentMaterials: materialsForSubroute(route, spec.segmentMaterials, routePart),
      pipeDiameterMm: spec.pipeDiameterMm, outerDiameterMm: spec.outerDiameterMm, insulationThicknessMm: spec.insulationThicknessMm,
      ...(bundleId ? { bundleId } : {}), startConnection, endConnection, elevationMm: element.elevation,
    });
    // (The part that still starts at the line's start port keeps its level without a route of its own.)
    const nodesPart = keepLevel && atStart && spec.startConnection ? [] : slice3d(route, traced, range.from, range.to, range.zFrom, range.zTo, total);
    const properties: Record<string, unknown> = {
      ...baseProps,
      ...(built.properties ?? {}),
      ...(bundleId ? { bundleId } : {}),
    };
    const bypasses = bypassesForStationRange(baseProps.bypasses, route, range.from, range.to);
    if (bypasses.length) properties.bypasses = bypasses;
    else properties.bypasses = undefined;
    if (bundleId === undefined) properties.bundleId = undefined;
    // The design is derived again from this part's route (its legs and joints renamed; accessories re-attach by place).
    properties[PIPE_DESIGN_PROPERTY] = undefined;
    if (Object.prototype.hasOwnProperty.call(baseProps, 'authoredCenterlineRoute')) {
      properties.authoredCenterlineRoute = authoredGuideForHalf(baseProps.authoredCenterlineRoute, routePart, atStart, atEnd);
    }
    if (nodesPart.length >= 2) properties.routeNodes3d = nodesPart;
    else properties.routeNodes3d = undefined;
    const own = accessories.filter((item) => {
      const station = stationOf(route, item.at);
      return station > range.from + EPS && station < range.to - EPS;
    });
    if (own.length) properties.inlineAccessories = own;
    else properties.inlineAccessories = undefined;
    if (startGap || endGap) properties[PIPE_GAP_PROPERTY] = { ...(startGap ? { start: startGap } : {}), ...(endGap ? { end: endGap } : {}) };
    else properties[PIPE_GAP_PROPERTY] = undefined;
    return { ...element, ...built, id: ids[index]!, properties } as HvacElement;
  });
  return { parts, gaps: Math.round(gaps), gapIds };
}

/** The cuts the picked pieces make on their line, in plan stations (accessories apart). */
function cutsOf(element: HvacElement, scene: readonly HvacElement[], keys: readonly string[]): { cuts: Cut[]; accessories: Set<string>; pieces: number } {
  const line = refrigerantLineOf(element, scene);
  const route = readRoutePoints(element);
  const total = cumulative(route)[route.length - 1] ?? 0;
  const cuts: Cut[] = [];
  const accessories = new Set<string>();
  let pieces = 0;
  for (const key of new Set(keys)) {
    const piece = line?.pieces.find((candidate) => candidate.key === key);
    if (!piece || piece.path.length < 2) continue;
    pieces += 1;
    if (piece.kind === 'accessory') {
      if (piece.accessory) accessories.add(piece.accessory.accessory.id);
      continue;
    }
    const first = piece.path[0]!;
    const last = piece.path[piece.path.length - 1]!;
    const a = stationOf(route, first);
    const b = stationOf(route, last);
    if (key === 'port:start') cuts.push({ from: 0, to: Math.max(a, b) });
    else if (key === 'port:end') cuts.push({ from: Math.min(a, b), to: total });
    else if (Math.abs(a - b) <= EPS) cuts.push({ from: a, to: a, zFrom: Math.min(first.z, last.z), zTo: Math.max(first.z, last.z) });
    else cuts.push({ from: Math.min(a, b), to: Math.max(a, b) });
  }
  return { cuts, accessories, pieces };
}

// ---- A pair's other line: the pieces alongside, cut at one cross-section. ----

/** How far beside each other the two lines of a pair may run (centre to centre, mm). */
const PAIR_REACH_MM = 350;
const PARALLEL = 0.985;
/** The straight a cut leaves past a bend drawn as an arc of chords (mm). */
const ARC_SPIGOT_MM = 50;

function planWay(a: Point2D, b: Point2D): Point2D | null {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  return length > 1e-6 ? { x: (b.x - a.x) / length, y: (b.y - a.y) / length } : null;
}

function way3(a: PipeRouteNode3D, b: PipeRouteNode3D): PipeRouteNode3D | null {
  const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  return length > 1e-6 ? { x: (b.x - a.x) / length, y: (b.y - a.y) / length, z: (b.z - a.z) / length } : null;
}

const dot3 = (a: PipeRouteNode3D | null, b: PipeRouteNode3D | null) => (a && b ? a.x * b.x + a.y * b.y + a.z * b.z : -1);

/**
 * The piece of a pair's other line that runs alongside `piece`: the straight parallel to it and beside it, the bend
 * turning the same way near it, the riser beside it, the stub at the same port. Null when there is none (the lines
 * part there).
 */
function alongsidePiece(piece: RefrigerantPiece, others: readonly RefrigerantPiece[]): RefrigerantPiece | null {
  if (piece.kind === 'accessory' || piece.path.length < 2) return null;
  if (piece.kind === 'port') return others.find((other) => other.key === piece.key) ?? null;
  const first = piece.path[0]!;
  const last = piece.path[piece.path.length - 1]!;
  let best: { piece: RefrigerantPiece; score: number } | null = null;
  for (const other of others) {
    if (other.kind !== piece.kind || other.path.length < 2) continue;
    const p = other.path[0]!;
    const q = other.path[other.path.length - 1]!;
    let score: number;
    if (piece.kind === 'straight') {
      const way = planWay(first, last);
      const otherWay = planWay(p, q);
      if (!way || !otherWay || way.x * otherWay.x + way.y * otherWay.y < PARALLEL) continue;
      const side = Math.abs(((p.x + q.x) / 2 - first.x) * -way.y + ((p.y + q.y) / 2 - first.y) * way.x);
      const length = Math.hypot(last.x - first.x, last.y - first.y);
      const t0 = (p.x - first.x) * way.x + (p.y - first.y) * way.y;
      const t1 = (q.x - first.x) * way.x + (q.y - first.y) * way.y;
      const overlap = Math.min(length, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1));
      if (side > PAIR_REACH_MM || overlap <= EPS) continue;
      score = side - overlap * 1e-3;
    } else if (piece.kind === 'riser') {
      score = Math.hypot(p.x - first.x, p.y - first.y);
      if (score > PAIR_REACH_MM || Math.sign(q.z - p.z) !== Math.sign(last.z - first.z)) continue;
    } else {
      const n = piece.path.length;
      const m = other.path.length;
      if (dot3(way3(first, piece.path[1]!), way3(p, other.path[1]!)) < PARALLEL
        || dot3(way3(piece.path[n - 2]!, last), way3(other.path[m - 2]!, q)) < PARALLEL) continue;
      const mid = piece.path[Math.floor(n / 2)]!;
      const otherMid = other.path[Math.floor(m / 2)]!;
      score = Math.hypot(mid.x - otherMid.x, mid.y - otherMid.y, mid.z - otherMid.z);
      if (score > PAIR_REACH_MM * 1.5) continue;
    }
    if (!best || score < best.score) best = { piece: other, score };
  }
  return best?.piece ?? null;
}

/**
 * A line's plan route and its straights (and port stubs): their ends as stations on the route, their way, and the
 * stretch of the route that is that straight (`cleanFrom`..`cleanTo`). A route drawn by an older pipe tool keeps its
 * bends as many short chords of a wider arc than the bend its pieces show: there a straight's drawn part is shorter.
 */
interface LineGeometry {
  route: Point2D[];
  total: number;
  straights: Array<{ from: number; to: number; cleanFrom: number; cleanTo: number; a: Point2D; b: Point2D; way: Point2D }>;
}

function geometryOf(element: HvacElement, pieces: readonly RefrigerantPiece[]): LineGeometry {
  const route = readRoutePoints(element);
  const at = cumulative(route);
  const straights = pieces.flatMap((piece) => {
    if ((piece.kind !== 'straight' && piece.kind !== 'port') || piece.path.length < 2) return [];
    const first = piece.path[0]!;
    const last = piece.path[piece.path.length - 1]!;
    const stationA = stationOf(route, first);
    const stationB = stationOf(route, last);
    const [a, b] = stationA <= stationB ? [first, last] : [last, first];
    const way = planWay(a, b);
    if (!way) return [];
    const from = Math.min(stationA, stationB);
    const to = Math.max(stationA, stationB);
    // The route's own segments along this straight, within its range.
    const onLine = (point: Point2D) => Math.abs((point.x - a.x) * -way.y + (point.y - a.y) * way.x) <= 0.75;
    let cleanFrom = Infinity;
    let cleanTo = -Infinity;
    for (let index = 1; index < route.length; index += 1) {
      const s0 = at[index - 1]!;
      const s1 = at[index]!;
      if (s1 - s0 < 1e-6 || s1 < from - EPS || s0 > to + EPS) continue;
      const segment = planWay(route[index - 1]!, route[index]!);
      if (!segment || segment.x * way.x + segment.y * way.y < 0.9999 || !onLine(route[index - 1]!) || !onLine(route[index]!)) continue;
      cleanFrom = Math.min(cleanFrom, Math.max(from, s0));
      cleanTo = Math.max(cleanTo, Math.min(to, s1));
    }
    if (!(cleanFrom < cleanTo)) { cleanFrom = from; cleanTo = to; }
    // Past a drawn arc a cut leaves a short spigot of the straight (the part then ends straight, as cut on site).
    const spigot = Math.min(ARC_SPIGOT_MM, (cleanTo - cleanFrom) / 3);
    if (cleanFrom > from + EPS) cleanFrom += spigot;
    if (cleanTo < to - EPS) cleanTo -= spigot;
    return [{ from, to, cleanFrom, cleanTo, a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, way }];
  });
  return { route, total: at[route.length - 1] ?? 0, straights };
}

/** The straight of `line` at `station` running on after it (`after`) or coming to it. */
function straightAt(line: LineGeometry, station: number, side: 'after' | 'before') {
  return line.straights.find((range) => range.from - EPS <= station && station <= range.to + EPS
    && (side === 'after' ? range.to - station > EPS : station - range.from > EPS)) ?? null;
}

/**
 * A cut kept to the route as it is drawn: a straight deleted goes where the route is that straight (its bends'
 * chords stay with the bends), a bend deleted takes its whole drawn arc (to where its straights are drawn straight).
 */
function cleanCut(line: LineGeometry, cut: Cut): Cut {
  if (cut.to - cut.from <= EPS) return cut;
  let { from, to } = cut;
  const deletedFirst = straightAt(line, from, 'after');
  const keptBefore = straightAt(line, from, 'before');
  if (deletedFirst && Math.abs(deletedFirst.from - from) <= EPS) from = Math.max(from, deletedFirst.cleanFrom);
  else if (keptBefore && Math.abs(keptBefore.to - from) <= EPS) from = Math.min(from, keptBefore.cleanTo);
  const deletedLast = straightAt(line, to, 'before');
  const keptAfter = straightAt(line, to, 'after');
  if (deletedLast && Math.abs(deletedLast.to - to) <= EPS) to = Math.min(to, deletedLast.cleanTo);
  else if (keptAfter && Math.abs(keptAfter.from - to) <= EPS) to = Math.max(to, keptAfter.cleanFrom);
  return to - from > EPS ? { ...cut, from, to } : cut;
}

/** The station on `line`'s route of `point` on the straight `on` (its foot there), when the route runs through it. */
function stationOnStraight(line: LineGeometry, on: { a: Point2D; way: Point2D }, point: Point2D): number | null {
  const t = (point.x - on.a.x) * on.way.x + (point.y - on.a.y) * on.way.y;
  const foot = { x: on.a.x + on.way.x * t, y: on.a.y + on.way.y * t };
  const station = stationOf(line.route, foot);
  const there = pointAt(line.route, station);
  return Math.hypot(there.x - foot.x, there.y - foot.y) <= 1 ? station : null;
}

/**
 * A pair's two cuts brought to one cross-section. Where the two lines' open ends would be staggered along the way (a
 * bend's inner line turns sooner than its outer one, or one line's straight is drawn shorter), the cut of the line
 * that falls short moves on into its deleted straight (it keeps a short stub), else, where a bend went, the cut of the
 * one that runs on moves back along its kept straight (a little more of it goes): the two ends face the gap side by
 * side, as a fitter cuts a pair, and the parts are a pair again for the pipe tool and the reconnect.
 */
function abreast(own: LineGeometry, partner: LineGeometry, ownCuts: readonly Cut[], partnerCuts: readonly Cut[]): [Cut[], Cut[]] {
  const mine = merge(ownCuts.map((cut) => cleanCut(own, cut)));
  const theirs = merge(partnerCuts.map((cut) => cleanCut(partner, cut)));
  if (mine.length !== theirs.length) return [mine, theirs];
  type Straight = LineGeometry['straights'][number];
  mine.forEach((cut, index) => {
    const other = theirs[index]!;
    // (A riser's cut is one plan point: nothing to bring abreast.)
    if (cut.to - cut.from <= EPS || other.to - other.from <= EPS) return;
    const sides = [{ line: own, cut }, { line: partner, cut: other }] as const;
    /** Both cuts' `end` to the cross-section through the farther (or nearer) of the two along the straights. */
    const level = (end: 'from' | 'to', straights: Array<Straight | null>, pick: 'far' | 'near') => {
      const [first, second] = straights;
      if (!first || !second || first.way.x * second.way.x + first.way.y * second.way.y < PARALLEL) return false;
      const points = sides.map((side) => pointAt(side.line.route, side.cut[end]));
      const along = points.map((point) => point.x * first.way.x + point.y * first.way.y);
      if (Math.abs(along[0]! - along[1]!) <= 1) return true;
      const target = points[(pick === 'far') === (along[0]! > along[1]!) ? 0 : 1]!;
      const stations = sides.map((side, at) => stationOnStraight(side.line, straights[at]!, target));
      const valid = stations.every((station, at) => {
        const side = sides[at]!;
        return station !== null && (end === 'from' ? station > EPS && station < side.cut.to - 1 : station > side.cut.from + 1 && station < side.line.total - EPS);
      });
      if (valid) sides.forEach((side, at) => { side.cut[end] = stations[at]!; });
      return valid;
    };
    // The ends of the parts before the cut: a straight deleted on both, else a bend deleted after their straights.
    if (cut.from > EPS && other.from > EPS && !level('from', sides.map((side) => straightAt(side.line, side.cut.from, 'after')), 'far')) {
      level('from', sides.map((side) => straightAt(side.line, side.cut.from, 'before')), 'near');
    }
    // The starts of the parts after it.
    if (cut.to < own.total - EPS && other.to < partner.total - EPS && !level('to', sides.map((side) => straightAt(side.line, side.cut.to, 'before')), 'near')) {
      level('to', sides.map((side) => straightAt(side.line, side.cut.to, 'after')), 'far');
    }
  });
  return [mine, theirs];
}

/** The other line of a coordinated pair: same bundle, the other service. */
function partnerOf(element: HvacElement, scene: readonly HvacElement[]): HvacElement | null {
  const bundleId = element.properties.bundleId;
  if (typeof bundleId !== 'string' || !bundleId) return null;
  const kind = resolveRefrigerantPipeSpec(element.properties).lineKind;
  return scene.find((other) => other.id !== element.id && other.type === 'refrigerant-pipe' && other.properties.bundleId === bundleId
    && resolveRefrigerantPipeSpec(other.properties).lineKind !== kind) ?? null;
}

/**
 * Deletes the picked pieces of refrigerant lines (see the module comment).
 * `pairs` (default true): a pair's partner line loses the same stretch.
 */
export function cutRefrigerantPieces(
  scene: readonly HvacElement[],
  picks: readonly PipePiecePick[],
  options: { pairs?: boolean; newId?: (kind: 'run' | 'gap') => string } = {},
): RefrigerantCutResult {
  const newId = options.newId ?? uniqueId;
  const pairs = options.pairs !== false;
  const result: RefrigerantCutResult = { updates: [], add: [], removeIds: [], pieces: 0, gaps: 0, refused: [] };
  const byLine = new Map<string, string[]>();
  for (const pick of picks) byLine.set(pick.runId, [...(byLine.get(pick.runId) ?? []), pick.key]);
  const done = new Set<string>();
  for (const [runId, keys] of byLine) {
    if (done.has(runId)) continue;
    const element = scene.find((candidate) => candidate.id === runId);
    if (!element) continue;
    if (element.type !== 'refrigerant-pipe') {
      result.refused.push({ runId, reason: `${element.label || 'This line'} is stored as an old pair element: delete it whole` });
      continue;
    }
    if (isPipeRouteLocked(element)) {
      result.refused.push({ runId, reason: `${element.label || 'This line'} is locked` });
      continue;
    }
    const own = cutsOf(element, scene, keys);
    result.pieces += own.pieces;
    const partner = pairs ? partnerOf(element, scene) : null;
    const ownPieces = refrigerantLineOf(element, scene)?.pieces ?? [];
    const ownGeometry = geometryOf(element, ownPieces);
    const lines: Array<{ element: HvacElement; cuts: Cut[]; accessories: Set<string> }> = [
      { element, cuts: own.cuts.map((cut) => cleanCut(ownGeometry, cut)), accessories: own.accessories },
    ];
    if (partner && !isPipeRouteLocked(partner)) {
      // The partner loses the pieces alongside the ones picked (each line keeps its own bends), the two cut at one
      // cross-section; where a piece has none alongside (the lines part there), the stretch between each cut's ends
      // projected onto it.
      const partnerPieces = refrigerantLineOf(partner, scene)?.pieces ?? [];
      const partnerGeometry = geometryOf(partner, partnerPieces);
      const picked = [...new Set(keys)].map((key) => ownPieces.find((piece) => piece.key === key))
        .filter((piece): piece is RefrigerantPiece => Boolean(piece && piece.kind !== 'accessory' && piece.path.length >= 2));
      const matching = picked.map((piece) => alongsidePiece(piece, partnerPieces));
      let alongside: Cut[];
      if (matching.every((piece) => piece !== null)) {
        const [ownCuts, partnerCuts] = abreast(ownGeometry, partnerGeometry, own.cuts, cutsOf(partner, scene, matching.map((piece) => piece!.key)).cuts);
        lines[0]!.cuts = ownCuts;
        alongside = partnerCuts;
      } else {
        const route = readRoutePoints(element);
        const partnerRoute = readRoutePoints(partner);
        alongside = own.cuts.map((cut): Cut => {
          const a = stationOf(partnerRoute, pointAt(route, cut.from));
          const b = stationOf(partnerRoute, pointAt(route, cut.to));
          return cut.to - cut.from <= EPS ? { from: a, to: a, zFrom: cut.zFrom, zTo: cut.zTo } : { from: Math.min(a, b), to: Math.max(a, b) };
        });
      }
      const extra = cutsOf(partner, scene, byLine.get(partner.id) ?? []);
      result.pieces += extra.pieces;
      lines.push({ element: partner, cuts: [...alongside, ...extra.cuts.map((cut) => cleanCut(partnerGeometry, cut))], accessories: extra.accessories });
      done.add(partner.id);
    }
    // The two lines' parts pair up again: part k of each takes one bundle.
    const bundle = typeof element.properties.bundleId === 'string' ? element.properties.bundleId : undefined;
    const bundleOf = (index: number) => (bundle && lines.length > 1 ? (index === 0 ? bundle : `${bundle}-p${index}`) : index === 0 ? bundle : undefined);
    const gapIds: string[] = [];
    for (const line of lines) {
      if (!line.cuts.length && !line.accessories.size) continue;
      if (!line.cuts.length) {
        // Accessories only: the line stays whole.
        const accessories = readRefrigerantAccessories(line.element).filter((item) => !line.accessories.has(item.id));
        const properties = { ...line.element.properties };
        if (accessories.length) properties.inlineAccessories = accessories;
        else properties.inlineAccessories = undefined;
        result.updates.push({ ...line.element, properties });
        continue;
      }
      const cut = cutLine(line.element, scene, line.cuts, line.accessories, gapIds, bundleOf, newId);
      result.gaps += cut.gaps;
      if (!cut.parts.length) {
        result.removeIds.push(line.element.id);
        continue;
      }
      for (const part of cut.parts) {
        if (part.id === line.element.id) result.updates.push(part);
        else result.add.push(part);
      }
      if (!cut.parts.some((part) => part.id === line.element.id)) result.removeIds.push(line.element.id);
    }
    done.add(runId);
  }
  return result;
}

/** A refrigerant line's open end that remembers a gap: where it is, the way into the gap, and the gap. */
export interface PipeOpenEndRef {
  runId: string;
  end: 'start' | 'end';
  point: PipeRouteNode3D;
  outward: Point2D;
  lineKind: RefrigerantPipeLineKind;
  bundleId: string | null;
  outerDiameterMm: number;
  gap: PipeGapRef;
}

/** Every open end of the refrigerant lines in `scene` that remembers a gap. */
export function refrigerantOpenEnds(scene: readonly HvacElement[]): PipeOpenEndRef[] {
  const out: PipeOpenEndRef[] = [];
  for (const element of scene) {
    if (element.type !== 'refrigerant-pipe') continue;
    const gaps = readPipeGaps(element);
    if (!gaps.start && !gaps.end) continue;
    const spec = resolveRefrigerantPipeSpec(element.properties);
    const nodes = readPipeRouteNodes(element);
    const route = readRoutePoints(element);
    const at = (index: number): PipeRouteNode3D => nodes[index < 0 ? nodes.length + index : index]!;
    const direction = (a: Point2D, b: Point2D) => {
      const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    };
    if (route.length < 2) continue;
    // The way it faces as its pieces show it (its first or last leg): a route drawn as arc chords ends on a chord.
    const legs = refrigerantLineOf(element, scene)?.design.legs ?? [];
    const legWay = (leg: (typeof legs)[number] | undefined, sign: 1 | -1) => {
      const length = leg ? Math.hypot(leg.direction.x, leg.direction.y) : 0;
      return leg && length > 0.5 ? { x: (sign * leg.direction.x) / length, y: (sign * leg.direction.y) / length } : null;
    };
    const common = { runId: element.id, lineKind: spec.lineKind, bundleId: spec.bundleId ?? null, outerDiameterMm: spec.outerDiameterMm };
    if (gaps.start) out.push({ ...common, end: 'start', point: at(0), outward: legWay(legs[0], -1) ?? direction(route[1]!, route[0]!), gap: gaps.start });
    if (gaps.end) {
      out.push({ ...common, end: 'end', point: at(-1), outward: legWay(legs[legs.length - 1], 1) ?? direction(route[route.length - 2]!, route[route.length - 1]!), gap: gaps.end });
    }
  }
  return out;
}
