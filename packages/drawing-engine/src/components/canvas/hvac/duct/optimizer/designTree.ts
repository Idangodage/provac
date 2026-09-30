/**
 * A duct system as a design tree, independent of sizes: each run is a fixed
 * centreline in the collar's local frame (x along its normal, y across) with
 * its take-offs at fixed stations, and how it ends (a terminal's flexible
 * runout, an end cap, a split into two runs, or a plenum with spigots). The
 * optimiser sizes a tree (sizingDp.ts) and builds it into ordinary runs
 * (realiseDesign.ts); the fabrication planner then judges the result.
 *
 * A tree comes from the router (steinerArborescence.ts) or is read back from
 * runs already built (the v1 layouts, used as seeds).
 */
import type { HvacElement, Point2D } from '../../../../../types';
import {
  branchStubMm,
  simplifyCollinear,
  toLocal,
  type AutoDuctIssue,
  type ServiceCtx,
  type TerminalCtx,
} from '../ductAutoContext';
import { readDuctRunSpec, type DuctSide, type DuctSpigotFace } from '../ductTypes';

export interface DesignTap {
  /** Distance along the parent run's centreline from its start (mm). */
  station: number;
  side: DuctSide;
  child: RunDesign;
}

export interface DesignSpigot {
  face: DuctSpigotFace;
  alongMm: number;
  acrossMm: number;
  child: RunDesign;
}

export type DesignEnd =
  | { kind: 'terminal'; terminal: TerminalCtx }
  | { kind: 'cap' }
  /** Two runs leave the end, one each side (+1 then −1). */
  | { kind: 'split'; children: RunDesign[] }
  | { kind: 'plenum'; widthMm: number; heightMm: number; lengthMm: number; spigots: DesignSpigot[] };

export type DesignStart =
  | { kind: 'unit' }
  | { kind: 'tap' }
  | { kind: 'split'; side: DuctSide }
  | { kind: 'spigot' };

/**
 * Where the tree router made a run (grid nodes, terminal sets as bit masks):
 * the fitting it starts from, its take-offs, split and runout. A failure the
 * sizing, the realiser or the planner finds on the run is traced back to one
 * of these and forbidden for the next routing round (routerCuts.ts).
 */
export interface RunRoute {
  kind: 'root' | 'tee' | 'stub' | 'split';
  /** The node of the fitting the run starts from (the root's end for the run off the collar). */
  node: number;
  /** The terminals the run serves, and those its parent served at that fitting. */
  set: number;
  parentSet: number;
  /** Node of each take-off, in the run's tap order. */
  tapNodes: number[];
  splitNode?: number;
  /** Where the run reaches its terminal's runout, heading which way, and that terminal's set (one bit). */
  leaf?: { node: number; heading: number; set: number };
}

export interface RunDesign {
  key: string;
  start: DesignStart;
  /** Set on the router's trees: where each part came from on the grid. */
  route?: RunRoute;
  /**
   * Centreline in the local frame. A branch's first vertex is where it leaves
   * its parent's centreline (a tap) or the split point; its first leg leaves
   * square to the parent. The realiser moves the first vertex onto the actual
   * collar or outlet for the sizes chosen.
   */
  vertices: Point2D[];
  taps: DesignTap[];
  end: DesignEnd;
  /** Airflow entering the run: everything it serves (m³/h). */
  airflowM3h: number;
  /** A branch that is only its collar + damper stub, then flex. */
  allFlex: boolean;
  /**
   * The narrowest free corridor the run passes (half-width to the nearest
   * obstacle beside it, mm): its section's outer half plus the clearance must
   * fit. Unset where unknown (a layout read back from built runs).
   */
  corridorMm?: number;
}

export interface ServiceDesign {
  /** What produced it: the v1 layout it was read from, or the tree router with its price of pressure. */
  label: string;
  source: 'seed' | 'steiner';
  root: RunDesign;
  /** Straight off the fan collar before the first fitting (mm). */
  fanOutletMm: number;
  /** Extra first cost for a compromise, in the cost units. */
  penalty: number;
  /** Extra fan pressure for a compromise (a shortened fan outlet's system effect, Pa). */
  pressurePenaltyPa?: number;
  /** The layout kind it was read from (a v1 layout) or 'tree'. */
  kind?: string;
  notes: AutoDuctIssue[];
  /** The tree router's own optimum of its model (for the certificate), when it made this design. */
  modelCost?: number;
  /** Which tree router made it (its catalogue's shape). */
  router?: 'rect' | 'round';
  exact?: boolean;
}

// ---- Geometry along a run ----

export function runLengthMm(run: Pick<RunDesign, 'vertices'>): number {
  let total = 0;
  for (let index = 1; index < run.vertices.length; index += 1) {
    total += Math.hypot(run.vertices[index]!.x - run.vertices[index - 1]!.x, run.vertices[index]!.y - run.vertices[index - 1]!.y);
  }
  return total;
}

