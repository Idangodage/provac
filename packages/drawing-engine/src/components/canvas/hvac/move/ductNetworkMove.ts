/**
 * Duct runs through a move: every run that what moved is attached to, and
 * every run being moved, re-solved elastically (ductElasticMove) from the
 * unit outwards, so each branch is solved on its parent's new wall.
 *
 * - A run's start moves exactly as what it leaves from: a unit's collar, a
 *   split outlet or plenum spigot at its parent's end, a take-off on its
 *   parent's wall. A take-off may also slide along that wall (within its
 *   straight), so a branch whose terminal moves along the trunk can follow it.
 * - Its end moves exactly as the terminal it serves; when that stays, the end
 *   stays (decision: ducts stretch, diffusers stay put).
 * - A run being moved would like every vertex to move by the drag; any other
 *   run would like to stay. Moved together = moved rigidly: a run whose ends
 *   both move with it translates exactly.
 * - A dragged straight (a segment) moves sideways (and up or down: risers are
 *   made at its ends where its neighbours are level), its neighbours stretching.
 *
 * A run that cannot keep both ends attached keeps its start, lets its end go
 * as little as it can and says so (it is left for the designer to re-route,
 * shown amber); a unit turned by its placement turns its runs rigidly.
 */
import type { HvacElement, Point2D } from '../../../../types';
import { findAirPort, type DuctAirPort } from '../duct/ductAirPorts';
import { branchAnchor, ductRunElementWithSpec, rigidTransformSpec, startAnchor, type DuctAnchor } from '../duct/ductFollow';
import { ductLegs } from '../duct/ductGeometry';
import type { DuctDesignSettings } from '../duct/ductSettings';
import { findTerminalPort } from '../duct/ductTerminals';
import { ductParentRunId, isDuctElement, readDuctRunSpec, type DuctLeg, type DuctRunSpec } from '../duct/ductTypes';

import {
  AXES3,
  dotVec3,
  lengthVec3,
  pinVertex,
  solveElasticRun,
  subVec3,
  ZERO3,
  type ElasticBound,
  type ElasticConstraint,
  type ElasticLegOption,
  type Vec3,
} from './ductElasticMove';

/** One straight of a run, as picked for its segment card. */
export interface DuctSegmentRef {
  runId: string;
  legIndex: number;
}

export interface DuctNetworkMoveInput {
  /** The scene before the move. */
  before: readonly HvacElement[];
  /** The scene with the moved units and terminals in their new places (ducts as they were). */
  after: readonly HvacElement[];
  /** Units and terminals that moved. */
  movedEquipmentIds: ReadonlySet<string>;
  /** Runs moved whole. */
  runIds: ReadonlySet<string>;
  /** A straight moved on its own. */
  segment?: DuctSegmentRef | null;
  delta: Vec3;
  settings: DuctDesignSettings;
}

export interface DuctRunMoveOutcome {
  /** `moved`: it was being moved; `follows`: it moved because what it is attached to did. */
  kind: 'moved' | 'follows';
  /** What the move left for the designer (shown amber). */
  note?: string;
}

export interface DuctNetworkMoveResult {
  /** The runs that changed, as they will be stored. */
  runs: HvacElement[];
  outcomes: Map<string, DuctRunMoveOutcome>;
  /** Why the straight did not move (the rest of the move goes ahead). */
  segmentRefused: string | null;
  /** Notes worth showing (a run that no longer reaches its terminal, …). */
  messages: string[];
}

/** Shifts below this count as no move (mm). */
const MOVE_EPSILON_MM = 0.005;

/** Where a place on a run (a leg and a station along it) is after its legs were split or risers made in it. */
type Relocate = (legIndex: number, stationMm: number) => { legIndex: number; stationMm: number };

const stay: Relocate = (legIndex, stationMm) => ({ legIndex, stationMm });

function andThen(first: Relocate, second: Relocate): Relocate {
  return (legIndex, stationMm) => {
    const moved = first(legIndex, stationMm);
    return second(moved.legIndex, moved.stationMm);
  };
}

interface SolvedRun {
  spec: DuctRunSpec;
  /** Where its take-offs' places are now (a straight raised on its own gains legs). */
  relocate: Relocate;
  changed: boolean;
}

