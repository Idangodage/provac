import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../../types';
import { resolveUnitAirPorts } from '../ductAirPorts';
import { flexFit, type ServiceCtx, type TerminalCtx } from '../ductAutoContext';
import { generateAutoDuct, inspectAutoDuctContexts, type AutoDuctRequest } from '../ductAutoLayout';
import { legNormal } from '../ductBranches';
import { galvanisedSheetMassKgPerM2 } from '../ductCatalog';
import { energyPricePerPa, presentWorthFactor, sectionCostPerMetre } from '../ductEconomics';
import { maxRoundBranchMm } from '../ductRoundFittings';
import { resolveDuctSettings, type DuctDesignSettings } from '../ductSettings';
import { velocityPressurePa, velocityMs } from '../ductSizing';
import { terminalEnvelope, typicalTerminalSpec } from '../ductTerminals';
import { roundLeg, type DuctLeg } from '../ductTypes';

import { computeFlows, type RunDesign, type ServiceDesign } from './designTree';
import { frontierGrid } from './ductOptimizer';
import type { RoutingGraph } from './routingGraph';
import { frontierPoints, sizeDesign } from './sizingDp';
import { sameLeg, SizingModel } from './sizingModel';
import { emptyCuts, newLayerMemo, steinerTrees } from './steinerArborescence';

// ---- Scene helpers (as the auto layout tests) ----

function fdum(): HvacElement {
  return {
    id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
    elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
    properties: { modelCode: 'FDUM22KXE6F-W', modelUrl: '/models/vrf/maco-vrf-fdum22kxe6f-w.glb' },
  };
}
const supplyFrame = (unit: HvacElement) => {
  const port = resolveUnitAirPorts(unit).find((candidate) => candidate.kind === 'supply')!;
  return { n: port.normal, t: legNormal(port.normal), lip: { x: port.lip.x, y: port.lip.y } };
};
const at = (frame: ReturnType<typeof supplyFrame>, along: number, across: number): Point2D => ({
  x: frame.lip.x + frame.n.x * along + frame.t.x * across, y: frame.lip.y + frame.n.y * along + frame.t.y * across,
});
function terminal(id: string, centre: Point2D, facing: Point2D): HvacElement {
  const spec = typicalTerminalSpec('square-4way', 200);
  const envelope = terminalEnvelope(spec);
  const rotation = (((Math.atan2(facing.x, -facing.y) * 180) / Math.PI) + 360) % 360;
  return {
    id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 },
    rotation, width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { terminal: spec },
  };
}
const request = (ids: string[], overrides: Partial<AutoDuctRequest> = {}): AutoDuctRequest => ({
  unitId: 'fdum', terminalIds: ids, fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: false }, rebuildExisting: false, ...overrides,
});
function contextFor(scene: HvacElement[], ids: string[], settings: DuctDesignSettings): ServiceCtx {
  let ctx: ServiceCtx | null = null;
  inspectAutoDuctContexts((found) => { ctx ??= found; });
  generateAutoDuct(scene, request(ids, { layout: 'plenum' }), settings);
  inspectAutoDuctContexts(null);
  return ctx!;
}

describe('economics (practice rates)', () => {
  const settings = resolveDuctSettings({});
  it('present worth of a rising yearly energy bill, and the price of a pascal', () => {
    const ratio = 1.02 / 1.06;
    const closed = (ratio * (1 - ratio ** 15)) / (1 - ratio);
    expect(presentWorthFactor(15, 6, 2)).toBeCloseTo(closed, 10);
    // 600 m³/h, 3000 h, η 0.45, 0.15 per kWh: Q·h·price·PW / (1000·η) per pascal.
    expect(energyPricePerPa(600, settings)).toBeCloseTo(((600 / 3600) * 3000 * 0.15 * closed) / (1000 * 0.45), 10);
  });

  it('a metre of spiral Ø250 by hand: sheet, fabrication, installation, joints at 3 m, hangers at 2.4 m', () => {
    const girth = Math.PI * (250 + 2 * 0.5);
    const area = girth / 1000;
    const expected = area * (galvanisedSheetMassKgPerM2(0.5) * 1.6 + 6 + 9) + (1000 / 3000) * area * 5 + (1000 / 2400) * 14;
    expect(sectionCostPerMetre(roundLeg(250), { service: 'supply', construction: 'gi-bare', settings, insulationMm: 0 })).toBeCloseTo(expected, 6);
  });
});

