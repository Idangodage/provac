/**
 * Geometric picking of duct runs against the drawn piece outlines, so a click
 * in the empty corner of an L-shaped run never selects it.
 */
import type { HvacElement, Point2D } from '../../../../types';

import { getDuctRunPlan, type DuctFabricationPlan } from './ductFabricationPlanner';
import { buildDuctPlanPresentation, type DuctPlanPresentation } from './ductPlanPresentation';
import type { DuctDesignSettings } from './ductSettings';
import { isDuctElement } from './ductTypes';

const PRESENTATION_CACHE = new WeakMap<DuctFabricationPlan, DuctPlanPresentation>();

export function getDuctPlanPresentation(plan: DuctFabricationPlan): DuctPlanPresentation {
  let presentation = PRESENTATION_CACHE.get(plan);
  if (!presentation) {
    presentation = buildDuctPlanPresentation(plan);
    PRESENTATION_CACHE.set(plan, presentation);
  }
  return presentation;
}

function insidePolygon(point: Point2D, polygon: readonly Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distanceToSegment(point: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared < 1e-9 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

export function distanceToPolygon(point: Point2D, polygon: readonly Point2D[]): number {
  if (polygon.length < 3) return Number.POSITIVE_INFINITY;
  if (insidePolygon(point, polygon)) return 0;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    best = Math.min(best, distanceToSegment(point, polygon[j]!, polygon[i]!));
  }
  return best;
}

export function pickDuctAtWorldPoint(
  point: Point2D,
  elements: Iterable<HvacElement>,
  settings: DuctDesignSettings,
  paddingMm: number,
): { id: string; distanceMm: number } | null {
  const scene = [...elements];
  let best: { id: string; distanceMm: number } | null = null;
  for (const element of scene) {
    if (!isDuctElement(element)) continue;
    const plan = getDuctRunPlan(element, scene, settings);
    if (!plan) continue;
    for (const piece of getDuctPlanPresentation(plan).piecePolygons) {
      const distance = distanceToPolygon(point, piece.polygon);
      if (distance <= paddingMm && (!best || distance < best.distanceMm)) best = { id: element.id, distanceMm: distance };
    }
  }
  return best;
}
