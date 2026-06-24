import type { HvacElement, Point2D } from '../../../types';

import {
  buildCeilingCassetteModel,
  getCeilingCassettePipePortEndpointLocal,
} from './ceilingCassetteModel';
import {
  normalizeBypasses,
  translateBypasses,
  type PipeBypass,
} from './pipeBypass';
import {
  DEFAULT_PIPE_ROUTING_ELEVATION_MM,
  getActivePipeRoutingSettings,
} from './pipeRoutingSettings';
import {
  buildRefrigerantBranchKitViewModel,
  isRefrigerantBranchKitElement,
  resolveRefrigerantBranchKitConnectionIdentity,
  resolveRefrigerantBranchKitInlineAnchorLocal,
  resolveRefrigerantBranchKitLineSelection,
  type RefrigerantBranchLineKind,
  type RefrigerantBranchTerminalRole,
} from './refrigerantBranchKitModel';
import {
  DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM,
  DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM,
  DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM,
  INCH_MM,
} from './refrigerantPipeDimensions';
import {
  getUnitPipePortEndpointLocal,
  getUnitPipePortSpec,
  GENERIC_PIPE_PORT_TYPES,
} from './unitPipePortModel';

export const ONE_INCH_MM = INCH_MM;
export const DEFAULT_REFRIGERANT_PIPE_INSULATION_THICKNESS_MM = ONE_INCH_MM;
export const DEFAULT_REFRIGERANT_PIPE_ELEVATION_MM = DEFAULT_PIPE_ROUTING_ELEVATION_MM;

/**
 * Active intra-pair gas/liquid clear gap (mm). Reads the document's configurable
 * {@link PipeRoutingSettings.defaultPipeGapMm} (defaults to 1" = 25.4 mm) so a
 * spacing change recomputes geometry the same way a property edit would.
 */
function resolvedPipeGapMm(): number {
  return getActivePipeRoutingSettings().defaultPipeGapMm;
}

/** Active fallback pipe centerline elevation (mm), configurable via settings. */
function resolvedPipeElevationMm(): number {
  return getActivePipeRoutingSettings().defaultPipeElevationMm;
}
const PIPE_CENTERLINE_CONTINUITY_TOLERANCE_MM = 0.25;

export type RefrigerantPipeConnectionKind = 'unit-port' | 'field-pipe';

export interface RefrigerantPipeBundleConnection {
  point: Point2D;
  gasPoint: Point2D;
  liquidPoint: Point2D;
  gasFieldPoint: Point2D;
  liquidFieldPoint: Point2D;
  gasOuterDiameterMm?: number;
  liquidOuterDiameterMm?: number;
  gasDirection?: Point2D;
  liquidDirection?: Point2D;
  direction: Point2D;
  elevationMm: number;
  gasElevationMm: number;
  liquidElevationMm: number;
  connectionKind: RefrigerantPipeConnectionKind;
  guideReference?: 'gas' | 'liquid' | 'center';
  sourceElementId?: string;
  terminalRole?: RefrigerantBranchTerminalRole;
}

export interface RefrigerantPipeBundleSegmentConnection
  extends RefrigerantPipeBundleConnection {
  segmentStart: Point2D;
  segmentEnd: Point2D;
  segmentLengthMm: number;
  projectedDistanceMm: number;
}

export interface RefrigerantPipePairSpec {
  routePoints: Point2D[];
  gasPipeDiameterMm: number;
  liquidPipeDiameterMm: number;
  gasOuterDiameterMm: number;
  liquidOuterDiameterMm: number;
  insulationThicknessMm: number;
  pipeGapMm: number;
  startBundleConnection: RefrigerantPipeBundleConnection | null;
  endBundleConnection: RefrigerantPipeBundleConnection | null;
}

export interface RefrigerantPipePairVisualSpec extends RefrigerantPipePairSpec {
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
    center: Point2D;
  };
  gasOuterDiameterMm: number;
  liquidOuterDiameterMm: number;
  gasOuterRadiusMm: number;
  liquidOuterRadiusMm: number;
  gasCoreRadiusMm: number;
  liquidCoreRadiusMm: number;
  gasLocalZMm: number;
  liquidLocalZMm: number;
  centerSpacingMm: number;
  gasOuterPoints: Point2D[];
  liquidOuterPoints: Point2D[];
  gasContinuousOuterPoints: Point2D[];
  liquidContinuousOuterPoints: Point2D[];
  gasLocalOuterPoints: Point2D[];
  liquidLocalOuterPoints: Point2D[];
  gasLocalContinuousOuterPoints: Point2D[];
  liquidLocalContinuousOuterPoints: Point2D[];
  gasContinuousCorePoints: Point2D[];
  liquidContinuousCorePoints: Point2D[];
  gasLocalContinuousCorePoints: Point2D[];
  liquidLocalContinuousCorePoints: Point2D[];
  gasLocalStub: { start: Point2D; end: Point2D } | null;
  liquidLocalStub: { start: Point2D; end: Point2D } | null;
}

export type RefrigerantPipeLineKind = 'gas' | 'liquid';
export type RefrigerantPipeMaterial = 'hard' | 'flexible';

export interface RefrigerantPipeSegmentVisualSpec {
  index: number;
  material: RefrigerantPipeMaterial;
  invalidHardGeometry: boolean;
  points: Point2D[];
  localPoints: Point2D[];
  lengthMm: number;
}

export interface RefrigerantPipeConnection {
  portPoint: Point2D;
  direction: Point2D;
  elevationMm: number;
  connectionKind: RefrigerantPipeConnectionKind;
  sourceElementId?: string;
}

export interface RefrigerantPipeSpec {
  routePoints: Point2D[];
  pipeDiameterMm: number;
  outerDiameterMm: number;
  insulationThicknessMm: number;
  lineKind: RefrigerantPipeLineKind;
  segmentMaterials: RefrigerantPipeMaterial[];
  bundleId?: string;
  startConnection: RefrigerantPipeConnection | null;
  endConnection: RefrigerantPipeConnection | null;
  /** Z-type offset bypasses that clear clashes with existing pipes. */
  bypasses: PipeBypass[];
}

export interface RefrigerantPipeVisualSpec extends RefrigerantPipeSpec {
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
    center: Point2D;
  };
  outerRadiusMm: number;
  coreRadiusMm: number;
  localZMm: number;
  outerPoints: Point2D[];
  localOuterPoints: Point2D[];
  continuousOuterPoints: Point2D[];
  localContinuousOuterPoints: Point2D[];
  localStub: { start: Point2D; end: Point2D } | null;
  segmentVisuals: RefrigerantPipeSegmentVisualSpec[];
  invalidHardSegmentCount: number;
}

type HvacPipeSnapSource = Pick<HvacElement, 'id' | 'type' | 'position' | 'width' | 'depth' | 'height' | 'rotation' | 'elevation' | 'properties'>;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readNumber(value: unknown, fallback: number): number {
  if (isFiniteNumber(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const HARD_ZERO_LENGTH_TOLERANCE_MM = 0.5;
const HARD_DIAGONAL_TOLERANCE_MM = 1.5;
const HARD_AXIS_TOLERANCE_MM = 0.5;
const HARD_MIN_SEGMENT_MM = 28;

type HardDirection8 = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

function normalizePoint(value: unknown): Point2D | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as { x?: unknown; y?: unknown };
  const x = readNumber(candidate.x, Number.NaN);
  const y = readNumber(candidate.y, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return { x, y };
}

function normalizeDirection(point: Point2D): Point2D {
  const length = Math.hypot(point.x, point.y);
  if (length < 0.0001) {
    return { x: 1, y: 0 };
  }
  return { x: point.x / length, y: point.y / length };
}

function normalizePipeMaterial(
  value: unknown,
  fallback: RefrigerantPipeMaterial = 'flexible',
): RefrigerantPipeMaterial {
  if (value === 'hard' || value === 'flexible') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'hard' || normalized === 'flexible') {
      return normalized;
    }
  }
  return fallback;
}

function resolveDefaultSegmentMaterial(
  segmentIndex: number,
  segmentCount: number,
  startConnection: RefrigerantPipeConnection | null,
  endConnection: RefrigerantPipeConnection | null,
): RefrigerantPipeMaterial {
  if (segmentIndex === 0 && startConnection?.connectionKind === 'unit-port') {
    return 'hard';
  }
  if (
    segmentCount > 0 &&
    segmentIndex === segmentCount - 1 &&
    endConnection?.connectionKind === 'unit-port'
  ) {
    return 'hard';
  }
  return 'flexible';
}

function normalizeSegmentMaterialArray(
  value: unknown,
  segmentCount: number,
  options?: {
    startConnection?: RefrigerantPipeConnection | null;
    endConnection?: RefrigerantPipeConnection | null;
  },
): RefrigerantPipeMaterial[] {
  if (segmentCount <= 0) {
    return [];
  }
  const rawArray = Array.isArray(value) ? value : [];
  return Array.from({ length: segmentCount }, (_, index) =>
    normalizePipeMaterial(
      rawArray[index],
      resolveDefaultSegmentMaterial(
        index,
        segmentCount,
        options?.startConnection ?? null,
        options?.endConnection ?? null,
      ),
    ),
  );
}

function pointsNearlyEqual(a: Point2D, b: Point2D, tolerance = 0.01): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
}

function stripLeadingPointIfEqual(
  points: Point2D[],
  targetPoint: Point2D | null,
): Point2D[] {
  if (!targetPoint || points.length === 0) {
    return points;
  }
  if (!pointsNearlyEqual(points[0]!, targetPoint)) {
    return points;
  }
  return points.slice(1);
}

function polylineLength(points: Point2D[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(
      points[index]!.x - points[index - 1]!.x,
      points[index]!.y - points[index - 1]!.y,
    );
  }
  return total;
}

function hardDirection(start: Point2D, end: Point2D): HardDirection8 | null {
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

function chooseHardCorner(start: Point2D, end: Point2D): Point2D {
  const primary = { x: end.x, y: start.y };
  const secondary = { x: start.x, y: end.y };
  const primaryShort =
    Math.hypot(primary.x - start.x, primary.y - start.y) < HARD_MIN_SEGMENT_MM ||
    Math.hypot(end.x - primary.x, end.y - primary.y) < HARD_MIN_SEGMENT_MM;
  const secondaryShort =
    Math.hypot(secondary.x - start.x, secondary.y - start.y) < HARD_MIN_SEGMENT_MM ||
    Math.hypot(end.x - secondary.x, end.y - secondary.y) < HARD_MIN_SEGMENT_MM;
  if (!primaryShort) {
    return primary;
  }
  if (!secondaryShort) {
    return secondary;
  }
  return primary;
}

function buildHardSegmentRoute(
  start: Point2D,
  end: Point2D,
): { points: Point2D[]; invalidHardGeometry: boolean } {
  const incomingDirection = hardDirection(start, end);
  if (incomingDirection) {
    return {
      points: [start, end],
      invalidHardGeometry: false,
    };
  }
  const corner = chooseHardCorner(start, end);
  const firstDirection = hardDirection(start, corner);
  const secondDirection = hardDirection(corner, end);
  return {
    points: [start, corner, end],
    invalidHardGeometry: !firstDirection || !secondDirection,
  };
}

function normalizePointArray(value: unknown): Point2D[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const points = value
    .map((entry) => normalizePoint(entry))
    .filter((entry): entry is Point2D => Boolean(entry));
  return dedupeConsecutivePoints(points);
}

const BUNDLE_OVERLAP_REPAIR_TOLERANCE_MM = 0.5;

function repairDegenerateBundlePoints(options: {
  gasPoint: Point2D;
  liquidPoint: Point2D;
  gasFieldPoint: Point2D;
  liquidFieldPoint: Point2D;
  direction: Point2D;
  guideReference?: 'gas' | 'liquid' | 'center';
  gasOuterDiameterMm?: number;
  liquidOuterDiameterMm?: number;
}): {
  gasPoint: Point2D;
  liquidPoint: Point2D;
  gasFieldPoint: Point2D;
  liquidFieldPoint: Point2D;
} {
  const fieldSpacingMm = Math.hypot(
    options.liquidFieldPoint.x - options.gasFieldPoint.x,
    options.liquidFieldPoint.y - options.gasFieldPoint.y,
  );
  if (fieldSpacingMm > BUNDLE_OVERLAP_REPAIR_TOLERANCE_MM) {
    return {
      gasPoint: options.gasPoint,
      liquidPoint: options.liquidPoint,
      gasFieldPoint: options.gasFieldPoint,
      liquidFieldPoint: options.liquidFieldPoint,
    };
  }

  const normal = perpendicular(options.direction);
  const gasOuterDiameterMm =
    options.gasOuterDiameterMm ?? DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM;
  const liquidOuterDiameterMm =
    options.liquidOuterDiameterMm ?? DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM;
  const repairedSpacingMm =
    gasOuterDiameterMm / 2 +
    liquidOuterDiameterMm / 2 +
    resolvedPipeGapMm();
  const existingDelta = subtract(options.liquidPoint, options.gasPoint);
  const normalSign = Math.sign(dot(existingDelta, normal)) || 1;

  if (options.guideReference === 'gas') {
    const liquidPoint = add(
      options.gasPoint,
      scale(normal, repairedSpacingMm * normalSign),
    );
    const liquidFieldPoint = add(
      options.gasFieldPoint,
      scale(normal, repairedSpacingMm * normalSign),
    );
    return {
      gasPoint: options.gasPoint,
      liquidPoint,
      gasFieldPoint: options.gasFieldPoint,
      liquidFieldPoint,
    };
  }

  if (options.guideReference === 'liquid') {
    const gasPoint = add(
      options.liquidPoint,
      scale(normal, -repairedSpacingMm * normalSign),
    );
    const gasFieldPoint = add(
      options.liquidFieldPoint,
      scale(normal, -repairedSpacingMm * normalSign),
    );
    return {
      gasPoint,
      liquidPoint: options.liquidPoint,
      gasFieldPoint,
      liquidFieldPoint: options.liquidFieldPoint,
    };
  }

  const halfSpacing = repairedSpacingMm / 2;
  const portCenter = computeBundleCenter(options.gasPoint, options.liquidPoint);
  const fieldCenter = computeBundleCenter(options.gasFieldPoint, options.liquidFieldPoint);
  return {
    gasPoint: add(portCenter, scale(normal, -halfSpacing * normalSign)),
    liquidPoint: add(portCenter, scale(normal, halfSpacing * normalSign)),
    gasFieldPoint: add(fieldCenter, scale(normal, -halfSpacing * normalSign)),
    liquidFieldPoint: add(fieldCenter, scale(normal, halfSpacing * normalSign)),
  };
}

function normalizeBundleConnection(value: unknown): RefrigerantPipeBundleConnection | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as {
    point?: unknown;
    gasPoint?: unknown;
    liquidPoint?: unknown;
    gasFieldPoint?: unknown;
    liquidFieldPoint?: unknown;
    gasOuterDiameterMm?: unknown;
    liquidOuterDiameterMm?: unknown;
    gasDirection?: unknown;
    liquidDirection?: unknown;
    direction?: unknown;
    elevationMm?: unknown;
    gasElevationMm?: unknown;
    liquidElevationMm?: unknown;
    connectionKind?: unknown;
    guideReference?: unknown;
    sourceElementId?: unknown;
  };
  const point = normalizePoint(candidate.point);
  const gasPoint = normalizePoint(candidate.gasPoint);
  const liquidPoint = normalizePoint(candidate.liquidPoint);
  const gasFieldPoint = normalizePoint(candidate.gasFieldPoint) ?? gasPoint;
  const liquidFieldPoint = normalizePoint(candidate.liquidFieldPoint) ?? liquidPoint;
  const gasDirection = normalizePoint(candidate.gasDirection);
  const liquidDirection = normalizePoint(candidate.liquidDirection);
  const direction = normalizePoint(candidate.direction);
  if (!point || !gasPoint || !liquidPoint || !gasFieldPoint || !liquidFieldPoint || !direction) {
    return null;
  }
  const guideReference =
    candidate.guideReference === 'gas'
    || candidate.guideReference === 'liquid'
    || candidate.guideReference === 'center'
      ? candidate.guideReference
      : undefined;
  const normalizedDirection = normalizeDirection(direction);
  const repairedPoints = repairDegenerateBundlePoints({
    gasPoint,
    liquidPoint,
    gasFieldPoint,
    liquidFieldPoint,
    direction: normalizedDirection,
    guideReference,
    gasOuterDiameterMm: isFiniteNumber(candidate.gasOuterDiameterMm)
      ? candidate.gasOuterDiameterMm
      : undefined,
    liquidOuterDiameterMm: isFiniteNumber(candidate.liquidOuterDiameterMm)
      ? candidate.liquidOuterDiameterMm
      : undefined,
  });

  return {
    point: computeBundleCenter(repairedPoints.gasPoint, repairedPoints.liquidPoint),
    gasPoint: repairedPoints.gasPoint,
    liquidPoint: repairedPoints.liquidPoint,
    gasFieldPoint: repairedPoints.gasFieldPoint,
    liquidFieldPoint: repairedPoints.liquidFieldPoint,
    gasOuterDiameterMm: isFiniteNumber(candidate.gasOuterDiameterMm) ? candidate.gasOuterDiameterMm : undefined,
    liquidOuterDiameterMm: isFiniteNumber(candidate.liquidOuterDiameterMm) ? candidate.liquidOuterDiameterMm : undefined,
    gasDirection: gasDirection ? normalizeDirection(gasDirection) : undefined,
    liquidDirection: liquidDirection ? normalizeDirection(liquidDirection) : undefined,
    direction: normalizedDirection,
    elevationMm: readNumber(candidate.elevationMm, resolvedPipeElevationMm()),
    gasElevationMm: readNumber(
      candidate.gasElevationMm,
      readNumber(candidate.elevationMm, resolvedPipeElevationMm()),
    ),
    liquidElevationMm: readNumber(
      candidate.liquidElevationMm,
      readNumber(candidate.elevationMm, resolvedPipeElevationMm()),
    ),
    connectionKind: normalizeConnectionKind(candidate.connectionKind),
    guideReference,
    sourceElementId: typeof candidate.sourceElementId === 'string' ? candidate.sourceElementId : undefined,
  };
}

function healStartBundleConnectionFromScene(
  startBundleConnection: RefrigerantPipeBundleConnection | null,
  contextElements?: HvacPipeSnapSource[],
): RefrigerantPipeBundleConnection | null {
  if (
    !startBundleConnection
    || !startBundleConnection.sourceElementId
    || !contextElements
    || contextElements.length === 0
  ) {
    return startBundleConnection;
  }

  const sourceElement = contextElements.find(
    (candidate) => candidate.id === startBundleConnection.sourceElementId,
  );
  if (!sourceElement) {
    return startBundleConnection;
  }

  if (startBundleConnection.connectionKind === 'unit-port') {
    return (
      resolveUnitPortBundleConnectionForElement(sourceElement)
      ?? startBundleConnection
    );
  }

  if (!isRefrigerantBranchKitElement(sourceElement)) {
    return startBundleConnection;
  }

  const liveTargets = getRefrigerantPipeBundleSnapTargets([sourceElement]).filter(
    (target) =>
      target.connectionKind === 'field-pipe'
      && target.sourceElementId === startBundleConnection.sourceElementId,
  );
  if (liveTargets.length === 0) {
    return startBundleConnection;
  }

  const bestTarget = startBundleConnection.terminalRole
    ? liveTargets.find((target) => target.terminalRole === startBundleConnection.terminalRole)
    : null;
  const healedTarget = bestTarget ?? liveTargets.reduce((best, candidate) => {
    const bestDistance = Math.hypot(
      best.point.x - startBundleConnection.point.x,
      best.point.y - startBundleConnection.point.y,
    );
    const candidateDistance = Math.hypot(
      candidate.point.x - startBundleConnection.point.x,
      candidate.point.y - startBundleConnection.point.y,
    );
    return candidateDistance < bestDistance ? candidate : best;
  });

  return {
    ...healedTarget,
    guideReference: startBundleConnection.guideReference ?? healedTarget.guideReference,
    terminalRole: healedTarget.terminalRole ?? startBundleConnection.terminalRole,
  };
}

function normalizeLineKind(value: unknown): RefrigerantPipeLineKind {
  return value === 'liquid' ? 'liquid' : 'gas';
}

function normalizeConnectionKind(value: unknown): RefrigerantPipeConnectionKind {
  return value === 'field-pipe' ? 'field-pipe' : 'unit-port';
}

function normalizePipeConnection(value: unknown): RefrigerantPipeConnection | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as {
    portPoint?: unknown;
    direction?: unknown;
    elevationMm?: unknown;
    connectionKind?: unknown;
    sourceElementId?: unknown;
  };
  const portPoint = normalizePoint(candidate.portPoint);
  const direction = normalizePoint(candidate.direction);
  if (!portPoint || !direction) {
    return null;
  }
  return {
    portPoint,
    direction: normalizeDirection(direction),
    elevationMm: readNumber(candidate.elevationMm, resolvedPipeElevationMm()),
    connectionKind: normalizeConnectionKind(candidate.connectionKind),
    sourceElementId: typeof candidate.sourceElementId === 'string' ? candidate.sourceElementId : undefined,
  };
}

