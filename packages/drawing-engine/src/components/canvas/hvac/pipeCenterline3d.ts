/**
 * three.js adapter for the canonical pipe centerline (T1).
 *
 * Kept separate from {@link ./pipeCenterline} so the geometry core stays free of
 * any three.js import and is testable/runnable without it. This converts the
 * shared arc-spline into a three curve the 3D sweep can consume, so the 3D tube
 * is built from the SAME filleted centerline as the 2D Fabric/Konva paths.
 *
 * NOTE (T1 scope): for now each arc is tessellated into short `LineCurve3`
 * chords within `tolMm`. T3 (3D geometry) replaces the chords with a parametric
 * arc curve + a rotation-minimising frame seed; that upgrade is intentionally
 * deferred. The important T1 invariant — 3D consumes the same centerline as 2D —
 * holds either way.
 */

import * as THREE from 'three';

import { worldTo3D } from '../coordinateTransform';

import type { PipeCenterline } from './pipeCenterline';
import { toPolyline } from './pipeCenterline';

/**
 * Builds a three.js `CurvePath` for the centerline at a given plan elevation
 * (mm). Plan (x, y) map straight through `worldTo3D`; the elevation becomes +Z.
 */
export function toCurvePath3D(
  centerline: PipeCenterline,
  elevationZMm: number,
  tolMm = 0.5,
): THREE.CurvePath<THREE.Vector3> | null {
  const pts = toPolyline(centerline, tolMm);
  if (pts.length < 2) {
    return null;
  }
  const path = new THREE.CurvePath<THREE.Vector3>();
  let prev = toVec3(pts[0]!, elevationZMm);
  for (let i = 1; i < pts.length; i += 1) {
    const curr = toVec3(pts[i]!, elevationZMm);
    if (prev.distanceTo(curr) > 1e-6) {
      path.add(new THREE.LineCurve3(prev, curr));
    }
    prev = curr;
  }
  return path.curves.length > 0 ? path : null;
}

function toVec3(p: { x: number; y: number }, elevationZMm: number): THREE.Vector3 {
  const v = worldTo3D(p, elevationZMm);
  return new THREE.Vector3(v.x, v.y, v.z);
}
