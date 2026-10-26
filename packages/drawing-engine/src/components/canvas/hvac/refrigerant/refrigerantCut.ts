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
import { PIPE_DESIGN_PROPERTY } from '../pipeDesignModel';
import { isPipeRouteLocked } from '../pipeEditRetention';
import { normalizePipeRouteNodes3d, splitPipeRoute3dAtPlanInterval, type PipeRouteNode3D } from '../pipeRoute3d';
import {
  buildRefrigerantPipeElement,
  resolveRefrigerantPipeSpec,
  type RefrigerantPipeConnection,
  type RefrigerantPipeLineKind,
} from '../refrigerantPipePairModel';

import { readRefrigerantAccessories } from './refrigerantAccessories';
import { refrigerantLineOf } from './refrigerantPieces';

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
  };
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
      const stretch = slice3d(route, nodes, cut.from, cut.to, cut.zFrom, cut.zTo, total);
      return stretch.length >= 2 ? stretch : null;
    };
    const atStart = range.from <= EPS;
    const atEnd = range.to >= total - EPS;
    const startGap: PipeGapRef | null = atStart ? null : {
      id: gapIds[range.cutBefore]!, lineKind: spec.lineKind,
      partner: index > 0 ? { runId: ids[index - 1]!, end: 'end' } : null,
      removed: removedOf(range.cutBefore), was: index > 0 ? null : spec.startConnection,
    };
    const endGap: PipeGapRef | null = atEnd ? null : {
      id: gapIds[range.cutAfter]!, lineKind: spec.lineKind,
      partner: index < kept.length - 1 ? { runId: ids[index + 1]!, end: 'start' } : null,
      removed: removedOf(range.cutAfter), was: index < kept.length - 1 ? null : spec.endConnection,
    };
    if (startGap) gaps += startGap.partner ? 0.5 : startGap.was ? 1 : 0;
    if (endGap) gaps += endGap.partner ? 0.5 : endGap.was ? 1 : 0;
    const startConnection = atStart ? spec.startConnection : null;
    const endConnection = atEnd ? spec.endConnection : null;
    const bundleId = bundleOf(index);
    const built = buildRefrigerantPipeElement(routePart, {
      lineKind: spec.lineKind, label: element.label,
      segmentMaterials: materialsForSubroute(route, spec.segmentMaterials, routePart),
      pipeDiameterMm: spec.pipeDiameterMm, outerDiameterMm: spec.outerDiameterMm, insulationThicknessMm: spec.insulationThicknessMm,
      ...(bundleId ? { bundleId } : {}), startConnection, endConnection, elevationMm: element.elevation,
    });
    const nodesPart = slice3d(route, nodes, range.from, range.to, range.zFrom, range.zTo, total);
    const properties: Record<string, unknown> = {
      ...baseProps,
      ...(built.properties ?? {}),
      ...(bundleId ? { bundleId } : {}),
      bypasses: bypassesForStationRange(baseProps.bypasses, route, range.from, range.to),
    };
    if (bundleId === undefined) delete properties.bundleId;
    // The design is derived again from this part's route (its legs and joints renamed; accessories re-attach by place).
    delete properties[PIPE_DESIGN_PROPERTY];
    if (Object.prototype.hasOwnProperty.call(baseProps, 'authoredCenterlineRoute')) {
      properties.authoredCenterlineRoute = authoredGuideForHalf(baseProps.authoredCenterlineRoute, routePart, atStart, atEnd);
    }
    if (nodesPart.length >= 2) properties.routeNodes3d = nodesPart;
    else delete properties.routeNodes3d;
    const own = accessories.filter((item) => {
      const station = stationOf(route, item.at);
      return station > range.from + EPS && station < range.to - EPS;
    });
    if (own.length) properties.inlineAccessories = own;
    else delete properties.inlineAccessories;
    if (startGap || endGap) properties[PIPE_GAP_PROPERTY] = { ...(startGap ? { start: startGap } : {}), ...(endGap ? { end: endGap } : {}) };
    else delete properties[PIPE_GAP_PROPERTY];
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
    const lines: Array<{ element: HvacElement; cuts: Cut[]; accessories: Set<string> }> = [{ element, cuts: own.cuts, accessories: own.accessories }];
    if (partner && !isPipeRouteLocked(partner)) {
      // The partner loses the stretch alongside (each cut's ends projected onto it), and its own picks.
      const route = readRoutePoints(element);
      const partnerRoute = readRoutePoints(partner);
      const projected = own.cuts.map((cut): Cut => {
        const a = stationOf(partnerRoute, pointAt(route, cut.from));
        const b = stationOf(partnerRoute, pointAt(route, cut.to));
        return cut.to - cut.from <= EPS ? { from: a, to: a, zFrom: cut.zFrom, zTo: cut.zTo } : { from: Math.min(a, b), to: Math.max(a, b) };
      });
      const extra = cutsOf(partner, scene, byLine.get(partner.id) ?? []);
      result.pieces += extra.pieces;
      lines.push({ element: partner, cuts: [...projected, ...extra.cuts], accessories: extra.accessories });
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
        else delete properties.inlineAccessories;
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
    const nodes = normalizePipeRouteNodes3d(element.properties.routeNodes3d);
    const route = readRoutePoints(element);
    const z = element.elevation + spec.outerDiameterMm / 2;
    const at = (index: number): PipeRouteNode3D => nodes.length >= 2 ? nodes[index < 0 ? nodes.length + index : index]! : { ...route[index < 0 ? route.length + index : index]!, z };
    const direction = (a: Point2D, b: Point2D) => {
      const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    };
    if (route.length < 2) continue;
    const common = { runId: element.id, lineKind: spec.lineKind, bundleId: spec.bundleId ?? null, outerDiameterMm: spec.outerDiameterMm };
    if (gaps.start) out.push({ ...common, end: 'start', point: at(0), outward: direction(route[1]!, route[0]!), gap: gaps.start });
    if (gaps.end) out.push({ ...common, end: 'end', point: at(-1), outward: direction(route[route.length - 2]!, route[route.length - 1]!), gap: gaps.end });
  }
  return out;
}
