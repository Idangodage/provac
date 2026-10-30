/**
 * One service's optimisation: every candidate tree (the router's and the v1
 * layouts') is sized exactly (sizingDp.ts) into its frontier of first cost
 * against fan pressure; the most promising points are built into runs,
 * planned, clash-checked and re-priced from their plans. Only verified
 * numbers leave this module.
 */
import type { HvacElement } from '../../../../../types';
import { listNetworkPipeLanes } from '../../networkPipeClearance';
import { runSteps } from '../../parallel/steps';
import type { AutoDuctIssue, ServiceCtx } from '../ductAutoContext';
import { priceDuctPlans, type DuctCostBreakdown } from '../ductEconomics';
import { planDuctRunSpec, type DuctFabricationPlan } from '../ductFabricationPlanner';
import { crossingAllowed } from '../ductPenetrations';
import { systemPressure, type ServicePressure } from '../ductPressure';
import { getDuctSupportPlan } from '../ductSupports';
import type { DuctSystemSizingReport } from '../ductSystemSizing';
import { filterPanelsServed, terminalDropLookup } from '../ductTerminals';
import { readDuctRunSpec } from '../ductTypes';
import { clashMessage, findDuctClashes } from '../ductVolumes';

import { withReplaced, type ServiceDesign } from './designTree';
import { realiseDesign, type RealiseFailure } from './realiseDesign';
import { frontierPoints, sizeDesign, type DesignFrontier, type DpGrid, type SizedDesign, type SizingFailure } from './sizingDp';
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
  /** Filter panels in the filter return grilles the runs serve. */
  filterPanels: number;
}

/**
 * Plans, clash checks and the pressure of every terminal path, for runs built
 * for one service. The plans find each run's wall penetrations: through an
 * interior wall of a system spanning rooms they are the planner's to judge
 * (sleeve, fire damper, a straight through the wall); any other crossing is a
 * run through a wall it may not pass (one DU_AUTO_WALL per leg).
 */
export function verifyRuns(ctx: ServiceCtx, runs: readonly HvacElement[], notes: readonly AutoDuctIssue[] = [], terminalUpdates: readonly HvacElement[] = []): VerifiedRuns {
  // Terminals whose spigot the design turns are checked as they will be.
  const scene = [...withReplaced(ctx.baseScene, terminalUpdates), ...runs];
  const building = { walls: ctx.walls ?? [], rooms: ctx.rooms ?? [] };
  const plans = runs.map((run) => planDuctRunSpec(run.id, readDuctRunSpec(run)!, { settings: ctx.settings, scene, building }));
  const issues: AutoDuctIssue[] = [...notes];
  let errors = notes.filter((issue) => issue.severity === 'error').length;
  let warnings = notes.filter((issue) => issue.severity === 'warning').length;
  const disallowed = (plan: DuctFabricationPlan) => new Set(plan.penetrations
    .filter((penetration) => !(ctx.crossing && crossingAllowed(penetration))).map((penetration) => penetration.key));
  for (const plan of plans) {
    const refused = disallowed(plan);
    for (const issue of plan.issues) {
      // A crossing it may not make is reported once, below, not again for its sleeve.
      if (issue.penetrationKey && refused.has(issue.penetrationKey)) continue;
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
      code: 'DU_CLASH', severity: 'error', message: clashMessage(clash),
      service: ctx.service, point: { x: clash.point.x, y: clash.point.y }, runId: newIds.has(clash.ductId) ? clash.ductId : clash.otherId,
    });
  }
  // A run through a wall it may not pass (the walls are obstacles to the router, not to the layout seeds).
  for (const plan of plans) {
    const refused = disallowed(plan);
    const legs = new Set<number>();
    for (const penetration of plan.penetrations) {
      if (!refused.has(penetration.key) || legs.has(penetration.legIndex)) continue;
      legs.add(penetration.legIndex);
      errors += 1;
      issues.push({
        code: 'DU_AUTO_WALL', severity: 'error', service: ctx.service, point: { x: penetration.point.x, y: penetration.point.y }, runId: plan.elementId,
        message: !ctx.crossing ? 'The duct passes through a wall.'
          : penetration.exterior ? 'The duct passes through an exterior wall.' : 'The duct passes through a wall that does not divide two rooms.',
      });
    }
  }
  const pressure = systemPressure(plans, new Map(ctx.terminals.map((terminal) => [terminal.element.id, terminal.airflowM3h])), ctx.settings, ctx.service,
    terminalDropLookup(scene, ctx.settings));
  let hangers = 0;
  let straps = 0;
  for (const plan of plans) {
    for (const hanger of getDuctSupportPlan(plan, scene, ctx.settings).hangers) {
      if (hanger.kind === 'strap') straps += 1;
      else hangers += 1;
    }
  }
  return { plans, issues, errors, warnings, pressure, hangers, straps, filterPanels: filterPanelsServed(plans, scene) };
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
  /** Sized again by constant friction: the sections and what set them. */
  sizingReport?: DuctSystemSizingReport;
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
function buildOrder<T extends { design: ServiceDesign; best: number }>(sized: readonly T[]): T[] {
  const sorted = [...sized].sort((a, b) => a.best - b.best);
  const leaders = ['steiner', 'seed'].flatMap((source) => sorted.filter((entry) => entry.design.source === source).slice(0, 1));
  return [...leaders.sort((a, b) => a.best - b.best), ...sorted.filter((entry) => !leaders.includes(entry))];
}

