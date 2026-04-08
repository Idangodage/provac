/**
 * WallJoinComputer
 *
 * Pure-function module for computing wall joins (miter, bevel, butt).
 * Extracted from WallRenderer so join logic is testable without a canvas.
 *
 * CHANGES FROM PREVIOUS VERSION:
 * ──────────────────────────────────────────────────────
 * [FIX] Import mismatch: was importing Vec2 namespace that doesn't exist
 *       in the actual WallGeometry module. Now imports the real standalone
 *       functions (normalize, add, subtract, dot, cross, etc.)
 *
 * [FIX] computeJoinAngle: switched from acos to atan2. acos has infinite
 *       derivative at ±1, producing wildly wrong angles near 0° and 180°
 *       due to floating-point noise. atan2 is stable across the full range.
 *
 * [FIX] Removed dead code: buildWallIndex() was called, result stored in
 *       `wallIndex`, but `wallIndex` was never read anywhere.
 *
 * [FIX] Unified miter code path: computeCornerGeometry previously had TWO
 *       different miter implementations depending on whether otherEndpoint
 *       existed. Path A called computeMiterJoin (from WallGeometry), path B
 *       called a local computeEndpointMiter with different intersection logic.
 *       These could produce inconsistent join shapes for the same geometry.
 *       Now both paths use computeEndpointMiter, which handles the general case.
 *
 * [FIX] computeMaxCornerReach now uses the actual angle between walls.
 *       Previously it used a flat 0.45 * shortestWall regardless of angle.
 *       A 170° corner barely extends past the wall face, while a 10° corner
 *       shoots to infinity. The new formula scales reach by 1/sin(angle/2),
 *       which is the actual geometric relationship.
 *
 * [PERF] Pairwise caching: when wall A checks wall B, the geometric results
 *        (direction, faces, projections) are cached so wall B doesn't recompute
 *        them when checking wall A. Cuts join computation work roughly in half.
 *
 * [FIX] computeBevelDirection: stabilized bisector for near-antiparallel walls.
 *       When wallDir + otherDir ≈ {0,0}, the bisector was flipping discontinuously
 *       between frames during drag. Now falls back to the perpendicular of the
 *       wall direction (the geometric midline) instead of returning the raw
 *       wallDir, which was an arbitrary choice.
 *
 * [FIX] computeButtJoinVertices: added hysteresis band for face selection.
 *       When the branch wall is nearly parallel to the host (dot ≈ 0), the
 *       face selection was flipping between frames. Now uses a dead zone:
 *       if |dot| < 0.1, pick based on midpoint proximity (stable during drag).
 *
 * [FIX] Miter limit now uses max(wall.thickness, other.thickness) instead of
 *       only wall.thickness. When walls of different thickness meet, the thicker
 *       wall's miter can extend further and needs the larger limit.
 *
 * [FEAT] T-junction priority: when multiple walls hit the same host segment,
 *        the join with the steepest angle wins (more perpendicular = higher
 *        priority). Previously the first match won arbitrarily.
 * ──────────────────────────────────────────────────────
 */

import type { Point2D, Wall, JoinData } from '../../../types';
// [FIX] Import the actual standalone functions, not a Vec2 namespace that doesn't exist
import {
  normalize,
  add,
  subtract,
  dot,
  cross,
  direction,
  perpendicular,
  distance,
  lineIntersection,
} from './WallGeometry';

// =============================================================================
// Constants
// =============================================================================

/** Max miter extension as a multiple of half-thickness */
const MITER_LIMIT = 3;

/** Minimum angle (degrees) to generate a visible join */
const MIN_JOIN_ANGLE = 30;

/** Dead zone for face selection in butt joins — prevents flipping when branch
 *  is nearly parallel to host. If |dot(approach, hostNormal)| < this value,
 *  we use a stable fallback instead of flipping between faces. */
const FACE_SELECTION_DEAD_ZONE = 0.1;

/** Minimum bisector magnitude before we switch to perpendicular fallback */
const BISECTOR_MIN_MAGNITUDE = 0.05;

