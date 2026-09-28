/**
 * One service's optimisation: every candidate tree (the router's and the v1
 * layouts') is sized exactly (sizingDp.ts) into its frontier of first cost
 * against fan pressure; the most promising points are built into runs,
 * planned, clash-checked and re-priced from their plans. Only verified
 * numbers leave this module.
 */
import type { HvacElement } from '../../../../../types';
import { listNetworkPipeLanes } from '../../networkPipeClearance';
import type { AutoDuctIssue, ServiceCtx } from '../ductAutoContext';
import { priceDuctPlans, type DuctCostBreakdown } from '../ductEconomics';
import { planDuctRunSpec, type DuctFabricationPlan } from '../ductFabricationPlanner';
import { systemPressure, type ServicePressure } from '../ductPressure';
import { getDuctSupportPlan } from '../ductSupports';
import { readDuctRunSpec } from '../ductTypes';
import { findDuctClashes } from '../ductVolumes';

import type { ServiceDesign } from './designTree';
import { realiseDesign } from './realiseDesign';
import { frontierPoints, sizeDesign, type DesignFrontier, type DpGrid } from './sizingDp';
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
export function verifyRuns(ctx: ServiceCtx, runs: readonly HvacElement[], notes: readonly AutoDuctIssue[] = []): VerifiedRuns {
  const scene = [...ctx.baseScene, ...runs];
  const plans = runs.map((run) => planDuctRunSpec(run.id, readDuctRunSpec(run)!, { settings: ctx.settings, scene }));
  const issues: AutoDuctIssue[] = [...notes];
  let errors = 0;
  let warnings = 0;
  for (const plan of plans) {
    for (const issue of plan.issues) {
      if (issue.severity === 'error') errors += 1;
      else if (issue.severity === 'warning') warnings += 1;
      else continue;
      issues.push({ code: issue.code, severity: issue.severity, message: issue.message, service: ctx.service, ...(issue.point ? { point: { x: issue.point.x, y: issue.point.y } } : {}) });
    }
  }
  const newIds = new Set(runs.map((run) => run.id));
  for (const clash of findDuctClashes(scene, ctx.settings, listNetworkPipeLanes(scene))) {
    if (!newIds.has(clash.ductId) && !newIds.has(clash.otherId)) continue;
    errors += 1;
    issues.push({ code: 'DU_CLASH', severity: 'error', message: `${clash.mark} clashes with ${clash.kind === 'pipe' ? `a ${clash.service ?? 'pipe'}` : clash.kind === 'terminal' ? 'an air terminal' : 'another duct'}.`, service: ctx.service, point: { x: clash.point.x, y: clash.point.y } });
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
}

export interface ServiceOptimisation {
  options: ServiceOption[];
  frontiers: number;
  realised: number;
  pricePerPa: number;
}

/** Grid of the frontiers: 0.1 Pa up to 1.5 × the fan's maximum (at least 80 Pa). */
export function frontierGrid(maxEspPa: number | null): DpGrid {
  const stepPa = 0.1;
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

/** How many of the most promising trees are built and verified. */
const TREES_REALISED = 4;

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
  for (const design of designs) {
    const frontier = sizeDesign(design, model, grid);
    if (!frontier) continue;
    let best = Number.POSITIVE_INFINITY;
    frontier.cost.forEach((cost, index) => {
      if (index * grid.stepPa <= budgetPa + 1e-9) best = Math.min(best, cost + model.pricePerPa * index * grid.stepPa);
    });
    sized.push({ frontier, best });
  }
  sized.sort((a, b) => a.best - b.best);
  const options: ServiceOption[] = [];
  let realised = 0;
  for (const { frontier } of sized.slice(0, TREES_REALISED)) {
    for (const index of frontierPicks(frontier, model.pricePerPa, budgetPa)) {
      const point = frontier.reconstruct(index);
      if (!point) continue;
      const built = realiseDesign(ctx, model, point);
      realised += 1;
      if (!built) continue;
      const verified = verifyRuns(ctx, built.runs, [...frontier.design.notes, ...built.notes]);
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
      });
    }
  }
  return { options, frontiers: sized.length, realised, pricePerPa: model.pricePerPa };
}
