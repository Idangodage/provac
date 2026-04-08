/**
 * useSelectMode Hook
 *
 * Professional wall editing interactions in select mode:
 * - thickness handles (interior/exterior)
 * - center handle move
 * - endpoint editing with snapping
 * - multi-wall selection helpers
 */

import * as fabric from 'fabric';
import type { Canvas as FabricCanvas, Object as FabricObject } from 'fabric';
import { useRef, useCallback, useEffect } from 'react';
import type { MutableRefObject } from 'react';

import { WallRotationOperation } from '../../../operations';
import type { Point2D, Room, Wall, WallSettings } from '../../../types';
import {
  MAX_WALL_THICKNESS,
  MIN_WALL_LENGTH,
  MIN_WALL_THICKNESS,
} from '../../../types/wall';
import { SnapManager } from '../../../utils/SnapManager';
import { GeometryEngine } from '../../../utils/geometry-engine';
import {
  type CornerEnd,
} from '../../../utils/wallBevel';
import { endDragPerfTimer, startDragPerfTimer } from '../perf/dragPerf';
import { isRoomIsolatedFromAttachments } from '../room/roomIsolation';
import { MM_TO_PX } from '../scale';
import { computeWallBodyPolygon } from '../wall/WallGeometry';
import { snapToGrid } from '../wall/WallSnapping';

const THICKNESS_PRESETS_MM = [100, 150, 200, 250];
const THICKNESS_SNAP_TOLERANCE_MM = 12;
const PERPENDICULAR_SNAP_TOLERANCE_DEG = 12;
const ENDPOINT_BOND_TOLERANCE_MM = 2;
const SEGMENT_BOND_TOLERANCE_MM = 2;
const SEGMENT_ENDPOINT_T_THRESHOLD = 0.02;
const ROOM_MAGNETIC_MIN_TOLERANCE_MM = 12;
const ROOM_MAGNETIC_MAX_TOLERANCE_MM = 90;
const ROOM_MAGNETIC_PARALLEL_DOT = 0.97;
const ROOM_MAGNETIC_MIN_OVERLAP_MM = 120;
const STATUS_UPDATE_MIN_INTERVAL_MS = 60;
const OVERLAP_CHECK_MIN_INTERVAL_MS = 80;
const DRAG_UPDATE_MAX_THRESHOLD_MM = 0.08;
const DRAG_UPDATE_MIN_THRESHOLD_MM = 0.001;
const DRAG_UPDATE_PIXEL_THRESHOLD_PX = 0.2;
const ENDPOINT_DEFAULT_SNAP_DISTANCE_FACTOR = 0.2;
const ENDPOINT_DEFAULT_SNAP_SEARCH_RADIUS_FACTOR = 1.1;
const ENDPOINT_DEFAULT_SNAP_RELEASE_FACTOR = 0.55;
const ENDPOINT_MIN_SNAP_DISTANCE_PX = 5;
const ROOM_ROTATION_MAJOR_ANGLES_DEG = [0, 45, 90, 135];
const ROOM_ROTATION_GUIDE_HIGHLIGHT_TOLERANCE_DEG = 6;
const ROOM_ROTATION_GUIDE_VISIBILITY_TOLERANCE_DEG = 10;
const ROOM_ROTATION_MAGNETIC_SNAP_TOLERANCE_DEG = 4;

type WallControlType =
  | 'wall-center-handle'
  | 'wall-endpoint-start'
  | 'wall-endpoint-end'
  | 'wall-thickness-interior'
  | 'wall-thickness-exterior'
  | 'wall-rotation-handle'
  | 'room-center-handle'
  | 'room-rotation-handle'
  | 'room-corner-handle'
  | 'room-scale-handle';

interface WallUpdateOptions {
  skipHistory?: boolean;
  source?: 'ui' | 'drag';
  skipRoomDetection?: boolean;
  skipElevationRegeneration?: boolean;
}

interface RoomMoveOptions {
  skipHistory?: boolean;
}

export interface UseSelectModeOptions {
  fabricRef: React.RefObject<FabricCanvas | null>;
  walls: Wall[];
  rooms: Room[];
  selectedIds: string[];
  wallSettings: WallSettings;
  zoom: number;
  setSelectedIds: (ids: string[]) => void;
  setHoveredElement: (id: string | null) => void;
  getWall: (id: string) => Wall | undefined;
  updateWall: (id: string, updates: Partial<Wall>, options?: WallUpdateOptions) => void;
  updateWalls: (
    updates: Array<{ id: string; updates: Partial<Wall> }>,
    options?: WallUpdateOptions
  ) => void;
  updateWallBevel: (
    wallId: string,
    end: CornerEnd,
    bevel: Partial<{ outerOffset: number; innerOffset: number }>,
    options?: WallUpdateOptions
  ) => void;
  resetWallBevel: (wallId: string, end: CornerEnd) => void;
  getCornerBevelDots: (cornerPoint: Point2D) => {
    outerDotPosition: Point2D;
    innerDotPosition: Point2D;
    outerOffset: number;
    innerOffset: number;
  } | null;
  moveRoom: (id: string, delta: Point2D, options?: RoomMoveOptions) => void;
  connectWalls: (wallId: string, otherWallId: string) => void;
  selectWallSegmentWithinInterval: (wallId: string, startPoint: Point2D, endPoint: Point2D) => string;
  detectRooms: (options?: { debounce?: boolean }) => void;
  regenerateElevations: (options?: { debounce?: boolean }) => void;
  saveToHistory: (action: string) => void;
  setProcessingStatus: (status: string, isProcessing: boolean) => void;
  onDragStateChange?: (isDragging: boolean) => void;
  onRoomDragStateChange?: (roomId: string | null) => void;
  originOffset: { x: number; y: number };
}

interface TargetMeta {
  name?: string;
  id?: string;
  wallId?: string;
  roomId?: string;
  controlType?: WallControlType;
  cornerIndex?: number;
  scaleDirection?: 'NW' | 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W';
  isWallControl?: boolean;
  isRoomControl?: boolean;
  roomBoundarySelectionKey?: string;
  roomBoundaryStartPoint?: Point2D;
  roomBoundaryEndPoint?: Point2D;
}

interface ConnectedEndpointRef {
  wallId: string;
  endpoint: 'start' | 'end';
}

interface SegmentConstraintRef {
  wallId: string;
  startPoint: Point2D;
  endPoint: Point2D;
}

interface MoveEndpointConstraint {
  wallId: string;
  endpoint: 'start' | 'end';
  connectedEndpoints: ConnectedEndpointRef[];
  segmentConstraints: SegmentConstraintRef[];
}

interface IdleDragState {
  mode: 'idle';
}

interface ThicknessDragState {
  mode: 'thickness';
  wallId: string;
  side: 'interior' | 'exterior';
  startPointer: Point2D;
  baselineWall: Wall;
  normal: Point2D;
  endpointConstraints: MoveEndpointConstraint[];
}

interface MoveDragState {
  mode: 'move';
  wallIds: string[];
  anchorWallId: string;
  startPointer: Point2D;
  baselineWalls: Map<string, Wall>;
  constrainedNormal: Point2D | null;
  endpointConstraints: MoveEndpointConstraint[];
}

interface EndpointDragState {
  mode: 'endpoint';
  wallId: string;
  endpoint: 'start' | 'end';
  startPointer: Point2D;
  baselineWall: Wall;
  fixedPoint: Point2D;
  connectedEndpoints: ConnectedEndpointRef[];
  segmentConstraints: SegmentConstraintRef[];
}

interface RoomMoveDragState {
  mode: 'room-move';
  roomId: string;
  startPointer: Point2D;
  lastAppliedDelta: Point2D;
  ghostWalls: Wall[];
}

interface RoomCornerDragState {
  mode: 'room-corner';
  roomId: string;
  cornerIndex: number;
  startPointer: Point2D;
  baselineRoom: Room;
  baselineWalls: Map<string, Wall>;
}

interface RoomScaleDragState {
  mode: 'room-scale';
  roomId: string;
  direction: 'NW' | 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W';
  startPointer: Point2D;
  baselineRoom: Room;
  baselineWalls: Map<string, Wall>;
}

interface RoomRotateDragState {
  mode: 'room-rotate';
  roomId: string;
  pivot: Point2D;
  baselineAngleRad: number;
  baselineReferenceAngleRad: number;
  baselineRoom: Room;
  baselineWalls: Map<string, Wall>;
}

interface RotateDragState {
  mode: 'rotate';
  wallId: string;
  baselineWall: Wall;
  connectedEndpoints: ConnectedEndpointRef[];
  operation: WallRotationOperation;
}

type DragState =
  | IdleDragState
  | ThicknessDragState
  | MoveDragState
  | EndpointDragState
  | RoomMoveDragState
  | RoomCornerDragState
  | RoomScaleDragState
  | RoomRotateDragState
  | RotateDragState;

interface DragApplyResult {
  label: string;
  point: Point2D;
  snapPoint?: Point2D;
}

interface RoomMagneticSnapResult {
  delta: Point2D;
  sourcePoint: Point2D;
  targetPoint: Point2D;
  movingWallId: string;
  targetWallId: string;
  kind: 'endpoint' | 'segment' | 'wall-line';
  distance: number;
}

