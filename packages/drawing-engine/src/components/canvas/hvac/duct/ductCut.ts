/**
 * Deleting pieces of duct runs rather than whole runs (the segments a card
 * shows, picked on the plan or in 3D):
 *
 *  - a straight or a riser, an elbow or an offset, a transition, a take-off
 *    (with its volume damper) or the canvas connector at a collar: the run is
 *    cut out there. What stays keeps its fittings, so a straight deleted
 *    between two elbows leaves both elbows, each with an open socket. The part
 *    from the run's start keeps the run's id; each part after a cut is a new
 *    run. Every open end a cut leaves remembers the gap (DuctGapRef): the
 *    other end, the stretch deleted, and for a lone end what it was connected
 *    to (the collar, the parent run, the terminal).
 *  - the end: a flexible runout goes and the run ends open where it began; a
 *    plenum goes and the run ends open at its inlet, its spigot branches
 *    orphaned; a split goes and the run ends open, its outlets' branches
 *    orphaned; an end cap goes and the end is open.
 *  - an accessory goes and the run stays whole: an inline damper, access door
 *    or attenuator, a branch's volume damper; a fire damper's crossing is set
 *    to have none.
 *
 * Branches follow what holds them: a take-off moves to the part its station is
 * on (re-indexed), or is orphaned when its station was deleted; a split's or a
 * plenum's branches stay with the run's end. Elbow choices, accessories and
 * fire-damper choices go with the part they are on. A locked run, or one in
 * the old stub format, is left as it is. Pure.
 */
import type { HvacElement, Point2D } from '../../../../types';

import { getActiveDuctBuilding, type DuctBuilding } from './ductBuilding';
import { planDuctRunSpec, type DuctFabricationPlan } from './ductFabricationPlanner';
import { ductRunElementWithSpec } from './ductFollow';
import { ductLegs, type DuctLegGeometry } from './ductGeometry';
import { ductBranchesOf } from './ductNetwork';
import { ductWallCrossings } from './ductPenetrations';
import { ductSegments, type DuctSegment } from './ductSegments';
import type { DuctDesignSettings } from './ductSettings';
import {
  isDuctElement,
  readDuctRunSpec,
  type DuctEnd,
  type DuctGapRef,
  type DuctInlineAccessory,
  type DuctLeg,
  type DuctNodeOverride,
  type DuctOpenEnd,
  type DuctPenetrationOverride,
  type DuctPoint3,
  type DuctRunSpec,
} from './ductTypes';

/** A piece of a run, by its segment key (`ductSegments`). */
export interface DuctPiecePick {
  runId: string;
  key: string;
}

export interface DuctCutOptions {
  settings: DuctDesignSettings;
  /** The walls and rooms the runs pass through (default: the active building): fire-damper choices follow their crossing. */
  building?: Pick<DuctBuilding, 'walls' | 'rooms'>;
  /** Ids for the new runs and the gaps (default: unique ones). */
  newId?: (kind: 'run' | 'gap') => string;
}

export interface DuctCutResult {
  /** Runs changed, as they will be stored: a cut run's first part, accessories taken off, branches re-pointed. */
  updates: HvacElement[];
  /** New runs: the parts after each cut. */
  add: HvacElement[];
  /** Runs every piece of which was deleted. */
  removeIds: string[];
  /** Pieces deleted, the gaps their cuts left in the runs, and the branches left without their take-off. */
  pieces: number;
  gaps: number;
  orphaned: number;
  /** Runs left as they are, with why. */
  refused: Array<{ runId: string; reason: string }>;
}

/** Stations closer than this are the same place (mm; the planner's own tolerance). */
const EPS = 0.5;

