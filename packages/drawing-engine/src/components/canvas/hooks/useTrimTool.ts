/**
 * useTrimTool Hook
 *
 * CAD-style wall trim tool (similar to AutoCAD TRIM command):
 *   1. Activate the Trim tool — ALL walls become potential cutting boundaries
 *   2. Hover over a wall segment to see which portion would be trimmed
 *   3. Click to trim the wall at intersection with the nearest boundary wall
 *   4. Tool stays active for more trims; press Escape to exit
 *
 * Trimming splits or shortens a wall at its intersection with another wall.
 */

import * as fabric from 'fabric';
import type { Canvas as FabricCanvas } from 'fabric';
import { useRef, useCallback } from 'react';

import type { Point2D, Wall } from '../../../types';
import type { DrawingTool } from '../../../types';
import { MIN_WALL_LENGTH } from '../../../types/wall';
import { MM_TO_PX } from '../scale';
import {
  distance,
  direction,
  perpendicular,
  dot,
  segmentIntersection,
  projectPointToSegment,
} from '../wall/WallGeometry';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UseTrimToolOptions {
  fabricRef: React.RefObject<FabricCanvas | null>;
  walls: Wall[];
  updateWall: (id: string, updates: Partial<Wall>) => void;
  addWall: (params: { startPoint: Point2D; endPoint: Point2D; thickness?: number }) => string;
  deleteWall: (id: string) => void;
  connectWalls: (wallId: string, otherWallId: string) => void;
  setTool: (tool: DrawingTool) => void;
  detectRooms: (options?: { debounce?: boolean }) => void;
  saveToHistory: (action: string) => void;
  setProcessingStatus: (status: string, isProcessing: boolean) => void;
}

export interface UseTrimToolResult {
  handleMouseDown: (scenePoint: Point2D) => void;
  handleMouseMove: (scenePoint: Point2D) => void;
  handleKeyDown: (e: KeyboardEvent) => boolean;
  cleanup: () => void;
}

interface TrimCandidate {
  wall: Wall;
  /** The intersection point on the wall's centerline (mm) */
  intersectionPoint: Point2D;
  /** The boundary wall causing the cut */
  boundaryWall: Wall;
  /** Parameter t along the wall centerline where intersection occurs (0..1) */
  t: number;
  /** Which side of the click to keep: 'start' keeps startPoint→intersection,
   *  'end' keeps intersection→endPoint */
  keepSide: 'start' | 'end';
}

type NamedObject = fabric.Object & { name?: string };

// ─── Constants ───────────────────────────────────────────────────────────────

const TRIM_PREVIEW_STROKE = '#EF4444'; // red
const TRIM_PREVIEW_FILL = 'rgba(239, 68, 68, 0.15)';
const TRIM_KEEP_STROKE = '#22C55E'; // green
const TRIM_KEEP_FILL = 'rgba(34, 197, 94, 0.10)';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toCanvasPoint(p: Point2D): { x: number; y: number } {
  return { x: p.x * MM_TO_PX, y: p.y * MM_TO_PX };
}

/**
 * Find all intersections between wall's centerline and other walls' centerlines.
 * Returns sorted by t parameter (distance along the wall).
 */
function findWallIntersections(
  wall: Wall,
  allWalls: Wall[],
): Array<{ point: Point2D; t: number; boundaryWall: Wall }> {
  const intersections: Array<{ point: Point2D; t: number; boundaryWall: Wall }> = [];

  for (const other of allWalls) {
    if (other.id === wall.id) continue;

    const ix = segmentIntersection(
      wall.startPoint, wall.endPoint,
      other.startPoint, other.endPoint,
    );
    if (!ix) continue;

    // Compute t parameter along the wall
    const wallDx = wall.endPoint.x - wall.startPoint.x;
    const wallDy = wall.endPoint.y - wall.startPoint.y;
    const wallLenSq = wallDx * wallDx + wallDy * wallDy;
    if (wallLenSq < 0.001) continue;

    const t = ((ix.x - wall.startPoint.x) * wallDx + (ix.y - wall.startPoint.y) * wallDy) / wallLenSq;

    // Only consider intersections within the wall segment (with small margin)
    if (t < 0.01 || t > 0.99) continue;

    intersections.push({ point: ix, t, boundaryWall: other });
  }

  intersections.sort((a, b) => a.t - b.t);
  return intersections;
}

/**
 * Given a wall and a click point, determine the best trim candidate.
 * Finds the nearest intersection(s) to the click and determines which
 * side of the intersection to remove.
 */
