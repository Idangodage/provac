/**
 * Pure viewport/camera math for the hybrid board — ported from the reference
 * app's `engine/camera/viewportMath.ts` practice (D:\myWorks\Advance canvas
 * board, SPEC §10/§26.8): no DOM, no camera-controls, fully unit-testable.
 *
 * Conventions: WORLD mm, Z-up, right-handed (the mirrored side of the model
 * basis — see modelSpace.ts). polar = angle from +Z (0 = top-down plan),
 * azimuth = rotation about Z (0 = camera due south of the target). Ortho
 * frustum spans the viewport in *pixels* and `zoom` is px-per-mm, so
 * mm-per-pixel = 1 / zoom everywhere.
 *
 * Every numeric assumption the controller makes lives HERE with property
 * tests — inline, untested pose math is exactly how the "board jumps on
 * right-click" (target ≠ screen-centre) and "rotated grid under a flat plan"
 * (azimuth ignored) bugs shipped.
 */
import * as THREE from "three";

import { worldPointToModel } from "../modelSpace";
import { MM_TO_PX } from "../scale";

export interface Viewport {
  width: number;
  height: number;
}

export interface CameraPose {
  target: THREE.Vector3;
  polar: number; // rad, 0 = top-down
  azimuth: number; // rad
  distance: number; // mm
}

// Reference §10 zoom limits: world-units-per-pixel ∈ [0.02 … 20 000 mm/px].
export const MIN_MM_PER_PX = 0.02;
export const MAX_MM_PER_PX = 20_000;

/** Direction from target to camera for a pose (unit vector, Z-up spherical). */
export function poseDirection(polar: number, azimuth: number): THREE.Vector3 {
  const sp = Math.sin(polar);
  return new THREE.Vector3(
    sp * Math.sin(azimuth),
    -sp * Math.cos(azimuth),
    Math.cos(polar),
  );
}

/**
 * Up vector for a pose. +Z generally; near the top-down pole that degenerates,
 * so use the continuous limit: screen-up = horizon direction (−sin az, cos az, 0).
 */
export function poseUp(polar: number, azimuth: number): THREE.Vector3 {
  if (polar < 1e-4) {
    return new THREE.Vector3(-Math.sin(azimuth), Math.cos(azimuth), 0);
  }
  return new THREE.Vector3(0, 0, 1);
}

/** Ortho camera for a pose — mirrors the live controller's frustum convention. */
export function makeOrthoCamera(
  pose: CameraPose,
  viewport: Viewport,
  zoom: number,
): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(
    -viewport.width / 2,
    viewport.width / 2,
    viewport.height / 2,
    -viewport.height / 2,
    1,
    1e9,
  );
  camera.zoom = zoom;
  camera.up.copy(poseUp(pose.polar, pose.azimuth));
  camera.position
    .copy(pose.target)
    .addScaledVector(poseDirection(pose.polar, pose.azimuth), pose.distance);
  camera.lookAt(pose.target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

/** World point → screen px (origin top-left, y down). */
export function worldToScreen(
  point: THREE.Vector3,
  camera: THREE.Camera,
  viewport: Viewport,
): { x: number; y: number } {
  const v = point.clone().project(camera);
  return {
    x: ((v.x + 1) / 2) * viewport.width,
    y: ((1 - v.y) / 2) * viewport.height,
  };
}

/** Screen px → picking ray in world space (ortho). */
export function screenRay(
  x: number,
  y: number,
  camera: THREE.OrthographicCamera,
  viewport: Viewport,
): THREE.Ray {
  const ndcX = (x / viewport.width) * 2 - 1;
  const ndcY = 1 - (y / viewport.height) * 2;
  const origin = new THREE.Vector3(ndcX, ndcY, -1).unproject(camera);
  const dir = new THREE.Vector3(0, 0, -1)
    .transformDirection(camera.matrixWorld)
    .normalize();
  return new THREE.Ray(origin, dir);
}

/** Screen px → world point on the horizontal plane z = planeZ. */
export function screenToWorldOnPlaneZ(
  x: number,
  y: number,
  camera: THREE.OrthographicCamera,
  viewport: Viewport,
  planeZ: number,
): THREE.Vector3 | null {
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -planeZ);
  return screenRay(x, y, camera, viewport).intersectPlane(plane, new THREE.Vector3());
}

/** Clamp ortho zoom (px-per-mm) so mm-per-pixel stays inside the limits. */
export function clampOrthoZoom(zoom: number): number {
  return Math.min(1 / MIN_MM_PER_PX, Math.max(1 / MAX_MM_PER_PX, zoom));
}

export interface DerivedBoardView {
  /** Fabric viewport zoom (scene-px multiplier) = pxPerMm / MM_TO_PX. */
  zoom: number;
  /** Fabric viewport translation in CSS px. */
  panPxX: number;
  panPxY: number;
}

/**
 * The flat-equivalent Fabric viewport of a camera pose — POSE-based, never
 * target-based. camera-controls' `setOrbitPoint` (RMB pivot-under-cursor)
 * moves its target to the CURSOR point while keeping the view via a focal
 * offset, so the target does NOT project to the screen centre; deriving from
 * it makes the whole board jump to re-centre on the cursor the moment RMB
 * goes down. Unprojecting the actual screen centre onto the board plane is
 * correct in every target / focal-offset / azimuth state.
 */
export function deriveBoardViewFromCamera(
  camera: THREE.OrthographicCamera,
  viewport: Viewport,
  planeZ = 0,
  fallbackCenterWorld?: THREE.Vector3,
): DerivedBoardView {
  const pxPerMm = camera.zoom;
  const centerWorld =
    screenToWorldOnPlaneZ(
      viewport.width / 2,
      viewport.height / 2,
      camera,
      viewport,
      planeZ,
    ) ??
    fallbackCenterWorld ??
    new THREE.Vector3();
  const centerModel = worldPointToModel(centerWorld);
  return {
    zoom: pxPerMm / MM_TO_PX,
    panPxX: viewport.width / 2 - centerModel.x * pxPerMm,
    panPxY: viewport.height / 2 - centerModel.y * pxPerMm,
  };
}
