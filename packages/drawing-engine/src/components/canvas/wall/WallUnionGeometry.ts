import { featureCollection, multiPolygon, polygon, union } from '@turf/turf';

import type { JoinData, Point2D, Wall } from '../../../types';

import { computeWallBodyPolygon } from './WallGeometry';
import { computeWallJoinMap, computeWallJoinMapWithShadows } from './WallJoinNetwork';

const COMPONENT_TOLERANCE_MM = 2;
const COORDINATE_TOLERANCE_MM = 0.001;
const MIN_PATCH_AREA_MM2 = 0.1;
const MIN_UNION_ENDPOINT_ANGLE_DEG = 1;
const SEGMENT_INTERIOR_TOLERANCE = 0.001;
// Acute joins wider than 30deg can still collapse one face enough to make the
// wall visibly taper near the endpoint. Keep the uniformity guard active until
// the join opens up into a clearly stable corner.
const SPIKE_JOIN_ANGLE_THRESHOLD_DEG = 30;
const WALL_UNIFORMITY_TOLERANCE_MM = 0.5;

type Endpoint = 'start' | 'end';
type RingCoordinate = number[];
type PolygonFeature = ReturnType<typeof polygon>;
type PolygonGeometry = PolygonFeature['geometry'];
type MultiPolygonGeometry = ReturnType<typeof multiPolygon>['geometry'];

interface EndpointFace {
  anchor: Point2D;
}

interface WallEndpointRef {
  key: string;
  wall: Wall;
  endpoint: Endpoint;
  point: Point2D;
  direction: Point2D;
  thickness: number;
  angleDeg: number;
  left: EndpointFace;
  right: EndpointFace;
}

interface EndpointNode {
  point: Point2D;
  endpoints: WallEndpointRef[];
}

export interface WallUnionComponent {
  id: string;
  wallIds: string[];
  polygons: Point2D[][][];
  junctionOverlays: Point2D[][][];
}

export interface WallUnionRenderData {
  joinsMap: Map<string, JoinData[]>;
  components: WallUnionComponent[];
}

const WALL_UNION_CACHE_LIMIT = 12;
const wallUnionRenderDataCache = new Map<string, WallUnionRenderData>();

function wallUnionSignature(walls: Wall[]): string {
  return JSON.stringify(
    walls.map((wall) => ({
      id: wall.id,
      thickness: wall.thickness,
      startPoint: wall.startPoint,
      endPoint: wall.endPoint,
      interiorLine: wall.interiorLine,
      exteriorLine: wall.exteriorLine,
      connectedWalls: wall.connectedWalls,
      startBevel: wall.startBevel ?? null,
      endBevel: wall.endBevel ?? null,
    }))
  );
}

function getCachedWallUnionRenderData(signature: string): WallUnionRenderData | null {
  const cached = wallUnionRenderDataCache.get(signature);
  if (!cached) {
    return null;
  }

  wallUnionRenderDataCache.delete(signature);
  wallUnionRenderDataCache.set(signature, cached);
  return cached;
}

function setCachedWallUnionRenderData(signature: string, renderData: WallUnionRenderData): void {
  wallUnionRenderDataCache.set(signature, renderData);
  if (wallUnionRenderDataCache.size <= WALL_UNION_CACHE_LIMIT) {
    return;
  }

  const oldestKey = wallUnionRenderDataCache.keys().next().value;
  if (typeof oldestKey === 'string') {
    wallUnionRenderDataCache.delete(oldestKey);
  }
}

function pointDistance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function copyPoint(point: Point2D): Point2D {
  return { x: point.x, y: point.y };
}

function add(a: Point2D, b: Point2D): Point2D {
  return {
    x: a.x + b.x,
    y: a.y + b.y,
  };
}

function subtract(a: Point2D, b: Point2D): Point2D {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
  };
}

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function cross(a: Point2D, b: Point2D): number {
  return a.x * b.y - a.y * b.x;
}

function scale(vector: Point2D, scalar: number): Point2D {
  return {
    x: vector.x * scalar,
    y: vector.y * scalar,
  };
}

function normalize(vector: Point2D): Point2D {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 0.000001) {
    return { x: 0, y: 0 };
  }

  return {
    x: vector.x / length,
    y: vector.y / length,
  };
}