interface EndpointSnapMemory {
  mode: 'endpoint';
  wallId: string;
  point: Point2D;
  snappedWallId?: string;
  visual?: {
    color: string;
    indicator: 'circle' | 'square' | 'triangle' | 'cross';
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function add(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}

function scale(v: Point2D, factor: number): Point2D {
  return { x: v.x * factor, y: v.y * factor };
}

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function magnitude(v: Point2D): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

function normalize(v: Point2D): Point2D {
  const len = magnitude(v) || 1;
  return { x: v.x / len, y: v.y / len };
}

function pointCacheKey(point?: Point2D): string {
  if (!point) return '';
  return `${point.x.toFixed(3)},${point.y.toFixed(3)}`;
}

function midpoint(a: Point2D, b: Point2D): Point2D {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function wallLength(wall: Pick<Wall, 'startPoint' | 'endPoint'>): number {
  return magnitude(subtract(wall.endPoint, wall.startPoint));
}

function wallDirection(wall: Pick<Wall, 'startPoint' | 'endPoint'>): Point2D {
  return normalize(subtract(wall.endPoint, wall.startPoint));
}

function wallNormal(wall: Pick<Wall, 'startPoint' | 'endPoint'>): Point2D {
  const direction = wallDirection(wall);
  return { x: -direction.y, y: direction.x };
}

function wallAngleDegrees(wall: Pick<Wall, 'startPoint' | 'endPoint'>): number {
  const angle =
    (Math.atan2(wall.endPoint.y - wall.startPoint.y, wall.endPoint.x - wall.startPoint.x) *
      180) /
    Math.PI;
  return (angle + 360) % 360;
}

function normalizeAngleRadians(angle: number): number {
  let normalized = angle;
  while (normalized > Math.PI) normalized -= Math.PI * 2;
  while (normalized < -Math.PI) normalized += Math.PI * 2;
  return normalized;
}

function normalizeAngleDegrees(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

function normalizeLineAngleDegrees(angle: number): number {
  return normalizeAngleDegrees(angle) % 180;
}

function rotatePointAround(point: Point2D, pivot: Point2D, angleRad: number): Point2D {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const dx = point.x - pivot.x;
  const dy = point.y - pivot.y;
  return {
    x: pivot.x + dx * cos - dy * sin,
    y: pivot.y + dx * sin + dy * cos,
  };
}

function getRoomPrimaryAxisAngleRad(vertices: Point2D[]): number {
  if (vertices.length < 2) return 0;

  let bestAngle = 0;
  let bestLength = -1;
  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index];
    const end = vertices[(index + 1) % vertices.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length > bestLength) {
      bestLength = length;
      bestAngle = Math.atan2(dy, dx);
    }
  }

  return bestAngle;
}

function getRoomGuideRadiusMm(vertices: Point2D[], pivot: Point2D): number {
  const furthestVertexDistance = vertices.reduce((maxDistance, vertex) => {
    return Math.max(maxDistance, magnitude(subtract(vertex, pivot)));
  }, 0);
  return Math.max(1600, furthestVertexDistance + 700);
}

function getLineAngleDegreesFromRadians(angleRad: number): number {
  return normalizeLineAngleDegrees((angleRad * 180) / Math.PI);
}

function getLineAngleDeltaDegrees(aDeg: number, bDeg: number): number {
  const diff = Math.abs(normalizeLineAngleDegrees(aDeg) - normalizeLineAngleDegrees(bDeg));
  return Math.min(diff, 180 - diff);
}

function alignGuideAngleNearReference(
  guideLineAngleRad: number,
  referenceAngleRad: number
): number {
  // Line angles are periodic over PI. Choose the equivalent orientation closest to the reference
  // so magnetic snapping never causes a large 180deg jump.
  let best = guideLineAngleRad;
  let bestDelta = Math.abs(normalizeAngleRadians(guideLineAngleRad - referenceAngleRad));

  for (let k = -2; k <= 2; k += 1) {
    const candidate = guideLineAngleRad + k * Math.PI;
    const delta = Math.abs(normalizeAngleRadians(candidate - referenceAngleRad));
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }

  return best;
}

function getNearestRoomRotationGuideAngle(angleRad: number): {
  angleDeg: number;
  angleRad: number;
  deltaDeg: number;
} {
  const lineAngleDeg = getLineAngleDegreesFromRadians(angleRad);
  let bestAngleDeg = ROOM_ROTATION_MAJOR_ANGLES_DEG[0];
  let bestDeltaDeg = getLineAngleDeltaDegrees(lineAngleDeg, bestAngleDeg);

  for (let index = 1; index < ROOM_ROTATION_MAJOR_ANGLES_DEG.length; index += 1) {
    const candidateDeg = ROOM_ROTATION_MAJOR_ANGLES_DEG[index];
    const candidateDeltaDeg = getLineAngleDeltaDegrees(lineAngleDeg, candidateDeg);
    if (candidateDeltaDeg < bestDeltaDeg) {
      bestAngleDeg = candidateDeg;
      bestDeltaDeg = candidateDeltaDeg;
    }
  }

  return {
    angleDeg: bestAngleDeg,
    angleRad: alignGuideAngleNearReference((bestAngleDeg * Math.PI) / 180, angleRad),
    deltaDeg: bestDeltaDeg,
  };
}

function snapThickness(thicknessMm: number): number {
  for (const preset of THICKNESS_PRESETS_MM) {
    if (Math.abs(thicknessMm - preset) <= THICKNESS_SNAP_TOLERANCE_MM) {
      return preset;
    }
  }
  return thicknessMm;
}

function projectPointToSegment(
  point: Point2D,
  start: Point2D,
  end: Point2D
): { point: Point2D; distance: number; t: number } {
  const segment = subtract(end, start);
  const lengthSq = dot(segment, segment);
  if (lengthSq < 0.000001) {
    return {
      point: { ...start },
      distance: magnitude(subtract(point, start)),
      t: 0,
    };
  }

  const t = clamp(dot(subtract(point, start), segment) / lengthSq, 0, 1);
  const projected = add(start, scale(segment, t));
  return {
    point: projected,
    distance: magnitude(subtract(point, projected)),
    t,
  };
}

function distancePointToSegment(point: Point2D, start: Point2D, end: Point2D): number {
  return projectPointToSegment(point, start, end).distance;
}

function segmentDistance(aStart: Point2D, aEnd: Point2D, bStart: Point2D, bEnd: Point2D): number {
  return Math.min(
    distancePointToSegment(aStart, bStart, bEnd),
    distancePointToSegment(aEnd, bStart, bEnd),
    distancePointToSegment(bStart, aStart, aEnd),
    distancePointToSegment(bEnd, aStart, aEnd)
  );
}

function projectionOverlap(
  aStart: Point2D,
  aEnd: Point2D,
  bStart: Point2D,
  bEnd: Point2D,
  axis: Point2D
): number {
  const a0 = dot(aStart, axis);
  const a1 = dot(aEnd, axis);
  const b0 = dot(bStart, axis);
  const b1 = dot(bEnd, axis);
  const minA = Math.min(a0, a1);
  const maxA = Math.max(a0, a1);
  const minB = Math.min(b0, b1);
  const maxB = Math.max(b0, b1);
  return Math.max(0, Math.min(maxA, maxB) - Math.max(minA, minB));
}

function isParallel(a: Pick<Wall, 'startPoint' | 'endPoint'>, b: Pick<Wall, 'startPoint' | 'endPoint'>): boolean {
  const da = wallDirection(a);
  const db = wallDirection(b);
  return Math.abs(dot(da, db)) >= 0.985;
}

function wallsLikelyOverlapping(a: Wall, b: Wall): boolean {
  if (!isParallel(a, b)) return false;

  const axis = wallDirection(a);
  const overlapLength = projectionOverlap(a.startPoint, a.endPoint, b.startPoint, b.endPoint, axis);
  if (overlapLength < 100) return false;

  const centerlineDistance = segmentDistance(a.startPoint, a.endPoint, b.startPoint, b.endPoint);
  const maxAllowed = (a.thickness + b.thickness) / 2 - 1;
  return centerlineDistance < maxAllowed;
}

function toCanvasPoint(point: Point2D): Point2D {
  return {
    x: point.x * MM_TO_PX,
    y: point.y * MM_TO_PX,
  };
}

function pointsNear(a: Point2D, b: Point2D, tolerance = ENDPOINT_BOND_TOLERANCE_MM): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
}

function perpendicularDirection(reference: Wall, atPoint: Point2D): Point2D | null {
  if (!pointsNear(reference.startPoint, atPoint) && !pointsNear(reference.endPoint, atPoint)) {
    return null;
  }
  const dir = pointsNear(reference.startPoint, atPoint)
    ? normalize(subtract(reference.endPoint, reference.startPoint))
    : normalize(subtract(reference.startPoint, reference.endPoint));
  return normalize({ x: -dir.y, y: dir.x });
}

function roomBounds(vertices: Point2D[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs = vertices.map((vertex) => vertex.x);
  const ys = vertices.map((vertex) => vertex.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function validateRoomVertices(vertices: Point2D[]): { valid: boolean; reason?: string } {
  if (vertices.length < 3) {
    return { valid: false, reason: 'Room requires at least 3 corners.' };
  }
  if (GeometryEngine.polygonSelfIntersects(vertices)) {
    return { valid: false, reason: 'Room shape cannot self-intersect.' };
  }
  const areaM2 = GeometryEngine.calculateRoomAreaM2({ vertices });
  if (areaM2 < 2) {
    return { valid: false, reason: 'Room area must be at least 2m².' };
  }
  for (let i = 0; i < vertices.length; i += 1) {
    const next = vertices[(i + 1) % vertices.length];
    if (GeometryEngine.distance(vertices[i], next) < MIN_WALL_LENGTH) {
      return { valid: false, reason: `Each wall segment must be at least ${MIN_WALL_LENGTH}mm.` };
    }
  }
  return { valid: true };
}

function oppositeScaleAnchor(
  direction: 'NW' | 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W',
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
): Point2D {
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  switch (direction) {
    case 'NW':
      return { x: bounds.maxX, y: bounds.maxY };
    case 'N':
      return { x: centerX, y: bounds.maxY };
    case 'NE':
      return { x: bounds.minX, y: bounds.maxY };
    case 'E':
      return { x: bounds.minX, y: centerY };
    case 'SE':
      return { x: bounds.minX, y: bounds.minY };
    case 'S':
      return { x: centerX, y: bounds.minY };
    case 'SW':
      return { x: bounds.maxX, y: bounds.minY };
    case 'W':
    default:
      return { x: bounds.maxX, y: centerY };
  }
}

export function useSelectMode({
  fabricRef,
  walls,
  rooms,
  selectedIds,
  wallSettings,
  zoom,
  setSelectedIds,
  setHoveredElement,
  getWall,
  updateWall,
  updateWalls,
  updateWallBevel,
  resetWallBevel,
  getCornerBevelDots,
  moveRoom,
  connectWalls,
  selectWallSegmentWithinInterval,
  detectRooms,
  regenerateElevations,
  saveToHistory,
  setProcessingStatus,
  onDragStateChange,
  onRoomDragStateChange,
}: UseSelectModeOptions) {
  const isWallHandleDraggingRef = useRef(false);
  const dragStateRef = useRef<DragState>({ mode: 'idle' });
  const dragChangedRef = useRef(false);
  const pendingPointRef = useRef<Point2D | null>(null);
  const frameRef = useRef<number | null>(null);
  const dimensionLabelRef = useRef<fabric.Text | null>(null);
  const ghostObjectsRef = useRef<fabric.FabricObject[]>([]);
  const snapObjectsRef = useRef<fabric.FabricObject[]>([]);
  const rotationGuideObjectsRef = useRef<fabric.FabricObject[]>([]);
  const lastAppliedStatusRef = useRef<string>('');
  const lastStatusAtRef = useRef(0);
  const lastOverlapCheckAtRef = useRef(0);
  const lastOverlapWarningRef = useRef(false);
  const snapManagerRef = useRef(new SnapManager());
  const smoothedPointerRef = useRef<Point2D | null>(null);
  const endpointSnapMemoryRef = useRef<EndpointSnapMemory | null>(null);
  const wallUpdateCacheRef = useRef<Map<string, string>>(new Map());
  const connectedPairCacheRef = useRef<Set<string>>(new Set());
  const modifierKeysRef = useRef({ shift: false, ctrl: false, alt: false });

  const optionsRef = useRef({
    walls,
    rooms,
    selectedIds,
    wallSettings,
    zoom,
    setSelectedIds,
    setHoveredElement,
    getWall,
    updateWall,
    updateWalls,
    updateWallBevel,
    resetWallBevel,
    getCornerBevelDots,
    moveRoom,
    connectWalls,
    selectWallSegmentWithinInterval,
    detectRooms,
    regenerateElevations,
    saveToHistory,
    setProcessingStatus,
    onDragStateChange,
    onRoomDragStateChange,
  });

  const canRotateWall = useCallback((wall: Wall): boolean => {
    if (wall.connectedWalls.length > 0) {
      return false;
    }

    return !optionsRef.current.rooms.some((room) => room.wallIds.includes(wall.id));
  }, []);

  useEffect(() => {
    optionsRef.current = {
      walls,
      rooms,
      selectedIds,
      wallSettings,
      zoom,
      setSelectedIds,
      setHoveredElement,
      getWall,
      updateWall,
      updateWalls,
      updateWallBevel,
      resetWallBevel,
      getCornerBevelDots,
      moveRoom,
      connectWalls,
      selectWallSegmentWithinInterval,
      detectRooms,
      regenerateElevations,
      saveToHistory,
      setProcessingStatus,
      onDragStateChange,
      onRoomDragStateChange,
    };
  }, [
    walls,
    rooms,
    selectedIds,
    wallSettings,
    zoom,
    setSelectedIds,
    setHoveredElement,
    updateWall,
    updateWalls,
    updateWallBevel,
    resetWallBevel,
    getCornerBevelDots,
    moveRoom,
    connectWalls,
    detectRooms,
    regenerateElevations,
    saveToHistory,
    setProcessingStatus,
    onDragStateChange,
    onRoomDragStateChange,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      modifierKeysRef.current = {
        shift: event.shiftKey,
        ctrl: event.ctrlKey || event.metaKey,
        alt: event.altKey,
      };
    };
    const onKeyUp = (event: KeyboardEvent) => {
      modifierKeysRef.current = {
        shift: event.shiftKey,
        ctrl: event.ctrlKey || event.metaKey,
        alt: event.altKey,
      };
    };
    const onBlur = () => {
      modifierKeysRef.current = { shift: false, ctrl: false, alt: false };
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const clearOverlayObjects = useCallback((objectsRef: MutableRefObject<fabric.FabricObject[]>) => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    objectsRef.current.forEach((obj) => canvas.remove(obj));
    objectsRef.current = [];
  }, [fabricRef]);

  const markOverlayObject = useCallback((obj: fabric.FabricObject) => {
    (
      obj as fabric.FabricObject & {
        isSelectModeOverlay?: boolean;
      }
    ).isSelectModeOverlay = true;
    return obj;
  }, []);

  const clearDimensionLabel = useCallback(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    if (dimensionLabelRef.current) {
      canvas.remove(dimensionLabelRef.current);
      dimensionLabelRef.current = null;
    }
  }, [fabricRef]);

  const setDimensionLabel = useCallback((text: string, point: Point2D) => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const canvasPoint = toCanvasPoint(point);
    if (!dimensionLabelRef.current) {
      dimensionLabelRef.current = new fabric.Text(text, {
        left: canvasPoint.x + 12,
        top: canvasPoint.y - 18,
        fontSize: 12,
        fill: '#1D4ED8',
        fontFamily: 'Arial',
        selectable: false,
        evented: false,
      });
      canvas.add(dimensionLabelRef.current);
    } else {
      dimensionLabelRef.current.set({
        text,
        left: canvasPoint.x + 12,
        top: canvasPoint.y - 18,
      });
    }
    canvas.requestRenderAll();
  }, [fabricRef]);

  const showGhostWalls = useCallback((ghostWalls: Wall[]) => {
    clearOverlayObjects(ghostObjectsRef);
    const canvas = fabricRef.current;
    if (!canvas) return;

    const overlays: fabric.FabricObject[] = [];
    for (const wall of ghostWalls) {
        const polygon = computeWallBodyPolygon(wall).map((point) => toCanvasPoint(point));
      const ghost = markOverlayObject(new fabric.Polygon(polygon, {
        fill: 'rgba(148,163,184,0.08)',
        stroke: '#64748B',
        strokeDashArray: [6, 4],
        strokeWidth: 1.5,
        selectable: false,
        evented: false,
      }));
      overlays.push(ghost);
      canvas.add(ghost);
    }
    ghostObjectsRef.current = overlays;
    canvas.requestRenderAll();
  }, [clearOverlayObjects, fabricRef, markOverlayObject]);

  const clearGhostWalls = useCallback(() => {
    clearOverlayObjects(ghostObjectsRef);
    fabricRef.current?.requestRenderAll();
  }, [clearOverlayObjects, fabricRef]);

  const showSnapIndicator = useCallback((
    point?: Point2D,
    line?: { start: Point2D; end: Point2D },
    visual?: { color?: string; indicator?: 'circle' | 'square' | 'triangle' | 'cross' }
  ) => {
    clearOverlayObjects(snapObjectsRef);
    const canvas = fabricRef.current;
    if (!canvas) return;

    const overlays: fabric.FabricObject[] = [];
    const color = visual?.color ?? '#10B981';

    if (line) {
      const start = toCanvasPoint(line.start);
      const end = toCanvasPoint(line.end);
      const indicatorLine = new fabric.Line(
        [start.x, start.y, end.x, end.y],
        {
          stroke: color,
          strokeWidth: 1.2,
          strokeDashArray: [5, 5],
          selectable: false,
          evented: false,
        }
      );
      markOverlayObject(indicatorLine);
      overlays.push(indicatorLine);
      canvas.add(indicatorLine);
    }

    if (point) {
      const canvasPoint = toCanvasPoint(point);
      if (visual?.indicator === 'square') {
        const marker = markOverlayObject(new fabric.Rect({
          left: canvasPoint.x,
          top: canvasPoint.y,
          width: 10,
          height: 10,
          fill: color,
          stroke: '#FFFFFF',
          strokeWidth: 1.5,
          originX: 'center',
          originY: 'center',
          selectable: false,
          evented: false,
        }));
        overlays.push(marker);
        canvas.add(marker);
      } else if (visual?.indicator === 'triangle') {
        const marker = markOverlayObject(new fabric.Triangle({
          left: canvasPoint.x,
          top: canvasPoint.y,
          width: 10,
          height: 10,
          fill: color,
          stroke: '#FFFFFF',
          strokeWidth: 1.5,
          originX: 'center',
          originY: 'center',
          selectable: false,
          evented: false,
        }));
        overlays.push(marker);
        canvas.add(marker);
      } else if (visual?.indicator === 'cross') {
        const h = markOverlayObject(new fabric.Line(
          [canvasPoint.x - 6, canvasPoint.y, canvasPoint.x + 6, canvasPoint.y],
          {
            stroke: color,
            strokeWidth: 1.5,
            selectable: false,
            evented: false,
          }
        ));
        const v = markOverlayObject(new fabric.Line(
          [canvasPoint.x, canvasPoint.y - 6, canvasPoint.x, canvasPoint.y + 6],
          {
            stroke: color,
            strokeWidth: 1.5,
            selectable: false,
            evented: false,
          }
        ));
        overlays.push(h, v);
        canvas.add(h, v);
      } else {
        const marker = markOverlayObject(new fabric.Circle({
          left: canvasPoint.x,
          top: canvasPoint.y,
          radius: 5,
          fill: color,
          stroke: '#FFFFFF',
          strokeWidth: 1.5,
          originX: 'center',
          originY: 'center',
          selectable: false,
          evented: false,
        }));
        overlays.push(marker);
        canvas.add(marker);
      }
    }

    snapObjectsRef.current = overlays;
    canvas.requestRenderAll();
  }, [clearOverlayObjects, fabricRef]);

  const clearSnapIndicators = useCallback(() => {
    clearOverlayObjects(snapObjectsRef);
    fabricRef.current?.requestRenderAll();
  }, [clearOverlayObjects, fabricRef, markOverlayObject]);

  const showRoomRotationGuide = useCallback((params: {
    pivot: Point2D;
    baselineAngleRad: number;
    currentAngleRad: number;
    suggestedAngleRad: number;
    currentAngleDeg: number;
    suggestedAngleDeg: number;
    suggestedAngleDeltaDeg: number;
    radiusMm: number;
  }) => {
    clearOverlayObjects(rotationGuideObjectsRef);
    const canvas = fabricRef.current;
    if (!canvas) return;

    const overlays: fabric.FabricObject[] = [];
    const pivot = toCanvasPoint(params.pivot);
    const guideHalfLengthPx = params.radiusMm * MM_TO_PX;

    const createGuideLine = (
      angleRad: number,
      options: {
        color: string;
        width: number;
        dash: number[];
        opacity?: number;
      }
    ) => {
      const dx = Math.cos(angleRad) * guideHalfLengthPx;
      const dy = Math.sin(angleRad) * guideHalfLengthPx;
      return markOverlayObject(new fabric.Line(
        [pivot.x - dx, pivot.y - dy, pivot.x + dx, pivot.y + dy],
        {
          stroke: options.color,
          strokeWidth: options.width,
          strokeDashArray: options.dash,
          opacity: options.opacity ?? 10,
          strokeLineCap: 'round',
          selectable: false,
          evented: false,
        }
      ));
    };

    const addBadge = (
      text: string,
      anchor: Point2D,
      accentColor: string,
      verticalShiftPx: number
    ) => {
      const label = markOverlayObject(new fabric.Text(text, {
        left: anchor.x,
        top: anchor.y + verticalShiftPx,
        fontSize: 11,
        fontWeight: '700',
        fontFamily: 'Arial',
        fill: '#0F172A',
        originX: 'center',
        originY: 'center',
        selectable: false,
        evented: false,
      }));
      const badge = markOverlayObject(new fabric.Rect({
        left: anchor.x,
        top: anchor.y + verticalShiftPx,
        width: (label.width ?? 0) + 12,
        height: (label.height ?? 0) + 8,
        rx: 6,
        ry: 6,
        fill: 'rgba(255,255,255,0.98)',
        stroke: accentColor,
        strokeWidth: 1.4,
        originX: 'center',
        originY: 'center',
        selectable: false,
        evented: false,
        shadow: new fabric.Shadow({
          color: 'rgba(15,23,42,0.18)',
          blur: 6,
          offsetX: 0,
          offsetY: 1,
        }),
      }));
      overlays.push(badge, label);
      canvas.add(badge, label);
    };

    const suggestedHighlight =
      params.suggestedAngleDeltaDeg <= ROOM_ROTATION_GUIDE_HIGHLIGHT_TOLERANCE_DEG;
    const suggestedAxisPrimaryBack = createGuideLine(params.suggestedAngleRad, {
      color: 'rgba(255,255,255,0.94)',
      width: suggestedHighlight ? 4.8 : 4,
      dash: [8, 6],
      opacity: 0.96,
    });
    const suggestedAxisPrimary = createGuideLine(params.suggestedAngleRad, {
      color: suggestedHighlight ? '#0284C7' : 'rgba(3,105,161,0.85)',
      width: suggestedHighlight ? 2.6 : 2,
      dash: [8, 6],
      opacity: suggestedHighlight ? 1 : 0.95,
    });
    const suggestedAxisPerpendicularBack = createGuideLine(params.suggestedAngleRad + Math.PI / 2, {
      color: 'rgba(255,255,255,0.9)',
      width: suggestedHighlight ? 4.2 : 3.6,
      dash: [8, 6],
      opacity: 0.92,
    });
    const suggestedAxisPerpendicular = createGuideLine(params.suggestedAngleRad + Math.PI / 2, {
      color: suggestedHighlight ? 'rgba(2,132,199,0.88)' : 'rgba(3,105,161,0.75)',
      width: suggestedHighlight ? 2.1 : 1.7,
      dash: [8, 6],
      opacity: suggestedHighlight ? 0.95 : 0.9,
    });
    const currentLineBack = createGuideLine(params.currentAngleRad, {
      color: 'rgba(255,255,255,0.96)',
      width: 5,
      dash: [12, 6],
      opacity: 0.96,
    });
    const currentLine = createGuideLine(params.currentAngleRad, {
      color: '#1D4ED8',
      width: 2.7,
      dash: [12, 6],
      opacity: 1,
    });
    const pivotMarker = markOverlayObject(new fabric.Circle({
      left: pivot.x,
      top: pivot.y,
      radius: 5.5,
      fill: '#FFFFFF',
      stroke: '#1D4ED8',
      strokeWidth: 2.2,
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
      shadow: new fabric.Shadow({
        color: 'rgba(29,78,216,0.18)',
        blur: 6,
        offsetX: 0,
        offsetY: 1,
      }),
    }));

    overlays.push(
      suggestedAxisPrimaryBack,
      suggestedAxisPerpendicularBack,
      currentLineBack,
      suggestedAxisPrimary,
      suggestedAxisPerpendicular,
      currentLine,
      pivotMarker
    );
    canvas.add(
      suggestedAxisPrimaryBack,
      suggestedAxisPerpendicularBack,
      currentLineBack,
      suggestedAxisPrimary,
      suggestedAxisPerpendicular,
      currentLine,
      pivotMarker
    );

    const currentLabelAnchor = {
      x: pivot.x + Math.cos(params.currentAngleRad) * (guideHalfLengthPx * 0.82),
      y: pivot.y + Math.sin(params.currentAngleRad) * (guideHalfLengthPx * 0.82),
    };
    const suggestedLabelAnchor = {
      x: pivot.x + Math.cos(params.suggestedAngleRad) * (guideHalfLengthPx * 0.67),
      y: pivot.y + Math.sin(params.suggestedAngleRad) * (guideHalfLengthPx * 0.67),
    };

    addBadge(`${params.currentAngleDeg.toFixed(1)}deg`, currentLabelAnchor, '#2563EB', -14);
    addBadge(`${params.suggestedAngleDeg}deg`, suggestedLabelAnchor, '#0EA5E9', 14);

    rotationGuideObjectsRef.current = overlays;
    overlays.forEach((overlay) => canvas.bringObjectToFront(overlay));
    canvas.requestRenderAll();
  }, [clearOverlayObjects, fabricRef, markOverlayObject]);

  const clearRotationGuide = useCallback(() => {
    clearOverlayObjects(rotationGuideObjectsRef);
    fabricRef.current?.requestRenderAll();
  }, [clearOverlayObjects, fabricRef]);

  const clearEditVisuals = useCallback(() => {
    clearGhostWalls();
    clearSnapIndicators();
    clearRotationGuide();
    clearDimensionLabel();
  }, [clearDimensionLabel, clearGhostWalls, clearRotationGuide, clearSnapIndicators]);

  const getSnapReleaseDistanceMm = useCallback((): number => {
    const safeZoom = Math.max(optionsRef.current.zoom, 0.01);
    const snapDistancePx = Math.max(
      optionsRef.current.wallSettings.endpointSnapTolerance,
      optionsRef.current.wallSettings.midpointSnapTolerance
    );
    return Math.max(6, (snapDistancePx * 1.8) / (MM_TO_PX * safeZoom));
  }, []);

  const withDragPerfOptions = useCallback((options?: WallUpdateOptions): WallUpdateOptions | undefined => {
    if (!options || options.source !== 'drag') {
      return options;
    }

    // Drag interactions should keep geometry updates light and defer expensive
    // derived recomputations to drag-finalization for smoother control.
    return {
      ...options,
      skipRoomDetection: options.skipRoomDetection ?? true,
      skipElevationRegeneration: options.skipElevationRegeneration ?? true,
    };
  }, []);

  const getWallUpdateThreshold = useCallback((options?: WallUpdateOptions): number => {
    if (options?.source !== 'drag') {
      return DRAG_UPDATE_MAX_THRESHOLD_MM;
    }

    const safeZoom = Math.max(optionsRef.current.zoom, 0.01);
    const thresholdFromPixels = DRAG_UPDATE_PIXEL_THRESHOLD_PX / (MM_TO_PX * safeZoom);
    return clamp(
      thresholdFromPixels,
      DRAG_UPDATE_MIN_THRESHOLD_MM,
      DRAG_UPDATE_MAX_THRESHOLD_MM
    );
  }, []);

  const smoothDragPoint = useCallback((point: Point2D, _mode: DragState['mode']): Point2D => {
    // Keep drag interaction 1:1 with the pointer for maximum responsiveness.
    smoothedPointerRef.current = { ...point };
    return point;
  }, []);

  const findWallById = useCallback((wallId: string): Wall | undefined => {
    return optionsRef.current.getWall(wallId) ?? optionsRef.current.walls.find((wall) => wall.id === wallId);
  }, []);

  const findRoomById = useCallback((roomId: string): Room | undefined => {
    return optionsRef.current.rooms.find((room) => room.id === roomId);
  }, []);

  const getRoomMagneticToleranceMm = useCallback((): number => {
    const safeZoom = Math.max(optionsRef.current.zoom, 0.01);
    const snapDistancePx = Math.max(
      optionsRef.current.wallSettings.endpointSnapTolerance,
      optionsRef.current.wallSettings.midpointSnapTolerance
    );
    const rawMm = (snapDistancePx * 1.35) / (MM_TO_PX * safeZoom);
    return clamp(rawMm, ROOM_MAGNETIC_MIN_TOLERANCE_MM, ROOM_MAGNETIC_MAX_TOLERANCE_MM);
  }, []);

  const findRoomMagneticSnap = useCallback((
    state: RoomMoveDragState,
    translation: Point2D
  ): RoomMagneticSnapResult | null => {
    const movingWallIds = new Set(state.ghostWalls.map((wall) => wall.id));
    const staticWalls = optionsRef.current.walls.filter((wall) => !movingWallIds.has(wall.id));
    if (staticWalls.length === 0) {
      return null;
    }

    const endpointTol = getRoomMagneticToleranceMm();
    const segmentTol = endpointTol * 1.2;
    const wallLineTol = endpointTol * 1.6;

    const candidates: Array<RoomMagneticSnapResult & { priority: number }> = [];
    const consider = (candidate: RoomMagneticSnapResult, priority: number) => {
      if (candidate.distance > (
        priority === 0
          ? endpointTol
          : priority === 1
            ? segmentTol
            : wallLineTol
      )) {
        return;
      }
      candidates.push({ ...candidate, priority });
    };

    for (const movingWall of state.ghostWalls) {
      const movedStart = add(movingWall.startPoint, translation);
      const movedEnd = add(movingWall.endPoint, translation);
      const movedMid = midpoint(movedStart, movedEnd);
      const movedDirection = wallDirection(movingWall);
      const movingEndpoints = [
        { point: movedStart, wallId: movingWall.id },
        { point: movedEnd, wallId: movingWall.id },
      ];

      for (const endpoint of movingEndpoints) {
        for (const targetWall of staticWalls) {
          const targetEndpoints = [targetWall.startPoint, targetWall.endPoint];
          for (const targetEndpoint of targetEndpoints) {
            const delta = subtract(targetEndpoint, endpoint.point);
            consider({
              delta,
              sourcePoint: endpoint.point,
              targetPoint: targetEndpoint,
              movingWallId: endpoint.wallId,
              targetWallId: targetWall.id,
              kind: 'endpoint',
              distance: magnitude(delta),
            }, 0);
          }

          const projection = projectPointToSegment(endpoint.point, targetWall.startPoint, targetWall.endPoint);
          const nearEndpoint = (
            projection.t <= SEGMENT_ENDPOINT_T_THRESHOLD
            || projection.t >= 1 - SEGMENT_ENDPOINT_T_THRESHOLD
          );
          if (nearEndpoint) {
            continue;
          }

          consider({
            delta: subtract(projection.point, endpoint.point),
            sourcePoint: endpoint.point,
            targetPoint: projection.point,
            movingWallId: endpoint.wallId,
            targetWallId: targetWall.id,
            kind: 'segment',
            distance: projection.distance,
          }, 1);
        }
      }

      for (const targetWall of staticWalls) {
        const targetDirection = wallDirection(targetWall);
        if (Math.abs(dot(movedDirection, targetDirection)) < ROOM_MAGNETIC_PARALLEL_DOT) {
          continue;
        }

        const overlap = projectionOverlap(
          movedStart,
          movedEnd,
          targetWall.startPoint,
          targetWall.endPoint,
          targetDirection
        );
        if (overlap < ROOM_MAGNETIC_MIN_OVERLAP_MM) {
          continue;
        }

        const projection = projectPointToSegment(movedMid, targetWall.startPoint, targetWall.endPoint);
        consider({
          delta: subtract(projection.point, movedMid),
          sourcePoint: movedMid,
          targetPoint: projection.point,
          movingWallId: movingWall.id,
          targetWallId: targetWall.id,
          kind: 'wall-line',
          distance: projection.distance,
        }, 2);
      }
    }

    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      return left.distance - right.distance;
    });

    const best = candidates[0];
    return {
      delta: best.delta,
      sourcePoint: best.sourcePoint,
      targetPoint: best.targetPoint,
      movingWallId: best.movingWallId,
      targetWallId: best.targetWallId,
      kind: best.kind,
      distance: best.distance,
    };
  }, [getRoomMagneticToleranceMm]);

  const buildEndpointConstraints = useCallback((
    wall: Wall,
    endpoint: 'start' | 'end',
    skipWallIds: Set<string>
  ): { connectedEndpoints: ConnectedEndpointRef[]; segmentConstraints: SegmentConstraintRef[] } => {
    const movingPoint = endpoint === 'start' ? wall.startPoint : wall.endPoint;
    const connectedEndpoints: ConnectedEndpointRef[] = [];
    const segmentConstraints: SegmentConstraintRef[] = [];
    const endpointSeen = new Set<string>();
    const segmentSeen = new Set<string>();
    const allWalls = optionsRef.current.walls;
    const safeZoom = Math.max(optionsRef.current.zoom, 0.01);
    const endpointTolerance = Math.max(
      ENDPOINT_BOND_TOLERANCE_MM,
      optionsRef.current.wallSettings.endpointSnapTolerance / (MM_TO_PX * safeZoom)
    );
    const segmentTolerance = Math.max(
      SEGMENT_BOND_TOLERANCE_MM,
      optionsRef.current.wallSettings.midpointSnapTolerance / (MM_TO_PX * safeZoom)
    );

    for (const connectedWall of allWalls) {
      if (connectedWall.id === wall.id || skipWallIds.has(connectedWall.id)) continue;

      if (pointsNear(connectedWall.startPoint, movingPoint, endpointTolerance)) {
        const key = `${connectedWall.id}:start`;
        if (!endpointSeen.has(key)) {
          endpointSeen.add(key);
          connectedEndpoints.push({ wallId: connectedWall.id, endpoint: 'start' });
        }
        continue;
      }

      if (pointsNear(connectedWall.endPoint, movingPoint, endpointTolerance)) {
        const key = `${connectedWall.id}:end`;
        if (!endpointSeen.has(key)) {
          endpointSeen.add(key);
          connectedEndpoints.push({ wallId: connectedWall.id, endpoint: 'end' });
        }
        continue;
      }

      const projection = projectPointToSegment(
        movingPoint,
        connectedWall.startPoint,
        connectedWall.endPoint
      );
      if (projection.distance <= segmentTolerance) {
        const segmentLength = Math.max(
          1,
          magnitude(subtract(connectedWall.endPoint, connectedWall.startPoint))
        );
        const endpointBand = Math.min(
          0.2,
          SEGMENT_ENDPOINT_T_THRESHOLD + endpointTolerance / segmentLength
        );
        const nearStart =
          projection.t <= endpointBand ||
          pointsNear(movingPoint, connectedWall.startPoint, endpointTolerance);
        const nearEnd =
          projection.t >= 1 - endpointBand ||
          pointsNear(movingPoint, connectedWall.endPoint, endpointTolerance);

        if (nearStart || nearEnd) {
          const endpointKey = `${connectedWall.id}:${nearStart ? 'start' : 'end'}`;
          if (!endpointSeen.has(endpointKey)) {
            endpointSeen.add(endpointKey);
            connectedEndpoints.push({
              wallId: connectedWall.id,
              endpoint: nearStart ? 'start' : 'end',
            });
          }
          continue;
        }

        const segmentKey = connectedWall.id;
        if (!segmentSeen.has(segmentKey)) {
          segmentSeen.add(segmentKey);
          segmentConstraints.push({
            wallId: connectedWall.id,
            startPoint: { ...connectedWall.startPoint },
            endPoint: { ...connectedWall.endPoint },
          });
        }
      }
    }

    return { connectedEndpoints, segmentConstraints };
  }, []);

  const getTargetMeta = useCallback((target: FabricObject | undefined | null): TargetMeta => {
    const typed = target as FabricObject & TargetMeta & { group?: TargetMeta };
    const group = typed?.group;

    const wallId =
      typed?.wallId ??
      group?.wallId ??
      (typed?.name?.startsWith('wall-') ? typed.id : undefined) ??
      (group?.name?.startsWith('wall-') ? group.id : undefined);
    const roomId =
      typed?.roomId ??
      group?.roomId ??
      (typed?.name?.startsWith('room-') ? typed.id : undefined) ??
      (group?.name?.startsWith('room-') ? group.id : undefined);

    const id = typed?.id ?? group?.id;
    const controlType = typed?.controlType ?? group?.controlType;
    const cornerIndex = typed?.cornerIndex ?? group?.cornerIndex;
    const scaleDirection = typed?.scaleDirection ?? group?.scaleDirection;
    const roomBoundarySelectionKey = typed?.roomBoundarySelectionKey ?? group?.roomBoundarySelectionKey;
    const roomBoundaryStartPoint = typed?.roomBoundaryStartPoint ?? group?.roomBoundaryStartPoint;
    const roomBoundaryEndPoint = typed?.roomBoundaryEndPoint ?? group?.roomBoundaryEndPoint;
    const isWallControl = Boolean(typed?.isWallControl && controlType);
    const isRoomControl = Boolean(typed?.isRoomControl && controlType);

    return {
      name: typed?.name,
      id,
      wallId,
      roomId,
      controlType,
      cornerIndex,
      scaleDirection,
      isWallControl,
      isRoomControl,
      roomBoundarySelectionKey,
      roomBoundaryStartPoint,
      roomBoundaryEndPoint,
    };
  }, []);

  const updateSelectionFromTargets = useCallback(
    (targets: Array<FabricObject | undefined | null>) => {
      const ids = Array.from(
        new Set(
          targets
            .map((target) => {
              const meta = getTargetMeta(target);
              return meta.wallId ?? meta.roomId ?? meta.id;
            })
            .filter((id): id is string => Boolean(id))
        )
      );
      optionsRef.current.setSelectedIds(ids);
    },
    [getTargetMeta]
  );

  const updateSelectionFromTarget = useCallback(
    (target: FabricObject | undefined | null) => {
      updateSelectionFromTargets([target]);
    },
    [updateSelectionFromTargets]
  );

  const setStatusFromWall = useCallback((wall: Wall) => {
    const status = `Wall length: ${Math.round(wallLength(wall))}mm, Thickness: ${Math.round(
      wall.thickness
    )}mm, Angle: ${wallAngleDegrees(wall).toFixed(1)}deg`;
    if (lastAppliedStatusRef.current !== status) {
      const now =
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
      if (now - lastStatusAtRef.current < STATUS_UPDATE_MIN_INTERVAL_MS) {
        return;
      }
      lastAppliedStatusRef.current = status;
      lastStatusAtRef.current = now;
      optionsRef.current.setProcessingStatus(status, false);
    }
  }, []);

  const setStatusFromRoom = useCallback((room: Room) => {
    const status = `Room: ${room.name}, Area: ${(room.area / 1_000_000).toFixed(1)}m², Perimeter: ${Math.round(room.perimeter)}mm`;
    if (lastAppliedStatusRef.current !== status) {
      const now =
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
      if (now - lastStatusAtRef.current < STATUS_UPDATE_MIN_INTERVAL_MS) {
        return;
      }
      lastAppliedStatusRef.current = status;
      lastStatusAtRef.current = now;
      optionsRef.current.setProcessingStatus(status, false);
    }
  }, []);

  const updateWallIfChanged = useCallback(
    (wallId: string, updates: Partial<Wall>, options?: WallUpdateOptions) => {
      const effectiveOptions = withDragPerfOptions(options);
      const cacheKey = [
        `s:${pointCacheKey(updates.startPoint)}`,
        `e:${pointCacheKey(updates.endPoint)}`,
        `t:${updates.thickness !== undefined ? updates.thickness.toFixed(3) : ''}`,
      ].join('|');
      const cached = wallUpdateCacheRef.current.get(wallId);
      if (cached === cacheKey) {
        return;
      }

      const current = findWallById(wallId);
      if (!current) {
        optionsRef.current.updateWall(wallId, updates, effectiveOptions);
        wallUpdateCacheRef.current.set(wallId, cacheKey);
        return;
      }

      const threshold = getWallUpdateThreshold(effectiveOptions);
      const startChanged = updates.startPoint
        ? magnitude(subtract(updates.startPoint, current.startPoint)) > threshold
        : false;
      const endChanged = updates.endPoint
        ? magnitude(subtract(updates.endPoint, current.endPoint)) > threshold
        : false;
      const thicknessChanged =
        updates.thickness !== undefined
          ? Math.abs(updates.thickness - current.thickness) > threshold
          : false;

      if (!startChanged && !endChanged && !thicknessChanged) {
        wallUpdateCacheRef.current.set(wallId, cacheKey);
        return;
      }
      optionsRef.current.updateWall(wallId, updates, effectiveOptions);
      wallUpdateCacheRef.current.set(wallId, cacheKey);
    },
    [findWallById, getWallUpdateThreshold, withDragPerfOptions]
  );

  const updateWallsIfChanged = useCallback(
    (entries: Array<{ id: string; updates: Partial<Wall> }>, options?: WallUpdateOptions) => {
      const effectiveOptions = withDragPerfOptions(options);
      if (entries.length === 0) {
        return;
      }

      const merged = new Map<string, Partial<Wall>>();
      entries.forEach(({ id, updates }) => {
        const existing = merged.get(id) ?? {};
        merged.set(id, {
          ...existing,
          ...updates,
          startBevel: updates.startBevel ?? existing.startBevel,
          endBevel: updates.endBevel ?? existing.endBevel,
        });
      });

      const changedEntries: Array<{ id: string; updates: Partial<Wall> }> = [];
      const threshold = getWallUpdateThreshold(effectiveOptions);

      merged.forEach((updates, wallId) => {
        const cacheKey = [
          `s:${pointCacheKey(updates.startPoint)}`,
          `e:${pointCacheKey(updates.endPoint)}`,
          `t:${updates.thickness !== undefined ? updates.thickness.toFixed(3) : ''}`,
        ].join('|');
        const cached = wallUpdateCacheRef.current.get(wallId);
        if (cached === cacheKey) {
          return;
        }

        const current = findWallById(wallId);
        if (!current) {
          changedEntries.push({ id: wallId, updates });
          wallUpdateCacheRef.current.set(wallId, cacheKey);
          return;
        }

        const startChanged = updates.startPoint
          ? magnitude(subtract(updates.startPoint, current.startPoint)) > threshold
          : false;
        const endChanged = updates.endPoint
          ? magnitude(subtract(updates.endPoint, current.endPoint)) > threshold
          : false;
        const thicknessChanged =
          updates.thickness !== undefined
            ? Math.abs(updates.thickness - current.thickness) > threshold
            : false;

        if (!startChanged && !endChanged && !thicknessChanged) {
          wallUpdateCacheRef.current.set(wallId, cacheKey);
          return;
        }

        changedEntries.push({ id: wallId, updates });
        wallUpdateCacheRef.current.set(wallId, cacheKey);
      });

      if (changedEntries.length === 0) {
        return;
      }

      optionsRef.current.updateWalls(changedEntries, effectiveOptions);
    },
    [findWallById, getWallUpdateThreshold, withDragPerfOptions]
  );

  const connectWallsIfNeeded = useCallback((wallId: string, otherWallId: string) => {
    if (wallId === otherWallId) return;
    const pairKey = wallId < otherWallId ? `${wallId}|${otherWallId}` : `${otherWallId}|${wallId}`;
    if (connectedPairCacheRef.current.has(pairKey)) return;

    const wall = findWallById(wallId);
    const otherWall = findWallById(otherWallId);
    if (
      wall?.connectedWalls.includes(otherWallId) &&
      otherWall?.connectedWalls.includes(wallId)
    ) {
      connectedPairCacheRef.current.add(pairKey);
      return;
    }

    optionsRef.current.connectWalls(wallId, otherWallId);
    connectedPairCacheRef.current.add(pairKey);
  }, [findWallById]);

  const resetDragDynamics = useCallback((point: Point2D) => {
    smoothedPointerRef.current = { ...point };
    dragChangedRef.current = false;
    endpointSnapMemoryRef.current = null;
    wallUpdateCacheRef.current.clear();
    connectedPairCacheRef.current.clear();
    lastOverlapCheckAtRef.current = 0;
    lastOverlapWarningRef.current = false;
  }, []);

  const beginControlDrag = useCallback((meta: TargetMeta, point: Point2D) => {
    if (!meta.controlType) return false;

    if (meta.controlType === 'room-center-handle' && meta.roomId) {
      const room = findRoomById(meta.roomId);
      if (!room) return false;

      isWallHandleDraggingRef.current = true;
      resetDragDynamics(point);
      const ghostWalls = room.wallIds
        .map((wallId) => findWallById(wallId))
        .filter((wall): wall is Wall => Boolean(wall));
      showGhostWalls(ghostWalls);

      dragStateRef.current = {
        mode: 'room-move',
        roomId: room.id,
        startPointer: { ...point },
        lastAppliedDelta: { x: 0, y: 0 },
        ghostWalls,
      };
      optionsRef.current.onRoomDragStateChange?.(room.id);
      return true;
    }

    if (meta.controlType === 'room-corner-handle' && meta.roomId && typeof meta.cornerIndex === 'number') {
      const room = findRoomById(meta.roomId);
      if (!room) return false;
      const baselineWalls = new Map<string, Wall>();
      room.wallIds.forEach((wallId) => {
        const roomWall = findWallById(wallId);
        if (roomWall) {
          baselineWalls.set(wallId, { ...roomWall });
        }
      });

      isWallHandleDraggingRef.current = true;
      resetDragDynamics(point);
      showGhostWalls(Array.from(baselineWalls.values()));
      dragStateRef.current = {
        mode: 'room-corner',
        roomId: room.id,
        cornerIndex: meta.cornerIndex,
        startPointer: { ...point },
        baselineRoom: {
          ...room,
          vertices: room.vertices.map((vertex) => ({ ...vertex })),
          holes: room.holes?.map((hole) => hole.map((vertex) => ({ ...vertex }))),
          wallIds: [...room.wallIds],
        },
        baselineWalls,
      };
      optionsRef.current.onRoomDragStateChange?.(room.id);
      return true;
    }

    if (meta.controlType === 'room-scale-handle' && meta.roomId && meta.scaleDirection) {
      const room = findRoomById(meta.roomId);
      if (!room) return false;
      const baselineWalls = new Map<string, Wall>();
      room.wallIds.forEach((wallId) => {
        const roomWall = findWallById(wallId);
        if (roomWall) {
          baselineWalls.set(wallId, { ...roomWall });
        }
      });

      isWallHandleDraggingRef.current = true;
      resetDragDynamics(point);
      showGhostWalls(Array.from(baselineWalls.values()));
      dragStateRef.current = {
        mode: 'room-scale',
        roomId: room.id,
        direction: meta.scaleDirection,
        startPointer: { ...point },
        baselineRoom: {
          ...room,
          vertices: room.vertices.map((vertex) => ({ ...vertex })),
          holes: room.holes?.map((hole) => hole.map((vertex) => ({ ...vertex }))),
          wallIds: [...room.wallIds],
        },
        baselineWalls,
      };
      optionsRef.current.onRoomDragStateChange?.(room.id);
      return true;
    }

    if (meta.controlType === 'room-rotation-handle' && meta.roomId) {
      const room = findRoomById(meta.roomId);
      if (!room) return false;
      if (!isRoomIsolatedFromAttachments(room, optionsRef.current.walls)) {
        return false;
      }
      const baselineWalls = new Map<string, Wall>();
      room.wallIds.forEach((wallId) => {
        const roomWall = findWallById(wallId);
        if (roomWall) {
          baselineWalls.set(wallId, { ...roomWall });
        }
      });
      const pivot = { ...room.centroid };
      const baselineAngleRad = Math.atan2(point.y - pivot.y, point.x - pivot.x);
      isWallHandleDraggingRef.current = true;
      resetDragDynamics(point);

      dragStateRef.current = {
        mode: 'room-rotate',
        roomId: room.id,
        pivot,
        baselineAngleRad,
        baselineReferenceAngleRad: getRoomPrimaryAxisAngleRad(room.vertices),
        baselineRoom: {
          ...room,
          centroid: { ...room.centroid },
          vertices: room.vertices.map((vertex) => ({ ...vertex })),
          holes: room.holes?.map((hole) => hole.map((vertex) => ({ ...vertex }))),
          wallIds: [...room.wallIds],
        },
        baselineWalls,
      };
      optionsRef.current.onRoomDragStateChange?.(room.id);
      return true;
    }

    if (
      meta.wallId &&
      meta.roomBoundaryStartPoint &&
      meta.roomBoundaryEndPoint
    ) {
      meta.wallId = optionsRef.current.selectWallSegmentWithinInterval(
        meta.wallId,
        meta.roomBoundaryStartPoint,
        meta.roomBoundaryEndPoint
      );
    }

    if (!meta.wallId) return false;
    const wall = findWallById(meta.wallId);
    if (!wall) return false;

    isWallHandleDraggingRef.current = true;
    resetDragDynamics(point);
    if (meta.controlType === 'wall-thickness-exterior' || meta.controlType === 'wall-thickness-interior') {
      const endpointConstraints: MoveEndpointConstraint[] = [];
      const startConstraints = buildEndpointConstraints(
        wall,
        'start',
        new Set([wall.id])
      );
      if (startConstraints.connectedEndpoints.length > 0 || startConstraints.segmentConstraints.length > 0) {
        endpointConstraints.push({
          wallId: wall.id,
          endpoint: 'start',
          connectedEndpoints: startConstraints.connectedEndpoints,
          segmentConstraints: startConstraints.segmentConstraints,
        });
      }
      const endConstraints = buildEndpointConstraints(
        wall,
        'end',
        new Set([wall.id])
      );
      if (endConstraints.connectedEndpoints.length > 0 || endConstraints.segmentConstraints.length > 0) {
        endpointConstraints.push({
          wallId: wall.id,
          endpoint: 'end',
          connectedEndpoints: endConstraints.connectedEndpoints,
          segmentConstraints: endConstraints.segmentConstraints,
        });
      }

      dragStateRef.current = {
        mode: 'thickness',
        wallId: wall.id,
        side: meta.controlType === 'wall-thickness-interior' ? 'interior' : 'exterior',
        startPointer: { ...point },
        baselineWall: { ...wall },
        normal: wallNormal(wall),
        endpointConstraints,
      };
      return true;
    }

    if (meta.controlType === 'wall-center-handle') {
      const selectedWallIds = optionsRef.current.selectedIds.includes(wall.id)
        ? optionsRef.current.selectedIds.filter((id) => Boolean(findWallById(id)))
        : [wall.id];
      const selectedWallIdSet = new Set(selectedWallIds);
      const baselineWalls = new Map<string, Wall>();
      for (const wallId of selectedWallIds) {
        const selectedWall = findWallById(wallId);
        if (selectedWall) baselineWalls.set(wallId, { ...selectedWall });
      }

      const endpointConstraints: MoveEndpointConstraint[] = [];
      baselineWalls.forEach((baselineWall) => {
        const startConstraints = buildEndpointConstraints(
          baselineWall,
          'start',
          selectedWallIdSet
        );
        if (startConstraints.connectedEndpoints.length > 0 || startConstraints.segmentConstraints.length > 0) {
          endpointConstraints.push({
            wallId: baselineWall.id,
            endpoint: 'start',
            connectedEndpoints: startConstraints.connectedEndpoints,
            segmentConstraints: startConstraints.segmentConstraints,
          });
        }

        const endConstraints = buildEndpointConstraints(
          baselineWall,
          'end',
          selectedWallIdSet
        );
        if (endConstraints.connectedEndpoints.length > 0 || endConstraints.segmentConstraints.length > 0) {
          endpointConstraints.push({
            wallId: baselineWall.id,
            endpoint: 'end',
            connectedEndpoints: endConstraints.connectedEndpoints,
            segmentConstraints: endConstraints.segmentConstraints,
          });
        }
      });

      const constrainedNormal = baselineWalls.size === 1 ? wallNormal(wall) : null;

      dragStateRef.current = {
        mode: 'move',
        wallIds: Array.from(baselineWalls.keys()),
        anchorWallId: wall.id,
        startPointer: { ...point },
        baselineWalls,
        constrainedNormal,
        endpointConstraints,
      };
      return true;
    }

    if (meta.controlType === 'wall-rotation-handle') {
      if (!canRotateWall(wall)) {
        isWallHandleDraggingRef.current = false;
        return false;
      }
      const connectedEndpoints: ConnectedEndpointRef[] = [];
      for (const connectedWallId of wall.connectedWalls) {
        const connectedWall = findWallById(connectedWallId);
        if (!connectedWall) continue;
        if (pointsNear(connectedWall.startPoint, wall.startPoint)) {
          connectedEndpoints.push({ wallId: connectedWall.id, endpoint: 'start' });
        } else if (pointsNear(connectedWall.endPoint, wall.startPoint)) {
          connectedEndpoints.push({ wallId: connectedWall.id, endpoint: 'end' });
        }
        if (pointsNear(connectedWall.startPoint, wall.endPoint)) {
          connectedEndpoints.push({ wallId: connectedWall.id, endpoint: 'start' });
        } else if (pointsNear(connectedWall.endPoint, wall.endPoint)) {
          connectedEndpoints.push({ wallId: connectedWall.id, endpoint: 'end' });
        }
      }

      dragStateRef.current = {
        mode: 'rotate',
        wallId: wall.id,
        baselineWall: { ...wall },
        connectedEndpoints,
        operation: new WallRotationOperation(wall, {
          updateWall: (id, updates) =>
            optionsRef.current.updateWall(id, updates, {
              skipHistory: true,
              source: 'drag',
              skipRoomDetection: true,
              skipElevationRegeneration: true,
            }),
        }),
      };
      return true;
    }

    if (meta.controlType === 'wall-endpoint-start' || meta.controlType === 'wall-endpoint-end') {
      const endpoint: 'start' | 'end' =
        meta.controlType === 'wall-endpoint-start' ? 'start' : 'end';
      const { connectedEndpoints, segmentConstraints } = buildEndpointConstraints(
        wall,
        endpoint,
        new Set([wall.id])
      );

      dragStateRef.current = {
        mode: 'endpoint',
        wallId: wall.id,
        endpoint,
        startPointer: { ...point },
        baselineWall: { ...wall },
        fixedPoint: endpoint === 'start' ? { ...wall.endPoint } : { ...wall.startPoint },
        connectedEndpoints,
        segmentConstraints,
      };
      return true;
    }

    return false;
  }, [buildEndpointConstraints, canRotateWall, findRoomById, findWallById, resetDragDynamics, showGhostWalls]);

  const computePerpendicularSnap = useCallback(
    (state: EndpointDragState, candidatePoint: Point2D): { snapped: Point2D; line?: { start: Point2D; end: Point2D } } => {
      const connectedWalls = state.baselineWall.connectedWalls
        .map((wallId) => findWallById(wallId))
        .filter((wall): wall is Wall => Boolean(wall));

      for (const connectedWall of connectedWalls) {
        const perpDir = perpendicularDirection(connectedWall, state.fixedPoint);
        if (!perpDir) continue;

        const candidateDirection = normalize(subtract(candidatePoint, state.fixedPoint));
        const angle = Math.acos(clamp(dot(candidateDirection, perpDir), -1, 1)) * (180 / Math.PI);
        const angleAlt = Math.min(angle, Math.abs(180 - angle));
        if (angleAlt > PERPENDICULAR_SNAP_TOLERANCE_DEG) continue;

        const projectedLength = dot(subtract(candidatePoint, state.fixedPoint), perpDir);
        const snapped = add(state.fixedPoint, scale(perpDir, projectedLength));
        return {
          snapped,
          line: { start: state.fixedPoint, end: snapped },
        };
      }

      return { snapped: candidatePoint };
    },
    [findWallById]
  );

  const hasOverlapWithUnselectedWalls = useCallback((candidates: Map<string, Wall>): boolean => {
    const candidateIds = new Set(candidates.keys());
    const otherWalls = optionsRef.current.walls.filter((wall) => !candidateIds.has(wall.id));

    for (const candidate of candidates.values()) {
      for (const other of otherWalls) {
        if (wallsLikelyOverlapping(candidate, other)) {
          return true;
        }
      }
    }
    return false;
  }, []);

  const applyDrag = useCallback((point: Point2D): DragApplyResult | null => {
    const state = dragStateRef.current;
    if (state.mode === 'idle') return null;

    if (state.mode === 'thickness') {
      const baseline = state.baselineWall;
      const normal = state.normal;
      const enableThicknessPresetSnap = modifierKeysRef.current.shift;
      const sideSign = state.side === 'interior' ? 1 : -1;
      const pointerDelta = subtract(point, state.startPointer);
      const projectedDelta = dot(pointerDelta, normal);

      // Independent face resize:
      // - Dragging interior/exterior moves only that face.
      // - Opposite face remains anchored by shifting centerline half of delta.
      const rawThickness = baseline.thickness + sideSign * projectedDelta;
      const nextThickness = clamp(
        enableThicknessPresetSnap ? snapThickness(rawThickness) : rawThickness,
        MIN_WALL_THICKNESS,
        MAX_WALL_THICKNESS
      );
      const appliedFaceDelta = nextThickness - baseline.thickness;
      const centerlineShift = sideSign * (appliedFaceDelta / 2);

      let nextStart = add(baseline.startPoint, scale(normal, centerlineShift));
      let nextEnd = add(baseline.endPoint, scale(normal, centerlineShift));

      // Keep T-junction endpoints bonded when a face resize shifts wall centerline.
      for (const endpointConstraint of state.endpointConstraints) {
        let constrainedPoint = endpointConstraint.endpoint === 'start'
          ? { ...nextStart }
          : { ...nextEnd };

        if (endpointConstraint.segmentConstraints.length > 0) {
          let bestProjection = projectPointToSegment(
            constrainedPoint,
            endpointConstraint.segmentConstraints[0].startPoint,
            endpointConstraint.segmentConstraints[0].endPoint
          );
          let bestConstraint = endpointConstraint.segmentConstraints[0];
          for (let i = 1; i < endpointConstraint.segmentConstraints.length; i += 1) {
            const projection = projectPointToSegment(
              constrainedPoint,
              endpointConstraint.segmentConstraints[i].startPoint,
              endpointConstraint.segmentConstraints[i].endPoint
            );
            if (projection.distance < bestProjection.distance) {
              bestProjection = projection;
              bestConstraint = endpointConstraint.segmentConstraints[i];
            }
          }
          constrainedPoint = bestProjection.point;
          connectWallsIfNeeded(state.wallId, bestConstraint.wallId);
        }

        if (endpointConstraint.endpoint === 'start') {
          nextStart = constrainedPoint;
        } else {
          nextEnd = constrainedPoint;
        }
      }

      const followerUpdates = new Map<string, Partial<Wall>>();
      for (const endpointConstraint of state.endpointConstraints) {
        const movedPoint = endpointConstraint.endpoint === 'start' ? nextStart : nextEnd;
        for (const connected of endpointConstraint.connectedEndpoints) {
          const pending = followerUpdates.get(connected.wallId) ?? {};
          if (connected.endpoint === 'start') {
            pending.startPoint = movedPoint;
          } else {
            pending.endPoint = movedPoint;
          }
          followerUpdates.set(connected.wallId, pending);
          connectWallsIfNeeded(state.wallId, connected.wallId);
        }
      }

      const thicknessUpdates: Array<{ id: string; updates: Partial<Wall> }> = [
        {
          id: baseline.id,
          updates: {
            startPoint: nextStart,
            endPoint: nextEnd,
            thickness: nextThickness,
          },
        },
      ];
      followerUpdates.forEach((updates, wallId) => {
        thicknessUpdates.push({ id: wallId, updates });
      });
      updateWallsIfChanged(thicknessUpdates, { skipHistory: true, source: 'drag' });

      const updatedWall: Wall = {
        ...baseline,
        startPoint: nextStart,
        endPoint: nextEnd,
        thickness: nextThickness,
      };
      setStatusFromWall(updatedWall);

      const updatedNormal = wallNormal(updatedWall);
      const updatedCenter = midpoint(updatedWall.startPoint, updatedWall.endPoint);
      const handlePoint = add(
        updatedCenter,
        scale(updatedNormal, sideSign * nextThickness / 2)
      );

      return {
        label: `${state.side === 'interior' ? 'Inner' : 'Outer'} ${Math.round(nextThickness)} mm`,
        point: handlePoint,
      };
    }

    if (state.mode === 'move') {
      const { wallSettings } = optionsRef.current;
      const gridSize = Math.max(1, wallSettings.gridSize);
      const shouldGridSnap = wallSettings.snapToGrid && modifierKeysRef.current.shift;
      let translation = subtract(point, state.startPointer);

      if (state.constrainedNormal) {
        const alongNormal = dot(translation, state.constrainedNormal);
        const snapped = shouldGridSnap ? Math.round(alongNormal / gridSize) * gridSize : alongNormal;
        translation = scale(state.constrainedNormal, snapped);
      } else if (shouldGridSnap) {
        translation = {
          x: Math.round(translation.x / gridSize) * gridSize,
          y: Math.round(translation.y / gridSize) * gridSize,
        };
      }

      const candidates = new Map<string, Wall>();
      for (const wallId of state.wallIds) {
        const baselineWall = state.baselineWalls.get(wallId);
        if (!baselineWall) continue;
        candidates.set(wallId, {
          ...baselineWall,
          startPoint: add(baselineWall.startPoint, translation),
          endPoint: add(baselineWall.endPoint, translation),
        });
      }

      // Keep moving-wall junctions bonded to host wall center-lines (T-junction support).
      for (const endpointConstraint of state.endpointConstraints) {
        const candidateWall = candidates.get(endpointConstraint.wallId);
        if (!candidateWall) continue;

        let constrainedPoint =
          endpointConstraint.endpoint === 'start'
            ? { ...candidateWall.startPoint }
            : { ...candidateWall.endPoint };

        if (endpointConstraint.segmentConstraints.length > 0) {
          let bestProjection = projectPointToSegment(
            constrainedPoint,
            endpointConstraint.segmentConstraints[0].startPoint,
            endpointConstraint.segmentConstraints[0].endPoint
          );
          for (let i = 1; i < endpointConstraint.segmentConstraints.length; i += 1) {
            const projection = projectPointToSegment(
              constrainedPoint,
              endpointConstraint.segmentConstraints[i].startPoint,
              endpointConstraint.segmentConstraints[i].endPoint
            );
            if (projection.distance < bestProjection.distance) {
              bestProjection = projection;
            }
          }
          constrainedPoint = bestProjection.point;
        }

        if (endpointConstraint.endpoint === 'start') {
          candidateWall.startPoint = constrainedPoint;
        } else {
          candidateWall.endPoint = constrainedPoint;
        }
      }

      const now =
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
      if (now - lastOverlapCheckAtRef.current >= OVERLAP_CHECK_MIN_INTERVAL_MS) {
        lastOverlapCheckAtRef.current = now;
        lastOverlapWarningRef.current = hasOverlapWithUnselectedWalls(candidates);
      }
      if (lastOverlapWarningRef.current) {
        optionsRef.current.setProcessingStatus('Overlap warning: wall intersects other walls.', false);
      }

      // Elastic mode: stretch neighboring non-selected walls by moving shared endpoints.
      const followerUpdates = new Map<string, Partial<Wall>>();
      for (const endpointConstraint of state.endpointConstraints) {
        const candidateWall = candidates.get(endpointConstraint.wallId);
        if (!candidateWall) continue;
        const movedPoint =
          endpointConstraint.endpoint === 'start'
            ? candidateWall.startPoint
            : candidateWall.endPoint;

        for (const connected of endpointConstraint.connectedEndpoints) {
          const pending = followerUpdates.get(connected.wallId) ?? {};
          if (connected.endpoint === 'start') {
            pending.startPoint = movedPoint;
          } else {
            pending.endPoint = movedPoint;
          }
          followerUpdates.set(connected.wallId, pending);
          connectWallsIfNeeded(endpointConstraint.wallId, connected.wallId);
        }
      }

      const dragUpdates: Array<{ id: string; updates: Partial<Wall> }> = [];
      candidates.forEach((candidateWall, wallId) => {
        dragUpdates.push({
          id: wallId,
          updates: {
            startPoint: candidateWall.startPoint,
            endPoint: candidateWall.endPoint,
          },
        });
      });
      followerUpdates.forEach((updates, wallId) => {
        dragUpdates.push({ id: wallId, updates });
      });
      updateWallsIfChanged(dragUpdates, { skipHistory: true, source: 'drag' });

      const anchor = candidates.get(state.anchorWallId);
      if (anchor) {
        setStatusFromWall(anchor);
      }

      const translationLength = Math.round(magnitude(translation));
      const labelPoint = anchor
        ? midpoint(anchor.startPoint, anchor.endPoint)
        : point;
      return {
        label: `Move ${translationLength} mm`,
        point: labelPoint,
      };
    }

    if (state.mode === 'room-move') {
      const room = findRoomById(state.roomId);
      if (!room) return null;
      const { wallSettings } = optionsRef.current;
      let translation = subtract(point, state.startPointer);
      if (wallSettings.snapToGrid && modifierKeysRef.current.shift) {
        translation = {
          x: Math.round(translation.x / wallSettings.gridSize) * wallSettings.gridSize,
          y: Math.round(translation.y / wallSettings.gridSize) * wallSettings.gridSize,
        };
      }

      let roomSnap: RoomMagneticSnapResult | null = null;
      if (!modifierKeysRef.current.ctrl) {
        roomSnap = findRoomMagneticSnap(state, translation);
        if (roomSnap) {
          translation = add(translation, roomSnap.delta);
          showSnapIndicator(
            roomSnap.targetPoint,
            {
              start: roomSnap.sourcePoint,
              end: roomSnap.targetPoint,
            },
            {
              color: '#0ea5e9',
              indicator: roomSnap.kind === 'endpoint' ? 'square' : 'cross',
            }
          );
        } else {
          clearSnapIndicators();
        }
      } else {
        clearSnapIndicators();
      }

      const delta = {
        x: translation.x - state.lastAppliedDelta.x,
        y: translation.y - state.lastAppliedDelta.y,
      };
      if (Math.abs(delta.x) > 0.0001 || Math.abs(delta.y) > 0.0001) {
        optionsRef.current.moveRoom(state.roomId, delta, { skipHistory: true });
        state.lastAppliedDelta = translation;
        if (roomSnap) {
          connectWallsIfNeeded(roomSnap.movingWallId, roomSnap.targetWallId);
        }
      }

      const movedCentroid = add(room.centroid, translation);
      setStatusFromRoom({
        ...room,
        centroid: movedCentroid,
      });

      return {
        label: roomSnap
          ? `${room.name} attached | ${Math.round(magnitude(translation))} mm`
          : `${room.name} move ${Math.round(magnitude(translation))} mm`,
        point: movedCentroid,
        snapPoint: roomSnap?.targetPoint,
      };
    }

    if (state.mode === 'room-corner') {
      const room = findRoomById(state.roomId);
      if (!room) return null;

      const nextVertices = state.baselineRoom.vertices.map((vertex) => ({ ...vertex }));
      const baselineCorner = state.baselineRoom.vertices[state.cornerIndex];
      const translation = subtract(point, state.startPointer);
      let nextCorner = add(baselineCorner, translation);
      if (optionsRef.current.wallSettings.snapToGrid && modifierKeysRef.current.shift) {
        nextCorner = snapToGrid(nextCorner, optionsRef.current.wallSettings.gridSize);
      }
      nextVertices[state.cornerIndex] = nextCorner;

      const validation = validateRoomVertices(nextVertices);
      if (!validation.valid) {
        optionsRef.current.setProcessingStatus(validation.reason ?? 'Invalid room edit.', false);
        return null;
      }

      const roomCornerUpdates: Array<{ id: string; updates: Partial<Wall> }> = [];
      state.baselineWalls.forEach((baselineWall, wallId) => {
        let nextStart = { ...baselineWall.startPoint };
        let nextEnd = { ...baselineWall.endPoint };
        state.baselineRoom.vertices.forEach((baselineVertex, vertexIndex) => {
          if (pointsNear(baselineWall.startPoint, baselineVertex)) {
            nextStart = { ...nextVertices[vertexIndex] };
          }
          if (pointsNear(baselineWall.endPoint, baselineVertex)) {
            nextEnd = { ...nextVertices[vertexIndex] };
          }
        });
        if (!pointsNear(nextStart, baselineWall.startPoint) || !pointsNear(nextEnd, baselineWall.endPoint)) {
          roomCornerUpdates.push({
            id: wallId,
            updates: { startPoint: nextStart, endPoint: nextEnd },
          });
        }
      });
      updateWallsIfChanged(
        roomCornerUpdates,
        { skipHistory: true, source: 'drag' }
      );

      const areaM2 = GeometryEngine.calculateRoomAreaM2({ vertices: nextVertices });
      const centroid = GeometryEngine.findRoomCentroid({ vertices: nextVertices });
      optionsRef.current.setProcessingStatus(
        `${room.name}: Area ${areaM2.toFixed(2)}m²`,
        false
      );
      return {
        label: `Corner edit | Area ${areaM2.toFixed(2)} m²`,
        point: centroid,
      };
    }

    if (state.mode === 'room-scale') {
      const room = findRoomById(state.roomId);
      if (!room) return null;

      const bounds = roomBounds(state.baselineRoom.vertices);
      const origin = oppositeScaleAnchor(state.direction, bounds);
      const center = {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
      };
      const handlePointByDirection: Record<typeof state.direction, Point2D> = {
        NW: { x: bounds.minX, y: bounds.minY },
        N: { x: center.x, y: bounds.minY },
        NE: { x: bounds.maxX, y: bounds.minY },
        E: { x: bounds.maxX, y: center.y },
        SE: { x: bounds.maxX, y: bounds.maxY },
        S: { x: center.x, y: bounds.maxY },
        SW: { x: bounds.minX, y: bounds.maxY },
        W: { x: bounds.minX, y: center.y },
      };
      const baseHandle = handlePointByDirection[state.direction];

      let nextPointer = { ...point };
      if (optionsRef.current.wallSettings.snapToGrid && modifierKeysRef.current.shift) {
        nextPointer = snapToGrid(nextPointer, optionsRef.current.wallSettings.gridSize);
      }

      const baseDx = baseHandle.x - origin.x;
      const baseDy = baseHandle.y - origin.y;
      let scaleX = Math.abs(baseDx) < 0.001 ? 1 : (nextPointer.x - origin.x) / baseDx;
      let scaleY = Math.abs(baseDy) < 0.001 ? 1 : (nextPointer.y - origin.y) / baseDy;

      if (state.direction === 'N' || state.direction === 'S') {
        scaleX = 1;
      }
      if (state.direction === 'E' || state.direction === 'W') {
        scaleY = 1;
      }

      if (
        (state.direction === 'NW' || state.direction === 'NE' || state.direction === 'SE' || state.direction === 'SW') &&
        !modifierKeysRef.current.shift
      ) {
        const uniform = Math.max(Math.abs(scaleX), Math.abs(scaleY));
        scaleX = Math.sign(scaleX || 1) * uniform;
        scaleY = Math.sign(scaleY || 1) * uniform;
      }

      scaleX = clamp(scaleX, 0.2, 5);
      scaleY = clamp(scaleY, 0.2, 5);

      const nextVertices = state.baselineRoom.vertices.map((vertex) => ({
        x: origin.x + (vertex.x - origin.x) * scaleX,
        y: origin.y + (vertex.y - origin.y) * scaleY,
      }));

      const validation = validateRoomVertices(nextVertices);
      if (!validation.valid) {
        optionsRef.current.setProcessingStatus(validation.reason ?? 'Invalid room scaling.', false);
        return null;
      }

      const roomScaleUpdates: Array<{ id: string; updates: Partial<Wall> }> = [];
      state.baselineWalls.forEach((baselineWall, wallId) => {
        let nextStart = { ...baselineWall.startPoint };
        let nextEnd = { ...baselineWall.endPoint };
        state.baselineRoom.vertices.forEach((baselineVertex, vertexIndex) => {
          if (pointsNear(baselineWall.startPoint, baselineVertex)) {
            nextStart = { ...nextVertices[vertexIndex] };
          }
          if (pointsNear(baselineWall.endPoint, baselineVertex)) {
            nextEnd = { ...nextVertices[vertexIndex] };
          }
        });
        if (!pointsNear(nextStart, baselineWall.startPoint) || !pointsNear(nextEnd, baselineWall.endPoint)) {
          roomScaleUpdates.push({
            id: wallId,
            updates: { startPoint: nextStart, endPoint: nextEnd },
          });
        }
      });
      updateWallsIfChanged(
        roomScaleUpdates,
        { skipHistory: true, source: 'drag' }
      );

      const areaM2 = GeometryEngine.calculateRoomAreaM2({ vertices: nextVertices });
      const centroid = GeometryEngine.findRoomCentroid({ vertices: nextVertices });
      const scaleDisplay = ((Math.abs(scaleX) + Math.abs(scaleY)) / 2).toFixed(2);
      optionsRef.current.setProcessingStatus(
        `${room.name}: Scale ${scaleDisplay}x | Area ${areaM2.toFixed(2)}m²`,
        false
      );
      return {
        label: `Scale ${scaleDisplay}x | Area ${areaM2.toFixed(2)} m²`,
        point: centroid,
      };
    }

    if (state.mode === 'room-rotate') {
      const room = findRoomById(state.roomId);
      if (!room) return null;

      let deltaAngle = normalizeAngleRadians(
        Math.atan2(point.y - state.pivot.y, point.x - state.pivot.x) - state.baselineAngleRad
      );
      const unsnappedReferenceAngleRad = normalizeAngleRadians(
        state.baselineReferenceAngleRad + deltaAngle
      );
      const suggestedGuideBeforeSnap = getNearestRoomRotationGuideAngle(unsnappedReferenceAngleRad);
      if (
        !modifierKeysRef.current.ctrl &&
        !modifierKeysRef.current.shift &&
        suggestedGuideBeforeSnap.deltaDeg <= ROOM_ROTATION_MAGNETIC_SNAP_TOLERANCE_DEG
      ) {
        deltaAngle = normalizeAngleRadians(
          suggestedGuideBeforeSnap.angleRad - state.baselineReferenceAngleRad
        );
      } else if (modifierKeysRef.current.shift) {
        const snappedDeg = Math.round((deltaAngle * 180) / Math.PI / 15) * 15;
        deltaAngle = (snappedDeg * Math.PI) / 180;
      }

      const nextVertices = state.baselineRoom.vertices.map((vertex) =>
        rotatePointAround(vertex, state.pivot, deltaAngle)
      );

      const validation = validateRoomVertices(nextVertices);
      if (!validation.valid) {
        optionsRef.current.setProcessingStatus(validation.reason ?? 'Invalid room rotation.', false);
        return null;
      }

      const roomRotateUpdates: Array<{ id: string; updates: Partial<Wall> }> = [];
      state.baselineWalls.forEach((baselineWall, wallId) => {
        roomRotateUpdates.push({
          id: wallId,
          updates: {
            startPoint: rotatePointAround(baselineWall.startPoint, state.pivot, deltaAngle),
            endPoint: rotatePointAround(baselineWall.endPoint, state.pivot, deltaAngle),
          },
        });
      });

      updateWallsIfChanged(roomRotateUpdates, { skipHistory: true, source: 'drag' });

      const angleDeg = (deltaAngle * 180) / Math.PI;
      const currentReferenceAngleRad = normalizeAngleRadians(
        state.baselineReferenceAngleRad + deltaAngle
      );
      const currentReferenceAngleDeg = getLineAngleDegreesFromRadians(currentReferenceAngleRad);
      const suggestedGuide = getNearestRoomRotationGuideAngle(currentReferenceAngleRad);
      if (suggestedGuide.deltaDeg <= ROOM_ROTATION_GUIDE_VISIBILITY_TOLERANCE_DEG) {
        showRoomRotationGuide({
          pivot: state.pivot,
          baselineAngleRad: state.baselineReferenceAngleRad,
          currentAngleRad: currentReferenceAngleRad,
          suggestedAngleRad: suggestedGuide.angleRad,
          currentAngleDeg: currentReferenceAngleDeg,
          suggestedAngleDeg: suggestedGuide.angleDeg,
          suggestedAngleDeltaDeg: suggestedGuide.deltaDeg,
          radiusMm: getRoomGuideRadiusMm(state.baselineRoom.vertices, state.pivot),
        });
      } else {
        clearRotationGuide();
      }
      optionsRef.current.setProcessingStatus(
        `${room.name}: Rotation ${angleDeg >= 0 ? '+' : ''}${angleDeg.toFixed(1)}deg`,
        false
      );
      return {
        label: `Rotate ${angleDeg >= 0 ? '+' : ''}${angleDeg.toFixed(1)}deg | Axis ${currentReferenceAngleDeg.toFixed(1)}deg`,
        point: state.pivot,
      };
    }

    if (state.mode === 'rotate') {
      const rotationPreview = state.operation.onDrag(point, {
        shift: modifierKeysRef.current.shift,
        ctrl: modifierKeysRef.current.ctrl,
      });

      const rotationUpdates: Array<{ id: string; updates: Partial<Wall> }> = [
        {
          id: state.wallId,
          updates: {
            startPoint: rotationPreview.startPoint,
            endPoint: rotationPreview.endPoint,
          },
        },
      ];

      for (const connected of state.connectedEndpoints) {
        const baselineConnected = findWallById(connected.wallId);
        if (!baselineConnected) continue;
        connectWallsIfNeeded(state.wallId, connected.wallId);
        if (
          connected.endpoint === 'start' &&
          pointsNear(baselineConnected.startPoint, state.baselineWall.startPoint)
        ) {
          rotationUpdates.push({
            id: connected.wallId,
            updates: { startPoint: rotationPreview.startPoint },
          });
          continue;
        }
        if (
          connected.endpoint === 'end' &&
          pointsNear(baselineConnected.endPoint, state.baselineWall.startPoint)
        ) {
          rotationUpdates.push({
            id: connected.wallId,
            updates: { endPoint: rotationPreview.startPoint },
          });
          continue;
        }
        if (
          connected.endpoint === 'start' &&
          pointsNear(baselineConnected.startPoint, state.baselineWall.endPoint)
        ) {
          rotationUpdates.push({
            id: connected.wallId,
            updates: { startPoint: rotationPreview.endPoint },
          });
          continue;
        }
        if (
          connected.endpoint === 'end' &&
          pointsNear(baselineConnected.endPoint, state.baselineWall.endPoint)
        ) {
          rotationUpdates.push({
            id: connected.wallId,
            updates: { endPoint: rotationPreview.endPoint },
          });
        }
      }

      updateWallsIfChanged(rotationUpdates, { skipHistory: true, source: 'drag' });

      setStatusFromWall({
        ...state.baselineWall,
        startPoint: rotationPreview.startPoint,
        endPoint: rotationPreview.endPoint,
      });
      return {
        label: `Angle ${rotationPreview.absoluteAngleDeg.toFixed(1)}deg | Delta ${rotationPreview.deltaAngleDeg >= 0 ? '+' : ''
          }${rotationPreview.deltaAngleDeg.toFixed(1)}deg`,
        point: midpoint(rotationPreview.startPoint, rotationPreview.endPoint),
      };
    }

    const endpointState = state;
    let snappedPoint = { ...point };
    let snapPoint: Point2D | undefined;
    let snapLine: { start: Point2D; end: Point2D } | undefined;
    let snappedWallId: string | undefined;
    const snapReleaseDistanceMm = getSnapReleaseDistanceMm();
    const snapMemory = endpointSnapMemoryRef.current;
    const canReuseSnapMemory =
      snapMemory?.mode === 'endpoint' && snapMemory.wallId === endpointState.wallId;

    const preciseSnapMode = modifierKeysRef.current.alt;
    if (!modifierKeysRef.current.ctrl) {
      const safeZoom = Math.max(optionsRef.current.zoom, 0.01);
      const baseSnapDistancePx = Math.max(
        optionsRef.current.wallSettings.endpointSnapTolerance,
        optionsRef.current.wallSettings.midpointSnapTolerance
      );
      // Endpoint drags are smoother with a tighter default magnet and no heavy
      // intersection/perpendicular scan each frame. Hold Alt for full precision snaps.
      const workingSnapDistancePx = preciseSnapMode
        ? baseSnapDistancePx
        : Math.max(ENDPOINT_MIN_SNAP_DISTANCE_PX, baseSnapDistancePx * ENDPOINT_DEFAULT_SNAP_DISTANCE_FACTOR);
      const snapSearchRadiusMm = Math.max(
        8,
        (workingSnapDistancePx * ENDPOINT_DEFAULT_SNAP_SEARCH_RADIUS_FACTOR) / (MM_TO_PX * safeZoom)
      );
      const nearbyWalls = optionsRef.current.walls.filter((candidateWall) => {
        if (candidateWall.id === endpointState.wallId) return false;
        if (magnitude(subtract(candidateWall.startPoint, snappedPoint)) <= snapSearchRadiusMm) return true;
        if (magnitude(subtract(candidateWall.endPoint, snappedPoint)) <= snapSearchRadiusMm) return true;
        return distancePointToSegment(
          snappedPoint,
          candidateWall.startPoint,
          candidateWall.endPoint
        ) <= snapSearchRadiusMm;
      });

      const snap = nearbyWalls.length > 0
        ? snapManagerRef.current.findBestSnap({
          point: snappedPoint,
          walls: nearbyWalls,
          zoom: optionsRef.current.zoom,
          gridSizeMm: optionsRef.current.wallSettings.gridSize,
          enableGridSnap: false,
          includeMidpointSnap: preciseSnapMode,
          includeIntersectionSnap: preciseSnapMode,
          includePerpendicularSnap: preciseSnapMode,
          snapDistancePx: workingSnapDistancePx,
          excludeWallId: endpointState.wallId,
          referencePoint: endpointState.fixedPoint,
        })
        : null;

      if (snap) {
        snappedPoint = snap.point;
        snappedWallId = snap.wallId;
        snapPoint = snap.point;
        endpointSnapMemoryRef.current = {
          mode: 'endpoint',
          wallId: endpointState.wallId,
          point: { ...snap.point },
          snappedWallId: snap.wallId,
          visual: {
            color: snap.visual.color,
            indicator: snap.visual.indicator,
          },
        };
        showSnapIndicator(snap.point, undefined, {
          color: snap.visual.color,
          indicator: snap.visual.indicator,
        });
      } else if (canReuseSnapMemory && snapMemory) {
        const releaseDistanceMm = preciseSnapMode
          ? snapReleaseDistanceMm
          : Math.max(4, snapReleaseDistanceMm * ENDPOINT_DEFAULT_SNAP_RELEASE_FACTOR);
        const distanceToMemory = magnitude(subtract(snappedPoint, snapMemory.point));
        if (distanceToMemory <= releaseDistanceMm) {
          snappedPoint = { ...snapMemory.point };
          snapPoint = { ...snapMemory.point };
          snappedWallId = snapMemory.snappedWallId;
          const memoryVisual = snapMemory.visual ?? { color: '#2563EB', indicator: 'circle' as const };
          showSnapIndicator(snapMemory.point, undefined, {
            color: memoryVisual.color,
            indicator: memoryVisual.indicator,
          });
        } else {
          endpointSnapMemoryRef.current = null;
        }
      }
    } else if (canReuseSnapMemory) {
      endpointSnapMemoryRef.current = null;
    }

    if (optionsRef.current.wallSettings.snapToGrid && modifierKeysRef.current.shift && !snapPoint) {
      snappedPoint = snapToGrid(snappedPoint, optionsRef.current.wallSettings.gridSize);
      snapPoint = snappedPoint;
      showSnapIndicator(snappedPoint, undefined, {
        color: '#10B981',
        indicator: 'circle',
      });
    }

    const perpendicularSnap = (modifierKeysRef.current.ctrl || !preciseSnapMode)
      ? { snapped: snappedPoint as Point2D }
      : computePerpendicularSnap(endpointState, snappedPoint);
    if (!snapPoint && perpendicularSnap.line) {
      snappedPoint = perpendicularSnap.snapped;
      snapLine = perpendicularSnap.line;
      snapPoint = perpendicularSnap.snapped;
    }

    const endpointVector = subtract(snappedPoint, endpointState.fixedPoint);
    const endpointDistance = magnitude(endpointVector);
    if (endpointDistance < MIN_WALL_LENGTH) {
      const direction = endpointDistance < 0.0001
        ? wallDirection(endpointState.baselineWall)
        : normalize(endpointVector);
      snappedPoint = add(endpointState.fixedPoint, scale(direction, MIN_WALL_LENGTH));
    }

    if (endpointState.segmentConstraints.length > 0) {
      let bestProjection = projectPointToSegment(
        snappedPoint,
        endpointState.segmentConstraints[0].startPoint,
        endpointState.segmentConstraints[0].endPoint
      );
      let bestConstraint = endpointState.segmentConstraints[0];
      for (let i = 1; i < endpointState.segmentConstraints.length; i += 1) {
        const projection = projectPointToSegment(
          snappedPoint,
          endpointState.segmentConstraints[i].startPoint,
          endpointState.segmentConstraints[i].endPoint
        );
        if (projection.distance < bestProjection.distance) {
          bestProjection = projection;
          bestConstraint = endpointState.segmentConstraints[i];
        }
      }
      snappedPoint = bestProjection.point;
      snapPoint = snappedPoint;
      snapLine = { start: bestConstraint.startPoint, end: bestConstraint.endPoint };
      connectWallsIfNeeded(endpointState.wallId, bestConstraint.wallId);
    }

    const endpointUpdates: Array<{ id: string; updates: Partial<Wall> }> = [
      {
        id: endpointState.wallId,
        updates: endpointState.endpoint === 'start'
          ? { startPoint: snappedPoint }
          : { endPoint: snappedPoint },
      },
    ];

    for (const connected of endpointState.connectedEndpoints) {
      endpointUpdates.push({
        id: connected.wallId,
        updates: connected.endpoint === 'start'
          ? { startPoint: snappedPoint }
          : { endPoint: snappedPoint },
      });
      connectWallsIfNeeded(endpointState.wallId, connected.wallId);
    }

    updateWallsIfChanged(endpointUpdates, { skipHistory: true, source: 'drag' });

    if (snappedWallId) {
      connectWallsIfNeeded(endpointState.wallId, snappedWallId);
    }

    if (snapPoint || snapLine) {
      if (snapLine) {
        showSnapIndicator(snapPoint, snapLine, {
          color: '#2563EB',
          indicator: 'cross',
        });
      }
    } else {
      clearSnapIndicators();
    }

    const updatedWall: Wall =
      endpointState.endpoint === 'start'
        ? { ...endpointState.baselineWall, startPoint: snappedPoint }
        : { ...endpointState.baselineWall, endPoint: snappedPoint };
    setStatusFromWall(updatedWall);

    const lengthMm = wallLength(updatedWall);
    const angle = wallAngleDegrees(updatedWall);
    return {
      label: `Length ${Math.round(lengthMm)} mm | ${angle.toFixed(1)}deg`,
      point: midpoint(updatedWall.startPoint, updatedWall.endPoint),
      snapPoint,
    };
  }, [
    clearSnapIndicators,
    connectWallsIfNeeded,
    computePerpendicularSnap,
    findWallById,
    findRoomById,
    findRoomMagneticSnap,
    getSnapReleaseDistanceMm,
    hasOverlapWithUnselectedWalls,
    setStatusFromRoom,
    setStatusFromWall,
    clearRotationGuide,
    showRoomRotationGuide,
    showSnapIndicator,
    updateWallIfChanged,
    updateWallsIfChanged,
  ]);

  const flushDragFrame = useCallback(() => {
    const framePerfStart = startDragPerfTimer();
    frameRef.current = null;
    const point = pendingPointRef.current;
    pendingPointRef.current = null;
    if (!point) {
      endDragPerfTimer('select.flushDragFrame', framePerfStart, {
        changed: 0,
      });
      return;
    }

    const mode = dragStateRef.current.mode;
    const applyPerfStart = startDragPerfTimer();
    const result = applyDrag(point);
    endDragPerfTimer(`select.applyDrag.${mode}`, applyPerfStart, {
      changed: result ? 1 : 0,
    });
    if (!result) {
      endDragPerfTimer('select.flushDragFrame', framePerfStart, {
        changed: 0,
      });
      return;
    }
    dragChangedRef.current = true;
    setDimensionLabel(result.label, result.point);
    endDragPerfTimer('select.flushDragFrame', framePerfStart, {
      changed: 1,
    });
  }, [applyDrag, setDimensionLabel]);

  const scheduleDragFrame = useCallback((point: Point2D) => {
    const mode = dragStateRef.current.mode;
    pendingPointRef.current = mode === 'idle' ? point : smoothDragPoint(point, mode);
    if (frameRef.current !== null) return;
    if (typeof window === 'undefined') {
      flushDragFrame();
      return;
    }
    frameRef.current = window.requestAnimationFrame(flushDragFrame);
  }, [flushDragFrame, smoothDragPoint]);

  const handleMouseMove = useCallback(
    (scenePoint: Point2D, target?: FabricObject | null): boolean => {
      const dragState = dragStateRef.current;
      if (dragState.mode === 'idle') {
        const meta = getTargetMeta(target ?? null);
        const hoveredId =
          meta.wallId ??
          meta.roomId ??
          (meta.name?.startsWith('wall-') || meta.name?.startsWith('room-') ? meta.id : null) ??
          null;
        optionsRef.current.setHoveredElement(hoveredId);
        if (meta.roomId) {
          const room = findRoomById(meta.roomId);
          if (room && room.adjacentRoomIds.length > 0) {
            optionsRef.current.setProcessingStatus(
              `${room.name}: adjacent to ${room.adjacentRoomIds.length} room(s).`,
              false
            );
          }
        }
        return false;
      }

      scheduleDragFrame(scenePoint);
      return true;
    },
    [findRoomById, getTargetMeta, scheduleDragFrame]
  );

  const finishDrag = useCallback(() => {
    if (frameRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    if (pendingPointRef.current) {
      const point = pendingPointRef.current;
      pendingPointRef.current = null;
      const result = applyDrag(point);
      if (result) {
        dragChangedRef.current = true;
        setDimensionLabel(result.label, result.point);
      }
    }

    const mode = dragStateRef.current.mode;
    if (mode !== 'idle' && dragChangedRef.current) {
      const action =
        mode === 'thickness'
          ? 'Adjust wall thickness'
          : mode === 'move'
              ? 'Move wall'
              : mode === 'rotate'
                ? 'Rotate wall'
                : mode === 'room-rotate'
                  ? 'Rotate room'
                : mode === 'room-corner'
                  ? 'Edit room corner'
                  : mode === 'room-scale'
                    ? 'Scale room'
                    : mode === 'room-move'
                      ? 'Move room'
                      : 'Edit wall endpoint';
      optionsRef.current.detectRooms();
      optionsRef.current.regenerateElevations();
      optionsRef.current.saveToHistory(action);
    }

    dragStateRef.current = { mode: 'idle' };
    isWallHandleDraggingRef.current = false;
    dragChangedRef.current = false;
    smoothedPointerRef.current = null;
    endpointSnapMemoryRef.current = null;
    wallUpdateCacheRef.current.clear();
    connectedPairCacheRef.current.clear();
    optionsRef.current.onDragStateChange?.(false);
    optionsRef.current.onRoomDragStateChange?.(null);
    clearEditVisuals();
  }, [applyDrag, clearEditVisuals, setDimensionLabel]);

  const finalizeHandleDrag = useCallback(() => {
    finishDrag();
  }, [finishDrag]);

  const handleDoubleClick = useCallback((event: MouseEvent) => {
    void event;
    return false;
  }, []);

  const handleObjectMoving = useCallback((_target: FabricObject) => {
    // Object moving is disabled for wall groups. Editing is handle-driven.
  }, []);

  const handleMouseDown = useCallback(
    (
      target: FabricObject | undefined | null,
      scenePoint: { x: number; y: number },
      addToSelection: boolean = false
    ) => {
      const meta = getTargetMeta(target);

      if ((meta.isWallControl || meta.isRoomControl) && beginControlDrag(meta, scenePoint)) {
        optionsRef.current.onDragStateChange?.(true);
        const selectedPrimaryId = meta.wallId ?? meta.roomId;
        if (selectedPrimaryId && !optionsRef.current.selectedIds.includes(selectedPrimaryId)) {
          optionsRef.current.setSelectedIds([selectedPrimaryId]);
        }
        return;
      }

      const clickedId =
        meta.wallId ??
        meta.roomId ??
        (meta.name?.startsWith('wall-') || meta.name?.startsWith('room-') ? meta.id : undefined);
      if (clickedId) {
        if (addToSelection) {
          const current = new Set(optionsRef.current.selectedIds);
          if (current.has(clickedId)) {
            current.delete(clickedId);
          } else {
            current.add(clickedId);
          }
          optionsRef.current.setSelectedIds(Array.from(current));
        } else {
          optionsRef.current.setSelectedIds([clickedId]);
        }
        optionsRef.current.setHoveredElement(clickedId);
        return;
      }

      if (!addToSelection) {
        optionsRef.current.setSelectedIds([]);
      }
      optionsRef.current.setHoveredElement(null);
    },
    [beginControlDrag, getTargetMeta]
  );

  const handleMouseUp = useCallback(() => {
    if (dragStateRef.current.mode === 'idle') return false;
    finishDrag();
    return true;
  }, [finishDrag]);

  const handleRoomHover = useCallback(
    (_point: { x: number; y: number }, _viewportPoint: { x: number; y: number }) => {
      optionsRef.current.setHoveredElement(null);
    },
    []
  );

  useEffect(() => {
    return () => {
      if (frameRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(frameRef.current);
      }
      optionsRef.current.onDragStateChange?.(false);
      optionsRef.current.onRoomDragStateChange?.(null);
      clearEditVisuals();
    };
  }, [clearEditVisuals]);

  return {
    isWallHandleDraggingRef,
    getTargetMeta,
    updateSelectionFromTarget,
    updateSelectionFromTargets,
    finalizeHandleDrag,
    handleObjectMoving,
    handleDoubleClick,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleRoomHover,
  };
}

