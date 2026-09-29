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
 * its reducer. Where two runs of a tree would share an edge or cross, the
 * conflict is blocked for the smaller subtree and the programme solved again
 * (routeTrees). The result is optimal on the grid for its λ and its blocks;
 * the sizing DP then sizes the tree exactly and the planner judges it.
 * Time O(3^k·|V|), memory O(2^k·|V|): it runs up to the settings' limit.
 */
import { isRoundLeg, type DuctLeg, type DuctTapStyle } from '../ductTypes';
import { branchStubMm, flexFit, flexOk, simplifyCollinear, type AutoDuctIssue, type ServiceCtx } from '../ductAutoContext';

import { computeFlows, runLengthMm, type DesignStart, type RunDesign, type ServiceDesign } from './designTree';
import { DIRECTIONS, leftOf, rightOf, reverseOf, ROUTE_CLEARANCE_MM, type RoutingGraph } from './routingGraph';
import type { SizingModel } from './sizingModel';

const INF = Number.POSITIVE_INFINITY;
const LEAF = 1;
const TEE_LEFT = 2;
const TEE_RIGHT = 3;
const SPLIT = 4;
/** A take-off whose branch is only its collar and damper, then flex into the terminal. */
const STUB_LEFT = 5;
const STUB_RIGHT = 6;
const MOVE = 8;
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
}

function outerHalfMm(leg: DuctLeg, model: SizingModel): number {
  return leg.widthMm / 2 + 1 + model.costContext.insulationMm;
}

function layerPrice(model: SizingModel, flow: number, neckMm: number | null, lambda: number): LayerPrice {
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
    // Rectangular trunks turn with vaned square elbows where a radius will not fit (setback W/2); round ones gored (R).
    clearMm: !bestLeg ? 600 : isRoundLeg(bestLeg)
      ? model.elbowRadiusMm(bestLeg) + model.settings.elbowNeckMm + 150
      : bestLeg.widthMm / 2 + model.settings.elbowNeckMm + 250,
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

/** Minimal binary heap of (key, item). */
class Heap {
  private keys: number[] = [];
  private items: number[] = [];
  get size(): number { return this.items.length; }
  push(key: number, item: number): void {
    this.keys.push(key);
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent]! <= this.keys[i]!) break;
      [this.keys[parent], this.keys[i]] = [this.keys[i]!, this.keys[parent]!];
      [this.items[parent], this.items[i]] = [this.items[i]!, this.items[parent]!];
      i = parent;
    }
  }
  pop(): { key: number; item: number } {
    const top = { key: this.keys[0]!, item: this.items[0]! };
    const lastKey = this.keys.pop()!;
    const lastItem = this.items.pop()!;
    if (this.items.length) {
      this.keys[0] = lastKey;
      this.items[0] = lastItem;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.keys[l]! < this.keys[m]!) m = l;
        if (r < this.items.length && this.keys[r]! < this.keys[m]!) m = r;
        if (m === i) break;
        [this.keys[m], this.keys[i]] = [this.keys[i]!, this.keys[m]!];
        [this.items[m], this.items[i]] = [this.items[i]!, this.items[m]!];
        i = m;
      }
    }
    return top;
  }
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
  seconds: number;
}

export interface SteinerOptions {
  /** Price of a pascal of fan pressure in the routing (currency). */
  lambda: number;
  label: string;
  /** The full fan-outlet straight (mm); shorter roots carry the system effect. */
  fanOutletMm: number;
  /** Extra fan pressure of a shortened fan outlet (Pa). */
  shortOutletPenaltyPa: number;
  maxTerminals: number;
  blocked?: BlockedEdges;
  /** Shortest root that may turn at its end (connector, collar transition and an elbow's setback, mm). */
  rootTurnMinMm?: number;
}

/** Clearance is counted in steps of this much straight (mm), up to a layer's fitting length. */
const CLEAR_STEP_MM = 100;
/** Levels a state carries: 0 … LEVELS − 1 (the top level = clear for a fitting). */
const LEVELS = 12;
/** A runout's rigid branch needs at least this straight since its last fitting (its collar, damper and flex start; mm). */
const LEAF_STRAIGHT_MM = 400;

