/**
 * useSymbolPlacementTool Hook
 *
 * Handles the complete symbol placement workflow:
 *   1. User selects a symbol from the library (door, window, etc.)
 *   2. Symbol sticks to the mouse cursor
 *   3. When cursor approaches a wall, symbol snaps to the wall:
 *      - Auto-aligns rotation to wall orientation
 *      - Scales to fit wall thickness
 *      - Shows real-time preview with correct architectural representation
 *   4. Click to place the symbol
 *
 * Supports doors, windows, furniture, fixtures, and drawing symbols.
 * Door/window types auto-detect the wall and create Opening entries.
 */

import { useRef, useCallback, useMemo } from 'react';
import type { Canvas as FabricCanvas } from 'fabric';

import type { ArchitecturalObjectDefinition } from '../../../data';
import type { Point2D, Wall, SymbolInstance2D, Opening } from '../../../types';
import { MM_TO_PX } from '../scale';

// =============================================================================
// Types
// =============================================================================

export interface WallSnapInfo {
  wall: Wall;
  /** Projection point on wall center-line (mm) */
  point: Point2D;
  /** Parametric position [0, 1] along wall */
  t: number;
  /** Distance from cursor to wall (mm) */
  distance: number;
  /** Wall angle in degrees */
  angleDeg: number;
  /** Wall perpendicular normal (interior side) */
  normal: Point2D;
  /** Position along wall center-line from start (mm) */
  positionAlongWall: number;
  /** Wall total length (mm) */
  wallLength: number;
}

export interface PlacementState {
  /** Current cursor position in scene mm */
  cursorPoint: Point2D | null;
  /** Computed placement position (snapped) in mm */
  placementPoint: Point2D | null;
  /** Placement rotation in degrees */
  rotationDeg: number;
  /** Snapped wall info (if any) */
  snappedWall: WallSnapInfo | null;
  /** Whether placement is valid (no collision, fits wall) */
  isValid: boolean;
  /** Whether we have an active placement definition */
  isActive: boolean;
}

export interface UseSymbolPlacementToolOptions {
  fabricRef: React.RefObject<FabricCanvas | null>;
  walls: Wall[];
  symbols: SymbolInstance2D[];
  zoom: number;
  /** Snap tolerance in screen pixels */
  snapTolerance?: number;
}

