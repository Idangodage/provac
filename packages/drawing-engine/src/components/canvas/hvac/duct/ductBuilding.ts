/**
 * The building ducts run through: its walls (centre line, thickness, the
 * height band they occupy, whether they are structural) and its rooms
 * (outlines). Plans derive wall penetrations from it every time they are made,
 * so a moved wall never leaves a stale sleeve.
 *
 * Engines that are not handed the building (the canvas's memoised duct plans)
 * read the active building, which the drawing sets whenever its walls or rooms
 * change (like the active duct settings). The auto layout sets and restores it
 * around its own work, so a Web Worker sees the building it was sent.
 */
import type { Point2D, Room, Wall } from '../../../../types';

/** A wall as ducts see it (mm). */
export interface DuctWall {
  id: string;
  a: Point2D;
  b: Point2D;
  thicknessMm: number;
  /** The vertical band it occupies (above the floor); a duct above its top passes over it. */
  baseZ: number;
  topZ: number;
  /** Masonry or concrete, or a structural layer: core drilled, and fire-dampered under the 'structural' policy. */
  structural: boolean;
  /** What it is built of, for the penetration schedule (absent when the drawing does not say). */
  material?: 'brick' | 'concrete' | 'partition';
}

export interface DuctRoomOutline {
  id: string;
  name?: string;
  vertices: Point2D[];
}

export interface DuctBuilding {
  walls: readonly DuctWall[];
  rooms: readonly DuctRoomOutline[];
  /** Changes whenever the walls or rooms do (plan caches key on it). */
  revision: number;
}

export const EMPTY_DUCT_BUILDING: DuctBuilding = { walls: [], rooms: [], revision: 0 };

/** The height walls are taken to have when the drawing gives none (mm). */
export const DEFAULT_DUCT_WALL_HEIGHT_MM = 2700;

type WallSource = Pick<Wall, 'id' | 'startPoint' | 'endPoint' | 'thickness'> & Partial<Pick<Wall, 'material' | 'layer' | 'properties3D'>>;

/** The drawing's walls as ducts see them. */
export function ductWallsFromWalls(walls: readonly WallSource[]): DuctWall[] {
  return walls.map((wall) => {
    const baseZ = Number.isFinite(wall.properties3D?.baseElevation) ? wall.properties3D!.baseElevation : 0;
    const height = Number.isFinite(wall.properties3D?.height) && wall.properties3D!.height > 0 ? wall.properties3D!.height : DEFAULT_DUCT_WALL_HEIGHT_MM;
    return {
      id: wall.id, a: wall.startPoint, b: wall.endPoint, thicknessMm: Math.max(1, wall.thickness || 100),
      baseZ, topZ: baseZ + height,
      structural: wall.layer === 'structural' || (wall.material !== undefined && wall.material !== 'partition'),
      ...(wall.material ? { material: wall.material } : {}),
    };
  });
}

/** A wall as the auto layout's request carries it (heights optional: absent = full height, as before). */
export interface DuctWallInput {
  id: string;
  startPoint: Point2D;
  endPoint: Point2D;
  thickness?: number;
  baseZ?: number;
  topZ?: number;
  structural?: boolean;
  material?: DuctWall['material'];
}

export function ductWallsFromInputs(walls: readonly DuctWallInput[]): DuctWall[] {
  return walls.map((wall) => ({
    id: wall.id, a: wall.startPoint, b: wall.endPoint, thicknessMm: Math.max(1, wall.thickness ?? 100),
    baseZ: wall.baseZ ?? -1e6, topZ: wall.topZ ?? 1e6, structural: wall.structural ?? false,
    ...(wall.material ? { material: wall.material } : {}),
  }));
}

/** The request form of the drawing's walls, with their heights and construction. */
export function ductWallInputs(walls: readonly WallSource[]): DuctWallInput[] {
  return ductWallsFromWalls(walls).map((wall) => ({
    id: wall.id, startPoint: wall.a, endPoint: wall.b, thickness: wall.thicknessMm, baseZ: wall.baseZ, topZ: wall.topZ, structural: wall.structural,
    ...(wall.material ? { material: wall.material } : {}),
  }));
}

export function ductRoomsFromRooms(rooms: ReadonlyArray<Pick<Room, 'id' | 'name' | 'vertices'>>): DuctRoomOutline[] {
  return rooms.map((room) => ({ id: room.id, name: room.name, vertices: room.vertices }));
}

let active: DuctBuilding = EMPTY_DUCT_BUILDING;
let revisions = 0;
let lastSource: { walls: unknown; rooms: unknown } = { walls: null, rooms: null };

export function getActiveDuctBuilding(): DuctBuilding {
  return active;
}

/** Sets the building plans read by default; a new revision only when the walls or rooms actually changed (by identity). */
export function setActiveDuctBuilding(walls: readonly DuctWall[], rooms: readonly DuctRoomOutline[], source?: { walls: unknown; rooms: unknown }): DuctBuilding {
  if (source && source.walls === lastSource.walls && source.rooms === lastSource.rooms) return active;
  lastSource = source ?? { walls, rooms };
  active = { walls, rooms, revision: (revisions += 1) };
  return active;
}

/** Keeps the active building in step with the drawing's walls and rooms (rebuilt only when either changes, by identity). */
export function syncActiveDuctBuilding(walls: readonly WallSource[], rooms: ReadonlyArray<Pick<Room, 'id' | 'name' | 'vertices'>>): DuctBuilding {
  if (walls === lastSource.walls && rooms === lastSource.rooms) return active;
  return setActiveDuctBuilding(ductWallsFromWalls(walls), ductRoomsFromRooms(rooms), { walls, rooms });
}

/** Runs `work` with `building` active, then restores the one before (the auto layout, worker-safe). */
export function withActiveDuctBuilding<T>(walls: readonly DuctWall[], rooms: readonly DuctRoomOutline[], work: () => T): T {
  const before = active;
  const beforeSource = lastSource;
  active = { walls, rooms, revision: (revisions += 1) };
  lastSource = { walls, rooms };
  try {
    return work();
  } finally {
    active = before;
    lastSource = beforeSource;
  }
}
