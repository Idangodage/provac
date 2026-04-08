/**
 * Smart Drawing Store
 *
 * Zustand store for managing drawing state with history support.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

import {
  attributeChangeObserver,
  bindRoomGeometryTo3D,
  bindWallGeometryTo3D,
  createAttributeEnvelope,
  DEFAULT_HVAC_DESIGN_CONDITIONS,
  DEFAULT_ROOM_HVAC_TEMPLATES,
  deserializeAttributeEnvelope,
  getDefaultMaterialIdForWallMaterial,
  getArchitecturalMaterial,
  DEFAULT_ARCHITECTURAL_MATERIALS,
  resolveWallMaterialFromLibrary,
  validateRoom3DAttributes,
  validateWall3DAttributes,
} from '../attributes';
import {
  createStandardElevationViews,
  regenerateElevationViews,
} from '../components/canvas/elevation';
import type { FurnitureProjectionInput } from '../components/canvas/elevation';
import {
  isRefrigerantPipeElementType,
  translateRefrigerantPipeElementProperties,
} from '../components/canvas/hvac/refrigerantPipePairModel';
import { DEFAULT_ARCHITECTURAL_OBJECT_LIBRARY } from '../data';
import type {
  Point2D,
  DisplayUnit,
  Dimension2D,
  DimensionSettings,
  Annotation2D,
  Sketch2D,
  Guide,
  SymbolInstance2D,
  DrawingLayer,
  DrawingTool,
  ImportedDrawing,
  DetectedElement,
  PageConfig,
  HistoryEntry,
  SplineSettings,
  SplineMethod,
  Room,
  Room3D,
  RoomType,
  HvacDesignConditions,
  ElevationSettings,
  ElevationView,
  Wall,
  Wall3D,
  BevelControl,
  WallDrawingState,
  WallSettings,
  WallMaterial,
  PartitionWallMode,
  SectionLine,
  SectionLineDrawingState,
  SectionLineDirection,
  SectionLineKind,
  CreateWallParams,
  RoomConfig,
  HvacElement,
  EditorViewMode,
} from '../types';
import { DEFAULT_DIMENSION_SETTINGS } from '../types';
import {
  DEFAULT_ROOM_3D,
  DEFAULT_ELEVATION_SETTINGS,
  DEFAULT_SECTION_LINE_COLOR,
  DEFAULT_SECTION_LINE_DEPTH_MM,
  DEFAULT_SECTION_LINE_DRAWING_STATE,
  DEFAULT_BEVEL_CONTROL,
  DEFAULT_WALL_3D,
  DEFAULT_WALL_SETTINGS,
  DEFAULT_WALL_DRAWING_STATE,
  DEFAULT_WALL_HEIGHT,
  DEFAULT_WALL_LAYER_COUNT,
  PARTITION_HALF_HEIGHT,
  PARTITION_TOP_CLEARANCE,
  MAX_WALL_HEIGHT,
  MAX_WALL_THICKNESS,
  MIN_WALL_HEIGHT,
  MIN_WALL_LENGTH,
  MIN_WALL_THICKNESS,
} from '../types/wall';
import { generateId } from '../utils/geometry';
import { GeometryEngine } from '../utils/geometry-engine';
import { DEFAULT_SPLINE_SETTINGS } from '../utils/spline';
import {
  clampBevelOffset,
  computeCornerBevelDotsForEndpoint,
  withUpdatedBevel,
  type CornerEnd,
} from '../utils/wallBevel';

// Import from extracted modules
import {
  DEFAULT_PAGE_CONFIG,
  DEFAULT_LAYERS,
} from './defaults';
import {
  createEmptyHistorySnapshot,
  createHistoryEntry,
  createHistorySnapshot,
} from './helpers';
import { buildAutoDetectedRooms, createRoomModel } from './autoDetectedRooms';
import {
  autoManagedDimensionSignature,
  buildAutoWallDimensions,
  buildRoomAreaDimensions,
  buildMergedAutoManagedDimensions,
  isAutoManagedDimension,
  mergeAutoManagedDimensions,
  normalizeDimensionPayload,
} from './autoManagedDimensions';
import { regenerateElevationsInBackground } from './elevationGenerationWorkerClient';
import {
  inferRoomType,
  roomTopologyHash,
  roomTypeFillColor,
} from './roomDetection';
import { syncAutoDimensionsInBackground } from './autoDimensionWorkerClient';
import { detectRoomsInBackground } from './roomDetectionWorkerClient';

const AUTO_TRIM_TOLERANCE_MM = 120;
const STRAIGHT_WALL_MERGE_NODE_TOLERANCE_MM = 4;
const STRAIGHT_WALL_MERGE_ANGLE_TOLERANCE_DEG = 6;
const STRAIGHT_WALL_MERGE_THICKNESS_TOLERANCE_MM = 1;
const COINCIDENT_WALL_TOLERANCE_MM = 2;
const COINCIDENT_WALL_THICKNESS_TOLERANCE_MM = 1;
const COINCIDENT_WALL_ELEVATION_TOLERANCE_MM = 1;
const COINCIDENT_OPENING_TOLERANCE_MM = 2;
const ROOM_DETECTION_FRAME_FALLBACK_MS = 16;
const ELEVATION_REGEN_DEBOUNCE_MS = 120;

let roomDetectionTimer: ReturnType<typeof setTimeout> | null = null;
let roomDetectionFrame: number | null = null;
let scheduledRoomDetectionCallback: (() => void) | null = null;
let elevationRegenTimer: ReturnType<typeof setTimeout> | null = null;
let lastRoomTopologyHash = '';
let pendingRoomTopologyHash = '';
let roomDetectionRequestId = 0;
let lastAutoDimensionSignature = '';
let pendingAutoDimensionSignature = '';
let autoDimensionRequestId = 0;
let lastElevationGenerationSignature = '';
let pendingElevationGenerationSignature = '';
let elevationGenerationRequestId = 0;
let pendingElevationFocusSectionLineId: string | null = null;
const INITIAL_ELEVATION_VIEWS = createStandardElevationViews(
  [],
  [],
  DEFAULT_ELEVATION_SETTINGS
);

function pointsEqual(left: Point2D, right: Point2D): boolean {
  return left.x === right.x && left.y === right.y;
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function clearScheduledRoomDetection(): void {
  if (roomDetectionTimer) {
    clearTimeout(roomDetectionTimer);
    roomDetectionTimer = null;
  }
  if (
    roomDetectionFrame !== null &&
    typeof window !== 'undefined' &&
    typeof window.cancelAnimationFrame === 'function'
  ) {
    window.cancelAnimationFrame(roomDetectionFrame);
  }
  roomDetectionFrame = null;
  scheduledRoomDetectionCallback = null;
}

function scheduleRoomDetection(runDetection: () => void): void {
  scheduledRoomDetectionCallback = runDetection;
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    if (roomDetectionFrame !== null) {
      return;
    }
    roomDetectionFrame = window.requestAnimationFrame(() => {
      roomDetectionFrame = null;
      const callback = scheduledRoomDetectionCallback;
      scheduledRoomDetectionCallback = null;
      callback?.();
    });
    return;
  }

  if (roomDetectionTimer) {
    return;
  }
  roomDetectionTimer = setTimeout(() => {
    roomDetectionTimer = null;
    const callback = scheduledRoomDetectionCallback;
    scheduledRoomDetectionCallback = null;
    callback?.();
  }, ROOM_DETECTION_FRAME_FALLBACK_MS);
}

// Build a lookup map for architectural object definitions by id
const objectDefMap = new Map(DEFAULT_ARCHITECTURAL_OBJECT_LIBRARY.map((d) => [d.id, d]));

/** Build elevation projection inputs from placed non-opening symbols. */
function buildFurnitureInputs(symbols: SymbolInstance2D[]): FurnitureProjectionInput[] {
  const result: FurnitureProjectionInput[] = [];
  for (const instance of symbols) {
    const definition = objectDefMap.get(instance.symbolId);
    if (!definition) continue;
    // Doors/windows are projected via wall openings, not standalone furniture projections.
    if (definition.category === 'doors' || definition.category === 'windows') continue;
    if (
      definition.category === 'furniture' ||
      definition.category === 'fixtures' ||
      definition.category === 'symbols' ||
      definition.category === 'my-library'
    ) {
      result.push({ instance, definition });
    }
  }
  return result;
}

function elevationGenerationSignature(params: {
  walls: Wall[];
  sectionLines: SectionLine[];
  elevationViews: ElevationView[];
  elevationSettings: ElevationSettings;
  hvacElements: HvacElement[];
  furnitureInputs: FurnitureProjectionInput[];
}): string {
  return JSON.stringify({
    walls: params.walls.map((wall) => ({
      id: wall.id,
      startPoint: wall.startPoint,
      endPoint: wall.endPoint,
      thickness: wall.thickness,
      material: wall.material,
      openings: wall.openings.map((opening) => ({
        id: opening.id,
        type: opening.type,
        position: opening.position,
        width: opening.width,
        height: opening.height,
        sillHeight: opening.sillHeight ?? 0,
      })),
      properties3D: {
        baseElevation: wall.properties3D.baseElevation,
        height: wall.properties3D.height,
        materialId: wall.properties3D.materialId,
      },
    })),
    sectionLines: params.sectionLines.map((sectionLine) => ({
      id: sectionLine.id,
      kind: sectionLine.kind,
      label: sectionLine.label,
      name: sectionLine.name,
      startPoint: sectionLine.startPoint,
      endPoint: sectionLine.endPoint,
      direction: sectionLine.direction,
      depthMm: sectionLine.depthMm,
      locked: sectionLine.locked,
      showReferenceIndicators: sectionLine.showReferenceIndicators,
    })),
    elevationViews: params.elevationViews.map((view) => ({
      id: view.id,
      kind: view.kind,
      name: view.name,
      sectionLineId: view.sectionLineId,
      gridIncrementMm: view.gridIncrementMm,
      scale: view.scale,
      sourceHash: view.sourceHash,
    })),
    elevationSettings: params.elevationSettings,
    hvacElements: params.hvacElements.map((element) => ({
      id: element.id,
      type: element.type,
      category: element.category,
      subtype: element.subtype,
      modelLabel: element.modelLabel,
      label: element.label,
      position: element.position,
      rotation: element.rotation,
      width: element.width,
      depth: element.depth,
      elevation: element.elevation,
      height: element.height,
      mountType: element.mountType,
      wallId: element.wallId,
      supplyZoneRatio: element.supplyZoneRatio,
      properties: element.properties,
    })),
    furnitureInputs: params.furnitureInputs.map((entry) => ({
      definition: {
        id: entry.definition.id,
        category: entry.definition.category,
        type: entry.definition.type,
        widthMm: entry.definition.widthMm,
        depthMm: entry.definition.depthMm,
        heightMm: entry.definition.heightMm,
        openingWidthMm: entry.definition.openingWidthMm ?? null,
        sillHeightMm: entry.definition.sillHeightMm ?? null,
        defaultRotationDeg: entry.definition.defaultRotationDeg ?? null,
        renderType: entry.definition.renderType ?? null,
      },
      instance: {
        id: entry.instance.id,
        symbolId: entry.instance.symbolId,
        position: entry.instance.position,
        rotation: entry.instance.rotation,
        scale: entry.instance.scale,
        flipped: entry.instance.flipped,
        properties: entry.instance.properties ?? {},
      },
    })),
  });
}

function resolveNextActiveElevationViewId(
  elevationViews: ElevationView[],
  activeElevationViewId: string | null,
  focusSectionLineId: string | null
): string | null {
  if (focusSectionLineId) {
    const focusedView = elevationViews.find(
      (view) => view.kind === 'custom' && view.sectionLineId === focusSectionLineId
    );
    if (focusedView) {
      return focusedView.id;
    }
  }

  if (
    activeElevationViewId &&
    elevationViews.some((view) => view.id === activeElevationViewId)
  ) {
    return activeElevationViewId;
  }

  return elevationViews[0]?.id ?? null;
}

function removeOpeningsLinkedToSymbols(
  walls: Wall[],
  symbolIds: Set<string>
): Wall[] {
  if (symbolIds.size === 0) return walls;
  return walls.map((wall) => {
    const filteredOpenings = wall.openings.filter((opening) => !symbolIds.has(opening.id));
    if (filteredOpenings.length === wall.openings.length) return wall;
    return {
      ...wall,
      openings: filteredOpenings,
    };
  });
}

function removeDimensionsLinkedToWallIds(
  dimensions: Dimension2D[],
  wallIds: Set<string>
): Dimension2D[] {
  if (wallIds.size === 0) return dimensions;
  return dimensions.filter((dimension) => {
    const linkedWallIds = dimension.linkedWallIds;
    if (!linkedWallIds || linkedWallIds.length === 0) return true;
    return linkedWallIds.every((wallId) => !wallIds.has(wallId));
  });
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sectionLabelForIndex(kind: SectionLineKind, index: number): string {
  if (kind === 'elevation') {
    const presets = ['FRONT ELEVATION', 'END ELEVATION'];
    return presets[index - 1] ?? `ELEVATION ${index}`;
  }

  const normalizedIndex = Math.max(1, Math.floor(index));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const letter = alphabet[(normalizedIndex - 1) % alphabet.length];
  return `SECTION ${letter}-${letter}`;
}

function wallLengthMm(startPoint: Point2D, endPoint: Point2D): number {
  return GeometryEngine.distance(startPoint, endPoint);
}

function clampThickness(thickness: number): number {
  return clampValue(thickness, MIN_WALL_THICKNESS, MAX_WALL_THICKNESS);
}

function clampHeight(height: number): number {
  return clampValue(height, MIN_WALL_HEIGHT, MAX_WALL_HEIGHT);
}

function isPartitionWallTool(tool: DrawingTool): boolean {
  return tool === 'partition-wall';
}

function resolvePartitionHeightMm(mode: PartitionWallMode, baseWallHeightMm: number): number {
  const baseHeight = clampHeight(baseWallHeightMm);
  if (mode === 'half') {
    return clampHeight(PARTITION_HALF_HEIGHT);
  }
  if (mode === 'top') {
    return clampHeight(baseHeight - PARTITION_TOP_CLEARANCE);
  }
  return baseHeight;
}

function inferHvacElementCategory(type: HvacElement['type']): HvacElement['category'] {
  switch (type) {
    case 'outdoor-unit':
      return 'outdoor-unit';
    case 'remote-controller':
    case 'control-panel':
      return 'control';
    case 'filter':
    case 'accessory':
    case 'refrigerant-pipe':
    case 'refrigerant-pipe-pair':
      return 'accessory';
    case 'diffuser':
    case 'return-grille':
      return 'air-terminal';
    case 'ducted-ac':
    case 'split-ac':
    case 'wall-mounted-ac':
    case 'ceiling-cassette-ac':
    case 'ceiling-suspended-ac':
    default:
      return 'indoor-unit';
  }
}

function normalizeHvacElement(
  element: Partial<HvacElement> & Pick<HvacElement, 'type' | 'position' | 'width' | 'depth' | 'height' | 'elevation' | 'mountType' | 'label'>
): HvacElement {
  const rotation = typeof element.rotation === 'number' && Number.isFinite(element.rotation)
    ? element.rotation
    : 0;
  const width = typeof element.width === 'number' && Number.isFinite(element.width)
    ? element.width
    : 1;
  const depth = typeof element.depth === 'number' && Number.isFinite(element.depth)
    ? element.depth
    : 1;
  const height = typeof element.height === 'number' && Number.isFinite(element.height)
    ? element.height
    : 1;
  const elevation = typeof element.elevation === 'number' && Number.isFinite(element.elevation)
    ? element.elevation
    : 0;
  const supplyZoneRatio = typeof element.supplyZoneRatio === 'number' && Number.isFinite(element.supplyZoneRatio)
    ? element.supplyZoneRatio
    : 0.5;

  return {
    id: element.id ?? generateId(),
    type: element.type,
    category: element.category ?? inferHvacElementCategory(element.type),
    subtype: element.subtype,
    modelLabel: element.modelLabel ?? element.label,
    position: {
      x: Number.isFinite(element.position.x) ? element.position.x : 0,
      y: Number.isFinite(element.position.y) ? element.position.y : 0,
    },
    rotation,
    width: Math.max(1, width),
    depth: Math.max(1, depth),
    height: Math.max(1, height),
    elevation,
    mountType: element.mountType,
    label: element.label,
    roomId: element.roomId,
    wallId: element.wallId,
    supplyZoneRatio: clampValue(
      supplyZoneRatio,
      0,
      1,
    ),
    properties: element.properties ? { ...element.properties } : {},
  };
}

function normalizeBevelControl(bevel?: Partial<BevelControl> | null): BevelControl {
  return {
    outerOffset: clampBevelOffset(bevel?.outerOffset ?? DEFAULT_BEVEL_CONTROL.outerOffset, Number.MAX_SAFE_INTEGER),
    innerOffset: clampBevelOffset(bevel?.innerOffset ?? DEFAULT_BEVEL_CONTROL.innerOffset, Number.MAX_SAFE_INTEGER),
  };
}

function normalizeWallBevel(wall: Wall): Wall {
  return {
    ...wall,
    startBevel: normalizeBevelControl(wall.startBevel),
    endBevel: normalizeBevelControl(wall.endBevel),
  };
}

function bevelKeyForEnd(end: CornerEnd): 'startBevel' | 'endBevel' {
  return end === 'start' ? 'startBevel' : 'endBevel';
}

function applyWallEndpointBevel(
  wall: Wall,
  end: CornerEnd,
  bevel: Partial<BevelControl>,
  maxOffset: number
): Wall {
  const normalized = normalizeWallBevel(wall);
  const key = bevelKeyForEnd(end);
  const nextBevel = withUpdatedBevel(normalized[key], bevel, maxOffset);
  if (key === 'startBevel') {
    return {
      ...normalized,
      startBevel: nextBevel,
    };
  }
  return {
    ...normalized,
    endBevel: nextBevel,
  };
}

function rebuildWallGeometry(wall: Wall): Wall {
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const length = Math.sqrt(dx * dx + dy * dy) || 1;
  const perpX = -dy / length;
  const perpY = dx / length;
  const halfThickness = wall.thickness / 2;

  return {
    ...normalizeWallBevel(wall),
    interiorLine: {
      start: { x: wall.startPoint.x + perpX * halfThickness, y: wall.startPoint.y + perpY * halfThickness },
      end: { x: wall.endPoint.x + perpX * halfThickness, y: wall.endPoint.y + perpY * halfThickness },
    },
    exteriorLine: {
      start: { x: wall.startPoint.x - perpX * halfThickness, y: wall.startPoint.y - perpY * halfThickness },
      end: { x: wall.endPoint.x - perpX * halfThickness, y: wall.endPoint.y - perpY * halfThickness },
    },
  };
}

function projectPointToSegment(
  point: Point2D,
  start: Point2D,
  end: Point2D
): { point: Point2D; distance: number } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq < 0.000001) {
    const distance = Math.hypot(point.x - start.x, point.y - start.y);
    return { point: { ...start }, distance };
  }

  const t = clampValue(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq,
    0,
    1
  );

  const projection = {
    x: start.x + dx * t,
    y: start.y + dy * t,
  };

  return {
    point: projection,
    distance: Math.hypot(point.x - projection.x, point.y - projection.y),
  };
}

function autoTrimEndpointToNearbyWall(
  endpoint: Point2D,
  fixedPoint: Point2D,
  walls: Wall[]
): Point2D {
  let bestPoint = endpoint;
  let bestDistance = AUTO_TRIM_TOLERANCE_MM;

  for (const wall of walls) {
    const projection = projectPointToSegment(endpoint, wall.startPoint, wall.endPoint);

    if (projection.distance > bestDistance) continue;
    if (wallLengthMm(fixedPoint, projection.point) < MIN_WALL_LENGTH) continue;

    bestDistance = projection.distance;
    bestPoint = projection.point;
  }

  return bestPoint;
}

function autoTrimWallEndpoints(
  startPoint: Point2D,
  endPoint: Point2D,
  walls: Wall[]
): { startPoint: Point2D; endPoint: Point2D } {
  const snappedStart = autoTrimEndpointToNearbyWall(startPoint, endPoint, walls);
  const snappedEnd = autoTrimEndpointToNearbyWall(endPoint, snappedStart, walls);

  if (wallLengthMm(snappedStart, snappedEnd) < MIN_WALL_LENGTH) {
    return { startPoint, endPoint };
  }

  return { startPoint: snappedStart, endPoint: snappedEnd };
}

function pointsNear(a: Point2D, b: Point2D, tolerance: number = 2): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
}

function pointForOppositeEndpoint(wall: Wall, end: CornerEnd): Point2D {
  return end === 'start' ? wall.endPoint : wall.startPoint;
}

function bevelForEndpoint(wall: Wall, end: CornerEnd): BevelControl {
  return normalizeBevelControl(end === 'start' ? wall.startBevel : wall.endBevel);
}

function dedupeWallIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function directionAwayFromEndpoint(wall: Wall, end: CornerEnd): Point2D {
  const from = end === 'start' ? wall.startPoint : wall.endPoint;
  const to = end === 'start' ? wall.endPoint : wall.startPoint;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.000001) {
    return { x: 0, y: 0 };
  }
  return {
    x: dx / length,
    y: dy / length,
  };
}

function canMergeStraightWalls(retained: Wall, candidate: Wall): boolean {
  if (retained.material !== candidate.material) return false;
  if (retained.layer !== candidate.layer) return false;
  if (retained.openings.length > 0 || candidate.openings.length > 0) return false;
  return Math.abs(retained.thickness - candidate.thickness) <= STRAIGHT_WALL_MERGE_THICKNESS_TOLERANCE_MM;
}