function isFlexTail(spec: DuctRunSpec): boolean {
  return spec.end.kind === 'terminal' && spec.end.flex && spec.path.length >= 2;
}

function planVec(point: Point2D): Vec3 {
  return { x: point.x, y: point.y, z: 0 };
}

function isZero(shift: Vec3): boolean {
  return lengthVec3(shift) < MOVE_EPSILON_MM;
}

function portAnchor(port: DuctAirPort): DuctAnchor {
  return { point: { x: port.lip.x, y: port.lip.y }, direction: port.normal, z: port.lip.z };
}

/** One direction (within 0.06°: stored paths are rounded; a unit turned by its placement turns by degrees). */
function sameDirection(a: Point2D, b: Point2D): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < 1e-3;
}

/** Runs ordered from the unit outwards: every parent before its branches. */
function parentsFirst(runs: ReadonlyArray<{ id: string; spec: DuctRunSpec }>): string[] {
  const ids = new Set(runs.map((run) => run.id));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const run of runs) {
    const parentId = ductParentRunId(run.spec);
    if (parentId && ids.has(parentId) && parentId !== run.id) {
      children.set(parentId, [...(children.get(parentId) ?? []), run.id]);
    } else {
      roots.push(run.id);
    }
  }
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    queue.push(...(children.get(id) ?? []));
  }
  // A cycle (a corrupt document) is left last, as it is.
  runs.forEach((run) => { if (!seen.has(run.id)) order.push(run.id); });
  return order;
}

/** Node overrides after a vertex was made after `node` (the later ones shift by one). */
function renumberNodes(overrides: DuctRunSpec['nodeOverrides'], node: number): DuctRunSpec['nodeOverrides'] {
  return Object.fromEntries(Object.entries(overrides).map(([key, value]) => {
    const index = Number(key);
    return [String(index > node ? index + 1 : index), value];
  }));
}

function relocateInline(spec: DuctRunSpec, relocate: Relocate): DuctRunSpec {
  if (!spec.inline?.length) return spec;
  return { ...spec, inline: spec.inline.map((item) => ({ ...item, ...relocate(item.legIndex, item.stationMm) })) };
}

interface Reshaped {
  spec: DuctRunSpec;
  relocate: Relocate;
}

/** Level leg `legIndex` split `stationMm` from its start: a vertex on its line, its section on both parts. */
function splitLeg(spec: DuctRunSpec, legIndex: number, stationMm: number): Reshaped {
  const a = spec.path[legIndex]!;
  const b = spec.path[legIndex + 1]!;
  const t = stationMm / Math.hypot(b.x - a.x, b.y - a.y);
  const at = { ...a, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  const relocate: Relocate = (leg, station) => {
    if (leg < legIndex) return { legIndex: leg, stationMm: station };
    if (leg > legIndex) return { legIndex: leg + 1, stationMm: station };
    return station <= stationMm ? { legIndex: leg, stationMm: station } : { legIndex: leg + 1, stationMm: station - stationMm };
  };
  const next: DuctRunSpec = {
    ...spec,
    path: [...spec.path.slice(0, legIndex + 1), at, ...spec.path.slice(legIndex + 1)],
    legs: [...spec.legs.slice(0, legIndex + 1), { ...spec.legs[legIndex]! }, ...spec.legs.slice(legIndex + 1)],
    nodeOverrides: renumberNodes(spec.nodeOverrides, legIndex),
  };
  return { spec: relocateInline(next, relocate), relocate };
}

/**
 * A zero-length vertical leg made at `vertex` (a riser or drop the move will
 * stretch): the vertex is doubled; later legs and nodes shift by one.
 */
function riserAt(spec: DuctRunSpec, vertex: number, section: DuctLeg): Reshaped {
  const relocate: Relocate = (leg, station) => ({ legIndex: leg >= vertex ? leg + 1 : leg, stationMm: station });
  const next: DuctRunSpec = {
    ...spec,
    path: [...spec.path.slice(0, vertex + 1), { ...spec.path[vertex]! }, ...spec.path.slice(vertex + 1)],
    legs: [...spec.legs.slice(0, vertex), { ...section }, ...spec.legs.slice(vertex)],
    nodeOverrides: renumberNodes(spec.nodeOverrides, vertex),
  };
  return { spec: relocateInline(next, relocate), relocate };
}

interface SegmentPlan {
  spec: DuctRunSpec;
  relocate: Relocate;
  constraints: ElasticConstraint[];
  legOptions: Map<number, ElasticLegOption>;
}

const COLLINEAR_DEG = 2;

function turnDeg(a: Point2D, b: Point2D): number {
  return (Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y))) * 180) / Math.PI;
}

