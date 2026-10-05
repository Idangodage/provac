/**
 * The tree router: the least-cost flow-weighted Steiner arborescence from the
 * collar to every terminal on the escape grid (routingGraph.ts), solved
 * exactly by the Dreyfus–Wagner dynamic programme over terminal subsets.
 *
 * State. D[S][v,h,c] is the cheapest subtree that serves the terminal set S
 * when the duct arrives at node v heading h, having run c steps (100 mm each,
 * capped at the layer's fitting length: an elbow's setback and a take-off
 * window) straight since its previous fitting. Fittings — an elbow, a
 * take-off, a split — need the full length and restart the count, so the
 * trees it finds leave room for the fittings the planner will make (SMACNA:
 * take-offs on straights clear of elbows and of each other).
 *
 * Every layer S carries exactly the airflow of S, so its duct is priced
 * exactly per metre — the cheapest section that fits the edge's corridor at
 * that flow, plus λ times its friction (λ = the price of a pascal of fan
 * pressure) — and its elbows likewise. A layer is built from
 *  - its leaves (|S| = 1): a runout candidate in front of or beside the
 *    terminal, costed with its flexible runout;
 *  - merges at a node: a take-off (the main A goes straight on, the branch
 *    B = S \ A leaves square to either side), or an end split into two trunks,
 *    each with its fitting;
 *  - growth: a shortest-path pass through the grid (straight on, or a 90°
 *    turn with an elbow).
 * A main that runs on into its last terminal does so straight, with room for
 * its reducer. An edge through a wall (a system spanning rooms) is priced
 * with its crossing, and the wall counts as a fitting of its own: the duct
 * enters it only with a fitting's reach of straight before its near face, and
 * leaves it as if a fitting had just ended at its far face. Where two runs of
 * a tree would share an edge or cross, the conflict is blocked for the
 * smaller subtree and the programme solved again
 * (routeTrees). The result is optimal on the grid for its λ and its blocks;
 * the sizing DP then sizes the tree exactly and the planner judges it.
 * Time O(3^k·|V|), memory O(2^k·|V|): it runs up to the settings' limit.
 */
import type { Point2D } from '../../../../../types';
import { branchStubMm, flexClear, flexOk, runoutPath, runoutStaysOut, simplifyCollinear, type AutoDuctIssue, type ServiceCtx, type TerminalCtx } from '../ductAutoContext';
import { PENETRATION_JOINT_MARGIN_MM } from '../ductPenetrations';
import { flexBendLossPa } from '../ductPressure';
import { maxRoundBranchMm } from '../ductRoundFittings';
import { isRoundLeg, roundLeg, type DuctLeg, type DuctTapStyle } from '../ductTypes';

import { allRuns, computeFlows, runLengthMm, type DesignStart, type RunDesign, type ServiceDesign } from './designTree';
import { DIRECTIONS, leftOf, rightOf, reverseOf, ROUTE_CLEARANCE_MM, terminalVariants, type RoutingGraph } from './routingGraph';
import type { SizingModel } from './sizingModel';

const INF = Number.POSITIVE_INFINITY;
const LEAF = 1;
const TEE_LEFT = 2;
const TEE_RIGHT = 3;
const SPLIT = 4;
/** A take-off whose branch is only its collar and damper, then flex into the terminal. */
const STUB_LEFT = 5;
const STUB_RIGHT = 6;
/** A wye on a round main: each outlet runs straight for its 45° leg and elbow (Fig. 3-5) before anything else. */
const SPLIT_WYE = 7;
const MOVE = 8;
/** A run's last terminal off its side on an all-flex stub, the run ending in a cap just past it. */
const STUB_END_LEFT = 20;
const STUB_END_RIGHT = 21;
/** How far a run ending on a stub runs on past it to its cap (the take-off window and the cap's reserve; mm). */
const STUB_END_RUN_ON_MM = 250;
/** Straight a main needs past its last take-off before its next fitting: the window and the reducer to the branch size (mm, practice). */
const MAIN_TAIL_MM = 900;

interface LayerPrice {
  /** Section outer half-widths, ascending, and the least price per mm among the sections up to each. */
  halves: Float64Array;
  prices: Float64Array;
  best: DuctLeg | null;
  /** A 90° elbow on the layer's cheapest section, with its pressure priced. */
  elbow: number;
  /** Straight needed between two fittings on this layer (an elbow's setback and neck, and a margin; mm). */
  clearMm: number;
  /** One fitting's own reach on this layer (the larger of an elbow's and a take-off window's; mm). */
  reachMm: number;
  /** Outer half-width of the cheapest section: a corner or split needs this much room round its node, plus clearance. */
  halfMm: number;
}

function outerHalfMm(leg: DuctLeg, model: SizingModel): number {
  return leg.widthMm / 2 + 1 + model.costContext.insulationMm;
}

/**
 * Straight a run to one terminal keeps after its last fitting (mm), the least
 * of the two ends the sizing may build: stepped down to the neck before that
 * elbow (the elbow alone, setback and neck, then the runout), or at the
 * layer's section with the fitting down to the neck and its lead after it.
 */
function leafStraightMm(model: SizingModel, best: DuctLeg, neckMm: number): number {
  const neck = roundLeg(neckMm);
  return Math.min(
    model.elbowSetbackMm(neck) + model.settings.elbowNeckMm,
    model.bendReachMm(best) + model.endStraightMm(best, neckMm),
  );
}

/**
 * Straight a layer needs between two fittings, from the realiser's own rules
 * (sizingModel): an elbow's reach (setback, neck, margin; a rectangular 90°
 * turn square vaned) and the widest take-off window a branch of `branchNeckMm`
 * cuts in it. The largest pair, so any two fittings in a row fit (conservative
 * by at most one reach). A single terminal's layer also holds its end straight.
 */
function layerClearMm(model: SizingModel, best: DuctLeg, neckMm: number | null, branchNeckMm: number): { clearMm: number; reachMm: number } {
  const reach = model.bendReachMm(best);
  if (neckMm !== null) return { clearMm: Math.max(2 * reach, leafStraightMm(model, best, neckMm)), reachMm: reach };
  const branch = roundLeg(branchNeckMm);
  const styles: DuctTapStyle[] = isRoundLeg(best) ? [...model.settings.autoRoundMainStyles] : ['spin-in', 'conical'];
  const window = Math.max(0, ...styles.map((style) => model.tapWindowHalfMm(style, branch, best)));
  return { clearMm: Math.max(2 * reach, reach + window, 2 * window), reachMm: Math.max(reach, window) };
}

function layerPrice(model: SizingModel, flow: number, neckMm: number | null, lambda: number, branchNeckMm = 250): LayerPrice {
  const options = neckMm !== null ? model.branchOptions(flow, neckMm) : model.trunkOptions(flow);
  const entries = options
    .map((leg) => ({ leg, half: outerHalfMm(leg, model), price: (model.costPerMetre(leg) + lambda * model.friction(leg, flow, 1000)) / 1000 }))
    .filter((entry) => Number.isFinite(entry.price))
    .sort((a, b) => a.half - b.half);
  const halves = new Float64Array(entries.length);
  const prices = new Float64Array(entries.length);
  let best: { leg: DuctLeg; price: number } | null = null;
  entries.forEach((entry, index) => {
    halves[index] = entry.half;
    if (!best || entry.price < best.price) best = { leg: entry.leg, price: entry.price };
    prices[index] = best.price;
  });
  const bestLeg = (best as { leg: DuctLeg } | null)?.leg ?? null;
  const elbow = bestLeg ? model.elbow(bestLeg, 90, flow) : null;
  return {
    halves, prices, best: bestLeg,
    elbow: elbow ? elbow.cost + lambda * elbow.loss : INF,
    ...(bestLeg ? layerClearMm(model, bestLeg, neckMm, branchNeckMm) : { clearMm: 600, reachMm: 300 }),
    halfMm: bestLeg ? outerHalfMm(bestLeg, model) : 0,
  };
}

/** Least price per mm of a section that fits a corridor (its outer half + the clearance within it). */
function priceFor(layer: LayerPrice, corridorMm: number): number {
  const limit = corridorMm - ROUTE_CLEARANCE_MM;
  let lo = 0;
  let hi = layer.halves.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (layer.halves[mid]! <= limit) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found < 0 ? INF : layer.prices[found]!;
}

/** Binary min-heap of (key, item) on typed arrays: the router's Dijkstra pops millions, allocating nothing. */
class Heap {
  private keys = new Float64Array(1024);
  private items = new Int32Array(1024);
  size = 0;
  /** The least key (read before pop). */
  get topKey(): number { return this.keys[0]!; }
  push(key: number, item: number): void {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2);
      keys.set(this.keys);
      this.keys = keys;
      const items = new Int32Array(this.size * 2);
      items.set(this.items);
      this.items = items;
    }
    const keys = this.keys;
    const items = this.items;
    let i = this.size;
    this.size += 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent]! <= key) break;
      keys[i] = keys[parent]!;
      items[i] = items[parent]!;
      i = parent;
    }
    keys[i] = key;
    items[i] = item;
  }
  /** Removes the least entry and returns its item (its key is topKey before the call). */
  pop(): number {
    const keys = this.keys;
    const items = this.items;
    const top = items[0]!;
    this.size -= 1;
    const n = this.size;
    if (n > 0) {
      const key = keys[n]!;
      const item = items[n]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && keys[r]! < keys[l]! ? r : l;
        if (keys[m]! >= key) break;
        keys[i] = keys[m]!;
        items[i] = items[m]!;
        i = m;
      }
      keys[i] = key;
      items[i] = item;
    }
    return top;
  }
}

