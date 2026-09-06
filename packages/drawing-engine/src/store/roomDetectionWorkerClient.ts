import type { Room, Wall } from '../types';

import { buildAutoDetectedRooms } from './autoDetectedRooms';
import { LatestOnlyAsyncQueue } from './latestOnlyAsyncQueue';
import type {
  RoomDetectionWorkerRequest,
  RoomDetectionWorkerResponse,
} from './roomDetection.worker';

let workerInstance: Worker | null = null;
let workerDisabled = false;
let requestIdCounter = 0;

interface RoomDetectionParams {
  topology: string;
  walls: Wall[];
  rooms: Room[];
}

interface ActiveWorkerRequest {
  requestId: number;
  resolve: (rooms: Room[]) => void;
  reject: (error: unknown) => void;
}

let activeWorkerRequest: ActiveWorkerRequest | null = null;

function resolveActiveWorkerRequest(requestId: number, rooms: Room[]): void {
  if (activeWorkerRequest?.requestId !== requestId) return;
  const pending = activeWorkerRequest;
  activeWorkerRequest = null;
  pending.resolve(rooms);
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
      resolveActiveWorkerRequest(message.requestId, message.rooms);
    });

    worker.addEventListener('error', (event) => {
      disableWorker(event.error ?? new Error('Room detection worker failed.'));
    });

    worker.addEventListener('messageerror', () => {
      disableWorker(new Error('Room detection worker returned an unreadable message.'));
    });

    workerInstance = worker;
    return workerInstance;
  } catch {
    workerDisabled = true;
    disposeWorker();
    return null;
  }
}

function runFallback(params: RoomDetectionParams): Promise<Room[]> {
  return new Promise<Room[]>((resolve, reject) => {
    const schedule = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
    schedule(() => {
      try {
        resolve(buildAutoDetectedRooms(params.walls, params.rooms));
      } catch (error) {
        reject(error);
      }
    }, 0);
  });
}

function executeRoomDetection(params: RoomDetectionParams): Promise<Room[]> {
  const worker = getRoomDetectionWorker();
  if (!worker) {
    return runFallback(params);
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
    activeWorkerRequest = { requestId, resolve, reject };
    try {
      worker.postMessage(request);
    } catch (error) {
      disableWorker(error);
    }
  });
}

const roomDetectionQueue = new LatestOnlyAsyncQueue<RoomDetectionParams, Room[]>(
  executeRoomDetection
);

export function detectRoomsInBackground(params: RoomDetectionParams): Promise<Room[]> {
  return roomDetectionQueue.enqueue(params);
}
