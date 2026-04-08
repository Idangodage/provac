import type { Point2D, Room, Wall } from '../types';
import { GeometryEngine } from './geometry-engine';

export type DoorSwingBehavior = 'inward' | 'outward';
export type DoorOpenSide = 'positive' | 'negative';
export type DoorHingeMode = 'auto-corner' | 'manual';
export type DoorSwingDirection = 'left' | 'right';

const DEFAULT_DOOR_SWING_BEHAVIOR: DoorSwingBehavior = 'inward';
const DEFAULT_DOOR_OPEN_SIDE: DoorOpenSide = 'positive';
const DEFAULT_DOOR_HINGE_MODE: DoorHingeMode = 'manual';
const DEFAULT_DOOR_SWING_DIRECTION: DoorSwingDirection = 'left';
const ROOM_SIDE_PROBE_MARGIN_MM = 140;
const CORNER_HINGE_MIN_THRESHOLD_MM = 220;
const CORNER_HINGE_MAX_THRESHOLD_MM = 800;
const CIRCULATION_TERMS = [
  'corridor',
  'hall',
  'hallway',
  'passage',
  'passageway',
  'lobby',
  'foyer',
  'entrance',
  'entry',
  'circulation',
  'vestibule',
  'stair',
  'staircase',
  'landing',
  'balcony',
];

function normalizeDoorOpenSide(value: unknown): DoorOpenSide {
  return value === 'negative' ? 'negative' : DEFAULT_DOOR_OPEN_SIDE;
}

export function readDoorSwingBehavior(properties?: Record<string, unknown>): DoorSwingBehavior {
  return properties?.doorSwingBehavior === 'outward'
    ? 'outward'
    : DEFAULT_DOOR_SWING_BEHAVIOR;
}

export function readDoorHingeMode(properties?: Record<string, unknown>): DoorHingeMode {
  return properties?.doorHingeMode === 'auto-corner'
    ? 'auto-corner'
    : DEFAULT_DOOR_HINGE_MODE;
}

export function readDoorSwingDirection(
  properties?: Record<string, unknown>,
  fallback: DoorSwingDirection = DEFAULT_DOOR_SWING_DIRECTION
): DoorSwingDirection {
  const direction = properties?.swingDirection;
  if (direction === 'left' || direction === 'right') {
    return direction;
  }
  return fallback;
}

export function readDoorOpenSide(
  properties?: Record<string, unknown>,
  fallback: DoorOpenSide = DEFAULT_DOOR_OPEN_SIDE
): DoorOpenSide {
  const side = properties?.doorOpenSide;
  if (side === 'positive' || side === 'negative') {
    return side;
  }
  return fallback;
}

export function invertDoorOpenSide(side: DoorOpenSide): DoorOpenSide {
  return side === 'positive' ? 'negative' : 'positive';
}

function wallLength(wall: Wall): number {
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  return Math.hypot(dx, dy);
}

function resolveCornerPreferredSwingDirection(
  wall: Wall,
  positionAlongWallMm: number,
  openingWidthMm: number
): DoorSwingDirection | null {
  const length = wallLength(wall);
  if (!Number.isFinite(length) || length <= 1) {
    return null;
  }

  const halfWidth = Math.max(120, openingWidthMm) / 2;
  const clampedPos = Math.max(0, Math.min(length, positionAlongWallMm));
  const clearToStart = Math.max(0, clampedPos - halfWidth);
  const clearToEnd = Math.max(0, length - (clampedPos + halfWidth));
  const minClear = Math.min(clearToStart, clearToEnd);
  const cornerThreshold = Math.min(
    CORNER_HINGE_MAX_THRESHOLD_MM,
    Math.max(CORNER_HINGE_MIN_THRESHOLD_MM, openingWidthMm * 0.6 + wall.thickness * 0.45)
  );

  if (minClear > cornerThreshold) {
    return null;
  }

  return clearToStart <= clearToEnd ? 'left' : 'right';
}

export function resolveDoorSwingDirectionFromCorner(
  wall: Wall,
  positionAlongWallMm: number,
  openingWidthMm: number,
  properties?: Record<string, unknown>
): DoorSwingDirection {
  const hingeMode = readDoorHingeMode(properties);
  if (hingeMode === 'manual') {
    return readDoorSwingDirection(properties);
  }

  const autoDirection = resolveCornerPreferredSwingDirection(
    wall,
    positionAlongWallMm,
    openingWidthMm
  );
  if (autoDirection) {
    return autoDirection;
  }

  return readDoorSwingDirection(properties);
}

function openingCenterPoint(wall: Wall, positionAlongWallMm: number): Point2D {
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const wallLength = Math.hypot(dx, dy) || 1;
  const clamped = Math.max(0, Math.min(wallLength, positionAlongWallMm));
  const t = clamped / wallLength;
  return {
    x: wall.startPoint.x + dx * t,
    y: wall.startPoint.y + dy * t,
  };
}

