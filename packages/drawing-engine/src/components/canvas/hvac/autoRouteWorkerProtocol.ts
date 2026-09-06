import type { HvacElement } from '../../../types';

import type {
  AutoRouteNetworkOptions,
  AutoRouteNetworkProgress,
  planAutoRouteNetwork,
} from './autoRouteNetwork';

export type AutoRouteNetworkResult = Awaited<ReturnType<typeof planAutoRouteNetwork>>;

export interface AutoRouteWorkerRequest {
  type: 'route';
  scene: HvacElement[];
  options: Omit<AutoRouteNetworkOptions, 'onProgress'>;
}

export type AutoRouteWorkerResponse =
  | { type: 'progress'; progress: AutoRouteNetworkProgress }
  | { type: 'result'; result: AutoRouteNetworkResult }
  | { type: 'error'; message: string };
