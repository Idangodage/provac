/**
 * One service's optimisation: every candidate tree (the router's and the v1
 * layouts') is sized exactly (sizingDp.ts) into its frontier of first cost
 * against fan pressure; the most promising points are built into runs,
 * planned, clash-checked and re-priced from their plans. Only verified
 * numbers leave this module.
 */
import type { HvacElement, Point2D } from '../../../../../types';
import { listNetworkPipeLanes } from '../../networkPipeClearance';
import type { AutoDuctIssue, ServiceCtx } from '../ductAutoContext';
import { priceDuctPlans, type DuctCostBreakdown } from '../ductEconomics';
import { planDuctRunSpec, type DuctFabricationPlan } from '../ductFabricationPlanner';
import { systemPressure, type ServicePressure } from '../ductPressure';
import { getDuctSupportPlan } from '../ductSupports';
import { readDuctRunSpec } from '../ductTypes';
import { findDuctClashes } from '../ductVolumes';

import { withReplaced, type ServiceDesign } from './designTree';
import { realiseDesign, type RealiseFailure } from './realiseDesign';
import { frontierPoints, sizeDesign, type DesignFrontier, type DpGrid, type SizingFailure } from './sizingDp';
import { SizingModel, type ShapeMode } from './sizingModel';

export interface VerifiedRuns {
  plans: DuctFabricationPlan[];
  issues: AutoDuctIssue[];
  errors: number;
  warnings: number;
  pressure: ServicePressure;
  /** Rod hangers and runout straps the support plans place. */
  hangers: number;
  straps: number;
}

/** Plans, clash checks and the pressure of every terminal path, for runs built for one service. */
export function verifyRuns(ctx: ServiceCtx, runs: readonly HvacElement[], notes: readonly AutoDuctIssue[] = [], terminalUpdates: readonly HvacElement[] = []): VerifiedRuns {
  // Terminals whose spigot the design turns are checked as they will be.
  const scene = [...withReplaced(ctx.baseScene, terminalUpdates), ...runs];
  const plans = runs.map((run) => planDuctRunSpec(run.id, readDuctRunSpec(run)!, { settings: ctx.settings, scene }));
  const issues: AutoDuctIssue[] = [...notes];
  let errors = 0;
  let warnings = 0;
  for (const plan of plans) {
    for (const issue of plan.issues) {
      if (issue.severity === 'error') errors += 1;
      else if (issue.severity === 'warning') warnings += 1;
      else continue;
      issues.push({ code: issue.code, severity: issue.severity, message: issue.message, service: ctx.service, runId: plan.elementId, ...(issue.point ? { point: { x: issue.point.x, y: issue.point.y } } : {}) });
    }
  }
  const newIds = new Set(runs.map((run) => run.id));
  for (const clash of findDuctClashes(scene, ctx.settings, listNetworkPipeLanes(scene))) {
    if (!newIds.has(clash.ductId) && !newIds.has(clash.otherId)) continue;
    errors += 1;
    issues.push({
      code: 'DU_CLASH', severity: 'error', message: `${clash.mark} clashes with ${clash.kind === 'pipe' ? `a ${clash.service ?? 'pipe'}` : clash.kind === 'terminal' ? 'an air terminal' : 'another duct'}.`,
      service: ctx.service, point: { x: clash.point.x, y: clash.point.y }, runId: newIds.has(clash.ductId) ? clash.ductId : clash.otherId,
    });
  }
  // A run through a wall (the walls are obstacles to the router, not to the layout seeds).
  for (const run of runs) {
    const path = readDuctRunSpec(run)?.path ?? [];
    for (let index = 1; index < path.length; index += 1) {
      const a = path[index - 1]!;
      const b = path[index]!;
      if (!(ctx.walls ?? []).some((wall) => segmentsCross(a, b, wall.startPoint, wall.endPoint))) continue;
      errors += 1;
      issues.push({
        code: 'DU_AUTO_WALL', severity: 'error', message: 'The duct passes through a wall.', service: ctx.service,
        point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, runId: run.id,
      });
    }
  }
  const pressure = systemPressure(plans, new Map(ctx.terminals.map((terminal) => [terminal.element.id, terminal.airflowM3h])), ctx.settings, ctx.service);
  let hangers = 0;
  let straps = 0;
  for (const plan of plans) {
    for (const hanger of getDuctSupportPlan(plan, scene, ctx.settings).hangers) {
      if (hanger.kind === 'strap') straps += 1;
      else hangers += 1;
    }
  }
  return { plans, issues, errors, warnings, pressure, hangers, straps };
}