function normalizeAngleDeg(angleDeg: number): number {
  let normalized = angleDeg % 360;
  if (normalized < 0) {
    normalized += 360;
  }
  return normalized;
}

function directionAwayFromWallEndpoint(wall: Wall, endpoint: Endpoint): Point2D {
  return endpoint === 'start'
    ? normalize(subtract(wall.endPoint, wall.startPoint))
    : normalize(subtract(wall.startPoint, wall.endPoint));
}

function directionAlongWall(wall: Wall): Point2D {
  return normalize(subtract(wall.endPoint, wall.startPoint));
}

function angleBetweenDirectionsDeg(a: Point2D, b: Point2D): number {
  const clampedDot = Math.max(-1, Math.min(1, dot(a, b)));
  return Math.acos(clampedDot) * (180 / Math.PI);
}

function angleBetweenWallAxesDeg(wall: Wall, otherWall: Wall): number {
  const axisDot = Math.max(
    -1,
    Math.min(1, Math.abs(dot(directionAlongWall(wall), directionAlongWall(otherWall))))
  );
  return Math.acos(axisDot) * (180 / Math.PI);
}

function wallsShareAcuteEndpointContact(wall: Wall, otherWall: Wall): boolean {
  const endpointPairs: Array<[Point2D, Endpoint, Point2D, Endpoint]> = [
    [wall.startPoint, 'start', otherWall.startPoint, 'start'],
    [wall.startPoint, 'start', otherWall.endPoint, 'end'],
    [wall.endPoint, 'end', otherWall.startPoint, 'start'],
    [wall.endPoint, 'end', otherWall.endPoint, 'end'],
  ];

  for (const [wallPoint, wallEndpoint, otherPoint, otherEndpoint] of endpointPairs) {
    if (!arePointsNear(wallPoint, otherPoint)) {
      continue;
    }

    const angleDeg = angleBetweenDirectionsDeg(
      directionAwayFromWallEndpoint(wall, wallEndpoint),
      directionAwayFromWallEndpoint(otherWall, otherEndpoint)
    );
    if (angleDeg < MIN_UNION_ENDPOINT_ANGLE_DEG) {
      return true;
    }
  }

  return false;
}

function wallsShareAcuteSegmentContact(wall: Wall, otherWall: Wall): boolean {
  if (angleBetweenWallAxesDeg(wall, otherWall) >= MIN_UNION_ENDPOINT_ANGLE_DEG) {
    return false;
  }

  const hasAcuteInteriorProjection = (sourceWall: Wall, hostWall: Wall): boolean => {
    const projections = [
      projectPointToSegment(sourceWall.startPoint, hostWall.startPoint, hostWall.endPoint),
      projectPointToSegment(sourceWall.endPoint, hostWall.startPoint, hostWall.endPoint),
    ];

    return projections.some(
      (projection) =>
        projection.distance <= COMPONENT_TOLERANCE_MM &&
        projection.t > SEGMENT_INTERIOR_TOLERANCE &&
        projection.t < 1 - SEGMENT_INTERIOR_TOLERANCE
    );
  };

  return hasAcuteInteriorProjection(wall, otherWall) || hasAcuteInteriorProjection(otherWall, wall);
}

function canWallsShareUnionComponent(wall: Wall, otherWall: Wall): boolean {
  return !(
    wallsShareAcuteEndpointContact(wall, otherWall) ||
    wallsShareAcuteSegmentContact(wall, otherWall)
  );
}

function polygonArea(points: Point2D[]): number {
  if (points.length < 3) {
    return 0;
  }

  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }

  return area / 2;
}

function isFinitePoint(point: Point2D): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function arePointsNear(a: Point2D, b: Point2D, tolerance = COMPONENT_TOLERANCE_MM): boolean {
  return pointDistance(a, b) <= tolerance;
}

