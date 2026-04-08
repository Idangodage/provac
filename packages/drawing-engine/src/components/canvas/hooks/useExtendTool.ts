/**
 * useExtendTool Hook
 *
 * CAD-style wall extend tool:
 *   1. Activate Extend tool
 *   2. Hover near a wall end to preview extension toward the nearest target wall
 *   3. Click to extend that endpoint and connect both walls
 *   4. Tool stays active; press Escape to return to Select
 */

import * as fabric from 'fabric';
import type { Canvas as FabricCanvas } from 'fabric';
import { useRef, useCallback } from 'react';

import type { Point2D, Wall } from '../../../types';
import type { DrawingTool } from '../../../types';
import { MM_TO_PX } from '../scale';
import {
  add,
  distance,
  dot,
  lineIntersection,
  projectPointToSegment,
  scale,
  segmentIntersection,
  subtract,
} from '../wall/WallGeometry';

export interface UseExtendToolOptions {
  fabricRef: React.RefObject<FabricCanvas | null>;
  walls: Wall[];
  updateWall: (id: string, updates: Partial<Wall>) => void;
  connectWalls: (wallId: string, otherWallId: string) => void;
  setTool: (tool: DrawingTool) => void;
  detectRooms: (options?: { debounce?: boolean }) => void;
  saveToHistory: (action: string) => void;
  setProcessingStatus: (status: string, isProcessing: boolean) => void;
}

export interface UseExtendToolResult {
  handleMouseDown: (scenePoint: Point2D) => void;
  handleMouseMove: (scenePoint: Point2D) => void;
  handleKeyDown: (e: KeyboardEvent) => boolean;
  cleanup: () => void;
}

interface ExtendCandidate {
  mode: 'single' | 'both';
  wall: Wall;
  endpoint: 'start' | 'end';
  targetWall: Wall;
  intersectionPoint: Point2D;
  extensionLength: number;
  targetEndpoint?: 'start' | 'end';
  targetExtensionLength?: number;
  totalExtension: number;
}

type NamedObject = fabric.Object & { name?: string };

const EXTEND_RAY_LENGTH_MM = 1_000_000;
const PICK_PADDING_MM = 32;
const MIN_EXTENSION_MM = 1.5;

const PREVIEW_PRIMARY = '#1D4ED8';
const PREVIEW_UNDERLAY = 'rgba(15, 23, 42, 0.25)';
const PREVIEW_HIGHLIGHT = 'rgba(255, 255, 255, 0.55)';
const PREVIEW_DASH: number[] = [10, 6];
const TARGET_STROKE = '#0F766E';
const TARGET_FILL = 'rgba(15, 118, 110, 0.16)';
const MARKER_STROKE = '#1E40AF';
const BADGE_BG = 'rgba(15, 23, 42, 0.88)';
const BADGE_BORDER = 'rgba(148, 163, 184, 0.55)';

function toCanvasPoint(point: Point2D): Point2D {
  return {
    x: point.x * MM_TO_PX,
    y: point.y * MM_TO_PX,
  };
}

function normalize(vector: Point2D): Point2D {
  const len = Math.hypot(vector.x, vector.y);
  if (len < 0.0001) return { x: 0, y: 0 };
  return { x: vector.x / len, y: vector.y / len };
}

function nearestEndpoint(wall: Wall, point: Point2D): 'start' | 'end' {
  return distance(point, wall.startPoint) <= distance(point, wall.endPoint) ? 'start' : 'end';
}

function wallEndpointPoint(wall: Wall, endpoint: 'start' | 'end'): Point2D {
  return endpoint === 'start' ? wall.startPoint : wall.endPoint;
}

function wallEndpointDirection(wall: Wall, endpoint: 'start' | 'end'): Point2D {
  const extendPoint = endpoint === 'start' ? wall.startPoint : wall.endPoint;
  const fixedPoint = endpoint === 'start' ? wall.endPoint : wall.startPoint;
  return normalize(subtract(extendPoint, fixedPoint));
}

