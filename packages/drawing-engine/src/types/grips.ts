import type { Point2D } from './index';

export type GripOwnerType = 'wall' | 'room' | 'furniture';
export type GripShape = 'square' | 'circle' | 'diamond' | 'cross';
export type ConstraintType = 'orthogonal' | 'parallel' | 'perpendicular' | 'equal_length';

export enum GripType {
  ENDPOINT = 'endpoint',
  MIDPOINT = 'midpoint',
  CENTER = 'center',
  CORNER = 'corner',
  EDGE_OFFSET = 'edge_offset',
  ROTATION = 'rotation',
  SCALE = 'scale',
}

export enum GripState {
  NORMAL = 'normal',
  HOVER = 'hover',
  ACTIVE = 'active',
  LOCKED = 'locked',
}

export interface EditContext {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export interface Constraint {
  type: ConstraintType;
  apply: (point: Point2D, context: EditContext) => Point2D;
}

export interface Grip {
  id: string;
  type: GripType;
  position: Point2D;
  ownerId: string;
  ownerType: GripOwnerType;
  state: GripState;
  size: number;
  color: string;
  shape: GripShape;
  cursorStyle: string;
  constraints?: Constraint[];
  metadata?: Record<string, unknown>;
}