function add(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(point: Point2D, factor: number): Point2D {
  return { x: point.x * factor, y: point.y * factor };
}

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function perpendicular(point: Point2D): Point2D {
  return { x: -point.y, y: point.x };
}

function rotateLocalPoint(point: Point2D, angleDeg: number): Point2D {
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  };
}

function localToWorld(center: Point2D, point: Point2D, angleDeg: number): Point2D {
  return add(center, rotateLocalPoint(point, angleDeg));
}

function lineIntersection(
  pointA: Point2D,
  directionA: Point2D,
  pointB: Point2D,
  directionB: Point2D,
): Point2D | null {
  const determinant = directionA.x * directionB.y - directionA.y * directionB.x;
  if (Math.abs(determinant) < 0.0001) {
    return null;
  }
  const delta = subtract(pointB, pointA);
  const t = (delta.x * directionB.y - delta.y * directionB.x) / determinant;
  return add(pointA, scale(directionA, t));
}

function dedupeConsecutivePoints(points: Point2D[]): Point2D[] {
  const deduped: Point2D[] = [];
  points.forEach((point) => {
    const previous = deduped[deduped.length - 1];
    if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) > 0.01) {
      deduped.push(point);
    }
  });
  return deduped;
}

function isPipeRoutingDebugEnabled(): boolean {
  const root = globalThis as Record<string, unknown>;
  if (root.__HVAC_PIPE_ROUTING_DEBUG__ === true) {
    return true;
  }
  if (typeof window !== 'undefined') {
    try {
      return window.localStorage.getItem('hvac.pipe.debug') === '1';
    } catch {
      return false;
    }
  }
  return false;
}

function logCenterlineDeviation(
  label: string,
  expected: Point2D,
  actual: Point2D,
  toleranceMm: number,
): void {
  if (!isPipeRoutingDebugEnabled()) {
    return;
  }
  const deltaMm = Math.hypot(actual.x - expected.x, actual.y - expected.y);
  if (deltaMm <= toleranceMm) {
    return;
  }
  // eslint-disable-next-line no-console
  console.warn('[pipe-routing] centerline deviation', {
    label,
    expected,
    actual,
    deltaMm,
    toleranceMm,
  });
}

function resolveCenterlinePathWithConnections(
  routePoints: Point2D[],
  startConnection: RefrigerantPipeConnection | null,
  endConnection: RefrigerantPipeConnection | null,
): Point2D[] {
  const points = dedupeConsecutivePoints(routePoints);
  if (points.length === 0) {
    const fallback: Point2D[] = [];
    if (startConnection?.connectionKind === 'field-pipe') {
      fallback.push(startConnection.portPoint);
    }
    if (endConnection?.connectionKind === 'field-pipe') {
      fallback.push(endConnection.portPoint);
    }
    return dedupeConsecutivePoints(fallback);
  }

  const anchored = [...points];
  if (startConnection?.connectionKind === 'field-pipe') {
    logCenterlineDeviation(
      'start-anchor',
      startConnection.portPoint,
      anchored[0]!,
      PIPE_CENTERLINE_CONTINUITY_TOLERANCE_MM,
    );
    anchored[0] = startConnection.portPoint;
  }
  if (endConnection?.connectionKind === 'field-pipe') {
    logCenterlineDeviation(
      'end-anchor',
      endConnection.portPoint,
      anchored[anchored.length - 1]!,
      PIPE_CENTERLINE_CONTINUITY_TOLERANCE_MM,
    );
    anchored[anchored.length - 1] = endConnection.portPoint;
  }
  return dedupeConsecutivePoints(anchored);
}

function resolveEndpointTangent(
  routePoints: Point2D[],
  end: 'start' | 'end',
): Point2D | null {
  if (routePoints.length < 2) {
    return null;
  }
  if (end === 'start') {
    const startPoint = routePoints[0]!;
    const nextPoint = routePoints[1]!;
    return normalizeDirection(subtract(startPoint, nextPoint));
  }
  const endPoint = routePoints[routePoints.length - 1]!;
  const previousPoint = routePoints[routePoints.length - 2]!;
  return normalizeDirection(subtract(endPoint, previousPoint));
}

function resolvePipeCenterlineElevationMm(
  element: Pick<HvacElement, 'elevation'>,
  spec: RefrigerantPipeSpec,
): number {
  return spec.startConnection?.elevationMm
    ?? spec.endConnection?.elevationMm
    ?? (element.elevation + spec.outerDiameterMm / 2);
}

function simplifyNearlyCollinearPoints(
  points: Point2D[],
  options?: {
    preserveFirstSegment?: boolean;
  },
): Point2D[] {
  const deduped = dedupeConsecutivePoints(points);
  if (deduped.length < 3) {
    return deduped;
  }

  const angleToleranceCos = Math.cos((2 * Math.PI) / 180);
  const lateralToleranceMm = 0.2;
  const simplified: Point2D[] = [deduped[0]!];

  for (let index = 1; index < deduped.length - 1; index += 1) {
    if (options?.preserveFirstSegment && index === 1) {
      simplified.push(deduped[index]!);
      continue;
    }

    const previous = simplified[simplified.length - 1]!;
    const current = deduped[index]!;
    const next = deduped[index + 1]!;
    const incoming = subtract(current, previous);
    const outgoing = subtract(next, current);
    const direct = subtract(next, previous);
    const incomingLength = Math.hypot(incoming.x, incoming.y);
    const outgoingLength = Math.hypot(outgoing.x, outgoing.y);
    const directLength = Math.hypot(direct.x, direct.y);

    if (incomingLength < 0.01 || outgoingLength < 0.01 || directLength < 0.01) {
      continue;
    }

    const incomingDirection = normalizeDirection(incoming);
    const outgoingDirection = normalizeDirection(outgoing);
    const directionDot = dot(incomingDirection, outgoingDirection);
    const areaTwice = Math.abs(
      (current.x - previous.x) * (next.y - previous.y) -
      (current.y - previous.y) * (next.x - previous.x),
    );
    const lateralOffsetMm = areaTwice / directLength;

    if (directionDot >= angleToleranceCos && lateralOffsetMm <= lateralToleranceMm) {
      continue;
    }

    simplified.push(current);
  }

  simplified.push(deduped[deduped.length - 1]!);
  return dedupeConsecutivePoints(simplified);
}

interface RefrigerantPipeSegmentPathSpec {
  index: number;
  material: RefrigerantPipeMaterial;
  invalidHardGeometry: boolean;
  points: Point2D[];
  lengthMm: number;
}

