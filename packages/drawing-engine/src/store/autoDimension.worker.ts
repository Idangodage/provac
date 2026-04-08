import type { Dimension2D, DimensionSettings, Room, Wall } from '../types';

import { buildMergedAutoManagedDimensions } from './autoManagedDimensions';

export interface AutoDimensionWorkerRequest {
  type: 'sync-auto-dimensions';
  requestId: number;
  signature: string;
  walls: Wall[];
  rooms: Room[];
  dimensionSettings: DimensionSettings;
  dimensions: Dimension2D[];
}

export interface AutoDimensionWorkerResponse {
  type: 'sync-auto-dimensions-result';
  requestId: number;
  signature: string;
  dimensions: Dimension2D[];
}

const workerScope = self as unknown as {
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<AutoDimensionWorkerRequest>) => void
  ) => void;
  postMessage: (message: AutoDimensionWorkerResponse) => void;
};

workerScope.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.type !== 'sync-auto-dimensions') {
    return;
  }

  workerScope.postMessage({
    type: 'sync-auto-dimensions-result',
    requestId: message.requestId,
    signature: message.signature,
    dimensions: buildMergedAutoManagedDimensions({
      walls: message.walls,
      rooms: message.rooms,
      dimensionSettings: message.dimensionSettings,
      dimensions: message.dimensions,
    }),
  });
});

export {};