function findWallAtPoint(walls: Wall[], pointMm: Point2D): Wall | null {
  let closestWall: Wall | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const wall of walls) {
    const projection = projectPointToSegment(pointMm, wall.startPoint, wall.endPoint);
    const maxDistance = wall.thickness / 2 + PICK_PADDING_MM;
    if (projection.distance <= maxDistance && projection.distance < closestDistance) {
      closestDistance = projection.distance;
      closestWall = wall;
    }
  }

  return closestWall;
}

function computeExtendCandidate(
  wall: Wall,
  endpoint: 'start' | 'end',
  allWalls: Wall[]
): ExtendCandidate | null {
  const extendPoint = wallEndpointPoint(wall, endpoint);
  const extendDirection = wallEndpointDirection(wall, endpoint);
  if (Math.abs(extendDirection.x) < 0.0001 && Math.abs(extendDirection.y) < 0.0001) {
    return null;
  }

  const rayEnd = add(extendPoint, scale(extendDirection, EXTEND_RAY_LENGTH_MM));
  let bestSingle: ExtendCandidate | null = null;
  let bestBoth: ExtendCandidate | null = null;

  for (const otherWall of allWalls) {
    if (otherWall.id === wall.id) continue;

    const singleIntersection = segmentIntersection(
      extendPoint,
      rayEnd,
      otherWall.startPoint,
      otherWall.endPoint
    );
    if (singleIntersection) {
      const along = dot(subtract(singleIntersection, extendPoint), extendDirection);
      if (Number.isFinite(along) && along > MIN_EXTENSION_MM) {
        const singleCandidate: ExtendCandidate = {
          mode: 'single',
          wall,
          endpoint,
          targetWall: otherWall,
          intersectionPoint: singleIntersection,
          extensionLength: along,
          totalExtension: along,
        };
        if (!bestSingle || singleCandidate.totalExtension < bestSingle.totalExtension) {
          bestSingle = singleCandidate;
        }
      }
    }

    for (const targetEndpoint of ['start', 'end'] as const) {
      const targetPoint = wallEndpointPoint(otherWall, targetEndpoint);
      const targetDirection = wallEndpointDirection(otherWall, targetEndpoint);
      if (Math.abs(targetDirection.x) < 0.0001 && Math.abs(targetDirection.y) < 0.0001) {
        continue;
      }

      const targetRayEnd = add(targetPoint, scale(targetDirection, EXTEND_RAY_LENGTH_MM));
      const dualIntersection = lineIntersection(
        extendPoint,
        rayEnd,
        targetPoint,
        targetRayEnd
      );
      if (!dualIntersection) continue;

      const alongSource = dot(subtract(dualIntersection, extendPoint), extendDirection);
      const alongTargetRaw = dot(subtract(dualIntersection, targetPoint), targetDirection);
      if (!Number.isFinite(alongSource) || !Number.isFinite(alongTargetRaw)) continue;
      if (alongSource <= MIN_EXTENSION_MM) continue;
      if (alongTargetRaw < -0.5) continue;
      const alongTarget = Math.max(0, alongTargetRaw);
      if (alongTarget < MIN_EXTENSION_MM) {
        // If target does not need extension, single-wall mode is preferred.
        continue;
      }

      const dualCandidate: ExtendCandidate = {
        mode: 'both',
        wall,
        endpoint,
        targetWall: otherWall,
        targetEndpoint,
        intersectionPoint: dualIntersection,
        extensionLength: alongSource,
        targetExtensionLength: alongTarget,
        totalExtension: alongSource + alongTarget,
      };
      if (!bestBoth || dualCandidate.totalExtension < bestBoth.totalExtension) {
        bestBoth = dualCandidate;
      }
    }
  }

  // Prefer classic single-wall extend when available.
  return bestSingle ?? bestBoth;
}

