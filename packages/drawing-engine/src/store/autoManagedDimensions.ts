import type {
  Point2D,
  Dimension2D,
  DimensionSettings,
  Room,
  Wall,
} from '../types';
import { generateId } from '../utils/geometry';
import { GeometryEngine } from '../utils/geometry-engine';

function wallLength(wall: Wall): number {
  return GeometryEngine.wallLength(wall);
}

function wallMidpoint(wall: Wall): Point2D {
  return {
    x: (wall.startPoint.x + wall.endPoint.x) / 2,
    y: (wall.startPoint.y + wall.endPoint.y) / 2,
  };
}

function wallLinearMode(wall: Wall): 'horizontal' | 'vertical' | 'aligned' {
  const dx = Math.abs(wall.endPoint.x - wall.startPoint.x);
  const dy = Math.abs(wall.endPoint.y - wall.startPoint.y);
  if (dx >= dy * 1.2) return 'horizontal';
  if (dy >= dx * 1.2) return 'vertical';
  return 'aligned';
}

function buildExteriorWallSet(walls: Wall[], rooms: Room[]): Set<string> {
  const interiorRoomWallRefCount = new Map<string, number>();
  rooms.forEach((room) => {
    if (room.isExterior) return;
    room.wallIds.forEach((wallId) => {
      interiorRoomWallRefCount.set(wallId, (interiorRoomWallRefCount.get(wallId) ?? 0) + 1);
    });
  });
  const exterior = new Set<string>();
  walls.forEach((wall) => {
    const count = interiorRoomWallRefCount.get(wall.id) ?? 0;
    if (count <= 1) {
      exterior.add(wall.id);
    }
  });
  return exterior;
}

const AUTO_DIM_WALL_GAP = 350;
const AUTO_DIM_MIN_WALL_LENGTH = 200;

