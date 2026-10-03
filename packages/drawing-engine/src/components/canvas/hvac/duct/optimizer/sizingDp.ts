/**
 * Exact sizing of a design tree: every run's sections (a section per stretch
 * between take-offs, with a reducer where it changes), every take-off's
 * fitting and the split style, chosen together to trade first cost against
 * fan pressure. The exact counterpart of ASHRAE's T-method on a discrete
 * catalogue.
 *
 * Frontiers. For a subtree, F[i] is the least first cost of a design in which
 * every terminal path from the subtree's start needs at most p_i = i·δ Pa (a
 * non-increasing step function of the pressure budget). Three operations
 * build every frontier exactly, each O(N) on the grid:
 *  - a fitting or duct in series: shift by its cost and (rounded up) its loss;
 *  - two subtrees in parallel (a take-off and the main beyond it): the paths
 *    must each stay within the same budget, so the costs add pointwise;
 *  - a choice (a section, a fitting style): the pointwise minimum.
 * Parent–child rules (SMACNA S3.4 two thirds, a spin-in ≤ the trunk height
 * less 50, a Y's outlets within its width, no expansion downstream, a reducer
 * only where it fits) are applied where the parent's section is known, so the
 * result is the true optimum over the catalogue, each loss rounded up to the
 * grid step (conservative).
 *
 * The root frontier gives every trade-off at once: the cheapest design for
 * each fan pressure. The caller picks points (least first cost, least
 * life-cycle cost, least pressure) and reconstructs their sizes.
 */
import type { Point2D } from '../../../../../types';
import type { TerminalCtx } from '../ductAutoContext';
import { FITTING_LOSS_COEFFICIENTS } from '../ductPressure';
import { maxRoundBranchMm } from '../ductRoundFittings';
import { velocityMs, velocityPressurePa } from '../ductSizing';
import { isRoundLeg, type DuctLeg, type DuctSplitStyle, type DuctTapStyle } from '../ductTypes';

import { pointAlong, runBends, runLengthMm, type DesignSpigot, type RunDesign, type ServiceDesign } from './designTree';
import { ROUTE_CLEARANCE_MM } from './routingGraph';
import { areaOf, sameLeg, type SizingModel } from './sizingModel';

const INF = Number.POSITIVE_INFINITY;

export interface DpGrid {
  /** Pressure step (Pa). */
  stepPa: number;
  /** Number of grid points (0 … (size − 1)·step). */
  size: number;
}

export interface RunSegment {
  from: number;
  to: number;
  /** The take-off inside the segment (index into the run's taps), or null. */
  tap: number | null;
  /** Airflow at the segment's start (upstream of its take-off) and after it. */
  flowIn: number;
  flowOut: number;
  lengthBeforeMm: number;
  lengthAfterMm: number;
  bendsBefore: number[];
  bendsAfter: number[];
  /** Straight room at the segment's end for a reducer (0 = the next segment keeps this section). */
  reducerRoomMm: number;
}

export interface RunSizing {
  /** Section per segment. */
  sections: DuctLeg[];
  /** Station of each boundary between segments (where a reducer goes when the section changes). */
  boundaries: number[];
  /** Fitting of each take-off, in the run's tap order. */
  tapStyles: DuctTapStyle[];
  splitStyle?: DuctSplitStyle;
  spigotStyles?: Array<'spin-in' | 'conical'>;
  /** The root turns at the collar's own section first (a square vaned elbow) and steps to its size after it. */
  collarTurn?: boolean;
}

export interface SizedDesign {
  design: ServiceDesign;
  sizing: Map<string, RunSizing>;
  /** The model's first cost (the planned design is re-priced) and pressure bound (Pa). */
  modelCost: number;
  modelPressurePa: number;
}

export interface DesignFrontier {
  design: ServiceDesign;
  grid: DpGrid;
  /** Least first cost for a fan pressure ≤ i·step. */
  cost: Float64Array;
  reconstruct(index: number): SizedDesign | null;
}

const TAP_STYLES: readonly DuctTapStyle[] = ['spin-in', 'conical', 'shoe-45', 'round-tee', 'round-conical', 'round-lateral', 'straight'];
const SPLIT_STYLES: readonly DuctSplitStyle[] = ['y', 'bullhead', 'wye'];
const SPIGOT_STYLES = ['spin-in', 'conical'] as const;

interface RunState {
  run: RunDesign;
  segments: RunSegment[];
  boundaries: number[];
  options: DuctLeg[][];
  /** G[k][x]: frontier of everything from segment k's start with section x there. */
  G: Float64Array[][];
  /** Per segment and section: whether the run can carry on from it, and whether its take-off can be made on it (for explanations). */
  alive: Array<Array<{ main: boolean; branch: boolean }>>;
  argTap: Array<Array<Int32Array | null>>;
  argNext: Int32Array[][];
  /** Last segment: the end's frontier and choices per section. */
  end: Array<Float64Array | null>;
  argEnd: Array<Int32Array | null>;
  children: RunState[];
}

// ---- Frontier operations ----

function steps(pressurePa: number, grid: DpGrid): number {
  return Math.max(0, Math.ceil(pressurePa / grid.stepPa - 1e-9));
}

function filled(grid: DpGrid, value: number): Float64Array {
  return new Float64Array(grid.size).fill(value);
}

/** out[i] = min(out[i], F[i − k] + cost), recording `code` where it wins. */
function minShiftedInto(out: Float64Array, arg: Int32Array | null, F: Float64Array, cost: number, k: number, code: number): void {
  if (!Number.isFinite(cost)) return;
  for (let i = k; i < out.length; i += 1) {
    const value = F[i - k]! + cost;
    if (value < out[i]!) {
      out[i] = value;
      if (arg) arg[i] = code;
    }
  }
}

// ---- Segments ----

