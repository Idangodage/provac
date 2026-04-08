/**
 * Wall Slice
 *
 * Domain-specific slice for wall drawing state and actions.
 */

import type { StateCreator } from 'zustand';

import type {
  Wall,
  WallDrawingState,
  WallSettings,
  WallMaterial,
  WallLayer,
  CreateWallParams,
  RoomConfig,
  Line,
  Point2D,
} from '../../types';
import {
  DEFAULT_WALL_3D,
  DEFAULT_BEVEL_CONTROL,
  DEFAULT_WALL_SETTINGS,
  DEFAULT_WALL_DRAWING_STATE,
  DEFAULT_WALL_THICKNESS,
  MAX_WALL_HEIGHT,
  MAX_WALL_THICKNESS,
  MAX_WALL_CENTERLINE_OFFSET,
  MIN_WALL_HEIGHT,
  MIN_WALL_LENGTH,
  MIN_WALL_THICKNESS,
} from '../../types/wall';
import { generateId } from '../../utils/geometry';
import { deepClone } from '../helpers';

// =============================================================================
// Types
// =============================================================================

export interface WallSliceState {
  walls: Wall[];
  wallDrawingState: WallDrawingState;
  wallSettings: WallSettings;
}

export interface WallSliceActions {
  // Wall CRUD
  addWall: (params: CreateWallParams) => string;
  updateWall: (id: string, updates: Partial<Wall>) => void;
  deleteWall: (id: string) => void;
  getWall: (id: string) => Wall | undefined;

  // Drawing state
  startWallDrawing: (startPoint: Point2D) => void;
  updateWallPreview: (currentPoint: Point2D) => void;
  commitWall: () => string | null;
  cancelWallDrawing: () => void;
  setChainMode: (enabled: boolean) => void;

  // Wall connections
  connectWalls: (wallId: string, otherWallId: string) => void;
  disconnectWall: (wallId: string, otherWallId: string) => void;

  // Settings
  setWallSettings: (settings: Partial<WallSettings>) => void;
  setWallPreviewMaterial: (material: WallMaterial) => void;
  setWallPreviewThickness: (thickness: number) => void;

  // Room creation
  createRoomWalls: (config: RoomConfig, startCorner: Point2D) => string[];

  // Bulk operations
  deleteWalls: (ids: string[]) => void;
  clearAllWalls: () => void;
}

export type WallSlice = WallSliceState & WallSliceActions;

// =============================================================================
// Helpers
// =============================================================================

function clampThickness(thickness: number): number {
  return Math.min(MAX_WALL_THICKNESS, Math.max(MIN_WALL_THICKNESS, thickness));
}

function clampHeight(height: number): number {
  return Math.min(MAX_WALL_HEIGHT, Math.max(MIN_WALL_HEIGHT, height));
}

/**
 * Compute offset lines (interior and exterior) from center-line
 */
function computeOffsetLines(
  startPoint: Point2D,
  endPoint: Point2D,
  thickness: number,
  centerlineOffset: number = 0,
): { interiorLine: Line; exteriorLine: Line } {
  const dx = endPoint.x - startPoint.x;
  const dy = endPoint.y - startPoint.y;
  const length = Math.sqrt(dx * dx + dy * dy) || 1;

  // Perpendicular unit vector (pointing "left" of the direction)
  const perpX = -dy / length;
  const perpY = dx / length;

  const halfThickness = thickness / 2;

  // Interior line (offset in positive perpendicular direction + centerlineOffset)
  const interiorLine: Line = {
    start: {
      x: startPoint.x + perpX * (centerlineOffset + halfThickness),
      y: startPoint.y + perpY * (centerlineOffset + halfThickness),
    },
    end: {
      x: endPoint.x + perpX * (centerlineOffset + halfThickness),
      y: endPoint.y + perpY * (centerlineOffset + halfThickness),
    },
  };

  // Exterior line (offset in negative perpendicular direction + centerlineOffset)
  const exteriorLine: Line = {
    start: {
      x: startPoint.x + perpX * (centerlineOffset - halfThickness),
      y: startPoint.y + perpY * (centerlineOffset - halfThickness),
    },
    end: {
      x: endPoint.x + perpX * (centerlineOffset - halfThickness),
      y: endPoint.y + perpY * (centerlineOffset - halfThickness),
    },
  };

  return { interiorLine, exteriorLine };
}

/**
 * Create a new wall from parameters
 */