function catmullRomPoint(
  p0: Point2D,
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  t: number,
): Point2D {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x:
      0.5 *
      ((2 * p1.x) +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y:
      0.5 *
      ((2 * p1.y) +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

function buildFlexibleSegmentSplinePoints(
  routePoints: Point2D[],
  segmentIndex: number,
): Point2D[] {
  const start = routePoints[segmentIndex];
  const end = routePoints[segmentIndex + 1];
  if (!start || !end) {
    return [];
  }

  const previous = routePoints[Math.max(0, segmentIndex - 1)] ?? start;
  const next = routePoints[Math.min(routePoints.length - 1, segmentIndex + 2)] ?? end;
  const spanLengthMm = Math.hypot(end.x - start.x, end.y - start.y);
  const sampleCount = Math.max(5, Math.min(24, Math.round(spanLengthMm / 12)));
  const sampled: Point2D[] = [start];

  for (let sampleIndex = 1; sampleIndex < sampleCount; sampleIndex += 1) {
    const t = sampleIndex / sampleCount;
    sampled.push(catmullRomPoint(previous, start, end, next, t));
  }
  sampled.push(end);

  return dedupeConsecutivePoints(sampled);
}

function buildRefrigerantPipeSegmentPaths(
  routePoints: Point2D[],
  segmentMaterials: RefrigerantPipeMaterial[],
): RefrigerantPipeSegmentPathSpec[] {
  const dedupedRoutePoints = dedupeConsecutivePoints(routePoints);
  if (dedupedRoutePoints.length < 2) {
    return [];
  }
  const normalizedMaterials = normalizeSegmentMaterialArray(
    segmentMaterials,
    dedupedRoutePoints.length - 1,
  );
  const segments: RefrigerantPipeSegmentPathSpec[] = [];
  for (let index = 0; index < dedupedRoutePoints.length - 1; index += 1) {
    const start = dedupedRoutePoints[index]!;
    const end = dedupedRoutePoints[index + 1]!;
    const material = normalizedMaterials[index] ?? 'flexible';
    const hardSegmentRoute = material === 'hard'
      ? buildHardSegmentRoute(start, end)
      : {
        points: buildFlexibleSegmentSplinePoints(dedupedRoutePoints, index),
        invalidHardGeometry: false,
      };
    const segmentPoints = dedupeConsecutivePoints(hardSegmentRoute.points);
    if (segmentPoints.length < 2) {
      continue;
    }
    segments.push({
      index,
      material,
      invalidHardGeometry: hardSegmentRoute.invalidHardGeometry,
      points: segmentPoints,
      lengthMm: polylineLength(segmentPoints),
    });
  }

  if (segments.length === 0 && dedupedRoutePoints.length >= 2) {
    const fallbackPoints = [dedupedRoutePoints[0]!, dedupedRoutePoints[1]!];
    return [{
      index: 0,
      material: normalizedMaterials[0] ?? 'flexible',
      invalidHardGeometry: false,
      points: fallbackPoints,
      lengthMm: polylineLength(fallbackPoints),
    }];
  }
  return segments;
}

function resolveInsulationThicknessMm(value: unknown): number {
  return Math.max(
    DEFAULT_REFRIGERANT_PIPE_INSULATION_THICKNESS_MM,
    readNumber(value, DEFAULT_REFRIGERANT_PIPE_INSULATION_THICKNESS_MM),
  );
}

function resolveInsulatedOuterDiameterMm(
  pipeDiameterMm: number,
  insulationThicknessMm: number,
  explicitOuterDiameterMm?: unknown,
): number {
  const insulatedOuterDiameterMm = pipeDiameterMm + insulationThicknessMm * 2;
  const minimumVisibleOuterDiameterMm = readNumber(
    explicitOuterDiameterMm,
    DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM,
  );
  return Math.max(insulatedOuterDiameterMm, minimumVisibleOuterDiameterMm);
}

function offsetPolyline(points: Point2D[], offsetMm: number): Point2D[] {
  if (points.length <= 1 || Math.abs(offsetMm) < 0.0001) {
    return [...points];
  }

  const normals: Point2D[] = [];
  const directions: Point2D[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const segment = subtract(points[index + 1]!, points[index]!);
    const direction = normalizeDirection(segment);
    directions.push(direction);
    normals.push(scale(perpendicular(direction), offsetMm));
  }

  return points.map((point, index) => {
    if (index === 0) {
      return add(point, normals[0]!);
    }
    if (index === points.length - 1) {
      return add(point, normals[normals.length - 1]!);
    }

    // Use miter join (line intersection) for geometrically correct parallel offset.
    // This maintains constant perpendicular spacing from the centerline.
    const previousDirection = directions[index - 1]!;
    const nextDirection = directions[index]!;
    const previousPoint = add(point, normals[index - 1]!);
    const nextPoint = add(point, normals[index]!);
    const intersection = lineIntersection(previousPoint, previousDirection, nextPoint, nextDirection);
    if (intersection) {
      return intersection;
    }
    return add(point, scale(add(normals[index - 1]!, normals[index]!), 0.5));
  });
}

function emptyBounds(): RefrigerantPipePairVisualSpec['bounds'] {
  return {
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
    width: 1,
    height: 1,
    center: { x: 0, y: 0 },
  };
}

function computeBounds(points: Point2D[], paddingMm: number): RefrigerantPipePairVisualSpec['bounds'] {
  if (points.length === 0) {
    return emptyBounds();
  }
  let minX = points[0]!.x;
  let minY = points[0]!.y;
  let maxX = points[0]!.x;
  let maxY = points[0]!.y;

  points.forEach((point) => {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  });

  minX -= paddingMm;
  minY -= paddingMm;
  maxX += paddingMm;
  maxY += paddingMm;

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
    center: {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
    },
  };
}

export function isRefrigerantPipePairType(type: HvacElement['type']): boolean {
  return type === 'refrigerant-pipe-pair';
}

export function isRefrigerantPipeType(type: HvacElement['type']): boolean {
  return type === 'refrigerant-pipe';
}

export function isRefrigerantPipeElementType(type: HvacElement['type']): boolean {
  return isRefrigerantPipeType(type) || isRefrigerantPipePairType(type);
}

export function resolveRefrigerantPipePairSpec(
  properties: Record<string, unknown>,
  contextElements?: HvacPipeSnapSource[],
): RefrigerantPipePairSpec {
  const gasPipeDiameterMm = readNumber(
    properties.gasPipeDiameterMm,
    DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM,
  );
  const liquidPipeDiameterMm = readNumber(
    properties.liquidPipeDiameterMm,
    DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM,
  );
  const insulationThicknessMm = resolveInsulationThicknessMm(properties.insulationThicknessMm);
  const gasOuterDiameterMm = resolveInsulatedOuterDiameterMm(
    gasPipeDiameterMm,
    insulationThicknessMm,
    properties.gasOuterDiameterMm,
  );
  const liquidOuterDiameterMm = resolveInsulatedOuterDiameterMm(
    liquidPipeDiameterMm,
    insulationThicknessMm,
    properties.liquidOuterDiameterMm,
  );

  const rawStartBundleConnection = normalizeBundleConnection(
    properties.startBundleConnection,
  );
  const startBundleConnection = healStartBundleConnectionFromScene(
    rawStartBundleConnection,
    contextElements,
  );
  const rawEndBundleConnection = normalizeBundleConnection(
    properties.endBundleConnection,
  );
  const endBundleConnection = healStartBundleConnectionFromScene(
    rawEndBundleConnection,
    contextElements,
  );
  const normalizedRoutePoints = normalizePointArray(properties.routePoints);
  const healedRoutePoints =
    rawStartBundleConnection
    && startBundleConnection
    && rawStartBundleConnection.connectionKind === 'field-pipe'
    && startBundleConnection.connectionKind === 'field-pipe'
    && rawStartBundleConnection.sourceElementId
    && rawStartBundleConnection.sourceElementId === startBundleConnection.sourceElementId
    ? (() => {
        const delta = subtract(
          startBundleConnection.point,
          rawStartBundleConnection.point,
        );
        const deltaMagnitudeMm = Math.hypot(delta.x, delta.y);
        if (deltaMagnitudeMm <= 0.5 || deltaMagnitudeMm > 600) {
          return normalizedRoutePoints;
        }
        return dedupeConsecutivePoints(
          normalizedRoutePoints.map((point) => add(point, delta)),
        );
      })()
    : normalizedRoutePoints;

  return {
    routePoints: healedRoutePoints,
    gasPipeDiameterMm,
    liquidPipeDiameterMm,
    gasOuterDiameterMm,
    liquidOuterDiameterMm,
    insulationThicknessMm,
    pipeGapMm: resolvedPipeGapMm(),
    startBundleConnection,
    endBundleConnection,
  };
}

export function translateRefrigerantPipePairProperties(
  properties: Record<string, unknown>,
  delta: Point2D,
): Record<string, unknown> {
  const spec = resolveRefrigerantPipePairSpec(properties);
  const translateBundle = (bundle: RefrigerantPipeBundleConnection | null) =>
    bundle
      ? {
          ...bundle,
          point: add(bundle.point, delta),
          gasPoint: add(bundle.gasPoint, delta),
          liquidPoint: add(bundle.liquidPoint, delta),
          gasFieldPoint: add(bundle.gasFieldPoint, delta),
          liquidFieldPoint: add(bundle.liquidFieldPoint, delta),
        }
      : null;

  return {
    ...properties,
    routePoints: spec.routePoints.map((point) => add(point, delta)),
    startBundleConnection: translateBundle(spec.startBundleConnection),
    endBundleConnection: translateBundle(spec.endBundleConnection),
  };
}

export function resolveRefrigerantPipeSpec(
  properties: Record<string, unknown>,
  contextElements?: HvacPipeSnapSource[],
): RefrigerantPipeSpec {
  const pipeDiameterMm = readNumber(
    properties.pipeDiameterMm,
    DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM,
  );
  const insulationThicknessMm = resolveInsulationThicknessMm(properties.insulationThicknessMm);
  const outerDiameterMm = resolveInsulatedOuterDiameterMm(
    pipeDiameterMm,
    insulationThicknessMm,
    properties.outerDiameterMm,
  );
  const lineKind = normalizeLineKind(properties.lineKind);
  const startConnection = healPipeConnectionFromScene(
    normalizePipeConnection(properties.startConnection),
    lineKind,
    contextElements,
  );
  const endConnection = healPipeConnectionFromScene(
    normalizePipeConnection(properties.endConnection),
    lineKind,
    contextElements,
  );
  const routePoints = normalizePointArray(properties.routePoints);
  const segmentMaterials = normalizeSegmentMaterialArray(
    properties.segmentMaterials,
    Math.max(0, routePoints.length - 1),
    {
      startConnection,
      endConnection,
    },
  );

  return {
    routePoints,
    pipeDiameterMm,
    outerDiameterMm,
    insulationThicknessMm,
    lineKind,
    segmentMaterials,
    bundleId: typeof properties.bundleId === 'string' ? properties.bundleId : undefined,
    startConnection,
    endConnection,
    bypasses: normalizeBypasses(properties.bypasses),
  };
}

export function translateRefrigerantPipeProperties(
  properties: Record<string, unknown>,
  delta: Point2D,
): Record<string, unknown> {
  const spec = resolveRefrigerantPipeSpec(properties);
  const nextStartConnection = spec.startConnection
    ? {
        ...spec.startConnection,
        portPoint: add(spec.startConnection.portPoint, delta),
      }
    : null;
  const nextEndConnection = spec.endConnection
    ? {
        ...spec.endConnection,
        portPoint: add(spec.endConnection.portPoint, delta),
      }
    : null;
  const centerlineStart = normalizePoint(properties.centerline_start);
  const centerlineEnd = normalizePoint(properties.centerline_end);

  return {
    ...properties,
    routePoints: spec.routePoints.map((point) => add(point, delta)),
    segmentMaterials: spec.segmentMaterials,
    startConnection: nextStartConnection,
    endConnection: nextEndConnection,
    centerline_start: centerlineStart ? add(centerlineStart, delta) : properties.centerline_start,
    centerline_end: centerlineEnd ? add(centerlineEnd, delta) : properties.centerline_end,
    bypasses: translateBypasses(properties.bypasses, delta),
  };
}

export function translateRefrigerantPipeElementProperties(
  type: HvacElement['type'],
  properties: Record<string, unknown>,
  delta: Point2D,
): Record<string, unknown> {
  if (isRefrigerantPipeType(type)) {
    return translateRefrigerantPipeProperties(properties, delta);
  }
  if (isRefrigerantPipePairType(type)) {
    return translateRefrigerantPipePairProperties(properties, delta);
  }
  return properties;
}

function computeBundleCenter(gasPoint: Point2D, liquidPoint: Point2D): Point2D {
  return {
    x: (gasPoint.x + liquidPoint.x) / 2,
    y: (gasPoint.y + liquidPoint.y) / 2,
  };
}

function healPipeConnectionFromScene(
  connection: RefrigerantPipeConnection | null,
  lineKind: RefrigerantPipeLineKind,
  contextElements?: HvacPipeSnapSource[],
): RefrigerantPipeConnection | null {
  if (
    !connection
    || connection.connectionKind !== 'unit-port'
    || !connection.sourceElementId
    || !contextElements
    || contextElements.length === 0
  ) {
    return connection;
  }

  const sourceElement = contextElements.find(
    (candidate) => candidate.id === connection.sourceElementId,
  );
  if (!sourceElement) {
    return connection;
  }

  return resolveUnitPortPipeConnectionForElement(sourceElement, lineKind) ?? connection;
}

function buildUnitPortBundleConnection(options: {
  gasPoint: Point2D;
  liquidPoint: Point2D;
  direction: Point2D;
  gasOuterDiameterMm: number;
  liquidOuterDiameterMm: number;
  gasElevationMm: number;
  liquidElevationMm: number;
  sourceElementId?: string;
}): RefrigerantPipeBundleConnection {
  const direction = normalizeDirection(options.direction);
  const bundleCenter = computeBundleCenter(options.gasPoint, options.liquidPoint);
  const normal = perpendicular(direction);
  const signedPortSpacingMm = dot(
    subtract(options.liquidPoint, options.gasPoint),
    normal,
  );
  const actualPortSpacingMm = Math.abs(signedPortSpacingMm);
  const desiredPortSpacingMm = Math.max(
    actualPortSpacingMm,
    options.gasOuterDiameterMm / 2 +
      options.liquidOuterDiameterMm / 2 +
      resolvedPipeGapMm(),
  );

  if (
    actualPortSpacingMm <= 0.2 ||
    desiredPortSpacingMm - actualPortSpacingMm <= 0.2
  ) {
    return {
      point: bundleCenter,
      gasPoint: options.gasPoint,
      liquidPoint: options.liquidPoint,
      gasFieldPoint: options.gasPoint,
      liquidFieldPoint: options.liquidPoint,
      gasOuterDiameterMm: options.gasOuterDiameterMm,
      liquidOuterDiameterMm: options.liquidOuterDiameterMm,
      gasDirection: direction,
      liquidDirection: direction,
      direction,
      elevationMm: (options.gasElevationMm + options.liquidElevationMm) / 2,
      gasElevationMm: options.gasElevationMm,
      liquidElevationMm: options.liquidElevationMm,
      connectionKind: 'unit-port',
      sourceElementId: options.sourceElementId,
    };
  }

  const spacingSign = Math.sign(signedPortSpacingMm) || 1;
  const spacingDeltaMm = desiredPortSpacingMm - actualPortSpacingMm;
  const fieldCenter = add(bundleCenter, scale(direction, spacingDeltaMm / 2));
  const gasFieldPoint = add(
    fieldCenter,
    scale(normal, -spacingSign * desiredPortSpacingMm / 2),
  );
  const liquidFieldPoint = add(
    fieldCenter,
    scale(normal, spacingSign * desiredPortSpacingMm / 2),
  );

  return {
    point: fieldCenter,
    gasPoint: options.gasPoint,
    liquidPoint: options.liquidPoint,
    gasFieldPoint,
    liquidFieldPoint,
    gasOuterDiameterMm: options.gasOuterDiameterMm,
    liquidOuterDiameterMm: options.liquidOuterDiameterMm,
    gasDirection: direction,
    liquidDirection: direction,
    direction,
    elevationMm: (options.gasElevationMm + options.liquidElevationMm) / 2,
    gasElevationMm: options.gasElevationMm,
    liquidElevationMm: options.liquidElevationMm,
    connectionKind: 'unit-port',
    sourceElementId: options.sourceElementId,
  };
}

function resolveUnitPortBundleConnectionForElement(
  element: HvacPipeSnapSource,
): RefrigerantPipeBundleConnection | null {
  if (element.type === 'ceiling-cassette-ac') {
    const cassette = buildCeilingCassetteModel(element);
    const gasPort = cassette.pipePorts.find((port) => port.kind === 'gas');
    const liquidPort = cassette.pipePorts.find((port) => port.kind === 'liquid');
    if (!gasPort || !liquidPort) {
      return null;
    }

    const center = absoluteCenter(element);
    const rotation = element.rotation ?? 0;
    const direction = normalizeDirection(rotateLocalPoint({ x: 1, y: 0 }, rotation));
    const gasPoint = localToWorld(
      center,
      getCeilingCassettePipePortEndpointLocal(gasPort),
      rotation,
    );
    const liquidPoint = localToWorld(
      center,
      getCeilingCassettePipePortEndpointLocal(liquidPort),
      rotation,
    );

    return buildUnitPortBundleConnection({
      gasPoint,
      liquidPoint,
      direction,
      gasOuterDiameterMm: gasPort.radius * 2,
      liquidOuterDiameterMm: liquidPort.radius * 2,
      gasElevationMm: element.elevation + gasPort.z,
      liquidElevationMm: element.elevation + liquidPort.z,
      sourceElementId: element.id,
    });
  }

  if (!GENERIC_PIPE_PORT_TYPES.has(element.type)) {
    return null;
  }

  const portSpec = getUnitPipePortSpec(element);
  if (!portSpec) {
    return null;
  }
  const gasPort = portSpec.ports.find((port) => port.kind === 'gas');
  const liquidPort = portSpec.ports.find((port) => port.kind === 'liquid');
  if (!gasPort || !liquidPort) {
    return null;
  }

  const center = absoluteCenter(element);
  const rotation = element.rotation ?? 0;
  const direction = normalizeDirection(
    rotateLocalPoint(portSpec.localDirection, rotation),
  );
  const gasPoint = localToWorld(
    center,
    getUnitPipePortEndpointLocal(gasPort),
    rotation,
  );
  const liquidPoint = localToWorld(
    center,
    getUnitPipePortEndpointLocal(liquidPort),
    rotation,
  );

  return buildUnitPortBundleConnection({
    gasPoint,
    liquidPoint,
    direction,
    gasOuterDiameterMm: gasPort.radius * 2,
    liquidOuterDiameterMm: liquidPort.radius * 2,
    gasElevationMm: element.elevation + gasPort.localZ,
    liquidElevationMm: element.elevation + liquidPort.localZ,
    sourceElementId: element.id,
  });
}

function resolveUnitPortPipeConnectionForElement(
  element: HvacPipeSnapSource,
  lineKind: RefrigerantPipeLineKind,
): RefrigerantPipeConnection | null {
  if (element.type === 'ceiling-cassette-ac') {
    const cassette = buildCeilingCassetteModel(element);
    const port = cassette.pipePorts.find((candidate) => candidate.kind === lineKind);
    if (!port) {
      return null;
    }

    const center = absoluteCenter(element);
    const rotation = element.rotation ?? 0;
    const direction = normalizeDirection(rotateLocalPoint({ x: 1, y: 0 }, rotation));
    const portPoint = localToWorld(
      center,
      getCeilingCassettePipePortEndpointLocal(port),
      rotation,
    );

    return {
      portPoint,
      direction,
      elevationMm: element.elevation + port.z,
      connectionKind: 'unit-port',
      sourceElementId: element.id,
    };
  }

  if (!GENERIC_PIPE_PORT_TYPES.has(element.type)) {
    return null;
  }

  const portSpec = getUnitPipePortSpec(element);
  const port = portSpec?.ports.find((candidate) => candidate.kind === lineKind);
  if (!portSpec || !port) {
    return null;
  }

  const center = absoluteCenter(element);
  const rotation = element.rotation ?? 0;
  const direction = normalizeDirection(
    rotateLocalPoint(portSpec.localDirection, rotation),
  );
  const portPoint = localToWorld(
    center,
    getUnitPipePortEndpointLocal(port),
    rotation,
  );

  return {
    portPoint,
    direction,
    elevationMm: element.elevation + port.localZ,
    connectionKind: 'unit-port',
    sourceElementId: element.id,
  };
}

function normalizeAngleDeg(value: number): number {
  let normalized = value % 360;
  if (normalized < 0) {
    normalized += 360;
  }
  return normalized;
}

function smallestAngleDifferenceDeg(a: number, b: number): number {
  const diff = Math.abs(normalizeAngleDeg(a) - normalizeAngleDeg(b));
  return Math.min(diff, 360 - diff);
}

function resolveInlineBranchKitCenter(
  element: HvacPipeSnapSource,
  lineSelection: ReturnType<typeof resolveRefrigerantBranchKitLineSelection>,
  model: ReturnType<typeof buildRefrigerantBranchKitViewModel>,
): { center: Point2D; rotationDeg: number } | null {
  if (element.properties.branchKitPlacementMode !== 'inline-pipe-run') {
    return null;
  }
  const initialAnchorPoint = normalizePoint(element.properties.branchKitSnapPoint);
  if (!initialAnchorPoint) {
    return null;
  }
  let anchorPoint: Point2D = initialAnchorPoint;

  const snapSegmentStart = normalizePoint(element.properties.branchKitSnapSegmentStart);
  const snapSegmentEnd = normalizePoint(element.properties.branchKitSnapSegmentEnd);
  const snapProjectedDistanceMm =
    typeof element.properties.branchKitSnapProjectedDistanceMm === "number" &&
    Number.isFinite(element.properties.branchKitSnapProjectedDistanceMm)
      ? element.properties.branchKitSnapProjectedDistanceMm
      : null;
  if (snapSegmentStart && snapSegmentEnd) {
    const segmentDelta = subtract(snapSegmentEnd, snapSegmentStart);
    const segmentLengthMm = Math.hypot(segmentDelta.x, segmentDelta.y);
    if (segmentLengthMm > 0.2) {
      const segmentDirection = {
        x: segmentDelta.x / segmentLengthMm,
        y: segmentDelta.y / segmentLengthMm,
      };
      const projectedMm =
        snapProjectedDistanceMm !== null
          ? Math.min(segmentLengthMm, Math.max(0, snapProjectedDistanceMm))
          : Math.min(
              segmentLengthMm,
              Math.max(
                0,
                dot(
                  subtract(initialAnchorPoint, snapSegmentStart),
                  segmentDirection,
                ),
              ),
            );
      anchorPoint = add(
        snapSegmentStart,
        { x: segmentDirection.x * projectedMm, y: segmentDirection.y * projectedMm },
      );
    }
  }
  const canonicalAnchorLocal = resolveRefrigerantBranchKitInlineAnchorLocal(
    model,
    lineSelection,
  );
  const storedAnchorLocal = normalizePoint(element.properties.branchKitSnapAnchorLocal);
  const anchorLocal = (() => {
    if (!storedAnchorLocal) {
      return canonicalAnchorLocal;
    }
    const MAX_INLINE_ANCHOR_LOCAL_DRIFT_MM = 1;
    const driftMm = Math.hypot(
      storedAnchorLocal.x - canonicalAnchorLocal.x,
      storedAnchorLocal.y - canonicalAnchorLocal.y,
    );
    return driftMm <= MAX_INLINE_ANCHOR_LOCAL_DRIFT_MM
      ? storedAnchorLocal
      : canonicalAnchorLocal;
  })();
  const snapDirection = normalizeDirection(
    normalizePoint(element.properties.branchKitSnapDirection) ?? { x: 1, y: 0 },
  );
  const fallbackRotationDeg = element.rotation ?? 0;
  const axisAngleDeg = normalizeAngleDeg(
    (Math.atan2(snapDirection.y, snapDirection.x) * 180) / Math.PI,
  );
  const candidateRotationA = axisAngleDeg;
  const candidateRotationB = normalizeAngleDeg(axisAngleDeg + 180);
  const rotationDeg =
    smallestAngleDifferenceDeg(candidateRotationA, fallbackRotationDeg)
      <= smallestAngleDifferenceDeg(candidateRotationB, fallbackRotationDeg)
      ? candidateRotationA
      : candidateRotationB;
  const rotatedAnchorLocal = rotateLocalPoint(anchorLocal, rotationDeg);
  return {
    center: {
      x: anchorPoint.x - rotatedAnchorLocal.x,
      y: anchorPoint.y - rotatedAnchorLocal.y,
    },
    rotationDeg,
  };
}

function computeStartTakeoffLength(
  centerSpacingMm: number,
  maxOuterDiameterMm: number,
): number {
  return Math.max(54, centerSpacingMm + 12, maxOuterDiameterMm * 1.02);
}

function computeCompactBendRadius(
  centerSpacingMm: number,
  maxOuterDiameterMm: number,
): number {
  return Math.max(6, maxOuterDiameterMm * 0.42, centerSpacingMm * 0.12);
}

function computeConnectionOverlapLength(maxOuterDiameterMm: number): number {
  return Math.max(2.5, Math.min(6, maxOuterDiameterMm * 0.2));
}

/**
 * Appends a short direction-aligned tail at the end of the guide route so the
 * last segment points along the end unit's port exit direction.  This ensures
 * that `offsetPolyline` offsets the endpoint perpendicular to the port direction,
 * producing correctly spaced gas/liquid endpoints without kinking.
 */
function appendEndApproachTail(
  guidePoints: Point2D[],
  endBundleConnection: RefrigerantPipeBundleConnection | null,
  tailLengthMm: number,
): Point2D[] {
  if (!endBundleConnection || guidePoints.length < 1) {
    return guidePoints;
  }
  const shouldAlignEnd =
    endBundleConnection.connectionKind === 'unit-port'
    || Boolean(endBundleConnection.terminalRole);
  if (!shouldAlignEnd) {
    return guidePoints;
  }

  const endCenter = computeBundleCenter(
    endBundleConnection.gasFieldPoint,
    endBundleConnection.liquidFieldPoint,
  );
  const endDir = endBundleConnection.direction;

  // The approach point sits tailLengthMm outward from endCenter along the port
  // exit direction. The segment approachPoint -> endCenter is therefore aligned
  // with the port, and offsetPolyline will offset perpendicular to it.
  const approachPoint = add(endCenter, scale(endDir, tailLengthMm));

  const result = guidePoints.slice(0, -1);
  result.push(approachPoint, endCenter);
  return dedupeConsecutivePoints(result);
}

function buildFieldRoutePoints(
  routePoints: Point2D[],
  connectionCenter: Point2D,
  direction: Point2D,
  takeoffLengthMm: number,
): Point2D[] {
  if (routePoints.length === 0) {
    return [connectionCenter];
  }

  const dedupedRoutePoints = dedupeConsecutivePoints(routePoints);
  const firstPoint = dedupedRoutePoints[0];
  const remaining =
    firstPoint &&
    Math.hypot(
      firstPoint.x - connectionCenter.x,
      firstPoint.y - connectionCenter.y,
    ) <= 0.2
      ? dedupedRoutePoints.slice(1)
      : dedupedRoutePoints;

  if (remaining.length === 0) {
    return [connectionCenter];
  }

  const takeoffTailPoints = buildTakeoffTailPoints(
    remaining,
    connectionCenter,
    direction,
    Math.max(0, takeoffLengthMm),
    { preserveFirstBearing: true },
  );

  return dedupeConsecutivePoints([connectionCenter, ...takeoffTailPoints]);
}

function buildTakeoffTailPoints(
  routePoints: Point2D[],
  connectionPoint: Point2D,
  direction: Point2D,
  takeoffLengthMm: number,
  options?: {
    preserveFirstBearing?: boolean;
  },
): Point2D[] {
  const TAKEOFF_LATERAL_TOLERANCE_MM = 0.75;
  const takeoffEnd = add(connectionPoint, scale(direction, takeoffLengthMm));
  const dedupedRoutePoints = dedupeConsecutivePoints(routePoints);
  const firstRoutePoint = dedupedRoutePoints[0];
  const remaining = firstRoutePoint && Math.hypot(
    firstRoutePoint.x - connectionPoint.x,
    firstRoutePoint.y - connectionPoint.y,
  ) <= 0.2
    ? dedupedRoutePoints.slice(1)
    : dedupedRoutePoints;

  if (remaining.length === 0) {
    return [takeoffEnd];
  }

  const firstPoint = remaining[0]!;
  const normal = perpendicular(direction);
  const projectedDistance = dot(subtract(firstPoint, connectionPoint), direction);
  if (options?.preserveFirstBearing && projectedDistance >= takeoffLengthMm - 0.2) {
    return dedupeConsecutivePoints([takeoffEnd, ...remaining]);
  }
  const axisAdvanceMm = Math.max(projectedDistance, takeoffLengthMm);
  const alignedFirstPoint = add(
    connectionPoint,
    scale(direction, axisAdvanceMm),
  );
  const lateralOffsetMm = dot(subtract(firstPoint, alignedFirstPoint), normal);

  const points = [takeoffEnd];
  if (
    Math.hypot(
      alignedFirstPoint.x - takeoffEnd.x,
      alignedFirstPoint.y - takeoffEnd.y,
    ) > 0.2
  ) {
    points.push(alignedFirstPoint);
  }

  if (projectedDistance < takeoffLengthMm) {
    if (Math.abs(lateralOffsetMm) > TAKEOFF_LATERAL_TOLERANCE_MM) {
      const projectedLateralPoint = add(
        alignedFirstPoint,
        scale(normal, lateralOffsetMm),
      );
      if (
        Math.hypot(
          projectedLateralPoint.x - points[points.length - 1]!.x,
          projectedLateralPoint.y - points[points.length - 1]!.y,
        ) > 0.2
      ) {
        points.push(projectedLateralPoint);
      }
    }
    return dedupeConsecutivePoints(points);
  }

  if (
    Math.hypot(
      firstPoint.x - alignedFirstPoint.x,
      firstPoint.y - alignedFirstPoint.y,
    ) > 0.2
  ) {
    points.push(firstPoint);
  }
  points.push(...remaining.slice(1));

  return dedupeConsecutivePoints(points);
}

function buildTwoFortyFiveOffsetTakeoffPoints(
  leadGuidePoints: Point2D[],
  leadConnectionPoint: Point2D,
  trailingConnectionPoint: Point2D,
  direction: Point2D,
  actualOffsetFromLeadMm: number,
  desiredOffsetFromLeadMm: number,
  takeoffLengthMm: number,
): Point2D[] {
  if (leadGuidePoints.length === 0) {
    return [];
  }

  const normal = perpendicular(direction);
  const parallelLeadPoints = leadGuidePoints.map((point) =>
    add(point, scale(normal, desiredOffsetFromLeadMm)),
  );
  const lateralShiftMm = desiredOffsetFromLeadMm - actualOffsetFromLeadMm;
  if (Math.abs(lateralShiftMm) <= 0.2) {
    return dedupeConsecutivePoints(parallelLeadPoints);
  }

  // For the non-selected pipe, start the 45 deg offset immediately from the
  // unit port. Any remaining straight takeoff length continues after the second
  // 45 so the bundle spacing is already correct before the first routed bend.
  const diagonalAdvanceMm = Math.min(takeoffLengthMm, Math.abs(lateralShiftMm));
  const diagonalJoinPoint = add(
    add(trailingConnectionPoint, scale(direction, diagonalAdvanceMm)),
    scale(normal, lateralShiftMm),
  );

  const points: Point2D[] = [diagonalJoinPoint];
  const parallelTakeoffPoint = parallelLeadPoints[0];
  if (
    parallelTakeoffPoint
    && Math.hypot(
      parallelTakeoffPoint.x - diagonalJoinPoint.x,
      parallelTakeoffPoint.y - diagonalJoinPoint.y,
    ) > 0.2
  ) {
    points.push(parallelTakeoffPoint);
  }
  points.push(...parallelLeadPoints.slice(1));

  return dedupeConsecutivePoints(points);
}

type BundleGuideReference = 'gas' | 'liquid' | 'center';
const UNIT_PORT_MIN_INSULATION_CLEARANCE_MM = ONE_INCH_MM;

function resolveParallelBundleOffsets(
  startBundleConnection: RefrigerantPipeBundleConnection | null,
  centerSpacingMm: number,
): { gasOffsetMm: number; liquidOffsetMm: number } {
  if (!startBundleConnection) {
    return {
      gasOffsetMm: -centerSpacingMm / 2,
      liquidOffsetMm: centerSpacingMm / 2,
    };
  }

  const bundleCenter = computeBundleCenter(
    startBundleConnection.gasFieldPoint,
    startBundleConnection.liquidFieldPoint,
  );
  const perpDir = perpendicular(startBundleConnection.direction);
  const gasPortOffset = dot(subtract(startBundleConnection.gasFieldPoint, bundleCenter), perpDir);
  const liquidPortOffset = dot(subtract(startBundleConnection.liquidFieldPoint, bundleCenter), perpDir);

  // For field-pipe connections (branch kits), use the ACTUAL port offsets.
  // This ensures offset calculations align with the exact branch kit outlet positions.
  // The parallel route will then start from the correct positions when the first
  // segment direction matches the branch kit direction.
  if (startBundleConnection.connectionKind === 'field-pipe') {
    return {
      gasOffsetMm: gasPortOffset,
      liquidOffsetMm: liquidPortOffset,
    };
  }

  // For unit-port connections, use standard centerSpacingMm-based offsets
  // to ensure consistent gap regardless of unit port variations.
  const offsetSign = Math.sign(liquidPortOffset - gasPortOffset) || 1;
  return {
    gasOffsetMm: -offsetSign * centerSpacingMm / 2,
    liquidOffsetMm: offsetSign * centerSpacingMm / 2,
  };
}

function resolveDesiredOffsetFromLead(
  options: {
    actualOffsetFromLeadMm: number;
    leadOuterDiameterMm?: number;
    trailingOuterDiameterMm?: number;
    fallbackCenterSpacingMm: number;
  },
): number {
  const sign = Math.sign(options.actualOffsetFromLeadMm) || 1;
  const leadRadiusMm =
    typeof options.leadOuterDiameterMm === 'number' && options.leadOuterDiameterMm > 0
      ? options.leadOuterDiameterMm / 2
      : null;
  const trailingRadiusMm =
    typeof options.trailingOuterDiameterMm === 'number'
    && options.trailingOuterDiameterMm > 0
      ? options.trailingOuterDiameterMm / 2
      : null;
  const knownCenterSpacingMm =
    leadRadiusMm !== null && trailingRadiusMm !== null
      ? leadRadiusMm + trailingRadiusMm + UNIT_PORT_MIN_INSULATION_CLEARANCE_MM
      : null;
  // Enforce insulation-surface clearance from routed pipe geometry as the minimum.
  // Port stub diameters can be visually simplified and smaller than routed ODs.
  const targetCenterSpacingMm = knownCenterSpacingMm !== null
    ? Math.max(knownCenterSpacingMm, options.fallbackCenterSpacingMm)
    : options.fallbackCenterSpacingMm;
  return sign * targetCenterSpacingMm;
}

function resolveBundleGuideReference(
  startBundleConnection: RefrigerantPipeBundleConnection | null,
): BundleGuideReference {
  if (!startBundleConnection) {
    return 'center';
  }
  // Unit-port starts should always route from one stable bundle datum.
  // Letting hover state flip between gas/liquid anchors creates two apparent
  // near-port snap positions and unstable 2D takeoff geometry.
  if (startBundleConnection.connectionKind === 'unit-port') {
    return 'center';
  }
  if (startBundleConnection.guideReference) {
    return startBundleConnection.guideReference;
  }

  const bundleCenter = computeBundleCenter(
    startBundleConnection.gasFieldPoint,
    startBundleConnection.liquidFieldPoint,
  );
  const gasDistance = Math.hypot(
    startBundleConnection.point.x - startBundleConnection.gasPoint.x,
    startBundleConnection.point.y - startBundleConnection.gasPoint.y,
  );
  const liquidDistance = Math.hypot(
    startBundleConnection.point.x - startBundleConnection.liquidPoint.x,
    startBundleConnection.point.y - startBundleConnection.liquidPoint.y,
  );
  const centerDistance = Math.hypot(
    startBundleConnection.point.x - bundleCenter.x,
    startBundleConnection.point.y - bundleCenter.y,
  );

  if (centerDistance <= 1 && centerDistance <= gasDistance && centerDistance <= liquidDistance) {
    return 'center';
  }
  return gasDistance <= liquidDistance ? 'gas' : 'liquid';
}

function buildBundleGuideRoutes(
  routePoints: Point2D[],
  startBundleConnection: RefrigerantPipeBundleConnection | null,
  endBundleConnection: RefrigerantPipeBundleConnection | null,
  centerSpacingMm: number,
  startTakeoffLengthMm: number,
): {
  gasGuidePoints: Point2D[];
  liquidGuidePoints: Point2D[];
  bundleGuidePoints: Point2D[];
} {
  const isFieldPipeConnection = startBundleConnection?.connectionKind === 'field-pipe';
  // Append an end approach tail so the last segment is aligned with the end
  // unit's port direction. offsetPolyline then naturally offsets the endpoint
  // perpendicular to the port direction; no endpoint-snapping hack needed.
  const endTailLength = startTakeoffLengthMm;
  const rawNormalized = isFieldPipeConnection
    ? dedupeConsecutivePoints(routePoints)
    : normalizeBundleGuideRoutePoints(routePoints, startBundleConnection);
  const normalizedGuideRoutePoints = appendEndApproachTail(
    rawNormalized,
    endBundleConnection,
    endTailLength,
  );

  if (!startBundleConnection) {
    return {
      gasGuidePoints: normalizedGuideRoutePoints.length >= 1
        ? dedupeConsecutivePoints(offsetPolyline(normalizedGuideRoutePoints, -centerSpacingMm / 2))
        : [],
      liquidGuidePoints: normalizedGuideRoutePoints.length >= 1
        ? dedupeConsecutivePoints(offsetPolyline(normalizedGuideRoutePoints, centerSpacingMm / 2))
        : [],
      bundleGuidePoints: normalizedGuideRoutePoints,
    };
  }

  const anchor = resolveBundleGuideReference(startBundleConnection);
  const direction = startBundleConnection.direction;
  const isUnitPortConnection = startBundleConnection.connectionKind === 'unit-port';
  const bundleCenter = computeBundleCenter(
    startBundleConnection.gasFieldPoint,
    startBundleConnection.liquidFieldPoint,
  );

  // Compute port-based perpendicular offsets so the guide routes start exactly at
  // the port positions. The perpendicular direction is direction rotated 90 degrees CCW.
  // Using port-derived offsets instead of centerSpacingMm/2 ensures the routes are
  // parallel to each other from the very first point (no convergence near the unit).
  const perpDir = { x: -direction.y, y: direction.x };
  const gasPortOffset = dot(subtract(startBundleConnection.gasFieldPoint, bundleCenter), perpDir);
  const liquidPortOffset = dot(subtract(startBundleConnection.liquidFieldPoint, bundleCenter), perpDir);
  const gasToLiquidOffset = liquidPortOffset - gasPortOffset;
  const desiredParallelOffsets = resolveParallelBundleOffsets(startBundleConnection, centerSpacingMm);
  const desiredGasToLiquidOffset =
    desiredParallelOffsets.liquidOffsetMm - desiredParallelOffsets.gasOffsetMm;

  // For field-pipe connections, always use centerSpacingMm-based offsets because
  // offsetPolyline applies offsets perpendicular to route direction (which may differ
  // from branch-kit direction). Port-based offsets only work when route direction
  // matches branch-kit direction.

  if (anchor === 'gas') {
    if (isUnitPortConnection) {
      const gasGuidePoints = buildTakeoffTailPoints(
        normalizedGuideRoutePoints,
        startBundleConnection.gasFieldPoint,
        direction,
        startTakeoffLengthMm,
        { preserveFirstBearing: true },
      );
      const actualLiquidOffsetFromGasMm = gasToLiquidOffset;
      const desiredLiquidOffsetFromGasMm = resolveDesiredOffsetFromLead({
        actualOffsetFromLeadMm: actualLiquidOffsetFromGasMm,
        leadOuterDiameterMm: startBundleConnection.gasOuterDiameterMm,
        trailingOuterDiameterMm: startBundleConnection.liquidOuterDiameterMm,
        fallbackCenterSpacingMm: centerSpacingMm,
      });
      const liquidGuidePoints = buildTwoFortyFiveOffsetTakeoffPoints(
        gasGuidePoints,
        startBundleConnection.gasFieldPoint,
        startBundleConnection.liquidFieldPoint,
        direction,
        actualLiquidOffsetFromGasMm,
        desiredLiquidOffsetFromGasMm,
        startTakeoffLengthMm,
      );
      return {
        gasGuidePoints,
        liquidGuidePoints,
        bundleGuidePoints: gasGuidePoints.length >= 1
          ? dedupeConsecutivePoints(
              offsetPolyline(gasGuidePoints, desiredLiquidOffsetFromGasMm / 2),
            )
          : [bundleCenter],
      };
    }

    const gasGuidePoints = isFieldPipeConnection
      ? buildFieldRoutePoints(
          normalizedGuideRoutePoints,
          startBundleConnection.gasFieldPoint,
          startBundleConnection.gasDirection ?? direction,
          startTakeoffLengthMm,
        )
      : buildTakeoffTailPoints(
          normalizedGuideRoutePoints,
          startBundleConnection.gasFieldPoint,
          direction,
          startTakeoffLengthMm,
          { preserveFirstBearing: isUnitPortConnection },
        );
    const desiredLiquidOffset = desiredGasToLiquidOffset;
    // For field-pipe connections, build liquid route independently from its port
    // instead of offsetting from gas route. This ensures correct alignment when
    // route direction differs from branch-kit outlet direction.
    const liquidGuidePoints = isFieldPipeConnection
      ? buildFieldRoutePoints(
          normalizedGuideRoutePoints,
          startBundleConnection.liquidFieldPoint,
          startBundleConnection.liquidDirection ?? direction,
          startTakeoffLengthMm,
        )
      : buildTwoFortyFiveOffsetTakeoffPoints(
          gasGuidePoints,
          startBundleConnection.gasFieldPoint,
          startBundleConnection.liquidFieldPoint,
          direction,
          gasToLiquidOffset,
          desiredLiquidOffset,
          startTakeoffLengthMm,
        );
    return {
      gasGuidePoints,
      liquidGuidePoints,
      // For field-pipe, build bundle center route directly from the actual center
      // instead of offsetting from gas/liquid (which were built independently).
      bundleGuidePoints: isFieldPipeConnection
        ? buildFieldRoutePoints(
            normalizedGuideRoutePoints,
            bundleCenter,
            direction,
            startTakeoffLengthMm,
          )
        : gasGuidePoints.length >= 1
          ? dedupeConsecutivePoints(offsetPolyline(gasGuidePoints, desiredLiquidOffset / 2))
          : [bundleCenter],
    };
  }

  if (anchor === 'liquid') {
    if (isUnitPortConnection) {
      const liquidGuidePoints = buildTakeoffTailPoints(
        normalizedGuideRoutePoints,
        startBundleConnection.liquidFieldPoint,
        direction,
        startTakeoffLengthMm,
        { preserveFirstBearing: true },
      );
      const actualGasOffsetFromLiquidMm = -gasToLiquidOffset;
      const desiredGasOffsetFromLiquidMm = resolveDesiredOffsetFromLead({
        actualOffsetFromLeadMm: actualGasOffsetFromLiquidMm,
        leadOuterDiameterMm: startBundleConnection.liquidOuterDiameterMm,
        trailingOuterDiameterMm: startBundleConnection.gasOuterDiameterMm,
        fallbackCenterSpacingMm: centerSpacingMm,
      });
      const gasGuidePoints = buildTwoFortyFiveOffsetTakeoffPoints(
        liquidGuidePoints,
        startBundleConnection.liquidFieldPoint,
        startBundleConnection.gasFieldPoint,
        direction,
        actualGasOffsetFromLiquidMm,
        desiredGasOffsetFromLiquidMm,
        startTakeoffLengthMm,
      );
      return {
        gasGuidePoints,
        liquidGuidePoints,
        bundleGuidePoints: liquidGuidePoints.length >= 1
          ? dedupeConsecutivePoints(
              offsetPolyline(liquidGuidePoints, desiredGasOffsetFromLiquidMm / 2),
            )
          : [bundleCenter],
      };
    }

    const liquidGuidePoints = isFieldPipeConnection
      ? buildFieldRoutePoints(
          normalizedGuideRoutePoints,
          startBundleConnection.liquidFieldPoint,
          startBundleConnection.liquidDirection ?? direction,
          startTakeoffLengthMm,
        )
      : buildTakeoffTailPoints(
          normalizedGuideRoutePoints,
          startBundleConnection.liquidFieldPoint,
          direction,
          startTakeoffLengthMm,
          { preserveFirstBearing: isUnitPortConnection },
        );
    const desiredGasOffset = desiredParallelOffsets.gasOffsetMm - desiredParallelOffsets.liquidOffsetMm;
    // For field-pipe connections, build gas route independently from its port
    // instead of offsetting from liquid route. This ensures correct alignment when
    // route direction differs from branch-kit outlet direction.
    const gasGuidePoints = isFieldPipeConnection
      ? buildFieldRoutePoints(
          normalizedGuideRoutePoints,
          startBundleConnection.gasFieldPoint,
          startBundleConnection.gasDirection ?? direction,
          startTakeoffLengthMm,
        )
      : buildTwoFortyFiveOffsetTakeoffPoints(
          liquidGuidePoints,
          startBundleConnection.liquidFieldPoint,
          startBundleConnection.gasFieldPoint,
          direction,
          -gasToLiquidOffset,
          desiredGasOffset,
          startTakeoffLengthMm,
        );
    return {
      gasGuidePoints,
      liquidGuidePoints,
      // For field-pipe, build bundle center route directly from the actual center
      // instead of offsetting from gas/liquid (which were built independently).
      bundleGuidePoints: isFieldPipeConnection
        ? buildFieldRoutePoints(
            normalizedGuideRoutePoints,
            bundleCenter,
            direction,
            startTakeoffLengthMm,
          )
        : liquidGuidePoints.length >= 1
          ? dedupeConsecutivePoints(offsetPolyline(liquidGuidePoints, desiredGasOffset / 2))
          : [bundleCenter],
    };
  }

  // 'center' anchor: offset the center takeoff route by port-derived perpendicular distances
  const bundleGuidePoints = isFieldPipeConnection
    ? buildFieldRoutePoints(
        normalizedGuideRoutePoints,
        bundleCenter,
        direction,
        startTakeoffLengthMm,
      )
    : buildTakeoffTailPoints(
        normalizedGuideRoutePoints,
        bundleCenter,
        direction,
        startTakeoffLengthMm,
        { preserveFirstBearing: isUnitPortConnection },
      );
  // For field-pipe connections, build gas and liquid routes independently from
  // their respective port positions instead of offsetting from bundle center.
  // This ensures correct alignment when route direction differs from branch-kit direction.
  const gasGuidePoints = isFieldPipeConnection
    ? buildFieldRoutePoints(
        normalizedGuideRoutePoints,
        startBundleConnection.gasFieldPoint,
        startBundleConnection.gasDirection ?? direction,
        startTakeoffLengthMm,
      )
    : buildTwoFortyFiveOffsetTakeoffPoints(
        bundleGuidePoints,
        bundleCenter,
        startBundleConnection.gasFieldPoint,
        direction,
        gasPortOffset,
        desiredParallelOffsets.gasOffsetMm,
        startTakeoffLengthMm,
      );
  const liquidGuidePoints = isFieldPipeConnection
    ? buildFieldRoutePoints(
        normalizedGuideRoutePoints,
        startBundleConnection.liquidFieldPoint,
        startBundleConnection.liquidDirection ?? direction,
        startTakeoffLengthMm,
      )
    : buildTwoFortyFiveOffsetTakeoffPoints(
        bundleGuidePoints,
        bundleCenter,
        startBundleConnection.liquidFieldPoint,
        direction,
        liquidPortOffset,
        desiredParallelOffsets.liquidOffsetMm,
        startTakeoffLengthMm,
      );
  return {
    gasGuidePoints,
    liquidGuidePoints,
    bundleGuidePoints,
  };
}

function mergeGuideRouteWithParallelRoute(
  guidePoints: Point2D[],
  parallelPoints: Point2D[],
): Point2D[] {
  if (parallelPoints.length === 0) {
    return dedupeConsecutivePoints(guidePoints);
  }
  if (guidePoints.length === 0) {
    return dedupeConsecutivePoints(parallelPoints);
  }

  const parallelStartPoint = parallelPoints[0]!;
  const joinIndex = guidePoints.findIndex((point) => Math.hypot(
    point.x - parallelStartPoint.x,
    point.y - parallelStartPoint.y,
  ) <= 0.2);

  if (joinIndex >= 0) {
    return dedupeConsecutivePoints([
      ...guidePoints.slice(0, joinIndex),
      ...parallelPoints,
    ]);
  }

  const MAX_GUIDE_PARALLEL_JOIN_DISTANCE_MM = 96;
  let bestGuideIndex = -1;
  let bestParallelIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  guidePoints.forEach((guidePoint, guideIndex) => {
    parallelPoints.forEach((parallelPoint, parallelIndex) => {
      const gap = Math.hypot(
        guidePoint.x - parallelPoint.x,
        guidePoint.y - parallelPoint.y,
      );
      if (
        gap < bestDistance
        || (
          Math.abs(gap - bestDistance) <= 0.01
          && parallelIndex < bestParallelIndex
        )
      ) {
        bestDistance = gap;
        bestGuideIndex = guideIndex;
        bestParallelIndex = parallelIndex;
      }
    });
  });

  if (
    bestGuideIndex >= 0
    && bestParallelIndex >= 0
    && bestDistance <= MAX_GUIDE_PARALLEL_JOIN_DISTANCE_MM
  ) {
    const parallelJoinPoint = parallelPoints[bestParallelIndex]!;
    
    return dedupeConsecutivePoints([
      ...guidePoints.slice(0, bestGuideIndex),
      parallelJoinPoint,
      ...parallelPoints.slice(bestParallelIndex + 1),
    ]);
  }

  return dedupeConsecutivePoints(parallelPoints);
}

function anchorGuideRouteEnd(
  guidePoints: Point2D[],
  endpoint: Point2D | null,
): Point2D[] {
  if (!endpoint || guidePoints.length === 0) {
    return guidePoints;
  }
  const anchored = [...guidePoints];
  anchored[anchored.length - 1] = endpoint;
  return anchored;
}

function anchorGuideRouteStart(
  guidePoints: Point2D[],
  endpoint: Point2D | null,
): Point2D[] {
  if (!endpoint || guidePoints.length === 0) {
    return guidePoints;
  }
  const anchored = [...guidePoints];
  anchored[0] = endpoint;
  return anchored;
}

function buildResolvedPipeRoutePoints(
  options: {
    gasGuidePoints: Point2D[];
    liquidGuidePoints: Point2D[];
    bundleGuidePoints: Point2D[];
    startBundleConnection: RefrigerantPipeBundleConnection | null;
    endBundleConnection: RefrigerantPipeBundleConnection | null;
    centerSpacingMm: number;
    bendRadiusMm: number;
  },
): {
  gasRoutePoints: Point2D[];
  liquidRoutePoints: Point2D[];
} {
  const {
    gasGuidePoints,
    liquidGuidePoints,
    bundleGuidePoints,
    startBundleConnection,
    endBundleConnection,
    centerSpacingMm,
    bendRadiusMm,
  } = options;
  
  const isFieldPipeStart = startBundleConnection?.connectionKind === 'field-pipe';
  const isUnitPortStart = startBundleConnection?.connectionKind === 'unit-port';
  const preserveFieldStartSegment = Boolean(startBundleConnection);

  // Simplify guide paths
  const simplifiedBundleGuidePoints = simplifyNearlyCollinearPoints(
    bundleGuidePoints,
    { preserveFirstSegment: preserveFieldStartSegment },
  );

  // For FIELD-PIPE connections: Use a simple approach -
  // Translate the bundle center route to align with gas/liquid outlet centers.
  // This ensures the pipe centerline passes through the branch kit outlet center.
  if (isFieldPipeStart && startBundleConnection && simplifiedBundleGuidePoints.length >= 1) {
    const roundedBundleCenter = roundPolylineCorners(simplifiedBundleGuidePoints, bendRadiusMm);
    
    if (roundedBundleCenter.length >= 1) {
      const bundleStartPoint = roundedBundleCenter[0]!;
      
      // Compute translation to move bundle center route to start at gas/liquid field points
      const gasTranslation = subtract(startBundleConnection.gasFieldPoint, bundleStartPoint);
      const liquidTranslation = subtract(startBundleConnection.liquidFieldPoint, bundleStartPoint);
      
      // Translate entire route to align centerline with outlet center
      let gasRoutePoints = roundedBundleCenter.map((pt) => add(pt, gasTranslation));
      let liquidRoutePoints = roundedBundleCenter.map((pt) => add(pt, liquidTranslation));
      
      // Anchor end points if end connection exists
      if (endBundleConnection) {
        gasRoutePoints = anchorGuideRouteEnd(gasRoutePoints, endBundleConnection.gasFieldPoint);
        liquidRoutePoints = anchorGuideRouteEnd(liquidRoutePoints, endBundleConnection.liquidFieldPoint);
      }
      
      return {
        gasRoutePoints: dedupeConsecutivePoints(gasRoutePoints),
        liquidRoutePoints: dedupeConsecutivePoints(liquidRoutePoints),
      };
    }
  }

  // For UNIT-PORT connections: Use the existing offset-based approach
  const simplifiedGasGuidePoints = simplifyNearlyCollinearPoints(
    gasGuidePoints,
    { preserveFirstSegment: preserveFieldStartSegment },
  );
  const simplifiedLiquidGuidePoints = simplifyNearlyCollinearPoints(
    liquidGuidePoints,
    { preserveFirstSegment: preserveFieldStartSegment },
  );

  // Round guides only for field-pipe starts; skip for unit-port (preserves 45-degree)
  const processedGasGuidePoints = simplifiedGasGuidePoints.length >= 1
    ? dedupeConsecutivePoints(roundPolylineCorners(simplifiedGasGuidePoints, bendRadiusMm))
    : simplifiedGasGuidePoints;
  const processedLiquidGuidePoints = simplifiedLiquidGuidePoints.length >= 1
    ? dedupeConsecutivePoints(roundPolylineCorners(simplifiedLiquidGuidePoints, bendRadiusMm))
    : simplifiedLiquidGuidePoints;

  // For unit-port starts, only keep the 45-degree takeoff segment (first 3 points)
  // from the guide. The rest comes from centerline-parallel routes for constant spacing.
  const MAX_UNIT_PORT_TAKEOFF_POINTS = 3;
  const takeoffGasGuidePoints = isUnitPortStart && processedGasGuidePoints.length > MAX_UNIT_PORT_TAKEOFF_POINTS
    ? processedGasGuidePoints.slice(0, MAX_UNIT_PORT_TAKEOFF_POINTS)
    : processedGasGuidePoints;
  const takeoffLiquidGuidePoints = isUnitPortStart && processedLiquidGuidePoints.length > MAX_UNIT_PORT_TAKEOFF_POINTS
    ? processedLiquidGuidePoints.slice(0, MAX_UNIT_PORT_TAKEOFF_POINTS)
    : processedLiquidGuidePoints;

  // Compute centerline-parallel base routes (constant spacing through bends)
  const { gasOffsetMm, liquidOffsetMm } = resolveParallelBundleOffsets(
    startBundleConnection,
    centerSpacingMm,
  );
  const sharpGasParallelBasePoints = simplifiedBundleGuidePoints.length >= 1
    ? dedupeConsecutivePoints(offsetPolyline(simplifiedBundleGuidePoints, gasOffsetMm))
    : [];
  const sharpLiquidParallelBasePoints = simplifiedBundleGuidePoints.length >= 1
    ? dedupeConsecutivePoints(offsetPolyline(simplifiedBundleGuidePoints, liquidOffsetMm))
    : [];

  const gasParallelBasePoints = sharpGasParallelBasePoints.length >= 1
    ? dedupeConsecutivePoints(roundPolylineCorners(sharpGasParallelBasePoints, bendRadiusMm))
    : [];
  const liquidParallelBasePoints = sharpLiquidParallelBasePoints.length >= 1
    ? dedupeConsecutivePoints(roundPolylineCorners(sharpLiquidParallelBasePoints, bendRadiusMm))
    : [];

  // Merge guide geometry (45-degree at start) with parallel routes (constant spacing)
  const gasParallelRoutePoints = mergeGuideRouteWithParallelRoute(
    takeoffGasGuidePoints,
    gasParallelBasePoints,
  );
  const liquidParallelRoutePoints = mergeGuideRouteWithParallelRoute(
    takeoffLiquidGuidePoints,
    liquidParallelBasePoints,
  );

  // Anchor to connection endpoints
  const anchoredGasRoutePoints = anchorGuideRouteEnd(
    anchorGuideRouteStart(
      gasParallelRoutePoints,
      startBundleConnection?.gasFieldPoint ?? null,
    ),
    endBundleConnection?.gasFieldPoint ?? null,
  );
  const anchoredLiquidRoutePoints = anchorGuideRouteEnd(
    anchorGuideRouteStart(
      liquidParallelRoutePoints,
      startBundleConnection?.liquidFieldPoint ?? null,
    ),
    endBundleConnection?.liquidFieldPoint ?? null,
  );

  // Keep unit-port drag behavior visually smooth by stabilizing curved bends
  // after endpoint anchoring. Re-anchor once more to guarantee exact endpoints.
  if (isUnitPortStart) {
    const unitPortDragBendRadiusMm = Math.max(8, bendRadiusMm * 0.65);
    const roundedAnchoredGasRoutePoints = anchoredGasRoutePoints.length >= 3
      ? dedupeConsecutivePoints(
          roundPolylineCorners(anchoredGasRoutePoints, unitPortDragBendRadiusMm),
        )
      : anchoredGasRoutePoints;
    const roundedAnchoredLiquidRoutePoints = anchoredLiquidRoutePoints.length >= 3
      ? dedupeConsecutivePoints(
          roundPolylineCorners(anchoredLiquidRoutePoints, unitPortDragBendRadiusMm),
        )
      : anchoredLiquidRoutePoints;
    return {
      gasRoutePoints: anchorGuideRouteEnd(
        anchorGuideRouteStart(
          roundedAnchoredGasRoutePoints,
          startBundleConnection?.gasFieldPoint ?? null,
        ),
        endBundleConnection?.gasFieldPoint ?? null,
      ),
      liquidRoutePoints: anchorGuideRouteEnd(
        anchorGuideRouteStart(
          roundedAnchoredLiquidRoutePoints,
          startBundleConnection?.liquidFieldPoint ?? null,
        ),
        endBundleConnection?.liquidFieldPoint ?? null,
      ),
    };
  }

  // For non-unit-port starts, use the anchored routes directly
  // (field-pipe connections are handled above with the translation approach).
  return {
    gasRoutePoints: anchoredGasRoutePoints,
    liquidRoutePoints: anchoredLiquidRoutePoints,
  };
}

function normalizeBundleGuideRoutePoints(
  routePoints: Point2D[],
  startBundleConnection: RefrigerantPipeBundleConnection | null,
): Point2D[] {
  const dedupedRoutePoints = dedupeConsecutivePoints(routePoints);
  if (!startBundleConnection || dedupedRoutePoints.length === 0) {
    return dedupedRoutePoints;
  }

  const firstPoint = dedupedRoutePoints[0]!;
  const bundleCenterPoint = computeBundleCenter(
    startBundleConnection.gasPoint,
    startBundleConnection.liquidPoint,
  );
  const fieldBundleCenterPoint = computeBundleCenter(
    startBundleConnection.gasFieldPoint,
    startBundleConnection.liquidFieldPoint,
  );
  const isStartSnapPoint =
    Math.hypot(firstPoint.x - startBundleConnection.gasPoint.x, firstPoint.y - startBundleConnection.gasPoint.y) <= 1
    || Math.hypot(firstPoint.x - startBundleConnection.liquidPoint.x, firstPoint.y - startBundleConnection.liquidPoint.y) <= 1
    || Math.hypot(firstPoint.x - startBundleConnection.gasFieldPoint.x, firstPoint.y - startBundleConnection.gasFieldPoint.y) <= 1
    || Math.hypot(firstPoint.x - startBundleConnection.liquidFieldPoint.x, firstPoint.y - startBundleConnection.liquidFieldPoint.y) <= 1
    || Math.hypot(firstPoint.x - bundleCenterPoint.x, firstPoint.y - bundleCenterPoint.y) <= 1
    || Math.hypot(firstPoint.x - fieldBundleCenterPoint.x, firstPoint.y - fieldBundleCenterPoint.y) <= 1;

  return isStartSnapPoint ? dedupedRoutePoints.slice(1) : dedupedRoutePoints;
}

function roundPolylineCorners(
  points: Point2D[],
  radiusMm: number,
): Point2D[] {
  if (points.length < 3 || radiusMm < 0.5) {
    return [...points];
  }

  const rounded: Point2D[] = [points[0]!];

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const next = points[index + 1]!;
    const incoming = subtract(current, previous);
    const outgoing = subtract(next, current);
    const incomingLength = Math.hypot(incoming.x, incoming.y);
    const outgoingLength = Math.hypot(outgoing.x, outgoing.y);
    if (incomingLength < 0.01 || outgoingLength < 0.01) {
      rounded.push(current);
      continue;
    }

    const incomingDirection = normalizeDirection(incoming);
    const outgoingDirection = normalizeDirection(outgoing);
    const dotValue = Math.max(-0.9999, Math.min(0.9999, dot(scale(incomingDirection, -1), outgoingDirection)));
    const interiorAngle = Math.acos(dotValue);
    if (interiorAngle < 0.2 || interiorAngle > Math.PI - 0.2) {
      rounded.push(current);
      continue;
    }

    // Use fixed tangent distance based only on radiusMm to ensure stability.
    // Adding new segments won't change how previous corners are rounded.
    const idealTangentDistance = radiusMm / Math.tan(interiorAngle / 2);
    const incomingTangentDistance = Math.min(idealTangentDistance, incomingLength * 0.45);
    const outgoingTangentDistance = Math.min(idealTangentDistance, outgoingLength * 0.45);
    // Use the smaller of the two to ensure the arc fits on both sides
    const tangentDistance = Math.min(incomingTangentDistance, outgoingTangentDistance);
    if (!Number.isFinite(tangentDistance) || tangentDistance < 0.5) {
      rounded.push(current);
      continue;
    }

    const tangentStart = subtract(current, scale(incomingDirection, tangentDistance));
    const tangentEnd = add(current, scale(outgoingDirection, tangentDistance));
    const turn = incomingDirection.x * outgoingDirection.y - incomingDirection.y * outgoingDirection.x;
    const normalSign = turn >= 0 ? 1 : -1;
    const center = lineIntersection(
      tangentStart,
      scale(perpendicular(incomingDirection), normalSign),
      tangentEnd,
      scale(perpendicular(outgoingDirection), normalSign),
    );

    if (!center) {
      rounded.push(tangentStart, tangentEnd);
      continue;
    }

    const startAngle = Math.atan2(tangentStart.y - center.y, tangentStart.x - center.x);
    const endAngle = Math.atan2(tangentEnd.y - center.y, tangentEnd.x - center.x);
    let sweepAngle = endAngle - startAngle;
    if (normalSign > 0 && sweepAngle <= 0) {
      sweepAngle += Math.PI * 2;
    } else if (normalSign < 0 && sweepAngle >= 0) {
      sweepAngle -= Math.PI * 2;
    }

    const arcRadius = Math.hypot(tangentStart.x - center.x, tangentStart.y - center.y);
    const segmentCount = Math.max(
      3,
      Math.min(8, Math.ceil((Math.abs(sweepAngle) * arcRadius) / Math.max(10, radiusMm * 0.75))),
    );

    rounded.push(tangentStart);
    for (let segment = 1; segment < segmentCount; segment += 1) {
      const progress = segment / segmentCount;
      const angle = startAngle + sweepAngle * progress;
      rounded.push({
        x: center.x + Math.cos(angle) * arcRadius,
        y: center.y + Math.sin(angle) * arcRadius,
      });
    }
    rounded.push(tangentEnd);
  }

  rounded.push(points[points.length - 1]!);
  return dedupeConsecutivePoints(rounded);
}

function computeLocalStub(
  absoluteStart: Point2D | null,
  absoluteEnd: Point2D | null,
  boundsCenter: Point2D,
): { start: Point2D; end: Point2D } | null {
  if (!absoluteStart || !absoluteEnd) {
    return null;
  }
  return {
    start: subtract(absoluteStart, boundsCenter),
    end: subtract(absoluteEnd, boundsCenter),
  };
}

function buildContinuousConnectionPolyline(
  stub: { start: Point2D; end: Point2D } | null,
  points: Point2D[],
): Point2D[] {
  if (!stub) {
    return dedupeConsecutivePoints(points);
  }

  const continuousPoints: Point2D[] = [stub.start, stub.end];
  if (points.length === 0) {
    return dedupeConsecutivePoints(continuousPoints);
  }

  const firstPoint = points[0]!;
  continuousPoints.push(
    ...(
      pointsNearlyEqual(firstPoint, stub.end, 0.2)
        ? points.slice(1)
        : points
    ),
  );
  return dedupeConsecutivePoints(continuousPoints);
}

function buildContinuousOuterConnectionPolyline(
  stub: { start: Point2D; end: Point2D } | null,
  points: Point2D[],
): Point2D[] {
  if (!stub) {
    return dedupeConsecutivePoints(points);
  }

  if (points.length === 0) {
    return [stub.end];
  }

  const firstPoint = points[0]!;
  return dedupeConsecutivePoints(
    pointsNearlyEqual(firstPoint, stub.end, 0.2)
      ? points
      : [stub.end, ...points],
  );
}

export function buildRefrigerantPipeVisual(
  element: Pick<HvacElement, 'position' | 'width' | 'depth' | 'properties'> & { elevation?: number },
  contextElements?: HvacPipeSnapSource[],
): RefrigerantPipeVisualSpec {
  const spec = resolveRefrigerantPipeSpec(element.properties, contextElements);
  const outerRadiusMm = spec.outerDiameterMm / 2;
  const coreRadiusMm = spec.pipeDiameterMm / 2;
  const baseElevationMm = isFiniteNumber(element.elevation) ? element.elevation : 0;
  const isUnitPortStartConnection = spec.startConnection?.connectionKind === 'unit-port';
  const isFieldPipeStartConnection = spec.startConnection?.connectionKind === 'field-pipe';
  const isUnitPortEndConnection = spec.endConnection?.connectionKind === 'unit-port';
  const isFieldPipeEndConnection = spec.endConnection?.connectionKind === 'field-pipe';
  const hasStartConnection = Boolean(spec.startConnection);
  const hasEndConnection = Boolean(spec.endConnection);
  const localZMm = spec.startConnection
    ? spec.startConnection.elevationMm - baseElevationMm
    : spec.endConnection
      ? spec.endConnection.elevationMm - baseElevationMm
    : outerRadiusMm;
  const connectionOverlapMm = hasStartConnection || hasEndConnection
    ? computeConnectionOverlapLength(spec.outerDiameterMm)
    : 0;
  // For unit-port connections, start/end the insulation exactly at the
  // rendered unit port endpoint. Adding an extra exposed tail here creates
  // the false "second snap" look and leaves a visible gap after moves.
  const startExposedTailLengthMm = 0;
  const endExposedTailLengthMm = 0;
  const normalizedRoutePoints = simplifyNearlyCollinearPoints(spec.routePoints);
  const segmentPathSpecs = buildRefrigerantPipeSegmentPaths(
    normalizedRoutePoints,
    spec.segmentMaterials,
  );
  const renderedRoutePoints = dedupeConsecutivePoints(
    segmentPathSpecs.flatMap((segment, index) =>
      index === 0 ? segment.points : segment.points.slice(1),
    ),
  );
  const insulationStartPoint =
    spec.startConnection && (isUnitPortStartConnection || isFieldPipeStartConnection)
    ? add(spec.startConnection.portPoint, scale(spec.startConnection.direction, startExposedTailLengthMm))
    : null;
  const insulationEndPoint =
    spec.endConnection && (isUnitPortEndConnection || isFieldPipeEndConnection)
      ? add(spec.endConnection.portPoint, scale(spec.endConnection.direction, endExposedTailLengthMm))
      : null;
  const routeStartPoint = insulationStartPoint
    ?? renderedRoutePoints[0]
    ?? null;
  const routeEndPoint = insulationEndPoint
    ?? renderedRoutePoints[renderedRoutePoints.length - 1]
    ?? null;
  const adjustedSegmentPathSpecs = segmentPathSpecs.map((segment) => ({
    ...segment,
    points: [...segment.points],
  }));
  if (adjustedSegmentPathSpecs.length > 0) {
    const firstSegment = adjustedSegmentPathSpecs[0]!;
    const lastSegment = adjustedSegmentPathSpecs[adjustedSegmentPathSpecs.length - 1]!;
    if (routeStartPoint && !pointsNearlyEqual(routeStartPoint, firstSegment.points[0]!)) {
      const shouldReplaceLeadingPortPoint = Boolean(
        spec.startConnection &&
          pointsNearlyEqual(firstSegment.points[0]!, spec.startConnection.portPoint),
      );
      firstSegment.points = shouldReplaceLeadingPortPoint
        ? [routeStartPoint, ...firstSegment.points.slice(1)]
        : [routeStartPoint, ...firstSegment.points];
    }
    const lastSegmentEnd = lastSegment.points[lastSegment.points.length - 1]!;
    if (insulationEndPoint && !pointsNearlyEqual(insulationEndPoint, lastSegmentEnd)) {
      lastSegment.points = [...lastSegment.points, insulationEndPoint];
    }
  } else if (
    routeStartPoint &&
    routeEndPoint &&
    !pointsNearlyEqual(routeStartPoint, routeEndPoint)
  ) {
    adjustedSegmentPathSpecs.push({
      index: 0,
      material: normalizePipeMaterial(spec.segmentMaterials[0], 'flexible'),
      invalidHardGeometry: false,
      points: [routeStartPoint, routeEndPoint],
      lengthMm: Math.hypot(routeEndPoint.x - routeStartPoint.x, routeEndPoint.y - routeStartPoint.y),
    });
  }

  const outerPolylinePoints = dedupeConsecutivePoints(
    adjustedSegmentPathSpecs.flatMap((segment, index) =>
      index === 0 ? segment.points : segment.points.slice(1),
    ),
  );
  const fallbackOuterPoints = dedupeConsecutivePoints([
    ...(routeStartPoint ? [routeStartPoint] : []),
    ...(routeEndPoint && (!routeStartPoint || !pointsNearlyEqual(routeStartPoint, routeEndPoint))
      ? [routeEndPoint]
      : []),
  ]);
  const outerPoints = simplifyNearlyCollinearPoints(
    outerPolylinePoints.length >= 2 ? outerPolylinePoints : fallbackOuterPoints,
  );
  const stubStart = spec.startConnection && isUnitPortStartConnection
    ? add(spec.startConnection.portPoint, scale(spec.startConnection.direction, -connectionOverlapMm))
    : null;
  const stubEnd = spec.startConnection && isUnitPortStartConnection
    ? spec.startConnection.portPoint
    : null;
  const boundsSourcePoints = [
    ...outerPoints,
  ];
  if (spec.startConnection) {
    boundsSourcePoints.push(spec.startConnection.portPoint);
  }
  if (spec.endConnection) {
    boundsSourcePoints.push(spec.endConnection.portPoint);
  }
  if (stubStart && stubEnd) {
    boundsSourcePoints.push(stubStart, stubEnd);
  }
  if (boundsSourcePoints.length === 0) {
    boundsSourcePoints.push(
      { x: element.position.x, y: element.position.y },
      { x: element.position.x + element.width, y: element.position.y + element.depth },
    );
  }

  const bounds = computeBounds(boundsSourcePoints, Math.max(outerRadiusMm, 4) + 2);
  const stub = stubStart && stubEnd ? { start: stubStart, end: stubEnd } : null;
  const continuousOuterPoints = buildContinuousOuterConnectionPolyline(
    stub,
    outerPoints,
  );
  const segmentVisuals: RefrigerantPipeSegmentVisualSpec[] = adjustedSegmentPathSpecs
    .map((segment) => {
      const absolutePoints = dedupeConsecutivePoints(segment.points);
      if (absolutePoints.length < 2) {
        return null;
      }
      return {
        index: segment.index,
        material: segment.material,
        invalidHardGeometry: segment.invalidHardGeometry,
        points: absolutePoints,
        localPoints: absolutePoints.map((point) => subtract(point, bounds.center)),
        lengthMm: polylineLength(absolutePoints),
      };
    })
    .filter((segment): segment is RefrigerantPipeSegmentVisualSpec => Boolean(segment));
  const invalidHardSegmentCount = segmentVisuals.filter(
    (segment) => segment.invalidHardGeometry,
  ).length;
  return {
    ...spec,
    bounds,
    outerRadiusMm,
    coreRadiusMm,
    localZMm,
    outerPoints,
    localOuterPoints: outerPoints.map((point) => subtract(point, bounds.center)),
    continuousOuterPoints,
    localContinuousOuterPoints: continuousOuterPoints.map((point) =>
      subtract(point, bounds.center),
    ),
    localStub: computeLocalStub(stubStart, stubEnd, bounds.center),
    segmentVisuals,
    invalidHardSegmentCount,
  };
}

export function buildRefrigerantPipePairVisual(
  element: Pick<HvacElement, 'position' | 'width' | 'depth' | 'properties'> & { elevation?: number },
  contextElements?: HvacPipeSnapSource[],
): RefrigerantPipePairVisualSpec {
  const spec = resolveRefrigerantPipePairSpec(element.properties, contextElements);
  const gasOuterDiameterMm = spec.gasOuterDiameterMm;
  const liquidOuterDiameterMm = spec.liquidOuterDiameterMm;
  const gasOuterRadiusMm = gasOuterDiameterMm / 2;
  const liquidOuterRadiusMm = liquidOuterDiameterMm / 2;
  const gasCoreRadiusMm = spec.gasPipeDiameterMm / 2;
  const liquidCoreRadiusMm = spec.liquidPipeDiameterMm / 2;
  const baseElevationMm = isFiniteNumber(element.elevation) ? element.elevation : 0;
  const gasLocalZMm = spec.startBundleConnection
    ? spec.startBundleConnection.gasElevationMm - baseElevationMm
    : gasOuterRadiusMm;
  const liquidLocalZMm = spec.startBundleConnection
    ? spec.startBundleConnection.liquidElevationMm - baseElevationMm
    : liquidOuterRadiusMm;
  const centerSpacingMm =
    gasOuterRadiusMm + liquidOuterRadiusMm + resolvedPipeGapMm();
  const bendRadiusMm = Math.max(
    12,
    computeCompactBendRadius(
      centerSpacingMm,
      Math.max(gasOuterDiameterMm, liquidOuterDiameterMm),
    ),
  );
  const isUnitPortConnection = spec.startBundleConnection?.connectionKind === 'unit-port';
  const gasExposedTailLengthMm = 0;
  const liquidExposedTailLengthMm = 0;
  const connectionOverlapMm = computeConnectionOverlapLength(
    Math.max(gasOuterDiameterMm, liquidOuterDiameterMm),
  );
  const gasStubDirection = spec.startBundleConnection?.gasDirection ?? spec.startBundleConnection?.direction ?? null;
  const liquidStubDirection = spec.startBundleConnection?.liquidDirection ?? spec.startBundleConnection?.direction ?? null;
  const resolvedGasFieldPoint = spec.startBundleConnection
    ? spec.startBundleConnection.gasFieldPoint
    : null;
  const resolvedLiquidFieldPoint = spec.startBundleConnection
    ? spec.startBundleConnection.liquidFieldPoint
    : null;
  const startTakeoffLengthMm = computeStartTakeoffLength(
    centerSpacingMm,
    Math.max(gasOuterDiameterMm, liquidOuterDiameterMm),
  );
  const {
    gasGuidePoints,
    liquidGuidePoints,
    bundleGuidePoints,
  } = buildBundleGuideRoutes(
    spec.routePoints,
    spec.startBundleConnection,
    spec.endBundleConnection,
    centerSpacingMm,
    startTakeoffLengthMm,
  );
  const { gasRoutePoints, liquidRoutePoints } = buildResolvedPipeRoutePoints({
    gasGuidePoints,
    liquidGuidePoints,
    bundleGuidePoints,
    startBundleConnection: spec.startBundleConnection,
    endBundleConnection: spec.endBundleConnection,
    centerSpacingMm,
    bendRadiusMm,
  });
  const gasInsulationStartPoint = resolvedGasFieldPoint && spec.startBundleConnection
    ? add(
        resolvedGasFieldPoint,
        scale(spec.startBundleConnection.direction, gasExposedTailLengthMm),
      )
    : resolvedGasFieldPoint;
  const liquidInsulationStartPoint = resolvedLiquidFieldPoint && spec.startBundleConnection
    ? add(
        resolvedLiquidFieldPoint,
        scale(spec.startBundleConnection.direction, liquidExposedTailLengthMm),
      )
    : resolvedLiquidFieldPoint;

  const gasOuterPoints = gasInsulationStartPoint
    ? simplifyNearlyCollinearPoints(
        [
          gasInsulationStartPoint,
          ...stripLeadingPointIfEqual(
            gasRoutePoints,
            !pointsNearlyEqual(gasInsulationStartPoint, resolvedGasFieldPoint ?? gasInsulationStartPoint)
              ? resolvedGasFieldPoint
              : null,
          ),
        ],
        {
          preserveFirstSegment:
            spec.startBundleConnection?.connectionKind === 'field-pipe',
        },
      )
    : simplifyNearlyCollinearPoints(
        gasRoutePoints,
        {
          preserveFirstSegment:
            spec.startBundleConnection?.connectionKind === 'field-pipe',
        },
      );
  const liquidOuterPoints = liquidInsulationStartPoint
    ? simplifyNearlyCollinearPoints(
        [
          liquidInsulationStartPoint,
          ...stripLeadingPointIfEqual(
            liquidRoutePoints,
            !pointsNearlyEqual(liquidInsulationStartPoint, resolvedLiquidFieldPoint ?? liquidInsulationStartPoint)
              ? resolvedLiquidFieldPoint
              : null,
          ),
        ],
        {
          preserveFirstSegment:
            spec.startBundleConnection?.connectionKind === 'field-pipe',
        },
      )
    : simplifyNearlyCollinearPoints(
        liquidRoutePoints,
        {
          preserveFirstSegment:
            spec.startBundleConnection?.connectionKind === 'field-pipe',
        },
      );

  const boundsSourcePoints = [
    ...bundleGuidePoints,
    ...gasOuterPoints,
    ...liquidOuterPoints,
  ];
  const gasStubStart = spec.startBundleConnection && gasStubDirection && isUnitPortConnection
    ? add(
        spec.startBundleConnection.gasPoint,
        scale(gasStubDirection, -connectionOverlapMm),
      )
    : null;
  const gasStubEnd = resolvedGasFieldPoint && spec.startBundleConnection && isUnitPortConnection
    ? resolvedGasFieldPoint
    : null;
  const liquidStubStart = spec.startBundleConnection && liquidStubDirection && isUnitPortConnection
    ? add(
        spec.startBundleConnection.liquidPoint,
        scale(liquidStubDirection, -connectionOverlapMm),
      )
    : null;
  const liquidStubEnd = resolvedLiquidFieldPoint && spec.startBundleConnection && isUnitPortConnection
    ? resolvedLiquidFieldPoint
    : null;
  if (spec.startBundleConnection) {
    boundsSourcePoints.push(
      spec.startBundleConnection.gasPoint,
      spec.startBundleConnection.liquidPoint,
    );
    if (resolvedGasFieldPoint && resolvedLiquidFieldPoint) {
      boundsSourcePoints.push(resolvedGasFieldPoint, resolvedLiquidFieldPoint);
    }
    if (gasStubStart && gasStubEnd && liquidStubStart && liquidStubEnd) {
      boundsSourcePoints.push(gasStubStart, gasStubEnd, liquidStubStart, liquidStubEnd);
    }
  }
  if (boundsSourcePoints.length === 0) {
    boundsSourcePoints.push(
      { x: element.position.x, y: element.position.y },
      { x: element.position.x + element.width, y: element.position.y + element.depth },
    );
  }

  const bounds = computeBounds(
    boundsSourcePoints,
    Math.max(gasOuterRadiusMm, liquidOuterRadiusMm, 4) + 2,
  );
  const gasLocalOuterPoints = gasOuterPoints.map((point) => subtract(point, bounds.center));
  const liquidLocalOuterPoints = liquidOuterPoints.map((point) => subtract(point, bounds.center));
  const gasLocalStub = computeLocalStub(
    gasStubStart,
    gasStubEnd,
    bounds.center,
  );
  const liquidLocalStub = computeLocalStub(
    liquidStubStart,
    liquidStubEnd,
    bounds.center,
  );
  const gasStub =
    gasStubStart && gasStubEnd ? { start: gasStubStart, end: gasStubEnd } : null;
  const liquidStub =
    liquidStubStart && liquidStubEnd
      ? { start: liquidStubStart, end: liquidStubEnd }
      : null;
  const gasContinuousOuterPoints = buildContinuousOuterConnectionPolyline(
    gasStub,
    gasOuterPoints,
  );
  const liquidContinuousOuterPoints = buildContinuousOuterConnectionPolyline(
    liquidStub,
    liquidOuterPoints,
  );
  const gasContinuousCorePoints = buildContinuousConnectionPolyline(
    gasStub,
    gasOuterPoints,
  );
  const liquidContinuousCorePoints = buildContinuousConnectionPolyline(
    liquidStub,
    liquidOuterPoints,
  );

  return {
    ...spec,
    bounds,
    gasOuterDiameterMm,
    liquidOuterDiameterMm,
    gasOuterRadiusMm,
    liquidOuterRadiusMm,
    gasCoreRadiusMm,
    liquidCoreRadiusMm,
    gasLocalZMm,
    liquidLocalZMm,
    centerSpacingMm,
    gasOuterPoints,
    liquidOuterPoints,
    gasContinuousOuterPoints,
    liquidContinuousOuterPoints,
    gasLocalOuterPoints,
    liquidLocalOuterPoints,
    gasLocalContinuousOuterPoints: gasContinuousOuterPoints.map((point) =>
      subtract(point, bounds.center),
    ),
    liquidLocalContinuousOuterPoints: liquidContinuousOuterPoints.map((point) =>
      subtract(point, bounds.center),
    ),
    gasContinuousCorePoints,
    liquidContinuousCorePoints,
    gasLocalContinuousCorePoints: gasContinuousCorePoints.map((point) =>
      subtract(point, bounds.center),
    ),
    liquidLocalContinuousCorePoints: liquidContinuousCorePoints.map((point) =>
      subtract(point, bounds.center),
    ),
    gasLocalStub,
    liquidLocalStub,
  };
}

export function buildRefrigerantPipeElement(
  routePoints: Point2D[],
  options: {
    label?: string;
    lineKind: RefrigerantPipeLineKind;
    segmentMaterialMode?: RefrigerantPipeMaterial;
    segmentMaterials?: RefrigerantPipeMaterial[];
    pipeDiameterMm: number;
    outerDiameterMm: number;
    insulationThicknessMm?: number;
    bundleId?: string;
    startConnection?: RefrigerantPipeConnection | null;
    endConnection?: RefrigerantPipeConnection | null;
    elevationMm?: number;
  },
): Omit<Partial<HvacElement>, 'id'> &
  Pick<HvacElement, 'type' | 'position' | 'width' | 'depth' | 'height' | 'elevation' | 'mountType' | 'label'> {
  const resolvedInsulationThicknessMm =
    options.insulationThicknessMm ?? DEFAULT_REFRIGERANT_PIPE_INSULATION_THICKNESS_MM;
  const resolvedOuterDiameterMm = resolveInsulatedOuterDiameterMm(
    options.pipeDiameterMm,
    resolvedInsulationThicknessMm,
    options.outerDiameterMm,
  );
  const outerRadiusMm = resolvedOuterDiameterMm / 2;
  const resolvedElevationMm =
    isFiniteNumber(options.elevationMm) ? options.elevationMm
      : options.startConnection
        ? options.startConnection.elevationMm - outerRadiusMm
        : options.endConnection
          ? options.endConnection.elevationMm - outerRadiusMm
        : resolvedPipeElevationMm();
  const centerlineRoutePoints = resolveCenterlinePathWithConnections(
    routePoints,
    options.startConnection ?? null,
    options.endConnection ?? null,
  );
  const centerlineSegmentCount = Math.max(0, centerlineRoutePoints.length - 1);
  const forcedSegmentMaterials = options.segmentMaterialMode
    ? Array.from(
        { length: centerlineSegmentCount },
        () => options.segmentMaterialMode,
      )
    : options.segmentMaterials;
  const segmentMaterials = normalizeSegmentMaterialArray(
    forcedSegmentMaterials,
    centerlineSegmentCount,
    {
      startConnection: options.startConnection ?? null,
      endConnection: options.endConnection ?? null,
    },
  );
  const centerlineStart = centerlineRoutePoints[0] ?? null;
  const centerlineEnd = centerlineRoutePoints[centerlineRoutePoints.length - 1] ?? null;
  const tangentStart = resolveEndpointTangent(centerlineRoutePoints, 'start');
  const tangentEnd = resolveEndpointTangent(centerlineRoutePoints, 'end');

  const properties = {
    routePoints: centerlineRoutePoints,
    pipeDiameterMm: options.pipeDiameterMm,
    outerDiameterMm: resolvedOuterDiameterMm,
    insulationThicknessMm: resolvedInsulationThicknessMm,
    lineKind: options.lineKind,
    segmentMaterials,
    bundleId: options.bundleId,
    startConnection: options.startConnection ?? null,
    endConnection: options.endConnection ?? null,
    centerline_start: centerlineStart,
    centerline_end: centerlineEnd,
    tangent_start: tangentStart,
    tangent_end: tangentEnd,
    nominal_diameter_mm: options.pipeDiameterMm,
    insulation_thickness_mm: resolvedInsulationThicknessMm,
    routing_metadata: {
      datum: 'centerline',
      continuityToleranceMm: PIPE_CENTERLINE_CONTINUITY_TOLERANCE_MM,
    },
  };
  const visual = buildRefrigerantPipeVisual({
    position: { x: 0, y: 0 },
    width: 1,
    depth: 1,
    elevation: resolvedElevationMm,
    properties,
  });

  return {
    type: 'refrigerant-pipe',
    category: 'accessory',
    subtype: options.lineKind,
    modelLabel: options.lineKind === 'gas' ? 'Gas Pipe' : 'Liquid Pipe',
    position: {
      x: visual.bounds.minX,
      y: visual.bounds.minY,
    },
    rotation: 0,
    width: visual.bounds.width,
    depth: visual.bounds.height,
    height: Math.max(1, resolvedOuterDiameterMm),
    elevation: resolvedElevationMm,
    mountType: 'ceiling',
    label: options.label ?? (options.lineKind === 'gas' ? 'Gas Pipe' : 'Liquid Pipe'),
    supplyZoneRatio: 0,
    properties,
  };
}

export function buildRefrigerantPipeElements(
  routePoints: Point2D[],
  options?: {
    gasPipeDiameterMm?: number;
    liquidPipeDiameterMm?: number;
    insulationThicknessMm?: number;
    pipeGapMm?: number;
    segmentMaterialMode?: RefrigerantPipeMaterial;
    bundleId?: string;
    startBundleConnection?: RefrigerantPipeBundleConnection | null;
    endBundleConnection?: RefrigerantPipeBundleConnection | null;
  },
): Array<
  Omit<Partial<HvacElement>, 'id'> &
  Pick<HvacElement, 'type' | 'position' | 'width' | 'depth' | 'height' | 'elevation' | 'mountType' | 'label'>
> {
  const gasPipeDiameterMm = options?.gasPipeDiameterMm ?? DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM;
  const liquidPipeDiameterMm = options?.liquidPipeDiameterMm ?? DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM;
  const insulationThicknessMm =
    options?.insulationThicknessMm ?? DEFAULT_REFRIGERANT_PIPE_INSULATION_THICKNESS_MM;
  const gasOuterDiameterMm = resolveInsulatedOuterDiameterMm(
    gasPipeDiameterMm,
    insulationThicknessMm,
  );
  const liquidOuterDiameterMm = resolveInsulatedOuterDiameterMm(
    liquidPipeDiameterMm,
    insulationThicknessMm,
  );
  const gasOuterRadiusMm = gasOuterDiameterMm / 2;
  const liquidOuterRadiusMm = liquidOuterDiameterMm / 2;
  const pipeGapMm = resolvedPipeGapMm();
  const centerSpacingMm = gasOuterRadiusMm + liquidOuterRadiusMm + pipeGapMm;
  const bendRadiusMm = Math.max(
    12,
    computeCompactBendRadius(
      centerSpacingMm,
      Math.max(gasOuterDiameterMm, liquidOuterDiameterMm),
    ),
  );
  const maxOuterDiameterMm = Math.max(gasOuterDiameterMm, liquidOuterDiameterMm);
  const startTakeoffLengthMm = computeStartTakeoffLength(centerSpacingMm, maxOuterDiameterMm);
  const {
    gasGuidePoints,
    liquidGuidePoints,
    bundleGuidePoints,
  } = buildBundleGuideRoutes(
    routePoints,
    options?.startBundleConnection ?? null,
    options?.endBundleConnection ?? null,
    centerSpacingMm,
    startTakeoffLengthMm,
  );
  const { gasRoutePoints, liquidRoutePoints } = buildResolvedPipeRoutePoints({
    gasGuidePoints,
    liquidGuidePoints,
    bundleGuidePoints,
    startBundleConnection: options?.startBundleConnection ?? null,
    endBundleConnection: options?.endBundleConnection ?? null,
    centerSpacingMm,
    bendRadiusMm,
  });
  if (options?.startBundleConnection?.connectionKind === 'field-pipe') {
    const expectedGasStart = options.startBundleConnection.gasFieldPoint;
    const expectedLiquidStart = options.startBundleConnection.liquidFieldPoint;
    const gasStart = gasRoutePoints[0];
    const liquidStart = liquidRoutePoints[0];
    if (gasStart) {
      logCenterlineDeviation(
        'gas-start-field-connection',
        expectedGasStart,
        gasStart,
        PIPE_CENTERLINE_CONTINUITY_TOLERANCE_MM,
      );
    }
    if (liquidStart) {
      logCenterlineDeviation(
        'liquid-start-field-connection',
        expectedLiquidStart,
        liquidStart,
        PIPE_CENTERLINE_CONTINUITY_TOLERANCE_MM,
      );
    }
  }

  return [
    buildRefrigerantPipeElement(gasRoutePoints, {
      lineKind: 'gas',
      label: 'Gas Pipe',
      segmentMaterialMode: options?.segmentMaterialMode,
      pipeDiameterMm: gasPipeDiameterMm,
      outerDiameterMm: gasOuterDiameterMm,
      insulationThicknessMm,
      bundleId: options?.bundleId,
      startConnection: options?.startBundleConnection
        ? {
            portPoint: options.startBundleConnection.gasPoint,
            direction:
              options.startBundleConnection.gasDirection ??
              options.startBundleConnection.direction,
            elevationMm: options.startBundleConnection.gasElevationMm,
            connectionKind: options.startBundleConnection.connectionKind,
            sourceElementId: options.startBundleConnection.sourceElementId,
          }
        : null,
      endConnection: options?.endBundleConnection
        ? {
            portPoint: options.endBundleConnection.gasPoint,
            direction:
              options.endBundleConnection.gasDirection ??
              options.endBundleConnection.direction,
            elevationMm: options.endBundleConnection.gasElevationMm,
            connectionKind: options.endBundleConnection.connectionKind,
            sourceElementId: options.endBundleConnection.sourceElementId,
          }
        : null,
    }),
    buildRefrigerantPipeElement(liquidRoutePoints, {
      lineKind: 'liquid',
      label: 'Liquid Pipe',
      segmentMaterialMode: options?.segmentMaterialMode,
      pipeDiameterMm: liquidPipeDiameterMm,
      outerDiameterMm: liquidOuterDiameterMm,
      insulationThicknessMm,
      bundleId: options?.bundleId,
      startConnection: options?.startBundleConnection
        ? {
            portPoint: options.startBundleConnection.liquidPoint,
            direction:
              options.startBundleConnection.liquidDirection ??
              options.startBundleConnection.direction,
            elevationMm: options.startBundleConnection.liquidElevationMm,
            connectionKind: options.startBundleConnection.connectionKind,
            sourceElementId: options.startBundleConnection.sourceElementId,
          }
        : null,
      endConnection: options?.endBundleConnection
        ? {
            portPoint: options.endBundleConnection.liquidPoint,
            direction:
              options.endBundleConnection.liquidDirection ??
              options.endBundleConnection.direction,
            elevationMm: options.endBundleConnection.liquidElevationMm,
            connectionKind: options.endBundleConnection.connectionKind,
            sourceElementId: options.endBundleConnection.sourceElementId,
          }
        : null,
    }),
  ];
}

export function buildRefrigerantPipePairElement(
  routePoints: Point2D[],
  options?: {
    label?: string;
    gasPipeDiameterMm?: number;
    liquidPipeDiameterMm?: number;
    insulationThicknessMm?: number;
    pipeGapMm?: number;
    startBundleConnection?: RefrigerantPipeBundleConnection | null;
    elevationMm?: number;
  },
): Omit<Partial<HvacElement>, 'id'> &
  Pick<HvacElement, 'type' | 'position' | 'width' | 'depth' | 'height' | 'elevation' | 'mountType' | 'label'> {
  const insulationThicknessMm =
    options?.insulationThicknessMm ?? DEFAULT_REFRIGERANT_PIPE_INSULATION_THICKNESS_MM;
  const gasOuterDiameterMm = resolveInsulatedOuterDiameterMm(
    options?.gasPipeDiameterMm ?? DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM,
    insulationThicknessMm,
  );
  const liquidOuterDiameterMm = resolveInsulatedOuterDiameterMm(
    options?.liquidPipeDiameterMm ?? DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM,
    insulationThicknessMm,
  );
  const gasOuterRadiusMm = gasOuterDiameterMm / 2;
  const liquidOuterRadiusMm = liquidOuterDiameterMm / 2;
  const gasCenterElevationMm = options?.startBundleConnection?.gasElevationMm;
  const liquidCenterElevationMm = options?.startBundleConnection?.liquidElevationMm;
  const resolvedElevationMm =
    isFiniteNumber(options?.elevationMm) ? options!.elevationMm
      : isFiniteNumber(gasCenterElevationMm) && isFiniteNumber(liquidCenterElevationMm)
        ? Math.min(
            gasCenterElevationMm - gasOuterRadiusMm,
            liquidCenterElevationMm - liquidOuterRadiusMm,
          )
        : options?.startBundleConnection?.elevationMm ?? resolvedPipeElevationMm();
  const resolvedHeightMm =
    isFiniteNumber(gasCenterElevationMm) && isFiniteNumber(liquidCenterElevationMm)
      ? Math.max(
          gasCenterElevationMm + gasOuterRadiusMm,
          liquidCenterElevationMm + liquidOuterRadiusMm,
        ) - resolvedElevationMm
      : Math.max(gasOuterDiameterMm, liquidOuterDiameterMm);

  const properties = {
    routePoints: dedupeConsecutivePoints(routePoints),
    gasPipeDiameterMm: options?.gasPipeDiameterMm ?? DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM,
    liquidPipeDiameterMm: options?.liquidPipeDiameterMm ?? DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM,
    gasOuterDiameterMm,
    liquidOuterDiameterMm,
    insulationThicknessMm,
    pipeGapMm: resolvedPipeGapMm(),
    startBundleConnection: options?.startBundleConnection ?? null,
  };
  const visual = buildRefrigerantPipePairVisual({
    position: { x: 0, y: 0 },
    width: 1,
    depth: 1,
    elevation: resolvedElevationMm,
    properties,
  });

  return {
    type: 'refrigerant-pipe-pair',
    category: 'accessory',
    subtype: 'refrigerant-pipe-pair',
    modelLabel: 'Refrigerant Pipe Pair',
    position: {
      x: visual.bounds.minX,
      y: visual.bounds.minY,
    },
    rotation: 0,
    width: visual.bounds.width,
    depth: visual.bounds.height,
    height: Math.max(1, resolvedHeightMm),
    elevation: resolvedElevationMm,
    mountType: 'ceiling',
    label: options?.label ?? 'Refrigerant Pipe Pair',
    supplyZoneRatio: 0,
    properties,
  };
}

function absoluteCenter(element: Pick<HvacElement, 'position' | 'width' | 'depth'>): Point2D {
  return {
    x: element.position.x + element.width / 2,
    y: element.position.y + element.depth / 2,
  };
}

interface RefrigerantPipeEndpointTarget {
  key: string;
  elementId: string;
  bundleId?: string;
  lineKind: RefrigerantPipeLineKind;
  point: Point2D;
  direction: Point2D;
  elevationMm: number;
  outerDiameterMm: number;
}

interface RefrigerantPipeStraightSegmentTarget {
  key: string;
  elementId: string;
  bundleId?: string;
  lineKind: RefrigerantPipeLineKind;
  start: Point2D;
  end: Point2D;
  direction: Point2D;
  lengthMm: number;
  elevationMm: number;
  outerDiameterMm: number;
}

interface BranchKitLineTerminalTarget {
  key: string;
  elementId: string;
  lineKind: RefrigerantBranchLineKind;
  role: RefrigerantBranchTerminalRole;
  point: Point2D;
  direction: Point2D;
  outerDiameterMm: number;
  elevationMm: number;
  snapSourceElementId?: string;
  snapProjectedDistanceMm?: number;
}

export interface RefrigerantPipeSegmentConnection {
  point: Point2D;
  direction: Point2D;
  segmentStart: Point2D;
  segmentEnd: Point2D;
  segmentLengthMm: number;
  projectedDistanceMm: number;
  lineKind: RefrigerantPipeLineKind;
  elevationMm: number;
  outerDiameterMm: number;
  sourceElementId?: string;
}

function createPipeEndpointTarget(
  element: HvacPipeSnapSource,
  spec: RefrigerantPipeSpec,
  end: 'start' | 'end',
): RefrigerantPipeEndpointTarget | null {
  const points = resolveCenterlinePathWithConnections(
    spec.routePoints,
    spec.startConnection,
    spec.endConnection,
  );
  if (points.length < 2) {
    return null;
  }
  const centerlineElevationMm = resolvePipeCenterlineElevationMm(element, spec);

  if (end === 'start') {
    const startPoint = points[0]!;
    const nextPoint = points[1]!;
    return {
      key: `${element.id}:start`,
      elementId: element.id,
      bundleId: spec.bundleId,
      lineKind: spec.lineKind,
      point: startPoint,
      direction: normalizeDirection(subtract(startPoint, nextPoint)),
      elevationMm: centerlineElevationMm,
      outerDiameterMm: spec.outerDiameterMm,
    };
  }

  const endPoint = points[points.length - 1]!;
  const previousPoint = points[points.length - 2]!;
  return {
    key: `${element.id}:end`,
    elementId: element.id,
    bundleId: spec.bundleId,
    lineKind: spec.lineKind,
    point: endPoint,
    direction: normalizeDirection(subtract(endPoint, previousPoint)),
    elevationMm: centerlineElevationMm,
    outerDiameterMm: spec.outerDiameterMm,
  };
}

function getRefrigerantPipeEndpointTargets(
  elements: HvacPipeSnapSource[],
): RefrigerantPipeEndpointTarget[] {
  const targets: RefrigerantPipeEndpointTarget[] = [];
  const ownership = new Map<string, string>();
  const connectedEndIds = new Set<string>();

  elements.forEach((element) => {
    if (element.type !== 'refrigerant-pipe') {
      return;
    }
    const spec = resolveRefrigerantPipeSpec(element.properties);
    ownership.set(`${spec.bundleId ?? element.id}|${spec.lineKind}`, element.id);
  });

  elements.forEach((element) => {
    if (element.type !== 'refrigerant-pipe') {
      return;
    }
    const spec = resolveRefrigerantPipeSpec(element.properties);
    if (
      spec.startConnection?.connectionKind !== 'field-pipe'
      || !spec.startConnection.sourceElementId
    ) {
      return;
    }
    const upstreamId = ownership.get(
      `${spec.startConnection.sourceElementId}|${spec.lineKind}`,
    );
    if (upstreamId) {
      connectedEndIds.add(upstreamId);
    }
  });

  elements.forEach((element) => {
    if (element.type !== 'refrigerant-pipe') {
      return;
    }

    const spec = resolveRefrigerantPipeSpec(element.properties);
    const endTarget = !spec.endConnection && !connectedEndIds.has(element.id)
      ? createPipeEndpointTarget(element, spec, 'end')
      : null;
    if (!spec.startConnection) {
      const startTarget = createPipeEndpointTarget(element, spec, 'start');
      if (startTarget) {
        targets.push(startTarget);
      }
    }
    if (endTarget) {
      targets.push(endTarget);
    }
  });

  return targets;
}

function getRefrigerantPipeStraightSegmentTargets(
  elements: HvacPipeSnapSource[],
): RefrigerantPipeStraightSegmentTarget[] {
  const targets: RefrigerantPipeStraightSegmentTarget[] = [];

  elements.forEach((element) => {
    if (element.type !== 'refrigerant-pipe') {
      return;
    }

    const spec = resolveRefrigerantPipeSpec(element.properties);
    const points = resolveCenterlinePathWithConnections(
      spec.routePoints,
      spec.startConnection,
      spec.endConnection,
    );
    if (points.length < 2) {
      return;
    }
    const elevationMm = resolvePipeCenterlineElevationMm(element, spec);

    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index]!;
      const end = points[index + 1]!;
      const delta = subtract(end, start);
      const lengthMm = Math.hypot(delta.x, delta.y);
      if (lengthMm < 0.01) {
        continue;
      }

      targets.push({
        key: `${element.id}:segment:${index}`,
        elementId: element.id,
        bundleId: spec.bundleId,
        lineKind: spec.lineKind,
        start,
        end,
        direction: normalizeDirection(delta),
        lengthMm,
        elevationMm,
        outerDiameterMm: spec.outerDiameterMm,
      });
    }
  });

  return targets;
}

