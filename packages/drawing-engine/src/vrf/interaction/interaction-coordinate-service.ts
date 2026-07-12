import * as THREE from 'three';

import {
  resolveViewManipulationPolicy,
  type DefaultDragPlane,
  type InteractionViewMode,
} from './view-manipulation-policy';

export {
  resolveViewManipulationPolicy,
  type CanonicalManipulationView,
  type DefaultDragPlane,
  type InteractionViewMode,
  type ManipulationAxis,
  type ManipulationPlane,
  type ViewManipulationPolicy,
} from './view-manipulation-policy';

const EPSILON = 1e-9;
const PARALLEL_EPSILON = 1e-7;

export interface InteractionViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface InteractionPointer {
  clientX: number;
  clientY: number;
  pointerId?: number;
}

export interface Workplane {
  id: string;
  origin: THREE.Vector3;
  normal: THREE.Vector3;
  xAxis?: THREE.Vector3;
  yAxis?: THREE.Vector3;
}

export interface CoordinateFrame {
  id: string;
  origin: THREE.Vector3;
  xAxis: THREE.Vector3;
  yAxis: THREE.Vector3;
  zAxis: THREE.Vector3;
  localToWorld: THREE.Matrix4;
  worldToLocal: THREE.Matrix4;
}

export interface CameraBasis {
  position: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  forward: THREE.Vector3;
}

export interface EquipmentPortFrameInput {
  id: string;
  positionLocal: THREE.Vector3;
  directionLocal: THREE.Vector3;
  upLocal?: THREE.Vector3;
  /** The complete equipment hierarchy transform. `Object3D.matrixWorld` is accepted directly. */
  equipmentWorld: THREE.Matrix4 | THREE.Object3D;
}

export interface SegmentFrame extends CoordinateFrame {
  length: number;
  isDegenerate: boolean;
}

export type TransformConstraint =
  | { kind: 'free' }
  | {
      kind: 'axis';
      origin?: THREE.Vector3;
      direction: THREE.Vector3;
    }
  | {
      kind: 'plane';
      workplane: Workplane;
    };

export interface InteractionContext {
  camera: THREE.Camera;
  viewport: InteractionViewport;
  viewMode: InteractionViewMode;
  activeWorkplane?: Workplane | null;
  selectedConstraint?: TransformConstraint | null;
}

export interface BeginDragOptions {
  anchorWorld: THREE.Vector3;
  frame?: CoordinateFrame;
  constraint?: TransformConstraint;
  /** Optional preselected free-drag plane. It is copied and frozen for the session. */
  dragPlane?: Workplane;
}

export interface ClosestAxisPoint {
  point: THREE.Vector3;
  scalar: number;
  rayScalar: number;
  usedFallback: boolean;
}

export interface PointerDeltaProjection {
  point: THREE.Vector3;
  delta: THREE.Vector3;
  scalar: number;
  usedFallback: boolean;
}

export interface FrozenDragContext {
  pointerId: number | null;
  anchorWorld: THREE.Vector3;
  frame: CoordinateFrame;
  constraint: TransformConstraint;
  plane: Workplane | null;
  axisOrigin: THREE.Vector3 | null;
  axisDirection: THREE.Vector3 | null;
  fallbackPlane: Workplane;
  startRay: THREE.Ray;
  startPoint: THREE.Vector3;
  startAxisScalar: number | null;
  /** Camera and viewport snapshots prevent a camera/store echo from changing drag math mid-gesture. */
  camera: THREE.Camera;
  viewport: InteractionViewport;
  viewMode: InteractionViewMode;
}

export interface DragUpdate {
  ray: THREE.Ray;
  worldPoint: THREE.Vector3;
  deltaWorld: THREE.Vector3;
  deltaLocal: THREE.Vector3;
  usedFallback: boolean;
  frameId: string;
}

export interface OrientationCandidate {
  id: string;
  orientation: THREE.Quaternion;
}

