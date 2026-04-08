import type { Wall } from '../../../types';
import { buildUnifiedWallBands, type IsometricWallBand } from './wallBands';

export interface BuildIsometricWallBandsWorkerRequest {
  type: 'build-isometric-wall-bands';
  requestId: number;
  signature: string;
  walls: Wall[];
}

export interface BuildIsometricWallBandsWorkerResponse {
  type: 'build-isometric-wall-bands-result';
  requestId: number;
  signature: string;
  wallBands: IsometricWallBand[];
}

const workerScope = self as unknown as {
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<BuildIsometricWallBandsWorkerRequest>) => void
  ) => void;
  postMessage: (message: BuildIsometricWallBandsWorkerResponse) => void;
};

workerScope.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.type !== 'build-isometric-wall-bands') {
    return;
  }

  workerScope.postMessage({
    type: 'build-isometric-wall-bands-result',
    requestId: message.requestId,
    signature: message.signature,
    wallBands: buildUnifiedWallBands(message.walls),
  });
});

export {};