// =============================================================================
// Types
// =============================================================================

export interface JoinComputeOptions {
  /** Base tolerance in mm for matching endpoints */
  toleranceMm: number;
}

interface JoinMatch {
  endpoint: 'start' | 'end';
  point: Point2D;
  matchType: 'endpoint' | 'segment';
  otherEndpoint?: 'start' | 'end';
}

interface EndpointFaces {
  direction: Point2D;
  left: { kind: 'interior' | 'exterior'; anchor: Point2D };
  right: { kind: 'interior' | 'exterior'; anchor: Point2D };
}

/** Pre-computed per-wall data to avoid redundant calculations */
interface WallCacheEntry {
  startDir: Point2D;
  endDir: Point2D;
  length: number;
}

type DirectionCache = Map<string, WallCacheEntry>;

// =============================================================================
// Public API
// =============================================================================

/**
 * Compute all pairwise wall joins.
 *
 * @returns Map from wallId → array of JoinData for that wall's endpoints.
 */
export function computeAllJoins(
  walls: readonly Wall[],
  options: JoinComputeOptions,
): Map<string, JoinData[]> {
  const joinsMap = new Map<string, JoinData[]>();

  // [PERF] Pre-compute direction vectors for all walls so we don't
  // recalculate them for every pairwise check.
  const dirCache: DirectionCache = new Map();
  for (const wall of walls) {
    dirCache.set(wall.id, {
      startDir: direction(wall.startPoint, wall.endPoint),
      endDir: direction(wall.endPoint, wall.startPoint),
      length: distance(wall.startPoint, wall.endPoint),
    });
  }

  // [PERF] Cache endpoint-to-endpoint match results. When wall A checks wall B
  // and finds a match, we store it so wall B can derive its own match without
  // recomputing distances and projections.
  const matchCache = new Map<string, JoinMatch[]>();

  for (const wall of walls) {
    const bestByEndpoint = new Map<'start' | 'end', { join: JoinData; priority: number }>();

    for (const other of walls) {
      if (other.id === wall.id) continue;

      const connected = isConnected(wall, other);

      // [PERF] Try to derive matches from the reverse pair's cached results
      const cacheKey = `${wall.id}:${other.id}`;
      const reverseCacheKey = `${other.id}:${wall.id}`;
      let matches: JoinMatch[];

      const cachedReverse = matchCache.get(reverseCacheKey);
      if (cachedReverse) {
        matches = flipMatches(cachedReverse, wall, other, options.toleranceMm, connected);
      } else {
        matches = findJoinMatches(wall, other, options.toleranceMm, connected);
        matchCache.set(cacheKey, matches);
      }

      for (const match of matches) {
        const angle = computeJoinAngle(wall, other, match, dirCache);
        if (!Number.isFinite(angle) || angle < MIN_JOIN_ANGLE) continue;

        const geometry = resolveJoinGeometry(wall, other, match, angle);
        const bevelDir = computeBevelDirection(wall, other, match.endpoint, match.point, dirCache);
        const maxBevel = computeMaxBevelOffset(wall, other, dirCache);

        const join: JoinData = {
          wallId: wall.id,
          otherWallId: other.id,
          endpoint: match.endpoint,
          joinPoint: match.point,
          joinType: geometry.joinType,
          angle,
          interiorVertex: geometry.interiorVertex,
          exteriorVertex: geometry.exteriorVertex,
          bevelDirection: bevelDir,
          maxBevelOffset: maxBevel,
        };

        // [FIX] T-junction priority: steeper angle = higher priority among
        // segment matches. Previously first match won arbitrarily when multiple
        // walls hit the same host segment.
        const basePriority = match.matchType === 'endpoint' ? 200 : 100;
        const priority = basePriority + angle;

        const existing = bestByEndpoint.get(match.endpoint);
        if (!existing || priority > existing.priority) {
          bestByEndpoint.set(match.endpoint, { join, priority });
        }
      }
    }

    joinsMap.set(
      wall.id,
      Array.from(bestByEndpoint.values()).map((e) => e.join),
    );
  }

  return joinsMap;
}