/** Half the length of main a take-off to `child` may occupy (its biggest option: the tee body C + 102, a cone's flare, the margin). */
function windowHalfMm(child: RunState, model: SizingModel): number {
  const biggest = Math.max(...child.options[0]!.map((leg) => leg.widthMm));
  return biggest / 2 + 51 + model.settings.conicalFlareMm / 2 + model.settings.tapWindowMarginMm;
}

/** Straight room between `a` and `b` along the run clear of its bends; the widest gap and its middle. */
function straightRoom(a: number, b: number, bends: readonly number[], clearMm: number): { room: number; at: number } {
  if (b - a <= 0) return { room: 0, at: (a + b) / 2 };
  const cuts = bends.filter((station) => station > a - clearMm && station < b + clearMm).sort((m, n) => m - n);
  let best = { room: 0, at: (a + b) / 2 };
  let cursor = a;
  for (const station of [...cuts, Number.POSITIVE_INFINITY]) {
    const until = Number.isFinite(station) ? Math.min(b, station - clearMm) : b;
    if (until - cursor > best.room) best = { room: until - cursor, at: (cursor + until) / 2 };
    if (Number.isFinite(station)) cursor = Math.max(cursor, station + clearMm);
  }
  return best;
}

/** Clearance a reducer keeps from an elbow's centre (practice: an elbow's setback and neck). */
const BEND_CLEAR_MM = 500;
/** Shortest straight worth a reducer (mm). */
const MIN_REDUCER_ROOM_MM = 250;
/** A run ending on a terminal keeps this much before its end for the fitting down to the neck (the realiser's rule). */
export const END_TRANSITION_MIN_LEG_MM = 700;

function planSegments(run: RunDesign, children: RunState[], model: SizingModel): { segments: RunSegment[]; boundaries: number[] } {
  const length = runLengthMm(run);
  const bends = runBends(run);
  const bendStations = bends.map((bend) => bend.station);
  const taps = run.taps;
  const halves = taps.map((_, index) => windowHalfMm(children[index]!, model));
  const flowsAfter: number[] = [];
  let flow = run.airflowM3h;
  const flowsBefore: number[] = [];
  for (const tap of taps) {
    flowsBefore.push(flow);
    flow -= tap.child.airflowM3h;
    flowsAfter.push(flow);
  }
  const bounds: Array<{ at: number; room: number }> = [];
  for (let j = 0; j + 1 < taps.length; j += 1) {
    const found = straightRoom(taps[j]!.station + halves[j]!, taps[j + 1]!.station - halves[j + 1]!, bendStations, BEND_CLEAR_MM);
    bounds.push(found.room >= MIN_REDUCER_ROOM_MM ? found : { at: (taps[j]!.station + taps[j + 1]!.station) / 2, room: 0 });
  }
  // A run ending on a terminal after its take-offs may step down for its last stretch (the branch to that terminal).
  let tail: { at: number; room: number } | null = null;
  if (taps.length && run.end.kind === 'terminal') {
    const last = taps.length - 1;
    const found = straightRoom(taps[last]!.station + halves[last]!, length - END_TRANSITION_MIN_LEG_MM, bendStations, BEND_CLEAR_MM);
    if (found.room >= MIN_REDUCER_ROOM_MM) tail = found;
  }
  const edges = [0, ...bounds.map((bound) => bound.at), ...(tail ? [tail.at] : []), length];
  const rooms = [...bounds.map((bound) => bound.room), ...(tail ? [tail.room] : [])];
  const segments: RunSegment[] = [];
  for (let k = 0; k + 1 < edges.length; k += 1) {
    const from = edges[k]!;
    const to = edges[k + 1]!;
    const tapIndex = k < taps.length ? k : null;
    const at = tapIndex !== null ? taps[tapIndex]!.station : to;
    const flowIn = tapIndex !== null ? flowsBefore[tapIndex]! : (taps.length ? flowsAfter[taps.length - 1]! : run.airflowM3h);
    segments.push({
      from, to, tap: tapIndex, flowIn,
      flowOut: tapIndex !== null ? flowsAfter[tapIndex]! : flowIn,
      lengthBeforeMm: Math.max(0, at - from), lengthAfterMm: Math.max(0, to - at),
      bendsBefore: bends.filter((bend) => bend.station >= from - 1e-6 && bend.station < at - 1e-6).map((bend) => bend.angleDeg),
      bendsAfter: bends.filter((bend) => bend.station >= at - 1e-6 && bend.station < to - 1e-6).map((bend) => bend.angleDeg),
      reducerRoomMm: k < rooms.length ? rooms[k]! : 0,
    });
  }
  return { segments, boundaries: edges.slice(1, -1) };
}

// ---- Options ----

function dedupe(legs: DuctLeg[]): DuctLeg[] {
  const out: DuctLeg[] = [];
  for (const leg of legs) if (!out.some((other) => sameLeg(other, leg))) out.push(leg);
  return out;
}

/** The corridor alongside this section, including any corner or split at its ends. */
function segmentCorridorMm(run: RunDesign, segment: RunSegment): number {
  if (!run.corridors) return run.corridorMm ?? INF;
  let corridor = INF;
  for (const limit of run.corridors) {
    const overlaps = limit.toMm > limit.fromMm
      ? Math.min(segment.to, limit.toMm) - Math.max(segment.from, limit.fromMm) > 1e-6
      : limit.fromMm >= segment.from - 1e-6 && limit.fromMm <= segment.to + 1e-6;
    if (overlaps) corridor = Math.min(corridor, limit.halfWidthMm);
  }
  return corridor;
}

function fitsCorridor(leg: DuctLeg, corridorMm: number, model: SizingModel): boolean {
  return !Number.isFinite(corridorMm)
    || leg.widthMm / 2 + 1 + model.costContext.insulationMm <= corridorMm - ROUTE_CLEARANCE_MM + 1e-6;
}