/** Distance along the run of each vertex. */
export function vertexStations(run: Pick<RunDesign, 'vertices'>): number[] {
  const out = [0];
  for (let index = 1; index < run.vertices.length; index += 1) {
    out.push(out[index - 1]! + Math.hypot(run.vertices[index]!.x - run.vertices[index - 1]!.x, run.vertices[index]!.y - run.vertices[index - 1]!.y));
  }
  return out;
}

/** The point and direction at a distance along the run. */
export function pointAlong(run: Pick<RunDesign, 'vertices'>, distance: number): { point: Point2D; direction: Point2D; legIndex: number; legStation: number } {
  const stations = vertexStations(run);
  const last = run.vertices.length - 2;
  let legIndex = 0;
  while (legIndex < last && distance > stations[legIndex + 1]! + 1e-6) legIndex += 1;
  const a = run.vertices[legIndex]!;
  const b = run.vertices[legIndex + 1]!;
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const direction = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  const legStation = distance - stations[legIndex]!;
  return { point: { x: a.x + direction.x * legStation, y: a.y + direction.y * legStation }, direction, legIndex, legStation };
}

/** Turn angle at each interior vertex (deg), keyed by the vertex's distance along the run. */
export function runBends(run: Pick<RunDesign, 'vertices'>): Array<{ station: number; angleDeg: number }> {
  const stations = vertexStations(run);
  const out: Array<{ station: number; angleDeg: number }> = [];
  for (let index = 1; index < run.vertices.length - 1; index += 1) {
    const a = run.vertices[index - 1]!;
    const b = run.vertices[index]!;
    const c = run.vertices[index + 1]!;
    const u = { x: b.x - a.x, y: b.y - a.y };
    const v = { x: c.x - b.x, y: c.y - b.y };
    const cos = (u.x * v.x + u.y * v.y) / ((Math.hypot(u.x, u.y) || 1) * (Math.hypot(v.x, v.y) || 1));
    const angle = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    if (angle > 1) out.push({ station: stations[index]!, angleDeg: angle });
  }
  return out;
}

// ---- Flows ----

/** Fills every run's airflow from its terminals up; returns the root's. */
export function computeFlows(run: RunDesign): number {
  let flow = run.end.kind === 'terminal' ? run.end.terminal.airflowM3h : 0;
  for (const tap of run.taps) flow += computeFlows(tap.child);
  if (run.end.kind === 'split') for (const child of run.end.children) flow += computeFlows(child);
  if (run.end.kind === 'plenum') for (const spigot of run.end.spigots) flow += computeFlows(spigot.child);
  run.airflowM3h = flow;
  return flow;
}

/** Every run of the tree, parents before children. */
export function allRuns(root: RunDesign): RunDesign[] {
  const out: RunDesign[] = [];
  const visit = (run: RunDesign) => {
    out.push(run);
    for (const tap of run.taps) visit(tap.child);
    if (run.end.kind === 'split') run.end.children.forEach(visit);
    if (run.end.kind === 'plenum') run.end.spigots.forEach((spigot) => visit(spigot.child));
  };
  visit(root);
  return out;
}

/** Terminals the tree serves. */
export function servedTerminals(root: RunDesign): TerminalCtx[] {
  return allRuns(root).flatMap((run) => (run.end.kind === 'terminal' ? [run.end.terminal] : []));
}

/** The terminals whose plenum spigot the tree turns to another side: each element as it will be. */
export function turnedTerminals(root: RunDesign): HvacElement[] {
  return servedTerminals(root).filter((terminal) => terminal.turnedTo !== undefined).map((terminal) => terminal.element);
}

/** A scene with some of its elements replaced (by id). */
export function withReplaced(scene: readonly HvacElement[], replacements: readonly HvacElement[]): HvacElement[] {
  if (!replacements.length) return [...scene];
  const byId = new Map(replacements.map((element) => [element.id, element]));
  return scene.map((element) => byId.get(element.id) ?? element);
}

/** Distance along a polyline to the point on it nearest `point`. */
export function stationOf(vertices: readonly Point2D[], point: Point2D): number {
  let best = { station: 0, distance: Number.POSITIVE_INFINITY };
  let start = 0;
  for (let index = 1; index < vertices.length; index += 1) {
    const a = vertices[index - 1]!;
    const b = vertices[index]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-9) continue;
    const u = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    const t = Math.max(0, Math.min(length, (point.x - a.x) * u.x + (point.y - a.y) * u.y));
    const distance = Math.hypot(a.x + u.x * t - point.x, a.y + u.y * t - point.y);
    if (distance < best.distance - 1e-6) best = { station: start + t, distance };
    start += length;
  }
  return best.station;
}