/** One tree sized: what ranks it, the points worth building from it and its sizes at each. */
export interface SizedTree {
  /** Least life-cycle cost within the budget: the trees are built in this order. */
  best: number;
  /** The frontier's picks (frontierPicks) … */
  picks: number[];
  /** … and the tree's sizes at each (null: none reconstructs). */
  points: Array<Omit<SizedDesign, 'design'> | null>;
}

/**
 * Sizes one tree for optimiseService: a pure function of the tree, the sizing
 * model and the budget, so a worker sizes it exactly as here.
 */
export function sizeTree(design: ServiceDesign, model: SizingModel, grid: DpGrid, budgetPa: number, onFailure: (failure: SizingFailure) => void): SizedTree | null {
  const frontier = sizeDesign(design, model, grid, onFailure);
  if (!frontier) return null;
  let best = Number.POSITIVE_INFINITY;
  frontier.cost.forEach((cost, index) => {
    if (index * grid.stepPa <= budgetPa + 1e-9) best = Math.min(best, cost + model.pricePerPa * index * grid.stepPa);
  });
  const picks = frontierPicks(frontier, model.pricePerPa, budgetPa);
  return {
    best, picks, points: picks.map((index) => {
      const point = frontier.reconstruct(index);
      return point ? { sizing: point.sizing, modelCost: point.modelCost, modelPressurePa: point.modelPressurePa } : null;
    }),
  };
}

/**
 * The work optimiseService hands off: size these trees. The model and grid it
 * made are here for sizing on the spot; a worker makes its own from the rest.
 */
export interface SizeTreesRequest {
  ctx: ServiceCtx;
  designs: readonly ServiceDesign[];
  shape: ShapeMode;
  unitAirflowM3h: number;
  budgetPa: number;
  model: SizingModel;
  grid: DpGrid;
}

/** A tree's sizing (null: it cannot be sized) and why it failed, in the order found. */
export interface SizedTreeAnswer { tree: SizedTree | null; failures: SizingFailure[] }

/** Sizes the trees here, one after another. */
export function sizeTreesHere(request: SizeTreesRequest): SizedTreeAnswer[] {
  return request.designs.map((design) => {
    const failures: SizingFailure[] = [];
    const tree = sizeTree(design, request.model, request.grid, request.budgetPa, (failure) => failures.push(failure));
    return { tree, failures };
  });
}

/**
 * optimiseService as steps: the trees' sizing (most of its time) is handed
 * off, then the sized trees are built and verified here, in order of promise.
 * The answers come back in the trees' order, so the sizing failures, the
 * ranking and the build order are exactly those of sizing them one by one.
 */
export function* optimiseServiceSteps(
  ctx: ServiceCtx,
  designs: readonly ServiceDesign[],
  shape: ShapeMode,
  unitAirflowM3h: number,
  budgetPa: number,
): Generator<SizeTreesRequest, ServiceOptimisation, SizedTreeAnswer[]> {
  const model = new SizingModel(ctx, shape, unitAirflowM3h);
  const grid = frontierGrid(budgetPa);
  const answers: SizedTreeAnswer[] = yield { ctx, designs, shape, unitAirflowM3h, budgetPa, model, grid };
  const sized: Array<{ design: ServiceDesign; tree: SizedTree; best: number }> = [];
  const failures: TreeFailure[] = [];
  designs.forEach((design, index) => {
    const answer = answers[index]!;
    for (const failure of answer.failures) failures.push({ design, stage: 'sizing', failure });
    if (answer.tree) sized.push({ design, tree: answer.tree, best: answer.tree.best });
  });
  const options: ServiceOption[] = [];
  let realised = 0;
  let clean = 0;
  let tried = 0;
  for (const { design, tree } of buildOrder(sized)) {
    if (clean >= CLEAN_WANTED || tried >= TREES_TRIED) break;
    tried += 1;
    // The life-cycle pick first. When it fails, the tree's other sizes mostly fail the same way: only the
    // cheapest (its smaller sections take less room) is still tried.
    const picks = tree.picks;
    // The cheapest pick is the one at the highest pressure (least first cost).
    const cheapest = Math.max(...picks);
    let leadFailed = false;
    for (const [order, index] of picks.entries()) {
      if (leadFailed && index !== cheapest) continue;
      const sizes = tree.points[order];
      if (!sizes) continue;
      const point: SizedDesign = { design, ...sizes };
      const built = realiseDesign(ctx, model, point, (failure) => failures.push({ design, stage: 'realise', failure }));
      realised += 1;
      if (!built) { if (order === 0) leadFailed = true; continue; }
      const verified = verifyRuns(ctx, built.runs, [...design.notes, ...built.notes], built.terminalUpdates);
      const cost = priceDuctPlans(verified.plans, ctx.settings, verified.hangers, verified.straps, verified.filterPanels);
      cost.total += design.penalty;
      options.push({
        key: `${design.label}#${index}`,
        label: design.label,
        source: design.source,
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
        exact: design.exact ?? false,
        design,
        runKeys: built.runKeys,
        terminalUpdates: built.terminalUpdates,
      });
      if (verified.errors === 0) clean += 1;
      else if (order === 0) leadFailed = true;
    }
  }
  return { options, frontiers: sized.length, realised, pricePerPa: model.pricePerPa, failures };
}

export function optimiseService(
  ctx: ServiceCtx,
  designs: readonly ServiceDesign[],
  shape: ShapeMode,
  unitAirflowM3h: number,
  budgetPa: number,
): ServiceOptimisation {
  return runSteps(optimiseServiceSteps(ctx, designs, shape, unitAirflowM3h, budgetPa), sizeTreesHere);
}