function projectPointToSegment(
  point: Point2D,
  start: Point2D,
  end: Point2D
): { point: Point2D; distance: number; t: number } {
  const segment = subtract(end, start);
  const lengthSq = segment.x * segment.x + segment.y * segment.y;

  if (lengthSq < 0.000001) {
    return {
      point: { ...start },
      distance: pointDistance(point, start),
      t: 0,
    };
  }

  const tRaw =
    ((point.x - start.x) * segment.x + (point.y - start.y) * segment.y) / lengthSq;
  const t = Math.max(0, Math.min(1, tRaw));
  const projection = {
    x: start.x + segment.x * t,
    y: start.y + segment.y * t,
  };

  return {
    point: projection,
    distance: pointDistance(point, projection),
    t,
  };
}

function segmentIntersectionPoint(
  aStart: Point2D,
  aEnd: Point2D,
  bStart: Point2D,
  bEnd: Point2D
): { point: Point2D; t: number; u: number } | null {
  const r = subtract(aEnd, aStart);
  const s = subtract(bEnd, bStart);
  const denominator = r.x * s.y - r.y * s.x;

  if (Math.abs(denominator) <= COORDINATE_TOLERANCE_MM) {
    return null;
  }

  const qp = subtract(bStart, aStart);
  const t = (qp.x * s.y - qp.y * s.x) / denominator;
  const u = (qp.x * r.y - qp.y * r.x) / denominator;
  const epsilon = 0.001;

  if (t < -epsilon || t > 1 + epsilon || u < -epsilon || u > 1 + epsilon) {
    return null;
  }

  return {
    point: add(aStart, scale(r, t)),
    t,
    u,
  };
}

/**
 * Snap a coordinate to a fixed precision grid (0.01 mm) to prevent
 * floating-point noise from creating micro-notches in turf.js unions.
 */
const COORDINATE_SNAP_PRECISION = 100; // 1/100 mm = 0.01 mm

function snapCoordinate(value: number): number {
  return Math.round(value * COORDINATE_SNAP_PRECISION) / COORDINATE_SNAP_PRECISION;
}

function normalizeRing(ring: Point2D[]): Point2D[] {
  const cleaned: Point2D[] = [];

  for (const point of ring) {
    if (!isFinitePoint(point)) {
      continue;
    }
    const snapped = { x: snapCoordinate(point.x), y: snapCoordinate(point.y) };
    const previous = cleaned[cleaned.length - 1];
    if (!previous || pointDistance(previous, snapped) > COORDINATE_TOLERANCE_MM) {
      cleaned.push(snapped);
    }
  }

  if (cleaned.length > 1) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (pointDistance(first, last) <= COORDINATE_TOLERANCE_MM) {
      cleaned.pop();
    }
  }

  return cleaned;
}

function closeRing(points: Point2D[]): RingCoordinate[] {
  const ring = normalizeRing(points);
  if (ring.length === 0) {
    return [];
  }

  const closed = ring.map((point) => [point.x, point.y] as RingCoordinate);
  const first = closed[0];
  const last = closed[closed.length - 1];
  if (!last || last[0] !== first[0] || last[1] !== first[1]) {
    closed.push([first[0], first[1]]);
  }

  return closed;
}

function openRing(ring: ReadonlyArray<RingCoordinate>): Point2D[] {
  return normalizeRing(
    ring.map((point) => ({
      x: point[0],
      y: point[1],
    }))
  );
}

function makePolygonFeature(vertices: Point2D[]): PolygonFeature | null {
  const ring = normalizeRing(vertices);
  if (ring.length < 3 || Math.abs(polygonArea(ring)) < MIN_PATCH_AREA_MM2) {
    return null;
  }

  const closedRing = closeRing(ring);
  if (closedRing.length < 4) {
    return null;
  }

  try {
    return polygon([closedRing]);
  } catch {
    return null;
  }
}

function wallPolygonFeature(wall: Wall, joins?: JoinData[]): PolygonFeature | null {
  const polygon = computeRenderableWallPolygon(wall, joins);
  return makePolygonFeature(polygon) ?? makePolygonFeature(computeWallBodyPolygon(wall));
}

export function computeRenderableWallPolygon(wall: Wall, joins?: JoinData[]): Point2D[] {
  const startRef = buildEndpointRef(wall, 'start');
  const endRef = buildEndpointRef(wall, 'end');
  const startVertices = resolveRenderableCapVertices(
    startRef,
    joins?.find((join) => join.endpoint === 'start')
  );
  const endVertices = resolveRenderableCapVertices(
    endRef,
    joins?.find((join) => join.endpoint === 'end')
  );

  const polygon = [
    startVertices.interiorVertex,
    endVertices.interiorVertex,
    endVertices.exteriorVertex,
    startVertices.exteriorVertex,
  ];

  return polygon.every(isFinitePoint) ? polygon : computeWallBodyPolygon(wall);
}

