"use client";

import * as THREE from "three";

import { smoothstep } from "./projectionState";
export {
  getPlanProjectionVisualState,
  type ProjectionVisualState,
} from "./projectionState";

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function resolveProjectionCameraDirection(blend: number): THREE.Vector3 {
  const sceneBlend = smoothstep(0.15, 0.45, clamp01(blend));
  const start = new THREE.Vector3(-0.06, -0.08, 1).normalize();
  const end = new THREE.Vector3(-0.72, -0.86, 0.92).normalize();
  return start.lerp(end, sceneBlend).normalize();
}

export function fitPerspectiveCameraToBox(
  camera: THREE.PerspectiveCamera,
  box: THREE.Box3,
  width: number,
  height: number,
  direction: THREE.Vector3,
  margin = 1.1,
): THREE.Vector3 {
  const aspect = Math.max(width / Math.max(height, 1), 0.1);
  camera.aspect = aspect;
  camera.fov = 36;

  if (box.isEmpty()) {
    camera.near = 1;
    camera.far = 50000;
    camera.position.set(1200, 1200, 1200);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return new THREE.Vector3();
  }

  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const center = sphere.center.clone();
  const radius = Math.max(sphere.radius, 120);
  const safeDirection = direction.clone().normalize();
  const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * aspect);
  const limitingHalfFov = Math.max(
    Math.min(verticalHalfFov, horizontalHalfFov),
    THREE.MathUtils.degToRad(5),
  );
  const distance = Math.max(
    (radius / Math.sin(limitingHalfFov)) * margin,
    radius * 2.15,
  );

  camera.up.set(0, 0, 1);
  camera.position.copy(center).addScaledVector(safeDirection, distance);
  camera.near = Math.max(1, distance - radius * 4);
  camera.far = distance + radius * 8;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return center;
}

export function projectLabelAnchors(
  anchors: Array<{ key: string; position: THREE.Vector3; text: string; color: string }>,
  camera: THREE.Camera,
  width: number,
  height: number,
): Array<{ key: string; x: number; y: number; text: string; color: string }> {
  return anchors.flatMap((anchor) => {
    const projected = anchor.position.clone().project(camera);
    if (
      !Number.isFinite(projected.x) ||
      !Number.isFinite(projected.y) ||
      !Number.isFinite(projected.z) ||
      projected.z < -1 ||
      projected.z > 1
    ) {
      return [];
    }

    return [
      {
        key: anchor.key,
        x: ((projected.x + 1) / 2) * width,
        y: ((1 - projected.y) / 2) * height,
        text: anchor.text,
        color: anchor.color,
      },
    ];
  });
}
