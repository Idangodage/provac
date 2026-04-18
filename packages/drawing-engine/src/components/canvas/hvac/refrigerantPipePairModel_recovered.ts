import type { HvacElement, Point2D } from '../../../types';
import {
  buildCeilingCassetteModel,
  getCeilingCassettePipePortEndpointLocal,
} from './ceilingCassetteModel';
import {
  DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM,
  DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM,
  DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM,
  DEFAULT_REFRIGERANT_PIPE_GAP_MM,
  DEFAULT_REFRIGERANT_PIPE_INSULATION_THICKNESS_MM,
  INCH_MM,
} from './refrigerantPipeDimensions';
import {
  getUnitPipePortEndpointLocal,
  getUnitPipePortSpec,
  GENERIC_PIPE_PORT_TYPES,
} from './unitPipePortModel';
import {
  buildRefrigerantBranchKitViewModel,
  isRefrigerantBranchKitElement,
  resolveRefrigerantBranchKitConnectionIdentity,
  resolveRefrigerantBranchKitInlineAnchorLocal,
  resolveRefrigerantBranchKitLineSelection,
  type RefrigerantBranchTerminalRole,
} from './refrigerantBranchKitModel';

export const ONE_INCH_MM = INCH_MM;
export { DEFAULT_REFRIGERANT_PIPE_INSULATION_THICKNESS_MM };
export const DEFAULT_REFRIGERANT_PIPE_ELEVATION_MM = 2600;
// 1-inch gap between outer insulation surfaces
const REQUIRED_REFRIGERANT_PIPE_GAP_MM = ONE_INCH_MM;
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
  gasLocalOuterPoints: Point2D[];
  liquidLocalOuterPoints: Point2D[];
  gasLocalStub: { start: Point2D; end: Point2D } | null;
  liquidLocalStub: { start: Point2D; end: Point2D } | null;
}