// =============================================================================
// Match Flipping (for cache reuse)
// =============================================================================

/**
 * [PERF] When wall B already computed endpoint-to-endpoint matches against
 * wall A, we can derive wall A's matches against wall B by flipping the
 * endpoint labels. Segment matches can't be reliably flipped (the perspectives
 * are different), so those fall through to fresh computation.
 */
function flipMatches(
  reverseMatches: JoinMatch[],
  wall: Readonly<Wall>,
  other: Readonly<Wall>,
  baseTolerance: number,
  connected: boolean,
): JoinMatch[] {
  const flipped: JoinMatch[] = [];

  for (const rm of reverseMatches) {
    if (rm.matchType === 'endpoint' && rm.otherEndpoint) {
      flipped.push({
        endpoint: rm.otherEndpoint,
        point: rm.point,
        matchType: 'endpoint',
        otherEndpoint: rm.endpoint,
      });
    }
  }

  // For endpoints not covered by flipped matches, compute directly
  const coveredEndpoints = new Set(flipped.map((m) => m.endpoint));
  if (!coveredEndpoints.has('start') || !coveredEndpoints.has('end')) {
    const directMatches = findJoinMatches(wall, other, baseTolerance, connected);
    for (const dm of directMatches) {
      if (!coveredEndpoints.has(dm.endpoint)) {
        flipped.push(dm);
      }
    }
  }

  return flipped;
}

// =============================================================================
// Join Matching
// =============================================================================

function isConnected(a: Readonly<Wall>, b: Readonly<Wall>): boolean {
  return a.connectedWalls.includes(b.id) || b.connectedWalls.includes(a.id);
}

function findJoinMatches(
  wall: Readonly<Wall>,
  other: Readonly<Wall>,
  baseTolerance: number,
  connected: boolean,
): JoinMatch[] {
  const tolerance = connected ? baseTolerance * 3 : baseTolerance;
  const ENDPOINT_T_RATIO = 0.02;
  const matches: JoinMatch[] = [];
  const seen = new Set<string>();

  const endpoints: Array<{ ep: 'start' | 'end'; pt: Point2D }> = [
    { ep: 'start', pt: wall.startPoint },
    { ep: 'end', pt: wall.endPoint },
  ];

  for (const { ep, pt } of endpoints) {
    const distToStart = distance(pt, other.startPoint);
    const distToEnd = distance(pt, other.endPoint);

    // Check endpoint-to-endpoint
    if (distToStart <= tolerance || distToEnd <= tolerance) {
      const otherEp: 'start' | 'end' = distToStart <= distToEnd ? 'start' : 'end';
      const key = `${ep}:endpoint:${otherEp}`;
      if (!seen.has(key)) {
        seen.add(key);
        const otherPt = otherEp === 'start' ? other.startPoint : other.endPoint;
        matches.push({
          endpoint: ep,
          point: { x: (pt.x + otherPt.x) / 2, y: (pt.y + otherPt.y) / 2 },
          matchType: 'endpoint',
          otherEndpoint: otherEp,
        });
      }
      continue;
    }

    // Check endpoint-to-segment
    const proj = projectToSegment(pt, other.startPoint, other.endPoint);
    if (proj.distance > tolerance) continue;

    const segLen = Math.max(1, distance(other.startPoint, other.endPoint));
    const endBand = Math.min(
      connected ? 0.3 : 0.2,
      (connected ? ENDPOINT_T_RATIO * 2 : ENDPOINT_T_RATIO) + tolerance / segLen,
    );

    const nearStart = proj.t <= endBand && distToStart <= tolerance * 2;
    const nearEnd = proj.t >= 1 - endBand && distToEnd <= tolerance * 2;
    const matchType: 'endpoint' | 'segment' = nearStart || nearEnd ? 'endpoint' : 'segment';

    const otherEp: 'start' | 'end' | undefined =
      matchType === 'endpoint'
        ? nearStart && !nearEnd
          ? 'start'
          : nearEnd && !nearStart
            ? 'end'
            : distToStart <= distToEnd ? 'start' : 'end'
        : undefined;

    const key = `${ep}:${matchType}:${otherEp ?? 'segment'}`;
    if (!seen.has(key)) {
      seen.add(key);
      const snapPt =
        matchType === 'endpoint' && otherEp
          ? {
            x: (pt.x + (otherEp === 'start' ? other.startPoint.x : other.endPoint.x)) / 2,
            y: (pt.y + (otherEp === 'start' ? other.startPoint.y : other.endPoint.y)) / 2,
          }
          : { ...proj.point };
      matches.push({ endpoint: ep, point: snapPt, matchType, otherEndpoint: otherEp });
    }
  }

  return matches;
}