export function useExtendTool(options: UseExtendToolOptions): UseExtendToolResult {
  const {
    fabricRef,
    walls,
    updateWall,
    connectWalls,
    setTool,
    detectRooms,
    saveToHistory,
    setProcessingStatus,
  } = options;

  const previewObjectsRef = useRef<fabric.Object[]>([]);

  const clearPreview = useCallback(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    previewObjectsRef.current.forEach((obj) => canvas.remove(obj));
    previewObjectsRef.current = [];
    canvas.requestRenderAll();
  }, [fabricRef]);

  const renderPreview = useCallback((candidate: ExtendCandidate) => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    clearPreview();

    const objects: fabric.Object[] = [];
    const from = candidate.endpoint === 'start' ? candidate.wall.startPoint : candidate.wall.endPoint;
    const fromCanvas = toCanvasPoint(from);
    const intersectionCanvas = toCanvasPoint(candidate.intersectionPoint);
    const targetStart = toCanvasPoint(candidate.targetWall.startPoint);
    const targetEnd = toCanvasPoint(candidate.targetWall.endPoint);
    const targetExtendPoint = candidate.mode === 'both' && candidate.targetEndpoint
      ? wallEndpointPoint(candidate.targetWall, candidate.targetEndpoint)
      : null;
    const targetExtendCanvas = targetExtendPoint ? toCanvasPoint(targetExtendPoint) : null;
    const guideDx = intersectionCanvas.x - fromCanvas.x;
    const guideDy = intersectionCanvas.y - fromCanvas.y;
    const guideLen = Math.hypot(guideDx, guideDy) || 1;
    const guideNx = -guideDy / guideLen;
    const guideNy = guideDx / guideLen;
    const guideMidX = (fromCanvas.x + intersectionCanvas.x) / 2;
    const guideMidY = (fromCanvas.y + intersectionCanvas.y) / 2;

    const targetBand = new fabric.Line(
      [targetStart.x, targetStart.y, targetEnd.x, targetEnd.y],
      {
        stroke: TARGET_FILL,
        strokeWidth: Math.max(candidate.targetWall.thickness * MM_TO_PX * 0.95, 6),
        opacity: 1,
        strokeLineCap: 'round',
        selectable: false,
        evented: false,
      }
    );
    (targetBand as NamedObject).name = 'extend-preview';
    objects.push(targetBand);

    const targetCore = new fabric.Line(
      [targetStart.x, targetStart.y, targetEnd.x, targetEnd.y],
      {
        stroke: TARGET_STROKE,
        strokeWidth: Math.max(candidate.targetWall.thickness * MM_TO_PX * 0.2, 1.5),
        opacity: 0.85,
        selectable: false,
        evented: false,
      }
    );
    (targetCore as NamedObject).name = 'extend-preview';
    objects.push(targetCore);

    const extensionUnderlay = new fabric.Line(
      [fromCanvas.x, fromCanvas.y, intersectionCanvas.x, intersectionCanvas.y],
      {
        stroke: PREVIEW_UNDERLAY,
        strokeWidth: Math.max(candidate.wall.thickness * MM_TO_PX * 0.72, 5),
        strokeLineCap: 'round',
        selectable: false,
        evented: false,
      }
    );
    (extensionUnderlay as NamedObject).name = 'extend-preview';
    objects.push(extensionUnderlay);

    const extensionLine = new fabric.Line(
      [fromCanvas.x, fromCanvas.y, intersectionCanvas.x, intersectionCanvas.y],
      {
        stroke: PREVIEW_PRIMARY,
        strokeWidth: Math.max(candidate.wall.thickness * MM_TO_PX * 0.52, 3),
        strokeLineCap: 'round',
        strokeDashArray: [...PREVIEW_DASH],
        opacity: 1,
        selectable: false,
        evented: false,
      }
    );
    (extensionLine as NamedObject).name = 'extend-preview';
    objects.push(extensionLine);

    const extensionHighlight = new fabric.Line(
      [fromCanvas.x, fromCanvas.y, intersectionCanvas.x, intersectionCanvas.y],
      {
        stroke: PREVIEW_HIGHLIGHT,
        strokeWidth: 1.25,
        strokeLineCap: 'round',
        strokeDashArray: [4, 9],
        opacity: 0.95,
        selectable: false,
        evented: false,
      }
    );
    (extensionHighlight as NamedObject).name = 'extend-preview';
    objects.push(extensionHighlight);

    if (targetExtendCanvas) {
      const targetExtendUnderlay = new fabric.Line(
        [targetExtendCanvas.x, targetExtendCanvas.y, intersectionCanvas.x, intersectionCanvas.y],
        {
          stroke: 'rgba(146, 64, 14, 0.28)',
          strokeWidth: Math.max(candidate.targetWall.thickness * MM_TO_PX * 0.62, 4),
          strokeLineCap: 'round',
          selectable: false,
          evented: false,
        }
      );
      (targetExtendUnderlay as NamedObject).name = 'extend-preview';
      objects.push(targetExtendUnderlay);

      const targetExtendLine = new fabric.Line(
        [targetExtendCanvas.x, targetExtendCanvas.y, intersectionCanvas.x, intersectionCanvas.y],
        {
          stroke: '#C2410C',
          strokeWidth: Math.max(candidate.targetWall.thickness * MM_TO_PX * 0.44, 2.4),
          strokeLineCap: 'round',
          strokeDashArray: [7, 5],
          selectable: false,
          evented: false,
        }
      );
      (targetExtendLine as NamedObject).name = 'extend-preview';
      objects.push(targetExtendLine);

      const targetMarker = new fabric.Circle({
        left: targetExtendCanvas.x,
        top: targetExtendCanvas.y,
        radius: 6.5,
        fill: '#FFFFFF',
        stroke: '#9A3412',
        strokeWidth: 2,
        originX: 'center',
        originY: 'center',
        selectable: false,
        evented: false,
      });
      (targetMarker as NamedObject).name = 'extend-preview';
      objects.push(targetMarker);
    }

    const sourceMarker = new fabric.Circle({
      left: fromCanvas.x,
      top: fromCanvas.y,
      radius: 6.5,
      fill: '#FFFFFF',
      stroke: MARKER_STROKE,
      strokeWidth: 2,
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
    });
    (sourceMarker as NamedObject).name = 'extend-preview';
    objects.push(sourceMarker);

    const intersectionRing = new fabric.Circle({
      left: intersectionCanvas.x,
      top: intersectionCanvas.y,
      radius: 6,
      fill: '#FFFFFF',
      stroke: MARKER_STROKE,
      strokeWidth: 2.2,
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
    });
    (intersectionRing as NamedObject).name = 'extend-preview';
    objects.push(intersectionRing);

    const crossH = new fabric.Line(
      [intersectionCanvas.x - 7, intersectionCanvas.y, intersectionCanvas.x + 7, intersectionCanvas.y],
      {
        stroke: MARKER_STROKE,
        strokeWidth: 1.7,
        selectable: false,
        evented: false,
      }
    );
    (crossH as NamedObject).name = 'extend-preview';
    objects.push(crossH);

    const crossV = new fabric.Line(
      [intersectionCanvas.x, intersectionCanvas.y - 7, intersectionCanvas.x, intersectionCanvas.y + 7],
      {
        stroke: MARKER_STROKE,
        strokeWidth: 1.7,
        selectable: false,
        evented: false,
      }
    );
    (crossV as NamedObject).name = 'extend-preview';
    objects.push(crossV);

    const coreDot = new fabric.Circle({
      left: intersectionCanvas.x,
      top: intersectionCanvas.y,
      radius: 2.5,
      fill: PREVIEW_PRIMARY,
      stroke: '#FFFFFF',
      strokeWidth: 1,
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
    });
    (coreDot as NamedObject).name = 'extend-preview';
    objects.push(coreDot);

    const badgeX = guideMidX + guideNx * 18;
    const badgeY = guideMidY + guideNy * 18;
    const extensionLabel = candidate.mode === 'both' && Number.isFinite(candidate.targetExtensionLength)
      ? `EXT ${Math.round(candidate.extensionLength)} + ${Math.round(candidate.targetExtensionLength ?? 0)} mm`
      : `EXT ${Math.round(candidate.extensionLength)} mm`;
    const label = new fabric.FabricText(extensionLabel, {
      left: badgeX,
      top: badgeY,
      fill: '#F8FAFC',
      fontSize: 11,
      fontFamily: 'Arial',
      fontWeight: 'bold',
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
    });
    const labelWidth = (label.width ?? 64) + 16;
    const labelHeight = (label.height ?? 14) + 8;
    const labelBg = new fabric.Rect({
      left: badgeX,
      top: badgeY,
      width: labelWidth,
      height: labelHeight,
      rx: 6,
      ry: 6,
      fill: BADGE_BG,
      stroke: BADGE_BORDER,
      strokeWidth: 1,
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
    });
    (labelBg as NamedObject).name = 'extend-preview';
    objects.push(labelBg);
    (label as NamedObject).name = 'extend-preview';
    objects.push(label);

    objects.forEach((obj) => canvas.add(obj));
    previewObjectsRef.current = objects;
    canvas.requestRenderAll();
  }, [clearPreview, fabricRef]);

  const resolveCandidateAtPoint = useCallback((scenePoint: Point2D): ExtendCandidate | null => {
    const pointMm = { x: scenePoint.x / MM_TO_PX, y: scenePoint.y / MM_TO_PX };
    const wall = findWallAtPoint(walls, pointMm);
    if (!wall) return null;
    const endpoint = nearestEndpoint(wall, pointMm);
    return computeExtendCandidate(wall, endpoint, walls);
  }, [walls]);

  const handleMouseMove = useCallback((scenePoint: Point2D) => {
    const candidate = resolveCandidateAtPoint(scenePoint);
    if (!candidate) {
      clearPreview();
      setProcessingStatus('Extend: Hover near a wall end to find a target wall.', false);
      return;
    }

    renderPreview(candidate);
    const extra = candidate.mode === 'both' && Number.isFinite(candidate.targetExtensionLength)
      ? ` + ${Math.round(candidate.targetExtensionLength ?? 0)} mm`
      : '';
    setProcessingStatus(
      `Extend: Click to connect walls (${Math.round(candidate.extensionLength)} mm${extra}).`,
      false
    );
  }, [clearPreview, renderPreview, resolveCandidateAtPoint, setProcessingStatus]);

  const handleMouseDown = useCallback((scenePoint: Point2D) => {
    const candidate = resolveCandidateAtPoint(scenePoint);
    if (!candidate) return;

    if (candidate.endpoint === 'start') {
      updateWall(candidate.wall.id, { startPoint: { ...candidate.intersectionPoint } });
    } else {
      updateWall(candidate.wall.id, { endPoint: { ...candidate.intersectionPoint } });
    }

    if (
      candidate.mode === 'both' &&
      candidate.targetEndpoint &&
      Number.isFinite(candidate.targetExtensionLength) &&
      (candidate.targetExtensionLength ?? 0) > MIN_EXTENSION_MM
    ) {
      if (candidate.targetEndpoint === 'start') {
        updateWall(candidate.targetWall.id, { startPoint: { ...candidate.intersectionPoint } });
      } else {
        updateWall(candidate.targetWall.id, { endPoint: { ...candidate.intersectionPoint } });
      }
    }

    connectWalls(candidate.wall.id, candidate.targetWall.id);
    clearPreview();
    detectRooms({ debounce: true });
    saveToHistory(candidate.mode === 'both' ? 'Extend walls to junction' : 'Extend wall');
    const targetPart = candidate.mode === 'both' && Number.isFinite(candidate.targetExtensionLength)
      ? ` + ${Math.round(candidate.targetExtensionLength ?? 0)} mm`
      : '';
    setProcessingStatus(
      `Extended by ${Math.round(candidate.extensionLength)} mm${targetPart} and connected.`,
      false
    );
  }, [
    clearPreview,
    connectWalls,
    detectRooms,
    resolveCandidateAtPoint,
    saveToHistory,
    setProcessingStatus,
    updateWall,
  ]);

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
