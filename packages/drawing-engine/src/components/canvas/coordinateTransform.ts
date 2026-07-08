'use client';

import type { Point2D } from '../../types';

import { MM_TO_PX } from './scale';

/**
 * Canonical coordinate transforms (W5 / R3).
 *
 * The engine has historically derived screen<->world and world->3D mappings
 * independently in each view (the Fabric plan viewport, the isometric Z-up mm
 * scene, the oblique px-shear projection), which let the views drift
 * geometrically. This module is the single, documented, deterministic source
 * for those mappings so every view can be routed through it. Pure + unit-tested
 * (the round-trip is pinned).
 *
 * Conventions:
 * - World space is millimetres, +X right, +Y down the page (matching the Fabric
 *   plan scene and every `*Mm` geometry field).
 * - Screen space is pixels: screen = world * MM_TO_PX * zoom + pan.
 * - 3D space is right-handed, Z-up in millimetres (matching the interactive
 *   isometric view): worldTo3D(x, y, elevationZ) = (x, y, elevationZ). Plan +Y
 *   maps to 3D +Y; pipe elevation maps to 3D +Z.
 */

export interface ViewTransform2D {
  /** Zoom factor (1 = one scene-mm-pixel : one screen pixel). */
  zoom: number;
  /** Pan offset in screen pixels. */
  panPx: Point2D;
}

export interface LocalScreenRect {
  left: number;
  top: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function safeScale(zoom: number): number {
  const k = MM_TO_PX * zoom;
  if (!Number.isFinite(k) || Math.abs(k) < 1e-9) {
    return 1e-9;
  }
  return k;
}

export function worldToScreen(worldMm: Point2D, view: ViewTransform2D): Point2D {
  const k = MM_TO_PX * view.zoom;
  return { x: worldMm.x * k + view.panPx.x, y: worldMm.y * k + view.panPx.y };
}

export function screenToWorld(screenPx: Point2D, view: ViewTransform2D): Point2D {
  const k = safeScale(view.zoom);
  return { x: (screenPx.x - view.panPx.x) / k, y: (screenPx.y - view.panPx.y) / k };
}

/**
 * Canonical board transform for 2D interaction. This is intentionally an alias
 * of `viewportToViewTransform`: call sites should ask for the canvas transform,
 * then use the same value for rendering, hit-testing, and pointer conversion.
 */
export function getCanvasTransform(viewportZoom: number, panOffset: Point2D): ViewTransform2D {
  return viewportToViewTransform(viewportZoom, panOffset);
}

/** Applies the current canvas transform to a world-mm point. */
export function applyCanvasTransform(worldMm: Point2D, view: ViewTransform2D): Point2D {
  return worldToScreen(worldMm, view);
}

/** Inverse of {@link applyCanvasTransform}: local screen pixels -> world mm. */
export function inverseCanvasTransform(screenPx: Point2D, view: ViewTransform2D): Point2D {
  return screenToWorld(screenPx, view);
}

/** Converts a browser client point to local screen pixels within a canvas/SVG host. */
export function clientPointToLocalScreen(
  clientX: number,
  clientY: number,
  rect: LocalScreenRect,
): Point2D {
  return { x: clientX - rect.left, y: clientY - rect.top };
}

/** Converts a browser client point directly into canonical world-mm coordinates. */
export function clientPointToWorld(
  clientX: number,
  clientY: number,
  rect: LocalScreenRect,
  view: ViewTransform2D,
): Point2D {
  return inverseCanvasTransform(clientPointToLocalScreen(clientX, clientY, rect), view);
}

/**
 * SVG matrix for a group whose child geometry is authored in world millimetres.
 * The same transform drives Fabric, Konva, and SVG overlays.
 */
export function canvasTransformToSvgMatrix(view: ViewTransform2D): string {
  const k = MM_TO_PX * view.zoom;
  return `matrix(${k} 0 0 ${k} ${view.panPx.x} ${view.panPx.y})`;
}

/** Pixels for a millimetre length at the given zoom (no pan). */
export function worldLengthToScreen(lengthMm: number, zoom: number): number {
  return lengthMm * MM_TO_PX * zoom;
}

/** Millimetres for a screen-pixel length at the given zoom. */
export function screenLengthToWorld(lengthPx: number, zoom: number): number {
  return lengthPx / safeScale(zoom);
}

/**
 * Maps a plan-space point + elevation to the canonical Z-up 3D frame (mm). Plan
 * (x, y) pass straight through; elevation becomes +Z.
 */
export function worldTo3D(worldMm: Point2D, elevationZMm: number): Vec3 {
  return { x: worldMm.x, y: worldMm.y, z: elevationZMm };
}

const MIN_SAFE_VIEWPORT_ZOOM = 1e-4;

/**
 * The single canonical {@link ViewTransform2D} for a frame, derived from the
 * engine's viewport state. `viewportZoom` already folds in the paper/real ratio
 * (DrawingCanvas) and `panOffset` is the scene-space pan. BOTH the Fabric
 * viewport matrix and the Konva interaction layer derive their transform from
 * the result (see `viewTransform.ts`), so the two 2D engines can never drift.
 *
 * Convention: a scene point (world-mm * MM_TO_PX) maps to screen via
 * `[zoom,0,0,zoom,panPx.x,panPx.y]`, identical to `worldToScreen` taking the
 * world-mm point directly — so pointer/handle/render geometry all agree.
 */
export function viewportToViewTransform(viewportZoom: number, panOffset: Point2D): ViewTransform2D {
  const zoom = Number.isFinite(viewportZoom)
    ? Math.max(viewportZoom, MIN_SAFE_VIEWPORT_ZOOM)
    : MIN_SAFE_VIEWPORT_ZOOM;
  return { zoom, panPx: { x: -panOffset.x * zoom, y: -panOffset.y * zoom } };
}
