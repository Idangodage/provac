import type { HvacElement, Point2D } from '../../../types';

import {
  buildCeilingCassetteModel,
  getCeilingCassettePipePortEndpointLocal,
} from './ceilingCassetteModel';
import { compileCopperSocketElbowRoute } from './copperSocketElbowRoute';
import { resolveCopperSocketElbowMinimumRadius, usesCopperSocketElbows } from './copperSocketElbows';
import { buildCircularFieldPipeSegments, resolveFieldPipeBendRadiusMm, resolveFieldPipeBends, type FieldPipeStraightAllowances } from './fieldPipeBends';
import {
  normalizeBypasses,
  translateBypasses,
  type PipeBypass,
} from './pipeBypass';
import {
  liftPipePlanRouteTo3d,
  normalizePipeRouteNodes3d,
  withCanonicalPipeRoute,
  type PipePlacementPoint,
} from './pipeRoute3d';
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

/**
 * Upper bound on the clear gap between the two insulated lines of one bundle
 * (mm). The gap slider caps `defaultPipeGapMm` at 300; allow a margin so a bundle
 * stays snappable across the whole configurable range.
 */
export const MAX_BUNDLE_CLEAR_GAP_MM = 320;

/**
 * Whether a gas↔liquid centre-to-centre distance reads as one bundle: from
 * touching (gap ≈ 0) up to {@link MAX_BUNDLE_CLEAR_GAP_MM}. Deliberately decoupled
 * from the *current* configured gap so changing `defaultPipeGapMm` never hides a
 * bundle's snap point — the pair a user drew at one gap must still be detected
 * after the gap is edited. Candidate ranking still favours the spacing closest to
 * the active gap; this is only the accept/reject gate for lines that do not share
 * a bundleId (a shared bundleId is always accepted).
 */
export function isPlausibleBundleSpacingMm(
  centerDistanceMm: number,
  gasOuterDiameterMm: number,
  liquidOuterDiameterMm: number,
): boolean {
  const touchingMm = gasOuterDiameterMm / 2 + liquidOuterDiameterMm / 2;
  return (
    centerDistanceMm >= Math.max(0, touchingMm - 2) &&
    centerDistanceMm <= touchingMm + MAX_BUNDLE_CLEAR_GAP_MM
  );
}

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
  /** Stable semantic identity for bundle-level consumers. */
  portId?: string;
  nodeId?: string;
  /** Per-line identities keep a coordinated bundle from collapsing onto one kit. */
  gasPortId?: string;
  liquidPortId?: string;
  gasNodeId?: string;
  liquidNodeId?: string;
  sourceElementId?: string;
  gasSourceElementId?: string;
  liquidSourceElementId?: string;
  terminalRole?: RefrigerantBranchTerminalRole;
  /**
   * Plan-space AABB of the owning unit's footprint (unit-port targets only) so
   * route builders can keep field pipes from crossing the equipment body.
   */
  sourceBoundsMm?: { minX: number; minY: number; maxX: number; maxY: number };
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

export function refrigerantBranchKitTerminalIds(
  elementId: string,
  lineKind: RefrigerantPipeLineKind,
  role: RefrigerantBranchTerminalRole,
): { portId: string; nodeId: string } {
  const identity = `${elementId}:${lineKind}:${role}`;
  return { portId: `${identity}:port`, nodeId: `${identity}:node` };
}
/**
 * Which line(s) the pipe tool lays on a single draw.
 * - `pair`   — coordinated gas + liquid pair offset from a shared centerline (default).
 * - `gas`    — a lone gas line whose centerline is the drawn route.
 * - `liquid` — a lone liquid line whose centerline is the drawn route.
 */
export type RefrigerantPipeLineMode = 'pair' | 'gas' | 'liquid';
export type RefrigerantPipeMaterial = 'hard' | 'flexible';

function routeStartDirection(
  bundle: RefrigerantPipeBundleConnection,
  lineMode: RefrigerantPipeLineMode,
): Point2D {
  if (lineMode === 'gas') {
    return normalizeDirection(bundle.gasDirection ?? bundle.direction);
  }
  if (lineMode === 'liquid') {
    return normalizeDirection(bundle.liquidDirection ?? bundle.direction);
  }
  return normalizeDirection(bundle.direction);
}

/**
 * Starts a live route with the mandatory straight copper stub for equipment
 * ports. Field-pipe/branch-kit starts intentionally remain one-point seeds so
 * their existing port topology and continuation behavior are unchanged.
 */
export function seedRefrigerantPipeRouteStart(
  startPoint: PipePlacementPoint,
  bundle: RefrigerantPipeBundleConnection | null,
  lineMode: RefrigerantPipeLineMode = 'pair',
  minimumPortStubMm: number = getActivePipeRoutingSettings().minimumPortStubMm,
): PipePlacementPoint[] {
  if (
    bundle?.connectionKind !== 'unit-port'
    || !Number.isFinite(minimumPortStubMm)
    || minimumPortStubMm <= 0
  ) {
    return [{ ...startPoint }];
  }

  const direction = routeStartDirection(bundle, lineMode);
  const anchor = lineMode === 'gas'
    ? bundle.gasPoint
    : lineMode === 'liquid'
      ? bundle.liquidPoint
      : {
          x: (bundle.gasPoint.x + bundle.liquidPoint.x) / 2,
          y: (bundle.gasPoint.y + bundle.liquidPoint.y) / 2,
        };
  const elevation = lineMode === 'gas'
    ? bundle.gasElevationMm
    : lineMode === 'liquid'
      ? bundle.liquidElevationMm
      : bundle.elevationMm;
  const start: PipePlacementPoint = {
    ...startPoint,
    x: anchor.x,
    y: anchor.y,
    z: Number.isFinite(startPoint.z) ? startPoint.z : elevation,
  };
  const stub: PipePlacementPoint = {
    x: start.x + direction.x * minimumPortStubMm,
    y: start.y + direction.y * minimumPortStubMm,
    z: start.z,
  };
  return [start, stub];
}
/**
 * Angle constraint applied to each drawn route vertex.
 * - `auto`     — material-driven (hard ⇒ 45°, flexible ⇒ free); the legacy default.
 * - `free`     — no constraint (any angle).
 * - `ortho`    — 90° only (clean L-shaped plan runs).
 * - `diagonal` — 45° increments.
 */
export type RefrigerantPipeAngleMode = 'auto' | 'free' | 'ortho' | 'diagonal';

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
  /** Stable terminal/node identity survives normalization, rebuilds and moves. */
  portId?: string;
  nodeId?: string;
  sourceElementId?: string;
  /**
   * For a `field-pipe` connection bound to a copper branch-kit port, which of
   * the kit's three ports (inlet / run-outlet / branch-outlet) this end holds —
   * so the pipe re-pins to the SAME port (not the nearest) when the kit moves or
   * the scene reloads. Mirrors {@link RefrigerantPipeBundleConnection.terminalRole}.
   */
  terminalRole?: RefrigerantBranchTerminalRole;
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
    portId?: unknown;
    nodeId?: unknown;
    gasPortId?: unknown;
    liquidPortId?: unknown;
    gasNodeId?: unknown;
    liquidNodeId?: unknown;
    sourceElementId?: unknown;
    gasSourceElementId?: unknown;
    liquidSourceElementId?: unknown;
    terminalRole?: unknown;
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
    portId: normalizeConnectionIdentity(candidate.portId),
    nodeId: normalizeConnectionIdentity(candidate.nodeId),
    gasPortId: normalizeConnectionIdentity(candidate.gasPortId),
    liquidPortId: normalizeConnectionIdentity(candidate.liquidPortId),
    gasNodeId: normalizeConnectionIdentity(candidate.gasNodeId),
    liquidNodeId: normalizeConnectionIdentity(candidate.liquidNodeId),
    sourceElementId: typeof candidate.sourceElementId === 'string' ? candidate.sourceElementId : undefined,
    gasSourceElementId: normalizeConnectionIdentity(candidate.gasSourceElementId),
    liquidSourceElementId: normalizeConnectionIdentity(candidate.liquidSourceElementId),
    terminalRole: normalizeBranchTerminalRole(candidate.terminalRole),
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

