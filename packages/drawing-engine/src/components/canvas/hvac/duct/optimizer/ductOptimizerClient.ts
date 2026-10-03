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
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

export function cancelAutoDuctWorker(): void {
  pending?.reject(new Error('cancelled'));
  pending = null;
  if (fallbackTimer !== null) clearTimeout(fallbackTimer);
  fallbackTimer = null;
  worker?.terminate();
  worker = null;
}

export function runAutoDuctInWorker(scene: readonly HvacElement[], request: AutoDuctRequest, settings: DuctDesignSettings): Promise<AutoDuctResult> {
  cancelAutoDuctWorker();
  const id = (counter += 1);
  return new Promise<AutoDuctResult>((resolve, reject) => {
    pending = { id, reject };
    const fallback = () => {
      // Give the browser a chance to show progress and honour cancellation
      // before the synchronous compatibility calculation begins.
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        if (pending?.id !== id) return;
        try {
          const result = generateAutoDuct(scene, request, settings);
          pending = null;
          resolve(result);
        } catch (error) {
          pending = null;
          reject(error instanceof Error ? error : new Error('The duct layout could not be calculated.'));
        }
      }, 0);
    };
    try {
      worker = new Worker(new URL('./ductOptimizer.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      worker = null;
      fallback();
      return;
    }
    const current = worker;
    const release = () => {
      current.onmessage = null;
      current.onerror = null;
      current.onmessageerror = null;
      current.terminate();
      if (worker === current) worker = null;
    };
    current.onmessage = ({ data }: MessageEvent<AutoDuctWorkerResponse>) => {
      if (pending?.id !== id || data.id !== id) return;
      pending = null;
      release();
      if (data.type === 'result') resolve(data.result);
      else reject(new Error(data.message));
    };
    current.onerror = () => {
      if (pending?.id !== id) return;
      release();
      // A worker that cannot load its module: fall back to the main thread.
      fallback();
    };
    current.onmessageerror = () => {
      if (pending?.id !== id) return;
      pending = null;
      release();
      reject(new Error('The duct preview could not be read. Generate it again.'));
    };
    try {
      current.postMessage({ type: 'generate', id, scene: [...scene], request, settings } satisfies AutoDuctWorkerRequest);
    } catch (error) {
      pending = null;
      release();
      reject(error instanceof Error ? error : new Error('The duct layout could not be started.'));
    }
  });
}
