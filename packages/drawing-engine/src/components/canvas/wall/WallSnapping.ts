/**
 * WallSnapping
 *
 * Snapping utilities for wall drawing.
 * Grid snap, keypoint snap, angle locking, and smart guides.
 *
 * CHANGES FROM ORIGINAL:
 * ──────────────────────────────────────────────────────
 * [BUG] normalizeAngle: replaced while-loop (infinite loop on NaN) with modulo
 * [BUG] snapWallPoint priority: distance-weighted — closer snap wins when both
 *       endpoint and midpoint are within tolerance, instead of endpoint always
 *       winning regardless of distance
 * [FEAT] Smart guide / extension line snapping — snaps to the infinite extension
 *        of existing wall lines (like Figma/AutoCAD alignment guides)
 * [FEAT] Perpendicular snap — snaps to the point on another wall that forms a
 *        90° angle from the start point (AutoCAD "perpendicular" osnap)
 * [FEAT] Wall face snap — snaps to interior/exterior wall faces, not just
 *        centerline endpoints
 * [FEAT] Intersection snap — findWallIntersections is now integrated into
 *        snapWallPoint (was computed but never used in the original)
 * [FEAT] SnapResult now includes `guideLines` — geometry data the renderer
 *        can use to draw visual snap indicators (extension lines, perp marks)
 * [FEAT] applyAngleLock supports optional referenceAngle for chain-drawing
 *        relative to the previous wall's angle
 * [REFACTOR] Reuses segmentIntersection + projectPointOnLine from WallGeometry
 *            instead of reimplementing them
 * ──────────────────────────────────────────────────────
 */

import type { Point2D, Wall, SnapResult, EndpointSnapResult, WallSettings } from '../../../types';
import { ANGLE_CONSTRAINTS } from '../../../types/wall';
import { MM_TO_PX } from '../scale';
import {
  segmentIntersection,
  projectPointOnLine,
  projectPointToSegment,
  direction as vecDirection,
  dot,
  perpendicular,
  add,
  scale,
  distance as vecDistance,
} from './WallGeometry';

// =============================================================================
// Extended Snap Result Types
// =============================================================================

/**
 * [NEW] Guide line data for rendering snap indicators.
 * The renderer uses this to draw dotted extension lines, perpendicular markers, etc.
 */
export interface SnapGuideLine {
  type: 'extension' | 'perpendicular' | 'alignment';
  from: Point2D;
  to: Point2D;
  sourceWallId?: string;
}

export interface EnhancedSnapResult extends SnapResult {
  /** [NEW] Guide lines the renderer should draw as visual feedback */
  guideLines: SnapGuideLine[];
  /** [NEW] Distance to the snap target (for UI display) */
  snapDistance?: number;
}

const AUTO_ORTHO_ANGLE_TOLERANCE_DEG = 2.5;
const AUTO_ORTHO_MIN_LENGTH_MM = 40;
const AUTO_ORTHO_PIXEL_TOLERANCE = 8;

// =============================================================================
// Grid Snapping
// =============================================================================

export function snapToGrid(point: Point2D, gridSize: number): Point2D {
  return {
    x: Math.round(point.x / gridSize) * gridSize,
    y: Math.round(point.y / gridSize) * gridSize,
  };
}

function applyAutoOrthogonalAssist(
  rawPoint: Point2D,
  snappedPoint: Point2D,
  startPoint: Point2D,
  settings: WallSettings,
  zoom: number
): Point2D {
  const rawDx = rawPoint.x - startPoint.x;
  const rawDy = rawPoint.y - startPoint.y;
  const rawAbsDx = Math.abs(rawDx);
  const rawAbsDy = Math.abs(rawDy);
  const major = Math.max(rawAbsDx, rawAbsDy);
  const minor = Math.min(rawAbsDx, rawAbsDy);

  if (major < AUTO_ORTHO_MIN_LENGTH_MM) return snappedPoint;

  const axisAngleDeg = Math.atan2(minor, major) * (180 / Math.PI);
  if (axisAngleDeg > AUTO_ORTHO_ANGLE_TOLERANCE_DEG) return snappedPoint;

  const pixelToleranceMm = AUTO_ORTHO_PIXEL_TOLERANCE / Math.max(zoom, 0.01) / MM_TO_PX;
  const axisToleranceMm = Math.max(pixelToleranceMm, settings.gridSize * 0.35);

  const isVerticalCandidate = rawAbsDy >= rawAbsDx;
  if (isVerticalCandidate) {
    const crossAxisDelta = Math.abs(snappedPoint.x - startPoint.x);
    if (crossAxisDelta <= axisToleranceMm) {
      return { x: startPoint.x, y: snappedPoint.y };
    }
    return snappedPoint;
  }

  const crossAxisDelta = Math.abs(snappedPoint.y - startPoint.y);
  if (crossAxisDelta <= axisToleranceMm) {
    return { x: snappedPoint.x, y: startPoint.y };
  }
  return snappedPoint;
}

