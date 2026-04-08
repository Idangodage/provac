/**
 * useOffsetTool Hook
 *
 * CAD-style wall offset tool (similar to AutoCAD OFFSET command):
 *   1. Select wall(s) in select mode, then switch to offset tool
 *      — OR — click a wall while in offset tool to pick it
 *   2. Move mouse perpendicular to the wall; ghost copies float with cursor
 *   3. Click to place parallel copies at the indicated distance
 *   4. Tool stays active for more offsets; press Escape to exit
 */

import * as fabric from 'fabric';
import type { Canvas as FabricCanvas } from 'fabric';
import { useRef, useCallback } from 'react';

import type { Point2D, Wall, CreateWallParams } from '../../../types';
import type { DrawingTool } from '../../../types';
import { MM_TO_PX } from '../scale';
import {
  computeOffsetLines,
  distance,
  direction,
  perpendicular,
  dot,
  scale,
  add,
} from '../wall/WallGeometry';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UseOffsetToolOptions {
  fabricRef: React.RefObject<FabricCanvas | null>;
  walls: Wall[];
  selectedIds: string[];
  zoom: number;
  addWall: (params: CreateWallParams) => string;
  setSelectedIds: (ids: string[]) => void;
  setTool: (tool: DrawingTool) => void;
  detectRooms: (options?: { debounce?: boolean }) => void;
  saveToHistory: (action: string) => void;
  setProcessingStatus: (status: string, isProcessing: boolean) => void;
}

export interface UseOffsetToolResult {
  handleMouseDown: (scenePoint: Point2D) => void;
  handleMouseMove: (scenePoint: Point2D) => void;
  handleKeyDown: (e: KeyboardEvent) => boolean;
  cleanup: () => void;
}

interface OffsetState {
  /** Walls being offset */
  sourceWalls: Wall[];
  /** True once user has picked walls and is positioning the offset */
  isPositioning: boolean;
}

type NamedObject = fabric.Object & { name?: string };

// ─── Constants ───────────────────────────────────────────────────────────────

const PREVIEW_FILL = 'rgba(59, 130, 246, 0.20)';
const PREVIEW_STROKE = '#3B82F6';
const PREVIEW_STROKE_WIDTH = 1.5;
const PREVIEW_DASH: number[] = [8, 4];
const DISTANCE_LINE_STROKE = '#B45309';
const DISTANCE_LINE_DASH: number[] = [4, 3];
const SNAP_TO_GRID = 50; // mm grid snap for offset distance

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toCanvasPoint(p: Point2D): { x: number; y: number } {
  return { x: p.x * MM_TO_PX, y: p.y * MM_TO_PX };
}

/**
 * Compute the signed perpendicular distance from a point to the wall's
 * reference centerline. Positive = interior (positive perp) side.
 */
function signedPerpendicularDistance(point: Point2D, wall: Wall): number {
  const dir = direction(wall.startPoint, wall.endPoint);
  const perp = perpendicular(dir);
  const delta = { x: point.x - wall.startPoint.x, y: point.y - wall.startPoint.y };
  return dot(delta, perp);
}

/**
 * Create an offset copy of a wall by a given perpendicular distance.
 * Returns CreateWallParams for the new wall.
 */
function computeOffsetWallParams(wall: Wall, offsetDistance: number): CreateWallParams {
  const dir = direction(wall.startPoint, wall.endPoint);
  const perp = perpendicular(dir);
  const shift = scale(perp, offsetDistance);

  return {
    startPoint: add(wall.startPoint, shift),
    endPoint: add(wall.endPoint, shift),
    thickness: wall.thickness,
    material: wall.material,
    layer: wall.layer,
  };
}

/**
 * Build polygon points for a preview of an offset wall.
 */
