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
 *
 * A turn (the selection rotated about the vertical axis):
 * - a system whose unit and terminals all turn as one block turns rigidly;
 * - a run on a turned collar leaves it square and rejoins its own route: the
 *   re-aims that make no detour first, then a route round the unit onto its old
 *   line before its first take-off (the rest of the system unchanged), then a
 *   stub off the collar that the route stretches to meet; where none fits it
 *   turns rigidly about the collar, and says so;
 * - a flexible runout re-curves to a turned spigot; a rigid one is re-aimed
 *   onto it, or says it meets it at an angle.
 */
import type { HvacElement, Point2D } from '../../../../types';
import { findAirPort, type DuctAirPort } from '../duct/ductAirPorts';
import { errorCodes, noNewErrors, reaimFromCollar, reaimRunEnd } from '../duct/ductBranchReaim';
import {
  collarReserveMm,
  ductClash,
  elbowRoomMm,
  footprintOf,
  planObstacles,
  rerouteFromCollar,
  routeCostMm,
  runClashes,
  runObstacles,
  runOutline,
  type PlanObstacle,
} from '../duct/ductCollarReroute';
import { getDuctRunPlan, planDuctRunSpec } from '../duct/ductFabricationPlanner';
import { branchAnchor, ductRunElementWithSpec, rigidTransformSpec, startAnchor, type DuctAnchor } from '../duct/ductFollow';
import { ductLegs } from '../duct/ductGeometry';
import { ductBranchesOf } from '../duct/ductNetwork';
import type { DuctDesignSettings } from '../duct/ductSettings';
import { findTerminalPort } from '../duct/ductTerminals';
import { ductParentRunId, isDuctElement, readDuctRunSpec, type DuctLeg, type DuctPoint3, type DuctRunSpec } from '../duct/ductTypes';

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
  /**
   * The moved equipment turned about the vertical axis (degrees, clockwise on
   * the plan); `pivot`: they turned as one block about it (null: each about its
   * own centre). `delta` is then zero.
   */
  turn?: { angleDeg: number; pivot: Point2D | null } | null;
  /**
   * One straight given a length (mm): its run re-solved with it fixed, every
   * end kept, the change taken up downstream first (by straights running the
   * same way and flexible runouts); its branches follow. Nothing moves.
   */
  legLength?: { runId: string; legIndex: number; lengthMm: number } | null;
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
  /** Notes worth showing (a run that no longer reaches its terminal, …), and what a turn did (below). */
  messages: string[];
  /** What a turn did that is worth saying but needs nothing from the designer (a run re-routed round its unit). */
  infos: string[];
  /** Why the straight cannot take the length asked (nothing is changed then). */
  legLengthRefused?: string | null;
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

/** A plan point turned `angleDeg` (clockwise on the plan, as an element's rotation) about `pivot`. */
export function turnPoint(point: Point2D, pivot: Point2D, angleDeg: number): Point2D {
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const x = point.x - pivot.x;
  const y = point.y - pivot.y;
  return { x: pivot.x + x * cos - y * sin, y: pivot.y + x * sin + y * cos };
}

/**
 * Whether a re-aim's new corners (`prefix`, the collar's lip first), with the
 * run's old legs it keeps from `keepFrom` on, clash with nothing: what stands
 * at the duct's level (its branches included), its own kept legs, and the
 * casing past the first leg (which leaves the casing's face).
 */
function clearOfClashes(spec: DuctRunSpec, runId: string, unitId: string, casing: readonly Point2D[], obstacles: readonly PlanObstacle[]) {
  const first = spec.legs[0]!;
  const half = (first.diameterMm ?? first.widthMm) / 2 + spec.insulationThicknessMm;
  const zMin = spec.path[0]!.z;
  const zMax = zMin + (first.diameterMm ?? first.heightMm) + 2 * spec.insulationThicknessMm;
  const outline: PlanObstacle = { ownerId: unitId, shape: { kind: 'outline', corners: casing }, zMin, zMax };
  return (prefix: readonly Point2D[], keepFrom: number): boolean => {
    const kept = runObstacles(runId, spec, keepFrom);
    for (let index = 0; index + 1 < prefix.length; index += 1) {
      const against = index === 0 ? [...obstacles, ...kept] : [...obstacles, outline, ...kept];
      if (ductClash(prefix[index]!, prefix[index + 1]!, half, zMin, zMax, against)) return false;
    }
    return true;
  };
}