function anchoredStartLabel(spec: DuctRunSpec): string {
  switch (spec.start.kind) {
    case 'unit-port': return 'the unit\'s collar';
    case 'tap': return 'a take-off';
    case 'split-branch': return 'a split';
    case 'spigot': return 'a plenum spigot';
    default: return 'its start';
  }
}

/**
 * How a dragged straight moves: a level straight sideways and up or down (the
 * along-component of the drag is dropped), a riser along its heading.
 *
 * Up or down, it rises on risers made in it: a riser at a plan corner would
 * bend the hard way (DU_HARD_WAY_ELBOW), so where a level neighbour turns, a
 * stub long enough for the corner's elbow and the riser's stays at the old
 * level, and the riser stands at the stub's end; a neighbour running on in
 * line takes the riser at the joint; a riser neighbour simply stretches.
 */
function planSegment(spec: DuctRunSpec, legIndex: number, delta: Vec3, terminalLabel: string | null, settings: DuctDesignSettings): SegmentPlan | string {
  const legs = ductLegs(spec);
  const leg = legs[legIndex];
  const last = legs.length - 1;
  if (!leg) return 'That straight is no longer on the run.';
  if (isFlexTail(spec) && legIndex === last) return 'A flexible runout bends to its terminal: move the terminal, or the straight before it.';
  if (leg.sloped) return 'A sloped leg cannot be moved on its own.';
  if (leg.vertical) {
    const heading = planVec(leg.direction);
    const along = delta.x * heading.x + delta.y * heading.y;
    if (Math.abs(along) < 0.5) return 'A riser moves along its heading: drag it that way.';
    return {
      spec, relocate: stay, legOptions: new Map(),
      constraints: [
        { vertex: legIndex, axis: heading, value: along },
        { vertex: legIndex + 1, axis: heading, value: along },
      ],
    };
  }
  const normal: Vec3 = { x: -leg.direction.y, y: leg.direction.x, z: 0 };
  const side = delta.x * normal.x + delta.y * normal.y;
  const rise = delta.z;
  if (Math.abs(side) < 0.5 && Math.abs(rise) < 0.5) return 'A straight moves sideways (or up and down), not along itself.';
  const anchoredStart = spec.start.kind !== 'open';
  const pinnedEnd = spec.end.kind === 'terminal';
  if (legIndex === 0 && anchoredStart && Math.abs(side) >= 0.5 && spec.start.kind !== 'tap') {
    return `The first straight leaves ${anchoredStartLabel(spec)}: it moves with it. Move the straight after it instead.`;
  }
  if (legIndex === last && pinnedEnd && Math.abs(side) >= 0.5) {
    return `The last straight ends on ${terminalLabel ?? 'its terminal'}: move the terminal, or the straight before it.`;
  }
  let work = spec;
  let relocate = stay;
  let startOps = 0;
  let endOps = 0;
  const legOptions = new Map<number, ElasticLegOption>();
  if (Math.abs(rise) >= 0.5) {
    if (legIndex === 0 && anchoredStart) return `The first straight leaves ${anchoredStartLabel(spec)} at its level: move a straight after it up or down instead.`;
    if (legIndex === last && pinnedEnd) return `The last straight meets ${terminalLabel ?? 'its terminal'} at its spigot: move the straight before it up or down instead.`;
    const up = Math.sign(rise);
    const section = spec.legs[legIndex]!;
    // Room for a square-throat elbow (W/2 + neck) at the corner and the riser's (H/2 + neck, bent the easy way), plus a margin.
    const riserRoom = (section.diameterMm ?? section.heightMm) / 2 + settings.elbowNeckMm;
    const stubFor = (corner: DuctLeg) => Math.max(150, (corner.diameterMm ?? corner.widthMm) / 2 + settings.elbowNeckMm + riserRoom + 50);
    const previous = legs[legIndex - 1];
    const next = legs[legIndex + 1];
    const flexAfter = isFlexTail(spec) && legIndex + 1 === last;
    let startStub = 0;
    let endStub = 0;
    if (previous && !previous.vertical) {
      if (turnDeg(previous.direction, leg.direction) < COLLINEAR_DEG) startOps = 1;
      else { startOps = 2; startStub = stubFor(spec.legs[legIndex - 1]!); }
    }
    if (next && !next.vertical && !flexAfter) {
      if (turnDeg(leg.direction, next.direction) < COLLINEAR_DEG) endOps = 1;
      else { endOps = 2; endStub = stubFor(section); }
    }
    if (leg.lengthMm < startStub + endStub + 100) {
      return `This straight is too short to rise on its own (its elbows need ${Math.round(startStub + endStub + 100)} mm): move a longer straight, or the run with its unit.`;
    }
    // The end side first (the higher index), so the start side's index is still the old one.
    const apply = (step: Reshaped) => { work = step.spec; relocate = andThen(relocate, step.relocate); };
    if (endOps === 2) apply(splitLeg(work, legIndex, leg.lengthMm - endStub));
    if (endOps > 0) apply(riserAt(work, legIndex + 1, section));
    if (startOps === 2) apply(splitLeg(work, legIndex, startStub));
    if (startOps === 2) apply(riserAt(work, legIndex + 1, section));
    if (startOps === 1) apply(riserAt(work, legIndex, section));
    const middle = legIndex + startOps;
    if (startOps > 0) legOptions.set(middle - 1, { direction: { x: 0, y: 0, z: up } });
    if (endOps > 0) legOptions.set(middle + 1, { direction: { x: 0, y: 0, z: -up } });
  }
  const middle = legIndex + startOps;
  const constraints: ElasticConstraint[] = [];
  // The whole straight (its stubs too) moves sideways; the part between its risers moves up or down.
  for (let vertex = legIndex; vertex <= legIndex + 1 + startOps + endOps; vertex += 1) constraints.push({ vertex, axis: normal, value: side });
  for (const vertex of [middle, middle + 1]) constraints.push({ vertex, axis: AXES3[2]!, value: rise });
  return { spec: work, relocate, constraints, legOptions };
}