function offsetWallPolygon(wall: Wall, offsetDistance: number): Point2D[] {
  const params = computeOffsetWallParams(wall, offsetDistance);
  const { interiorLine, exteriorLine } = computeOffsetLines(
    params.startPoint,
    params.endPoint,
    params.thickness ?? wall.thickness,
  );
  return [
    interiorLine.start,
    interiorLine.end,
    exteriorLine.end,
    exteriorLine.start,
  ];
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useOffsetTool(options: UseOffsetToolOptions): UseOffsetToolResult {
  const {
    fabricRef,
    walls,
    selectedIds,
    addWall,
    setSelectedIds,
    setTool,
    detectRooms,
    saveToHistory,
    setProcessingStatus,
  } = options;

  const stateRef = useRef<OffsetState>({
    sourceWalls: [],
    isPositioning: false,
  });
  const previewObjectsRef = useRef<fabric.Object[]>([]);
  const labelObjectRef = useRef<fabric.Object | null>(null);

  // ─── Preview Management ──────────────────────────────────────────────────

  const clearPreview = useCallback(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;

    for (const obj of previewObjectsRef.current) {
      canvas.remove(obj);
    }
    previewObjectsRef.current = [];

    if (labelObjectRef.current) {
      canvas.remove(labelObjectRef.current);
      labelObjectRef.current = null;
    }

    canvas.requestRenderAll();
  }, [fabricRef]);

  const renderPreview = useCallback((offsetDistance: number, anchorWall: Wall) => {
    const canvas = fabricRef.current;
    if (!canvas) return;

    clearPreview();

    const state = stateRef.current;
    const objects: fabric.Object[] = [];

    for (const wall of state.sourceWalls) {
      // Ghost wall polygon
      const polygon = offsetWallPolygon(wall, offsetDistance);
      const canvasPoints = polygon.map(toCanvasPoint);

      const ghostPoly = new fabric.Polygon(canvasPoints, {
        fill: PREVIEW_FILL,
        stroke: PREVIEW_STROKE,
        strokeWidth: PREVIEW_STROKE_WIDTH,
        strokeDashArray: [...PREVIEW_DASH],
        selectable: false,
        evented: false,
      });
      (ghostPoly as NamedObject).name = 'offset-preview';
      objects.push(ghostPoly);

      // Center line of ghost
      const params = computeOffsetWallParams(wall, offsetDistance);
      const cs = toCanvasPoint(params.startPoint);
      const ce = toCanvasPoint(params.endPoint);
      const ghostCenter = new fabric.Line([cs.x, cs.y, ce.x, ce.y], {
        stroke: PREVIEW_STROKE,
        strokeWidth: 1,
        strokeDashArray: [6, 4],
        selectable: false,
        evented: false,
      });
      (ghostCenter as NamedObject).name = 'offset-preview';
      objects.push(ghostCenter);
    }

    // Distance indicator line from anchor wall center to offset wall center
    const dir = direction(anchorWall.startPoint, anchorWall.endPoint);
    const perp = perpendicular(dir);
    const wallMid = {
      x: (anchorWall.startPoint.x + anchorWall.endPoint.x) / 2,
      y: (anchorWall.startPoint.y + anchorWall.endPoint.y) / 2,
    };
    const offsetMid = add(wallMid, scale(perp, offsetDistance));
    const dm1 = toCanvasPoint(wallMid);
    const dm2 = toCanvasPoint(offsetMid);

    const distLine = new fabric.Line([dm1.x, dm1.y, dm2.x, dm2.y], {
      stroke: DISTANCE_LINE_STROKE,
      strokeWidth: 1,
      strokeDashArray: [...DISTANCE_LINE_DASH],
      selectable: false,
      evented: false,
    });
    (distLine as NamedObject).name = 'offset-preview';
    objects.push(distLine);

    // Distance label
    const labelPos = {
      x: (dm1.x + dm2.x) / 2 + 8,
      y: (dm1.y + dm2.y) / 2 - 8,
    };
    const sign = offsetDistance >= 0 ? '' : '';
    const label = new fabric.FabricText(`${sign}${Math.round(Math.abs(offsetDistance))} mm`, {
      left: labelPos.x,
      top: labelPos.y,
      fill: '#1F2937',
      fontSize: 12,
      fontFamily: 'Arial',
      fontWeight: 'bold',
      backgroundColor: 'rgba(255,255,255,0.9)',
      selectable: false,
      evented: false,
    });
    (label as NamedObject).name = 'offset-preview';
    labelObjectRef.current = label;
    objects.push(label);

    objects.forEach((obj) => canvas.add(obj));
    previewObjectsRef.current = objects;
    canvas.requestRenderAll();
  }, [clearPreview, fabricRef]);

  // ─── Event Handlers ──────────────────────────────────────────────────────

  const handleMouseDown = useCallback((scenePoint: Point2D) => {
    const state = stateRef.current;
    const pointMm = { x: scenePoint.x / MM_TO_PX, y: scenePoint.y / MM_TO_PX };

    if (!state.isPositioning) {
      // Phase 1: Pick source walls
      // If walls are already selected (from select mode), use them
      const preSelected = selectedIds
        .map((id) => walls.find((w) => w.id === id))
        .filter((w): w is Wall => Boolean(w));

      if (preSelected.length > 0) {
        state.sourceWalls = preSelected;
        state.isPositioning = true;
        setProcessingStatus(
          `Offset: ${preSelected.length} wall(s) selected. Move mouse to set distance, click to place.`,
          false
        );
        return;
      }

      // Otherwise, find wall under cursor
      let closestWall: Wall | null = null;
      let closestDist = Infinity;

      for (const wall of walls) {
        // Project point onto wall centerline
        const dx = wall.endPoint.x - wall.startPoint.x;
        const dy = wall.endPoint.y - wall.startPoint.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1) continue;

        const t = Math.max(0, Math.min(1,
          ((pointMm.x - wall.startPoint.x) * dx + (pointMm.y - wall.startPoint.y) * dy) / (len * len)
        ));
        const proj = { x: wall.startPoint.x + t * dx, y: wall.startPoint.y + t * dy };
        const dist = distance(pointMm, proj);

        if (dist < wall.thickness + 50 && dist < closestDist) {
          closestDist = dist;
          closestWall = wall;
        }
      }

      if (closestWall) {
        state.sourceWalls = [closestWall];
        state.isPositioning = true;
        setSelectedIds([closestWall.id]);
        setProcessingStatus(
          'Offset: Move mouse to set distance, click to place.',
          false
        );
      }
      return;
    }

    // Phase 2: Place the offset copies
    if (state.sourceWalls.length === 0) return;

    const anchorWall = state.sourceWalls[0];
    const offsetDistance = signedPerpendicularDistance(pointMm, anchorWall);

    // Snap to grid
    const snappedOffset = Math.abs(offsetDistance) < 10
      ? 0
      : Math.round(offsetDistance / SNAP_TO_GRID) * SNAP_TO_GRID || Math.round(offsetDistance);

    if (Math.abs(snappedOffset) < 10) {
      setProcessingStatus('Offset too small — move further from wall.', false);
      return;
    }

    // Create offset wall copies
    const newWallIds: string[] = [];
    for (const wall of state.sourceWalls) {
      const params = computeOffsetWallParams(wall, snappedOffset);
      const newId = addWall(params);
      newWallIds.push(newId);
    }

    clearPreview();
    detectRooms({ debounce: true });
    saveToHistory(`Offset ${state.sourceWalls.length} wall(s) by ${Math.round(snappedOffset)} mm`);
    setSelectedIds(newWallIds);
    setProcessingStatus(
      `Placed ${newWallIds.length} offset wall(s) at ${Math.abs(Math.round(snappedOffset))} mm. Click to offset again or press Escape.`,
      false
    );

    // Keep tool active with new walls as source for chaining
    state.sourceWalls = newWallIds
      .map((id) => walls.find((w) => w.id === id))
      .filter((w): w is Wall => Boolean(w));

    // Source walls may not be in the store yet — fall back to re-picking
    if (state.sourceWalls.length === 0) {
      state.isPositioning = false;
    }
  }, [addWall, clearPreview, detectRooms, saveToHistory, selectedIds, setProcessingStatus, setSelectedIds, walls]);

  const handleMouseMove = useCallback((scenePoint: Point2D) => {
    const state = stateRef.current;
    if (!state.isPositioning || state.sourceWalls.length === 0) return;

    const pointMm = { x: scenePoint.x / MM_TO_PX, y: scenePoint.y / MM_TO_PX };
    const anchorWall = state.sourceWalls[0];
    const rawOffset = signedPerpendicularDistance(pointMm, anchorWall);

    // Snap to grid increments
    const snappedOffset = Math.abs(rawOffset) < 10
      ? 0
      : Math.round(rawOffset / SNAP_TO_GRID) * SNAP_TO_GRID || Math.round(rawOffset);

    renderPreview(snappedOffset, anchorWall);
  }, [renderPreview]);

  const handleKeyDown = useCallback((e: KeyboardEvent): boolean => {
    if (e.key === 'Escape') {
      clearPreview();
      stateRef.current = { sourceWalls: [], isPositioning: false };
      setTool('select');
      setProcessingStatus('', false);
      return true;
    }
    return false;
  }, [clearPreview, setProcessingStatus, setTool]);

  const cleanup = useCallback(() => {
    clearPreview();
    stateRef.current = { sourceWalls: [], isPositioning: false };
  }, [clearPreview]);

  return {
    handleMouseDown,
    handleMouseMove,
    handleKeyDown,
    cleanup,
  };
}
