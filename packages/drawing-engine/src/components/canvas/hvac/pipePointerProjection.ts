import * as THREE from 'three';

import {
  closestPointBetweenRayAndAxis,
  createCameraFacingWorkplane,
  createWorkplane,
  intersectRayWithWorkplane,
  ndcPointToRay,
  resolveViewManipulationPolicy,
  type InteractionViewMode,
} from '../../../vrf/interaction/interaction-coordinate-service';

/**
 * Authoritative screen -> ray -> drawing-target -> world pipeline for pipe
 * placement. CSS client pixels are used throughout; the WebGL backing-buffer
 * size and devicePixelRatio deliberately never enter the calculation.
 */

export interface PointerCanvasRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PointerProjectionCoordinates {
  client: THREE.Vector2;
  canvas: THREE.Vector2;
  ndc: THREE.Vector2;
}

export type PipeDrawingPlaneKind =
  | 'floor'
  | 'wall'
  | 'ceiling'
  | 'equipment-face'
  | 'work-plane'
  | 'view-plane'
  | 'camera-facing';

export interface PipeDrawingPlane {
  id: string;
  kind: PipeDrawingPlaneKind;
  origin: THREE.Vector3;
  normal: THREE.Vector3;
  xAxis: THREE.Vector3;
  yAxis: THREE.Vector3;
  localToWorld: THREE.Matrix4;
  worldToLocal: THREE.Matrix4;
}

export interface DrawingSurfaceHit {
  id: string;
  kind: Exclude<PipeDrawingPlaneKind, 'work-plane' | 'view-plane' | 'camera-facing'>;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  xAxisHint?: THREE.Vector3;
}

export interface ResolveDrawingPlaneContext {
  explicitPlane?: PipeDrawingPlane | null;
  lockedPlane?: PipeDrawingPlane | null;
  surfaceHit?: DrawingSurfaceHit | null;
  viewPlane?: PipeDrawingPlane | null;
  viewMode?: InteractionViewMode;
  camera: THREE.Camera;
  anchor?: THREE.Vector3 | null;
  fallbackOrigin?: THREE.Vector3;
}

export interface PipePointerProjection {
  coordinates: PointerProjectionCoordinates;
  ray: THREE.Ray;
  plane: PipeDrawingPlane;
  rawWorldPoint: THREE.Vector3;
}

export type PipeAxisConstraint =
  | 'none'
  | 'local-x'
  | 'local-y'
  | 'world-x'
  | 'world-y'
  | 'world-z';

export type PipeSnapKind =
  | 'equipment-port'
  | 'pipe-endpoint'
  | 'fitting'
  | 'guide'
  | 'surface'
  | 'construction-plane';

export interface PipeSnapCandidate {
  id: string;
  kind: PipeSnapKind;
  point: THREE.Vector3;
  /** Distance from pointer to projected candidate in CSS screen pixels. */
  screenDistancePx: number;
}

export interface ResolvedPipeSnap {
  point: THREE.Vector3;
  candidate: PipeSnapCandidate | null;
}

const SNAP_PRIORITY: Record<PipeSnapKind, number> = {
  'equipment-port': 0,
  'pipe-endpoint': 1,
  fitting: 2,
  guide: 3,
  surface: 4,
  'construction-plane': 5,
};

const EPSILON = 1e-9;

function finitePositive(value: number): number {
  return Number.isFinite(value) && value > EPSILON ? value : 1;
}

export function getPointerNDC(
  clientX: number,
  clientY: number,
  canvasRect: PointerCanvasRect,
): PointerProjectionCoordinates {
  const width = finitePositive(canvasRect.width);
  const height = finitePositive(canvasRect.height);
  const canvas = new THREE.Vector2(clientX - canvasRect.left, clientY - canvasRect.top);
  return {
    client: new THREE.Vector2(clientX, clientY),
    canvas,
    ndc: new THREE.Vector2(
      (canvas.x / width) * 2 - 1,
      1 - (canvas.y / height) * 2,
    ),
  };
}