/** Accessories in a run's straights keep their place along their leg as the run would like them to. */
function shiftInline(spec: DuctRunSpec, before: DuctRunSpec, shifts: readonly Vec3[], desire: Vec3): DuctRunSpec {
  if (!spec.inline?.length) return spec;
  const legs = ductLegs(spec);
  const oldLegs = ductLegs(before);
  const inline = spec.inline.map((item) => {
    const leg = legs[item.legIndex];
    const old = oldLegs[item.legIndex];
    if (!leg || !old) return item;
    const u: Vec3 = old.vertical ? { x: 0, y: 0, z: old.vertical } : planVec(old.direction);
    const shift = shifts[item.legIndex] ?? ZERO3;
    const station = item.stationMm + dotVec3(subVec3(desire, shift), u);
    const clamped = Math.round(Math.min(leg.lengthMm, Math.max(0, station)) * 10) / 10;
    return clamped === item.stationMm ? item : { ...item, stationMm: clamped };
  });
  return { ...spec, inline };
}

export function moveDuctNetwork(input: DuctNetworkMoveInput): DuctNetworkMoveResult {
  const { before, after, settings, movedEquipmentIds, runIds, delta } = input;
  const byId = new Map(after.map((element) => [element.id, element]));
  const runs: Array<{ id: string; element: HvacElement; spec: DuctRunSpec }> = [];
  for (const element of after) {
    if (!isDuctElement(element)) continue;
    const spec = readDuctRunSpec(element);
    if (spec) runs.push({ id: element.id, element, spec });
  }
  const runById = new Map(runs.map((run) => [run.id, run]));
  const solved = new Map<string, SolvedRun>();
  const outcomes = new Map<string, DuctRunMoveOutcome>();
  const changedRuns: HvacElement[] = [];
  const messages: string[] = [];
  let segmentRefused: string | null = null;
  const segment = input.segment && runById.has(input.segment.runId) ? input.segment : null;
  const labelOf = (id: string) => byId.get(id)?.label || id;

  const terminalShift = (terminalId: string, portId: string): Vec3 => {
    if (!movedEquipmentIds.has(terminalId)) return ZERO3;
    const from = findTerminalPort(before, terminalId, portId);
    const to = findTerminalPort(after, terminalId, portId);
    return from && to ? subVec3(to.lip, from.lip) : ZERO3;
  };

  const record = (id: string, element: HvacElement, spec: DuctRunSpec, next: DuctRunSpec, relocate: Relocate, outcome: DuctRunMoveOutcome) => {
    const changed = next !== spec && JSON.stringify(next) !== JSON.stringify(spec);
    solved.set(id, { spec: next, relocate, changed });
    if (!changed) return;
    changedRuns.push(ductRunElementWithSpec(element, next));
    outcomes.set(id, outcome);
    if (outcome.note) messages.push(`${labelOf(id)} ${outcome.note}`);
  };

  const collarShift = (start: Extract<DuctRunSpec['start'], { kind: 'unit-port' }>): Vec3 | null => {
    if (!movedEquipmentIds.has(start.unitId)) return ZERO3;
    const from = findAirPort(before, start.unitId, start.portId);
    const to = findAirPort(after, start.unitId, start.portId);
    if (!from || !to) return ZERO3;
    return sameDirection(from.normal, to.normal) ? subVec3(to.lip, from.lip) : null;
  };

  // A system nobody drags still moves rigidly when everything it is fixed to — its unit's collar and every
  // terminal it serves — moves by one vector (a unit and its diffusers moved, the ducts between them not picked).
  const rootOf = (id: string): string => {
    let current = id;
    const seen = new Set<string>([id]);
    for (;;) {
      const parentId = ductParentRunId(runById.get(current)!.spec);
      if (!parentId || !runById.has(parentId) || seen.has(parentId)) return current;
      seen.add(parentId);
      current = parentId;
    }
  };
  const anchorsByRoot = new Map<string, Array<Vec3 | null>>();
  for (const run of runs) {
    const root = rootOf(run.id);
    const anchors = anchorsByRoot.get(root) ?? [];
    if (run.id === root && run.spec.start.kind === 'unit-port') anchors.push(collarShift(run.spec.start));
    if (run.spec.end.kind === 'terminal') anchors.push(terminalShift(run.spec.end.terminalId, run.spec.end.portId));
    anchorsByRoot.set(root, anchors);
  }
  const systemShift = new Map<string, Vec3>();
  for (const [root, anchors] of anchorsByRoot) {
    const first = anchors[0];
    if (!first || isZero(first) || anchors.some((anchor) => !anchor || lengthVec3(subVec3(anchor, first)) > 0.5)) continue;
    systemShift.set(root, first);
  }

  /** Rigidly about its new anchor (a turned unit or parent), its flexible runout still ending on its terminal. */
  const rigid = (spec: DuctRunSpec, from: DuctAnchor, to: DuctAnchor): DuctRunSpec => {
    const moved = rigidTransformSpec(spec, from, to);
    if (!isFlexTail(spec) || spec.end.kind !== 'terminal') return moved;
    const lip = spec.path[spec.path.length - 1]!;
    const shift = terminalShift(spec.end.terminalId, spec.end.portId);
    return { ...moved, path: [...moved.path.slice(0, -1), { ...lip, x: lip.x + shift.x, y: lip.y + shift.y, z: lip.z + shift.z }] };
  };

  for (const id of parentsFirst(runs)) {
    const { element, spec } = runById.get(id)!;
    const selected = runIds.has(id);
    const desire = selected ? delta : systemShift.get(rootOf(id)) ?? ZERO3;
    const kind: DuctRunMoveOutcome['kind'] = selected || segment?.runId === id ? 'moved' : 'follows';
    if (spec.legacy) {
      // The old straight stubs only translate when moved themselves.
      const next = selected && !isZero(delta)
        ? { ...spec, path: spec.path.map((point) => ({ ...point, x: point.x + delta.x, y: point.y + delta.y, z: point.z + delta.z })) }
        : spec;
      record(id, element, spec, next, stay, { kind });
      continue;
    }

    // ---- The start: what it leaves from. ----
    const constraints: ElasticConstraint[] = [];
    const bounds: ElasticBound[] = [];
    /** A take-off's slide along its parent's wall: the wall's direction, how its place moved with the parent, the straight's length. */
    let slide: { axis: Vec3; base: Vec3; legLengthMm: number } | null = null;
    /** How far its start moves with what it leaves from (an open start: with the drag). */
    let startShift: Vec3 = desire;
    let base = spec;
    let rigidAbout: { from: DuctAnchor; to: DuctAnchor } | null = null;
    const start = spec.start;
    if (start.kind === 'unit-port') {
      const shift = collarShift(start);
      if (shift) {
        startShift = shift;
        constraints.push(...pinVertex(0, shift));
      } else {
        // The unit turned: the run turns with it about its collar.
        const from = findAirPort(before, start.unitId, start.portId)!;
        const to = findAirPort(after, start.unitId, start.portId)!;
        rigidAbout = { from: portAnchor(from), to: portAnchor(to) };
      }
    } else if (start.kind === 'tap' || start.kind === 'split-branch' || start.kind === 'spigot') {
      const parent = solved.get(start.parentRunId);
      const parentSpec = parent?.spec ?? runById.get(start.parentRunId)?.spec ?? null;
      if (parent && start.kind === 'tap') {
        // Its parent's straight may have been split by risers made in it: the take-off's place on the new legs.
        const place = parent.relocate(start.legIndex, start.stationMm);
        if (place.legIndex !== start.legIndex || place.stationMm !== start.stationMm) base = { ...spec, start: { ...start, ...place } };
      }
      const from = startAnchor(base);
      const to = parentSpec ? branchAnchor(parentSpec, base, settings) : null;
      if (!from || !to || !parentSpec) {
        startShift = ZERO3;
        constraints.push(...pinVertex(0, ZERO3));
      } else if (!sameDirection(from.direction, to.direction)) {
        rigidAbout = { from, to };
      } else {
        const shift: Vec3 = { x: to.point.x - from.point.x, y: to.point.y - from.point.y, z: to.z - from.z };
        startShift = shift;
        const tapStart = base.start;
        const parentLeg = tapStart.kind === 'tap' ? ductLegs(parentSpec)[tapStart.legIndex] : undefined;
        if (tapStart.kind === 'tap' && parentLeg && !parentLeg.vertical) {
          // Square to the wall and in level it moves with the parent; along the wall it may slide (within the straight).
          const axis = planVec(parentLeg.direction);
          const normal: Vec3 = { x: -axis.y, y: axis.x, z: 0 };
          constraints.push({ vertex: 0, axis: normal, value: dotVec3(shift, normal) }, { vertex: 0, axis: AXES3[2]!, value: shift.z });
          const along = dotVec3(shift, axis);
          bounds.push({ vertex: 0, axis, min: along - tapStart.stationMm, max: along + parentLeg.lengthMm - tapStart.stationMm });
          slide = { axis, base: shift, legLengthMm: parentLeg.lengthMm };
        } else {
          constraints.push(...pinVertex(0, shift));
        }
      }
    }

    // ---- A turned unit or parent: the run turns with it, rigidly. ----
    if (rigidAbout) {
      record(id, element, spec, rigid(base, rigidAbout.from, rigidAbout.to), stay, { kind });
      continue;
    }
    /** The take-off's new station: its start moved `startMoved`, its place on the wall moved `slide.base`. */
    const slid = (next: DuctRunSpec, startMoved: Vec3): DuctRunSpec => {
      if (!slide || next.start.kind !== 'tap') return next;
      const along = dotVec3(subVec3(startMoved, slide.base), slide.axis);
      if (Math.abs(along) <= MOVE_EPSILON_MM) return next;
      const station = Math.min(slide.legLengthMm, Math.max(0, next.start.stationMm + along));
      return { ...next, start: { ...next.start, stationMm: Math.round(station * 10) / 10 } };
    };

    // ---- The end: the terminal it serves. ----
    let endPin: ElasticConstraint[] = [];
    const end = spec.end;
    const terminalLabel = end.kind === 'terminal' ? labelOf(end.terminalId) : null;
    if (end.kind === 'terminal') endPin = pinVertex(spec.path.length - 1, terminalShift(end.terminalId, end.portId));

    // ---- A straight dragged on its own. ----
    let work = base;
    let relocate = stay;
    let segmentConstraints: ElasticConstraint[] = [];
    let legOptions = new Map<number, ElasticLegOption>();
    if (segment?.runId === id) {
      const planned = planSegment(base, segment.legIndex, delta, terminalLabel, settings);
      if (typeof planned === 'string') {
        segmentRefused = planned;
      } else {
        work = planned.spec;
        relocate = planned.relocate;
        segmentConstraints = planned.constraints;
        legOptions = planned.legOptions;
        // The end's vertex moved up the path by the risers made.
        if (end.kind === 'terminal') endPin = pinVertex(work.path.length - 1, terminalShift(end.terminalId, end.portId));
      }
    }

    // Nothing it is fixed to moved, nobody drags it, and its take-off is still on its straight.
    const nothingAsked = !selected && segmentConstraints.length === 0
      && [...constraints, ...endPin].every((constraint) => Math.abs(constraint.value) < MOVE_EPSILON_MM)
      && bounds.every((bound) => (bound.min ?? 0) <= MOVE_EPSILON_MM && (bound.max ?? 0) >= -MOVE_EPSILON_MM);
    if (nothingAsked) {
      // It stays where it is; a take-off whose straight moved under it keeps its place in the room.
      record(id, element, spec, slid(base, ZERO3), stay, { kind });
      continue;
    }

    const solve = (fixed: readonly ElasticConstraint[], pulls?: Parameters<typeof solveElasticRun>[0]['pulls']) => {
      const flex = isFlexTail(work);
      const legs = work.legs.map((_, index): ElasticLegOption => ({
        ...(legOptions.get(index) ?? {}),
        ...(flex && index === work.legs.length - 1 ? { flex: true } : {}),
      }));
      return solveElasticRun({ path: work.path, legs, constraints: fixed, bounds, desire, ...(pulls ? { pulls } : {}) });
    };
    let note: string | undefined;
    let result = solve([...constraints, ...endPin, ...segmentConstraints]);
    if (!result.ok && segmentConstraints.length) {
      segmentRefused = 'That straight cannot move that way: the legs either side of it do not run that way.';
      work = base;
      relocate = stay;
      segmentConstraints = [];
      legOptions = new Map();
      if (end.kind === 'terminal') endPin = pinVertex(work.path.length - 1, terminalShift(end.terminalId, end.portId));
      result = solve([...constraints, ...endPin]);
    }
    if (!result.ok && endPin.length) {
      // Its legs cannot reach the terminal from where its start now is: keep the start, the end reaching as near it as it can.
      const reach = { x: endPin[0]!.value, y: endPin[1]!.value, z: endPin[2]!.value };
      result = solve([...constraints, ...segmentConstraints], [{ vertex: work.path.length - 1, shift: reach, weight: 1e3 }]);
      if (result.ok) note = `no longer reaches ${terminalLabel ?? 'its terminal'}: re-route its runout.`;
    }
    if (!result.ok) {
      // Nothing elastic fits (a corrupt run): it moves whole with its start.
      const path = work.path.map((point) => ({ ...point, x: point.x + startShift.x, y: point.y + startShift.y, z: point.z + startShift.z }));
      record(id, element, spec, slid({ ...work, path }, startShift), relocate, { kind, note: 'moved whole: re-route it.' });
      continue;
    }

    // ---- The new run: its path, its take-off's place on the wall, its accessories. ----
    const next = shiftInline(slid({ ...work, path: result.path }, result.shifts[0]!), work, result.shifts, desire);
    if (result.shortest.length && !note && kind === 'follows') {
      const legs = result.shortest.map((leg) => leg + 1).join(', ');
      note = `was pushed along: leg ${legs} is at its shortest.`;
    }
    record(id, element, spec, next, relocate, { kind, ...(note ? { note } : {}) });
  }
  return { runs: changedRuns, outcomes, segmentRefused, messages };
}