function buildFieldPipeBundleSnapTargets(
  elements: HvacPipeSnapSource[],
): RefrigerantPipeBundleConnection[] {
  const endpointTargets = getRefrigerantPipeEndpointTargets(elements);
  const gasEndpoints = endpointTargets.filter((endpoint) => endpoint.lineKind === 'gas');
  const liquidEndpoints = endpointTargets.filter((endpoint) => endpoint.lineKind === 'liquid');

  const candidates: Array<{
    gas: RefrigerantPipeEndpointTarget;
    liquid: RefrigerantPipeEndpointTarget;
    score: number;
  }> = [];

  gasEndpoints.forEach((gasEndpoint) => {
    liquidEndpoints.forEach((liquidEndpoint) => {
      const directionDot = dot(gasEndpoint.direction, liquidEndpoint.direction);
      if (directionDot < 0.92) {
        return;
      }

      const delta = subtract(liquidEndpoint.point, gasEndpoint.point);
      const distanceMm = Math.hypot(delta.x, delta.y);
      if (distanceMm < 0.01) {
        return;
      }

      const averageDirection = normalizeDirection(add(gasEndpoint.direction, liquidEndpoint.direction));
      const lateralAlignment = Math.abs(dot(normalizeDirection(delta), averageDirection));
      if (lateralAlignment > 0.35) {
        return;
      }

      const expectedSpacingMm =
        gasEndpoint.outerDiameterMm / 2
        + liquidEndpoint.outerDiameterMm / 2
        + resolvedPipeGapMm();
      const spacingToleranceMm = Math.max(18, expectedSpacingMm * 0.4);
      const spacingErrorMm = Math.abs(distanceMm - expectedSpacingMm);
      const sharesBundleId = Boolean(
        gasEndpoint.bundleId
        && liquidEndpoint.bundleId
        && gasEndpoint.bundleId === liquidEndpoint.bundleId,
      );
      if (!sharesBundleId && spacingErrorMm > spacingToleranceMm) {
        return;
      }

      const score = spacingErrorMm + (sharesBundleId ? 0 : 200);
      candidates.push({
        gas: gasEndpoint,
        liquid: liquidEndpoint,
        score,
      });
    });
  });

  candidates.sort((a, b) => a.score - b.score);

  const usedKeys = new Set<string>();
  const targets: RefrigerantPipeBundleConnection[] = [];
  candidates.forEach(({ gas, liquid }) => {
    if (usedKeys.has(gas.key) || usedKeys.has(liquid.key)) {
      return;
    }
    usedKeys.add(gas.key);
    usedKeys.add(liquid.key);
    const direction = normalizeDirection(add(gas.direction, liquid.direction));
    targets.push({
      point: computeBundleCenter(gas.point, liquid.point),
      gasPoint: gas.point,
      liquidPoint: liquid.point,
      gasFieldPoint: gas.point,
      liquidFieldPoint: liquid.point,
      gasOuterDiameterMm: gas.outerDiameterMm,
      liquidOuterDiameterMm: liquid.outerDiameterMm,
      gasDirection: gas.direction,
      liquidDirection: liquid.direction,
      direction,
      elevationMm: (gas.elevationMm + liquid.elevationMm) / 2,
      gasElevationMm: gas.elevationMm,
      liquidElevationMm: liquid.elevationMm,
      connectionKind: 'field-pipe',
      sourceElementId: gas.bundleId ?? gas.elementId,
    });
  });

  return targets;
}

