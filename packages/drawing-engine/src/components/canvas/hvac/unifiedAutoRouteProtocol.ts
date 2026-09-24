import type { HvacElement } from '../../../types';

import type { UnifiedAutoRouteOptions, UnifiedAutoRouteProgress, UnifiedAutoRouteResult } from './unifiedAutoRoute';

export interface UnifiedAutoRouteRequest {
  type: 'route';
  scene: HvacElement[];
  options: Omit<UnifiedAutoRouteOptions, 'onProgress'>;
}

export type UnifiedAutoRouteResponse =
  | { type: 'progress'; progress: UnifiedAutoRouteProgress }
  | { type: 'result'; result: UnifiedAutoRouteResult }
  | { type: 'error'; message: string };