function patchPolygonFeature(vertices: Point2D[]): PolygonFeature | null {
  return makePolygonFeature(vertices);
}

function wallsTouch(wall: Wall, otherWall: Wall): boolean {
  if (
    wall.connectedWalls.includes(otherWall.id) ||
    otherWall.connectedWalls.includes(wall.id)
  ) {
    return true;
  }

  const endpoints: Point2D[] = [wall.startPoint, wall.endPoint];
  const otherEndpoints: Point2D[] = [otherWall.startPoint, otherWall.endPoint];

  for (const point of endpoints) {
    if (otherEndpoints.some((otherPoint) => arePointsNear(point, otherPoint))) {
      return true;
    }

    const projection = projectPointToSegment(point, otherWall.startPoint, otherWall.endPoint);
    if (
      projection.distance <= COMPONENT_TOLERANCE_MM &&
      projection.t > 0.001 &&
      projection.t < 0.999
    ) {
      return true;
    }
  }

  for (const point of otherEndpoints) {
    const projection = projectPointToSegment(point, wall.startPoint, wall.endPoint);
    if (
      projection.distance <= COMPONENT_TOLERANCE_MM &&
      projection.t > 0.001 &&
      projection.t < 0.999
    ) {
      return true;
    }
  }

  if (
    segmentIntersectionPoint(
      wall.startPoint,
      wall.endPoint,
      otherWall.startPoint,
      otherWall.endPoint
    )
  ) {
    return true;
  }

  return false;
}

function addGraphEdge(graph: Map<string, Set<string>>, a: string, b: string): void {
  if (a === b) {
    return;
  }

  if (!graph.has(a)) {
    graph.set(a, new Set());
  }
  if (!graph.has(b)) {
    graph.set(b, new Set());
  }

  graph.get(a)?.add(b);
  graph.get(b)?.add(a);
}

function buildComponentGraph(
  walls: Wall[],
  joinsMap: Map<string, JoinData[]>
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  const wallsById = new Map(walls.map((wall) => [wall.id, wall]));
  const pairCompatibilityCache = new Map<string, boolean>();

  const shouldLinkWalls = (wall: Wall, otherWall: Wall): boolean => {
    const pairKey = [wall.id, otherWall.id].sort().join('|');
    const cached = pairCompatibilityCache.get(pairKey);
    if (cached !== undefined) {
      return cached;
    }

    const compatible = canWallsShareUnionComponent(wall, otherWall);
    pairCompatibilityCache.set(pairKey, compatible);
    return compatible;
  };

  for (const wall of walls) {
    graph.set(wall.id, new Set());
  }

  for (const wall of walls) {
    for (const connectedWallId of wall.connectedWalls) {
      const connectedWall = wallsById.get(connectedWallId);
      if (connectedWall && shouldLinkWalls(wall, connectedWall)) {
        addGraphEdge(graph, wall.id, connectedWallId);
      }
    }
  }

  joinsMap.forEach((joins, wallId) => {
    const wall = wallsById.get(wallId);
    if (!wall) {
      return;
    }

    for (const join of joins) {
      const otherWall = wallsById.get(join.otherWallId);
      if (otherWall && shouldLinkWalls(wall, otherWall)) {
        addGraphEdge(graph, wallId, join.otherWallId);
      }
    }
  });

  for (let index = 0; index < walls.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < walls.length; otherIndex += 1) {
      if (
        shouldLinkWalls(walls[index], walls[otherIndex]) &&
        wallsTouch(walls[index], walls[otherIndex])
      ) {
        addGraphEdge(graph, walls[index].id, walls[otherIndex].id);
      }
    }
  }

  return graph;
}