export function createPointerRay(ndc: THREE.Vector2, camera: THREE.Camera): THREE.Ray {
  return ndcPointToRay(ndc, camera);
}

function choosePlaneXAxis(normal: THREE.Vector3, hint?: THREE.Vector3): THREE.Vector3 {
  const n = normal.clone().normalize();
  const candidates = [
    hint,
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ].filter((candidate): candidate is THREE.Vector3 => Boolean(candidate));

  for (const candidate of candidates) {
    const projected = candidate.clone().addScaledVector(n, -candidate.dot(n));
    if (projected.lengthSq() > EPSILON) {
      return projected.normalize();
    }
  }
  return new THREE.Vector3(1, 0, 0);
}

export function createDrawingPlane(
  id: string,
  kind: PipeDrawingPlaneKind,
  origin: THREE.Vector3,
  normal: THREE.Vector3,
  xAxisHint?: THREE.Vector3,
): PipeDrawingPlane {
  const safeNormal = normal.lengthSq() > EPSILON
    ? normal.clone().normalize()
    : new THREE.Vector3(0, 0, 1);
  const xAxis = choosePlaneXAxis(safeNormal, xAxisHint);
  const yAxis = safeNormal.clone().cross(xAxis).normalize();
  const localToWorld = new THREE.Matrix4().makeBasis(xAxis, yAxis, safeNormal);
  localToWorld.setPosition(origin);
  return {
    id,
    kind,
    origin: origin.clone(),
    normal: safeNormal,
    xAxis,
    yAxis,
    localToWorld,
    worldToLocal: localToWorld.clone().invert(),
  };
}

export function planeLocalToWorld(
  local: THREE.Vector3,
  plane: PipeDrawingPlane,
): THREE.Vector3 {
  return local.clone().applyMatrix4(plane.localToWorld);
}

export function worldToPlaneLocal(
  world: THREE.Vector3,
  plane: PipeDrawingPlane,
): THREE.Vector3 {
  return world.clone().applyMatrix4(plane.worldToLocal);
}

export function intersectRayWithDrawingTarget(
  ray: THREE.Ray,
  target: PipeDrawingPlane,
): THREE.Vector3 | null {
  return intersectRayWithWorkplane(
    ray,
    createWorkplane(target.id, target.origin, target.normal, target.xAxis),
  );
}

export function createCameraFacingDrawingPlane(
  camera: THREE.Camera,
  origin: THREE.Vector3,
): PipeDrawingPlane {
  const workplane = createCameraFacingWorkplane(camera, origin);
  return createDrawingPlane(
    'camera-facing',
    'camera-facing',
    workplane.origin,
    workplane.normal,
    workplane.xAxis,
  );
}

export function createViewDefaultDrawingPlane(
  viewMode: InteractionViewMode,
  camera: THREE.Camera,
  origin: THREE.Vector3,
): PipeDrawingPlane {
  const policy = resolveViewManipulationPolicy(viewMode);
  switch (policy.defaultDragPlane) {
    case 'xy':
      return createDrawingPlane('view-default-xy', 'view-plane', origin, new THREE.Vector3(0, 0, 1));
    case 'xz':
      return createDrawingPlane('view-default-xz', 'view-plane', origin, new THREE.Vector3(0, 1, 0));
    case 'yz':
      return createDrawingPlane('view-default-yz', 'view-plane', origin, new THREE.Vector3(1, 0, 0));
    case 'camera-facing':
      return createCameraFacingDrawingPlane(camera, origin);
    default: {
      const exhaustive: never = policy.defaultDragPlane;
      return exhaustive;
    }
  }
}

/**
 * Stable priority: an explicitly selected work plane wins, then the plane
 * locked by the first click, then the currently raycast surface, the current
 * orthographic view plane, and finally a camera-facing plane through the route
 * anchor. A locked plane is never recomputed merely because the camera moves.
 */
