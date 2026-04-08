import type { Wall } from '../../../types';
import { buildUnifiedWallBands, type IsometricWallBand } from './wallBands';
import type {
  BuildIsometricWallBandsWorkerRequest,
  BuildIsometricWallBandsWorkerResponse,
} from './isometricWallBands.worker';

let workerInstance: Worker | null = null;
let workerDisabled = false;
let requestIdCounter = 0;
const resolvedCache = new Map<string, IsometricWallBand[]>();

const pendingRequests = new Map<
  number,
  {
    signature: string;
    resolve: (wallBands: IsometricWallBand[]) => void;
    reject: (error: unknown) => void;
  }
>();

function setCachedWallBands(signature: string, wallBands: IsometricWallBand[]): void {
  resolvedCache.set(signature, wallBands);
  if (resolvedCache.size <= 12) {
    return;
  }

  const oldestKey = resolvedCache.keys().next().value;
  if (typeof oldestKey === 'string') {
    resolvedCache.delete(oldestKey);
  }
}

function resolvePendingRequest(requestId: number, wallBands: IsometricWallBand[]): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) {
    return;
  }

  pendingRequests.delete(requestId);
  setCachedWallBands(pending.signature, wallBands);
  pending.resolve(wallBands);
}

function rejectPendingRequests(error: unknown): void {
  pendingRequests.forEach((pending) => pending.reject(error));
  pendingRequests.clear();
}

function disposeWorker(): void {
  if (!workerInstance) {
    return;
  }

  workerInstance.terminate();
  workerInstance = null;
}

function getWallBandsWorker(): Worker | null {
  if (workerDisabled || typeof window === 'undefined' || typeof Worker === 'undefined') {
    return null;
  }

  if (workerInstance) {
    return workerInstance;
  }

  try {
    const worker = new Worker(
      new URL('./isometricWallBands.worker.ts', import.meta.url),
      { type: 'module' }
    );

    worker.addEventListener('message', (event: MessageEvent<BuildIsometricWallBandsWorkerResponse>) => {
      const message = event.data;
      if (!message || message.type !== 'build-isometric-wall-bands-result') {
        return;
      }
      resolvePendingRequest(message.requestId, message.wallBands);
    });

    worker.addEventListener('error', (event) => {
      workerDisabled = true;
      disposeWorker();
      rejectPendingRequests(event.error ?? new Error('Isometric wall band worker failed.'));
    });

    workerInstance = worker;
    return workerInstance;
  } catch {
    workerDisabled = true;
    disposeWorker();
    return null;
  }
}

export async function buildIsometricWallBandsInBackground(params: {
  signature: string;
  walls: Wall[];
}): Promise<IsometricWallBand[]> {
  const cached = resolvedCache.get(params.signature);
  if (cached) {
    return cached;
  }

  const worker = getWallBandsWorker();
  if (!worker) {
    return new Promise<IsometricWallBand[]>((resolve) => {
      const schedule = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
      schedule(() => {
        const wallBands = buildUnifiedWallBands(params.walls);
        setCachedWallBands(params.signature, wallBands);
        resolve(wallBands);
      }, 0);
    });
  }

  const requestId = ++requestIdCounter;
  const request: BuildIsometricWallBandsWorkerRequest = {
    type: 'build-isometric-wall-bands',
    requestId,
    signature: params.signature,
    walls: params.walls,
  };

  return new Promise<IsometricWallBand[]>((resolve, reject) => {
    pendingRequests.set(requestId, {
      signature: params.signature,
      resolve,
      reject,
    });
    worker.postMessage(request);
  });
}
