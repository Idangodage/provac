/**
 * Serialization / deserialization helpers for bound 3D attributes.
 */

import type { Room, Room3D, Wall, Wall3D } from '../types';

import { bindRoomGeometryTo3D, bindWallGeometryTo3D } from './schemas';

export const ATTRIBUTE_ENVELOPE_SCHEMA = 'provacx.drawing-attributes';
export const ATTRIBUTE_ENVELOPE_VERSION = 1;

export interface SerializedWallAttributes {
  wallId: string;
  properties3D: Wall3D;
}

export interface SerializedRoomAttributes {
  roomId: string;
  properties3D: Room3D;
}

export interface DrawingAttributeEnvelope {
  schema: typeof ATTRIBUTE_ENVELOPE_SCHEMA;
  version: typeof ATTRIBUTE_ENVELOPE_VERSION;
  wallAttributes: SerializedWallAttributes[];
  roomAttributes: SerializedRoomAttributes[];
}

export function createAttributeEnvelope(walls: Wall[], rooms: Room[]): DrawingAttributeEnvelope {
  return {
    schema: ATTRIBUTE_ENVELOPE_SCHEMA,
    version: ATTRIBUTE_ENVELOPE_VERSION,
    wallAttributes: walls.map((wall) => ({
      wallId: wall.id,
      properties3D: wall.properties3D,
    })),
    roomAttributes: rooms.map((room) => ({
      roomId: room.id,
      properties3D: room.properties3D,
    })),
  };
}

export function serializeAttributeEnvelope(walls: Wall[], rooms: Room[]): string {
  return JSON.stringify(createAttributeEnvelope(walls, rooms));
}

export interface DeserializedAttributeState {
  walls: Wall[];
  rooms: Room[];
  warnings: string[];
}

export function deserializeAttributeEnvelope(
  rawEnvelope: unknown,
  walls: Wall[],
  rooms: Room[]
): DeserializedAttributeState {
  const warnings: string[] = [];
  const envelope = rawEnvelope as Partial<DrawingAttributeEnvelope> | null | undefined;

  const wallAttributeById = new Map<string, Wall3D>();
  const roomAttributeById = new Map<string, Room3D>();

  if (
    envelope &&
    envelope.schema === ATTRIBUTE_ENVELOPE_SCHEMA &&
    envelope.version === ATTRIBUTE_ENVELOPE_VERSION
  ) {
    if (Array.isArray(envelope.wallAttributes)) {
      envelope.wallAttributes.forEach((entry) => {
        if (entry?.wallId && entry?.properties3D) {
          wallAttributeById.set(entry.wallId, entry.properties3D);
        }
      });
    }
    if (Array.isArray(envelope.roomAttributes)) {
      envelope.roomAttributes.forEach((entry) => {
        if (entry?.roomId && entry?.properties3D) {
          roomAttributeById.set(entry.roomId, entry.properties3D);
        }
      });
    }
  } else if (rawEnvelope !== undefined && rawEnvelope !== null) {
    warnings.push('Ignored unsupported attribute envelope.');
  }

  const hydratedWalls = walls.map((wall) => {
    const bound = bindWallGeometryTo3D(wall, wallAttributeById.get(wall.id));
    if (bound.issues.length > 0) {
      warnings.push(`Wall ${wall.id} attribute issues: ${bound.issues.map((issue) => issue.message).join(', ')}`);
    }
    return {
      ...wall,
      properties3D: bound.value,
    };
  });

  const hydratedRooms = rooms.map((room) => {
    const bound = bindRoomGeometryTo3D(room, roomAttributeById.get(room.id));
    if (bound.issues.length > 0) {
      warnings.push(`Room ${room.id} attribute issues: ${bound.issues.map((issue) => issue.message).join(', ')}`);
    }
    return {
      ...room,
      properties3D: bound.value,
    };
  });

  return {
    walls: hydratedWalls,
    rooms: hydratedRooms,
    warnings,
  };
}
