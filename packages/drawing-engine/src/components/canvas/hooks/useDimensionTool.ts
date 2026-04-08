/**
 * useDimensionTool
 *
 * Dimension placement + editing interactions.
 */

import * as fabric from 'fabric';
import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';

import type {
  Dimension2D,
  DimensionAnchor,
  DimensionLinearMode,
  DimensionSettings,
  Point2D,
  Room,
  Wall,
  WallSettings,
} from '../../../types';
import { resolveDimensionGeometry } from '../dimension/dimensionGeometry';
import { MM_TO_PX } from '../scale';
import { snapToEndpoint, snapToGrid, snapToMidpoint } from '../wall/WallSnapping';

type FabricObject = fabric.Object & {
  id?: string;
  name?: string;
  wallId?: string;
  roomId?: string;
  dimensionId?: string;
  controlType?: string;
  group?: (fabric.Group & {
    id?: string;
    name?: string;
    wallId?: string;
    roomId?: string;
    dimensionId?: string;
  }) | null;
};

type DimensionPlacementType = 'linear' | 'angular' | 'area';

type PlacementState =
  | { mode: 'idle' }
  | {
      mode: 'linear-first';
      firstPoint: Point2D;
      firstAnchor: DimensionAnchor;
    }
  | {
      mode: 'angular-first';
      firstWallId: string;
    };

type DragState =
  | { mode: 'idle' }
  | {
      mode: 'text';
      dimensionId: string;
      startPointer: Point2D;
      baselineTextPosition: Point2D;
      baselineTextPositionRatio?: number;
      baselineDimensionStart?: Point2D;
      baselineDirection?: Point2D;
      baselineLength?: number;
    }
  | {
      mode: 'offset';
      dimensionId: string;
      startPointer: Point2D;
      baselineOffset: number;
    }
  | {
      mode: 'body';
      dimensionId: string;
      startPointer: Point2D;
      baselineOffset: number;
      baselineTextPosition: Point2D;
      textPositionLocked: boolean;
    };

export interface UseDimensionToolOptions {
  fabricRef: MutableRefObject<fabric.Canvas | null>;
  walls: Wall[];
  rooms: Room[];
  dimensions: Dimension2D[];
  dimensionSettings: DimensionSettings;
  wallSettings: WallSettings;
  zoom: number;
  selectedIds: string[];
  addDimension: (dimension: Omit<Dimension2D, 'id'>, options?: { skipHistory?: boolean }) => string;
  updateDimension: (
    id: string,
    data: Partial<Dimension2D>,
    options?: { skipHistory?: boolean }
  ) => void;
  deleteDimension: (id: string) => void;
  setSelectedIds: (ids: string[]) => void;
  setHoveredElement: (id: string | null) => void;
  setProcessingStatus: (status: string, isProcessing: boolean) => void;
  saveToHistory: (action: string) => void;
}

export interface UseDimensionToolResult {
  handlePlacementMouseDown: (point: Point2D, target?: FabricObject | null) => boolean;
  handlePlacementMouseMove: (point: Point2D) => boolean;
  handleSelectMouseDown: (
    target: FabricObject | null | undefined,
    point: Point2D,
    addToSelection: boolean
  ) => boolean;
  handleSelectMouseMove: (point: Point2D, target: FabricObject | null | undefined) => boolean;
  handleSelectMouseUp: () => boolean;
  handleDoubleClick: (target: FabricObject | null | undefined) => boolean;
  handleDeleteContext: (target: FabricObject | null | undefined) => boolean;
  handleKeyDown: (event: KeyboardEvent) => boolean;
  cancelPlacement: () => void;
  getTargetMeta: (target: FabricObject | null | undefined) => {
    dimensionId: string | undefined;
    wallId: string | undefined;
    roomId: string | undefined;
    controlType: string | undefined;
  };
  isSelectDragActive: () => boolean;
  isPlacingRef: MutableRefObject<PlacementState>;
}

