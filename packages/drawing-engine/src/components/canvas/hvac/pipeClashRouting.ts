/**
 * Pipe clash detection + Z-type offset routing engine.
 *
 * Given a freshly routed (or edited) refrigerant pipe bundle and the existing
 * scene, this module detects where the new gas/liquid centerlines cross or run
 * too close to already-routed pipes at the same level, and computes a
 * professional Z-type vertical offset that bypasses each obstacle while keeping
 * the {@link MIN_INSULATED_CLEARANCE_MM} clear gap between insulated surfaces.
 *
 * The plan-view centerline is intentionally left untouched — the bypass is a
 * pure elevation change rendered on the top-down plan as a crossover hop/break.
 * All geometry (segments, elevations, insulated outer diameters) is sourced from
 * {@link getVisibleRefrigerantPipeStraightSegmentTargets} so obstacles and the
 * moving pipe share one consistent source of truth.
 */

import type { HvacElement, Point2D } from '../../../types';

import {
  createBypassId,
  type BypassDirection,
  type BypassRoutingMode,
  type PipeBypass,
  type PipeLineKind,
} from './pipeBypass';
import {
  MIN_CROSSING_SINE,
  PARALLEL_DIRECTION_DOT,
  ROUTE_POINT_EPSILON_MM,
  computeFittingRunMm,
  computeRequiredRiseMm,
} from './pipeRoutingRules';
import { getActivePipeRoutingSettings } from './pipeRoutingSettings';
import {
  getVisibleRefrigerantPipeStraightSegmentTargets,
  type VisibleRefrigerantPipeSegmentTarget,
} from './refrigerantPipeRenderState';

export type { BypassDirection, BypassRoutingMode, PipeBypass, PipeLineKind } from './pipeBypass';
export { normalizeBypasses, translateBypasses } from './pipeBypass';

export interface PipeObstacle {
  elementId: string;
  bundleId?: string;
  lineKind: PipeLineKind;
  start: Point2D;
  end: Point2D;
  direction: Point2D;
  lengthMm: number;
  /** Centerline elevation (mm from floor). */
  elevationMm: number;
  /** Insulated outer diameter (mm). */
  outerDiameterMm: number;
}

interface RouteSegment {
  index: number;
  start: Point2D;
  end: Point2D;
  direction: Point2D;
  lengthMm: number;
  /** Cumulative distance from the route start to this segment's start. */
  startDistanceMm: number;
}

export interface PipeClash {
  obstacle: PipeObstacle;
  /** Crossing/closest point on the moving pipe centerline (plan). */
  point: Point2D;
  /** Arc-length distance from the route start to {@link point}. */
  distanceAlongRouteMm: number;
  /** Moving-pipe tangent at the clash, normalized. */
  routeDirection: Point2D;
  /** `crossing` = perpendicular intersection; `overlap` = runs alongside. */
  kind: 'crossing' | 'overlap';
}

export interface BundleBypassPlan {
  /** Bypasses keyed by the moving pipe element id. */
  byElementId: Map<string, PipeBypass[]>;
  clashCount: number;
  warnings: string[];
  /** Direction the engine recommends regardless of any override. */
  recommendedDirection: BypassDirection | null;
}

export interface PlanBundleBypassesOptions {
  mode?: BypassRoutingMode;
  /** Forces every offset in the bundle to this direction (the card's choice). */
  directionOverride?: BypassDirection;
  clearanceMm?: number;
  fittingAngleDeg?: 45 | 90;
  ceilingLimitMm?: number;
  floorLimitMm?: number;
}

// ---------------------------------------------------------------------------
// Vector helpers (kept local, mirroring the pattern in refrigerantPipeRenderState)
// ---------------------------------------------------------------------------

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function add(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}

function scale(point: Point2D, factor: number): Point2D {
  return { x: point.x * factor, y: point.y * factor };
}

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function cross(a: Point2D, b: Point2D): number {
  return a.x * b.y - a.y * b.x;
}

function length(point: Point2D): number {
  return Math.hypot(point.x, point.y);
}