function isStraightContinuation(
  retained: Wall,
  retainedEnd: CornerEnd,
  candidate: Wall,
  candidateEnd: CornerEnd
): boolean {
  const dirA = directionAwayFromEndpoint(retained, retainedEnd);
  const dirB = directionAwayFromEndpoint(candidate, candidateEnd);
  const toleranceRad = (STRAIGHT_WALL_MERGE_ANGLE_TOLERANCE_DEG * Math.PI) / 180;
  const dot = dirA.x * dirB.x + dirA.y * dirB.y;
  const cross = Math.abs(dirA.x * dirB.y - dirA.y * dirB.x);
  return dot <= -Math.cos(toleranceRad) && cross <= Math.sin(toleranceRad) + 0.0001;
}

function mergeWallPair(
  retained: Wall,
  retainedEnd: CornerEnd,
  candidate: Wall,
  candidateEnd: CornerEnd
): Wall {
  const candidateOuterEnd: CornerEnd = candidateEnd === 'start' ? 'end' : 'start';
  const candidateOuterPoint = pointForOppositeEndpoint(candidate, candidateEnd);
  const merged = normalizeWallBevel({
    ...retained,
    startPoint: retainedEnd === 'start' ? { ...candidateOuterPoint } : { ...retained.startPoint },
    endPoint: retainedEnd === 'end' ? { ...candidateOuterPoint } : { ...retained.endPoint },
    startBevel: retainedEnd === 'start'
      ? bevelForEndpoint(candidate, candidateOuterEnd)
      : bevelForEndpoint(retained, 'start'),
    endBevel: retainedEnd === 'end'
      ? bevelForEndpoint(candidate, candidateOuterEnd)
      : bevelForEndpoint(retained, 'end'),
    connectedWalls: dedupeWallIds(
      [...retained.connectedWalls, ...candidate.connectedWalls]
        .filter((wallId) => wallId !== retained.id && wallId !== candidate.id)
    ),
  });

  return bindWallAttributes(rebuildWallGeometry(merged), retained.properties3D);
}

function cleanupStraightWallRuns(walls: Wall[], retainedId: string): Wall[] {
  let nextWalls = walls.map((wall) => normalizeWallBevel(wall));
  let mergedWall = true;

  while (mergedWall) {
    mergedWall = false;
    const retained = nextWalls.find((wall) => wall.id === retainedId);
    if (!retained) break;

    for (const candidate of nextWalls) {
      if (candidate.id === retainedId) continue;
      if (!canMergeStraightWalls(retained, candidate)) continue;

      const sharedPoint =
        pointsNear(retained.startPoint, candidate.startPoint, STRAIGHT_WALL_MERGE_NODE_TOLERANCE_MM)
          ? { point: retained.startPoint, retainedEnd: 'start' as CornerEnd, candidateEnd: 'start' as CornerEnd }
          : pointsNear(retained.startPoint, candidate.endPoint, STRAIGHT_WALL_MERGE_NODE_TOLERANCE_MM)
            ? { point: retained.startPoint, retainedEnd: 'start' as CornerEnd, candidateEnd: 'end' as CornerEnd }
            : pointsNear(retained.endPoint, candidate.startPoint, STRAIGHT_WALL_MERGE_NODE_TOLERANCE_MM)
              ? { point: retained.endPoint, retainedEnd: 'end' as CornerEnd, candidateEnd: 'start' as CornerEnd }
              : pointsNear(retained.endPoint, candidate.endPoint, STRAIGHT_WALL_MERGE_NODE_TOLERANCE_MM)
                ? { point: retained.endPoint, retainedEnd: 'end' as CornerEnd, candidateEnd: 'end' as CornerEnd }
                : null;

      if (!sharedPoint) continue;
      if (findWallsTouchingPoint(sharedPoint.point, nextWalls, STRAIGHT_WALL_MERGE_NODE_TOLERANCE_MM).length !== 2) {
        continue;
      }
      if (!isStraightContinuation(retained, sharedPoint.retainedEnd, candidate, sharedPoint.candidateEnd)) {
        continue;
      }

      const mergedCandidatePoint = pointForOppositeEndpoint(candidate, sharedPoint.candidateEnd);
      const mergedStartPoint = sharedPoint.retainedEnd === 'start' ? mergedCandidatePoint : retained.startPoint;
      const mergedEndPoint = sharedPoint.retainedEnd === 'end' ? mergedCandidatePoint : retained.endPoint;
      if (wallLengthMm(mergedStartPoint, mergedEndPoint) < MIN_WALL_LENGTH) {
        continue;
      }

      const merged = mergeWallPair(retained, sharedPoint.retainedEnd, candidate, sharedPoint.candidateEnd);
      nextWalls = nextWalls
        .filter((wall) => wall.id !== candidate.id)
        .map((wall) => {
          if (wall.id === retainedId) {
            return merged;
          }
          if (!wall.connectedWalls.includes(candidate.id)) {
            return wall;
          }
          return {
            ...wall,
            connectedWalls: dedupeWallIds(
              wall.connectedWalls
                .map((wallId) => (wallId === candidate.id ? retainedId : wallId))
                .filter((wallId) => wallId !== wall.id)
            ),
          };
        });
      mergedWall = true;
      break;
    }
  }

  return nextWalls;
}

function subtractPoints(a: Point2D, b: Point2D): Point2D {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
  };
}

function dotPoints(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function crossPoints(a: Point2D, b: Point2D): number {
  return a.x * b.y - a.y * b.x;
}

function normalizePointVector(vector: Point2D): Point2D {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 0.000001) {
    return { x: 0, y: 0 };
  }

  return {
    x: vector.x / length,
    y: vector.y / length,
  };
}

function perpendicularPointVector(vector: Point2D): Point2D {
  return {
    x: -vector.y,
    y: vector.x,
  };
}

function projectDistanceAlongWall(point: Point2D, wall: Wall): number {
  const direction = normalizePointVector(subtractPoints(wall.endPoint, wall.startPoint));
  return dotPoints(subtractPoints(point, wall.startPoint), direction);
}

function areWallsCompatibleForOverlapCollapse(a: Wall, b: Wall): boolean {
  if (a.material !== b.material) return false;
  if (a.layer !== b.layer) return false;
  if (Math.abs(a.thickness - b.thickness) > COINCIDENT_WALL_THICKNESS_TOLERANCE_MM) return false;

  const aBase = a.properties3D.baseElevation ?? 0;
  const bBase = b.properties3D.baseElevation ?? 0;
  const aHeight = a.properties3D.height ?? DEFAULT_WALL_HEIGHT;
  const bHeight = b.properties3D.height ?? DEFAULT_WALL_HEIGHT;
  return (
    Math.abs(aBase - bBase) <= COINCIDENT_WALL_ELEVATION_TOLERANCE_MM &&
    Math.abs(aHeight - bHeight) <= COINCIDENT_WALL_ELEVATION_TOLERANCE_MM
  );
}

function areWallsCoincidentForCollapse(a: Wall, b: Wall): boolean {
  const sameDirection =
    pointsNear(a.startPoint, b.startPoint, COINCIDENT_WALL_TOLERANCE_MM) &&
    pointsNear(a.endPoint, b.endPoint, COINCIDENT_WALL_TOLERANCE_MM);
  const reversedDirection =
    pointsNear(a.startPoint, b.endPoint, COINCIDENT_WALL_TOLERANCE_MM) &&
    pointsNear(a.endPoint, b.startPoint, COINCIDENT_WALL_TOLERANCE_MM);

  if (sameDirection || reversedDirection) {
    return true;
  }

  const dirA = subtractPoints(a.endPoint, a.startPoint);
  const dirB = subtractPoints(b.endPoint, b.startPoint);
  const lenA = Math.hypot(dirA.x, dirA.y);
  const lenB = Math.hypot(dirB.x, dirB.y);
  if (lenA < 0.001 || lenB < 0.001) {
    return false;
  }

  const crossNormalized = Math.abs(crossPoints(dirA, dirB)) / (lenA * lenB);
  if (crossNormalized > 0.02) {
    return false;
  }

  const perpendicular = perpendicularPointVector(normalizePointVector(dirA));
  const perpendicularDistance = Math.abs(dotPoints(subtractPoints(b.startPoint, a.startPoint), perpendicular));
  if (perpendicularDistance > COINCIDENT_WALL_TOLERANCE_MM) {
    return false;
  }

  const bStartOnA = projectPointToSegment(b.startPoint, a.startPoint, a.endPoint).distance <= COINCIDENT_WALL_TOLERANCE_MM;
  const bEndOnA = projectPointToSegment(b.endPoint, a.startPoint, a.endPoint).distance <= COINCIDENT_WALL_TOLERANCE_MM;
  const aStartOnB = projectPointToSegment(a.startPoint, b.startPoint, b.endPoint).distance <= COINCIDENT_WALL_TOLERANCE_MM;
  const aEndOnB = projectPointToSegment(a.endPoint, b.startPoint, b.endPoint).distance <= COINCIDENT_WALL_TOLERANCE_MM;

  return (bStartOnA && bEndOnA) || (aStartOnB && aEndOnB);
}

function chooseCoincidentWallRepresentative(
  walls: Wall[],
  preferredRetainedIds: Set<string>,
  wallIndexById: Map<string, number>
): Wall {
  return walls.reduce((best, candidate) => {
    const bestPreferred = preferredRetainedIds.has(best.id);
    const candidatePreferred = preferredRetainedIds.has(candidate.id);
    if (bestPreferred !== candidatePreferred) {
      return candidatePreferred ? candidate : best;
    }

    if (best.openings.length !== candidate.openings.length) {
      return candidate.openings.length > best.openings.length ? candidate : best;
    }

    const bestLength = wallLengthMm(best.startPoint, best.endPoint);
    const candidateLength = wallLengthMm(candidate.startPoint, candidate.endPoint);
    if (Math.abs(bestLength - candidateLength) > COINCIDENT_WALL_TOLERANCE_MM) {
      return candidateLength > bestLength ? candidate : best;
    }

    if (best.connectedWalls.length !== candidate.connectedWalls.length) {
      return candidate.connectedWalls.length > best.connectedWalls.length ? candidate : best;
    }

    if (Math.abs(best.thickness - candidate.thickness) > COINCIDENT_WALL_THICKNESS_TOLERANCE_MM) {
      return candidate.thickness > best.thickness ? candidate : best;
    }

    return (wallIndexById.get(candidate.id) ?? Number.MAX_SAFE_INTEGER)
      < (wallIndexById.get(best.id) ?? Number.MAX_SAFE_INTEGER)
      ? candidate
      : best;
  });
}

function mapOpeningToWall(opening: Wall['openings'][number], sourceWall: Wall, targetWall: Wall): Wall['openings'][number] {
  const sourceLength = Math.max(wallLengthMm(sourceWall.startPoint, sourceWall.endPoint), 0.001);
  const t = clampValue(opening.position / sourceLength, 0, 1);
  const worldPoint = {
    x: sourceWall.startPoint.x + (sourceWall.endPoint.x - sourceWall.startPoint.x) * t,
    y: sourceWall.startPoint.y + (sourceWall.endPoint.y - sourceWall.startPoint.y) * t,
  };
  const targetLength = Math.max(wallLengthMm(targetWall.startPoint, targetWall.endPoint), 0.001);
  const mappedPosition = clampValue(projectDistanceAlongWall(worldPoint, targetWall), 0, targetLength);

  return {
    ...opening,
    position: mappedPosition,
  };
}

function openingsEquivalent(a: Wall['openings'][number], b: Wall['openings'][number]): boolean {
  return (
    a.type === b.type &&
    Math.abs(a.position - b.position) <= COINCIDENT_OPENING_TOLERANCE_MM &&
    Math.abs(a.width - b.width) <= COINCIDENT_OPENING_TOLERANCE_MM &&
    Math.abs(a.height - b.height) <= COINCIDENT_OPENING_TOLERANCE_MM &&
    Math.abs((a.sillHeight ?? 0) - (b.sillHeight ?? 0)) <= COINCIDENT_OPENING_TOLERANCE_MM
  );
}

function mergeCoincidentWallOpenings(targetWall: Wall, sourceWalls: Wall[]): Wall['openings'] {
  const merged: Wall['openings'] = [];

  sourceWalls.forEach((sourceWall) => {
    sourceWall.openings.forEach((opening) => {
      const mappedOpening = mapOpeningToWall(opening, sourceWall, targetWall);
      if (!merged.some((existing) => existing.id === mappedOpening.id || openingsEquivalent(existing, mappedOpening))) {
        merged.push(mappedOpening);
      }
    });
  });

  return merged.sort((left, right) => left.position - right.position);
}

function mergeCoincidentWallGroup(retained: Wall, group: Wall[]): Wall {
  const endpoints = group.flatMap((wall) => ([
    {
      projection: projectDistanceAlongWall(wall.startPoint, retained),
      point: wall.startPoint,
      bevel: bevelForEndpoint(wall, 'start'),
    },
    {
      projection: projectDistanceAlongWall(wall.endPoint, retained),
      point: wall.endPoint,
      bevel: bevelForEndpoint(wall, 'end'),
    },
  ]));

  const startEndpoint = endpoints.reduce(
    (best, candidate) => (candidate.projection < best.projection ? candidate : best),
    endpoints[0]
  );
  const endEndpoint = endpoints.reduce(
    (best, candidate) => (candidate.projection > best.projection ? candidate : best),
    endpoints[0]
  );
  const groupIds = new Set(group.map((wall) => wall.id));

  const mergedBase = normalizeWallBevel({
    ...retained,
    startPoint: { ...startEndpoint.point },
    endPoint: { ...endEndpoint.point },
    startBevel: startEndpoint.bevel,
    endBevel: endEndpoint.bevel,
    connectedWalls: dedupeWallIds(
      group.flatMap((wall) => wall.connectedWalls).filter((wallId) => !groupIds.has(wallId))
    ),
  });
  const reboundWall = bindWallAttributes(rebuildWallGeometry(mergedBase), retained.properties3D);
  return {
    ...reboundWall,
    openings: mergeCoincidentWallOpenings(reboundWall, group),
  };
}

function resolveWallReplacementId(id: string, replacementMap: Map<string, string>): string {
  let resolved = id;
  const visited = new Set<string>();

  while (replacementMap.has(resolved) && !visited.has(resolved)) {
    visited.add(resolved);
    resolved = replacementMap.get(resolved) ?? resolved;
  }

  return resolved;
}

function collapseCoincidentWallOverlaps(params: {
  walls: Wall[];
  rooms: Room[];
  dimensions: Dimension2D[];
  selectedElementIds: string[];
  selectedIds: string[];
  hoveredElementId: string | null;
  preferredRetainedIds?: Set<string>;
}): {
  walls: Wall[];
  rooms: Room[];
  dimensions: Dimension2D[];
  selectedElementIds: string[];
  selectedIds: string[];
  hoveredElementId: string | null;
  replacementMap: Map<string, string>;
} {
  const preferredRetainedIds = params.preferredRetainedIds ?? new Set<string>();
  const wallIndexById = new Map(params.walls.map((wall, index) => [wall.id, index]));
  const consumedIds = new Set<string>();
  const replacementMap = new Map<string, string>();
  const mergedWalls: Wall[] = [];

  for (let index = 0; index < params.walls.length; index += 1) {
    const wall = params.walls[index];
    if (consumedIds.has(wall.id)) {
      continue;
    }

    const group = [wall];
    for (let otherIndex = index + 1; otherIndex < params.walls.length; otherIndex += 1) {
      const candidate = params.walls[otherIndex];
      if (consumedIds.has(candidate.id)) {
        continue;
      }
      if (!areWallsCompatibleForOverlapCollapse(wall, candidate)) {
        continue;
      }
      if (areWallsCoincidentForCollapse(wall, candidate)) {
        group.push(candidate);
      }
    }

    if (group.length === 1) {
      mergedWalls.push(group[0]);
      consumedIds.add(group[0].id);
      continue;
    }

    const retained = chooseCoincidentWallRepresentative(group, preferredRetainedIds, wallIndexById);
    const mergedWall = mergeCoincidentWallGroup(retained, group);
    mergedWalls.push(mergedWall);

    group.forEach((candidate) => {
      consumedIds.add(candidate.id);
      if (candidate.id !== retained.id) {
        replacementMap.set(candidate.id, retained.id);
      }
    });
  }

  if (replacementMap.size === 0) {
    return {
      walls: params.walls,
      rooms: params.rooms,
      dimensions: params.dimensions,
      selectedElementIds: params.selectedElementIds,
      selectedIds: params.selectedIds,
      hoveredElementId: params.hoveredElementId,
      replacementMap,
    };
  }

  const survivingWallIds = new Set(mergedWalls.map((wall) => wall.id));
  const normalizeWallIds = (ids: string[]): string[] =>
    dedupeWallIds(
      ids
        .map((id) => resolveWallReplacementId(id, replacementMap))
        .filter((id) => survivingWallIds.has(id))
    );
  const remapOptionalWallId = (id: string | null): string | null => {
    if (!id || !replacementMap.has(id)) {
      return id;
    }
    const resolved = resolveWallReplacementId(id, replacementMap);
    return survivingWallIds.has(resolved) ? resolved : null;
  };

  return {
    walls: mergedWalls.map((wall) => ({
      ...wall,
      connectedWalls: normalizeWallIds(wall.connectedWalls).filter((wallId) => wallId !== wall.id),
    })),
    rooms: params.rooms.map((room) => ({
      ...room,
      wallIds: normalizeWallIds(room.wallIds),
    })),
    dimensions: params.dimensions.map((dimension) => ({
      ...dimension,
      linkedWallIds: Array.isArray(dimension.linkedWallIds)
        ? dedupeWallIds(
          dimension.linkedWallIds
            .map((wallId) => resolveWallReplacementId(wallId, replacementMap))
            .filter((wallId) => survivingWallIds.has(wallId))
        )
        : dimension.linkedWallIds,
    })),
    selectedElementIds: dedupeWallIds(
      params.selectedElementIds.map((id) => resolveWallReplacementId(id, replacementMap))
    ),
    selectedIds: dedupeWallIds(
      params.selectedIds.map((id) => resolveWallReplacementId(id, replacementMap))
    ),
    hoveredElementId: remapOptionalWallId(params.hoveredElementId),
    replacementMap,
  };
}

function pointLiesOnWall(point: Point2D, wall: Wall, tolerance: number = 2): boolean {
  const projection = projectPointToSegment(point, wall.startPoint, wall.endPoint);
  return projection.distance <= tolerance;
}

const WALL_SEGMENT_SELECTION_TOLERANCE_MM = 2;
const WALL_SEGMENT_SELECTION_OPENING_CLEARANCE_MM = 2;

interface SplitWallDescriptor {
  wall: Wall;
  startDistance: number;
  endDistance: number;
}

interface SplitWallSelectionState {
  walls: Wall[];
  rooms: Room[];
  dimensions: Dimension2D[];
  selectedElementIds: string[];
  selectedIds: string[];
  hoveredElementId: string | null;
}

function projectPointParameter(point: Point2D, start: Point2D, end: Point2D): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 0.000001) {
    return 0;
  }
  return clampValue(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq,
    0,
    1
  );
}

function addUniqueSplitPoint(
  points: Point2D[],
  point: Point2D,
  tolerance: number = WALL_SEGMENT_SELECTION_TOLERANCE_MM
): void {
  if (!points.some((existing) => pointsNear(existing, point, tolerance))) {
    points.push({ ...point });
  }
}

function splitPointConflictsWithOpening(point: Point2D, wall: Wall): boolean {
  if (wall.openings.length === 0) {
    return false;
  }

  const position = clampValue(
    projectDistanceAlongWall(point, wall),
    0,
    wallLengthMm(wall.startPoint, wall.endPoint)
  );

  return wall.openings.some((opening) => (
    Math.abs(position - opening.position)
    <= opening.width / 2 + WALL_SEGMENT_SELECTION_OPENING_CLEARANCE_MM
  ));
}

function collectWallSelectionSplitPoints(wall: Wall, walls: Wall[]): Point2D[] {
  const splitPoints: Point2D[] = [
    { ...wall.startPoint },
    { ...wall.endPoint },
  ];
  const wallLength = wallLengthMm(wall.startPoint, wall.endPoint);

  for (const otherWall of walls) {
    if (otherWall.id === wall.id) {
      continue;
    }

    [otherWall.startPoint, otherWall.endPoint].forEach((endpoint) => {
      const projection = projectPointToSegment(endpoint, wall.startPoint, wall.endPoint);
      if (projection.distance > WALL_SEGMENT_SELECTION_TOLERANCE_MM) {
        return;
      }
      if (
        pointsNear(projection.point, wall.startPoint, WALL_SEGMENT_SELECTION_TOLERANCE_MM) ||
        pointsNear(projection.point, wall.endPoint, WALL_SEGMENT_SELECTION_TOLERANCE_MM)
      ) {
        return;
      }
      if (splitPointConflictsWithOpening(projection.point, wall)) {
        return;
      }
      addUniqueSplitPoint(splitPoints, projection.point);
    });

    GeometryEngine.findIntersections(wall, otherWall).forEach((intersection) => {
      const projection = projectPointToSegment(intersection, wall.startPoint, wall.endPoint);
      if (projection.distance > WALL_SEGMENT_SELECTION_TOLERANCE_MM) {
        return;
      }
      if (
        pointsNear(projection.point, wall.startPoint, WALL_SEGMENT_SELECTION_TOLERANCE_MM) ||
        pointsNear(projection.point, wall.endPoint, WALL_SEGMENT_SELECTION_TOLERANCE_MM)
      ) {
        return;
      }
      if (splitPointConflictsWithOpening(projection.point, wall)) {
        return;
      }
      addUniqueSplitPoint(splitPoints, projection.point);
    });
  }

  const ordered = splitPoints
    .map((point) => ({
      point,
      distance: clampValue(projectDistanceAlongWall(point, wall), 0, wallLength),
    }))
    .sort((left, right) => left.distance - right.distance);

  if (ordered.length <= 2) {
    return ordered.map((entry) => entry.point);
  }

  const filtered = [ordered[0]];
  for (let index = 1; index < ordered.length - 1; index += 1) {
    const candidate = ordered[index];
    const previous = filtered[filtered.length - 1];
    if (candidate.distance - previous.distance < MIN_WALL_LENGTH) {
      continue;
    }
    if (wallLength - candidate.distance < MIN_WALL_LENGTH) {
      continue;
    }
    filtered.push(candidate);
  }
  filtered.push(ordered[ordered.length - 1]);

  return filtered.map((entry) => entry.point);
}

