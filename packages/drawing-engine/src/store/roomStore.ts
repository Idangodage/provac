import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { StoreApi, UseBoundStore } from 'zustand';

import {
  DEFAULT_ROOM_DETECTION_CONFIG,
  type DetectedRoom,
  type RoomDetectionConfig,
  type WallSegment,
} from '../types/room';
import {
  detectRoomsFromWalls,
  isPointInsideRoom,
  prepareWallSegmentForInsertion,
} from '../utils/roomDetection';

type Point = { x: number; y: number };

let detectionTimer: ReturnType<typeof setTimeout> | null = null;
let pendingChangedWallIds = new Set<string>();
let roomWallIndexById = new Map<string, string[]>();
let roomHoleIndexById = new Map<string, Point[][]>();
let archivedRooms = new Map<string, DetectedRoom>();
const DEFAULT_ROOM_BEVEL = {
  outerOffset: 0,
  innerOffset: 0,
};

function scheduleSync(getState: () => RoomStore): void {
  if (detectionTimer) {
    clearTimeout(detectionTimer);
  }
  detectionTimer = setTimeout(() => {
    detectionTimer = null;
    getState()._syncRoomsFromWalls();
  }, 150);
}

function roomTagText(name: string, area: number): string {
  return `${name}\n${area.toFixed(1)} px²`;
}

export interface RoomStore {
  walls: Map<string, WallSegment>;
  rooms: Map<string, DetectedRoom>;
  config: RoomDetectionConfig;

  addWall: (wall: WallSegment) => void;
  removeWall: (wallId: string) => void;
  updateWall: (wallId: string, updates: Partial<WallSegment>) => void;

  _syncRoomsFromWalls: () => void;
  renameRoom: (roomId: string, name: string) => void;
  toggleRoomVisibility: (roomId: string) => void;

  pinLabelTag: (roomId: string, position: { x: number; y: number }) => void;
  resetLabelTag: (roomId: string) => void;

  getRoomAtPoint: (point: { x: number; y: number }) => DetectedRoom | null;
  getSubRooms: (roomId: string) => DetectedRoom[];
  getTopLevelRooms: () => DetectedRoom[];
}

export const useRoomStore: UseBoundStore<StoreApi<RoomStore>> = create<RoomStore>()(
  immer<RoomStore>((set, get) => ({
    walls: new Map<string, WallSegment>(),
    rooms: new Map<string, DetectedRoom>(),
    config: { ...DEFAULT_ROOM_DETECTION_CONFIG },

    addWall: (wall) => {
      const existingWalls = Array.from(get().walls.values());
      const existingRooms = Array.from(get().rooms.values());
      const prepared = prepareWallSegmentForInsertion(
        {
          ...wall,
          thickness: Number.isFinite(wall.thickness) ? wall.thickness : 8,
          startBevel: {
            outerOffset: wall.startBevel?.outerOffset ?? DEFAULT_ROOM_BEVEL.outerOffset,
            innerOffset: wall.startBevel?.innerOffset ?? DEFAULT_ROOM_BEVEL.innerOffset,
          },
          endBevel: {
            outerOffset: wall.endBevel?.outerOffset ?? DEFAULT_ROOM_BEVEL.outerOffset,
            innerOffset: wall.endBevel?.innerOffset ?? DEFAULT_ROOM_BEVEL.innerOffset,
          },
        },
        existingWalls,
        existingRooms,
        get().config
      );

      set((state) => {
        state.walls.set(prepared.wall.id, prepared.wall);
      });

      pendingChangedWallIds.add(prepared.wall.id);
      scheduleSync(get);
    },

    removeWall: (wallId) => {
      set((state) => {
        state.walls.delete(wallId);
      });

      pendingChangedWallIds.add(wallId);
      scheduleSync(get);
    },

    updateWall: (wallId, updates) => {
      const existing = get().walls.get(wallId);
      if (!existing) return;

      const merged: WallSegment = {
        ...existing,
        ...updates,
        startPoint: updates.startPoint ?? existing.startPoint,
        endPoint: updates.endPoint ?? existing.endPoint,
        startBevel: {
          outerOffset: updates.startBevel?.outerOffset ?? existing.startBevel.outerOffset,
          innerOffset: updates.startBevel?.innerOffset ?? existing.startBevel.innerOffset,
        },
        endBevel: {
          outerOffset: updates.endBevel?.outerOffset ?? existing.endBevel.outerOffset,
          innerOffset: updates.endBevel?.innerOffset ?? existing.endBevel.innerOffset,
        },
      };
      const otherWalls = Array.from(get().walls.values()).filter((wall) => wall.id !== wallId);
      const prepared = prepareWallSegmentForInsertion(
        merged,
        otherWalls,
        Array.from(get().rooms.values()),
        get().config
      );

      set((state) => {
        state.walls.set(wallId, prepared.wall);
      });

      pendingChangedWallIds.add(wallId);
      scheduleSync(get);
    },

    _syncRoomsFromWalls: () => {
      const state = get();
      const walls = Array.from(state.walls.values());
      const existingRooms = Array.from(state.rooms.values());
      const changedWallIds = [...pendingChangedWallIds];
      pendingChangedWallIds = new Set<string>();

      const result = detectRoomsFromWalls({
        walls,
        existingRooms,
        changedWallIds,
        config: state.config,
      });

      roomWallIndexById = result.roomWallIdsById;
      roomHoleIndexById = result.roomHolesById;
      archivedRooms = result.archivedParentRooms;

      set((draft) => {
        draft.rooms = new Map(result.rooms.map((room) => [room.id, room]));
      });
    },

    renameRoom: (roomId, name) => {
      set((state) => {
        const room = state.rooms.get(roomId);
        if (!room) return;
        room.name = name;
        room.labelTag.text = roomTagText(name, room.area);
      });
    },

    toggleRoomVisibility: (roomId) => {
      set((state) => {
        const room = state.rooms.get(roomId);
        if (!room) return;
        room.labelTag.visible = !room.labelTag.visible;
        if (!room.labelTag.visible) {
          room.isActive = false;
        }
      });
    },

    pinLabelTag: (roomId, position) => {
      set((state) => {
        const room = state.rooms.get(roomId);
        if (!room) return;
        room.labelTag.position = { ...position };
        room.labelTag.pinned = true;
        room.labelTag.visible = true;
      });
    },

    resetLabelTag: (roomId) => {
      set((state) => {
        const room = state.rooms.get(roomId);
        if (!room) return;
        room.labelTag.position = { ...room.centroid };
        room.labelTag.pinned = false;
      });
    },

    getRoomAtPoint: (point) => {
      const rooms = Array.from(get().rooms.values())
        .filter((room) => room.labelTag.visible)
        .sort((a, b) => b.depth - a.depth || a.area - b.area);
      for (const room of rooms) {
        if (isPointInsideRoom(point, room)) {
          return room;
        }
      }
      return null;
    },

    getSubRooms: (roomId) => {
      return Array.from(get().rooms.values()).filter((room) => room.parentRoomId === roomId);
    },

    getTopLevelRooms: () => {
      return Array.from(get().rooms.values()).filter((room) => !room.parentRoomId);
    },
  }))
);

export function getRoomWallIds(roomId: string): string[] {
  return roomWallIndexById.get(roomId) ?? [];
}

export function getRoomHoles(roomId: string): Point[][] {
  return roomHoleIndexById.get(roomId) ?? [];
}

export function getArchivedRoom(roomId: string): DetectedRoom | null {
  return archivedRooms.get(roomId) ?? null;
}
