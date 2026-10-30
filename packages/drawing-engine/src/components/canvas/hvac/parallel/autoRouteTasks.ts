/**
 * The tasks Auto route hands to its workers (taskRunner.ts), and how a step's
 * request is split into them. Each task is a pure function of its input:
 * whatever a worker starts without (the duct building, a routing session) it
 * sets up from the input, as the caller had it.
 */
import { growNetwork, type GrowNetworkTask, type GrownNetwork } from '../autoRouteNetwork';
import type { ServiceCtx } from '../duct/ductAutoContext';
import { withActiveDuctBuilding } from '../duct/ductBuilding';
import type { ServiceDesign } from '../duct/optimizer/designTree';
import { frontierGrid, sizeTree, type SizedTreeAnswer, type SizeTreesRequest } from '../duct/optimizer/ductOptimizer';
import type { SizingFailure } from '../duct/optimizer/sizingDp';
import { SizingModel, type ShapeMode } from '../duct/optimizer/sizingModel';
import { inFreshRoutingSession } from '../routingSession';

import type { TaskRunner } from './taskRunner';

/**
 * A duct service's context as a worker gets it: without its id maker and its
 * wall-crossing rule (functions cannot be sent) and its scene (sizing never
 * reads it; whatever reads a field left out fails, it does not answer otherwise).
 */
export type PortableServiceCtx = Omit<ServiceCtx, 'ids' | 'crossing' | 'baseScene'>;

/** Size a run of trees with the model the context, shape and airflow make. */
export interface SizeTreesTask {
  ctx: PortableServiceCtx;
  designs: ServiceDesign[];
  shape: ShapeMode;
  unitAirflowM3h: number;
  budgetPa: number;
}

export interface AutoRouteTaskMap {
  'size-trees': { input: SizeTreesTask; output: SizedTreeAnswer[] };
  'grow-network': { input: GrowNetworkTask; output: GrownNetwork };
}
export type AutoRouteTaskKind = keyof AutoRouteTaskMap;
export type AutoRouteTaskInput<K extends AutoRouteTaskKind> = AutoRouteTaskMap[K]['input'];
export type AutoRouteTaskOutput<K extends AutoRouteTaskKind> = AutoRouteTaskMap[K]['output'];

const noIds = (): string => {
  throw new Error('Sizing does not make elements.');
};

function sizeTrees(task: SizeTreesTask): SizedTreeAnswer[] {
  const ctx: ServiceCtx = { ...task.ctx, baseScene: [], ids: noIds };
  const model = new SizingModel(ctx, task.shape, task.unitAirflowM3h);
  const grid = frontierGrid(task.budgetPa);
  // As the design's own stretches run: in its building.
  return withActiveDuctBuilding(ctx.walls ?? [], ctx.rooms ?? [], () => task.designs.map((design) => {
    const failures: SizingFailure[] = [];
    const tree = sizeTree(design, model, grid, task.budgetPa, (failure) => failures.push(failure));
    return { tree, failures };
  }));
}

/** Runs one task (in a worker, or here through the same boundary), in a routing session of its own. */
export async function runAutoRouteTask<K extends AutoRouteTaskKind>(kind: K, input: AutoRouteTaskInput<K>): Promise<AutoRouteTaskOutput<K>> {
  return inFreshRoutingSession(async () => {
    switch (kind) {
      case 'size-trees': return sizeTrees(input as SizeTreesTask) as AutoRouteTaskOutput<K>;
      case 'grow-network': return growNetwork(input as GrowNetworkTask) as AutoRouteTaskOutput<K>;
      default: throw new Error(`Unknown Auto route task: ${String(kind)}`);
    }
  });
}

/**
 * Sizes a step's trees on the runner, in runs of consecutive trees (about two
 * per worker, so a slow tree does not hold the rest; one run when there is
 * one worker); the answers are put back in the trees' order.
 */
export async function sizeTreesOn(runner: TaskRunner, request: SizeTreesRequest): Promise<SizedTreeAnswer[]> {
  const { ids: _ids, crossing: _crossing, baseScene: _scene, ...ctx } = request.ctx;
  const designs = [...request.designs];
  if (!designs.length) return [];
  const runs = runner.concurrency <= 1 ? 1 : Math.min(designs.length, runner.concurrency * 2);
  const size = Math.ceil(designs.length / runs);
  const tasks = [];
  for (let start = 0; start < designs.length; start += size) {
    tasks.push({ kind: 'size-trees' as const, input: { ctx, designs: designs.slice(start, start + size), shape: request.shape,
      unitAirflowM3h: request.unitAirflowM3h, budgetPa: request.budgetPa } });
  }
  return (await runner.all(tasks)).flat();
}
