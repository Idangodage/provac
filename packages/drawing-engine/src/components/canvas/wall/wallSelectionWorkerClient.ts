import type { Wall } from '../../../types';
import {
  buildAllWallSelectionComponentEntries,
  cacheWallSelectionComponentEntriesForSignature,
  getCachedWallSelectionComponentsForSignature,
  getWallSelectionGeometrySignature,
} from './WallSelectionGeometry';
import type {
  BuildWallSelectionGeometryWorkerRequest,
  BuildWallSelectionGeometryWorkerResponse,
} from './wallSelection.worker';

let workerInstance: Worker | null = null;
let workerDisabled = false;
let requestIdCounter = 0;
const pendingSignatures = new Set<string>();

function disposeWorker(): void {
  if (!workerInstance) {
    return;
  }

  workerInstance.terminate();
  workerInstance = null;
}

function getWallSelectionWorker(): Worker | null {
  if (workerDisabled || typeof window === 'undefined' || typeof Worker === 'undefined') {
    return null;
  }

  if (workerInstance) {
    return workerInstance;
  }

  try {
    const worker = new Worker(
      new URL('./wallSelection.worker.ts', import.meta.url),
      { type: 'module' }
    );

    worker.addEventListener('message', (event: MessageEvent<BuildWallSelectionGeometryWorkerResponse>) => {
      const message = event.data;
      if (!message || message.type !== 'build-wall-selection-geometry-result') {
        return;
      }

      pendingSignatures.delete(message.signature);
      cacheWallSelectionComponentEntriesForSignature(message.signature, message.entries);
    });

    worker.addEventListener('error', () => {
      workerDisabled = true;
      pendingSignatures.clear();
      disposeWorker();
    });

    workerInstance = worker;
    return workerInstance;
  } catch {
    workerDisabled = true;
    disposeWorker();
    return null;
  }
}

export function primeWallSelectionGeometryInBackground(walls: Wall[]): void {
  if (walls.length === 0) {
    return;
  }

  const signature = getWallSelectionGeometrySignature(walls);
  if (
    pendingSignatures.has(signature) ||
    getCachedWallSelectionComponentsForSignature(signature)
  ) {
    return;
  }

  pendingSignatures.add(signature);
  const worker = getWallSelectionWorker();
  if (!worker) {
    const schedule = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
    schedule(() => {
      pendingSignatures.delete(signature);
      cacheWallSelectionComponentEntriesForSignature(
        signature,
        buildAllWallSelectionComponentEntries(walls)
      );
    }, 0);
    return;
  }

  const request: BuildWallSelectionGeometryWorkerRequest = {
    type: 'build-wall-selection-geometry',
    requestId: ++requestIdCounter,
    signature,
    walls,
  };
  worker.postMessage(request);
}