function buildWallSplitDescriptors(
  wall: Wall,
  splitPoints: Point2D[],
  selectedDistance: number
): { descriptors: SplitWallDescriptor[]; selectedWallId: string } {
  const wallLength = wallLengthMm(wall.startPoint, wall.endPoint);
  const ordered = splitPoints
    .map((point) => ({
      point,
      distance: clampValue(projectDistanceAlongWall(point, wall), 0, wallLength),
    }))
    .sort((left, right) => left.distance - right.distance);

  const intervals = ordered
    .slice(0, -1)
    .map((entry, index) => ({
      startPoint: entry.point,
      endPoint: ordered[index + 1].point,
      startDistance: entry.distance,
      endDistance: ordered[index + 1].distance,
    }))
    .filter((entry) => entry.endDistance - entry.startDistance >= MIN_WALL_LENGTH);

  if (intervals.length <= 1) {
    return { descriptors: [], selectedWallId: wall.id };
  }

  const selectedIndex = intervals.findIndex((entry) => (
    selectedDistance >= entry.startDistance - WALL_SEGMENT_SELECTION_TOLERANCE_MM &&
    selectedDistance <= entry.endDistance + WALL_SEGMENT_SELECTION_TOLERANCE_MM
  ));
  const resolvedSelectedIndex = selectedIndex >= 0
    ? selectedIndex
    : intervals.reduce((bestIndex, entry, index) => {
      const best = intervals[bestIndex];
      const bestDistance = Math.min(
        Math.abs(selectedDistance - best.startDistance),
        Math.abs(selectedDistance - best.endDistance)
      );
      const entryDistance = Math.min(
        Math.abs(selectedDistance - entry.startDistance),
        Math.abs(selectedDistance - entry.endDistance)
      );
      return entryDistance < bestDistance ? index : bestIndex;
    }, 0);

  const descriptors = intervals.map((interval, index) => {
    const length = interval.endDistance - interval.startDistance;
    const baseWall = normalizeWallBevel({
      ...wall,
      id: index === resolvedSelectedIndex ? wall.id : generateId(),
      startPoint: { ...interval.startPoint },
      endPoint: { ...interval.endPoint },
      startBevel: interval.startDistance <= WALL_SEGMENT_SELECTION_TOLERANCE_MM
        ? { ...wall.startBevel }
        : { ...DEFAULT_BEVEL_CONTROL },
      endBevel: wallLength - interval.endDistance <= WALL_SEGMENT_SELECTION_TOLERANCE_MM
        ? { ...wall.endBevel }
        : { ...DEFAULT_BEVEL_CONTROL },
      connectedWalls: [],
      openings: wall.openings
        .filter((opening) => (
          opening.position >= interval.startDistance - WALL_SEGMENT_SELECTION_TOLERANCE_MM &&
          opening.position <= interval.endDistance + WALL_SEGMENT_SELECTION_TOLERANCE_MM
        ))
        .map((opening) => ({
          ...opening,
          position: clampValue(opening.position - interval.startDistance, 0, length),
        })),
    });

    return {
      wall: bindWallAttributes(rebuildWallGeometry(baseWall), wall.properties3D),
      startDistance: interval.startDistance,
      endDistance: interval.endDistance,
    };
  });

  return {
    descriptors,
    selectedWallId: descriptors[resolvedSelectedIndex]?.wall.id ?? wall.id,
  };
}

function remapDimensionForSplitWall(
  dimension: Dimension2D,
  sourceWall: Wall,
  descriptors: SplitWallDescriptor[]
): Dimension2D {
  const replacementWallIds = descriptors.map((descriptor) => descriptor.wall.id);
  const remapDistanceToWallId = (distance: number): string => {
    const match = descriptors.find((descriptor) => (
      distance >= descriptor.startDistance - WALL_SEGMENT_SELECTION_TOLERANCE_MM &&
      distance <= descriptor.endDistance + WALL_SEGMENT_SELECTION_TOLERANCE_MM
    ));
    return match?.wall.id ?? replacementWallIds[0];
  };

  const sourceLength = wallLengthMm(sourceWall.startPoint, sourceWall.endPoint);
  const sourceMidpointDistance = sourceLength / 2;
  const sourceMidpoint = {
    x: (sourceWall.startPoint.x + sourceWall.endPoint.x) / 2,
    y: (sourceWall.startPoint.y + sourceWall.endPoint.y) / 2,
  };

  return {
    ...dimension,
    linkedWallIds: Array.isArray(dimension.linkedWallIds)
      ? dedupeWallIds(
        dimension.linkedWallIds.flatMap((wallId) => (
          wallId === sourceWall.id ? replacementWallIds : [wallId]
        ))
      )
      : dimension.linkedWallIds,
    anchors: dimension.anchors?.map((anchor) => {
      if (anchor.wallId !== sourceWall.id) {
        return anchor;
      }

      if (anchor.kind === 'wall-endpoint') {
        return {
          ...anchor,
          wallId: anchor.endpoint === 'end'
            ? descriptors[descriptors.length - 1]?.wall.id ?? sourceWall.id
            : descriptors[0]?.wall.id ?? sourceWall.id,
        };
      }

      if (anchor.kind === 'wall-midpoint') {
        return {
          kind: 'point' as const,
          point: { ...sourceMidpoint },
        };
      }

      const projectedDistance = anchor.point
        ? clampValue(projectDistanceAlongWall(anchor.point, sourceWall), 0, sourceLength)
        : sourceMidpointDistance;
      return {
        ...anchor,
        wallId: remapDistanceToWallId(projectedDistance),
      };
    }),
  };
}

function wallsTouchForConnection(a: Wall, b: Wall): boolean {
  if (
    pointsNear(a.startPoint, b.startPoint, WALL_SEGMENT_SELECTION_TOLERANCE_MM) ||
    pointsNear(a.startPoint, b.endPoint, WALL_SEGMENT_SELECTION_TOLERANCE_MM) ||
    pointsNear(a.endPoint, b.startPoint, WALL_SEGMENT_SELECTION_TOLERANCE_MM) ||
    pointsNear(a.endPoint, b.endPoint, WALL_SEGMENT_SELECTION_TOLERANCE_MM)
  ) {
    return true;
  }

  if (
    pointLiesOnWall(a.startPoint, b, WALL_SEGMENT_SELECTION_TOLERANCE_MM) ||
    pointLiesOnWall(a.endPoint, b, WALL_SEGMENT_SELECTION_TOLERANCE_MM) ||
    pointLiesOnWall(b.startPoint, a, WALL_SEGMENT_SELECTION_TOLERANCE_MM) ||
    pointLiesOnWall(b.endPoint, a, WALL_SEGMENT_SELECTION_TOLERANCE_MM)
  ) {
    return true;
  }

  return GeometryEngine.findIntersections(a, b).length > 0;
}

function pointLiesOnSegment(
  point: Point2D,
  start: Point2D,
  end: Point2D,
  tolerance: number = WALL_SEGMENT_SELECTION_TOLERANCE_MM
): boolean {
  return projectPointToSegment(point, start, end).distance <= tolerance;
}

function segmentMidpoint(start: Point2D, end: Point2D): Point2D {
  return {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  };
}

function wallsAreParallelToSegment(
  wall: Wall,
  start: Point2D,
  end: Point2D
): boolean {
  const wallVector = subtractPoints(wall.endPoint, wall.startPoint);
  const edgeVector = subtractPoints(end, start);
  const wallLength = Math.hypot(wallVector.x, wallVector.y);
  const edgeLength = Math.hypot(edgeVector.x, edgeVector.y);
  if (wallLength < 0.000001 || edgeLength < 0.000001) {
    return false;
  }
  const crossNormalized = Math.abs(crossPoints(wallVector, edgeVector)) / (wallLength * edgeLength);
  return crossNormalized <= 0.02;
}

function collectRoomBoundarySplitPoints(
  start: Point2D,
  end: Point2D,
  walls: Wall[]
): Point2D[] {
  const splitPoints: Point2D[] = [{ ...start }, { ...end }];
  const edgeLength = wallLengthMm(start, end);

  for (const wall of walls) {
    [wall.startPoint, wall.endPoint].forEach((endpoint) => {
      if (!pointLiesOnSegment(endpoint, start, end, WALL_SEGMENT_SELECTION_TOLERANCE_MM)) {
        return;
      }
      if (
        pointsNear(endpoint, start, WALL_SEGMENT_SELECTION_TOLERANCE_MM) ||
        pointsNear(endpoint, end, WALL_SEGMENT_SELECTION_TOLERANCE_MM)
      ) {
        return;
      }
      addUniqueSplitPoint(splitPoints, endpoint);
    });

    GeometryEngine.findIntersections(
      { startPoint: start, endPoint: end },
      wall
    ).forEach((intersection) => {
      if (!pointLiesOnSegment(intersection, start, end, WALL_SEGMENT_SELECTION_TOLERANCE_MM)) {
        return;
      }
      if (
        pointsNear(intersection, start, WALL_SEGMENT_SELECTION_TOLERANCE_MM) ||
        pointsNear(intersection, end, WALL_SEGMENT_SELECTION_TOLERANCE_MM)
      ) {
        return;
      }
      addUniqueSplitPoint(splitPoints, intersection);
    });
  }

  const ordered = splitPoints
    .map((point) => ({
      point,
      distance: clampValue(projectPointParameter(point, start, end) * edgeLength, 0, edgeLength),
    }))
    .sort((left, right) => left.distance - right.distance);

  return ordered.map((entry) => entry.point);
}

function findWallForRoomBoundarySubEdge(
  start: Point2D,
  end: Point2D,
  walls: Wall[],
  preferredWallIds: Set<string>
): Wall | null {
  const midpoint = segmentMidpoint(start, end);
  const pointLiesWithinWallBand = (point: Point2D, wall: Wall) => {
    const projection = projectPointToSegment(point, wall.startPoint, wall.endPoint);
    return projection.distance <= wall.thickness / 2 + WALL_SEGMENT_SELECTION_TOLERANCE_MM;
  };
  const matches = (wall: Wall) =>
    wallsAreParallelToSegment(wall, start, end) &&
    pointLiesWithinWallBand(midpoint, wall);

  for (const wall of walls) {
    if (preferredWallIds.has(wall.id) && matches(wall)) {
      return wall;
    }
  }

  return walls.find((wall) => matches(wall)) ?? null;
}

function wallMidpoint(wall: Wall): Point2D {
  return segmentMidpoint(wall.startPoint, wall.endPoint);
}

function wallMidpointLiesOnRoomBoundary(room: Room, wall: Wall): boolean {
  const midpoint = wallMidpoint(wall);
  for (let index = 0; index < room.vertices.length; index += 1) {
    const edgeStart = room.vertices[index];
    const edgeEnd = room.vertices[(index + 1) % room.vertices.length];
    if (!edgeStart || !edgeEnd) {
      continue;
    }
    if (!wallsAreParallelToSegment(wall, edgeStart, edgeEnd)) {
      continue;
    }
    if (pointLiesOnSegment(midpoint, edgeStart, edgeEnd, WALL_SEGMENT_SELECTION_TOLERANCE_MM)) {
      return true;
    }
  }
  return false;
}

function replacementWallIdsForRoom(
  room: Room,
  sourceWallId: string,
  descriptors: SplitWallDescriptor[]
): string[] {
  const overlappingIds = descriptors
    .filter((descriptor) => wallMidpointLiesOnRoomBoundary(room, descriptor.wall))
    .map((descriptor) => descriptor.wall.id);

  if (overlappingIds.length === 0) {
    return room.wallIds.filter((wallId) => wallId !== sourceWallId);
  }

  return dedupeWallIds(
    room.wallIds.flatMap((wallId) => (wallId === sourceWallId ? overlappingIds : [wallId]))
  );
}

function applySplitWallSelectionState(
  state: SplitWallSelectionState,
  sourceWall: Wall,
  descriptors: SplitWallDescriptor[],
  selectedWallId: string
): SplitWallSelectionState {
  const remainingWalls = state.walls.filter((wall) => wall.id !== sourceWall.id);
  const nextDescriptors = descriptors.map((descriptor) => ({ ...descriptor, wall: { ...descriptor.wall } }));

  nextDescriptors.forEach((descriptor) => {
    const connectedWallIds: string[] = [];

    remainingWalls.forEach((otherWall) => {
      if (wallsTouchForConnection(descriptor.wall, otherWall)) {
        connectedWallIds.push(otherWall.id);
      }
    });

    nextDescriptors.forEach((otherDescriptor) => {
      if (otherDescriptor.wall.id === descriptor.wall.id) {
        return;
      }
      if (wallsTouchForConnection(descriptor.wall, otherDescriptor.wall)) {
        connectedWallIds.push(otherDescriptor.wall.id);
      }
    });

    descriptor.wall = {
      ...descriptor.wall,
      connectedWalls: dedupeWallIds(connectedWallIds).filter((id) => id !== descriptor.wall.id),
    };
  });

  const nextWalls = [
    ...remainingWalls.map((wall) => {
      if (!wall.connectedWalls.includes(sourceWall.id) && !wallsTouchForConnection(wall, sourceWall)) {
        return wall;
      }

      const nextConnectedWalls = dedupeWallIds([
        ...wall.connectedWalls.filter((id) => id !== sourceWall.id),
        ...nextDescriptors
          .filter((descriptor) => wallsTouchForConnection(wall, descriptor.wall))
          .map((descriptor) => descriptor.wall.id),
      ]).filter((id) => id !== wall.id);

      if (stringArraysEqual(nextConnectedWalls, wall.connectedWalls)) {
        return wall;
      }

      return {
        ...wall,
        connectedWalls: nextConnectedWalls,
      };
    }),
    ...nextDescriptors.map((descriptor) => descriptor.wall),
  ];

  const remapSelectedIds = (ids: string[]): string[] => dedupeWallIds(
    ids.flatMap((id) => (id === sourceWall.id ? [selectedWallId] : [id]))
  );

  return {
    walls: nextWalls,
    rooms: state.rooms.map((room) => (
      room.wallIds.includes(sourceWall.id)
        ? {
          ...room,
          wallIds: replacementWallIdsForRoom(room, sourceWall.id, nextDescriptors),
        }
        : room
    )),
    dimensions: state.dimensions.map((dimension) => (
      Array.isArray(dimension.linkedWallIds) && dimension.linkedWallIds.includes(sourceWall.id)
        ? remapDimensionForSplitWall(dimension, sourceWall, nextDescriptors)
        : dimension.anchors?.some((anchor) => anchor.wallId === sourceWall.id)
          ? remapDimensionForSplitWall(dimension, sourceWall, nextDescriptors)
          : dimension
    )),
    selectedElementIds: remapSelectedIds(state.selectedElementIds),
    selectedIds: remapSelectedIds(state.selectedIds),
    hoveredElementId: state.hoveredElementId === sourceWall.id ? selectedWallId : state.hoveredElementId,
  };
}

function findWallsTouchingPoint(
  point: Point2D,
  walls: Wall[],
  tolerance: number = 2
): string[] {
  const touching: string[] = [];

  for (const wall of walls) {
    if (
      pointsNear(point, wall.startPoint, tolerance) ||
      pointsNear(point, wall.endPoint, tolerance) ||
      pointLiesOnWall(point, wall, tolerance)
    ) {
      touching.push(wall.id);
    }
  }

  return touching;
}

function polygonArea(vertices: Point2D[], holes: Point2D[][] = []): number {
  return GeometryEngine.calculateRoomAreaMm2({ vertices, holes });
}

function polygonPerimeter(vertices: Point2D[], holes: Point2D[][] = []): number {
  return GeometryEngine.calculateRoomPerimeterMm({ vertices, holes });
}

function polygonCentroid(vertices: Point2D[], holes: Point2D[][] = []): Point2D {
  return GeometryEngine.findRoomCentroid({ vertices, holes });
}

function bindWallAttributes(wall: Wall, defaults?: Partial<Wall3D>): Wall {
  const bound = bindWallGeometryTo3D(wall, defaults);
  return {
    ...wall,
    properties3D: bound.value,
  };
}

function bindRoomAttributes(room: Room, defaults?: Partial<Room3D>): Room {
  const computedArea = polygonArea(room.vertices, room.holes ?? []);
  const computedPerimeter = polygonPerimeter(room.vertices, room.holes ?? []);
  const computedCentroid = polygonCentroid(room.vertices, room.holes ?? []);
  const bound = bindRoomGeometryTo3D(
    {
      ...room,
      area: computedArea,
    },
    defaults
  );
  return {
    ...room,
    properties3D: bound.value,
    area: computedArea,
    perimeter: computedPerimeter,
    centroid: computedCentroid,
  };
}

// =============================================================================
// Store Interface
// =============================================================================

export interface DrawingState {
  // Drawing Elements
  dimensions: Dimension2D[];
  dimensionSettings: DimensionSettings;
  annotations: Annotation2D[];
  sketches: Sketch2D[];
  guides: Guide[];
  symbols: SymbolInstance2D[];
  layers: DrawingLayer[];

  // Wall State
  walls: Wall[];
  rooms: Room[];
  materialLibrary: typeof DEFAULT_ARCHITECTURAL_MATERIALS;
  hvacDesignConditions: HvacDesignConditions;
  wallDrawingState: WallDrawingState;
  wallSettings: WallSettings;
  sectionLines: SectionLine[];
  sectionLineDrawingState: SectionLineDrawingState;
  elevationViews: ElevationView[];
  activeElevationViewId: string | null;
  elevationSettings: ElevationSettings;
  hvacElements: HvacElement[];
  editorViewMode: EditorViewMode;

  // Import State
  importedDrawing: ImportedDrawing | null;
  importProgress: number;
  isProcessing: boolean;
  processingStatus: string;
  detectedElements: DetectedElement[];

  // Tool State
  activeTool: DrawingTool;
  activeLayerId: string | null;
  selectedElementIds: string[];
  hoveredElementId: string | null;

  // Aliases for backward compatibility
  tool: DrawingTool;
  selectedIds: string[];

  // View State
  zoom: number;
  zoomToFitRequestId: number;
  resetViewRequestId: number;
  panOffset: Point2D;
  displayUnit: DisplayUnit;
  gridSize: number;
  snapToGrid: boolean;
  showGrid: boolean;
  showRulers: boolean;
  pageConfig: PageConfig;

  // Preview State
  previewHeight: number;
  show3DPreview: boolean;
  autoSync3D: boolean;

  // Calibration State
  isCalibrating: boolean;
  calibrationStep: number;

  // History State
  history: HistoryEntry[];
  historyIndex: number;

  // Spline Settings
  splineSettings: SplineSettings;
  splineEditMode: 'draw' | 'edit-points' | 'add-point' | 'remove-point';
  editingSplineId: string | null;

  // Actions - Import
  setImportedDrawing: (drawing: ImportedDrawing | null) => void;
  updateImportedDrawing: (data: Partial<ImportedDrawing>) => void;
  setImportProgress: (progress: number) => void;
  setProcessingStatus: (status: string, isProcessing: boolean) => void;
  clearImportedDrawing: () => void;

  // Actions - Detection
  setDetectedElements: (elements: DetectedElement[]) => void;
  acceptDetectedElement: (id: string) => void;
  rejectDetectedElement: (id: string) => void;
  acceptAllDetectedElements: () => void;
  clearDetectedElements: () => void;

  // Actions - Dimensions
  addDimension: (dimension: Omit<Dimension2D, 'id'>, options?: { skipHistory?: boolean }) => string;
  updateDimension: (id: string, data: Partial<Dimension2D>, options?: { skipHistory?: boolean }) => void;
  deleteDimension: (id: string) => void;
  setDimensionSettings: (settings: Partial<DimensionSettings>) => void;
  autoDimensionExteriorWalls: () => void;
  syncAutoDimensions: () => void;
  addAreaDimensions: () => void;

  // Actions - Annotations
  addAnnotation: (annotation: Omit<Annotation2D, 'id'>) => string;
  updateAnnotation: (id: string, data: Partial<Annotation2D>) => void;
  deleteAnnotation: (id: string) => void;

  // Actions - Sketches
  addSketch: (sketch: Omit<Sketch2D, 'id'>) => string;
  updateSketch: (id: string, data: Partial<Sketch2D>) => void;
  deleteSketch: (id: string) => void;

  // Actions - Guides
  addGuide: (guide: Guide) => void;
  removeGuide: (id: string) => void;
  clearGuides: () => void;

