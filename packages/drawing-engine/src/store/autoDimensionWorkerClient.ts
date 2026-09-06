import type { Dimension2D, DimensionSettings, Room, Wall } from '../types';

import type {
  AutoDimensionWorkerRequest,
  AutoDimensionWorkerResponse,
} from './autoDimension.worker';
import { buildMergedAutoManagedDimensions } from './autoManagedDimensions';
import { LatestOnlyAsyncQueue } from './latestOnlyAsyncQueue';

let workerInstance: Worker | null = null;
let workerDisabled = false;
let requestIdCounter = 0;

interface AutoDimensionParams {
  signature: string;
  walls: Wall[];
  rooms: Room[];
  dimensionSettings: DimensionSettings;
  dimensions: Dimension2D[];
}

interface ActiveWorkerRequest {
  requestId: number;
  resolve: (dimensions: Dimension2D[]) => void;
  reject: (error: unknown) => void;
}

let activeWorkerRequest: ActiveWorkerRequest | null = null;

function resolveActiveWorkerRequest(requestId: number, dimensions: Dimension2D[]): void {
  if (activeWorkerRequest?.requestId !== requestId) return;
  const pending = activeWorkerRequest;
  activeWorkerRequest = null;
  pending.resolve(dimensions);
}

function rejectActiveWorkerRequest(error: unknown): void {
  const pending = activeWorkerRequest;
  activeWorkerRequest = null;
  pending?.reject(error);
}

function disposeWorker(): void {
  if (!workerInstance) return;
  try {
    workerInstance.terminate();
  } finally {
    workerInstance = null;
  }
}

function disableWorker(error: unknown): void {
  workerDisabled = true;
  try {
    disposeWorker();
  } finally {
    rejectActiveWorkerRequest(error);
  }
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
      resolveActiveWorkerRequest(message.requestId, message.dimensions);
    });

    worker.addEventListener('error', (event) => {
      disableWorker(event.error ?? new Error('Auto-dimension worker failed.'));
    });

    worker.addEventListener('messageerror', () => {
      disableWorker(new Error('Auto-dimension worker returned an unreadable message.'));
    });

    workerInstance = worker;
    return workerInstance;
  } catch {
    workerDisabled = true;
    disposeWorker();
    return null;
  }
}

function runFallback(params: AutoDimensionParams): Promise<Dimension2D[]> {
  return new Promise<Dimension2D[]>((resolve, reject) => {
    const schedule = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
    schedule(() => {
      try {
        resolve(buildMergedAutoManagedDimensions(params));
      } catch (error) {
        reject(error);
      }
    }, 0);
  });
}

function executeAutoDimensionSync(params: AutoDimensionParams): Promise<Dimension2D[]> {
  const worker = getAutoDimensionWorker();
  if (!worker) {
    return runFallback(params);
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
    activeWorkerRequest = { requestId, resolve, reject };
    try {
      worker.postMessage(request);
    } catch (error) {
      disableWorker(error);
    }
  });
}

const autoDimensionQueue = new LatestOnlyAsyncQueue<AutoDimensionParams, Dimension2D[]>(
  executeAutoDimensionSync
);

export function syncAutoDimensionsInBackground(
  params: AutoDimensionParams
): Promise<Dimension2D[]> {
  return autoDimensionQueue.enqueue(params);
}