export interface NearestValidOrientation {
  id: string;
  index: number;
  orientation: THREE.Quaternion;
  angularDistanceDeg: number;
}

function finitePositive(value: number): number {
  return Number.isFinite(value) && value > EPSILON ? value : 1;
}

function safeUnit(value: THREE.Vector3, fallback: THREE.Vector3): THREE.Vector3 {
  return value.lengthSq() > EPSILON && value.toArray().every(Number.isFinite)
    ? value.clone().normalize()
    : fallback.clone().normalize();
}

function leastParallelAxis(direction: THREE.Vector3): THREE.Vector3 {
  const axes = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ];
  return axes.reduce((best, candidate) =>
    Math.abs(candidate.dot(direction)) < Math.abs(best.dot(direction)) ? candidate : best,
  );
}

function projectPerpendicular(value: THREE.Vector3, normal: THREE.Vector3): THREE.Vector3 {
  return value.clone().addScaledVector(normal, -value.dot(normal));
}

function cloneViewport(viewport: InteractionViewport): InteractionViewport {
  return {
    left: viewport.left,
    top: viewport.top,
    width: finitePositive(viewport.width),
    height: finitePositive(viewport.height),
  };
}

function cloneCamera(camera: THREE.Camera): THREE.Camera {
  const cloned = camera.clone();
  cloned.position.copy(camera.position);
  cloned.quaternion.copy(camera.quaternion);
  cloned.scale.copy(camera.scale);
  cloned.matrix.copy(camera.matrix);
  cloned.matrixWorld.copy(camera.matrixWorld);
  cloned.matrixWorldInverse.copy(camera.matrixWorldInverse);
  cloned.projectionMatrix.copy(camera.projectionMatrix);
  cloned.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
  cloned.updateMatrixWorld(true);
  return cloned;
}

export function createCoordinateFrame(
  id: string,
  origin: THREE.Vector3,
  xAxis: THREE.Vector3,
  yAxisHint: THREE.Vector3,
): CoordinateFrame {
  const x = safeUnit(xAxis, new THREE.Vector3(1, 0, 0));
  let y = projectPerpendicular(yAxisHint, x);
  if (y.lengthSq() <= EPSILON) y = projectPerpendicular(leastParallelAxis(x), x);
  y.normalize();
  const z = x.clone().cross(y).normalize();
  y = z.clone().cross(x).normalize();
  const localToWorld = new THREE.Matrix4().makeBasis(x, y, z);
  localToWorld.setPosition(origin);
  return {
    id,
    origin: origin.clone(),
    xAxis: x,
    yAxis: y,
    zAxis: z,
    localToWorld,
    worldToLocal: localToWorld.clone().invert(),
  };
}

export function createWorkplane(
  id: string,
  origin: THREE.Vector3,
  normal: THREE.Vector3,
  xAxisHint?: THREE.Vector3,
): Workplane {
  const n = safeUnit(normal, new THREE.Vector3(0, 0, 1));
  let x = projectPerpendicular(xAxisHint ?? new THREE.Vector3(1, 0, 0), n);
  if (x.lengthSq() <= EPSILON) x = projectPerpendicular(leastParallelAxis(n), n);
  x.normalize();
  return {
    id,
    origin: origin.clone(),
    normal: n,
    xAxis: x,
    yAxis: n.clone().cross(x).normalize(),
  };
}

export function ndcPointToRay(ndc: THREE.Vector2, camera: THREE.Camera): THREE.Ray {
  camera.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray.clone();
}

export function screenPointToRay(
  pointer: InteractionPointer | THREE.Vector2,
  camera: THREE.Camera,
  viewport: InteractionViewport,
): THREE.Ray {
  const clientX = pointer instanceof THREE.Vector2 ? pointer.x : pointer.clientX;
  const clientY = pointer instanceof THREE.Vector2 ? pointer.y : pointer.clientY;
  const width = finitePositive(viewport.width);
  const height = finitePositive(viewport.height);
  const ndc = new THREE.Vector2(
    ((clientX - viewport.left) / width) * 2 - 1,
    1 - ((clientY - viewport.top) / height) * 2,
  );
  return ndcPointToRay(ndc, camera);
}

