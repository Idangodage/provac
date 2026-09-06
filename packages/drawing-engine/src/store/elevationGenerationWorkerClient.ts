import type { FurnitureProjectionInput } from '../components/canvas/elevation/elevationGenerator';
import { regenerateElevationViews } from '../components/canvas/elevation/elevationGenerator';
import type {
  ElevationSettings,
  ElevationView,
  HvacElement,
  SectionLine,
  Wall,
} from '../types';

import type {
  RegenerateElevationsWorkerRequest,
  RegenerateElevationsWorkerResponse,
} from './elevationGeneration.worker';
import { LatestOnlyAsyncQueue } from './latestOnlyAsyncQueue';

let workerInstance: Worker | null = null;
let workerDisabled = false;
let requestIdCounter = 0;

interface ElevationGenerationParams {
  signature: string;
  walls: Wall[];
  sectionLines: SectionLine[];
  existingViews: ElevationView[];
  elevationSettings: ElevationSettings;
  hvacElements: HvacElement[];
  furnitureInputs: FurnitureProjectionInput[];
}

interface ActiveWorkerRequest {
  requestId: number;
  resolve: (views: ElevationView[]) => void;
  reject: (error: unknown) => void;
}

let activeWorkerRequest: ActiveWorkerRequest | null = null;

function resolveActiveWorkerRequest(requestId: number, elevationViews: ElevationView[]): void {
  if (activeWorkerRequest?.requestId !== requestId) return;
  const pending = activeWorkerRequest;
  activeWorkerRequest = null;
  pending.resolve(elevationViews);
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

function getElevationGenerationWorker(): Worker | null {
  if (workerDisabled || typeof window === 'undefined' || typeof Worker === 'undefined') {
    return null;
  }
  if (workerInstance) {
    return workerInstance;
  }

  try {
    const worker = new Worker(
      new URL('./elevationGeneration.worker.ts', import.meta.url),
      { type: 'module' }
    );

    worker.addEventListener('message', (event: MessageEvent<RegenerateElevationsWorkerResponse>) => {
      const message = event.data;
      if (!message || message.type !== 'regenerate-elevations-result') {
        return;
      }
      resolveActiveWorkerRequest(message.requestId, message.elevationViews);
    });

    worker.addEventListener('error', (event) => {
      disableWorker(event.error ?? new Error('Elevation generation worker failed.'));
    });

    worker.addEventListener('messageerror', () => {
      disableWorker(new Error('Elevation generation worker returned an unreadable message.'));
    });

    workerInstance = worker;
    return workerInstance;
  } catch {
    workerDisabled = true;
    disposeWorker();
    return null;
  }
}

function runFallback(params: ElevationGenerationParams): Promise<ElevationView[]> {
  return new Promise<ElevationView[]>((resolve, reject) => {
    const schedule = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
    schedule(() => {
      try {
        resolve(regenerateElevationViews(
          params.walls,
          params.sectionLines,
          params.existingViews,
          params.elevationSettings,
          params.hvacElements,
          params.furnitureInputs
        ));
      } catch (error) {
        reject(error);
      }
    }, 0);
  });
}

function executeElevationGeneration(
  params: ElevationGenerationParams
): Promise<ElevationView[]> {
  const worker = getElevationGenerationWorker();
  if (!worker) {
    return runFallback(params);
  }

  const requestId = ++requestIdCounter;
  const request: RegenerateElevationsWorkerRequest = {
    type: 'regenerate-elevations',
    requestId,
    signature: params.signature,
    walls: params.walls,
    sectionLines: params.sectionLines,
    existingViews: params.existingViews,
    elevationSettings: params.elevationSettings,
    hvacElements: params.hvacElements,
    furnitureInputs: params.furnitureInputs,
  };

  return new Promise<ElevationView[]>((resolve, reject) => {
    activeWorkerRequest = { requestId, resolve, reject };
    try {
      worker.postMessage(request);
    } catch (error) {
      disableWorker(error);
    }
  });
}

const elevationGenerationQueue = new LatestOnlyAsyncQueue<
  ElevationGenerationParams,
  ElevationView[]
>(executeElevationGeneration);

export function regenerateElevationsInBackground(
  params: ElevationGenerationParams
): Promise<ElevationView[]> {
  return elevationGenerationQueue.enqueue(params);
}