export function buildAutoWallDimensions(
  walls: Wall[],
  rooms: Room[],
  settings: DimensionSettings
): Omit<Dimension2D, 'id'>[] {
  const exteriorWallIds = buildExteriorWallSet(walls, rooms);
  const exteriorWalls = walls.filter(
    (wall) => exteriorWallIds.has(wall.id) && wallLength(wall) >= AUTO_DIM_MIN_WALL_LENGTH
  );
  if (exteriorWalls.length === 0) return [];

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  exteriorWalls.forEach((wall) => {
    for (const point of [wall.startPoint, wall.endPoint]) {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
  });
  const bboxCenterX = (minX + maxX) / 2;
  const bboxCenterY = (minY + maxY) / 2;

  const horizontal = exteriorWalls.filter((wall) => wallLinearMode(wall) === 'horizontal');
  const vertical = exteriorWalls.filter((wall) => wallLinearMode(wall) === 'vertical');
  const aligned = exteriorWalls.filter((wall) => wallLinearMode(wall) === 'aligned');

  const topWalls = horizontal
    .filter((wall) => wallMidpoint(wall).y <= bboxCenterY)
    .sort((left, right) => Math.min(left.startPoint.x, left.endPoint.x) - Math.min(right.startPoint.x, right.endPoint.x));
  const bottomWalls = horizontal
    .filter((wall) => wallMidpoint(wall).y > bboxCenterY)
    .sort((left, right) => Math.min(left.startPoint.x, left.endPoint.x) - Math.min(right.startPoint.x, right.endPoint.x));
  const leftWalls = vertical
    .filter((wall) => wallMidpoint(wall).x <= bboxCenterX)
    .sort((left, right) => Math.min(left.startPoint.y, left.endPoint.y) - Math.min(right.startPoint.y, right.endPoint.y));
  const rightWalls = vertical
    .filter((wall) => wallMidpoint(wall).x > bboxCenterX)
    .sort((left, right) => Math.min(left.startPoint.y, left.endPoint.y) - Math.min(right.startPoint.y, right.endPoint.y));

  const unit: Dimension2D['unit'] = settings.unitSystem === 'imperial' ? 'ft-in' : 'mm';
  const dimensions: Omit<Dimension2D, 'id'>[] = [];

  const allWallsById = new Map(walls.map((wall) => [wall.id, wall]));
  const snapTolerance = 50;
  const faceProbeOffset = 10;
  const interiorRooms = rooms.filter((room) => !room.isExterior);
  const interiorRoomsByWallId = new Map<string, Room[]>();
  interiorRooms.forEach((room) => {
    room.wallIds.forEach((wallId) => {
      interiorRoomsByWallId.set(wallId, [...(interiorRoomsByWallId.get(wallId) ?? []), room]);
    });
  });

  function distance(left: Point2D, right: Point2D): number {
    return Math.hypot(left.x - right.x, left.y - right.y);
  }

  function dot(left: Point2D, right: Point2D): number {
    return left.x * right.x + left.y * right.y;
  }

  function normalize(vector: Point2D): Point2D {
    const length = Math.hypot(vector.x, vector.y);
    if (length < 0.000001) {
      return { x: 1, y: 0 };
    }
    return { x: vector.x / length, y: vector.y / length };
  }

  function add(left: Point2D, right: Point2D): Point2D {
    return { x: left.x + right.x, y: left.y + right.y };
  }

  function scale(vector: Point2D, amount: number): Point2D {
    return { x: vector.x * amount, y: vector.y * amount };
  }

  function wallDirection(wall: Wall): Point2D {
    return normalize({
      x: wall.endPoint.x - wall.startPoint.x,
      y: wall.endPoint.y - wall.startPoint.y,
    });
  }

  function wallLeftNormal(wall: Wall): Point2D {
    const direction = wallDirection(wall);
    return { x: -direction.y, y: direction.x };
  }

  function orientFaceLineWithWall(
    wall: Wall,
    line: { start: Point2D; end: Point2D }
  ): { start: Point2D; end: Point2D } {
    const centerDirection = {
      x: wall.endPoint.x - wall.startPoint.x,
      y: wall.endPoint.y - wall.startPoint.y,
    };
    const lineDirection = {
      x: line.end.x - line.start.x,
      y: line.end.y - line.start.y,
    };
    if (dot(centerDirection, lineDirection) >= 0) {
      return {
        start: { ...line.start },
        end: { ...line.end },
      };
    }
    return {
      start: { ...line.end },
      end: { ...line.start },
    };
  }

  function lineIntersection(
    a1: Point2D,
    a2: Point2D,
    b1: Point2D,
    b2: Point2D
  ): Point2D | null {
    const dax = a2.x - a1.x;
    const day = a2.y - a1.y;
    const dbx = b2.x - b1.x;
    const dby = b2.y - b1.y;
    const denominator = dax * dby - day * dbx;
    if (Math.abs(denominator) < 0.000001) {
      return null;
    }
    const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / denominator;
    return {
      x: a1.x + dax * t,
      y: a1.y + day * t,
    };
  }

  interface WallFaceSelection {
    inner: { start: Point2D; end: Point2D };
    outer: { start: Point2D; end: Point2D };
    insideSign: -1 | 1;
    outsideSign: -1 | 1;
  }

  type WallFaceKind = 'inner' | 'outer';

  const wallFaceCache = new Map<string, WallFaceSelection>();
  function resolveWallFaces(wall: Wall): WallFaceSelection {
    const cached = wallFaceCache.get(wall.id);
    if (cached) return cached;

    const midpoint = wallMidpoint(wall);
    const normal = wallLeftNormal(wall);
    const halfThickness = Math.max(0, wall.thickness / 2);
    const probeDistance = halfThickness + faceProbeOffset;
    const positiveProbe = add(midpoint, scale(normal, probeDistance));
    const negativeProbe = add(midpoint, scale(normal, -probeDistance));
    const attachedRooms = interiorRoomsByWallId.get(wall.id) ?? [];

    let choosePositiveSide: boolean | null = null;
    if (attachedRooms.length > 0) {
      const positiveHits = attachedRooms.some((room) => GeometryEngine.pointInRoom(positiveProbe, room));
      const negativeHits = attachedRooms.some((room) => GeometryEngine.pointInRoom(negativeProbe, room));
      if (positiveHits !== negativeHits) {
        choosePositiveSide = positiveHits;
      }
    }

    if (choosePositiveSide === null && attachedRooms.length > 0) {
      const averageSigned = attachedRooms.reduce((sum, room) => (
        sum + dot({ x: room.centroid.x - midpoint.x, y: room.centroid.y - midpoint.y }, normal)
      ), 0) / attachedRooms.length;
      if (Math.abs(averageSigned) > 0.0001) {
        choosePositiveSide = averageSigned > 0;
      }
    }

    if (choosePositiveSide === null) {
      const positiveHitsAny = interiorRooms.some((room) => GeometryEngine.pointInRoom(positiveProbe, room));
      const negativeHitsAny = interiorRooms.some((room) => GeometryEngine.pointInRoom(negativeProbe, room));
      if (positiveHitsAny !== negativeHitsAny) {
        choosePositiveSide = positiveHitsAny;
      }
    }

    if (choosePositiveSide === null) {
      const toBboxCenter = {
        x: bboxCenterX - midpoint.x,
        y: bboxCenterY - midpoint.y,
      };
      if (Math.hypot(toBboxCenter.x, toBboxCenter.y) > 0.001) {
        choosePositiveSide = dot(toBboxCenter, normal) >= 0;
      }
    }

    if (choosePositiveSide === null) {
      choosePositiveSide = true;
    }

    const insideSign: -1 | 1 = choosePositiveSide ? 1 : -1;
    const outsideSign: -1 | 1 = insideSign === 1 ? -1 : 1;
    const innerRaw = choosePositiveSide
      ? { start: wall.interiorLine.start, end: wall.interiorLine.end }
      : { start: wall.exteriorLine.start, end: wall.exteriorLine.end };
    const outerRaw = choosePositiveSide
      ? { start: wall.exteriorLine.start, end: wall.exteriorLine.end }
      : { start: wall.interiorLine.start, end: wall.interiorLine.end };
    const resolved: WallFaceSelection = {
      inner: orientFaceLineWithWall(wall, innerRaw),
      outer: orientFaceLineWithWall(wall, outerRaw),
      insideSign,
      outsideSign,
    };
    wallFaceCache.set(wall.id, resolved);
    return resolved;
  }

  function wallsNearEndpoint(endpoint: Point2D, sourceWallId: string): Wall[] {
    const nearWalls = walls.filter((candidate) => {
      if (candidate.id === sourceWallId) return false;
      return (
        distance(endpoint, candidate.startPoint) <= snapTolerance ||
        distance(endpoint, candidate.endPoint) <= snapTolerance
      );
    });
    const nearExterior = nearWalls.filter((candidate) => exteriorWallIds.has(candidate.id));
    return nearExterior.length > 0 ? nearExterior : nearWalls;
  }

  function resolveSpanCorner(
    wall: Wall,
    endpoint: 'start' | 'end',
    face: { start: Point2D; end: Point2D },
    faceKind: WallFaceKind
  ): Point2D {
    const centerEndpoint = endpoint === 'start' ? wall.startPoint : wall.endPoint;
    const faceEndpoint = endpoint === 'start' ? face.start : face.end;
    const explicitlyConnected = wall.connectedWalls
      .map((connectedId) => allWallsById.get(connectedId))
      .filter((candidate): candidate is Wall => Boolean(candidate))
      .filter((candidate) => (
        distance(centerEndpoint, candidate.startPoint) <= snapTolerance ||
        distance(centerEndpoint, candidate.endPoint) <= snapTolerance
      ));
    const nearbyWalls = wallsNearEndpoint(centerEndpoint, wall.id);
    const connected = explicitlyConnected.length > 0 ? explicitlyConnected : nearbyWalls;
    const connectedExterior = connected.filter((candidate) => exteriorWallIds.has(candidate.id));
    const candidates = connectedExterior.length > 0 ? connectedExterior : connected;

    let bestPoint: Point2D | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const candidateFaces = resolveWallFaces(candidate);
      const candidateFace = faceKind === 'inner' ? candidateFaces.inner : candidateFaces.outer;
      const intersection = lineIntersection(face.start, face.end, candidateFace.start, candidateFace.end);
      if (!intersection) continue;
      const score = distance(intersection, faceEndpoint);
      if (score < bestScore) {
        bestScore = score;
        bestPoint = intersection;
      }
    }

    return bestPoint ?? { ...faceEndpoint };
  }

  function wallOutsideOffsetSign(wall: Wall): -1 | 1 {
    return resolveWallFaces(wall).outsideSign;
  }

  function spanOnFace(
    wall: Wall,
    faceKind: WallFaceKind
  ): { start: Point2D; end: Point2D; length: number } {
    const faces = resolveWallFaces(wall);
    const face = faceKind === 'inner' ? faces.inner : faces.outer;
    const start = resolveSpanCorner(wall, 'start', face, faceKind);
    const end = resolveSpanCorner(wall, 'end', face, faceKind);
    return {
      start,
      end,
      length: Math.max(0, distance(start, end)),
    };
  }

  function pointInAnyInteriorRoom(point: Point2D): boolean {
    return interiorRooms.some((room) => GeometryEngine.pointInRoom(point, room));
  }

  function segmentIntersectionPoint(
    a1: Point2D,
    a2: Point2D,
    b1: Point2D,
    b2: Point2D
  ): Point2D | null {
    const candidate = lineIntersection(a1, a2, b1, b2);
    if (!candidate) return null;

    const within = (value: number, edgeA: number, edgeB: number): boolean => {
      const min = Math.min(edgeA, edgeB) - 0.001;
      const max = Math.max(edgeA, edgeB) + 0.001;
      return value >= min && value <= max;
    };

    if (
      within(candidate.x, a1.x, a2.x) &&
      within(candidate.y, a1.y, a2.y) &&
      within(candidate.x, b1.x, b2.x) &&
      within(candidate.y, b1.y, b2.y)
    ) {
      return candidate;
    }
    return null;
  }

  function offsetOverlapsRoomsOrWalls(
    wall: Wall,
    span: { start: Point2D; end: Point2D; length: number },
    signedOffset: number
  ): boolean {
    if (span.length < 0.001) return false;

    const faceDirection = normalize({
      x: span.end.x - span.start.x,
      y: span.end.y - span.start.y,
    });
    const faceNormal = { x: -faceDirection.y, y: faceDirection.x };
    const dimStart = add(span.start, scale(faceNormal, signedOffset));
    const dimEnd = add(span.end, scale(faceNormal, signedOffset));

    const samples = [0, 0.25, 0.5, 0.75, 1];
    for (const t of samples) {
      const samplePoint = {
        x: dimStart.x + (dimEnd.x - dimStart.x) * t,
        y: dimStart.y + (dimEnd.y - dimStart.y) * t,
      };
      if (pointInAnyInteriorRoom(samplePoint)) {
        return true;
      }
    }

    const endpointTolerance = Math.max(40, wall.thickness * 0.25);
    for (const candidate of walls) {
      if (candidate.id === wall.id) continue;
      const hit = segmentIntersectionPoint(dimStart, dimEnd, candidate.startPoint, candidate.endPoint);
      if (!hit) continue;
      if (
        distance(hit, wall.startPoint) <= endpointTolerance ||
        distance(hit, wall.endPoint) <= endpointTolerance
      ) {
        continue;
      }
      return true;
    }

    return false;
  }

  function resolveSafeSignedOffset(
    wall: Wall,
    span: { start: Point2D; end: Point2D; length: number },
    baseOffsetAbs: number,
    preferredSign: -1 | 1
  ): number {
    const preferredOffset = preferredSign * baseOffsetAbs;
    if (!offsetOverlapsRoomsOrWalls(wall, span, preferredOffset)) {
      return preferredOffset;
    }
    const flippedSign: -1 | 1 = preferredSign === 1 ? -1 : 1;
    const flippedOffset = flippedSign * baseOffsetAbs;
    if (!offsetOverlapsRoomsOrWalls(wall, span, flippedOffset)) {
      return flippedOffset;
    }
    return preferredOffset;
  }

  function uniformOffsetFromInnerFace(wall: Wall): number {
    return Math.max(80, wall.thickness + AUTO_DIM_WALL_GAP);
  }

  function addSideDimensions(sideWalls: Wall[], chainId: string): void {
    if (sideWalls.length === 0) return;
    sideWalls.forEach((wall) => {
      const measureSpan = spanOnFace(wall, 'inner');
      if (measureSpan.length < 1) return;

      const spanMid = {
        x: (measureSpan.start.x + measureSpan.end.x) / 2,
        y: (measureSpan.start.y + measureSpan.end.y) / 2,
      };
      const outsideSign = wallOutsideOffsetSign(wall);
      const offset = resolveSafeSignedOffset(
        wall,
        measureSpan,
        uniformOffsetFromInnerFace(wall),
        outsideSign
      );

      dimensions.push({
        type: 'aligned',
        linearMode: 'aligned',
        points: [measureSpan.start, measureSpan.end],
        value: measureSpan.length,
        unit,
        textPosition: { ...spanMid },
        visible: true,
        style: settings.style,
        precision: settings.precision,
        displayFormat: settings.displayFormat,
        offset,
        autoBaseOffset: offset,
        autoOffsetAdjustment: 0,
        linkedWallIds: [wall.id],
        isAssociative: true,
        chainGroupId: chainId,
        baselineGroupId: 'auto-exterior',
      });
    });
  }

  addSideDimensions(topWalls, 'auto-top');
  addSideDimensions(bottomWalls, 'auto-bottom');
  addSideDimensions(leftWalls, 'auto-left');
  addSideDimensions(rightWalls, 'auto-right');

  aligned.sort((left, right) => wallLength(right) - wallLength(left));
  aligned.forEach((wall) => {
    const measureSpan = spanOnFace(wall, 'inner');
    if (measureSpan.length < 1) return;

    const spanMid = {
      x: (measureSpan.start.x + measureSpan.end.x) / 2,
      y: (measureSpan.start.y + measureSpan.end.y) / 2,
    };
    const outsideSign = wallOutsideOffsetSign(wall);
    const offset = resolveSafeSignedOffset(
      wall,
      measureSpan,
      uniformOffsetFromInnerFace(wall),
      outsideSign
    );
    dimensions.push({
      type: 'aligned',
      linearMode: 'aligned',
      points: [measureSpan.start, measureSpan.end],
      value: measureSpan.length,
      unit,
      textPosition: { ...spanMid },
      visible: true,
      style: settings.style,
      precision: settings.precision,
      displayFormat: settings.displayFormat,
      offset,
      autoBaseOffset: offset,
      autoOffsetAdjustment: 0,
      linkedWallIds: [wall.id],
      isAssociative: true,
      baselineGroupId: 'auto-exterior',
    });
  });

  return dimensions;
}

