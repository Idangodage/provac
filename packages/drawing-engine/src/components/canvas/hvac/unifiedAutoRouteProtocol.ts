import type { HvacElement } from '../../../types';

import type { UnifiedAutoRouteOptions, UnifiedAutoRouteProgress, UnifiedAutoRouteResult } from './unifiedAutoRoute';

export interface UnifiedAutoRouteRequest {
  type: 'route';
  scene: HvacElement[];
  options: Omit<UnifiedAutoRouteOptions, 'onProgress'>;
  /** Everything in the run's own worker, one task after another (scripted checks compare the two; the answers are the same). */
  inlineTasks?: boolean;
  /** Scripted checks: this many pool workers, whatever the machine has. */
  poolSize?: number;
}

export type UnifiedAutoRouteResponse =
  | { type: 'progress'; progress: UnifiedAutoRouteProgress }
  | { type: 'result'; result: UnifiedAutoRouteResult }
  | { type: 'error'; message: string };
