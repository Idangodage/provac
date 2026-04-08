import type { HvacElement, Point2D } from '../../../types';
import { buildCeilingCassetteModel } from './ceilingCassetteModel';
import {
  DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM,
  DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM,
  DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM,
  DEFAULT_REFRIGERANT_PIPE_GAP_MM,
  INCH_MM,
} from './refrigerantPipeDimensions';

export const ONE_INCH_MM = INCH_MM;
export const DEFAULT_REFRIGERANT_PIPE_INSULATION_THICKNESS_MM = 13;
export const DEFAULT_REFRIGERANT_PIPE_ELEVATION_MM = 2600;

export interface RefrigerantPipeBundleConnection {
  point: Point2D;
  gasPoint: Point2D;
  liquidPoint: Point2D;
  gasFieldPoint: Point2D;
  liquidFieldPoint: Point2D;
  direction: Point2D;
  elevationMm: number;
  gasElevationMm: number;
  liquidElevationMm: number;
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
  sourceElementId?: string;
}

export interface RefrigerantPipeSpec {
  routePoints: Point2D[];
  pipeDiameterMm: number;
  outerDiameterMm: number;
  insulationThicknessMm: number;
  lineKind: RefrigerantPipeLineKind;
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
    direction?: unknown;
    elevationMm?: unknown;
    gasElevationMm?: unknown;
    liquidElevationMm?: unknown;
    sourceElementId?: unknown;
  };
  const point = normalizePoint(candidate.point);
  const gasPoint = normalizePoint(candidate.gasPoint);
  const liquidPoint = normalizePoint(candidate.liquidPoint);
  const gasFieldPoint = normalizePoint(candidate.gasFieldPoint) ?? gasPoint;
  const liquidFieldPoint = normalizePoint(candidate.liquidFieldPoint) ?? liquidPoint;
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
    sourceElementId: typeof candidate.sourceElementId === 'string' ? candidate.sourceElementId : undefined,
  };
}

function normalizeLineKind(value: unknown): RefrigerantPipeLineKind {
  return value === 'liquid' ? 'liquid' : 'gas';
}

function normalizePipeConnection(value: unknown): RefrigerantPipeConnection | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as {
    portPoint?: unknown;
    direction?: unknown;
    elevationMm?: unknown;
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
  const insulationThicknessMm = readNumber(
    properties.insulationThicknessMm,
    DEFAULT_REFRIGERANT_PIPE_INSULATION_THICKNESS_MM,
  );
  const gasOuterDiameterMm = Math.max(
    gasPipeDiameterMm,
    readNumber(
      properties.gasOuterDiameterMm,
      DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM,
    ),
  );
  const liquidOuterDiameterMm = Math.max(
    liquidPipeDiameterMm,
    readNumber(
      properties.liquidOuterDiameterMm,
      DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM,
    ),
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
  };
}

export function translateRefrigerantPipePairProperties(
  properties: Record<string, unknown>,
  delta: Point2D,
): Record<string, unknown> {
  const spec = resolveRefrigerantPipePairSpec(properties);
  const nextBundle = spec.startBundleConnection
    ? {
        ...spec.startBundleConnection,
        point: add(spec.startBundleConnection.point, delta),
        gasPoint: add(spec.startBundleConnection.gasPoint, delta),
        liquidPoint: add(spec.startBundleConnection.liquidPoint, delta),
        gasFieldPoint: add(spec.startBundleConnection.gasFieldPoint, delta),
        liquidFieldPoint: add(spec.startBundleConnection.liquidFieldPoint, delta),
      }
    : null;

  return {
    ...properties,
    routePoints: spec.routePoints.map((point) => add(point, delta)),
    startBundleConnection: nextBundle,
  };
}