function readStringProperty(
  properties: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = properties[key];
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

function readFiniteNumberProperty(
  properties: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = properties[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function getBranchTerminalByRole(
  line: ReturnType<typeof buildRefrigerantBranchKitViewModel>['gas'],
  role: RefrigerantBranchTerminalRole,
) {
  switch (role) {
    case 'inlet':
      return line.inletTerminal;
    case 'run-outlet':
      return line.runOutletTerminal;
    case 'branch-outlet':
      return line.branchOutletTerminal;
    default:
      return null;
  }
}

function collectBranchKitLineTerminalTargets(
  element: HvacPipeSnapSource,
): BranchKitLineTerminalTarget[] {
  const lineSelection = resolveRefrigerantBranchKitLineSelection(element);
  if (lineSelection === 'both') {
    return [];
  }

  const model = buildRefrigerantBranchKitViewModel(element);
  const inlinePlacement = resolveInlineBranchKitCenter(
    element,
    lineSelection,
    model,
  );
  const center = inlinePlacement?.center ?? absoluteCenter(element);
  const rotationDeg = inlinePlacement?.rotationDeg ?? (element.rotation ?? 0);
  const line = lineSelection === 'gas' ? model.gas : model.liquid;
  const roles: RefrigerantBranchTerminalRole[] = [
    'inlet',
    'run-outlet',
    'branch-outlet',
  ];

  return roles.flatMap((role): BranchKitLineTerminalTarget[] => {
    const terminal = getBranchTerminalByRole(line, role);
    if (!terminal) {
      return [];
    }

    return [{
      key: `${element.id}:${lineSelection}:${role}`,
      elementId: element.id,
      lineKind: lineSelection,
      role,
      point: localToWorld(center, terminal.point, rotationDeg),
      direction: normalizeDirection(rotateLocalPoint(terminal.direction, rotationDeg)),
      outerDiameterMm: terminal.outerDiameterMm,
      elevationMm: element.elevation + line.centerlineZMm,
      snapSourceElementId: readStringProperty(
        element.properties,
        'branchKitSnapSourceElementId',
      ),
      snapProjectedDistanceMm: readFiniteNumberProperty(
        element.properties,
        'branchKitSnapProjectedDistanceMm',
      ),
    }];
  });
}

function buildSelfContainedBranchKitBundleTargets(
  element: HvacPipeSnapSource,
): RefrigerantPipeBundleConnection[] {
  const lineSelection = resolveRefrigerantBranchKitLineSelection(element);
  if (lineSelection !== 'both') {
    return [];
  }

  const model = buildRefrigerantBranchKitViewModel(element);
  const inlinePlacement = resolveInlineBranchKitCenter(
    element,
    lineSelection,
    model,
  );
  const center = inlinePlacement?.center ?? absoluteCenter(element);
  const rotationDeg = inlinePlacement?.rotationDeg ?? (element.rotation ?? 0);
  const roles: RefrigerantBranchTerminalRole[] = [
    'inlet',
    'run-outlet',
    'branch-outlet',
  ];

  return roles.flatMap((role): RefrigerantPipeBundleConnection[] => {
    const identity = resolveRefrigerantBranchKitConnectionIdentity({
      model,
      role,
      lineSelection,
      worldCenter: center,
      rotationDeg,
    });
    if (!identity) {
      return [];
    }

    return [{
      point: computeBundleCenter(identity.gasPoint, identity.liquidPoint),
      gasPoint: identity.gasPoint,
      liquidPoint: identity.liquidPoint,
      gasFieldPoint: identity.gasPoint,
      liquidFieldPoint: identity.liquidPoint,
      gasOuterDiameterMm: identity.gasTerminal.outerDiameterMm,
      liquidOuterDiameterMm: identity.liquidTerminal.outerDiameterMm,
      gasDirection: identity.gasDirection,
      liquidDirection: identity.liquidDirection,
      direction: identity.direction,
      elevationMm:
        element.elevation +
        (model.gas.centerlineZMm + model.liquid.centerlineZMm) / 2,
      gasElevationMm: element.elevation + model.gas.centerlineZMm,
      liquidElevationMm: element.elevation + model.liquid.centerlineZMm,
      connectionKind: 'field-pipe',
      sourceElementId: element.id,
      terminalRole: role,
    }];
  });
}

function buildPairedBranchKitBundleTargets(
  elements: HvacPipeSnapSource[],
): RefrigerantPipeBundleConnection[] {
  const terminalTargets = elements.flatMap((element) =>
    isRefrigerantBranchKitElement(element)
      ? collectBranchKitLineTerminalTargets(element)
      : [],
  );
  const gasTargets = terminalTargets.filter((target) => target.lineKind === 'gas');
  const liquidTargets = terminalTargets.filter((target) => target.lineKind === 'liquid');
  const candidates: Array<{
    gas: BranchKitLineTerminalTarget;
    liquid: BranchKitLineTerminalTarget;
    score: number;
  }> = [];

  gasTargets.forEach((gas) => {
    liquidTargets.forEach((liquid) => {
      if (gas.role !== liquid.role) {
        return;
      }

      const directionDot = dot(gas.direction, liquid.direction);
      if (directionDot < 0.92) {
        return;
      }

      const delta = subtract(liquid.point, gas.point);
      const spacingMm = Math.hypot(delta.x, delta.y);
      if (spacingMm < 0.01) {
        return;
      }

      const direction = normalizeDirection(add(gas.direction, liquid.direction));
      const lateralAlignment = Math.abs(
        dot(normalizeDirection(delta), direction),
      );
      if (lateralAlignment > 0.35) {
        return;
      }

      const expectedSpacingMm =
        gas.outerDiameterMm / 2 +
        liquid.outerDiameterMm / 2 +
        resolvedPipeGapMm();
      const maxReasonableSpacingMm = Math.max(600, expectedSpacingMm * 8);
      if (spacingMm > maxReasonableSpacingMm) {
        return;
      }

      const sharesSnappedSource = Boolean(
        gas.snapSourceElementId &&
        liquid.snapSourceElementId &&
        gas.snapSourceElementId === liquid.snapSourceElementId,
      );
      const projectedDistanceDelta =
        isFiniteNumber(gas.snapProjectedDistanceMm) &&
        isFiniteNumber(liquid.snapProjectedDistanceMm)
          ? Math.abs(gas.snapProjectedDistanceMm - liquid.snapProjectedDistanceMm)
          : 0;
      const spacingErrorMm = Math.abs(spacingMm - expectedSpacingMm);

      candidates.push({
        gas,
        liquid,
        score:
          spacingErrorMm +
          projectedDistanceDelta * 0.25 +
          (sharesSnappedSource ? 0 : 250),
      });
    });
  });

  candidates.sort((a, b) => a.score - b.score);

  const usedKeys = new Set<string>();
  const targets: RefrigerantPipeBundleConnection[] = [];
  candidates.forEach(({ gas, liquid }) => {
    if (usedKeys.has(gas.key) || usedKeys.has(liquid.key)) {
      return;
    }
    usedKeys.add(gas.key);
    usedKeys.add(liquid.key);

    const direction = normalizeDirection(add(gas.direction, liquid.direction));
    targets.push({
      point: computeBundleCenter(gas.point, liquid.point),
      gasPoint: gas.point,
      liquidPoint: liquid.point,
      gasFieldPoint: gas.point,
      liquidFieldPoint: liquid.point,
      gasOuterDiameterMm: gas.outerDiameterMm,
      liquidOuterDiameterMm: liquid.outerDiameterMm,
      gasDirection: gas.direction,
      liquidDirection: liquid.direction,
      direction,
      elevationMm: (gas.elevationMm + liquid.elevationMm) / 2,
      gasElevationMm: gas.elevationMm,
      liquidElevationMm: liquid.elevationMm,
      connectionKind: 'field-pipe',
      sourceElementId: `branch-pair:${gas.elementId}:${liquid.elementId}`,
      terminalRole: gas.role,
    });
  });

  return targets;
}

function interpolatePointOnAxis(
  axisPoint: Point2D,
  axisDirection: Point2D,
  axisScalar: number,
  targetScalar: number,
): Point2D {
  return add(axisPoint, scale(axisDirection, targetScalar - axisScalar));
}

function computeStraightBundleSegmentTargets(
  elements: HvacPipeSnapSource[],
  minimumSegmentLengthMm: number,
): RefrigerantPipeBundleSegmentConnection[] {
  const straightSegments = getRefrigerantPipeStraightSegmentTargets(elements);
  const gasSegments = straightSegments.filter((segment) => segment.lineKind === 'gas');
  const liquidSegments = straightSegments.filter((segment) => segment.lineKind === 'liquid');
  const candidates: Array<{
    gas: RefrigerantPipeStraightSegmentTarget;
    liquid: RefrigerantPipeStraightSegmentTarget;
    score: number;
  }> = [];

  gasSegments.forEach((gasSegment) => {
    liquidSegments.forEach((liquidSegment) => {
      const directionDot = dot(gasSegment.direction, liquidSegment.direction);
      if (Math.abs(directionDot) < 0.985) {
        return;
      }

      const averageDirection = directionDot >= 0
        ? normalizeDirection(add(gasSegment.direction, liquidSegment.direction))
        : gasSegment.direction;
      const gasStartScalar = dot(gasSegment.start, averageDirection);
      const gasEndScalar = dot(gasSegment.end, averageDirection);
      const liquidStartScalar = dot(liquidSegment.start, averageDirection);
      const liquidEndScalar = dot(liquidSegment.end, averageDirection);
      const gasMinScalar = Math.min(gasStartScalar, gasEndScalar);
      const gasMaxScalar = Math.max(gasStartScalar, gasEndScalar);
      const liquidMinScalar = Math.min(liquidStartScalar, liquidEndScalar);
      const liquidMaxScalar = Math.max(liquidStartScalar, liquidEndScalar);
      const overlapStartScalar = Math.max(gasMinScalar, liquidMinScalar);
      const overlapEndScalar = Math.min(gasMaxScalar, liquidMaxScalar);
      const overlapLengthMm = overlapEndScalar - overlapStartScalar;
      if (overlapLengthMm < minimumSegmentLengthMm) {
        return;
      }

      const bundleStartGasPoint = interpolatePointOnAxis(
        gasSegment.start,
        averageDirection,
        gasStartScalar,
        overlapStartScalar,
      );
      const bundleStartLiquidPoint = interpolatePointOnAxis(
        liquidSegment.start,
        averageDirection,
        liquidStartScalar,
        overlapStartScalar,
      );
      const bundleEndGasPoint = interpolatePointOnAxis(
        gasSegment.start,
        averageDirection,
        gasStartScalar,
        overlapEndScalar,
      );
      const bundleEndLiquidPoint = interpolatePointOnAxis(
        liquidSegment.start,
        averageDirection,
        liquidStartScalar,
        overlapEndScalar,
      );
      const bundleStart = computeBundleCenter(bundleStartGasPoint, bundleStartLiquidPoint);
      const bundleEnd = computeBundleCenter(bundleEndGasPoint, bundleEndLiquidPoint);
      const spacingStartMm = Math.hypot(
        bundleStartLiquidPoint.x - bundleStartGasPoint.x,
        bundleStartLiquidPoint.y - bundleStartGasPoint.y,
      );
      const spacingEndMm = Math.hypot(
        bundleEndLiquidPoint.x - bundleEndGasPoint.x,
        bundleEndLiquidPoint.y - bundleEndGasPoint.y,
      );
      const spacingMm = (spacingStartMm + spacingEndMm) / 2;
      const expectedSpacingMm =
        gasSegment.outerDiameterMm / 2 +
        liquidSegment.outerDiameterMm / 2 +
        resolvedPipeGapMm();
      const spacingToleranceMm = Math.max(18, expectedSpacingMm * 0.4);
      const spacingErrorMm = Math.abs(spacingMm - expectedSpacingMm);
      const sharesBundleId = Boolean(
        gasSegment.bundleId &&
        liquidSegment.bundleId &&
        gasSegment.bundleId === liquidSegment.bundleId,
      );
      if (!sharesBundleId && spacingErrorMm > spacingToleranceMm) {
        return;
      }

      const centerSegmentLengthMm = Math.hypot(
        bundleEnd.x - bundleStart.x,
        bundleEnd.y - bundleStart.y,
      );
      if (centerSegmentLengthMm < minimumSegmentLengthMm) {
        return;
      }

      candidates.push({
        gas: gasSegment,
        liquid: liquidSegment,
        score: spacingErrorMm + (sharesBundleId ? 0 : 200),
      });
    });
  });

  candidates.sort((a, b) => a.score - b.score);

  const usedKeys = new Set<string>();
  const targets: RefrigerantPipeBundleSegmentConnection[] = [];
  candidates.forEach(({ gas, liquid }) => {
    if (usedKeys.has(gas.key) || usedKeys.has(liquid.key)) {
      return;
    }
    usedKeys.add(gas.key);
    usedKeys.add(liquid.key);

    const directionDot = dot(gas.direction, liquid.direction);
    const direction = directionDot >= 0
      ? normalizeDirection(add(gas.direction, liquid.direction))
      : gas.direction;
    const gasStartScalar = dot(gas.start, direction);
    const gasEndScalar = dot(gas.end, direction);
    const liquidStartScalar = dot(liquid.start, direction);
    const liquidEndScalar = dot(liquid.end, direction);
    const overlapStartScalar = Math.max(
      Math.min(gasStartScalar, gasEndScalar),
      Math.min(liquidStartScalar, liquidEndScalar),
    );
    const overlapEndScalar = Math.min(
      Math.max(gasStartScalar, gasEndScalar),
      Math.max(liquidStartScalar, liquidEndScalar),
    );
    const gasPointStart = interpolatePointOnAxis(gas.start, direction, gasStartScalar, overlapStartScalar);
    const liquidPointStart = interpolatePointOnAxis(liquid.start, direction, liquidStartScalar, overlapStartScalar);
    const gasPointEnd = interpolatePointOnAxis(gas.start, direction, gasStartScalar, overlapEndScalar);
    const liquidPointEnd = interpolatePointOnAxis(liquid.start, direction, liquidStartScalar, overlapEndScalar);
    const segmentStart = computeBundleCenter(gasPointStart, liquidPointStart);
    const segmentEnd = computeBundleCenter(gasPointEnd, liquidPointEnd);
    const segmentLengthMm = Math.hypot(
      segmentEnd.x - segmentStart.x,
      segmentEnd.y - segmentStart.y,
    );
    if (segmentLengthMm < minimumSegmentLengthMm) {
      return;
    }

    targets.push({
      point: segmentStart,
      gasPoint: gasPointStart,
      liquidPoint: liquidPointStart,
      gasFieldPoint: gasPointStart,
      liquidFieldPoint: liquidPointStart,
      gasOuterDiameterMm: gas.outerDiameterMm,
      liquidOuterDiameterMm: liquid.outerDiameterMm,
      gasDirection: gas.direction,
      liquidDirection: liquid.direction,
      direction,
      elevationMm: (gas.elevationMm + liquid.elevationMm) / 2,
      gasElevationMm: gas.elevationMm,
      liquidElevationMm: liquid.elevationMm,
      connectionKind: 'field-pipe',
      sourceElementId: gas.bundleId ?? gas.elementId,
      segmentStart,
      segmentEnd,
      segmentLengthMm,
      projectedDistanceMm: 0,
    });
  });

  return targets;
}

export function getRefrigerantPipeBundleSnapTargets(
  elements: HvacPipeSnapSource[],
): RefrigerantPipeBundleConnection[] {
  const targets: RefrigerantPipeBundleConnection[] = [];

  elements.forEach((element) => {
    const unitPortTarget = resolveUnitPortBundleConnectionForElement(element);
    if (unitPortTarget) {
      targets.push(unitPortTarget);
      return;
    }

    if (isRefrigerantBranchKitElement(element)) {
      targets.push(...buildSelfContainedBranchKitBundleTargets(element));
      return;
    }
  });

  return [
    ...targets,
    ...buildPairedBranchKitBundleTargets(elements),
    ...buildFieldPipeBundleSnapTargets(elements),
  ];
}

export function findNearestRefrigerantPipeBundleTarget(
  elements: HvacPipeSnapSource[],
  point: Point2D,
  thresholdMm: number,
): RefrigerantPipeBundleConnection | null {
  const targets = getRefrigerantPipeBundleSnapTargets(elements);
  let bestTarget: RefrigerantPipeBundleConnection | null = null;
  let bestDistance = thresholdMm;

  targets.forEach((target) => {
    const gasDistance = Math.hypot(target.gasPoint.x - point.x, target.gasPoint.y - point.y);
    const liquidDistance = Math.hypot(target.liquidPoint.x - point.x, target.liquidPoint.y - point.y);
    const nearestDistance = Math.min(gasDistance, liquidDistance);
    if (nearestDistance <= bestDistance) {
      bestDistance = nearestDistance;
      bestTarget = target;
    }
  });

  return bestTarget;
}

export function findNearestRefrigerantPipeBundleSegmentTarget(
  elements: HvacPipeSnapSource[],
  point: Point2D,
  thresholdMm: number,
  options?: {
    minSegmentLengthMm?: number;
  },
): RefrigerantPipeBundleSegmentConnection | null {
  const minimumSegmentLengthMm = Math.max(
    1,
    options?.minSegmentLengthMm ?? 1,
  );
  const targets = computeStraightBundleSegmentTargets(
    elements,
    minimumSegmentLengthMm,
  );
  let bestTarget: RefrigerantPipeBundleSegmentConnection | null = null;
  let bestDistance = thresholdMm;

  targets.forEach((target) => {
    const segmentDirection = normalizeDirection(
      subtract(target.segmentEnd, target.segmentStart),
    );
    const segmentVector = subtract(target.segmentEnd, target.segmentStart);
    const segmentLengthMm = Math.max(
      Math.hypot(segmentVector.x, segmentVector.y),
      0.0001,
    );
    const projectedScalar = clamp(
      dot(subtract(point, target.segmentStart), segmentDirection),
      0,
      segmentLengthMm,
    );
    const bundlePoint = add(
      target.segmentStart,
      scale(segmentDirection, projectedScalar),
    );
    const distanceMm = Math.hypot(
      point.x - bundlePoint.x,
      point.y - bundlePoint.y,
    );
    if (distanceMm > bestDistance) {
      return;
    }

    const segmentStartScalar = dot(target.segmentStart, segmentDirection);
    const gasStartScalar = dot(target.gasPoint, segmentDirection);
    const liquidStartScalar = dot(target.liquidPoint, segmentDirection);
    const gasPoint = interpolatePointOnAxis(
      target.gasPoint,
      segmentDirection,
      gasStartScalar,
      segmentStartScalar + projectedScalar,
    );
    const liquidPoint = interpolatePointOnAxis(
      target.liquidPoint,
      segmentDirection,
      liquidStartScalar,
      segmentStartScalar + projectedScalar,
    );
    bestDistance = distanceMm;
    bestTarget = {
      ...target,
      point: bundlePoint,
      gasPoint,
      liquidPoint,
      gasFieldPoint: gasPoint,
      liquidFieldPoint: liquidPoint,
      direction: segmentDirection,
      projectedDistanceMm: projectedScalar,
    };
  });

  return bestTarget;
}

export function findNearestRefrigerantPipeSegmentTarget(
  elements: HvacPipeSnapSource[],
  point: Point2D,
  thresholdMm: number,
  options?: {
    lineKind?: RefrigerantPipeLineKind;
    minSegmentLengthMm?: number;
  },
): RefrigerantPipeSegmentConnection | null {
  const minimumSegmentLengthMm = Math.max(
    1,
    options?.minSegmentLengthMm ?? 1,
  );
  const lineKindFilter = options?.lineKind;
  const targets = getRefrigerantPipeStraightSegmentTargets(elements).filter(
    (target) =>
      (!lineKindFilter || target.lineKind === lineKindFilter) &&
      target.lengthMm >= minimumSegmentLengthMm,
  );
  let bestTarget: RefrigerantPipeSegmentConnection | null = null;
  let bestDistance = thresholdMm;

  targets.forEach((target) => {
    const projectedScalar = clamp(
      dot(subtract(point, target.start), target.direction),
      0,
      target.lengthMm,
    );
    const projectedPoint = add(
      target.start,
      scale(target.direction, projectedScalar),
    );
    const distanceMm = Math.hypot(
      point.x - projectedPoint.x,
      point.y - projectedPoint.y,
    );
    if (distanceMm > bestDistance) {
      return;
    }

    bestDistance = distanceMm;
    bestTarget = {
      point: projectedPoint,
      direction: target.direction,
      segmentStart: target.start,
      segmentEnd: target.end,
      segmentLengthMm: target.lengthMm,
      projectedDistanceMm: projectedScalar,
      lineKind: target.lineKind,
      elevationMm: target.elevationMm,
      outerDiameterMm: target.outerDiameterMm,
      sourceElementId: target.bundleId ?? target.elementId,
    };
  });

  return bestTarget;
}

function pointsWithinTolerance(a: Point2D, b: Point2D, toleranceMm = 0.01): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= toleranceMm;
}

function connectionEquals(
  left: RefrigerantPipeConnection | null,
  right: RefrigerantPipeConnection | null,
): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.connectionKind === right.connectionKind &&
    left.sourceElementId === right.sourceElementId &&
    Math.abs(left.elevationMm - right.elevationMm) <= 0.01 &&
    pointsWithinTolerance(left.portPoint, right.portPoint) &&
    pointsWithinTolerance(left.direction, right.direction)
  );
}

