import type Konva from 'konva';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Group, Layer, Line, Stage } from 'react-konva/lib/ReactKonvaCore';
import 'konva/lib/shapes/Circle';
import 'konva/lib/shapes/Line';

import type { HvacElement, Point2D, WallSettings } from '../../../types';
import { viewportToViewTransform } from '../coordinateTransform';
import { MM_TO_PX } from '../scale';
import { viewTransformToKonvaLayer } from '../viewTransform';

import { beginPipeDrag, type PipeDragSession } from './pipeDragSession';
import { withCanonicalPipeRoute } from './pipeRoute3d';
import {
  buildRefrigerantPipeVisual,
  constrainRefrigerantPipeRouteForConnections,
  resolveRefrigerantPipeSpec,
  type RefrigerantPipeMaterial,
  type RefrigerantPipeVisualSpec,
} from './refrigerantPipePairModel';

type HardDirection8 = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

interface PipeKonvaInteractionLayerProps {
  enabled: boolean;
  width: number;
  height: number;
  viewportZoom: number;
  panOffset: Point2D;
  hvacElements: HvacElement[];
  selectedIds: string[];
  wallSettings: WallSettings;
  updateHvacElement: (
    id: string,
    updates: Partial<HvacElement>,
    options?: { skipHistory?: boolean },
  ) => void;
  saveToHistory: (action: string) => void;
  setProcessingStatus: (status: string, isProcessing: boolean) => void;
  setSelectedIds: (ids: string[]) => void;
}

interface SegmentHandleSpec {
  pipeId: string;
  startIndex: number;
  endIndex: number;
  point: Point2D;
}

interface VertexHandleSpec {
  pipeId: string;
  vertexIndex: number;
  point: Point2D;
  endpoint: boolean;
}

interface SegmentDragState {
  kind: 'segment';
  pipeId: string;
  startIndex: number;
  endIndex: number;
  lockStart: boolean;
  lockEnd: boolean;
  startHandlePoint: Point2D;
  lastValidHandlePoint: Point2D;
  baselineRoutePoints: Point2D[];
  segmentMaterials: RefrigerantPipeMaterial[];
  baselineProperties: Record<string, unknown>;
  session: PipeDragSession;
}

interface VertexDragState {
  kind: 'vertex';
  pipeId: string;
  vertexIndex: number;
  lastValidPoint: Point2D;
  baselineRoutePoints: Point2D[];
  segmentMaterials: RefrigerantPipeMaterial[];
  baselineProperties: Record<string, unknown>;
  session: PipeDragSession;
}

type DragState = SegmentDragState | VertexDragState;

interface PipeDragPreview {
  pipeId: string;
  routePoints: Point2D[];
  segmentMaterials: RefrigerantPipeMaterial[];
  visual: RefrigerantPipeVisualSpec;
}

const HARD_ZERO_LENGTH_TOLERANCE_MM = 0.5;
const HARD_DIAGONAL_TOLERANCE_MM = 1.5;
const HARD_AXIS_TOLERANCE_MM = 0.5;
const MIN_MOVABLE_HARD_SEGMENT_MM = 24;

const SQRT_HALF = Math.SQRT1_2;
const DIRECTION_UNIT: Record<HardDirection8, Point2D> = {
  E: { x: 1, y: 0 },
  NE: { x: SQRT_HALF, y: -SQRT_HALF },
  N: { x: 0, y: -1 },
  NW: { x: -SQRT_HALF, y: -SQRT_HALF },
  W: { x: -1, y: 0 },
  SW: { x: -SQRT_HALF, y: SQRT_HALF },
  S: { x: 0, y: 1 },
  SE: { x: SQRT_HALF, y: SQRT_HALF },
};

