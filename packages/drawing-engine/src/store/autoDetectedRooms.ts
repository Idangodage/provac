import {
  booleanIntersects,
  pointOnFeature,
  polygon as turfPolygon,
} from '@turf/turf';

import { bindRoomGeometryTo3D } from '../attributes';
import { computeWallUnionRenderData } from '../components/canvas/wall/WallUnionGeometry';
import type { Point2D, Room, Room3D, RoomDesignCriteria, RoomType, Wall } from '../types';
import { DEFAULT_ROOM_3D } from '../types/wall';
import { generateId, isPointInPolygon } from '../utils/geometry';
import { GeometryEngine } from '../utils/geometry-engine';
import type { Vec2 } from '../wallcore/vec2';
import { halfWidths } from '../wallcore/wallSolver';
import { subtractWallPolygons, type WallPolygon } from '../wallcore/wallUnion';

import {
  inferRoomType,
  inferRoomTypeFromLayout,
  roomMinimumDimensionWarnings,
  roomTypeFillColor,
} from './roomDetection';

const MIN_ENCLOSED_ROOM_AREA_MM2 = 10_000;
const ENCLOSURE_BOUNDS_PADDING_MM = 500;
const WALL_CONTACT_MARGIN_MM = 1;

function polygonAreaWithHoles(vertices: Point2D[], holes: Point2D[][] = []): number {
  return GeometryEngine.calculateRoomAreaMm2({ vertices, holes });
}

function polygonPerimeter(vertices: Point2D[], holes: Point2D[][] = []): number {
  return GeometryEngine.calculateRoomPerimeterMm({ vertices, holes });
}

function polygonCentroid(vertices: Point2D[], holes: Point2D[][] = []): Point2D {
  return GeometryEngine.findRoomCentroid({ vertices, holes });
}

function roomSignatureFromWallIds(wallIds: string[]): string {
  return [...new Set(wallIds)].sort().join('|');
}

function ringSignature(vertices: Point2D[], precision = 1): string {
  const rounded = vertices.map((point) => `${point.x.toFixed(precision)}:${point.y.toFixed(precision)}`);
  if (rounded.length === 0) return '';

  const variants: string[] = [];
  for (let index = 0; index < rounded.length; index += 1) {
    const rotated = [...rounded.slice(index), ...rounded.slice(0, index)];
    variants.push(rotated.join('|'));
  }

  const reversed = [...rounded].reverse();
  for (let index = 0; index < reversed.length; index += 1) {
    const rotated = [...reversed.slice(index), ...reversed.slice(0, index)];
    variants.push(rotated.join('|'));
  }

  variants.sort();
  return variants[0] ?? '';
}

function polygonSignature(vertices: Point2D[], holes: Point2D[][] = [], precision = 1): string {
  const outerSignature = ringSignature(vertices, precision);
  const holeSignatures = holes
    .map((hole) => ringSignature(hole, precision))
    .filter((signature) => signature.length > 0)
    .sort();
  return [outerSignature, ...holeSignatures].join('||');
}

function closeRing(vertices: Point2D[]): number[][] {
  if (vertices.length === 0) return [];
  const ring = vertices.map((vertex) => [vertex.x, vertex.y]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last) return ring;
  if (Math.abs(first[0] - last[0]) > 0.000001 || Math.abs(first[1] - last[1]) > 0.000001) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}

function makePolygonFeature(vertices: Point2D[], holes: Point2D[][] = []): any | null {
  if (vertices.length < 3) return null;
  try {
    const holeRings = holes
      .map((hole) => closeRing(hole))
      .filter((holeRing) => holeRing.length >= 4);
    return turfPolygon([closeRing(vertices), ...holeRings]);
  } catch {
    return null;
  }
}

function ringFromPoints(points: Point2D[]): Vec2[] {
  return points.map((point): Vec2 => [point.x, point.y]);
}

function pointsFromPolygon(rings: WallPolygon): Point2D[][] {
  return rings.map((ring) => ring.map(([x, y]) => ({ x, y })));
}

/** The walls exactly as the plan draws them, junction cores included, so no room can leak through a junction. */
function drawnWallBodies(walls: Wall[]): WallPolygon[] {
  return computeWallUnionRenderData(walls).components.flatMap((component) =>
    component.polygons.map((polygon) => polygon.map(ringFromPoints)),
  );
}

/**
 * A wall's whole rectangle, a little larger all round: rooms come off the boolean
 * grid, so a room's edge could otherwise miss the wall it runs along by a grid step.
 */