export function intersectRayWithWorkplane(
  ray: THREE.Ray,
  workplane: Workplane,
  fallbackPlane?: Workplane | null,
  parallelEpsilon = PARALLEL_EPSILON,
): THREE.Vector3 | null {
  const intersect = (candidate: Workplane): THREE.Vector3 | null => {
    const normal = safeUnit(candidate.normal, new THREE.Vector3(0, 0, 1));
    if (Math.abs(ray.direction.dot(normal)) <= parallelEpsilon) return null;
    return ray.intersectPlane(
      new THREE.Plane().setFromNormalAndCoplanarPoint(normal, candidate.origin),
      new THREE.Vector3(),
    );
  };
  return intersect(workplane) ?? (fallbackPlane ? intersect(fallbackPlane) : null);
}

export function calculateCameraBasis(camera: THREE.Camera): CameraBasis {
  camera.updateMatrixWorld(true);
  const elements = camera.matrixWorld.elements;
  const right = safeUnit(
    new THREE.Vector3(elements[0], elements[1], elements[2]),
    new THREE.Vector3(1, 0, 0),
  );
  const up = safeUnit(
    new THREE.Vector3(elements[4], elements[5], elements[6]),
    new THREE.Vector3(0, 1, 0),
  );
  const forward = safeUnit(
    new THREE.Vector3(-elements[8], -elements[9], -elements[10]),
    new THREE.Vector3(0, 0, -1),
  );
  return {
    position: new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld),
    right,
    up,
    forward,
  };
}

export function createCameraFacingWorkplane(
  camera: THREE.Camera,
  origin: THREE.Vector3,
  id = 'camera-facing',
): Workplane {
  const basis = calculateCameraBasis(camera);
  return createWorkplane(id, origin, basis.forward.clone().negate(), basis.right);
}

export function closestPointBetweenRayAndAxis(
  ray: THREE.Ray,
  axisOrigin: THREE.Vector3,
  axisDirection: THREE.Vector3,
  fallbackPlane?: Workplane | null,
  parallelEpsilon = PARALLEL_EPSILON,
): ClosestAxisPoint | null {
  const rayDirection = safeUnit(ray.direction, new THREE.Vector3(0, 0, -1));
  const axis = safeUnit(axisDirection, new THREE.Vector3(1, 0, 0));
  const relativeOrigin = ray.origin.clone().sub(axisOrigin);
  const parallel = rayDirection.dot(axis);
  const denominator = 1 - parallel * parallel;

  if (Math.abs(denominator) > parallelEpsilon) {
    const rayOriginDot = rayDirection.dot(relativeOrigin);
    const axisOriginDot = axis.dot(relativeOrigin);
    const rayScalar = (parallel * axisOriginDot - rayOriginDot) / denominator;
    const scalar = axisOriginDot + parallel * rayScalar;
    if (Number.isFinite(scalar) && Number.isFinite(rayScalar)) {
      return {
        point: axisOrigin.clone().addScaledVector(axis, scalar),
        scalar,
        rayScalar,
        usedFallback: false,
      };
    }
  }

  if (!fallbackPlane) return null;
  const hit = intersectRayWithWorkplane(ray, fallbackPlane, null, parallelEpsilon);
  if (!hit) return null;
  const scalar = hit.clone().sub(axisOrigin).dot(axis);
  return {
    point: axisOrigin.clone().addScaledVector(axis, scalar),
    scalar,
    rayScalar: hit.clone().sub(ray.origin).dot(rayDirection),
    usedFallback: true,
  };
}