function bundleConnectionEquals(
  left: RefrigerantPipeBundleConnection | null,
  right: RefrigerantPipeBundleConnection | null,
): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.connectionKind === right.connectionKind &&
    left.sourceElementId === right.sourceElementId &&
    left.guideReference === right.guideReference &&
    left.terminalRole === right.terminalRole &&
    Math.abs(left.elevationMm - right.elevationMm) <= 0.01 &&
    Math.abs(left.gasElevationMm - right.gasElevationMm) <= 0.01 &&
    Math.abs(left.liquidElevationMm - right.liquidElevationMm) <= 0.01 &&
    pointsWithinTolerance(left.point, right.point) &&
    pointsWithinTolerance(left.gasPoint, right.gasPoint) &&
    pointsWithinTolerance(left.liquidPoint, right.liquidPoint) &&
    pointsWithinTolerance(left.gasFieldPoint, right.gasFieldPoint) &&
    pointsWithinTolerance(left.liquidFieldPoint, right.liquidFieldPoint) &&
    pointsWithinTolerance(left.direction, right.direction) &&
    pointsWithinTolerance(
      left.gasDirection ?? left.direction,
      right.gasDirection ?? right.direction,
    ) &&
    pointsWithinTolerance(
      left.liquidDirection ?? left.direction,
      right.liquidDirection ?? right.direction,
    )
  );
}

