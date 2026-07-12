import * as THREE from 'three';

import type { Point2D } from '../../types';

export const MODEL_COORDINATE_SYSTEM = Object.freeze({
  unit: 'millimetre',
  plane: 'XY',
  elevationAxis: 'Z',
  x: 'right on the drawing board',
  y: 'down on the drawing board',
  z: 'elevation above the drawing board',
});

/**
 * The board basis (x right, y DOWN, z up) is left-handed while the three.js
 * render world is right-handed, so no camera rotation alone can show the plan
 * with the same orientation as the 2D board — a mirror is required. It is
 * applied exactly ONCE, at a permanent view-basis parent that wraps all model
 * content, and never anywhere else: model objects keep canonical coordinates,
 * and view/camera code must treat the basis as immutable for the app lifetime.
 */
export const MODEL_TO_WORLD_SCALE = Object.freeze({ x: 1, y: -1, z: 1 });

declare const process: { env: { NODE_ENV?: string } };

function isDevBuild(): boolean {
  try {
    // Bundlers statically replace `process.env.NODE_ENV`; anywhere it is not
    // replaced and `process` is missing we keep the assertions on.
    return process.env.NODE_ENV !== 'production';
  } catch {
    return true;
  }
}

/** True outside production builds — gates the O(scene) matrix snapshots. */
export const MODEL_SPACE_DEV_ASSERTIONS = isDevBuild();

const IDENTITY_QUATERNION = new THREE.Quaternion();

export interface ModelObjectMatrixSnapshot {
  id: string;
  parentId: string | null;
  matrixWorld: THREE.Matrix4;
  localPosition: THREE.Vector3;
  localQuaternion: THREE.Quaternion;
  localScale: THREE.Vector3;
}

export function modelPoint(point: Point2D, elevationMm: number): THREE.Vector3 {
  return new THREE.Vector3(point.x, point.y, elevationMm);
}

export function modelPointToWorld(point: Point2D, elevationMm = 0): THREE.Vector3 {
  return new THREE.Vector3(
    point.x * MODEL_TO_WORLD_SCALE.x,
    point.y * MODEL_TO_WORLD_SCALE.y,
    elevationMm * MODEL_TO_WORLD_SCALE.z,
  );
}

export function worldPointToModel(point: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(
    point.x / MODEL_TO_WORLD_SCALE.x,
    point.y / MODEL_TO_WORLD_SCALE.y,
    point.z / MODEL_TO_WORLD_SCALE.z,
  );
}

/** Stamp `node` as THE model→world view basis (see MODEL_TO_WORLD_SCALE). */
export function applyModelToWorldBasis(node: THREE.Object3D): void {
  node.position.set(0, 0, 0);
  node.quaternion.copy(IDENTITY_QUATERNION);
  node.scale.set(MODEL_TO_WORLD_SCALE.x, MODEL_TO_WORLD_SCALE.y, MODEL_TO_WORLD_SCALE.z);
  node.updateMatrixWorld(true);
}

export function getModelToWorldBasisIssue(
  node: THREE.Object3D,
  tolerance = 1e-9,
): string | null {
  if (node.position.lengthSq() > tolerance * tolerance) {
    return `position=${node.position.toArray().join(',')}`;
  }
  if (
    Math.abs(node.quaternion.x - IDENTITY_QUATERNION.x) > tolerance ||
    Math.abs(node.quaternion.y - IDENTITY_QUATERNION.y) > tolerance ||
    Math.abs(node.quaternion.z - IDENTITY_QUATERNION.z) > tolerance ||
    Math.abs(node.quaternion.w - IDENTITY_QUATERNION.w) > tolerance
  ) {
    return `quaternion=${node.quaternion.toArray().join(',')}`;
  }
  if (
    Math.abs(node.scale.x - MODEL_TO_WORLD_SCALE.x) > tolerance ||
    Math.abs(node.scale.y - MODEL_TO_WORLD_SCALE.y) > tolerance ||
    Math.abs(node.scale.z - MODEL_TO_WORLD_SCALE.z) > tolerance
  ) {
    return `scale=${node.scale.toArray().join(',')}`;
  }
  return null;
}

export function assertModelToWorldBasis(node: THREE.Object3D, label: string): void {
  const issue = getModelToWorldBasisIssue(node);
  if (!issue) {
    return;
  }

  console.assert(
    false,
    `${label} must remain the immutable model→world view basis; view/camera code must never modify it (${issue}).`,
  );
}

