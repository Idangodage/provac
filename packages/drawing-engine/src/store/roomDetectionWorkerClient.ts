import type { Room, Wall } from '../types';

import { buildAutoDetectedRooms } from './autoDetectedRooms';
import type {
  RoomDetectionWorkerRequest,
  RoomDetectionWorkerResponse,
} from './roomDetection.worker';

let workerInstance: Worker | null = null;
let workerDisabled = false;
let requestIdCounter = 0;

const pendingRequests = new Map<
  number,
  {
    resolve: (rooms: Room[]) => void;
    reject: (error: unknown) => void;
  }
>();

function resolvePendingRequest(requestId: number, rooms: Room[]): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  pending.resolve(rooms);
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

function getRoomDetectionWorker(): Worker | null {
  if (workerDisabled || typeof window === 'undefined' || typeof Worker === 'undefined') {
    return null;
  }
  if (workerInstance) {
    return workerInstance;
  }

  try {
    const worker = new Worker(
      new URL('./roomDetection.worker.ts', import.meta.url),
      { type: 'module' }
    );

    worker.addEventListener('message', (event: MessageEvent<RoomDetectionWorkerResponse>) => {
      const message = event.data;
      if (!message || message.type !== 'detect-rooms-result') {
        return;
      }
      resolvePendingRequest(message.requestId, message.rooms);
    });

    worker.addEventListener('error', (event) => {
      workerDisabled = true;
      disposeWorker();
      rejectPendingRequests(event.error ?? new Error('Room detection worker failed.'));
    });

    workerInstance = worker;
    return workerInstance;
  } catch {
    workerDisabled = true;
    disposeWorker();
    return null;
  }
}

export async function detectRoomsInBackground(params: {
  topology: string;
  walls: Wall[];
  rooms: Room[];
}): Promise<Room[]> {
  const worker = getRoomDetectionWorker();
  if (!worker) {
    return new Promise<Room[]>((resolve) => {
      const schedule = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
      schedule(() => {
        resolve(buildAutoDetectedRooms(params.walls, params.rooms));
      }, 0);
    });
  }

  const requestId = ++requestIdCounter;
  const request: RoomDetectionWorkerRequest = {
    type: 'detect-rooms',
    requestId,
    topology: params.topology,
    walls: params.walls,
    rooms: params.rooms,
  };

  return new Promise<Room[]>((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    worker.postMessage(request);
  });
}
