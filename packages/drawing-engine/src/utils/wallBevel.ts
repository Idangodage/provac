import type { BevelControl, Point2D, Wall } from '../types';
import { DEFAULT_BEVEL_CONTROL } from '../types/wall';

const MM_TO_PX = 96 / 25.4;
const COLLINEAR_CROSS_TOLERANCE = 0.02;
const EPSILON = 0.000001;

export type CornerEnd = 'start' | 'end';
export type CornerBevelKind = 'outer' | 'inner';

export interface CornerBevelDots {
  cornerPoint: Point2D;
  wallId: string;
  end: CornerEnd;
  otherWallId: string;
  otherEnd: CornerEnd;
  outerMiterPoint: Point2D;
  innerMiterPoint: Point2D;
  bisector: Point2D;
  outerDotPosition: Point2D;
  innerDotPosition: Point2D;
  outerOffset: number;
  innerOffset: number;
  maxOffset: number;
}

export interface EndpointBevelDots {
  cornerPoint: Point2D;
  wallId: string;
  end: CornerEnd;
  outerMiterPoint: Point2D;
  innerMiterPoint: Point2D;
  bisector: Point2D;
  outerDotPosition: Point2D;
  innerDotPosition: Point2D;
  outerOffset: number;
  innerOffset: number;
  maxOffset: number;
}