describe('sizing DP: exact against brute force', () => {
  // A round main off the collar with one take-off, running on into a second terminal.
  const settings = resolveDuctSettings({ soffitMm: 3200, autoRoundMainStyles: ['round-conical', 'round-tee'] });
  const unit = fdum();
  const frame = supplyFrame(unit);
  const t1 = terminal('t1', at(frame, 2000, 2300), { x: -frame.t.x, y: -frame.t.y });
  const t2 = terminal('t2', at(frame, 3500, 0), { x: -frame.n.x, y: -frame.n.y });
  const ctx = contextFor([unit, t1, t2], ['t1', 't2'], settings);
  const [a, b] = ctx.terminals as [TerminalCtx, TerminalCtx];
  const child: RunDesign = { key: 'c', start: { kind: 'tap' }, vertices: [{ x: 2000, y: 0 }, { x: 2000, y: a.lip.y - 700 }], taps: [], end: { kind: 'terminal', terminal: a }, airflowM3h: 0, allFlex: false };
  const root: RunDesign = { key: 'r', start: { kind: 'unit' }, vertices: [{ x: 0, y: 0 }, { x: b.lip.x - 700, y: 0 }], taps: [{ station: 2000, side: 1, child }], end: { kind: 'terminal', terminal: b }, airflowM3h: 0, allFlex: false };
  computeFlows(root);
  const design: ServiceDesign = { label: 'test', source: 'seed', root, fanOutletMm: 900, penalty: 0, notes: [] };
  const model = new SizingModel(ctx, 'round', ctx.airflowM3h);
  const grid = frontierGrid(100);

  /** Every combination, costed and pressured path by path (independent of the DP's recursion). */
  function bruteForce(): Array<{ cost: number; pressure: number }> {
    const collar: DuctLeg = { widthMm: ctx.port.widthMm, heightMm: ctx.port.heightMm };
    const q = root.airflowM3h;
    const lengthRoot = b.lip.x - 700;
    const lengthChild = Math.abs(a.lip.y - 700);
    const connectorMm = settings.connectorFabricMm + 2 * settings.connectorMetalMm;
    const connectorLoss = 0.1 * velocityPressurePa(velocityMs(collar, ctx.airflowM3h));
    const childOptions = model.branchOptions(a.airflowM3h, a.neck);
    const smallest = Math.min(...childOptions.map((leg) => leg.diameterMm!));
    const extra = settings.autoRoundSizesMm.find((size) => maxRoundBranchMm(size) >= smallest - 0.5 && size <= model.maxHeightMm);
    const rootOptions = [...model.trunkOptions(q), ...(extra ? [roundLeg(extra)] : [])].filter((leg, index, all) => all.findIndex((other) => sameLeg(other, leg)) === index);
    const windowHalf = Math.max(...childOptions.map((leg) => leg.widthMm)) / 2 + 51 + settings.conicalFlareMm / 2 + settings.tapWindowMarginMm;
    const out: Array<{ cost: number; pressure: number }> = [];
    for (const x of rootOptions) {
      const collarFit = model.transition(collar, x, q);
      if (connectorMm + collarFit.lengthMm + 2 * windowHalf > lengthRoot - 100 + 1e-6) continue;
      for (const y of childOptions) {
        if (y.diameterMm! > maxRoundBranchMm(x.diameterMm!) + 0.5) continue;
        for (const style of ['round-conical', 'round-tee'] as const) {
          const tee = model.tee(style, y, a.airflowM3h, x, q);
          const endRoot = sameLeg(x, roundLeg(b.neck)) ? { cost: 0, loss: 0 } : model.transition(x, roundLeg(b.neck), b.airflowM3h);
          const endChild = sameLeg(y, roundLeg(a.neck)) ? { cost: 0, loss: 0 } : model.transition(y, roundLeg(a.neck), a.airflowM3h);
          const flexA = runout(model, child, a);
          const flexB = runout(model, root, b);
          const cost = collarFit.cost + model.costPerMetre(x) * (lengthRoot / 1000) + tee.cost + endRoot.cost + flexB.cost
            + model.costPerMetre(y) * (lengthChild / 1000) + endChild.cost + flexA.cost;
          const common = collarFit.loss + connectorLoss + model.friction(x, q, 2000);
          const pathA = common + tee.loss + model.friction(y, a.airflowM3h, lengthChild) + endChild.loss + flexA.loss + model.terminalDropPa;
          const pathB = common + model.passage(x, q, b.airflowM3h) + model.friction(x, b.airflowM3h, lengthRoot - 2000) + endRoot.loss + flexB.loss + model.terminalDropPa;
          out.push({ cost, pressure: Math.max(pathA, pathB) });
        }
      }
    }
    return out;
  }

  it('the least first cost at each fan pressure equals the enumeration (within the grid rounding)', () => {
    const frontier = sizeDesign(design, model, grid)!;
    expect(frontier).not.toBeNull();
    const combos = bruteForce();
    expect(combos.length).toBeGreaterThan(3);
    // Each loss is rounded up to the step; a path adds at most ~10 of them.
    const slack = 10 * grid.stepPa;
    for (const budget of [15, 20, 25, 30, 40, 60]) {
      const exact = Math.min(...combos.filter((combo) => combo.pressure <= budget).map((combo) => combo.cost));
      const index = Math.round(budget / grid.stepPa);
      const dp = frontier.cost[index]!;
      if (!Number.isFinite(exact)) continue;
      // Never below the true optimum (it is a real design), and at most the true optimum once the rounding slack is allowed.
      expect(dp).toBeGreaterThanOrEqual(exact - 1e-6);
      expect(frontier.cost[Math.min(frontier.cost.length - 1, index + Math.ceil(slack / grid.stepPa))]!).toBeLessThanOrEqual(exact + 1e-6);
    }
  });

  it('every point reconstructs to sizes the recursion prices at its own cost', () => {
    const frontier = sizeDesign(design, model, grid)!;
    for (const point of frontierPoints(frontier.cost)) {
      const sized = frontier.reconstruct(point.index);
      expect(sized).not.toBeNull();
      expect(sized!.modelCost).toBeCloseTo(point.cost, 6);
      expect(sized!.sizing.get('r')!.sections[0]!.diameterMm).toBeDefined();
    }
  });

  it('a dearer pascal never buys a design that needs more fan pressure', () => {
    const frontier = sizeDesign(design, model, grid)!;
    const points = frontierPoints(frontier.cost);
    const pick = (price: number) => points.reduce((best, point) => (point.cost + price * point.index * grid.stepPa < best.cost + price * best.index * grid.stepPa ? point : best));
    let previous = Number.POSITIVE_INFINITY;
    for (const price of [0, 0.5, 2, 8, 32, 128]) {
      const chosen = pick(price);
      expect(chosen.index).toBeLessThanOrEqual(previous);
      previous = chosen.index;
    }
  });

  function designWithNarrowTail(halfWidthMm: number) {
    const tailElement = terminal('tail', at(frame, 6500, 0), { x: -frame.n.x, y: -frame.n.y });
    const narrowCtx = contextFor([unit, t1, tailElement], ['t1', 'tail'], settings);
    const [branchTerminal, tailTerminal] = narrowCtx.terminals as [TerminalCtx, TerminalCtx];
    const branch: RunDesign = {
      ...child, end: { kind: 'terminal', terminal: branchTerminal },
    };
    const endMm = tailTerminal.lip.x - 700;
    const main: RunDesign = {
      ...root, vertices: [{ x: 0, y: 0 }, { x: endMm, y: 0 }],
      taps: [{ station: 2000, side: 1, child: branch }],
      end: { kind: 'terminal', terminal: tailTerminal }, corridorMm: halfWidthMm,
      corridors: [
        { fromMm: 0, toMm: 4500, halfWidthMm: Number.POSITIVE_INFINITY },
        { fromMm: 4500, toMm: endMm, halfWidthMm },
      ],
    };
    computeFlows(main);
    return {
      design: { ...design, root: main },
      model: new SizingModel(narrowCtx, 'round', narrowCtx.airflowM3h),
    };
  }

  it('keeps a wide main and reduces before a narrow downstream corridor', () => {
    const narrow = designWithNarrowTail(160);
    const frontier = sizeDesign(narrow.design, narrow.model, grid);
    expect(frontier).not.toBeNull();
    const points = frontierPoints(frontier!.cost);
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      const main = frontier!.reconstruct(point.index)!.sizing.get('r')!;
      expect(main.sections[0]!.diameterMm).toBeGreaterThanOrEqual(300);
      expect(main.sections.at(-1)!.diameterMm).toBe(200);
      const reducer = narrow.model.transition(main.sections[0]!, main.sections[1]!, narrow.model.ctx.terminals[1]!.airflowM3h);
      expect(main.boundaries[0]! + reducer.lengthMm / 2).toBeLessThan(4500);
    }
    // A legacy run with only a global corridor still honours that bound.
    const legacy = { ...narrow.design, root: { ...narrow.design.root, corridors: undefined } };
    expect(sizeDesign(legacy, narrow.model, grid)).toBeNull();
  });

  it('rejects a tail too narrow even when a larger upstream section could carry on', () => {
    const narrow = designWithNarrowTail(149);
    expect(sizeDesign(narrow.design, narrow.model, grid)).toBeNull();
  });
});

