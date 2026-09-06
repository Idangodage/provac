import { planAutoRouteNetwork } from './autoRouteNetwork';
import type { AutoRouteWorkerRequest, AutoRouteWorkerResponse } from './autoRouteWorkerProtocol';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AutoRouteWorkerRequest>) => void) | null;
  postMessage: (response: AutoRouteWorkerResponse) => void;
};

scope.onmessage = async ({ data }) => {
  if (data?.type !== 'route') return;
  try {
    const result = await planAutoRouteNetwork(data.scene, {
      ...data.options,
      onProgress: progress => scope.postMessage({ type: 'progress', progress }),
    });
    scope.postMessage({ type: 'result', result });
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Unable to calculate this network.' });
  }
};
