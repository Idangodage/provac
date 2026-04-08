import type {
  ElevationSettings,
  ElevationView,
  HvacElement,
  SectionLine,
  Wall,
} from '../types';
import type { FurnitureProjectionInput } from '../components/canvas/elevation/elevationGenerator';
import { regenerateElevationViews } from '../components/canvas/elevation/elevationGenerator';
import type {
  RegenerateElevationsWorkerRequest,
  RegenerateElevationsWorkerResponse,
} from './elevationGeneration.worker';

let workerInstance: Worker | null = null;
let workerDisabled = false;
let requestIdCounter = 0;

const pendingRequests = new Map<
  number,
  {
    resolve: (views: ElevationView[]) => void;
    reject: (error: unknown) => void;
  }
>();

function resolvePendingRequest(requestId: number, elevationViews: ElevationView[]): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  pending.resolve(elevationViews);
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
      resolvePendingRequest(message.requestId, message.elevationViews);
    });

    worker.addEventListener('error', (event) => {
      workerDisabled = true;
      disposeWorker();
      rejectPendingRequests(event.error ?? new Error('Elevation generation worker failed.'));
    });

    workerInstance = worker;
    return workerInstance;
  } catch {
    workerDisabled = true;
    disposeWorker();
    return null;
  }
}

export async function regenerateElevationsInBackground(params: {
  signature: string;
  walls: Wall[];
  sectionLines: SectionLine[];
  existingViews: ElevationView[];
  elevationSettings: ElevationSettings;
  hvacElements: HvacElement[];
  furnitureInputs: FurnitureProjectionInput[];
}): Promise<ElevationView[]> {
  const worker = getElevationGenerationWorker();
  if (!worker) {
    return new Promise<ElevationView[]>((resolve) => {
      const schedule = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
      schedule(() => {
        resolve(regenerateElevationViews(
          params.walls,
          params.sectionLines,
          params.existingViews,
          params.elevationSettings,
          params.hvacElements,
          params.furnitureInputs
        ));
      }, 0);
    });
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
    pendingRequests.set(requestId, { resolve, reject });
    worker.postMessage(request);
  });
}