interface RunRef {
  id: string;
  spec: DuctRunSpec;
}

/** Each run's system root: the run on the unit's collar (or the free run) its branch tree hangs off. */
function systemRoots(runs: readonly RunRef[]): (id: string) => string {
  const byId = new Map(runs.map((run) => [run.id, run]));
  return (id) => {
    let current = id;
    const seen = new Set<string>([id]);
    for (;;) {
      const parentId = ductParentRunId(byId.get(current)!.spec);
      if (!parentId || !byId.has(parentId) || seen.has(parentId)) return current;
      seen.add(parentId);
      current = parentId;
    }
  };
}

/** What each system is fixed to (its collar's unit and every terminal it serves), by root. */
function systemAnchors(runs: readonly RunRef[], rootOf: (id: string) => string): Map<string, { ids: string[]; terminals: string[] }> {
  const anchors = new Map<string, { ids: string[]; terminals: string[] }>();
  for (const run of runs) {
    const root = rootOf(run.id);
    const entry = anchors.get(root) ?? { ids: [], terminals: [] };
    if (run.id === root && run.spec.start.kind === 'unit-port') entry.ids.push(run.spec.start.unitId);
    if (run.spec.end.kind === 'terminal') {
      entry.ids.push(run.spec.end.terminalId);
      entry.terminals.push(run.spec.end.terminalId);
    }
    anchors.set(root, entry);
  }
  return anchors;
}

function readRuns(scene: readonly HvacElement[]): Array<RunRef & { element: HvacElement }> {
  return scene.flatMap((element) => {
    if (!isDuctElement(element)) return [];
    const spec = readDuctRunSpec(element);
    return spec ? [{ id: element.id, element, spec }] : [];
  });
}

/**
 * The air terminals whose whole duct system turns with a block: everything
 * the system is fixed to (its unit's collar, every terminal it serves) turns.
 * Their spigots turn with them (their runouts turn too).
 */
