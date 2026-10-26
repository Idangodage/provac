/**
 * Deleting pieces of condensate drains rather than whole runs or networks (a
 * segment card's piece, picked on the plan or in 3D):
 *
 *  - a leg, a bend, a riser, a unit's connection (its hose or outlet stub) or
 *    how a run ends (its wye into a main): the run is cut out there. Nothing
 *    else of the network changes (no re-solve: falls, sizes and wyes stay as
 *    they were); the part from the run's start keeps its id, each part after a
 *    cut is a new run. Every open end a cut leaves remembers the gap
 *    (`drainGap`): the other end, the stretch deleted (3D and on the plan) and
 *    its fittings, and for a lone end the connection it had. The network is
 *    marked hand-edited (Auto route leaves it); the design checks report the
 *    open ends until the gap is reconnected.
 *  - a drop (a termination run) goes whole: the runs that drained into its
 *    head end open, remembering it, so it can be put back as it was.
 *  - a rodding eye or an air vent goes and the run stays whole (it stays gone
 *    when the network is solved again). A wall sleeve stays: the drain passes
 *    a wall there.
 *
 * A locked run is left as it is. Pure.
 */
import type { HvacElement, Point2D } from '../../../../types';

import type { CondensateFittingEdit } from './condensateEditing';
import { condensatePieceOf, condensateRunOf, type CondensatePiece } from './condensatePieces';
import {
  isCondensatePipe,
  readCondensatePipeSpec,
  type CondensateConnection,
  type CondensateFitting,
  type CondensateNetworkOwnership,
  type Point3,
} from './condensateTypes';

export interface DrainPiecePick {
  runId: string;
  key: string;
}

/** A gap left in a drain where pieces were deleted, kept on each open end it left until reconnected. */
export interface DrainGapRef {
  id: string;
  /** The other open end of the gap: its run and which end; null for a lone end. */
  partner: { runId: string; end: 'start' | 'end' } | null;
  /** The stretch deleted, in the direction of flow (model mm, centreline). */
  removed: Point3[] | null;
  /** The same stretch on the plan, as the run's plan route had it. */
  removedPlan: Point2D[] | null;
  /** The fittings that were on it (its elbows, a rodding eye …). */
  removedFittings: CondensateFitting[];
  /** A lone end: the connection it had (the unit's outlet, the joint it ran into, the gully). */
  was: CondensateConnection | null;
  /** A drop deleted whole: the run as it was, to put back. */
  removedRun?: HvacElement;
  /** The points the cut made (where it fell between the run's own points): put back, they go again. */
  introduced?: { plan: Point2D[]; nodes: Point3[] };
}

export interface CondensateCutResult {
  updates: HvacElement[];
  add: HvacElement[];
  removeIds: string[];
  pieces: number;
  gaps: number;
  refused: Array<{ runId: string; reason: string }>;
}

export const DRAIN_GAP_PROPERTY = 'drainGap';
const FITTINGS_KEY = 'fittingEdits';
const EPS = 0.5;

