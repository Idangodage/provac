/**
 * THE single world↔screen transform. Every "* zoom" in the app funnels through
 * here — there is no stray scaling math elsewhere. The Konva stage mirrors this
 * (stage.scale = zoom, stage.position = {panX, panY}).
 *
 * Convention: screen = world * zoom + pan  (y is screen-down, mm are floats).
 *   zoom = screen pixels per world mm.
 */

import type { Point } from '../model/types';

export interface ViewTransform {
  /** Screen pixels per world mm. */
  zoom: number;
  panX: number;
  panY: number;
}

export const identityView = (): ViewTransform => ({ zoom: 1, panX: 0, panY: 0 });

/** Hard zoom clamp — matches the round-trip invariant range. */
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 40;

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

export function worldToScreen(t: ViewTransform, p: Point): Point {
  return { x: p.x * t.zoom + t.panX, y: p.y * t.zoom + t.panY };
}

export function screenToWorld(t: ViewTransform, p: Point): Point {
  return { x: (p.x - t.panX) / t.zoom, y: (p.y - t.panY) / t.zoom };
}

/** World mm covered by one screen pixel — for converting pixel tolerances. */
export function pxToWorld(t: ViewTransform, px: number): number {
  return px / t.zoom;
}

/**
 * Zoom by `factor` while keeping the world point currently under `screenAnchor`
 * pinned to that same screen pixel (cursor-anchored wheel zoom). Returns the new
 * transform; zoom is clamped.
 */
export function zoomAt(
  t: ViewTransform,
  screenAnchor: Point,
  factor: number,
): ViewTransform {
  const nextZoom = clampZoom(t.zoom * factor);
  // Solve pan so screenToWorld(anchor) is unchanged: world = (anchor - pan)/zoom.
  const world = screenToWorld(t, screenAnchor);
  return {
    zoom: nextZoom,
    panX: screenAnchor.x - world.x * nextZoom,
    panY: screenAnchor.y - world.y * nextZoom,
  };
}

/** Pan by a screen-pixel delta (drag-to-pan). */
export function panBy(t: ViewTransform, dxPx: number, dyPx: number): ViewTransform {
  return { ...t, panX: t.panX + dxPx, panY: t.panY + dyPx };
}

/** The world-space rectangle currently visible in a `width`×`height` screen. */
export function visibleWorldBounds(
  t: ViewTransform,
  width: number,
  height: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const a = screenToWorld(t, { x: 0, y: 0 });
  const b = screenToWorld(t, { x: width, y: height });
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}
