/**
 * useRoomTool Hook
 *
 * 2-click rectangular room workflow:
 * - First click: set first corner.
 * - Second click: commit rectangle walls immediately.
 */

import { useState, useCallback } from 'react';

import type { Point2D, RoomConfig, WallMaterial } from '../../../types';
import { snapToGrid } from '../wall/WallSnapping';

// =============================================================================
// Types
// =============================================================================

export interface UseRoomToolOptions {
  gridSize: number;
  wallThickness: number;
  wallMaterial: WallMaterial;
  snapPoint?: (scenePoint: Point2D) => Point2D;
  createRoomWalls: (config: RoomConfig, startCorner: Point2D) => string[];
  onRoomCreated?: (wallIds: string[]) => void;
}

export interface UseRoomToolResult {
  isDrawing: boolean;
  startCorner: Point2D | null;
  currentCorner: Point2D | null;
  handleMouseDown: (scenePoint: Point2D) => void;
  handleMouseMove: (scenePoint: Point2D) => void;
  cancelRoomCreation: () => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

const MIN_ROOM_EDGE_MM = 100;

export function useRoomTool({
  gridSize,
  wallThickness,
  wallMaterial,
  snapPoint,
  createRoomWalls,
  onRoomCreated,
}: UseRoomToolOptions): UseRoomToolResult {
  const [startCorner, setStartCorner] = useState<Point2D | null>(null);
  const [currentCorner, setCurrentCorner] = useState<Point2D | null>(null);

  const handleMouseDown = useCallback(
    (scenePoint: Point2D) => {
      const snapped = snapPoint
        ? snapPoint(scenePoint)
        : snapToGrid(scenePoint, gridSize);

      if (!startCorner) {
        setStartCorner(snapped);
        setCurrentCorner(snapped);
        return;
      }

      const minX = Math.min(startCorner.x, snapped.x);
      const minY = Math.min(startCorner.y, snapped.y);
      const width = Math.abs(snapped.x - startCorner.x);
      const height = Math.abs(snapped.y - startCorner.y);

      if (width < MIN_ROOM_EDGE_MM || height < MIN_ROOM_EDGE_MM) {
        setCurrentCorner(snapped);
        return;
      }

      const roomConfig: RoomConfig = {
        width,
        height,
        wallThickness,
        material: wallMaterial,
      };
      const wallIds = createRoomWalls(roomConfig, { x: minX, y: minY });
      if (wallIds.length === 4) {
        onRoomCreated?.(wallIds);
      }

      setStartCorner(null);
      setCurrentCorner(null);
    },
    [gridSize, snapPoint, startCorner, wallThickness, wallMaterial, createRoomWalls, onRoomCreated]
  );

  const handleMouseMove = useCallback(
    (scenePoint: Point2D) => {
      if (!startCorner) return;
      const snapped = snapPoint
        ? snapPoint(scenePoint)
        : snapToGrid(scenePoint, gridSize);
      setCurrentCorner(snapped);
    },
    [gridSize, snapPoint, startCorner]
  );

  const cancelRoomCreation = useCallback(() => {
    setStartCorner(null);
    setCurrentCorner(null);
  }, []);

  return {
    isDrawing: Boolean(startCorner),
    startCorner,
    currentCorner,
    handleMouseDown,
    handleMouseMove,
    cancelRoomCreation,
  };
}
