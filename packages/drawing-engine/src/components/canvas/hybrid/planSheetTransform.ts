import * as THREE from "three";

import { modelPointToWorld } from "../modelSpace";
import { MM_TO_PX } from "../scale";

/**
 * The 2D board is a stack of DOM surfaces (Fabric canvas, SVG pipe overlay,
 * selection chrome) — one "sheet of paper". During the RMB tilt the 3D scene
 * shows the same model through an ORTHOGRAPHIC camera, and under an ortho
 * camera the projection of the z=0 model plane onto the screen is EXACTLY an
 * affine map. That means a plain CSS `matrix(a,b,c,d,e,f)` can tilt the whole
 * DOM sheet pixel-identically to the 3D view — the drawing stays glued to the
 * paper through the entire transition. (CSS3DRenderer cannot do this: it
 * requires a perspective camera — three.js issue #11534.)
 *
 * T = C ∘ D⁻¹ where
 *   D(model) = screen of the FLAT sheet  = panPx + z·MM_TO_PX·model
 *   C(model) = screen of the tilted view = project(camera, modelPointToWorld)
 * With the canonical mirror basis in place, T is the identity while flat.
 */
export interface PlanSheetCssMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const PLAN_SHEET_IDENTITY: PlanSheetCssMatrix = Object.freeze({
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: 0,
  f: 0,
});

const worldScratch = new THREE.Vector3();

function projectModelPointToScreen(
  camera: THREE.Camera,
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const world = modelPointToWorld({ x, y });
  worldScratch.copy(world).project(camera);
  return {
    x: ((worldScratch.x + 1) / 2) * width,
    y: ((1 - worldScratch.y) / 2) * height,
  };
}

/**
 * Compute the CSS matrix that maps the FLAT DOM sheet onto the camera's view
 * of the model plane. `fabricVpt` is Fabric's live viewportTransform
 * `[z, 0, 0, z, panPxX, panPxY]`; the camera must have up-to-date matrices.
 * Apply with `transform-origin: 0 0`.
 */
export function computePlanSheetCssMatrix(
  camera: THREE.Camera,
  fabricVpt: readonly number[],
  width: number,
  height: number,
): PlanSheetCssMatrix {
  const zoom = fabricVpt[0] ?? 1;
  const panPxX = fabricVpt[4] ?? 0;
  const panPxY = fabricVpt[5] ?? 0;
  const pxPerMm = Math.max(zoom * MM_TO_PX, 1e-9);

  // One mm step on the sheet spans `pxPerMm` DOM pixels; probe the camera map
  // with the same step so the derived columns are D⁻¹-scaled directly.
  const stepMm = 1;
  const origin = projectModelPointToScreen(camera, 0, 0, width, height);
  const alongX = projectModelPointToScreen(camera, stepMm, 0, width, height);
  const alongY = projectModelPointToScreen(camera, 0, stepMm, width, height);

  const a = (alongX.x - origin.x) / (stepMm * pxPerMm);
  const b = (alongX.y - origin.y) / (stepMm * pxPerMm);
  const c = (alongY.x - origin.x) / (stepMm * pxPerMm);
  const d = (alongY.y - origin.y) / (stepMm * pxPerMm);
  // D(0,0) = (panPxX, panPxY) must land on C(0,0):
  const e = origin.x - (a * panPxX + c * panPxY);
  const f = origin.y - (b * panPxX + d * panPxY);

  return { a, b, c, d, e, f };
}

export function planSheetCssMatrixToString(matrix: PlanSheetCssMatrix): string {
  return `matrix(${matrix.a}, ${matrix.b}, ${matrix.c}, ${matrix.d}, ${matrix.e}, ${matrix.f})`;
}

export function isApproximatelyIdentity(
  matrix: PlanSheetCssMatrix,
  tolerance = 1e-4,
): boolean {
  return (
    Math.abs(matrix.a - 1) <= tolerance &&
    Math.abs(matrix.b) <= tolerance &&
    Math.abs(matrix.c) <= tolerance &&
    Math.abs(matrix.d - 1) <= tolerance &&
    Math.abs(matrix.e) <= tolerance &&
    Math.abs(matrix.f) <= tolerance
  );
}

/**
 * Sheet fade through the tilt: fully crisp until the tilt is clearly under
 * way, fully gone before the 3D walls need to stand free. While it fades the
 * sheet is pixel-locked to the 3D view, so the crossfade itself is invisible.
 */
export const SHEET_FADE_START_RAD = THREE.MathUtils.degToRad(1.5);
export const SHEET_FADE_END_RAD = THREE.MathUtils.degToRad(12);

export function planSheetOpacityForPolar(polar: number): number {
  if (polar <= SHEET_FADE_START_RAD) return 1;
  if (polar >= SHEET_FADE_END_RAD) return 0;
  const t =
    (polar - SHEET_FADE_START_RAD) / (SHEET_FADE_END_RAD - SHEET_FADE_START_RAD);
  const eased = t * t * (3 - 2 * t);
  return 1 - eased;
}

/**
 * Wall height reveal: while the sheet is still visible the 3D walls stay FLAT
 * (their top face sits on the plan footprint, so the crossfade shows ONE
 * image — a tall solid would parallax-shift its top by height·tanφ and read
 * as a broken double wall). Once the sheet is gone the walls rise out of the
 * paper to full height. Pure view-side reveal of a derived render cache —
 * model data never changes.
 */
export const WALL_RISE_START_RAD = SHEET_FADE_END_RAD;
export const WALL_RISE_END_RAD = THREE.MathUtils.degToRad(26);

export function wallRiseForPolar(polar: number): number {
  if (polar <= WALL_RISE_START_RAD) return 0;
  if (polar >= WALL_RISE_END_RAD) return 1;
  const t = (polar - WALL_RISE_START_RAD) / (WALL_RISE_END_RAD - WALL_RISE_START_RAD);
  return t * t * (3 - 2 * t);
}
