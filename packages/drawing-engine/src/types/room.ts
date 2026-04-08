/**
 * Smart room detection types for legacy room pipelines.
 */

export interface WallSegment {
  id: string;
  startPoint: { x: number; y: number };
  endPoint: { x: number; y: number };
  thickness: number; // default 8px
  snapToGrid: boolean;
  parentRoomId?: string; // set when wall divides an existing room
  startBevel: RoomWallBevelControl;
  endBevel: RoomWallBevelControl;
}

export interface RoomWallBevelControl {
  outerOffset: number;
  innerOffset: number;
}

export interface RoomLabelTag {
  roomId: string;
  text: string; // room name + area e.g. "Room 1 \n 24.5 m²"
  position: { x: number; y: number }; // centroid offset
  visible: boolean;
  fontSize: number; // scales with room size, min 10 max 16
  pinned: boolean; // if user manually repositioned the tag
}

export interface DetectedRoom {
  id: string;
  name: string; // e.g. "Room 1", "Room 2" -- auto-incremented
  polygon: Array<{ x: number; y: number }>; // ordered vertices
  area: number; // in canvas units squared
  centroid: { x: number; y: number }; // for label placement
  parentRoomId?: string; // if this is a sub-room
  childRoomIds: string[]; // sub-rooms carved from this room
  depth: number; // nesting depth (0 = top-level)
  color: string; // auto-assigned fill with opacity 0.15
  labelTag: RoomLabelTag;
  isActive: boolean;
  createdAt: number;
}

export interface RoomDetectionConfig {
  snapTolerance: number; // px distance to snap endpoints (default 10)
  minRoomArea: number; // ignore tiny polygons below this (default 500)
  wallSnapAngles: number[]; // snap to these angles [0, 45, 90, 135, 180, ...]
  autoNamePrefix: string; // default "Room"
  subRoomPrefix: string; // default "Sub-Room"
  colorPalette: string[]; // hex colors cycled for new rooms
}

export const DEFAULT_ROOM_DETECTION_CONFIG: RoomDetectionConfig = {
  snapTolerance: 10,
  minRoomArea: 500,
  wallSnapAngles: [0, 45, 90, 135, 180, 225, 270, 315],
  autoNamePrefix: 'Room',
  subRoomPrefix: 'Sub-Room',
  colorPalette: [
    '#3B82F6',
    '#10B981',
    '#F59E0B',
    '#EF4444',
    '#8B5CF6',
    '#14B8A6',
    '#EC4899',
    '#6366F1',
  ],
};

export const ROOM_LABEL_MIN_FONT = 10;
export const ROOM_LABEL_MAX_FONT = 16;