function buildConnectedComponents(
  walls: Wall[],
  joinsMap: Map<string, JoinData[]>
): string[][] {
  const graph = buildComponentGraph(walls, joinsMap);
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const wall of walls) {
    if (visited.has(wall.id)) {
      continue;
    }

    const queue = [wall.id];
    const component: string[] = [];
    visited.add(wall.id);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }

      component.push(current);
      const neighbors = graph.get(current) ?? new Set<string>();
      neighbors.forEach((neighbor) => {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      });
    }

    components.push(component);
  }

  return components;
}

function extractPolygons(
  geometry: PolygonGeometry | MultiPolygonGeometry
): Point2D[][][] {
  if (geometry.type === 'Polygon') {
    return [geometry.coordinates.map(openRing)];
  }

  return geometry.coordinates.map((polygon) => polygon.map(openRing));
}

function endpointKey(wallId: string, endpoint: Endpoint): string {
  return `${wallId}:${endpoint}`;
}

function directionAwayFromEndpoint(wall: Wall, endpoint: Endpoint): Point2D {
  return endpoint === 'start'
    ? normalize(subtract(wall.endPoint, wall.startPoint))
    : normalize(subtract(wall.startPoint, wall.endPoint));
}

function buildEndpointRef(wall: Wall, endpoint: Endpoint): WallEndpointRef {
  const point = endpoint === 'start' ? wall.startPoint : wall.endPoint;
  const direction = directionAwayFromEndpoint(wall, endpoint);
  const angleDeg = normalizeAngleDeg(Math.atan2(direction.y, direction.x) * (180 / Math.PI));

  if (endpoint === 'start') {
    return {
      key: endpointKey(wall.id, endpoint),
      wall,
      endpoint,
      point,
      direction,
      thickness: wall.thickness,
      angleDeg,
      left: { anchor: wall.interiorLine.start },
      right: { anchor: wall.exteriorLine.start },
    };
  }

  return {
    key: endpointKey(wall.id, endpoint),
    wall,
    endpoint,
    point,
    direction,
    thickness: wall.thickness,
    angleDeg,
    left: { anchor: wall.exteriorLine.end },
    right: { anchor: wall.interiorLine.end },
  };
}

function buildEndpointNodes(walls: Wall[]): EndpointNode[] {
  const refs = walls.flatMap((wall) => [
    buildEndpointRef(wall, 'start'),
    buildEndpointRef(wall, 'end'),
  ]);
  const nodes: EndpointNode[] = [];

  for (const ref of refs) {
    let node = nodes.find((candidate) => pointDistance(candidate.point, ref.point) <= COMPONENT_TOLERANCE_MM);
    if (!node) {
      node = {
        point: copyPoint(ref.point),
        endpoints: [],
      };
      nodes.push(node);
    } else if (node.endpoints.length > 0) {
      const count = node.endpoints.length + 1;
      node.point = scale(add(scale(node.point, node.endpoints.length), ref.point), 1 / count);
    }

    node.endpoints.push(ref);
  }

  return nodes;
}

function anchorAngleDeg(nodePoint: Point2D, anchor: Point2D): number {
  return normalizeAngleDeg(Math.atan2(anchor.y - nodePoint.y, anchor.x - nodePoint.x) * (180 / Math.PI));
}

function endpointRawCapVertices(endpointRef: WallEndpointRef): {
  interiorVertex: Point2D;
  exteriorVertex: Point2D;
} {
  if (endpointRef.endpoint === 'start') {
    return {
      interiorVertex: copyPoint(endpointRef.wall.interiorLine.start),
      exteriorVertex: copyPoint(endpointRef.wall.exteriorLine.start),
    };
  }

  return {
    interiorVertex: copyPoint(endpointRef.wall.interiorLine.end),
    exteriorVertex: copyPoint(endpointRef.wall.exteriorLine.end),
  };
}

function endpointJoinForRef(
  endpointRef: WallEndpointRef,
  joinsMap: Map<string, JoinData[]>
): JoinData | undefined {
  return (joinsMap.get(endpointRef.wall.id) ?? []).find(
    (join) => join.endpoint === endpointRef.endpoint
  );
}

function endpointHasManualBevel(wall: Wall, endpoint: Endpoint): boolean {
  const bevel = endpoint === 'start' ? wall.startBevel : wall.endBevel;
  return Math.abs(bevel?.innerOffset ?? 0) > 0.001 || Math.abs(bevel?.outerOffset ?? 0) > 0.001;
}