function add(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalize(vector: Point2D): Point2D {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 0.000001) {
    return { x: 1, y: 0 };
  }
  return {
    x: vector.x / length,
    y: vector.y / length,
  };
}

function detectPlacementType(settings: DimensionSettings): DimensionPlacementType {
  return settings.placementType ?? 'linear';
}

function lineIntersection(
  a1: Point2D,
  a2: Point2D,
  b1: Point2D,
  b2: Point2D
): Point2D | null {
  const x1 = a1.x;
  const y1 = a1.y;
  const x2 = a2.x;
  const y2 = a2.y;
  const x3 = b1.x;
  const y3 = b1.y;
  const x4 = b2.x;
  const y4 = b2.y;
  const denominator = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denominator) < 0.000001) return null;
  const cross1 = x1 * y2 - y1 * x2;
  const cross2 = x3 * y4 - y3 * x4;
  return {
    x: (cross1 * (x3 - x4) - (x1 - x2) * cross2) / denominator,
    y: (cross1 * (y3 - y4) - (y1 - y2) * cross2) / denominator,
  };
}

function closestWallCorner(
  point: Point2D,
  walls: Wall[],
  toleranceMm: number
): Point2D | null {
  let best: Point2D | null = null;
  let bestDistance = toleranceMm;
  for (const wall of walls) {
    const corners = [
      wall.interiorLine.start,
      wall.interiorLine.end,
      wall.exteriorLine.start,
      wall.exteriorLine.end,
    ];
    for (const corner of corners) {
      const distance = Math.hypot(point.x - corner.x, point.y - corner.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { ...corner };
      }
    }
  }
  return best;
}