export function buildRoomAreaDimensions(
  rooms: Room[],
  settings: DimensionSettings
): Omit<Dimension2D, 'id'>[] {
  return rooms
    .filter((room) => !room.isExterior)
    .map((room) => ({
      type: 'area',
      points: [{ ...room.centroid }],
      value: room.area,
      unit: settings.unitSystem === 'imperial' ? 'ft-in' : 'mm',
      textPosition: { ...room.centroid },
      visible: true,
      style: settings.style,
      precision: settings.precision,
      displayFormat: settings.displayFormat,
      linkedRoomId: room.id,
      showPerimeter: settings.showAreaPerimeter,
      isAssociative: true,
    }));
}

export function normalizeDimensionPayload(
  dimension: Omit<Dimension2D, 'id'> | Dimension2D,
  settings: DimensionSettings
): Omit<Dimension2D, 'id'> {
  const { id: _dimensionId, ...payload } = dimension as Dimension2D;
  void _dimensionId;
  const points = Array.isArray(dimension.points)
    ? dimension.points.map((point) => ({ ...point }))
    : [];
  const safeTextPosition = payload.textPosition
    ? { ...payload.textPosition }
    : points[0]
      ? { ...points[0] }
      : { x: 0, y: 0 };
  const precision = payload.precision ?? settings.precision;
  const safeTextPositionRatio =
    Number.isFinite(payload.textPositionRatio)
      ? Math.min(0.92, Math.max(0.08, payload.textPositionRatio as number))
      : undefined;
  const safeAutoBaseOffset = Number.isFinite(payload.autoBaseOffset)
    ? (payload.autoBaseOffset as number)
    : undefined;
  const safeAutoOffsetAdjustment = Number.isFinite(payload.autoOffsetAdjustment)
    ? (payload.autoOffsetAdjustment as number)
    : undefined;

  return {
    ...payload,
    points,
    textPosition: safeTextPosition,
    visible: payload.visible ?? true,
    style: payload.style ?? settings.style,
    precision: precision === 0 || precision === 1 || precision === 2 ? precision : settings.precision,
    displayFormat: payload.displayFormat ?? settings.displayFormat,
    offset: Number.isFinite(payload.offset) ? payload.offset : settings.defaultOffset,
    textPositionLocked: payload.textPositionLocked ?? false,
    textPositionRatio: safeTextPositionRatio,
    autoBaseOffset: safeAutoBaseOffset,
    autoOffsetAdjustment: safeAutoOffsetAdjustment,
  };
}

