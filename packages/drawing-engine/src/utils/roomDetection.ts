import {
  booleanContains,
  booleanPointInPolygon,
  booleanPointOnLine,
  centroid as turfCentroid,
  featureCollection as turfFeatureCollection,
  kinks as turfKinks,
  lineIntersect,
  lineSplit,
  lineString as turfLineString,
  point as turfPoint,
  pointOnFeature as turfPointOnFeature,
  polygon as turfPolygon,
  polygonize,
  polygonToLine,
} from '@turf/turf';

import type {
  DetectedRoom,
  RoomDetectionConfig,
  RoomLabelTag,
  WallSegment,
} from '../types/room';
import {
  DEFAULT_ROOM_DETECTION_CONFIG,
  ROOM_LABEL_MAX_FONT,
  ROOM_LABEL_MIN_FONT,
} from '../types/room';
import { generateId } from './geometry';

type Point = { x: number; y: number };

interface NormalizedWallSegment {
  id: string;
  startPoint: Point;
  endPoint: Point;
  thickness: number;
  snapToGrid: boolean;
  parentRoomId?: string;
  originalWallIds: string[];
}

interface CycleCandidate {
  polygon: Point[];
  area: number;
  signature: string;
  wallIds: string[];
  holes: Point[][];
}

interface AdjacencyEdge {
  to: string;
  wallId: string;
  edgeKey: string;
}

interface ExistingRoomMeta {
  room: DetectedRoom;
  signature: string;
}

export interface RoomDetectionRunOptions {
  walls: WallSegment[];
  existingRooms?: DetectedRoom[];
  config?: Partial<RoomDetectionConfig>;
  changedWallIds?: string[];
}

export interface RoomDetectionRunResult {
  rooms: DetectedRoom[];
  roomWallIdsById: Map<string, string[]>;
  roomHolesById: Map<string, Point[][]>;
  affectedWallIds: Set<string>;
  archivedParentRooms: Map<string, DetectedRoom>;
}

export interface PreparedWallInsertionResult {
  wall: WallSegment;
  snappedToWallEndpoint: boolean;
  isDivider: boolean;
}

const EPSILON = 1e-6;
const DIVIDER_TOLERANCE = 5;
const MAX_DFS_DEPTH = 24;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointsEqual(a: Point, b: Point, tolerance: number): boolean {
  return distance(a, b) <= tolerance;
}

function midpoint(a: Point, b: Point): Point {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function segmentLength(wall: Pick<WallSegment, 'startPoint' | 'endPoint'>): number {
  return distance(wall.startPoint, wall.endPoint);
}

function toNodeKey(point: Point, snapTolerance: number): string {
  const safeTolerance = Math.max(1, snapTolerance);
  return `${Math.round(point.x / safeTolerance)}:${Math.round(point.y / safeTolerance)}`;
}

function fromRing(ring: number[][]): Point[] {
  return ring.slice(0, -1).map(([x, y]) => ({ x, y }));
}

function ensureClosedRing(points: Point[]): number[][] {
  if (points.length === 0) return [];
  const ring = points.map((point) => [point.x, point.y]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last) return ring;
  if (Math.abs(first[0] - last[0]) > EPSILON || Math.abs(first[1] - last[1]) > EPSILON) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}

function signedArea(points: Point[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!a || !b) continue;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function polygonArea(points: Point[]): number {
  return Math.abs(signedArea(points));
}

function polygonBounds(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
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

function boundsIntersect(
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number }
): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

function expandBounds(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  padding: number
): { minX: number; minY: number; maxX: number; maxY: number } {
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
  };
}

function canonicalLoopSignature(points: Point[], precision = 1): string {
  const rounded = points.map((point) => `${point.x.toFixed(precision)}:${point.y.toFixed(precision)}`);
  if (rounded.length === 0) return '';

  const variants: string[] = [];
  for (let i = 0; i < rounded.length; i++) {
    const rotated = [...rounded.slice(i), ...rounded.slice(0, i)];
    variants.push(rotated.join('|'));
  }
  const reversed = [...rounded].reverse();
  for (let i = 0; i < reversed.length; i++) {
    const rotated = [...reversed.slice(i), ...reversed.slice(0, i)];
    variants.push(rotated.join('|'));
  }
  variants.sort();
  return variants[0] ?? '';
}

function toPolygonFeature(points: Point[], holes: Point[][] = []): any | null {
  if (points.length < 3) return null;
  const outer = ensureClosedRing(points);
  if (outer.length < 4) return null;
  const holeRings = holes
    .map((hole) => ensureClosedRing(hole))
    .filter((ring) => ring.length >= 4);
  try {
    return turfPolygon([outer, ...holeRings]);
  } catch {
    return null;
  }
}

function pointInsidePolygon(point: Point, polygon: Point[], holes: Point[][] = []): boolean {
  const polygonFeature = toPolygonFeature(polygon, holes);
  if (!polygonFeature) return false;
  return booleanPointInPolygon(turfPoint([point.x, point.y]), polygonFeature, {
    ignoreBoundary: false,
  });
}

function polygonContainsPolygon(outer: Point[], inner: Point[]): boolean {
  const outerFeature = toPolygonFeature(outer);
  const innerFeature = toPolygonFeature(inner);
  if (!outerFeature || !innerFeature) return false;
  try {
    return booleanContains(outerFeature, innerFeature);
  } catch {
    return false;
  }
}

function geometryToRings(geometry: any): Array<{ outer: Point[]; holes: Point[][] }> {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') {
    const [outerRing, ...holeRings] = geometry.coordinates;
    if (!outerRing) return [];
    return [{
      outer: fromRing(outerRing),
      holes: holeRings.map(fromRing),
    }];
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates
      .map((polygon: number[][][]) => {
        const [outerRing, ...holeRings] = polygon;
        if (!outerRing) return null;
        return {
          outer: fromRing(outerRing),
          holes: holeRings.map(fromRing),
        };
      })
      .filter((entry: { outer: Point[]; holes: Point[][] } | null): entry is { outer: Point[]; holes: Point[][] } => Boolean(entry));
  }
  return [];
}