let counter = 0;
function uniqueId(kind: 'run' | 'gap'): string {
  counter += 1;
  return `${kind === 'run' ? 'duct' : 'gap'}-${Date.now().toString(36)}-${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** What deleting one segment does to its run. */
type PieceAction =
  | { kind: 'cut'; from: number; to: number }
  | { kind: 'spec'; apply: (spec: DuctRunSpec) => DuctRunSpec }
  /** The run's end goes (a split, an end cap): the path stays, the end is open. */
  | { kind: 'end'; lone: boolean };

/** The run's stations: where each leg starts along it (mm) and its whole length. */
interface Stations {
  legs: DuctLegGeometry[];
  starts: number[];
  total: number;
}

function stationsOf(spec: DuctRunSpec): Stations {
  const legs = ductLegs(spec);
  const starts: number[] = [];
  let total = 0;
  for (const leg of legs) {
    starts.push(total);
    total += leg.lengthMm;
  }
  return { legs, starts, total };
}

/** The point on the run at station `s` (clear-bottom level, as the path stores it). */
function pointAt(spec: DuctRunSpec, st: Stations, legIndex: number, s: number): DuctPoint3 {
  const leg = st.legs[legIndex]!;
  const a = spec.path[legIndex]!;
  const b = spec.path[legIndex + 1]!;
  const d = Math.max(0, Math.min(leg.lengthMm, s - st.starts[legIndex]!));
  if (leg.vertical) {
    // A riser's station is its centreline rise; the bottom of a point inside it is the riser section's.
    const centre = leg.startCentreZ + leg.vertical * d;
    return { x: a.x, y: a.y, z: centre - spec.legs[legIndex]!.heightMm / 2 };
  }
  const t = leg.lengthMm > 0 ? d / leg.lengthMm : 0;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: leg.sloped ? a.z + (b.z - a.z) * t : a.z };
}

/** The leg a part starting at `s` begins on (a station at a leg's end begins the next leg). */
function legStartingAt(st: Stations, s: number): number {
  for (let k = 0; k < st.legs.length; k += 1) {
    if (s < st.starts[k]! + st.legs[k]!.lengthMm - EPS) return k;
  }
  return st.legs.length - 1;
}

/** The leg a part ending at `s` ends on (a station at a leg's start ends the leg before). */
function legEndingAt(st: Stations, s: number): number {
  for (let k = st.legs.length - 1; k >= 0; k -= 1) {
    if (s > st.starts[k]! + EPS) return k;
  }
  return 0;
}

/** Where a segment's pieces lie along the run (mm). */
function segmentSpan(plan: DuctFabricationPlan, segment: DuctSegment): { from: number; to: number } | null {
  const pieces = segment.pieceIndices.map((index) => plan.pieces[index]).filter((piece) => piece !== undefined);
  if (!pieces.length) return null;
  return { from: Math.min(...pieces.map((piece) => piece!.stationStartMm)), to: Math.max(...pieces.map((piece) => piece!.stationEndMm)) };
}

function actionOf(plan: DuctFabricationPlan, segment: DuctSegment, segments: readonly DuctSegment[], st: Stations): PieceAction | null {
  const key = segment.key;
  if (key.startsWith('inline:')) {
    const id = key.slice('inline:'.length);
    return { kind: 'spec', apply: (spec) => ({ ...spec, inline: (spec.inline ?? []).filter((item) => item.id !== id) }) };
  }
  if (key.startsWith('pen:')) {
    const crossing = segment.pieceIndices.map((index) => plan.pieces[index]?.penetrationKey).find((value) => value);
    if (!crossing) return null;
    return { kind: 'spec', apply: (spec) => ({ ...spec, penetrations: { ...(spec.penetrations ?? {}), [crossing]: { fireDamper: false } } }) };
  }
  if (key === 'start:damper') {
    return {
      kind: 'spec',
      apply: (spec) => (spec.start.kind === 'tap' || spec.start.kind === 'split-branch' || spec.start.kind === 'spigot'
        ? { ...spec, start: { ...spec.start, vcd: false } } : spec),
    };
  }
  if (key === 'end:cap') return { kind: 'end', lone: false };
  if (key === 'end:split') return { kind: 'end', lone: true };
  if (key === 'end:flex') {
    // The runout is the run's last leg; it goes, and the run ends where it began.
    const last = st.legs.length - 1;
    return last >= 1 ? { kind: 'cut', from: st.starts[last]!, to: st.total } : null;
  }
  const span = segmentSpan(plan, segment);
  if (!span) return null;
  if (key === 'start:takeoff') {
    // The take-off goes with the volume damper behind it.
    const damper = segments.find((other) => other.key === 'start:damper');
    const damperSpan = damper ? segmentSpan(plan, damper) : null;
    return { kind: 'cut', from: 0, to: Math.max(span.to, damperSpan?.to ?? 0) };
  }
  if (key === 'start:connector') return { kind: 'cut', from: 0, to: span.to };
  if (key === 'end:plenum') return { kind: 'cut', from: span.from, to: st.total };
  return { kind: 'cut', from: span.from, to: span.to };
}

/** Merge overlapping or touching intervals, in station order. */
function merge(intervals: ReadonlyArray<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  const out: Array<{ from: number; to: number }> = [];
  for (const interval of sorted) {
    const last = out[out.length - 1];
    if (last && interval.from <= last.to + EPS) last.to = Math.max(last.to, interval.to);
    else out.push({ ...interval });
  }
  return out;
}

/** The stretch an interval deletes: its centreline from cut to cut, and the section of each leg of it. */
function removedStretch(spec: DuctRunSpec, st: Stations, from: number, to: number): DuctGapRef['removed'] {
  if (to - from < EPS) return null;
  const k0 = legStartingAt(st, from);
  const k1 = legEndingAt(st, to);
  const path: DuctPoint3[] = [pointAt(spec, st, k0, from)];
  const legs: DuctLeg[] = [];
  for (let k = k0; k <= k1; k += 1) {
    legs.push(spec.legs[k]!);
    path.push(k < k1 ? { ...spec.path[k + 1]! } : pointAt(spec, st, k1, to));
  }
  return { path, legs };
}

/** A part of a cut run: the stations it keeps, and its ends. */
interface Part {
  id: string;
  from: number;
  to: number;
  k0: number;
  k1: number;
  start: DuctEnd;
  end: DuctEnd;
}

/** The ends a lone gap leaves: what was there (an open or capped end leaves a plain open end). */
function loneOpen(was: DuctEnd, gapId: string): DuctOpenEnd {
  if (was.kind === 'open') return was.orphaned ? { kind: 'open', orphaned: true } : { kind: 'open' };
  if (was.kind === 'end-cap') return { kind: 'open' };
  return { kind: 'open', gap: { id: gapId, partner: null, removed: null, was } };
}

interface RunCut {
  parts: Array<{ id: string; spec: DuctRunSpec }>;
  /** Where a take-off at (legIndex, station) on the old run is now: its part and place, or null when deleted. */
  relocate: (legIndex: number, stationMm: number) => { runId: string; legIndex: number; stationMm: number } | null;
  /** The part holding the run's end, when the end itself stays (a split's or a plenum's branches stay on it). */
  endHolder: string | null;
  pieces: number;
  gaps: number;
}

/**
 * `planned`: the run as the scene has it (its pieces are found from it); `spec`: the run as it is now, which
 * differs only in its start when its parent was cut first (the same path, so the same stations).
 */
function cutRun(element: HvacElement, planned: DuctRunSpec, spec: DuctRunSpec, keys: readonly string[], scene: readonly HvacElement[], options: Required<Pick<DuctCutOptions, 'settings' | 'newId'>> & { building: Pick<DuctBuilding, 'walls' | 'rooms'> }): RunCut {
  const plan = planDuctRunSpec(element.id, planned, { settings: options.settings, scene, building: options.building });
  const segments = ductSegments(plan);
  const st = stationsOf(spec);
  let next = spec;
  const intervals: Array<{ from: number; to: number }> = [];
  let endGone: { lone: boolean } | null = null;
  let pieces = 0;
  for (const key of new Set(keys)) {
    const segment = segments.find((candidate) => candidate.key === key);
    if (!segment) continue;
    const action = actionOf(plan, segment, segments, st);
    if (!action) continue;
    pieces += 1;
    if (action.kind === 'spec') next = action.apply(next);
    else if (action.kind === 'end') endGone = endGone && endGone.lone ? endGone : { lone: action.lone };
    else intervals.push({ from: Math.max(0, action.from), to: Math.min(st.total, action.to) });
  }
  const cuts = merge(intervals.filter((interval) => interval.to - interval.from >= EPS));

  // ---- The parts kept between the cuts. ----
  const kept: Array<{ from: number; to: number }> = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.from > cursor + EPS) kept.push({ from: cursor, to: cut.from });
    cursor = Math.max(cursor, cut.to);
  }
  if (st.total > cursor + EPS) kept.push({ from: cursor, to: st.total });
  if (!cuts.length) {
    // Accessories and the end only: the run stays whole.
    const end: DuctEnd = !endGone ? next.end : endGone.lone ? loneOpen(next.end, options.newId('gap')) : { kind: 'open' };
    return {
      parts: [{ id: element.id, spec: { ...next, end } }],
      relocate: (legIndex, stationMm) => ({ runId: element.id, legIndex, stationMm }),
      endHolder: endGone ? null : element.id,
      pieces,
      gaps: end.kind === 'open' && end.gap ? 1 : 0,
    };
  }
  if (!kept.length) return { parts: [], relocate: () => null, endHolder: null, pieces, gaps: 0 };

  const parts: Part[] = kept.map((range, index) => ({
    id: index === 0 ? element.id : options.newId('run'),
    from: range.from,
    to: range.to,
    k0: legStartingAt(st, range.from),
    k1: legEndingAt(st, range.to),
    start: next.start,
    end: next.end,
  }));
  /** A transition right at a part's cut start stays: its inlet is the open start's socket. */
  const socketAt = (part: Part): DuctLeg | null => {
    if (part.from <= EPS) return null;
    const transition = plan.pieces.find((piece) => piece.kind === 'transition' && piece.legIndex === part.k0 && Math.abs(piece.stationStartMm - part.from) <= EPS);
    if (!transition) return null;
    return transition.diameterMm !== undefined
      ? { widthMm: transition.diameterMm, heightMm: transition.diameterMm, diameterMm: transition.diameterMm }
      : { widthMm: transition.widthMm, heightMm: transition.heightMm };
  };
  let gaps = 0;
  // Each cut between two parts is one gap; one at either end is a lone gap remembering what was there.
  for (const cut of cuts) {
    const before = parts.filter((part) => part.to <= cut.from + EPS).pop();
    const after = parts.find((part) => part.from >= cut.to - EPS);
    const removed = removedStretch(spec, st, cut.from, cut.to);
    const id = options.newId('gap');
    if (before && after) {
      before.end = { kind: 'open', gap: { id, partner: { runId: after.id, end: 'start' }, removed, was: null } };
      after.start = { kind: 'open', gap: { id, partner: { runId: before.id, end: 'end' }, removed, was: null } };
      gaps += 1;
    } else if (after) {
      after.start = loneOpen(next.start, id);
      if (after.start.kind === 'open' && after.start.gap) after.start = { ...after.start, gap: { ...after.start.gap, removed } };
      if (after.start.kind === 'open' && after.start.gap) gaps += 1;
    } else if (before) {
      before.end = loneOpen(next.end, id);
      if (before.end.kind === 'open' && before.end.gap) before.end = { ...before.end, gap: { ...before.end.gap, removed } };
      if (before.end.kind === 'open' && before.end.gap) gaps += 1;
    }
  }
  for (const part of parts) {
    const socket = part.start.kind === 'open' ? socketAt(part) : null;
    if (socket && part.start.kind === 'open') part.start = { ...part.start, socket };
  }
  const last = parts[parts.length - 1]!;
  if (endGone && last.to >= st.total - EPS) {
    last.end = endGone.lone ? loneOpen(next.end, options.newId('gap')) : { kind: 'open' };
    if (endGone.lone && last.end.kind === 'open' && last.end.gap) gaps += 1;
  }

  // ---- Each part's spec: its stretch of path and legs, and what rides on it. ----
  const crossingsBefore = options.building.walls.length ? ductWallCrossings(spec, options.building.walls, options.building.rooms) : [];
  const built = parts.map((part) => {
    const path: DuctPoint3[] = [pointAt(spec, st, part.k0, part.from)];
    for (let k = part.k0 + 1; k <= part.k1; k += 1) path.push({ ...spec.path[k]! });
    path.push(pointAt(spec, st, part.k1, part.to));
    const legs = spec.legs.slice(part.k0, part.k1 + 1);
    const inside = (s: number) => s > part.from + EPS && s < part.to - EPS;
    const nodeOverrides: Record<string, DuctNodeOverride> = {};
    for (const [node, override] of Object.entries(next.nodeOverrides)) {
      const index = Number(node);
      if (index > part.k0 && index <= part.k1 && inside(st.starts[index]!)) nodeOverrides[String(index - part.k0)] = override;
    }
    const inline: DuctInlineAccessory[] = [];
    for (const item of next.inline ?? []) {
      const s = st.starts[item.legIndex]! + item.stationMm;
      if (item.legIndex < part.k0 || item.legIndex > part.k1 || !inside(s)) continue;
      inline.push({ ...item, legIndex: item.legIndex - part.k0, stationMm: item.legIndex === part.k0 ? s - part.from : item.stationMm });
    }
    const keepsStart = part.from <= EPS;
    const { inline: _inline, penetrations: _penetrations, sizing, initialSizing, ...rest } = next;
    const partSpec: DuctRunSpec = {
      ...rest,
      path,
      legs,
      start: part.start,
      end: part.end,
      nodeOverrides,
      ...(inline.length ? { inline } : {}),
      // The system's sizing basis rides on the run off the collar: it stays with the part that keeps the run's id.
      ...(part.id === element.id && sizing ? { sizing } : {}),
      ...(part.id === element.id && initialSizing ? { initialSizing } : {}),
    };
    return { part, spec: partSpec, keepsStart };
  });

  // Fire-damper choices go with their crossing (keys count crossings along each run, so they are re-counted).
  const overrides = next.penetrations ?? {};
  if (Object.keys(overrides).length) {
    const crossingsAfter = built.map(({ spec: partSpec }) => (options.building.walls.length ? ductWallCrossings(partSpec, options.building.walls, options.building.rooms) : []));
    for (const [key, override] of Object.entries(overrides)) {
      const was = crossingsBefore.find((crossing) => crossing.key === key);
      if (!was) {
        // Without the walls a choice cannot be placed: the first part keeps it as it was.
        if (!options.building.walls.length) built[0]!.spec.penetrations = { ...(built[0]!.spec.penetrations ?? {}), [key]: override };
        continue;
      }
      built.forEach(({ spec: partSpec }, index) => {
        const now = crossingsAfter[index]!.find((crossing) => crossing.wallId === was.wallId && Math.hypot(crossing.point.x - was.point.x, crossing.point.y - was.point.y) < 1);
        if (now) partSpec.penetrations = { ...(partSpec.penetrations ?? {}), [now.key]: override as DuctPenetrationOverride };
      });
    }
  }

  const relocate = (legIndex: number, stationMm: number) => {
    const s = (st.starts[legIndex] ?? 0) + stationMm;
    const holder = parts.find((part) => legIndex >= part.k0 && legIndex <= part.k1 && s > part.from + EPS && s < part.to - EPS);
    if (!holder) return null;
    return { runId: holder.id, legIndex: legIndex - holder.k0, stationMm: legIndex === holder.k0 ? s - holder.from : stationMm };
  };
  const endKept = last.to >= st.total - EPS && last.end === next.end && !endGone;
  return { parts: built.map(({ part, spec: partSpec }) => ({ id: part.id, spec: partSpec })), relocate, endHolder: endKept ? last.id : null, pieces, gaps };
}

/** A branch taken off what was deleted: its start is open, remembering what it hung from. */
function orphaned(spec: DuctRunSpec, gapId: string): DuctRunSpec {
  const was = spec.start;
  return was.kind === 'open' ? spec : { ...spec, start: { kind: 'open', orphaned: true, gap: { id: gapId, partner: null, removed: null, was } } };
}

/** Depth of a run below its root (0 = off a collar or free). */
function depthOf(id: string, specs: ReadonlyMap<string, DuctRunSpec>, seen = new Set<string>()): number {
  const spec = specs.get(id);
  if (!spec || seen.has(id)) return 0;
  seen.add(id);
  const parent = spec.start.kind === 'tap' || spec.start.kind === 'split-branch' || spec.start.kind === 'spigot' ? spec.start.parentRunId : null;
  return parent ? 1 + depthOf(parent, specs, seen) : 0;
}

/**
 * Deletes the picked pieces (see the module comment): the runs as they will
 * be stored, the parts added, the runs gone whole. Picks on runs that are
 * locked, drawn in the old format, or not ducts are refused or ignored.
 */
export function cutDuctPieces(scene: readonly HvacElement[], picks: readonly DuctPiecePick[], options: DuctCutOptions): DuctCutResult {
  const newId = options.newId ?? uniqueId;
  const building = options.building ?? getActiveDuctBuilding();
  const elements = new Map(scene.filter(isDuctElement).map((element) => [element.id, element]));
  const specs = new Map<string, DuctRunSpec>();
  for (const [id, element] of elements) {
    const spec = readDuctRunSpec(element);
    if (spec) specs.set(id, spec);
  }
  const keysByRun = new Map<string, string[]>();
  for (const pick of picks) {
    if (!elements.has(pick.runId)) continue;
    keysByRun.set(pick.runId, [...(keysByRun.get(pick.runId) ?? []), pick.key]);
  }
  const result: DuctCutResult = { updates: [], add: [], removeIds: [], pieces: 0, gaps: 0, orphaned: 0, refused: [] };
  // Parents first: a branch's start follows its parent's cut before its own pieces are cut.
  const current = new Map(specs);
  const changed = new Set<string>();
  const order = [...elements.keys()].filter((id) => specs.has(id)).sort((a, b) => depthOf(a, specs) - depthOf(b, specs));
  for (const id of order) {
    const element = elements.get(id)!;
    const spec = current.get(id)!;
    const keys = keysByRun.get(id);
    if (!keys?.length) continue;
    if (spec.legacy) { result.refused.push({ runId: id, reason: `${element.label || 'This run'} is drawn in the old format: delete it whole` }); continue; }
    if (spec.locked) { result.refused.push({ runId: id, reason: `${element.label || 'This run'} is locked` }); continue; }
    const cut = cutRun(element, specs.get(id)!, spec, keys, scene, { settings: options.settings, newId, building });
    result.pieces += cut.pieces;
    result.gaps += cut.gaps;
    if (!cut.pieces) continue;
    // Its branches: take-offs to the part their station is on, a split's or plenum's to the run's end.
    for (const branch of ductBranchesOf(id, scene)) {
      const branchSpec = current.get(branch.element.id) ?? branch.spec;
      const start = branchSpec.start;
      let nextSpec: DuctRunSpec;
      if (start.kind === 'tap') {
        const moved = cut.relocate(start.legIndex, start.stationMm);
        nextSpec = moved ? { ...branchSpec, start: { ...start, parentRunId: moved.runId, legIndex: moved.legIndex, stationMm: moved.stationMm } } : orphaned(branchSpec, newId('gap'));
      } else if (start.kind === 'split-branch' || start.kind === 'spigot') {
        nextSpec = cut.endHolder ? { ...branchSpec, start: { ...start, parentRunId: cut.endHolder } } : orphaned(branchSpec, newId('gap'));
      } else continue;
      if (nextSpec.start.kind === 'open' && nextSpec.start.gap) result.orphaned += 1;
      current.set(branch.element.id, nextSpec);
      changed.add(branch.element.id);
    }
    if (!cut.parts.length) {
      result.removeIds.push(id);
      current.delete(id);
      changed.delete(id);
      continue;
    }
    for (const part of cut.parts) {
      if (part.id === id) {
        current.set(id, part.spec);
        changed.add(id);
      } else {
        result.add.push(ductRunElementWithSpec({ ...element, id: part.id }, part.spec));
      }
    }
  }
  for (const id of changed) {
    const spec = current.get(id);
    const element = elements.get(id);
    if (spec && element) result.updates.push(ductRunElementWithSpec(element, spec));
  }
  return result;
}

/** A run's open ends that remember a gap, for the reconnect proposals and the marks on the drawing. */
export interface DuctOpenEndRef {
  runId: string;
  end: 'start' | 'end';
  point: DuctPoint3;
  /** The way the run leaves the end, into the gap (plan). */
  outward: Point2D;
  section: DuctLeg;
  gap: DuctGapRef | null;
  orphaned: boolean;
}

/** Every open end of the duct runs in `scene`. */
export function ductOpenEnds(scene: readonly HvacElement[]): DuctOpenEndRef[] {
  const out: DuctOpenEndRef[] = [];
  for (const element of scene) {
    if (!isDuctElement(element)) continue;
    const spec = readDuctRunSpec(element);
    if (!spec || spec.legacy || spec.path.length < 2) continue;
    const legs = ductLegs(spec);
    if (spec.start.kind === 'open') {
      const first = legs[0]!;
      out.push({
        runId: element.id, end: 'start', point: spec.path[0]!, outward: { x: -first.direction.x, y: -first.direction.y },
        section: spec.legs[0]!, gap: spec.start.gap ?? null, orphaned: spec.start.orphaned === true,
      });
    }
    if (spec.end.kind === 'open') {
      const lastLeg = legs[legs.length - 1]!;
      out.push({
        runId: element.id, end: 'end', point: spec.path[spec.path.length - 1]!, outward: lastLeg.direction,
        section: spec.legs[spec.legs.length - 1]!, gap: spec.end.gap ?? null, orphaned: spec.end.orphaned === true,
      });
    }
  }
  return out;
}