function segmentOptions(run: RunDesign, segment: RunSegment, index: number, children: RunState[], model: SizingModel): DuctLeg[] {
  const corridor = segmentCorridorMm(run, segment);
  if (run.end.kind === 'plenum') return [{ widthMm: model.ctx.port.widthMm, heightMm: model.ctx.port.heightMm }];
  const terminal = run.end.kind === 'terminal' ? run.end.terminal : null;
  if (run.allFlex && terminal) return [{ widthMm: terminal.neck, heightMm: terminal.neck, diameterMm: terminal.neck }];
  const oneTerminal = segment.tap === null && terminal !== null && Math.abs(segment.flowIn - terminal.airflowM3h) < 1e-6;
  if (oneTerminal && (run.start.kind === 'tap' || run.start.kind === 'spigot' || index > 0)) {
    return model.branchOptions(segment.flowIn, terminal.neck).filter((leg) => fitsCorridor(leg, corridor, model));
  }
  let options = model.trunkOptions(segment.flowIn);
  // A split outlet run to one terminal may also be a round branch (a wye outlet).
  if (oneTerminal && terminal) options = [...options, ...model.branchOptions(segment.flowIn, terminal.neck)];
  // Take-offs set a floor: the branch must fit the trunk (two thirds of a round main, height − 50 for a spin-in).
  if (segment.tap !== null) {
    const child = children[segment.tap]!;
    // The smallest branch that can be sized at all (a branch with take-offs of its own may need a tall one).
    const live = child.options[0]!.filter((_, iy) => child.G[0]?.[iy]?.some(Number.isFinite) ?? true);
    const smallest = Math.min(...(live.length ? live : child.options[0]!).map((leg) => leg.diameterMm ?? leg.heightMm));
    const cap = model.settings.autoMaxVelocityTrunkMs;
    const extra: DuctLeg[] = [];
    if (model.shape !== 'rect') {
      const d = model.settings.autoRoundSizesMm.find((size) => maxRoundBranchMm(size) >= smallest - 0.5 && size <= model.maxHeightMm);
      if (d) extra.push({ widthMm: d, heightMm: d, diameterMm: d });
    }
    if (model.shape !== 'round') {
      const h = Math.ceil((smallest + 50) / 50) * 50;
      if (h <= model.maxHeightMm) {
        for (let w = h; w <= 4 * h; w += 50) {
          const leg = { widthMm: w, heightMm: h };
          if (segment.flowIn / 3600 / areaOf(leg) <= cap * 1.001) { extra.push(leg); break; }
        }
      }
    }
    options = [...options, ...extra];
  }
  // Off the collar, sections as wide as the collar (a short transition) at the heights offered: slow for
  // the flow, but where the collar's straight is short they may be the only ones whose transition fits.
  if (run.start.kind === 'unit' && index === 0 && model.shape !== 'round') {
    const width = Math.max(100, Math.round(model.ctx.port.widthMm / 50) * 50);
    const heights = new Set(options.filter((leg) => !isRoundLeg(leg)).map((leg) => leg.heightMm));
    for (const h of heights) if (h <= model.maxHeightMm && width <= 4 * h) options.push({ widthMm: width, heightMm: h });
  }
  // A rectangular Y shares the main's width between its two outlets (Fig. 2-5): the stretch before it may be
  // as wide as a pair of outlets side by side — slower than the economy band, but the fitting needs it.
  if (run.end.kind === 'split' && model.shape !== 'round' && segment.to >= runLengthMm(run) - 1) {
    const outlets = children.slice(run.taps.length);
    if (outlets.length === 2) {
      const [a, b] = outlets.map((child) => child.options[0]!.filter((leg) => !isRoundLeg(leg))) as [DuctLeg[], DuctLeg[]];
      const pairs: DuctLeg[] = [];
      for (const x of a) {
        for (const y of b) {
          const leg = { widthMm: x.widthMm + y.widthMm, heightMm: Math.max(x.heightMm, y.heightMm) };
          if (leg.heightMm <= model.maxHeightMm && leg.widthMm <= 4 * leg.heightMm) pairs.push(leg);
        }
      }
      options = [...options, ...dedupe(pairs).sort((m, n) => areaOf(m) - areaOf(n)).slice(0, 24)];
    }
  }
  // Only sections that fit the corridor the router ran the run through (its outer half and the clearance).
  return dedupe(options).filter((leg) => fitsCorridor(leg, corridor, model));
}

// ---- Compatibility ----

/** Take-off styles that join a branch of section `branch` to a main of section `main`. */
function tapStyles(main: DuctLeg, branch: DuctLeg, child: RunState, model: SizingModel): DuctTapStyle[] {
  if (isRoundLeg(main)) {
    if (!isRoundLeg(branch) || branch.diameterMm! > maxRoundBranchMm(main.diameterMm!) + 0.5) return [];
    const room = child.run.allFlex ? 0 : firstEventMm(child.run, child.children, model);
    return model.settings.autoRoundMainStyles.filter((style) => style !== 'round-lateral' || room >= model.diagonalRoomMm(main.diameterMm!, branch, false));
  }
  if (isRoundLeg(branch)) {
    const out: DuctTapStyle[] = [];
    if (branch.diameterMm! + 50 <= main.heightMm + 0.5) out.push('spin-in');
    if (branch.diameterMm! + model.settings.conicalFlareMm + 20 <= main.heightMm + 0.5) out.push('conical');
    return out;
  }
  return branch.heightMm <= main.heightMm + 0.5 ? ['shoe-45'] : [];
}