function violatesWallThicknessUniformity(
  endpointRef: WallEndpointRef,
  join: JoinData,
  raw: { interiorVertex: Point2D; exteriorVertex: Point2D },
  resolved: { interiorVertex: Point2D; exteriorVertex: Point2D }
): boolean {
  if (endpointHasManualBevel(endpointRef.wall, endpointRef.endpoint)) {
    return false;
  }

  const spanTolerance = Math.max(
    WALL_UNIFORMITY_TOLERANCE_MM,
    endpointRef.wall.thickness * 0.02
  );
  const wallLengthMm = pointDistance(endpointRef.wall.startPoint, endpointRef.wall.endPoint);
  const resolvedSpan = pointDistance(resolved.interiorVertex, resolved.exteriorVertex);
  const interiorAdvance = dot(
    subtract(resolved.interiorVertex, raw.interiorVertex),
    endpointRef.direction
  );
  const exteriorAdvance = dot(
    subtract(resolved.exteriorVertex, raw.exteriorVertex),
    endpointRef.direction
  );
  const advanceDelta = Math.abs(interiorAdvance - exteriorAdvance);

  // Short walls are far less tolerant of skewed endpoint joins: a sheared cap
  // can consume a large fraction of the wall body and makes the thickness look
  // visibly non-uniform. Prefer a stable raw cap in that case.
  if (
    wallLengthMm <= endpointRef.wall.thickness * 2.5 &&
    advanceDelta > spanTolerance
  ) {
    return true;
  }

  if (!Number.isFinite(join.angle) || join.angle >= SPIKE_JOIN_ANGLE_THRESHOLD_DEG) {
    return false;
  }

  return (
    Math.abs(resolvedSpan - endpointRef.wall.thickness) > spanTolerance ||
    advanceDelta > spanTolerance
  );
}

function resolveRenderableCapVertices(
  endpointRef: WallEndpointRef,
  join?: JoinData
): { interiorVertex: Point2D; exteriorVertex: Point2D } {
  const raw = endpointRawCapVertices(endpointRef);
  if (!join) {
    return raw;
  }

  const resolved = resolveJoinEdgeVertices(endpointRef.wall, join);
  return violatesWallThicknessUniformity(endpointRef, join, raw, resolved) ? raw : resolved;
}

function endpointResolvedCapVertices(
  endpointRef: WallEndpointRef,
  joinsMap: Map<string, JoinData[]>
): { leftVertex: Point2D; rightVertex: Point2D } {
  const resolved = resolveRenderableCapVertices(
    endpointRef,
    endpointJoinForRef(endpointRef, joinsMap)
  );
  return endpointRef.endpoint === 'start'
    ? {
        leftVertex: resolved.interiorVertex,
        rightVertex: resolved.exteriorVertex,
      }
    : {
        leftVertex: resolved.exteriorVertex,
        rightVertex: resolved.interiorVertex,
      };
}

function resolveJoinEdgeVertices(wall: Wall, join: JoinData): {
  interiorVertex: Point2D;
  exteriorVertex: Point2D;
} {
  let interiorVertex = copyPoint(join.interiorVertex);
  let exteriorVertex = copyPoint(join.exteriorVertex);

  if (!join.bevelDirection) {
    return { interiorVertex, exteriorVertex };
  }

  const bevelDirection = normalize(join.bevelDirection);
  if (Math.hypot(bevelDirection.x, bevelDirection.y) < 0.0001) {
    return { interiorVertex, exteriorVertex };
  }

  const wallVector = subtract(wall.endPoint, wall.startPoint);
  const wallLen = Math.hypot(wallVector.x, wallVector.y);
  const maxOffset = Math.max(0, join.maxBevelOffset ?? wallLen / 2);
  const bevel =
    join.endpoint === 'start'
      ? wall.startBevel ?? { outerOffset: 0, innerOffset: 0 }
      : wall.endBevel ?? { outerOffset: 0, innerOffset: 0 };
  const innerOffset = Math.min(maxOffset, Math.max(0, bevel.innerOffset ?? 0));
  const outerOffset = Math.min(maxOffset, Math.max(0, bevel.outerOffset ?? 0));

  interiorVertex = add(interiorVertex, scale(bevelDirection, -innerOffset));
  exteriorVertex = add(exteriorVertex, scale(bevelDirection, -outerOffset));
  return { interiorVertex, exteriorVertex };
}