export function resetCanonicalModelRoot(root: THREE.Object3D): void {
  root.position.set(0, 0, 0);
  root.quaternion.copy(IDENTITY_QUATERNION);
  root.scale.set(1, 1, 1);
  root.updateMatrixWorld(true);
}

export function getCanonicalModelRootTransformIssue(
  root: THREE.Object3D,
  tolerance = 1e-9,
): string | null {
  if (root.position.lengthSq() > tolerance * tolerance) {
    return `position=${root.position.toArray().join(',')}`;
  }
  if (
    Math.abs(root.quaternion.x - IDENTITY_QUATERNION.x) > tolerance ||
    Math.abs(root.quaternion.y - IDENTITY_QUATERNION.y) > tolerance ||
    Math.abs(root.quaternion.z - IDENTITY_QUATERNION.z) > tolerance ||
    Math.abs(root.quaternion.w - IDENTITY_QUATERNION.w) > tolerance
  ) {
    return `quaternion=${root.quaternion.toArray().join(',')}`;
  }
  if (
    Math.abs(root.scale.x - 1) > tolerance ||
    Math.abs(root.scale.y - 1) > tolerance ||
    Math.abs(root.scale.z - 1) > tolerance
  ) {
    return `scale=${root.scale.toArray().join(',')}`;
  }
  return null;
}

export function assertCanonicalModelRoot(root: THREE.Object3D, label: string): void {
  const issue = getCanonicalModelRootTransformIssue(root);
  if (!issue) {
    return;
  }

  console.assert(
    false,
    `${label} must remain an identity model-space parent; camera/view code must not move the model root (${issue}).`,
  );
}

function objectSnapshotId(object: THREE.Object3D): string {
  // uuid, not name: duplicate names would collide in the snapshot map and a
  // moved duplicate could mask a real matrix change. Keep the name only for
  // readable change messages.
  return object.name ? `${object.uuid} (${object.name})` : object.uuid;
}

export function captureModelObjectMatrices(
  root: THREE.Object3D,
): Map<string, ModelObjectMatrixSnapshot> {
  root.updateMatrixWorld(true);
  const snapshots = new Map<string, ModelObjectMatrixSnapshot>();

  root.traverse((object) => {
    if (object === root) {
      return;
    }

    const id = objectSnapshotId(object);
    snapshots.set(id, {
      id,
      parentId: object.parent ? objectSnapshotId(object.parent) : null,
      matrixWorld: object.matrixWorld.clone(),
      localPosition: object.position.clone(),
      localQuaternion: object.quaternion.clone(),
      localScale: object.scale.clone(),
    });
  });

  return snapshots;
}

function matrixEquals(a: THREE.Matrix4, b: THREE.Matrix4, tolerance: number): boolean {
  const ae = a.elements;
  const be = b.elements;
  for (let index = 0; index < ae.length; index += 1) {
    if (Math.abs(ae[index]! - be[index]!) > tolerance) {
      return false;
    }
  }
  return true;
}

function vectorEquals(a: THREE.Vector3, b: THREE.Vector3, tolerance: number): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.z - b.z) <= tolerance
  );
}

function quaternionEquals(a: THREE.Quaternion, b: THREE.Quaternion, tolerance: number): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.z - b.z) <= tolerance &&
    Math.abs(a.w - b.w) <= tolerance
  );
}

export function getModelMatrixChanges(
  before: Map<string, ModelObjectMatrixSnapshot>,
  root: THREE.Object3D,
  tolerance = 1e-7,
): string[] {
  const after = captureModelObjectMatrices(root);
  const changes: string[] = [];

  before.forEach((snapshot, id) => {
    const current = after.get(id);
    if (!current) {
      changes.push(`${id}: missing after view update`);
      return;
    }
    if (snapshot.parentId !== current.parentId) {
      changes.push(`${id}: parent ${snapshot.parentId ?? '<none>'} -> ${current.parentId ?? '<none>'}`);
    }
    if (!vectorEquals(snapshot.localPosition, current.localPosition, tolerance)) {
      changes.push(`${id}: local position changed`);
    }
    if (!quaternionEquals(snapshot.localQuaternion, current.localQuaternion, tolerance)) {
      changes.push(`${id}: local rotation changed`);
    }
    if (!vectorEquals(snapshot.localScale, current.localScale, tolerance)) {
      changes.push(`${id}: local scale changed`);
    }
    if (!matrixEquals(snapshot.matrixWorld, current.matrixWorld, tolerance)) {
      changes.push(`${id}: world matrix changed`);
    }
  });

  return changes;
}