/** Proper crossing of two plan segments (touching ends do not count). */
function segmentsCross(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  const cross = (o: Point2D, p: Point2D, q: Point2D) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 1e-6 && d2 < -1e-6) || (d1 < -1e-6 && d2 > 1e-6)) && ((d3 > 1e-6 && d4 < -1e-6) || (d3 < -1e-6 && d4 > 1e-6));
}

export interface ServiceOption {
  key: string;
  /** "Split trunk + branches", "Optimised tree (λ = 1)" … */
  label: string;
  source: ServiceDesign['source'] | 'v1';
  shape: ShapeMode;
  runs: HvacElement[];
  plans: DuctFabricationPlan[];
  terminalRuns: Map<string, string>;
  trunkSections: Array<{ widthMm: number; heightMm: number; diameterMm?: number; airflowM3h: number }>;
  pressure: ServicePressure;
  /** The index path the fan must overcome (verified, Pa). */
  espPa: number;
  cost: DuctCostBreakdown;
  errors: number;
  warnings: number;
  issues: AutoDuctIssue[];
  /** The sizing model's own figures for the point (the certificate compares them). */
  modelCost: number;
  modelPressurePa: number;
  exact: boolean;
  /** The tree it was built from, and which of its runs each built run is (element id → run key). */
  design?: ServiceDesign;
  runKeys?: Map<string, string>;
  /** Terminals whose plenum spigot the design turns to another side: the elements as they will be. */
  terminalUpdates: HvacElement[];
}

/** A tree that could not be sized or built: which, where and why (the router learns from these). */
export interface TreeFailure {
  design: ServiceDesign;
  stage: 'sizing' | 'realise';
  failure: SizingFailure | RealiseFailure;
}

export interface ServiceOptimisation {
  options: ServiceOption[];
  frontiers: number;
  realised: number;
  pricePerPa: number;
  failures: TreeFailure[];
}

/** Grid of the frontiers: 0.2 Pa up to 1.5 × the fan's maximum (at least 80 Pa). */
export function frontierGrid(maxEspPa: number | null): DpGrid {
  const stepPa = 0.2;
  return { stepPa, size: Math.ceil((Math.max(80, maxEspPa ?? 100) * 1.5) / stepPa) + 1 };
}

/** The points worth building from a frontier: least life-cycle cost, least first cost and least pressure within the budget. */
export function frontierPicks(frontier: DesignFrontier, pricePerPa: number, budgetPa: number): number[] {
  const points = frontierPoints(frontier.cost).filter((point) => point.index * frontier.grid.stepPa <= budgetPa + 1e-9);
  const usable = points.length ? points : frontierPoints(frontier.cost);
  if (!usable.length) return [];
  const lifeCycle = usable.reduce((best, point) => (point.cost + pricePerPa * point.index * frontier.grid.stepPa
    < best.cost + pricePerPa * best.index * frontier.grid.stepPa ? point : best));
  const cheapest = usable[usable.length - 1]!;
  const quietest = usable[0]!;
  return [...new Set([lifeCycle.index, cheapest.index, quietest.index])];
}

/** Trees are built and verified in order of promise until this many verify without an error … */
const CLEAN_WANTED = 3;
/** … or this many have been tried. */
const TREES_TRIED = 12;

