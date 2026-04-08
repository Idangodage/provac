import type { Dimension2D, DimensionSettings, Room, Wall } from '../types';

import { buildMergedAutoManagedDimensions } from './autoManagedDimensions';
import type {
  AutoDimensionWorkerRequest,
  AutoDimensionWorkerResponse,
} from './autoDimension.worker';

let workerInstance: Worker | null = null;
let workerDisabled = false;
let requestIdCounter = 0;

const pendingRequests = new Map<
  number,
  {
    resolve: (dimensions: Dimension2D[]) => void;
    reject: (error: unknown) => void;
  }
>();

function resolvePendingRequest(requestId: number, dimensions: Dimension2D[]): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  pending.resolve(dimensions);
}

function rejectPendingRequests(error: unknown): void {
  pendingRequests.forEach((pending) => pending.reject(error));
  pendingRequests.clear();
}

function disposeWorker(): void {
  if (!workerInstance) return;
  workerInstance.terminate();
  workerInstance = null;
}

function getAutoDimensionWorker(): Worker | null {
  if (workerDisabled || typeof window === 'undefined' || typeof Worker === 'undefined') {
    return null;
  }
  if (workerInstance) {
    return workerInstance;
  }

  try {
    const worker = new Worker(
      new URL('./autoDimension.worker.ts', import.meta.url),
      { type: 'module' }
    );

    worker.addEventListener('message', (event: MessageEvent<AutoDimensionWorkerResponse>) => {
      const message = event.data;
      if (!message || message.type !== 'sync-auto-dimensions-result') {
        return;
      }
      resolvePendingRequest(message.requestId, message.dimensions);
    });

    worker.addEventListener('error', (event) => {
      workerDisabled = true;
      disposeWorker();
      rejectPendingRequests(event.error ?? new Error('Auto-dimension worker failed.'));
    });

    workerInstance = worker;
    return workerInstance;
  } catch {
    workerDisabled = true;
    disposeWorker();
    return null;
  }
}

export async function syncAutoDimensionsInBackground(params: {
  signature: string;
  walls: Wall[];
  rooms: Room[];
  dimensionSettings: DimensionSettings;
  dimensions: Dimension2D[];
}): Promise<Dimension2D[]> {
  const worker = getAutoDimensionWorker();
  if (!worker) {
    return new Promise<Dimension2D[]>((resolve) => {
      const schedule = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
      schedule(() => {
        resolve(buildMergedAutoManagedDimensions(params));
      }, 0);
    });
  }

  const requestId = ++requestIdCounter;
  const request: AutoDimensionWorkerRequest = {
    type: 'sync-auto-dimensions',
    requestId,
    signature: params.signature,
    walls: params.walls,
    rooms: params.rooms,
    dimensionSettings: params.dimensionSettings,
    dimensions: params.dimensions,
  };

  return new Promise<Dimension2D[]>((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    worker.postMessage(request);
  });
}
