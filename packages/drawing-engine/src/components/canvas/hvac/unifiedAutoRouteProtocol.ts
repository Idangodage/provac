import type { HvacElement } from '../../../types';

import type { AutoRouteStepMemo, UnifiedAutoRouteOptions, UnifiedAutoRouteProgress, UnifiedAutoRouteResult } from './unifiedAutoRoute';

export interface UnifiedAutoRouteRequest {
  type: 'route';
  scene: HvacElement[];
  options: Omit<UnifiedAutoRouteOptions, 'onProgress' | 'onPartial' | 'onMemo'>;
  /** Everything in the run's own worker, one task after another (scripted checks compare the two; the answers are the same). */
  inlineTasks?: boolean;
  /** Scripted checks: this many pool workers, whatever the machine has. */
  poolSize?: number;
}

export type UnifiedAutoRouteResponse =
  | { type: 'progress'; progress: UnifiedAutoRouteProgress }
  /** The proposal so far, as each service finishes. */
  | { type: 'partial'; result: UnifiedAutoRouteResult }
  | { type: 'result'; result: UnifiedAutoRouteResult; memo?: AutoRouteStepMemo }
  | { type: 'error'; message: string };