/**
 * The order trees are built in: the most promising of each source first (the
 * router's and the layout seeds' — a seed that looks cheap on the model must
 * not crowd out the router's trees), then the rest by promise.
 */
function buildOrder<T extends { frontier: DesignFrontier; best: number }>(sized: readonly T[]): T[] {
  const sorted = [...sized].sort((a, b) => a.best - b.best);
  const leaders = ['steiner', 'seed'].flatMap((source) => sorted.filter((entry) => entry.frontier.design.source === source).slice(0, 1));
  return [...leaders.sort((a, b) => a.best - b.best), ...sorted.filter((entry) => !leaders.includes(entry))];
}

export function optimiseService(
  ctx: ServiceCtx,
  designs: readonly ServiceDesign[],
  shape: ShapeMode,
  unitAirflowM3h: number,
  budgetPa: number,
): ServiceOptimisation {
  const model = new SizingModel(ctx, shape, unitAirflowM3h);
  const grid = frontierGrid(budgetPa);
  const sized: Array<{ frontier: DesignFrontier; best: number }> = [];
  const failures: TreeFailure[] = [];
  for (const design of designs) {
    const frontier = sizeDesign(design, model, grid, (failure) => failures.push({ design, stage: 'sizing', failure }));
    if (!frontier) continue;
    let best = Number.POSITIVE_INFINITY;
    frontier.cost.forEach((cost, index) => {
      if (index * grid.stepPa <= budgetPa + 1e-9) best = Math.min(best, cost + model.pricePerPa * index * grid.stepPa);
    });
    sized.push({ frontier, best });
  }
  const options: ServiceOption[] = [];
  let realised = 0;
  let clean = 0;
  let tried = 0;
  for (const { frontier } of buildOrder(sized)) {
    if (clean >= CLEAN_WANTED || tried >= TREES_TRIED) break;
    tried += 1;
    // The life-cycle pick first. When it fails, the tree's other sizes mostly fail the same way: only the
    // cheapest (its smaller sections take less room) is still tried.
    const picks = frontierPicks(frontier, model.pricePerPa, budgetPa);
    // The cheapest pick is the one at the highest pressure (least first cost).
    const cheapest = Math.max(...picks);
    let leadFailed = false;
    for (const [order, index] of picks.entries()) {
      if (leadFailed && index !== cheapest) continue;
      const point = frontier.reconstruct(index);
      if (!point) continue;
      const built = realiseDesign(ctx, model, point, (failure) => failures.push({ design: frontier.design, stage: 'realise', failure }));
      realised += 1;
      if (!built) { if (order === 0) leadFailed = true; continue; }
      const verified = verifyRuns(ctx, built.runs, [...frontier.design.notes, ...built.notes], built.terminalUpdates);
      const cost = priceDuctPlans(verified.plans, ctx.settings, verified.hangers, verified.straps);
      cost.total += frontier.design.penalty;
      options.push({
        key: `${frontier.design.label}#${index}`,
        label: frontier.design.label,
        source: frontier.design.source,
        shape,
        runs: built.runs,
        plans: verified.plans,
        terminalRuns: built.terminalRuns,
        trunkSections: built.trunkSections,
        pressure: verified.pressure,
        espPa: verified.pressure.indexPa,
        cost,
        errors: verified.errors,
        warnings: verified.warnings,
        issues: verified.issues,
        modelCost: point.modelCost,
        modelPressurePa: point.modelPressurePa,
        exact: frontier.design.exact ?? false,
        design: frontier.design,
        runKeys: built.runKeys,
        terminalUpdates: built.terminalUpdates,
      });
      if (verified.errors === 0) clean += 1;
      else if (order === 0) leadFailed = true;
    }
  }
  return { options, frontiers: sized.length, realised, pricePerPa: model.pricePerPa, failures };
}
