import type { Wall } from '../../../types';
import {
  buildAllWallSelectionComponentEntries,
  type WallSelectionComponentEntry,
} from './WallSelectionGeometry';

export interface BuildWallSelectionGeometryWorkerRequest {
  type: 'build-wall-selection-geometry';
  requestId: number;
  signature: string;
  walls: Wall[];
}

export interface BuildWallSelectionGeometryWorkerResponse {
  type: 'build-wall-selection-geometry-result';
  requestId: number;
  signature: string;
  entries: WallSelectionComponentEntry[];
}

const workerScope = self as unknown as {
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<BuildWallSelectionGeometryWorkerRequest>) => void
  ) => void;
  postMessage: (message: BuildWallSelectionGeometryWorkerResponse) => void;
};

workerScope.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.type !== 'build-wall-selection-geometry') {
    return;
  }

  workerScope.postMessage({
    type: 'build-wall-selection-geometry-result',
    requestId: message.requestId,
    signature: message.signature,
    entries: buildAllWallSelectionComponentEntries(message.walls),
  });
});

export {};