export interface LineProjectionResult {
  projected: Point2D;
  t: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function add(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(v: Point2D, factor: number): Point2D {
  return { x: v.x * factor, y: v.y * factor };
}

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function cross(a: Point2D, b: Point2D): number {
  return a.x * b.y - a.y * b.x;
}

function magnitude(v: Point2D): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

function normalize(v: Point2D): Point2D {
  const len = magnitude(v);
  if (len < EPSILON) {
    return { x: 0, y: 0 };
  }
  return { x: v.x / len, y: v.y / len };
}

function perpendicular(v: Point2D): Point2D {
  return { x: -v.y, y: v.x };
}

function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function lineIntersection(a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D): Point2D | null {
  const da = subtract(a2, a1);
  const db = subtract(b2, b1);
  const denom = cross(da, db);
  if (Math.abs(denom) < EPSILON) {
    return null;
  }
  const offset = subtract(b1, a1);
  const t = cross(offset, db) / denom;
  return add(a1, scale(da, t));
}

function getEndpointPoint(wall: Wall, end: CornerEnd): Point2D {
  return end === 'start' ? wall.startPoint : wall.endPoint;
}

function getDirectionAwayFromEndpoint(wall: Wall, end: CornerEnd): Point2D {
  return end === 'start'
    ? normalize(subtract(wall.endPoint, wall.startPoint))
    : normalize(subtract(wall.startPoint, wall.endPoint));
}

function getEndpointBevel(wall: Wall, end: CornerEnd): BevelControl {
  if (end === 'start') {
    return wall.startBevel ?? { ...DEFAULT_BEVEL_CONTROL };
  }
  return wall.endBevel ?? { ...DEFAULT_BEVEL_CONTROL };
}

function resolveWallEndpointAtCorner(
  wall: Wall,
  cornerPoint: Point2D,
  tolerance: number
): CornerEnd | null {
  const startDistance = distance(wall.startPoint, cornerPoint);
  const endDistance = distance(wall.endPoint, cornerPoint);
  const bestDistance = Math.min(startDistance, endDistance);
  if (bestDistance > tolerance) return null;
  return startDistance <= endDistance ? 'start' : 'end';
}

export function countWallsTouchingEndpoint(
  wall: Wall,
  end: CornerEnd,
  walls: Wall[],
  tolerance: number = 2
): number {
  const cornerPoint = getEndpointPoint(wall, end);
  let count = 0;
  for (const candidate of walls) {
    if (candidate.id === wall.id) continue;
    const candidateEnd = resolveWallEndpointAtCorner(candidate, cornerPoint, tolerance);
    if (candidateEnd) count += 1;
  }
  return count;
}

export function projectPointToLine(point: Point2D, lineOrigin: Point2D, lineDirection: Point2D): LineProjectionResult {
  const direction = normalize(lineDirection);
  if (magnitude(direction) < EPSILON) {
    return { projected: { ...lineOrigin }, t: 0 };
  }
  const t = dot(subtract(point, lineOrigin), direction);
  return {
    projected: add(lineOrigin, scale(direction, t)),
    t,
  };
}

export function clampBevelOffset(offset: number, maxOffset: number): number {
  if (!Number.isFinite(offset)) return 0;
  return clamp(offset, 0, maxOffset);
}

export function withUpdatedBevel(
  bevel: BevelControl | undefined,
  updates: Partial<BevelControl>,
  maxOffset: number
): BevelControl {
  const base = bevel ?? { ...DEFAULT_BEVEL_CONTROL };
  const outer = updates.outerOffset !== undefined
    ? clampBevelOffset(updates.outerOffset, maxOffset)
    : clampBevelOffset(base.outerOffset, maxOffset);
  const inner = updates.innerOffset !== undefined
    ? clampBevelOffset(updates.innerOffset, maxOffset)
    : clampBevelOffset(base.innerOffset, maxOffset);

  return {
    outerOffset: outer,
    innerOffset: inner,
  };
}

export function computeCornerBevelDotsForEndpoint(
  wall: Wall,
  end: CornerEnd,
  walls: Wall[],
  tolerance: number = 2
): CornerBevelDots | null {
  const cornerPoint = getEndpointPoint(wall, end);
  const connectedAtCorner = walls
    .filter((candidate) => candidate.id !== wall.id)
    .map((candidate) => ({
      wall: candidate,
      end: resolveWallEndpointAtCorner(candidate, cornerPoint, tolerance),
    }))
    .filter((entry): entry is { wall: Wall; end: CornerEnd } => Boolean(entry.end));

  if (connectedAtCorner.length !== 1) {
    return null;
  }

  const otherWall = connectedAtCorner[0].wall;
  const otherEnd = connectedAtCorner[0].end;
  const dirA = getDirectionAwayFromEndpoint(wall, end);
  const dirB = getDirectionAwayFromEndpoint(otherWall, otherEnd);

  if (magnitude(dirA) < EPSILON || magnitude(dirB) < EPSILON) {
    return null;
  }

  if (Math.abs(cross(dirA, dirB)) < COLLINEAR_CROSS_TOLERANCE) {
    return null;
  }

  const bisectorRaw = add(dirA, dirB);
  if (magnitude(bisectorRaw) < EPSILON) {
    return null;
  }
  const bisector = normalize(bisectorRaw);
  if (magnitude(bisector) < EPSILON) {
    return null;
  }

  const normalA = perpendicular(dirA);
  const normalB = perpendicular(dirB);
  const halfA = wall.thickness / 2;
  const halfB = otherWall.thickness / 2;

  const outerLineAStart = add(cornerPoint, scale(normalA, halfA));
  const outerLineAEnd = add(outerLineAStart, dirA);
  const outerLineBStart = add(cornerPoint, scale(normalB, halfB));
  const outerLineBEnd = add(outerLineBStart, dirB);

  const innerLineAStart = add(cornerPoint, scale(normalA, -halfA));
  const innerLineAEnd = add(innerLineAStart, dirA);
  const innerLineBStart = add(cornerPoint, scale(normalB, -halfB));
  const innerLineBEnd = add(innerLineBStart, dirB);

  const outerMiterPoint =
    lineIntersection(outerLineAStart, outerLineAEnd, outerLineBStart, outerLineBEnd) ?? outerLineAStart;
  const innerMiterPoint =
    lineIntersection(innerLineAStart, innerLineAEnd, innerLineBStart, innerLineBEnd) ?? innerLineAStart;

  const wallLength = distance(wall.startPoint, wall.endPoint);
  const otherLength = distance(otherWall.startPoint, otherWall.endPoint);
  let maxOffset = Math.min(wallLength / 2, otherLength / 2);
  if (wallLength * MM_TO_PX < 20 || otherLength * MM_TO_PX < 20) {
    maxOffset = Math.min(maxOffset, Math.min(wallLength, otherLength) / 3);
  }
  maxOffset = Math.max(0, maxOffset);

  const current = getEndpointBevel(wall, end);
  const otherCurrent = getEndpointBevel(otherWall, otherEnd);
  const outerOffset = clampBevelOffset(Math.max(current.outerOffset, otherCurrent.outerOffset), maxOffset);
  const innerOffset = clampBevelOffset(Math.max(current.innerOffset, otherCurrent.innerOffset), maxOffset);

  return {
    cornerPoint: { ...cornerPoint },
    wallId: wall.id,
    end,
    otherWallId: otherWall.id,
    otherEnd,
    outerMiterPoint,
    innerMiterPoint,
    bisector,
    outerDotPosition: add(outerMiterPoint, scale(bisector, outerOffset)),
    innerDotPosition: add(innerMiterPoint, scale(bisector, innerOffset)),
    outerOffset,
    innerOffset,
    maxOffset,
  };
}

export function computeDeadEndBevelDotsForEndpoint(
  wall: Wall,
  end: CornerEnd
): EndpointBevelDots {
  const cornerPoint = getEndpointPoint(wall, end);
  const direction = getDirectionAwayFromEndpoint(wall, end);
  const normal = perpendicular(direction);
  const halfThickness = wall.thickness / 2;

  const outerMiterPoint = add(cornerPoint, scale(normal, halfThickness));
  const innerMiterPoint = add(cornerPoint, scale(normal, -halfThickness));

  const length = distance(wall.startPoint, wall.endPoint);
  let maxOffset = Math.max(0, length / 2);
  if (length * MM_TO_PX < 20) {
    maxOffset = Math.min(maxOffset, length / 3);
  }

  const current = getEndpointBevel(wall, end);
  const outerOffset = clampBevelOffset(current.outerOffset, maxOffset);
  const innerOffset = clampBevelOffset(current.innerOffset, maxOffset);

  return {
    cornerPoint: { ...cornerPoint },
    wallId: wall.id,
    end,
    outerMiterPoint,
    innerMiterPoint,
    bisector: direction,
    outerDotPosition: add(outerMiterPoint, scale(direction, outerOffset)),
    innerDotPosition: add(innerMiterPoint, scale(direction, innerOffset)),
    outerOffset,
    innerOffset,
    maxOffset,
  };
}