function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function normalizeDirection(point: Point2D): Point2D {
  const len = length(point);
  if (len < 1e-6) {
    return { x: 1, y: 0 };
  }
  return { x: point.x / len, y: point.y / len };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Obstacles & route reconstruction
// ---------------------------------------------------------------------------

function toObstacle(target: VisibleRefrigerantPipeSegmentTarget): PipeObstacle {
  return {
    elementId: target.elementId,
    bundleId: target.bundleId,
    lineKind: target.lineKind,
    start: target.start,
    end: target.end,
    direction: target.direction,
    lengthMm: target.lengthMm,
    elevationMm: target.elevationMm,
    outerDiameterMm: target.outerDiameterMm,
  };
}

/**
 * Rebuilds an ordered centerline polyline + per-segment metadata from the
 * rendered segments of a single pipe element. Segments arrive in route order.
 */
function buildRouteSegments(
  segments: VisibleRefrigerantPipeSegmentTarget[],
): RouteSegment[] {
  const routeSegments: RouteSegment[] = [];
  let cumulative = 0;
  segments.forEach((segment, index) => {
    const delta = subtract(segment.end, segment.start);
    const lengthMm = length(delta);
    if (lengthMm < ROUTE_POINT_EPSILON_MM) {
      return;
    }
    routeSegments.push({
      index,
      start: segment.start,
      end: segment.end,
      direction: normalizeDirection(delta),
      lengthMm,
      startDistanceMm: cumulative,
    });
    cumulative += lengthMm;
  });
  return routeSegments;
}

function totalRouteLength(routeSegments: RouteSegment[]): number {
  const last = routeSegments[routeSegments.length - 1];
  return last ? last.startDistanceMm + last.lengthMm : 0;
}

/** Maps an arc-length distance back to a plan point on the route polyline. */
function pointAtDistance(routeSegments: RouteSegment[], distanceMm: number): Point2D {
  if (routeSegments.length === 0) {
    return { x: 0, y: 0 };
  }
  const total = totalRouteLength(routeSegments);
  const clamped = clamp(distanceMm, 0, total);
  for (const segment of routeSegments) {
    const localDistance = clamped - segment.startDistanceMm;
    if (localDistance <= segment.lengthMm + 1e-6) {
      return add(segment.start, scale(segment.direction, Math.max(0, localDistance)));
    }
  }
  const last = routeSegments[routeSegments.length - 1]!;
  return last.end;
}

// ---------------------------------------------------------------------------
// Clash detection
// ---------------------------------------------------------------------------

interface ClashDetectionContext {
  movingOuterDiameterMm: number;
  movingElevationMm: number;
  clearanceMm: number;
}

/**
 * Two pipes only clash if their insulated envelopes overlap *vertically*. When
 * the elevation gap already exceeds the required separation they are safely on
 * different levels and never clash regardless of plan geometry.
 */
function elevationEnvelopesOverlap(
  obstacle: PipeObstacle,
  ctx: ClashDetectionContext,
): boolean {
  const requiredSeparation = computeRequiredRiseMm(
    obstacle.outerDiameterMm,
    ctx.movingOuterDiameterMm,
    ctx.clearanceMm,
  );
  return Math.abs(ctx.movingElevationMm - obstacle.elevationMm) < requiredSeparation - 1e-6;
}

/** Required surface-to-surface plan clearance distance for a near-miss check. */
function requiredPlanGap(obstacle: PipeObstacle, ctx: ClashDetectionContext): number {
  return obstacle.outerDiameterMm / 2 + ctx.movingOuterDiameterMm / 2 + ctx.clearanceMm;
}

/** Segment-segment intersection returning the point + the parameter `t` on AB. */
function segmentIntersection(
  a: Point2D,
  b: Point2D,
  c: Point2D,
  d: Point2D,
): { point: Point2D; t: number } | null {
  const r = subtract(b, a);
  const s = subtract(d, c);
  const denominator = cross(r, s);
  if (Math.abs(denominator) < 1e-9) {
    return null;
  }
  const qp = subtract(c, a);
  const t = cross(qp, s) / denominator;
  const u = cross(qp, r) / denominator;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) {
    return null;
  }
  return { point: add(a, scale(r, t)), t: clamp(t, 0, 1) };
}