/** A section may follow `from` downstream: never larger, a flat bottom (height not up), rectangular to round but not back. */
function mayFollow(from: DuctLeg, to: DuctLeg, _model: SizingModel): boolean {
  if (sameLeg(from, to)) return true;
  if (areaOf(to) > areaOf(from) + 1e-9) return false;
  if (isRoundLeg(from)) return isRoundLeg(to) && to.diameterMm! < from.diameterMm!;
  // Rectangular to round (a square-to-round): the round top may rise a little over the flat bottom.
  if (isRoundLeg(to)) return to.diameterMm! <= from.heightMm + 50;
  return to.heightMm <= from.heightMm && to.widthMm <= from.widthMm;
}

/** Distance along a run to its first fitting (a take-off window or a bend). */
function firstEventMm(run: RunDesign, children: RunState[], model: SizingModel): number {
  const bends = runBends(run).map((bend) => bend.station);
  const taps = run.taps.map((tap, index) => tap.station - windowHalfMm(children[index]!, model));
  return Math.min(runLengthMm(run), ...bends, ...taps);
}

function splitStylesFor(main: DuctLeg, model: SizingModel): DuctSplitStyle[] {
  if (isRoundLeg(main)) return model.settings.autoAllowWye ? ['wye'] : [];
  return ['y', 'bullhead'];
}

/** An outlet section a split of `style` on `main` can take (the Y's shared width is applied pairwise). */
function splitOutletOk(style: DuctSplitStyle, main: DuctLeg, outlet: DuctLeg): boolean {
  if (style === 'wye') return isRoundLeg(outlet) && outlet.diameterMm! <= main.diameterMm!;
  if (isRoundLeg(outlet)) return false;
  return outlet.heightMm <= main.heightMm + 0.5 && outlet.widthMm <= main.widthMm + 0.5;
}

// ---- The DP ----

interface Solver {
  model: SizingModel;
  grid: DpGrid;
  states: Map<string, RunState>;
}

/** Loss in the part of segment k before its take-off (friction and bends at the flow in). */
function lossBefore(segment: RunSegment, leg: DuctLeg, model: SizingModel): number {
  return model.friction(leg, segment.flowIn, segment.lengthBeforeMm)
    + segment.bendsBefore.reduce((total, angle) => total + model.elbow(leg, angle, segment.flowIn).loss, 0);
}

/** Loss on the main beyond the take-off: its straight-through passage, friction and bends at the flow out. */
function lossAfter(segment: RunSegment, leg: DuctLeg, model: SizingModel): number {
  return (segment.tap !== null ? model.passage(leg, segment.flowIn, segment.flowOut) : 0)
    + model.friction(leg, segment.flowOut, segment.lengthAfterMm)
    + segment.bendsAfter.reduce((total, angle) => total + model.elbow(leg, angle, segment.flowOut).loss, 0);
}

function segmentCost(segment: RunSegment, leg: DuctLeg, model: SizingModel): number {
  const length = segment.to - segment.from;
  return model.costPerMetre(leg) * (length / 1000)
    + [...segment.bendsBefore, ...segment.bendsAfter].reduce((total, angle) => total + model.elbow(leg, angle, segment.flowIn).cost, 0);
}

/** The terminal runout, including the bend loss from its actual curve. */
function runoutFit(run: RunDesign, model: SizingModel, airflowM3h: number): ReturnType<SizingModel['flexRunout']> | null {
  if (run.end.kind !== 'terminal') return null;
  const terminal = run.end.terminal;
  const last = run.vertices[run.vertices.length - 1]!;
  const before = run.vertices[run.vertices.length - 2] ?? last;
  const length = Math.hypot(last.x - before.x, last.y - before.y) || 1;
  const out = { x: (last.x - before.x) / length, y: (last.y - before.y) / length };
  return model.flexRunout(last, out, terminal, airflowM3h);
}

/** Loss where the duct enters a plenum box: its velocity pressure. */
function plenumEntryLossPa(leg: DuctLeg, airflowM3h: number): number {
  return FITTING_LOSS_COEFFICIENTS.plenumEntry * velocityPressurePa(velocityMs(leg, airflowM3h));
}