function add(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(v: Point2D, factor: number): Point2D {
  return { x: v.x * factor, y: v.y * factor };
}

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function areParallel(a: Point2D, b: Point2D): boolean {
  return Math.abs(a.x * b.y - a.y * b.x) <= 0.0001;
}

function midpoint(a: Point2D, b: Point2D): Point2D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function classifyHardDirection(start: Point2D, end: Point2D): HardDirection8 | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (
    Math.abs(dx) <= HARD_ZERO_LENGTH_TOLERANCE_MM &&
    Math.abs(dy) <= HARD_ZERO_LENGTH_TOLERANCE_MM
  ) {
    return null;
  }
  if (Math.abs(dx) <= HARD_AXIS_TOLERANCE_MM) {
    return dy > 0 ? 'S' : 'N';
  }
  if (Math.abs(dy) <= HARD_AXIS_TOLERANCE_MM) {
    return dx > 0 ? 'E' : 'W';
  }
  if (Math.abs(Math.abs(dx) - Math.abs(dy)) <= HARD_DIAGONAL_TOLERANCE_MM) {
    if (dx > 0 && dy < 0) return 'NE';
    if (dx > 0 && dy > 0) return 'SE';
    if (dx < 0 && dy < 0) return 'NW';
    return 'SW';
  }
  return null;
}

function intersectLines(
  lineAPoint: Point2D,
  lineADirection: Point2D,
  lineBPoint: Point2D,
  lineBDirection: Point2D,
): Point2D | null {
  const determinant =
    lineADirection.x * lineBDirection.y - lineADirection.y * lineBDirection.x;
  if (Math.abs(determinant) <= 0.0001) {
    return null;
  }
  const delta = subtract(lineBPoint, lineAPoint);
  const t = (delta.x * lineBDirection.y - delta.y * lineBDirection.x) / determinant;
  return add(lineAPoint, scale(lineADirection, t));
}

function snapToGrid(point: Point2D, gridSize: number): Point2D {
  const safeGrid = Math.max(gridSize, 1);
  return {
    x: Math.round(point.x / safeGrid) * safeGrid,
    y: Math.round(point.y / safeGrid) * safeGrid,
  };
}

function normalizeDragMaterials(
  segmentMaterials: RefrigerantPipeMaterial[],
  segmentCount: number,
): RefrigerantPipeMaterial[] {
  return Array.from(
    { length: Math.max(0, segmentCount) },
    (_, index) => (segmentMaterials[index] === 'hard' ? 'hard' : 'flexible'),
  );
}

function toKonvaPolylinePoints(points: Point2D[]): number[] {
  return points.flatMap((point) => [point.x * MM_TO_PX, point.y * MM_TO_PX]);
}