/** Shortest distance between two finite segments + their closest points. */
function segmentDistance(
  a: Point2D,
  b: Point2D,
  c: Point2D,
  d: Point2D,
): { distanceMm: number; pointOnAB: Point2D; tOnAB: number } {
  const intersection = segmentIntersection(a, b, c, d);
  if (intersection) {
    return { distanceMm: 0, pointOnAB: intersection.point, tOnAB: intersection.t };
  }
  const candidates: Array<{ distanceMm: number; pointOnAB: Point2D; tOnAB: number }> = [];
  const projectOnto = (
    p: Point2D,
    segStart: Point2D,
    segEnd: Point2D,
  ): { point: Point2D; t: number } => {
    const seg = subtract(segEnd, segStart);
    const len2 = dot(seg, seg);
    if (len2 < 1e-9) {
      return { point: segStart, t: 0 };
    }
    const t = clamp(dot(subtract(p, segStart), seg) / len2, 0, 1);
    return { point: add(segStart, scale(seg, t)), t };
  };
  // c and d projected onto AB
  for (const p of [c, d]) {
    const projection = projectOnto(p, a, b);
    candidates.push({
      distanceMm: distance(projection.point, p),
      pointOnAB: projection.point,
      tOnAB: projection.t,
    });
  }
  // a and b projected onto CD (closest point on AB is the endpoint itself)
  const projAonCD = projectOnto(a, c, d);
  candidates.push({ distanceMm: distance(a, projAonCD.point), pointOnAB: a, tOnAB: 0 });
  const projBonCD = projectOnto(b, c, d);
  candidates.push({ distanceMm: distance(b, projBonCD.point), pointOnAB: b, tOnAB: 1 });

  return candidates.reduce((best, candidate) =>
    candidate.distanceMm < best.distanceMm ? candidate : best,
  );
}

function detectRouteClashes(
  routeSegments: RouteSegment[],
  obstacles: PipeObstacle[],
  ctx: ClashDetectionContext,
): PipeClash[] {
  const clashes: PipeClash[] = [];
  routeSegments.forEach((segment) => {
    obstacles.forEach((obstacle) => {
      if (!elevationEnvelopesOverlap(obstacle, ctx)) {
        return;
      }
      const directionDot = Math.abs(dot(segment.direction, obstacle.direction));
      const planGap = requiredPlanGap(obstacle, ctx);
      const result = segmentDistance(
        segment.start,
        segment.end,
        obstacle.start,
        obstacle.end,
      );
      const isParallel = directionDot >= PARALLEL_DIRECTION_DOT;
      // Crossing: real intersection. Overlap: parallel & running within the gap.
      const isCrossing = result.distanceMm <= 1e-3 && !isParallel;
      const isOverlap = isParallel && result.distanceMm < planGap;
      const isNearCrossing = !isParallel && result.distanceMm < planGap;
      if (!isCrossing && !isOverlap && !isNearCrossing) {
        return;
      }
      const distanceAlongRouteMm =
        segment.startDistanceMm + segment.lengthMm * result.tOnAB;
      clashes.push({
        obstacle,
        point: result.pointOnAB,
        distanceAlongRouteMm,
        routeDirection: segment.direction,
        kind: isOverlap ? 'overlap' : 'crossing',
      });
    });
  });
  clashes.sort((a, b) => a.distanceAlongRouteMm - b.distanceAlongRouteMm);
  return clashes;
}

// ---------------------------------------------------------------------------
// Grouping (minimum fittings) + bypass geometry
// ---------------------------------------------------------------------------

interface ClashGroup {
  clashes: PipeClash[];
  centerDistanceMm: number;
  minDistanceMm: number;
  maxDistanceMm: number;
  /** Sorted obstacle element ids — coordinates direction across gas/liquid. */
  key: string;
  obstacleElementIds: string[];
}

