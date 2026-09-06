/**
 * three.js adapter for the canonical pipe centerline (T1).
 *
 * Kept separate from {@link ./pipeCenterline} so the geometry core stays free of
 * any three.js import and is testable/runnable without it. This converts the
 * shared arc-spline into a three curve the 3D sweep can consume, so the 3D tube
 * is built from the SAME filleted centerline as the 2D Fabric/Konva paths.
 *
 * Arc primitives remain exact parametric circles in three.js. They are not
 * tessellated and then re-filleted, so the 3D sweep consumes the same centre,
 * radius and sweep that the SVG/Fabric path uses.
 */

import * as THREE from 'three';

import { worldTo3D } from '../coordinateTransform';

import type { PipeCenterline } from './pipeCenterline';
import { CircularArcCurve3 } from './three3d/pipeJointGeometry';

const EPSILON = 1e-6;
const Z_AXIS = new THREE.Vector3(0, 0, 1);

function signedSweep(startAngle: number, endAngle: number): number {
  let sweep = endAngle - startAngle;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  while (sweep < -Math.PI) sweep += Math.PI * 2;
  return sweep;
}

function offsetLinePoint(
  point: { x: number; y: number },
  direction: { x: number; y: number },
  offsetMm: number,
): { x: number; y: number } {
  return {
    x: point.x - direction.y * offsetMm,
    y: point.y + direction.x * offsetMm,
  };
}

/**
 * Builds a three.js `CurvePath` for the centerline at a given plan elevation
 * (mm). Plan (x, y) map straight through `worldTo3D`; the elevation becomes +Z.
 */
export function toCurvePath3D(
  centerline: PipeCenterline,
  elevationZMm: number,
  _tolMm = 0.5,
): THREE.CurvePath<THREE.Vector3> | null {
  return toOffsetCurvePath3D(centerline, elevationZMm, 0);
}

/**
 * Converts a canonical plan centerline to a parallel three.js path.
 *
 * Positive offsets are to the left of travel. Lines translate by their normal;
 * arcs retain their centre and adjust their radius, so two pair paths remain
 * exactly parallel and concentric through a bend.
 */
export function toOffsetCurvePath3D(
  centerline: PipeCenterline,
  elevationZMm: number,
  offsetMm: number,
): THREE.CurvePath<THREE.Vector3> | null {
  const path = new THREE.CurvePath<THREE.Vector3>();
  for (const segment of centerline.segments) {
    if (segment.type === 'line') {
      const dx = segment.b.x - segment.a.x;
      const dy = segment.b.y - segment.a.y;
      const length = Math.hypot(dx, dy);
      if (length <= EPSILON) continue;
      const direction = { x: dx / length, y: dy / length };
      const start = toVec3(
        offsetLinePoint(segment.a, direction, offsetMm),
        elevationZMm,
      );
      const end = toVec3(
        offsetLinePoint(segment.b, direction, offsetMm),
        elevationZMm,
      );
      if (start.distanceTo(end) > EPSILON) {
        path.add(new THREE.LineCurve3(start, end));
      }
      continue;
    }

    const sweep = signedSweep(segment.startAngle, segment.endAngle);
    const directionSign = Math.sign(sweep) || 1;
    const offsetRadius = segment.radius - directionSign * offsetMm;
    if (offsetRadius <= EPSILON) continue;
    const start = toVec3({
      x: segment.center.x + Math.cos(segment.startAngle) * offsetRadius,
      y: segment.center.y + Math.sin(segment.startAngle) * offsetRadius,
    }, elevationZMm);
    path.add(new CircularArcCurve3(
      toVec3(segment.center, elevationZMm),
      start,
      Z_AXIS,
      sweep,
    ));
  }
  return path.curves.length > 0 ? path : null;
}

function toVec3(p: { x: number; y: number }, elevationZMm: number): THREE.Vector3 {
  const v = worldTo3D(p, elevationZMm);
  return new THREE.Vector3(v.x, v.y, v.z);
}
