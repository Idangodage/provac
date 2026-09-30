/**
 * The feasibility loop's learning step (lazy constraint generation). The tree
 * router solves a grid model that relaxes the real rules; the sizing DP, the
 * realiser and the fabrication planner are the exact checks. Every failure
 * they report is traced back — through the provenance the router records on
 * each run — to the one routing decision that caused it, and that decision is
 * forbidden for the next round:
 *  - a split that cannot be sized or built → no split there for that set;
 *  - a take-off whose window, runout or branch start does not fit → no
 *    take-off (or all-flex stub) there for that branch's set;
 *  - a runout that cannot be made from where the run ends → that leaf;
 *  - a collar straight that cannot hold its fittings → that root;
 *  - an error the planner finds on a run (a clash, a leg too short, a tight
 *    runout) → the decision nearest to where it is: the run's own fitting,
 *    one of its take-offs, or its runout.
 * Each cut removes only choices proven unbuildable, so the router's optimum
 * over what remains is still exact on its model; the loop stops at the first
 * clean verified tree or when nothing new is learnt.
 */
import type { Point2D } from '../../../../../types';
import { toLocal, type ServiceCtx } from '../ductAutoContext';

import { allRuns, pointAlong, type RunDesign, type ServiceDesign } from './designTree';
import type { ServiceOption, TreeFailure } from './ductOptimizer';
import type { RouterCuts } from './steinerArborescence';

function addTo(map: Map<number, Set<number>>, set: number, value: number): boolean {
  const values = map.get(set) ?? new Set<number>();
  if (values.has(value)) return false;
  values.add(value);
  map.set(set, values);
  return true;
}

/** Forbids the fitting the run starts from (its take-off, stub or split outlet, or the root). */
function cutCreator(cuts: RouterCuts, run: RunDesign): boolean {
  const route = run.route;
  if (!route) return false;
  if (route.kind === 'root') {
    if (cuts.roots.has(route.node)) return false;
    cuts.roots.add(route.node);
    return true;
  }
  if (route.kind === 'tee') return addTo(cuts.tees, route.set, route.node);
  if (route.kind === 'stub') return addTo(cuts.stubs, route.set, route.node);
  return addTo(cuts.splits, route.parentSet, route.node);
}

/** Forbids take-off `tap` of the run (the branch it starts). */
function cutTap(cuts: RouterCuts, run: RunDesign, tap: number | undefined): boolean {
  const child = tap !== undefined ? run.taps[tap]?.child : undefined;
  if (child) return cutCreator(cuts, child);
  // Unknown which: every take-off of the run (rare; the reports name the take-off).
  return run.taps.map((entry) => cutCreator(cuts, entry.child)).some(Boolean);
}

/** Forbids where the run meets its terminal's runout (an all-flex stub: the stub itself). */
function cutLeaf(cuts: RouterCuts, run: RunDesign): boolean {
  const route = run.route;
  if (!route) return false;
  if (route.leaf) return addTo(cuts.leaves, route.leaf.set, route.leaf.node * 4 + route.leaf.heading);
  return cutCreator(cuts, run);
}

/** Learns from failures of sizing and building. Returns how many new cuts. */
export function cutsFromFailures(failures: readonly TreeFailure[], cuts: RouterCuts): number {
  let added = 0;
  for (const { design, failure } of failures) {
    if (design.source !== 'steiner') continue;
    const run = allRuns(design.root).find((entry) => entry.key === failure.runKey);
    if (!run?.route) continue;
    let changed = false;
    switch (failure.reason) {
      case 'end-split':
        changed = run.route.splitNode !== undefined && addTo(cuts.splits, run.route.set, run.route.splitNode);
        break;
      case 'take-off':
      case 'section-change':
      case 'take-off-windows':
      case 'runout':
      case 'origin':
        changed = cutTap(cuts, run, failure.tap);
        break;
      case 'end-terminal':
      case 'neck-transition':
        changed = cutLeaf(cuts, run);
        break;
      default:
        changed = cutCreator(cuts, run);
    }
    if (changed) added += 1;
  }
  return added;
}

/**
 * Learns from the planner's errors on built router trees: each error on a run
 * cuts the decision nearest to it (the run's start, one of its take-offs, or
 * its end). Returns how many new cuts.
 */
export function cutsFromErrors(options: readonly ServiceOption[], cuts: RouterCuts, ctx: ServiceCtx): number {
  let added = 0;
  for (const option of options) {
    if (option.source !== 'steiner' || !option.errors || !option.design || !option.runKeys) continue;
    const runs = new Map(allRuns(option.design.root).map((run) => [run.key, run]));
    for (const issue of option.issues) {
      if (issue.severity !== 'error' || !issue.runId) continue;
      const run = runs.get(option.runKeys.get(issue.runId) ?? '');
      if (!run?.route) continue;
      if (nearestDecision(run, issue.point ? toLocal(ctx.frame, issue.point) : null, cuts)) added += 1;
    }
  }
  return added;
}

function nearestDecision(run: RunDesign, at: Point2D | null, cuts: RouterCuts): boolean {
  const start = run.vertices[0]!;
  const end = run.vertices[run.vertices.length - 1]!;
  if (!at) return cutCreator(cuts, run);
  const candidates: Array<{ distance: number; cut: () => boolean }> = [
    { distance: Math.hypot(at.x - start.x, at.y - start.y), cut: () => cutCreator(cuts, run) },
    ...run.taps.map((tap, index) => {
      const point = pointAlong(run, tap.station).point;
      return { distance: Math.hypot(at.x - point.x, at.y - point.y), cut: () => cutTap(cuts, run, index) };
    }),
    ...(run.route?.leaf ? [{ distance: Math.hypot(at.x - end.x, at.y - end.y), cut: () => cutLeaf(cuts, run) }] : []),
  ].sort((a, b) => a.distance - b.distance);
  // The nearest decision not cut yet; otherwise the next one out.
  for (const candidate of candidates) if (candidate.cut()) return true;
  return false;
}

export type { RouterCuts };
export type { ServiceDesign };
