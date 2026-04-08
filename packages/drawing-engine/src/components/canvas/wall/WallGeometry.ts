/**
 * WallGeometry
 *
 * Pure geometry functions for wall calculations.
 * All coordinates are in millimeters.
 *
 * CRITICAL CHANGES FOR THE OFFSET LINE / DYNAMIC UPDATE BUGS:
 * ──────────────────────────────────────────────────────
 * [ROOT FIX] Added refreshOffsetLines(wall) — recomputes interiorLine and
 *   exteriorLine from the wall's CURRENT startPoint/endPoint/thickness.
 *   Previously, offset lines were computed once at creation and never updated,
 *   causing stale offset lines during drag → garbage join vertices → the
 *   massive diagonal stripe artifact visible in the screenshots.
 *
 * [ROOT FIX] computeWallPolygon now VALIDATES the output:
 *   - Checks for self-intersecting edges (acute miter joins)
 *   - Checks polygon area is reasonable (≤ 3× expected)
 *   - Falls back to the basic rectangle if validation fails
 *   This prevents the "wall fill extending to infinity" artifact.
 *
 * [BUG] computeMiterJoin now enforces aggressive distance clamping on
 *   both vertices. The clamping uses min(miterLimit × halfThickness,
 *   geometric reach, wallLength × 0.35).
 *
 * [BUG] angleBetweenWalls uses atan2 (was acos, unstable at 0°/180°)
 * [BUG] wallAngle returns [0, 360) (was [-180, 180])
 * [FEAT] segmentIntersection, projectPointOnLine, closestPointsBetweenSegments
 * ──────────────────────────────────────────────────────
 */

import type { Point2D, Wall, Line, JoinType, JoinData } from '../../../types';

// =============================================================================
// Vector Operations
// =============================================================================

