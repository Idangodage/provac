import { planUnifiedAutoRoute } from './unifiedAutoRoute';
import type { UnifiedAutoRouteRequest, UnifiedAutoRouteResponse } from './unifiedAutoRouteProtocol';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<UnifiedAutoRouteRequest>) => void) | null;
  postMessage: (response: UnifiedAutoRouteResponse) => void;
};

scope.onmessage = async ({ data }) => {
  if (data?.type !== 'route') return;
  try {
    const result = await planUnifiedAutoRoute(data.scene, {
      ...data.options,
      onProgress: (progress) => scope.postMessage({ type: 'progress', progress }),
    });
    scope.postMessage({ type: 'result', result });
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Unable to calculate the network.' });
  }
};