/** Elementwise least of two arrays. */
function minOf(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i]! < b[i]! ? a[i]! : b[i]!;
  return out;
}

function popcount(value: number): number {
  let count = 0;
  for (let v = value; v; v &= v - 1) count += 1;
  return count;
}

/** Edges (node·4 + direction) a subtree may not use, by the terminal set of its layer. */
export type BlockedEdges = Map<number, Set<number>>;

/** Where a tree's runs are: the grid edges and nodes each uses (for the conflict repair). */
interface Usage {
  edges: Map<number, number[]>;
  nodes: Map<number, Array<{ run: string; set: number; start: boolean }>>;
}

function edgeKey(a: number, b: number): number {
  return Math.min(a, b) * 1_000_003 + Math.max(a, b);
}

function treeSignature(run: RunDesign): unknown[] {
  return [run.vertices.map((v) => [Math.round(v.x), Math.round(v.y)]), ...run.taps.map((tap) => treeSignature(tap.child)),
    ...(run.end.kind === 'split' ? run.end.children.map(treeSignature) : [])];
}

export interface SteinerSolution {
  designs: ServiceDesign[];
  usages: Usage[];
  /** The model's cost of the best tree (currency, pressure priced by λ). */
  modelCost: number;
  /** Time spent (routeTrees: over all its repair rounds). */
  seconds: number;
  /** routeTrees: the solves after the first that removed conflicts between runs. */
  repairs?: number;
  /** Outer half-width of the section the router priced for a terminal set (mm). */
  halfOf?: (set: number) => number;
}

/**
 * What earlier rounds found unbuildable, forbidden in the next (lazy
 * constraint generation; see routerCuts.ts): take-offs, all-flex stubs and
 * splits by the terminal set at a node, runout starts by terminal set and
 * `node·4 + heading`, and root nodes.
 */
export interface RouterCuts {
  tees: Map<number, Set<number>>;
  stubs: Map<number, Set<number>>;
  splits: Map<number, Set<number>>;
  leaves: Map<number, Set<number>>;
  roots: Set<number>;
}

export function emptyCuts(): RouterCuts {
  return { tees: new Map(), stubs: new Map(), splits: new Map(), leaves: new Map(), roots: new Set() };
}

interface SavedLayer {
  d: Float64Array;
  gs: Float64Array;
  gb: Float64Array;
  how: Int8Array;
  subset: Int32Array | null;
  layer: LayerPrice;
  tailValue: Float64Array | null;
  tailLand: Int32Array | null;
  leafVariant: Int8Array | null;
}

/**
 * The layers of the last solve on one graph at one price of pressure, kept
 * for the next (routeTrees' conflict rounds, the feasibility loop's rounds).
 * A layer is reused when nothing it depends on changed: no block and no cut
 * on any subset of its terminal set (the layers below it are then the same).
 */
export interface LayerMemo {
  key: string;
  signatures: Map<number, string>;
  saved: Map<number, SavedLayer>;
}

export function newLayerMemo(): LayerMemo {
  return { key: '', signatures: new Map(), saved: new Map() };
}

/** A memo kept between calls holds a solve's tables alive: worth it up to this size (bytes). */
const MEMO_MAX_BYTES = 64 * 1024 * 1024;

/** Whether a memo for `terminals` on `graph` is small enough to keep between calls (grouped: the routed subsets only). */
export function layerMemoWorthKeeping(graph: RoutingGraph, terminals: number, groups?: number[][]): boolean {
  const subsets = groups && groups.length > 1
    ? groups.reduce((sum, group) => sum + (1 << group.length), 0) + (1 << groups.length)
    : (1 << terminals);
  // Per state: the value (8 bytes), the decision (1) and the subset split (4).
  return subsets * graph.nodeCount * 4 * LEVELS * 13 <= MEMO_MAX_BYTES;
}

export interface SteinerOptions {
  /** Forbidden by earlier rounds of the feasibility loop. */
  cuts?: RouterCuts;
  /** Layers of the previous solve on this graph at this price, reused where unchanged. */
  memo?: LayerMemo;
  /** routeTrees: no repair round starts after this time (epoch ms). */
  deadline?: number;
  /** Price of a pascal of fan pressure in the routing (currency). */
  lambda: number;
  label: string;
  /** The full fan-outlet straight (mm); shorter roots carry the system effect. */
  fanOutletMm: number;
  /** Extra fan pressure of a shortened fan outlet (Pa). */
  shortOutletPenaltyPa: number;
  maxTerminals: number;
  /**
   * More terminals than `maxTerminals`: groups of terminal indices (groupTerminals). The router then
   * solves only subsets inside one group and unions of whole groups — exact within each group and
   * between the groups, each group served as one subtree (a heuristic, and labelled so).
   */
  groups?: number[][];
  blocked?: BlockedEdges;
  /** Shortest root that may turn at its end (connector, collar transition and an elbow's setback, mm). */
  rootTurnMinMm?: number;
}

/** Clearance is counted in steps of this much straight (mm), up to a layer's fitting length. */
const CLEAR_STEP_MM = 100;
/** Levels a state carries: 0 … LEVELS − 1 (the top level = clear for a fitting); up to 1.5 m of straight. */
const LEVELS = 16;
/** A take-off's branch runs this much straight past its collar and damper before its first fitting (the realiser's rule; mm). */
const BRANCH_LEAD_MM = 150;
/** A runout's rigid branch needs at least this straight since its last fitting (its collar, damper and flex start; mm). */
const LEAF_STRAIGHT_MM = 400;
/** Trees built from the best roots only (each is sized and verified; the rest cost more on the model). */
const ROOTS_KEPT = 6;

interface StubRunoutSide { length: Float64Array; bendLossPa: Float64Array }

/** All-flex runouts per side, geometry and fixed terminal flow, shared by every solve on the graph. */
const STUB_GEOMETRY = new WeakMap<RoutingGraph, Map<string, StubRunoutSide[]>>();

/**
 * Terminal `index`'s all-flex branch leaving each directed state with its stub end `reach` from the node:
 * each spigot side that bends within limits and runs clear (∞ where none does).
 * Keep their bend losses as well as lengths: a shorter curved side need not
 * be cheaper at every price of pressure.
 */
