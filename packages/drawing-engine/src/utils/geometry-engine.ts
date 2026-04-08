/**
 * GeometryEngine
 *
 * Centralized geometric operations for architectural editing.
 * Turf.js is used for topology/boolean/intersection operations.
 * Metric calculations remain in project units (millimeters) to keep
 * CAD behavior deterministic and geodesic-free.
 */

import {
  booleanPointInPolygon,
  centroid as turfCentroid,
  featureCollection as turfFeatureCollection,
  kinks as turfKinks,
  lineIntersect,
  lineOverlap,
  lineString as turfLineString,
  nearestPoint,
  nearestPointOnLine,
  point as turfPoint,
  pointOnFeature as turfPointOnFeature,
  polygon as turfPolygon,
} from '@turf/turf';

import type { Point2D, Room, Wall } from '../types';

import {
  calculateCentroid,
  calculatePolygonArea,
  distancePointToSegment,
  isPointInPolygon,
  polylineLength,
  segmentsIntersect,
} from './geometry';

type WallLike = Pick<Wall, 'startPoint' | 'endPoint'>;
type RoomLike = Pick<Room, 'vertices'> & { holes?: Point2D[][] };

const EPSILON = 0.000001;
const ROOM_MIN_AREA_M2 = 2;
type Coordinate2D = [number, number];

function dedupePoints(points: Point2D[], tolerance = 0.001): Point2D[] {
  const deduped: Point2D[] = [];
  points.forEach((point) => {
    const existing = deduped.find(
      (item) =>
        Math.abs(item.x - point.x) <= tolerance &&
        Math.abs(item.y - point.y) <= tolerance
    );
    if (!existing) {
      deduped.push(point);
    }
  });
  return deduped;
}

function normalizeLoop(vertices: Point2D[]): Point2D[] {
  const cleaned: Point2D[] = [];
  vertices.forEach((vertex) => {
    const previous = cleaned[cleaned.length - 1];
    if (
      !previous ||
      Math.abs(previous.x - vertex.x) > EPSILON ||
      Math.abs(previous.y - vertex.y) > EPSILON
    ) {
      cleaned.push({ x: vertex.x, y: vertex.y });
    }
  });

  if (cleaned.length > 1) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (Math.abs(first.x - last.x) <= EPSILON && Math.abs(first.y - last.y) <= EPSILON) {
      cleaned.pop();
    }
  }

  return cleaned;
}