function endFrontiers(state: RunState, solver: Solver): void {
  const { model, grid } = solver;
  const run = state.run;
  const lastIndex = state.segments.length - 1;
  const last = state.segments[lastIndex]!;
  const options = state.options[lastIndex]!;
  const flow = last.flowOut;
  const fit = runoutFit(run, model, flow);
  state.end = options.map(() => null);
  state.argEnd = options.map(() => null);
  options.forEach((leg, x) => {
    if (run.end.kind === 'terminal') {
      const terminal = run.end.terminal;
      const neck = { widthMm: terminal.neck, heightMm: terminal.neck, diameterMm: terminal.neck };
      const lastLeg = run.vertices.length > 1
        ? Math.hypot(run.vertices.at(-1)!.x - run.vertices.at(-2)!.x, run.vertices.at(-1)!.y - run.vertices.at(-2)!.y) : 0;
      let transition = { cost: 0, loss: 0 };
      if (!sameLeg(leg, neck)) {
        if (lastLeg < END_TRANSITION_MIN_LEG_MM) return;
        transition = model.transition(leg, neck, flow);
      }
      const runout = model.flex(terminal.neck, flow, fit!.lengthMm, fit!.bendLossPa);
      const frontier = filled(grid, INF);
      minShiftedInto(frontier, null, filled(grid, 0), transition.cost + runout.cost, steps(transition.loss + runout.loss + model.terminalDropPa, grid), 0);
      state.end[x] = frontier;
    } else if (run.end.kind === 'cap') {
      state.end[x] = filled(grid, model.capCost(leg));
    } else if (run.end.kind === 'split') {
      const [plus, minus] = state.children.slice(run.taps.length) as [RunState, RunState];
      const frontier = filled(grid, INF);
      const arg = new Int32Array(grid.size).fill(-1);
      const room = [firstEventMm(plus.run, plus.children, model), firstEventMm(minus.run, minus.children, model)];
      for (const style of splitStylesFor(leg, model)) {
        const styleIndex = SPLIT_STYLES.indexOf(style);
        // Each outlet on its own (its section fits the split, its loss and share of the fitting), shifted by that.
        const side = (child: RunState, which: 0 | 1) => child.options[0]!.flatMap((y, index) => {
          if (!splitOutletOk(style, leg, y)) return [];
          if (style === 'wye' && room[which]! < model.diagonalRoomMm(leg.diameterMm!, y, true)) return [];
          const part = model.splitOutlet(style, leg, flow, y, child.run.airflowM3h);
          const shifted = filled(grid, INF);
          minShiftedInto(shifted, null, child.G[0]![index]!, part.cost, steps(part.loss, grid), 0);
          return [{ index, leg: y, shifted }];
        });
        const as = side(plus, 0);
        const bs = side(minus, 1).sort((m, n) => m.leg.widthMm - n.leg.widthMm);
        if (!as.length || !bs.length) continue;
        // Envelope over the second outlet, narrowest first: the best of those up to each width.
        const envelope: Float64Array[] = [];
        const envelopeArg: Int32Array[] = [];
        bs.forEach((entry, j) => {
          const value = j ? Float64Array.from(envelope[j - 1]!) : filled(grid, INF);
          const which = j ? Int32Array.from(envelopeArg[j - 1]!) : new Int32Array(grid.size).fill(-1);
          for (let i = 0; i < grid.size; i += 1) if (entry.shifted[i]! < value[i]!) { value[i] = entry.shifted[i]!; which[i] = entry.index; }
          envelope.push(value);
          envelopeArg.push(which);
        });
        const base = model.splitBaseCost(style, leg, flow);
        for (const a of as) {
          // A Y shares the main's width between its outlets; a bullhead or a wye takes each within the main.
          const limit = style === 'y' ? leg.widthMm - a.leg.widthMm + 0.5 : Number.POSITIVE_INFINITY;
          let j = -1;
          while (j + 1 < bs.length && bs[j + 1]!.leg.widthMm <= limit) j += 1;
          if (j < 0) continue;
          const best = envelope[j]!;
          const which = envelopeArg[j]!;
          for (let i = 0; i < grid.size; i += 1) {
            const value = a.shifted[i]! + best[i]! + base;
            if (value < frontier[i]!) { frontier[i] = value; arg[i] = styleIndex * 1_000_000 + a.index * 1000 + which[i]!; }
          }
        }
      }
      state.end[x] = frontier;
      state.argEnd[x] = arg;
    } else {
      // Plenum: every spigot's branch in parallel, the box, and the entry loss.
      const plenum = run.end;
      const children = state.children.slice(run.taps.length);
      let total = filled(grid, 0);
      const args: Int32Array[] = [];
      plenum.spigots.forEach((spigot: DesignSpigot, c) => {
        const child = children[c]!;
        const best = filled(grid, INF);
        const arg = new Int32Array(grid.size).fill(-1);
        child.options[0]!.forEach((y, iy) => {
          if ((y.diameterMm ?? y.widthMm) > plenum.heightMm - 100 + 0.5) return;
          SPIGOT_STYLES.forEach((style, s) => {
            const part = model.spigot(style, y, spigot.child.airflowM3h);
            minShiftedInto(best, arg, child.G[0]![iy]!, part.cost, steps(part.loss, grid), (iy << 4) | s);
          });
        });
        args.push(arg);
        const next = new Float64Array(grid.size);
        for (let i = 0; i < grid.size; i += 1) next[i] = total[i]! + best[i]!;
        total = next;
      });
      // The box: its sides and two faces, fabricated at the fitting rate.
      const box = { widthMm: plenum.widthMm, heightMm: plenum.heightMm };
      const boxCost = model.plenumCost(box, plenum.lengthMm);
      const entry = plenumEntryLossPa(leg, flow);
      const frontier = filled(grid, INF);
      minShiftedInto(frontier, null, total, boxCost, steps(entry, grid), 0);
      state.end[x] = frontier;
      // One arg array per spigot, stored after the end marker.
      (state as RunState & { argSpigots?: Int32Array[] }).argSpigots = args;
    }
  });
}

/** Where an all-flex take-off leaves its main (design point and direction), for the runout check; null otherwise. */
function stubAt(run: RunDesign, tap: number, child: RunDesign): { centre: Point2D; out: Point2D; terminal: TerminalCtx } | null {
  if (!child.allFlex || child.end.kind !== 'terminal' || child.vertices.length < 2) return null;
  const [first, second] = child.vertices as [Point2D, Point2D];
  const reach = Math.hypot(second.x - first.x, second.y - first.y) || 1;
  return {
    centre: pointAlong(run, run.taps[tap]!.station).point,
    out: { x: (second.x - first.x) / reach, y: (second.y - first.y) / reach },
    terminal: child.end.terminal,
  };
}