/** The runout the DP prices for a run's end (the same flex curve the planner draws). */
function runout(model: SizingModel, run: RunDesign, terminalCtx: TerminalCtx) {
  const last = run.vertices[run.vertices.length - 1]!;
  const before = run.vertices[run.vertices.length - 2]!;
  const length = Math.hypot(last.x - before.x, last.y - before.y);
  const out = { x: (last.x - before.x) / length, y: (last.y - before.y) / length };
  return model.flex(terminalCtx.neck, terminalCtx.airflowM3h, flexFit(model.ctx, last, out, model.ctx.bottomZ, terminalCtx).lengthMm);
}

describe('tree router: exact against brute force (two terminals, an open grid)', () => {
  // A 5 × 5 grid at 1 m, prices that differ by layer (the full flow dearer per mm), elbows and tees priced.
  const xs = [0, 1000, 2000, 3000, 4000];
  const ys = [-2000, -1000, 0, 1000, 2000];
  const count = xs.length * ys.length;
  const node = (i: number, j: number) => i * ys.length + j;
  const neighbour = new Int32Array(count * 4).fill(-1);
  const edgeLength = new Float64Array(count * 4);
  const corridor = new Float64Array(count * 4).fill(Number.POSITIVE_INFINITY);
  const nodeX = new Float64Array(count);
  const nodeY = new Float64Array(count);
  for (let i = 0; i < xs.length; i += 1) {
    for (let j = 0; j < ys.length; j += 1) {
      const v = node(i, j);
      nodeX[v] = xs[i]!;
      nodeY[v] = ys[j]!;
      const links: Array<[number, number, number]> = [[0, i + 1, j], [1, i, j + 1], [2, i - 1, j], [3, i, j - 1]];
      for (const [d, ni, nj] of links) {
        if (ni < 0 || nj < 0 || ni >= xs.length || nj >= ys.length) continue;
        neighbour[v * 4 + d] = node(ni, nj);
        edgeLength[v * 4 + d] = 1000;
      }
    }
  }
  const leafA = { node: node(3, 4), heading: 1, flexLengthMm: 500, variant: 0 };
  const leafB = { node: node(4, 0), heading: 0, flexLengthMm: 900, variant: 0 };
  const graph: RoutingGraph = {
    xs, ys, nodeX, nodeY, nodeCount: count, neighbour, edgeLength, corridor,
    nodeClear: new Float64Array(count).fill(Number.POSITIVE_INFINITY),
    leaves: [[leafA], [leafB]], roots: [{ node: node(1, 2), outletMm: 1000 }],
  };
  const settings = resolveDuctSettings({ tapCollarMm: 50, vcdLengthMm: 50, elbowNeckMm: 0 });
  const far = { x: 1e6, y: 1e6 };
  const terminalCtx = (id: string) => ({ element: { id } as HvacElement, airflowM3h: 100, neck: 100, lip: far, normal: { x: 1, y: 0 }, port: { lip: { ...far, z: 0 }, normal: { x: 1, y: 0 } } }) as unknown as TerminalCtx;
  const ctx = { terminals: [terminalCtx('a'), terminalCtx('b')], settings, service: 'supply', bottomZ: 0, port: { widthMm: 100, heightMm: 100 } } as unknown as ServiceCtx;
  const ELBOW = 3;
  const TEE = 5;
  const perMm = (flow: number) => (flow > 150 ? 0.004 : 0.001);
  const trunk: DuctLeg = { widthMm: 100, heightMm: 100 };
  const branch = roundLeg(100);
  const mock = {
    ctx, settings, costContext: { insulationMm: 0 },
    trunkOptions: () => [trunk], branchOptions: () => [branch],
    costPerMetre: (leg: DuctLeg) => 1000 * perMm(leg === trunk ? 200 : 100),
    friction: () => 0, elbowRadiusMm: () => 0,
    elbow: () => ({ cost: ELBOW, loss: 0 }), tee: () => ({ cost: TEE, loss: 0 }),
    split: () => ({ cost: Number.POSITIVE_INFINITY, losses: [0, 0] }),
    flex: (_neck: number, _q: number, length: number) => ({ cost: length / 1000, loss: 0 }),
    collarLengthMm: () => 0,
    // No fitting lengths: every clearance holds after one 1 m edge, as the brute force assumes.
    bendReachMm: () => 0, elbowSetbackMm: () => 0, tapWindowHalfMm: () => 0, endStraightMm: () => 0, diagonalRoomMm: () => 0, turnFirstReachMm: () => 0,
    transitionLengthMm: () => ({ lengthMm: 0, slopeMm: 0, includedDeg: 0 }),
  } as unknown as SizingModel;

  /** Independent shortest paths over (node, heading) with elbows, for one layer. */
  function dijkstra(price: number, sources: Array<{ state: number; cost: number }>, backward: boolean): Float64Array {
    const dist = new Float64Array(count * 4).fill(Number.POSITIVE_INFINITY);
    const queue = sources.map((source) => ({ ...source }));
    for (const source of sources) dist[source.state] = Math.min(dist[source.state]!, source.cost);
    while (queue.length) {
      queue.sort((m, n) => m.cost - n.cost);
      const { state, cost } = queue.shift()!;
      if (cost > dist[state]!) continue;
      const v = state >> 2;
      const h = state & 3;
      if (!backward) {
        for (const dir of [h, (h + 1) % 4, (h + 3) % 4]) {
          const u = neighbour[v * 4 + dir]!;
          if (u < 0) continue;
          const next = u * 4 + dir;
          const value = cost + 1000 * price + (dir === h ? 0 : ELBOW);
          if (value < dist[next]!) { dist[next] = value; queue.push({ state: next, cost: value }); }
        }
      } else {
        // Into (v, h) from w = the node before v along h, having arrived there heading h or turning at w.
        const w = neighbour[v * 4 + ((h + 2) % 4)]!;
        if (w < 0) continue;
        for (const from of [h, (h + 1) % 4, (h + 3) % 4]) {
          const prev = w * 4 + from;
          const value = cost + 1000 * price + (from === h ? 0 : ELBOW);
          if (value < dist[prev]!) { dist[prev] = value; queue.push({ state: prev, cost: value }); }
        }
      }
    }
    return dist;
  }

  it('the subset programme finds the same optimum as trying every take-off point', () => {
    const solution = steinerTrees(ctx, mock, graph, { lambda: 0, label: 'test', fanOutletMm: 1000, shortOutletPenaltyPa: 0, maxTerminals: 8 });
    expect(solution).not.toBeNull();
    // To each leaf from any state (arriving on the leaf's heading), per single-terminal layer.
    const toA = dijkstra(perMm(100), [{ state: leafA.node * 4 + leafA.heading, cost: 0.5 }], true);
    const toB = dijkstra(perMm(100), [{ state: leafB.node * 4 + leafB.heading, cost: 0.9 }], true);
    // From the root along the full layer.
    const fromRoot = dijkstra(perMm(200), [{ state: graph.roots[0]!.node * 4, cost: 0 }], false);
    let best = Number.POSITIVE_INFINITY;
    for (let v = 0; v < count; v += 1) {
      for (let h = 0; h < 4; h += 1) {
        const arrive = fromRoot[v * 4 + h]!;
        if (!Number.isFinite(arrive)) continue;
        const ahead = neighbour[v * 4 + h]!;
        for (const [mainTo, branchTo] of [[toA, toB], [toB, toA]] as const) {
          if (ahead < 0) continue;
          const main = 1000 * perMm(100) + mainTo[ahead * 4 + h]!;
          for (const side of [(h + 1) % 4, (h + 3) % 4]) {
            const u = neighbour[v * 4 + side]!;
            if (u < 0) continue;
            best = Math.min(best, arrive + TEE + main + 1000 * perMm(100) + branchTo[u * 4 + side]!);
          }
        }
      }
    }
    // The router adds the fan-outlet straight in the full layer.
    expect(solution!.modelCost).toBeCloseTo(best + 1000 * perMm(200), 6);
  });

  it('a new cut re-solves only the layers it can change, and the optimum is the same as solving afresh', () => {
    const base = { lambda: 0, label: 'test', fanOutletMm: 1000, shortOutletPenaltyPa: 0, maxTerminals: 8 };
    const memo = newLayerMemo();
    const first = steinerTrees(ctx, mock, graph, { ...base, memo })!;
    const aloneA = memo.saved.get(1);
    // No take-off for terminal b where the optimum took it off: only the layers holding b can change.
    const cuts = emptyCuts();
    const allRuns = (run: RunDesign): RunDesign[] => [run, ...run.taps.flatMap((tap) => allRuns(tap.child))];
    const tapped = allRuns(first.designs[0]!.root).find((run) => run.route?.kind === 'tee' || run.route?.kind === 'stub');
    cuts.tees.set(2, new Set(tapped ? [tapped.route!.node] : [0]));
    const again = steinerTrees(ctx, mock, graph, { ...base, memo, cuts });
    const fresh = steinerTrees(ctx, mock, graph, { ...base, cuts });
    expect(memo.saved.get(1)).toBe(aloneA);
    expect(again === null).toBe(fresh === null);
    if (fresh) expect(again!.modelCost).toBeCloseTo(fresh.modelCost, 9);
  });

  it('one terminal: the least-cost path, elbows included', () => {
    const one = { ...ctx, terminals: [ctx.terminals[0]!] } as ServiceCtx;
    const solution = steinerTrees(one, mock, { ...graph, leaves: [[leafA]] }, { lambda: 0, label: 'test', fanOutletMm: 1000, shortOutletPenaltyPa: 0, maxTerminals: 8 });
    const toA = dijkstra(perMm(100), [{ state: leafA.node * 4 + leafA.heading, cost: 0.5 }], true);
    expect(solution!.modelCost).toBeCloseTo(toA[graph.roots[0]!.node * 4]! + 1000 * perMm(100), 6);
  });
});