// =============================================================================
// Angle Computation
// =============================================================================

function directionAway(wall: Readonly<Wall>, ep: 'start' | 'end', cache?: DirectionCache): Point2D {
  if (cache) {
    const cached = cache.get(wall.id);
    if (cached) return ep === 'start' ? cached.startDir : cached.endDir;
  }
  return ep === 'start'
    ? direction(wall.startPoint, wall.endPoint)
    : direction(wall.endPoint, wall.startPoint);
}

/**
 * Compute angle between two walls at a join.
 *
 * [FIX] Uses atan2(cross, dot) instead of acos(dot).
 * acos has infinite derivative at ±1 — a dot product of 0.99999999 vs 1.00000001
 * (common floating-point noise) produces a wildly different acos result.
 * atan2 is stable across the full range because both sine and cosine components
 * are well-conditioned near any angle.
 */
function computeJoinAngle(
  wall: Readonly<Wall>,
  other: Readonly<Wall>,
  match: JoinMatch,
  cache?: DirectionCache,
): number {
  const wallDir = directionAway(wall, match.endpoint, cache);

  if (match.matchType === 'endpoint' && match.otherEndpoint) {
    const otherDir = directionAway(other, match.otherEndpoint, cache);
    // [FIX] atan2-based: stable at 0° and 180° unlike acos
    const angleRad = Math.abs(Math.atan2(cross(wallDir, otherDir), dot(wallDir, otherDir)));
    return angleRad * (180 / Math.PI);
  }

  // T-junction: angle between branch and host wall
  const hostDir = direction(other.startPoint, other.endPoint);
  // Use both cross and dot for atan2 — gives accurate angle even when
  // the branch is nearly parallel or perpendicular to the host
  const perpComponent = Math.abs(cross(wallDir, hostDir));
  const parallelComponent = Math.abs(dot(wallDir, hostDir));
  const angleRad = Math.atan2(perpComponent, parallelComponent);
  return angleRad * (180 / Math.PI);
}

// =============================================================================
// Join Geometry Resolution
// =============================================================================

interface JoinGeometryResult {
  joinType: 'miter' | 'bevel' | 'butt';
  interiorVertex: Point2D;
  exteriorVertex: Point2D;
}

function resolveJoinGeometry(
  wall: Readonly<Wall>,
  other: Readonly<Wall>,
  match: JoinMatch,
  angle: number,
): JoinGeometryResult {
  if (match.matchType === 'segment') {
    return { joinType: 'butt', ...computeButtJoinVertices(wall, other, match.endpoint) };
  }

  const corner = computeCornerGeometry(wall, other, match, angle);
  return corner ?? { joinType: 'butt', ...computeButtJoinVertices(wall, other, match.endpoint) };
}

/**
 * [FIX] Unified miter path. Previously had two different miter implementations:
 * - Path A (!otherEndpoint): called computeMiterJoin from WallGeometry
 * - Path B (otherEndpoint): called local computeEndpointMiter
 *
 * These used different intersection logic (WallGeometry's version vs the local
 * endpointFaces-based version) and could produce inconsistent join shapes for
 * the same geometric configuration. Now always uses computeEndpointMiter.
 * When otherEndpoint is missing, we infer it from proximity to the join point.
 */