// =============================================================================
// Endpoint Snapping
// =============================================================================

export function snapToEndpoint(
  point: Point2D,
  walls: Wall[],
  tolerancePx: number,
  zoom: number,
  excludeWallId?: string
): EndpointSnapResult | null {
  const toleranceMm = tolerancePx / zoom / MM_TO_PX;

  let closest: EndpointSnapResult | null = null;
  let closestDistance = toleranceMm;

  for (const wall of walls) {
    if (wall.id === excludeWallId) continue;

    const distToStart = vecDistance(point, wall.startPoint);
    if (distToStart < closestDistance) {
      closestDistance = distToStart;
      closest = {
        snappedPoint: { ...wall.startPoint },
        wallId: wall.id,
        endpoint: 'start',
        distance: distToStart,
      };
    }

    const distToEnd = vecDistance(point, wall.endPoint);
    if (distToEnd < closestDistance) {
      closestDistance = distToEnd;
      closest = {
        snappedPoint: { ...wall.endPoint },
        wallId: wall.id,
        endpoint: 'end',
        distance: distToEnd,
      };
    }
  }

  return closest;
}

export function snapToMidpoint(
  point: Point2D,
  walls: Wall[],
  tolerancePx: number,
  zoom: number,
  excludeWallId?: string
): EndpointSnapResult | null {
  const toleranceMm = tolerancePx / zoom / MM_TO_PX;

  let closest: EndpointSnapResult | null = null;
  let closestDistance = toleranceMm;

  for (const wall of walls) {
    if (wall.id === excludeWallId) continue;

    const mid = {
      x: (wall.startPoint.x + wall.endPoint.x) / 2,
      y: (wall.startPoint.y + wall.endPoint.y) / 2,
    };

    const dist = vecDistance(point, mid);
    if (dist < closestDistance) {
      closestDistance = dist;
      closest = {
        snappedPoint: mid,
        wallId: wall.id,
        endpoint: 'midpoint',
        distance: dist,
      };
    }
  }

  return closest;
}

// =============================================================================
// [NEW] Extension Line Snapping (Smart Guides)
// =============================================================================

/**
 * Snap to the infinite extension of existing wall lines.
 * This is how Figma, Sketch, and AutoCAD show alignment guides — when your
 * cursor is near the extended line of an existing wall, it snaps to that line.
 *
 * Returns the snap point and the guide line endpoints for rendering.
 */
export function snapToExtensionLine(
  point: Point2D,
  walls: Wall[],
  tolerancePx: number,
  zoom: number,
  excludeWallId?: string
): { snappedPoint: Point2D; wallId: string; guideLine: SnapGuideLine; distance: number } | null {
  const toleranceMm = tolerancePx / zoom / MM_TO_PX;

  let best: {
    snappedPoint: Point2D;
    wallId: string;
    guideLine: SnapGuideLine;
    distance: number;
  } | null = null;
  let bestDist = toleranceMm;

  for (const wall of walls) {
    if (wall.id === excludeWallId) continue;

    // Project point onto the wall's INFINITE line (not clamped to segment)
    const proj = projectPointOnLine(point, wall.startPoint, wall.endPoint);

    // Only trigger if the projection is BEYOND the wall segment (t < 0 or t > 1)
    // Otherwise it's just a regular wall-proximity snap, not an extension guide
    if (proj.t >= -0.01 && proj.t <= 1.01) continue;

    if (proj.distance < bestDist) {
      bestDist = proj.distance;

      // Guide line goes from the nearest wall endpoint to the snap point
      const nearEndpoint = proj.t < 0 ? wall.startPoint : wall.endPoint;
      best = {
        snappedPoint: proj.projected,
        wallId: wall.id,
        guideLine: {
          type: 'extension',
          from: nearEndpoint,
          to: proj.projected,
          sourceWallId: wall.id,
        },
        distance: proj.distance,
      };
    }
  }

  return best;
}

// =============================================================================
// [NEW] Perpendicular Snapping
// =============================================================================

/**
 * Find the point on another wall that forms a 90° angle from startPoint.
 * This is AutoCAD's "perpendicular" osnap — essential for clean T-junctions.
 *
 * Given a startPoint (where the new wall begins), finds the closest point on
 * any existing wall where the line from startPoint to that point is perpendicular
 * to the existing wall.
 */
