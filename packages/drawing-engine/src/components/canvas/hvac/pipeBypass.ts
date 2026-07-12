/**
 * Shared Z-offset bypass types + (de)serialization helpers.
 *
 * Kept dependency-free (only `Point2D`) so both the pipe geometry model
 * ({@link ./refrigerantPipePairModel}) and the clash-routing engine
 * ({@link ./pipeClashRouting}) can use it without an import cycle.
 */

import type { Point2D } from '../../../types';

import { MIN_INSULATED_CLEARANCE_MM } from './pipeRoutingRules';

export type PipeLineKind = 'gas' | 'liquid';
export type BypassDirection = 'above' | 'below';
/** `auto` lets the engine pick the best direction; the others force it. */
export type BypassRoutingMode = 'auto' | 'above' | 'below';

export interface PipeBypass {
  id: string;
  /** Obstacle element ids cleared by this single offset (one or more). */
  obstacleElementIds: string[];
  obstaclePoint: Point2D;
  /** Where the rise fitting begins (before the obstacle). */
  enterPoint: Point2D;
  /** Where the return fitting ends (after the obstacle). */
  exitPoint: Point2D;
  direction: BypassDirection;
  clearanceMm: number;
  /** Vertical centre-to-centre offset applied across the obstacle. */
  riseMm: number;
  /** Original centerline elevation of the moving pipe (mm from floor). */
  baseElevationMm: number;
  /** Raised/lowered centerline elevation across the obstacle (mm from floor). */
  bypassElevationMm: number;
  fittingAngleDeg: 45 | 90;
  /** True when the engine chose the direction (vs a user override). */
  auto: boolean;
  /** Human-readable rationale shown in the suggestion card. */
  reason: string;
  /** False when no valid offset clears the obstacle (e.g. hits slab/floor). */
  resolved: boolean;
}

let bypassIdCounter = 0;

export function createBypassId(): string {
  bypassIdCounter += 1;
  return `pipe-bypass-${Date.now().toString(36)}-${bypassIdCounter.toString(36)}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function add(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}

function normalizePoint(value: unknown): Point2D | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as { x?: unknown; y?: unknown };
  if (!isFiniteNumber(record.x) || !isFiniteNumber(record.y)) {
    return null;
  }
  return { x: record.x, y: record.y };
}

/** Parses a stored `properties.bypasses` array back into typed bypasses. */
export function normalizeBypasses(value: unknown): PipeBypass[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: PipeBypass[] = [];
  value.forEach((raw) => {
    if (!raw || typeof raw !== 'object') {
      return;
    }
    const record = raw as Record<string, unknown>;
    const obstaclePoint = normalizePoint(record.obstaclePoint);
    const enterPoint = normalizePoint(record.enterPoint);
    const exitPoint = normalizePoint(record.exitPoint);
    if (!obstaclePoint || !enterPoint || !exitPoint) {
      return;
    }
    const direction: BypassDirection = record.direction === 'below' ? 'below' : 'above';
    const fittingAngleDeg: 45 | 90 = record.fittingAngleDeg === 90 ? 90 : 45;
    result.push({
      id: typeof record.id === 'string' ? record.id : createBypassId(),
      obstacleElementIds: Array.isArray(record.obstacleElementIds)
        ? record.obstacleElementIds.filter((id): id is string => typeof id === 'string')
        : [],
      obstaclePoint,
      enterPoint,
      exitPoint,
      direction,
      clearanceMm: isFiniteNumber(record.clearanceMm)
        ? record.clearanceMm
        : MIN_INSULATED_CLEARANCE_MM,
      riseMm: isFiniteNumber(record.riseMm) ? record.riseMm : 0,
      baseElevationMm: isFiniteNumber(record.baseElevationMm) ? record.baseElevationMm : 0,
      bypassElevationMm: isFiniteNumber(record.bypassElevationMm)
        ? record.bypassElevationMm
        : 0,
      fittingAngleDeg,
      auto: record.auto !== false,
      reason: typeof record.reason === 'string' ? record.reason : '',
      resolved: record.resolved !== false,
    });
  });
  return result;
}

/** Shifts every plan point of a bypass by `delta` (used when a pipe is moved). */
export function translateBypasses(value: unknown, delta: Point2D): PipeBypass[] {
  return normalizeBypasses(value).map((bypass) => ({
    ...bypass,
    obstaclePoint: add(bypass.obstaclePoint, delta),
    enterPoint: add(bypass.enterPoint, delta),
    exitPoint: add(bypass.exitPoint, delta),
  }));
}