function closeRing(vertices: Point2D[]): Coordinate2D[] {
  const normalized = normalizeLoop(vertices);
  if (normalized.length === 0) return [];
  const ring: Coordinate2D[] = normalized.map((point) => [point.x, point.y]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!last || first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}

function normalizeRoomGeometry(room: RoomLike): { outer: Point2D[]; holes: Point2D[][] } {
  return {
    outer: normalizeLoop(room.vertices),
    holes: (room.holes ?? [])
      .map((hole) => normalizeLoop(hole))
      .filter((hole) => hole.length >= 3),
  };
}

function signedArea(vertices: Point2D[]): number {
  if (vertices.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < vertices.length; i += 1) {
    const next = (i + 1) % vertices.length;
    area += vertices[i].x * vertices[next].y - vertices[next].x * vertices[i].y;
  }
  return area / 2;
}

export interface RoomValidationResult {
  valid: boolean;
  errors: string[];
}

export class GeometryEngine {
  static distance(p1: Point2D, p2: Point2D): number {
    return Math.hypot(p2.x - p1.x, p2.y - p1.y);
  }

  static nearestPoint(target: Point2D, candidates: Point2D[]): Point2D {
    if (candidates.length === 0) return { ...target };
    try {
      const targetPt = turfPoint([target.x, target.y]);
      const points = turfFeatureCollection(
        candidates.map((candidate) => turfPoint([candidate.x, candidate.y]))
      );
      const nearest = nearestPoint(targetPt, points);
      return {
        x: nearest.geometry.coordinates[0],
        y: nearest.geometry.coordinates[1],
      };
    } catch {
      let best = candidates[0];
      let bestDistance = this.distance(target, best);
      for (let i = 1; i < candidates.length; i += 1) {
        const candidateDistance = this.distance(target, candidates[i]);
        if (candidateDistance < bestDistance) {
          bestDistance = candidateDistance;
          best = candidates[i];
        }
      }
      return { ...best };
    }
  }

  static wallToLineString(wall: WallLike): ReturnType<typeof turfLineString> {
    return turfLineString([
      [wall.startPoint.x, wall.startPoint.y],
      [wall.endPoint.x, wall.endPoint.y],
    ]);
  }

  static findIntersections(wall1: WallLike, wall2: WallLike): Point2D[] {
    const line1 = this.wallToLineString(wall1);
    const line2 = this.wallToLineString(wall2);
    const intersections = lineIntersect(line1, line2);
    return dedupePoints(
      intersections.features.map((feature) => ({
        x: feature.geometry.coordinates[0],
        y: feature.geometry.coordinates[1],
      }))
    );
  }

  static snapToWall(point: Point2D, wall: WallLike): Point2D {
    const line = this.wallToLineString(wall);
    const target = turfPoint([point.x, point.y]);
    try {
      const snapped = nearestPointOnLine(line, target);
      return {
        x: snapped.geometry.coordinates[0],
        y: snapped.geometry.coordinates[1],
      };
    } catch {
      const projected = distancePointToSegment(point, wall.startPoint, wall.endPoint);
      return projected.projection;
    }
  }

  static wallLength(wall: WallLike): number {
    return this.distance(wall.startPoint, wall.endPoint);
  }

  static wallsOverlap(wall1: WallLike, wall2: WallLike): boolean {
    const line1 = this.wallToLineString(wall1);
    const line2 = this.wallToLineString(wall2);
    try {
      const overlap = lineOverlap(line1, line2, { tolerance: 0.00001 });
      return overlap.features.length > 0;
    } catch {
      return segmentsIntersect(
        wall1.startPoint,
        wall1.endPoint,
        wall2.startPoint,
        wall2.endPoint
      );
    }
  }

  static roomToPolygon(room: RoomLike): ReturnType<typeof turfPolygon> {
    const { outer, holes } = normalizeRoomGeometry(room);
    const ring = closeRing(outer);
    if (ring.length < 4) {
      return turfPolygon([[
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ]]);
    }
    const holeRings = holes
      .map((hole) => closeRing(hole))
      .filter((holeRing) => holeRing.length >= 4);
    return turfPolygon([ring, ...holeRings]);
  }

  static calculateSignedArea(vertices: Point2D[]): number {
    return signedArea(normalizeLoop(vertices));
  }

  static calculateRoomAreaMm2(room: RoomLike): number {
    const { outer, holes } = normalizeRoomGeometry(room);
    const holeArea = holes.reduce((sum, hole) => sum + calculatePolygonArea(hole), 0);
    return Math.max(0, calculatePolygonArea(outer) - holeArea);
  }

  static calculateRoomAreaM2(room: RoomLike): number {
    return this.calculateRoomAreaMm2(room) / 1_000_000;
  }

  static calculateRoomPerimeterMm(room: RoomLike): number {
    const { outer, holes } = normalizeRoomGeometry(room);
    const rings = [outer, ...holes];
    return rings.reduce((sum, ring) => {
      if (ring.length < 2) return sum;
      return sum + polylineLength([...ring, ring[0]]);
    }, 0);
  }

  static findRoomCentroid(room: RoomLike): Point2D {
    const { outer, holes } = normalizeRoomGeometry(room);
    if (outer.length === 0) return { x: 0, y: 0 };
    try {
      const polygon = this.roomToPolygon({ vertices: outer, holes });
      const roomCentroid = turfCentroid(polygon);
      const centroidPoint = {
        x: roomCentroid.geometry.coordinates[0],
        y: roomCentroid.geometry.coordinates[1],
      };
      if (booleanPointInPolygon(turfPoint([centroidPoint.x, centroidPoint.y]), polygon, { ignoreBoundary: false })) {
        return centroidPoint;
      }
      const fallbackPoint = turfPointOnFeature(polygon);
      return {
        x: fallbackPoint.geometry.coordinates[0],
        y: fallbackPoint.geometry.coordinates[1],
      };
    } catch {
      return calculateCentroid(outer);
    }
  }

  static pointInRoom(point: Point2D, room: RoomLike): boolean {
    const { outer, holes } = normalizeRoomGeometry(room);
    if (outer.length < 3) return false;
    try {
      return booleanPointInPolygon(
        turfPoint([point.x, point.y]),
        this.roomToPolygon({ vertices: outer, holes })
      );
    } catch {
      return isPointInPolygon(point, outer) && holes.every((hole) => !isPointInPolygon(point, hole));
    }
  }

  static polygonSelfIntersects(vertices: Point2D[]): boolean {
    const loop = normalizeLoop(vertices);
    if (loop.length < 4) return false;
    try {
      const polygonKinks = turfKinks(this.roomToPolygon({ vertices: loop }));
      return polygonKinks.features.length > 0;
    } catch {
      for (let i = 0; i < loop.length; i += 1) {
        const a1 = loop[i];
        const a2 = loop[(i + 1) % loop.length];
        for (let j = i + 1; j < loop.length; j += 1) {
          const b1 = loop[j];
          const b2 = loop[(j + 1) % loop.length];
          const adjacent =
            i === j ||
            (i + 1) % loop.length === j ||
            i === (j + 1) % loop.length;
          if (adjacent) continue;
          if (segmentsIntersect(a1, a2, b1, b2)) {
            return true;
          }
        }
      }
      return false;
    }
  }

  static validateRoomShape(vertices: Point2D[]): RoomValidationResult {
    const loop = normalizeLoop(vertices);
    const errors: string[] = [];

    if (loop.length < 3) {
      errors.push('Room must have at least 3 corners.');
    }
    if (this.polygonSelfIntersects(loop)) {
      errors.push('Room shape cannot self-intersect.');
    }
    const areaM2 = this.calculateRoomAreaM2({ vertices: loop });
    if (areaM2 > 0 && areaM2 < ROOM_MIN_AREA_M2) {
      errors.push(`Room area must be at least ${ROOM_MIN_AREA_M2} m².`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  static pointInPolygon(point: Point2D, vertices: Point2D[]): boolean {
    return this.pointInRoom(point, { vertices });
  }
}