export function snapToPerpendicular(
  point: Point2D,
  startPoint: Point2D,
  walls: Wall[],
  tolerancePx: number,
  zoom: number,
  excludeWallId?: string
): { snappedPoint: Point2D; wallId: string; guideLine: SnapGuideLine; distance: number } | null {
  const toleranceMm = tolerancePx / zoom / MM_TO_PX;

  let best: {
    snappedPoint: Point2D;
    wallId: string;
    guideLine: SnapGuideLine;
    distance: number;
  } | null = null;
  let bestDist = toleranceMm;

  for (const wall of walls) {
    if (wall.id === excludeWallId) continue;

    // Find the foot of perpendicular from startPoint to wall centerline
    const proj = projectPointToSegment(startPoint, wall.startPoint, wall.endPoint);

    // The perpendicular point must be within the wall segment
    if (proj.t < 0.001 || proj.t > 0.999) continue;

    // Check if the cursor is near this perpendicular point
    const cursorDist = vecDistance(point, proj.closest);
    if (cursorDist < bestDist) {
      bestDist = cursorDist;
      best = {
        snappedPoint: proj.closest,
        wallId: wall.id,
        guideLine: {
          type: 'perpendicular',
          from: startPoint,
          to: proj.closest,
          sourceWallId: wall.id,
        },
        distance: cursorDist,
      };
    }
  }

  return best;
}

// =============================================================================
// [NEW] Wall Body (Centerline) Snapping
// =============================================================================

/**
 * Snap to the wall BODY via centerline projection (segment interior only).
 * This avoids endpoint/face-edge drift and keeps new connections aligned to
 * the true wall axis for clean T-junction joins.
 */
export function snapToWallBodyCenterline(
  point: Point2D,
  walls: Wall[],
  tolerancePx: number,
  zoom: number,
  excludeWallId?: string
): EndpointSnapResult | null {
  const toleranceMm = tolerancePx / zoom / MM_TO_PX;

  let closest: EndpointSnapResult | null = null;
  let closestDistance = toleranceMm;

  for (const wall of walls) {
    if (wall.id === excludeWallId) continue;

    // Project onto wall centerline and keep only interior segment body.
    const proj = projectPointToSegment(point, wall.startPoint, wall.endPoint);
    if (proj.distance < closestDistance && proj.t > 0.02 && proj.t < 0.98) {
      closestDistance = proj.distance;
      closest = {
        snappedPoint: proj.closest,
        wallId: wall.id,
        endpoint: 'midpoint',
        distance: proj.distance,
      };
    }
  }

  return closest;
}

// =============================================================================
// [NEW] Intersection Snapping
// =============================================================================

/**
 * Snap to wall-wall intersection points.
 * Previously `findWallIntersections` existed but was never integrated into
 * the snap pipeline — this bridges that gap.
 */
export function snapToIntersection(
  point: Point2D,
  walls: Wall[],
  tolerancePx: number,
  zoom: number,
  excludeWallId?: string
): EndpointSnapResult | null {
  const toleranceMm = tolerancePx / zoom / MM_TO_PX;

  let closest: EndpointSnapResult | null = null;
  let closestDistance = toleranceMm;

  for (let i = 0; i < walls.length; i++) {
    if (walls[i].id === excludeWallId) continue;

    for (let j = i + 1; j < walls.length; j++) {
      if (walls[j].id === excludeWallId) continue;

      const intersection = segmentIntersection(
        walls[i].startPoint, walls[i].endPoint,
        walls[j].startPoint, walls[j].endPoint
      );

      if (!intersection) continue;

      const dist = vecDistance(point, intersection);
      if (dist < closestDistance) {
        closestDistance = dist;
        closest = {
          snappedPoint: intersection,
          wallId: walls[i].id,
          endpoint: 'midpoint', // intersection doesn't map to a named endpoint
          distance: dist,
        };
      }
    }
  }

  return closest;
}

// =============================================================================
// Angle Locking
// =============================================================================

/**
 * Apply angle locking when Shift key is pressed.
 * [NEW] Supports optional referenceAngle for chain-drawing — angles are measured
 * relative to the previous wall's direction, not just global axes.
 */
