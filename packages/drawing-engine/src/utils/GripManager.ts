import type { Point2D, Room, Wall } from '../types';
import { GripState, GripType, type Grip } from '../types/grips';

import { GeometryEngine } from './geometry-engine';

const BASE_GRIP_SIZE = 8;
const ROTATION_HANDLE_DISTANCE_MM = 300;

function wallMidpoint(wall: Pick<Wall, 'startPoint' | 'endPoint'>): Point2D {
  return {
    x: (wall.startPoint.x + wall.endPoint.x) / 2,
    y: (wall.startPoint.y + wall.endPoint.y) / 2,
  };
}

function wallPerpendicularUnit(wall: Pick<Wall, 'startPoint' | 'endPoint'>): Point2D {
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: -dy / len, y: dx / len };
}

function roomBounds(room: Room): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs = room.vertices.map((v) => v.x);
  const ys = room.vertices.map((v) => v.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

export class GripManager {
  private grips: Map<string, Grip> = new Map();

  clear(): void {
    this.grips.clear();
  }

  getAll(): Grip[] {
    return Array.from(this.grips.values());
  }

  setGrips(grips: Grip[]): void {
    this.grips.clear();
    grips.forEach((grip) => this.grips.set(grip.id, grip));
  }

  generateWallGrips(wall: Wall): Grip[] {
    const midpoint = wallMidpoint(wall);
    const perp = wallPerpendicularUnit(wall);
    const halfThickness = wall.thickness / 2;
    const angle = Math.atan2(
      wall.endPoint.y - wall.startPoint.y,
      wall.endPoint.x - wall.startPoint.x
    );

    const grips: Grip[] = [
      {
        id: `${wall.id}-start`,
        type: GripType.ENDPOINT,
        position: { ...wall.startPoint },
        ownerId: wall.id,
        ownerType: 'wall',
        state: GripState.NORMAL,
        size: BASE_GRIP_SIZE,
        color: '#2563EB',
        shape: 'square',
        cursorStyle: 'move',
        metadata: { controlType: 'wall-endpoint-start' },
      },
      {
        id: `${wall.id}-end`,
        type: GripType.ENDPOINT,
        position: { ...wall.endPoint },
        ownerId: wall.id,
        ownerType: 'wall',
        state: GripState.NORMAL,
        size: BASE_GRIP_SIZE,
        color: '#2563EB',
        shape: 'square',
        cursorStyle: 'move',
        metadata: { controlType: 'wall-endpoint-end' },
      },
      {
        id: `${wall.id}-mid`,
        type: GripType.MIDPOINT,
        position: midpoint,
        ownerId: wall.id,
        ownerType: 'wall',
        state: GripState.NORMAL,
        size: BASE_GRIP_SIZE,
        color: '#2563EB',
        shape: 'circle',
        cursorStyle: 'move',
        metadata: { controlType: 'wall-center-handle' },
      },
      {
        id: `${wall.id}-thickness-interior`,
        type: GripType.EDGE_OFFSET,
        position: {
          x: midpoint.x + perp.x * halfThickness,
          y: midpoint.y + perp.y * halfThickness,
        },
        ownerId: wall.id,
        ownerType: 'wall',
        state: GripState.NORMAL,
        size: 6,
        color: '#1D4ED8',
        shape: 'circle',
        cursorStyle: 'ew-resize',
        metadata: { controlType: 'wall-thickness-interior', side: 'interior' },
      },
      {
        id: `${wall.id}-thickness-exterior`,
        type: GripType.EDGE_OFFSET,
        position: {
          x: midpoint.x - perp.x * halfThickness,
          y: midpoint.y - perp.y * halfThickness,
        },
        ownerId: wall.id,
        ownerType: 'wall',
        state: GripState.NORMAL,
        size: 6,
        color: '#1D4ED8',
        shape: 'circle',
        cursorStyle: 'ew-resize',
        metadata: { controlType: 'wall-thickness-exterior', side: 'exterior' },
      },
      {
        id: `${wall.id}-rotate`,
        type: GripType.ROTATION,
        position: {
          x: midpoint.x - Math.sin(angle) * ROTATION_HANDLE_DISTANCE_MM,
          y: midpoint.y + Math.cos(angle) * ROTATION_HANDLE_DISTANCE_MM,
        },
        ownerId: wall.id,
        ownerType: 'wall',
        state: GripState.NORMAL,
        size: 10,
        color: '#16A34A',
        shape: 'circle',
        cursorStyle: 'alias',
        metadata: { controlType: 'wall-rotation-handle' },
      },
    ];

    return grips;
  }

  generateRoomGrips(room: Room): Grip[] {
    const centroid = GeometryEngine.findRoomCentroid(room);
    const bounds = roomBounds(room);
    const topCenter = { x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY };
    const bottomCenter = { x: (bounds.minX + bounds.maxX) / 2, y: bounds.maxY };
    const leftCenter = { x: bounds.minX, y: (bounds.minY + bounds.maxY) / 2 };
    const rightCenter = { x: bounds.maxX, y: (bounds.minY + bounds.maxY) / 2 };

    const grips: Grip[] = room.vertices.map((vertex, index) => ({
      id: `${room.id}-corner-${index}`,
      type: GripType.CORNER,
      position: { ...vertex },
      ownerId: room.id,
      ownerType: 'room',
      state: GripState.NORMAL,
      size: BASE_GRIP_SIZE,
      color: '#2563EB',
      shape: 'square',
      cursorStyle: 'move',
      metadata: { cornerIndex: index },
    }));

    grips.push(
      {
        id: `${room.id}-center`,
        type: GripType.CENTER,
        position: centroid,
        ownerId: room.id,
        ownerType: 'room',
        state: GripState.NORMAL,
        size: 10,
        color: '#2563EB',
        shape: 'cross',
        cursorStyle: 'move',
        metadata: { controlType: 'room-center-handle' },
      },
      {
        id: `${room.id}-scale-n`,
        type: GripType.SCALE,
        position: topCenter,
        ownerId: room.id,
        ownerType: 'room',
        state: GripState.NORMAL,
        size: BASE_GRIP_SIZE,
        color: '#16A34A',
        shape: 'square',
        cursorStyle: 'ns-resize',
        metadata: { direction: 'N' },
      },
      {
        id: `${room.id}-scale-s`,
        type: GripType.SCALE,
        position: bottomCenter,
        ownerId: room.id,
        ownerType: 'room',
        state: GripState.NORMAL,
        size: BASE_GRIP_SIZE,
        color: '#16A34A',
        shape: 'square',
        cursorStyle: 'ns-resize',
        metadata: { direction: 'S' },
      },
      {
        id: `${room.id}-scale-w`,
        type: GripType.SCALE,
        position: leftCenter,
        ownerId: room.id,
        ownerType: 'room',
        state: GripState.NORMAL,
        size: BASE_GRIP_SIZE,
        color: '#16A34A',
        shape: 'square',
        cursorStyle: 'ew-resize',
        metadata: { direction: 'W' },
      },
      {
        id: `${room.id}-scale-e`,
        type: GripType.SCALE,
        position: rightCenter,
        ownerId: room.id,
        ownerType: 'room',
        state: GripState.NORMAL,
        size: BASE_GRIP_SIZE,
        color: '#16A34A',
        shape: 'square',
        cursorStyle: 'ew-resize',
        metadata: { direction: 'E' },
      }
    );

    return grips;
  }

  findGripAtPoint(point: Point2D, tolerance = 10): Grip | null {
    for (const grip of this.grips.values()) {
      const d = GeometryEngine.distance(point, grip.position);
      if (d <= tolerance) {
        return grip;
      }
    }
    return null;
  }
}