describe('the optimiser end to end', () => {
  const settings = resolveDuctSettings({ soffitMm: 3000 });
  const unit = fdum();
  const frame = supplyFrame(unit);
  const row = [-3750, -2250, -750, 750, 2250, 3750].map((across, index) => terminal(`r${index + 1}`, at(frame, 3000, across), { x: -frame.n.x, y: -frame.n.y }));
  const scene = [unit, ...row];
  const ids = row.map((element) => element.id);

  it('Optimal is never dearer than Rectangular or Round, and beats equal friction', () => {
    const results = (['rect', 'round', 'optimal'] as const).map((shape) => generateAutoDuct(scene, request(ids, { shape }), settings));
    // Every shape that builds a design is matched or beaten by Optimal (Round may find none here, and says so).
    const lcc = results.map((result) => result.designs[result.selected]?.lifeCycleCost ?? Number.POSITIVE_INFINITY);
    expect(lcc[2]!).toBeLessThanOrEqual(Math.min(lcc[0]!, lcc[1]!) + 1e-6);
    if (!Number.isFinite(lcc[1]!)) expect(results[1]!.issues.concat(results[1]!.services.flatMap((service) => service.issues)).map((issue) => issue.code)).toContain('DU_AUTO_NO_LAYOUT');
    const optimal = results[2]!;
    const reference = optimal.designs.find((design) => design.label.includes('(equal friction)'))!;
    expect(optimal.designs[optimal.selected]!.lifeCycleCost).toBeLessThan(reference.lifeCycleCost);
    // Under parallel load the shared unit deadline can stop refinement;
    // that result must be labelled time-limited rather than exact.
    expect(optimal.certificate).toBeDefined();
    expect(optimal.certificate!.exact).toBe(!optimal.certificate!.timeLimited);
  }, 120_000);

  it('the picks sit on the frontier: least first cost, least life-cycle, least pressure', () => {
    const result = generateAutoDuct(scene, request(ids, { shape: 'optimal' }), settings);
    const { cheapest, lifeCycle, quietest } = result.picks!;
    const clean = result.designs.filter((design) => design.errors === 0 && design.requiredEspPa <= result.maxEspPa!);
    expect(result.designs[cheapest]!.firstCost).toBeCloseTo(Math.min(...clean.map((design) => design.firstCost)), 6);
    expect(result.designs[lifeCycle]!.lifeCycleCost).toBeCloseTo(Math.min(...clean.map((design) => design.lifeCycleCost)), 6);
    expect(result.designs[quietest]!.requiredEspPa).toBeCloseTo(Math.min(...clean.map((design) => design.requiredEspPa)), 6);
    expect(result.selected).toBe(lifeCycle);
  }, 120_000);
});
