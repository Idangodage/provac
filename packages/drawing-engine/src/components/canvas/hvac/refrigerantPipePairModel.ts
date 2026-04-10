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
  INCH_MM,
} from './refrigerantPipeDimensions';
import {
  getUnitPipePortEndpointLocal,
  getUnitPipePortSpec,
  GENERIC_PIPE_PORT_TYPES,
} from './unitPipePortModel';

export const ONE_INCH_MM = INCH_MM;
export const DEFAULT_REFRIGERANT_PIPE_INSULATION_THICKNESS_MM = ONE_INCH_MM;
export const DEFAULT_REFRIGERANT_PIPE_ELEVATION_MM = 2600;

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
  return {
    point,
    gasPoint,
    liquidPoint,
    gasFieldPoint,
    liquidFieldPoint,
    gasOuterDiameterMm: isFiniteNumber(candidate.gasOuterDiameterMm) ? candidate.gasOuterDiameterMm : undefined,
    liquidOuterDiameterMm: isFiniteNumber(candidate.liquidOuterDiameterMm) ? candidate.liquidOuterDiameterMm : undefined,
    gasDirection: gasDirection ? normalizeDirection(gasDirection) : undefined,
    liquidDirection: liquidDirection ? normalizeDirection(liquidDirection) : undefined,
    direction: normalizeDirection(direction),
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
    guideReference:
      candidate.guideReference === 'gas'
      || candidate.guideReference === 'liquid'
      || candidate.guideReference === 'center'
        ? candidate.guideReference
        : undefined,
    sourceElementId: typeof candidate.sourceElementId === 'string' ? candidate.sourceElementId : undefined,
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

function simplifyNearlyCollinearPoints(points: Point2D[]): Point2D[] {
  const deduped = dedupeConsecutivePoints(points);
  if (deduped.length < 3) {
    return deduped;
  }

  const angleToleranceCos = Math.cos((2 * Math.PI) / 180);
  const lateralToleranceMm = 0.2;
  const simplified: Point2D[] = [deduped[0]!];

  for (let index = 1; index < deduped.length - 1; index += 1) {
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

  return {
    routePoints: normalizePointArray(properties.routePoints),
    gasPipeDiameterMm,
    liquidPipeDiameterMm,
    gasOuterDiameterMm,
    liquidOuterDiameterMm,
    insulationThicknessMm,
    pipeGapMm: readNumber(properties.pipeGapMm, DEFAULT_REFRIGERANT_PIPE_GAP_MM),
    startBundleConnection: normalizeBundleConnection(properties.startBundleConnection),
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
  };
}

export function translateRefrigerantPipeProperties(
  properties: Record<string, unknown>,
  delta: Point2D,
): Record<string, unknown> {
  const spec = resolveRefrigerantPipeSpec(properties);
  const nextConnection = spec.startConnection
    ? {
        ...spec.startConnection,
        portPoint: add(spec.startConnection.portPoint, delta),
      }
    : null;

  return {
    ...properties,
    routePoints: spec.routePoints.map((point) => add(point, delta)),
    startConnection: nextConnection,
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
  if (
    !endBundleConnection
    || endBundleConnection.connectionKind === 'field-pipe'
    || guidePoints.length < 1
  ) {
    return guidePoints;
  }

  const endCenter = computeBundleCenter(
    endBundleConnection.gasFieldPoint,
    endBundleConnection.liquidFieldPoint,
  );
  const endDir = endBundleConnection.direction;

  // The approach point sits tailLengthMm outward from endCenter along the port
  // exit direction.  The segment approachPoint → endCenter is therefore aligned
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
  if (routePoints.length < 2) {
    return routePoints;
  }

  const FIELD_CONTINUATION_LATERAL_TOLERANCE_MM = 0.75;
  const takeoffEnd = add(connectionCenter, scale(direction, takeoffLengthMm));
  const remaining = routePoints.slice(1);
  const firstPoint = remaining[0];
  if (!firstPoint) {
    return dedupeConsecutivePoints([connectionCenter, takeoffEnd]);
  }

  const normal = perpendicular(direction);
  const firstDelta = subtract(firstPoint, connectionCenter);
  const projectedDistance = Math.max(0, dot(firstDelta, direction));
  const lateralOffsetMm = dot(firstDelta, normal);
  const axisAdvanceMm = Math.max(projectedDistance, takeoffLengthMm);
  const axisJoinPoint = add(connectionCenter, scale(direction, axisAdvanceMm));
  const points: Point2D[] = [connectionCenter, takeoffEnd];

  if (Math.hypot(axisJoinPoint.x - takeoffEnd.x, axisJoinPoint.y - takeoffEnd.y) > 0.2) {
    points.push(axisJoinPoint);
  }

  if (Math.abs(lateralOffsetMm) > FIELD_CONTINUATION_LATERAL_TOLERANCE_MM) {
    const correctedFirstPoint = add(
      axisJoinPoint,
      scale(normal, lateralOffsetMm),
    );
    if (
      Math.hypot(
        correctedFirstPoint.x - points[points.length - 1]!.x,
        correctedFirstPoint.y - points[points.length - 1]!.y,
      ) > 0.2
    ) {
      points.push(correctedFirstPoint);
    }
  }

  points.push(...remaining.slice(1));
  return dedupeConsecutivePoints(points);
}

function buildTakeoffTailPoints(
  routePoints: Point2D[],
  connectionPoint: Point2D,
  direction: Point2D,
  takeoffLengthMm: number,
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

  if (startBundleConnection.connectionKind === 'unit-port') {
    const offsetSign = Math.sign(liquidPortOffset - gasPortOffset) || 1;
    return {
      gasOffsetMm: -offsetSign * centerSpacingMm / 2,
      liquidOffsetMm: offsetSign * centerSpacingMm / 2,
    };
  }

  return {
    gasOffsetMm: gasPortOffset,
    liquidOffsetMm: liquidPortOffset,
  };
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
  // perpendicular to the port direction — no endpoint-snapping hack needed.
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
  const bundleCenter = computeBundleCenter(
    startBundleConnection.gasFieldPoint,
    startBundleConnection.liquidFieldPoint,
  );

  // Compute port-based perpendicular offsets so the guide routes start exactly at
  // the port positions. The perpendicular direction is direction rotated 90° CCW.
  // Using port-derived offsets instead of centerSpacingMm/2 ensures the routes are
  // parallel to each other from the very first point (no convergence near the unit).
  const perpDir = { x: -direction.y, y: direction.x };
  const gasPortOffset = dot(subtract(startBundleConnection.gasFieldPoint, bundleCenter), perpDir);
  const liquidPortOffset = dot(subtract(startBundleConnection.liquidFieldPoint, bundleCenter), perpDir);
  const gasToLiquidOffset = liquidPortOffset - gasPortOffset;
  const desiredParallelOffsets = resolveParallelBundleOffsets(startBundleConnection, centerSpacingMm);

  if (anchor === 'gas') {
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
        );
    const desiredLiquidOffset = desiredParallelOffsets.liquidOffsetMm - desiredParallelOffsets.gasOffsetMm;
    const liquidGuidePoints = isFieldPipeConnection
      ? gasGuidePoints.length >= 1
        ? dedupeConsecutivePoints(offsetPolyline(gasGuidePoints, gasToLiquidOffset))
        : []
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
      bundleGuidePoints: gasGuidePoints.length >= 1
        ? dedupeConsecutivePoints(offsetPolyline(gasGuidePoints, desiredLiquidOffset / 2))
        : [bundleCenter],
    };
  }

  if (anchor === 'liquid') {
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
        );
    const desiredGasOffset = desiredParallelOffsets.gasOffsetMm - desiredParallelOffsets.liquidOffsetMm;
    const gasGuidePoints = isFieldPipeConnection
      ? liquidGuidePoints.length >= 1
        ? dedupeConsecutivePoints(offsetPolyline(liquidGuidePoints, -gasToLiquidOffset))
        : []
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
      bundleGuidePoints: liquidGuidePoints.length >= 1
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
      );
  const gasGuidePoints = isFieldPipeConnection
    ? bundleGuidePoints.length >= 1
      ? dedupeConsecutivePoints(offsetPolyline(bundleGuidePoints, gasPortOffset))
      : []
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
    ? bundleGuidePoints.length >= 1
      ? dedupeConsecutivePoints(offsetPolyline(bundleGuidePoints, liquidPortOffset))
      : []
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
  const startGuideReference = resolveBundleGuideReference(startBundleConnection);
  const isUnitPortStart = startBundleConnection?.connectionKind === 'unit-port';
  const canContinueSelectedFieldPipe =
    startBundleConnection?.connectionKind === 'field-pipe'
    && (startGuideReference === 'gas' || startGuideReference === 'liquid')
    && (
      !endBundleConnection
      || endBundleConnection.connectionKind !== 'field-pipe'
      || !endBundleConnection.guideReference
      || endBundleConnection.guideReference === startGuideReference
    );

  if (canContinueSelectedFieldPipe) {
    const leadKind = startGuideReference;
    const leadGuidePoints = leadKind === 'gas' ? gasGuidePoints : liquidGuidePoints;
    const leadRoutePoints = roundPolylineCorners(leadGuidePoints, bendRadiusMm);
    const { gasOffsetMm, liquidOffsetMm } = resolveParallelBundleOffsets(
      startBundleConnection,
      centerSpacingMm,
    );
    const companionOffsetMm = leadKind === 'gas'
      ? liquidOffsetMm - gasOffsetMm
      : gasOffsetMm - liquidOffsetMm;
    const companionGuidePoints = leadGuidePoints.length >= 1
      ? dedupeConsecutivePoints(offsetPolyline(leadGuidePoints, companionOffsetMm))
      : [];
    const companionRoutePoints = companionGuidePoints.length >= 1
      ? roundPolylineCorners(companionGuidePoints, bendRadiusMm)
      : [];
    const gasRouteBase = leadKind === 'gas' ? leadRoutePoints : companionRoutePoints;
    const liquidRouteBase = leadKind === 'liquid' ? leadRoutePoints : companionRoutePoints;

    return {
      gasRoutePoints: anchorGuideRouteEnd(
        anchorGuideRouteStart(
          gasRouteBase,
          startBundleConnection?.connectionKind === 'field-pipe'
            ? startBundleConnection.gasFieldPoint
            : null,
        ),
        endBundleConnection?.gasFieldPoint ?? null,
      ),
      liquidRoutePoints: anchorGuideRouteEnd(
        anchorGuideRouteStart(
          liquidRouteBase,
          startBundleConnection?.connectionKind === 'field-pipe'
            ? startBundleConnection.liquidFieldPoint
            : null,
        ),
        endBundleConnection?.liquidFieldPoint ?? null,
      ),
    };
  }

  const { gasOffsetMm, liquidOffsetMm } = resolveParallelBundleOffsets(
    startBundleConnection,
    centerSpacingMm,
  );
  const gasParallelGuidePoints = bundleGuidePoints.length >= 1
    ? dedupeConsecutivePoints(offsetPolyline(bundleGuidePoints, gasOffsetMm))
    : [];
  const liquidParallelGuidePoints = bundleGuidePoints.length >= 1
    ? dedupeConsecutivePoints(offsetPolyline(bundleGuidePoints, liquidOffsetMm))
    : [];
  const gasParallelRoutePoints = gasParallelGuidePoints.length >= 1
    ? roundPolylineCorners(gasParallelGuidePoints, bendRadiusMm)
    : [];
  const liquidParallelRoutePoints = liquidParallelGuidePoints.length >= 1
    ? roundPolylineCorners(liquidParallelGuidePoints, bendRadiusMm)
    : [];

  if (isUnitPortStart) {
    const gasRoundedGuidePoints = gasGuidePoints.length >= 1
      ? roundPolylineCorners(gasGuidePoints, bendRadiusMm)
      : [];
    const liquidRoundedGuidePoints = liquidGuidePoints.length >= 1
      ? roundPolylineCorners(liquidGuidePoints, bendRadiusMm)
      : [];

    return {
      gasRoutePoints: anchorGuideRouteEnd(
        mergeGuideRouteWithParallelRoute(
          gasRoundedGuidePoints,
          gasParallelRoutePoints,
        ),
        endBundleConnection?.gasFieldPoint ?? null,
      ),
      liquidRoutePoints: anchorGuideRouteEnd(
        mergeGuideRouteWithParallelRoute(
          liquidRoundedGuidePoints,
          liquidParallelRoutePoints,
        ),
        endBundleConnection?.liquidFieldPoint ?? null,
      ),
    };
  }

  return {
    gasRoutePoints: anchorGuideRouteEnd(
      anchorGuideRouteStart(
        mergeGuideRouteWithParallelRoute(gasGuidePoints, gasParallelRoutePoints),
        startBundleConnection?.connectionKind === 'field-pipe'
          ? startBundleConnection.gasFieldPoint
          : null,
      ),
      endBundleConnection?.gasFieldPoint ?? null,
    ),
    liquidRoutePoints: anchorGuideRouteEnd(
      anchorGuideRouteStart(
        mergeGuideRouteWithParallelRoute(liquidGuidePoints, liquidParallelRoutePoints),
        startBundleConnection?.connectionKind === 'field-pipe'
          ? startBundleConnection.liquidFieldPoint
          : null,
      ),
      endBundleConnection?.liquidFieldPoint ?? null,
    ),
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

    const tangentDistance = Math.min(
      radiusMm / Math.tan(interiorAngle / 2),
      incomingLength * 0.45,
      outgoingLength * 0.45,
    );
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
  const isUnitPortConnection = spec.startConnection?.connectionKind === 'unit-port';
  const hasStartConnection = Boolean(spec.startConnection);
  const localZMm = spec.startConnection
    ? spec.startConnection.elevationMm - baseElevationMm
    : outerRadiusMm;
  const connectionOverlapMm = hasStartConnection
    ? computeConnectionOverlapLength(spec.outerDiameterMm)
    : 0;
  const exposedTailLengthMm = 0;
  const renderedRoutePoints = simplifyNearlyCollinearPoints(spec.routePoints);
  const insulationStartPoint = spec.startConnection && isUnitPortConnection
    ? add(spec.startConnection.portPoint, scale(spec.startConnection.direction, exposedTailLengthMm))
    : null;
  const routeStartPoint = insulationStartPoint
    ?? renderedRoutePoints[0]
    ?? null;
  const outerPoints = routeStartPoint
    ? simplifyNearlyCollinearPoints([routeStartPoint, ...renderedRoutePoints])
    : [...renderedRoutePoints];
  const stubStart = spec.startConnection && isUnitPortConnection
    ? add(spec.startConnection.portPoint, scale(spec.startConnection.direction, -connectionOverlapMm))
    : null;
  const stubEnd = spec.startConnection && isUnitPortConnection
    ? spec.startConnection.portPoint
    : null;
  const boundsSourcePoints = [
    ...outerPoints,
  ];
  if (spec.startConnection) {
    boundsSourcePoints.push(spec.startConnection.portPoint);
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
): RefrigerantPipePairVisualSpec {
  const spec = resolveRefrigerantPipePairSpec(element.properties);
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
  const centerSpacingMm = gasOuterRadiusMm + liquidOuterRadiusMm + spec.pipeGapMm;
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
    ? simplifyNearlyCollinearPoints([gasInsulationStartPoint, ...gasRoutePoints])
    : simplifyNearlyCollinearPoints(gasRoutePoints);
  const liquidOuterPoints = liquidInsulationStartPoint
    ? simplifyNearlyCollinearPoints([liquidInsulationStartPoint, ...liquidRoutePoints])
    : simplifyNearlyCollinearPoints(liquidRoutePoints);

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
        : DEFAULT_REFRIGERANT_PIPE_ELEVATION_MM;

  const properties = {
    routePoints: dedupeConsecutivePoints(routePoints),
    pipeDiameterMm: options.pipeDiameterMm,
    outerDiameterMm: resolvedOuterDiameterMm,
    insulationThicknessMm: resolvedInsulationThicknessMm,
    lineKind: options.lineKind,
    bundleId: options.bundleId,
    startConnection: options.startConnection ?? null,
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
  const pipeGapMm = options?.pipeGapMm ?? DEFAULT_REFRIGERANT_PIPE_GAP_MM;
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
    pipeGapMm: options?.pipeGapMm ?? DEFAULT_REFRIGERANT_PIPE_GAP_MM,
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

function createPipeEndpointTarget(
  element: HvacPipeSnapSource,
  spec: RefrigerantPipeSpec,
  visual: RefrigerantPipeVisualSpec,
  end: 'start' | 'end',
): RefrigerantPipeEndpointTarget | null {
  const points = visual.outerPoints;
  if (points.length < 2) {
    return null;
  }

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
      elevationMm: element.elevation + visual.localZMm,
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
    elevationMm: element.elevation + visual.localZMm,
    outerDiameterMm: spec.outerDiameterMm,
  };
}

function getRefrigerantPipeEndpointTargets(
  elements: HvacPipeSnapSource[],
): RefrigerantPipeEndpointTarget[] {
  const targets: RefrigerantPipeEndpointTarget[] = [];

  elements.forEach((element) => {
    if (element.type !== 'refrigerant-pipe') {
      return;
    }

    const spec = resolveRefrigerantPipeSpec(element.properties);
    const visual = buildRefrigerantPipeVisual(element);
    const endTarget = createPipeEndpointTarget(element, spec, visual, 'end');
    if (!spec.startConnection) {
      const startTarget = createPipeEndpointTarget(element, spec, visual, 'start');
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
        + DEFAULT_REFRIGERANT_PIPE_GAP_MM;
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

export function getRefrigerantPipeBundleSnapTargets(
  elements: HvacPipeSnapSource[],
): RefrigerantPipeBundleConnection[] {
  const targets: RefrigerantPipeBundleConnection[] = [];

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