export function resolveRefrigerantPipeSpec(
  properties: Record<string, unknown>,
): RefrigerantPipeSpec {
  const pipeDiameterMm = readNumber(
    properties.pipeDiameterMm,
    DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM,
  );
  const outerDiameterMm = Math.max(
    pipeDiameterMm,
    readNumber(
      properties.outerDiameterMm,
      DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM,
    ),
  );

  return {
    routePoints: normalizePointArray(properties.routePoints),
    pipeDiameterMm,
    outerDiameterMm,
    insulationThicknessMm: readNumber(
      properties.insulationThicknessMm,
      DEFAULT_REFRIGERANT_PIPE_INSULATION_THICKNESS_MM,
    ),
    lineKind: normalizeLineKind(properties.lineKind),
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
  return Math.max(40, centerSpacingMm * 0.9, maxOuterDiameterMm * 2.1);
}

function computeConnectionOverlapLength(maxOuterDiameterMm: number): number {
  return Math.max(2.5, Math.min(6, maxOuterDiameterMm * 0.2));
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

  const takeoffEnd = add(connectionCenter, scale(direction, takeoffLengthMm));
  const remaining = routePoints.slice(1);
  const firstPoint = remaining[0];
  if (!firstPoint) {
    return dedupeConsecutivePoints([connectionCenter, takeoffEnd]);
  }

  const projectedDistance = dot(subtract(firstPoint, connectionCenter), direction);
  const adjustedFirstPoint = projectedDistance < takeoffLengthMm
    ? add(firstPoint, scale(direction, takeoffLengthMm - projectedDistance))
    : firstPoint;

  return dedupeConsecutivePoints([
    connectionCenter,
    takeoffEnd,
    adjustedFirstPoint,
    ...remaining.slice(1),
  ]);
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
  const localZMm = spec.startConnection
    ? spec.startConnection.elevationMm - baseElevationMm
    : outerRadiusMm;
  const connectionOverlapMm = computeConnectionOverlapLength(spec.outerDiameterMm);
  const routeStartPoint = spec.startConnection
    ? spec.startConnection.portPoint
    : spec.routePoints[0] ?? null;
  const outerPoints = routeStartPoint
    ? dedupeConsecutivePoints([routeStartPoint, ...spec.routePoints])
    : [...spec.routePoints];
  const stubStart = spec.startConnection
    ? add(spec.startConnection.portPoint, scale(spec.startConnection.direction, -connectionOverlapMm))
    : null;
  const stubEnd = spec.startConnection
    ? spec.startConnection.portPoint
    : routeStartPoint;
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
    18,
    Math.max(gasOuterDiameterMm, liquidOuterDiameterMm) * 1.25,
    centerSpacingMm * 0.45,
  );
  const connectionOverlapMm = computeConnectionOverlapLength(
    Math.max(gasOuterDiameterMm, liquidOuterDiameterMm),
  );
  const resolvedGasFieldPoint = spec.startBundleConnection
    ? spec.startBundleConnection.gasPoint
    : null;
  const resolvedLiquidFieldPoint = spec.startBundleConnection
    ? spec.startBundleConnection.liquidPoint
    : null;
  const startTakeoffLengthMm = computeStartTakeoffLength(
    centerSpacingMm,
    Math.max(gasOuterDiameterMm, liquidOuterDiameterMm),
  );
  const startFieldBundleCenter = resolvedGasFieldPoint && resolvedLiquidFieldPoint
    ? computeBundleCenter(
        resolvedGasFieldPoint,
        resolvedLiquidFieldPoint,
      )
    : null;

  const gasOffsetMm = -centerSpacingMm / 2;
  const liquidOffsetMm = centerSpacingMm / 2;
  const effectiveRoutePoints = spec.startBundleConnection && startFieldBundleCenter
    ? buildFieldRoutePoints(
        spec.routePoints,
        startFieldBundleCenter,
        spec.startBundleConnection.direction,
        startTakeoffLengthMm,
      )
    : spec.routePoints;

  const gasRoutePoints = effectiveRoutePoints.length >= 2
    ? roundPolylineCorners(offsetPolyline(effectiveRoutePoints, gasOffsetMm), bendRadiusMm)
    : [];
  const liquidRoutePoints = effectiveRoutePoints.length >= 2
    ? roundPolylineCorners(offsetPolyline(effectiveRoutePoints, liquidOffsetMm), bendRadiusMm)
    : [];
  const gasOuterPoints = buildStartConnectedPath(
    resolvedGasFieldPoint,
    null,
    0,
    gasRoutePoints,
  );
  const liquidOuterPoints = buildStartConnectedPath(
    resolvedLiquidFieldPoint,
    null,
    0,
    liquidRoutePoints,
  );

  const boundsSourcePoints = [
    ...effectiveRoutePoints,
    ...gasOuterPoints,
    ...liquidOuterPoints,
  ];
  const gasStubStart = spec.startBundleConnection
    ? add(
        spec.startBundleConnection.gasPoint,
        scale(spec.startBundleConnection.direction, -connectionOverlapMm),
      )
    : null;
  const gasStubEnd = resolvedGasFieldPoint && spec.startBundleConnection
    ? add(resolvedGasFieldPoint, scale(spec.startBundleConnection.direction, connectionOverlapMm))
    : null;
  const liquidStubStart = spec.startBundleConnection
    ? add(
        spec.startBundleConnection.liquidPoint,
        scale(spec.startBundleConnection.direction, -connectionOverlapMm),
      )
    : null;
  const liquidStubEnd = resolvedLiquidFieldPoint && spec.startBundleConnection
    ? add(resolvedLiquidFieldPoint, scale(spec.startBundleConnection.direction, connectionOverlapMm))
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
    startConnection?: RefrigerantPipeConnection | null;
    elevationMm?: number;
  },
): Omit<Partial<HvacElement>, 'id'> &
  Pick<HvacElement, 'type' | 'position' | 'width' | 'depth' | 'height' | 'elevation' | 'mountType' | 'label'> {
  const outerRadiusMm = options.outerDiameterMm / 2;
  const resolvedElevationMm =
    isFiniteNumber(options.elevationMm) ? options.elevationMm
      : options.startConnection
        ? options.startConnection.elevationMm - outerRadiusMm
        : DEFAULT_REFRIGERANT_PIPE_ELEVATION_MM;

  const properties = {
    routePoints: dedupeConsecutivePoints(routePoints),
    pipeDiameterMm: options.pipeDiameterMm,
    outerDiameterMm: options.outerDiameterMm,
    insulationThicknessMm:
      options.insulationThicknessMm ?? DEFAULT_REFRIGERANT_PIPE_INSULATION_THICKNESS_MM,
    lineKind: options.lineKind,
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
    height: Math.max(1, options.outerDiameterMm),
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
    startBundleConnection?: RefrigerantPipeBundleConnection | null;
  },
): Array<
  Omit<Partial<HvacElement>, 'id'> &
  Pick<HvacElement, 'type' | 'position' | 'width' | 'depth' | 'height' | 'elevation' | 'mountType' | 'label'>