function toLineFeature(wall: Pick<WallSegment, 'startPoint' | 'endPoint'>): any {
  return turfLineString([
    [wall.startPoint.x, wall.startPoint.y],
    [wall.endPoint.x, wall.endPoint.y],
  ]);
}

function endpointSnapCandidates(wall: WallSegment): Point[] {
  return [wall.startPoint, wall.endPoint];
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace('#', '').trim();
  if (normalized.length === 3) {
    const r = parseInt(`${normalized[0]}${normalized[0]}`, 16);
    const g = parseInt(`${normalized[1]}${normalized[1]}`, 16);
    const b = parseInt(`${normalized[2]}${normalized[2]}`, 16);
    return { r, g, b };
  }
  const six = normalized.padEnd(6, '0').slice(0, 6);
  const r = parseInt(six.slice(0, 2), 16);
  const g = parseInt(six.slice(2, 4), 16);
  const b = parseInt(six.slice(4, 6), 16);
  return { r, g, b };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (delta > EPSILON) {
    s = delta / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case rn:
        h = ((gn - bn) / delta) % 6;
        break;
      case gn:
        h = (bn - rn) / delta + 2;
        break;
      default:
        h = (rn - gn) / delta + 4;
        break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hp >= 0 && hp < 1) {
    r1 = c;
    g1 = x;
  } else if (hp >= 1 && hp < 2) {
    r1 = x;
    g1 = c;
  } else if (hp >= 2 && hp < 3) {
    g1 = c;
    b1 = x;
  } else if (hp >= 3 && hp < 4) {
    g1 = x;
    b1 = c;
  } else if (hp >= 4 && hp < 5) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  const m = l - c / 2;
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

function toHex(value: number): string {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
}

export function darkenHex(hex: string, percent: number): string {
  const { r, g, b } = parseHex(hex);
  const hsl = rgbToHsl(r, g, b);
  const nextLightness = clamp(hsl.l * (1 - percent / 100), 0, 1);
  const rgb = hslToRgb(hsl.h, hsl.s, nextLightness);
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

export function snapEndpointToNearest(
  point: Point,
  walls: WallSegment[],
  tolerance: number
): { point: Point; snapped: boolean } {
  let best: Point | null = null;
  let bestDistance = tolerance;

  walls.forEach((wall) => {
    endpointSnapCandidates(wall).forEach((candidate) => {
      const candidateDistance = distance(point, candidate);
      if (candidateDistance <= bestDistance) {
        bestDistance = candidateDistance;
        best = candidate;
      }
    });
  });

  if (!best) {
    return { point: { ...point }, snapped: false };
  }
  const snappedPoint = best as Point;
  return { point: { x: snappedPoint.x, y: snappedPoint.y }, snapped: true };
}

function normalizeWallEndpoints(wall: WallSegment, walls: WallSegment[], config: RoomDetectionConfig): PreparedWallInsertionResult {
  const startSnap = snapEndpointToNearest(wall.startPoint, walls, config.snapTolerance);
  const endSnap = snapEndpointToNearest(wall.endPoint, walls, config.snapTolerance);
  return {
    wall: {
      ...wall,
      startPoint: startSnap.point,
      endPoint: endSnap.point,
      thickness: Number.isFinite(wall.thickness) ? wall.thickness : 8,
    },
    snappedToWallEndpoint: startSnap.snapped || endSnap.snapped,
    isDivider: false,
  };
}

function pointOnPolygonBoundary(point: Point, polygon: Point[], tolerance = DIVIDER_TOLERANCE): boolean {
  const feature = toPolygonFeature(polygon);
  if (!feature) return false;
  const boundary = polygonToLine(feature);
  const pointFeature = turfPoint([point.x, point.y]);

  if (boundary.type === 'FeatureCollection') {
    return boundary.features.some((line) =>
      booleanPointOnLine(pointFeature, line as any, {
        epsilon: tolerance,
      })
    );
  }
  return booleanPointOnLine(pointFeature, boundary as any, {
    epsilon: tolerance,
  });
}

function pointOnBoundaryOrInside(point: Point, polygon: Point[], tolerance = DIVIDER_TOLERANCE): boolean {
  if (pointOnPolygonBoundary(point, polygon, tolerance)) return true;
  return pointInsidePolygon(point, polygon);
}

function wallIsDividerForRoom(
  wall: WallSegment,
  room: Pick<DetectedRoom, 'polygon'>,
  tolerance = DIVIDER_TOLERANCE
): boolean {
  return (
    pointOnBoundaryOrInside(wall.startPoint, room.polygon, tolerance) &&
    pointOnBoundaryOrInside(wall.endPoint, room.polygon, tolerance)
  );
}

export function prepareWallSegmentForInsertion(
  wall: WallSegment,
  existingWalls: WallSegment[],
  existingRooms: DetectedRoom[],
  configInput?: Partial<RoomDetectionConfig>
): PreparedWallInsertionResult {
  const config = { ...DEFAULT_ROOM_DETECTION_CONFIG, ...configInput };
  const normalized = normalizeWallEndpoints(wall, existingWalls, config);
  const dividerParent = existingRooms.find((room) => wallIsDividerForRoom(normalized.wall, room, DIVIDER_TOLERANCE));
  return {
    wall: {
      ...normalized.wall,
      parentRoomId: dividerParent?.id ?? normalized.wall.parentRoomId,
    },
    snappedToWallEndpoint: normalized.snappedToWallEndpoint,
    isDivider: Boolean(dividerParent),
  };
}

function areCollinear(a: NormalizedWallSegment, b: NormalizedWallSegment): boolean {
  const ax = a.endPoint.x - a.startPoint.x;
  const ay = a.endPoint.y - a.startPoint.y;
  const bx = b.endPoint.x - b.startPoint.x;
  const by = b.endPoint.y - b.startPoint.y;
  const cross = Math.abs(ax * by - ay * bx);
  const lengths = Math.max(1, Math.hypot(ax, ay) * Math.hypot(bx, by));
  return cross / lengths < 0.001;
}

function pointProjectionParameter(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < EPSILON) return 0;
  return ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq;
}

function pointOnSegment(point: Point, start: Point, end: Point, tolerance: number): boolean {
  const t = pointProjectionParameter(point, start, end);
  if (t < -EPSILON || t > 1 + EPSILON) return false;
  const projected = {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
  };
  return distance(point, projected) <= tolerance;
}

function segmentIntersection(
  aStart: Point,
  aEnd: Point,
  bStart: Point,
  bEnd: Point
): Point | null {
  const x1 = aStart.x;
  const y1 = aStart.y;
  const x2 = aEnd.x;
  const y2 = aEnd.y;
  const x3 = bStart.x;
  const y3 = bStart.y;
  const x4 = bEnd.x;
  const y4 = bEnd.y;

  const denominator = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denominator) < EPSILON) return null;

  const det1 = x1 * y2 - y1 * x2;
  const det2 = x3 * y4 - y3 * x4;
  const px = (det1 * (x3 - x4) - (x1 - x2) * det2) / denominator;
  const py = (det1 * (y3 - y4) - (y1 - y2) * det2) / denominator;
  return { x: px, y: py };
}