function buildEndpointJoinPatchFeature(wall: Wall, join: JoinData): PolygonFeature | null {
  if (!join.endpoint) {
    return null;
  }

  const endpointRef = buildEndpointRef(wall, join.endpoint);
  const rawCap = endpointRawCapVertices(endpointRef);
  const joined = resolveRenderableCapVertices(endpointRef, join);
  return patchPolygonFeature([
    rawCap.interiorVertex,
    joined.interiorVertex,
    joined.exteriorVertex,
    rawCap.exteriorVertex,
  ]);
}

function buildEndpointJoinPatchFeatures(
  walls: Wall[],
  joinsMap: Map<string, JoinData[]>,
  filter?: (join: JoinData) => boolean
): PolygonFeature[] {
  const wallsById = new Map(walls.map((wall) => [wall.id, wall]));
  const features: PolygonFeature[] = [];

  joinsMap.forEach((joins, wallId) => {
    const wall = wallsById.get(wallId);
    if (!wall) {
      return;
    }

    joins.forEach((join) => {
      if (filter && !filter(join)) {
        return;
      }
      const feature = buildEndpointJoinPatchFeature(wall, join);
      if (feature) {
        features.push(feature);
      }
    });
  });

  return features;
}

// -----------------------------------------------------------------------------
// Convex Hull (Andrew's monotone chain)
// -----------------------------------------------------------------------------
function convexHull(points: Point2D[]): Point2D[] {
  if (points.length <= 3) return [...points];
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: Point2D[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(subtract(lower[lower.length - 1], lower[lower.length - 2]),
                                        subtract(p, lower[lower.length - 1])) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point2D[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(subtract(upper[upper.length - 1], upper[upper.length - 2]),
                                        subtract(p, upper[upper.length - 1])) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function buildNodeCorePatchFeatures(
  walls: Wall[],
  joinsMap: Map<string, JoinData[]>,
  includeNode?: (node: EndpointNode) => boolean
): PolygonFeature[] {
  const nodes = buildEndpointNodes(walls);
  const features: PolygonFeature[] = [];

  for (const node of nodes) {
    if (node.endpoints.length < 2) continue;
    if (includeNode && !includeNode(node)) continue;

    const resolvedVertices = node.endpoints.flatMap((endpointRef) => {
      const vertices = endpointResolvedCapVertices(endpointRef, joinsMap);
      return [vertices.leftVertex, vertices.rightVertex];
    });

    // Deduplicate (keep unique points)
    const uniqueVertices: Point2D[] = [];
    for (const v of resolvedVertices) {
      if (!uniqueVertices.some(u => pointDistance(u, v) <= COORDINATE_TOLERANCE_MM)) {
        uniqueVertices.push(copyPoint(v));
      }
    }

    if (uniqueVertices.length < 3) continue;

    // Build convex hull (always simple, covers all points)
    const hull = convexHull(uniqueVertices);
    if (hull.length < 3) continue;

    const patch = patchPolygonFeature(hull);
    if (patch) features.push(patch);
  }

  return features;
}

function featureUnionPolygons(features: PolygonFeature[]): Point2D[][][] {
  if (features.length === 0) {
    return [];
  }

  if (features.length === 1) {
    return [features[0].geometry.coordinates.map(openRing)];
  }

  try {
    const merged = union(featureCollection(features));
    if (merged && (merged.geometry.type === 'Polygon' || merged.geometry.type === 'MultiPolygon')) {
      return extractPolygons(merged.geometry);
    }
  } catch {
    // Fall through to the per-feature polygons below.
  }

  return features.map((feature) => feature.geometry.coordinates.map(openRing));
}

function unionWallComponent(
  walls: Wall[],
  joinsMap: Map<string, JoinData[]>
): { polygons: Point2D[][][]; junctionOverlays: Point2D[][][] } {
  if (walls.length === 0) {
    return { polygons: [], junctionOverlays: [] };
  }

  // Use the resolved per-wall join polygons for the visible body so wide-angle
  // corners keep their intended architectural shape. The endpoint overlay
  // patches remain disabled below because those were the main source of the
  // short-wall tapering artifact.
  const features = [
    ...walls.flatMap((wall) => {
      const feature = wallPolygonFeature(wall, joinsMap.get(wall.id));
      return feature ? [feature] : [];
    }),
    ...buildNodeCorePatchFeatures(walls, joinsMap),
  ];

  return {
    polygons: featureUnionPolygons(features),
    junctionOverlays: [],
  };
}

export function computeWallUnionRenderData(
  walls: Wall[],
  precomputedJoinsMap?: Map<string, JoinData[]>
): WallUnionRenderData {
  const cacheable = !precomputedJoinsMap;
  const signature = cacheable ? wallUnionSignature(walls) : null;
  if (signature) {
    const cached = getCachedWallUnionRenderData(signature);
    if (cached) {
      return cached;
    }
  }

  // When no precomputed joins are provided, use the shadow-aware variant
  // so that coincident duplicate walls (e.g. shared room edges) are excluded
  // from the polygon union — preventing double-thickness artifacts.
  let joinsMap: Map<string, JoinData[]>;
  let shadowedWallIds: Set<string>;

  if (precomputedJoinsMap) {
    joinsMap = precomputedJoinsMap;
    shadowedWallIds = new Set<string>();
  } else {
    const result = computeWallJoinMapWithShadows(walls);
    joinsMap = result.joinsMap;
    shadowedWallIds = result.shadowedWallIds;
  }

  const wallsById = new Map(walls.map((wall) => [wall.id, wall]));
  const components = buildConnectedComponents(walls, joinsMap)
    .map((wallIds, index) => {
      // Exclude shadowed walls from the polygon union — the representative
      // wall already covers the same geometry.  Keep shadowed IDs in the
      // component's wallIds list so hit-testing / selection still works.
      const componentWalls = wallIds
        .map((wallId) => wallsById.get(wallId))
        .filter((wall): wall is Wall => Boolean(wall));

      const unionWalls = shadowedWallIds.size > 0
        ? componentWalls.filter((w) => !shadowedWallIds.has(w.id))
        : componentWalls;

      return {
        id: `wall-component-${index}`,
        wallIds,
        ...unionWallComponent(unionWalls, joinsMap),
      };
    })
    .filter((component) => component.polygons.length > 0 || component.junctionOverlays.length > 0);

  const renderData = {
    joinsMap,
    components,
  };
  if (signature) {
    setCachedWallUnionRenderData(signature, renderData);
  }
  return renderData;
}

/**
 * Compute junction (corner) patch polygons for all nodes where 2+ walls meet.
 * Each patch is a 2D polygon that fills the gap between wall endpoints at a junction.
 * Returns the polygon vertices and the IDs of walls participating in each junction.
 */
export function computeJunctionPatchPolygons(
  walls: Wall[],
  precomputedJoinsMap?: Map<string, JoinData[]>
): { polygon: Point2D[]; wallIds: string[] }[] {
  const joinsMap = precomputedJoinsMap ?? computeWallJoinMap(walls);
  const nodes = buildEndpointNodes(walls);
  const patches: { polygon: Point2D[]; wallIds: string[] }[] = [];

  for (const node of nodes) {
    if (node.endpoints.length < 2) {
      continue;
    }

    const resolvedVertices = node.endpoints.flatMap((endpointRef) => {
      const vertices = endpointResolvedCapVertices(endpointRef, joinsMap);
      return [vertices.leftVertex, vertices.rightVertex];
    });
    const uniqueVertices: Point2D[] = [];
    resolvedVertices.forEach((vertex) => {
      if (!uniqueVertices.some((candidate) => pointDistance(candidate, vertex) <= COORDINATE_TOLERANCE_MM)) {
        uniqueVertices.push(copyPoint(vertex));
      }
    });

    if (uniqueVertices.length < 3) {
      continue;
    }

    const hull = convexHull(uniqueVertices);
    if (hull.length < 3) continue;

    if (Math.abs(polygonArea(hull)) < MIN_PATCH_AREA_MM2) {
      continue;
    }

    patches.push({
      polygon: hull,
      wallIds: node.endpoints.map((ep) => ep.wall.id),
    });
  }

  return patches;
}