function normalizeConnectionIdentity(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function normalizeBranchTerminalRole(value: unknown): RefrigerantBranchTerminalRole | undefined {
  return value === 'inlet' || value === 'run-outlet' || value === 'branch-outlet'
    ? value
    : undefined;
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
    portId?: unknown;
    nodeId?: unknown;
    sourceElementId?: unknown;
    terminalRole?: unknown;
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
    portId: normalizeConnectionIdentity(candidate.portId),
    nodeId: normalizeConnectionIdentity(candidate.nodeId),
    sourceElementId: typeof candidate.sourceElementId === 'string' ? candidate.sourceElementId : undefined,
    terminalRole: normalizeBranchTerminalRole(candidate.terminalRole),
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
    if (!previous) {
      deduped.push(point);
      return;
    }
    const dx = previous.x - point.x; const dy = previous.y - point.y;
    // An axis already outside the tolerance proves the Euclidean distance is
    // outside too. Preserve the exact hypot decision at the boundary and for
    // nonfinite legacy inputs; ordinary sampled pipe spans need no square root.
    const separated = Number.isFinite(dx) && Number.isFinite(dy) && (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01)
      || Math.hypot(dx, dy) > 0.01;
    if (separated) deduped.push(point);
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

/**
 * Pins a route to a physical equipment port and reserves a straight first leg
 * along its outward normal. Any authored vertices inside the protected stub
 * zone are removed; the first downstream point is retained so manual and 3D
 * routes continue from the end of the compliant stub instead of being replaced.
 */
export function reserveMinimumPortStub(
  routePoints: readonly Point2D[],
  portPoint: Point2D,
  portDirection: Point2D,
  minimumPortStubMm: number = getActivePipeRoutingSettings().minimumPortStubMm,
): Point2D[] {
  const minimumMm = Number.isFinite(minimumPortStubMm)
    ? Math.max(0, minimumPortStubMm)
    : 0;
  if (minimumMm <= 0) {
    return dedupeConsecutivePoints([{ ...portPoint }, ...routePoints]);
  }

  const direction = normalizeDirection(portDirection);
  const lateral = perpendicular(direction);
  const stubEnd = add(portPoint, scale(direction, minimumMm));
  const normalized = dedupeConsecutivePoints([...routePoints]).filter(
    (point, index) => index > 0 || !pointsNearlyEqual(point, portPoint, 0.2),
  );

  // Fast path: the route already provides the compliant straight stub (takeoff
  // builders emit it). Splicing here would delete their carefully built
  // gather/fan vertices, so leave compliant routes untouched.
  const STUB_LATERAL_TOLERANCE_MM = 1;
  let compliantPrefix = 0;
  while (compliantPrefix < normalized.length) {
    const offset = subtract(normalized[compliantPrefix]!, portPoint);
    if (Math.abs(dot(offset, lateral)) > STUB_LATERAL_TOLERANCE_MM) break;
    if (dot(offset, direction) >= minimumMm - 0.2) {
      return dedupeConsecutivePoints([{ ...portPoint }, ...normalized]);
    }
    compliantPrefix += 1;
  }

  const firstBeyondStub = normalized.findIndex(
    (point) => dot(subtract(point, portPoint), direction) >= minimumMm - 0.2,
  );
  // When no vertex projects beyond the stub plane (e.g. the route sweeps
  // around the unit and approaches laterally), keep everything outside the
  // port's protective bubble instead of discarding the route.
  const tail = firstBeyondStub >= 0
    ? normalized.slice(firstBeyondStub)
    : (() => {
        const outsideBubble = normalized.filter((point) => {
          const offset = subtract(point, portPoint);
          return Math.hypot(offset.x, offset.y) >= minimumMm - 0.2;
        });
        if (outsideBubble.length > 0) return outsideBubble;
        return normalized.length > 0 ? [normalized[normalized.length - 1]!] : [];
      })();

  // Reconnect beyond the protected straight with a 45-degree fan-out when
  // space permits, or a perpendicular gather for a constrained approach.
  const tailStart = tail[0];
  const elbowPoints: Point2D[] = [];
  if (tailStart && !pointsNearlyEqual(tailStart, stubEnd, 0.2)) {
    const lateralOffsetMm = dot(subtract(tailStart, stubEnd), lateral);
    const alongOffsetMm = dot(subtract(tailStart, stubEnd), direction);
    if (Math.abs(lateralOffsetMm) > 0.2 && Math.abs(alongOffsetMm) > 0.2) {
      // Use a forward 45-degree fan-out when there is room after the reserved
      // straight. A tiny perpendicular dogleg creates cramped socket elbows.
      const advanceMm = alongOffsetMm >= Math.abs(lateralOffsetMm)
        ? Math.abs(lateralOffsetMm)
        : 0;
      elbowPoints.push(add(add(stubEnd, scale(direction, advanceMm)), scale(lateral, lateralOffsetMm)));
    }
  }

  return dedupeConsecutivePoints([
    { ...portPoint },
    stubEnd,
    ...elbowPoints,
    ...tail.filter((point, index) => index > 0 || !pointsNearlyEqual(point, stubEnd, 0.2)),
  ]);
}

/**
 * Drops the leading takeoff/weld artifacts of a route so a moved connection can
 * rebuild its port approach from scratch. Reconnection must be idempotent:
 * patching the previously patched head accumulates a staircase of stale stub
 * and elbow fragments after every equipment move. Takeoff artifacts are all
 * short legs (stub, gather, elbow); the authored field run starts at the first
 * long leg, so everything before it is regenerated by the fresh weld.
 */
function stripPortTakeoffArtifacts(
  routePoints: Point2D[],
  minKeepLegMm = 300,
): Point2D[] {
  const deduped = dedupeConsecutivePoints(routePoints);
  let index = 0;
  while (index < deduped.length - 2) {
    const legMm = Math.hypot(
      deduped[index + 1]!.x - deduped[index]!.x,
      deduped[index + 1]!.y - deduped[index]!.y,
    );
    if (legMm >= minKeepLegMm) break;
    index += 1;
  }
  return deduped.slice(index);
}

/**
 * Collapses arc-sampled bends back into single corner vertices: group segments
 * into straight runs by accumulated heading change, keep runs longer than the
 * arc-chord scale, and place one vertex at each leg-to-leg intersection.
 * (PipeStudioOverlay applies the same idea for rendering; this model-space
 * variant feeds reflow so rebuilt routes stay compact and weldable.)
 */
function sharpenPipeRouteCorners(routePoints: Point2D[]): Point2D[] {
  const cleaned = dedupeConsecutivePoints(routePoints);
  if (cleaned.length <= 3) return cleaned;

  const HEADING_TOLERANCE_RAD = 0.2;
  // Above arc-chord-run scale: heading-grouped bend-arc fragments come in runs
  // of up to ~100mm, while authored legs at reflow scale are longer.
  const MIN_LEG_MM = 120;
  type Run = { start: Point2D; end: Point2D; lengthMm: number; direction: Point2D };
  const runs: Run[] = [];
  let runStart = cleaned[0]!;
  let runEnd = cleaned[1]!;
  let runDirection = normalizeDirection(subtract(runEnd, runStart));
  let runLength = Math.hypot(runEnd.x - runStart.x, runEnd.y - runStart.y);
  for (let index = 1; index < cleaned.length - 1; index += 1) {
    const from = cleaned[index]!;
    const to = cleaned[index + 1]!;
    const segmentDirection = normalizeDirection(subtract(to, from));
    const headingDelta = Math.acos(
      Math.max(-1, Math.min(1, dot(runDirection, segmentDirection))),
    );
    if (headingDelta < HEADING_TOLERANCE_RAD) {
      runEnd = to;
      runLength += Math.hypot(to.x - from.x, to.y - from.y);
    } else {
      runs.push({ start: runStart, end: runEnd, lengthMm: runLength, direction: runDirection });
      runStart = from;
      runEnd = to;
      runDirection = segmentDirection;
      runLength = Math.hypot(to.x - from.x, to.y - from.y);
    }
  }
  runs.push({ start: runStart, end: runEnd, lengthMm: runLength, direction: runDirection });

  const legs = runs.filter((run) => run.lengthMm >= MIN_LEG_MM);
  if (legs.length < 2) return cleaned;

  const sharpened: Point2D[] = [{ ...legs[0]!.start }];
  for (let index = 0; index < legs.length - 1; index += 1) {
    const exit = legs[index]!.end;
    const entry = legs[index + 1]!.start;
    const corner = lineIntersection(
      legs[index]!.start,
      legs[index]!.direction,
      entry,
      legs[index + 1]!.direction,
    );
    // Miter limit: a near-parallel pair intersects far away — keep the arc's
    // own endpoints instead of shooting a spike kilometres off the route.
    const gapMm = Math.hypot(entry.x - exit.x, entry.y - exit.y);
    const miterLimitMm = gapMm * 4 + 60;
    if (
      corner
      && Math.hypot(corner.x - exit.x, corner.y - exit.y) <= miterLimitMm
    ) {
      sharpened.push(corner);
    } else {
      sharpened.push({ ...exit }, { ...entry });
    }
  }
  sharpened.push({ ...legs[legs.length - 1]!.end });
  return dedupeConsecutivePoints(sharpened);
}

/**
 * Minimum-bend absorption for reflowed routes, constrained so that NOTHING
 * after the second bend ever moves:
 * - A perpendicular first leg slides its entry vertex along its OWN line onto
 *   the port axis (the leg is trimmed/extended; its line and every later
 *   vertex stay fixed) — the takeoff then joins it with a single elbow.
 * - A first leg parallel to the port normal may slide onto the axis ONLY when
 *   the next leg is perpendicular to the slide, because then the second bend
 *   merely slides along its own line (trim/extend). Otherwise the leg stays
 *   put and the takeoff bridges the offset with its Z — downstream geometry
 *   is sacred.
 */
function alignReflowRouteToPortAxis(
  routePoints: Point2D[],
  portAnchor: Point2D,
  portDirection: Point2D,
): Point2D[] {
  if (routePoints.length < 2) return routePoints;
  const direction = normalizeDirection(portDirection);
  const lateral = perpendicular(direction);
  const aligned = routePoints.map((point) => ({ ...point }));
  const legDirection = normalizeDirection(subtract(aligned[1]!, aligned[0]!));
  const ALIGN_TOLERANCE = Math.cos(0.2);
  const axisAlignment = dot(legDirection, direction);
  if (axisAlignment >= ALIGN_TOLERANCE) {
    if (aligned.length < 3) return aligned;
    const nextLegDirection = normalizeDirection(subtract(aligned[2]!, aligned[1]!));
    const nextLegSlidesInPlace = Math.abs(dot(nextLegDirection, direction)) <= 0.2;
    if (!nextLegSlidesInPlace) return aligned;
    // Project each slid vertex onto the axis individually so the leg lies
    // exactly on the port line; the second bend slides along its own leg.
    for (const index of [0, 1]) {
      const lateralOffsetMm = dot(subtract(portAnchor, aligned[index]!), lateral);
      aligned[index] = add(aligned[index]!, scale(lateral, lateralOffsetMm));
    }
    return dedupeConsecutivePoints(aligned);
  }
  if (Math.abs(dot(legDirection, lateral)) >= ALIGN_TOLERANCE) {
    const entryAdvanceMm = dot(subtract(aligned[0]!, portAnchor), direction);
    aligned[0] = add(portAnchor, scale(direction, entryAdvanceMm));
    return dedupeConsecutivePoints(aligned);
  }
  return aligned;
}

/** Axial distance occupied by two tangent, equal-radius offset bends. */
function unitPortGatherAdvanceMm(displacementMm: number, radiusMm: number): number {
  const radius = Math.max(1, radiusMm);
  const angle = Math.acos(Math.max(0, 1 - Math.abs(displacementMm) / (2 * radius)));
  return 2 * radius * Math.sin(angle);
}

/** Required straight corridor from the bundle datum before its first field
 * elbow. Includes each actual socket's axial stagger, its protected straight
 * and the two tangent bends needed to reach the paired service lane. The field
 * elbow's tangent setback is NOT included; route solvers add that separately. */
export function getUnitPortApproachStraightMm(
  connection: RefrigerantPipeBundleConnection,
  centerSpacingMm: number,
  bendRadiusMm: number,
  minimumPortStubMm: number,
): number {
  const direction = normalizeDirection(connection.direction);
  const normal = perpendicular(direction);
  const bundleCenter = computeBundleCenter(connection.gasFieldPoint, connection.liquidFieldPoint);
  const offsets = resolveParallelBundleOffsets(connection, centerSpacingMm);
  return Math.max(minimumPortStubMm, ...([
    [connection.gasPoint, offsets.gasOffsetMm],
    [connection.liquidPoint, offsets.liquidOffsetMm],
  ] as const).map(([point, offset]) => {
    const displacement = offset - dot(subtract(point, bundleCenter), normal);
    const stagger = dot(subtract(point, connection.point), direction);
    return stagger + minimumPortStubMm + unitPortGatherAdvanceMm(displacement, bendRadiusMm);
  }));
}

/** Shape the socket gather once, leaving its downstream parallel lane intact. */
function roundEngineeringUnitPortApproach(
  points: Point2D[], portPoint: Point2D, portDirection: Point2D,
  minimumStraightMm: number, radiusMm: number,
): Point2D[] {
  const direction = normalizeDirection(portDirection);
  const normal = perpendicular(direction);
  const radius = Math.max(1, radiusMm);
  for (let index = 1; index < points.length - 1; index += 1) {
    const entry = points[index]!; const exit = points[index + 1]!;
    const delta = subtract(exit, entry);
    const length = Math.hypot(delta.x, delta.y);
    if (length < 1e-6) continue;
    const heading = dot(scale(delta, 1 / length), direction);
    // A substantial perpendicular run is already the main field route. Never
    // replace it with a longer gather that jumps across a real route bend.
    if (Math.abs(heading) < 1e-6 && length > radius * 2) break;
    if (heading < 1 - 1e-8) continue;
    const offset = dot(subtract(entry, portPoint), normal);
    const displacement = Math.abs(offset);
    if (displacement <= 0.2) continue;
    const angle = Math.acos(Math.max(0, 1 - displacement / (2 * radius)));
    const advance = unitPortGatherAdvanceMm(displacement, radius);
    const finishStation = minimumStraightMm + advance;
    if (dot(subtract(exit, portPoint), direction) < finishStation - 1e-6) continue;
    const sign = Math.sign(offset);
    const localPoint = (x: number, y: number) => add(portPoint, add(scale(direction, x), scale(normal, y)));
    const result = [{ ...portPoint }, localPoint(minimumStraightMm, 0)];
    const segments = arcChordCount(angle);
    for (let step = 1; step <= segments; step += 1) {
      const theta = angle * step / segments;
      result.push(localPoint(minimumStraightMm + radius * Math.sin(theta), sign * radius * (1 - Math.cos(theta))));
    }
    const middleStraight = Math.max(0, displacement - 2 * radius);
    const firstEndX = minimumStraightMm + radius * Math.sin(angle);
    const secondStartY = sign * (radius * (1 - Math.cos(angle)) + middleStraight);
    if (middleStraight > 0.2) result.push(localPoint(firstEndX, secondStartY));
    for (let step = 1; step <= segments; step += 1) {
      const theta = angle * (1 - step / segments);
      result.push(localPoint(firstEndX + radius * (Math.sin(angle) - Math.sin(theta)),
        secondStartY + sign * radius * (Math.cos(theta) - Math.cos(angle))));
    }
    return dedupeConsecutivePoints([...result, ...points.slice(index + 1)]);
  }
  return points;
}

function reserveUnitPortBundleStubs(
  routes: { gasRoutePoints: Point2D[]; liquidRoutePoints: Point2D[] },
  connection: RefrigerantPipeBundleConnection | null,
  endConnection: RefrigerantPipeBundleConnection | null = null,
  minimumBendRadiusMm?: number,
): { gasRoutePoints: Point2D[]; liquidRoutePoints: Point2D[] } {
  let { gasRoutePoints, liquidRoutePoints } = routes;
  const minimumMm = getActivePipeRoutingSettings().minimumPortStubMm;
  const reserve = (points: Point2D[], point: Point2D, direction: Point2D): Point2D[] => {
    const reserved = reserveMinimumPortStub(points, point, direction, minimumMm);
    return minimumBendRadiusMm === undefined ? reserved
      : roundEngineeringUnitPortApproach(reserved, point, direction, minimumMm, minimumBendRadiusMm);
  };
  if (connection?.connectionKind === 'unit-port') {
    gasRoutePoints = reserve(
      gasRoutePoints,
      connection.gasPoint,
      connection.gasDirection ?? connection.direction,
    );
    liquidRoutePoints = reserve(
      liquidRoutePoints,
      connection.liquidPoint,
      connection.liquidDirection ?? connection.direction,
    );
  }
  // The arriving end needs the same straight stub + orthogonal gather as the
  // start: reserve it on the reversed polyline so the final leg enters the
  // port dead-on along its normal instead of diving in diagonally.
  if (endConnection?.connectionKind === 'unit-port') {
    const reserveEnd = (points: Point2D[], portPoint: Point2D, direction: Point2D): Point2D[] =>
      reserve(
        [...points].reverse(),
        portPoint,
        direction,
      ).reverse();
    gasRoutePoints = reserveEnd(
      gasRoutePoints,
      endConnection.gasPoint,
      endConnection.gasDirection ?? endConnection.direction,
    );
    liquidRoutePoints = reserveEnd(
      liquidRoutePoints,
      endConnection.liquidPoint,
      endConnection.liquidDirection ?? endConnection.direction,
    );
  }
  return { gasRoutePoints, liquidRoutePoints };
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

  const anchored = startConnection?.connectionKind === 'unit-port'
    ? reserveMinimumPortStub(
        points,
        startConnection.portPoint,
        startConnection.direction,
      )
    : [...points];
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
  /** Keep authored hard-angle failures distinct from replaceable formed bends. */
  invalidHardRouteGeometry?: boolean;
  unresolvedFieldBends?: Array<{ corner: Point2D; reason: 'direction-reversal' | 'insufficient-straight' }>;
  points: Point2D[];
  lengthMm: number;
}

function buildRefrigerantPipeSegmentPaths(
  routePoints: Point2D[],
  segmentMaterials: RefrigerantPipeMaterial[],
  bendRadiusMm: number,
  allowances: FieldPipeStraightAllowances,
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
  const fieldRoute: Point2D[] = [dedupedRoutePoints[0]!];
  const spanOwners: number[] = [];
  for (let index = 0; index < dedupedRoutePoints.length - 1; index += 1) {
    const start = dedupedRoutePoints[index]!;
    const end = dedupedRoutePoints[index + 1]!;
    const material = normalizedMaterials[index] ?? 'flexible';
    const hardSegmentRoute = material === 'hard'
      ? buildHardSegmentRoute(start, end)
      : {
        points: [start, end],
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
      invalidHardRouteGeometry: hardSegmentRoute.invalidHardGeometry,
      points: [],
      lengthMm: 0,
    });
    for (const point of segmentPoints.slice(1)) {
      fieldRoute.push(point);
      spanOwners.push(segments.length - 1);
    }
  }

  buildCircularFieldPipeSegments(fieldRoute, bendRadiusMm, allowances).forEach((span, index) => {
    const owner = segments[spanOwners[index]!]!;
    owner.points.push(...(owner.points.length ? span.points.slice(1) : span.points));
    owner.lengthMm += span.lengthMm;
    owner.invalidHardGeometry ||= span.invalidBend;
  });
  // A successful socket elbow may replace a failed formed bend at this exact
  // corner. Retain the reason and owner so it cannot erase an unrelated
  // reversal, hard-angle failure, or another elbow's insufficient clearance.
  for (const bend of resolveFieldPipeBends(fieldRoute, bendRadiusMm, allowances)) {
    if (bend.fits || !bend.unresolvedReason) continue;
    for (const ownerIndex of new Set([spanOwners[bend.vertexIndex - 1], spanOwners[bend.vertexIndex]])) {
      const owner = ownerIndex === undefined ? undefined : segments[ownerIndex];
      if (!owner) continue;
      (owner.unresolvedFieldBends ??= []).push({ corner: fieldRoute[bend.vertexIndex]!, reason: bend.unresolvedReason });
    }
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
    // Per-element spacing is authoritative: a pair remembers the gap it was
    // drawn with (stamped into properties at creation). Fall back to the live
    // document setting only for legacy/unset elements, so changing the document
    // gap no longer drifts the spacing of pairs drawn earlier (A3).
    pipeGapMm: readNumber(properties.pipeGapMm, resolvedPipeGapMm()),
    startBundleConnection,
    endBundleConnection,
  };
}

export function translateRefrigerantPipePairProperties(
  properties: Record<string, unknown>,
  delta: Point2D,
): Record<string, unknown> {
  const spec = resolveRefrigerantPipePairSpec(properties);
  let routePoints = spec.routePoints.map((point) => add(point, delta));
  if (spec.startBundleConnection) {
    if (spec.startBundleConnection.connectionKind === 'unit-port') {
      routePoints = reserveMinimumPortStub(
        routePoints,
        spec.startBundleConnection.point,
        spec.startBundleConnection.direction,
      );
    } else if (routePoints.length > 0) {
      routePoints[0] = { ...spec.startBundleConnection.point };
    }
  }
  if (spec.endBundleConnection) {
    if (spec.endBundleConnection.connectionKind === 'unit-port') {
      routePoints = reserveMinimumPortStub(
        [...routePoints].reverse(),
        spec.endBundleConnection.point,
        spec.endBundleConnection.direction,
      ).reverse();
    } else if (routePoints.length > 0) {
      routePoints[routePoints.length - 1] = { ...spec.endBundleConnection.point };
    }
  }
  return withCanonicalPipeRoute({ properties }, routePoints, {
    startBundleConnection: spec.startBundleConnection,
    endBundleConnection: spec.endBundleConnection,
  }).properties;
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
  let routePoints = spec.routePoints.map((point) => add(point, delta));
  if (spec.startConnection) {
    if (spec.startConnection.connectionKind === 'unit-port') {
      routePoints = reserveMinimumPortStub(
        routePoints,
        spec.startConnection.portPoint,
        spec.startConnection.direction,
      );
    } else if (routePoints.length > 0) {
      routePoints[0] = { ...spec.startConnection.portPoint };
    }
  }
  if (spec.endConnection) {
    if (spec.endConnection.connectionKind === 'unit-port') {
      routePoints = reserveMinimumPortStub(
        [...routePoints].reverse(),
        spec.endConnection.portPoint,
        spec.endConnection.direction,
      ).reverse();
    } else if (routePoints.length > 0) {
      routePoints[routePoints.length - 1] = { ...spec.endConnection.portPoint };
    }
  }
  const routed = withCanonicalPipeRoute({ properties }, routePoints, {
    segmentMaterials: spec.segmentMaterials,
    startConnection: spec.startConnection,
    endConnection: spec.endConnection,
    bypasses: translateBypasses(properties.bypasses, delta),
  });
  const nextRoute = normalizePointArray(routed.properties.routePoints);
  const authoredCenterline = normalizePointArray(properties.authoredCenterlineRoute);
  return {
    ...routed.properties,
    ...(authoredCenterline.length >= 2
      ? {
          authoredCenterlineRoute: authoredCenterline.map(
            (point) => add(point, delta),
          ),
        }
      : {}),
    centerline_start: nextRoute[0] ?? properties.centerline_start,
    centerline_end: nextRoute[nextRoute.length - 1] ?? properties.centerline_end,
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

/**
 * Re-applies persisted endpoint constraints after an authored route edit.
 *
 * Plan/Konva/SVG editors manipulate the shared guide route. A connected end is
 * not free geometry: field connections remain pinned to their fitting/pipe
 * terminal, while equipment connections also retain the protected straight
 * port-normal stub. Keeping this normalization beside the pipe model prevents
 * individual editors from persisting a route that only looks compliant after
 * renderer-side healing.
 */
export function constrainRefrigerantPipeRouteForConnections(
  type: HvacElement['type'],
  properties: Record<string, unknown>,
  routePoints: readonly Point2D[],
): Point2D[] {
  let constrained = routePoints.map((point) => ({ ...point }));

  if (isRefrigerantPipeType(type)) {
    const spec = resolveRefrigerantPipeSpec(properties);
    if (spec.startConnection) {
      constrained = spec.startConnection.connectionKind === 'unit-port'
        ? reserveMinimumPortStub(
            constrained,
            spec.startConnection.portPoint,
            spec.startConnection.direction,
          )
        : constrained.map((point, index) => (
            index === 0 ? { ...spec.startConnection!.portPoint } : point
          ));
    }
    if (spec.endConnection) {
      constrained = spec.endConnection.connectionKind === 'unit-port'
        ? reserveMinimumPortStub(
            [...constrained].reverse(),
            spec.endConnection.portPoint,
            spec.endConnection.direction,
          ).reverse()
        : constrained.map((point, index) => (
            index === constrained.length - 1
              ? { ...spec.endConnection!.portPoint }
              : point
          ));
    }
    return constrained;
  }

  if (isRefrigerantPipePairType(type)) {
    const spec = resolveRefrigerantPipePairSpec(properties);
    if (spec.startBundleConnection) {
      constrained = spec.startBundleConnection.connectionKind === 'unit-port'
        ? reserveMinimumPortStub(
            constrained,
            spec.startBundleConnection.point,
            spec.startBundleConnection.direction,
          )
        : constrained.map((point, index) => (
            index === 0 ? { ...spec.startBundleConnection!.point } : point
          ));
    }
    if (spec.endBundleConnection) {
      constrained = spec.endBundleConnection.connectionKind === 'unit-port'
        ? reserveMinimumPortStub(
            [...constrained].reverse(),
            spec.endBundleConnection.point,
            spec.endBundleConnection.direction,
          ).reverse()
        : constrained.map((point, index) => (
            index === constrained.length - 1
              ? { ...spec.endBundleConnection!.point }
              : point
          ));
    }
  }

  return constrained;
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
  sourceBoundsMm?: { minX: number; minY: number; maxX: number; maxY: number };
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
      sourceBoundsMm: options.sourceBoundsMm,
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
    sourceBoundsMm: options.sourceBoundsMm,
  };
}

function elementFootprintBoundsMm(
  element: HvacPipeSnapSource,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const center = absoluteCenter(element);
  const halfWidth = element.width / 2;
  const halfDepth = element.depth / 2;
  const rotation = element.rotation ?? 0;
  const corners = [
    { x: -halfWidth, y: -halfDepth },
    { x: halfWidth, y: -halfDepth },
    { x: halfWidth, y: halfDepth },
    { x: -halfWidth, y: halfDepth },
  ].map((corner) => add(center, rotateLocalPoint(corner, rotation)));
  return {
    minX: Math.min(...corners.map((corner) => corner.x)),
    minY: Math.min(...corners.map((corner) => corner.y)),
    maxX: Math.max(...corners.map((corner) => corner.x)),
    maxY: Math.max(...corners.map((corner) => corner.y)),
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
      sourceBoundsMm: elementFootprintBoundsMm(element),
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
    sourceBoundsMm: elementFootprintBoundsMm(element),
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

/**
 * Single source of truth for an inline branch kit's world placement. Positions
 * the kit purely from its stored snap metadata (no live re-snap), so the kit
 * renders exactly where its terminals/snap-targets are — used by both the snap
 * builders here and the 2D/3D renderers (which previously each kept a divergent
 * copy that re-snapped, causing gaps where pipes meet the kit).
 */
export function resolveInlineBranchKitCenter(
  element: Pick<HvacElement, 'properties' | 'rotation'>,
  lineSelection: ReturnType<typeof resolveRefrigerantBranchKitLineSelection>,
  model: ReturnType<typeof buildRefrigerantBranchKitViewModel>,
): { center: Point2D; anchorPoint: Point2D; anchorLocal: Point2D; rotationDeg: number } | null {
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
    anchorPoint,
    anchorLocal,
    rotationDeg,
  };
}

function computeStartTakeoffLength(
  centerSpacingMm: number,
  maxOuterDiameterMm: number,
  minimumPortStubMm = 0,
  bendRadiusMm = 0,
): number {
  // The compliant stub must stay straight until the first bend STARTS, so the
  // takeoff reserves the stub plus the bend arc's tangent offset.
  return Math.max(
    54,
    centerSpacingMm + 12,
    maxOuterDiameterMm * 1.02,
    minimumPortStubMm + Math.max(0, bendRadiusMm),
  );
}

function computeCompactBendRadius(
  centerSpacingMm: number,
  maxOuterDiameterMm: number,
  requestedFactor?: number,
): number {
  return Math.max(6, maxOuterDiameterMm * 0.42, centerSpacingMm * 0.12,
    requestedFactor === undefined ? 0 : maxOuterDiameterMm * requestedFactor);
}

function explicitBendRadiusFactor(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function computeConnectionOverlapLength(maxOuterDiameterMm: number): number {
  return Math.max(2.5, Math.min(6, maxOuterDiameterMm * 0.2));
}

const END_APPROACH_CLEARANCE_MM = 120;

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
  bendRadiusMm: number,
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
  const endDir = normalizeDirection(endBundleConnection.direction);
  const endTailLengthMm = endBundleConnection.connectionKind === 'field-pipe'
    ? Math.max(0, getActivePipeRoutingSettings().defaultBranchKitClearanceMm) + Math.max(0, bendRadiusMm)
    : tailLengthMm;

  // A branch socket has its own straight requirement. Reusing a long unit
  // departure stub here can extend past an already valid final elbow and fold
  // the route back on itself. Recognize the whole inward straight, including
  // any intermediate collinear waypoints, before adding an approach point.
  if (pointsNearlyEqual(guidePoints[guidePoints.length - 1]!, endCenter, 0.2)) {
    let straightLengthMm = 0;
    let inwardAligned = true;
    for (let index = guidePoints.length - 2; index >= 0; index -= 1) {
      const delta = subtract(guidePoints[index]!, endCenter);
      const along = dot(delta, endDir);
      const lateral = subtract(delta, scale(endDir, along));
      if (Math.hypot(lateral.x, lateral.y) > 0.2) break;
      if (along < straightLengthMm - 0.2) {
        inwardAligned = false;
        break;
      }
      straightLengthMm = along;
    }
    if (inwardAligned && straightLengthMm >= endTailLengthMm - 0.2) return guidePoints;
    if (inwardAligned && straightLengthMm > 0.2 && endBundleConnection.connectionKind === 'field-pipe') {
      // A shorter existing leg still establishes the fitting's correct lane.
      // Its service-specific final elbow is extended by
      // alignFieldTerminalApproach; inserting a farther collinear vertex here
      // would introduce a reversal before that clearance correction runs.
      return guidePoints;
    }
  }

  // The approach point sits endTailLengthMm outward from endCenter along the port
  // exit direction. The segment approachPoint -> endCenter is therefore aligned
  // with the port, and offsetPolyline will offset perpendicular to it.
  const approachPoint = add(endCenter, scale(endDir, endTailLengthMm));

  const result = guidePoints.slice(0, -1);
  // A pipe arriving from the far side of the unit must swing around its body,
  // not through it: detour along the lateral side the route is already on.
  const bounds = endBundleConnection.connectionKind === 'unit-port'
    ? endBundleConnection.sourceBoundsMm
    : undefined;
  const previousPoint = result[result.length - 1];
  if (previousPoint && bounds) {
    const clearance = END_APPROACH_CLEARANCE_MM;
    const inflated = {
      minX: bounds.minX - clearance,
      minY: bounds.minY - clearance,
      maxX: bounds.maxX + clearance,
      maxY: bounds.maxY + clearance,
    };
    if (segmentIntersectsRect(previousPoint, approachPoint, inflated)) {
      // Pick the bypass side that CONTINUES the route's incoming heading —
      // bouncing back the way the route came folds the polyline onto itself
      // and the parallel offset miters explode at the reversal.
      const previousPrevious = result[result.length - 2];
      if (Math.abs(endDir.x) >= Math.abs(endDir.y)) {
        const headingY = previousPrevious ? previousPoint.y - previousPrevious.y : 0;
        const useMaxSide = Math.abs(headingY) > 1
          ? headingY > 0
          : previousPoint.y > (bounds.minY + bounds.maxY) / 2;
        const laneY = useMaxSide ? inflated.maxY : inflated.minY;
        result.push({ x: previousPoint.x, y: laneY }, { x: approachPoint.x, y: laneY });
      } else {
        const headingX = previousPrevious ? previousPoint.x - previousPrevious.x : 0;
        const useMaxSide = Math.abs(headingX) > 1
          ? headingX > 0
          : previousPoint.x > (bounds.minX + bounds.maxX) / 2;
        const laneX = useMaxSide ? inflated.maxX : inflated.minX;
        result.push({ x: laneX, y: previousPoint.y }, { x: laneX, y: approachPoint.y });
      }
    }
  }
  result.push(approachPoint, endCenter);
  return dedupeConsecutivePoints(result);
}

function segmentIntersectsRect(
  start: Point2D,
  end: Point2D,
  rect: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  // Liang-Barsky clip: the segment hits the rect iff a clipped span survives.
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let tMin = 0;
  let tMax = 1;
  const edges: Array<[number, number]> = [
    [-dx, start.x - rect.minX],
    [dx, rect.maxX - start.x],
    [-dy, start.y - rect.minY],
    [dy, rect.maxY - start.y],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      tMin = Math.max(tMin, t);
    } else {
      tMax = Math.min(tMax, t);
    }
    if (tMin > tMax) return false;
  }
  return true;
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
    // Only the point inside the takeoff zone is superseded by the straight
    // takeoff — the rest of the drawn route must survive.
    points.push(...remaining.slice(1));
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

  // The trailing pipe must leave its port with the same compliant straight
  // stub as the lead pipe (flare joints cannot bend at the casing), so the
  // 45-degree gather to bundle spacing starts only after the takeoff length.
  // Leading parallel points inside the gather region are superseded by it.
  const stubEndPoint = add(trailingConnectionPoint, scale(direction, takeoffLengthMm));
  const diagonalJoinPoint = add(
    add(stubEndPoint, scale(direction, Math.abs(lateralShiftMm))),
    scale(normal, lateralShiftMm),
  );
  const joinAdvanceMm = Math.hypot(
    diagonalJoinPoint.x - trailingConnectionPoint.x,
    diagonalJoinPoint.y - trailingConnectionPoint.y,
  );

  // Drop only the leading parallel points inside the gather region (a
  // Euclidean bubble around the port) — an axis-projection test would also
  // discard genuine route vertices when the drawn route turns away sharply.
  const points: Point2D[] = [stubEndPoint, diagonalJoinPoint];
  let firstBeyondJoin = 0;
  while (
    firstBeyondJoin < parallelLeadPoints.length
    && Math.hypot(
      parallelLeadPoints[firstBeyondJoin]!.x - trailingConnectionPoint.x,
      parallelLeadPoints[firstBeyondJoin]!.y - trailingConnectionPoint.y,
    ) <= joinAdvanceMm + 0.2
  ) {
    firstBeyondJoin += 1;
  }
  points.push(...parallelLeadPoints.slice(firstBeyondJoin));

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
  bendRadiusMm: number,
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
    bendRadiusMm,
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

/**
 * Resolve a field fitting approach from its own socket axis. Gas/liquid outlet
 * order may differ from the unit's order, so moving only the final vertex leaves
 * the preceding elbow on the other lane (sometimes inside the same-service
 * main). Replace that last elbow and its straight together. Any lateral lane
 * change happens on the preceding straight; this function never changes Z.
 */
function alignFieldTerminalApproach(
  route: Point2D[],
  endpoint: Point2D,
  outwardDirection: Point2D,
  bendRadiusMm: number,
  minimumStraightMm: number,
): Point2D[] {
  if (route.length < 3) return route;
  const outward = normalizeDirection(outwardDirection);
  const radius = Math.max(1, bendRadiusMm);
  // Arc chords are short; the substantial incoming straight identifies the
  // last elbow without depending on a fixed number of sampled curve vertices.
  let incomingIndex = -1;
  for (let index = route.length - 2; index >= 0; index -= 1) {
    const delta = subtract(route[index + 1]!, route[index]!);
    if (Math.hypot(delta.x, delta.y) < radius * 2) continue;
    if (Math.abs(dot(normalizeDirection(delta), outward)) > 0.995) continue;
    incomingIndex = index;
    break;
  }
  if (incomingIndex < 0) return route;
  const entry = route[incomingIndex]!;
  const incoming = normalizeDirection(subtract(route[incomingIndex + 1]!, entry));
  const naturalCorner = lineIntersection(entry, incoming, endpoint, outward);
  if (!naturalCorner) return route;
  const turn = Math.acos(Math.max(-1, Math.min(1, dot(incoming, scale(outward, -1)))));
  const elbowSetback = radius * Math.tan(turn / 2);
  const straight = Math.max(0, minimumStraightMm);
  const tailLength = Math.max(straight + elbowSetback, dot(subtract(naturalCorner, endpoint), outward));
  const corner = add(endpoint, scale(outward, tailLength));
  const availableAdvance = dot(subtract(corner, entry), incoming);
  const lateralDelta = subtract(subtract(corner, entry), scale(incoming, availableAdvance));
  const lateralDistance = Math.hypot(lateralDelta.x, lateralDelta.y);
  const suffix: Point2D[] = [entry];
  if (lateralDistance > 0.2) {
    // Two tangent bends gather the line before the final fitting elbow. Small
    // lateral corrections use a shallower angle to retain the physical radius.
    const rampAdvance = Math.max(lateralDistance, Math.sqrt(4 * radius * lateralDistance));
    const lead = radius * 2;
    if (availableAdvance < lead + rampAdvance + radius * 2 + elbowSetback) return route;
    const rampStart = add(entry, scale(incoming, lead));
    const rampEnd = add(add(rampStart, scale(incoming, rampAdvance)), lateralDelta);
    suffix.push(rampStart, rampEnd);
  } else if (availableAdvance <= elbowSetback) {
    return route;
  }
  suffix.push(corner, endpoint);
  return dedupeConsecutivePoints([
    ...route.slice(0, incomingIndex),
    ...roundPolylineCorners(dedupeConsecutivePoints(suffix), radius),
  ]);
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
    isUnitPortStart
      ? [computeBundleCenter(startBundleConnection.gasFieldPoint, startBundleConnection.liquidFieldPoint), ...bundleGuidePoints]
      : bundleGuidePoints,
    { preserveFirstSegment: preserveFieldStartSegment && !isUnitPortStart },
  );

  // For UNIT-PORT connections: Use the existing offset-based approach
  const simplifiedGasGuidePoints = simplifyNearlyCollinearPoints(
    gasGuidePoints,
    { preserveFirstSegment: preserveFieldStartSegment },
  );
  const simplifiedLiquidGuidePoints = simplifyNearlyCollinearPoints(
    liquidGuidePoints,
    { preserveFirstSegment: preserveFieldStartSegment },
  );

  // Non-unit guides can still provide authored fitting approaches. Unit
  // sockets connect to the intact parallel lanes below, without stitching
  // fragments of one sampled curve into another.
  const processedGasGuidePoints = simplifiedGasGuidePoints.length >= 1
    ? dedupeConsecutivePoints(roundPolylineCorners(simplifiedGasGuidePoints, bendRadiusMm))
    : simplifiedGasGuidePoints;
  const processedLiquidGuidePoints = simplifiedLiquidGuidePoints.length >= 1
    ? dedupeConsecutivePoints(roundPolylineCorners(simplifiedLiquidGuidePoints, bendRadiusMm))
    : simplifiedLiquidGuidePoints;

  // Compute centerline-parallel base routes (constant spacing through bends).
  // Round the *centerline* once, then offset both pipes from that smooth curve,
  // so gas and liquid stay perfectly parallel (concentric) through every bend —
  // no miter spikes and no independent per-line rounding that pulls them apart.
  // The centerline radius is enlarged by the pipe offset so the inner pipe keeps
  // a valid (non-inverted) arc.
  const { gasOffsetMm, liquidOffsetMm } = resolveParallelBundleOffsets(
    startBundleConnection,
    centerSpacingMm,
  );
  const maxOffsetMm = Math.max(Math.abs(gasOffsetMm), Math.abs(liquidOffsetMm));
  const centerlineBendRadiusMm = Math.max(bendRadiusMm, maxOffsetMm + bendRadiusMm);
  const gasParallelBasePoints = simplifiedBundleGuidePoints.length >= 1
    ? dedupeConsecutivePoints(
        roundAndOffsetPolyline(simplifiedBundleGuidePoints, centerlineBendRadiusMm, gasOffsetMm),
      )
    : [];
  const liquidParallelBasePoints = simplifiedBundleGuidePoints.length >= 1
    ? dedupeConsecutivePoints(
        roundAndOffsetPolyline(simplifiedBundleGuidePoints, centerlineBendRadiusMm, liquidOffsetMm),
      )
    : [];

  // Attach physical unit sockets before shaping their gather. Keep the whole
  // first parallel straight so socket clearance and elbow tangency can use it.
  // Fitting starts use the same perpendicular offsets and concentric elbows as
  // the rest of the bundle. A constant world translation aligns the first leg
  // but collapses the two lines onto each other after a quarter turn.
  const gasParallelRoutePoints = isUnitPortStart
    ? [startBundleConnection.gasFieldPoint, ...gasParallelBasePoints]
    : isFieldPipeStart
    ? gasParallelBasePoints
    : mergeGuideRouteWithParallelRoute(processedGasGuidePoints, gasParallelBasePoints);
  const liquidParallelRoutePoints = isUnitPortStart
    ? [startBundleConnection.liquidFieldPoint, ...liquidParallelBasePoints]
    : isFieldPipeStart
    ? liquidParallelBasePoints
    : mergeGuideRouteWithParallelRoute(processedLiquidGuidePoints, liquidParallelBasePoints);

  const fieldTerminal = endBundleConnection?.connectionKind === 'field-pipe'
    && endBundleConnection.terminalRole ? endBundleConnection : null;
  const minimumTerminalStraightMm = getActivePipeRoutingSettings().defaultBranchKitClearanceMm;
  const gasTerminalRoutePoints = fieldTerminal ? alignFieldTerminalApproach(
    gasParallelRoutePoints, fieldTerminal.gasFieldPoint,
    fieldTerminal.gasDirection ?? fieldTerminal.direction, bendRadiusMm, minimumTerminalStraightMm,
  ) : gasParallelRoutePoints;
  const liquidTerminalRoutePoints = fieldTerminal ? alignFieldTerminalApproach(
    liquidParallelRoutePoints, fieldTerminal.liquidFieldPoint,
    fieldTerminal.liquidDirection ?? fieldTerminal.direction, bendRadiusMm, minimumTerminalStraightMm,
  ) : liquidParallelRoutePoints;

  // Anchor to connection endpoints
  const anchoredGasRoutePoints = anchorGuideRouteEnd(
    anchorGuideRouteStart(
      gasTerminalRoutePoints,
      startBundleConnection?.gasFieldPoint ?? null,
    ),
    endBundleConnection?.gasFieldPoint ?? null,
  );
  const anchoredLiquidRoutePoints = anchorGuideRouteEnd(
    anchorGuideRouteStart(
      liquidTerminalRoutePoints,
      startBundleConnection?.liquidFieldPoint ?? null,
    ),
    endBundleConnection?.liquidFieldPoint ?? null,
  );

  // These lanes already contain sampled circular arcs. Filleting their
  // sampled chords again shrinks the joins into tiny reverse-curvature loops.
  // The final socket reservation shapes its local gather exactly once.
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

/**
 * Chords used to approximate a corner arc. Angle-based (~3.75° per chord) so a
 * bend reads equally smooth at any radius and zoom — the previous mm-based chord
 * targets collapsed a 90° elbow to ~3 chords (a visible staircase), and even a
 * coarse 7.5°/chord arc still showed faceting on the thick copper core stroke at
 * high zoom. ~24 chords across 90° keeps chord sag well under a pixel.
 */
const ARC_MAX_STEP_RAD = Math.PI / 48; // 3.75° per chord
function arcChordCount(sweepAngle: number): number {
  return Math.max(6, Math.min(96, Math.ceil(Math.abs(sweepAngle) / ARC_MAX_STEP_RAD)));
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
    const segmentCount = arcChordCount(sweepAngle);

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

/**
 * Offsets a centerline polyline by `offsetMm` while rounding its corners as TRUE
 * CONCENTRIC ARCS (same arc centre as the centerline, radius adjusted by the
 * offset). This avoids the cusp that `offsetPolyline(roundPolylineCorners(...))`
 * produces on the inner pipe — offsetting a finely-faceted arc by a distance
 * larger than its segment length self-intersects. Used to build the gas/liquid
 * pair so both lines bend smoothly and stay parallel.
 */
function roundAndOffsetPolyline(
  points: Point2D[],
  radiusMm: number,
  offsetMm: number,
): Point2D[] {
  if (points.length < 2) {
    return [...points];
  }
  if (points.length < 3 || radiusMm < 0.5) {
    return offsetPolyline(points, offsetMm);
  }

  const result: Point2D[] = [];
  const firstDirection = normalizeDirection(subtract(points[1]!, points[0]!));
  result.push(add(points[0]!, scale(perpendicular(firstDirection), offsetMm)));

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const next = points[index + 1]!;
    const incoming = subtract(current, previous);
    const outgoing = subtract(next, current);
    const incomingLength = Math.hypot(incoming.x, incoming.y);
    const outgoingLength = Math.hypot(outgoing.x, outgoing.y);
    const incomingDirection = normalizeDirection(incoming);
    const outgoingDirection = normalizeDirection(outgoing);
    // Fallback offset point (miter of the two offset legs) for corners we don't
    // round.
    const miterPoint = (() => {
      const p1 = add(current, scale(perpendicular(incomingDirection), offsetMm));
      const p2 = add(current, scale(perpendicular(outgoingDirection), offsetMm));
      return (
        lineIntersection(p1, incomingDirection, p2, outgoingDirection) ?? p1
      );
    })();
    if (incomingLength < 0.01 || outgoingLength < 0.01) {
      result.push(miterPoint);
      continue;
    }
    const dotValue = Math.max(
      -0.9999,
      Math.min(0.9999, dot(scale(incomingDirection, -1), outgoingDirection)),
    );
    const interiorAngle = Math.acos(dotValue);
    if (interiorAngle < 0.2 || interiorAngle > Math.PI - 0.2) {
      result.push(miterPoint);
      continue;
    }
    const idealTangentDistance = radiusMm / Math.tan(interiorAngle / 2);
    const tangentDistance = Math.min(
      idealTangentDistance,
      incomingLength * 0.45,
      outgoingLength * 0.45,
    );
    if (!Number.isFinite(tangentDistance) || tangentDistance < 0.5) {
      result.push(miterPoint);
      continue;
    }
    const tangentStart = subtract(current, scale(incomingDirection, tangentDistance));
    const tangentEnd = add(current, scale(outgoingDirection, tangentDistance));
    const turn =
      incomingDirection.x * outgoingDirection.y - incomingDirection.y * outgoingDirection.x;
    const normalSign = turn >= 0 ? 1 : -1;
    const center = lineIntersection(
      tangentStart,
      scale(perpendicular(incomingDirection), normalSign),
      tangentEnd,
      scale(perpendicular(outgoingDirection), normalSign),
    );
    if (!center) {
      result.push(miterPoint);
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
    // Concentric offset radius: toward the centre (normalSign side) shrinks it.
    const offsetRadius = Math.max(0.5, arcRadius - normalSign * offsetMm);
    const segmentCount = arcChordCount(sweepAngle);
    for (let segment = 0; segment <= segmentCount; segment += 1) {
      const angle = startAngle + sweepAngle * (segment / segmentCount);
      result.push({
        x: center.x + Math.cos(angle) * offsetRadius,
        y: center.y + Math.sin(angle) * offsetRadius,
      });
    }
  }

  const lastDirection = normalizeDirection(
    subtract(points[points.length - 1]!, points[points.length - 2]!),
  );
  result.push(add(points[points.length - 1]!, scale(perpendicular(lastDirection), offsetMm)));
  return dedupeConsecutivePoints(result);
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

interface PlanSocketElbowCacheEntry {
  /** Null retains the current caller's authored points identity when no fitting fits. */
  points: Point2D[] | null;
  fittedCorners: Point2D[];
  pointCount: number;
}

// Cache only this pure projection, never a visual, scene element, or its arrays.
// Independent budgets bound long sampled routes as well as many short routes.
const PLAN_SOCKET_ELBOW_CACHE_MAX_ENTRIES = 512;
const PLAN_SOCKET_ELBOW_CACHE_MAX_POINTS = 100_000;
const PLAN_SOCKET_ELBOW_CACHE_MAX_KEY_CHARS = 4_000_000;
const planSocketElbowCache = new Map<string, PlanSocketElbowCacheEntry>();
let planSocketElbowCachePointCount = 0;
let planSocketElbowCacheKeyChars = 0;

function planSocketElbowCacheKey(points: Point2D[], values: number[]): string | null {
  if (points.length > PLAN_SOCKET_ELBOW_CACHE_MAX_POINTS || !values.every(Number.isFinite)) return null;
  // Number strings round-trip exactly; distinguish -0 without rounding geometry.
  const numberKey = (value: number) => Object.is(value, -0) ? '-0' : String(value);
  let key = `${values.map(numberKey).join(',')}|`;
  for (const point of points) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    key += `${numberKey(point.x)},${numberKey(point.y)};`;
    if (key.length > PLAN_SOCKET_ELBOW_CACHE_MAX_KEY_CHARS) return null;
  }
  return key;
}

function copyPlanSocketElbowCacheEntry(entry: PlanSocketElbowCacheEntry, points: Point2D[]) {
  return {
    points: entry.points?.map(point => ({ ...point })) ?? points,
    fittedCorners: entry.fittedCorners.map(point => ({ ...point })),
  };
}

function retainPlanSocketElbowCacheEntry(key: string, entry: PlanSocketElbowCacheEntry): void {
  if (entry.pointCount > PLAN_SOCKET_ELBOW_CACHE_MAX_POINTS
    || entry.points?.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))
    || entry.fittedCorners.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return;
  while (planSocketElbowCache.size >= PLAN_SOCKET_ELBOW_CACHE_MAX_ENTRIES
    || planSocketElbowCachePointCount + entry.pointCount > PLAN_SOCKET_ELBOW_CACHE_MAX_POINTS
    || planSocketElbowCacheKeyChars + key.length > PLAN_SOCKET_ELBOW_CACHE_MAX_KEY_CHARS) {
    const oldest = planSocketElbowCache.entries().next().value;
    if (!oldest) break;
    planSocketElbowCache.delete(oldest[0]);
    planSocketElbowCachePointCount -= oldest[1].pointCount;
    planSocketElbowCacheKeyChars -= oldest[0].length;
  }
  planSocketElbowCache.set(key, entry);
  planSocketElbowCachePointCount += entry.pointCount;
  planSocketElbowCacheKeyChars += key.length;
}

/** The shared fitting compiler is authoritative in plan as well as in 3D.
 * Retain the authored route and its arbitrary terminal gathers when no actual
 * factory elbow can fit; the compiler's caller can expose those fit issues. */
function compilePlanSocketElbowPoints(
  points: Point2D[], tubeDiameterMm: number, properties: Record<string, unknown>,
  unitStart: boolean, unitEnd: boolean,
): { points: Point2D[]; fittedCorners: Point2D[] } {
  if (!usesCopperSocketElbows(properties)) return { points, fittedCorners: [] };
  const settings = getActivePipeRoutingSettings();
  // Resolve live settings on every call; only their effective compiler inputs
  // belong in the key, including persisted profile radius requirements.
  const options = {
    startStraightMm: unitStart ? settings.minimumPortStubMm : 0,
    endStraightMm: unitEnd ? settings.minimumPortStubMm : 0,
    minimumBendRadiusMm: resolveCopperSocketElbowMinimumRadius(properties),
  };
  const key = planSocketElbowCacheKey(points,
    [tubeDiameterMm, options.startStraightMm, options.endStraightMm, options.minimumBendRadiusMm]);
  const cached = key === null ? undefined : planSocketElbowCache.get(key);
  if (cached) {
    planSocketElbowCache.delete(key!);
    planSocketElbowCache.set(key!, cached);
    return copyPlanSocketElbowCacheEntry(cached, points);
  }
  const compiled = compileCopperSocketElbowRoute(points.map(point => ({ ...point, z: 0 })), tubeDiameterMm, options);
  const fittedCorners = compiled.fittings.map(fitting => ({ x: fitting.corner.x, y: fitting.corner.y }));
  const compiledPoints = compiled.fittings.length ? compiled.centerline.map(({ x, y }) => ({ x, y })) : null;
  const entry = { points: compiledPoints, fittedCorners,
    pointCount: (compiledPoints?.length ?? 0) + fittedCorners.length };
  if (key !== null) retainPlanSocketElbowCacheEntry(key, entry);
  return copyPlanSocketElbowCacheEntry(entry, points);
}

function updateResolvedFieldBendWarnings(
  segments: RefrigerantPipeSegmentPathSpec[], fittedCorners: Point2D[],
): RefrigerantPipeSegmentPathSpec[] {
  if (!fittedCorners.length) return segments;
  return segments.map(segment => !segment.unresolvedFieldBends ? segment : {
    ...segment,
    invalidHardGeometry: segment.invalidHardRouteGeometry === true || segment.unresolvedFieldBends.some(bend =>
      bend.reason !== 'insufficient-straight'
      || !fittedCorners.some(corner => Math.hypot(corner.x - bend.corner.x, corner.y - bend.corner.y) <= 1e-5)),
  });
}

/** Keep material/index ownership on the reconstructed path. A fitting can
 * straddle two authored legs, so assign its sampled edges to their nearest
 * original owned span rather than replacing every segment with one new owner. */
function transferPipeSegmentOwnership(
  points: Point2D[], original: RefrigerantPipeSegmentPathSpec[],
): RefrigerantPipeSegmentPathSpec[] {
  const spans = original.flatMap(segment => segment.points.slice(1).map((end, index) => {
    const start = segment.points[index]!;
    const dx = end.x - start.x; const dy = end.y - start.y;
    return { segment, x: start.x, y: start.y, dx, dy, squaredLength: dx * dx + dy * dy };
  }));
  const result: RefrigerantPipeSegmentPathSpec[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!; const end = points[index]!;
    const midpointX = (start.x + end.x) * 0.5;
    const midpointY = (start.y + end.y) * 0.5;
    let best = spans[0]?.segment; let bestDistance = Number.POSITIVE_INFINITY;
    for (const span of spans) {
      // This projection is evaluated for every new edge/original span pair.
      // Scalar arithmetic preserves operation order and first-span tie breaks
      // without allocating temporary vectors in the quadratic inner loop.
      const t = span.squaredLength > 1e-12 ? Math.max(0, Math.min(1,
        ((midpointX - span.x) * span.dx + (midpointY - span.y) * span.dy) / span.squaredLength)) : 0;
      const offsetX = midpointX - (span.x + span.dx * t);
      const offsetY = midpointY - (span.y + span.dy * t);
      const squaredDistance = offsetX * offsetX + offsetY * offsetY;
      if (squaredDistance < bestDistance) { best = span.segment; bestDistance = squaredDistance; }
    }
    if (!best) continue;
    const previous = result.at(-1);
    if (previous?.index === best.index && previous.material === best.material
      && previous.invalidHardGeometry === best.invalidHardGeometry) previous.points.push(end);
    else result.push({ ...best, points: [start, end], lengthMm: 0 });
  }
  return result.map(segment => ({ ...segment, lengthMm: polylineLength(segment.points) }));
}

/** Exact world-space pipe geometry without drawing-only ownership and local
 * coordinate arrays. Each call resolves live sockets and owns its result. */
export type RefrigerantPipePhysicalPathSpec = Omit<RefrigerantPipeVisualSpec,
  'localOuterPoints' | 'localContinuousOuterPoints' | 'segmentVisuals' | 'invalidHardSegmentCount'>;

function buildRefrigerantPipePhysicalState(
  element: Pick<HvacElement, 'position' | 'width' | 'depth' | 'properties'> & { elevation?: number },
  contextElements?: HvacPipeSnapSource[],
) {
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
  // Paired lane routes already contain the shared circular bends and port
  // transitions. Re-splining each sample with Catmull-Rom creates overshoots at
  // short takeoffs; treating sample chords as hard runs creates stair steps.
  const derivedPairLane = Array.isArray(element.properties.authoredCenterlineRoute);
  const normalizedRoutePoints = derivedPairLane ? dedupeConsecutivePoints(spec.routePoints)
    : simplifyNearlyCollinearPoints(spec.routePoints);
  const segmentPathSpecs: RefrigerantPipeSegmentPathSpec[] = derivedPairLane
    ? normalizedRoutePoints.slice(1).map((end, index) => ({
        index,
        material: spec.segmentMaterials[index] ?? 'flexible',
        invalidHardGeometry: false,
        points: [normalizedRoutePoints[index]!, end],
        lengthMm: Math.hypot(end.x - normalizedRoutePoints[index]!.x, end.y - normalizedRoutePoints[index]!.y),
      }))
    : buildRefrigerantPipeSegmentPaths(normalizedRoutePoints, spec.segmentMaterials,
      resolveFieldPipeBendRadiusMm(spec.outerDiameterMm, element.properties.bendRadiusFactor), {
        startStraightMm: isUnitPortStartConnection ? getActivePipeRoutingSettings().minimumPortStubMm : 0,
        endStraightMm: isUnitPortEndConnection ? getActivePipeRoutingSettings().minimumPortStubMm : 0,
      });
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
  // These points already describe exact circular arcs. Approximate collinear
  // cleanup can erase a small-radius tangent entry and turn it into a kink.
  const sourceOuterPoints = dedupeConsecutivePoints(
    outerPolylinePoints.length >= 2 ? outerPolylinePoints : fallbackOuterPoints,
  );
  const { points: outerPoints, fittedCorners } = compilePlanSocketElbowPoints(sourceOuterPoints, spec.pipeDiameterMm, element.properties,
    isUnitPortStartConnection, isUnitPortEndConnection);
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
  return {
    physical: {
      ...spec,
      bounds,
      outerRadiusMm,
      coreRadiusMm,
      localZMm,
      outerPoints,
      continuousOuterPoints,
      localStub: computeLocalStub(stubStart, stubEnd, bounds.center),
    },
    sourceOuterPoints,
    adjustedSegmentPathSpecs,
    fittedCorners,
  };
}

export function buildRefrigerantPipePhysicalPath(
  element: Pick<HvacElement, 'position' | 'width' | 'depth' | 'properties'> & { elevation?: number },
  contextElements?: HvacPipeSnapSource[],
): RefrigerantPipePhysicalPathSpec {
  return buildRefrigerantPipePhysicalState(element, contextElements).physical;
}

export function buildRefrigerantPipeVisual(
  element: Pick<HvacElement, 'position' | 'width' | 'depth' | 'properties'> & { elevation?: number },
  contextElements?: HvacPipeSnapSource[],
): RefrigerantPipeVisualSpec {
  const { physical, sourceOuterPoints, adjustedSegmentPathSpecs, fittedCorners } =
    buildRefrigerantPipePhysicalState(element, contextElements);
  const { bounds, outerPoints, continuousOuterPoints } = physical;
  const resolvedSegmentWarnings = updateResolvedFieldBendWarnings(adjustedSegmentPathSpecs, fittedCorners);
  const authoritativeSegments = outerPoints === sourceOuterPoints ? resolvedSegmentWarnings
    : transferPipeSegmentOwnership(outerPoints, resolvedSegmentWarnings);
  const segmentVisuals: RefrigerantPipeSegmentVisualSpec[] = authoritativeSegments
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
    ...physical,
    localOuterPoints: outerPoints.map((point) => subtract(point, bounds.center)),
    localContinuousOuterPoints: continuousOuterPoints.map((point) =>
      subtract(point, bounds.center),
    ),
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
  // Use the spec's stored gap (authoritative per element) rather than re-reading
  // the live document setting, so an existing pair holds its center-to-center
  // spacing when the document default changes (A3).
  const centerSpacingMm =
    gasOuterRadiusMm + liquidOuterRadiusMm + spec.pipeGapMm;
  const bendRadiusMm = Math.max(
    12,
    computeCompactBendRadius(
      centerSpacingMm,
      Math.max(gasOuterDiameterMm, liquidOuterDiameterMm),
      explicitBendRadiusFactor(element.properties.bendRadiusFactor),
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
    spec.startBundleConnection?.connectionKind === 'unit-port'
      ? getActivePipeRoutingSettings().minimumPortStubMm
      : 0,
    bendRadiusMm,
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
    bendRadiusMm,
  );
  const { gasRoutePoints, liquidRoutePoints } = reserveUnitPortBundleStubs(
    buildResolvedPipeRoutePoints({
      gasGuidePoints,
      liquidGuidePoints,
      bundleGuidePoints,
      startBundleConnection: spec.startBundleConnection,
      endBundleConnection: spec.endBundleConnection,
      centerSpacingMm,
      bendRadiusMm,
    }),
    spec.startBundleConnection,
    spec.endBundleConnection,
    explicitBendRadiusFactor(element.properties.bendRadiusFactor) === undefined ? undefined : bendRadiusMm,
  );
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

  const gasSourceOuterPoints = gasInsulationStartPoint
    ? dedupeConsecutivePoints(
        [
          gasInsulationStartPoint,
          ...stripLeadingPointIfEqual(
            gasRoutePoints,
            !pointsNearlyEqual(gasInsulationStartPoint, resolvedGasFieldPoint ?? gasInsulationStartPoint)
              ? resolvedGasFieldPoint
              : null,
          ),
        ],
      )
    : dedupeConsecutivePoints(gasRoutePoints);
  const liquidSourceOuterPoints = liquidInsulationStartPoint
    ? dedupeConsecutivePoints(
        [
          liquidInsulationStartPoint,
          ...stripLeadingPointIfEqual(
            liquidRoutePoints,
            !pointsNearlyEqual(liquidInsulationStartPoint, resolvedLiquidFieldPoint ?? liquidInsulationStartPoint)
              ? resolvedLiquidFieldPoint
              : null,
          ),
        ],
      )
    : dedupeConsecutivePoints(liquidRoutePoints);

  const { points: gasOuterPoints } = compilePlanSocketElbowPoints(gasSourceOuterPoints, spec.gasPipeDiameterMm, element.properties,
    isUnitPortConnection, spec.endBundleConnection?.connectionKind === 'unit-port');
  const { points: liquidOuterPoints } = compilePlanSocketElbowPoints(liquidSourceOuterPoints, spec.liquidPipeDiameterMm, element.properties,
    isUnitPortConnection, spec.endBundleConnection?.connectionKind === 'unit-port');

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
    /** Clear wall-to-wall gap this line was routed with (pair mode only). */
    pairClearGapMm?: number;
    /** Centerline-to-centerline spacing the pair was routed with (pair mode only). */
    pairCenterSpacingMm?: number;
    /** Persisted opt-in radius multiplier; omitted for legacy manual geometry. */
    bendRadiusFactor?: number;
    /** Verified minimum retained when the document's active settings change. */
    minimumFieldBendRadiusMm?: number;
    /**
     * The user's drawn bundle centerline (pair mode only). Reflow after
     * equipment moves rebuilds from THIS immutable intent, never from the
     * generated geometry — re-deriving from built output (arcs, fans,
     * detours) diverges when applied repeatedly.
     */
    authoredCenterlineRoute?: Point2D[];
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
  // A flare/braze connection cannot bend at the equipment casing. Keep the
  // reserved first/last port legs rigid even when the active draw mode is
  // flexible; flexibility begins only after the compliant straight stub.
  if (segmentMaterials.length > 0 && options.startConnection?.connectionKind === 'unit-port') {
    segmentMaterials[0] = 'hard';
  }
  if (segmentMaterials.length > 0 && options.endConnection?.connectionKind === 'unit-port') {
    segmentMaterials[segmentMaterials.length - 1] = 'hard';
  }
  const centerlineStart = centerlineRoutePoints[0] ?? null;
  const centerlineEnd = centerlineRoutePoints[centerlineRoutePoints.length - 1] ?? null;
  const tangentStart = resolveEndpointTangent(centerlineRoutePoints, 'start');
  const tangentEnd = resolveEndpointTangent(centerlineRoutePoints, 'end');

  const minimumFieldBendRadiusMm = resolveCopperSocketElbowMinimumRadius({ minimumFieldBendRadiusMm: options.minimumFieldBendRadiusMm });
  const properties = {
    routePoints: centerlineRoutePoints,
    pipeDiameterMm: options.pipeDiameterMm,
    outerDiameterMm: resolvedOuterDiameterMm,
    insulationThicknessMm: resolvedInsulationThicknessMm,
    lineKind: options.lineKind,
    segmentMaterials,
    bundleId: options.bundleId,
    ...(explicitBendRadiusFactor(options.bendRadiusFactor) === undefined ? {} : { bendRadiusFactor: options.bendRadiusFactor }),
    ...(minimumFieldBendRadiusMm > 0 ? { minimumFieldBendRadiusMm } : {}),
    ...(isFiniteNumber(options.pairClearGapMm) ? { pipeGapMm: options.pairClearGapMm } : {}),
    ...(isFiniteNumber(options.pairCenterSpacingMm)
      ? { pairCenterSpacingMm: options.pairCenterSpacingMm }
      : {}),
    ...(options.authoredCenterlineRoute && options.authoredCenterlineRoute.length >= 2
      ? {
          authoredCenterlineRoute: options.authoredCenterlineRoute.map(
            (point) => ({ x: point.x, y: point.y }),
          ),
        }
      : {}),
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
  const visual = buildRefrigerantPipePhysicalPath({
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
    /** Minimum planar bend radius as a multiple of the insulated outside diameter. */
    bendRadiusFactor?: number;
    minimumFieldBendRadiusMm?: number;
    segmentMaterialMode?: RefrigerantPipeMaterial;
    bundleId?: string;
    startBundleConnection?: RefrigerantPipeBundleConnection | null;
    endBundleConnection?: RefrigerantPipeBundleConnection | null;
    /** Optional model-space bottom elevation for view-adaptive 3D placement. */
    elevationMm?: number;
    /**
     * Which line(s) to build. `pair` (default) keeps the coordinated gas+liquid
     * pair; `gas`/`liquid` return a single line whose centerline IS the drawn
     * route (no lateral offset — the one line follows the cursor exactly).
     */
    lineMode?: RefrigerantPipeLineMode;
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

  // Single-line mode: the drawn route is that line's centerline, so the lone
  // gas/liquid pipe tracks the cursor exactly (no pair offsetting). Bind either
  // end to the matching side of a snapped bundle port.
  const lineMode = options?.lineMode ?? 'pair';
  const buildSideConnection = (
    bundle: RefrigerantPipeBundleConnection | null | undefined,
    lineKind: RefrigerantPipeLineKind,
  ): RefrigerantPipeConnection | null => {
    if (!bundle) {
      return null;
    }
    const isGas = lineKind === 'gas';
    return {
      portPoint: isGas ? bundle.gasPoint : bundle.liquidPoint,
      direction:
        (isGas ? bundle.gasDirection : bundle.liquidDirection) ?? bundle.direction,
      elevationMm: isGas ? bundle.gasElevationMm : bundle.liquidElevationMm,
      connectionKind: bundle.connectionKind,
      portId: (isGas ? bundle.gasPortId : bundle.liquidPortId) ?? bundle.portId,
      nodeId: (isGas ? bundle.gasNodeId : bundle.liquidNodeId) ?? bundle.nodeId,
      sourceElementId:
        (isGas ? bundle.gasSourceElementId : bundle.liquidSourceElementId) ??
        bundle.sourceElementId,
      terminalRole: bundle.terminalRole,
    };
  };
  if (lineMode !== 'pair') {
    const isGas = lineMode === 'gas';
    return [
      buildRefrigerantPipeElement(routePoints, {
        lineKind: isGas ? 'gas' : 'liquid',
        label: isGas ? 'Gas Pipe' : 'Liquid Pipe',
        segmentMaterialMode: options?.segmentMaterialMode,
        pipeDiameterMm: isGas ? gasPipeDiameterMm : liquidPipeDiameterMm,
        outerDiameterMm: isGas ? gasOuterDiameterMm : liquidOuterDiameterMm,
        insulationThicknessMm,
        bundleId: options?.bundleId,
        bendRadiusFactor: explicitBendRadiusFactor(options?.bendRadiusFactor),
        minimumFieldBendRadiusMm: options?.minimumFieldBendRadiusMm,
        startConnection: buildSideConnection(options?.startBundleConnection, lineMode),
        endConnection: buildSideConnection(options?.endBundleConnection, lineMode),
        elevationMm: options?.elevationMm,
      }),
    ];
  }

  const gasOuterRadiusMm = gasOuterDiameterMm / 2;
  const liquidOuterRadiusMm = liquidOuterDiameterMm / 2;
  const requestedPipeGapMm = Math.max(0, readNumber(options?.pipeGapMm, resolvedPipeGapMm()));
  const fieldStart = options?.startBundleConnection?.connectionKind === 'field-pipe'
    ? options.startBundleConnection
    : null;
  const inheritedSpacingMm = fieldStart ? Math.abs(dot(
    subtract(fieldStart.liquidFieldPoint, fieldStart.gasFieldPoint),
    perpendicular(normalizeDirection(fieldStart.direction)),
  )) : 0;
  // Continuing an existing bundle/fitting inherits its physical port spacing.
  // Store that spacing too: otherwise the property panel and later reflow claim
  // the current document default while the actual connected lanes differ.
  const centerSpacingMm = inheritedSpacingMm > 0.01
    ? inheritedSpacingMm
    : gasOuterRadiusMm + liquidOuterRadiusMm + requestedPipeGapMm;
  const pipeGapMm = inheritedSpacingMm > 0.01
    ? Math.max(0, centerSpacingMm - gasOuterRadiusMm - liquidOuterRadiusMm)
    : requestedPipeGapMm;
  const bendRadiusMm = Math.max(
    12,
    computeCompactBendRadius(
      centerSpacingMm,
      Math.max(gasOuterDiameterMm, liquidOuterDiameterMm),
      explicitBendRadiusFactor(options?.bendRadiusFactor),
    ),
  );
  const maxOuterDiameterMm = Math.max(gasOuterDiameterMm, liquidOuterDiameterMm);
  const startTakeoffLengthMm = computeStartTakeoffLength(
    centerSpacingMm,
    maxOuterDiameterMm,
    options?.startBundleConnection?.connectionKind === 'unit-port'
      ? getActivePipeRoutingSettings().minimumPortStubMm
      : 0,
    bendRadiusMm,
  );
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
    bendRadiusMm,
  );
  const { gasRoutePoints, liquidRoutePoints } = reserveUnitPortBundleStubs(
    buildResolvedPipeRoutePoints({
      gasGuidePoints,
      liquidGuidePoints,
      bundleGuidePoints,
      startBundleConnection: options?.startBundleConnection ?? null,
      endBundleConnection: options?.endBundleConnection ?? null,
      centerSpacingMm,
      bendRadiusMm,
    }),
    options?.startBundleConnection ?? null,
    options?.endBundleConnection ?? null,
    explicitBendRadiusFactor(options?.bendRadiusFactor) === undefined ? undefined : bendRadiusMm,
  );
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
      bendRadiusFactor: explicitBendRadiusFactor(options?.bendRadiusFactor),
      minimumFieldBendRadiusMm: options?.minimumFieldBendRadiusMm,
      startConnection: buildSideConnection(options?.startBundleConnection, 'gas'),
      endConnection: buildSideConnection(options?.endBundleConnection, 'gas'),
      elevationMm: options?.elevationMm,
      pairClearGapMm: pipeGapMm,
      pairCenterSpacingMm: centerSpacingMm,
      authoredCenterlineRoute: dedupeConsecutivePoints(
        routePoints.map((point) => ({ x: point.x, y: point.y })),
      ),
    }),
    buildRefrigerantPipeElement(liquidRoutePoints, {
      lineKind: 'liquid',
      label: 'Liquid Pipe',
      segmentMaterialMode: options?.segmentMaterialMode,
      pipeDiameterMm: liquidPipeDiameterMm,
      outerDiameterMm: liquidOuterDiameterMm,
      insulationThicknessMm,
      bundleId: options?.bundleId,
      bendRadiusFactor: explicitBendRadiusFactor(options?.bendRadiusFactor),
      minimumFieldBendRadiusMm: options?.minimumFieldBendRadiusMm,
      startConnection: buildSideConnection(options?.startBundleConnection, 'liquid'),
      endConnection: buildSideConnection(options?.endBundleConnection, 'liquid'),
      elevationMm: options?.elevationMm,
      pairClearGapMm: pipeGapMm,
      pairCenterSpacingMm: centerSpacingMm,
      authoredCenterlineRoute: dedupeConsecutivePoints(
        routePoints.map((point) => ({ x: point.x, y: point.y })),
      ),
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
    bendRadiusFactor?: number;
    minimumFieldBendRadiusMm?: number;
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

  const minimumFieldBendRadiusMm = resolveCopperSocketElbowMinimumRadius({ minimumFieldBendRadiusMm: options?.minimumFieldBendRadiusMm });
  const properties = {
    routePoints: dedupeConsecutivePoints(routePoints),
    gasPipeDiameterMm: options?.gasPipeDiameterMm ?? DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM,
    liquidPipeDiameterMm: options?.liquidPipeDiameterMm ?? DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM,
    gasOuterDiameterMm,
    liquidOuterDiameterMm,
    insulationThicknessMm,
    pipeGapMm: resolvedPipeGapMm(),
    ...(explicitBendRadiusFactor(options?.bendRadiusFactor) === undefined ? {} : { bendRadiusFactor: options?.bendRadiusFactor }),
    ...(minimumFieldBendRadiusMm > 0 ? { minimumFieldBendRadiusMm } : {}),
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
  const routeNodes3d = normalizePipeRouteNodes3d(element.properties.routeNodes3d);
  const points = routeNodes3d.length >= 2
    ? routeNodes3d.map((node) => ({ x: node.x, y: node.y }))
    : resolveCenterlinePathWithConnections(
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
      elevationMm: routeNodes3d[0]?.z ?? centerlineElevationMm,
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
    elevationMm: routeNodes3d[routeNodes3d.length - 1]?.z ?? centerlineElevationMm,
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
    const authoredNodes = normalizePipeRouteNodes3d(element.properties.routeNodes3d);
    const baselineZ = spec.startConnection?.elevationMm ?? spec.endConnection?.elevationMm
      ?? element.elevation + spec.outerDiameterMm / 2;
    // Resolve exactly the same endpoint levels as the renderer. The first
    // socket's elevation is not a datum for every span of a multi-level run.
    const nodes = liftPipePlanRouteTo3d(points, authoredNodes.length >= 2
      ? authoredNodes
      : points.map((point) => ({ ...point, z: baselineZ })), {
      startConnection: spec.startConnection,
      endConnection: spec.endConnection,
      outerDiameterMm: spec.outerDiameterMm,
      bendRadiusMm: resolveFieldPipeBendRadiusMm(spec.outerDiameterMm, element.properties.bendRadiusFactor),
      pipeDiameterMm: usesCopperSocketElbows(element.properties) ? spec.pipeDiameterMm : undefined,
      minimumBendRadiusMm: resolveCopperSocketElbowMinimumRadius(element.properties),
    });
    const stations = [0];
    for (let index = 1; index < nodes.length; index += 1) {
      stations.push(stations[index - 1]! + Math.hypot(
        nodes[index]!.x - nodes[index - 1]!.x,
        nodes[index]!.y - nodes[index - 1]!.y,
      ));
    }
    const stationNear = (point: Point2D): number => {
      let closestDistance = Number.POSITIVE_INFINITY;
      let station = 0;
      for (let index = 1; index < nodes.length; index += 1) {
        const start = nodes[index - 1]!;
        const delta = subtract(nodes[index]!, start);
        const length = stations[index]! - stations[index - 1]!;
        if (length <= 1e-8) continue;
        const t = clamp(dot(subtract(point, start), delta) / (length * length), 0, 1);
        const projected = add(start, scale(delta, t));
        const offset = Math.hypot(projected.x - point.x, projected.y - point.y);
        if (offset < closestDistance) {
          closestDistance = offset;
          station = stations[index - 1]! + t * length;
        }
      }
      return station;
    };
    // Legacy bypasses are rendered from separate metadata. Exclude the entire
    // occupied interval, including its rise and return fittings. Authored 3D
    // nodes supersede this metadata in the renderer and are inspected directly.
    const blockedIntervals = authoredNodes.length >= 2 ? []
      : normalizeBypasses(element.properties.bypasses).map((bypass) => {
        const enter = stationNear(bypass.enterPoint);
        const exit = stationNear(bypass.exitPoint);
        return { start: Math.min(enter, exit), end: Math.max(enter, exit) };
      });
    const horizontalSpans: Array<{
      start: Point2D;
      end: Point2D;
      startStation: number;
      endStation: number;
      elevationMm: number;
    }> = [];
    let lastHorizontalEndIndex = -1;
    for (let index = 1; index < nodes.length; index += 1) {
      const start = nodes[index - 1]!;
      const end = nodes[index]!;
      const length = stations[index]! - stations[index - 1]!;
      // A horizontal REFNET cannot be cut into a riser or a sloping segment.
      if (length < 0.01 || Math.abs(end.z - start.z) > 0.01) continue;
      const previous = horizontalSpans.at(-1);
      const direction = normalizeDirection(subtract(end, start));
      if (previous && lastHorizontalEndIndex === index - 1
        && Math.abs(previous.endStation - stations[index - 1]!) < 0.01
        && Math.abs(previous.elevationMm - start.z) < 0.01
        && dot(normalizeDirection(subtract(previous.end, previous.start)), direction) > 1 - 1e-10) {
        previous.end = { x: end.x, y: end.y };
        previous.endStation = stations[index]!;
      } else {
        horizontalSpans.push({
          start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y },
          startStation: stations[index - 1]!, endStation: stations[index]!, elevationMm: start.z,
        });
      }
      lastHorizontalEndIndex = index;
    }
    for (const [spanIndex, span] of horizontalSpans.entries()) {
      let available = [{ start: span.startStation, end: span.endStation }];
      for (const blocked of blockedIntervals) {
        available = available.flatMap((interval) => {
          if (blocked.end <= interval.start || blocked.start >= interval.end) return [interval];
          return [
            { start: interval.start, end: Math.min(interval.end, blocked.start) },
            { start: Math.max(interval.start, blocked.end), end: interval.end },
          ].filter((remaining) => remaining.end - remaining.start > 0.01);
        });
      }
      const direction = normalizeDirection(subtract(span.end, span.start));
      for (const [partIndex, interval] of available.entries()) targets.push({
        key: `${element.id}:segment:${spanIndex}:${partIndex}`,
        elementId: element.id,
        bundleId: spec.bundleId,
        lineKind: spec.lineKind,
        start: add(span.start, scale(direction, interval.start - span.startStation)),
        end: add(span.start, scale(direction, interval.end - span.startStation)),
        direction,
        lengthMm: interval.end - interval.start,
        elevationMm: span.elevationMm,
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
      const spacingErrorMm = Math.abs(distanceMm - expectedSpacingMm);
      const sharesBundleId = Boolean(
        gasEndpoint.bundleId
        && liquidEndpoint.bundleId
        && gasEndpoint.bundleId === liquidEndpoint.bundleId,
      );
      if (
        !sharesBundleId
        && !isPlausibleBundleSpacingMm(
          distanceMm,
          gasEndpoint.outerDiameterMm,
          liquidEndpoint.outerDiameterMm,
        )
      ) {
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
  // Exposes the kit's 3 ports for ALL line kinds — gas, liquid, and both — so a
  // single-line kit's ports are drawable snap points too (the identity always
  // resolves both gas + liquid terminals from the model regardless of selection).
  const lineSelection = resolveRefrigerantBranchKitLineSelection(element);
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

    // A single-line kit collapses BOTH slots onto its own line's point, so the
    // port is one snap point at the visible tube end — not spread across to the
    // model's hidden other line. 'both' keeps the real gas/liquid pair.
    const gasP = lineSelection === 'liquid' ? identity.liquidPoint : identity.gasPoint;
    const liqP = lineSelection === 'gas' ? identity.gasPoint : identity.liquidPoint;
    const gasDir = lineSelection === 'liquid' ? identity.liquidDirection : identity.gasDirection;
    const liqDir = lineSelection === 'gas' ? identity.gasDirection : identity.liquidDirection;
    const gasZ = lineSelection === 'liquid' ? model.liquid.centerlineZMm : model.gas.centerlineZMm;
    const liqZ = lineSelection === 'gas' ? model.gas.centerlineZMm : model.liquid.centerlineZMm;
    const gasIdentity = refrigerantBranchKitTerminalIds(element.id, 'gas', role);
    const liquidIdentity = refrigerantBranchKitTerminalIds(element.id, 'liquid', role);

    return [{
      point: computeBundleCenter(gasP, liqP),
      gasPoint: gasP,
      liquidPoint: liqP,
      gasFieldPoint: gasP,
      liquidFieldPoint: liqP,
      gasOuterDiameterMm: identity.gasTerminal.outerDiameterMm,
      liquidOuterDiameterMm: identity.liquidTerminal.outerDiameterMm,
      gasDirection: gasDir,
      liquidDirection: liqDir,
      direction: identity.direction,
      elevationMm: element.elevation + (gasZ + liqZ) / 2,
      gasElevationMm: element.elevation + gasZ,
      liquidElevationMm: element.elevation + liqZ,
      connectionKind: 'field-pipe',
      sourceElementId: element.id,
      gasSourceElementId: element.id,
      liquidSourceElementId: element.id,
      gasPortId: gasIdentity.portId,
      liquidPortId: liquidIdentity.portId,
      gasNodeId: gasIdentity.nodeId,
      liquidNodeId: liquidIdentity.nodeId,
      terminalRole: role,
    }];
  });
}

/**
 * The 3 bundle ports (inlet / run-outlet / branch-outlet) of a self-contained
 * ('both' lines) copper branch kit, in WORLD coordinates: gas/liquid points,
 * outward direction, diameters, and terminalRole. Same data the pipe draw tool
 * snaps to; exposed so UI (port grips) can render + draw from each port.
 */
export function getBranchKitPortConnections(
  element: HvacPipeSnapSource,
): RefrigerantPipeBundleConnection[] {
  return buildSelfContainedBranchKitBundleTargets(element);
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
      const spacingErrorMm = Math.abs(spacingMm - expectedSpacingMm);
      const sharesBundleId = Boolean(
        gasSegment.bundleId &&
        liquidSegment.bundleId &&
        gasSegment.bundleId === liquidSegment.bundleId,
      );
      if (
        !sharesBundleId &&
        !isPlausibleBundleSpacingMm(
          spacingMm,
          gasSegment.outerDiameterMm,
          liquidSegment.outerDiameterMm,
        )
      ) {
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
    const explicitPair = Boolean(gas.bundleId && gas.bundleId === liquid.bundleId);
    // Different level-transition stations can divide one lane into several
    // spans beside a single straight companion span. Every shared horizontal
    // interval of an identified pair remains eligible.
    if (!explicitPair && (usedKeys.has(gas.key) || usedKeys.has(liquid.key))) {
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
      gasSourceElementId: gas.elementId,
      liquidSourceElementId: liquid.elementId,
      segmentStart,
      segmentEnd,
      segmentLengthMm,
      projectedDistanceMm: 0,
    });
  });

  return targets;
}

/**
 * Returns every paired, level, straight gas/liquid interval that can physically
 * host an inline fitting. Callers that need to recover from a blocked hover
 * position can rank and validate these immutable spans without repeatedly
 * snapping to whichever neighboring pipe happens to be closest.
 */
export function getRefrigerantPipeBundleSegmentTargets(
  elements: HvacPipeSnapSource[],
  options?: { minSegmentLengthMm?: number },
): RefrigerantPipeBundleSegmentConnection[] {
  return computeStraightBundleSegmentTargets(
    elements,
    Math.max(1, options?.minSegmentLengthMm ?? 1),
  );
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

export interface RefrigerantPipeExtensionTarget {
  bundle: RefrigerantPipeBundleConnection;
  /** Whether continuing this end lays a coordinated pair or a single gas/liquid line. */
  lineMode: RefrigerantPipeLineMode;
  distanceMm: number;
}

/**
 * Resolves the open pipe end nearest `point` and how to continue it — the single
 * "detection engine" both the draw tool's first click and the overlay's "+" grip
 * run so extending a run always inherits its real identity (coordinated pair vs a
 * lone gas/liquid line) regardless of the toolbar Lines selector.
 *
 * A matched gas+liquid pair (or a unit port / branch-kit bundle) resolves to a
 * `pair` continuation; a lone single line resolves to its own `gas`/`liquid`
 * continuation, synthesized from the open endpoint's geometry. When a pair and a
 * lone end are equidistant (their endpoints coincide on a real pair) the pair wins.
 *
 * `options.excludeElementId` drops ends owned by that element (so a run can't weld
 * back onto its own start); `options.lineKind` restricts the result to lone ends
 * that expose that line (used when terminating a single-line continuation, which
 * also skips pair bundles).
 */
export function findNearestRefrigerantPipeExtensionTarget(
  elements: HvacPipeSnapSource[],
  point: Point2D,
  thresholdMm: number,
  options?: { excludeElementId?: string; lineKind?: RefrigerantPipeLineKind },
): RefrigerantPipeExtensionTarget | null {
  const excludeElementId = options?.excludeElementId;
  const lineKindFilter = options?.lineKind;

  // Pair / unit-port / branch-kit bundle. Skipped when a single line kind is
  // required (a single-line continuation only welds onto a lone line of its kind).
  let pairTarget: RefrigerantPipeExtensionTarget | null = null;
  if (!lineKindFilter) {
    const pairBundle = findNearestRefrigerantPipeBundleTarget(
      elements,
      point,
      thresholdMm,
    );
    if (pairBundle && pairBundle.sourceElementId !== excludeElementId) {
      const gasDistance = Math.hypot(
        pairBundle.gasPoint.x - point.x,
        pairBundle.gasPoint.y - point.y,
      );
      const liquidDistance = Math.hypot(
        pairBundle.liquidPoint.x - point.x,
        pairBundle.liquidPoint.y - point.y,
      );
      pairTarget = {
        bundle: pairBundle,
        lineMode: 'pair',
        distanceMm: Math.min(gasDistance, liquidDistance),
      };
    }
  }

  // Nearest lone open single-line end, synthesized into a field-pipe bundle so the
  // continuation welds to its own line only.
  let singleTarget: RefrigerantPipeExtensionTarget | null = null;
  let bestSingleDistance = thresholdMm;
  // A same-scope for-of (not forEach) so control-flow analysis tracks the
  // `singleTarget` assignment and narrows it after the loop.
  for (const endpoint of getRefrigerantPipeEndpointTargets(elements)) {
    if (
      excludeElementId
      && (endpoint.elementId === excludeElementId
        || endpoint.bundleId === excludeElementId)
    ) {
      continue;
    }
    if (lineKindFilter && endpoint.lineKind !== lineKindFilter) {
      continue;
    }
    const distanceMm = Math.hypot(
      endpoint.point.x - point.x,
      endpoint.point.y - point.y,
    );
    if (distanceMm > bestSingleDistance) {
      continue;
    }
    bestSingleDistance = distanceMm;
    const elevationMm = endpoint.elevationMm;
    singleTarget = {
      bundle: {
        point: endpoint.point,
        gasPoint: endpoint.point,
        liquidPoint: endpoint.point,
        gasFieldPoint: endpoint.point,
        liquidFieldPoint: endpoint.point,
        gasOuterDiameterMm: endpoint.outerDiameterMm,
        liquidOuterDiameterMm: endpoint.outerDiameterMm,
        gasDirection: endpoint.direction,
        liquidDirection: endpoint.direction,
        direction: endpoint.direction,
        elevationMm,
        gasElevationMm: elevationMm,
        liquidElevationMm: elevationMm,
        connectionKind: 'field-pipe',
        guideReference: endpoint.lineKind,
        sourceElementId: endpoint.bundleId ?? endpoint.elementId,
      },
      lineMode: endpoint.lineKind,
      distanceMm,
    };
  }

  if (pairTarget && singleTarget) {
    return pairTarget.distanceMm <= singleTarget.distanceMm
      ? pairTarget
      : singleTarget;
  }
  return pairTarget ?? singleTarget;
}

/** How far a built extension line's first vertex may sit from the host pipe's
 * open end and still be treated as the SAME point (weld guarantee + rounding). */
const EXTENSION_MERGE_WELD_TOLERANCE_MM = 1;

export interface RefrigerantPipeExtensionMergeUpdate {
  /** Existing pipe element the extension merges into. */
  id: string;
  position: Point2D;
  width: number;
  depth: number;
  properties: Record<string, unknown>;
}

/**
 * Merges a committed extension INTO the host pipe element(s) it continues, so
 * the whole run stays ONE polyline per line — the junction bend then renders
 * exactly like any mid-draw vertex (no crack between two butted bodies). This is
 * the same "one element, many segments" model a fresh segment-by-segment draw
 * commits, applied to extensions.
 *
 * `extensionElements` are the elements `buildRefrigerantPipeElements` built for
 * the extension route (their per-line routes are already welded to the host line
 * ends). For each, the host is found by line kind + an OPEN route end within
 * tolerance of the extension's first vertex; the extension's tail is appended
 * (or prepended reversed, when continuing the host's start), segment materials
 * follow, and the far-end connection (if the extension welded onto another
 * port/pipe) transfers to the merged element.
 *
 * Returns null when merging does not apply — not a plain field-pipe open end
 * (unit ports and branch-kit terminals keep their connection semantics), or any
 * extension line has no open matching host end — in which case the caller
 * commits the extension as new elements exactly as before.
 */
export function buildRefrigerantPipeExtensionMerge(
  elements: HvacPipeSnapSource[],
  startBundleConnection: RefrigerantPipeBundleConnection,
  extensionElements: ReadonlyArray<{ properties?: Record<string, unknown> }>,
): RefrigerantPipeExtensionMergeUpdate[] | null {
  if (
    startBundleConnection.connectionKind !== 'field-pipe'
    || startBundleConnection.terminalRole
    || extensionElements.length === 0
  ) {
    return null;
  }

  const normalizeMaterials = (
    materials: RefrigerantPipeMaterial[] | undefined,
    segmentCount: number,
  ): RefrigerantPipeMaterial[] =>
    Array.from({ length: Math.max(0, segmentCount) }, (_, index) =>
      materials?.[index] === 'hard' ? 'hard' : 'flexible',
    );

  const updates: RefrigerantPipeExtensionMergeUpdate[] = [];
  const usedHostIds = new Set<string>();

  for (const extension of extensionElements) {
    const extensionProperties = extension.properties;
    if (!extensionProperties) {
      return null;
    }
    const extensionSpec = resolveRefrigerantPipeSpec(extensionProperties);
    const extensionRoute = extensionSpec.routePoints;
    if (extensionRoute.length < 2) {
      return null;
    }
    const weldPoint = extensionRoute[0]!;

    // Host = pipe of the same line kind whose OPEN start/end coincides with the
    // extension's welded first vertex. Nearest wins inside the tolerance.
    let host: HvacPipeSnapSource | null = null;
    let hostSpec: RefrigerantPipeSpec | null = null;
    let hostEnd: 'start' | 'end' = 'end';
    let bestDistanceMm = EXTENSION_MERGE_WELD_TOLERANCE_MM;
    for (const element of elements) {
      if (element.type !== 'refrigerant-pipe' || usedHostIds.has(element.id)) {
        continue;
      }
      const spec = resolveRefrigerantPipeSpec(element.properties);
      if (spec.lineKind !== extensionSpec.lineKind || spec.routePoints.length < 2) {
        continue;
      }
      const route = spec.routePoints;
      const endDistanceMm = spec.endConnection
        ? Number.POSITIVE_INFINITY
        : Math.hypot(
            route[route.length - 1]!.x - weldPoint.x,
            route[route.length - 1]!.y - weldPoint.y,
          );
      const startDistanceMm = spec.startConnection
        ? Number.POSITIVE_INFINITY
        : Math.hypot(route[0]!.x - weldPoint.x, route[0]!.y - weldPoint.y);
      if (endDistanceMm <= bestDistanceMm && endDistanceMm <= startDistanceMm) {
        bestDistanceMm = endDistanceMm;
        host = element;
        hostSpec = spec;
        hostEnd = 'end';
      } else if (startDistanceMm <= bestDistanceMm) {
        bestDistanceMm = startDistanceMm;
        host = element;
        hostSpec = spec;
        hostEnd = 'start';
      }
    }
    if (!host || !hostSpec) {
      return null;
    }
    usedHostIds.add(host.id);

    const hostRoute = hostSpec.routePoints;
    const hostMaterials = normalizeMaterials(
      hostSpec.segmentMaterials,
      hostRoute.length - 1,
    );
    const extensionMaterials = normalizeMaterials(
      extensionSpec.segmentMaterials,
      extensionRoute.length - 1,
    );
    // The extension's first vertex IS the host end (welded) — drop it on join.
    const extensionTail = extensionRoute.slice(1);
    const mergedRoute = hostEnd === 'end'
      ? [...hostRoute, ...extensionTail]
      : [...[...extensionTail].reverse(), ...hostRoute];
    const mergedMaterials = hostEnd === 'end'
      ? [...hostMaterials, ...extensionMaterials]
      : [...[...extensionMaterials].reverse(), ...hostMaterials];

    const mergedProperties: Record<string, unknown> = {
      ...(host.properties ?? {}),
      routePoints: mergedRoute,
      segmentMaterials: mergedMaterials,
    };
    // The extended side stops being an open end; whatever the extension's far
    // end welded onto (another pipe end / port) becomes the merged terminal.
    if (hostEnd === 'end') {
      mergedProperties.endConnection = extensionSpec.endConnection ?? null;
    } else {
      mergedProperties.startConnection = extensionSpec.endConnection ?? null;
    }

    // Bounds recompute mirrors the overlay's route-edit path (withPipeRoute):
    // route bbox padded by the insulated outer diameter.
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const point of mergedRoute) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    const marginMm = Math.max(hostSpec.outerDiameterMm, 1);
    updates.push({
      id: host.id,
      position: { x: minX - marginMm, y: minY - marginMm },
      width: maxX - minX + marginMm * 2,
      depth: maxY - minY + marginMm * 2,
      properties: mergedProperties,
    });
  }

  return updates.length > 0 ? updates : null;
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
  const targets = getRefrigerantPipeBundleSegmentTargets(elements, {
    minSegmentLengthMm: minimumSegmentLengthMm,
  });
  // Deterministic selection: rank candidates by distance quantized into a small
  // tie window, breaking near-ties by the stable sourceElementId. This stops the
  // chosen run from flip-flopping between two near-equidistant parallel mains as
  // the cursor jitters (B2).
  const TIE_BREAK_EPS_MM = 1;
  let bestTarget: RefrigerantPipeBundleSegmentConnection | null = null;
  let bestBucket = Number.POSITIVE_INFINITY;
  let bestSourceId = '';

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
    if (distanceMm > thresholdMm) {
      return;
    }
    const candidateBucket = Math.round(distanceMm / TIE_BREAK_EPS_MM);
    const candidateSourceId = target.sourceElementId ?? '';
    if (
      bestTarget &&
      (candidateBucket > bestBucket ||
        (candidateBucket === bestBucket && candidateSourceId >= bestSourceId))
    ) {
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
    bestBucket = candidateBucket;
    bestSourceId = candidateSourceId;
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
    left.portId === right.portId &&
    left.nodeId === right.nodeId &&
    left.terminalRole === right.terminalRole &&
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
    left.gasSourceElementId === right.gasSourceElementId &&
    left.liquidSourceElementId === right.liquidSourceElementId &&
    left.portId === right.portId &&
    left.nodeId === right.nodeId &&
    left.gasPortId === right.gasPortId &&
    left.liquidPortId === right.liquidPortId &&
    left.gasNodeId === right.gasNodeId &&
    left.liquidNodeId === right.liquidNodeId &&
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

/**
 * Rebuilds a coordinated gas+liquid pair through the draw-time builder after
 * one of its unit-port ends moved. Reflow re-derives the centerline from the
 * retained (stripped, sharpened, axis-aligned) main run, so the pair welds to
 * the new port with the standard takeoff, correct bundle spacing, and the
 * minimum number of bends — live, on every move. Returns null when the pair
 * shape doesn't apply (single lines, branch-kit ends, degenerate tails); the
 * caller then falls back to per-line reconnection.
 */
function rebuildCoordinatedPairReflow(options: {
  gas: HvacElement;
  liquid: HvacElement;
  syncStart: boolean;
  syncEnd: boolean;
  movedBundle: RefrigerantPipeBundleConnection;
  sceneElements: HvacElement[];
  bundleId: string;
}): Array<{ id: string; updates: Partial<HvacElement> }> | null {
  const { gas, liquid, syncStart, syncEnd, movedBundle, sceneElements, bundleId } = options;
  if (syncStart === syncEnd) return null;
  const gasSpec = resolveRefrigerantPipeSpec(gas.properties);
  const liquidSpec = resolveRefrigerantPipeSpec(liquid.properties);

  const resolveBundleForConnection = (
    connection: RefrigerantPipeConnection | null,
  ): RefrigerantPipeBundleConnection | null => {
    if (!connection) return null;
    if (connection.connectionKind !== 'unit-port' || !connection.sourceElementId) {
      return null;
    }
    const unitElement = sceneElements.find(
      (candidate) => candidate.id === connection.sourceElementId,
    );
    return unitElement
      ? resolveUnitPortBundleConnectionForElement(unitElement)
      : null;
  };
  const farConnection = syncStart ? gasSpec.endConnection : gasSpec.startConnection;
  // Branch-kit / field-pipe far ends have their own weld topology — leave them
  // to the per-line path rather than rebuilding through the pair builder.
  if (farConnection && farConnection.connectionKind !== 'unit-port') return null;
  const farBundle = resolveBundleForConnection(farConnection);
  if (farConnection && !farBundle) return null;

  const spacingMm = (() => {
    const persisted = readNumber(
      (gas.properties as Record<string, unknown>).pairCenterSpacingMm,
      Number.NaN,
    );
    if (Number.isFinite(persisted) && persisted > 0) return persisted;
    return gasSpec.outerDiameterMm / 2 + liquidSpec.outerDiameterMm / 2 + resolvedPipeGapMm();
  })();

  // Strip the WHOLE old takeoff structurally: every leading vertex inside the
  // old port's takeoff bubble (stub + gather + slack) belongs to the weld that
  // is being rebuilt. A leg-length heuristic misses the old gather diagonal,
  // whose stale lateral level would then resurface as a spike mid-run.
  const oldConnection = syncStart ? gasSpec.startConnection : gasSpec.endConnection;
  const oldPortPoint = oldConnection?.portPoint ?? movedBundle.point;
  const takeoffBubbleMm =
    getActivePipeRoutingSettings().minimumPortStubMm + spacingMm * 4;
  // The authored bundle centerline is the reflow's source of truth: reflowing
  // from generated geometry (arcs, fans, detours) diverges when repeated, but
  // realigning the same drawn intent is a fixed point. The rebuild below
  // passes the aligned centerline back through the builder, which re-persists
  // it, so consecutive moves keep operating on clean authored geometry.
  const authoredCenterline = normalizePointArray(
    (gas.properties as Record<string, unknown>).authoredCenterlineRoute,
  );
  let centerlineTail: Point2D[] | null = null;
  let persistedAuthoredCenterline: Point2D[] | null =
    authoredCenterline.length >= 2 ? authoredCenterline : null;
  if (authoredCenterline.length >= 2) {
    const oriented = syncStart
      ? [...authoredCenterline]
      : [...authoredCenterline].reverse();
    // Retain from the first REAL leg that leaves the bubble, keeping that
    // leg's start vertex even when it sits inside the bubble: the vertex
    // carries the leg's line. Dropping it would erase the leg (typically the
    // main's first run) and promote the NEXT leg to "first", letting the
    // align step slide geometry that lies beyond the second bend.
    let firstRetainedIndex = Math.max(0, oriented.length - 2);
    for (let index = 0; index < oriented.length - 1; index += 1) {
      const legEnd = oriented[index + 1]!;
      const legEndOutside = Math.hypot(
        legEnd.x - oldPortPoint.x,
        legEnd.y - oldPortPoint.y,
      ) >= takeoffBubbleMm;
      const legLengthMm = Math.hypot(
        legEnd.x - oriented[index]!.x,
        legEnd.y - oriented[index]!.y,
      );
      if (legEndOutside && legLengthMm >= spacingMm * 2) {
        firstRetainedIndex = index;
        break;
      }
    }
    const tail = oriented.slice(firstRetainedIndex);
    if (tail.length >= 2) centerlineTail = tail;
  }
  if (!centerlineTail) {
    // Legacy pipes drawn before the authored centerline existed: derive one
    // from the gas line once; the rebuild persists it for future moves.
    const orientedGasRoute = syncStart
      ? [...gasSpec.routePoints]
      : [...gasSpec.routePoints].reverse();
    const sharpenedGasRoute = sharpenPipeRouteCorners(orientedGasRoute);
    // Retain from the first REAL leg that leaves the bubble — including its
    // start vertex even when that vertex sits inside the bubble, because it
    // carries the main's line.
    let firstRetainedIndex = Math.max(0, sharpenedGasRoute.length - 2);
    for (let index = 0; index < sharpenedGasRoute.length - 1; index += 1) {
      const legEnd = sharpenedGasRoute[index + 1]!;
      const legEndOutside = Math.hypot(
        legEnd.x - oldPortPoint.x,
        legEnd.y - oldPortPoint.y,
      ) >= takeoffBubbleMm;
      const legLengthMm = Math.hypot(
        legEnd.x - sharpenedGasRoute[index]!.x,
        legEnd.y - sharpenedGasRoute[index]!.y,
      );
      if (legEndOutside && legLengthMm >= spacingMm * 2) {
        firstRetainedIndex = index;
        break;
      }
    }
    const gasTail = sharpenedGasRoute.slice(firstRetainedIndex);
    if (gasTail.length < 2) return null;
    // Centerline sits half a spacing from the gas line, on the liquid side.
    const liquidReference = syncStart
      ? liquidSpec.routePoints[liquidSpec.routePoints.length - 1]
      : liquidSpec.routePoints[0];
    const candidateA = offsetPolyline(gasTail, spacingMm / 2);
    const candidateB = offsetPolyline(gasTail, -spacingMm / 2);
    const distanceToReference = (candidate: Point2D[]): number => {
      const probe = candidate[candidate.length - 1]!;
      return liquidReference
        ? Math.hypot(probe.x - liquidReference.x, probe.y - liquidReference.y)
        : Number.POSITIVE_INFINITY;
    };
    centerlineTail = distanceToReference(candidateA) <= distanceToReference(candidateB)
      ? candidateA
      : candidateB;
    // Legacy pipes adopt this one-shot derivation as their authored intent so
    // every later move re-derives from the SAME frozen route.
    persistedAuthoredCenterline = syncStart
      ? centerlineTail.map((point) => ({ ...point }))
      : [...centerlineTail].reverse().map((point) => ({ ...point }));
  }

  // The tail is oriented with the MOVED end first, so the moved port's axis
  // drives the minimum-bend absorption regardless of which end moved.
  let centerline = alignReflowRouteToPortAxis(
    centerlineTail,
    movedBundle.point,
    movedBundle.direction,
  );
  if (!syncStart) centerline = [...centerline].reverse();
  if (centerline.length < 2) return null;

  const startBundle = syncStart ? movedBundle : farBundle;
  const endBundle = syncStart ? farBundle : movedBundle;
  const built = buildRefrigerantPipeElements(centerline, {
    gasPipeDiameterMm: gasSpec.pipeDiameterMm,
    liquidPipeDiameterMm: liquidSpec.pipeDiameterMm,
    insulationThicknessMm: gasSpec.insulationThicknessMm,
    bendRadiusFactor: explicitBendRadiusFactor(gas.properties.bendRadiusFactor)
      ?? explicitBendRadiusFactor(liquid.properties.bendRadiusFactor),
    minimumFieldBendRadiusMm: Math.max(resolveCopperSocketElbowMinimumRadius(gas.properties),
      resolveCopperSocketElbowMinimumRadius(liquid.properties)),
    bundleId,
    startBundleConnection: startBundle,
    endBundleConnection: endBundle,
  });
  if (built.length !== 2) return null;
  const builtGas = built.find((candidate) => candidate.properties?.lineKind === 'gas');
  const builtLiquid = built.find((candidate) => candidate.properties?.lineKind === 'liquid');
  if (!builtGas || !builtLiquid) return null;

  return [
    { element: gas, rebuilt: builtGas },
    { element: liquid, rebuilt: builtLiquid },
  ].map(({ element, rebuilt }) => ({
    id: element.id,
    updates: {
      position: rebuilt.position,
      width: rebuilt.width,
      depth: rebuilt.depth,
      height: rebuilt.height,
      elevation: rebuilt.elevation,
      properties: {
        ...element.properties,
        ...rebuilt.properties,
        // Reflow must never rewrite the drawn intent: the builder persisted
        // the ADAPTED centerline it was fed, but the authored route stays
        // frozen so every future move re-derives from the same source and
        // moving the unit back restores the original layout exactly.
        ...(persistedAuthoredCenterline
          ? {
              authoredCenterlineRoute: persistedAuthoredCenterline.map(
                (point) => ({ ...point }),
              ),
            }
          : {}),
      },
    },
  }));
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

  // Coordinated pairs reflow as ONE unit through the draw-time builder so the
  // rebuilt geometry keeps bundle spacing and minimum bends; per-line handling
  // below remains the fallback for singles and special welds.
  const pairHandledIds = new Set<string>();
  const pipesByBundleId = new Map<string, HvacElement[]>();
  elements.forEach((element) => {
    if (element.type !== 'refrigerant-pipe') return;
    const bundleId = resolveRefrigerantPipeSpec(element.properties).bundleId;
    if (!bundleId) return;
    const group = pipesByBundleId.get(bundleId) ?? [];
    group.push(element);
    pipesByBundleId.set(bundleId, group);
  });
  pipesByBundleId.forEach((group, bundleId) => {
    if (group.length !== 2) return;
    const gas = group.find(
      (candidate) => resolveRefrigerantPipeSpec(candidate.properties).lineKind === 'gas',
    );
    const liquid = group.find(
      (candidate) => resolveRefrigerantPipeSpec(candidate.properties).lineKind === 'liquid',
    );
    if (!gas || !liquid) return;
    const gasSpec = resolveRefrigerantPipeSpec(gas.properties);
    const liquidSpec = resolveRefrigerantPipeSpec(liquid.properties);
    const syncStart =
      isUnitPortConnectionFromSource(gasSpec.startConnection, movedSourceElement.id)
      && isUnitPortConnectionFromSource(liquidSpec.startConnection, movedSourceElement.id);
    const syncEnd =
      isUnitPortConnectionFromSource(gasSpec.endConnection, movedSourceElement.id)
      && isUnitPortConnectionFromSource(liquidSpec.endConnection, movedSourceElement.id);
    if (!syncStart && !syncEnd) return;
    const pairUpdates = rebuildCoordinatedPairReflow({
      gas,
      liquid,
      syncStart,
      syncEnd,
      movedBundle: sourceBundleTarget,
      sceneElements: sceneWithMovedSource,
      bundleId,
    });
    if (!pairUpdates) return;
    updates.push(...pairUpdates);
    pairHandledIds.add(gas.id);
    pairHandledIds.add(liquid.id);
  });

  elements.forEach((element) => {
    if (element.type === 'refrigerant-pipe') {
      if (pairHandledIds.has(element.id)) {
        return;
      }
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
        portId: spec.lineKind === 'gas'
          ? sourceBundleTarget.gasPortId ?? sourceBundleTarget.portId
          : sourceBundleTarget.liquidPortId ?? sourceBundleTarget.portId,
        nodeId: spec.lineKind === 'gas'
          ? sourceBundleTarget.gasNodeId ?? sourceBundleTarget.nodeId
          : sourceBundleTarget.liquidNodeId ?? sourceBundleTarget.nodeId,
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
      let nextRoutePoints = remapRouteEndpointsForMovedConnection(
        spec.routePoints,
        {
          previousStart: syncStart ? spec.startConnection?.portPoint ?? null : null,
          nextStart: syncStart ? nextStartConnection?.portPoint ?? null : null,
          previousEnd: syncEnd ? spec.endConnection?.portPoint ?? null : null,
          nextEnd: syncEnd ? nextEndConnection?.portPoint ?? null : null,
          anchorSnapRadiusMm: 160,
        },
      );
      if (syncStart && nextStartConnection) {
        nextRoutePoints = reserveMinimumPortStub(
          stripPortTakeoffArtifacts(nextRoutePoints),
          nextStartConnection.portPoint,
          nextStartConnection.direction,
        );
      }
      if (syncEnd && nextEndConnection) {
        nextRoutePoints = reserveMinimumPortStub(
          stripPortTakeoffArtifacts([...nextRoutePoints].reverse()),
          nextEndConnection.portPoint,
          nextEndConnection.direction,
        ).reverse();
      }

      const routedElement = withCanonicalPipeRoute(element, nextRoutePoints, {
        startConnection: nextStartConnection,
        endConnection: nextEndConnection,
      });
      const nextProperties: Record<string, unknown> = { ...routedElement.properties };
      const nextNodes = normalizePipeRouteNodes3d(nextProperties.routeNodes3d);
      if (nextNodes.length >= 2) {
        if (syncStart && nextStartConnection) nextNodes[0]!.z = nextStartConnection.elevationMm;
        if (syncEnd && nextEndConnection) nextNodes[nextNodes.length - 1]!.z = nextEndConnection.elevationMm;
        nextProperties.routeNodes3d = nextNodes;
      }
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
    let nextRoutePoints = remapRouteEndpointsForMovedConnection(
      normalizePointArray(element.properties.routePoints),
      {
        previousStart: syncStart ? startBundleConnection?.point ?? null : null,
        nextStart: syncStart ? nextStartBundleConnection?.point ?? null : null,
        previousEnd: syncEnd ? endBundleConnection?.point ?? null : null,
        nextEnd: syncEnd ? nextEndBundleConnection?.point ?? null : null,
        anchorSnapRadiusMm: 220,
      },
    );
    if (syncStart && nextStartBundleConnection) {
      nextRoutePoints = reserveMinimumPortStub(
        stripPortTakeoffArtifacts(nextRoutePoints),
        nextStartBundleConnection.point,
        nextStartBundleConnection.direction,
      );
    }
    if (syncEnd && nextEndBundleConnection) {
      nextRoutePoints = reserveMinimumPortStub(
        stripPortTakeoffArtifacts([...nextRoutePoints].reverse()),
        nextEndBundleConnection.point,
        nextEndBundleConnection.direction,
      ).reverse();
    }

    const routedElement = withCanonicalPipeRoute(element, nextRoutePoints, {
      startBundleConnection: nextStartBundleConnection,
      endBundleConnection: nextEndBundleConnection,
    });
    const nextProperties: Record<string, unknown> = { ...routedElement.properties };
    const nextNodes = normalizePipeRouteNodes3d(nextProperties.routeNodes3d);
    if (nextNodes.length >= 2) {
      if (syncStart && nextStartBundleConnection) {
        nextNodes[0]!.z = nextStartBundleConnection.elevationMm;
      }
      if (syncEnd && nextEndBundleConnection) {
        nextNodes[nextNodes.length - 1]!.z = nextEndBundleConnection.elevationMm;
      }
      nextProperties.routeNodes3d = nextNodes;
    }
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

/**
 * A single-pipe end bound to a copper branch-kit port: a `field-pipe` connection
 * that names both the kit ({@link sourceElementId}) and which port
 * ({@link terminalRole}). The terminalRole requirement is what separates a kit
 * binding from an ordinary pipe-to-pipe field joint (also `field-pipe`).
 */
function isBranchKitConnectionFromSource(
  connection: RefrigerantPipeConnection | null,
  sourceElementId: string,
): boolean {
  return Boolean(
    connection &&
      connection.connectionKind === 'field-pipe' &&
      connection.sourceElementId === sourceElementId &&
      Boolean(connection.terminalRole),
  );
}

function isBranchKitBundleConnectionFromSource(
  connection: RefrigerantPipeBundleConnection | null,
  sourceElementId: string,
): boolean {
  return Boolean(
    connection &&
      connection.connectionKind === 'field-pipe' &&
      connection.sourceElementId === sourceElementId &&
      Boolean(connection.terminalRole),
  );
}

/**
 * When a copper branch kit is moved, re-pin every pipe end bound to one of its
 * ports so the pipe follows the kit — the branch-kit analogue of
 * {@link resolveRefrigerantPipeUnitPortReconnectionUpdates}. Each bound end is
 * re-resolved from the kit's LIVE world ports by its stored `terminalRole` (so
 * inlet stays on inlet, etc.), the route endpoint is remapped, and pipe bounds
 * are rebuilt. Returns one update per affected pipe.
 */
export function resolveRefrigerantPipeBranchKitReconnectionUpdates(
  elements: HvacElement[],
  movedKitElement: HvacElement,
): Array<{ id: string; updates: Partial<HvacElement> }> {
  if (movedKitElement.type !== 'refrigerant-branch-kit') {
    return [];
  }
  const sceneWithMovedKit = elements.map((element) =>
    element.id === movedKitElement.id ? movedKitElement : element,
  );
  const livePorts = new Map<
    RefrigerantBranchTerminalRole,
    RefrigerantPipeBundleConnection
  >();
  for (const port of getBranchKitPortConnections(movedKitElement)) {
    if (port.terminalRole) {
      livePorts.set(port.terminalRole, port);
    }
  }
  if (livePorts.size === 0) {
    return [];
  }

  const updates: Array<{ id: string; updates: Partial<HvacElement> }> = [];
  elements.forEach((element) => {
    if (element.type === 'refrigerant-pipe') {
      const spec = resolveRefrigerantPipeSpec(element.properties);
      const syncStart = isBranchKitConnectionFromSource(
        spec.startConnection,
        movedKitElement.id,
      );
      const syncEnd = isBranchKitConnectionFromSource(
        spec.endConnection,
        movedKitElement.id,
      );
      if (!syncStart && !syncEnd) {
        return;
      }
      const rebindSingle = (
        prev: RefrigerantPipeConnection | null,
      ): RefrigerantPipeConnection | null => {
        if (!prev || !prev.terminalRole) {
          return prev;
        }
        const livePort = livePorts.get(prev.terminalRole);
        if (!livePort) {
          return prev;
        }
        const isLiquid = spec.lineKind === 'liquid';
        const portPoint = isLiquid ? livePort.liquidPoint : livePort.gasPoint;
        const direction = normalizeDirection(
          (isLiquid ? livePort.liquidDirection : livePort.gasDirection) ??
            livePort.direction,
        );
        return {
          portPoint: { ...portPoint },
          direction: { ...direction },
          elevationMm: isLiquid
            ? livePort.liquidElevationMm
            : livePort.gasElevationMm,
          connectionKind: 'field-pipe',
          portId: (isLiquid ? livePort.liquidPortId : livePort.gasPortId) ?? livePort.portId,
          nodeId: (isLiquid ? livePort.liquidNodeId : livePort.gasNodeId) ?? livePort.nodeId,
          sourceElementId: movedKitElement.id,
          terminalRole: prev.terminalRole,
        };
      };
      const nextStartConnection = syncStart
        ? rebindSingle(spec.startConnection)
        : spec.startConnection;
      const nextEndConnection = syncEnd
        ? rebindSingle(spec.endConnection)
        : spec.endConnection;
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
      const routedElement = withCanonicalPipeRoute(element, nextRoutePoints, {
        startConnection: nextStartConnection,
        endConnection: nextEndConnection,
      });
      const nextProperties: Record<string, unknown> = { ...routedElement.properties };
      const nextNodes = normalizePipeRouteNodes3d(nextProperties.routeNodes3d);
      if (nextNodes.length >= 2) {
        if (syncStart && nextStartConnection) nextNodes[0]!.z = nextStartConnection.elevationMm;
        if (syncEnd && nextEndConnection) nextNodes[nextNodes.length - 1]!.z = nextEndConnection.elevationMm;
        nextProperties.routeNodes3d = nextNodes;
      }
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
          position: { x: nextVisual.bounds.minX, y: nextVisual.bounds.minY },
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
    const syncStart = isBranchKitBundleConnectionFromSource(
      startBundleConnection,
      movedKitElement.id,
    );
    const syncEnd = isBranchKitBundleConnectionFromSource(
      endBundleConnection,
      movedKitElement.id,
    );
    if (!syncStart && !syncEnd) {
      return;
    }
    const rebindBundle = (
      prev: RefrigerantPipeBundleConnection | null,
    ): RefrigerantPipeBundleConnection | null => {
      if (!prev || !prev.terminalRole) {
        return prev;
      }
      const livePort = livePorts.get(prev.terminalRole);
      if (!livePort) {
        return prev;
      }
      return {
        ...livePort,
        point: { ...livePort.point },
        gasPoint: { ...livePort.gasPoint },
        liquidPoint: { ...livePort.liquidPoint },
        gasFieldPoint: { ...livePort.gasFieldPoint },
        liquidFieldPoint: { ...livePort.liquidFieldPoint },
        direction: { ...livePort.direction },
        gasDirection: livePort.gasDirection
          ? { ...livePort.gasDirection }
          : undefined,
        liquidDirection: livePort.liquidDirection
          ? { ...livePort.liquidDirection }
          : undefined,
        sourceElementId: movedKitElement.id,
        terminalRole: prev.terminalRole,
        guideReference: prev.guideReference ?? livePort.guideReference,
      };
    };
    const nextStartBundleConnection = syncStart
      ? rebindBundle(startBundleConnection)
      : startBundleConnection;
    const nextEndBundleConnection = syncEnd
      ? rebindBundle(endBundleConnection)
      : endBundleConnection;
    if (
      bundleConnectionEquals(startBundleConnection, nextStartBundleConnection) &&
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
    const routedElement = withCanonicalPipeRoute(element, nextRoutePoints, {
      startBundleConnection: nextStartBundleConnection,
      endBundleConnection: nextEndBundleConnection,
    });
    const nextProperties: Record<string, unknown> = { ...routedElement.properties };
    const nextNodes = normalizePipeRouteNodes3d(nextProperties.routeNodes3d);
    if (nextNodes.length >= 2) {
      if (syncStart && nextStartBundleConnection) {
        nextNodes[0]!.z = nextStartBundleConnection.elevationMm;
      }
      if (syncEnd && nextEndBundleConnection) {
        nextNodes[nextNodes.length - 1]!.z = nextEndBundleConnection.elevationMm;
      }
      nextProperties.routeNodes3d = nextNodes;
    }
    const nextVisual = buildRefrigerantPipePairVisual(
      {
        position: element.position,
        width: element.width,
        depth: element.depth,
        elevation: element.elevation,
        properties: nextProperties,
      },
      sceneWithMovedKit,
    );
    updates.push({
      id: element.id,
      updates: {
        position: { x: nextVisual.bounds.minX, y: nextVisual.bounds.minY },
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