function isUnitPortConnectionFromSource(
  connection: RefrigerantPipeConnection | null,
  sourceElementId: string,
): boolean {
  return Boolean(
    connection &&
      connection.connectionKind === 'unit-port' &&
      connection.sourceElementId === sourceElementId,
  );
}

function isUnitPortBundleConnectionFromSource(
  connection: RefrigerantPipeBundleConnection | null,
  sourceElementId: string,
): boolean {
  return Boolean(
    connection &&
      connection.connectionKind === 'unit-port' &&
      connection.sourceElementId === sourceElementId,
  );
}

function remapRouteEndpointsForMovedConnection(
  routePoints: Point2D[],
  options: {
    previousStart?: Point2D | null;
    nextStart?: Point2D | null;
    previousEnd?: Point2D | null;
    nextEnd?: Point2D | null;
    anchorSnapRadiusMm?: number;
  },
): Point2D[] {
  if (routePoints.length === 0) {
    return routePoints;
  }

  const anchorSnapRadiusMm = options.anchorSnapRadiusMm ?? 180;
  const remapped = [...routePoints];

  if (options.previousStart && options.nextStart) {
    const delta = subtract(options.nextStart, options.previousStart);
    if (Math.hypot(delta.x, delta.y) > 0.01) {
      const firstPoint = remapped[0]!;
      const firstDistance = Math.hypot(
        firstPoint.x - options.previousStart.x,
        firstPoint.y - options.previousStart.y,
      );
      if (firstDistance <= anchorSnapRadiusMm) {
        remapped[0] = add(firstPoint, delta);
      }
    }
  }

  if (options.previousEnd && options.nextEnd && remapped.length > 1) {
    const delta = subtract(options.nextEnd, options.previousEnd);
    if (Math.hypot(delta.x, delta.y) > 0.01) {
      const lastIndex = remapped.length - 1;
      const lastPoint = remapped[lastIndex]!;
      const lastDistance = Math.hypot(
        lastPoint.x - options.previousEnd.x,
        lastPoint.y - options.previousEnd.y,
      );
      if (lastDistance <= anchorSnapRadiusMm) {
        remapped[lastIndex] = add(lastPoint, delta);
      }
    }
  }

  return remapped;
}