export function normalize(v: Point2D): Point2D {
  const len = Math.sqrt(v.x * v.x + v.y * v.y);
  if (len < 0.0001) return { x: 0, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

export function perpendicular(v: Point2D): Point2D {
  return { x: -v.y, y: v.x };
}

export function direction(start: Point2D, end: Point2D): Point2D {
  return normalize({ x: end.x - start.x, y: end.y - start.y });
}

export function scale(v: Point2D, s: number): Point2D {
  return { x: v.x * s, y: v.y * s };
}

export function add(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

export function cross(a: Point2D, b: Point2D): number {
  return a.x * b.y - a.y * b.x;
}

export function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function distanceSq(a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dx * dx + dy * dy;
}

export function lerp(a: Point2D, b: Point2D, t: number): Point2D {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function midpoint(a: Point2D, b: Point2D): Point2D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function magnitude(v: Point2D): number {
  return Math.hypot(v.x, v.y);
}

// =============================================================================
// Line / Segment Operations
// =============================================================================

export function lineIntersection(
  a1: Point2D, a2: Point2D,
  b1: Point2D, b2: Point2D,
): Point2D | null {
  const d1 = subtract(a2, a1);
  const d2 = subtract(b2, b1);
  const crossD = cross(d1, d2);
  if (Math.abs(crossD) < 0.0001) return null;
  const d = subtract(b1, a1);
  const t = cross(d, d2) / crossD;
  return { x: a1.x + d1.x * t, y: a1.y + d1.y * t };
}

export function segmentIntersection(
  a1: Point2D, a2: Point2D,
  b1: Point2D, b2: Point2D,
): Point2D | null {
  const d1 = subtract(a2, a1);
  const d2 = subtract(b2, b1);
  const crossD = cross(d1, d2);
  if (Math.abs(crossD) < 0.0001) return null;
  const d = subtract(b1, a1);
  const t = cross(d, d2) / crossD;
  const u = cross(d, d1) / crossD;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a1.x + d1.x * t, y: a1.y + d1.y * t };
}

export function projectPointOnLine(
  point: Point2D, lineStart: Point2D, lineEnd: Point2D,
): { projected: Point2D; t: number; distance: number } {
  const d = subtract(lineEnd, lineStart);
  const lenSq = dot(d, d);
  if (lenSq < 0.0001) {
    return { projected: { ...lineStart }, t: 0, distance: distance(point, lineStart) };
  }
  const t = dot(subtract(point, lineStart), d) / lenSq;
  const projected = { x: lineStart.x + d.x * t, y: lineStart.y + d.y * t };
  return { projected, t, distance: distance(point, projected) };
}

export function projectPointToSegment(
  point: Point2D, start: Point2D, end: Point2D,
): { distance: number; t: number; closest: Point2D } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    const dist = Math.sqrt((point.x - start.x) ** 2 + (point.y - start.y) ** 2);
    return { distance: dist, t: 0, closest: { ...start } };
  }
  let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const closest = { x: start.x + t * dx, y: start.y + t * dy };
  const dist = Math.sqrt((point.x - closest.x) ** 2 + (point.y - closest.y) ** 2);
  return { distance: dist, t, closest };
}

// =============================================================================
// Offset Line Computation
// =============================================================================

export function computeOffsetLines(
  startPoint: Point2D, endPoint: Point2D, thickness: number,
  centerlineOffset: number = 0,
): { interiorLine: Line; exteriorLine: Line } {
  const dir = direction(startPoint, endPoint);
  const perp = perpendicular(dir);
  const halfThickness = thickness / 2;

  // centerlineOffset shifts the entire wall body perpendicular to the reference line.
  // Positive offset = interior (positive perpendicular) direction.
  return {
    interiorLine: {
      start: add(startPoint, scale(perp, centerlineOffset + halfThickness)),
      end: add(endPoint, scale(perp, centerlineOffset + halfThickness)),
    },
    exteriorLine: {
      start: add(startPoint, scale(perp, centerlineOffset - halfThickness)),
      end: add(endPoint, scale(perp, centerlineOffset - halfThickness)),
    },
  };
}

/**
 * [ROOT FIX] Recompute a wall's offset lines from its current centerline.
 *
 * THIS MUST BE CALLED every time wall.startPoint, wall.endPoint, or
 * wall.thickness changes. Without this, the offset lines become stale and
 * the join computation produces garbage vertices.
 *
 * @mutates wall — updates wall.interiorLine and wall.exteriorLine in place
 */
export function refreshOffsetLines(wall: Wall): void {
  const len = distance(wall.startPoint, wall.endPoint);
  if (len < 0.001) {
    wall.interiorLine = {
      start: { ...wall.startPoint },
      end: { ...wall.endPoint },
    };
    wall.exteriorLine = {
      start: { ...wall.startPoint },
      end: { ...wall.endPoint },
    };
    return;
  }

  const { interiorLine, exteriorLine } = computeOffsetLines(
    wall.startPoint, wall.endPoint, wall.thickness, wall.centerlineOffset ?? 0,
  );
  wall.interiorLine = interiorLine;
  wall.exteriorLine = exteriorLine;
}

// =============================================================================
// Wall Angle Calculations
// =============================================================================

export function wallAngle(wall: Wall): number {
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const deg = Math.atan2(dy, dx) * (180 / Math.PI);
  return ((deg % 360) + 360) % 360;
}

export function angleBetweenWalls(wall1: Wall, wall2: Wall, sharedEndpoint: Point2D): number {
  let dir1: Point2D;
  let dir2: Point2D;

  const isWall1Start = Math.abs(wall1.startPoint.x - sharedEndpoint.x) < 0.1 &&
    Math.abs(wall1.startPoint.y - sharedEndpoint.y) < 0.1;
  dir1 = isWall1Start
    ? direction(wall1.startPoint, wall1.endPoint)
    : direction(wall1.endPoint, wall1.startPoint);

  const isWall2Start = Math.abs(wall2.startPoint.x - sharedEndpoint.x) < 0.1 &&
    Math.abs(wall2.startPoint.y - sharedEndpoint.y) < 0.1;
  dir2 = isWall2Start
    ? direction(wall2.startPoint, wall2.endPoint)
    : direction(wall2.endPoint, wall2.startPoint);

  // atan2-based: stable at 0° and 180° unlike acos
  const angleRad = Math.abs(Math.atan2(cross(dir1, dir2), dot(dir1, dir2)));
  return angleRad * (180 / Math.PI);
}

export function signedAngleBetween(dir1: Point2D, dir2: Point2D): number {
  const angle = Math.atan2(cross(dir1, dir2), dot(dir1, dir2));
  return angle * (180 / Math.PI);
}

// =============================================================================
// Join Type Determination
// =============================================================================

export function determineJoinType(angleDegrees: number): JoinType {
  return angleDegrees > 30 ? 'miter' : 'butt';
}

// =============================================================================
// Miter Join Computation (with aggressive clamping)
// =============================================================================

export interface MiterJoinResult {
  interiorVertex: Point2D;
  exteriorVertex: Point2D;
  wasClamped: boolean;
}

/**
 * Compute miter join vertices with AGGRESSIVE distance clamping.
 *
 * [ROOT FIX] The miter limit now enforces a maximum DISTANCE from the
 * join point, not just a ratio check. This prevents vertices from shooting
 * to infinity at acute angles.
 */
export function computeMiterJoin(
  wall1: Wall, wall2: Wall, joinPoint: Point2D,
  miterLimit: number = 2.5,
): MiterJoinResult {
  const isW1Start = Math.abs(wall1.startPoint.x - joinPoint.x) < 0.1 &&
    Math.abs(wall1.startPoint.y - joinPoint.y) < 0.1;
  const isW2Start = Math.abs(wall2.startPoint.x - joinPoint.x) < 0.1 &&
    Math.abs(wall2.startPoint.y - joinPoint.y) < 0.1;

  const w1Dir = isW1Start
    ? direction(wall1.startPoint, wall1.endPoint)
    : direction(wall1.endPoint, wall1.startPoint);
  const w2Dir = isW2Start
    ? direction(wall2.startPoint, wall2.endPoint)
    : direction(wall2.endPoint, wall2.startPoint);

  const w1Left = isW1Start ? wall1.interiorLine.start : wall1.exteriorLine.end;
  const w1Right = isW1Start ? wall1.exteriorLine.start : wall1.interiorLine.end;
  const w2Left = isW2Start ? wall2.interiorLine.start : wall2.exteriorLine.end;
  const w2Right = isW2Start ? wall2.exteriorLine.start : wall2.interiorLine.end;

  let leftVertex = lineIntersection(
    w1Left, add(w1Left, w1Dir),
    w2Right, add(w2Right, w2Dir),
  ) || joinPoint;

  let rightVertex = lineIntersection(
    w1Right, add(w1Right, w1Dir),
    w2Left, add(w2Left, w2Dir),
  ) || joinPoint;

  // [ROOT FIX] Compute maximum allowed reach
  const maxHalfThick = Math.max(wall1.thickness, wall2.thickness) / 2;
  const shortestLen = Math.min(
    distance(wall1.startPoint, wall1.endPoint),
    distance(wall2.startPoint, wall2.endPoint),
  );
  const maxReach = Math.min(
    maxHalfThick * miterLimit,
    shortestLen * 0.35,
  );

  let wasClamped = false;

  // Clamp left vertex
  const leftDist = distance(joinPoint, leftVertex);
  if (leftDist > maxReach && leftDist > 0.001) {
    const ratio = maxReach / leftDist;
    leftVertex = {
      x: joinPoint.x + (leftVertex.x - joinPoint.x) * ratio,
      y: joinPoint.y + (leftVertex.y - joinPoint.y) * ratio,
    };
    wasClamped = true;
  }

  // Clamp right vertex
  const rightDist = distance(joinPoint, rightVertex);
  if (rightDist > maxReach && rightDist > 0.001) {
    const ratio = maxReach / rightDist;
    rightVertex = {
      x: joinPoint.x + (rightVertex.x - joinPoint.x) * ratio,
      y: joinPoint.y + (rightVertex.y - joinPoint.y) * ratio,
    };
    wasClamped = true;
  }

  return isW1Start
    ? { interiorVertex: leftVertex, exteriorVertex: rightVertex, wasClamped }
    : { interiorVertex: rightVertex, exteriorVertex: leftVertex, wasClamped };
}

// =============================================================================
// Wall Polygon Computation (with validation)
// =============================================================================

export function computeWallBodyPolygon(wall: Wall): Point2D[] {
  return [
    wall.interiorLine.start,
    wall.interiorLine.end,
    wall.exteriorLine.end,
    wall.exteriorLine.start,
  ];
}

/**
 * Compute wall polygon with join adjustments.
 *
 * [ROOT FIX] Now validates the result and falls back to the basic
 * rectangle if the polygon is self-intersecting or has unreasonable area.
 */
export function computeWallPolygon(wall: Wall, joins?: JoinData[]): Point2D[] {
  const JOIN_ENDPOINT_TOLERANCE = 2;
  const basePolygon = computeWallBodyPolygon(wall);
  let interiorStart = basePolygon[0];
  let interiorEnd = basePolygon[1];
  let exteriorEnd = basePolygon[2];
  let exteriorStart = basePolygon[3];
  let startJoin: JoinData | null = null;
  let endJoin: JoinData | null = null;

  if (joins && joins.length > 0) {
    for (const join of joins) {
      const startDistance = Math.hypot(
        wall.startPoint.x - join.joinPoint.x,
        wall.startPoint.y - join.joinPoint.y,
      );
      const endDistance = Math.hypot(
        wall.endPoint.x - join.joinPoint.x,
        wall.endPoint.y - join.joinPoint.y,
      );
      const hasExplicitEndpoint = join.endpoint === 'start' || join.endpoint === 'end';
      if (!hasExplicitEndpoint && Math.min(startDistance, endDistance) > JOIN_ENDPOINT_TOLERANCE) {
        continue;
      }

      const isStart = hasExplicitEndpoint ? join.endpoint === 'start' : startDistance <= endDistance;

      if (isStart) {
        interiorStart = join.interiorVertex;
        exteriorStart = join.exteriorVertex;
        startJoin = join;
      } else {
        interiorEnd = join.interiorVertex;
        exteriorEnd = join.exteriorVertex;
        endJoin = join;
      }
    }
  }

  // Apply bevel offsets
  if (startJoin?.bevelDirection) {
    const result = applyBevelOffset(
      interiorStart, exteriorStart,
      startJoin.bevelDirection,
      wall.startBevel?.innerOffset ?? 0,
      wall.startBevel?.outerOffset ?? 0,
      startJoin.maxBevelOffset ?? wallLength(wall) / 2,
    );
    interiorStart = result.interior;
    exteriorStart = result.exterior;
  }

  if (endJoin?.bevelDirection) {
    const result = applyBevelOffset(
      interiorEnd, exteriorEnd,
      endJoin.bevelDirection,
      wall.endBevel?.innerOffset ?? 0,
      wall.endBevel?.outerOffset ?? 0,
      endJoin.maxBevelOffset ?? wallLength(wall) / 2,
    );
    interiorEnd = result.interior;
    exteriorEnd = result.exterior;
  }

  const polygon = [interiorStart, interiorEnd, exteriorEnd, exteriorStart];

  // [ROOT FIX] Validate polygon before returning
  if (isPolygonSelfIntersecting(polygon)) {
    return computeWallBodyPolygon(wall);
  }

  // Check area is reasonable
  const area = Math.abs(polygonSignedArea(polygon));
  const expectedArea = wallLength(wall) * wall.thickness;
  if (expectedArea > 0.001 && area > expectedArea * 3) {
    return computeWallBodyPolygon(wall);
  }

  return polygon;
}

function applyBevelOffset(
  interior: Point2D, exterior: Point2D,
  bevelDirection: Point2D,
  innerOffset: number, outerOffset: number,
  maxOffset: number,
): { interior: Point2D; exterior: Point2D } {
  const rawMagnitude = Math.hypot(bevelDirection.x, bevelDirection.y);
  if (rawMagnitude < 0.001) {
    return { interior, exterior };
  }

  const dir = normalize(bevelDirection);
  const clampedMax = Math.max(0, maxOffset);
  const safeClamp = (v: number) => Math.min(clampedMax, Math.max(0, Number.isFinite(v) ? v : 0));

  return {
    interior: add(interior, scale(dir, -safeClamp(innerOffset))),
    exterior: add(exterior, scale(dir, -safeClamp(outerOffset))),
  };
}

// =============================================================================
// Polygon Validation
// =============================================================================

export function isPolygonSelfIntersecting(polygon: Point2D[]): boolean {
  const n = polygon.length;
  if (n < 4) return false;

  for (let i = 0; i < n; i++) {
    const a1 = polygon[i];
    const a2 = polygon[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const b1 = polygon[j];
      const b2 = polygon[(j + 1) % n];
      if (segmentIntersection(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

function polygonSignedArea(polygon: Point2D[]): number {
  let area = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    area += (polygon[j].x + polygon[i].x) * (polygon[j].y - polygon[i].y);
  }
  return area / 2;
}

// =============================================================================
// Wall Metrics
// =============================================================================

export function wallLength(wall: Wall): number {
  return distance(wall.startPoint, wall.endPoint);
}

export function wallCenter(wall: Wall): Point2D {
  return midpoint(wall.startPoint, wall.endPoint);
}

export function wallBounds(wall: Wall): {
  minX: number; minY: number; maxX: number; maxY: number;
  width: number; height: number;
} {
  const points = [
    wall.interiorLine.start, wall.interiorLine.end,
    wall.exteriorLine.start, wall.exteriorLine.end,
  ];
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

// =============================================================================
// Hit-Testing
// =============================================================================

export function isPointInsideWall(point: Point2D, wall: Wall): boolean {
  const polygon = computeWallPolygon(wall);
  return isPointInPolygon(point, polygon);
}

function isPointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    if (
      ((pi.y > point.y) !== (pj.y > point.y)) &&
      (point.x < (pj.x - pi.x) * (point.y - pi.y) / (pj.y - pi.y) + pi.x)
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export function distanceToWallCenterLine(point: Point2D, wall: Wall): number {
  return projectPointToSegment(point, wall.startPoint, wall.endPoint).distance;
}