export function isAutoManagedDimension(
  dimension: Pick<Dimension2D, 'baselineGroupId' | 'linkedRoomId'>
): boolean {
  return Boolean(dimension.baselineGroupId || dimension.linkedRoomId);
}

function autoManagedDimensionKey(
  dimension: Pick<
    Dimension2D,
    'type' | 'baselineGroupId' | 'linkedRoomId' | 'linkedWallIds'
  >
): string | null {
  if (dimension.linkedRoomId) {
    return `area:${dimension.type}:${dimension.linkedRoomId}`;
  }

  if (!dimension.baselineGroupId) {
    return null;
  }

  const primaryWallId = dimension.linkedWallIds?.[0];
  if (!primaryWallId) {
    return null;
  }

  return [
    'wall',
    primaryWallId,
    dimension.type,
  ].join(':');
}

export function mergeAutoManagedDimensions(
  generatedDimensions: Array<Omit<Dimension2D, 'id'>>,
  existingDimensions: Dimension2D[],
  settings: DimensionSettings
): Dimension2D[] {
  const existingByKey = new Map<string, Dimension2D>();

  existingDimensions.forEach((dimension) => {
    if (!isAutoManagedDimension(dimension)) {
      return;
    }

    const key = autoManagedDimensionKey(dimension);
    if (!key || existingByKey.has(key)) {
      return;
    }

    existingByKey.set(key, dimension);
  });

  return generatedDimensions.map((dimension) => {
    const normalized = normalizeDimensionPayload(dimension, settings);
    const key = autoManagedDimensionKey(normalized);
    const existing = key ? existingByKey.get(key) : null;

    if (!existing) {
      return {
        ...normalized,
        id: generateId(),
      };
    }

    const nextAutoBaseOffset: number =
      Number.isFinite(normalized.autoBaseOffset)
        ? (normalized.autoBaseOffset as number)
        : (normalized.offset as number);
    const existingAutoBaseOffset: number =
      Number.isFinite(existing.autoBaseOffset)
        ? (existing.autoBaseOffset as number)
        : nextAutoBaseOffset;
    const derivedAutoOffsetAdjustment =
      Number.isFinite(existing.autoOffsetAdjustment)
        ? (existing.autoOffsetAdjustment as number)
        : (
          Number.isFinite(existing.offset)
            ? (existing.offset as number) - existingAutoBaseOffset
            : 0
        );

    return {
      ...normalized,
      id: existing.id,
      offset: nextAutoBaseOffset + derivedAutoOffsetAdjustment,
      textPosition: existing.textPositionLocked
        ? { ...existing.textPosition }
        : normalized.textPosition,
      textPositionLocked: existing.textPositionLocked ?? normalized.textPositionLocked,
      textPositionRatio: existing.textPositionLocked
        ? existing.textPositionRatio ?? normalized.textPositionRatio
        : normalized.textPositionRatio,
      autoBaseOffset: nextAutoBaseOffset,
      autoOffsetAdjustment: derivedAutoOffsetAdjustment,
      text: existing.text,
      isDesignValue: existing.isDesignValue,
      baselineOrigin: existing.baselineOrigin ? { ...existing.baselineOrigin } : normalized.baselineOrigin,
      visible: existing.visible,
    };
  });
}