function createWall(params: CreateWallParams): Wall {
  const thickness = clampThickness(
    params.thickness ?? DEFAULT_WALL_THICKNESS[params.layer ?? 'partition']
  );
  const material = params.material ?? 'brick';
  const layer = params.layer ?? 'partition';

  const centerlineOffset = params.centerlineOffset ?? 0;
  const { interiorLine, exteriorLine } = computeOffsetLines(
    params.startPoint,
    params.endPoint,
    thickness,
    centerlineOffset,
  );
  const length = Math.sqrt(
    (params.endPoint.x - params.startPoint.x) ** 2 +
    (params.endPoint.y - params.startPoint.y) ** 2
  );
  const height = clampHeight(DEFAULT_WALL_SETTINGS.defaultHeight);
  const volume = (length * thickness * height) / 1_000_000_000;

  return {
    id: generateId(),
    startPoint: { ...params.startPoint },
    endPoint: { ...params.endPoint },
    thickness,
    centerlineOffset,
    material,
    layer,
    interiorLine,
    exteriorLine,
    startBevel: { ...DEFAULT_BEVEL_CONTROL },
    endBevel: { ...DEFAULT_BEVEL_CONTROL },
    connectedWalls: [],
    openings: [],
    properties3D: {
      ...DEFAULT_WALL_3D,
      height,
      computedLength: length,
      computedVolumeM3: volume,
    },
  };
}

/**
 * Update wall's offset lines when geometry changes
 */