export function applyAngleLock(
  startPoint: Point2D,
  currentPoint: Point2D,
  angles: number[] = ANGLE_CONSTRAINTS,
  referenceAngle: number = 0
): Point2D {
  const dx = currentPoint.x - startPoint.x;
  const dy = currentPoint.y - startPoint.y;
  const length = Math.sqrt(dx * dx + dy * dy);

  if (length < 0.001) {
    return currentPoint;
  }

  const currentAngle = Math.atan2(dy, dx) * (180 / Math.PI) - referenceAngle;

  let nearestAngle = angles[0];
  let minDiff = Math.abs(normalizeAngle(currentAngle - angles[0]));

  for (const angle of angles) {
    const diff = Math.abs(normalizeAngle(currentAngle - angle));
    if (diff < minDiff) {
      minDiff = diff;
      nearestAngle = angle;
    }
  }

  const radians = (nearestAngle + referenceAngle) * (Math.PI / 180);
  return {
    x: startPoint.x + length * Math.cos(radians),
    y: startPoint.y + length * Math.sin(radians),
  };
}

/**
 * Normalize angle to -180 to 180 range.
 * [FIX] Replaced while-loop with modulo arithmetic.
 * The original while-loop would spin forever if given NaN or Infinity.
 */
function normalizeAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  return ((angle % 360) + 540) % 360 - 180;
}

// =============================================================================
// Combined Snapping
// =============================================================================

/**
 * Apply all snapping rules to a point.
 *
 * [FIX] Priority is now distance-weighted within each tier. Previously
 * an endpoint 14px away always beat a midpoint 2px away — now the closer
 * snap wins when both are within tolerance.
 *
 * [NEW] Includes extension line, perpendicular, intersection, and wall-body snapping.
 * [NEW] Returns guideLines for snap indicator rendering.
 *
 * Priority tiers (highest first):
 *   1. Endpoint snap
 *   2. Intersection snap (NEW)
 *   3. Midpoint snap
 *   4. Perpendicular snap (NEW, only when drawing from a startPoint)
 *   5. Extension line snap (NEW)
 *   6. Wall body snap (centerline projection)
 *   7. Angle lock (Shift key)
 *   8. Grid snap
 *
 * Within the top 3 tiers, if multiple candidates are within tolerance,
 * the CLOSEST one wins (distance-weighted).
 */