// ---- Reading built runs back into a tree (the v1 layouts as seeds) ----

/**
 * The tree of runs built from one collar: centrelines in the local frame
 * (reducer vertices dropped: the sizing places its own), take-offs at their
 * distance along the parent, ends as built.
 */
export function designFromRuns(ctx: ServiceCtx, runs: readonly HvacElement[], label: string, fanOutletMm: number, penalty: number, notes: AutoDuctIssue[]): ServiceDesign | null {
  const specs = new Map(runs.map((run) => [run.id, readDuctRunSpec(run)]));
  const rootElement = runs.find((run) => specs.get(run.id)?.start.kind === 'unit-port');
  if (!rootElement) return null;
  const terminals = new Map(ctx.terminals.map((terminal) => [terminal.element.id, terminal]));
  let counter = 0;
  const build = (element: HvacElement, start: DesignStart, parentLocal: RunDesign | null, parentStart: Point2D | null): RunDesign | null => {
    const spec = specs.get(element.id);
    if (!spec) return null;
    const flexEnd = spec.end.kind === 'terminal' && spec.end.flex;
    const rigid = (flexEnd ? spec.path.slice(0, -1) : spec.path).map((point) => toLocal(ctx.frame, point));
    // A branch starts on its parent's centreline (or the split point); the realiser puts it on the wall.
    if (parentStart) rigid[0] = parentStart;
    const vertices = simplifyCollinear(rigid);
    if (vertices.length < 2) vertices.push({ x: vertices[0]!.x + 1, y: vertices[0]!.y });
    let end: DesignEnd;
    if (spec.end.kind === 'terminal') {
      const terminal = terminals.get(spec.end.terminalId);
      if (!terminal) return null;
      end = { kind: 'terminal', terminal };
    } else if (spec.end.kind === 'split') {
      end = { kind: 'split', children: [] };
    } else if (spec.end.kind === 'plenum') {
      end = { kind: 'plenum', widthMm: spec.end.widthMm, heightMm: spec.end.heightMm, lengthMm: spec.end.lengthMm, spigots: [] };
    } else {
      end = { kind: 'cap' };
    }
    // All flex: the rigid part is only the collar + damper stub (a single rigid leg to a front point is a rigid branch).
    const firstLeg = spec.path.length > 1 ? Math.hypot(spec.path[1]!.x - spec.path[0]!.x, spec.path[1]!.y - spec.path[0]!.y) : 0;
    const run: RunDesign = {
      key: `r${(counter += 1)}`, start, vertices, taps: [], end, airflowM3h: 0,
      allFlex: flexEnd && spec.path.length === 3 && start.kind !== 'unit' && firstLeg <= branchStubMm(ctx.settings) + 120,
    };
    void parentLocal;
    // Children in the order the runs were built.
    for (const other of runs) {
      const childSpec = specs.get(other.id);
      const childStart = childSpec?.start;
      if (!childSpec || !childStart || (childStart.kind !== 'tap' && childStart.kind !== 'split-branch' && childStart.kind !== 'spigot') || childStart.parentRunId !== element.id) continue;
      if (childStart.kind === 'tap') {
        // The take-off's point on the built path, measured again along the design's centreline
        // (a branch's design starts at its parent, not at its outlet).
        const a = spec.path[childStart.legIndex]!;
        const b = spec.path[childStart.legIndex + 1] ?? a;
        const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const world = { x: a.x + ((b.x - a.x) / length) * childStart.stationMm, y: a.y + ((b.y - a.y) / length) * childStart.stationMm };
        const station = stationOf(run.vertices, toLocal(ctx.frame, world));
        const centre = pointAlong(run, station).point;
        const child = build(other, { kind: 'tap' }, run, centre);
        if (!child) return null;
        run.taps.push({ station, side: childStart.side, child });
      } else if (childStart.kind === 'split-branch' && run.end.kind === 'split') {
        const child = build(other, { kind: 'split', side: childStart.side }, run, vertices[vertices.length - 1]!);
        if (!child) return null;
        run.end.children.push(child);
      } else if (childStart.kind === 'spigot' && run.end.kind === 'plenum') {
        const child = build(other, { kind: 'spigot' }, run, null);
        if (!child) return null;
        run.end.spigots.push({ face: childStart.face, alongMm: childStart.alongMm, acrossMm: childStart.acrossMm, child });
      }
    }
    run.taps.sort((a, b) => a.station - b.station);
    if (run.end.kind === 'split') {
      run.end.children.sort((a, b) => ((b.start as { side: DuctSide }).side - (a.start as { side: DuctSide }).side));
      if (run.end.children.length !== 2) return null;
    }
    return run;
  };
  const root = build(rootElement, { kind: 'unit' }, null, null);
  if (!root) return null;
  computeFlows(root);
  return { label, source: 'seed', root, fanOutletMm, penalty, notes };
}