function recomputeWallGeometry(wall: Wall): Wall {
  const { interiorLine, exteriorLine } = computeOffsetLines(
    wall.startPoint,
    wall.endPoint,
    wall.thickness,
    wall.centerlineOffset ?? 0,
  );
  const length = Math.sqrt(
    (wall.endPoint.x - wall.startPoint.x) ** 2 +
    (wall.endPoint.y - wall.startPoint.y) ** 2
  );
  const height = clampHeight(wall.properties3D?.height ?? DEFAULT_WALL_3D.height);
  const volume = (length * wall.thickness * height) / 1_000_000_000;
  return {
    ...wall,
    interiorLine,
    exteriorLine,
    properties3D: {
      ...wall.properties3D,
      height,
      computedLength: length,
      computedVolumeM3: volume,
    },
  };
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createWallSlice: StateCreator<WallSlice, [], [], WallSlice> = (set, get) => ({
  // Initial State
  walls: [],
  wallDrawingState: deepClone(DEFAULT_WALL_DRAWING_STATE),
  wallSettings: deepClone(DEFAULT_WALL_SETTINGS),

  // ==========================================================================
  // Wall CRUD Actions
  // ==========================================================================

  addWall: (params) => {
    const wall = createWall(params);
    set((state) => ({
      walls: [...state.walls, wall],
    }));
    return wall.id;
  },

  updateWall: (id, updates) => {
    set((state) => ({
      walls: state.walls.map((wall) => {
        if (wall.id !== id) return wall;

        const updatedWall = { ...wall, ...updates };

        // Recompute geometry if relevant fields changed
        if (
          updates.startPoint ||
          updates.endPoint ||
          updates.thickness ||
          updates.centerlineOffset !== undefined
        ) {
          return recomputeWallGeometry(updatedWall);
        }

        return updatedWall;
      }),
    }));
  },

  deleteWall: (id) => {
    const state = get();
    const wallToDelete = state.walls.find((w) => w.id === id);

    if (!wallToDelete) return;

    // Clean up connections in other walls
    const updatedWalls = state.walls
      .filter((w) => w.id !== id)
      .map((wall) => ({
        ...wall,
        connectedWalls: wall.connectedWalls.filter((cid) => cid !== id),
      }));

    set({ walls: updatedWalls });
  },

  getWall: (id) => {
    return get().walls.find((w) => w.id === id);
  },

  // ==========================================================================
  // Drawing State Actions
  // ==========================================================================

  startWallDrawing: (startPoint) => {
    const { wallSettings } = get();
    set({
      wallDrawingState: {
        isDrawing: true,
        startPoint: { ...startPoint },
        currentPoint: { ...startPoint },
        chainMode: wallSettings.chainModeEnabled,
        previewThickness: clampThickness(wallSettings.defaultThickness),
        previewMaterial: wallSettings.defaultMaterial,
      },
    });
  },

  updateWallPreview: (currentPoint) => {
    set((state) => ({
      wallDrawingState: {
        ...state.wallDrawingState,
        currentPoint: { ...currentPoint },
      },
    }));
  },

  commitWall: () => {
    const { wallDrawingState, wallSettings } = get();

    if (!wallDrawingState.isDrawing || !wallDrawingState.startPoint || !wallDrawingState.currentPoint) {
      return null;
    }

    // Don't create zero-length walls
    const dx = wallDrawingState.currentPoint.x - wallDrawingState.startPoint.x;
    const dy = wallDrawingState.currentPoint.y - wallDrawingState.startPoint.y;
    const length = Math.sqrt(dx * dx + dy * dy);

    if (length < MIN_WALL_LENGTH) {
      // Reject walls shorter than minimum configured architectural length.
      return null;
    }

    // Create the wall
    const wallId = get().addWall({
      startPoint: wallDrawingState.startPoint,
      endPoint: wallDrawingState.currentPoint,
      thickness: wallDrawingState.previewThickness,
      material: wallDrawingState.previewMaterial,
      layer: wallSettings.defaultLayer,
    });

    // If chain mode, start next wall from current endpoint
    if (wallDrawingState.chainMode) {
      set({
        wallDrawingState: {
          ...wallDrawingState,
          startPoint: { ...wallDrawingState.currentPoint },
          currentPoint: { ...wallDrawingState.currentPoint },
        },
      });
    } else {
      // Exit drawing mode
      set({
        wallDrawingState: deepClone(DEFAULT_WALL_DRAWING_STATE),
      });
    }

    return wallId;
  },

  cancelWallDrawing: () => {
    set({
      wallDrawingState: deepClone(DEFAULT_WALL_DRAWING_STATE),
    });
  },

  setChainMode: (enabled) => {
    set((state) => ({
      wallDrawingState: {
        ...state.wallDrawingState,
        chainMode: enabled,
      },
      wallSettings: {
        ...state.wallSettings,
        chainModeEnabled: enabled,
      },
    }));
  },

  // ==========================================================================
  // Wall Connection Actions
  // ==========================================================================

  connectWalls: (wallId, otherWallId) => {
    if (wallId === otherWallId) return;

    set((state) => ({
      walls: state.walls.map((wall) => {
        if (wall.id === wallId && !wall.connectedWalls.includes(otherWallId)) {
          return { ...wall, connectedWalls: [...wall.connectedWalls, otherWallId] };
        }
        if (wall.id === otherWallId && !wall.connectedWalls.includes(wallId)) {
          return { ...wall, connectedWalls: [...wall.connectedWalls, wallId] };
        }
        return wall;
      }),
    }));
  },

  disconnectWall: (wallId, otherWallId) => {
    set((state) => ({
      walls: state.walls.map((wall) => {
        if (wall.id === wallId || wall.id === otherWallId) {
          const filteredConnections = wall.connectedWalls.filter(
            (id) => id !== wallId && id !== otherWallId
          );
          return { ...wall, connectedWalls: filteredConnections };
        }
        return wall;
      }),
    }));
  },

  // ==========================================================================
  // Settings Actions
  // ==========================================================================

  setWallSettings: (settings) => {
    const safeSettings = { ...settings };
    if (safeSettings.defaultThickness !== undefined) {
      safeSettings.defaultThickness = clampThickness(safeSettings.defaultThickness);
    }
    if (safeSettings.defaultHeight !== undefined) {
      safeSettings.defaultHeight = clampHeight(safeSettings.defaultHeight);
    }
    if (safeSettings.defaultLayerCount !== undefined) {
      safeSettings.defaultLayerCount = Math.max(1, Math.round(safeSettings.defaultLayerCount));
    }
    if (safeSettings.gridSize !== undefined) {
      safeSettings.gridSize = Math.max(1, safeSettings.gridSize);
    }

    set((state) => ({
      wallSettings: { ...state.wallSettings, ...safeSettings },
    }));
  },

  setWallPreviewMaterial: (material) => {
    set((state) => ({
      wallDrawingState: {
        ...state.wallDrawingState,
        previewMaterial: material,
      },
    }));
  },

  setWallPreviewThickness: (thickness) => {
    set((state) => ({
      wallDrawingState: {
        ...state.wallDrawingState,
        previewThickness: clampThickness(thickness),
      },
    }));
  },

  // ==========================================================================
  // Room Creation
  // ==========================================================================

  createRoomWalls: (config, startCorner) => {
    const { width, height, wallThickness, material } = config;

    // Determine layer based on material
    const layer: WallLayer = material === 'partition' ? 'partition' : 'structural';

    // Calculate corner points (using center-lines)
    // Start corner is bottom-left in architectural coords (Y-up)
    const corners: Point2D[] = [
      startCorner,                                              // bottom-left
      { x: startCorner.x + width, y: startCorner.y },          // bottom-right
      { x: startCorner.x + width, y: startCorner.y + height }, // top-right
      { x: startCorner.x, y: startCorner.y + height },         // top-left
    ];

    // Create 4 walls
    const wallIds: string[] = [];
    const state = get();

    for (let i = 0; i < 4; i++) {
      const start = corners[i];
      const end = corners[(i + 1) % 4];

      const wallId = state.addWall({
        startPoint: start,
        endPoint: end,
        thickness: wallThickness,
        material,
        layer,
      });

      wallIds.push(wallId);
    }

    // Connect walls
    for (let i = 0; i < 4; i++) {
      const currentId = wallIds[i];
      const nextId = wallIds[(i + 1) % 4];
      get().connectWalls(currentId, nextId);
    }

    return wallIds;
  },

  // ==========================================================================
  // Bulk Operations
  // ==========================================================================

  deleteWalls: (ids) => {
    const idsSet = new Set(ids);

    set((state) => ({
      walls: state.walls
        .filter((w) => !idsSet.has(w.id))
        .map((wall) => ({
          ...wall,
          connectedWalls: wall.connectedWalls.filter((cid) => !idsSet.has(cid)),
        })),
    }));
  },

  clearAllWalls: () => {
    set({ walls: [] });
  },
});