export function projectPointerDeltaToAxis(
  startRay: THREE.Ray,
  currentRay: THREE.Ray,
  axisOrigin: THREE.Vector3,
  axisDirection: THREE.Vector3,
  fallbackPlane: Workplane,
): PointerDeltaProjection | null {
  const start = closestPointBetweenRayAndAxis(startRay, axisOrigin, axisDirection, fallbackPlane);
  const current = closestPointBetweenRayAndAxis(currentRay, axisOrigin, axisDirection, fallbackPlane);
  if (!start || !current) return null;
  return {
    point: current.point,
    delta: current.point.clone().sub(start.point),
    scalar: current.scalar - start.scalar,
    usedFallback: start.usedFallback || current.usedFallback,
  };
}

export function projectPointerDeltaToPlane(
  startRay: THREE.Ray,
  currentRay: THREE.Ray,
  workplane: Workplane,
  fallbackPlane?: Workplane | null,
): PointerDeltaProjection | null {
  const start = intersectRayWithWorkplane(startRay, workplane, fallbackPlane);
  const current = intersectRayWithWorkplane(currentRay, workplane, fallbackPlane);
  if (!start || !current) return null;
  const normal = safeUnit(workplane.normal, new THREE.Vector3(0, 0, 1));
  const delta = current.clone().sub(start);
  return {
    point: current,
    delta,
    scalar: delta.length(),
    usedFallback:
      Math.abs(startRay.direction.dot(normal)) <= PARALLEL_EPSILON ||
      Math.abs(currentRay.direction.dot(normal)) <= PARALLEL_EPSILON,
  };
}

export function worldDeltaToLocalFrame(
  deltaWorld: THREE.Vector3,
  frame: CoordinateFrame,
): THREE.Vector3 {
  return deltaWorld.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(frame.worldToLocal));
}

export function localDeltaToWorldFrame(
  deltaLocal: THREE.Vector3,
  frame: CoordinateFrame,
): THREE.Vector3 {
  return deltaLocal.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(frame.localToWorld));
}

export function calculatePortWorldFrame(input: EquipmentPortFrameInput): CoordinateFrame {
  const matrix = input.equipmentWorld instanceof THREE.Object3D
    ? (() => {
        input.equipmentWorld.updateWorldMatrix(true, false);
        return input.equipmentWorld.matrixWorld;
      })()
    : input.equipmentWorld;
  const origin = input.positionLocal.clone().applyMatrix4(matrix);
  const transformedVector = (local: THREE.Vector3): THREE.Vector3 => {
    const tip = input.positionLocal.clone().add(safeUnit(local, new THREE.Vector3(1, 0, 0)));
    return tip.applyMatrix4(matrix).sub(origin);
  };
  const forward = safeUnit(
    transformedVector(input.directionLocal),
    new THREE.Vector3(1, 0, 0),
  );
  let up = projectPerpendicular(
    transformedVector(input.upLocal ?? leastParallelAxis(input.directionLocal)),
    forward,
  );
  if (up.lengthSq() <= EPSILON) up = projectPerpendicular(leastParallelAxis(forward), forward);
  up.normalize();
  const right = up.clone().cross(forward).normalize();
  const correctedUp = forward.clone().cross(right).normalize();
  return createCoordinateFrame(input.id, origin, right, correctedUp);
}

export function calculateSegmentFrame(
  start: THREE.Vector3,
  end: THREE.Vector3,
  upHint = new THREE.Vector3(0, 0, 1),
  fallbackDirection = new THREE.Vector3(1, 0, 0),
): SegmentFrame {
  const delta = end.clone().sub(start);
  const length = delta.length();
  const isDegenerate = !Number.isFinite(length) || length <= 1e-6;
  const direction = isDegenerate ? safeUnit(fallbackDirection, new THREE.Vector3(1, 0, 0)) : delta.normalize();
  let normal = projectPerpendicular(upHint, direction);
  if (normal.lengthSq() <= EPSILON) normal = projectPerpendicular(leastParallelAxis(direction), direction);
  const base = createCoordinateFrame('pipe-segment', start, direction, normal.normalize());
  return { ...base, length: isDegenerate ? 0 : length, isDegenerate };
}

