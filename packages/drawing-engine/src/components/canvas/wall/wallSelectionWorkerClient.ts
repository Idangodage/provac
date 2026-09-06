import { LatestOnlyAsyncQueue } from '../../../store/latestOnlyAsyncQueue';
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

type WallSelectionJob = { signature: string; walls: Wall[] };
type WallSelectionResult = {
  signature: string;
  entries: ReturnType<typeof buildAllWallSelectionComponentEntries>;
};

let activeWorkerRequest: {
  requestId: number;
  resolve: (result: WallSelectionResult) => void;
  reject: (error: unknown) => void;
} | null = null;

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
      if (activeWorkerRequest?.requestId !== message.requestId) return;
      const pending = activeWorkerRequest;
      activeWorkerRequest = null;
      pending.resolve({ signature: message.signature, entries: message.entries });
    });

    const disableWorker = (error: unknown): void => {
      workerDisabled = true;
      disposeWorker();
      const pending = activeWorkerRequest;
      activeWorkerRequest = null;
      pending?.reject(error);
    };
    worker.addEventListener('error', (event) => {
      disableWorker(event.error ?? new Error('Wall-selection worker failed.'));
    });
    worker.addEventListener('messageerror', () => {
      disableWorker(new Error('Wall-selection worker returned an unreadable message.'));
    });

    workerInstance = worker;
    return workerInstance;
  } catch {
    workerDisabled = true;
    disposeWorker();
    return null;
  }
}

function runWallSelectionJob(job: WallSelectionJob): Promise<WallSelectionResult> {
  const worker = getWallSelectionWorker();
  if (!worker) {
    return new Promise((resolve, reject) => {
      const schedule = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
      schedule(() => {
        try {
          resolve({
            signature: job.signature,
            entries: buildAllWallSelectionComponentEntries(job.walls),
          });
        } catch (error) {
          reject(error);
        }
      }, 0);
    });
  }

  const requestId = ++requestIdCounter;
  const request: BuildWallSelectionGeometryWorkerRequest = {
    type: 'build-wall-selection-geometry',
    requestId,
    signature: job.signature,
    walls: job.walls,
  };
  return new Promise((resolve, reject) => {
    activeWorkerRequest = { requestId, resolve, reject };
    try {
      worker.postMessage(request);
    } catch (error) {
      workerDisabled = true;
      disposeWorker();
      activeWorkerRequest = null;
      reject(error);
    }
  });
}

const wallSelectionQueue = new LatestOnlyAsyncQueue<WallSelectionJob, WallSelectionResult>(
  runWallSelectionJob
);

export function primeWallSelectionGeometryInBackground(walls: Wall[]): void {
  if (walls.length === 0) return;
  const signature = getWallSelectionGeometrySignature(walls);
  if (getCachedWallSelectionComponentsForSignature(signature)) return;

  void wallSelectionQueue.enqueue({ signature, walls }).then((result) => {
    cacheWallSelectionComponentEntriesForSignature(result.signature, result.entries);
  }).catch(() => {
    // Selection geometry is an optimisation; synchronous callers retain a safe path.
  });
}