function wallPerpendicularUnit(wall: Wall): Point2D {
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const wallLength = Math.hypot(dx, dy) || 1;
  return {
    x: -dy / wallLength,
    y: dx / wallLength,
  };
}

function roomProbePoint(
  wall: Wall,
  positionAlongWallMm: number,
  side: DoorOpenSide
): Point2D {
  const center = openingCenterPoint(wall, positionAlongWallMm);
  const perp = wallPerpendicularUnit(wall);
  const distance = Math.max(ROOM_SIDE_PROBE_MARGIN_MM, wall.thickness / 2 + 80);
  const sign = side === 'negative' ? -1 : 1;
  return {
    x: center.x + perp.x * distance * sign,
    y: center.y + perp.y * distance * sign,
  };
}

function isCirculationRoom(room: Room): boolean {
  const haystack = `${room.name} ${room.roomType}`.toLowerCase();
  return CIRCULATION_TERMS.some((term) => haystack.includes(term));
}

function inwardRoomPriority(room: Room): number {
  let score = isCirculationRoom(room) ? 0 : 100;

  switch (room.roomType) {
    case 'Bathroom/Closet':
      score += 40;
      break;
    case 'Bedroom':
      score += 30;
      break;
    case 'Custom':
      score += 20;
      break;
    case 'Corridor':
    case 'Passage':
      score += 5;
      break;
    case 'Balcony':
      score -= 10;
      break;
    case 'Living Room':
      score += 15;
      break;
    case 'Open Space':
    default:
      score += 10;
      break;
  }

  // Smaller/private rooms generally benefit more from inward swing
  // than large circulation-facing spaces.
  score -= room.area / 1_000_000 / 10;
  return score;
}

function findBestRoomForProbe(rooms: Room[], probe: Point2D): Room | null {
  const containing = rooms.filter((room) => GeometryEngine.pointInRoom(probe, room));
  if (containing.length === 0) {
    return null;
  }

  return [...containing].sort((left, right) => {
    if (Math.abs(left.area - right.area) > 0.01) {
      return left.area - right.area;
    }
    return left.name.localeCompare(right.name);
  })[0] ?? null;
}

function preferredInwardSide(
  positiveRoom: Room | null,
  negativeRoom: Room | null
): DoorOpenSide | null {
  if (positiveRoom && !negativeRoom) {
    return 'positive';
  }
  if (negativeRoom && !positiveRoom) {
    return 'negative';
  }
  if (!positiveRoom || !negativeRoom) {
    return null;
  }

  const positiveScore = inwardRoomPriority(positiveRoom);
  const negativeScore = inwardRoomPriority(negativeRoom);
  if (Math.abs(positiveScore - negativeScore) > 0.001) {
    return positiveScore > negativeScore ? 'positive' : 'negative';
  }

  return positiveRoom.area <= negativeRoom.area ? 'positive' : 'negative';
}

export function resolveDoorOpenSideFromRooms(
  wall: Wall,
  positionAlongWallMm: number,
  rooms: Room[],
  behavior: DoorSwingBehavior = DEFAULT_DOOR_SWING_BEHAVIOR,
  fallback: DoorOpenSide = DEFAULT_DOOR_OPEN_SIDE
): DoorOpenSide {
  const positiveRoom = findBestRoomForProbe(rooms, roomProbePoint(wall, positionAlongWallMm, 'positive'));
  const negativeRoom = findBestRoomForProbe(rooms, roomProbePoint(wall, positionAlongWallMm, 'negative'));
  const inwardSide = preferredInwardSide(positiveRoom, negativeRoom);

  if (!inwardSide) {
    return normalizeDoorOpenSide(fallback);
  }

  return behavior === 'outward' ? invertDoorOpenSide(inwardSide) : inwardSide;
}

export function resolveHostedDoorSwingProperties(
  wall: Wall,
  positionAlongWallMm: number,
  openingWidthMm: number,
  rooms: Room[],
  properties?: Record<string, unknown>
): Record<string, unknown> {
  const behavior = readDoorSwingBehavior(properties);
  const fallbackSide = readDoorOpenSide(properties);
  const hingeMode = readDoorHingeMode(properties);
  const swingDirection = resolveDoorSwingDirectionFromCorner(
    wall,
    positionAlongWallMm,
    openingWidthMm,
    properties
  );
  return {
    doorSwingBehavior: behavior,
    doorHingeMode: hingeMode,
    swingDirection,
    doorOpenSide: resolveDoorOpenSideFromRooms(
      wall,
      positionAlongWallMm,
      rooms,
      behavior,
      fallbackSide
    ),
  };
}