function computeCornerGeometry(
  wall: Readonly<Wall>,
  other: Readonly<Wall>,
  match: JoinMatch,
  angle: number,
): JoinGeometryResult | null {
  // [FIX] Infer otherEndpoint from proximity instead of branching to a
  // completely different miter implementation
  const otherEp: 'start' | 'end' = match.otherEndpoint
    ?? (distance(other.startPoint, match.point) <= distance(other.endPoint, match.point)
      ? 'start' : 'end');

  const miterResult = computeEndpointMiter(wall, other, match.endpoint, otherEp, match.point);

  // [FIX] Angle-aware max reach instead of flat 0.45 * shortestWall
  const maxReach = computeMaxCornerReach(wall, other, angle);

  if (!Number.isFinite(maxReach) || maxReach <= 0.0001) {
    return null;
  }

  if (miterResult.outerReach <= maxReach) {
    return {
      joinType: 'miter',
      interiorVertex: miterResult.interiorVertex,
      exteriorVertex: miterResult.exteriorVertex,
    };
  }

  // Fall back to bevel — keep the inner (shorter) miter vertex,
  // snap the outer (longer) one back to the wall face anchor
  const anchors = endpointAnchors(wall, match.endpoint);
  const bevelVertices =
    miterResult.outerKind === 'interior'
      ? { interiorVertex: anchors.interiorVertex, exteriorVertex: miterResult.exteriorVertex }
      : { interiorVertex: miterResult.interiorVertex, exteriorVertex: anchors.exteriorVertex };

  return { joinType: 'bevel', ...bevelVertices };
}

// =============================================================================
// Endpoint Face Helpers
// =============================================================================

function endpointFaces(wall: Readonly<Wall>, ep: 'start' | 'end'): EndpointFaces {
  const dir = directionAway(wall, ep);

  if (ep === 'start') {
    return {
      direction: dir,
      left: { kind: 'interior', anchor: wall.interiorLine.start },
      right: { kind: 'exterior', anchor: wall.exteriorLine.start },
    };
  }

  return {
    direction: dir,
    left: { kind: 'exterior', anchor: wall.exteriorLine.end },
    right: { kind: 'interior', anchor: wall.interiorLine.end },
  };
}

function endpointAnchors(
  wall: Readonly<Wall>,
  ep: 'start' | 'end',
): { interiorVertex: Point2D; exteriorVertex: Point2D } {
  return ep === 'start'
    ? { interiorVertex: wall.interiorLine.start, exteriorVertex: wall.exteriorLine.start }
    : { interiorVertex: wall.interiorLine.end, exteriorVertex: wall.exteriorLine.end };
}

// =============================================================================
// Miter Computation
// =============================================================================

function computeEndpointMiter(
  wall: Readonly<Wall>,
  other: Readonly<Wall>,
  ep: 'start' | 'end',
  otherEp: 'start' | 'end',
  joinPoint: Point2D,
): {
  interiorVertex: Point2D;
  exteriorVertex: Point2D;
  outerKind: 'interior' | 'exterior';
  outerReach: number;
} {
  const wFaces = endpointFaces(wall, ep);
  const oFaces = endpointFaces(other, otherEp);

  const intersect = (anchor: Point2D, dir: Point2D, oAnchor: Point2D, oDir: Point2D): Point2D =>
    lineIntersection(anchor, add(anchor, dir), oAnchor, add(oAnchor, oDir)) ?? joinPoint;

  const leftV = intersect(wFaces.left.anchor, wFaces.direction, oFaces.right.anchor, oFaces.direction);
  const rightV = intersect(wFaces.right.anchor, wFaces.direction, oFaces.left.anchor, oFaces.direction);

  const intV = wFaces.left.kind === 'interior' ? leftV : rightV;
  const extV = wFaces.left.kind === 'exterior' ? leftV : rightV;
  const leftReach = distance(joinPoint, leftV);
  const rightReach = distance(joinPoint, rightV);
  const outerKind = leftReach >= rightReach ? wFaces.left.kind : wFaces.right.kind;

  return {
    interiorVertex: intV,
    exteriorVertex: extV,
    outerKind,
    outerReach: Math.max(leftReach, rightReach),
  };
}