export interface UseSymbolPlacementToolResult {
  /** Update cursor position — call on every mouse move */
  updateCursor: (scenePoint: Point2D, definition: ArchitecturalObjectDefinition | null) => PlacementState;
  /** Attempt to place the symbol at current cursor position */
  place: (
    scenePoint: Point2D,
    definition: ArchitecturalObjectDefinition,
    addSymbol: (payload: Omit<SymbolInstance2D, 'id'>) => string,
    updateWall: (id: string, data: Partial<Wall>, opts?: { skipHistory?: boolean; source?: string }) => void,
  ) => { symbolId: string; opening?: Opening } | null;
  /** Current placement state */
  state: PlacementState;
  /** Reset placement state */
  reset: () => void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_SNAP_TOLERANCE_PX = 80;
const WALL_SNAP_DISTANCE_MM = 150;
const MIN_EDGE_MARGIN_MM = 50;

// =============================================================================
// Implementation
// =============================================================================

function projectToWallSegment(
  point: Point2D,
  wall: Wall,
): { projected: Point2D; t: number; distance: number } {
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 0.001) {
    return { projected: { ...wall.startPoint }, t: 0, distance: Math.hypot(point.x - wall.startPoint.x, point.y - wall.startPoint.y) };
  }
  let t = ((point.x - wall.startPoint.x) * dx + (point.y - wall.startPoint.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projected = {
    x: wall.startPoint.x + dx * t,
    y: wall.startPoint.y + dy * t,
  };
  const distance = Math.hypot(point.x - projected.x, point.y - projected.y);
  return { projected, t, distance };
}

function findNearestWall(
  point: Point2D,
  walls: Wall[],
  maxDistance: number,
): WallSnapInfo | null {
  let best: WallSnapInfo | null = null;

  for (const wall of walls) {
    const { projected, t, distance } = projectToWallSegment(point, wall);
    if (distance > maxDistance) continue;
    if (best && distance >= best.distance) continue;

    const dx = wall.endPoint.x - wall.startPoint.x;
    const dy = wall.endPoint.y - wall.startPoint.y;
    const wallLength = Math.hypot(dx, dy) || 1;
    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const normal = { x: -dy / wallLength, y: dx / wallLength };

    best = {
      wall,
      point: projected,
      t,
      distance,
      angleDeg,
      normal,
      positionAlongWall: t * wallLength,
      wallLength,
    };
  }

  return best;
}

function validatePlacement(
  definition: ArchitecturalObjectDefinition,
  wallSnap: WallSnapInfo | null,
): boolean {
  if (definition.category === 'doors' || definition.category === 'windows') {
    if (!wallSnap) return false;
    // Check opening fits within wall length
    const openingWidth = definition.openingWidthMm ?? definition.widthMm;
    const halfW = openingWidth / 2 + MIN_EDGE_MARGIN_MM;
    if (wallSnap.positionAlongWall < halfW) return false;
    if (wallSnap.positionAlongWall > wallSnap.wallLength - halfW) return false;

    // Check no overlapping openings
    for (const existing of wallSnap.wall.openings) {
      const existHalfW = existing.width / 2;
      const newHalfW = openingWidth / 2;
      const gap = Math.abs(existing.position - wallSnap.positionAlongWall) - existHalfW - newHalfW;
      if (gap < MIN_EDGE_MARGIN_MM) return false;
    }
    return true;
  }

  // Furniture/fixtures are always valid at free positions
  return true;
}

function clampOpeningPosition(
  position: number,
  openingWidth: number,
  wallLength: number,
): number {
  const halfW = openingWidth / 2 + MIN_EDGE_MARGIN_MM;
  return Math.min(Math.max(position, halfW), wallLength - halfW);
}

export function useSymbolPlacementTool({
  walls,
  symbols,
  zoom,
  snapTolerance = DEFAULT_SNAP_TOLERANCE_PX,
}: UseSymbolPlacementToolOptions): UseSymbolPlacementToolResult {
  const stateRef = useRef<PlacementState>({
    cursorPoint: null,
    placementPoint: null,
    rotationDeg: 0,
    snappedWall: null,
    isValid: false,
    isActive: false,
  });

  const maxSnapDistanceMm = useMemo(() => {
    return Math.max(WALL_SNAP_DISTANCE_MM, snapTolerance / (zoom * MM_TO_PX));
  }, [zoom, snapTolerance]);

  const updateCursor = useCallback((
    scenePoint: Point2D,
    definition: ArchitecturalObjectDefinition | null,
  ): PlacementState => {
    if (!definition) {
      stateRef.current = {
        cursorPoint: null,
        placementPoint: null,
        rotationDeg: 0,
        snappedWall: null,
        isValid: false,
        isActive: false,
      };
      return stateRef.current;
    }

    const isDoorOrWindow = definition.category === 'doors' || definition.category === 'windows';
    let wallSnap: WallSnapInfo | null = null;
    let placementPoint = { ...scenePoint };
    let rotationDeg = 0;

    if (isDoorOrWindow) {
      wallSnap = findNearestWall(scenePoint, walls, maxSnapDistanceMm);
      if (wallSnap) {
        // Snap to wall center-line with clamped position
        const openingWidth = definition.openingWidthMm ?? definition.widthMm;
        const clampedPosition = clampOpeningPosition(
          wallSnap.positionAlongWall,
          openingWidth,
          wallSnap.wallLength,
        );
        // Recompute point at clamped position
        const dx = wallSnap.wall.endPoint.x - wallSnap.wall.startPoint.x;
        const dy = wallSnap.wall.endPoint.y - wallSnap.wall.startPoint.y;
        const len = wallSnap.wallLength;
        placementPoint = {
          x: wallSnap.wall.startPoint.x + (dx / len) * clampedPosition,
          y: wallSnap.wall.startPoint.y + (dy / len) * clampedPosition,
        };
        rotationDeg = wallSnap.angleDeg;
        wallSnap = { ...wallSnap, positionAlongWall: clampedPosition, point: placementPoint };
      }
    } else {
      // Furniture: snap to nearby wall edge for alignment
      const nearWall = findNearestWall(scenePoint, walls, maxSnapDistanceMm * 0.5);
      if (nearWall) {
        // Align rotation to wall
        rotationDeg = nearWall.angleDeg;
        // Offset from wall by depth/2
        const offsetDist = (definition.depthMm / 2) + nearWall.wall.thickness / 2 + 20;
        const dot = (scenePoint.x - nearWall.point.x) * nearWall.normal.x +
                    (scenePoint.y - nearWall.point.y) * nearWall.normal.y;
        const side = dot >= 0 ? 1 : -1;
        placementPoint = {
          x: nearWall.point.x + nearWall.normal.x * offsetDist * side,
          y: nearWall.point.y + nearWall.normal.y * offsetDist * side,
        };
      }
    }

    const isValid = validatePlacement(definition, wallSnap);

    stateRef.current = {
      cursorPoint: scenePoint,
      placementPoint,
      rotationDeg,
      snappedWall: wallSnap,
      isValid,
      isActive: true,
    };
    return stateRef.current;
  }, [walls, maxSnapDistanceMm]);

  const place = useCallback((
    scenePoint: Point2D,
    definition: ArchitecturalObjectDefinition,
    addSymbol: (payload: Omit<SymbolInstance2D, 'id'>) => string,
    updateWall: (id: string, data: Partial<Wall>, opts?: { skipHistory?: boolean; source?: string }) => void,
  ): { symbolId: string; opening?: Opening } | null => {
    const state = stateRef.current;
    if (!state.placementPoint) return null;

    const isDoorOrWindow = definition.category === 'doors' || definition.category === 'windows';

    if (isDoorOrWindow && !state.snappedWall) return null;
    if (isDoorOrWindow && !state.isValid) return null;

    // Create symbol instance
    const symbolPayload: Omit<SymbolInstance2D, 'id'> = {
      symbolId: definition.id,
      position: { ...state.placementPoint },
      rotation: state.rotationDeg,
      scale: 1,
      flipped: false,
      properties: {
        definitionId: definition.id,
        category: definition.category,
        type: definition.type,
        widthMm: definition.openingWidthMm ?? definition.widthMm,
        depthMm: state.snappedWall?.wall.thickness ?? definition.depthMm,
        heightMm: definition.heightMm,
        baseElevationMm:
          definition.category === 'windows'
            ? ((state.snappedWall?.wall.properties3D.baseElevation ?? 0) + (definition.sillHeightMm ?? 900))
            : (state.snappedWall?.wall.properties3D.baseElevation ?? 0),
        material: definition.material,
        swingDirection: 'left',
        doorSwingBehavior: definition.category === 'doors' ? 'inward' : undefined,
        doorHingeMode: definition.category === 'doors' ? 'auto-corner' : undefined,
        hostWallId: state.snappedWall?.wall.id,
        hostWallThicknessMm: state.snappedWall?.wall.thickness,
        positionAlongWallMm: state.snappedWall?.positionAlongWall,
        placedAt: new Date().toISOString(),
      },
    };

    const symbolId = addSymbol(symbolPayload);
    let opening: Opening | undefined;

    // For doors/windows, create an Opening entry on the wall
    if (isDoorOrWindow && state.snappedWall) {
      const wall = state.snappedWall.wall;
      const openingWidth = (definition.openingWidthMm ?? definition.widthMm) + 50;
      const position = state.snappedWall.positionAlongWall;

      opening = {
        id: symbolId,
        type: definition.category === 'doors' ? 'door' : 'window',
        position,
        width: openingWidth,
        height: definition.heightMm,
        sillHeight: definition.category === 'windows'
          ? definition.sillHeightMm ?? 900
          : 0,
      };

      updateWall(
        wall.id,
        {
          openings: [...wall.openings, opening],
        },
        { skipHistory: true, source: 'symbol-placement' }
      );
    }

    return { symbolId, opening };
  }, []);

  const reset = useCallback(() => {
    stateRef.current = {
      cursorPoint: null,
      placementPoint: null,
      rotationDeg: 0,
      snappedWall: null,
      isValid: false,
      isActive: false,
    };
  }, []);

  return {
    updateCursor,
    place,
    state: stateRef.current,
    reset,
  };
}
