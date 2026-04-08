import type { Point2D, Room, Wall } from '../../../types';
import { MIN_WALL_LENGTH } from '../../../types/wall';
import { GeometryEngine } from '../../../utils/geometry-engine';

import { projectPointToSegment, refreshOffsetLines } from './WallGeometry';

const ROOM_BOUNDARY_SELECTION_TOLERANCE_MM = 2;

export interface RoomBoundarySelectionSegment {
  key: string;
  roomId: string;
  hostWallId: string;
  faceStartPoint: Point2D;
  faceEndPoint: Point2D;
  startPoint: Point2D;
  endPoint: Point2D;
  startDistance: number;
  endDistance: number;
  startCornerIndex: number | null;
  endCornerIndex: number | null;
  virtualWall: Wall;
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function pointsNear(a: Point2D, b: Point2D, tolerance: number = ROOM_BOUNDARY_SELECTION_TOLERANCE_MM): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
}

function wallLengthMm(start: Point2D, end: Point2D): number {
  return Math.hypot(end.x - start.x, end.y - start.y);
}

function crossPoints(a: Point2D, b: Point2D): number {
  return a.x * b.y - a.y * b.x;
}

function subtractPoints(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function segmentMidpoint(start: Point2D, end: Point2D): Point2D {
  return {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  };
}

function projectPointParameter(point: Point2D, start: Point2D, end: Point2D): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 0.000001) {
    return 0;
  }

  return clampValue(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq,
    0,
    1
  );
}

function pointLiesOnSegment(
  point: Point2D,
  start: Point2D,
  end: Point2D,
  tolerance: number = ROOM_BOUNDARY_SELECTION_TOLERANCE_MM
): boolean {
  return projectPointToSegment(point, start, end).distance <= tolerance;
}

function addUniqueSplitPoint(
  points: Point2D[],
  point: Point2D,
  tolerance: number = ROOM_BOUNDARY_SELECTION_TOLERANCE_MM
): void {
  if (!points.some((existing) => pointsNear(existing, point, tolerance))) {
    points.push({ ...point });
  }
}

function wallsAreParallelToSegment(wall: Wall, start: Point2D, end: Point2D): boolean {
  const wallVector = subtractPoints(wall.endPoint, wall.startPoint);
  const edgeVector = subtractPoints(end, start);
  const wallLength = Math.hypot(wallVector.x, wallVector.y);
  const edgeLength = Math.hypot(edgeVector.x, edgeVector.y);
  if (wallLength < 0.000001 || edgeLength < 0.000001) {
    return false;
  }

  const crossNormalized = Math.abs(crossPoints(wallVector, edgeVector)) / (wallLength * edgeLength);
  return crossNormalized <= 0.02;
}

function collectRoomBoundarySplitPoints(
  start: Point2D,
  end: Point2D,
  walls: Wall[]
): Point2D[] {
  const splitPoints: Point2D[] = [{ ...start }, { ...end }];
  const edgeLength = wallLengthMm(start, end);

  for (const wall of walls) {
    [wall.startPoint, wall.endPoint].forEach((endpoint) => {
      if (!pointLiesOnSegment(endpoint, start, end, ROOM_BOUNDARY_SELECTION_TOLERANCE_MM)) {
        return;
      }
      if (
        pointsNear(endpoint, start, ROOM_BOUNDARY_SELECTION_TOLERANCE_MM) ||
        pointsNear(endpoint, end, ROOM_BOUNDARY_SELECTION_TOLERANCE_MM)
      ) {
        return;
      }
      addUniqueSplitPoint(splitPoints, endpoint);
    });

    GeometryEngine.findIntersections(
      { startPoint: start, endPoint: end },
      wall
    ).forEach((intersection) => {
      if (!pointLiesOnSegment(intersection, start, end, ROOM_BOUNDARY_SELECTION_TOLERANCE_MM)) {
        return;
      }
      if (
        pointsNear(intersection, start, ROOM_BOUNDARY_SELECTION_TOLERANCE_MM) ||
        pointsNear(intersection, end, ROOM_BOUNDARY_SELECTION_TOLERANCE_MM)
      ) {
        return;
      }
      addUniqueSplitPoint(splitPoints, intersection);
    });
  }

  const ordered = splitPoints
    .map((point) => ({
      point,
      distance: clampValue(projectPointParameter(point, start, end) * edgeLength, 0, edgeLength),
    }))
    .sort((left, right) => left.distance - right.distance);

  return ordered.map((entry) => entry.point);
}

function findWallForRoomBoundarySubEdge(
  start: Point2D,
  end: Point2D,
  walls: Wall[],
  preferredWallIds: Set<string>
): Wall | null {
  const midpoint = segmentMidpoint(start, end);
  const pointLiesWithinWallBand = (point: Point2D, wall: Wall) => {
    const projection = projectPointToSegment(point, wall.startPoint, wall.endPoint);
    return projection.distance <= wall.thickness / 2 + ROOM_BOUNDARY_SELECTION_TOLERANCE_MM;
  };
  const matches = (wall: Wall) =>
    wallsAreParallelToSegment(wall, start, end) &&
    pointLiesWithinWallBand(midpoint, wall);

  for (const wall of walls) {
    if (preferredWallIds.has(wall.id) && matches(wall)) {
      return wall;
    }
  }

  return walls.find((wall) => matches(wall)) ?? null;
}