> {
  const gasPipeDiameterMm = options?.gasPipeDiameterMm ?? DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM;
  const liquidPipeDiameterMm = options?.liquidPipeDiameterMm ?? DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM;
  const gasOuterDiameterMm = DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM;
  const liquidOuterDiameterMm = DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM;
  const gasOuterRadiusMm = gasOuterDiameterMm / 2;
  const liquidOuterRadiusMm = liquidOuterDiameterMm / 2;
  const pipeGapMm = options?.pipeGapMm ?? DEFAULT_REFRIGERANT_PIPE_GAP_MM;
  const centerSpacingMm = gasOuterRadiusMm + liquidOuterRadiusMm + pipeGapMm;
  const bendRadiusMm = Math.max(
    18,
    Math.max(gasOuterDiameterMm, liquidOuterDiameterMm) * 1.25,
    centerSpacingMm * 0.45,
  );
  const maxOuterDiameterMm = Math.max(gasOuterDiameterMm, liquidOuterDiameterMm);
  const startTakeoffLengthMm = computeStartTakeoffLength(centerSpacingMm, maxOuterDiameterMm);
  const resolvedGasFieldPoint = options?.startBundleConnection
    ? options.startBundleConnection.gasPoint
    : null;
  const resolvedLiquidFieldPoint = options?.startBundleConnection
    ? options.startBundleConnection.liquidPoint
    : null;
  const startFieldBundleCenter = resolvedGasFieldPoint && resolvedLiquidFieldPoint
    ? computeBundleCenter(resolvedGasFieldPoint, resolvedLiquidFieldPoint)
    : null;
  const effectiveRoutePoints = options?.startBundleConnection && startFieldBundleCenter
    ? buildFieldRoutePoints(
        routePoints,
        startFieldBundleCenter,
        options.startBundleConnection.direction,
        startTakeoffLengthMm,
      )
    : dedupeConsecutivePoints(routePoints);
  const gasRoutePoints = effectiveRoutePoints.length >= 2
    ? roundPolylineCorners(offsetPolyline(effectiveRoutePoints, -centerSpacingMm / 2), bendRadiusMm)
    : [];
  const liquidRoutePoints = effectiveRoutePoints.length >= 2
    ? roundPolylineCorners(offsetPolyline(effectiveRoutePoints, centerSpacingMm / 2), bendRadiusMm)
    : [];

  return [
    buildRefrigerantPipeElement(gasRoutePoints, {
      lineKind: 'gas',
      label: 'Gas Pipe',
      pipeDiameterMm: gasPipeDiameterMm,
      outerDiameterMm: gasOuterDiameterMm,
      insulationThicknessMm: options?.insulationThicknessMm,
      startConnection: options?.startBundleConnection
        ? {
            portPoint: options.startBundleConnection.gasPoint,
            direction: options.startBundleConnection.direction,
            elevationMm: options.startBundleConnection.gasElevationMm,
            sourceElementId: options.startBundleConnection.sourceElementId,
          }
        : null,
    }),
    buildRefrigerantPipeElement(liquidRoutePoints, {
      lineKind: 'liquid',
      label: 'Liquid Pipe',
      pipeDiameterMm: liquidPipeDiameterMm,
      outerDiameterMm: liquidOuterDiameterMm,
      insulationThicknessMm: options?.insulationThicknessMm,
      startConnection: options?.startBundleConnection
        ? {
            portPoint: options.startBundleConnection.liquidPoint,
            direction: options.startBundleConnection.direction,
            elevationMm: options.startBundleConnection.liquidElevationMm,
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
  const gasOuterDiameterMm = DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM;
  const liquidOuterDiameterMm = DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM;
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
    insulationThicknessMm:
      options?.insulationThicknessMm ?? DEFAULT_REFRIGERANT_PIPE_INSULATION_THICKNESS_MM,
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

function cassettePortEndpointLocal(port: ReturnType<typeof buildCeilingCassetteModel>['pipePorts'][number]): Point2D {
  return {
    x: port.x + port.collarLength + port.length - port.flangeThickness * 0.15,
    y: port.y,
  };
}

function unitPipeSnapEndpoint(
  point: Point2D,
  direction: Point2D,
  maxOuterDiameterMm: number,
): Point2D {
  const leadLengthMm = Math.max(20, maxOuterDiameterMm * 1.1);
  return add(point, scale(direction, leadLengthMm));
}

export function getRefrigerantPipeBundleSnapTargets(
  elements: HvacPipeSnapSource[],
): RefrigerantPipeBundleConnection[] {
  const targets: RefrigerantPipeBundleConnection[] = [];

  elements.forEach((element) => {
    if (element.type !== 'ceiling-cassette-ac') {
      return;
    }

    const cassette = buildCeilingCassetteModel(element);
    const gasPort = cassette.pipePorts.find((port) => port.kind === 'gas');
    const liquidPort = cassette.pipePorts.find((port) => port.kind === 'liquid');
    if (!gasPort || !liquidPort) {
      return;
    }

    const center = absoluteCenter(element);
    const direction = normalizeDirection(rotateLocalPoint({ x: 1, y: 0 }, element.rotation ?? 0));
    const gasPoint = localToWorld(center, cassettePortEndpointLocal(gasPort), element.rotation ?? 0);
    const liquidPoint = localToWorld(center, cassettePortEndpointLocal(liquidPort), element.rotation ?? 0);
    const maxOuterDiameterMm = Math.max(gasPort.radius * 2, liquidPort.radius * 2);
    const gasFieldPoint = gasPoint;
    const liquidFieldPoint = liquidPoint;
    const gasElevationMm = element.elevation + gasPort.z;
    const liquidElevationMm = element.elevation + liquidPort.z;

    targets.push({
      point: computeBundleCenter(gasPoint, liquidPoint),
      gasPoint,
      liquidPoint,
      gasFieldPoint,
      liquidFieldPoint,
      direction,
      elevationMm: (gasElevationMm + liquidElevationMm) / 2,
      gasElevationMm,
      liquidElevationMm,
      sourceElementId: element.id,
    });
  });

  return targets;
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
    const nearestPoint = gasDistance <= liquidDistance ? target.gasPoint : target.liquidPoint;
    const nearestDistance = Math.min(gasDistance, liquidDistance);
    if (nearestDistance <= bestDistance) {
      bestDistance = nearestDistance;
      bestTarget = {
        ...target,
        point: nearestPoint,
      };
    }
  });

  return bestTarget;
}