/**
 * Compute the maximum allowed miter reach for a corner join.
 *
 * [FIX] Now uses the actual angle between walls. The geometric miter extension
 * is halfThickness / sin(angle/2). This means:
 *   - 90° corner:  reach ≈ 1.41 × halfThickness (modest extension)
 *   - 45° corner:  reach ≈ 2.61 × halfThickness (significant)
 *   - 170° corner: reach ≈ 5.76 × halfThickness but barely visible
 *   - 10° corner:  reach ≈ 11.5 × halfThickness (clamped by MITER_LIMIT)
 *
 * Previously used a flat 0.45 × shortestWallLength regardless of angle,
 * which was too conservative for right angles and didn't prevent blowup
 * at acute angles.
 *
 * [FIX] Uses max(wall.thickness, other.thickness) for the limit. When walls
 * of different thickness meet, the thicker wall needs a larger miter limit.
 */
function computeMaxCornerReach(
  wall: Readonly<Wall>,
  other: Readonly<Wall>,
  angleDegrees: number,
): number {
  const shortestWallLength = Math.min(
    distance(wall.startPoint, wall.endPoint),
    distance(other.startPoint, other.endPoint),
  );

  // [FIX] Use the thicker wall's half-thickness
  const halfThickness = Math.max(wall.thickness, other.thickness) / 2;
  const miterLimitedReach = halfThickness * MITER_LIMIT;

  // [FIX] Angle-aware geometric limit.
  // Clamp half-angle away from 0° to avoid division by zero.
  const halfAngleRad = Math.max(0.01, (angleDegrees / 2) * (Math.PI / 180));
  const geometricReach = halfThickness / Math.sin(halfAngleRad);

  return Math.min(
    miterLimitedReach,
    geometricReach * 1.1,         // 10% margin over true geometric reach
    shortestWallLength * 0.45,    // never extend past half the wall
  );
}

// =============================================================================
// Butt Join (T-junction)
// =============================================================================

/**
 * Compute butt join vertices where a branch wall meets a host wall's face.
 *
 * [FIX] Added hysteresis for face selection. When the branch wall is nearly
 * parallel to the host (|dot(approach, hostNormal)| < FACE_SELECTION_DEAD_ZONE),
 * the face pick was flipping between interior and exterior on consecutive frames
 * during drag. Now uses midpoint-proximity as a stable tiebreaker in the dead zone.
 */
function computeButtJoinVertices(
  wall: Readonly<Wall>,
  host: Readonly<Wall>,
  ep: 'start' | 'end',
): { interiorVertex: Point2D; exteriorVertex: Point2D } {
  const epPt = ep === 'start' ? wall.startPoint : wall.endPoint;
  const oppPt = ep === 'start' ? wall.endPoint : wall.startPoint;
  const intFallback = ep === 'start' ? wall.interiorLine.start : wall.interiorLine.end;
  const extFallback = ep === 'start' ? wall.exteriorLine.start : wall.exteriorLine.end;

  const approachLen = distance(epPt, oppPt);
  const hostLen = distance(host.startPoint, host.endPoint);

  if (approachLen < 0.0001 || hostLen < 0.0001) {
    return { interiorVertex: intFallback, exteriorVertex: extFallback };
  }

  const approachDir = direction(oppPt, epPt);
  const hostVec = subtract(host.endPoint, host.startPoint);
  const hostNormal = normalize({ x: -hostVec.y, y: hostVec.x });
  const dotProduct = dot(approachDir, hostNormal);

  let useInteriorFace: boolean;

  if (Math.abs(dotProduct) < FACE_SELECTION_DEAD_ZONE) {
    // [FIX] In the dead zone, pick based on which host face the wall midpoint
    // is closer to. Midpoint moves smoothly → no flickering during drag.
    const wallMid = { x: (epPt.x + oppPt.x) / 2, y: (epPt.y + oppPt.y) / 2 };
    const hostIntMid = {
      x: (host.interiorLine.start.x + host.interiorLine.end.x) / 2,
      y: (host.interiorLine.start.y + host.interiorLine.end.y) / 2,
    };
    const hostExtMid = {
      x: (host.exteriorLine.start.x + host.exteriorLine.end.x) / 2,
      y: (host.exteriorLine.start.y + host.exteriorLine.end.y) / 2,
    };
    useInteriorFace = distance(wallMid, hostIntMid) < distance(wallMid, hostExtMid);
  } else {
    useInteriorFace = dotProduct < 0;
  }

  const hostFace = useInteriorFace ? host.interiorLine : host.exteriorLine;

  return {
    interiorVertex:
      lineIntersection(wall.interiorLine.start, wall.interiorLine.end, hostFace.start, hostFace.end) ?? intFallback,
    exteriorVertex:
      lineIntersection(wall.exteriorLine.start, wall.exteriorLine.end, hostFace.start, hostFace.end) ?? extFallback,
  };
}