let counter = 0;
function uniqueId(kind: 'run' | 'gap'): string {
  counter += 1;
  return `${kind === 'run' ? 'condensate-pipe' : 'gap'}-${Date.now().toString(36)}-${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function readGap(value: unknown): DrainGapRef | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string') return null;
  const partner = raw.partner as Record<string, unknown> | null | undefined;
  return {
    id: raw.id,
    partner: partner && typeof partner.runId === 'string' && (partner.end === 'start' || partner.end === 'end')
      ? { runId: partner.runId, end: partner.end } : null,
    removed: Array.isArray(raw.removed) ? raw.removed as Point3[] : null,
    removedPlan: Array.isArray(raw.removedPlan) ? raw.removedPlan as Point2D[] : null,
    removedFittings: Array.isArray(raw.removedFittings) ? raw.removedFittings as CondensateFitting[] : [],
    was: raw.was && typeof raw.was === 'object' ? raw.was as CondensateConnection : null,
    ...(raw.removedRun && typeof raw.removedRun === 'object' ? { removedRun: raw.removedRun as HvacElement } : {}),
    ...(raw.introduced && typeof raw.introduced === 'object' ? { introduced: raw.introduced as { plan: Point2D[]; nodes: Point3[] } } : {}),
  };
}

/** The gaps a drain run's open ends remember. */
export function readDrainGaps(element: Pick<HvacElement, 'properties'>): { start: DrainGapRef | null; end: DrainGapRef | null } {
  const raw = element.properties[DRAIN_GAP_PROPERTY] as Record<string, unknown> | undefined;
  return { start: readGap(raw?.start), end: readGap(raw?.end) };
}

/** A drain's gap record from its two ends (undefined clears it: the store merges properties). */
export function drainGapRecord(start: DrainGapRef | null, end: DrainGapRef | null): Record<string, DrainGapRef> | undefined {
  return start || end ? { ...(start ? { start } : {}), ...(end ? { end } : {}) } : undefined;
}

// ---- Stations along a run's 3D centreline and along its plan route. ----

type P = { x: number; y: number; z?: number };
const distanceOf = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));

function stationsOf(points: readonly P[]): number[] {
  const out = [0];
  for (let index = 1; index < points.length; index += 1) out.push(out[index - 1]! + distanceOf(points[index - 1]!, points[index]!));
  return out;
}

function stationOf(points: readonly P[], at: readonly number[], point: P): number {
  let best = { distance: Infinity, station: 0 };
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const ab = { x: b.x - a.x, y: b.y - a.y, z: (b.z ?? 0) - (a.z ?? 0) };
    const squared = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
    const pz = (point.z ?? 0) - (a.z ?? 0);
    const t = squared < 1e-9 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * ab.x + (point.y - a.y) * ab.y + pz * ab.z) / squared));
    const d = Math.hypot(a.x + ab.x * t - point.x, a.y + ab.y * t - point.y, (a.z ?? 0) + ab.z * t - (point.z ?? 0));
    if (d < best.distance - 1e-9) best = { distance: d, station: at[index - 1]! + t * Math.sqrt(squared) };
  }
  return best.station;
}

function pointAt<T extends P>(points: readonly T[], at: readonly number[], station: number): T {
  for (let index = 1; index < points.length; index += 1) {
    if (station <= at[index]! + 1e-9 || index === points.length - 1) {
      const span = at[index]! - at[index - 1]!;
      const t = span < 1e-9 ? 0 : Math.max(0, Math.min(1, (station - at[index - 1]!) / span));
      const a = points[index - 1]!;
      const b = points[index]!;
      const z = a.z !== undefined && b.z !== undefined ? { z: a.z + (b.z - a.z) * t } : {};
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, ...z } as T;
    }
  }
  return { ...points[points.length - 1]! };
}

/** The line from station `from` to station `to`. */
function slice<T extends P>(points: readonly T[], at: readonly number[], from: number, to: number): T[] {
  const inner = points.filter((_, index) => at[index]! > from + EPS && at[index]! < to - EPS).map((point) => ({ ...point }));
  return [pointAt(points, at, from), ...inner, pointAt(points, at, to)];
}

interface Cut { from: number; to: number }

function merge(cuts: readonly Cut[]): Cut[] {
  const sorted = [...cuts].sort((a, b) => a.from - b.from);
  const out: Cut[] = [];
  for (const cut of sorted) {
    const last = out[out.length - 1];
    if (last && cut.from <= last.to + EPS) last.to = Math.max(last.to, cut.to);
    else out.push({ ...cut });
  }
  return out;
}

/** The stretch a picked piece is along its run (3D stations), or what else it is. */
function cutOf(piece: CondensatePiece, nodes: readonly Point3[], at: readonly number[], total: number): Cut | 'fitting' | 'sleeve' | 'whole' | null {
  if (piece.kind === 'eye' || piece.kind === 'vent') return 'fitting';
  if (piece.kind === 'sleeve') return 'sleeve';
  if (piece.kind === 'termination') return 'whole';
  if (!piece.path.length) return null;
  const a = stationOf(nodes, at, piece.path[0]!);
  const b = stationOf(nodes, at, piece.path[piece.path.length - 1]!);
  if (piece.kind === 'connection') return { from: 0, to: Math.max(a, b, EPS * 2) };
  if (piece.kind === 'end') return { from: Math.min(a, b), to: total };
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  return to - from > EPS ? { from, to } : null;
}

/** A network run edited by hand: Auto route leaves it. */
function retained(properties: Record<string, unknown>): Record<string, unknown> {
  const owner = properties.condensateNetwork as CondensateNetworkOwnership | undefined;
  return owner ? { ...properties, condensateNetwork: { ...owner, editPolicy: 'retain' } } : properties;
}

/** Deletes the picked pieces of condensate drains (see the module comment). */
export function cutCondensatePieces(
  scene: readonly HvacElement[],
  picks: readonly DrainPiecePick[],
  options: { newId?: (kind: 'run' | 'gap') => string } = {},
): CondensateCutResult {
  const newId = options.newId ?? uniqueId;
  const result: CondensateCutResult = { updates: [], add: [], removeIds: [], pieces: 0, gaps: 0, refused: [] };
  const byRun = new Map<string, string[]>();
  for (const pick of picks) byRun.set(pick.runId, [...(byRun.get(pick.runId) ?? []), pick.key]);
  const updated = new Map<string, HvacElement>();
  const current = (element: HvacElement) => updated.get(element.id) ?? element;
  let gaps = 0;
  for (const [runId, keys] of byRun) {
    const element = scene.find((candidate) => candidate.id === runId);
    if (!element || !isCondensatePipe(element)) continue;
    const spec = readCondensatePipeSpec(element);
    if (spec.locked) {
      result.refused.push({ runId, reason: `${element.label || 'This drain run'} is locked` });
      continue;
    }
    const run = condensateRunOf(element);
    if (!run) continue;
    const nodes = run.nodes;
    const at = stationsOf(nodes);
    const total = at[at.length - 1] ?? 0;
    const cuts: Cut[] = [];
    const fittingEdits: CondensateFittingEdit[] = [];
    let whole = false;
    for (const key of new Set(keys)) {
      const piece = condensatePieceOf(run, key);
      if (!piece) continue;
      const cut = cutOf(piece, nodes, at, total);
      if (cut === 'sleeve') { result.refused.push({ runId, reason: 'A wall sleeve stays where the drain passes a wall: move the run instead' }); continue; }
      if (!cut) continue;
      result.pieces += 1;
      if (cut === 'fitting') {
        const fitting = piece.fittings[0];
        if (fitting && (fitting.kind === 'cleanout' || fitting.kind === 'air-vent')) fittingEdits.push({ action: 'remove', kind: fitting.kind, point: { x: fitting.point.x, y: fitting.point.y } });
        continue;
      }
      if (cut === 'whole') { whole = true; continue; }
      cuts.push(cut);
    }
    if (whole) {
      // A drop goes whole: whatever drained into its head ends open, remembering it.
      result.removeIds.push(element.id);
      const head = spec.drainStart?.kind === 'junction' ? spec.drainStart.nodeId : undefined;
      const gapId = newId('gap');
      for (const upstream of scene) {
        if (!isCondensatePipe(upstream) || upstream.id === element.id) continue;
        const upSpec = readCondensatePipeSpec(upstream);
        if (!head || upSpec.drainEnd?.kind !== 'junction' || upSpec.drainEnd.nodeId !== head) continue;
        const base = current(upstream);
        const gap: DrainGapRef = {
          id: gapId, partner: null, removed: spec.routeNodes3d.map((node) => ({ ...node })), removedPlan: spec.routePoints.map((point) => ({ ...point })),
          removedFittings: [...spec.fittings], was: (upstream.properties.drainEnd as CondensateConnection | undefined) ?? upSpec.drainEnd, removedRun: element,
        };
        updated.set(upstream.id, { ...base, properties: retained({ ...base.properties, drainEnd: null, [DRAIN_GAP_PROPERTY]: drainGapRecord(readDrainGaps(base).start, gap) }) });
      }
      gaps += 1;
      continue;
    }
    if (!cuts.length) {
      if (fittingEdits.length) {
        // The run stays whole without them (and they stay gone when the network is solved again).
        const base = current(element);
        const gone = (fitting: CondensateFitting) => fittingEdits.some((edit) => edit.kind === fitting.kind
          && Math.hypot(edit.point.x - fitting.point.x, edit.point.y - fitting.point.y) < 1);
        const previous = Array.isArray(base.properties[FITTINGS_KEY]) ? base.properties[FITTINGS_KEY] as CondensateFittingEdit[] : [];
        updated.set(element.id, { ...base, properties: retained({ ...base.properties,
          fittings: readCondensatePipeSpec(base).fittings.filter((fitting) => !gone(fitting)), [FITTINGS_KEY]: [...previous, ...fittingEdits] }) });
      }
      continue;
    }
    // ---- The run cut: the parts kept between the cuts, each with what stays on it. ----
    const merged = merge(cuts.map((cut) => ({ from: Math.max(0, cut.from), to: Math.min(total, cut.to) })));
    const kept: Array<{ from: number; to: number; cutBefore: number; cutAfter: number }> = [];
    let cursor = 0;
    merged.forEach((cut, index) => {
      if (cut.from > cursor + EPS) kept.push({ from: cursor, to: cut.from, cutBefore: index - 1, cutAfter: index });
      cursor = Math.max(cursor, cut.to);
    });
    if (total > cursor + EPS) kept.push({ from: cursor, to: total, cutBefore: merged.length - 1, cutAfter: -1 });
    const gapIds = merged.map(() => newId('gap'));
    const ids = kept.map((_, index) => (index === 0 ? element.id : newId('run')));
    // The plan route cut where the 3D centreline is: each cut station's point on the plan.
    const plan = spec.routePoints;
    const planAt = stationsOf(plan);
    const planStation = (station: number) => {
      const point = pointAt(nodes, at, station);
      return stationOf(plan, planAt, { x: point.x, y: point.y });
    };
    const fittingStation = (fitting: CondensateFitting) => stationOf(nodes, at, fitting.point);
    const own = <T extends P>(points: readonly T[], point: T) => points.some((candidate) => distanceOf(candidate, point) < 0.01);
    const removedOf = (cutIndex: number) => {
      const cut = merged[cutIndex]!;
      const removed = slice(nodes, at, cut.from, cut.to);
      const removedPlan = slice(plan, planAt, planStation(cut.from), planStation(cut.to));
      const ends = <T extends P>(line: readonly T[]) => [line[0]!, line[line.length - 1]!];
      return {
        removed,
        removedPlan,
        removedFittings: spec.fittings.filter((fitting) => {
          const station = fittingStation(fitting);
          return station > cut.from + EPS && station < cut.to - EPS;
        }),
        introduced: {
          plan: ends(removedPlan).filter((point) => !own(plan, point)),
          nodes: ends(removed).filter((point) => !own(nodes, point)),
        },
      };
    };
    const base = current(element);
    kept.forEach((range, index) => {
      const atStart = range.from <= EPS;
      const atEnd = range.to >= total - EPS;
      const startGap: DrainGapRef | null = atStart ? null : {
        id: gapIds[range.cutBefore]!, partner: index > 0 ? { runId: ids[index - 1]!, end: 'end' } : null,
        ...removedOf(range.cutBefore), was: index > 0 ? null : (base.properties.drainStart as CondensateConnection | undefined) ?? spec.drainStart,
      };
      const endGap: DrainGapRef | null = atEnd ? null : {
        id: gapIds[range.cutAfter]!, partner: index < kept.length - 1 ? { runId: ids[index + 1]!, end: 'start' } : null,
        ...removedOf(range.cutAfter), was: index < kept.length - 1 ? null : (base.properties.drainEnd as CondensateConnection | undefined) ?? spec.drainEnd,
      };
      if (startGap) gaps += startGap.partner ? 0.5 : 1;
      if (endGap) gaps += endGap.partner ? 0.5 : 1;
      // The plan route as it was between the cuts (its own points kept: a run put back is the run it was).
      const planPart = slice(plan, planAt, atStart ? 0 : planStation(range.from), atEnd ? planAt[planAt.length - 1]! : planStation(range.to));
      const properties = retained({
        ...base.properties,
        routePoints: planPart,
        routeNodes3d: slice(nodes, at, range.from, range.to),
        fittings: spec.fittings.filter((fitting) => {
          const station = fittingStation(fitting);
          return station >= range.from - EPS && station <= range.to + EPS;
        }),
        // The connections as stored.
        drainStart: atStart ? base.properties.drainStart ?? spec.drainStart : null,
        drainEnd: atEnd ? base.properties.drainEnd ?? spec.drainEnd : null,
        drainHoseLengthMm: atStart ? spec.drainHoseLengthMm : 0,
        [DRAIN_GAP_PROPERTY]: drainGapRecord(startGap, endGap),
      });
      const part = { ...base, id: ids[index]!, properties } as HvacElement;
      if (index === 0) updated.set(element.id, part);
      else result.add.push(part);
    });
    if (!kept.length) result.removeIds.push(element.id);
  }
  result.updates = [...updated.values()].filter((element) => !result.removeIds.includes(element.id));
  result.gaps = Math.round(gaps);
  return result;
}

/** A drain's open end that remembers a gap: where it is, the way into the gap (plan), and the gap. */
export interface DrainOpenEndRef {
  runId: string;
  end: 'start' | 'end';
  point: Point3;
  outward: Point2D;
  radiusMm: number;
  gap: DrainGapRef;
}

/** Every open end of the drains in `scene` that remembers a gap. */
export function condensateOpenEnds(scene: readonly HvacElement[]): DrainOpenEndRef[] {
  const out: DrainOpenEndRef[] = [];
  for (const element of scene) {
    if (!isCondensatePipe(element)) continue;
    const gaps = readDrainGaps(element);
    if (!gaps.start && !gaps.end) continue;
    const run = condensateRunOf(element);
    if (!run || run.nodes.length < 2) continue;
    const nodes = run.nodes;
    // The way it faces on the plan: its first (last) stretch that runs on the plan.
    const facing = (from: number, step: 1 | -1): Point2D => {
      for (let index = from; index + step >= 0 && index + step < nodes.length; index += step) {
        const a = nodes[index]!;
        const b = nodes[index + step]!;
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (length > 1) return { x: (a.x - b.x) / length, y: (a.y - b.y) / length };
      }
      return { x: 1, y: 0 };
    };
    if (gaps.start) out.push({ runId: element.id, end: 'start', point: { ...nodes[0]! }, outward: facing(0, 1), radiusMm: run.radiusMm, gap: gaps.start });
    if (gaps.end) out.push({ runId: element.id, end: 'end', point: { ...nodes[nodes.length - 1]! }, outward: facing(nodes.length - 1, -1), radiusMm: run.radiusMm, gap: gaps.end });
  }
  return out;
}