function deduplicateWalls(walls: WallSegment[], tolerance: number): WallSegment[] {
  const result: WallSegment[] = [];
  walls.forEach((wall) => {
    const duplicate = result.some((existing) => {
      const sameDirection =
        pointsEqual(existing.startPoint, wall.startPoint, tolerance) &&
        pointsEqual(existing.endPoint, wall.endPoint, tolerance);
      const reverseDirection =
        pointsEqual(existing.startPoint, wall.endPoint, tolerance) &&
        pointsEqual(existing.endPoint, wall.startPoint, tolerance);
      return sameDirection || reverseDirection;
    });
    if (!duplicate) {
      result.push({
        ...wall,
        startPoint: { ...wall.startPoint },
        endPoint: { ...wall.endPoint },
      });
    }
  });
  return result;
}

function deduplicateNormalizedWalls(
  walls: NormalizedWallSegment[],
  tolerance: number
): NormalizedWallSegment[] {
  const result: NormalizedWallSegment[] = [];

  walls.forEach((wall) => {
    const duplicateIndex = result.findIndex((existing) => {
      const sameDirection =
        pointsEqual(existing.startPoint, wall.startPoint, tolerance) &&
        pointsEqual(existing.endPoint, wall.endPoint, tolerance);
      const reverseDirection =
        pointsEqual(existing.startPoint, wall.endPoint, tolerance) &&
        pointsEqual(existing.endPoint, wall.startPoint, tolerance);
      return sameDirection || reverseDirection;
    });

    if (duplicateIndex < 0) {
      result.push({
        ...wall,
        startPoint: { ...wall.startPoint },
        endPoint: { ...wall.endPoint },
        originalWallIds: [...wall.originalWallIds],
      });
      return;
    }

    const existing = result[duplicateIndex];
    result[duplicateIndex] = {
      ...existing,
      thickness: (existing.thickness + wall.thickness) / 2,
      snapToGrid: existing.snapToGrid || wall.snapToGrid,
      parentRoomId: existing.parentRoomId ?? wall.parentRoomId,
      originalWallIds: [...new Set([...existing.originalWallIds, ...wall.originalWallIds])],
    };
  });

  return result;
}

function splitWallsAtIntersections(
  walls: WallSegment[],
  tolerance: number
): NormalizedWallSegment[] {
  const splitPointsByWall = new Map<string, Point[]>();
  walls.forEach((wall) => {
    splitPointsByWall.set(wall.id, [
      { ...wall.startPoint },
      { ...wall.endPoint },
    ]);
  });

  for (let i = 0; i < walls.length; i++) {
    const wallA = walls[i];
    if (!wallA) continue;
    for (let j = i + 1; j < walls.length; j++) {
      const wallB = walls[j];
      if (!wallB) continue;
      const intersection = segmentIntersection(
        wallA.startPoint,
        wallA.endPoint,
        wallB.startPoint,
        wallB.endPoint
      );
      if (!intersection) continue;

      const onA = pointOnSegment(intersection, wallA.startPoint, wallA.endPoint, tolerance);
      const onB = pointOnSegment(intersection, wallB.startPoint, wallB.endPoint, tolerance);
      if (!onA || !onB) continue;

      const tA = pointProjectionParameter(intersection, wallA.startPoint, wallA.endPoint);
      const tB = pointProjectionParameter(intersection, wallB.startPoint, wallB.endPoint);
      const aInterior = tA > EPSILON && tA < 1 - EPSILON;
      const bInterior = tB > EPSILON && tB < 1 - EPSILON;
      if (!aInterior && !bInterior) continue;

      if (aInterior) {
        splitPointsByWall.set(wallA.id, [...(splitPointsByWall.get(wallA.id) ?? []), intersection]);
      }
      if (bInterior) {
        splitPointsByWall.set(wallB.id, [...(splitPointsByWall.get(wallB.id) ?? []), intersection]);
      }
    }
  }

  const splitWalls: NormalizedWallSegment[] = [];
  walls.forEach((wall) => {
    const points = splitPointsByWall.get(wall.id) ?? [wall.startPoint, wall.endPoint];
    const unique = points.filter((point, index) =>
      points.findIndex((candidate) => pointsEqual(candidate, point, tolerance / 2)) === index
    );
    unique.sort((a, b) => {
      const ta = pointProjectionParameter(a, wall.startPoint, wall.endPoint);
      const tb = pointProjectionParameter(b, wall.startPoint, wall.endPoint);
      return ta - tb;
    });
    for (let i = 0; i < unique.length - 1; i++) {
      const startPoint = unique[i];
      const endPoint = unique[i + 1];
      if (!startPoint || !endPoint) continue;
      if (distance(startPoint, endPoint) <= tolerance / 2) continue;
      splitWalls.push({
        id: `${wall.id}::${i}`,
        startPoint: { ...startPoint },
        endPoint: { ...endPoint },
        thickness: wall.thickness,
        snapToGrid: wall.snapToGrid,
        parentRoomId: wall.parentRoomId,
        originalWallIds: [wall.id],
      });
    }
  });
  return splitWalls;
}