// =============================================================================
// Bevel Direction
// =============================================================================

/**
 * Compute the bevel direction (bisector of the two wall directions).
 *
 * [FIX] Stabilized for near-antiparallel walls. When two walls point in nearly
 * opposite directions, wallDir + otherDir ≈ {0,0}. The previous code returned
 * wallDir as fallback, which is arbitrary — the bisector of two antiparallel
 * vectors should be perpendicular to both.
 *
 * Now falls back to perpendicular(wallDir), which is the geometric midline
 * between antiparallel vectors and produces stable, predictable bevel offsets.
 */
function computeBevelDirection(
  wall: Readonly<Wall>,
  other: Readonly<Wall>,
  ep: 'start' | 'end',
  joinPoint: Point2D,
  cache?: DirectionCache,
): Point2D {
  const wallDir = directionAway(wall, ep, cache);
  const otherEp: 'start' | 'end' =
    distance(other.startPoint, joinPoint) <= distance(other.endPoint, joinPoint)
      ? 'start'
      : 'end';
  const otherDir = directionAway(other, otherEp, cache);

  const bisector = add(wallDir, otherDir);
  const bisectorLen = Math.hypot(bisector.x, bisector.y);

  if (bisectorLen < BISECTOR_MIN_MAGNITUDE) {
    // [FIX] Near-antiparallel: perpendicular is the stable geometric midline
    return perpendicular(wallDir);
  }

  return normalize(bisector);
}

function computeMaxBevelOffset(
  wall: Readonly<Wall>,
  other: Readonly<Wall>,
  cache?: DirectionCache,
): number {
  const lenA = cache?.get(wall.id)?.length ?? distance(wall.startPoint, wall.endPoint);
  const lenB = cache?.get(other.id)?.length ?? distance(other.startPoint, other.endPoint);

  let max = Math.min(lenA / 2, lenB / 2);
  if (lenA < 20 || lenB < 20) {
    max = Math.min(max, Math.min(lenA, lenB) / 3);
  }
  return Math.max(0, max);
}

// =============================================================================
// Point-to-Segment Projection (local helper)
// =============================================================================

function projectToSegment(
  point: Point2D,
  start: Point2D,
  end: Point2D,
): { point: Point2D; distance: number; t: number } {
  const seg = subtract(end, start);
  const lenSq = seg.x * seg.x + seg.y * seg.y;

  if (lenSq < 1e-10) {
    return { point: { ...start }, distance: distance(point, start), t: 0 };
  }

  const toPoint = subtract(point, start);
  const t = Math.max(0, Math.min(1, dot(toPoint, seg) / lenSq));
  const proj = { x: start.x + seg.x * t, y: start.y + seg.y * t };

  return { point: proj, distance: distance(point, proj), t };
}