export function resolveRefrigerantPipeUnitPortReconnectionUpdates(
  elements: HvacElement[],
  movedSourceElement: HvacElement,
): Array<{ id: string; updates: Partial<HvacElement> }> {
  const sceneWithMovedSource = elements.map((element) =>
    element.id === movedSourceElement.id ? movedSourceElement : element,
  );
  const movedSceneSourceElement = sceneWithMovedSource.find(
    (element) => element.id === movedSourceElement.id,
  );
  const sourceBundleTarget = movedSceneSourceElement
    ? resolveUnitPortBundleConnectionForElement(movedSceneSourceElement)
    : null;

  if (!sourceBundleTarget) {
    return [];
  }

  const updates: Array<{ id: string; updates: Partial<HvacElement> }> = [];
  elements.forEach((element) => {
    if (element.type === 'refrigerant-pipe') {
      const spec = resolveRefrigerantPipeSpec(element.properties);
      const syncStart = isUnitPortConnectionFromSource(
        spec.startConnection,
        movedSourceElement.id,
      );
      const syncEnd = isUnitPortConnectionFromSource(
        spec.endConnection,
        movedSourceElement.id,
      );
      if (!syncStart && !syncEnd) {
        return;
      }

      const connectionDirection = normalizeDirection(
        (spec.lineKind === 'gas'
          ? sourceBundleTarget.gasDirection
          : sourceBundleTarget.liquidDirection) ?? sourceBundleTarget.direction,
      );
      const connectionPortPoint =
        spec.lineKind === 'gas'
          ? sourceBundleTarget.gasPoint
          : sourceBundleTarget.liquidPoint;
      const connectionElevationMm =
        spec.lineKind === 'gas'
          ? sourceBundleTarget.gasElevationMm
          : sourceBundleTarget.liquidElevationMm;
      const connectionTemplate: RefrigerantPipeConnection = {
        portPoint: { ...connectionPortPoint },
        direction: { ...connectionDirection },
        elevationMm: connectionElevationMm,
        connectionKind: 'unit-port',
        sourceElementId: movedSourceElement.id,
      };

      const nextStartConnection = syncStart
        ? connectionTemplate
        : spec.startConnection;
      const nextEndConnection = syncEnd ? connectionTemplate : spec.endConnection;
      if (
        connectionEquals(spec.startConnection, nextStartConnection) &&
        connectionEquals(spec.endConnection, nextEndConnection)
      ) {
        return;
      }
      const nextRoutePoints = remapRouteEndpointsForMovedConnection(
        spec.routePoints,
        {
          previousStart: syncStart ? spec.startConnection?.portPoint ?? null : null,
          nextStart: syncStart ? nextStartConnection?.portPoint ?? null : null,
          previousEnd: syncEnd ? spec.endConnection?.portPoint ?? null : null,
          nextEnd: syncEnd ? nextEndConnection?.portPoint ?? null : null,
          anchorSnapRadiusMm: 160,
        },
      );

      const nextProperties: Record<string, unknown> = {
        ...element.properties,
        routePoints: nextRoutePoints,
        startConnection: nextStartConnection,
        endConnection: nextEndConnection,
      };
      const nextVisual = buildRefrigerantPipeVisual({
        position: element.position,
        width: element.width,
        depth: element.depth,
        elevation: element.elevation,
        properties: nextProperties,
      });

      updates.push({
        id: element.id,
        updates: {
          position: {
            x: nextVisual.bounds.minX,
            y: nextVisual.bounds.minY,
          },
          width: nextVisual.bounds.width,
          depth: nextVisual.bounds.height,
          height: Math.max(1, nextVisual.outerRadiusMm * 2),
          properties: nextProperties,
        },
      });
      return;
    }

    if (element.type !== 'refrigerant-pipe-pair') {
      return;
    }

    const startBundleConnection = normalizeBundleConnection(
      element.properties.startBundleConnection,
    );
    const endBundleConnection = normalizeBundleConnection(
      element.properties.endBundleConnection,
    );
    const syncStart = isUnitPortBundleConnectionFromSource(
      startBundleConnection,
      movedSourceElement.id,
    );
    const syncEnd = isUnitPortBundleConnectionFromSource(
      endBundleConnection,
      movedSourceElement.id,
    );
    if (!syncStart && !syncEnd) {
      return;
    }

    const bundleConnectionTemplate: RefrigerantPipeBundleConnection = {
      ...sourceBundleTarget,
      point: { ...sourceBundleTarget.point },
      gasPoint: { ...sourceBundleTarget.gasPoint },
      liquidPoint: { ...sourceBundleTarget.liquidPoint },
      gasFieldPoint: { ...sourceBundleTarget.gasFieldPoint },
      liquidFieldPoint: { ...sourceBundleTarget.liquidFieldPoint },
      direction: { ...sourceBundleTarget.direction },
      gasDirection: sourceBundleTarget.gasDirection
        ? { ...sourceBundleTarget.gasDirection }
        : undefined,
      liquidDirection: sourceBundleTarget.liquidDirection
        ? { ...sourceBundleTarget.liquidDirection }
        : undefined,
      sourceElementId: movedSourceElement.id,
    };

    const nextStartBundleConnection = syncStart
      ? {
          ...bundleConnectionTemplate,
          guideReference:
            startBundleConnection?.guideReference ??
            bundleConnectionTemplate.guideReference,
        }
      : startBundleConnection;
    const nextEndBundleConnection = syncEnd
      ? {
          ...bundleConnectionTemplate,
          guideReference:
            endBundleConnection?.guideReference ??
            bundleConnectionTemplate.guideReference,
        }
      : endBundleConnection;
    if (
      bundleConnectionEquals(
        startBundleConnection,
        nextStartBundleConnection,
      ) &&
      bundleConnectionEquals(endBundleConnection, nextEndBundleConnection)
    ) {
      return;
    }
    const nextRoutePoints = remapRouteEndpointsForMovedConnection(
      normalizePointArray(element.properties.routePoints),
      {
        previousStart: syncStart ? startBundleConnection?.point ?? null : null,
        nextStart: syncStart ? nextStartBundleConnection?.point ?? null : null,
        previousEnd: syncEnd ? endBundleConnection?.point ?? null : null,
        nextEnd: syncEnd ? nextEndBundleConnection?.point ?? null : null,
        anchorSnapRadiusMm: 220,
      },
    );

    const nextProperties: Record<string, unknown> = {
      ...element.properties,
      routePoints: nextRoutePoints,
      startBundleConnection: nextStartBundleConnection,
      endBundleConnection: nextEndBundleConnection,
    };
    const nextVisual = buildRefrigerantPipePairVisual(
      {
        position: element.position,
        width: element.width,
        depth: element.depth,
        elevation: element.elevation,
        properties: nextProperties,
      },
      sceneWithMovedSource,
    );

    updates.push({
      id: element.id,
      updates: {
        position: {
          x: nextVisual.bounds.minX,
          y: nextVisual.bounds.minY,
        },
        width: nextVisual.bounds.width,
        depth: nextVisual.bounds.height,
        height: Math.max(
          1,
          nextVisual.gasLocalZMm + nextVisual.gasOuterRadiusMm,
          nextVisual.liquidLocalZMm + nextVisual.liquidOuterRadiusMm,
        ),
        properties: nextProperties,
      },
    });
  });

  return updates;
}