function mergeCollinearLogicalWalls(
  walls: NormalizedWallSegment[],
  tolerance: number,
  snapTolerance: number
): NormalizedWallSegment[] {
  const segments = [...walls];
  let changed = true;

  while (changed) {
    changed = false;
    outer: for (let i = 0; i < segments.length; i++) {
      const a = segments[i];
      if (!a) continue;
      for (let j = i + 1; j < segments.length; j++) {
        const b = segments[j];
        if (!b) continue;
        if (!areCollinear(a, b)) continue;

        const sharedPoint =
          pointsEqual(a.startPoint, b.startPoint, tolerance) ? a.startPoint :
          pointsEqual(a.startPoint, b.endPoint, tolerance) ? a.startPoint :
          pointsEqual(a.endPoint, b.startPoint, tolerance) ? a.endPoint :
          pointsEqual(a.endPoint, b.endPoint, tolerance) ? a.endPoint :
          null;
        if (!sharedPoint) continue;
        const wallsAtSharedPoint = segments.filter((segment) =>
          pointsEqual(segment.startPoint, sharedPoint, tolerance) ||
          pointsEqual(segment.endPoint, sharedPoint, tolerance)
        );
        // Preserve split nodes that represent room corners or T-junctions.
        if (wallsAtSharedPoint.length !== 2) continue;

        const endpoints = [a.startPoint, a.endPoint, b.startPoint, b.endPoint];
        const nonShared = endpoints.filter((point) => !pointsEqual(point, sharedPoint, tolerance));
        if (nonShared.length < 2) continue;
        const [startCandidate, endCandidate] = nonShared;
        if (!startCandidate || !endCandidate) continue;
        if (distance(startCandidate, endCandidate) <= snapTolerance / 2) continue;

        const merged: NormalizedWallSegment = {
          id: `${a.id}+${b.id}`,
          startPoint: { ...startCandidate },
          endPoint: { ...endCandidate },
          thickness: (a.thickness + b.thickness) / 2,
          snapToGrid: a.snapToGrid || b.snapToGrid,
          parentRoomId: a.parentRoomId ?? b.parentRoomId,
          originalWallIds: [...new Set([...a.originalWallIds, ...b.originalWallIds])],
        };

        segments.splice(j, 1);
        segments.splice(i, 1, merged);
        changed = true;
        break outer;
      }
    }
  }

  return segments;
}

function preprocessWalls(walls: WallSegment[], config: RoomDetectionConfig): NormalizedWallSegment[] {
  const deduped = deduplicateWalls(walls, config.snapTolerance / 2);
  const split = splitWallsAtIntersections(deduped, config.snapTolerance / 2);
  const dedupedSplit = deduplicateNormalizedWalls(split, config.snapTolerance / 2);
  const merged = mergeCollinearLogicalWalls(dedupedSplit, config.snapTolerance / 2, config.snapTolerance);
  return deduplicateNormalizedWalls(merged, config.snapTolerance / 2);
}

function buildGraph(
  walls: NormalizedWallSegment[],
  snapTolerance: number
): {
  nodeByKey: Map<string, Point>;
  adjacency: Map<string, AdjacencyEdge[]>;
  wallById: Map<string, NormalizedWallSegment>;
} {
  const nodeByKey = new Map<string, Point>();
  const adjacency = new Map<string, AdjacencyEdge[]>();
  const wallById = new Map<string, NormalizedWallSegment>();

  walls.forEach((wall) => {
    const from = toNodeKey(wall.startPoint, snapTolerance);
    const to = toNodeKey(wall.endPoint, snapTolerance);
    if (!nodeByKey.has(from)) {
      nodeByKey.set(from, { ...wall.startPoint });
    }
    if (!nodeByKey.has(to)) {
      nodeByKey.set(to, { ...wall.endPoint });
    }

    const undirectedKey = from < to ? `${from}|${to}` : `${to}|${from}`;
    const edgeKey = `${undirectedKey}:${wall.id}`;
    const fromEdges = adjacency.get(from) ?? [];
    fromEdges.push({ to, wallId: wall.id, edgeKey });
    adjacency.set(from, fromEdges);
    const toEdges = adjacency.get(to) ?? [];
    toEdges.push({ to: from, wallId: wall.id, edgeKey });
    adjacency.set(to, toEdges);
    wallById.set(wall.id, wall);
  });

  return { nodeByKey, adjacency, wallById };
}