function stubGeometry(ctx: ServiceCtx, model: SizingModel, graph: RoutingGraph, index: number, terminal: TerminalCtx, reach: number, mainHalfMm: number): StubRunoutSide[] {
  let cache = STUB_GEOMETRY.get(graph);
  if (!cache) STUB_GEOMETRY.set(graph, (cache = new Map()));
  const key = `${index}:${reach}:${Math.round(mainHalfMm)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const directed = graph.nodeCount * 4;
  const sides = terminalVariants(terminal).map((candidate) => {
    const length = new Float64Array(directed).fill(INF);
    const bendLossPa = new Float64Array(directed);
    for (let s = 0; s < directed; s += 1) {
      const v = s >> 2;
      const dirV = DIRECTIONS[s & 3]!;
      const end = { x: graph.nodeX[v]! + dirV.x * reach, y: graph.nodeY[v]! + dirV.y * reach };
      if (Math.hypot(candidate.lip.x - end.x, candidate.lip.y - end.y) > ctx.settings.flexMaxLengthMm) continue;
      const fit = model.flexRunoutCurve(end, dirV, candidate);
      if (!flexOk(fit, candidate, ctx.settings) || !flexClear(ctx, end, dirV, ctx.bottomZ, candidate)) continue;
      // Not back across the main it leaves.
      if (!runoutStaysOut(ctx, { x: graph.nodeX[v]!, y: graph.nodeY[v]! }, dirV, end, ctx.bottomZ, candidate, mainHalfMm)) continue;
      length[s] = fit.lengthMm;
      bendLossPa[s] = flexBendLossPa(fit.points, candidate.neck, candidate.airflowM3h);
    }
    return { length, bendLossPa };
  });
  cache.set(key, sides);
  return sides;
}

/** Most terminals the grouped router takes (its subset tables are indexed by bit mask). */
export const GROUPED_MAX_TERMINALS = 16;

/**
 * Terminals in groups of at most `size` for the grouped router, in the
 * collar's frame: rows across its axis (a gap of more than 900 mm along it
 * starts a new row), and a longer row cut into balanced runs across.
 */
export function groupTerminals(terminals: readonly TerminalCtx[], size: number): number[][] {
  const order = terminals.map((_, index) => index)
    .sort((a, b) => terminals[a]!.lip.x - terminals[b]!.lip.x || terminals[a]!.lip.y - terminals[b]!.lip.y);
  const rows: number[][] = [];
  for (const index of order) {
    const row = rows[rows.length - 1];
    const previous = row ? terminals[row[row.length - 1]!]! : null;
    if (row && previous && terminals[index]!.lip.x - previous.lip.x <= 900) row.push(index);
    else rows.push([index]);
  }
  return rows.flatMap((row) => {
    const across = [...row].sort((a, b) => terminals[a]!.lip.y - terminals[b]!.lip.y);
    const parts = Math.ceil(across.length / size);
    return Array.from({ length: parts }, (_, part) => across.slice(Math.round((part * across.length) / parts), Math.round(((part + 1) * across.length) / parts)));
  });
}

export function steinerTrees(ctx: ServiceCtx, model: SizingModel, graph: RoutingGraph, options: SteinerOptions): SteinerSolution | null {
  const started = Date.now();
  const terminals = ctx.terminals;
  const k = terminals.length;
  const groupMasks = options.groups && k > options.maxTerminals ? options.groups.map((group) => group.reduce((mask, index) => mask | (1 << index), 0)) : null;
  // A terminal without a rigid runout candidate can still be reached by an
  // all-flex take-off. Its singleton layer tries both kinds of ending below.
  if (!k || (k > options.maxTerminals && !groupMasks) || k > GROUPED_MAX_TERMINALS || !graph.roots.length) return null;
  /** The subsets routed: all of them, or (grouped) those inside one group and the unions of whole groups. */
  const inFamily = (S: number): boolean => !groupMasks
    || groupMasks.some((mask) => (S & ~mask) === 0)
    || groupMasks.every((mask) => (S & mask) === 0 || (S & mask) === mask);
  const { lambda } = options;
  const directed = graph.nodeCount * 4;
  /** State index: (node·4 + heading)·LEVELS + level; the level counts the straight since the last fitting. */
  const states = directed * LEVELS;
  const full = (1 << k) - 1;
  const nb = graph.neighbour;
  const flows = new Float64Array(full + 1);
  for (let S = 1; S <= full; S += 1) {
    for (let i = 0; i < k; i += 1) if (S & (1 << i)) flows[S] += terminals[i]!.airflowM3h;
  }
  const blocked = options.blocked;
  const isBlocked = (S: number, v: number, dir: number) => Boolean(blocked?.get(v * 4 + dir)?.has(S));
  const D: Array<Float64Array | null> = new Array(full + 1).fill(null);
  /** The straight move out of (v, h) after a fitting there (clearance restarts), per directed state. */
  const GS: Array<Float64Array | null> = new Array(full + 1).fill(null);
  /** The same for a branch leaving a take-off: its collar and damper do not count towards the clearance. */
  const GB: Array<Float64Array | null> = new Array(full + 1).fill(null);
  const neckLeg = { widthMm: 200, heightMm: 200, diameterMm: 200 };
  const collarMm = Math.max(model.collarLengthMm('round-conical', neckLeg), model.collarLengthMm('conical', neckLeg)) + model.settings.vcdLengthMm;
  const how: Array<Int8Array | null> = new Array(full + 1).fill(null);
  const subset: Array<Int32Array | null> = new Array(full + 1).fill(null);
  const layers: Array<LayerPrice | null> = new Array(full + 1).fill(null);
  /**
   * Single terminals: a main carrying on past its last take-off runs at least MAIN_TAIL_MM straight
   * (then anything); the cost of that and where it lands (node·4 + heading).
   */
  const tailValue: Array<Float64Array | null> = new Array(full + 1).fill(null);
  const tailLand: Array<Int32Array | null> = new Array(full + 1).fill(null);
  /** Single terminals: the cheaper of the tail and going straight on as usual, per directed state. */
  const tailOrOn: Array<Float64Array | undefined> = new Array(full + 1);
  const stubMm = branchStubMm(ctx.settings);
  /**
   * How far an all-flex branch's stub end lies from its main's centreline, as the realiser builds it: the
   * main's half, the collar of the take-off fitting (beyond the standard collar) and the damper stub.
   */
  const stubReachMm = (main: DuctLeg, neckMm: number): number => {
    const neck = roundLeg(neckMm);
    return main.widthMm / 2 + stubMm + Math.max(0, model.collarLengthMm(fittingStyle(main, neck), neck) - ctx.settings.tapCollarMm);
  };
  /**
   * The main a take-off to a branch of Ø`neckMm` is cut into, for layer S: the cheapest of its sections
   * (and the ones the sizing adds for take-offs) that such a branch fits — a spin-in needs the trunk
   * Ø + 50 high, a round main at most ⅔ … — as the sizing will choose it. Cached.
   */
  const tapMainCache = new Map<string, DuctLeg | null>();
  const tapMainFor = (S: number, neckMm: number): DuctLeg | null => {
    const key = `${S}:${neckMm}`;
    if (tapMainCache.has(key)) return tapMainCache.get(key)!;
    const flow = flows[S]!;
    const candidates = [...model.trunkOptions(flow)];
    const round = model.settings.autoRoundSizesMm.find((size) => maxRoundBranchMm(size) >= neckMm - 0.5 && size <= model.maxHeightMm);
    if (round && model.shape !== 'rect') candidates.push({ widthMm: round, heightMm: round, diameterMm: round });
    const h = Math.ceil((neckMm + 50) / 50) * 50;
    if (model.shape !== 'round' && h <= model.maxHeightMm) {
      for (let w = h; w <= 4 * h; w += 50) {
        if (flow / 3600 / ((w / 1000) * (h / 1000)) <= model.settings.autoMaxVelocityTrunkMs * 1.001) { candidates.push({ widthMm: w, heightMm: h }); break; }
      }
    }
    const fits = candidates.filter((leg) => (isRoundLeg(leg) ? maxRoundBranchMm(leg.diameterMm!) >= neckMm - 0.5 : leg.heightMm >= neckMm + 50 - 0.5));
    const best = fits.reduce<DuctLeg | null>((least, leg) => (!least || model.costPerMetre(leg) < model.costPerMetre(least) ? leg : least), null);
    tapMainCache.set(key, best);
    return best;
  };
  /**
   * Single terminal B: an all-flex branch leaving node v along d — the stub, then the runout as the
   * planner curves it, clear of other equipment — for a stub end `reach` from the node. Cached per reach.
   */
  const stubCache = new Map<string, { value: Float64Array; variant: Int8Array }>();
  const stubsFor = (B: number, reach: number, mainHalf: number): { value: Float64Array; variant: Int8Array } => {
    const key = `${B}:${Math.round(reach)}:${Math.round(mainHalf)}`;
    const cached = stubCache.get(key);
    if (cached) return cached;
    const terminal = terminals[Math.log2(B)]!;
    const sides = stubGeometry(ctx, model, graph, Math.log2(B), terminal, Math.round(reach), mainHalf);
    const value = new Float64Array(directed).fill(INF);
    const variant = new Int8Array(directed);
    sides.forEach((geometry, side) => {
      for (let s = 0; s < directed; s += 1) {
        const length = geometry.length[s]!;
        if (!Number.isFinite(length)) continue;
        const runout = model.flex(terminal.neck, terminal.airflowM3h, length, geometry.bendLossPa[s]!);
        const price = runout.cost + lambda * runout.loss;
        if (price < value[s]!) { value[s] = price; variant[s] = side; }
      }
    });
    const entry = { value, variant };
    stubCache.set(key, entry);
    return entry;
  };
  /** Single terminals: the spigot side each leaf state's runout serves. */
  const leafVariant: Array<Int8Array | null> = new Array(full + 1).fill(null);
  /** Take-off windows are sized for the widest terminal neck the service has (a conservative branch). */
  const branchNeckMm = Math.max(...terminals.map((terminal) => terminal.neck));
  const order = Array.from({ length: full }, (_, index) => index + 1).filter(inFamily).sort((a, b) => popcount(a) - popcount(b));
  const fittingStyle = (main: DuctLeg, branch: DuctLeg): DuctTapStyle => (isRoundLeg(main) ? 'round-conical' : isRoundLeg(branch) ? 'spin-in' : 'shoe-45');
  /** The layer's clear level: its fitting length in steps. */
  const topOf = (layer: LayerPrice) => Math.min(LEVELS - 1, Math.ceil(layer.clearMm / CLEAR_STEP_MM));
  const stepsOf = (length: number) => Math.floor(length / CLEAR_STEP_MM + 1e-9);
  /** Level on arrival after a straight of `length` from level `c` (c = 0 right after a fitting). */
  const arrive = (top: number, c: number, length: number) => Math.min(top, c + stepsOf(length));
  // Edges through walls: the straight each keeps before the wall's near face and after its far face.
  const cross = graph.cross ?? null;
  const crossCost = graph.crossCost!;
  const crossBefore = graph.crossBefore!;
  const crossAfter = graph.crossAfter!;
  /** Straight a fitting needs off a wall face on this layer (its reach and the joint margin), in levels. */
  const wallStepsOf = (layer: LayerPrice) => Math.min(topOf(layer), Math.ceil((layer.reachMm + PENETRATION_JOINT_MARGIN_MM) / CLEAR_STEP_MM));
  /** Level on arriving past the wall of edge e: as if a fitting had ended at its far face. */
  const crossArrival = (e: number, top: number, wallSteps: number) => Math.min(top, top - wallSteps + stepsOf(crossAfter[e]!));
  /** The least level a duct may enter edge e at (≤ 0: right after a fitting; `collar`: a branch's own collar and damper first). */
  const crossNeed = (e: number, wallSteps: number, collar = 0) => wallSteps - stepsOf(Math.max(0, crossBefore[e]! - collar));
  /**
   * Straight on out of (v, h) right after a fitting at v for at least `minMm`
   * on layer S: its cost (walls crossed included), where it stops and the
   * level it arrives with; null when it is blocked, or meets a wall too soon.
   */
  const straightOn = (S: number, start: number, minMm: number, layer: LayerPrice): { cost: number; node: number; level: number; crossed: boolean } | null => {
    const top = topOf(layer);
    const wallSteps = wallStepsOf(layer);
    const h = start & 3;
    let node = start >> 2;
    let cost = 0;
    let length = 0;
    // The level at the last fitting (or wall face) and the straight since it.
    let base = 0;
    let since = 0;
    let crossed = false;
    while (length < minMm) {
      const e = node * 4 + h;
      const u = nb[e]!;
      if (u < 0 || isBlocked(S, node, h)) return null;
      cost += graph.edgeLength[e]! * priceFor(layer, graph.corridor[e]!);
      if (cross && cross[e]! >= 0) {
        if (arrive(top, base, since) < crossNeed(e, wallSteps)) return null;
        cost += crossCost[e]!;
        base = crossArrival(e, top, wallSteps);
        since = 0;
        crossed = true;
      } else {
        since += graph.edgeLength[e]!;
      }
      length += graph.edgeLength[e]!;
      node = u;
    }
    if (!Number.isFinite(cost) || length <= 0) return null;
    return { cost, node, level: arrive(top, base, since), crossed };
  };
  /**
   * Straight on out of (v, h) for at least `minMm` after a fitting at v, then
   * the layer's own best from where that lands: the cost per directed state,
   * and the state it lands in (for the walk). Exact on the grid; cached.
   */
  const straightCache = new Map<string, { value: Float64Array; land: Int32Array }>();
  const straightFirst = (S: number, minMm: number): { value: Float64Array; land: Int32Array } => {
    const key = `${S}:${Math.ceil(minMm / 25)}`;
    const cached = straightCache.get(key);
    if (cached) return cached;
    const layer = layers[S]!;
    const d = D[S]!;
    const value = new Float64Array(directed).fill(INF);
    const land = new Int32Array(directed).fill(-1);
    for (let s = 0; s < directed; s += 1) {
      const walked = straightOn(S, s, minMm, layer);
      if (!walked) continue;
      const s3 = (walked.node * 4 + (s & 3)) * LEVELS + walked.level;
      const rest = d[s3]!;
      if (rest < INF) { value[s] = walked.cost + rest; land[s] = s3; }
    }
    const entry = { value, land };
    straightCache.set(key, entry);
    return entry;
  };
  /** Straight each outlet of a wye on `main` needs before its first fitting. */
  const wyeRoom = (main: DuctLeg, outlet: DuctLeg | null) => (outlet && isRoundLeg(main) ? model.diagonalRoomMm(main.diameterMm!, outlet, true) : 0);

  // The root's straight first holds the flexible connector and the collar transition (the shortest the
  // trunk's sections allow; the sizing checks the one it picks): only what is left counts as clear.
  // No root that can hold them: nothing to solve.
  const collar: DuctLeg = { widthMm: ctx.port.widthMm, heightMm: ctx.port.heightMm };
  const connectorMm = ctx.settings.flexibleConnectorAtUnit ? ctx.settings.connectorFabricMm + 2 * ctx.settings.connectorMetalMm : 0;
  const shortestTransition = Math.min(...model.trunkOptions(flows[full]!).map((leg) => model.transitionLengthMm(collar, leg).lengthMm));
  // A collar straight too short for its transition may still turn at the collar's own section (a square
  // vaned elbow) and make the transition on the next leg.
  const collarTurnMm = model.elbowSetbackMm(collar) + ctx.settings.elbowNeckMm + 25;
  const rootFits = (root: RoutingGraph['roots'][number]) => !options.cuts?.roots.has(root.node)
    && root.outletMm - connectorMm - Math.min(Number.isFinite(shortestTransition) ? shortestTransition : 0, collarTurnMm) >= 0;
  if (!graph.roots.some(rootFits)) return null;
  // What each layer depends on beyond the layers below it: blocks and cuts keyed by one of its subsets.
  const memo = options.memo ?? null;
  const memoKey = `${lambda}|${graph.nodeCount}|${model.shape}|${k}|${groupMasks?.join(',') ?? ''}`;
  if (memo && memo.key !== memoKey) { memo.key = memoKey; memo.signatures.clear(); memo.saved.clear(); }
  const dependencies: Array<{ set: number; text: string }> = [];
  if (memo) {
    for (const [edge, sets] of blocked ?? []) for (const set of sets) dependencies.push({ set, text: `b${edge}:${set}` });
    const cutEntries = (tag: string, map: Map<number, Set<number>> | undefined) => {
      for (const [set, values] of map ?? []) dependencies.push({ set, text: `${tag}${set}:${[...values].sort((a, b) => a - b).join(',')}` });
    };
    cutEntries('t', options.cuts?.tees);
    cutEntries('s', options.cuts?.stubs);
    cutEntries('p', options.cuts?.splits);
    cutEntries('l', options.cuts?.leaves);
    dependencies.sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  }
  const signatureOf = (S: number) => dependencies.filter((entry) => (entry.set & S) === entry.set).map((entry) => entry.text).join('|');

  for (const S of order) {
    const signature = memo ? signatureOf(S) : '';
    const saved = memo && memo.signatures.get(S) === signature ? memo.saved.get(S) : undefined;
    if (saved) {
      D[S] = saved.d; GS[S] = saved.gs; GB[S] = saved.gb; how[S] = saved.how; subset[S] = saved.subset;
      layers[S] = saved.layer; tailValue[S] = saved.tailValue; tailLand[S] = saved.tailLand; leafVariant[S] = saved.leafVariant;
      continue;
    }
    const single = popcount(S) === 1;
    const index = single ? Math.log2(S) : -1;
    const layer = layerPrice(model, flows[S]!, single ? terminals[index]!.neck : null, lambda, branchNeckMm);
    layers[S] = layer;
    const top = topOf(layer);
    const d = new Float64Array(states).fill(INF);
    const dec = new Int8Array(states);
    const sub = single ? null : new Int32Array(states);
    if (single) {
      const terminal = terminals[index]!;
      // The run's last leg holds its last elbow and the end the sizing builds (leafStraightMm); whole steps
      // below it, so no length that holds it is refused (the sizing and the realiser check the rest).
      const endMm = layer.best ? leafStraightMm(model, layer.best, terminal.neck) : LEAF_STRAIGHT_MM;
      const needed = Math.min(top, stepsOf(endMm));
      const bannedLeaves = options.cuts?.leaves.get(S);
      const variantOf = new Int8Array(states);
      for (const leaf of graph.leaves[index]!) {
        if (bannedLeaves?.has(leaf.node * 4 + leaf.heading)) continue;
        const runout = model.flex(terminal.neck, terminal.airflowM3h, leaf.flexLengthMm, leaf.flexBendLossPa);
        const value = runout.cost + lambda * runout.loss;
        for (let c = needed; c <= top; c += 1) {
          const s3 = (leaf.node * 4 + leaf.heading) * LEVELS + c;
          if (value < d[s3]!) { d[s3] = value; dec[s3] = LEAF; variantOf[s3] = leaf.variant; }
        }
      }
      // Or the run takes its last terminal off its side on an all-flex stub and ends in a cap just past it
      // (a trunk with take-offs and an end cap): a fitting, so where the straight arriving is clear.
      const endMain = tapMainFor(S, terminal.neck);
      if (endMain) {
        const neckLeg = roundLeg(terminal.neck);
        const fit = model.tee(fittingStyle(endMain, neckLeg), neckLeg, flows[S]!, endMain, flows[S]!);
        const fitting = fit.cost + lambda * fit.loss + model.capCost(endMain)
          + (STUB_END_RUN_ON_MM / 1000) * model.costPerMetre(endMain);
        const stubs = stubsFor(S, stubReachMm(endMain, terminal.neck), (endMain.diameterMm ?? endMain.widthMm) / 2);
        const banned = options.cuts?.stubs.get(S);
        for (let s = 0; s < directed; s += 1) {
          const v = s >> 2;
          if (banned?.has(v)) continue;
          const h = s & 3;
          const s3 = s * LEVELS + top;
          const left = stubs.value[v * 4 + ((h + 1) & 3)]! + fitting;
          if (left < d[s3]!) { d[s3] = left; dec[s3] = STUB_END_LEFT; }
          const right = stubs.value[v * 4 + ((h + 3) & 3)]! + fitting;
          if (right < d[s3]!) { d[s3] = right; dec[s3] = STUB_END_RIGHT; }
        }
      }
      leafVariant[S] = variantOf;
    } else {
      const main = layer.best;
      const bannedSplits = options.cuts?.splits.get(S);
      for (let A = (S - 1) & S; A > 0; A = (A - 1) & S) {
        const B = S ^ A;
        if (groupMasks && (!inFamily(A) || !inFamily(B))) continue;
        const gA = GS[A]!;
        const gB = GS[B]!;
        const branchLeg = layers[B]!.best;
        let tee = INF;
        let split = INF;
        if (main && branchLeg) {
          const fit = model.tee(fittingStyle(main, branchLeg), branchLeg, flows[B]!, main, flows[S]!);
          tee = fit.cost + lambda * fit.loss;
          const leftLeg = layers[A]!.best;
          // A split divides the flow into two trunks; a wye on a round main may also feed single terminals
          // (its outlets can be their neck size). A rectangular Y divides into trunks only.
          if (leftLeg && (isRoundLeg(main) || (popcount(A) >= 2 && popcount(B) >= 2))) {
            const fork = model.split(isRoundLeg(main) ? 'wye' : 'y', main, flows[S]!, [{ leg: leftLeg, airflowM3h: flows[A]! }, { leg: branchLeg, airflowM3h: flows[B]! }]);
            split = fork.cost + lambda * Math.max(...fork.losses);
          }
        }
        if (!Number.isFinite(tee) && !Number.isFinite(split)) continue;
        // A main that goes on to a single terminal first runs straight far enough for its reducer.
        const tail = popcount(A) === 1;
        // A wye's outlets leave at 45° and square up: each runs straight for that before anything else.
        const wye = main !== null && isRoundLeg(main);
        const splitA = Number.isFinite(split) && wye ? straightFirst(A, wyeRoom(main!, layers[A]!.best)).value : gA;
        const splitB = Number.isFinite(split) && wye ? straightFirst(B, wyeRoom(main!, layers[B]!.best)).value : gB;
        // A single terminal may hang off the main on an all-flex stub, laid off this main's wall.
        const tapMain = popcount(B) === 1 ? tapMainFor(S, terminals[Math.log2(B)]!.neck) : null;
        const stubs = Number.isFinite(tee) && tapMain
          ? stubsFor(B, stubReachMm(tapMain, terminals[Math.log2(B)]!.neck), (tapMain.diameterMm ?? tapMain.widthMm) / 2) : null;
        const bannedTees = options.cuts?.tees.get(B);
        const bannedStubs = options.cuts?.stubs.get(B);
        // A take-off's branch runs straight off the main for the main's half, its collar and damper and the
        // realiser's lead before its first fitting.
        const bB = Number.isFinite(tee) ? straightFirst(B, layer.halfMm + collarMm + BRANCH_LEAD_MM).value : GB[B]!;
        // The hot loop (every pair of subsets × every directed state): plain arrays, nothing allocated.
        const teeOk = Number.isFinite(tee);
        const splitOk = Number.isFinite(split);
        // (or, where cheaper, straight on as usual: the run need not step down — it may end on a stub and a cap)
        const straightOf = tail ? (tailOrOn[A] ??= minOf(tailValue[A]!, gA)) : gA;
        const stubValue = stubs ? stubs.value : null;
        const splitCode = wye ? SPLIT_WYE : SPLIT;
        const splitRoom = layer.halfMm + ROUTE_CLEARANCE_MM;
        const nodes = graph.nodeCount;
        for (let v = 0; v < nodes; v += 1) {
          const teeHere = teeOk && !bannedTees?.has(v);
          const stubHere = teeOk && stubValue !== null && !bannedStubs?.has(v);
          const splitHere = splitOk && !bannedSplits?.has(v) && graph.nodeClear[v]! >= splitRoom;
          if (!teeHere && !stubHere && !splitHere) continue;
          const base = v * 4;
          for (let h = 0; h < 4; h += 1) {
            // Fittings only where the straight arriving is clear (the top level).
            const s3 = (base + h) * LEVELS + top;
            let best = d[s3]!;
            let code = 0;
            const left = base + ((h + 1) & 3);
            const right = base + ((h + 3) & 3);
            if (teeHere || stubHere) {
              const straight = straightOf[base + h]!;
              if (straight < INF) {
                if (teeHere) {
                  const l = straight + bB[left]! + tee;
                  if (l < best) { best = l; code = TEE_LEFT; }
                  const r = straight + bB[right]! + tee;
                  if (r < best) { best = r; code = TEE_RIGHT; }
                }
                if (stubHere) {
                  const l = straight + stubValue![left]! + tee;
                  if (l < best) { best = l; code = STUB_LEFT; }
                  const r = straight + stubValue![right]! + tee;
                  if (r < best) { best = r; code = STUB_RIGHT; }
                }
              }
            }
            if (splitHere) {
              const total = splitA[left]! + splitB[right]! + split;
              if (total < best) { best = total; code = splitCode; }
            }
            if (code) { d[s3] = best; dec[s3] = code; sub![s3] = A; }
          }
        }
      }
    }
    // Growth, backwards from the settled states: into t = (u, dir, c') from v = the node before u.
    // Each edge's price on this layer (its length at the cheapest section its corridor takes).
    const edgeCost = new Float64Array(directed);
    for (let e = 0; e < directed; e += 1) {
      edgeCost[e] = nb[e]! < 0 ? INF : graph.edgeLength[e]! * priceFor(layer, graph.corridor[e]!);
      // Through a wall: its sleeve (and fire damper) too.
      if (cross && cross[e]! >= 0) edgeCost[e] += crossCost[e]!;
    }
    const wallSteps = wallStepsOf(layer);
    const heap = new Heap();
    for (let s3 = 0; s3 < states; s3 += 1) if (d[s3]! < INF) heap.push(d[s3]!, s3);
    const done = new Uint8Array(states);
    const turnRoom = layer.halfMm + ROUTE_CLEARANCE_MM;
    const anyBlocked = Boolean(blocked?.size);
    const elbowPrice = layer.elbow;
    while (heap.size) {
      const key = heap.topKey;
      const t = heap.pop();
      if (done[t] || key > d[t]!) continue;
      done[t] = 1;
      const level = t % LEVELS;
      const directedT = (t - level) / LEVELS;
      const u = directedT >> 2;
      const dir = directedT & 3;
      const v = nb[u * 4 + ((dir + 2) & 3)]!;
      if (v < 0 || (anyBlocked && isBlocked(S, v, dir))) continue;
      const edge = edgeCost[v * 4 + dir]!;
      if (!(edge < INF)) continue;
      const value = key + edge;
      const move = MOVE + dir;
      if (cross && cross[v * 4 + dir]! >= 0) {
        // Through a wall: it arrives past the far face at one level, from any level that clears the near face.
        const e = v * 4 + dir;
        if (level !== crossArrival(e, top, wallSteps)) continue;
        const need = crossNeed(e, wallSteps);
        const into = (v * 4 + dir) * LEVELS;
        for (let c = Math.max(0, need); c <= top; c += 1) {
          if (value < d[into + c]! - 1e-9) { d[into + c] = value; dec[into + c] = move; heap.push(value, into + c); }
        }
        // A turn just before it: its elbow's reach must clear the near face too.
        if (need <= 0 && graph.nodeClear[v]! >= turnRoom) {
          const turned = value + elbowPrice;
          const l = (v * 4 + ((dir + 1) & 3)) * LEVELS + top;
          if (turned < d[l]! - 1e-9) { d[l] = turned; dec[l] = move; heap.push(turned, l); }
          const r = (v * 4 + ((dir + 3) & 3)) * LEVELS + top;
          if (turned < d[r]! - 1e-9) { d[r] = turned; dec[r] = move; heap.push(turned, r); }
        }
        continue;
      }
      // Straight on from (v, dir, c): arrives at level min(top, c + steps) — one c below the top, a range at it.
      const steps = stepsOf(graph.edgeLength[v * 4 + dir]!);
      const base = (v * 4 + dir) * LEVELS;
      for (let c = level < top ? level - steps : Math.max(0, top - steps), last = level < top ? level - steps : top; c <= last; c += 1) {
        if (c < 0) continue;
        const s3 = base + c;
        if (value < d[s3]! - 1e-9) { d[s3] = value; dec[s3] = move; heap.push(value, s3); }
      }
      // A turn at v (an elbow) needs clearance there and restarts it; the corner needs room round its node.
      if (Math.min(top, steps) === level && graph.nodeClear[v]! >= turnRoom) {
        const turned = value + elbowPrice;
        const l = (v * 4 + ((dir + 1) & 3)) * LEVELS + top;
        if (turned < d[l]! - 1e-9) { d[l] = turned; dec[l] = move; heap.push(turned, l); }
        const r = (v * 4 + ((dir + 3) & 3)) * LEVELS + top;
        if (turned < d[r]! - 1e-9) { d[r] = turned; dec[r] = move; heap.push(turned, r); }
      }
    }
    // The move out of (v, h) straight after a fitting there (a branch's collar and damper not counted).
    const gs = new Float64Array(directed).fill(INF);
    const gb = new Float64Array(directed).fill(INF);
    for (let s = 0; s < directed; s += 1) {
      const v = s >> 2;
      const h = s & 3;
      const u = nb[v * 4 + h]!;
      if (u < 0 || isBlocked(S, v, h)) continue;
      const length = graph.edgeLength[v * 4 + h]!;
      const edge = length * priceFor(layer, graph.corridor[v * 4 + h]!);
      if (!Number.isFinite(edge)) continue;
      if (cross && cross[s]! >= 0) {
        // Straight into a wall after the fitting: only with its reach clear of the near face.
        const arrival = d[(u * 4 + h) * LEVELS + crossArrival(s, top, wallSteps)]!;
        if (crossNeed(s, wallSteps) <= 0) gs[s] = edge + crossCost[s]! + arrival;
        if (crossNeed(s, wallSteps, collarMm) <= 0) gb[s] = edge + crossCost[s]! + arrival;
        continue;
      }
      gs[s] = edge + d[(u * 4 + h) * LEVELS + arrive(top, 0, length)]!;
      gb[s] = edge + d[(u * 4 + h) * LEVELS + arrive(top, 0, Math.max(0, length - collarMm))]!;
    }
    D[S] = d;
    GS[S] = gs;
    GB[S] = gb;
    how[S] = dec;
    subset[S] = sub;
    if (single) {
      // Past a take-off: straight on at least MAIN_TAIL_MM, then the layer's own best (arriving clear).
      const value = new Float64Array(directed).fill(INF);
      const land = new Int32Array(directed).fill(-1);
      for (let s = 0; s < directed; s += 1) {
        const walked = straightOn(S, s, MAIN_TAIL_MM, layer);
        // (Past a wall the tail must still end clear for what follows.)
        if (!walked || (walked.crossed && walked.level < top)) continue;
        const rest = d[(walked.node * 4 + (s & 3)) * LEVELS + top]!;
        if (rest < INF) { value[s] = walked.cost + rest; land[s] = walked.node * 4 + (s & 3); }
      }
      tailValue[S] = value;
      tailLand[S] = land;
    }
    if (memo) {
      memo.signatures.set(S, signature);
      memo.saved.set(S, {
        d, gs, gb, how: dec, subset: sub, layer, tailValue: tailValue[S] ?? null, tailLand: tailLand[S] ?? null, leafVariant: leafVariant[S] ?? null,
      });
    }
  }

  const fullLayer = layers[full]!;
  const fullTop = topOf(fullLayer);
  const results: Array<{ root: RoutingGraph['roots'][number]; value: number; state: number; turn?: { dir: number; land: number } }> = [];
  // The shortest collar transition the trunk's sections allow (a relaxation: the sizing picks a section
  // whose transition fits, or reports the collar).
  const pricedTransition = Number.isFinite(shortestTransition) ? shortestTransition : 0;
  const collarElbow = model.elbow(collar, 90, flows[full]!);
  // Turning first, the next leg holds the collar elbow's reach, then the transition to a trunk section and
  // that section's own next elbow: the least over the sections (the sizing checks the one it picks).
  const turnFirstMm = model.turnFirstReachMm(flows[full]!, branchNeckMm);
  for (const root of graph.roots) {
    if (!rootFits(root)) continue;
    const straight = root.outletMm * (fullLayer.prices[fullLayer.prices.length - 1] ?? INF);
    const penalty = root.outletMm < options.fanOutletMm ? lambda * options.shortOutletPenaltyPa : 0;
    // Turn first: the collar's elbow at the root's end, then straight on for the transition and a fitting's reach.
    // (the collar's elbow needs its half-width and the clearance round the corner)
    if (root.outletMm >= connectorMm + collarTurnMm && graph.nodeClear[root.node]! >= collar.widthMm / 2 + 1 + model.costContext.insulationMm + ROUTE_CLEARANCE_MM) {
      const after = straightFirst(full, turnFirstMm);
      for (const dir of [leftOf(0), rightOf(0)]) {
        const rest = after.value[root.node * 4 + dir]!;
        if (rest < INF) results.push({ root, value: rest + collarElbow.cost + lambda * collarElbow.loss + straight + penalty, state: -1, turn: { dir, land: after.land[root.node * 4 + dir]! } });
      }
    }
    const clear = Math.max(0, root.outletMm - connectorMm - pricedTransition);
    // The transition's length is already counted: the first fitting needs only its own reach after it.
    const credit = Math.max(0, fullTop - Math.ceil(fullLayer.reachMm / CLEAR_STEP_MM));
    const s3 = (root.node * 4) * LEVELS + arrive(fullTop, credit, clear);
    const value = D[full]![s3]!;
    if (!Number.isFinite(value)) continue;
    // A turn right at the root's end needs its elbow's setback clear of the collar transition.
    const first = how[full]![s3]!;
    if (first > MOVE && first < MOVE + 4 && root.outletMm < (options.rootTurnMinMm ?? 0)) continue;
    results.push({ root, value: value + straight + penalty, state: s3 });
  }
  if (!results.length) return null;
  results.sort((a, b) => a.value - b.value);

  const usages: Usage[] = [];
  const designs: ServiceDesign[] = [];
  const seen = new Set<string>();
  // The collar straight and the short cap tail are not necessarily grid
  // edges. Give them the same obstacle corridor check as the searched edges.
  const corridorBoxes = (ctx.obstacles ?? []).filter((box) => box.id !== ctx.unitId
    && box.zMax > ctx.bottomZ && box.zMin < ctx.bottomZ + Math.min(model.maxHeightMm, 350));
  const straightCorridor = (a: Point2D, b: Point2D): number => {
    const horizontal = Math.abs(a.y - b.y) < 0.5;
    const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
    const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
    const at = horizontal ? a.y : a.x;
    let free = INF;
    for (const box of corridorBoxes) {
      if (hi <= (horizontal ? box.minX : box.minY) || lo >= (horizontal ? box.maxX : box.maxY)) continue;
      const low = horizontal ? box.minY : box.minX;
      const high = horizontal ? box.maxY : box.maxX;
      free = Math.min(free, at < low ? low - at : at > high ? at - high : 0);
    }
    return free;
  };
  for (const { root, value, state, turn } of results.slice(0, ROOTS_KEPT)) {
    const usage: Usage = { edges: new Map(), nodes: new Map() };
    const constrain = (run: RunDesign, halfWidthMm: number, lengthMm = 0) => {
      const fromMm = runLengthMm(run);
      run.corridorMm = Math.min(run.corridorMm ?? INF, halfWidthMm);
      (run.corridors ??= []).push({ fromMm, toMm: fromMm + lengthMm, halfWidthMm });
    };
    const use = (run: RunDesign, S: number, v: number, u: number) => {
      const key = edgeKey(v, u);
      usage.edges.set(key, [...(usage.edges.get(key) ?? []), S]);
      // Keep where each corridor occurs: a narrow tail must not restrict a
      // wider upstream section when a reducer fits before that tail.
      for (let d = 0; d < 4; d += 1) {
        if (nb[v * 4 + d] === u) constrain(run, graph.corridor[v * 4 + d]!, graph.edgeLength[v * 4 + d]!);
      }
      const list = usage.nodes.get(u) ?? [];
      if (!list.some((entry) => entry.run === run.key)) list.push({ run: run.key, set: S, start: false });
      usage.nodes.set(u, list);
    };
    const enter = (run: RunDesign, S: number, v: number) => {
      const list = usage.nodes.get(v) ?? [];
      list.push({ run: run.key, set: S, start: true });
      usage.nodes.set(v, list);
    };
    let keyCounter = 0;
    const newRun = (start: DesignStart, from: { x: number; y: number }): RunDesign => ({
      key: `t${(keyCounter += 1)}`, start, vertices: [from], taps: [], end: { kind: 'cap' }, airflowM3h: 0, allFlex: false,
    });
    const at = (node: number) => ({ x: graph.nodeX[node]!, y: graph.nodeY[node]! });
    const push = (run: RunDesign, node: number) => {
      const p = at(node);
      const last = run.vertices[run.vertices.length - 1]!;
      if (Math.hypot(p.x - last.x, p.y - last.y) > 0.5) run.vertices.push(p);
    };
    /** Straight out of `v` along `dir` after a fitting there (a branch: less its collar and damper): the state it arrives in. */
    const leave = (S: number, v: number, dir: number, branch = false) => {
      const u = nb[v * 4 + dir]!;
      const length = graph.edgeLength[v * 4 + dir]!;
      const top = topOf(layers[S]!);
      if (cross && cross[v * 4 + dir]! >= 0) return (u * 4 + dir) * LEVELS + crossArrival(v * 4 + dir, top, wallStepsOf(layers[S]!));
      return (u * 4 + dir) * LEVELS + arrive(top, 0, branch ? Math.max(0, length - collarMm) : length);
    };
    const walk = (run: RunDesign, startSet: number, startState: number, from: number | null): void => {
      let S = startSet;
      let s3 = startState;
      if (from !== null) {
        enter(run, S, from);
        use(run, S, from, Math.floor(s3 / LEVELS) >> 2);
      }
      for (let guard = 0; guard < 100000; guard += 1) {
        const level = s3 % LEVELS;
        const directedS = (s3 - level) / LEVELS;
        const v = directedS >> 2;
        const h = directedS & 3;
        push(run, v);
        const choice = how[S]![s3]!;
        const top = topOf(layers[S]!);
        if (choice >= MOVE && choice < MOVE + 4) {
          const dir = choice - MOVE;
          const u = nb[v * 4 + dir]!;
          // A corner here: its room round the node limits the run's section too.
          if (dir !== h) constrain(run, graph.nodeClear[v]!);
          use(run, S, v, u);
          const next = cross && cross[v * 4 + dir]! >= 0
            ? crossArrival(v * 4 + dir, top, wallStepsOf(layers[S]!))
            : arrive(top, dir === h ? level : 0, graph.edgeLength[v * 4 + dir]!);
          s3 = (u * 4 + dir) * LEVELS + next;
          continue;
        }
        if (choice === LEAF) {
          run.end = { kind: 'terminal', terminal: terminalVariants(terminals[Math.log2(S)]!)[leafVariant[S]![s3]!]! };
          if (run.route) run.route.leaf = { node: v, heading: h, set: S };
          return;
        }
        if (choice === STUB_END_LEFT || choice === STUB_END_RIGHT) {
          // The last terminal off the run's side on an all-flex stub; the run goes on a little and is capped.
          const side = choice === STUB_END_LEFT ? 1 : -1;
          const out = side > 0 ? leftOf(h) : rightOf(h);
          const terminal = terminals[Math.log2(S)]!;
          const endMain = tapMainFor(S, terminal.neck)!;
          const reach = stubReachMm(endMain, terminal.neck);
          const p = at(v);
          const outDir = DIRECTIONS[out]!;
          const child = newRun({ kind: 'tap' }, p);
          child.route = { kind: 'stub', node: v, set: S, parentSet: S, tapNodes: [] };
          child.vertices.push({ x: p.x + outDir.x * reach, y: p.y + outDir.y * reach });
          child.allFlex = true;
          const variant = stubsFor(S, reach, (endMain.diameterMm ?? endMain.widthMm) / 2).variant[v * 4 + out]!;
          child.end = { kind: 'terminal', terminal: terminalVariants(terminal)[variant]! };
          run.route?.tapNodes.push(v);
          run.taps.push({ station: runLengthMm(run), side, child });
          enter(child, S, v);
          const ahead = DIRECTIONS[h]!;
          const capEnd = { x: p.x + ahead.x * STUB_END_RUN_ON_MM, y: p.y + ahead.y * STUB_END_RUN_ON_MM };
          constrain(run, straightCorridor(p, capEnd), STUB_END_RUN_ON_MM);
          run.vertices.push(capEnd);
          run.end = { kind: 'cap' };
          return;
        }
        if (choice === TEE_LEFT || choice === TEE_RIGHT || choice === STUB_LEFT || choice === STUB_RIGHT) {
          const A = subset[S]![s3]!;
          const B = S ^ A;
          const side = choice === TEE_LEFT || choice === STUB_LEFT ? 1 : -1;
          const out = side > 0 ? leftOf(h) : rightOf(h);
          const child = newRun({ kind: 'tap' }, at(v));
          const stub = choice === STUB_LEFT || choice === STUB_RIGHT;
          child.route = { kind: stub ? 'stub' : 'tee', node: v, set: B, parentSet: S, tapNodes: [] };
          run.route?.tapNodes.push(v);
          run.taps.push({ station: runLengthMm(run), side, child });
          if (stub) {
            // Collar + damper, then flex: the realiser lays the stub off the actual wall.
            const p = at(v);
            const outDir = DIRECTIONS[out]!;
            const tapMain = tapMainFor(S, terminals[Math.log2(B)]!.neck)!;
            const reach = stubReachMm(tapMain, terminals[Math.log2(B)]!.neck);
            child.vertices.push({ x: p.x + outDir.x * reach, y: p.y + outDir.y * reach });
            child.allFlex = true;
            const variant = stubsFor(B, reach, (tapMain.diameterMm ?? tapMain.widthMm) / 2).variant[v * 4 + out]!;
            child.end = { kind: 'terminal', terminal: terminalVariants(terminals[Math.log2(B)]!)[variant]! };
            enter(child, B, v);
          } else {
            walkStraight(child, B, v, out, straightFirst(B, layers[S]!.halfMm + collarMm + BRANCH_LEAD_MM).land[v * 4 + out]!);
          }
          S = A;
          if (popcount(A) === 1 && tailValue[A]![v * 4 + h]! <= GS[A]![v * 4 + h]!) {
            // Straight on far enough for the reducer, then on as the branch to the last terminal.
            const landing = tailLand[A]![v * 4 + h]!;
            let node = v;
            for (let step = 0; step < 10000 && node * 4 + h !== landing; step += 1) {
              const next = nb[node * 4 + h]!;
              if (next < 0) break;
              use(run, S, node, next);
              node = next;
              push(run, node);
            }
            s3 = landing * LEVELS + topOf(layers[A]!);
            continue;
          }
          const next = leave(A, v, h);
          use(run, S, v, Math.floor(next / LEVELS) >> 2);
          s3 = next;
          continue;
        }
        if (choice === SPLIT || choice === SPLIT_WYE) {
          const A = subset[S]![s3]!;
          const B = S ^ A;
          const plus = newRun({ kind: 'split', side: 1 }, at(v));
          const minus = newRun({ kind: 'split', side: -1 }, at(v));
          plus.route = { kind: 'split', node: v, set: A, parentSet: S, tapNodes: [] };
          minus.route = { kind: 'split', node: v, set: B, parentSet: S, tapNodes: [] };
          if (run.route) run.route.splitNode = v;
          run.end = { kind: 'split', children: [plus, minus] };
          constrain(run, graph.nodeClear[v]!);
          if (choice === SPLIT_WYE) {
            const main = layers[S]!.best!;
            walkStraight(plus, A, v, leftOf(h), straightFirst(A, wyeRoom(main, layers[A]!.best)).land[v * 4 + leftOf(h)]!);
            walkStraight(minus, B, v, rightOf(h), straightFirst(B, wyeRoom(main, layers[B]!.best)).land[v * 4 + rightOf(h)]!);
          } else {
            walk(plus, A, leave(A, v, leftOf(h)), v);
            walk(minus, B, leave(B, v, rightOf(h)), v);
          }
          return;
        }
        return;
      }
    };
    /** A run that leaves `v` along `dir` straight to the state `landing` (a wye outlet), then goes on as the DP chose. */
    const walkStraight = (run: RunDesign, S: number, v: number, dir: number, landing: number): void => {
      enter(run, S, v);
      const target = Math.floor(landing / LEVELS);
      let node = v;
      for (let step = 0; step < 10000 && node * 4 + dir !== target; step += 1) {
        const next = nb[node * 4 + dir]!;
        if (next < 0) break;
        use(run, S, node, next);
        node = next;
        push(run, node);
      }
      walk(run, S, landing, null);
    };
    const rootRun = newRun({ kind: 'unit' }, { x: 0, y: 0 });
    rootRun.route = { kind: 'root', node: root.node, set: full, parentSet: full, tapNodes: [] };
    constrain(rootRun, straightCorridor({ x: 0, y: 0 }, at(root.node)), root.outletMm);
    // The fan-outlet straight is the root's too.
    for (let node = 0; node < graph.nodeCount; node += 1) {
      if (Math.abs(graph.nodeY[node]!) < 1 && graph.nodeX[node]! < root.outletMm - 1) {
        usage.nodes.set(node, [...(usage.nodes.get(node) ?? []), { run: rootRun.key, set: full, start: false }]);
      }
    }
    enter(rootRun, full, root.node);
    if (turn) {
      push(rootRun, root.node);
      constrain(rootRun, graph.nodeClear[root.node]!);
      walkStraight(rootRun, full, root.node, turn.dir, turn.land);
    } else {
      walk(rootRun, full, state, null);
    }
    const tidy = (run: RunDesign) => {
      run.vertices = simplifyCollinear(run.vertices);
      for (const tap of run.taps) tidy(tap.child);
      if (run.end.kind === 'split') run.end.children.forEach(tidy);
    };
    tidy(rootRun);
    computeFlows(rootRun);
    // Different roots can give the same tree: keep one of each.
    const signature = JSON.stringify(treeSignature(rootRun));
    if (seen.has(signature)) continue;
    seen.add(signature);
    const shortened = root.outletMm < options.fanOutletMm;
    const notes: AutoDuctIssue[] = shortened ? [{
      code: 'DU_AUTO_FAN_OUTLET', severity: 'info', service: ctx.service,
      message: `The straight off the fan is shortened to ${root.outletMm} mm (about 2.5 duct diameters, ${options.fanOutletMm} mm, is recommended): expect a little system-effect loss at the fan.`,
    }] : [];
    usages.push(usage);
    designs.push({
      label: options.label, source: 'steiner', root: rootRun, fanOutletMm: root.outletMm, penalty: 0,
      pressurePenaltyPa: shortened ? options.shortOutletPenaltyPa : 0, notes, kind: 'tree', modelCost: value, exact: true,
    });
  }
  return { designs, usages, modelCost: results[0]!.value, seconds: (Date.now() - started) / 1000, halfOf: (set) => layers[set]?.halfMm ?? 0 };
}

/** Distance from p to the segment a–b (mm). */
function distanceToSegment(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

interface SelfClash {
  /** The run to move: a runout's own run, or the smaller of two runs too close together. */
  run: RunDesign;
  runout: boolean;
  /** The leg of `run` that is too close (legs only). */
  leg?: [Point2D, Point2D];
  /** The other run's leg a runout crosses, with that run's half-width (runouts only). */
  crossed?: { a: Point2D; b: Point2D; half: number };
}

/**
 * Where a tree's own runs would collide once built, beyond two runs sharing a
 * grid edge or node: a runout (off an all-flex stub, or at a run's end)
 * curving through another run's duct, as the planner curves it, or two
 * parallel legs of different runs closer than their halves and the clearance.
 */
function selfClashes(ctx: ServiceCtx, root: RunDesign, halfOf: (set: number) => number, flowOf: (set: number) => number): SelfClash[] {
  const runs = allRuns(root);
  const legs: Array<{ run: RunDesign; a: Point2D; b: Point2D; half: number }> = [];
  for (const run of runs) {
    if (run.allFlex || !run.route) continue;
    const half = halfOf(run.route.set);
    for (let index = 1; index < run.vertices.length; index += 1) legs.push({ run, a: run.vertices[index - 1]!, b: run.vertices[index]!, half });
  }
  const out: SelfClash[] = [];
  for (const run of runs) {
    if (run.end.kind !== 'terminal' || run.vertices.length < 2 || !run.route) continue;
    const from = run.allFlex ? run.vertices[0]! : run.vertices[run.vertices.length - 2]!;
    const to = run.allFlex ? run.vertices[1]! : run.vertices[run.vertices.length - 1]!;
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const path = runoutPath(ctx, to, { x: (to.x - from.x) / length, y: (to.y - from.y) / length }, ctx.bottomZ, run.end.terminal);
    const hit = legs.find((leg) => leg.run !== run && path.points.some((point) => distanceToSegment(point, leg.a, leg.b) < leg.half + path.radiusMm));
    if (hit) out.push({ run, runout: true, crossed: { a: hit.a, b: hit.b, half: hit.half } });
  }
  for (let i = 0; i < legs.length; i += 1) {
    const p = legs[i]!;
    const horizontal = Math.abs(p.a.y - p.b.y) < 0.5;
    for (let j = i + 1; j < legs.length; j += 1) {
      const q = legs[j]!;
      if (q.run === p.run || horizontal !== (Math.abs(q.a.y - q.b.y) < 0.5)) continue;
      const [pa, pb, qa, qb, gap] = horizontal
        ? [Math.min(p.a.x, p.b.x), Math.max(p.a.x, p.b.x), Math.min(q.a.x, q.b.x), Math.max(q.a.x, q.b.x), Math.abs(p.a.y - q.a.y)]
        : [Math.min(p.a.y, p.b.y), Math.max(p.a.y, p.b.y), Math.min(q.a.y, q.b.y), Math.max(q.a.y, q.b.y), Math.abs(p.a.x - q.a.x)];
      if (Math.min(pb, qb) - Math.max(pa, qa) <= 1 || gap >= p.half + q.half + ROUTE_CLEARANCE_MM) continue;
      const smaller = flowOf(p.run.route!.set) <= flowOf(q.run.route!.set) ? p : q;
      out.push({ run: smaller.run, runout: false, leg: [smaller.a, smaller.b] });
    }
  }
  return out;
}

/**
 * Conflicts in a routed tree: an edge two runs share, or a node two runs pass
 * through (a branch starting from its parent is a junction, not a conflict).
 */
function conflicts(usage: Usage, flows: (set: number) => number): Array<{ node: number; other?: number; set: number }> {
  const out: Array<{ node: number; other?: number; set: number }> = [];
  for (const [key, sets] of usage.edges) {
    if (sets.length < 2) continue;
    const smaller = sets.reduce((best, set) => (flows(set) < flows(best) ? set : best));
    out.push({ node: Math.floor(key / 1_000_003), other: key % 1_000_003, set: smaller });
  }
  for (const [node, entries] of usage.nodes) {
    const runs = new Map<string, { set: number; start: boolean }>();
    for (const entry of entries) {
      const known = runs.get(entry.run);
      runs.set(entry.run, { set: entry.set, start: (known?.start ?? false) || entry.start });
    }
    const passing = [...runs.values()].filter((entry) => !entry.start);
    if (passing.length >= 2) {
      const smaller = passing.reduce((best, entry) => (flows(entry.set) < flows(best.set) ? entry : best));
      out.push({ node, set: smaller.set });
    }
  }
  return out;
}

/**
 * The router with repair: solve, find where the tree's runs would share an
 * edge or cross, block those for the smaller-flow subtree and solve again
 * (a few rounds). Returns the conflict-free trees (one per distinct root).
 */
export function routeTrees(ctx: ServiceCtx, model: SizingModel, graph: RoutingGraph, options: SteinerOptions, rounds = options.groups ? 16 : 10): SteinerSolution | null {
  const blocked: BlockedEdges = new Map(options.blocked ?? []);
  // Each round blocks edges for a few terminal sets only: the layers of the others carry over.
  const memo = options.memo ?? newLayerMemo();
  const flowOf = (set: number) => {
    let total = 0;
    ctx.terminals.forEach((terminal, index) => { if (set & (1 << index)) total += terminal.airflowM3h; });
    return total;
  };
  const block = (v: number, dir: number, set: number) => {
    const key = v * 4 + dir;
    const sets = blocked.get(key) ?? new Set<number>();
    sets.add(set);
    blocked.set(key, sets);
  };
  // Repairs of this call only (a runout through the tree's own duct depends on the tree): the loop's cuts
  // plus the stubs and runout starts ruled out here.
  const copy = (map: Map<number, Set<number>> | undefined) => new Map([...(map ?? [])].map(([set, values]) => [set, new Set(values)]));
  const cuts: RouterCuts = {
    tees: copy(options.cuts?.tees), stubs: copy(options.cuts?.stubs), splits: copy(options.cuts?.splits),
    leaves: copy(options.cuts?.leaves), roots: new Set(options.cuts?.roots ?? []),
  };
  const cut = (map: Map<number, Set<number>>, set: number, value: number) => {
    const values = map.get(set) ?? new Set<number>();
    map.set(set, values);
    if (values.has(value)) return false;
    values.add(value);
    return true;
  };
  let last: SteinerSolution | null = null;
  let seconds = 0;
  for (let round = 0; round < rounds; round += 1) {
    if (round > 0 && options.deadline !== undefined && Date.now() > options.deadline) break;
    const solution = steinerTrees(ctx, model, graph, { ...options, cuts, blocked, memo });
    // Repaired into a corner (nothing left to route): the last trees go on to the exact checks, whose
    // verdicts the feasibility loop learns from more sharply.
    if (!solution) return last ? { ...last, seconds, repairs: round } : null;
    seconds += solution.seconds;
    const halfOf = solution.halfOf ?? (() => 0);
    const checked = solution.designs.map((design, index) => ({
      design, usage: solution.usages[index]!, grid: conflicts(solution.usages[index]!, flowOf), built: selfClashes(ctx, design.root, halfOf, flowOf),
    }));
    const clean = checked.filter((entry) => !entry.grid.length && !entry.built.length);
    if (clean.length) return { ...solution, designs: clean.map((entry) => entry.design), usages: clean.map((entry) => entry.usage), seconds, repairs: round };
    last = solution;
    // Block what the best tree's runs fought over, for the smaller subtree, and try again.
    const best = checked[0]!;
    let changed = false;
    for (const conflict of best.grid) {
      for (let dir = 0; dir < 4; dir += 1) {
        const u = graph.neighbour[conflict.node * 4 + dir]!;
        if (u < 0) continue;
        if (conflict.other !== undefined && u !== conflict.other) continue;
        block(conflict.node, dir, conflict.set);
        block(u, reverseOf(dir), conflict.set);
        changed = true;
      }
    }
    // A runout through the tree's own duct: not that stub, or not that runout start. Legs too close:
    // the smaller run off that stretch.
    for (const clash of best.built) {
      const route = clash.run.route!;
      if (clash.runout) {
        if (clash.run.allFlex) {
          changed = cut(cuts.stubs, route.set, route.node) || changed;
          // Every other node whose stub (as long as this one) would send its runout across the same duct.
          const [start, end] = clash.run.vertices as [Point2D, Point2D];
          const reach = Math.hypot(end.x - start.x, end.y - start.y);
          const crossed = clash.crossed!;
          const terminal = clash.run.end.kind === 'terminal' ? clash.run.end.terminal : null;
          for (let node = 0; terminal && node < graph.nodeCount; node += 1) {
            if ((cuts.stubs.get(route.set)?.has(node))) continue;
            for (const dir of DIRECTIONS) {
              const tip = { x: graph.nodeX[node]! + dir.x * reach, y: graph.nodeY[node]! + dir.y * reach };
              if (Math.hypot(terminal.lip.x - tip.x, terminal.lip.y - tip.y) > ctx.settings.flexMaxLengthMm) continue;
              const path = runoutPath(ctx, tip, dir, ctx.bottomZ, terminal);
              if (path.points.some((point) => distanceToSegment(point, crossed.a, crossed.b) < crossed.half + path.radiusMm)) {
                changed = cut(cuts.stubs, route.set, node) || changed;
                break;
              }
            }
          }
        } else if (route.leaf) {
          const set = route.leaf.set;
          changed = cut(cuts.leaves, set, route.leaf.node * 4 + route.leaf.heading) || changed;
          // Every other runout start of that terminal that would cross the same duct goes too.
          const index = Math.log2(set);
          const crossed = clash.crossed!;
          const variants = terminalVariants(ctx.terminals[index]!);
          for (const leaf of graph.leaves[index] ?? []) {
            const path = runoutPath(ctx, { x: graph.nodeX[leaf.node]!, y: graph.nodeY[leaf.node]! }, DIRECTIONS[leaf.heading]!, ctx.bottomZ, variants[leaf.variant]!);
            if (path.points.some((point) => distanceToSegment(point, crossed.a, crossed.b) < crossed.half + path.radiusMm)) {
              changed = cut(cuts.leaves, set, leaf.node * 4 + leaf.heading) || changed;
            }
          }
        }
        continue;
      }
      // The grid edges the run used along that leg (its ends need not be grid nodes, e.g. at the collar).
      const [a, b] = clash.leg!;
      for (const [key, sets] of best.usage.edges) {
        const v = Math.floor(key / 1_000_003);
        const u = key % 1_000_003;
        const pv = { x: graph.nodeX[v]!, y: graph.nodeY[v]! };
        const pu = { x: graph.nodeX[u]!, y: graph.nodeY[u]! };
        if (distanceToSegment(pv, a, b) > 1 || distanceToSegment(pu, a, b) > 1) continue;
        const dir = [0, 1, 2, 3].find((d) => graph.neighbour[v * 4 + d] === u);
        if (dir === undefined) continue;
        for (const set of sets) {
          if ((set & route.set) !== set) continue;
          block(v, dir, set);
          block(u, reverseOf(dir), set);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return last ? { ...last, designs: [], usages: [], seconds, repairs: rounds } : null;
}