export function steinerTrees(ctx: ServiceCtx, model: SizingModel, graph: RoutingGraph, options: SteinerOptions): SteinerSolution | null {
  const started = Date.now();
  const terminals = ctx.terminals;
  const k = terminals.length;
  if (!k || k > options.maxTerminals || !graph.roots.length || graph.leaves.some((leaves) => !leaves.length)) return null;
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
  /** Single terminals: an all-flex branch leaving node v along d (collar + damper stub, then flex), where it fits. */
  const stubValue: Array<Float64Array | null> = new Array(full + 1).fill(null);
  const stubMm = branchStubMm(ctx.settings);
  const order = Array.from({ length: full }, (_, index) => index + 1).sort((a, b) => popcount(a) - popcount(b));
  const fittingStyle = (main: DuctLeg, branch: DuctLeg): DuctTapStyle => (isRoundLeg(main) ? 'round-conical' : isRoundLeg(branch) ? 'spin-in' : 'shoe-45');
  /** The layer's clear level: its fitting length in steps. */
  const topOf = (layer: LayerPrice) => Math.min(LEVELS - 1, Math.ceil(layer.clearMm / CLEAR_STEP_MM));
  const stepsOf = (length: number) => Math.floor(length / CLEAR_STEP_MM + 1e-9);
  /** Level on arrival after a straight of `length` from level `c` (c = 0 right after a fitting). */
  const arrive = (top: number, c: number, length: number) => Math.min(top, c + stepsOf(length));

  for (const S of order) {
    const single = popcount(S) === 1;
    const index = single ? Math.log2(S) : -1;
    const layer = layerPrice(model, flows[S]!, single ? terminals[index]!.neck : null, lambda);
    layers[S] = layer;
    const top = topOf(layer);
    const d = new Float64Array(states).fill(INF);
    const dec = new Int8Array(states);
    const sub = single ? null : new Int32Array(states);
    if (single) {
      const terminal = terminals[index]!;
      // All-flex branches: from each node square off the main, the stub then the runout (checked as curved).
      const stubs = new Float64Array(directed).fill(INF);
      for (let s = 0; s < directed; s += 1) {
        const v = s >> 2;
        const dirV = DIRECTIONS[s & 3]!;
        // The stub starts at the main's wall: allow for half a trunk beside the node.
        const reachOut = stubMm + 150;
        const end = { x: graph.nodeX[v]! + dirV.x * reachOut, y: graph.nodeY[v]! + dirV.y * reachOut };
        if (Math.hypot(terminal.lip.x - end.x, terminal.lip.y - end.y) > ctx.settings.flexMaxLengthMm) continue;
        const fit = flexFit(ctx, end, dirV, ctx.bottomZ, terminal);
        if (!flexOk(fit, terminal, ctx.settings)) continue;
        const runout = model.flex(terminal.neck, terminal.airflowM3h, fit.lengthMm);
        stubs[s] = runout.cost + lambda * runout.loss;
      }
      stubValue[S] = stubs;
      const needed = Math.min(top, Math.ceil(LEAF_STRAIGHT_MM / CLEAR_STEP_MM));
      for (const leaf of graph.leaves[index]!) {
        const runout = model.flex(terminal.neck, terminal.airflowM3h, leaf.flexLengthMm);
        const value = runout.cost + lambda * runout.loss;
        for (let c = needed; c <= top; c += 1) {
          const s3 = (leaf.node * 4 + leaf.heading) * LEVELS + c;
          if (value < d[s3]!) { d[s3] = value; dec[s3] = LEAF; }
        }
      }
    } else {
      const main = layer.best;
      for (let A = (S - 1) & S; A > 0; A = (A - 1) & S) {
        const B = S ^ A;
        const gA = GS[A]!;
        const gB = GS[B]!;
        const bB = GB[B]!;
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
        const mainValue = (v: number, h: number): number => (tail ? tailValue[A]![v * 4 + h]! : gA[v * 4 + h]!);
        for (let s = 0; s < directed; s += 1) {
          const h = s & 3;
          const v = s >> 2;
          // Fittings only where the straight arriving is clear (the top level).
          const s3 = s * LEVELS + top;
          if (Number.isFinite(tee)) {
            const straight = mainValue(v, h);
            if (straight < INF) {
              const stubs = stubValue[B];
              for (const [side, code, stubCode] of [[leftOf(h), TEE_LEFT, STUB_LEFT], [rightOf(h), TEE_RIGHT, STUB_RIGHT]] as const) {
                const routed = bB[v * 4 + side]!;
                if (routed < INF) {
                  const total = straight + routed + tee;
                  if (total < d[s3]!) { d[s3] = total; dec[s3] = code; sub![s3] = A; }
                }
                const flexOnly = stubs ? stubs[v * 4 + side]! : INF;
                if (flexOnly < INF) {
                  const total = straight + flexOnly + tee;
                  if (total < d[s3]!) { d[s3] = total; dec[s3] = stubCode; sub![s3] = A; }
                }
              }
            }
          }
          if (Number.isFinite(split)) {
            const left = gA[v * 4 + leftOf(h)]!;
            const right = gB[v * 4 + rightOf(h)]!;
            if (left < INF && right < INF) {
              const total = left + right + split;
              if (total < d[s3]!) { d[s3] = total; dec[s3] = SPLIT; sub![s3] = A; }
            }
          }
        }
      }
    }
    // Growth, backwards from the settled states: into t = (u, dir, c') from v = the node before u.
    const heap = new Heap();
    for (let s3 = 0; s3 < states; s3 += 1) if (d[s3]! < INF) heap.push(d[s3]!, s3);
    const done = new Uint8Array(states);
    while (heap.size) {
      const { key, item: t } = heap.pop();
      if (done[t] || key > d[t]!) continue;
      done[t] = 1;
      const level = t % LEVELS;
      const directedT = (t - level) / LEVELS;
      const u = directedT >> 2;
      const dir = directedT & 3;
      const v = nb[u * 4 + reverseOf(dir)]!;
      if (v < 0 || isBlocked(S, v, dir)) continue;
      const length = graph.edgeLength[v * 4 + dir]!;
      const edge = length * priceFor(layer, graph.corridor[v * 4 + dir]!);
      if (!Number.isFinite(edge)) continue;
      const relax = (s3: number, value: number) => {
        if (value < d[s3]! - 1e-9) { d[s3] = value; dec[s3] = MOVE + dir; heap.push(value, s3); }
      };
      // Straight on from (v, dir, c): arrives at level min(top, c + steps).
      for (let c = 0; c <= top; c += 1) if (arrive(top, c, length) === level) relax((v * 4 + dir) * LEVELS + c, key + edge);
      // A turn at v (an elbow) needs clearance there and restarts it.
      if (arrive(top, 0, length) === level) {
        for (const h of [leftOf(dir), rightOf(dir)]) relax((v * 4 + h) * LEVELS + top, key + edge + layer.elbow);
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
        const h = s & 3;
        let node = s >> 2;
        let cost = 0;
        let length = 0;
        while (length < MAIN_TAIL_MM) {
          const u = nb[node * 4 + h]!;
          if (u < 0 || isBlocked(S, node, h)) { cost = INF; break; }
          cost += graph.edgeLength[node * 4 + h]! * priceFor(layer, graph.corridor[node * 4 + h]!);
          length += graph.edgeLength[node * 4 + h]!;
          node = u;
        }
        if (!Number.isFinite(cost)) continue;
        const rest = d[(node * 4 + h) * LEVELS + top]!;
        if (rest < INF) { value[s] = cost + rest; land[s] = node * 4 + h; }
      }
      tailValue[S] = value;
      tailLand[S] = land;
    }
  }

  const fullLayer = layers[full]!;
  const fullTop = topOf(fullLayer);
  const results: Array<{ root: RoutingGraph['roots'][number]; value: number }> = [];
  for (const root of graph.roots) {
    const s3 = (root.node * 4) * LEVELS + fullTop;
    const value = D[full]![s3]!;
    if (!Number.isFinite(value)) continue;
    // A turn right at the root's end needs its elbow's setback clear of the collar transition.
    const first = how[full]![s3]!;
    if (first > MOVE && root.outletMm < (options.rootTurnMinMm ?? 0)) continue;
    const straight = root.outletMm * (fullLayer.prices[fullLayer.prices.length - 1] ?? INF);
    const penalty = root.outletMm < options.fanOutletMm ? lambda * options.shortOutletPenaltyPa : 0;
    results.push({ root, value: value + straight + penalty });
  }
  if (!results.length) return null;
  results.sort((a, b) => a.value - b.value);

  const usages: Usage[] = [];
  const designs: ServiceDesign[] = [];
  const seen = new Set<string>();
  for (const { root, value } of results) {
    const usage: Usage = { edges: new Map(), nodes: new Map() };
    const use = (run: RunDesign, S: number, v: number, u: number) => {
      const key = edgeKey(v, u);
      usage.edges.set(key, [...(usage.edges.get(key) ?? []), S]);
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
      return (u * 4 + dir) * LEVELS + arrive(topOf(layers[S]!), 0, branch ? Math.max(0, length - collarMm) : length);
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
        if (choice >= MOVE) {
          const dir = choice - MOVE;
          const u = nb[v * 4 + dir]!;
          use(run, S, v, u);
          const next = arrive(top, dir === h ? level : 0, graph.edgeLength[v * 4 + dir]!);
          s3 = (u * 4 + dir) * LEVELS + next;
          continue;
        }
        if (choice === LEAF) {
          run.end = { kind: 'terminal', terminal: terminals[Math.log2(S)]! };
          return;
        }
        if (choice === TEE_LEFT || choice === TEE_RIGHT || choice === STUB_LEFT || choice === STUB_RIGHT) {
          const A = subset[S]![s3]!;
          const B = S ^ A;
          const side = choice === TEE_LEFT || choice === STUB_LEFT ? 1 : -1;
          const out = side > 0 ? leftOf(h) : rightOf(h);
          const child = newRun({ kind: 'tap' }, at(v));
          run.taps.push({ station: runLengthMm(run), side, child });
          if (choice === STUB_LEFT || choice === STUB_RIGHT) {
            // Collar + damper, then flex: the realiser lays the stub off the actual wall.
            const p = at(v);
            const outDir = DIRECTIONS[out]!;
            child.vertices.push({ x: p.x + outDir.x * (stubMm + 150), y: p.y + outDir.y * (stubMm + 150) });
            child.allFlex = true;
            child.end = { kind: 'terminal', terminal: terminals[Math.log2(B)]! };
            enter(child, B, v);
          } else {
            walk(child, B, leave(B, v, out, true), v);
          }
          S = A;
          if (popcount(A) === 1) {
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
        if (choice === SPLIT) {
          const A = subset[S]![s3]!;
          const B = S ^ A;
          const plus = newRun({ kind: 'split', side: 1 }, at(v));
          const minus = newRun({ kind: 'split', side: -1 }, at(v));
          run.end = { kind: 'split', children: [plus, minus] };
          walk(plus, A, leave(A, v, leftOf(h)), v);
          walk(minus, B, leave(B, v, rightOf(h)), v);
          return;
        }
        return;
      }
    };
    const rootRun = newRun({ kind: 'unit' }, { x: 0, y: 0 });
    // The fan-outlet straight is the root's too.
    for (let node = 0; node < graph.nodeCount; node += 1) {
      if (Math.abs(graph.nodeY[node]!) < 1 && graph.nodeX[node]! < root.outletMm - 1) {
        usage.nodes.set(node, [...(usage.nodes.get(node) ?? []), { run: rootRun.key, set: full, start: false }]);
      }
    }
    enter(rootRun, full, root.node);
    walk(rootRun, full, (root.node * 4) * LEVELS + fullTop, null);
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
  return { designs, usages, modelCost: results[0]!.value, seconds: (Date.now() - started) / 1000 };
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
export function routeTrees(ctx: ServiceCtx, model: SizingModel, graph: RoutingGraph, options: SteinerOptions, rounds = 5): SteinerSolution | null {
  const blocked: BlockedEdges = new Map(options.blocked ?? []);
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
  let last: SteinerSolution | null = null;
  for (let round = 0; round < rounds; round += 1) {
    const solution = steinerTrees(ctx, model, graph, { ...options, blocked });
    if (!solution) return last ? { ...last, designs: [], usages: [] } : null;
    const clean = solution.designs.map((design, index) => ({ design, usage: solution.usages[index]! }))
      .filter(({ usage }) => conflicts(usage, flowOf).length === 0);
    if (clean.length) return { ...solution, designs: clean.map((entry) => entry.design), usages: clean.map((entry) => entry.usage) };
    last = solution;
    // Block what the best tree's runs fought over, for the smaller subtree, and try again.
    for (const conflict of conflicts(solution.usages[0]!, flowOf)) {
      for (let dir = 0; dir < 4; dir += 1) {
        const u = graph.neighbour[conflict.node * 4 + dir]!;
        if (u < 0) continue;
        if (conflict.other !== undefined && u !== conflict.other) continue;
        block(conflict.node, dir, conflict.set);
        block(u, reverseOf(dir), conflict.set);
      }
    }
  }
  return last ? { ...last, designs: [], usages: [] } : null;
}
