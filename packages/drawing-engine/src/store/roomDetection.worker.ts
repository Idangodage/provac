import type { Room, Wall } from '../types';

import { buildAutoDetectedRooms } from './autoDetectedRooms';

export interface RoomDetectionWorkerRequest {
  type: 'detect-rooms';
  requestId: number;
  topology: string;
  walls: Wall[];
  rooms: Room[];
}

export interface RoomDetectionWorkerResponse {
  type: 'detect-rooms-result';
  requestId: number;
  topology: string;
  rooms: Room[];
}

const workerScope = self as unknown as {
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<RoomDetectionWorkerRequest>) => void
  ) => void;
  postMessage: (message: RoomDetectionWorkerResponse) => void;
};

workerScope.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.type !== 'detect-rooms') {
    return;
  }

  workerScope.postMessage({
    type: 'detect-rooms-result',
    requestId: message.requestId,
    topology: message.topology,
    rooms: buildAutoDetectedRooms(message.walls, message.rooms),
  });
});

export {};