function solveRun(run: RunDesign, solver: Solver): RunState {
  const { model, grid } = solver;
  /** Runout checks, per take-off, main section and fitting (each is a curve against the obstacles). */
  const stubCache = new Map<string, boolean>();
  const stubFits = (stub: NonNullable<ReturnType<typeof stubAt>>, leg: DuctLeg, style: DuctTapStyle): boolean => {
    const key = `${stub.centre.x},${stub.centre.y},${leg.diameterMm ?? leg.widthMm},${style}`;
    let fits = stubCache.get(key);
    if (fits === undefined) {
      fits = model.stubRunoutFits(stub.centre, stub.out, leg, style, stub.terminal, model.ctx.bottomZ);
      stubCache.set(key, fits);
    }
    return fits;
  };
  const children: RunState[] = [
    ...run.taps.map((tap) => solveRun(tap.child, solver)),
    ...(run.end.kind === 'split' ? run.end.children.map((child) => solveRun(child, solver)) : []),
    ...(run.end.kind === 'plenum' ? run.end.spigots.map((spigot) => solveRun(spigot.child, solver)) : []),
  ];
  const { segments, boundaries } = planSegments(run, children, model);
  const state: RunState = {
    run, segments, boundaries, options: [], G: [], alive: [], argTap: [], argNext: [], end: [], argEnd: [], children,
  };
  state.options = segments.map((segment, index) => segmentOptions(run, segment, index, children, model));
  // A section may always carry on past a take-off (a velocity under the economy band is no rule), so each
  // segment also offers the sections of the one before it; otherwise close take-offs leave no room to reduce.
  for (let k = 1; k < state.options.length; k += 1) {
    const corridor = segmentCorridorMm(run, segments[k]!);
    state.options[k] = dedupe([...state.options[k]!, ...state.options[k - 1]!])
      .filter((leg) => fitsCorridor(leg, corridor, model));
  }
  endFrontiers(state, solver);
  for (let k = segments.length - 1; k >= 0; k -= 1) {
    const segment = segments[k]!;
    const options = state.options[k]!;
    const G: Float64Array[] = [];
    const argTap: Array<Int32Array | null> = [];
    const argNext: Int32Array[] = [];
    const alive: Array<{ main: boolean; branch: boolean }> = [];
    options.forEach((leg, x) => {
      // Main side: the end, or the next segment through a reducer where it fits.
      const main = filled(grid, INF);
      const next = new Int32Array(grid.size).fill(-1);
      const after = lossAfter(segment, leg, model);
      if (k === segments.length - 1) {
        const end = state.end[x];
        if (end) minShiftedInto(main, next, end, 0, steps(after, grid), -2);
      } else {
        state.options[k + 1]!.forEach((nextLeg, xn) => {
          if (!mayFollow(leg, nextLeg, model)) return;
          let reducer = { cost: 0, loss: 0, lengthMm: 0 };
          if (!sameLeg(leg, nextLeg)) {
            reducer = model.transition(leg, nextLeg, segments[k + 1]!.flowIn);
            if (reducer.lengthMm > segment.reducerRoomMm + 1e-6) return;
          }
          minShiftedInto(main, next, state.G[k + 1]![xn]!, reducer.cost, steps(after + reducer.loss, grid), xn);
        });
      }
      // Branch side: the take-off to the child, each section and fitting it may use.
      let combined = main;
      let tapArg: Int32Array | null = null;
      if (segment.tap !== null) {
        const child = children[segment.tap]!;
        const branch = filled(grid, INF);
        tapArg = new Int32Array(grid.size).fill(-1);
        const stub = stubAt(run, segment.tap, child.run);
        child.options[0]!.forEach((y, iy) => {
          for (const style of tapStyles(leg, y, child, model)) {
            // An all-flex branch: its runout must still fit from this main's wall with this fitting.
            if (stub && !stubFits(stub, leg, style)) continue;
            const tee = model.tee(style, y, child.run.airflowM3h, leg, segment.flowIn);
            minShiftedInto(branch, tapArg, child.G[0]![iy]!, tee.cost, steps(tee.loss, grid), (iy << 4) | TAP_STYLES.indexOf(style));
          }
        });
        combined = new Float64Array(grid.size);
        for (let i = 0; i < grid.size; i += 1) combined[i] = branch[i]! + main[i]!;
        alive.push({ main: main.some(Number.isFinite), branch: branch.some(Number.isFinite) });
      } else {
        alive.push({ main: main.some(Number.isFinite), branch: true });
      }
      const frontier = filled(grid, INF);
      minShiftedInto(frontier, null, combined, segmentCost(segment, leg, model), steps(lossBefore(segment, leg, model), grid), 0);
      G[x] = frontier;
      argTap[x] = tapArg;
      argNext[x] = next;
    });
    state.G[k] = G;
    state.alive[k] = alive;
    state.argTap[k] = argTap;
    state.argNext[k] = argNext;
  }
  solver.states.set(run.key, state);
  return state;
}

function reconstructRun(state: RunState, option: number, budget: number, solver: Solver, out: Map<string, RunSizing>): boolean {
  const { model, grid } = solver;
  const sizing: RunSizing = { sections: [], boundaries: state.boundaries, tapStyles: [] };
  out.set(state.run.key, sizing);
  let x = option;
  let i = budget;
  for (let k = 0; k < state.segments.length; k += 1) {
    const segment = state.segments[k]!;
    const leg = state.options[k]![x]!;
    sizing.sections.push(leg);
    i -= steps(lossBefore(segment, leg, model), grid);
    if (i < 0) return false;
    if (segment.tap !== null) {
      const code = state.argTap[k]![x]![i]!;
      if (code < 0) return false;
      const child = state.children[segment.tap]!;
      const iy = code >> 4;
      const style = TAP_STYLES[code & 15]!;
      sizing.tapStyles.push(style);
      const tee = model.tee(style, child.options[0]![iy]!, child.run.airflowM3h, leg, segment.flowIn);
      if (!reconstructRun(child, iy, i - steps(tee.loss, grid), solver, out)) return false;
    }
    const next = state.argNext[k]![x]![i]!;
    const after = lossAfter(segment, leg, model);
    if (next === -2 || k === state.segments.length - 1) {
      i -= steps(after, grid);
      return reconstructEnd(state, x, i, solver, out, sizing);
    }
    if (next < 0) return false;
    const nextLeg = state.options[k + 1]![next]!;
    const reducer = sameLeg(leg, nextLeg) ? { loss: 0 } : model.transition(leg, nextLeg, state.segments[k + 1]!.flowIn);
    i -= steps(after + reducer.loss, grid);
    x = next;
  }
  return true;
}