  // Actions - Symbols
  addSymbol: (symbol: Omit<SymbolInstance2D, 'id'>) => string;
  updateSymbol: (id: string, data: Partial<SymbolInstance2D>, options?: { skipHistory?: boolean }) => void;
  deleteSymbol: (id: string) => void;

  // Actions - Walls
  addWall: (params: CreateWallParams) => string;
  updateWall: (
    id: string,
    updates: Partial<Wall>,
    options?: {
      skipHistory?: boolean;
      source?: 'ui' | 'drag';
      skipRoomDetection?: boolean;
      skipElevationRegeneration?: boolean;
    }
  ) => void;
  updateWalls: (
    updates: Array<{ id: string; updates: Partial<Wall> }>,
    options?: {
      skipHistory?: boolean;
      source?: 'ui' | 'drag';
      skipRoomDetection?: boolean;
      skipElevationRegeneration?: boolean;
    }
  ) => void;
  updateWallBevel: (
    wallId: string,
    end: CornerEnd,
    bevel: Partial<BevelControl>,
    options?: {
      skipHistory?: boolean;
      source?: 'ui' | 'drag';
      skipRoomDetection?: boolean;
      skipElevationRegeneration?: boolean;
    }
  ) => void;
  resetWallBevel: (wallId: string, end: CornerEnd) => void;
  getCornerBevelDots: (
    cornerPoint: Point2D
  ) => {
    outerDotPosition: Point2D;
    innerDotPosition: Point2D;
    outerOffset: number;
    innerOffset: number;
  } | null;
  updateWall3DAttributes: (id: string, updates: Partial<Wall3D>) => void;
  deleteWall: (id: string) => void;
  getWall: (id: string) => Wall | undefined;
  addRoom: (params: {
    vertices: Point2D[];
    wallIds: string[];
    name?: string;
    roomType?: RoomType;
    perimeter?: number;
    centroid?: Point2D;
    finishes?: string;
    notes?: string;
    fillColor?: string;
    showLabel?: boolean;
    adjacentRoomIds?: string[];
    hasWindows?: boolean;
    validationWarnings?: string[];
    isExterior?: boolean;
    properties3D?: Partial<Room3D>;
  }) => string;
  updateRoom: (id: string, updates: Partial<Room>) => void;
  updateRoom3DAttributes: (id: string, updates: Partial<Room3D>) => void;
  setHvacDesignConditions: (updates: Partial<HvacDesignConditions>) => void;
  applyRoomTemplateToSelectedRooms: (templateId: string) => void;
  deleteRoom: (id: string) => void;
  getRoom: (id: string) => Room | undefined;
  moveRoom: (id: string, delta: Point2D, options?: { skipHistory?: boolean }) => void;
  detectRooms: (options?: { debounce?: boolean }) => void;
  startWallDrawing: (startPoint: Point2D) => void;
  updateWallPreview: (currentPoint: Point2D) => void;
  commitWall: () => string | null;
  cancelWallDrawing: () => void;
  setChainMode: (enabled: boolean) => void;
  startSectionLineDrawing: (startPoint: Point2D) => void;
  updateSectionLinePreview: (currentPoint: Point2D) => void;
  commitSectionLine: () => string | null;
  cancelSectionLineDrawing: () => void;
  setSectionLineDirection: (direction: SectionLineDirection) => void;
  flipSectionLineDirection: (sectionLineId: string) => void;
  updateSectionLine: (id: string, updates: Partial<SectionLine>) => void;
  deleteSectionLine: (id: string) => void;
  setElevationSettings: (settings: Partial<ElevationSettings>) => void;
  setActiveElevationView: (id: string | null) => void;
  generateElevationForSection: (sectionLineId: string) => void;
  regenerateElevations: (options?: { debounce?: boolean; focusSectionLineId?: string | null }) => void;
  setEditorViewMode: (mode: EditorViewMode) => void;
  connectWalls: (wallId: string, otherWallId: string) => void;
  disconnectWall: (wallId: string, otherWallId: string) => void;
  setWallSettings: (settings: Partial<WallSettings>) => void;
  setWallPreviewMaterial: (material: WallMaterial) => void;
  setWallPreviewThickness: (thickness: number) => void;
  createRoomWalls: (config: RoomConfig, startCorner: Point2D) => string[];
  deleteWalls: (ids: string[]) => void;
  clearAllWalls: () => void;
  addHvacElement: (element: Omit<Partial<HvacElement>, 'id'> & Pick<HvacElement, 'type' | 'position' | 'width' | 'depth' | 'height' | 'elevation' | 'mountType' | 'label'>) => string;
  addHvacElements: (elements: Array<Omit<Partial<HvacElement>, 'id'> & Pick<HvacElement, 'type' | 'position' | 'width' | 'depth' | 'height' | 'elevation' | 'mountType' | 'label'>>) => string[];
  updateHvacElement: (id: string, updates: Partial<HvacElement>, options?: { skipHistory?: boolean }) => void;
  deleteHvacElement: (id: string, options?: { skipHistory?: boolean }) => void;
  duplicateHvacElement: (id: string) => string | null;
  selectWallSegmentAtPoint: (wallId: string, point: Point2D) => string;
  selectWallSegmentWithinInterval: (wallId: string, startPoint: Point2D, endPoint: Point2D) => string;
  resolveRoomPerimeterWallSegments: (roomIds: string[]) => string[];

  // Actions - Selection
  selectElement: (id: string, addToSelection?: boolean) => void;
  deselectElement: (id: string) => void;
  clearSelection: () => void;
  selectAll: () => void;
  setHoveredElement: (id: string | null) => void;
  deleteSelectedElements: () => void;

  // Aliases for backward compatibility
  setSelectedIds: (ids: string[]) => void;
  deleteSelected: () => void;

  // Actions - Tools
  setActiveTool: (tool: DrawingTool) => void;

  // Alias for backward compatibility
  setTool: (tool: DrawingTool) => void;

  // Computed properties for history
  canUndo: boolean;
  canRedo: boolean;

  // Actions - View
  setZoom: (zoom: number) => void;
  setPanOffset: (offset: Point2D) => void;
  setViewTransform: (zoom: number, offset: Point2D) => void;
  setDisplayUnit: (unit: DisplayUnit) => void;
  setGridSize: (size: number) => void;
  setSnapToGrid: (snap: boolean) => void;
  setShowGrid: (show: boolean) => void;
  setShowRulers: (show: boolean) => void;
  toggleRulers: () => void;
  setPageConfig: (config: Partial<PageConfig>) => void;
  resetView: () => void;
  zoomToFit: () => void;

  // Actions - Preview
  setPreviewHeight: (height: number) => void;
  setShow3DPreview: (show: boolean) => void;
  setAutoSync3D: (sync: boolean) => void;

  // Actions - Calibration
  startCalibration: () => void;
  addCalibrationPoint: (point: Point2D) => void;
  setCalibrationDistance: (distance: number) => void;
  finishCalibration: () => void;
  cancelCalibration: () => void;

  // Actions - Layers
  addLayer: (name: string) => string;
  updateLayer: (id: string, data: Partial<DrawingLayer>) => void;
  deleteLayer: (id: string) => void;
  setActiveLayer: (id: string | null) => void;
  moveElementToLayer: (elementId: string, layerId: string) => void;
  toggleLayerVisibility: (id: string) => void;
  toggleLayerLock: (id: string) => void;

  // Actions - History
  saveToHistory: (action: string) => void;
  undo: () => void;
  redo: () => void;
  clearHistory: () => void;

  // Actions - Export/Import
  exportToJSON: () => string;
  importFromJSON: (json: string) => void;

  // Data management aliases
  loadData: (data: unknown) => void;
  exportData: () => unknown;

  // Actions - Spline
  setSplineSettings: (settings: Partial<SplineSettings>) => void;
  setSplineEditMode: (mode: 'draw' | 'edit-points' | 'add-point' | 'remove-point') => void;
  setEditingSpline: (id: string | null) => void;
  addSplineControlPoint: (sketchId: string, point: Point2D, index?: number) => void;
  updateSplineControlPoint: (sketchId: string, pointIndex: number, position: Point2D) => void;
  removeSplineControlPoint: (sketchId: string, pointIndex: number) => void;
  toggleSplineClosed: (sketchId: string) => void;
  convertSplineMethod: (sketchId: string, method: SplineMethod) => void;
}

// =============================================================================
// Store Implementation
// =============================================================================