export function resolveActiveDrawingPlane(
  context: ResolveDrawingPlaneContext,
): PipeDrawingPlane {
  if (context.explicitPlane) return context.explicitPlane;
  if (context.lockedPlane) return context.lockedPlane;
  if (context.surfaceHit) {
    return createDrawingPlane(
      context.surfaceHit.id,
      context.surfaceHit.kind,
      context.surfaceHit.point,
      context.surfaceHit.normal,
      context.surfaceHit.xAxisHint,
    );
  }
  if (context.viewPlane) return context.viewPlane;
  if (context.viewMode) {
    return createViewDefaultDrawingPlane(
      context.viewMode,
      context.camera,
      context.anchor ?? context.fallbackOrigin ?? new THREE.Vector3(),
    );
  }
  return createCameraFacingDrawingPlane(
    context.camera,
    context.anchor ?? context.fallbackOrigin ?? new THREE.Vector3(),
  );
}

export function projectPointerToDrawingPlane(
  clientX: number,
  clientY: number,
  canvasRect: PointerCanvasRect,
  camera: THREE.Camera,
  plane: PipeDrawingPlane,
): PipePointerProjection | null {
  const coordinates = getPointerNDC(clientX, clientY, canvasRect);
  const ray = createPointerRay(coordinates.ndc, camera);
  const rawWorldPoint = intersectRayWithDrawingTarget(ray, plane);
  if (!rawWorldPoint) return null;
  return { coordinates, ray, plane, rawWorldPoint };
}

export function applyPipeAxisConstraint(
  start: THREE.Vector3,
  candidate: THREE.Vector3,
  constraint: PipeAxisConstraint,
  plane: PipeDrawingPlane,
): THREE.Vector3 {
  if (constraint === 'none') return candidate.clone();

  const direction = (() => {
    switch (constraint) {
      case 'local-x': return plane.xAxis;
      case 'local-y': return plane.yAxis;
      case 'world-x': return new THREE.Vector3(1, 0, 0);
      case 'world-y': return new THREE.Vector3(0, 1, 0);
      case 'world-z': return new THREE.Vector3(0, 0, 1);
      default: return plane.xAxis;
    }
  })().clone().normalize();
  const displacement = candidate.clone().sub(start);
  return start.clone().addScaledVector(direction, displacement.dot(direction));
}

/**
 * Closest point on an infinite world axis to the current pointer ray. This is
 * the correct way to drive a Z riser (or an explicit axis handle) from any
 * camera angle; projecting a horizontal-plane hit onto Z cannot create an
 * elevation change.
 */
export function intersectPointerRayWithAxis(
  ray: THREE.Ray,
  axisOrigin: THREE.Vector3,
  axisDirection: THREE.Vector3,
): THREE.Vector3 | null {
  return closestPointBetweenRayAndAxis(ray, axisOrigin, axisDirection)?.point ?? null;
}

/** Priority first, then closest screen-space candidate within the tolerance. */
export function resolveSnappedPipePoint(
  rawWorldPoint: THREE.Vector3,
  candidates: readonly PipeSnapCandidate[],
  tolerancePx: number,
): ResolvedPipeSnap {
  const eligible = candidates
    .filter((candidate) => (
      Number.isFinite(candidate.screenDistancePx)
      && candidate.screenDistancePx >= 0
      && candidate.screenDistancePx <= Math.max(0, tolerancePx)
    ))
    .sort((left, right) => (
      SNAP_PRIORITY[left.kind] - SNAP_PRIORITY[right.kind]
      || left.screenDistancePx - right.screenDistancePx
      || left.id.localeCompare(right.id)
    ));
  const candidate = eligible[0] ?? null;
  return {
    point: candidate ? candidate.point.clone() : rawWorldPoint.clone(),
    candidate,
  };
}

export function worldPointScreenDistance(
  worldPoint: THREE.Vector3,
  canvasPoint: THREE.Vector2,
  camera: THREE.Camera,
  viewport: Pick<PointerCanvasRect, 'width' | 'height'>,
): number {
  camera.updateMatrixWorld(true);
  const projected = worldPoint.clone().project(camera);
  const x = (projected.x + 1) * 0.5 * finitePositive(viewport.width);
  const y = (1 - projected.y) * 0.5 * finitePositive(viewport.height);
  return Math.hypot(x - canvasPoint.x, y - canvasPoint.y);
}