export function PipeKonvaInteractionLayer({
  enabled,
  width,
  height,
  viewportZoom,
  panOffset,
  hvacElements,
  selectedIds,
  wallSettings,
  updateHvacElement,
  saveToHistory,
  setProcessingStatus,
  setSelectedIds,
}: PipeKonvaInteractionLayerProps): JSX.Element | null {
  const selectedPipeElements = useMemo(
    () =>
      hvacElements.filter(
        (element) =>
          selectedIds.includes(element.id) && element.type === 'refrigerant-pipe',
      ),
    [hvacElements, selectedIds],
  );

  const [dragPreview, setDragPreview] = useState<PipeDragPreview | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const queuedPreviewRef = useRef<PipeDragPreview | null>(null);
  const dragStateRef = useRef<DragState | null>(null);

  const scheduleDragPreview = useCallback((preview: PipeDragPreview): void => {
    queuedPreviewRef.current = preview;
    if (previewFrameRef.current !== null) {
      return;
    }
    previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = null;
      setDragPreview(queuedPreviewRef.current);
    });
  }, []);

  const clearDragPreview = useCallback((): void => {
    if (previewFrameRef.current !== null) {
      cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    queuedPreviewRef.current = null;
    setDragPreview(null);
  }, []);

  useEffect(
    () => () => {
      if (previewFrameRef.current !== null) {
        cancelAnimationFrame(previewFrameRef.current);
      }
    },
    [],
  );

  const handles = useMemo(() => {
    const segmentHandles: SegmentHandleSpec[] = [];
    const vertexHandles: VertexHandleSpec[] = [];

    selectedPipeElements.forEach((element) => {
      const spec = resolveRefrigerantPipeSpec(element.properties);
      const routePoints = spec.routePoints;
      const segmentMaterials = spec.segmentMaterials;
      if (routePoints.length < 2) {
        return;
      }
      const lastIndex = routePoints.length - 1;

      for (let segmentIndex = 0; segmentIndex < lastIndex; segmentIndex += 1) {
        if ((segmentMaterials[segmentIndex] ?? 'flexible') !== 'hard') {
          continue;
        }
        if (segmentIndex === 0 && spec.startConnection) {
          continue;
        }
        if (segmentIndex + 1 === lastIndex && spec.endConnection) {
          continue;
        }
        const startPoint = routePoints[segmentIndex]!;
        const endPoint = routePoints[segmentIndex + 1]!;
        const segmentLength = Math.hypot(
          endPoint.x - startPoint.x,
          endPoint.y - startPoint.y,
        );
        if (segmentLength < MIN_MOVABLE_HARD_SEGMENT_MM) {
          continue;
        }
        if (!classifyHardDirection(startPoint, endPoint)) {
          continue;
        }
        segmentHandles.push({
          pipeId: element.id,
          startIndex: segmentIndex,
          endIndex: segmentIndex + 1,
          point: midpoint(startPoint, endPoint),
        });
      }

      for (let vertexIndex = 0; vertexIndex <= lastIndex; vertexIndex += 1) {
        const isEndpoint = vertexIndex === 0 || vertexIndex === lastIndex;
        const protectedStartIndex = spec.startConnection?.connectionKind === 'unit-port' ? 1 : -1;
        const protectedEndIndex = spec.endConnection?.connectionKind === 'unit-port'
          ? lastIndex - 1
          : -1;
        if (vertexIndex === protectedStartIndex || vertexIndex === protectedEndIndex) {
          continue;
        }
        const leftMaterial =
          vertexIndex > 0
            ? segmentMaterials[vertexIndex - 1] ?? 'flexible'
            : segmentMaterials[0] ?? 'flexible';
        const rightMaterial =
          vertexIndex < lastIndex
            ? segmentMaterials[vertexIndex] ?? leftMaterial
            : segmentMaterials[Math.max(0, lastIndex - 1)] ?? leftMaterial;
        if (leftMaterial !== 'flexible' && rightMaterial !== 'flexible') {
          continue;
        }
        vertexHandles.push({
          pipeId: element.id,
          vertexIndex,
          point: routePoints[vertexIndex]!,
          endpoint: isEndpoint,
        });
      }
    });

    return { segmentHandles, vertexHandles };
  }, [selectedPipeElements]);

  const resolvePipeElement = (pipeId: string): HvacElement | null => {
    const element = hvacElements.find((entry) => entry.id === pipeId);
    if (!element || element.type !== 'refrigerant-pipe') {
      return null;
    }
    return element;
  };

  const buildPipeUpdates = (
    pipeElement: HvacElement,
    baselineProperties: Record<string, unknown>,
    routePoints: Point2D[],
    segmentMaterials: RefrigerantPipeMaterial[],
  ): Partial<HvacElement> | null => {
    const constrainedRoutePoints = constrainRefrigerantPipeRouteForConnections(
      pipeElement.type,
      baselineProperties,
      routePoints,
    );
    const constrainedMaterials = normalizeDragMaterials(
      segmentMaterials,
      constrainedRoutePoints.length - 1,
    );
    const nextPipeElement = withCanonicalPipeRoute(
      { ...pipeElement, properties: baselineProperties },
      constrainedRoutePoints,
      { segmentMaterials: constrainedMaterials },
    );
    const nextVisual = buildRefrigerantPipeVisual(
      nextPipeElement,
      hvacElements,
    );
    if (nextVisual.invalidHardSegmentCount > 0) {
      return null;
    }
    return {
      position: {
        x: nextVisual.bounds.minX,
        y: nextVisual.bounds.minY,
      },
      width: nextVisual.bounds.width,
      depth: nextVisual.bounds.height,
      height: Math.max(1, nextVisual.outerRadiusMm * 2),
      properties: nextPipeElement.properties,
    };
  };

  const commitPipeDrag = (
    state: DragState,
    historyLabel: string,
    statusLabel: string,
  ): boolean => {
    const pipeElement = resolvePipeElement(state.pipeId);
    if (!pipeElement) {
      state.session.abort();
      clearDragPreview();
      return false;
    }
    const committed = state.session.commit(
      {
        updateHvacElement: (id, updates, options) =>
          updateHvacElement(id, updates as Partial<HvacElement>, options),
        saveToHistory,
      },
      (ghost) =>
        buildPipeUpdates(
          pipeElement,
          state.baselineProperties,
          ghost.route,
          ghost.materials as RefrigerantPipeMaterial[],
        ) as Record<string, unknown> | null,
      historyLabel,
    );
    if (committed) {
      setProcessingStatus(statusLabel, false);
    }
    clearDragPreview();
    return committed;
  };

  const handleSegmentDragMove = (
    event: Konva.KonvaEventObject<DragEvent>,
    state: SegmentDragState,
    forceApply = false,
  ): void => {
    const node = event.target;
    const currentHandlePoint: Point2D = {
      x: node.x() / MM_TO_PX,
      y: node.y() / MM_TO_PX,
    };
    const pipeElement = resolvePipeElement(state.pipeId);
    if (!pipeElement) {
      return;
    }
    const startPoint = state.baselineRoutePoints[state.startIndex];
    const endPoint = state.baselineRoutePoints[state.endIndex];
    if (!startPoint || !endPoint) {
      return;
    }
    const mainDirection = classifyHardDirection(startPoint, endPoint);
    if (!mainDirection) {
      return;
    }
    const direction = DIRECTION_UNIT[mainDirection];
    const segmentNormal = {
      x: -direction.y,
      y: direction.x,
    };
    const pointerDelta = subtract(currentHandlePoint, state.startHandlePoint);
    const projectedDistance = dot(pointerDelta, segmentNormal);
    let appliedDistance = projectedDistance;
    if (wallSettings.snapToGrid && forceApply) {
      const gridSize = Math.max(wallSettings.gridSize, 1);
      appliedDistance = Math.round(appliedDistance / gridSize) * gridSize;
    }
    const appliedDelta = scale(segmentNormal, appliedDistance);
    const routePoints = state.baselineRoutePoints;
    const pointCount = routePoints.length;
    const terminalIndex = pointCount - 1;
    const isHardSegment = (segmentIndex: number): boolean =>
      (state.segmentMaterials[segmentIndex] ?? 'flexible') === 'hard';
    const hardSegmentDirection = (segmentIndex: number): HardDirection8 | null => {
      if (segmentIndex < 0 || segmentIndex >= pointCount - 1) {
        return null;
      }
      return classifyHardDirection(routePoints[segmentIndex]!, routePoints[segmentIndex + 1]!);
    };

    let moveStartIndex = state.startIndex;
    let moveEndIndex = state.endIndex;

    while (moveStartIndex > 0) {
      const leftSegmentIndex = moveStartIndex - 1;
      if (!isHardSegment(leftSegmentIndex)) {
        break;
      }
      const leftDirection = hardSegmentDirection(leftSegmentIndex);
      if (!leftDirection || !areParallel(DIRECTION_UNIT[leftDirection], direction)) {
        break;
      }
      if (state.lockStart && leftSegmentIndex === 0) {
        node.position({
          x: state.lastValidHandlePoint.x * MM_TO_PX,
          y: state.lastValidHandlePoint.y * MM_TO_PX,
        });
        return;
      }
      moveStartIndex -= 1;
    }

    while (moveEndIndex < terminalIndex) {
      const rightSegmentIndex = moveEndIndex;
      if (!isHardSegment(rightSegmentIndex)) {
        break;
      }
      const rightDirection = hardSegmentDirection(rightSegmentIndex);
      if (!rightDirection || !areParallel(DIRECTION_UNIT[rightDirection], direction)) {
        break;
      }
      if (state.lockEnd && rightSegmentIndex === terminalIndex - 1) {
        node.position({
          x: state.lastValidHandlePoint.x * MM_TO_PX,
          y: state.lastValidHandlePoint.y * MM_TO_PX,
        });
        return;
      }
      moveEndIndex += 1;
    }

    const movedPointOverrides = new Map<number, Point2D>();
    for (let index = moveStartIndex; index <= moveEndIndex; index += 1) {
      movedPointOverrides.set(index, add(routePoints[index]!, appliedDelta));
    }

    const leftBoundarySegmentIndex = moveStartIndex - 1;
    if (leftBoundarySegmentIndex >= 0 && isHardSegment(leftBoundarySegmentIndex)) {
      const fixedPoint = routePoints[leftBoundarySegmentIndex]!;
      const leftDirection = hardSegmentDirection(leftBoundarySegmentIndex);
      const movedBoundaryPoint = movedPointOverrides.get(moveStartIndex)!;
      if (!leftDirection || areParallel(DIRECTION_UNIT[leftDirection], direction)) {
        node.position({
          x: state.lastValidHandlePoint.x * MM_TO_PX,
          y: state.lastValidHandlePoint.y * MM_TO_PX,
        });
        return;
      }
      const intersection = intersectLines(
        movedBoundaryPoint,
        direction,
        fixedPoint,
        DIRECTION_UNIT[leftDirection],
      );
      if (!intersection) {
        node.position({
          x: state.lastValidHandlePoint.x * MM_TO_PX,
          y: state.lastValidHandlePoint.y * MM_TO_PX,
        });
        return;
      }
      movedPointOverrides.set(moveStartIndex, intersection);
    }

    const rightBoundarySegmentIndex = moveEndIndex;
    if (rightBoundarySegmentIndex < terminalIndex && isHardSegment(rightBoundarySegmentIndex)) {
      const fixedPoint = routePoints[rightBoundarySegmentIndex + 1]!;
      const rightDirection = hardSegmentDirection(rightBoundarySegmentIndex);
      const movedBoundaryPoint = movedPointOverrides.get(moveEndIndex)!;
      if (!rightDirection || areParallel(DIRECTION_UNIT[rightDirection], direction)) {
        node.position({
          x: state.lastValidHandlePoint.x * MM_TO_PX,
          y: state.lastValidHandlePoint.y * MM_TO_PX,
        });
        return;
      }
      const intersection = intersectLines(
        movedBoundaryPoint,
        direction,
        fixedPoint,
        DIRECTION_UNIT[rightDirection],
      );
      if (!intersection) {
        node.position({
          x: state.lastValidHandlePoint.x * MM_TO_PX,
          y: state.lastValidHandlePoint.y * MM_TO_PX,
        });
        return;
      }
      movedPointOverrides.set(moveEndIndex, intersection);
    }

    const nextRoutePoints = state.baselineRoutePoints.map(
      (routePoint, index): Point2D => movedPointOverrides.get(index) ?? { ...routePoint },
    );
    const movedStart = nextRoutePoints[state.startIndex]!;
    const movedEnd = nextRoutePoints[state.endIndex]!;
    const movedMainDirection = classifyHardDirection(movedStart, movedEnd);
    if (!movedMainDirection || movedMainDirection !== mainDirection) {
      node.position({
        x: state.lastValidHandlePoint.x * MM_TO_PX,
        y: state.lastValidHandlePoint.y * MM_TO_PX,
      });
      return;
    }

    const nextMidpoint = midpoint(movedStart, movedEnd);
    node.position({
      x: nextMidpoint.x * MM_TO_PX,
      y: nextMidpoint.y * MM_TO_PX,
    });

    const constrainedRoutePoints = constrainRefrigerantPipeRouteForConnections(
      pipeElement.type,
      state.baselineProperties,
      nextRoutePoints,
    );
    const normalizedMaterials = normalizeDragMaterials(
      state.segmentMaterials,
      constrainedRoutePoints.length - 1,
    );
    const nextPipeElement = withCanonicalPipeRoute(
      { ...pipeElement, properties: state.baselineProperties },
      constrainedRoutePoints,
      { segmentMaterials: normalizedMaterials },
    );
    const nextVisual = buildRefrigerantPipeVisual(
      nextPipeElement,
      hvacElements,
    );
    if (nextVisual.invalidHardSegmentCount > 0) {
      node.position({
        x: state.lastValidHandlePoint.x * MM_TO_PX,
        y: state.lastValidHandlePoint.y * MM_TO_PX,
      });
      return;
    }

    state.session.update({
      route: constrainedRoutePoints,
      materials: normalizedMaterials,
    });
    state.lastValidHandlePoint = nextMidpoint;
    scheduleDragPreview({
      pipeId: state.pipeId,
      routePoints: constrainedRoutePoints,
      segmentMaterials: normalizedMaterials,
      visual: nextVisual,
    });
  };

  const handleVertexDragMove = (
    event: Konva.KonvaEventObject<DragEvent>,
    state: VertexDragState,
    forceApply = false,
  ): void => {
    const node = event.target;
    const pipeElement = resolvePipeElement(state.pipeId);
    if (!pipeElement) {
      return;
    }
    const leftMaterial = state.segmentMaterials[state.vertexIndex - 1] ?? 'flexible';
    const rightMaterial = state.segmentMaterials[state.vertexIndex] ?? leftMaterial;
    const touchesHardSegment = leftMaterial === 'hard' || rightMaterial === 'hard';
    let nextPoint = {
      x: node.x() / MM_TO_PX,
      y: node.y() / MM_TO_PX,
    };
    if (touchesHardSegment && wallSettings.snapToGrid && forceApply) {
      nextPoint = snapToGrid(nextPoint, wallSettings.gridSize);
    }
    node.position({
      x: nextPoint.x * MM_TO_PX,
      y: nextPoint.y * MM_TO_PX,
    });

    const nextRoutePoints = state.baselineRoutePoints.map((routePoint, index) =>
      index === state.vertexIndex ? nextPoint : { ...routePoint },
    );
    const constrainedRoutePoints = constrainRefrigerantPipeRouteForConnections(
      pipeElement.type,
      state.baselineProperties,
      nextRoutePoints,
    );
    const normalizedMaterials = normalizeDragMaterials(
      state.segmentMaterials,
      constrainedRoutePoints.length - 1,
    );
    const nextPipeElement = withCanonicalPipeRoute(
      { ...pipeElement, properties: state.baselineProperties },
      constrainedRoutePoints,
      { segmentMaterials: normalizedMaterials },
    );
    const nextVisual = buildRefrigerantPipeVisual(
      nextPipeElement,
      hvacElements,
    );
    if (touchesHardSegment && nextVisual.invalidHardSegmentCount > 0) {
      node.position({
        x: state.lastValidPoint.x * MM_TO_PX,
        y: state.lastValidPoint.y * MM_TO_PX,
      });
      return;
    }

    state.session.update({
      route: constrainedRoutePoints,
      materials: normalizedMaterials,
    });
    state.lastValidPoint = nextPoint;
    scheduleDragPreview({
      pipeId: state.pipeId,
      routePoints: constrainedRoutePoints,
      segmentMaterials: normalizedMaterials,
      visual: nextVisual,
    });
  };

  if (!enabled || width <= 0 || height <= 0 || selectedPipeElements.length === 0) {
    return null;
  }

  // Single canonical transform — shared with the Fabric viewport matrix so the
  // Konva handles can never drift from the rendered pipe body.
  const layerTransform = viewTransformToKonvaLayer(viewportToViewTransform(viewportZoom, panOffset));
  const safeZoom = Math.max(viewportZoom, 0.01);
  const segmentOuterRadius = Math.max(7, 11 / safeZoom);
  const segmentInnerRadius = Math.max(2.6, 4.4 / safeZoom);
  const segmentHitRadius = Math.max(segmentOuterRadius + 6, 20 / safeZoom);
  const vertexOuterRadius = Math.max(7.2, 10.4 / safeZoom);
  const vertexInnerRadius = Math.max(2.4, 3.8 / safeZoom);
  const vertexHitRadius = Math.max(vertexOuterRadius + 6, 20 / safeZoom);

  return (
    <div className="absolute left-0 top-0 z-[9]">
      <Stage
        width={width}
        height={height}
        onMouseDown={(event) => {
          if (event.target === event.target.getStage()) {
            setSelectedIds([]);
          }
        }}
      >
        <Layer
          x={layerTransform.x}
          y={layerTransform.y}
          scaleX={layerTransform.scaleX}
          scaleY={layerTransform.scaleY}
        >
          {dragPreview && (
            <Group listening={false}>
              {dragPreview.visual.segmentVisuals.map((segment) => {
                const points = toKonvaPolylinePoints(segment.points);
                const lineColor =
                  dragPreview.visual.lineKind === 'liquid' ? '#b45309' : '#2563eb';
                const outerStrokeWidth = Math.max(
                  dragPreview.visual.outerRadiusMm * 2 * MM_TO_PX,
                  5 / safeZoom,
                );
                const coreStrokeWidth = Math.max(
                  dragPreview.visual.coreRadiusMm * 2 * MM_TO_PX,
                  1.6 / safeZoom,
                );
                return (
                  <Group key={`${dragPreview.pipeId}-preview-${segment.index}`}>
                    <Line
                      points={points}
                      stroke="rgba(255,255,255,0.92)"
                      strokeWidth={outerStrokeWidth + 2.5 / safeZoom}
                      lineCap="round"
                      lineJoin="round"
                      perfectDrawEnabled={false}
                    />
                    <Line
                      points={points}
                      stroke={lineColor}
                      strokeWidth={outerStrokeWidth}
                      opacity={0.82}
                      lineCap="round"
                      lineJoin="round"
                      perfectDrawEnabled={false}
                    />
                    <Line
                      points={points}
                      stroke="rgba(255,255,255,0.65)"
                      strokeWidth={coreStrokeWidth}
                      lineCap="round"
                      lineJoin="round"
                      perfectDrawEnabled={false}
                    />
                  </Group>
                );
              })}
            </Group>
          )}
          {handles.segmentHandles.map((handle) => (
            <Group key={`${handle.pipeId}-s-${handle.startIndex}-${handle.endIndex}`}>
              <Circle
                x={handle.point.x * MM_TO_PX}
                y={handle.point.y * MM_TO_PX}
                radius={segmentOuterRadius}
                fill="rgba(255,255,255,0.95)"
                stroke="#b45309"
                strokeWidth={2.2}
                listening={false}
              />
              <Circle
                x={handle.point.x * MM_TO_PX}
                y={handle.point.y * MM_TO_PX}
                radius={segmentInnerRadius}
                fill="#b45309"
                listening={false}
              />
              <Circle
                x={handle.point.x * MM_TO_PX}
                y={handle.point.y * MM_TO_PX}
                radius={segmentHitRadius}
                fill="rgba(0,0,0,0.001)"
                strokeWidth={0}
                draggable
                dragDistance={0}
                perfectDrawEnabled={false}
                onDragStart={() => {
                  const pipeElement = resolvePipeElement(handle.pipeId);
                  if (!pipeElement) {
                    return;
                  }
                  setSelectedIds([handle.pipeId]);
                  const pipeSpec = resolveRefrigerantPipeSpec(pipeElement.properties);
                  const baselineRoutePoints = pipeSpec.routePoints.map((point) => ({ ...point }));
                  const segmentMaterials = normalizeDragMaterials(
                    pipeSpec.segmentMaterials,
                    baselineRoutePoints.length - 1,
                  );
                  const baselineProperties = { ...pipeElement.properties };
                  dragStateRef.current = {
                    kind: 'segment',
                    pipeId: handle.pipeId,
                    startIndex: handle.startIndex,
                    endIndex: handle.endIndex,
                    lockStart: Boolean(pipeSpec.startConnection),
                    lockEnd: Boolean(pipeSpec.endConnection),
                    startHandlePoint: { ...handle.point },
                    lastValidHandlePoint: { ...handle.point },
                    baselineRoutePoints,
                    segmentMaterials,
                    baselineProperties,
                    session: beginPipeDrag(handle.pipeId, {
                      route: baselineRoutePoints,
                      materials: segmentMaterials,
                    }),
                  };
                }}
                onDragMove={(event) => {
                  if (dragStateRef.current?.kind !== 'segment') {
                    return;
                  }
                  handleSegmentDragMove(event, dragStateRef.current);
                }}
                onDragEnd={(event) => {
                  const dragState = dragStateRef.current;
                  if (dragState?.kind === 'segment') {
                    handleSegmentDragMove(event, dragState, true);
                    commitPipeDrag(
                      dragState,
                      'Move refrigerant pipe hard segment',
                      `Hard segment S${dragState.startIndex + 1}-${dragState.endIndex + 1}`,
                    );
                  }
                  dragStateRef.current = null;
                }}
              />
            </Group>
          ))}
          {handles.vertexHandles.map((handle) => (
            <Group key={`${handle.pipeId}-v-${handle.vertexIndex}`}>
              {(() => {
                const outerRadius = handle.endpoint
                  ? Math.max(6.4, 8.4 / safeZoom)
                  : vertexOuterRadius;
                const innerRadius = handle.endpoint
                  ? Math.max(2.1, 3.2 / safeZoom)
                  : vertexInnerRadius;
                const stroke = handle.endpoint ? '#0f766e' : '#2563eb';
                return (
                  <>
                    <Circle
                      x={handle.point.x * MM_TO_PX}
                      y={handle.point.y * MM_TO_PX}
                      radius={outerRadius}
                      fill="rgba(255,255,255,0.95)"
                      stroke={stroke}
                      strokeWidth={2}
                      listening={false}
                    />
                    <Circle
                      x={handle.point.x * MM_TO_PX}
                      y={handle.point.y * MM_TO_PX}
                      radius={innerRadius}
                      fill={stroke}
                      listening={false}
                    />
                  </>
                );
              })()}
              {!handle.endpoint && (
              <Circle
                x={handle.point.x * MM_TO_PX}
                y={handle.point.y * MM_TO_PX}
                radius={vertexHitRadius}
                fill="rgba(0,0,0,0.001)"
                strokeWidth={0}
                draggable
                dragDistance={0}
                perfectDrawEnabled={false}
                onDragStart={() => {
                  const pipeElement = resolvePipeElement(handle.pipeId);
                  if (!pipeElement) {
                    return;
                  }
                  setSelectedIds([handle.pipeId]);
                  const pipeSpec = resolveRefrigerantPipeSpec(pipeElement.properties);
                  const baselineRoutePoints = pipeSpec.routePoints.map((point) => ({ ...point }));
                  const segmentMaterials = normalizeDragMaterials(
                    pipeSpec.segmentMaterials,
                    baselineRoutePoints.length - 1,
                  );
                  const baselineProperties = { ...pipeElement.properties };
                  dragStateRef.current = {
                    kind: 'vertex',
                    pipeId: handle.pipeId,
                    vertexIndex: handle.vertexIndex,
                    lastValidPoint: { ...handle.point },
                    baselineRoutePoints,
                    segmentMaterials,
                    baselineProperties,
                    session: beginPipeDrag(handle.pipeId, {
                      route: baselineRoutePoints,
                      materials: segmentMaterials,
                    }),
                  };
                }}
                onDragMove={(event) => {
                  if (dragStateRef.current?.kind !== 'vertex') {
                    return;
                  }
                  handleVertexDragMove(event, dragStateRef.current);
                }}
                onDragEnd={(event) => {
                  const dragState = dragStateRef.current;
                  if (dragState?.kind === 'vertex') {
                    handleVertexDragMove(event, dragState, true);
                    commitPipeDrag(
                      dragState,
                      'Edit refrigerant pipe vertex',
                      `Pipe vertex V${dragState.vertexIndex + 1}`,
                    );
                  }
                  dragStateRef.current = null;
                }}
              />
              )}
            </Group>
          ))}
        </Layer>
      </Stage>
    </div>
  );
}
