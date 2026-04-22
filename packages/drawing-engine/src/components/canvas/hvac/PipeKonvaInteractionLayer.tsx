import { useMemo, useRef } from 'react';
import { Circle, Group, Layer, Stage } from 'react-konva/lib/ReactKonvaCore';
import type Konva from 'konva';
import 'konva/lib/shapes/Circle';

import type { HvacElement, Point2D, WallSettings } from '../../../types';
import { MM_TO_PX } from '../scale';
import {
  buildRefrigerantPipeVisual,
  resolveRefrigerantPipeSpec,
  type RefrigerantPipeMaterial,
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
  lastAppliedAtMs: number;
  updated: boolean;
}

interface VertexDragState {
  kind: 'vertex';
  pipeId: string;
  vertexIndex: number;
  lastValidPoint: Point2D;
  baselineRoutePoints: Point2D[];
  segmentMaterials: RefrigerantPipeMaterial[];
  baselineProperties: Record<string, unknown>;
  lastAppliedAtMs: number;
  updated: boolean;
}

type DragState = SegmentDragState | VertexDragState;

const HARD_ZERO_LENGTH_TOLERANCE_MM = 0.5;
const HARD_DIAGONAL_TOLERANCE_MM = 1.5;
const HARD_AXIS_TOLERANCE_MM = 0.5;
const MIN_MOVABLE_HARD_SEGMENT_MM = 24;
const DRAG_APPLY_INTERVAL_MS = 10;

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