function groupClashes(clashes: PipeClash[]): ClashGroup[] {
  const groups: ClashGroup[] = [];
  let current: PipeClash[] = [];
  clashes.forEach((clash) => {
    const last = current[current.length - 1];
    const mergeWindowMm = getActivePipeRoutingSettings().clashMergeWindowMm;
    if (last && clash.distanceAlongRouteMm - last.distanceAlongRouteMm > mergeWindowMm) {
      groups.push(finalizeGroup(current));
      current = [];
    }
    current.push(clash);
  });
  if (current.length > 0) {
    groups.push(finalizeGroup(current));
  }
  return groups;
}

function finalizeGroup(clashes: PipeClash[]): ClashGroup {
  const distances = clashes.map((clash) => clash.distanceAlongRouteMm);
  const minDistanceMm = Math.min(...distances);
  const maxDistanceMm = Math.max(...distances);
  const obstacleElementIds = Array.from(
    new Set(clashes.map((clash) => clash.obstacle.elementId)),
  ).sort();
  return {
    clashes,
    centerDistanceMm: (minDistanceMm + maxDistanceMm) / 2,
    minDistanceMm,
    maxDistanceMm,
    key: obstacleElementIds.join('|'),
    obstacleElementIds,
  };
}

interface DirectionDecision {
  direction: BypassDirection;
  reason: string;
  auto: boolean;
}

/**
 * Picks above/below for a group. Above is preferred (cleaner, fewer traps,
 * keeps mains clear) when the raised pipe still fits under the slab; otherwise
 * the engine drops below. An explicit override always wins.
 */
function decideDirection(
  group: ClashGroup,
  movingOuterDiameterMm: number,
  baseElevationMm: number,
  clearanceMm: number,
  ceilingLimitMm: number,
  floorLimitMm: number,
  override?: BypassDirection,
): DirectionDecision {
  const obstacleTopMax = Math.max(
    ...group.clashes.map(
      (clash) => clash.obstacle.elevationMm + clash.obstacle.outerDiameterMm / 2,
    ),
  );
  const obstacleBottomMin = Math.min(
    ...group.clashes.map(
      (clash) => clash.obstacle.elevationMm - clash.obstacle.outerDiameterMm / 2,
    ),
  );
  const movingRadius = movingOuterDiameterMm / 2;
  const aboveTop = obstacleTopMax + clearanceMm + movingOuterDiameterMm;
  const belowBottom = obstacleBottomMin - clearanceMm - movingOuterDiameterMm;
  const aboveFits = aboveTop <= ceilingLimitMm;
  const belowFits = belowBottom >= floorLimitMm;

  if (override) {
    const fits = override === 'above' ? aboveFits : belowFits;
    return {
      direction: override,
      auto: false,
      reason: fits
        ? `Manually set to bypass ${override} the existing pipe.`
        : `Manually set to bypass ${override} — limited space, verify clearance.`,
    };
  }

  if (aboveFits) {
    return {
      direction: 'above',
      auto: true,
      reason: 'Above keeps the mains clear with the most ceiling space and fewer fittings.',
    };
  }
  if (belowFits) {
    return {
      direction: 'below',
      auto: true,
      reason: 'Not enough ceiling clearance above the obstacle — bypassing below.',
    };
  }
  // Neither fits cleanly: choose the side with more room and flag it.
  const roomAbove = ceilingLimitMm - aboveTop;
  const roomBelow = belowBottom - floorLimitMm;
  void movingRadius;
  return roomAbove >= roomBelow
    ? { direction: 'above', auto: true, reason: 'Tight on both sides — above has marginally more room.' }
    : { direction: 'below', auto: true, reason: 'Tight on both sides — below has marginally more room.' };
}