function wallContactFeature(wall: Wall): any | null {
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0) return null;
  const u = { x: dx / length, y: dy / length };
  const n = { x: -u.y, y: u.x };
  const { hl, hr } = halfWidths({ thickness: wall.thickness, justification: wall.graph?.justification ?? 'center' });
  const at = (along: number, across: number): Point2D => ({
    x: wall.startPoint.x + u.x * along + n.x * across,
    y: wall.startPoint.y + u.y * along + n.y * across,
  });
  const m = WALL_CONTACT_MARGIN_MM;
  return makePolygonFeature([at(-m, hl + m), at(length + m, hl + m), at(length + m, -hr - m), at(-m, -hr - m)]);
}

function boundsForPoints(points: Point2D[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  points.forEach((point) => {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  });

  return { minX, minY, maxX, maxY };
}

function roomTouchesBounds(
  vertices: Point2D[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  tolerance = 0.001
): boolean {
  return vertices.some((vertex) => (
    Math.abs(vertex.x - bounds.minX) <= tolerance ||
    Math.abs(vertex.x - bounds.maxX) <= tolerance ||
    Math.abs(vertex.y - bounds.minY) <= tolerance ||
    Math.abs(vertex.y - bounds.maxY) <= tolerance
  ));
}

interface EnclosedRoomCandidate {
  signature: string;
  vertices: Point2D[];
  holes: Point2D[][];
  wallIds: string[];
  area: number;
  perimeter: number;
  centroid: Point2D;
}

function detectEnclosedRoomCandidatesFromWalls(walls: Wall[]): EnclosedRoomCandidate[] {
  if (walls.length < 3) return [];

  const wallFeatures = walls.map(wallContactFeature);
  const wallFeatureBounds = wallFeatures.map((feature) => (
    feature
      ? boundsForPoints((feature.geometry.coordinates[0] as number[][]).map(([x, y]) => ({ x, y })))
      : null
  ));
  const mergedWalls = drawnWallBodies(walls);
  if (mergedWalls.length === 0) return [];

  const allPoints = mergedWalls.flat(2).map(([x, y]) => ({ x, y }));
  const rawBounds = boundsForPoints(allPoints);
  // Whole millimetres: exactly on the boolean grid, so the outside space can be recognised by touching them.
  const bounds = {
    minX: Math.floor(rawBounds.minX) - ENCLOSURE_BOUNDS_PADDING_MM,
    minY: Math.floor(rawBounds.minY) - ENCLOSURE_BOUNDS_PADDING_MM,
    maxX: Math.ceil(rawBounds.maxX) + ENCLOSURE_BOUNDS_PADDING_MM,
    maxY: Math.ceil(rawBounds.maxY) + ENCLOSURE_BOUNDS_PADDING_MM,
  };
  const emptySpaces = subtractWallPolygons(
    [[[
      [bounds.minX, bounds.minY],
      [bounds.maxX, bounds.minY],
      [bounds.maxX, bounds.maxY],
      [bounds.minX, bounds.maxY],
    ]]],
    mergedWalls,
  );
  if (!emptySpaces.exact) return [];

  const candidatesBySignature = new Map<string, EnclosedRoomCandidate>();

  emptySpaces.polygons.map(pointsFromPolygon).forEach((rings) => {
    const outer = rings[0] ?? [];
    const holes = rings.slice(1).filter((ring) => ring.length >= 3);
    if (outer.length < 3) return;
    if (roomTouchesBounds(outer, bounds)) return;

    const area = polygonAreaWithHoles(outer, holes);
    if (!Number.isFinite(area) || area < MIN_ENCLOSED_ROOM_AREA_MM2) return;

    const roomFeature = makePolygonFeature(outer, holes);
    if (!roomFeature) return;

    // Most walls are nowhere near this room: only the rest need the exact test.
    const roomBounds = boundsForPoints(outer);
    const wallIds = walls
      .filter((_wall, index) => {
        const wallFeature = wallFeatures[index];
        const wallBounds = wallFeatureBounds[index];
        if (!wallFeature || !wallBounds) return false;
        const apart = wallBounds.minX > roomBounds.maxX || wallBounds.maxX < roomBounds.minX
          || wallBounds.minY > roomBounds.maxY || wallBounds.maxY < roomBounds.minY;
        return !apart && booleanIntersects(roomFeature, wallFeature);
      })
      .map((wall) => wall.id);
    if (wallIds.length < 3) return;

    const centroidFeature = pointOnFeature(roomFeature);
    const centroid = {
      x: centroidFeature.geometry.coordinates[0],
      y: centroidFeature.geometry.coordinates[1],
    };
    const signature = polygonSignature(outer, holes);
    const perimeter = polygonPerimeter(outer, holes);

    const existing = candidatesBySignature.get(signature);
    if (!existing || area > existing.area) {
      candidatesBySignature.set(signature, {
        signature,
        vertices: outer.map((vertex) => ({ ...vertex })),
        holes: holes.map((hole) => hole.map((vertex) => ({ ...vertex }))),
        wallIds: [...new Set(wallIds)],
        area,
        perimeter,
        centroid,
      });
    }
  });

  return [...candidatesBySignature.values()]
    .sort((left, right) => left.area - right.area);
}

function bindRoomAttributes(room: Room, defaults?: Partial<Room3D>): Room {
  const computedArea = polygonAreaWithHoles(room.vertices, room.holes ?? []);
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

export function createRoomModel(params: {
  vertices: Point2D[];
  holes?: Point2D[][];
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
  designCriteria?: RoomDesignCriteria | null;
}): Room {
  const area = polygonAreaWithHoles(params.vertices, params.holes ?? []);
  const areaM2 = area / 1_000_000;
  const roomType = params.roomType ?? inferRoomType(areaM2);
  const roomBase: Room = {
    id: generateId(),
    name: params.name ?? `${roomType} ${new Date().toISOString().slice(11, 16)}`,
    roomType,
    vertices: params.vertices.map((vertex) => ({ ...vertex })),
    holes: params.holes?.map((hole) => hole.map((vertex) => ({ ...vertex }))),
    wallIds: [...params.wallIds],
    area,
    perimeter: params.perimeter ?? polygonPerimeter(params.vertices, params.holes ?? []),
    centroid: params.centroid ? { ...params.centroid } : polygonCentroid(params.vertices, params.holes ?? []),
    finishes: params.finishes ?? '',
    notes: params.notes ?? '',
    fillColor: params.fillColor ?? roomTypeFillColor(roomType),
    showLabel: params.showLabel ?? true,
    adjacentRoomIds: params.adjacentRoomIds ?? [],
    hasWindows: params.hasWindows ?? false,
    validationWarnings: params.validationWarnings ?? [],
    isExterior: params.isExterior ?? false,
    properties3D: { ...DEFAULT_ROOM_3D },
    ...(params.designCriteria ? { designCriteria: { ...params.designCriteria } } : {}),
  };
  return bindRoomAttributes(roomBase, params.properties3D);
}

function buildRoomValidationWarnings(params: {
  areaM2: number;
  roomType: RoomType;
  vertices: Point2D[];
  hasWindows: boolean;
}): string[] {
  const warnings: string[] = [];
  if (params.areaM2 < 2) {
    warnings.push('Room area is below 2m² (possible drawing error).');
  }
  if (!params.hasWindows) {
    warnings.push('No windows detected for this room.');
  }
  warnings.push(...roomMinimumDimensionWarnings(params.roomType, params.vertices));
  return warnings;
}

export function buildAutoDetectedRooms(
  walls: Wall[],
  existingRooms: Room[]
): Room[] {
  if (walls.length < 3) return [];
  const detectedRooms = detectEnclosedRoomCandidatesFromWalls(walls);
  if (detectedRooms.length === 0) return [];

  const existingByPolygonSignature = new Map<string, Room>();
  const existingByWallSignature = new Map<string, Room>();
  existingRooms.forEach((room) => {
    existingByPolygonSignature.set(polygonSignature(room.vertices, room.holes ?? []), room);
    existingByWallSignature.set(roomSignatureFromWallIds(room.wallIds), room);
  });

  const wallById = new Map(walls.map((wall) => [wall.id, wall]));
  const usedNames = new Set(existingRooms.map((room) => room.name));
  const nextTypeOrdinal = new Map<RoomType, number>();

  const roomIndicesByWallId = new Map<string, number[]>();
  const adjacencyByRoomIndex = detectedRooms.map(() => new Set<number>());

  detectedRooms.forEach((room, roomIndex) => {
    room.wallIds.forEach((wallId) => {
      roomIndicesByWallId.set(wallId, [...(roomIndicesByWallId.get(wallId) ?? []), roomIndex]);
    });
  });

  roomIndicesByWallId.forEach((indices) => {
    if (indices.length < 2) return;
    for (let i = 0; i < indices.length - 1; i += 1) {
      for (let j = i + 1; j < indices.length; j += 1) {
        const left = indices[i];
        const right = indices[j];
        adjacencyByRoomIndex[left]?.add(right);
        adjacencyByRoomIndex[right]?.add(left);
      }
    }
  });

  const reserveAutoName = (roomType: RoomType): string => {
    let ordinal = nextTypeOrdinal.get(roomType) ?? 1;
    let candidate = `${roomType} ${ordinal}`;
    while (usedNames.has(candidate)) {
      ordinal += 1;
      candidate = `${roomType} ${ordinal}`;
    }
    nextTypeOrdinal.set(roomType, ordinal + 1);
    return candidate;
  };

  const nextRooms: Room[] = [];
  // A room the walls make anew (a room split by a new wall) keeps the duct design criteria of the room it was part of.
  const criteriaAround = (point: Point2D): RoomDesignCriteria | null => existingRooms
    .find((room) => room.designCriteria && room.vertices.length >= 3 && isPointInPolygon(point, room.vertices))?.designCriteria ?? null;

  detectedRooms.forEach((detectedRoom, index) => {
    const wallSignature = roomSignatureFromWallIds(detectedRoom.wallIds);
    const existing = existingByPolygonSignature.get(detectedRoom.signature)
      ?? existingByWallSignature.get(wallSignature);
    const areaM2 = detectedRoom.area / 1_000_000;
    const hasWindows = detectedRoom.wallIds.some((wallId) => {
      const wall = wallById.get(wallId);
      if (!wall) return false;
      return wall.openings.some((opening) => opening.type === 'window');
    });
    const adjacencyCount = adjacencyByRoomIndex[index]?.size ?? 0;
    const exteriorWallCount = detectedRoom.wallIds.reduce((count, wallId) => (
      (roomIndicesByWallId.get(wallId)?.length ?? 0) <= 1 ? count + 1 : count
    ), 0);
    const exteriorWallRatio = detectedRoom.wallIds.length > 0
      ? exteriorWallCount / detectedRoom.wallIds.length
      : 0;
    const inferredType = inferRoomTypeFromLayout({
      areaM2,
      perimeterMm: detectedRoom.perimeter,
      vertices: detectedRoom.vertices,
      adjacencyCount,
      exteriorWallRatio,
      hasWindows,
    });
    const resolvedRoomType = existing?.roomType ?? inferredType;
    const validationWarnings = buildRoomValidationWarnings({
      areaM2,
      roomType: resolvedRoomType,
      vertices: detectedRoom.vertices,
      hasWindows,
    });

    let roomName = existing?.name;
    if (!roomName) {
      roomName = reserveAutoName(resolvedRoomType);
    }
    usedNames.add(roomName);

    const room = createRoomModel({
      vertices: detectedRoom.vertices,
      holes: detectedRoom.holes,
      wallIds: detectedRoom.wallIds,
      name: roomName,
      roomType: resolvedRoomType,
      perimeter: detectedRoom.perimeter,
      centroid: detectedRoom.centroid,
      finishes: existing?.finishes ?? '',
      notes: existing?.notes ?? '',
      fillColor: existing?.fillColor ?? roomTypeFillColor(resolvedRoomType),
      showLabel: existing?.showLabel ?? true,
      adjacentRoomIds: existing?.adjacentRoomIds ?? [],
      hasWindows,
      validationWarnings,
      isExterior: existing?.isExterior ?? false,
      properties3D: existing?.properties3D,
      designCriteria: existing ? existing.designCriteria ?? null : criteriaAround(detectedRoom.centroid),
    });

    if (existing) {
      room.id = existing.id;
    }

    nextRooms.push(room);
  });

  const roomIdsByWall = new Map<string, string[]>();
  nextRooms.forEach((room) => {
    room.wallIds.forEach((wallId) => {
      roomIdsByWall.set(wallId, [...(roomIdsByWall.get(wallId) ?? []), room.id]);
    });
  });
  nextRooms.forEach((room) => {
    const adjacent = new Set<string>();
    room.wallIds.forEach((wallId) => {
      const linked = roomIdsByWall.get(wallId) ?? [];
      linked.forEach((roomId) => {
        if (roomId !== room.id) adjacent.add(roomId);
      });
    });
    room.adjacentRoomIds = [...adjacent];
  });

  return nextRooms;
}