function reconstructEnd(state: RunState, x: number, i: number, solver: Solver, out: Map<string, RunSizing>, sizing: RunSizing): boolean {
  const { model, grid } = solver;
  const run = state.run;
  if (i < 0) return false;
  if (run.end.kind === 'split') {
    const code = state.argEnd[x]?.[i] ?? -1;
    if (code < 0) return false;
    const style = SPLIT_STYLES[Math.floor(code / 1_000_000)]!;
    const ia = Math.floor(code / 1000) % 1000;
    const ib = code % 1000;
    sizing.splitStyle = style;
    const [plus, minus] = state.children.slice(run.taps.length) as [RunState, RunState];
    const leg = state.options[state.segments.length - 1]![x]!;
    const flow = state.segments.at(-1)!.flowOut;
    const a = model.splitOutlet(style, leg, flow, plus.options[0]![ia]!, plus.run.airflowM3h);
    const b = model.splitOutlet(style, leg, flow, minus.options[0]![ib]!, minus.run.airflowM3h);
    return reconstructRun(plus, ia, i - steps(a.loss, grid), solver, out)
      && reconstructRun(minus, ib, i - steps(b.loss, grid), solver, out);
  }
  if (run.end.kind === 'plenum') {
    const args = (state as RunState & { argSpigots?: Int32Array[] }).argSpigots ?? [];
    const leg = state.options[state.segments.length - 1]![x]!;
    const flow = state.segments.at(-1)!.flowOut;
    const budget = i - steps(plenumEntryLossPa(leg, flow), grid);
    sizing.spigotStyles = [];
    const children = state.children.slice(run.taps.length);
    for (let c = 0; c < children.length; c += 1) {
      const code = args[c]?.[budget] ?? -1;
      if (code < 0) return false;
      const iy = code >> 4;
      const style = SPIGOT_STYLES[code & 15]!;
      sizing.spigotStyles.push(style);
      const part = model.spigot(style, children[c]!.options[0]![iy]!, children[c]!.run.airflowM3h);
      if (!reconstructRun(children[c]!, iy, budget - steps(part.loss, grid), solver, out)) return false;
    }
  }
  return true;
}

/** Why a design tree has no size set at all: the run, and the rule that rules out every section there. */
export interface SizingFailure {
  runKey: string;
  reason: 'end-terminal' | 'end-split' | 'end-plenum' | 'take-off' | 'section-change' | 'collar' | 'unknown';
  /** The take-off (index into the run's taps) or the split outlet side it concerns. */
  tap?: number;
  detail: string;
}

const alive = (state: RunState) => state.G[0]?.some((frontier) => frontier.some(Number.isFinite)) ?? false;

/** The deepest run with no size set, and why (the child is explained before its parent). */
function explainInfeasible(state: RunState, model: SizingModel): SizingFailure {
  for (const child of state.children) if (!alive(child)) return explainInfeasible(child, model);
  const run = state.run;
  const lastIndex = state.segments.length - 1;
  const endAlive = state.end.some((frontier) => frontier?.some(Number.isFinite));
  if (!endAlive) {
    if (run.end.kind === 'terminal') {
      const last = run.vertices.length > 1 ? Math.hypot(run.vertices.at(-1)!.x - run.vertices.at(-2)!.x, run.vertices.at(-1)!.y - run.vertices.at(-2)!.y) : 0;
      return { runKey: run.key, reason: 'end-terminal', detail: `last leg ${Math.round(last)} mm; the fitting down to the Ø${run.end.terminal.neck} neck needs ${END_TRANSITION_MIN_LEG_MM} mm` };
    }
    if (run.end.kind === 'split') {
      const outlets = state.children.slice(run.taps.length);
      const rooms = outlets.map((child) => Math.round(firstEventMm(child.run, child.children, model)));
      return { runKey: run.key, reason: 'end-split', detail: `no split style fits its outlets (straight before their first fitting: ${rooms.join(' / ')} mm)` };
    }
    if (run.end.kind === 'plenum') return { runKey: run.key, reason: 'end-plenum', detail: 'no spigot fits the plenum' };
  }
  for (let k = lastIndex; k >= 0; k -= 1) {
    if (state.G[k]!.some((frontier) => frontier.some(Number.isFinite))) continue;
    const segment = state.segments[k]!;
    const corridorMm = segmentCorridorMm(run, segment);
    const corridor = Number.isFinite(corridorMm) ? `; corridor ${Math.round(corridorMm)} mm` : '';
    const options = state.options[k]!;
    const alive = state.alive[k] ?? [];
    const sizes = `${options.length} section${options.length === 1 ? '' : 's'}${corridor}`;
    if (segment.tap !== null) {
      const child = state.children[segment.tap]!;
      const compatible = options.some((leg) => child.options[0]!.some((y) => tapStyles(leg, y, child, model).length > 0));
      if (!compatible) {
        return { runKey: run.key, reason: 'take-off', tap: segment.tap, detail: `no take-off joins its branch (${child.options[0]!.length} sections) to this main (${sizes})` };
      }
      if (!alive.some((entry) => entry.branch)) {
        return { runKey: run.key, reason: 'take-off', tap: segment.tap, detail: child.run.allFlex
          ? `its all-flex runout fits from none of this main's sections (${sizes})`
          : `no branch size that can be built joins any of this main's sections (${sizes})` };
      }
      if (alive.some((entry) => entry.main) && !alive.some((entry) => entry.main && entry.branch)) {
        return { runKey: run.key, reason: 'take-off', tap: segment.tap, detail: `the sections that can take its branch cannot carry on along the run (${sizes})` };
      }
    }
    return { runKey: run.key, reason: 'section-change', tap: segment.tap ?? undefined, detail: `no section can follow at segment ${k} (reducer room ${Math.round(segment.reducerRoomMm)} mm; ${sizes})` };
  }
  return { runKey: run.key, reason: 'unknown', detail: 'no size set' };
}

/**
 * Sizes a design tree: the root frontier (least first cost per fan pressure,
 * collar transition and fan-outlet compromise included) and the sizes for any
 * point on it. When there is none, `onFailure` hears why.
 */