function gravityUp(gravity: THREE.Vector3): THREE.Vector3 {
  return safeUnit(gravity, new THREE.Vector3(0, 0, -1)).negate();
}

export function calculateBranchPitchAngle(
  orientation: THREE.Quaternion,
  localForward = new THREE.Vector3(1, 0, 0),
  gravity = new THREE.Vector3(0, 0, -1),
): number {
  const forward = safeUnit(localForward.clone().applyQuaternion(orientation), new THREE.Vector3(1, 0, 0));
  const value = THREE.MathUtils.clamp(forward.dot(gravityUp(gravity)), -1, 1);
  return THREE.MathUtils.radToDeg(Math.asin(value));
}

export function calculateBranchRollAngle(
  orientation: THREE.Quaternion,
  localForward = new THREE.Vector3(1, 0, 0),
  localUp = new THREE.Vector3(0, 0, 1),
  gravity = new THREE.Vector3(0, 0, -1),
): number {
  const forward = safeUnit(localForward.clone().applyQuaternion(orientation), new THREE.Vector3(1, 0, 0));
  let actualUp = projectPerpendicular(localUp.clone().applyQuaternion(orientation), forward);
  if (actualUp.lengthSq() <= EPSILON) actualUp = projectPerpendicular(leastParallelAxis(forward), forward);
  actualUp.normalize();
  let referenceUp = projectPerpendicular(gravityUp(gravity), forward);
  if (referenceUp.lengthSq() <= EPSILON) referenceUp = projectPerpendicular(leastParallelAxis(forward), forward);
  referenceUp.normalize();
  return THREE.MathUtils.radToDeg(
    Math.atan2(
      forward.dot(referenceUp.clone().cross(actualUp)),
      THREE.MathUtils.clamp(referenceUp.dot(actualUp), -1, 1),
    ),
  );
}

export function findNearestValidOrientation(
  current: THREE.Quaternion,
  candidates: readonly (OrientationCandidate | THREE.Quaternion)[],
): NearestValidOrientation | null {
  let best: NearestValidOrientation | null = null;
  const normalizedCurrent = current.clone().normalize();
  candidates.forEach((candidate, index) => {
    const id = candidate instanceof THREE.Quaternion ? String(index) : candidate.id;
    const orientation = (candidate instanceof THREE.Quaternion
      ? candidate
      : candidate.orientation).clone().normalize();
    const dot = Math.abs(THREE.MathUtils.clamp(normalizedCurrent.dot(orientation), -1, 1));
    const angularDistanceDeg = THREE.MathUtils.radToDeg(2 * Math.acos(dot));
    if (!best || angularDistanceDeg < best.angularDistanceDeg - 1e-9) {
      best = { id, index, orientation, angularDistanceDeg };
    }
  });
  return best;
}

function defaultFrame(anchor: THREE.Vector3): CoordinateFrame {
  return createCoordinateFrame(
    'world',
    anchor,
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
  );
}

function defaultWorkplaneForView(
  plane: DefaultDragPlane,
  anchor: THREE.Vector3,
  camera: THREE.Camera,
): Workplane {
  switch (plane) {
    case 'xy':
      return createWorkplane(
        'view-default-xy',
        anchor,
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(1, 0, 0),
      );
    case 'xz':
      return createWorkplane(
        'view-default-xz',
        anchor,
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(1, 0, 0),
      );
    case 'yz':
      return createWorkplane(
        'view-default-yz',
        anchor,
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, 1, 0),
      );
    case 'camera-facing':
      return createCameraFacingWorkplane(camera, anchor, 'view-default-camera-facing');
    default: {
      const exhaustive: never = plane;
      return exhaustive;
    }
  }
}