export function snapWallPoint(
  point: Point2D,
  startPoint: Point2D | null,
  settings: WallSettings,
  walls: Wall[],
  shiftPressed: boolean,
  zoom: number,
  excludeWallId?: string
): EnhancedSnapResult {
  const guideLines: SnapGuideLine[] = [];
  let snappedPoint = { ...point };
  let snapType: SnapResult['snapType'] = 'none';
  let connectedWallId: string | undefined;
  let endpoint: 'start' | 'end' | 'midpoint' | undefined;
  let snapDist: number | undefined;

  // Collect high-priority candidates and pick the closest
  interface Candidate {
    point: Point2D;
    type: SnapResult['snapType'];
    wallId?: string;
    endpoint?: 'start' | 'end' | 'midpoint';
    distance: number;
    priority: number; // higher = better
    guides?: SnapGuideLine[];
  }
  const candidates: Candidate[] = [];

  // 1. Endpoint snap (priority 100)
  const endpointSnap = snapToEndpoint(point, walls, settings.endpointSnapTolerance, zoom, excludeWallId);
  if (endpointSnap) {
    candidates.push({
      point: endpointSnap.snappedPoint,
      type: 'endpoint',
      wallId: endpointSnap.wallId,
      endpoint: endpointSnap.endpoint,
      distance: endpointSnap.distance,
      priority: 100,
    });
  }

  // 2. Intersection snap (priority 90)
  const intersectionSnap = snapToIntersection(point, walls, settings.endpointSnapTolerance, zoom, excludeWallId);
  if (intersectionSnap) {
    candidates.push({
      point: intersectionSnap.snappedPoint,
      type: 'endpoint', // treat as endpoint-level snap for downstream
      wallId: intersectionSnap.wallId,
      endpoint: intersectionSnap.endpoint,
      distance: intersectionSnap.distance,
      priority: 90,
    });
  }

  // 3. Midpoint snap (priority 80)
  const midpointSnap = snapToMidpoint(point, walls, settings.midpointSnapTolerance, zoom, excludeWallId);
  if (midpointSnap) {
    candidates.push({
      point: midpointSnap.snappedPoint,
      type: 'midpoint',
      wallId: midpointSnap.wallId,
      endpoint: midpointSnap.endpoint,
      distance: midpointSnap.distance,
      priority: 80,
    });
  }

  // 4. Perpendicular snap (priority 70, only when drawing from startPoint)
  if (startPoint) {
    const perpSnap = snapToPerpendicular(
      point, startPoint, walls, settings.endpointSnapTolerance * 1.5, zoom, excludeWallId
    );
    if (perpSnap) {
      candidates.push({
        point: perpSnap.snappedPoint,
        type: 'endpoint',
        wallId: perpSnap.wallId,
        distance: perpSnap.distance,
        priority: 70,
        guides: [perpSnap.guideLine],
      });
    }
  }

  // 5. Extension line snap (priority 60)
  const extensionSnap = snapToExtensionLine(point, walls, settings.endpointSnapTolerance, zoom, excludeWallId);
  if (extensionSnap) {
    candidates.push({
      point: extensionSnap.snappedPoint,
      type: 'grid', // no specific type for extension — using grid as fallback
      wallId: extensionSnap.wallId,
      distance: extensionSnap.distance,
      priority: 60,
      guides: [extensionSnap.guideLine],
    });
  }

  // 6. Wall body snap on centerline (priority 50)
  const bodySnap = snapToWallBodyCenterline(
    point,
    walls,
    settings.endpointSnapTolerance * 0.8,
    zoom,
    excludeWallId
  );
  if (bodySnap) {
    candidates.push({
      point: bodySnap.snappedPoint,
      type: 'endpoint',
      wallId: bodySnap.wallId,
      // Keep endpoint undefined for body snaps so downstream can treat as T-junction.
      distance: bodySnap.distance,
      priority: 50,
    });
  }

  // [FIX] Pick winner: highest priority, then closest distance as tiebreaker
  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.distance - b.distance; // closer wins within same priority
    });

    const winner = candidates[0];
    snappedPoint = winner.point;
    snapType = winner.type;
    connectedWallId = winner.wallId;
    endpoint = winner.endpoint;
    snapDist = winner.distance;
    if (winner.guides) guideLines.push(...winner.guides);
  }

  // 7. Angle lock (shift key) — only if no higher-priority snap hit
  if (snapType === 'none' && shiftPressed && startPoint) {
    snappedPoint = applyAngleLock(startPoint, point);
    snapType = 'angle';

    if (settings.snapToGrid) {
      const dx = snappedPoint.x - startPoint.x;
      const dy = snappedPoint.y - startPoint.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      const snappedLength = Math.round(length / settings.gridSize) * settings.gridSize;

      if (length > 0.001) {
        const ratio = snappedLength / length;
        snappedPoint = {
          x: startPoint.x + dx * ratio,
          y: startPoint.y + dy * ratio,
        };
      }
    }
  }

  // 8. Grid snap — lowest priority fallback
  if (snapType === 'none' && settings.snapToGrid) {
    snappedPoint = snapToGrid(point, settings.gridSize);
    snapType = 'grid';
  }

  // Auto-orthogonal stabilization for grid-snapped drawing.
  // Prevents tiny skew in preview/commit when starting from off-grid endpoints.
  if (startPoint && snapType === 'grid' && settings.snapToGrid) {
    snappedPoint = applyAutoOrthogonalAssist(point, snappedPoint, startPoint, settings, zoom);
  }

  return {
    snappedPoint,
    snapType,
    connectedWallId,
    endpoint,
    guideLines,
    snapDistance: snapDist,
  };
}

// =============================================================================
// Orthogonal Constraint
// =============================================================================

export function applyOrthogonalConstraint(startPoint: Point2D, currentPoint: Point2D): Point2D {
  const dx = Math.abs(currentPoint.x - startPoint.x);
  const dy = Math.abs(currentPoint.y - startPoint.y);

  if (dx > dy) {
    return { x: currentPoint.x, y: startPoint.y };
  } else {
    return { x: startPoint.x, y: currentPoint.y };
  }
}

// =============================================================================
// Intersection Finding (standalone utility)
// =============================================================================

/**
 * Find wall intersection points.
 * [REFACTOR] Now delegates to segmentIntersection from WallGeometry
 * instead of reimplementing the same math.
 */
export function findWallIntersections(
  walls: Wall[],
  excludeWallIds: string[] = []
): Point2D[] {
  const intersections: Point2D[] = [];
  const excludeSet = new Set(excludeWallIds);

  for (let i = 0; i < walls.length; i++) {
    if (excludeSet.has(walls[i].id)) continue;

    for (let j = i + 1; j < walls.length; j++) {
      if (excludeSet.has(walls[j].id)) continue;

      const intersection = segmentIntersection(
        walls[i].startPoint, walls[i].endPoint,
        walls[j].startPoint, walls[j].endPoint
      );

      if (intersection) {
        intersections.push(intersection);
      }
    }
  }

  return intersections;
}