export type RefrigerantPipeLineKind = 'gas' | 'liquid';

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
  bundleId?: string;
  startConnection: RefrigerantPipeConnection | null;
  endConnection: RefrigerantPipeConnection | null;
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
  localStub: { start: Point2D; end: Point2D } | null;
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
    REQUIRED_REFRIGERANT_PIPE_GAP_MM;
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
    elevationMm: readNumber(candidate.elevationMm, DEFAULT_REFRIGERANT_PIPE_ELEVATION_MM),
    gasElevationMm: readNumber(
      candidate.gasElevationMm,
      readNumber(candidate.elevationMm, DEFAULT_REFRIGERANT_PIPE_ELEVATION_MM),
    ),
    liquidElevationMm: readNumber(
      candidate.liquidElevationMm,
      readNumber(candidate.elevationMm, DEFAULT_REFRIGERANT_PIPE_ELEVATION_MM),
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
    || startBundleConnection.connectionKind !== 'field-pipe'
    || !startBundleConnection.sourceElementId
    || !contextElements
    || contextElements.length === 0
  ) {
    return startBundleConnection;
  }

  const sourceElement = contextElements.find(
    (candidate) =>
      candidate.id === startBundleConnection.sourceElementId
      && isRefrigerantBranchKitElement(candidate),
  );
  if (!sourceElement) {
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
    elevationMm: readNumber(candidate.elevationMm, DEFAULT_REFRIGERANT_PIPE_ELEVATION_MM),
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
    pipeGapMm: REQUIRED_REFRIGERANT_PIPE_GAP_MM,
    startBundleConnection,
    endBundleConnection: normalizeBundleConnection(properties.endBundleConnection),
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

  return {
    routePoints: normalizePointArray(properties.routePoints),
    pipeDiameterMm,
    outerDiameterMm,
    insulationThicknessMm,
    lineKind: normalizeLineKind(properties.lineKind),
    bundleId: typeof properties.bundleId === 'string' ? properties.bundleId : undefined,
    startConnection: normalizePipeConnection(properties.startConnection),
    endConnection: normalizePipeConnection(properties.endConnection),
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
    startConnection: nextStartConnection,
    endConnection: nextEndConnection,
    centerline_start: centerlineStart ? add(centerlineStart, delta) : properties.centerline_start,
    centerline_end: centerlineEnd ? add(centerlineEnd, delta) : properties.centerline_end,
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

function buildStartConnectedPath(
  portPoint: Point2D | null,
  direction: Point2D | null,
  takeoffLengthMm: number,
  mainPoints: Point2D[],
): Point2D[] {
  if (!portPoint) {
    return [...mainPoints];
  }

  const points: Point2D[] = [portPoint];
  if (direction && takeoffLengthMm > 0.01) {
    points.push(add(portPoint, scale(direction, takeoffLengthMm)));
  }
  points.push(...mainPoints);
  return dedupeConsecutivePoints(points);
}

function computeBundleCenter(gasPoint: Point2D, liquidPoint: Point2D): Point2D {
  return {
    x: (gasPoint.x + liquidPoint.x) / 2,
    y: (gasPoint.y + liquidPoint.y) / 2,
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
  const anchorPoint = normalizePoint(element.properties.branchKitSnapPoint);
  if (!anchorPoint) {
    return null;
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
  // Use a small, visually tight bend radius.
  // The actual inner/outer pipe radii will be adjusted concentrically
  // to maintain constant gap through bends.
  return Math.max(6, maxOuterDiameterMm * 0.5, centerSpacingMm * 0.4);
}

function computeConnectionOverlapLength(maxOuterDiameterMm: number): number {
  return Math.max(2.5, Math.min(6, maxOuterDiameterMm * 0.2));
}

function computeExposedConnectionTailLength(outerDiameterMm: number): number {
  return Math.max(22, Math.min(38, outerDiameterMm * 0.45));
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

  // Use ACTUAL port offsets for both field-pipe and unit-port connections.
  // This ensures pipe centerlines align exactly with the connection points
  // (gasFieldPoint / liquidFieldPoint) rather than using a generic centerSpacingMm
  // that may differ from the actual port spacing (e.g., 42mm vs 44.45mm).
  return {
    gasOffsetMm: gasPortOffset,
    liquidOffsetMm: liquidPortOffset,
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
  const effectiveGasToLiquidOffset = isFieldPipeConnection
    ? desiredGasToLiquidOffset
    : gasToLiquidOffset;
  const effectiveGasPortOffset = isFieldPipeConnection
    ? desiredParallelOffsets.gasOffsetMm
    : gasPortOffset;
  const effectiveLiquidPortOffset = isFieldPipeConnection
    ? desiredParallelOffsets.liquidOffsetMm
    : liquidPortOffset;

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
    const guideJoinPoint = guidePoints[bestGuideIndex]!;
    const parallelJoinPoint = parallelPoints[bestParallelIndex]!;
    const splicePoint =
      bestDistance <= 0.2
        ? guideJoinPoint
        : {
            x: (guideJoinPoint.x + parallelJoinPoint.x) / 2,
            y: (guideJoinPoint.y + parallelJoinPoint.y) / 2,
          };
    return dedupeConsecutivePoints([
      ...guidePoints.slice(0, bestGuideIndex),
      splicePoint,
      ...parallelPoints.slice(
        bestDistance <= 0.2 ? bestParallelIndex + 1 : bestParallelIndex,
      ),
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
  // Key: offset the straight-line guide FIRST, then round with the SAME radius.
  // This maintains consistent visual appearance and parallel pipe geometry.
  const { gasOffsetMm, liquidOffsetMm } = resolveParallelBundleOffsets(
    startBundleConnection,
    centerSpacingMm,
  );
  
  // Offset the NON-ROUNDED bundle guide to get straight-line gas/liquid paths
  const gasOffsetGuide = simplifiedBundleGuidePoints.length >= 1
    ? dedupeConsecutivePoints(offsetPolyline(simplifiedBundleGuidePoints, gasOffsetMm))
    : [];
  const liquidOffsetGuide = simplifiedBundleGuidePoints.length >= 1
    ? dedupeConsecutivePoints(offsetPolyline(simplifiedBundleGuidePoints, liquidOffsetMm))
    : [];
  
  // Round each pipe's guide with the SAME radius for visual consistency.
  // Using identical radius creates parallel curves with constant separation
  // at entry/exit points of each bend.
  const gasParallelBasePoints = gasOffsetGuide.length >= 1
    ? dedupeConsecutivePoints(roundPolylineCorners(gasOffsetGuide, bendRadiusMm))
    : [];
  const liquidParallelBasePoints = liquidOffsetGuide.length >= 1
    ? dedupeConsecutivePoints(roundPolylineCorners(liquidOffsetGuide, bendRadiusMm))
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

  // For unit-port connections, use the anchored routes directly
  // (Field-pipe connections are handled above with the translation approach)
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
  const isStartSnapPoint =
    Math.hypot(firstPoint.x - startBundleConnection.gasPoint.x, firstPoint.y - startBundleConnection.gasPoint.y) <= 1
    || Math.hypot(firstPoint.x - startBundleConnection.liquidPoint.x, firstPoint.y - startBundleConnection.liquidPoint.y) <= 1
    || Math.hypot(firstPoint.x - bundleCenterPoint.x, firstPoint.y - bundleCenterPoint.y) <= 1;

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

export function buildRefrigerantPipeVisual(
  element: Pick<HvacElement, 'position' | 'width' | 'depth' | 'properties'> & { elevation?: number },
): RefrigerantPipeVisualSpec {
  const spec = resolveRefrigerantPipeSpec(element.properties);
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
  const exposedTailLengthMm = 0;
  const renderedRoutePoints = simplifyNearlyCollinearPoints(spec.routePoints);
  const insulationStartPoint =
    spec.startConnection && (isUnitPortStartConnection || isFieldPipeStartConnection)
    ? add(spec.startConnection.portPoint, scale(spec.startConnection.direction, exposedTailLengthMm))
    : null;
  const insulationEndPoint =
    spec.endConnection && (isUnitPortEndConnection || isFieldPipeEndConnection)
      ? add(spec.endConnection.portPoint, scale(spec.endConnection.direction, exposedTailLengthMm))
      : null;
  const routeStartPoint = insulationStartPoint
    ?? renderedRoutePoints[0]
    ?? null;
  const outerPoints = simplifyNearlyCollinearPoints([
    ...(routeStartPoint ? [routeStartPoint] : []),
    ...renderedRoutePoints,
    ...(insulationEndPoint ? [insulationEndPoint] : []),
  ]);
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
  return {
    ...spec,
    bounds,
    outerRadiusMm,
    coreRadiusMm,
    localZMm,
    outerPoints,
    localOuterPoints: outerPoints.map((point) => subtract(point, bounds.center)),
    localStub: computeLocalStub(stubStart, stubEnd, bounds.center),
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
    gasOuterRadiusMm + liquidOuterRadiusMm + REQUIRED_REFRIGERANT_PIPE_GAP_MM;
  const bendRadiusMm = Math.max(
    12,
    computeCompactBendRadius(
      centerSpacingMm,
      Math.max(gasOuterDiameterMm, liquidOuterDiameterMm),
    ),
  );
  const gasExposedTailLengthMm = 0;
  const liquidExposedTailLengthMm = 0;
  const connectionOverlapMm = computeConnectionOverlapLength(
    Math.max(gasOuterDiameterMm, liquidOuterDiameterMm),
  );
  const gasStubDirection = spec.startBundleConnection?.gasDirection ?? spec.startBundleConnection?.direction ?? null;
  const liquidStubDirection = spec.startBundleConnection?.liquidDirection ?? spec.startBundleConnection?.direction ?? null;
  const isUnitPortConnection = spec.startBundleConnection?.connectionKind === 'unit-port';
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
        [gasInsulationStartPoint, ...gasRoutePoints],
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
        [liquidInsulationStartPoint, ...liquidRoutePoints],
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
    gasLocalOuterPoints,
    liquidLocalOuterPoints,
    gasLocalStub,
    liquidLocalStub,
  };
}

export function buildRefrigerantPipeElement(
  routePoints: Point2D[],
  options: {
    label?: string;
    lineKind: RefrigerantPipeLineKind;
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
        : DEFAULT_REFRIGERANT_PIPE_ELEVATION_MM;
  const centerlineRoutePoints = resolveCenterlinePathWithConnections(
    routePoints,
    options.startConnection ?? null,
    options.endConnection ?? null,
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
  const pipeGapMm = REQUIRED_REFRIGERANT_PIPE_GAP_MM;
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
        : options?.startBundleConnection?.elevationMm ?? DEFAULT_REFRIGERANT_PIPE_ELEVATION_MM;
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
    pipeGapMm: REQUIRED_REFRIGERANT_PIPE_GAP_MM,
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
        + REQUIRED_REFRIGERANT_PIPE_GAP_MM;
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
        REQUIRED_REFRIGERANT_PIPE_GAP_MM;
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
  const branchRoles: RefrigerantBranchTerminalRole[] = [
    'inlet',
    'run-outlet',
    'branch-outlet',
  ];

  elements.forEach((element) => {
    if (element.type === 'ceiling-cassette-ac') {
      const cassette = buildCeilingCassetteModel(element);
      const gasPort = cassette.pipePorts.find((port) => port.kind === 'gas');
      const liquidPort = cassette.pipePorts.find((port) => port.kind === 'liquid');
      if (!gasPort || !liquidPort) {
        return;
      }

      const center = absoluteCenter(element);
      const direction = normalizeDirection(rotateLocalPoint({ x: 1, y: 0 }, element.rotation ?? 0));
      const gasPoint = localToWorld(center, getCeilingCassettePipePortEndpointLocal(gasPort), element.rotation ?? 0);
      const liquidPoint = localToWorld(center, getCeilingCassettePipePortEndpointLocal(liquidPort), element.rotation ?? 0);
      const gasElevationMm = element.elevation + gasPort.z;
      const liquidElevationMm = element.elevation + liquidPort.z;

      targets.push({
        point: computeBundleCenter(gasPoint, liquidPoint),
        gasPoint,
        liquidPoint,
        gasFieldPoint: gasPoint,
        liquidFieldPoint: liquidPoint,
        gasOuterDiameterMm: gasPort.radius * 2,
        liquidOuterDiameterMm: liquidPort.radius * 2,
        gasDirection: direction,
        liquidDirection: direction,
        direction,
        elevationMm: (gasElevationMm + liquidElevationMm) / 2,
        gasElevationMm,
        liquidElevationMm,
        connectionKind: 'unit-port',
        sourceElementId: element.id,
      });
      return;
    }

    if (isRefrigerantBranchKitElement(element)) {
      const lineSelection = resolveRefrigerantBranchKitLineSelection(element);
      const model = buildRefrigerantBranchKitViewModel(element);
      const inlinePlacement = resolveInlineBranchKitCenter(
        element,
        lineSelection,
        model,
      );
      const center = inlinePlacement?.center ?? absoluteCenter(element);
      const rotationDeg = inlinePlacement?.rotationDeg ?? (element.rotation ?? 0);

      branchRoles.forEach((role) => {
        const identity = resolveRefrigerantBranchKitConnectionIdentity({
          model,
          role,
          lineSelection,
          worldCenter: center,
          rotationDeg,
        });
        if (!identity) {
          return;
        }

        const gasTerminal = identity.gasTerminal;
        const liquidTerminal = identity.liquidTerminal;
        const gasPoint = identity.gasPoint;
        const liquidPoint = identity.liquidPoint;
        const gasDirection = identity.gasDirection;
        const liquidDirection = identity.liquidDirection;
        const direction = identity.direction;
        const guideReference = identity.guideReference;

        targets.push({
          point: computeBundleCenter(gasPoint, liquidPoint),
          gasPoint,
          liquidPoint,
          gasFieldPoint: gasPoint,
          liquidFieldPoint: liquidPoint,
          gasOuterDiameterMm: gasTerminal.outerDiameterMm,
          liquidOuterDiameterMm: liquidTerminal.outerDiameterMm,
          gasDirection,
          liquidDirection,
          direction,
          elevationMm:
            element.elevation +
            (model.gas.centerlineZMm + model.liquid.centerlineZMm) / 2,
          gasElevationMm: element.elevation + model.gas.centerlineZMm,
          liquidElevationMm: element.elevation + model.liquid.centerlineZMm,
          connectionKind: 'field-pipe',
          guideReference,
          sourceElementId: element.id,
          terminalRole: role,
        });
      });
      return;
    }

    if (!GENERIC_PIPE_PORT_TYPES.has(element.type)) {
      return;
    }

    const portSpec = getUnitPipePortSpec(element);
    if (!portSpec) {
      return;
    }
    const gasPort = portSpec.ports.find((p) => p.kind === 'gas');
    const liquidPort = portSpec.ports.find((p) => p.kind === 'liquid');
    if (!gasPort || !liquidPort) {
      return;
    }

    const center = absoluteCenter(element);
    const rotation = element.rotation ?? 0;
    const direction = normalizeDirection(rotateLocalPoint(portSpec.localDirection, rotation));
    const gasEndpoint = getUnitPipePortEndpointLocal(gasPort);
    const liquidEndpoint = getUnitPipePortEndpointLocal(liquidPort);
    const gasPoint = localToWorld(center, gasEndpoint, rotation);
    const liquidPoint = localToWorld(center, liquidEndpoint, rotation);
    const gasElevationMm = element.elevation + gasPort.localZ;
    const liquidElevationMm = element.elevation + liquidPort.localZ;

    targets.push({
      point: computeBundleCenter(gasPoint, liquidPoint),
      gasPoint,
      liquidPoint,
      gasFieldPoint: gasPoint,
      liquidFieldPoint: liquidPoint,
      gasOuterDiameterMm: gasPort.radius * 2,
      liquidOuterDiameterMm: liquidPort.radius * 2,
      gasDirection: direction,
      liquidDirection: direction,
      direction,
      elevationMm: (gasElevationMm + liquidElevationMm) / 2,
      gasElevationMm,
      liquidElevationMm,
      connectionKind: 'unit-port',
      sourceElementId: element.id,
    });
  });

  return [
    ...targets,
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
