import * as THREE from 'three';

import {
  clampOrthoZoom,
  poseDirection,
  poseUp,
  resolveHybridCameraViewPose,
  type HybridCameraView,
  type HybridCameraViewPose,
  type Viewport,
} from './hybridViewportMath';

export interface OrthographicFitResult {
  target: THREE.Vector3;
  zoom: number;
  screenRight: THREE.Vector3;
  screenUp: THREE.Vector3;
  spanX: number;
  spanY: number;
  paddingPx: number;
}

function boxCorners(bounds: THREE.Box3): THREE.Vector3[] {
  const result: THREE.Vector3[] = [];
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        result.push(new THREE.Vector3(x, y, z));
      }
    }
  }
  return result;
}

/**
 * Fits an orthographic pose without changing its orientation.
 *
 * `camera-controls.fitToBox` rounds the camera to its nearest principal axis,
 * which breaks true isometric and free-orbit poses. This solver projects all
 * eight box corners into the requested basis and derives the exact px/mm zoom.
 */
export function resolveOrthographicFitForPose(
  bounds: THREE.Box3,
  viewport: Viewport,
  pose: HybridCameraViewPose,
  requestedPaddingPx = 24,
): OrthographicFitResult | null {
  if (bounds.isEmpty()) return null;

  const cameraToTarget = poseDirection(pose.polar, pose.azimuth).negate();
  const nominalUp = poseUp(pose.polar, pose.azimuth).normalize();
  const screenRight = cameraToTarget.clone().cross(nominalUp).normalize();
  if (screenRight.lengthSq() <= 1e-12) return null;
  const screenUp = screenRight.clone().cross(cameraToTarget).normalize();
  const target = bounds.getCenter(new THREE.Vector3());

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const corner of boxCorners(bounds)) {
    const relative = corner.sub(target);
    const x = relative.dot(screenRight);
    const y = relative.dot(screenUp);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const maxPadding = Math.max(
    0,
    Math.min(viewport.width, viewport.height) / 2 - 0.5,
  );
  const paddingPx = Math.min(Math.max(0, requestedPaddingPx), maxPadding);
  const usableWidth = Math.max(1, viewport.width - paddingPx * 2);
  const usableHeight = Math.max(1, viewport.height - paddingPx * 2);
  const zoom = clampOrthoZoom(Math.min(usableWidth / spanX, usableHeight / spanY));

  return {
    target,
    zoom,
    screenRight,
    screenUp,
    spanX,
    spanY,
    paddingPx,
  };
}

export function resolveOrthographicFit(
  bounds: THREE.Box3,
  viewport: Viewport,
  view: HybridCameraView,
  requestedPaddingPx = 24,
): OrthographicFitResult | null {
  return resolveOrthographicFitForPose(
    bounds,
    viewport,
    resolveHybridCameraViewPose(view),
    requestedPaddingPx,
  );
}