export function beginDrag(
  pointer: InteractionPointer,
  context: InteractionContext,
  options: BeginDragOptions,
): FrozenDragContext | null {
  const camera = cloneCamera(context.camera);
  const viewport = cloneViewport(context.viewport);
  const constraint = options.constraint ?? context.selectedConstraint ?? { kind: 'free' };
  const frame = options.frame
    ? {
        ...options.frame,
        origin: options.frame.origin.clone(),
        xAxis: options.frame.xAxis.clone(),
        yAxis: options.frame.yAxis.clone(),
        zAxis: options.frame.zAxis.clone(),
        localToWorld: options.frame.localToWorld.clone(),
        worldToLocal: options.frame.worldToLocal.clone(),
      }
    : defaultFrame(options.anchorWorld);
  const fallbackPlane = createCameraFacingWorkplane(camera, options.anchorWorld, 'drag-fallback');
  const viewPolicy = resolveViewManipulationPolicy(context.viewMode);
  const viewDefaultPlane = defaultWorkplaneForView(
    viewPolicy.defaultDragPlane,
    options.anchorWorld,
    camera,
  );
  const selectedPlane = constraint.kind === 'plane'
    ? constraint.workplane
    : options.dragPlane ?? context.activeWorkplane ?? viewDefaultPlane;
  const plane = constraint.kind === 'axis'
    ? null
    : createWorkplane(
        selectedPlane.id,
        selectedPlane.origin,
        selectedPlane.normal,
        selectedPlane.xAxis,
      );
  const axisOrigin = constraint.kind === 'axis'
    ? (constraint.origin ?? options.anchorWorld).clone()
    : null;
  const axisDirection = constraint.kind === 'axis'
    ? safeUnit(constraint.direction, frame.xAxis)
    : null;
  const startRay = screenPointToRay(pointer, camera, viewport);
  let startPoint: THREE.Vector3 | null = null;
  let startAxisScalar: number | null = null;
  if (axisOrigin && axisDirection) {
    const axisHit = closestPointBetweenRayAndAxis(startRay, axisOrigin, axisDirection, fallbackPlane);
    startPoint = axisHit?.point ?? null;
    startAxisScalar = axisHit?.scalar ?? null;
  } else if (plane) {
    startPoint = intersectRayWithWorkplane(startRay, plane, fallbackPlane);
  }
  if (!startPoint) return null;
  return {
    pointerId: pointer.pointerId ?? null,
    anchorWorld: options.anchorWorld.clone(),
    frame,
    constraint,
    plane,
    axisOrigin,
    axisDirection,
    fallbackPlane,
    startRay,
    startPoint,
    startAxisScalar,
    camera,
    viewport,
    viewMode: context.viewMode,
  };
}

export function updateDrag(
  drag: FrozenDragContext,
  pointer: InteractionPointer,
): DragUpdate | null {
  if (drag.pointerId !== null && pointer.pointerId !== undefined && pointer.pointerId !== drag.pointerId) {
    return null;
  }
  const ray = screenPointToRay(pointer, drag.camera, drag.viewport);
  let deltaWorld: THREE.Vector3;
  let usedFallback = false;
  if (drag.axisOrigin && drag.axisDirection) {
    const current = closestPointBetweenRayAndAxis(
      ray,
      drag.axisOrigin,
      drag.axisDirection,
      drag.fallbackPlane,
    );
    if (!current || drag.startAxisScalar === null) return null;
    const scalar = current.scalar - drag.startAxisScalar;
    deltaWorld = drag.axisDirection.clone().multiplyScalar(scalar);
    usedFallback = current.usedFallback;
  } else if (drag.plane) {
    const current = intersectRayWithWorkplane(ray, drag.plane, drag.fallbackPlane);
    if (!current) return null;
    deltaWorld = current.sub(drag.startPoint);
    usedFallback = Math.abs(ray.direction.dot(drag.plane.normal)) <= PARALLEL_EPSILON;
  } else {
    return null;
  }
  return {
    ray,
    worldPoint: drag.anchorWorld.clone().add(deltaWorld),
    deltaWorld,
    deltaLocal: worldDeltaToLocalFrame(deltaWorld, drag.frame),
    usedFallback,
    frameId: drag.frame.id,
  };
}