function computeTrimCandidate(
  wall: Wall,
  clickPointMm: Point2D,
  allWalls: Wall[],
): TrimCandidate | null {
  const intersections = findWallIntersections(wall, allWalls);
  if (intersections.length === 0) return null;

  // Where along the wall did the user click?
  const proj = projectPointToSegment(clickPointMm, wall.startPoint, wall.endPoint);
  const clickT = proj.t;

  // Find the two intersections bracketing the click point
  let lowerIdx = -1;
  let upperIdx = -1;

  for (let i = 0; i < intersections.length; i++) {
    if (intersections[i].t <= clickT) lowerIdx = i;
    if (intersections[i].t >= clickT && upperIdx === -1) upperIdx = i;
  }

  // Determine what to trim:
  // If click is before first intersection → trim start to first intersection
  // If click is after last intersection → trim last intersection to end
  // If click is between two intersections → trim that segment (shrink wall)
  if (lowerIdx === -1 && upperIdx >= 0) {
    // Click is before first intersection → trim from start
    return {
      wall,
      intersectionPoint: intersections[upperIdx].point,
      boundaryWall: intersections[upperIdx].boundaryWall,
      t: intersections[upperIdx].t,
      keepSide: 'end',
    };
  }

  if (upperIdx === -1 && lowerIdx >= 0) {
    // Click is after last intersection → trim from end
    return {
      wall,
      intersectionPoint: intersections[lowerIdx].point,
      boundaryWall: intersections[lowerIdx].boundaryWall,
      t: intersections[lowerIdx].t,
      keepSide: 'start',
    };
  }

  if (lowerIdx >= 0 && upperIdx >= 0 && lowerIdx !== upperIdx) {
    // Click between two intersections — pick the nearer boundary
    const distToLower = Math.abs(clickT - intersections[lowerIdx].t);
    const distToUpper = Math.abs(intersections[upperIdx].t - clickT);

    if (distToLower <= distToUpper) {
      return {
        wall,
        intersectionPoint: intersections[lowerIdx].point,
        boundaryWall: intersections[lowerIdx].boundaryWall,
        t: intersections[lowerIdx].t,
        keepSide: 'start',
      };
    }
    return {
      wall,
      intersectionPoint: intersections[upperIdx].point,
      boundaryWall: intersections[upperIdx].boundaryWall,
      t: intersections[upperIdx].t,
      keepSide: 'end',
    };
  }

  // Edge case: click is right on the single intersection
  if (lowerIdx === upperIdx && lowerIdx >= 0) {
    return {
      wall,
      intersectionPoint: intersections[lowerIdx].point,
      boundaryWall: intersections[lowerIdx].boundaryWall,
      t: intersections[lowerIdx].t,
      keepSide: clickT <= 0.5 ? 'end' : 'start',
    };
  }

  return null;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useTrimTool(options: UseTrimToolOptions): UseTrimToolResult {
  const {
    fabricRef,
    walls,
    updateWall,
    deleteWall,
    setTool,
    detectRooms,
    saveToHistory,
    setProcessingStatus,
  } = options;

  const previewObjectsRef = useRef<fabric.Object[]>([]);

  // ─── Preview ──────────────────────────────────────────────────────────────

  const clearPreview = useCallback(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    for (const obj of previewObjectsRef.current) {
      canvas.remove(obj);
    }
    previewObjectsRef.current = [];
    canvas.requestRenderAll();
  }, [fabricRef]);

  const renderTrimPreview = useCallback((candidate: TrimCandidate) => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    clearPreview();

    const objects: fabric.Object[] = [];
    const wall = candidate.wall;

    // Determine the segments: kept (green) and trimmed (red)
    let keptStart: Point2D;
    let keptEnd: Point2D;
    let trimmedStart: Point2D;
    let trimmedEnd: Point2D;

    if (candidate.keepSide === 'start') {
      keptStart = wall.startPoint;
      keptEnd = candidate.intersectionPoint;
      trimmedStart = candidate.intersectionPoint;
      trimmedEnd = wall.endPoint;
    } else {
      trimmedStart = wall.startPoint;
      trimmedEnd = candidate.intersectionPoint;
      keptStart = candidate.intersectionPoint;
      keptEnd = wall.endPoint;
    }

    // Kept portion (green highlight)
    const ks = toCanvasPoint(keptStart);
    const ke = toCanvasPoint(keptEnd);
    const keptLine = new fabric.Line([ks.x, ks.y, ke.x, ke.y], {
      stroke: TRIM_KEEP_STROKE,
      strokeWidth: Math.max(wall.thickness * MM_TO_PX * 0.8, 4),
      strokeLineCap: 'round',
      opacity: 0.6,
      selectable: false,
      evented: false,
    });
    (keptLine as NamedObject).name = 'trim-preview';
    objects.push(keptLine);

    // Trimmed portion (red highlight — this will be removed)
    const ts = toCanvasPoint(trimmedStart);
    const te = toCanvasPoint(trimmedEnd);
    const trimmedLine = new fabric.Line([ts.x, ts.y, te.x, te.y], {
      stroke: TRIM_PREVIEW_STROKE,
      strokeWidth: Math.max(wall.thickness * MM_TO_PX * 0.8, 4),
      strokeLineCap: 'round',
      opacity: 0.5,
      selectable: false,
      evented: false,
    });
    (trimmedLine as NamedObject).name = 'trim-preview';
    objects.push(trimmedLine);

    // Intersection marker (scissors icon area)
    const ip = toCanvasPoint(candidate.intersectionPoint);
    const marker = new fabric.Circle({
      left: ip.x,
      top: ip.y,
      radius: 5,
      fill: '#EF4444',
      stroke: '#FFFFFF',
      strokeWidth: 2,
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
    });
    (marker as NamedObject).name = 'trim-preview';
    objects.push(marker);

    objects.forEach((obj) => canvas.add(obj));
    previewObjectsRef.current = objects;
    canvas.requestRenderAll();
  }, [clearPreview, fabricRef]);

  // ─── Find wall under cursor ───────────────────────────────────────────────

  const findWallAtPoint = useCallback((pointMm: Point2D): Wall | null => {
    let closest: Wall | null = null;
    let closestDist = Infinity;

    for (const wall of walls) {
      const proj = projectPointToSegment(pointMm, wall.startPoint, wall.endPoint);
      const maxDist = wall.thickness / 2 + 30; // tolerance
      if (proj.distance < maxDist && proj.distance < closestDist) {
        closestDist = proj.distance;
        closest = wall;
      }
    }
    return closest;
  }, [walls]);

  // ─── Event Handlers ───────────────────────────────────────────────────────

  const handleMouseMove = useCallback((scenePoint: Point2D) => {
    const pointMm = { x: scenePoint.x / MM_TO_PX, y: scenePoint.y / MM_TO_PX };
    const wall = findWallAtPoint(pointMm);

    if (!wall) {
      clearPreview();
      return;
    }

    const candidate = computeTrimCandidate(wall, pointMm, walls);
    if (!candidate) {
      clearPreview();
      setProcessingStatus('Trim: No intersecting wall found for this wall.', false);
      return;
    }

    renderTrimPreview(candidate);
    const trimLength = candidate.keepSide === 'start'
      ? distance(candidate.intersectionPoint, wall.endPoint)
      : distance(wall.startPoint, candidate.intersectionPoint);
    setProcessingStatus(
      `Trim: Click to remove ${Math.round(trimLength)} mm (red segment). Green = kept.`,
      false
    );
  }, [clearPreview, findWallAtPoint, renderTrimPreview, setProcessingStatus, walls]);

  const handleMouseDown = useCallback((scenePoint: Point2D) => {
    const pointMm = { x: scenePoint.x / MM_TO_PX, y: scenePoint.y / MM_TO_PX };
    const wall = findWallAtPoint(pointMm);
    if (!wall) return;

    const candidate = computeTrimCandidate(wall, pointMm, walls);
    if (!candidate) return;

    // Apply the trim: shorten the wall to the kept side
    if (candidate.keepSide === 'start') {
      // Keep startPoint → intersectionPoint
      const newLength = distance(wall.startPoint, candidate.intersectionPoint);
      if (newLength < MIN_WALL_LENGTH) {
        // Wall would be too short — delete it instead
        deleteWall(wall.id);
        setProcessingStatus('Wall deleted (would be too short after trim).', false);
      } else {
        updateWall(wall.id, { endPoint: { ...candidate.intersectionPoint } });
        setProcessingStatus(
          `Trimmed wall to ${Math.round(newLength)} mm.`,
          false
        );
      }
    } else {
      // Keep intersectionPoint → endPoint
      const newLength = distance(candidate.intersectionPoint, wall.endPoint);
      if (newLength < MIN_WALL_LENGTH) {
        deleteWall(wall.id);
        setProcessingStatus('Wall deleted (would be too short after trim).', false);
      } else {
        updateWall(wall.id, { startPoint: { ...candidate.intersectionPoint } });
        setProcessingStatus(
          `Trimmed wall to ${Math.round(newLength)} mm.`,
          false
        );
      }
    }

    clearPreview();
    detectRooms({ debounce: true });
    saveToHistory('Trim wall');
  }, [clearPreview, deleteWall, detectRooms, findWallAtPoint, saveToHistory, setProcessingStatus, updateWall, walls]);

  const handleKeyDown = useCallback((e: KeyboardEvent): boolean => {
    if (e.key === 'Escape') {
      clearPreview();
      setTool('select');
      setProcessingStatus('', false);
      return true;
    }
    return false;
  }, [clearPreview, setProcessingStatus, setTool]);

  const cleanup = useCallback(() => {
    clearPreview();
  }, [clearPreview]);

  return {
    handleMouseDown,
    handleMouseMove,
    handleKeyDown,
    cleanup,
  };
}