function shouldApplyDragUpdate(lastAppliedAtMs: number, forceApply: boolean): boolean {
  if (forceApply) {
    return true;
  }
  return performance.now() - lastAppliedAtMs >= DRAG_APPLY_INTERVAL_MS;
}

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

  const dragStateRef = useRef<DragState | null>(null);

  const resolvePipeElement = (pipeId: string): HvacElement | null => {
    const element = hvacElements.find((entry) => entry.id === pipeId);
    if (!element || element.type !== 'refrigerant-pipe') {
      return null;
    }
    return element;
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
    const movedLinePoint = add(startPoint, appliedDelta);
    let movedStart = add(startPoint, appliedDelta);
    let movedEnd = add(endPoint, appliedDelta);

    const leftMaterial = state.segmentMaterials[state.startIndex - 1] ?? 'flexible';
    const rightMaterial = state.segmentMaterials[state.endIndex] ?? 'flexible';
    const previousPoint =
      state.startIndex > 0 ? state.baselineRoutePoints[state.startIndex - 1] : null;
    const nextPoint =
      state.endIndex + 1 < state.baselineRoutePoints.length
        ? state.baselineRoutePoints[state.endIndex + 1]
        : null;
    const baselineLeftDirection =
      previousPoint && leftMaterial === 'hard'
        ? classifyHardDirection(previousPoint, startPoint)
        : null;
    const baselineRightDirection =
      nextPoint && rightMaterial === 'hard'
        ? classifyHardDirection(endPoint, nextPoint)
        : null;
    const movedPointOverrides = new Map<number, Point2D>();

    if (previousPoint && baselineLeftDirection) {
      const previousDirection = DIRECTION_UNIT[baselineLeftDirection];
      if (areParallel(previousDirection, direction)) {
        const previousIndex = state.startIndex - 1;
        if (!(state.lockStart && previousIndex === 0)) {
          movedPointOverrides.set(previousIndex, add(previousPoint, appliedDelta));
        } else {
          node.position({
            x: state.lastValidHandlePoint.x * MM_TO_PX,
            y: state.lastValidHandlePoint.y * MM_TO_PX,
          });
          return;
        }
      } else {
        const intersection = intersectLines(
          movedLinePoint,
          direction,
          previousPoint,
          previousDirection,
        );
        if (!intersection) {
          node.position({
            x: state.lastValidHandlePoint.x * MM_TO_PX,
            y: state.lastValidHandlePoint.y * MM_TO_PX,
          });
          return;
        }
        movedStart = intersection;
      }
    }
    if (nextPoint && baselineRightDirection) {
      const nextDirection = DIRECTION_UNIT[baselineRightDirection];
      if (areParallel(nextDirection, direction)) {
        const nextIndex = state.endIndex + 1;
        const terminalIndex = state.baselineRoutePoints.length - 1;
        if (!(state.lockEnd && nextIndex === terminalIndex)) {
          movedPointOverrides.set(nextIndex, add(nextPoint, appliedDelta));
        } else {
          node.position({
            x: state.lastValidHandlePoint.x * MM_TO_PX,
            y: state.lastValidHandlePoint.y * MM_TO_PX,
          });
          return;
        }
      } else {
        const intersection = intersectLines(
          movedLinePoint,
          direction,
          nextPoint,
          nextDirection,
        );
        if (!intersection) {
          node.position({
            x: state.lastValidHandlePoint.x * MM_TO_PX,
            y: state.lastValidHandlePoint.y * MM_TO_PX,
          });
          return;
        }
        movedEnd = intersection;
      }
    }

    const movedMainDirection = classifyHardDirection(movedStart, movedEnd);
    if (!movedMainDirection || movedMainDirection !== mainDirection) {
      return;
    }

    movedPointOverrides.set(state.startIndex, movedStart);
    movedPointOverrides.set(state.endIndex, movedEnd);
    const nextRoutePoints = state.baselineRoutePoints.map(
      (routePoint, index): Point2D => movedPointOverrides.get(index) ?? { ...routePoint },
    );

    const nextMidpoint = midpoint(movedStart, movedEnd);
    node.position({
      x: nextMidpoint.x * MM_TO_PX,
      y: nextMidpoint.y * MM_TO_PX,
    });
    state.lastValidHandlePoint = nextMidpoint;

    if (!shouldApplyDragUpdate(state.lastAppliedAtMs, forceApply)) {
      return;
    }

    const segmentCount = Math.max(0, nextRoutePoints.length - 1);
    const normalizedMaterials = Array.from(
      { length: segmentCount },
      (_, index) => (state.segmentMaterials[index] === 'hard' ? 'hard' : 'flexible'),
    );
    const nextProperties = {
      ...state.baselineProperties,
      routePoints: nextRoutePoints,
      segmentMaterials: normalizedMaterials,
    };
    const nextVisual = buildRefrigerantPipeVisual(
      {
        ...pipeElement,
        properties: nextProperties,
      },
      hvacElements,
    );
    if (nextVisual.invalidHardSegmentCount > 0) {
      return;
    }

    updateHvacElement(
      pipeElement.id,
      {
        position: {
          x: nextVisual.bounds.minX,
          y: nextVisual.bounds.minY,
        },
        width: nextVisual.bounds.width,
        depth: nextVisual.bounds.height,
        height: Math.max(1, nextVisual.outerRadiusMm * 2),
        properties: nextProperties,
      },
      { skipHistory: true },
    );
    state.lastAppliedAtMs = performance.now();
    state.updated = true;
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

    if (!shouldApplyDragUpdate(state.lastAppliedAtMs, forceApply)) {
      return;
    }

    const nextRoutePoints = state.baselineRoutePoints.map((routePoint, index) =>
      index === state.vertexIndex ? nextPoint : { ...routePoint },
    );
    const segmentCount = Math.max(0, nextRoutePoints.length - 1);
    const normalizedMaterials = Array.from(
      { length: segmentCount },
      (_, index) => (state.segmentMaterials[index] === 'hard' ? 'hard' : 'flexible'),
    );
    const nextProperties = {
      ...state.baselineProperties,
      routePoints: nextRoutePoints,
      segmentMaterials: normalizedMaterials,
    };
    const nextVisual = buildRefrigerantPipeVisual(
      {
        ...pipeElement,
        properties: nextProperties,
      },
      hvacElements,
    );
    if (touchesHardSegment && nextVisual.invalidHardSegmentCount > 0) {
      node.position({
        x: state.lastValidPoint.x * MM_TO_PX,
        y: state.lastValidPoint.y * MM_TO_PX,
      });
      return;
    }

    updateHvacElement(
      pipeElement.id,
      {
        position: {
          x: nextVisual.bounds.minX,
          y: nextVisual.bounds.minY,
        },
        width: nextVisual.bounds.width,
        depth: nextVisual.bounds.height,
        height: Math.max(1, nextVisual.outerRadiusMm * 2),
        properties: nextProperties,
      },
      { skipHistory: true },
    );
    state.lastAppliedAtMs = performance.now();
    state.lastValidPoint = nextPoint;
    state.updated = true;
  };

  if (!enabled || width <= 0 || height <= 0 || selectedPipeElements.length === 0) {
    return null;
  }

  const stageOffsetX = -panOffset.x * viewportZoom;
  const stageOffsetY = -panOffset.y * viewportZoom;
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
        <Layer x={stageOffsetX} y={stageOffsetY} scaleX={viewportZoom} scaleY={viewportZoom}>
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
                  dragStateRef.current = {
                    kind: 'segment',
                    pipeId: handle.pipeId,
                    startIndex: handle.startIndex,
                    endIndex: handle.endIndex,
                    lockStart: Boolean(pipeSpec.startConnection),
                    lockEnd: Boolean(pipeSpec.endConnection),
                    startHandlePoint: { ...handle.point },
                    lastValidHandlePoint: { ...handle.point },
                    baselineRoutePoints: pipeSpec.routePoints.map((point) => ({ ...point })),
                    segmentMaterials: [...pipeSpec.segmentMaterials],
                    baselineProperties: { ...pipeElement.properties },
                    lastAppliedAtMs: Number.NEGATIVE_INFINITY,
                    updated: false,
                  };
                }}
                onDragMove={(event) => {
                  if (dragStateRef.current?.kind !== 'segment') {
                    return;
                  }
                  handleSegmentDragMove(event, dragStateRef.current);
                }}
                onDragEnd={(event) => {
                  if (dragStateRef.current?.kind === 'segment') {
                    handleSegmentDragMove(event, dragStateRef.current, true);
                  }
                  if (dragStateRef.current?.kind === 'segment' && dragStateRef.current.updated) {
                    setProcessingStatus(
                      `Hard segment S${dragStateRef.current.startIndex + 1}-${dragStateRef.current.endIndex + 1}`,
                      false,
                    );
                    saveToHistory('Move refrigerant pipe hard segment');
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
                  dragStateRef.current = {
                    kind: 'vertex',
                    pipeId: handle.pipeId,
                    vertexIndex: handle.vertexIndex,
                    lastValidPoint: { ...handle.point },
                    baselineRoutePoints: pipeSpec.routePoints.map((point) => ({ ...point })),
                    segmentMaterials: [...pipeSpec.segmentMaterials],
                    baselineProperties: { ...pipeElement.properties },
                    lastAppliedAtMs: Number.NEGATIVE_INFINITY,
                    updated: false,
                  };
                }}
                onDragMove={(event) => {
                  if (dragStateRef.current?.kind !== 'vertex') {
                    return;
                  }
                  handleVertexDragMove(event, dragStateRef.current);
                }}
                onDragEnd={(event) => {
                  if (dragStateRef.current?.kind === 'vertex') {
                    handleVertexDragMove(event, dragStateRef.current, true);
                  }
                  if (dragStateRef.current?.kind === 'vertex' && dragStateRef.current.updated) {
                    setProcessingStatus(
                      `Pipe vertex V${dragStateRef.current.vertexIndex + 1}`,
                      false,
                    );
                    saveToHistory('Edit refrigerant pipe vertex');
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
