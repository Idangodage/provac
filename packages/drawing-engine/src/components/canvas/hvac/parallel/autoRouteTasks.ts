/**
 * The tasks Auto route hands to its workers (taskRunner.ts): the refrigerant
 * network's starts. Each task is a pure function of its input: whatever a
 * worker starts without (a routing session) it sets up from the input, as the
 * caller had it. (Duct sizing used to go to the workers too; once its frontiers
 * were kept as steps it cost less than starting them.)
 */
import { growNetwork, type GrowNetworkTask, type GrownNetwork } from '../autoRouteNetwork';
import { inFreshRoutingSession } from '../routingSession';

export interface AutoRouteTaskMap {
  'grow-network': { input: GrowNetworkTask; output: GrownNetwork };
}
export type AutoRouteTaskKind = keyof AutoRouteTaskMap;
export type AutoRouteTaskInput<K extends AutoRouteTaskKind> = AutoRouteTaskMap[K]['input'];
export type AutoRouteTaskOutput<K extends AutoRouteTaskKind> = AutoRouteTaskMap[K]['output'];

/** Runs one task (in a worker, or here through the same boundary), in a routing session of its own. */
export async function runAutoRouteTask<K extends AutoRouteTaskKind>(kind: K, input: AutoRouteTaskInput<K>): Promise<AutoRouteTaskOutput<K>> {
  return inFreshRoutingSession(async () => {
    switch (kind) {
      case 'grow-network': return growNetwork(input as GrowNetworkTask) as AutoRouteTaskOutput<K>;
      default: throw new Error(`Unknown Auto route task: ${String(kind)}`);
    }
  });
}