function computeBypassForGroup(
  group: ClashGroup,
  routeSegments: RouteSegment[],
  decision: DirectionDecision,
  movingOuterDiameterMm: number,
  baseElevationMm: number,
  clearanceMm: number,
  fittingAngleDeg: 45 | 90,
): PipeBypass {
  const obstacleTopMax = Math.max(
    ...group.clashes.map(
      (clash) => clash.obstacle.elevationMm + clash.obstacle.outerDiameterMm / 2,
    ),
  );
  const obstacleBottomMin = Math.min(
    ...group.clashes.map(
      (clash) => clash.obstacle.elevationMm - clash.obstacle.outerDiameterMm / 2,
    ),
  );
  const movingRadius = movingOuterDiameterMm / 2;
  const bypassElevationMm =
    decision.direction === 'above'
      ? obstacleTopMax + clearanceMm + movingRadius
      : obstacleBottomMin - clearanceMm - movingRadius;
  const riseMm = Math.abs(bypassElevationMm - baseElevationMm);
  const fittingRunMm = computeFittingRunMm(riseMm, fittingAngleDeg);

  // Largest obstacle envelope footprint projected onto the route tangent, so the
  // offset reaches its raised level *before* the obstacle and returns *after*.
  const envelopeFootprintMm = Math.max(
    ...group.clashes.map((clash) => {
      const sine = Math.max(
        MIN_CROSSING_SINE,
        Math.abs(cross(clash.routeDirection, clash.obstacle.direction)),
      );
      const envelopeRadius =
        clash.obstacle.outerDiameterMm / 2 + movingRadius + clearanceMm;
      return envelopeRadius / sine;
    }),
  );

  const offsetDistanceMm =
    envelopeFootprintMm + fittingRunMm + getActivePipeRoutingSettings().zOffsetStartDistanceMm;
  const enterDistanceMm = group.minDistanceMm - offsetDistanceMm;
  const exitDistanceMm = group.maxDistanceMm + offsetDistanceMm;

  const resolved =
    decision.direction === 'above'
      ? bypassElevationMm > baseElevationMm + 1e-3
      : bypassElevationMm < baseElevationMm - 1e-3;

  return {
    id: createBypassId(),
    obstacleElementIds: group.obstacleElementIds,
    obstaclePoint: pointAtDistance(routeSegments, group.centerDistanceMm),
    enterPoint: pointAtDistance(routeSegments, enterDistanceMm),
    exitPoint: pointAtDistance(routeSegments, exitDistanceMm),
    direction: decision.direction,
    clearanceMm,
    riseMm,
    baseElevationMm,
    bypassElevationMm,
    fittingAngleDeg,
    auto: decision.auto,
    reason: decision.reason,
    resolved,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface MovingPipe {
  elementId: string;
  bundleId?: string;
  lineKind: PipeLineKind;
  routeSegments: RouteSegment[];
  outerDiameterMm: number;
  elevationMm: number;
}

/**
 * Computes coordinated Z-offset bypasses for every pipe element in a bundle.
 *
 * @param allElements   Full scene used to extract consistent segment geometry
 *                      (include the moving bundle so its connections resolve).
 * @param bundleElementIds  Ids of the moving bundle's gas/liquid elements.
 */
export function planBundleBypasses(
  allElements: HvacElement[],
  bundleElementIds: string[],
  options: PlanBundleBypassesOptions = {},
): BundleBypassPlan {
  const routingSettings = getActivePipeRoutingSettings();
  const clearanceMm = options.clearanceMm ?? routingSettings.zOffsetClearanceMm;
  const fittingAngleDeg = options.fittingAngleDeg ?? routingSettings.bypassFittingAngleDeg;
  const ceilingLimitMm = options.ceilingLimitMm ?? routingSettings.ceilingLimitMm;
  const floorLimitMm = options.floorLimitMm ?? routingSettings.floorLimitMm;
  const mode = options.mode ?? 'auto';
  const directionOverride =
    options.directionOverride ?? (mode === 'above' || mode === 'below' ? mode : undefined);

  const emptyPlan: BundleBypassPlan = {
    byElementId: new Map(),
    clashCount: 0,
    warnings: [],
    recommendedDirection: null,
  };

  const idSet = new Set(bundleElementIds);
  if (idSet.size === 0) {
    return emptyPlan;
  }

  const allSegments = getVisibleRefrigerantPipeStraightSegmentTargets(allElements);
  const bundleSegments = allSegments.filter((segment) => idSet.has(segment.elementId));
  if (bundleSegments.length === 0) {
    return emptyPlan;
  }

  const bundleIds = new Set(
    bundleSegments
      .map((segment) => segment.bundleId)
      .filter((value): value is string => Boolean(value)),
  );

  const obstacles = allSegments
    .filter((segment) => {
      if (idSet.has(segment.elementId)) {
        return false;
      }
      if (segment.bundleId && bundleIds.has(segment.bundleId)) {
        return false;
      }
      return true;
    })
    .map(toObstacle);

  // One moving pipe per element id, preserving route order.
  const movingPipes: MovingPipe[] = bundleElementIds
    .map((elementId): MovingPipe | null => {
      const segments = bundleSegments.filter((segment) => segment.elementId === elementId);
      if (segments.length === 0) {
        return null;
      }
      const routeSegments = buildRouteSegments(segments);
      if (routeSegments.length === 0) {
        return null;
      }
      const first = segments[0]!;
      return {
        elementId,
        bundleId: first.bundleId,
        lineKind: first.lineKind,
        routeSegments,
        outerDiameterMm: first.outerDiameterMm,
        elevationMm: first.elevationMm,
      };
    })
    .filter((value): value is MovingPipe => value !== null);

  // Pass 1: detect + group clashes for each moving pipe.
  const perPipeGroups = movingPipes.map((pipe) => {
    const clashes = detectRouteClashes(pipe.routeSegments, obstacles, {
      movingOuterDiameterMm: pipe.outerDiameterMm,
      movingElevationMm: pipe.elevationMm,
      clearanceMm,
    });
    return { pipe, groups: groupClashes(clashes) };
  });

  const clashCount = perPipeGroups.reduce(
    (sum, entry) => sum + entry.groups.length,
    0,
  );
  if (clashCount === 0) {
    return emptyPlan;
  }

  // Pass 2: decide one direction per obstacle key so gas & liquid stay
  // coordinated when they bypass the same existing bundle.
  const directionByKey = new Map<string, DirectionDecision>();
  perPipeGroups.forEach(({ pipe, groups }) => {
    groups.forEach((group) => {
      const decision = decideDirection(
        group,
        pipe.outerDiameterMm,
        pipe.elevationMm,
        clearanceMm,
        ceilingLimitMm,
        floorLimitMm,
        directionOverride,
      );
      const existing = directionByKey.get(group.key);
      // Prefer a "below" decision if any line in the group cannot fit above,
      // so the whole bundle moves together.
      if (!existing || (existing.direction === 'above' && decision.direction === 'below')) {
        directionByKey.set(group.key, decision);
      }
    });
  });

  // Pass 3: build bypasses using the coordinated direction.
  const byElementId = new Map<string, PipeBypass[]>();
  const warnings: string[] = [];
  let recommendedDirection: BypassDirection | null = null;

  perPipeGroups.forEach(({ pipe, groups }) => {
    const bypasses = groups.map((group) => {
      const decision = directionByKey.get(group.key) ?? {
        direction: 'above' as BypassDirection,
        reason: 'Above keeps the mains clear.',
        auto: true,
      };
      if (decision.auto && !recommendedDirection) {
        recommendedDirection = decision.direction;
      }
      const bypass = computeBypassForGroup(
        group,
        pipe.routeSegments,
        decision,
        pipe.outerDiameterMm,
        pipe.elevationMm,
        clearanceMm,
        fittingAngleDeg,
      );
      if (!bypass.resolved) {
        warnings.push(
          `Could not find a valid ${bypass.direction} offset for ${pipe.lineKind} pipe near an existing line.`,
        );
      }
      return bypass;
    });
    byElementId.set(pipe.elementId, bypasses);
  });

  return {
    byElementId,
    clashCount,
    warnings,
    recommendedDirection: directionOverride ? null : recommendedDirection,
  };
}