export const useDrawingStore = create<DrawingState>()(
  devtools(
    (set, get) => ({
      // Initial State
      dimensions: [],
      dimensionSettings: { ...DEFAULT_DIMENSION_SETTINGS },
      annotations: [],
      sketches: [],
      guides: [],
      symbols: [],
      layers: [...DEFAULT_LAYERS],

      // Wall State
      walls: [],
      rooms: [],
      materialLibrary: [...DEFAULT_ARCHITECTURAL_MATERIALS],
      hvacDesignConditions: { ...DEFAULT_HVAC_DESIGN_CONDITIONS },
      wallDrawingState: { ...DEFAULT_WALL_DRAWING_STATE },
      wallSettings: { ...DEFAULT_WALL_SETTINGS },
      sectionLines: [],
      sectionLineDrawingState: { ...DEFAULT_SECTION_LINE_DRAWING_STATE },
      elevationViews: INITIAL_ELEVATION_VIEWS.map((view) => ({
        ...view,
        walls: view.walls.map((projection) => ({
          ...projection,
          openings: projection.openings.map((opening) => ({ ...opening })),
        })),
      })),
      activeElevationViewId: INITIAL_ELEVATION_VIEWS[0]?.id ?? null,
      elevationSettings: { ...DEFAULT_ELEVATION_SETTINGS },
      hvacElements: [],
      editorViewMode: 'plan' as EditorViewMode,
      importedDrawing: null,
      importProgress: 0,
      isProcessing: false,
      processingStatus: '',
      detectedElements: [],
      activeTool: 'select',
      activeLayerId: 'default',
      selectedElementIds: [],
      hoveredElementId: null,

      // Aliases for backward compatibility
      tool: 'select',
      selectedIds: [],
      canUndo: false,
      canRedo: false,

      zoom: 1,
      zoomToFitRequestId: 0,
      resetViewRequestId: 0,
      panOffset: { x: 0, y: 0 },
      displayUnit: 'mm',
      gridSize: 20,
      snapToGrid: true,
      showGrid: true,
      showRulers: true,
      pageConfig: { ...DEFAULT_PAGE_CONFIG },
      previewHeight: 3.0,
      show3DPreview: true,
      autoSync3D: true,
      isCalibrating: false,
      calibrationStep: 0,
      history: [createHistoryEntry('Initial state', createEmptyHistorySnapshot())],
      historyIndex: 0,
      splineSettings: { ...DEFAULT_SPLINE_SETTINGS },
      splineEditMode: 'draw',
      editingSplineId: null,

      // Import Actions
      setImportedDrawing: (drawing) => set({ importedDrawing: drawing }),

      updateImportedDrawing: (data) => set((state) => ({
        importedDrawing: state.importedDrawing
          ? { ...state.importedDrawing, ...data }
          : null,
      })),

      setImportProgress: (progress) => set({ importProgress: progress }),

      setProcessingStatus: (status, isProcessing) => set((state) => (
        state.processingStatus === status && state.isProcessing === isProcessing
          ? state
          : {
            processingStatus: status,
            isProcessing,
          }
      )),

      clearImportedDrawing: () => set({
        importedDrawing: null,
        importProgress: 0,
        detectedElements: []
      }),

      // Detection Actions
      setDetectedElements: (elements) => set({ detectedElements: elements }),

      acceptDetectedElement: (id) => set((state) => ({
        detectedElements: state.detectedElements.map((el) =>
          el.id === id ? { ...el, accepted: true } : el
        ),
      })),

      rejectDetectedElement: (id) => set((state) => ({
        detectedElements: state.detectedElements.filter((el) => el.id !== id),
      })),

      acceptAllDetectedElements: () => set((state) => ({
        detectedElements: state.detectedElements.map((el) => ({ ...el, accepted: true })),
      })),

      clearDetectedElements: () => set({ detectedElements: [] }),

      // Guide Actions
      addGuide: (guide) => set((state) => ({ guides: [...state.guides, guide] })),
      removeGuide: (id) => set((state) => ({ guides: state.guides.filter((g) => g.id !== id) })),
      clearGuides: () => set({ guides: [] }),

      // Dimension Actions
      addDimension: (dimension, options) => {
        const id = generateId();
        const normalized = normalizeDimensionPayload(dimension, get().dimensionSettings);
        set((state) => ({ dimensions: [...state.dimensions, { ...normalized, id }] }));
        if (!options?.skipHistory) {
          get().saveToHistory('Add dimension');
        }
        return id;
      },

      updateDimension: (id, data, options) => {
        set((state) => ({
          dimensions: state.dimensions.map((d) => {
            if (d.id !== id) return d;
            const merged = { ...d, ...data };
            return {
              ...normalizeDimensionPayload(
                merged,
                state.dimensionSettings
              ),
              id: d.id,
            };
          })
        }));
        if (!options?.skipHistory) {
          get().saveToHistory('Update dimension');
        }
      },

      deleteDimension: (id) => {
        set((state) => ({ dimensions: state.dimensions.filter((d) => d.id !== id) }));
        get().saveToHistory('Delete dimension');
      },

      setDimensionSettings: (settings) => {
        set((state) => ({
          dimensionSettings: {
            ...state.dimensionSettings,
            ...settings,
            precision:
              settings.precision === 0 || settings.precision === 1 || settings.precision === 2
                ? settings.precision
                : state.dimensionSettings.precision,
            defaultOffset: settings.defaultOffset !== undefined
              ? Math.max(20, settings.defaultOffset)
              : state.dimensionSettings.defaultOffset,
            extensionGap: settings.extensionGap !== undefined
              ? Math.max(0, settings.extensionGap)
              : state.dimensionSettings.extensionGap,
            extensionBeyond: settings.extensionBeyond !== undefined
              ? Math.max(0, settings.extensionBeyond)
              : state.dimensionSettings.extensionBeyond,
          },
        }));
      },

      autoDimensionExteriorWalls: () => {
        const { walls, rooms, dimensionSettings, dimensions } = get();
        const autoLinear = buildAutoWallDimensions(walls, rooms, dimensionSettings);
        const preserved = dimensions.filter((dimension) => !dimension.baselineGroupId);
        set({
          dimensions: [
            ...preserved,
            ...mergeAutoManagedDimensions(autoLinear, dimensions, dimensionSettings),
          ],
        });
        get().saveToHistory('Auto dimension exterior walls');
        get().setProcessingStatus('Auto dimensions added for walls.', false);
      },

      /**
       * Silently rebuild all auto-generated dimensions without touching history.
       * Called automatically whenever walls/rooms/settings change so dimensions
       * are always visible without requiring a manual trigger.
       */
      syncAutoDimensions: () => {
        const { walls, rooms, dimensionSettings, dimensions } = get();
        if (walls.length === 0 && rooms.length === 0) return;
        const signature = autoManagedDimensionSignature({
          walls,
          rooms,
          dimensionSettings,
          dimensions,
        });
        if (signature === lastAutoDimensionSignature || signature === pendingAutoDimensionSignature) {
          return;
        }

        pendingAutoDimensionSignature = signature;
        const requestId = ++autoDimensionRequestId;
        const wallsSnapshot = walls.map((wall) => ({
          ...wall,
          startPoint: { ...wall.startPoint },
          endPoint: { ...wall.endPoint },
          interiorLine: {
            start: { ...wall.interiorLine.start },
            end: { ...wall.interiorLine.end },
          },
          exteriorLine: {
            start: { ...wall.exteriorLine.start },
            end: { ...wall.exteriorLine.end },
          },
          openings: wall.openings.map((opening) => ({ ...opening })),
          connectedWalls: [...wall.connectedWalls],
          startBevel: { ...wall.startBevel },
          endBevel: { ...wall.endBevel },
          properties3D: { ...wall.properties3D },
        }));
        const roomsSnapshot = rooms.map((room) => ({
          ...room,
          centroid: { ...room.centroid },
          vertices: room.vertices.map((vertex) => ({ ...vertex })),
          holes: room.holes?.map((hole) => hole.map((vertex) => ({ ...vertex }))),
          wallIds: [...room.wallIds],
          adjacentRoomIds: [...room.adjacentRoomIds],
          validationWarnings: [...room.validationWarnings],
          properties3D: { ...room.properties3D },
        }));
        const dimensionsSnapshot = dimensions.map((dimension) => ({
          ...dimension,
          points: dimension.points.map((point) => ({ ...point })),
          textPosition: { ...dimension.textPosition },
          linkedWallIds: dimension.linkedWallIds ? [...dimension.linkedWallIds] : undefined,
          anchors: dimension.anchors?.map((anchor) => ({
            ...anchor,
            point: anchor.point ? { ...anchor.point } : undefined,
          })),
          baselineOrigin: dimension.baselineOrigin ? { ...dimension.baselineOrigin } : undefined,
        }));
        const dimensionSettingsSnapshot = { ...dimensionSettings };

        void syncAutoDimensionsInBackground({
          signature,
          walls: wallsSnapshot,
          rooms: roomsSnapshot,
          dimensionSettings: dimensionSettingsSnapshot,
          dimensions: dimensionsSnapshot,
        }).then((nextDimensions) => {
          if (requestId !== autoDimensionRequestId) {
            return;
          }

          const currentState = get();
          const currentSignature = autoManagedDimensionSignature({
            walls: currentState.walls,
            rooms: currentState.rooms,
            dimensionSettings: currentState.dimensionSettings,
            dimensions: currentState.dimensions,
          });
          if (currentSignature !== signature) {
            pendingAutoDimensionSignature = '';
            get().syncAutoDimensions();
            return;
          }

          lastAutoDimensionSignature = autoManagedDimensionSignature({
            walls: currentState.walls,
            rooms: currentState.rooms,
            dimensionSettings: currentState.dimensionSettings,
            dimensions: nextDimensions,
          });
          pendingAutoDimensionSignature = '';
          set({ dimensions: nextDimensions });
        }).catch(() => {
          if (requestId !== autoDimensionRequestId) {
            return;
          }

          const currentState = get();
          const currentSignature = autoManagedDimensionSignature({
            walls: currentState.walls,
            rooms: currentState.rooms,
            dimensionSettings: currentState.dimensionSettings,
            dimensions: currentState.dimensions,
          });
          if (currentSignature !== signature) {
            pendingAutoDimensionSignature = '';
            get().syncAutoDimensions();
            return;
          }

          const nextDimensions = buildMergedAutoManagedDimensions({
            walls: currentState.walls,
            rooms: currentState.rooms,
            dimensionSettings: currentState.dimensionSettings,
            dimensions: currentState.dimensions,
          });
          lastAutoDimensionSignature = autoManagedDimensionSignature({
            walls: currentState.walls,
            rooms: currentState.rooms,
            dimensionSettings: currentState.dimensionSettings,
            dimensions: nextDimensions,
          });
          pendingAutoDimensionSignature = '';
          set({ dimensions: nextDimensions });
        });
      },

      addAreaDimensions: () => {
        const { rooms, dimensionSettings } = get();
        const areaDimensions = buildRoomAreaDimensions(rooms, dimensionSettings);
        set((state) => ({
          dimensions: [
            ...state.dimensions.filter((dimension) => !dimension.linkedRoomId),
            ...areaDimensions.map((dimension) => ({
              ...normalizeDimensionPayload(dimension, dimensionSettings),
              id: generateId(),
            })),
          ],
        }));
        get().saveToHistory('Add room area dimensions');
        get().setProcessingStatus('Room area labels updated.', false);
      },

      // Annotation Actions
      addAnnotation: (annotation) => {
        const id = generateId();
        set((state) => ({ annotations: [...state.annotations, { ...annotation, id }] }));
        get().saveToHistory('Add annotation');
        return id;
      },

      updateAnnotation: (id, data) => {
        set((state) => ({
          annotations: state.annotations.map((a) => a.id === id ? { ...a, ...data } : a)
        }));
        get().saveToHistory('Update annotation');
      },

      deleteAnnotation: (id) => {
        set((state) => ({ annotations: state.annotations.filter((a) => a.id !== id) }));
        get().saveToHistory('Delete annotation');
      },

      // Sketch Actions
      addSketch: (sketch) => {
        const id = generateId();
        set((state) => ({ sketches: [...state.sketches, { ...sketch, id }] }));
        get().saveToHistory('Add sketch');
        return id;
      },

      updateSketch: (id, data) => {
        set((state) => ({
          sketches: state.sketches.map((s) => s.id === id ? { ...s, ...data } : s)
        }));
        get().saveToHistory('Update sketch');
      },

      deleteSketch: (id) => {
        set((state) => ({ sketches: state.sketches.filter((s) => s.id !== id) }));
        get().saveToHistory('Delete sketch');
      },

      // Symbol Actions
      addSymbol: (symbol) => {
        const id = generateId();
        set((state) => ({ symbols: [...state.symbols, { ...symbol, id }] }));
        get().regenerateElevations({ debounce: true });
        get().saveToHistory('Add symbol');
        return id;
      },

      updateSymbol: (id, data, options) => {
        set((state) => ({
          symbols: state.symbols.map((s) => s.id === id ? { ...s, ...data } : s)
        }));
        get().regenerateElevations({ debounce: true });
        if (!options?.skipHistory) {
          get().saveToHistory('Update symbol');
        }
      },

      deleteSymbol: (id) => {
        set((state) => ({
          symbols: state.symbols.filter((s) => s.id !== id),
          walls: removeOpeningsLinkedToSymbols(state.walls, new Set([id])),
        }));
        get().regenerateElevations({ debounce: true });
        get().saveToHistory('Delete symbol');
      },

      // Wall Actions
      detectRooms: (options) => {
        const runDetection = () => {
          const detectionState = get();
          const topology = roomTopologyHash(detectionState.walls);
          if (topology === lastRoomTopologyHash || topology === pendingRoomTopologyHash) {
            return;
          }

          pendingRoomTopologyHash = topology;
          const requestId = ++roomDetectionRequestId;
          const wallsSnapshot = detectionState.walls.map((wall) => ({
            ...wall,
            startPoint: { ...wall.startPoint },
            endPoint: { ...wall.endPoint },
            interiorLine: {
              start: { ...wall.interiorLine.start },
              end: { ...wall.interiorLine.end },
            },
            exteriorLine: {
              start: { ...wall.exteriorLine.start },
              end: { ...wall.exteriorLine.end },
            },
            openings: wall.openings.map((opening) => ({ ...opening })),
            connectedWalls: [...wall.connectedWalls],
            startBevel: { ...wall.startBevel },
            endBevel: { ...wall.endBevel },
          }));
          const roomsSnapshot = detectionState.rooms.map((room) => ({
            ...room,
            vertices: room.vertices.map((vertex) => ({ ...vertex })),
            holes: room.holes?.map((hole) => hole.map((vertex) => ({ ...vertex }))),
            wallIds: [...room.wallIds],
            adjacentRoomIds: [...room.adjacentRoomIds],
            validationWarnings: [...room.validationWarnings],
          }));

          void detectRoomsInBackground({
            topology,
            walls: wallsSnapshot,
            rooms: roomsSnapshot,
          }).then((detectedRooms) => {
            if (requestId !== roomDetectionRequestId) {
              return;
            }

            set((state) => {
              const currentTopology = roomTopologyHash(state.walls);
              if (currentTopology !== topology) {
                return state;
              }
              lastRoomTopologyHash = topology;
              pendingRoomTopologyHash = '';
              return {
                rooms: detectedRooms,
              };
            });
          }).catch(() => {
            if (requestId !== roomDetectionRequestId) {
              return;
            }

            set((state) => {
              const currentTopology = roomTopologyHash(state.walls);
              if (currentTopology !== topology) {
                return state;
              }
              const detectedRooms = buildAutoDetectedRooms(state.walls, state.rooms);
              lastRoomTopologyHash = topology;
              pendingRoomTopologyHash = '';
              return {
                rooms: detectedRooms,
              };
            });
          });
        };

        // Drag updates call this with debounce=true; keep those updates live by
        // frame-throttling instead of resetting a trailing debounce on every move.
        if (options?.debounce) {
          scheduleRoomDetection(runDetection);
          return;
        }

        clearScheduledRoomDetection();
        runDetection();
      },

      setEditorViewMode: (mode) => set({ editorViewMode: mode }),

      regenerateElevations: (options) => {
        const runRegeneration = () => {
          const state = get();
          const focusSectionLineId = options?.focusSectionLineId ?? null;
          const furnitureInputs = buildFurnitureInputs(state.symbols);
          const signature = elevationGenerationSignature({
            walls: state.walls,
            sectionLines: state.sectionLines,
            elevationViews: state.elevationViews,
            elevationSettings: state.elevationSettings,
            hvacElements: state.hvacElements,
            furnitureInputs,
          });
          if (
            signature === lastElevationGenerationSignature ||
            signature === pendingElevationGenerationSignature
          ) {
            if (focusSectionLineId) {
              const nextActiveViewId = resolveNextActiveElevationViewId(
                state.elevationViews,
                state.activeElevationViewId,
                focusSectionLineId
              );
              if (nextActiveViewId !== state.activeElevationViewId) {
                set({ activeElevationViewId: nextActiveViewId });
              }
              pendingElevationFocusSectionLineId =
                signature === pendingElevationGenerationSignature
                  ? focusSectionLineId
                  : null;
            }
            return;
          }

          pendingElevationGenerationSignature = signature;
          pendingElevationFocusSectionLineId = focusSectionLineId ?? null;
          const requestId = ++elevationGenerationRequestId;
          const wallsSnapshot = state.walls.map((wall) => ({
            ...wall,
            startPoint: { ...wall.startPoint },
            endPoint: { ...wall.endPoint },
            interiorLine: {
              start: { ...wall.interiorLine.start },
              end: { ...wall.interiorLine.end },
            },
            exteriorLine: {
              start: { ...wall.exteriorLine.start },
              end: { ...wall.exteriorLine.end },
            },
            openings: wall.openings.map((opening) => ({ ...opening })),
            connectedWalls: [...wall.connectedWalls],
            startBevel: { ...wall.startBevel },
            endBevel: { ...wall.endBevel },
            properties3D: { ...wall.properties3D },
          }));
          const sectionLinesSnapshot = state.sectionLines.map((sectionLine) => ({
            ...sectionLine,
            startPoint: { ...sectionLine.startPoint },
            endPoint: { ...sectionLine.endPoint },
          }));
          const elevationViewsSnapshot = state.elevationViews.map((view) => ({
            ...view,
            walls: view.walls.map((wall) => ({
              ...wall,
              openings: wall.openings.map((opening) => ({ ...opening })),
            })),
            hvacElements: view.hvacElements.map((element) => ({ ...element })),
            furnitureElements: view.furnitureElements.map((element) => ({ ...element })),
          }));
          const hvacElementsSnapshot = state.hvacElements.map((element) => ({
            ...element,
            position: { ...element.position },
            properties: element.properties ? { ...element.properties } : {},
          }));
          const furnitureInputsSnapshot = furnitureInputs.map((entry) => ({
            definition: { ...entry.definition },
            instance: {
              ...entry.instance,
              position: { ...entry.instance.position },
              properties: entry.instance.properties ? { ...entry.instance.properties } : {},
            },
          }));
          const elevationSettingsSnapshot = { ...state.elevationSettings };

          void regenerateElevationsInBackground({
            signature,
            walls: wallsSnapshot,
            sectionLines: sectionLinesSnapshot,
            existingViews: elevationViewsSnapshot,
            elevationSettings: elevationSettingsSnapshot,
            hvacElements: hvacElementsSnapshot,
            furnitureInputs: furnitureInputsSnapshot,
          }).then((nextViews) => {
            if (requestId !== elevationGenerationRequestId) {
              return;
            }

            const currentState = get();
            const currentFurnitureInputs = buildFurnitureInputs(currentState.symbols);
            const currentSignature = elevationGenerationSignature({
              walls: currentState.walls,
              sectionLines: currentState.sectionLines,
              elevationViews: currentState.elevationViews,
              elevationSettings: currentState.elevationSettings,
              hvacElements: currentState.hvacElements,
              furnitureInputs: currentFurnitureInputs,
            });
            if (currentSignature !== signature) {
              pendingElevationGenerationSignature = '';
              get().regenerateElevations({
                focusSectionLineId: pendingElevationFocusSectionLineId,
              });
              return;
            }

            lastElevationGenerationSignature = elevationGenerationSignature({
              walls: currentState.walls,
              sectionLines: currentState.sectionLines,
              elevationViews: nextViews,
              elevationSettings: currentState.elevationSettings,
              hvacElements: currentState.hvacElements,
              furnitureInputs: currentFurnitureInputs,
            });
            pendingElevationGenerationSignature = '';
            const nextActiveViewId = resolveNextActiveElevationViewId(
              nextViews,
              currentState.activeElevationViewId,
              pendingElevationFocusSectionLineId
            );
            pendingElevationFocusSectionLineId = null;
            set({
              elevationViews: nextViews,
              activeElevationViewId: nextActiveViewId,
            });
          }).catch(() => {
            if (requestId !== elevationGenerationRequestId) {
              return;
            }

            const currentState = get();
            const currentFurnitureInputs = buildFurnitureInputs(currentState.symbols);
            const currentSignature = elevationGenerationSignature({
              walls: currentState.walls,
              sectionLines: currentState.sectionLines,
              elevationViews: currentState.elevationViews,
              elevationSettings: currentState.elevationSettings,
              hvacElements: currentState.hvacElements,
              furnitureInputs: currentFurnitureInputs,
            });
            if (currentSignature !== signature) {
              pendingElevationGenerationSignature = '';
              get().regenerateElevations({
                focusSectionLineId: pendingElevationFocusSectionLineId,
              });
              return;
            }

            const nextViews = regenerateElevationViews(
              currentState.walls,
              currentState.sectionLines,
              currentState.elevationViews,
              currentState.elevationSettings,
              currentState.hvacElements,
              currentFurnitureInputs
            );
            lastElevationGenerationSignature = elevationGenerationSignature({
              walls: currentState.walls,
              sectionLines: currentState.sectionLines,
              elevationViews: nextViews,
              elevationSettings: currentState.elevationSettings,
              hvacElements: currentState.hvacElements,
              furnitureInputs: currentFurnitureInputs,
            });
            pendingElevationGenerationSignature = '';
            const nextActiveViewId = resolveNextActiveElevationViewId(
              nextViews,
              currentState.activeElevationViewId,
              pendingElevationFocusSectionLineId
            );
            pendingElevationFocusSectionLineId = null;
            set({
              elevationViews: nextViews,
              activeElevationViewId: nextActiveViewId,
            });
          });
        };

        if (options?.debounce) {
          if (elevationRegenTimer) {
            clearTimeout(elevationRegenTimer);
          }
          elevationRegenTimer = setTimeout(() => {
            elevationRegenTimer = null;
            runRegeneration();
          }, ELEVATION_REGEN_DEBOUNCE_MS);
          return;
        }

        if (elevationRegenTimer) {
          clearTimeout(elevationRegenTimer);
          elevationRegenTimer = null;
        }

        runRegeneration();
      },

      setElevationSettings: (settings) => {
        set((state) => ({
          elevationSettings: {
            ...state.elevationSettings,
            ...settings,
            defaultGridIncrementMm: settings.defaultGridIncrementMm !== undefined
              ? Math.max(100, settings.defaultGridIncrementMm)
              : state.elevationSettings.defaultGridIncrementMm,
            defaultScale: settings.defaultScale !== undefined
              ? Math.max(1, settings.defaultScale)
              : state.elevationSettings.defaultScale,
            sunAngleDeg: settings.sunAngleDeg !== undefined
              ? clampValue(settings.sunAngleDeg, 0, 360)
              : state.elevationSettings.sunAngleDeg,
          },
        }));
        get().regenerateElevations();
      },

      setActiveElevationView: (id) =>
        set((state) => ({
          activeElevationViewId: id && state.elevationViews.some((view) => view.id === id) ? id : null,
        })),

      startSectionLineDrawing: (startPoint) => {
        const sectionIndex = get().sectionLines.length + 1;
        const nextKind = get().sectionLineDrawingState.nextKind;
        const nextLabel = sectionLabelForIndex(nextKind, sectionIndex);
        set((state) => ({
          sectionLineDrawingState: {
            ...state.sectionLineDrawingState,
            isDrawing: true,
            startPoint: { ...startPoint },
            currentPoint: { ...startPoint },
            nextLabel,
          },
        }));
      },

      updateSectionLinePreview: (currentPoint) =>
        set((state) => ({
          sectionLineDrawingState: {
            ...state.sectionLineDrawingState,
            currentPoint: { ...currentPoint },
          },
        })),

      cancelSectionLineDrawing: () =>
        set((state) => ({
          sectionLineDrawingState: {
            ...DEFAULT_SECTION_LINE_DRAWING_STATE,
            direction: state.sectionLineDrawingState.direction,
            nextKind: state.sectionLineDrawingState.nextKind,
          },
        })),

      setSectionLineDirection: (direction) =>
        set((state) => ({
          sectionLineDrawingState: {
            ...state.sectionLineDrawingState,
            direction: direction === -1 ? -1 : 1,
          },
        })),

      commitSectionLine: () => {
        const { sectionLineDrawingState, wallSettings } = get();
        if (
          !sectionLineDrawingState.isDrawing ||
          !sectionLineDrawingState.startPoint ||
          !sectionLineDrawingState.currentPoint
        ) {
          return null;
        }

        const sectionLength = wallLengthMm(
          sectionLineDrawingState.startPoint,
          sectionLineDrawingState.currentPoint
        );
        if (sectionLength < MIN_WALL_LENGTH) {
          return null;
        }

        const sectionIndex = get().sectionLines.length + 1;
        const fallbackLabel = sectionLabelForIndex(sectionLineDrawingState.nextKind, sectionIndex);
        const label =
          sectionLineDrawingState.nextLabel.trim().length > 0
            ? sectionLineDrawingState.nextLabel.trim()
            : fallbackLabel;

        const sectionLine: SectionLine = {
          id: generateId(),
          label,
          name: label,
          kind: sectionLineDrawingState.nextKind,
          startPoint: { ...sectionLineDrawingState.startPoint },
          endPoint: { ...sectionLineDrawingState.currentPoint },
          direction: sectionLineDrawingState.direction,
          color: DEFAULT_SECTION_LINE_COLOR,
          depthMm: DEFAULT_SECTION_LINE_DEPTH_MM,
          locked: false,
          showReferenceIndicators: wallSettings.showSectionReferenceLines,
        };

        set((state) => ({
          sectionLines: [...state.sectionLines, sectionLine],
          sectionLineDrawingState: {
            ...DEFAULT_SECTION_LINE_DRAWING_STATE,
            direction: state.sectionLineDrawingState.direction,
            nextKind: state.sectionLineDrawingState.nextKind,
            nextLabel: sectionLabelForIndex(state.sectionLineDrawingState.nextKind, state.sectionLines.length + 2),
          },
        }));
        get().generateElevationForSection(sectionLine.id);
        get().saveToHistory('Add section line');
        return sectionLine.id;
      },

      generateElevationForSection: (sectionLineId) => {
        const state = get();
        const sectionLine = state.sectionLines.find((entry) => entry.id === sectionLineId);
        if (!sectionLine) {
          return;
        }

        const existingCustom = state.elevationViews.find(
          (view) => view.kind === 'custom' && view.sectionLineId === sectionLineId
        );
        if (existingCustom) {
          set({ activeElevationViewId: existingCustom.id });
        }

        get().regenerateElevations({ focusSectionLineId: sectionLineId });
      },

      updateSectionLine: (id, updates) => {
        const nextUpdates: Partial<SectionLine> = { ...updates };
        if (nextUpdates.direction !== undefined) {
          nextUpdates.direction = nextUpdates.direction === -1 ? -1 : 1;
        }
        if (nextUpdates.depthMm !== undefined) {
          nextUpdates.depthMm = Math.max(100, nextUpdates.depthMm);
        }
        set((state) => ({
          sectionLines: state.sectionLines.map((line) =>
            line.id === id
              ? {
                ...line,
                ...nextUpdates,
              }
              : line
          ),
        }));
        get().generateElevationForSection(id);
        get().saveToHistory('Update section line');
      },

      flipSectionLineDirection: (sectionLineId) => {
        set((state) => ({
          sectionLines: state.sectionLines.map((line) =>
            line.id === sectionLineId
              ? { ...line, direction: line.direction === 1 ? -1 : 1 }
              : line
          ),
        }));
        get().generateElevationForSection(sectionLineId);
        get().saveToHistory('Flip section direction');
      },

      deleteSectionLine: (id) => {
        set((state) => {
          const nextSectionLines = state.sectionLines.filter((line) => line.id !== id);
          const nextViews = state.elevationViews.filter((view) => view.sectionLineId !== id);
          const nextActive =
            state.activeElevationViewId &&
              nextViews.some((view) => view.id === state.activeElevationViewId)
              ? state.activeElevationViewId
              : nextViews[0]?.id ?? null;
          return {
            sectionLines: nextSectionLines,
            elevationViews: nextViews,
            activeElevationViewId: nextActive,
          };
        });
        get().regenerateElevations();
        get().saveToHistory('Delete section line');
      },

      addWall: (params) => {
        const id = generateId();
        const thickness = clampThickness(params.thickness ?? 150);
        const material = params.material ?? 'brick';
        const layer = params.layer ?? 'partition';
        const partitionMode = params.partitionMode;
        const existingWalls = get().walls;
        const trimmedEndpoints = autoTrimWallEndpoints(
          params.startPoint,
          params.endPoint,
          existingWalls
        );
        const connectedWallIds = Array.from(
          new Set([
            ...findWallsTouchingPoint(trimmedEndpoints.startPoint, existingWalls),
            ...findWallsTouchingPoint(trimmedEndpoints.endPoint, existingWalls),
          ])
        );

        // Compute offset lines
        const dx = trimmedEndpoints.endPoint.x - trimmedEndpoints.startPoint.x;
        const dy = trimmedEndpoints.endPoint.y - trimmedEndpoints.startPoint.y;
        const length = Math.sqrt(dx * dx + dy * dy) || 1;
        const perpX = -dy / length;
        const perpY = dx / length;
        const halfThickness = thickness / 2;

        const wall: Wall = {
          id,
          startPoint: { ...trimmedEndpoints.startPoint },
          endPoint: { ...trimmedEndpoints.endPoint },
          thickness,
          centerlineOffset: 0,
          material,
          layer,
          partitionMode,
          interiorLine: {
            start: {
              x: trimmedEndpoints.startPoint.x + perpX * halfThickness,
              y: trimmedEndpoints.startPoint.y + perpY * halfThickness,
            },
            end: {
              x: trimmedEndpoints.endPoint.x + perpX * halfThickness,
              y: trimmedEndpoints.endPoint.y + perpY * halfThickness,
            },
          },
          exteriorLine: {
            start: {
              x: trimmedEndpoints.startPoint.x - perpX * halfThickness,
              y: trimmedEndpoints.startPoint.y - perpY * halfThickness,
            },
            end: {
              x: trimmedEndpoints.endPoint.x - perpX * halfThickness,
              y: trimmedEndpoints.endPoint.y - perpY * halfThickness,
            },
          },
          startBevel: { ...DEFAULT_BEVEL_CONTROL },
          endBevel: { ...DEFAULT_BEVEL_CONTROL },
          connectedWalls: connectedWallIds,
          openings: [],
          properties3D: { ...DEFAULT_WALL_3D },
        };
        const materialId = getDefaultMaterialIdForWallMaterial(wall.material);
        const boundWall = bindWallAttributes(wall, {
          materialId,
          height: get().wallSettings.defaultHeight ?? DEFAULT_WALL_HEIGHT,
          layerCount: get().wallSettings.defaultLayerCount ?? DEFAULT_WALL_LAYER_COUNT,
          thermalResistance: getArchitecturalMaterial(materialId)?.thermalResistance ?? DEFAULT_WALL_3D.thermalResistance,
          ...(params.properties3D ?? {}),
        });
        let effectiveWallId = id;

        set((state) => {
          const nextWalls = [
            ...state.walls.map((existingWall) => {
              if (
                connectedWallIds.includes(existingWall.id) &&
                !existingWall.connectedWalls.includes(id)
              ) {
                return {
                  ...existingWall,
                  connectedWalls: [...existingWall.connectedWalls, id],
                };
              }
              return existingWall;
            }),
            boundWall,
          ];
          const collapsed = collapseCoincidentWallOverlaps({
            walls: cleanupStraightWallRuns(nextWalls, id),
            rooms: state.rooms,
            dimensions: state.dimensions,
            selectedElementIds: state.selectedElementIds,
            selectedIds: state.selectedIds,
            hoveredElementId: state.hoveredElementId,
          });
          effectiveWallId = resolveWallReplacementId(id, collapsed.replacementMap);

          return {
            walls: collapsed.walls,
            rooms: collapsed.rooms,
            dimensions: collapsed.dimensions,
            selectedElementIds: collapsed.selectedElementIds,
            selectedIds: collapsed.selectedIds,
            hoveredElementId: collapsed.hoveredElementId,
          };
        });
        if (effectiveWallId === boundWall.id) {
          attributeChangeObserver.notify({
            entity: 'wall',
            entityId: boundWall.id,
            previousValue: null,
            nextValue: boundWall.properties3D,
            source: 'binding',
            timestamp: Date.now(),
          });
        }
        get().detectRooms();
        get().regenerateElevations();
        get().saveToHistory('Add wall');
        return effectiveWallId;
      },

      updateWall: (id, updates, options) => {
        const safeUpdates = updates.thickness !== undefined
          ? { ...updates, thickness: clampThickness(updates.thickness) }
          : updates;
        let previousValue: Wall3D | null = null;
        let nextValue: Wall3D | null = null;
        let effectiveWallId = id;
        const geometryChanged = Boolean(
          safeUpdates.startPoint ||
          safeUpdates.endPoint ||
          safeUpdates.thickness !== undefined ||
          safeUpdates.openings
        );
        const elevationChanged = Boolean(
          geometryChanged ||
          safeUpdates.material !== undefined ||
          safeUpdates.layer !== undefined
        );

        set((state) => {
          const nextWalls = state.walls.map((wall) => {
            if (wall.id !== id) return wall;
            previousValue = wall.properties3D;
            const updatedWall = normalizeWallBevel({
              ...wall,
              ...safeUpdates,
              startBevel: safeUpdates.startBevel ?? wall.startBevel,
              endBevel: safeUpdates.endBevel ?? wall.endBevel,
            });

            // Recompute geometry if relevant fields changed
            if (safeUpdates.startPoint || safeUpdates.endPoint || safeUpdates.thickness) {
              const dx = updatedWall.endPoint.x - updatedWall.startPoint.x;
              const dy = updatedWall.endPoint.y - updatedWall.startPoint.y;
              const length = Math.sqrt(dx * dx + dy * dy) || 1;
              const perpX = -dy / length;
              const perpY = dx / length;
              const halfThickness = updatedWall.thickness / 2;

              updatedWall.interiorLine = {
                start: { x: updatedWall.startPoint.x + perpX * halfThickness, y: updatedWall.startPoint.y + perpY * halfThickness },
                end: { x: updatedWall.endPoint.x + perpX * halfThickness, y: updatedWall.endPoint.y + perpY * halfThickness },
              };
              updatedWall.exteriorLine = {
                start: { x: updatedWall.startPoint.x - perpX * halfThickness, y: updatedWall.startPoint.y - perpY * halfThickness },
                end: { x: updatedWall.endPoint.x - perpX * halfThickness, y: updatedWall.endPoint.y - perpY * halfThickness },
              };
            }

            const reboundWall = bindWallAttributes(updatedWall, updatedWall.properties3D);
            nextValue = reboundWall.properties3D;
            return reboundWall;
          });
          const cleanedWalls = geometryChanged
            ? cleanupStraightWallRuns(nextWalls, id)
            : nextWalls;
          const collapsed = geometryChanged
            ? collapseCoincidentWallOverlaps({
              walls: cleanedWalls,
              rooms: state.rooms,
              dimensions: state.dimensions,
              selectedElementIds: state.selectedElementIds,
              selectedIds: state.selectedIds,
              hoveredElementId: state.hoveredElementId,
              preferredRetainedIds: new Set<string>([id]),
            })
            : {
              walls: cleanedWalls,
              rooms: state.rooms,
              dimensions: state.dimensions,
              selectedElementIds: state.selectedElementIds,
              selectedIds: state.selectedIds,
              hoveredElementId: state.hoveredElementId,
              replacementMap: new Map<string, string>(),
            };

          effectiveWallId = resolveWallReplacementId(id, collapsed.replacementMap);
          const cleanedTarget = collapsed.walls.find((wall) => wall.id === effectiveWallId);
          if (cleanedTarget) {
            nextValue = cleanedTarget.properties3D;
          }

          return {
            walls: collapsed.walls,
            rooms: collapsed.rooms,
            dimensions: collapsed.dimensions,
            selectedElementIds: collapsed.selectedElementIds,
            selectedIds: collapsed.selectedIds,
            hoveredElementId: collapsed.hoveredElementId,
          };
        });
        if (nextValue && options?.source !== 'drag' && effectiveWallId === id) {
          attributeChangeObserver.notify({
            entity: 'wall',
            entityId: effectiveWallId,
            previousValue,
            nextValue,
            source: options?.source ?? 'ui',
            timestamp: Date.now(),
          });
        }
        if (!options?.skipHistory) {
          get().saveToHistory('Update wall');
        }
        if (geometryChanged && !options?.skipRoomDetection) {
          get().detectRooms({ debounce: options?.source === 'drag' });
        }
        if (elevationChanged && !options?.skipElevationRegeneration) {
          get().regenerateElevations({ debounce: options?.source === 'drag' });
        }
      },

      updateWalls: (updates, options) => {
        if (!updates.length) {
          return;
        }

        const mergedUpdates = new Map<string, Partial<Wall>>();
        const preferredRetainedIds = new Set<string>();
        updates.forEach(({ id, updates: nextUpdates }) => {
          const existing = mergedUpdates.get(id) ?? {};
          const safeUpdates = nextUpdates.thickness !== undefined
            ? { ...nextUpdates, thickness: clampThickness(nextUpdates.thickness) }
            : nextUpdates;
          preferredRetainedIds.add(id);
          mergedUpdates.set(id, {
            ...existing,
            ...safeUpdates,
            startBevel: safeUpdates.startBevel ?? existing.startBevel,
            endBevel: safeUpdates.endBevel ?? existing.endBevel,
          });
        });

        let geometryChanged = false;
        let elevationChanged = false;
        const previousValues = new Map<string, Wall3D>();

        set((state) => {
          let nextWalls = state.walls.map((wall) => {
            const wallUpdates = mergedUpdates.get(wall.id);
            if (!wallUpdates) {
              return wall;
            }

            previousValues.set(wall.id, wall.properties3D);
            const updatedWall = normalizeWallBevel({
              ...wall,
              ...wallUpdates,
              startBevel: wallUpdates.startBevel ?? wall.startBevel,
              endBevel: wallUpdates.endBevel ?? wall.endBevel,
            });

            const wallGeometryChanged = Boolean(
              wallUpdates.startPoint ||
              wallUpdates.endPoint ||
              wallUpdates.thickness !== undefined ||
              wallUpdates.openings
            );
            const wallElevationChanged = Boolean(
              wallGeometryChanged ||
              wallUpdates.material !== undefined ||
              wallUpdates.layer !== undefined
            );

            geometryChanged = geometryChanged || wallGeometryChanged;
            elevationChanged = elevationChanged || wallElevationChanged;

            const reboundWall = bindWallAttributes(
              wallGeometryChanged ? rebuildWallGeometry(updatedWall) : updatedWall,
              updatedWall.properties3D
            );
            return reboundWall;
          });

          if (geometryChanged && options?.source !== 'drag') {
            mergedUpdates.forEach((_wallUpdates, wallId) => {
              nextWalls = cleanupStraightWallRuns(nextWalls, wallId);
            });
          }

          const collapsed = geometryChanged
            ? collapseCoincidentWallOverlaps({
              walls: nextWalls,
              rooms: state.rooms,
              dimensions: state.dimensions,
              selectedElementIds: state.selectedElementIds,
              selectedIds: state.selectedIds,
              hoveredElementId: state.hoveredElementId,
              preferredRetainedIds,
            })
            : {
              walls: nextWalls,
              rooms: state.rooms,
              dimensions: state.dimensions,
              selectedElementIds: state.selectedElementIds,
              selectedIds: state.selectedIds,
              hoveredElementId: state.hoveredElementId,
              replacementMap: new Map<string, string>(),
            };

          return {
            walls: collapsed.walls,
            rooms: collapsed.rooms,
            dimensions: collapsed.dimensions,
            selectedElementIds: collapsed.selectedElementIds,
            selectedIds: collapsed.selectedIds,
            hoveredElementId: collapsed.hoveredElementId,
          };
        });

        if (options?.source !== 'drag') {
          const currentWalls = get().walls;
          mergedUpdates.forEach((_wallUpdates, wallId) => {
            const nextWall = currentWalls.find((wall) => wall.id === wallId);
            const previousValue = previousValues.get(wallId);
            if (nextWall && previousValue) {
              attributeChangeObserver.notify({
                entity: 'wall',
                entityId: wallId,
                previousValue,
                nextValue: nextWall.properties3D,
                source: options?.source ?? 'ui',
                timestamp: Date.now(),
              });
            }
          });
        }

        if (!options?.skipHistory) {
          get().saveToHistory('Update walls');
        }
        if (geometryChanged && !options?.skipRoomDetection) {
          get().detectRooms({ debounce: options?.source === 'drag' });
        }
        if (elevationChanged && !options?.skipElevationRegeneration) {
          get().regenerateElevations({ debounce: options?.source === 'drag' });
        }
      },

      updateWallBevel: (wallId, end, bevel, options) => {
        const walls = get().walls;
        const targetWall = walls.find((wall) => wall.id === wallId);
        if (!targetWall) return;

        const corner = computeCornerBevelDotsForEndpoint(targetWall, end, walls, 2);
        const fallbackMax = wallLengthMm(targetWall.startPoint, targetWall.endPoint) / 2;
        const maxOffset = Math.max(0, corner?.maxOffset ?? fallbackMax);

        set((state) => ({
          walls: state.walls.map((wall) => {
            if (wall.id === wallId) {
              return applyWallEndpointBevel(wall, end, bevel, maxOffset);
            }
            if (corner && wall.id === corner.otherWallId) {
              return applyWallEndpointBevel(wall, corner.otherEnd, bevel, maxOffset);
            }
            return wall;
          }),
        }));

        if (!options?.skipHistory) {
          get().saveToHistory('Adjust wall bevel');
        }
        if (!options?.skipRoomDetection) {
          get().detectRooms({ debounce: options?.source === 'drag' });
        }
      },

      resetWallBevel: (wallId, end) => {
        get().updateWallBevel(
          wallId,
          end,
          {
            outerOffset: 0,
            innerOffset: 0,
          },
          {
            skipHistory: false,
            source: 'ui',
            skipRoomDetection: false,
          }
        );
      },

      getCornerBevelDots: (cornerPoint) => {
        const walls = get().walls;
        for (const wall of walls) {
          const startCorner = computeCornerBevelDotsForEndpoint(wall, 'start', walls, 2);
          if (startCorner && pointsNear(startCorner.cornerPoint, cornerPoint, 2)) {
            return {
              outerDotPosition: startCorner.outerDotPosition,
              innerDotPosition: startCorner.innerDotPosition,
              outerOffset: startCorner.outerOffset,
              innerOffset: startCorner.innerOffset,
            };
          }
          const endCorner = computeCornerBevelDotsForEndpoint(wall, 'end', walls, 2);
          if (endCorner && pointsNear(endCorner.cornerPoint, cornerPoint, 2)) {
            return {
              outerDotPosition: endCorner.outerDotPosition,
              innerDotPosition: endCorner.innerDotPosition,
              outerOffset: endCorner.outerOffset,
              innerOffset: endCorner.innerOffset,
            };
          }
        }
        return null;
      },

      updateWall3DAttributes: (id, updates) => {
        let previousValue: Wall3D | null = null;
        let nextValue: Wall3D | null = null;

        set((state) => {
          const nextWalls = state.walls.map((wall) => {
            if (wall.id !== id) return wall;
            previousValue = wall.properties3D;

            const merged = {
              ...wall.properties3D,
              ...updates,
            };
            const validation = validateWall3DAttributes(merged);
            const nextWall = bindWallAttributes(
              {
                ...wall,
                thickness: updates.materialId
                  ? getArchitecturalMaterial(updates.materialId)?.defaultThicknessMm ?? wall.thickness
                  : wall.thickness,
                material: updates.materialId
                  ? resolveWallMaterialFromLibrary(updates.materialId)
                  : wall.material,
                properties3D: validation.value,
              },
              validation.value
            );
            nextValue = nextWall.properties3D;
            return nextWall;
          });
          return { walls: nextWalls };
        });

        if (nextValue) {
          attributeChangeObserver.notify({
            entity: 'wall',
            entityId: id,
            previousValue,
            nextValue,
            source: 'ui',
            timestamp: Date.now(),
          });
        }
        get().regenerateElevations();
        get().saveToHistory('Update wall 3D attributes');
      },

      deleteWall: (id) => {
        const wallToDelete = get().walls.find((wall) => wall.id === id);
        if (!wallToDelete) return;
        const deletedWallIds = new Set([id]);

        set((state) => ({
          walls: state.walls
            .filter((w) => w.id !== id)
            .map((wall) => {
              const cleaned = normalizeWallBevel({
                ...wall,
                connectedWalls: wall.connectedWalls.filter((cid) => cid !== id),
              });
              const touchesStart = pointsNear(cleaned.startPoint, wallToDelete.startPoint, 2)
                || pointsNear(cleaned.startPoint, wallToDelete.endPoint, 2);
              const touchesEnd = pointsNear(cleaned.endPoint, wallToDelete.startPoint, 2)
                || pointsNear(cleaned.endPoint, wallToDelete.endPoint, 2);
              return {
                ...cleaned,
                startBevel: touchesStart ? { ...DEFAULT_BEVEL_CONTROL } : cleaned.startBevel,
                endBevel: touchesEnd ? { ...DEFAULT_BEVEL_CONTROL } : cleaned.endBevel,
              };
            }),
          rooms: state.rooms.map((room) => ({
            ...room,
            wallIds: room.wallIds.filter((wallId) => wallId !== id),
          })),
          dimensions: removeDimensionsLinkedToWallIds(state.dimensions, deletedWallIds),
        }));
        get().detectRooms();
        get().regenerateElevations();
        get().saveToHistory('Delete wall');
      },

      getWall: (id) => get().walls.find((w) => w.id === id),

      addRoom: (params) => {
        const room = createRoomModel(params);
        set((state) => ({
          rooms: [...state.rooms, room],
        }));
        attributeChangeObserver.notify({
          entity: 'room',
          entityId: room.id,
          previousValue: null,
          nextValue: room.properties3D,
          source: 'binding',
          timestamp: Date.now(),
        });
        get().saveToHistory('Add room');
        return room.id;
      },

      updateRoom: (id, updates) => {
        let previousValue: Room3D | null = null;
        let nextValue: Room3D | null = null;
        set((state) => ({
          rooms: state.rooms.map((room) => {
            if (room.id !== id) return room;
            previousValue = room.properties3D;
            const mergedRoom = {
              ...room,
              ...updates,
            };
            const reboundRoom = bindRoomAttributes(mergedRoom, mergedRoom.properties3D);
            nextValue = reboundRoom.properties3D;
            return reboundRoom;
          }),
        }));
        if (nextValue) {
          attributeChangeObserver.notify({
            entity: 'room',
            entityId: id,
            previousValue,
            nextValue,
            source: 'ui',
            timestamp: Date.now(),
          });
        }
        get().saveToHistory('Update room');
      },

      updateRoom3DAttributes: (id, updates) => {
        let previousValue: Room3D | null = null;
        let nextValue: Room3D | null = null;
        set((state) => ({
          rooms: state.rooms.map((room) => {
            if (room.id !== id) return room;
            previousValue = room.properties3D;
            const validation = validateRoom3DAttributes({
              ...room.properties3D,
              ...updates,
            });
            const reboundRoom = bindRoomAttributes(
              {
                ...room,
                properties3D: validation.value,
              },
              validation.value
            );
            nextValue = reboundRoom.properties3D;
            return reboundRoom;
          }),
        }));
        if (nextValue) {
          attributeChangeObserver.notify({
            entity: 'room',
            entityId: id,
            previousValue,
            nextValue,
            source: 'ui',
            timestamp: Date.now(),
          });
        }
        get().saveToHistory('Update room 3D attributes');
      },

      setHvacDesignConditions: (updates) => {
        set((state) => ({
          hvacDesignConditions: {
            ...state.hvacDesignConditions,
            ...updates,
            peakCoolingHour: updates.peakCoolingHour !== undefined
              ? clampValue(updates.peakCoolingHour, 0, 23)
              : state.hvacDesignConditions.peakCoolingHour,
            internalGainDiversityFactor: updates.internalGainDiversityFactor !== undefined
              ? clampValue(updates.internalGainDiversityFactor, 0, 1)
              : state.hvacDesignConditions.internalGainDiversityFactor,
            defaultWindowShgc: updates.defaultWindowShgc !== undefined
              ? clampValue(updates.defaultWindowShgc, 0, 1)
              : state.hvacDesignConditions.defaultWindowShgc,
            seasonalVariation: {
              ...state.hvacDesignConditions.seasonalVariation,
              ...(updates.seasonalVariation ?? {}),
            },
          },
        }));
      },

      applyRoomTemplateToSelectedRooms: (templateId) => {
        const template = DEFAULT_ROOM_HVAC_TEMPLATES.find((entry) => entry.id === templateId);
        if (!template) return;
        const selectedSet = new Set(get().selectedElementIds);
        let affectedCount = 0;

        set((state) => ({
          rooms: state.rooms.map((room) => {
            if (!selectedSet.has(room.id)) return room;
            affectedCount += 1;
            const areaM2 = room.area / 1_000_000;
            const occupancyFromDensity = template.occupantsPer10m2 > 0
              ? (areaM2 / 10) * template.occupantsPer10m2
              : 0;
            const occupantCount = Math.max(1, Math.round(Math.max(template.occupantsBase, occupancyFromDensity) * 10) / 10);
            const validation = validateRoom3DAttributes({
              ...room.properties3D,
              hvacTemplateId: template.id,
              occupantCount,
              occupancySchedule: template.schedule,
              lightingLoadWm2: template.lightingWm2,
              equipmentLoadWm2: template.equipmentWm2,
              requiresExhaust: template.requiresExhaust,
            });
            return bindRoomAttributes(
              {
                ...room,
                properties3D: validation.value,
              },
              validation.value
            );
          }),
        }));

        if (affectedCount > 0) {
          get().saveToHistory('Apply HVAC template');
          get().setProcessingStatus(`Applied template to ${affectedCount} room(s).`, false);
        }
      },

      deleteRoom: (id) => {
        const room = get().rooms.find((entry) => entry.id === id);
        set((state) => ({
          rooms: state.rooms.filter((room) => room.id !== id),
        }));
        if (room) {
          get().setProcessingStatus(`Removed room "${room.name}". Walls were kept.`, false);
        }
        get().saveToHistory('Delete room');
      },

      getRoom: (id) => get().rooms.find((room) => room.id === id),

      moveRoom: (id, delta, options) => {
        const room = get().rooms.find((entry) => entry.id === id);
        if (!room) return;
        const wallsById = new Map(get().walls.map((wall) => [wall.id, wall]));
        const updates: Array<{ id: string; updates: Partial<Wall> }> = [];
        room.wallIds.forEach((wallId) => {
          const wall = wallsById.get(wallId);
          if (!wall) return;
          updates.push({
            id: wallId,
            updates: {
              startPoint: {
                x: wall.startPoint.x + delta.x,
                y: wall.startPoint.y + delta.y,
              },
              endPoint: {
                x: wall.endPoint.x + delta.x,
                y: wall.endPoint.y + delta.y,
              },
            },
          });
        });

        if (updates.length > 0) {
          get().updateWalls(updates, {
            skipHistory: true,
            source: 'drag',
            // Defer expensive room recomputation to drag finalization.
            skipRoomDetection: options?.skipHistory ?? false,
            // Defer elevation regeneration to drag finalization.
            skipElevationRegeneration: options?.skipHistory ?? false,
          });
        }

        if (!options?.skipHistory) {
          get().detectRooms();
          get().regenerateElevations();
          get().saveToHistory('Move room');
        }
      },

      startWallDrawing: (startPoint) => {
        const { wallSettings, activeTool } = get();
        const partitionToolActive = isPartitionWallTool(activeTool);
        const previewThickness = partitionToolActive
          ? clampThickness(wallSettings.defaultPartitionThickness)
          : clampThickness(wallSettings.defaultThickness);
        const previewMaterial: WallMaterial = partitionToolActive
          ? 'partition'
          : wallSettings.defaultMaterial;
        set({
          wallDrawingState: {
            isDrawing: true,
            startPoint: { ...startPoint },
            currentPoint: { ...startPoint },
            chainMode: wallSettings.chainModeEnabled,
            previewThickness,
            previewMaterial,
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
        const { wallDrawingState, wallSettings, activeTool } = get();

        if (!wallDrawingState.isDrawing || !wallDrawingState.startPoint || !wallDrawingState.currentPoint) {
          return null;
        }

        const length = wallLengthMm(wallDrawingState.startPoint, wallDrawingState.currentPoint);
        if (length < MIN_WALL_LENGTH) {
          return null;
        }

        const partitionToolActive = isPartitionWallTool(activeTool);
        const partitionMode = wallSettings.partitionMode;
        const resolvedHeight = partitionToolActive
          ? resolvePartitionHeightMm(partitionMode, wallSettings.defaultHeight)
          : wallSettings.defaultHeight;

        // Create the wall
        const wallId = get().addWall({
          startPoint: wallDrawingState.startPoint,
          endPoint: wallDrawingState.currentPoint,
          thickness: partitionToolActive
            ? clampThickness(wallSettings.defaultPartitionThickness)
            : wallDrawingState.previewThickness,
          material: partitionToolActive ? 'partition' : wallDrawingState.previewMaterial,
          layer: partitionToolActive ? 'partition' : wallSettings.defaultLayer,
          partitionMode: partitionToolActive ? partitionMode : undefined,
          properties3D: {
            height: resolvedHeight,
            materialId: partitionToolActive
              ? getDefaultMaterialIdForWallMaterial('partition')
              : undefined,
          },
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
          set({
            wallDrawingState: { ...DEFAULT_WALL_DRAWING_STATE },
          });
        }

        return wallId;
      },

      cancelWallDrawing: () => {
        set({
          wallDrawingState: { ...DEFAULT_WALL_DRAWING_STATE },
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

      connectWalls: (wallId, otherWallId) => {
        if (wallId === otherWallId) return;
        let didChange = false;
        set((state) => {
          const wallIndex = state.walls.findIndex((wall) => wall.id === wallId);
          const otherWallIndex = state.walls.findIndex((wall) => wall.id === otherWallId);
          if (wallIndex < 0 || otherWallIndex < 0) {
            return state;
          }

          const wall = state.walls[wallIndex];
          const otherWall = state.walls[otherWallIndex];
          const wallHasOther = wall.connectedWalls.includes(otherWallId);
          const otherHasWall = otherWall.connectedWalls.includes(wallId);

          if (wallHasOther && otherHasWall) {
            return state;
          }

          const nextWalls = [...state.walls];
          didChange = true;

          if (!wallHasOther) {
            nextWalls[wallIndex] = {
              ...wall,
              connectedWalls: [...wall.connectedWalls, otherWallId],
            };
          }

          if (!otherHasWall) {
            const latestOther = nextWalls[otherWallIndex];
            nextWalls[otherWallIndex] = {
              ...latestOther,
              connectedWalls: [...latestOther.connectedWalls, wallId],
            };
          }

          return { walls: nextWalls };
        });
        if (didChange) {
          get().detectRooms({ debounce: true });
        }
      },

      disconnectWall: (wallId, otherWallId) => {
        let didChange = false;
        set((state) => {
          const nextWalls = state.walls.map((wall) => {
            if (wall.id !== wallId && wall.id !== otherWallId) {
              return wall;
            }

            const nextConnectedWalls = wall.connectedWalls.filter((id) => id !== wallId && id !== otherWallId);
            if (nextConnectedWalls.length === wall.connectedWalls.length) {
              return wall;
            }

            didChange = true;
            return {
              ...wall,
              connectedWalls: nextConnectedWalls,
            };
          });

          return didChange ? { walls: nextWalls } : state;
        });
        if (didChange) {
          get().detectRooms({ debounce: true });
        }
      },

      setWallSettings: (settings) => {
        const safeSettings = { ...settings };
        if (safeSettings.defaultThickness !== undefined) {
          safeSettings.defaultThickness = clampThickness(safeSettings.defaultThickness);
        }
        if (safeSettings.defaultPartitionThickness !== undefined) {
          safeSettings.defaultPartitionThickness = clampThickness(safeSettings.defaultPartitionThickness);
        }
        if (safeSettings.defaultHeight !== undefined) {
          safeSettings.defaultHeight = clampValue(
            safeSettings.defaultHeight,
            MIN_WALL_HEIGHT,
            MAX_WALL_HEIGHT
          );
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

      createRoomWalls: (config, startCorner) => {
        const { width, height, wallThickness, material } = config;
        const layer = material === 'partition' ? 'partition' : 'structural';

        const corners: Point2D[] = [
          startCorner,
          { x: startCorner.x + width, y: startCorner.y },
          { x: startCorner.x + width, y: startCorner.y + height },
          { x: startCorner.x, y: startCorner.y + height },
        ];

        const wallIds: string[] = [];
        for (let i = 0; i < 4; i++) {
          const start = corners[i];
          const end = corners[(i + 1) % 4];
          const wallId = get().addWall({
            startPoint: start,
            endPoint: end,
            thickness: wallThickness,
            material,
            layer,
          });
          wallIds.push(wallId);
        }

        for (let i = 0; i < 4; i++) {
          get().connectWalls(wallIds[i], wallIds[(i + 1) % 4]);
        }

        return wallIds;
      },

      deleteWalls: (ids) => {
        const idsSet = new Set(ids);
        const deletedWalls = get().walls.filter((wall) => idsSet.has(wall.id));
        set((state) => ({
          walls: state.walls
            .filter((w) => !idsSet.has(w.id))
            .map((wall) => {
              const cleaned = normalizeWallBevel({
                ...wall,
                connectedWalls: wall.connectedWalls.filter((cid) => !idsSet.has(cid)),
              });
              const touchesStart = deletedWalls.some(
                (deleted) =>
                  pointsNear(cleaned.startPoint, deleted.startPoint, 2)
                  || pointsNear(cleaned.startPoint, deleted.endPoint, 2)
              );
              const touchesEnd = deletedWalls.some(
                (deleted) =>
                  pointsNear(cleaned.endPoint, deleted.startPoint, 2)
                  || pointsNear(cleaned.endPoint, deleted.endPoint, 2)
              );
              return {
                ...cleaned,
                startBevel: touchesStart ? { ...DEFAULT_BEVEL_CONTROL } : cleaned.startBevel,
                endBevel: touchesEnd ? { ...DEFAULT_BEVEL_CONTROL } : cleaned.endBevel,
              };
            }),
          rooms: state.rooms.map((room) => ({
            ...room,
            wallIds: room.wallIds.filter((wallId) => !idsSet.has(wallId)),
          })),
          dimensions: removeDimensionsLinkedToWallIds(state.dimensions, idsSet),
        }));
        get().detectRooms();
        get().regenerateElevations();
        get().saveToHistory('Delete walls');
      },

      clearAllWalls: () => {
        set({ walls: [], rooms: [] });
        lastRoomTopologyHash = '';
        get().regenerateElevations();
        get().saveToHistory('Clear all walls');
      },

      addHvacElement: (element) => {
        const nextElement = normalizeHvacElement(element);
        set((state) => ({
          hvacElements: [...state.hvacElements, nextElement],
        }));
        get().regenerateElevations({ debounce: true });
        get().saveToHistory('Add AC equipment');
        return nextElement.id;
      },

      addHvacElements: (elements) => {
        const nextElements = elements.map((element) => normalizeHvacElement(element));
        if (nextElements.length === 0) {
          return [];
        }
        set((state) => ({
          hvacElements: [...state.hvacElements, ...nextElements],
        }));
        get().regenerateElevations({ debounce: true });
        get().saveToHistory(nextElements.length > 1 ? 'Add refrigerant pipes' : 'Add AC equipment');
        return nextElements.map((element) => element.id);
      },

      updateHvacElement: (id, updates, options) => {
        let changed = false;
        set((state) => ({
          hvacElements: state.hvacElements.map((element) => {
            if (element.id !== id) {
              return element;
            }
            const nextElement = normalizeHvacElement({
              ...element,
              ...updates,
              id: element.id,
              type: updates.type ?? element.type,
              position: updates.position ?? element.position,
              width: updates.width ?? element.width,
              depth: updates.depth ?? element.depth,
              height: updates.height ?? element.height,
              elevation: updates.elevation ?? element.elevation,
              mountType: updates.mountType ?? element.mountType,
              label: updates.label ?? element.label,
              properties: updates.properties
                ? { ...element.properties, ...updates.properties }
                : element.properties,
            });
            changed =
              changed ||
              JSON.stringify(nextElement) !== JSON.stringify(element);
            return nextElement;
          }),
        }));
        if (!changed) {
          return;
        }
        get().regenerateElevations({ debounce: true });
        if (!options?.skipHistory) {
          get().saveToHistory('Update AC equipment');
        }
      },

      deleteHvacElement: (id, options) => {
        const exists = get().hvacElements.some((element) => element.id === id);
        if (!exists) {
          return;
        }
        set((state) => ({
          hvacElements: state.hvacElements.filter((element) => element.id !== id),
          selectedElementIds: state.selectedElementIds.filter((selectedId) => selectedId !== id),
          selectedIds: state.selectedIds.filter((selectedId) => selectedId !== id),
          hoveredElementId: state.hoveredElementId === id ? null : state.hoveredElementId,
        }));
        get().regenerateElevations({ debounce: true });
        if (!options?.skipHistory) {
          get().saveToHistory('Delete AC equipment');
        }
      },

      duplicateHvacElement: (id) => {
        const existing = get().hvacElements.find((element) => element.id === id);
        if (!existing) {
          return null;
        }
        const duplicateOffset = { x: 200, y: 200 };
        const clone = normalizeHvacElement({
          ...existing,
          id: generateId(),
          label: `${existing.label} Copy`,
          position: {
            x: existing.position.x + duplicateOffset.x,
            y: existing.position.y + duplicateOffset.y,
          },
          properties: isRefrigerantPipeElementType(existing.type)
            ? translateRefrigerantPipeElementProperties(existing.type, existing.properties, duplicateOffset)
            : existing.properties,
        });
        set((state) => ({
          hvacElements: [...state.hvacElements, clone],
          selectedElementIds: [clone.id],
          selectedIds: [clone.id],
        }));
        get().regenerateElevations({ debounce: true });
        get().saveToHistory('Duplicate AC equipment');
        return clone.id;
      },

      selectWallSegmentAtPoint: (wallId, point) => {
        const currentState = get();
        const sourceWall = currentState.walls.find((wall) => wall.id === wallId);
        if (!sourceWall) {
          return wallId;
        }

        const splitPoints = collectWallSelectionSplitPoints(sourceWall, currentState.walls);
        if (splitPoints.length <= 2) {
          return wallId;
        }

        const projected = projectPointToSegment(point, sourceWall.startPoint, sourceWall.endPoint);
        const selectedDistance = clampValue(
          projectDistanceAlongWall(projected.point, sourceWall),
          0,
          wallLengthMm(sourceWall.startPoint, sourceWall.endPoint)
        );
        const { descriptors, selectedWallId } = buildWallSplitDescriptors(
          sourceWall,
          splitPoints,
          selectedDistance
        );

        if (descriptors.length === 0) {
          return wallId;
        }

        set((state) => applySplitWallSelectionState(state, sourceWall, descriptors, selectedWallId));

        get().regenerateElevations({ debounce: true });
        return selectedWallId;
      },

      selectWallSegmentWithinInterval: (wallId, startPoint, endPoint) => {
        const currentState = get();
        const sourceWall = currentState.walls.find((wall) => wall.id === wallId);
        if (!sourceWall) {
          return wallId;
        }

        const projectedStart = projectPointToSegment(startPoint, sourceWall.startPoint, sourceWall.endPoint);
        const projectedEnd = projectPointToSegment(endPoint, sourceWall.startPoint, sourceWall.endPoint);
        const maxProjectionDistance = sourceWall.thickness / 2 + WALL_SEGMENT_SELECTION_TOLERANCE_MM;
        if (
          projectedStart.distance > maxProjectionDistance ||
          projectedEnd.distance > maxProjectionDistance
        ) {
          return wallId;
        }

        const splitPoints = collectWallSelectionSplitPoints(sourceWall, currentState.walls);
        addUniqueSplitPoint(splitPoints, projectedStart.point);
        addUniqueSplitPoint(splitPoints, projectedEnd.point);

        const midpoint = segmentMidpoint(projectedStart.point, projectedEnd.point);
        const intervalStartDistance = clampValue(
          projectDistanceAlongWall(projectedStart.point, sourceWall),
          0,
          wallLengthMm(sourceWall.startPoint, sourceWall.endPoint)
        );
        const intervalEndDistance = clampValue(
          projectDistanceAlongWall(projectedEnd.point, sourceWall),
          0,
          wallLengthMm(sourceWall.startPoint, sourceWall.endPoint)
        );
        const intervalMin = Math.min(intervalStartDistance, intervalEndDistance);
        const intervalMax = Math.max(intervalStartDistance, intervalEndDistance);
        const selectedDistance = clampValue(
          projectDistanceAlongWall(midpoint, sourceWall),
          0,
          wallLengthMm(sourceWall.startPoint, sourceWall.endPoint)
        );
        const { descriptors, selectedWallId } = buildWallSplitDescriptors(
          sourceWall,
          splitPoints,
          selectedDistance
        );

        if (descriptors.length === 0) {
          return wallId;
        }

        const selectedDescriptor = descriptors.find((descriptor) => (
          descriptor.startDistance <= intervalMin + WALL_SEGMENT_SELECTION_TOLERANCE_MM &&
          descriptor.endDistance >= intervalMax - WALL_SEGMENT_SELECTION_TOLERANCE_MM
        ));
        const effectiveSelectedWallId = selectedDescriptor?.wall.id ?? selectedWallId;

        set((state) => applySplitWallSelectionState(state, sourceWall, descriptors, effectiveSelectedWallId));

        get().regenerateElevations({ debounce: true });
        return effectiveSelectedWallId;
      },

      resolveRoomPerimeterWallSegments: (roomIds) => {
        const resolvedWallIds = new Set<string>();

        roomIds.forEach((roomId) => {
          const liveRoom = get().rooms.find((room) => room.id === roomId);
          if (!liveRoom || liveRoom.vertices.length < 2) {
            return;
          }

          for (let index = 0; index < liveRoom.vertices.length; index += 1) {
            const edgeStart = liveRoom.vertices[index];
            const edgeEnd = liveRoom.vertices[(index + 1) % liveRoom.vertices.length];
            if (!edgeStart || !edgeEnd) {
              continue;
            }

            let subEdgePoints = collectRoomBoundarySplitPoints(edgeStart, edgeEnd, get().walls);
            for (let subIndex = 0; subIndex < subEdgePoints.length - 1; subIndex += 1) {
              const subStart = subEdgePoints[subIndex];
              const subEnd = subEdgePoints[subIndex + 1];
              if (wallLengthMm(subStart, subEnd) < MIN_WALL_LENGTH) {
                continue;
              }

              const currentState = get();
              const currentRoom = currentState.rooms.find((room) => room.id === roomId) ?? liveRoom;
              const boundaryWall = findWallForRoomBoundarySubEdge(
                subStart,
                subEnd,
                currentState.walls,
                new Set(currentRoom.wallIds)
              );
              if (!boundaryWall) {
                continue;
              }

              const selectedWallId = get().selectWallSegmentWithinInterval(
                boundaryWall.id,
                subStart,
                subEnd
              );
              resolvedWallIds.add(selectedWallId);

              subEdgePoints = collectRoomBoundarySplitPoints(edgeStart, edgeEnd, get().walls);
            }
          }
        });

        return Array.from(resolvedWallIds);
      },

      // Selection Actions
      selectElement: (id, addToSelection = false) => set((state) => ({
        selectedElementIds: addToSelection
          ? [...state.selectedElementIds, id]
          : [id],
        selectedIds: addToSelection
          ? [...state.selectedElementIds, id]
          : [id],
      })),

      deselectElement: (id) => set((state) => ({
        selectedElementIds: state.selectedElementIds.filter((eid) => eid !== id),
        selectedIds: state.selectedElementIds.filter((eid) => eid !== id),
      })),

      clearSelection: () => set({ selectedElementIds: [], selectedIds: [] }),

      selectAll: () => set((state) => ({
        selectedElementIds: [
          ...state.dimensions.map((d) => d.id),
          ...state.annotations.map((a) => a.id),
          ...state.sketches.map((s) => s.id),
          ...state.symbols.map((s) => s.id),
          ...state.hvacElements.map((element) => element.id),
          ...state.walls.map((w) => w.id),
          ...state.rooms.map((room) => room.id),
          ...state.sectionLines.map((line) => line.id),
        ],
        selectedIds: [
          ...state.dimensions.map((d) => d.id),
          ...state.annotations.map((a) => a.id),
          ...state.sketches.map((s) => s.id),
          ...state.symbols.map((s) => s.id),
          ...state.hvacElements.map((element) => element.id),
          ...state.walls.map((w) => w.id),
          ...state.rooms.map((room) => room.id),
          ...state.sectionLines.map((line) => line.id),
        ],
      })),

      setHoveredElement: (id) => set((state) => (
        state.hoveredElementId === id
          ? state
          : { hoveredElementId: id }
      )),

      deleteSelectedElements: () => {
        const {
          selectedElementIds,
          dimensions,
          annotations,
          sketches,
          symbols,
          hvacElements,
          walls,
          rooms,
          sectionLines,
          elevationViews,
          activeElevationViewId,
        } = get();
        const selectedSet = new Set(selectedElementIds);
        const selectedRoomCount = rooms.filter((room) => selectedSet.has(room.id)).length;
        const selectedWallCount = walls.filter((wall) => selectedSet.has(wall.id)).length;
        const removedSymbolIds = new Set(
          symbols.filter((symbol) => selectedSet.has(symbol.id)).map((symbol) => symbol.id)
        );
        const removedWallIds = new Set(
          walls.filter((wall) => selectedSet.has(wall.id)).map((wall) => wall.id)
        );
        const roomsAtRisk = rooms.filter((room) =>
          room.wallIds.some((wallId) => selectedSet.has(wallId))
        );
        const brokenRoomNames = roomsAtRisk
          .filter((room) => room.wallIds.filter((wallId) => !selectedSet.has(wallId)).length < 3)
          .map((room) => room.name);
        const nextSectionLines = sectionLines.filter((line) => !selectedSet.has(line.id));
        const removedSectionIds = new Set(
          sectionLines
            .filter((line) => selectedSet.has(line.id))
            .map((line) => line.id)
        );
        const nextElevationViews = elevationViews.filter(
          (view) => !selectedSet.has(view.id) && (!view.sectionLineId || !removedSectionIds.has(view.sectionLineId))
        );
        const nextActiveElevationViewId =
          activeElevationViewId && nextElevationViews.some((view) => view.id === activeElevationViewId)
            ? activeElevationViewId
            : nextElevationViews[0]?.id ?? null;
        const nextWalls = removeOpeningsLinkedToSymbols(
          walls
            .filter((w) => !selectedSet.has(w.id))
            .map((wall) => ({
              ...wall,
              connectedWalls: wall.connectedWalls.filter((cid) => !selectedSet.has(cid)),
            })),
          removedSymbolIds
        );

        set({
          dimensions: removeDimensionsLinkedToWallIds(
            dimensions.filter((d) => !selectedSet.has(d.id)),
            removedWallIds
          ),
          annotations: annotations.filter((a) => !selectedSet.has(a.id)),
          sketches: sketches.filter((s) => !selectedSet.has(s.id)),
          symbols: symbols.filter((s) => !selectedSet.has(s.id)),
          hvacElements: hvacElements.filter((element) => !selectedSet.has(element.id)),
          walls: nextWalls,
          rooms: rooms
            .filter((room) => !selectedSet.has(room.id))
            .map((room) => ({
              ...room,
              wallIds: room.wallIds.filter((wallId) => !selectedSet.has(wallId)),
            })),
          sectionLines: nextSectionLines,
          elevationViews: nextElevationViews,
          activeElevationViewId: nextActiveElevationViewId,
          selectedElementIds: [],
          selectedIds: [],
        });
        if (brokenRoomNames.length > 0) {
          get().setProcessingStatus(
            `Warning: room enclosure may be broken (${brokenRoomNames.join(', ')}).`,
            false
          );
        } else if (selectedRoomCount > 0 && selectedWallCount === 0) {
          get().setProcessingStatus(
            `Removed ${selectedRoomCount} room object(s); walls were kept.`,
            false
          );
        }
        get().detectRooms();
        get().regenerateElevations();
        get().saveToHistory('Delete selected');
      },

      // Alias methods for backward compatibility
      setSelectedIds: (ids) => set((state) => (
        stringArraysEqual(state.selectedElementIds, ids)
          ? state
          : { selectedElementIds: ids, selectedIds: ids }
      )),
      deleteSelected: () => get().deleteSelectedElements(),
      setTool: (tool) => set((state) => {
        const partitionToolActive = isPartitionWallTool(tool);
        return {
          activeTool: tool,
          tool,
          wallDrawingState: {
            ...state.wallDrawingState,
            previewThickness: partitionToolActive
              ? clampThickness(state.wallSettings.defaultPartitionThickness)
              : clampThickness(state.wallSettings.defaultThickness),
            previewMaterial: partitionToolActive ? 'partition' : state.wallSettings.defaultMaterial,
          },
        };
      }),
      loadData: (data) => {
        try {
          const normalized = typeof data === 'string' ? data : JSON.stringify(data);
          get().importFromJSON(normalized);
        } catch (error) {
          console.error('Failed to load drawing data:', error);
          get().setProcessingStatus('Failed to load drawing data.', false);
        }
      },
      exportData: () => get().exportToJSON(),

      // Tool Actions
      setActiveTool: (tool) => set((state) => {
        const partitionToolActive = isPartitionWallTool(tool);
        return {
          activeTool: tool,
          tool,
          wallDrawingState: {
            ...state.wallDrawingState,
            previewThickness: partitionToolActive
              ? clampThickness(state.wallSettings.defaultPartitionThickness)
              : clampThickness(state.wallSettings.defaultThickness),
            previewMaterial: partitionToolActive ? 'partition' : state.wallSettings.defaultMaterial,
          },
        };
      }),

      // View Actions
      setZoom: (zoom) => set((state) => {
        const nextZoom = Math.max(0.1, Math.min(10, zoom));
        return state.zoom === nextZoom ? state : { zoom: nextZoom };
      }),
      setPanOffset: (offset) => set((state) => (
        pointsEqual(state.panOffset, offset)
          ? state
          : { panOffset: offset }
      )),
      setViewTransform: (zoom, offset) =>
        set((state) => {
          const nextZoom = Math.max(0.1, Math.min(10, zoom));
          return state.zoom === nextZoom && pointsEqual(state.panOffset, offset)
            ? state
            : {
              zoom: nextZoom,
              panOffset: offset,
            };
        }),
      setDisplayUnit: (unit) => set({ displayUnit: unit }),
      setGridSize: (size) => set({ gridSize: size }),
      setSnapToGrid: (snap) => set({ snapToGrid: snap }),
      setShowGrid: (show) => set({ showGrid: show }),
      setShowRulers: (show) => set({ showRulers: show }),
      toggleRulers: () => set((state) => ({ showRulers: !state.showRulers })),
      setPageConfig: (config) => set((state) => ({
        pageConfig: { ...state.pageConfig, ...config }
      })),
      resetView: () => set({ zoom: 1, panOffset: { x: 0, y: 0 }, resetViewRequestId: Date.now() }),
      zoomToFit: () => set({ zoomToFitRequestId: Date.now() }),

      // Preview Actions
      setPreviewHeight: (height) => set({ previewHeight: height }),
      setShow3DPreview: (show) => set({ show3DPreview: show }),
      setAutoSync3D: (sync) => set({ autoSync3D: sync }),

      // Calibration Actions
      startCalibration: () => set({
        isCalibrating: true,
        calibrationStep: 1,
        activeTool: 'calibrate',
        tool: 'calibrate',
      }),

      addCalibrationPoint: (point) => set((state) => {
        if (!state.importedDrawing) return state;
        const points = state.importedDrawing.calibrationPoints || [];
        const newPoint = { id: generateId(), pixelPoint: point };
        return {
          importedDrawing: {
            ...state.importedDrawing,
            calibrationPoints: [...points, newPoint]
          },
          calibrationStep: state.calibrationStep + 1,
        };
      }),

      setCalibrationDistance: (distance) => set((state) => {
        if (!state.importedDrawing?.calibrationPoints ||
          state.importedDrawing.calibrationPoints.length < 2) {
          return state;
        }
        const [p1, p2] = state.importedDrawing.calibrationPoints;
        if (!p1 || !p2) {
          return state;
        }
        const pixelDistance = Math.sqrt(
          Math.pow(p2.pixelPoint.x - p1.pixelPoint.x, 2) +
          Math.pow(p2.pixelPoint.y - p1.pixelPoint.y, 2)
        );
        const scale = pixelDistance / distance;
        return {
          importedDrawing: { ...state.importedDrawing, scale },
          isCalibrating: false,
          calibrationStep: 0,
          activeTool: 'select',
          tool: 'select',
        };
      }),

      finishCalibration: () => set({
        isCalibrating: false,
        calibrationStep: 0,
        activeTool: 'select',
        tool: 'select',
      }),

      cancelCalibration: () => set((state) => ({
        isCalibrating: false,
        calibrationStep: 0,
        activeTool: 'select',
        tool: 'select',
        importedDrawing: state.importedDrawing
          ? { ...state.importedDrawing, calibrationPoints: [] }
          : null,
      })),

      // Layer Actions
      addLayer: (name) => {
        const id = generateId();
        set((state) => ({
          layers: [...state.layers, {
            id,
            name,
            visible: true,
            locked: false,
            opacity: 1,
            elements: []
          }],
        }));
        return id;
      },

      updateLayer: (id, data) => set((state) => ({
        layers: state.layers.map((l) => l.id === id ? { ...l, ...data } : l),
      })),

      deleteLayer: (id) => set((state) => ({
        layers: state.layers.filter((l) => l.id !== id),
        activeLayerId: state.activeLayerId === id ? 'default' : state.activeLayerId,
      })),

      setActiveLayer: (id) => set({ activeLayerId: id }),

      moveElementToLayer: (elementId, layerId) => set((state) => ({
        layers: state.layers.map((l) => ({
          ...l,
          elements: l.id === layerId
            ? [...l.elements.filter((e) => e !== elementId), elementId]
            : l.elements.filter((e) => e !== elementId),
        })),
      })),

      toggleLayerVisibility: (id) => set((state) => ({
        layers: state.layers.map((l) =>
          l.id === id ? { ...l, visible: !l.visible } : l
        ),
      })),

      toggleLayerLock: (id) => set((state) => ({
        layers: state.layers.map((l) =>
          l.id === id ? { ...l, locked: !l.locked } : l
        ),
      })),

      // History Actions
      saveToHistory: (action) => set((state) => {
        const previousSnapshot = state.history[state.historyIndex]?.snapshot;
        const snapshot = createHistorySnapshot(state, previousSnapshot);
        const entry = createHistoryEntry(action, snapshot);
        const newHistory = state.history.slice(0, state.historyIndex + 1);
        newHistory.push(entry);
        if (newHistory.length > 50) {
          newHistory.shift();
        }
        const nextHistoryIndex = newHistory.length - 1;
        return {
          history: newHistory,
          historyIndex: nextHistoryIndex,
          canUndo: nextHistoryIndex > 0,
          canRedo: nextHistoryIndex < newHistory.length - 1,
        };
      }),

      undo: () => set((state) => {
        if (state.historyIndex <= 0) return state;
        const prevEntry = state.history[state.historyIndex - 1];
        if (!prevEntry) return state;
        const nextHistoryIndex = state.historyIndex - 1;
        return {
          detectedElements: prevEntry.snapshot.detectedElements,
          dimensions: prevEntry.snapshot.dimensions,
          annotations: prevEntry.snapshot.annotations,
          sketches: prevEntry.snapshot.sketches,
          symbols: prevEntry.snapshot.symbols,
          hvacElements: prevEntry.snapshot.hvacElements ?? [],
          walls: prevEntry.snapshot.walls ?? [],
          rooms: prevEntry.snapshot.rooms ?? [],
          sectionLines: prevEntry.snapshot.sectionLines ?? [],
          elevationViews: prevEntry.snapshot.elevationViews ?? [],
          activeElevationViewId: prevEntry.snapshot.activeElevationViewId ?? null,
          historyIndex: nextHistoryIndex,
          canUndo: nextHistoryIndex > 0,
          canRedo: nextHistoryIndex < state.history.length - 1,
        };
      }),

      redo: () => set((state) => {
        if (state.historyIndex >= state.history.length - 1) return state;
        const nextEntry = state.history[state.historyIndex + 1];
        if (!nextEntry) return state;
        const nextHistoryIndex = state.historyIndex + 1;
        return {
          detectedElements: nextEntry.snapshot.detectedElements,
          dimensions: nextEntry.snapshot.dimensions,
          annotations: nextEntry.snapshot.annotations,
          sketches: nextEntry.snapshot.sketches,
          symbols: nextEntry.snapshot.symbols,
          hvacElements: nextEntry.snapshot.hvacElements ?? [],
          walls: nextEntry.snapshot.walls ?? [],
          rooms: nextEntry.snapshot.rooms ?? [],
          sectionLines: nextEntry.snapshot.sectionLines ?? [],
          elevationViews: nextEntry.snapshot.elevationViews ?? [],
          activeElevationViewId: nextEntry.snapshot.activeElevationViewId ?? null,
          historyIndex: nextHistoryIndex,
          canUndo: nextHistoryIndex > 0,
          canRedo: nextHistoryIndex < state.history.length - 1,
        };
      }),

      clearHistory: () => set((state) => ({
        history: [createHistoryEntry('Baseline', createHistorySnapshot(state, state.history[state.historyIndex]?.snapshot))],
        historyIndex: 0,
        canUndo: false,
        canRedo: false,
      })),

      // Export/Import Actions
      exportToJSON: () => {
        const {
          importedDrawing,
          dimensions,
          annotations,
          sketches,
          symbols,
          guides,
          hvacElements,
          walls,
          rooms,
          sectionLines,
          elevationViews,
          activeElevationViewId,
          elevationSettings,
          wallSettings,
          dimensionSettings,
          hvacDesignConditions,
          materialLibrary,
        } = get();

        const attributeEnvelope = createAttributeEnvelope(walls, rooms);
        return JSON.stringify({
          version: '1.0',
          attributeSchemaVersion: 1,
          dimensions,
          annotations,
          sketches,
          guides,
          symbols,
          hvacElements,
          walls,
          rooms,
          sectionLines,
          elevationViews,
          activeElevationViewId,
          elevationSettings,
          wallSettings,
          dimensionSettings,
          hvacDesignConditions,
          materialLibrary,
          attributeEnvelope,
          scale: importedDrawing?.scale || 100,
          exportedAt: new Date().toISOString(),
        }, null, 2);
      },

      importFromJSON: (json) => {
        try {
          const data = JSON.parse(json);
          const rawWalls = Array.isArray(data.walls) ? data.walls : [];
          const importedWalls: Wall[] = rawWalls.map((rawWall: Partial<Wall>) => {
            const baseWall: Wall = {
              id: rawWall.id ?? generateId(),
              startPoint: rawWall.startPoint ?? { x: 0, y: 0 },
              endPoint: rawWall.endPoint ?? { x: 0, y: 0 },
              thickness: clampThickness(rawWall.thickness ?? 150),
              centerlineOffset: rawWall.centerlineOffset ?? 0,
              material: rawWall.material ?? 'partition',
              layer: rawWall.layer ?? 'partition',
              partitionMode: rawWall.partitionMode === 'half' || rawWall.partitionMode === 'top'
                ? rawWall.partitionMode
                : rawWall.partitionMode === 'full'
                  ? 'full'
                  : undefined,
              interiorLine: rawWall.interiorLine ?? { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } },
              exteriorLine: rawWall.exteriorLine ?? { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } },
              startBevel: normalizeBevelControl(rawWall.startBevel),
              endBevel: normalizeBevelControl(rawWall.endBevel),
              connectedWalls: Array.isArray(rawWall.connectedWalls) ? rawWall.connectedWalls : [],
              openings: Array.isArray(rawWall.openings) ? rawWall.openings : [],
              properties3D: rawWall.properties3D ?? { ...DEFAULT_WALL_3D },
            };
            const rebuilt = rebuildWallGeometry(baseWall);
            return bindWallAttributes(rebuilt, rawWall.properties3D ?? undefined);
          });

          const rawRooms = Array.isArray(data.rooms) ? data.rooms : [];
          const importedRooms: Room[] = rawRooms.map((rawRoom: Partial<Room>) => {
            const fallbackVertices = Array.isArray(rawRoom.vertices) ? rawRoom.vertices : [];
            const fallbackHoles = Array.isArray(rawRoom.holes)
              ? rawRoom.holes.map((hole) => (Array.isArray(hole) ? hole : []))
              : [];
            const fallbackArea = typeof rawRoom.area === 'number'
              ? rawRoom.area
              : polygonArea(fallbackVertices, fallbackHoles);
            const baseRoom: Room = {
              id: rawRoom.id ?? generateId(),
              name: rawRoom.name ?? 'Room',
              roomType: rawRoom.roomType ?? inferRoomType(fallbackArea / 1_000_000),
              vertices: fallbackVertices,
              holes: fallbackHoles,
              wallIds: Array.isArray(rawRoom.wallIds) ? rawRoom.wallIds : [],
              area: fallbackArea,
              perimeter: typeof rawRoom.perimeter === 'number'
                ? rawRoom.perimeter
                : polygonPerimeter(fallbackVertices, fallbackHoles),
              centroid: rawRoom.centroid ?? polygonCentroid(fallbackVertices, fallbackHoles),
              finishes: rawRoom.finishes ?? '',
              notes: rawRoom.notes ?? '',
              fillColor: rawRoom.fillColor ?? roomTypeFillColor(rawRoom.roomType ?? inferRoomType(fallbackArea / 1_000_000)),
              showLabel: rawRoom.showLabel ?? true,
              adjacentRoomIds: Array.isArray(rawRoom.adjacentRoomIds) ? rawRoom.adjacentRoomIds : [],
              hasWindows: rawRoom.hasWindows ?? false,
              validationWarnings: Array.isArray(rawRoom.validationWarnings) ? rawRoom.validationWarnings : [],
              isExterior: rawRoom.isExterior ?? false,
              properties3D: rawRoom.properties3D ?? { ...DEFAULT_ROOM_3D },
            };
            return bindRoomAttributes(baseRoom, rawRoom.properties3D ?? undefined);
          });

          const rawSectionLines = Array.isArray(data.sectionLines) ? data.sectionLines : [];
          const importedSectionLines: SectionLine[] = rawSectionLines.map(
            (rawLine: Partial<SectionLine>, index: number) => {
              const fallbackLabel = sectionLabelForIndex(rawLine.kind ?? 'section', index + 1);
              return {
                id: rawLine.id ?? generateId(),
                label: rawLine.label ?? fallbackLabel,
                name: rawLine.name ?? rawLine.label ?? fallbackLabel,
                kind: rawLine.kind === 'elevation' ? 'elevation' : 'section',
                startPoint: rawLine.startPoint ?? { x: 0, y: 0 },
                endPoint: rawLine.endPoint ?? { x: 0, y: 0 },
                direction: rawLine.direction === -1 ? -1 : 1,
                color: rawLine.color ?? DEFAULT_SECTION_LINE_COLOR,
                depthMm: Math.max(100, rawLine.depthMm ?? DEFAULT_SECTION_LINE_DEPTH_MM),
                locked: rawLine.locked ?? false,
                showReferenceIndicators: rawLine.showReferenceIndicators ?? true,
              };
            }
          );

          const attributeHydration = deserializeAttributeEnvelope(
            data.attributeEnvelope,
            importedWalls,
            importedRooms
          );

          const nextWallSettings = {
            ...DEFAULT_WALL_SETTINGS,
            ...(typeof data.wallSettings === 'object' && data.wallSettings ? data.wallSettings : {}),
          } as WallSettings;
          nextWallSettings.defaultThickness = clampThickness(nextWallSettings.defaultThickness);
          nextWallSettings.defaultPartitionThickness = clampThickness(nextWallSettings.defaultPartitionThickness);
          nextWallSettings.defaultHeight = clampHeight(nextWallSettings.defaultHeight);
          nextWallSettings.partitionMode =
            nextWallSettings.partitionMode === 'half' ||
            nextWallSettings.partitionMode === 'top'
              ? nextWallSettings.partitionMode
              : 'full';
          nextWallSettings.defaultLayerCount = Math.max(1, Math.round(nextWallSettings.defaultLayerCount));
          nextWallSettings.gridSize = Math.max(1, nextWallSettings.gridSize);

          const nextMaterialLibrary = Array.isArray(data.materialLibrary) && data.materialLibrary.length > 0
            ? data.materialLibrary
            : [...DEFAULT_ARCHITECTURAL_MATERIALS];

          const nextDimensionSettings = {
            ...DEFAULT_DIMENSION_SETTINGS,
            ...(typeof data.dimensionSettings === 'object' && data.dimensionSettings ? data.dimensionSettings : {}),
          } as DimensionSettings;
          nextDimensionSettings.precision = nextDimensionSettings.precision === 0 || nextDimensionSettings.precision === 1 || nextDimensionSettings.precision === 2
            ? nextDimensionSettings.precision
            : DEFAULT_DIMENSION_SETTINGS.precision;
          nextDimensionSettings.defaultOffset = Math.max(20, nextDimensionSettings.defaultOffset);
          nextDimensionSettings.extensionGap = Math.max(0, nextDimensionSettings.extensionGap);
          nextDimensionSettings.extensionBeyond = Math.max(0, nextDimensionSettings.extensionBeyond);

          const nextHvacDesignConditions = {
            ...DEFAULT_HVAC_DESIGN_CONDITIONS,
            ...(typeof data.hvacDesignConditions === 'object' && data.hvacDesignConditions ? data.hvacDesignConditions : {}),
          } as HvacDesignConditions;
          nextHvacDesignConditions.peakCoolingHour = clampValue(nextHvacDesignConditions.peakCoolingHour, 0, 23);
          nextHvacDesignConditions.internalGainDiversityFactor = clampValue(nextHvacDesignConditions.internalGainDiversityFactor, 0, 1);
          nextHvacDesignConditions.defaultWindowShgc = clampValue(nextHvacDesignConditions.defaultWindowShgc, 0, 1);
          nextHvacDesignConditions.seasonalVariation = {
            summerAdjustment: Number.isFinite(nextHvacDesignConditions.seasonalVariation?.summerAdjustment)
              ? nextHvacDesignConditions.seasonalVariation.summerAdjustment
              : DEFAULT_HVAC_DESIGN_CONDITIONS.seasonalVariation.summerAdjustment,
            winterAdjustment: Number.isFinite(nextHvacDesignConditions.seasonalVariation?.winterAdjustment)
              ? nextHvacDesignConditions.seasonalVariation.winterAdjustment
              : DEFAULT_HVAC_DESIGN_CONDITIONS.seasonalVariation.winterAdjustment,
          };

          const nextElevationSettings = {
            ...DEFAULT_ELEVATION_SETTINGS,
            ...(typeof data.elevationSettings === 'object' && data.elevationSettings ? data.elevationSettings : {}),
          } as ElevationSettings;
          nextElevationSettings.defaultGridIncrementMm = Math.max(100, nextElevationSettings.defaultGridIncrementMm);
          nextElevationSettings.defaultScale = Math.max(1, nextElevationSettings.defaultScale);
          nextElevationSettings.sunAngleDeg = clampValue(nextElevationSettings.sunAngleDeg, 0, 360);

          const importedElevationViews = Array.isArray(data.elevationViews)
            ? data.elevationViews as ElevationView[]
            : [];
          const importedActiveElevationViewId =
            typeof data.activeElevationViewId === 'string'
              ? data.activeElevationViewId
              : null;
          const importedHvacElements = Array.isArray(data.hvacElements)
            ? data.hvacElements.map((rawElement: Partial<HvacElement>) => normalizeHvacElement({
              type: rawElement.type ?? 'ducted-ac',
              position: rawElement.position ?? { x: 0, y: 0 },
              width: typeof rawElement.width === 'number' && Number.isFinite(rawElement.width) ? rawElement.width : 1000,
              depth: typeof rawElement.depth === 'number' && Number.isFinite(rawElement.depth) ? rawElement.depth : 600,
              height: typeof rawElement.height === 'number' && Number.isFinite(rawElement.height) ? rawElement.height : 300,
              elevation: typeof rawElement.elevation === 'number' && Number.isFinite(rawElement.elevation) ? rawElement.elevation : 0,
              mountType: rawElement.mountType ?? 'ceiling',
              label: rawElement.label ?? rawElement.modelLabel ?? rawElement.type ?? 'AC equipment',
              ...rawElement,
            }))
            : [];

          set({
            dimensions: Array.isArray(data.dimensions)
              ? data.dimensions.map((dimension: Omit<Dimension2D, 'id'> & { id: string }) => ({
                ...normalizeDimensionPayload(dimension, nextDimensionSettings),
                id: dimension.id ?? generateId(),
              }))
              : [],
            dimensionSettings: nextDimensionSettings,
            annotations: data.annotations || [],
            sketches: data.sketches || [],
            guides: data.guides || [],
            symbols: data.symbols || [],
            hvacElements: importedHvacElements,
            walls: attributeHydration.walls,
            rooms: attributeHydration.rooms,
            sectionLines: importedSectionLines,
            elevationViews: importedElevationViews,
            activeElevationViewId: importedActiveElevationViewId,
            elevationSettings: nextElevationSettings,
            sectionLineDrawingState: { ...DEFAULT_SECTION_LINE_DRAWING_STATE },
            wallSettings: nextWallSettings,
            hvacDesignConditions: nextHvacDesignConditions,
            materialLibrary: nextMaterialLibrary,
          });
          lastRoomTopologyHash = '';
          get().detectRooms();
          get().regenerateElevations();
          importedSectionLines.forEach((line) => {
            get().generateElevationForSection(line.id);
          });
          if (
            importedActiveElevationViewId &&
            get().elevationViews.some((view) => view.id === importedActiveElevationViewId)
          ) {
            get().setActiveElevationView(importedActiveElevationViewId);
          }
          if (attributeHydration.warnings.length > 0) {
            console.warn('Attribute hydration warnings', attributeHydration.warnings);
          }
          get().setProcessingStatus('Imported drawing JSON.', false);
        } catch (error) {
          console.error('Failed to import JSON:', error);
          get().setProcessingStatus('Failed to import drawing JSON.', false);
        }
      },

      // Spline Actions
      setSplineSettings: (settings) => set((state) => ({
        splineSettings: { ...state.splineSettings, ...settings },
      })),

      setSplineEditMode: (mode) => set({ splineEditMode: mode }),

      setEditingSpline: (id) => set({ editingSplineId: id }),

      addSplineControlPoint: (sketchId, point, index) => {
        set((state) => ({
          sketches: state.sketches.map((s) => {
            if (s.id !== sketchId || s.type !== 'spline') return s;
            const newPoints = [...s.points];
            if (index !== undefined && index >= 0 && index <= newPoints.length) {
              newPoints.splice(index, 0, point);
            } else {
              newPoints.push(point);
            }
            return { ...s, points: newPoints };
          }),
        }));
        get().saveToHistory('Add spline point');
      },

      updateSplineControlPoint: (sketchId, pointIndex, position) => {
        set((state) => ({
          sketches: state.sketches.map((s) => {
            if (s.id !== sketchId || s.type !== 'spline') return s;
            const newPoints = [...s.points];
            if (pointIndex >= 0 && pointIndex < newPoints.length) {
              newPoints[pointIndex] = position;
            }
            return { ...s, points: newPoints };
          }),
        }));
        get().saveToHistory('Move spline point');
      },

      removeSplineControlPoint: (sketchId, pointIndex) => {
        set((state) => ({
          sketches: state.sketches.map((s) => {
            if (s.id !== sketchId || s.type !== 'spline') return s;
            if (s.points.length <= 2) return s;
            const newPoints = s.points.filter((_, i) => i !== pointIndex);
            return { ...s, points: newPoints };
          }),
        }));
        get().saveToHistory('Remove spline point');
      },

      toggleSplineClosed: (sketchId) => {
        set((state) => ({
          sketches: state.sketches.map((s) => {
            if (s.id !== sketchId || s.type !== 'spline') return s;
            const currentSettings = s.splineSettings || DEFAULT_SPLINE_SETTINGS;
            return {
              ...s,
              closed: !currentSettings.closed,
              splineSettings: { ...currentSettings, closed: !currentSettings.closed },
            };
          }),
        }));
        get().saveToHistory('Toggle spline closed');
      },

      convertSplineMethod: (sketchId, method) => {
        set((state) => ({
          sketches: state.sketches.map((s) => {
            if (s.id !== sketchId || s.type !== 'spline') return s;
            const currentSettings = s.splineSettings || DEFAULT_SPLINE_SETTINGS;
            return {
              ...s,
              splineSettings: { ...currentSettings, method },
            };
          }),
        }));
        get().saveToHistory('Change spline method');
      },
    }),
    { name: 'smart-drawing-store' }
  )
);

// Alias for backwards compatibility
export const useSmartDrawingStore = useDrawingStore;
export type SmartDrawingState = DrawingState;

export default useDrawingStore;
export {
  useRoomStore,
  getRoomWallIds,
  getRoomHoles,
  getArchivedRoom,
  type RoomStore,
} from './roomStore';

