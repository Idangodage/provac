/**
 * Runs the duct auto layout in a module worker so the canvas stays live while
 * the trees are routed and sized; a newer request cancels the one running.
 * Where module workers are missing (tests, old browsers) it runs on the main
 * thread instead.
 */
import type { HvacElement } from '../../../../../types';
import { generateAutoDuct, type AutoDuctRequest, type AutoDuctResult } from '../ductAutoLayout';
import type { DuctDesignSettings } from '../ductSettings';

export interface AutoDuctWorkerRequest {
  type: 'generate';
  id: number;
  scene: HvacElement[];
  request: AutoDuctRequest;
  settings: DuctDesignSettings;
}

export type AutoDuctWorkerResponse =
  | { type: 'result'; id: number; result: AutoDuctResult }
  | { type: 'error'; id: number; message: string };

let worker: Worker | null = null;
let counter = 0;
let pending: { id: number; reject: (reason: Error) => void } | null = null;

export function cancelAutoDuctWorker(): void {
  pending?.reject(new Error('cancelled'));
  pending = null;
  worker?.terminate();
  worker = null;
}

export function runAutoDuctInWorker(scene: readonly HvacElement[], request: AutoDuctRequest, settings: DuctDesignSettings): Promise<AutoDuctResult> {
  cancelAutoDuctWorker();
  const id = (counter += 1);
  try {
    worker = new Worker(new URL('./ductOptimizer.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
    return Promise.resolve().then(() => generateAutoDuct(scene, request, settings));
  }
  const current = worker;
  return new Promise<AutoDuctResult>((resolve, reject) => {
    pending = { id, reject };
    current.onmessage = ({ data }: MessageEvent<AutoDuctWorkerResponse>) => {
      if (data.id !== id) return;
      pending = null;
      current.terminate();
      if (worker === current) worker = null;
      if (data.type === 'result') resolve(data.result);
      else reject(new Error(data.message));
    };
    current.onerror = () => {
      pending = null;
      current.terminate();
      if (worker === current) worker = null;
      // A worker that cannot load its module: fall back to the main thread.
      try {
        resolve(generateAutoDuct(scene, request, settings));
      } catch (error) {
        reject(error instanceof Error ? error : new Error('The duct layout could not be calculated.'));
      }
    };
    current.postMessage({ type: 'generate', id, scene: [...scene], request, settings } satisfies AutoDuctWorkerRequest);
  });
}