export function useDimensionTool(options: UseDimensionToolOptions): UseDimensionToolResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const placementRef = useRef<PlacementState>({ mode: 'idle' });
  const dragStateRef = useRef<DragState>({ mode: 'idle' });
  const previewObjectsRef = useRef<fabric.FabricObject[]>([]);
  const dragFrameRef = useRef<number | null>(null);
  const dragPointRef = useRef<Point2D | null>(null);

  const clearPreview = useCallback(() => {
    const canvas = optionsRef.current.fabricRef.current;
    if (!canvas) return;
    previewObjectsRef.current.forEach((object) => canvas.remove(object));
    previewObjectsRef.current = [];
    canvas.requestRenderAll();
  }, []);

  const getTargetMeta = useCallback((target: FabricObject | null | undefined) => {
    if (!target) {
      return {
        dimensionId: undefined as string | undefined,
        wallId: undefined as string | undefined,
        roomId: undefined as string | undefined,
        controlType: undefined as string | undefined,
      };
    }
    const group = target.group;
    const dimensionId =
      target.dimensionId ??
      group?.dimensionId ??
      (target.name?.startsWith('dimension-') ? target.id : undefined) ??
      (group?.name?.startsWith('dimension-') ? group.id : undefined);
    return {
      dimensionId,
      wallId:
        target.wallId ??
        group?.wallId ??
        (target.name?.startsWith('wall-') ? target.id : undefined) ??
        (group?.name?.startsWith('wall-') ? group.id : undefined),
      roomId:
        target.roomId ??
        group?.roomId ??
        (target.name?.startsWith('room-') ? target.id : undefined) ??
        (group?.name?.startsWith('room-') ? group.id : undefined),
      controlType: target.controlType,
    };
  }, []);

  const snapPoint = useCallback((point: Point2D): { point: Point2D; anchor: DimensionAnchor } => {
    const { walls, wallSettings, zoom } = optionsRef.current;
    const endpoint = snapToEndpoint(
      point,
      walls,
      wallSettings.endpointSnapTolerance,
      zoom
    );
    if (endpoint) {
      return {
        point: endpoint.snappedPoint,
        anchor: {
          kind: endpoint.endpoint === 'midpoint' ? 'wall-midpoint' : 'wall-endpoint',
          wallId: endpoint.wallId,
          endpoint: endpoint.endpoint === 'start' || endpoint.endpoint === 'end'
            ? endpoint.endpoint
            : undefined,
        },
      };
    }

    const midpoint = snapToMidpoint(
      point,
      walls,
      wallSettings.midpointSnapTolerance,
      zoom
    );
    if (midpoint) {
      return {
        point: midpoint.snappedPoint,
        anchor: { kind: 'wall-midpoint', wallId: midpoint.wallId },
      };
    }

    const toleranceMm = wallSettings.endpointSnapTolerance / zoom / MM_TO_PX;
    const corner = closestWallCorner(point, walls, toleranceMm);
    if (corner) {
      return {
        point: corner,
        anchor: { kind: 'point', point: corner },
      };
    }

    if (wallSettings.snapToGrid) {
      const snapped = snapToGrid(point, wallSettings.gridSize);
      return {
        point: snapped,
        anchor: { kind: 'point', point: snapped },
      };
    }
    return {
      point: { ...point },
      anchor: { kind: 'point', point: { ...point } },
    };
  }, []);

  const renderLinearPreview = useCallback((start: Point2D, end: Point2D) => {
    const canvas = optionsRef.current.fabricRef.current;
    if (!canvas) return;

    clearPreview();

    const dx = Math.abs(end.x - start.x);
    const dy = Math.abs(end.y - start.y);
    const linearMode: DimensionLinearMode =
      Math.min(dx, dy) <= Math.max(dx, dy) * 0.2
        ? (dx >= dy ? 'horizontal' : 'vertical')
        : 'aligned';

    const previewDimension: Dimension2D = {
      id: 'preview',
      type: linearMode === 'aligned' ? 'aligned' : 'linear',
      linearMode,
      points: [start, end],
      value: Math.hypot(end.x - start.x, end.y - start.y),
      unit: 'mm',
      textPosition: {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2,
      },
      visible: true,
      offset: optionsRef.current.dimensionSettings.defaultOffset,
      style: optionsRef.current.dimensionSettings.style,
      precision: optionsRef.current.dimensionSettings.precision,
      displayFormat: optionsRef.current.dimensionSettings.displayFormat,
    };

    const geometry = resolveDimensionGeometry(
      previewDimension,
      optionsRef.current.walls,
      optionsRef.current.rooms,
      optionsRef.current.dimensionSettings
    );
    if (!geometry || geometry.kind !== 'linear') return;

    const extA = new fabric.Line(
      [
        geometry.extensionAStart.x * MM_TO_PX,
        geometry.extensionAStart.y * MM_TO_PX,
        geometry.extensionAEnd.x * MM_TO_PX,
        geometry.extensionAEnd.y * MM_TO_PX,
      ],
      {
        stroke: '#2563EB',
        strokeWidth: 1,
        strokeDashArray: [4, 4],
        selectable: false,
        evented: false,
      }
    );
    const extB = new fabric.Line(
      [
        geometry.extensionBStart.x * MM_TO_PX,
        geometry.extensionBStart.y * MM_TO_PX,
        geometry.extensionBEnd.x * MM_TO_PX,
        geometry.extensionBEnd.y * MM_TO_PX,
      ],
      {
        stroke: '#2563EB',
        strokeWidth: 1,
        strokeDashArray: [4, 4],
        selectable: false,
        evented: false,
      }
    );
    const dimLine = new fabric.Line(
      [
        geometry.dimensionStart.x * MM_TO_PX,
        geometry.dimensionStart.y * MM_TO_PX,
        geometry.dimensionEnd.x * MM_TO_PX,
        geometry.dimensionEnd.y * MM_TO_PX,
      ],
      {
        stroke: '#1D4ED8',
        strokeWidth: 1.4,
        strokeDashArray: [6, 4],
        selectable: false,
        evented: false,
      }
    );
    const text = new fabric.Text(geometry.label, {
      left: geometry.textPosition.x * MM_TO_PX,
      top: geometry.textPosition.y * MM_TO_PX,
      fontSize: 11,
      fill: '#1D4ED8',
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
    });

    previewObjectsRef.current = [extA, extB, dimLine, text];
    previewObjectsRef.current.forEach((object) => canvas.add(object));
    canvas.requestRenderAll();
  }, [clearPreview]);

  const commitLinearDimension = useCallback((start: Point2D, end: Point2D, startAnchor: DimensionAnchor, endAnchor: DimensionAnchor) => {
    const dx = Math.abs(end.x - start.x);
    const dy = Math.abs(end.y - start.y);
    const linearMode: DimensionLinearMode =
      Math.min(dx, dy) <= Math.max(dx, dy) * 0.2
        ? (dx >= dy ? 'horizontal' : 'vertical')
        : 'aligned';

    const id = optionsRef.current.addDimension({
      type: linearMode === 'aligned' ? 'aligned' : 'linear',
      linearMode,
      points: [start, end],
      value: Math.hypot(end.x - start.x, end.y - start.y),
      unit: optionsRef.current.dimensionSettings.unitSystem === 'imperial' ? 'ft-in' : 'mm',
      textPosition: {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2,
      },
      visible: true,
      style: optionsRef.current.dimensionSettings.style,
      precision: optionsRef.current.dimensionSettings.precision,
      displayFormat: optionsRef.current.dimensionSettings.displayFormat,
      offset: optionsRef.current.dimensionSettings.defaultOffset,
      anchors: [startAnchor, endAnchor],
      isAssociative: true,
      textPositionLocked: false,
    });
    optionsRef.current.setSelectedIds([id]);
    optionsRef.current.setProcessingStatus('Dimension added.', false);
  }, []);

  const buildAngularDimensionFromWalls = useCallback((wallA: Wall, wallB: Wall): Omit<Dimension2D, 'id'> | null => {
    const sharedCandidates = [
      [wallA.startPoint, wallB.startPoint],
      [wallA.startPoint, wallB.endPoint],
      [wallA.endPoint, wallB.startPoint],
      [wallA.endPoint, wallB.endPoint],
    ];
    let vertex: Point2D | null = null;
    for (const [a, b] of sharedCandidates) {
      if (Math.hypot(a.x - b.x, a.y - b.y) <= 0.1) {
        vertex = { ...a };
        break;
      }
    }
    if (!vertex) {
      vertex = lineIntersection(wallA.startPoint, wallA.endPoint, wallB.startPoint, wallB.endPoint);
    }
    if (!vertex) return null;

    const legA = Math.hypot(wallA.startPoint.x - vertex.x, wallA.startPoint.y - vertex.y) >
      Math.hypot(wallA.endPoint.x - vertex.x, wallA.endPoint.y - vertex.y)
      ? wallA.startPoint
      : wallA.endPoint;
    const legB = Math.hypot(wallB.startPoint.x - vertex.x, wallB.startPoint.y - vertex.y) >
      Math.hypot(wallB.endPoint.x - vertex.x, wallB.endPoint.y - vertex.y)
      ? wallB.startPoint
      : wallB.endPoint;

    return {
      type: 'angular',
      points: [{ ...vertex }, { ...legA }, { ...legB }],
      value: 0,
      unit: optionsRef.current.dimensionSettings.unitSystem === 'imperial' ? 'ft-in' : 'mm',
      textPosition: { ...vertex },
      visible: true,
      style: optionsRef.current.dimensionSettings.style,
      precision: optionsRef.current.dimensionSettings.precision,
      displayFormat: optionsRef.current.dimensionSettings.displayFormat,
      offset: Math.max(220, optionsRef.current.dimensionSettings.defaultOffset * 0.6),
      anchors: [
        { kind: 'point', point: { ...vertex } },
        { kind: 'point', point: { ...legA } },
        { kind: 'point', point: { ...legB } },
      ],
      isAssociative: true,
      linkedWallIds: [wallA.id, wallB.id],
    };
  }, []);

  const handlePlacementMouseDown = useCallback(
    (point: Point2D, target?: FabricObject | null) => {
      const placementType = detectPlacementType(optionsRef.current.dimensionSettings);
      const meta = getTargetMeta(target ?? null);

      if (placementType === 'area') {
        if (!meta.roomId) {
          optionsRef.current.setProcessingStatus('Area dimension mode: click a room.', false);
          return true;
        }
        const room = optionsRef.current.rooms.find((entry) => entry.id === meta.roomId);
        if (!room) return true;
        const id = optionsRef.current.addDimension({
          type: 'area',
          points: [{ ...room.centroid }],
          value: room.area,
          unit: optionsRef.current.dimensionSettings.unitSystem === 'imperial' ? 'ft-in' : 'mm',
          textPosition: { ...room.centroid },
          visible: true,
          style: optionsRef.current.dimensionSettings.style,
          precision: optionsRef.current.dimensionSettings.precision,
          displayFormat: optionsRef.current.dimensionSettings.displayFormat,
          linkedRoomId: room.id,
          isAssociative: true,
          showPerimeter: optionsRef.current.dimensionSettings.showAreaPerimeter,
          textPositionLocked: false,
        });
        optionsRef.current.setSelectedIds([id]);
        optionsRef.current.setProcessingStatus('Area label added.', false);
        return true;
      }

      if (placementType === 'angular') {
        if (!meta.wallId) {
          optionsRef.current.setProcessingStatus('Angular mode: click first wall.', false);
          return true;
        }
        const angularState = placementRef.current;
        if (angularState.mode !== 'angular-first') {
          placementRef.current = { mode: 'angular-first', firstWallId: meta.wallId };
          optionsRef.current.setProcessingStatus('Angular mode: click second wall.', false);
          return true;
        }
        const firstWall = optionsRef.current.walls.find((wall) => wall.id === angularState.firstWallId);
        const secondWall = optionsRef.current.walls.find((wall) => wall.id === meta.wallId);
        if (!firstWall || !secondWall || firstWall.id === secondWall.id) {
          optionsRef.current.setProcessingStatus('Select a different wall for angular dimension.', false);
          return true;
        }
        const payload = buildAngularDimensionFromWalls(firstWall, secondWall);
        placementRef.current = { mode: 'idle' };
        if (!payload) {
          optionsRef.current.setProcessingStatus('Unable to compute wall angle.', false);
          return true;
        }
        const id = optionsRef.current.addDimension(payload);
        optionsRef.current.setSelectedIds([id]);
        optionsRef.current.setProcessingStatus('Angular dimension added.', false);
        return true;
      }

      const snapped = snapPoint(point);
      const linearState = placementRef.current;
      if (linearState.mode !== 'linear-first') {
        placementRef.current = {
          mode: 'linear-first',
          firstPoint: snapped.point,
          firstAnchor: snapped.anchor,
        };
        optionsRef.current.setProcessingStatus('Dimension start set. Click end point.', false);
        return true;
      }

      const first = linearState.firstPoint;
      const firstAnchor = linearState.firstAnchor;
      placementRef.current = { mode: 'idle' };

      if (Math.hypot(first.x - snapped.point.x, first.y - snapped.point.y) < 1) {
        clearPreview();
        return true;
      }
      commitLinearDimension(first, snapped.point, firstAnchor, snapped.anchor);
      clearPreview();
      return true;
    },
    [
      buildAngularDimensionFromWalls,
      clearPreview,
      commitLinearDimension,
      getTargetMeta,
      snapPoint,
    ]
  );

  const handlePlacementMouseMove = useCallback((point: Point2D) => {
    const placement = placementRef.current;
    if (placement.mode !== 'linear-first') return false;
    const snapped = snapPoint(point);
    renderLinearPreview(placement.firstPoint, snapped.point);
    return true;
  }, [renderLinearPreview, snapPoint]);

  const cancelPlacement = useCallback(() => {
    placementRef.current = { mode: 'idle' };
    clearPreview();
  }, [clearPreview]);

  const isSelectDragActive = useCallback(() => dragStateRef.current.mode !== 'idle', []);

  const applyDrag = useCallback((point: Point2D) => {
    const dragState = dragStateRef.current;
    if (dragState.mode === 'idle') return;
    const dimension = optionsRef.current.dimensions.find((entry) => entry.id === dragState.dimensionId);
    if (!dimension) return;

    if (dragState.mode === 'text') {
      const geometry = resolveDimensionGeometry(
        dimension,
        optionsRef.current.walls,
        optionsRef.current.rooms,
        optionsRef.current.dimensionSettings
      );
      if (
        geometry?.kind === 'linear' &&
        dragState.baselineDirection &&
        dragState.baselineDimensionStart &&
        Number.isFinite(dragState.baselineLength) &&
        Number.isFinite(dragState.baselineTextPositionRatio)
      ) {
        const delta = subtract(point, dragState.startPointer);
        const deltaAlongDirection = dot(delta, dragState.baselineDirection);
        const nextRatio = clamp(
          (dragState.baselineTextPositionRatio as number) +
            deltaAlongDirection / Math.max(dragState.baselineLength as number, 0.000001),
          0.08,
          0.92
        );
        const next = add(
          dragState.baselineDimensionStart,
          {
            x: dragState.baselineDirection.x * (dragState.baselineLength as number) * nextRatio,
            y: dragState.baselineDirection.y * (dragState.baselineLength as number) * nextRatio,
          }
        );
        optionsRef.current.updateDimension(
          dragState.dimensionId,
          {
            textPosition: next,
            textPositionLocked: true,
            textPositionRatio: nextRatio,
          },
          { skipHistory: true }
        );
        return;
      }
      const delta = subtract(point, dragState.startPointer);
      const next = add(dragState.baselineTextPosition, delta);
      optionsRef.current.updateDimension(
        dragState.dimensionId,
        {
          textPosition: next,
          textPositionLocked: true,
          textPositionRatio: undefined,
        },
        { skipHistory: true }
      );
      return;
    }

    if (dragState.mode === 'body') {
      const delta = subtract(point, dragState.startPointer);
      const geometry = resolveDimensionGeometry(
        dimension,
        optionsRef.current.walls,
        optionsRef.current.rooms,
        optionsRef.current.dimensionSettings
      );
      if (!geometry) return;

      if (geometry.kind === 'linear') {
        const deltaAlongNormal = dot(delta, geometry.normal);
        const baselineOffsetSign = dragState.baselineOffset >= 0 ? 1 : -1;
        const normalDelta = {
          x: geometry.normal.x * deltaAlongNormal,
          y: geometry.normal.y * deltaAlongNormal,
        };
        optionsRef.current.updateDimension(
          dragState.dimensionId,
          {
            offset: dragState.baselineOffset + baselineOffsetSign * deltaAlongNormal,
            ...(dragState.textPositionLocked
              ? {
                  textPosition: add(dragState.baselineTextPosition, normalDelta),
                  textPositionLocked: true,
                }
              : {}),
          },
          { skipHistory: true }
        );
        return;
      }

      if (geometry.kind === 'angular') {
        const midAngle = geometry.startAngle + geometry.deltaAngle / 2;
        const radial = normalize({
          x: Math.cos(midAngle),
          y: Math.sin(midAngle),
        });
        const deltaAlongRadius = dot(delta, radial);
        const radialDelta = {
          x: radial.x * deltaAlongRadius,
          y: radial.y * deltaAlongRadius,
        };
        optionsRef.current.updateDimension(
          dragState.dimensionId,
          {
            offset: Math.max(20, dragState.baselineOffset + deltaAlongRadius),
            ...(dragState.textPositionLocked
              ? {
                  textPosition: add(dragState.baselineTextPosition, radialDelta),
                  textPositionLocked: true,
                }
              : {}),
          },
          { skipHistory: true }
        );
        return;
      }

      optionsRef.current.updateDimension(
        dragState.dimensionId,
        {
          textPosition: add(dragState.baselineTextPosition, delta),
          textPositionLocked: true,
        },
        { skipHistory: true }
      );
      return;
    }

    const geometry = resolveDimensionGeometry(
      dimension,
      optionsRef.current.walls,
      optionsRef.current.rooms,
      optionsRef.current.dimensionSettings
    );
    if (!geometry || geometry.kind !== 'linear') return;
    const delta = subtract(point, dragState.startPointer);
    const normal = geometry.normal;
    const deltaAlongNormal = dot(delta, normal);
    const baselineOffsetSign = dragState.baselineOffset >= 0 ? 1 : -1;
    const nextOffset = dragState.baselineOffset + baselineOffsetSign * deltaAlongNormal;
    const isAutoManaged =
      dimension.baselineGroupId === 'auto-exterior' ||
      dimension.baselineGroupId === 'auto-exterior-overall';
    const autoBaseOffset = Number.isFinite(dimension.autoBaseOffset)
      ? (dimension.autoBaseOffset as number)
      : undefined;
    optionsRef.current.updateDimension(
      dragState.dimensionId,
      {
        offset: nextOffset,
        ...(isAutoManaged && autoBaseOffset !== undefined
          ? { autoOffsetAdjustment: nextOffset - autoBaseOffset }
          : {}),
      },
      { skipHistory: true }
    );
  }, []);

  const flushDragFrame = useCallback(() => {
    dragFrameRef.current = null;
    const point = dragPointRef.current;
    dragPointRef.current = null;
    if (!point) return;
    applyDrag(point);
  }, [applyDrag]);

  const scheduleDragFrame = useCallback((point: Point2D) => {
    dragPointRef.current = point;
    if (dragFrameRef.current !== null) return;
    if (typeof window === 'undefined') {
      flushDragFrame();
      return;
    }
    dragFrameRef.current = window.requestAnimationFrame(flushDragFrame);
  }, [flushDragFrame]);

  const handleSelectMouseDown = useCallback(
    (target: FabricObject | null | undefined, point: Point2D, addToSelection: boolean) => {
      const meta = getTargetMeta(target ?? null);
      if (!meta.dimensionId) return false;

      if (meta.controlType === 'dimension-text-handle') {
        const dimension = optionsRef.current.dimensions.find((entry) => entry.id === meta.dimensionId);
        if (!dimension) return false;
        const geometry = resolveDimensionGeometry(
          dimension,
          optionsRef.current.walls,
          optionsRef.current.rooms,
          optionsRef.current.dimensionSettings
        );
        dragStateRef.current = {
          mode: 'text',
          dimensionId: meta.dimensionId,
          startPointer: { ...point },
          baselineTextPosition: { ...dimension.textPosition },
          baselineTextPositionRatio:
            geometry?.kind === 'linear'
              ? (
                Number.isFinite(dimension.textPositionRatio)
                  ? dimension.textPositionRatio
                  : geometry.textPositionRatio
              )
              : undefined,
          baselineDimensionStart:
            geometry?.kind === 'linear' ? { ...geometry.dimensionStart } : undefined,
          baselineDirection:
            geometry?.kind === 'linear' ? { ...geometry.direction } : undefined,
          baselineLength:
            geometry?.kind === 'linear' ? geometry.length : undefined,
        };
        optionsRef.current.setSelectedIds([meta.dimensionId]);
        optionsRef.current.setHoveredElement(meta.dimensionId);
        return true;
      }

      if (meta.controlType === 'dimension-offset-handle') {
        const dimension = optionsRef.current.dimensions.find((entry) => entry.id === meta.dimensionId);
        if (!dimension) return false;
        dragStateRef.current = {
          mode: 'offset',
          dimensionId: meta.dimensionId,
          startPointer: { ...point },
          baselineOffset: dimension.offset ?? optionsRef.current.dimensionSettings.defaultOffset,
        };
        optionsRef.current.setSelectedIds([meta.dimensionId]);
        optionsRef.current.setHoveredElement(meta.dimensionId);
        return true;
      }

      if (addToSelection) {
        const selection = new Set(optionsRef.current.selectedIds);
        if (selection.has(meta.dimensionId)) {
          selection.delete(meta.dimensionId);
        } else {
          selection.add(meta.dimensionId);
        }
        optionsRef.current.setSelectedIds(Array.from(selection));
      } else {
        optionsRef.current.setSelectedIds([meta.dimensionId]);
      }
      optionsRef.current.setHoveredElement(meta.dimensionId);
      return true;
    },
    [getTargetMeta]
  );

  const handleSelectMouseMove = useCallback(
    (point: Point2D, target: FabricObject | null | undefined): boolean => {
      if (dragStateRef.current.mode !== 'idle') {
        scheduleDragFrame(point);
        return true;
      }
      const meta = getTargetMeta(target ?? null);
      if (meta.dimensionId) {
        optionsRef.current.setHoveredElement(meta.dimensionId);
        return true;
      }
      return false;
    },
    [getTargetMeta, scheduleDragFrame]
  );

  const handleSelectMouseUp = useCallback((): boolean => {
    if (dragStateRef.current.mode === 'idle') return false;
    const dimensionId = dragStateRef.current.dimensionId;
    if (dragFrameRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    const pending = dragPointRef.current;
    dragPointRef.current = null;
    if (pending) applyDrag(pending);
    dragStateRef.current = { mode: 'idle' };
    optionsRef.current.setSelectedIds([dimensionId]);
    optionsRef.current.setHoveredElement(dimensionId);
    optionsRef.current.saveToHistory('Edit dimension');
    return true;
  }, [applyDrag]);

  const handleDoubleClick = useCallback((target: FabricObject | null | undefined): boolean => {
    const meta = getTargetMeta(target ?? null);
    if (!meta.dimensionId || typeof window === 'undefined') return false;
    const dimension = optionsRef.current.dimensions.find((entry) => entry.id === meta.dimensionId);
    if (!dimension) return false;
    const nextText = window.prompt('Edit dimension value/label', dimension.text ?? '');
    if (nextText === null) return true;
    optionsRef.current.updateDimension(meta.dimensionId, {
      text: nextText.trim(),
      isDesignValue: nextText.trim().length > 0,
    });
    optionsRef.current.setProcessingStatus('Dimension label updated.', false);
    return true;
  }, [getTargetMeta]);

  const handleDeleteContext = useCallback((target: FabricObject | null | undefined): boolean => {
    const meta = getTargetMeta(target ?? null);
    if (!meta.dimensionId) return false;
    optionsRef.current.deleteDimension(meta.dimensionId);
    return true;
  }, [getTargetMeta]);

  const handleKeyDown = useCallback((event: KeyboardEvent): boolean => {
    if (event.key !== 'Escape') return false;
    if (placementRef.current.mode !== 'idle') {
      cancelPlacement();
      optionsRef.current.setProcessingStatus('Dimension placement canceled.', false);
      return true;
    }
    return false;
  }, [cancelPlacement]);

  useEffect(() => {
    return () => {
      clearPreview();
      if (dragFrameRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(dragFrameRef.current);
      }
    };
  }, [clearPreview]);

  return {
    handlePlacementMouseDown,
    handlePlacementMouseMove,
    handleSelectMouseDown,
    handleSelectMouseMove,
    handleSelectMouseUp,
    handleDoubleClick,
    handleDeleteContext,
    handleKeyDown,
    cancelPlacement,
    getTargetMeta,
    isSelectDragActive,
    isPlacingRef: placementRef,
  };
}