export function buildMergedAutoManagedDimensions(params: {
  walls: Wall[];
  rooms: Room[];
  dimensionSettings: DimensionSettings;
  dimensions: Dimension2D[];
}): Dimension2D[] {
  const autoLinear = buildAutoWallDimensions(params.walls, params.rooms, params.dimensionSettings);
  const preserved = params.dimensions.filter((dimension) => !dimension.baselineGroupId);
  return [
    ...preserved,
    ...mergeAutoManagedDimensions(autoLinear, params.dimensions, params.dimensionSettings),
  ];
}

export function autoManagedDimensionSignature(params: {
  walls: Wall[];
  rooms: Room[];
  dimensionSettings: DimensionSettings;
  dimensions: Dimension2D[];
}): string {
  return JSON.stringify({
    settings: {
      unitSystem: params.dimensionSettings.unitSystem,
      style: params.dimensionSettings.style,
      displayFormat: params.dimensionSettings.displayFormat,
      precision: params.dimensionSettings.precision,
      defaultOffset: params.dimensionSettings.defaultOffset,
      showAreaPerimeter: params.dimensionSettings.showAreaPerimeter,
    },
    walls: params.walls.map((wall) => ({
      id: wall.id,
      startPoint: wall.startPoint,
      endPoint: wall.endPoint,
      thickness: wall.thickness,
      connectedWalls: wall.connectedWalls,
      openings: wall.openings.map((opening) => ({
        id: opening.id,
        type: opening.type,
        position: opening.position,
        width: opening.width,
        height: opening.height,
        sillHeight: opening.sillHeight ?? 0,
      })),
    })),
    rooms: params.rooms.map((room) => ({
      id: room.id,
      isExterior: room.isExterior,
      wallIds: room.wallIds,
      area: room.area,
      perimeter: room.perimeter,
      centroid: room.centroid,
      vertices: room.vertices,
    })),
    autoManagedDimensions: params.dimensions
      .filter((dimension) => isAutoManagedDimension(dimension))
      .map((dimension) => ({
        id: dimension.id,
        type: dimension.type,
        linkedRoomId: dimension.linkedRoomId ?? null,
        linkedWallIds: dimension.linkedWallIds ?? [],
        baselineGroupId: dimension.baselineGroupId ?? null,
        offset: dimension.offset ?? null,
        text: dimension.text ?? null,
        textPosition: dimension.textPosition,
        textPositionLocked: dimension.textPositionLocked ?? false,
        textPositionRatio: dimension.textPositionRatio ?? null,
        autoBaseOffset: dimension.autoBaseOffset ?? null,
        autoOffsetAdjustment: dimension.autoOffsetAdjustment ?? null,
        baselineOrigin: dimension.baselineOrigin ?? null,
        isDesignValue: dimension.isDesignValue ?? false,
        visible: dimension.visible,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
}