function dfsCycles(
  adjacency: Map<string, AdjacencyEdge[]>,
  nodeByKey: Map<string, Point>,
  wallById: Map<string, NormalizedWallSegment>,
  config: RoomDetectionConfig
): CycleCandidate[] {
  const nodeKeys = [...nodeByKey.keys()];
  const seen = new Set<string>();
  const candidates: CycleCandidate[] = [];

  const explore = (
    start: string,
    current: string,
    pathNodes: string[],
    pathWalls: string[],
    usedEdges: Set<string>
  ) => {
    if (pathNodes.length > MAX_DFS_DEPTH) return;
    const edges = adjacency.get(current) ?? [];
    for (const edge of edges) {
      if (usedEdges.has(edge.edgeKey)) continue;
      if (edge.to === start && pathNodes.length >= 3) {
        const cycleNodeKeys = [...pathNodes];
        const cycleWalls = [...pathWalls, edge.wallId];
        const points = cycleNodeKeys
          .map((key) => nodeByKey.get(key))
          .filter((point): point is Point => Boolean(point));
        if (points.length < 3) continue;
        const area = polygonArea(points);
        if (area < config.minRoomArea) continue;
        const signature = canonicalLoopSignature(points, 1);
        if (!signature || seen.has(signature)) continue;

        const polygonFeature = toPolygonFeature(points);
        if (!polygonFeature) continue;
        const polygonKinks = turfKinks(polygonFeature);
        if (polygonKinks.features.length > 0) continue;

        seen.add(signature);
        const normalizedWallIds = Array.from(
          new Set(
            cycleWalls.flatMap((wallId) => wallById.get(wallId)?.originalWallIds ?? [wallId])
          )
        );
        candidates.push({
          polygon: points,
          area,
          signature,
          wallIds: normalizedWallIds,
          holes: [],
        });
        continue;
      }

      if (pathNodes.includes(edge.to)) continue;
      const nextEdges = new Set(usedEdges);
      nextEdges.add(edge.edgeKey);
      explore(
        start,
        edge.to,
        [...pathNodes, edge.to],
        [...pathWalls, edge.wallId],
        nextEdges
      );
    }
  };

  nodeKeys.forEach((start) => {
    explore(start, start, [start], [], new Set<string>());
  });

  const sorted = [...candidates].sort((a, b) => a.area - b.area);
  const minimal: CycleCandidate[] = [];
  sorted.forEach((candidate) => {
    const center = polygonCentroidInside(candidate.polygon, candidate.holes.flat());
    const containsSmaller = minimal.some((kept) =>
      kept.area < candidate.area * 0.999 &&
      pointInsidePolygon(center, kept.polygon, kept.holes)
    );
    if (!containsSmaller) {
      minimal.push(candidate);
    }
  });

  return minimal;
}

function polygonizeCandidates(
  walls: NormalizedWallSegment[],
  config: RoomDetectionConfig
): CycleCandidate[] {
  const lineFeatures = walls
    .filter((wall) => segmentLength(wall) > config.snapTolerance / 3)
    .map((wall) => toLineFeature(wall));
  if (lineFeatures.length === 0) return [];

  let polygonized: any;
  try {
    polygonized = polygonize(turfFeatureCollection(lineFeatures as any) as any) as any;
  } catch {
    return [];
  }

  const candidates: CycleCandidate[] = [];
  const seen = new Set<string>();
  polygonized.features.forEach((feature: any) => {
    const rings = geometryToRings(feature.geometry);
    rings.forEach(({ outer, holes }) => {
      const area = polygonArea(outer) - holes.reduce((sum, hole) => sum + polygonArea(hole), 0);
      if (area < config.minRoomArea) return;
      const signature = canonicalLoopSignature(outer, 1);
      if (!signature || seen.has(signature)) return;
      seen.add(signature);
      candidates.push({
        polygon: outer,
        holes,
        area,
        signature,
        wallIds: [],
      });
    });
  });

  return candidates;
}

function wallTouchesPolygon(
  wall: NormalizedWallSegment,
  polygon: Point[],
  holes: Point[][] = []
): boolean {
  const wallLine = toLineFeature(wall);
  const polygonFeature = toPolygonFeature(polygon, holes);
  if (!polygonFeature) return false;

  const boundary = polygonToLine(polygonFeature);
  const intersects = boundary.type === 'FeatureCollection'
    ? boundary.features.some((line: any) => lineIntersect(wallLine, line as any).features.length > 0)
    : lineIntersect(wallLine, boundary as any).features.length > 0;

  if (intersects) return true;
  const mid = midpoint(wall.startPoint, wall.endPoint);
  return pointInsidePolygon(mid, polygon, holes);
}

function attachWallIdsToCandidates(
  candidates: CycleCandidate[],
  walls: NormalizedWallSegment[]
): CycleCandidate[] {
  return candidates.map((candidate) => {
    const wallIds = new Set<string>();
    walls.forEach((wall) => {
      if (wallTouchesPolygon(wall, candidate.polygon, candidate.holes)) {
        wall.originalWallIds.forEach((sourceId) => wallIds.add(sourceId));
      }
    });
    return {
      ...candidate,
      wallIds: Array.from(wallIds),
    };
  });
}

function polygonCentroidInside(polygon: Point[], holes: Point[] = []): Point {
  const feature = toPolygonFeature(polygon, holes.length > 0 ? [holes] : []);
  if (!feature) {
    return polygon[0] ?? { x: 0, y: 0 };
  }
  const centroidFeature = turfCentroid(feature);
  const centroidPoint = {
    x: centroidFeature.geometry.coordinates[0],
    y: centroidFeature.geometry.coordinates[1],
  };
  if (pointInsidePolygon(centroidPoint, polygon, holes.length > 0 ? [holes] : [])) {
    return centroidPoint;
  }
  const pointOn = turfPointOnFeature(feature);
  return {
    x: pointOn.geometry.coordinates[0],
    y: pointOn.geometry.coordinates[1],
  };
}