export function sizeDesign(design: ServiceDesign, model: SizingModel, grid: DpGrid, onFailure?: (failure: SizingFailure) => void): DesignFrontier | null {
  const solver: Solver = { model, grid, states: new Map() };
  const root = solveRun(design.root, solver);
  const collar: DuctLeg = { widthMm: model.ctx.port.widthMm, heightMm: model.ctx.port.heightMm };
  const connector = FITTING_LOSS_COEFFICIENTS.connector * velocityPressurePa(velocityMs(collar, model.ctx.airflowM3h));
  const cost = filled(grid, INF);
  const arg = new Int32Array(grid.size).fill(-1);
  // The connector and the collar transition must fit on the root's first leg with the take-off windows
  // the leg carries (the realiser spreads them downstream), before its first elbow.
  const connectorMm = model.settings.flexibleConnectorAtUnit ? model.settings.connectorFabricMm + 2 * model.settings.connectorMetalMm : 0;
  const bends = runBends(root.run);
  const firstBend = bends[0]?.station ?? Number.POSITIVE_INFINITY;
  const plenumMm = root.run.end.kind === 'plenum' ? root.run.end.lengthMm : 0;
  const runEnd = runLengthMm(root.run) - plenumMm - 100;
  const legEnd = Math.min(firstBend, runEnd);
  const windowsIn = (from: number, to: number) => root.run.taps.reduce((total, tap, index) => total + (tap.station > from && tap.station < to ? 2 * windowHalfMm(root.children[index]!, model) : 0), 0);
  const windows = windowsIn(-1, legEnd);
  // Turn first (the collar straight too short for its transition): a square vaned elbow at the collar's own
  // section, and the transition on the next leg, which holds it with that leg's take-off windows.
  const flow = root.segments[0]!.flowIn;
  const neck = model.settings.elbowNeckMm;
  const collarTurnMm = model.elbowSetbackMm(collar) + neck;
  const secondEnd = Math.min(bends[1]?.station ?? Number.POSITIVE_INFINITY, runEnd);
  const turnable = Number.isFinite(firstBend) && Math.abs(bends[0]!.angleDeg - 90) < 1 && windows === 0 && connectorMm + collarTurnMm <= firstBend + 1e-6;
  const collarElbow = turnable ? model.elbow(collar, 90, flow) : null;
  const windowsNext = turnable ? windowsIn(firstBend, secondEnd) : 0;
  /** Per first section: whether it is reached by turning first, and the extra loss that costs (Pa). */
  const turned = new Uint8Array(root.options[0]!.length);
  const extraLoss = new Float64Array(root.options[0]!.length);
  root.options[0]!.forEach((leg, x) => {
    const transition = model.transition(collar, leg, flow);
    const bendSetback = Number.isFinite(firstBend) ? model.elbowSetbackMm(leg) + neck : 0;
    if (connectorMm + transition.lengthMm + windows <= legEnd - bendSetback + 1e-6) {
      minShiftedInto(cost, arg, root.G[0]![x]!, transition.cost + design.penalty, steps(transition.loss + connector + (design.pressurePenaltyPa ?? 0), grid), x);
      return;
    }
    if (!collarElbow) return;
    const nextSetback = Number.isFinite(bends[1]?.station ?? Number.POSITIVE_INFINITY) ? model.elbowSetbackMm(leg) + neck : 0;
    if (collarTurnMm + transition.lengthMm + windowsNext > secondEnd - firstBend - nextSetback + 1e-6) return;
    // The collar's elbow replaces the one the sizing priced on this section, and the stretch up to it is the collar's.
    const trunkElbow = model.elbow(leg, 90, flow);
    const stretch = (firstBend + collarTurnMm) / 1000;
    const extraCost = collarElbow.cost - trunkElbow.cost + (model.costPerMetre(collar) - model.costPerMetre(leg)) * stretch;
    turned[x] = 1;
    extraLoss[x] = Math.max(0, collarElbow.loss - trunkElbow.loss);
    minShiftedInto(cost, arg, root.G[0]![x]!, transition.cost + design.penalty + extraCost,
      steps(transition.loss + connector + (design.pressurePenaltyPa ?? 0) + extraLoss[x]!, grid), x);
  });
  if (!cost.some(Number.isFinite)) {
    onFailure?.(alive(root) ? {
      runKey: root.run.key, reason: 'collar',
      detail: `the connector, collar transition and ${Math.round(windows)} mm of take-off windows do not fit before the first elbow (${Math.round(legEnd)} mm)`,
    } : explainInfeasible(root, model));
    return null;
  }
  return {
    design, grid, cost,
    reconstruct(index: number): SizedDesign | null {
      const x = arg[index] ?? -1;
      if (x < 0 || !Number.isFinite(cost[index]!)) return null;
      const leg = root.options[0]![x]!;
      const transition = model.transition(collar, leg, root.segments[0]!.flowIn);
      const sizing = new Map<string, RunSizing>();
      if (!reconstructRun(root, x, index - steps(transition.loss + connector + (design.pressurePenaltyPa ?? 0) + extraLoss[x]!, grid), solver, sizing)) return null;
      if (turned[x]) sizing.get(root.run.key)!.collarTurn = true;
      return { design, sizing, modelCost: cost[index]!, modelPressurePa: index * grid.stepPa };
    },
  };
}

/** Points of a frontier where the cost steps down (the Pareto points), as (index, cost). */
export function frontierPoints(cost: Float64Array): Array<{ index: number; cost: number }> {
  const out: Array<{ index: number; cost: number }> = [];
  let previous = INF;
  for (let i = 0; i < cost.length; i += 1) {
    if (cost[i]! < previous - 1e-9) {
      out.push({ index: i, cost: cost[i]! });
      previous = cost[i]!;
    }
  }
  return out;
}