export function terminalsTurnedWhole(scene: readonly HvacElement[], turnedIds: ReadonlySet<string>): Set<string> {
  const runs = readRuns(scene);
  const out = new Set<string>();
  for (const { ids, terminals } of systemAnchors(runs, systemRoots(runs)).values()) {
    if (ids.length && ids.every((id) => turnedIds.has(id))) terminals.forEach((id) => out.add(id));
  }
  return out;
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

/** What holds a run's start, in a sentence ("its collar", "its take-off"). */
function startHeldBy(spec: DuctRunSpec): string {
  switch (spec.start.kind) {
    case 'unit-port': return 'its collar';
    case 'tap': return 'its take-off';
    case 'split-branch': return 'its split';
    case 'spigot': return 'its plenum spigot';
    default: return 'its start';
  }
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

/** The run with a first straight from `lip` (a stub off a turned collar): later legs, nodes and accessories shift by one. */
function prependStub(spec: DuctRunSpec, lip: DuctPoint3): DuctRunSpec {
  const { inline, ...rest } = spec;
  return {
    ...rest,
    path: [lip, ...spec.path],
    legs: [spec.legs[0]!, ...spec.legs],
    nodeOverrides: Object.fromEntries(Object.entries(spec.nodeOverrides).map(([node, override]) => [String(Number(node) + 1), override])),
    ...(inline?.length ? { inline: inline.map((item) => ({ ...item, legIndex: item.legIndex + 1 })) } : {}),
  };
}

const nextLeg: Relocate = (legIndex, stationMm) => ({ legIndex: legIndex + 1, stationMm });

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
  const turn = input.turn && Math.abs(input.turn.angleDeg) > 1e-9 ? input.turn : null;
  const byId = new Map(after.map((element) => [element.id, element]));
  const runs = readRuns(after);
  const runById = new Map(runs.map((run) => [run.id, run]));
  const solved = new Map<string, SolvedRun>();
  const outcomes = new Map<string, DuctRunMoveOutcome>();
  const changedRuns: HvacElement[] = [];
  const messages: string[] = [];
  let segmentRefused: string | null = null;
  const segment = input.segment && runById.has(input.segment.runId) ? input.segment : null;
  const labelOf = (id: string) => byId.get(id)?.label || id;
  /** A run as the designer knows it: its own label, or (a generic "Supply duct") the terminal it serves. */
  const runName = (id: string, spec: DuctRunSpec): string => {
    const label = byId.get(id)?.label?.trim() ?? '';
    if (label && !/^(supply|return) duct$/i.test(label)) return label;
    if (spec.end.kind === 'terminal') return `The run to ${labelOf(spec.end.terminalId)}`;
    return spec.start.kind === 'unit-port' ? `The ${spec.service} trunk` : `A ${spec.service} branch`;
  };

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
    if (outcome.note) {
      const name = runName(id, spec);
      const terminal = spec.end.kind === 'terminal' ? labelOf(spec.end.terminalId) : null;
      // "The run to SAD-2 can no longer reach it", not "… no longer reaches SAD-2".
      const note = terminal && name === `The run to ${terminal}` ? outcome.note.replace(`no longer reaches ${terminal}`, 'can no longer reach it') : outcome.note;
      messages.push(`${name} ${note}`);
    }
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
  const rootOf = systemRoots(runs);
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
  // ... and turns rigidly when all of it turns as one block.
  const turnedWhole = new Set<string>();
  if (turn?.pivot) {
    for (const [root, { ids }] of systemAnchors(runs, rootOf)) if (ids.length && ids.every((anchorId) => movedEquipmentIds.has(anchorId))) turnedWhole.add(root);
  }
  /** The drawing as it now stands: the moved equipment and the runs solved so far. */
  const sceneNow = (): HvacElement[] => {
    const changed = new Map(changedRuns.map((run) => [run.id, run]));
    return after.map((element) => changed.get(element.id) ?? element);
  };
  /** Outlines of the runs re-routed off each turned unit so far (the next one keeps clear of them). */
  const reroutedOff = new Map<string, Point2D[][]>();
  /** What a turn did that is worth saying (not left for the designer). */
  const infos: string[] = [];
  const unitName = (id: string): string => {
    const unit = byId.get(id);
    const tag = unit?.properties.airSystemTag;
    return typeof tag === 'string' && tag.trim() ? tag.trim() : unit?.label?.replace(/\s*\(3D\)$/i, '') || 'the unit';
  };

  /**
   * A run on a turned collar: re-aimed (no detour) or re-routed round the unit
   * onto its own route; else a stub off the collar for the route to stretch to;
   * null when not even that fits (more than a quarter turn).
   */
  const turnCollar = (
    id: string, element: HvacElement, spec: DuctRunSpec, start: Extract<DuctRunSpec['start'], { kind: 'unit-port' }>, from: DuctAirPort, to: DuctAirPort,
  ): { kind: 'reaimed'; spec: DuctRunSpec; relocate: Relocate } | { kind: 'stub'; lip: DuctPoint3; shift: Vec3 } | null => {
    const unit = byId.get(start.unitId);
    if (!unit || spec.path.length < 2) return null;
    const anchor: DuctAnchor = { point: { x: to.lip.x, y: to.lip.y }, direction: to.normal, z: spec.path[0]!.z + (to.lip.z - from.lip.z) };
    const casing = footprintOf(unit);
    const first = spec.legs[0]!;
    const scene = sceneNow();
    const reserve = collarReserveMm(spec, scene, settings);
    const remember = (next: DuctRunSpec) => reroutedOff.set(start.unitId, [...(reroutedOff.get(start.unitId) ?? []), ...runOutline(next)]);
    const clear = clearOfClashes(spec, id, start.unitId, casing, planObstacles(scene, new Set([id, start.unitId])));
    // A re-aim onto the route as it runs (no detour), or a route round the unit onto its old line: the cheaper to make.
    const exact = reaimFromCollar(scene, before, settings, element, spec, anchor, { collarMm: reserve, clear });
    const routed = rerouteFromCollar({ scene, baseline: before, settings, run: element, spec, to: anchor, unit: casing, avoid: reroutedOff.get(start.unitId) ?? [] });
    if (exact && (!routed || routeCostMm(exact.spec) <= routeCostMm(routed.spec))) {
      infos.push(`${runName(id, spec)} leaves the turned collar and rejoins its route.`);
      remember(exact.spec);
      return { kind: 'reaimed', spec: exact.spec, relocate: (legIndex, stationMm) => ({ legIndex: exact.legOf(legIndex) ?? legIndex, stationMm }) };
    }
    if (routed) {
      infos.push(`${runName(id, spec)} leaves the turned collar and rejoins its route round ${unitName(start.unitId)} (${routed.elbows} new elbow${routed.elbows === 1 ? '' : 's'}).`);
      remember(routed.spec);
      return { kind: 'reaimed', spec: routed.spec, relocate: routed.relocate };
    }
    // A stub square off the collar, one elbow onto the route's first heading: the route stretches to meet its end.
    const lead = ductLegs(spec)[0]!;
    if (lead.vertical || lead.sloped) return null;
    const cos = to.normal.x * lead.direction.x + to.normal.y * lead.direction.y;
    if (cos < -1e-6) return null;
    const angle = (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
    const reach = reserve + elbowRoomMm(first, angle, settings) + 50;
    const lip: DuctPoint3 = { x: anchor.point.x, y: anchor.point.y, z: anchor.z };
    const origin = spec.path[0]!;
    infos.push(`${runName(id, spec)} leaves the turned collar at a new elbow; its route shifts to meet it.`);
    return { kind: 'stub', lip, shift: { x: lip.x + to.normal.x * reach - origin.x, y: lip.y + to.normal.y * reach - origin.y, z: anchor.z - origin.z } };
  };

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
    if (turn?.pivot && turnedWhole.has(rootOf(id))) {
      // Turned with its whole system, as one block.
      const pivot = turn.pivot;
      record(id, element, spec, { ...spec, path: spec.path.map((point) => ({ ...point, ...turnPoint(point, pivot, turn.angleDeg) })) }, stay, { kind });
      continue;
    }
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
    /** Where places on the run's legs are on `base` (a re-routed start drops or adds legs). */
    let baseRelocate: Relocate = stay;
    let rigidAbout: { from: DuctAnchor; to: DuctAnchor } | null = null;
    /** A stub made off a turned collar: its lip (put before the solved run) and the collar's turn (the fallback). */
    let collarStub: { lip: DuctPoint3; from: DuctAnchor; to: DuctAnchor } | null = null;
    let turnNote: string | undefined;
    const start = spec.start;
    if (start.kind === 'unit-port') {
      const shift = collarShift(start);
      if (shift) {
        startShift = shift;
        constraints.push(...pinVertex(0, shift));
      } else {
        const from = findAirPort(before, start.unitId, start.portId)!;
        const to = findAirPort(after, start.unitId, start.portId)!;
        const turned = turn && !spec.legacy ? turnCollar(id, element, spec, start, from, to) : null;
        if (turned?.kind === 'reaimed') {
          base = turned.spec;
          baseRelocate = turned.relocate;
          startShift = ZERO3;
          constraints.push(...pinVertex(0, ZERO3));
        } else if (turned?.kind === 'stub') {
          collarStub = { lip: turned.lip, from: portAnchor(from), to: portAnchor(to) };
          startShift = turned.shift;
          constraints.push(...pinVertex(0, turned.shift));
        } else {
          // The unit turned (by its placement, or with no way round it): the run turns with it about its collar.
          rigidAbout = { from: portAnchor(from), to: portAnchor(to) };
          if (turn) turnNote = 'turned with its unit: re-route it, or re-design it with Auto duct.';
        }
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
      record(id, element, spec, rigid(base, rigidAbout.from, rigidAbout.to), stay, { kind, ...(turnNote ? { note: turnNote } : {}) });
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
    let endShift = end.kind === 'terminal' ? terminalShift(end.terminalId, end.portId) : ZERO3;
    let endNote: string | undefined;
    if (turn && end.kind === 'terminal' && !end.flex && movedEquipmentIds.has(end.terminalId)) {
      // A rigid end on a turned spigot: re-aimed onto it, or left meeting it at an angle.
      const was = findTerminalPort(before, end.terminalId, end.portId);
      const now = findTerminalPort(after, end.terminalId, end.portId);
      if (was && now && !sameDirection(was.normal, now.normal)) {
        const last = base.path.length - 1;
        const reaimed = reaimRunEnd(sceneNow(), before, settings, element, base, {
          point: { x: now.lip.x, y: now.lip.y }, direction: now.normal, z: base.path[last]!.z + (now.lip.z - was.lip.z),
        });
        if (reaimed) {
          base = reaimed.spec;
          endShift = ZERO3;
          infos.push(`${runName(id, spec)} is re-aimed onto ${terminalLabel}'s turned spigot.`);
        } else {
          endNote = `meets ${terminalLabel}'s turned spigot at an angle: re-route its last straight.`;
        }
      }
    }
    if (end.kind === 'terminal') endPin = pinVertex(base.path.length - 1, endShift);

    // ---- A straight dragged on its own. ----
    let work = base;
    let relocate = baseRelocate;
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
        if (end.kind === 'terminal') endPin = pinVertex(work.path.length - 1, endShift);
      }
    }

    // Nothing it is fixed to moved, nobody drags it, and its take-off is still on its straight.
    // A straight given a length: fixed in the solve, the vertices before it held so the change goes downstream first.
    const sizing = input.legLength?.runId === id ? input.legLength : null;
    const nothingAsked = !sizing && !selected && segmentConstraints.length === 0
      && [...constraints, ...endPin].every((constraint) => Math.abs(constraint.value) < MOVE_EPSILON_MM)
      && bounds.every((bound) => (bound.min ?? 0) <= MOVE_EPSILON_MM && (bound.max ?? 0) >= -MOVE_EPSILON_MM);
    if (nothingAsked) {
      // It stays where it is; a take-off whose straight moved under it keeps its place in the room.
      record(id, element, spec, slid(base, ZERO3), baseRelocate, { kind, ...(endNote ? { note: endNote } : {}) });
      continue;
    }

    const held = sizing ? Array.from({ length: sizing.legIndex + 1 }, (_, vertex) => ({ vertex, shift: ZERO3, weight: 1e3 })) : [];
    const solve = (fixed: readonly ElasticConstraint[], pulls?: Parameters<typeof solveElasticRun>[0]['pulls']) => {
      const flex = isFlexTail(work);
      const legs = work.legs.map((_, index): ElasticLegOption => ({
        ...(legOptions.get(index) ?? {}),
        ...(flex && index === work.legs.length - 1 ? { flex: true } : {}),
      }));
      const allPulls = [...held, ...(pulls ?? [])];
      return solveElasticRun({
        path: work.path, legs, constraints: fixed, bounds, desire, ...(allPulls.length ? { pulls: allPulls } : {}),
        ...(sizing ? { legLengths: [{ leg: sizing.legIndex, lengthMm: sizing.lengthMm }] } : {}),
      });
    };
    let note: string | undefined = endNote;
    let result = solve([...constraints, ...endPin, ...segmentConstraints]);
    if (!result.ok && sizing) {
      // Nothing can give: the whole edit is refused (no end may come off what it is fixed to).
      return {
        runs: [], outcomes: new Map(), segmentRefused: null, messages: [], infos: [],
        legLengthRefused: `${runName(id, spec)} is held at ${startHeldBy(spec)} and ${end.kind === 'terminal' ? `${terminalLabel ?? 'its terminal'}'s spigot` : 'its end'}, and no other straight can give way: move ${end.kind === 'terminal' ? terminalLabel ?? 'its terminal' : 'its end'}, or change a straight that runs the same way.`,
      };
    }
    if (!result.ok && segmentConstraints.length) {
      segmentRefused = 'That straight cannot move that way: the legs either side of it do not run that way.';
      work = base;
      relocate = baseRelocate;
      segmentConstraints = [];
      legOptions = new Map();
      if (end.kind === 'terminal') endPin = pinVertex(work.path.length - 1, endShift);
      result = solve([...constraints, ...endPin]);
    }
    if (!result.ok && endPin.length) {
      // Its legs cannot reach the terminal from where its start now is: keep the start, the end reaching as near it as it can.
      const reach = { x: endPin[0]!.value, y: endPin[1]!.value, z: endPin[2]!.value };
      result = solve([...constraints, ...segmentConstraints], [{ vertex: work.path.length - 1, shift: reach, weight: 1e3 }]);
      if (result.ok) note = `no longer reaches ${terminalLabel ?? 'its terminal'}: re-route its runout.`;
    }
    if (!result.ok && collarStub) {
      // The route cannot stretch to the stub: the run turns with its unit about its collar.
      record(id, element, spec, rigid(base, collarStub.from, collarStub.to), stay, { kind, note: 'turned with its unit: re-route it, or re-design it with Auto duct.' });
      continue;
    }
    if (!result.ok) {
      // Nothing elastic fits (a corrupt run): it moves whole with its start.
      const path = work.path.map((point) => ({ ...point, x: point.x + startShift.x, y: point.y + startShift.y, z: point.z + startShift.z }));
      record(id, element, spec, slid({ ...work, path }, startShift), relocate, { kind, note: 'moved whole: re-route it.' });
      continue;
    }

    // ---- The new run: its path, its take-off's place on the wall, its accessories (after a turned collar's stub). ----
    let next = shiftInline(slid({ ...work, path: result.path }, result.shifts[0]!), work, result.shifts, desire);
    if (collarStub) {
      next = prependStub(next, collarStub.lip);
      relocate = andThen(relocate, nextLeg);
      // The route stretched to the stub must still make a run: no rule it did not break before, nothing it now runs
      // into (the turned casing past its first leg, terminals, other runs, itself). Else it turns with its unit.
      const unitId = (spec.start as Extract<DuctRunSpec['start'], { kind: 'unit-port' }>).unitId;
      const scene = sceneNow();
      const children = ductBranchesOf(id, scene);
      const branches = new Set(children.map((branch) => branch.element.id));
      // Its take-offs planned where they now sit on it (they follow it in their own turn, below).
      const replaced = new Map<string, HvacElement>([[id, ductRunElementWithSpec(element, next)], ...children.flatMap((child) => (child.start.kind === 'tap'
        ? [[child.element.id, ductRunElementWithSpec(child.element, { ...child.spec, start: { ...child.start, ...relocate(child.start.legIndex, child.start.stationMm) } })] as const]
        : []))]);
      const trial = scene.map((candidate) => replaced.get(candidate.id) ?? candidate);
      const fits = noNewErrors(errorCodes(getDuctRunPlan(element, before, settings)), errorCodes(planDuctRunSpec(id, next, { settings, scene: trial })))
        && !runClashes(next, planObstacles(scene, new Set([id, ...branches])), { firstLegClearOf: new Set([unitId]) });
      if (!fits) {
        infos.pop();
        record(id, element, spec, rigid(base, collarStub.from, collarStub.to), stay, { kind, note: 'turned with its unit: re-route it, or re-design it with Auto duct.' });
        continue;
      }
    }
    if (result.shortest.length && !note && kind === 'follows') {
      const legs = [...result.shortest].map((leg) => leg + (collarStub ? 1 : 0)).sort((a, b) => a - b);
      const which = legs.length === 1 && legs[0] === 0 ? 'its first straight is' : `${legs.length === 1 ? 'straight' : 'straights'} ${legs.map((leg) => leg + 1).join(', ')} ${legs.length === 1 ? 'is' : 'are'}`;
      note = `is pushed along: ${which} at its shortest.`;
    }
    record(id, element, spec, next, relocate, { kind, ...(note ? { note } : {}) });
  }
  return { runs: changedRuns, outcomes, segmentRefused, messages: [...messages, ...infos], infos };
}