function computeLabelTag(
  roomId: string,
  roomName: string,
  area: number,
  centroid: Point,
  existing?: DetectedRoom
): RoomLabelTag {
  const defaultPosition = existing?.labelTag.pinned ? existing.labelTag.position : centroid;
  const fontSize = clamp(Math.sqrt(Math.max(area, 1)) / 20, ROOM_LABEL_MIN_FONT, ROOM_LABEL_MAX_FONT);
  return {
    roomId,
    text: `${roomName}\n${area.toFixed(1)} px²`,
    position: { ...defaultPosition },
    visible: existing?.labelTag.visible ?? true,
    fontSize: existing?.labelTag.fontSize ?? fontSize,
    pinned: existing?.labelTag.pinned ?? false,
  };
}

function parseMaxSequence(existingRooms: DetectedRoom[], prefix: string): number {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escaped}\\s+(\\d+)$`, 'i');
  let max = 0;
  existingRooms.forEach((room) => {
    const match = room.name.match(regex);
    if (!match || !match[1]) return;
    const value = Number(match[1]);
    if (Number.isFinite(value)) {
      max = Math.max(max, value);
    }
  });
  return max;
}

function collectAffectedSubgraphWallIds(
  walls: WallSegment[],
  changedWallIds: string[],
  snapTolerance: number
): Set<string> {
  if (changedWallIds.length === 0) {
    return new Set(walls.map((wall) => wall.id));
  }

  const nodeToWalls = new Map<string, Set<string>>();
  walls.forEach((wall) => {
    const nodeA = toNodeKey(wall.startPoint, snapTolerance);
    const nodeB = toNodeKey(wall.endPoint, snapTolerance);
    const bucketA = nodeToWalls.get(nodeA) ?? new Set<string>();
    bucketA.add(wall.id);
    nodeToWalls.set(nodeA, bucketA);
    const bucketB = nodeToWalls.get(nodeB) ?? new Set<string>();
    bucketB.add(wall.id);
    nodeToWalls.set(nodeB, bucketB);
  });

  const queue = [...new Set(changedWallIds)];
  const visited = new Set<string>(queue);

  while (queue.length > 0) {
    const wallId = queue.shift();
    if (!wallId) continue;
    const wall = walls.find((entry) => entry.id === wallId);
    if (!wall) continue;

    const nodeA = toNodeKey(wall.startPoint, snapTolerance);
    const nodeB = toNodeKey(wall.endPoint, snapTolerance);
    const linked = new Set<string>([
      ...(nodeToWalls.get(nodeA) ?? []),
      ...(nodeToWalls.get(nodeB) ?? []),
    ]);
    linked.forEach((candidate) => {
      if (visited.has(candidate)) return;
      visited.add(candidate);
      queue.push(candidate);
    });
  }

  return visited;
}

function assignHierarchy(
  candidates: CycleCandidate[],
  existingRooms: DetectedRoom[],
  config: RoomDetectionConfig
): {
  rooms: DetectedRoom[];
  roomWallIdsById: Map<string, string[]>;
  roomHolesById: Map<string, Point[][]>;
} {
  const existingBySignature = new Map<string, ExistingRoomMeta>();
  existingRooms.forEach((room) => {
    existingBySignature.set(canonicalLoopSignature(room.polygon, 1), {
      room,
      signature: canonicalLoopSignature(room.polygon, 1),
    });
  });

  const indexed = candidates
    .map((candidate, index) => ({ ...candidate, index }))
    .sort((a, b) => b.area - a.area);

  const parentByIndex = new Map<number, number | null>();
  indexed.forEach((candidate) => {
    const centroid = polygonCentroidInside(candidate.polygon, candidate.holes.flat());
    let parentIndex: number | null = null;
    for (const maybeParent of indexed) {
      if (maybeParent.index === candidate.index) continue;
      if (maybeParent.area <= candidate.area) continue;
      if (polygonContainsPolygon(maybeParent.polygon, candidate.polygon)) {
        if (parentIndex === null) {
          parentIndex = maybeParent.index;
          continue;
        }
        const currentParent = indexed.find((entry) => entry.index === parentIndex);
        if (currentParent && maybeParent.area < currentParent.area) {
          parentIndex = maybeParent.index;
        }
      }
    }
    if (parentIndex === null) {
      const existingParent = existingRooms
        .filter((room) => polygonContainsPolygon(room.polygon, candidate.polygon))
        .sort((a, b) => a.area - b.area)[0];
      if (existingParent && !pointInsidePolygon(centroid, candidate.polygon)) {
        parentIndex = null;
      }
    }
    parentByIndex.set(candidate.index, parentIndex);
  });

  const topLevelCounter = parseMaxSequence(existingRooms, config.autoNamePrefix);
  const subLevelCounter = parseMaxSequence(existingRooms, config.subRoomPrefix);
  let nextTop = topLevelCounter;
  let nextSub = subLevelCounter;

  const byIndex = new Map<number, DetectedRoom>();
  const ordered = [...indexed].sort((a, b) => a.area - b.area);
  const roomWallIdsById = new Map<string, string[]>();
  const roomHolesById = new Map<string, Point[][]>();

  ordered.forEach((candidate, colorIndex) => {
    const parentIndex = parentByIndex.get(candidate.index) ?? null;
    const parentRoom = parentIndex === null ? null : byIndex.get(parentIndex) ?? null;
    const depth = parentRoom ? parentRoom.depth + 1 : 0;
    const signature = canonicalLoopSignature(candidate.polygon, 1);
    const existing = existingBySignature.get(signature)?.room;
    const roomId = existing?.id ?? generateId();
    const roomName = existing?.name ?? (
      depth > 0
        ? `${config.subRoomPrefix} ${++nextSub}`
        : `${config.autoNamePrefix} ${++nextTop}`
    );
    const baseColor = parentRoom
      ? darkenHex(parentRoom.color, 15 + Math.max(0, depth - 1) * 10)
      : config.colorPalette[colorIndex % config.colorPalette.length] ?? '#3B82F6';
    const centroid = polygonCentroidInside(candidate.polygon, candidate.holes.flat());
    const labelTag = computeLabelTag(roomId, roomName, candidate.area, centroid, existing);

    const room: DetectedRoom = {
      id: roomId,
      name: roomName,
      polygon: candidate.polygon.map((point) => ({ ...point })),
      area: candidate.area,
      centroid,
      parentRoomId: parentRoom?.id ?? existing?.parentRoomId,
      childRoomIds: [],
      depth,
      color: existing?.color ?? baseColor,
      labelTag,
      isActive: existing?.isActive ?? false,
      createdAt: existing?.createdAt ?? Date.now(),
    };

    byIndex.set(candidate.index, room);
    roomWallIdsById.set(room.id, [...candidate.wallIds]);
    roomHolesById.set(
      room.id,
      candidate.holes.map((hole) => hole.map((point) => ({ ...point })))
    );
  });

  byIndex.forEach((room) => {
    room.childRoomIds = [];
  });
  byIndex.forEach((room) => {
    if (!room.parentRoomId) return;
    const parent = [...byIndex.values()].find((candidate) => candidate.id === room.parentRoomId);
    if (!parent) return;
    parent.childRoomIds.push(room.id);
  });

  return {
    rooms: [...byIndex.values()].sort((a, b) => a.depth - b.depth || b.area - a.area),
    roomWallIdsById,
    roomHolesById,
  };
}

function roomCandidateFromPolygon(
  polygon: Point[],
  holes: Point[][],
  area: number,
  wallIds: string[]
): CycleCandidate {
  return {
    polygon: polygon.map((point) => ({ ...point })),
    holes: holes.map((hole) => hole.map((point) => ({ ...point }))),
    area,
    signature: canonicalLoopSignature(polygon, 1),
    wallIds: [...new Set(wallIds)],
  };
}

function splitRoomWithDivider(
  room: Pick<DetectedRoom, 'polygon'>,
  divider: WallSegment,
  config: RoomDetectionConfig
): CycleCandidate[] {
  const parentFeature = toPolygonFeature(room.polygon);
  if (!parentFeature) return [];
  if (!wallIsDividerForRoom(divider, room, DIVIDER_TOLERANCE)) return [];

  const dividerFeature = toLineFeature(divider);
  const boundary = polygonToLine(parentFeature);
  const boundaryLines = boundary.type === 'FeatureCollection'
    ? boundary.features
    : [boundary];

  const splitBoundarySegments: any[] = [];
  boundaryLines.forEach((line) => {
    try {
      const split = lineSplit(line as any, dividerFeature);
      splitBoundarySegments.push(...split.features);
    } catch {
      splitBoundarySegments.push(line as any);
    }
  });

  let dividerSegments: any[] = [dividerFeature];
  boundaryLines.forEach((line) => {
    const nextSegments: any[] = [];
    dividerSegments.forEach((segment) => {
      try {
        const split = lineSplit(segment, line as any);
        if (split.features.length > 0) {
          nextSegments.push(...(split.features as any[]));
        } else {
          nextSegments.push(segment);
        }
      } catch {
        nextSegments.push(segment);
      }
    });
    dividerSegments = nextSegments;
  });

  let polygonized: any;
  try {
    polygonized = polygonize(
      turfFeatureCollection([
        ...splitBoundarySegments,
        ...dividerSegments,
      ] as any) as any
    ) as any;
  } catch {
    return [];
  }

  const childCandidates: CycleCandidate[] = [];
  polygonized.features.forEach((feature: any) => {
    const rings = geometryToRings(feature.geometry);
    rings.forEach(({ outer, holes }) => {
      if (outer.length < 3) return;
      const area = polygonArea(outer) - holes.reduce((sum, hole) => sum + polygonArea(hole), 0);
      if (area < config.minRoomArea) return;
      const center = polygonCentroidInside(outer);
      if (!pointInsidePolygon(center, room.polygon)) return;
      childCandidates.push(roomCandidateFromPolygon(outer, holes, area, []));
    });
  });

  const unique = new Map<string, CycleCandidate>();
  childCandidates.forEach((candidate) => {
    if (!unique.has(candidate.signature)) {
      unique.set(candidate.signature, candidate);
    }
  });
  return [...unique.values()];
}

function normalizedWallToSegment(wall: NormalizedWallSegment): WallSegment {
  return {
    id: wall.originalWallIds[0] ?? wall.id,
    startPoint: { ...wall.startPoint },
    endPoint: { ...wall.endPoint },
    thickness: wall.thickness,
    snapToGrid: wall.snapToGrid,
    parentRoomId: wall.parentRoomId,
    startBevel: {
      outerOffset: 0,
      innerOffset: 0,
    },
    endBevel: {
      outerOffset: 0,
      innerOffset: 0,
    },
  };
}

function splitCandidatesByDividerWalls(
  candidates: CycleCandidate[],
  walls: NormalizedWallSegment[],
  config: RoomDetectionConfig
): CycleCandidate[] {
  const queue = candidates.map((candidate) => ({
    polygon: candidate.polygon.map((point) => ({ ...point })),
    holes: candidate.holes.map((hole) => hole.map((point) => ({ ...point }))),
    area: candidate.area,
    signature: candidate.signature,
    wallIds: [...candidate.wallIds],
  }));
  const result: CycleCandidate[] = [];

  while (queue.length > 0) {
    const candidate = queue.shift();
    if (!candidate) continue;

    let splitApplied = false;

    for (const wall of walls) {
      const divider = normalizedWallToSegment(wall);
      if (!wallIsDividerForRoom(divider, candidate, DIVIDER_TOLERANCE)) {
        continue;
      }

      const children = dedupeCandidates(
        splitRoomWithDivider(candidate, divider, config).filter(
          (child) => child.signature !== candidate.signature
        )
      );
      if (children.length < 2) {
        continue;
      }

      queue.unshift(...children);
      splitApplied = true;
      break;
    }

    if (!splitApplied) {
      result.push(candidate);
    }
  }

  return dedupeCandidates(attachWallIdsToCandidates(result, walls));
}

function candidateListForWalls(
  walls: NormalizedWallSegment[],
  config: RoomDetectionConfig
): CycleCandidate[] {
  const graph = buildGraph(walls, config.snapTolerance);
  const dfsBased = dfsCycles(graph.adjacency, graph.nodeByKey, graph.wallById, config);
  const polygonized = polygonizeCandidates(walls, config);
  const source = polygonized.length > 0 ? polygonized : dfsBased;
  return splitCandidatesByDividerWalls(source, walls, config)
    .filter((candidate) => candidate.area >= config.minRoomArea)
    .filter((candidate) => candidate.polygon.length >= 3);
}

function dedupeCandidates(candidates: CycleCandidate[]): CycleCandidate[] {
  const bySignature = new Map<string, CycleCandidate>();
  candidates.forEach((candidate) => {
    if (!candidate.signature) return;
    if (!bySignature.has(candidate.signature)) {
      bySignature.set(candidate.signature, candidate);
      return;
    }
    const existing = bySignature.get(candidate.signature);
    if (!existing) return;
    if (candidate.area > existing.area) {
      bySignature.set(candidate.signature, candidate);
    }
  });
  return [...bySignature.values()];
}

function affectedWallsBounds(walls: WallSegment[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const points = walls.flatMap((wall) => [wall.startPoint, wall.endPoint]);
  return polygonBounds(points);
}

export function detectRoomsFromWalls(options: RoomDetectionRunOptions): RoomDetectionRunResult {
  const config: RoomDetectionConfig = {
    ...DEFAULT_ROOM_DETECTION_CONFIG,
    ...(options.config ?? {}),
  };
  const existingRooms = options.existingRooms ?? [];
  const changedWallIds = options.changedWallIds ?? [];
  const walls = options.walls
    .filter((wall) => segmentLength(wall) > config.snapTolerance / 3)
    .map((wall) => ({
      ...wall,
      startPoint: { ...wall.startPoint },
      endPoint: { ...wall.endPoint },
    }));

  if (walls.length < 3) {
    return {
      rooms: [],
      roomWallIdsById: new Map<string, string[]>(),
      roomHolesById: new Map<string, Point[][]>(),
      affectedWallIds: new Set<string>(changedWallIds),
      archivedParentRooms: new Map<string, DetectedRoom>(),
    };
  }

  const affectedWallIds = collectAffectedSubgraphWallIds(walls, changedWallIds, config.snapTolerance);
  const affectedWalls = walls.filter((wall) => affectedWallIds.has(wall.id));
  const wallsForDetection = affectedWalls.length > 0 ? affectedWalls : walls;
  const normalized = preprocessWalls(wallsForDetection, config);

  let candidates = candidateListForWalls(normalized, config);
  const archivedParentRooms = new Map<string, DetectedRoom>();

  if (changedWallIds.length > 0 && existingRooms.length > 0) {
    const changedWalls = walls.filter((wall) => changedWallIds.includes(wall.id));
    changedWalls.forEach((changedWall) => {
      existingRooms.forEach((existingRoom) => {
        if (!wallIsDividerForRoom(changedWall, existingRoom, DIVIDER_TOLERANCE)) return;
        const children = splitRoomWithDivider(existingRoom, changedWall, config);
        if (children.length < 2) return;
        archivedParentRooms.set(existingRoom.id, { ...existingRoom });
        candidates = candidates.filter(
          (candidate) => !pointInsidePolygon(
            polygonCentroidInside(candidate.polygon),
            existingRoom.polygon
          )
        );
        children.forEach((child) => {
          candidates.push({
            ...child,
            wallIds: [...new Set([...child.wallIds, changedWall.id])],
          });
        });
      });
    });
  }

  candidates = dedupeCandidates(attachWallIdsToCandidates(candidates, normalized));
  const hierarchy = assignHierarchy(candidates, existingRooms, config);
  let nextRooms = hierarchy.rooms;

  if (changedWallIds.length > 0 && existingRooms.length > 0 && affectedWalls.length > 0) {
    const affectedBounds = expandBounds(affectedWallsBounds(affectedWalls), config.snapTolerance * 2);
    const unaffectedExisting = existingRooms.filter((room) => {
      const roomBounds = polygonBounds(room.polygon);
      return !boundsIntersect(roomBounds, affectedBounds);
    });
    const mergedById = new Map<string, DetectedRoom>();
    unaffectedExisting.forEach((room) => mergedById.set(room.id, room));
    nextRooms.forEach((room) => mergedById.set(room.id, room));
    nextRooms = [...mergedById.values()];
  }

  const roomById = new Map(nextRooms.map((room) => [room.id, room]));
  nextRooms.forEach((room) => {
    room.childRoomIds = [];
  });
  nextRooms.forEach((room) => {
    if (!room.parentRoomId) return;
    const parent = roomById.get(room.parentRoomId);
    if (!parent) return;
    parent.childRoomIds.push(room.id);
  });

  archivedParentRooms.forEach((archived) => {
    archived.childRoomIds = nextRooms
      .filter((room) => room.parentRoomId === archived.id)
      .map((room) => room.id);
  });

  return {
    rooms: nextRooms,
    roomWallIdsById: hierarchy.roomWallIdsById,
    roomHolesById: hierarchy.roomHolesById,
    affectedWallIds,
    archivedParentRooms,
  };
}

export function isPointInsideRoom(point: Point, room: Pick<DetectedRoom, 'polygon'>): boolean {
  return pointInsidePolygon(point, room.polygon);
}