function projectDistanceAlongWall(point: Point2D, wall: Wall): number {
  const projection = projectPointToSegment(point, wall.startPoint, wall.endPoint);
  return wallLengthMm(wall.startPoint, wall.endPoint) * projection.t;
}

function buildRoomBoundaryVirtualWall(
  roomId: string,
  hostWall: Wall,
  faceStartPoint: Point2D,
  faceEndPoint: Point2D,
  startCornerIndex: number | null,
  endCornerIndex: number | null,
  startPoint: Point2D,
  endPoint: Point2D
): RoomBoundarySelectionSegment | null {
  const projectedStart = projectPointToSegment(startPoint, hostWall.startPoint, hostWall.endPoint);
  const projectedEnd = projectPointToSegment(endPoint, hostWall.startPoint, hostWall.endPoint);
  const maxProjectionDistance = hostWall.thickness / 2 + ROOM_BOUNDARY_SELECTION_TOLERANCE_MM;
  if (
    projectedStart.distance > maxProjectionDistance ||
    projectedEnd.distance > maxProjectionDistance
  ) {
    return null;
  }

  const wallLength = wallLengthMm(hostWall.startPoint, hostWall.endPoint);
  const startDistance = clampValue(projectDistanceAlongWall(projectedStart.closest, hostWall), 0, wallLength);
  const endDistance = clampValue(projectDistanceAlongWall(projectedEnd.closest, hostWall), 0, wallLength);
  const intervalStart = Math.min(startDistance, endDistance);
  const intervalEnd = Math.max(startDistance, endDistance);
  if (intervalEnd - intervalStart < MIN_WALL_LENGTH) {
    return null;
  }

  const key = [
    hostWall.id,
    intervalStart.toFixed(3),
    intervalEnd.toFixed(3),
  ].join(':');

  const virtualWall: Wall = {
    ...hostWall,
    id: key,
    startPoint: { ...projectedStart.closest },
    endPoint: { ...projectedEnd.closest },
    connectedWalls: [],
    openings: [],
  };
  refreshOffsetLines(virtualWall);

  return {
    key,
    roomId,
    hostWallId: hostWall.id,
    faceStartPoint: { ...faceStartPoint },
    faceEndPoint: { ...faceEndPoint },
    startPoint: { ...projectedStart.closest },
    endPoint: { ...projectedEnd.closest },
    startDistance: intervalStart,
    endDistance: intervalEnd,
    startCornerIndex,
    endCornerIndex,
    virtualWall,
  };
}

export function resolveRoomBoundarySelectionSegments(
  roomIds: string[],
  rooms: Room[],
  walls: Wall[]
): RoomBoundarySelectionSegment[] {
  const roomsById = new Map(rooms.map((room) => [room.id, room]));
  const segments = new Map<string, RoomBoundarySelectionSegment>();

  roomIds.forEach((roomId) => {
    const room = roomsById.get(roomId);
    if (!room || room.vertices.length < 2) {
      return;
    }

    for (let index = 0; index < room.vertices.length; index += 1) {
      const edgeStart = room.vertices[index];
      const edgeEnd = room.vertices[(index + 1) % room.vertices.length];
      if (!edgeStart || !edgeEnd) {
        continue;
      }

      const subEdgePoints = collectRoomBoundarySplitPoints(edgeStart, edgeEnd, walls);
      for (let subIndex = 0; subIndex < subEdgePoints.length - 1; subIndex += 1) {
        const subStart = subEdgePoints[subIndex];
        const subEnd = subEdgePoints[subIndex + 1];
        if (wallLengthMm(subStart, subEnd) < MIN_WALL_LENGTH) {
          continue;
        }

        const boundaryWall = findWallForRoomBoundarySubEdge(
          subStart,
          subEnd,
          walls,
          new Set(room.wallIds)
        );
        if (!boundaryWall) {
          continue;
        }

        const nextVertexIndex = (index + 1) % room.vertices.length;
        const startCornerIndex = pointsNear(subStart, edgeStart, ROOM_BOUNDARY_SELECTION_TOLERANCE_MM)
          ? index
          : null;
        const endCornerIndex = pointsNear(subEnd, edgeEnd, ROOM_BOUNDARY_SELECTION_TOLERANCE_MM)
          ? nextVertexIndex
          : null;
        const selectionSegment = buildRoomBoundaryVirtualWall(
          room.id,
          boundaryWall,
          subStart,
          subEnd,
          startCornerIndex,
          endCornerIndex,
          subStart,
          subEnd
        );
        if (!selectionSegment) {
          continue;
        }

        if (!segments.has(selectionSegment.key)) {
          segments.set(selectionSegment.key, selectionSegment);
        }
      }
    }
  });

  return Array.from(segments.values());
}
