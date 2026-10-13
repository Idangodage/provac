/**
 * Refrigerant lines and condensate drains in the 3D views: the pipe and the
 * point on it under the pointer, the piece there (the same keys the plan uses,
 * so a piece has one card whichever view points at it), a piece's outline proxy
 * and the rings at its two ends (square to the pipe's own axis, risers
 * included), and a piece's box as the camera sees it (where its card goes).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import type { HvacElement } from '../../../types';
import {
  condensateFocusAtPoint,
  condensatePieceBounds3D,
  condensatePieceMidpoint,
  condensatePieceOf,
  condensateRunOf,
  type CondensatePiece,
} from '../hvac/condensate/condensatePieces';
import type { ScreenRect } from '../hvac/duct/popoverPlacement';
import type { Vec3 } from '../hvac/pipePortFrame';
import { KIT_KEY, refrigerantKitOf } from '../hvac/refrigerant/refrigerantKits';
import {
  pieceMidpoint,
  refrigerantFocusAtPoint,
  refrigerantLineOf,
  refrigerantPieceBounds3D,
  refrigerantPieceOf,
  type RefrigerantLine,
  type RefrigerantPiece,
} from '../hvac/refrigerant/refrigerantPieces';
import { isRefrigerantPipeElementType } from '../hvac/refrigerantPipePairModel';
import type { SegmentFocus } from '../hvac/segments/segmentUiStore';
import { modelPointToWorld } from '../modelSpace';

import { FOCUS_RING_MATERIAL, OUTLINE_PROXY_MATERIAL } from './postfx';

export interface PipeHit3D {
  elementId: string;
  /** The picked point on the pipe's surface (model mm, z up). */
  model: Vec3;
  distance: number;
}

/** The refrigerant or drain pipe nearest along the ray, and where on it, among the visible ones under `root`. */
export function raycastPipe(raycaster: THREE.Raycaster, root: THREE.Object3D): PipeHit3D | null {
  const pipes = root.children.filter((object) => {
    const type = object.userData.hvacElementType as HvacElement['type'] | undefined;
    return object.visible && type && (isRefrigerantPipeElementType(type) || type === 'condensate-pipe');
  });
  if (pipes.length === 0) return null;
  for (const hit of raycaster.intersectObjects(pipes, true)) {
    let node: THREE.Object3D | null = hit.object;
    while (node && node.parent !== root) node = node.parent;
    const elementId = node?.userData.hvacElementId as string | undefined;
    if (!elementId) continue;
    const local = root.worldToLocal(hit.point.clone());
    return { elementId, model: { x: local.x, y: local.y, z: local.z }, distance: hit.distance };
  }
  return null;
}

const lineIn = (scene: readonly HvacElement[], runId: string): RefrigerantLine | null => {
  const element = scene.find((candidate) => candidate.id === runId);
  return element ? refrigerantLineOf(element, scene) : null;
};

/** The piece of a refrigerant line at a picked model point, as a 3D focus, or null. */
export function refrigerantFocusAt(scene: readonly HvacElement[], runId: string, model: Vec3): SegmentFocus | null {
  return refrigerantFocusAtPoint(scene, runId, model, '3d');
}

/** The piece of a condensate drain at a picked model point, as a 3D focus, or null. */
export function condensateFocusAt(scene: readonly HvacElement[], runId: string, model: Vec3): SegmentFocus | null {
  return condensateFocusAtPoint(scene, runId, model, '3d');
}

/** The piece of a pipe of either service, a drain's own by its run, with its centreline and the pipe's outside radius. */
function pipePieceShape(scene: readonly HvacElement[], runId: string, key: string): { path: Vec3[]; radius: number; drainPiece: CondensatePiece | null } | null {
  const element = scene.find((candidate) => candidate.id === runId);
  if (!element) return null;
  if (element.type === 'condensate-pipe') {
    const run = condensateRunOf(element);
    const piece = run ? condensatePieceOf(run, key) : null;
    return run && piece ? { path: piece.path, radius: run.radiusMm, drainPiece: piece } : null;
  }
  const line = refrigerantLineOf(element, scene);
  const piece = line ? refrigerantPieceOf(line, key) : null;
  return line && piece ? { path: piece.path, radius: line.outsideDiameterMm / 2, drainPiece: null } : null;
}

/** A drain's fittings and joints are points on it: ringed by the plan, not bracketed at two ends. */
const DRAIN_POINT_KINDS = new Set<CondensatePiece['kind']>(['eye', 'vent', 'sleeve', 'end']);

/** A swept tube along a polyline: one ring of `sides` vertices per path point, its frame carried along the path. */
function tubeGeometry(path: readonly Vec3[], radius: number, sides = 16): THREE.BufferGeometry | null {
  const points = path.map((point) => new THREE.Vector3(point.x, point.y, point.z));
  const clean = points.filter((point, index) => index === 0 || point.distanceTo(points[index - 1]!) > 0.25);
  if (clean.length < 2) return null;
  const tangents = clean.map((_, index) => {
    const a = clean[Math.max(0, index - 1)]!;
    const b = clean[Math.min(clean.length - 1, index + 1)]!;
    return b.clone().sub(a).normalize();
  });
  // A normal square to the first tangent, then parallel-transported along the path (no twist).
  const first = tangents[0]!;
  let normal = new THREE.Vector3(0, 0, 1).cross(first);
  if (normal.lengthSq() < 1e-6) normal = new THREE.Vector3(1, 0, 0).cross(first);
  normal.normalize();
  const positions: number[] = [];
  const indices: number[] = [];
  for (let index = 0; index < clean.length; index += 1) {
    const tangent = tangents[index]!;
    if (index > 0) {
      const axis = tangents[index - 1]!.clone().cross(tangent);
      const angle = Math.asin(Math.min(1, axis.length()));
      if (angle > 1e-6) normal.applyAxisAngle(axis.normalize(), angle);
      normal.sub(tangent.clone().multiplyScalar(normal.dot(tangent))).normalize();
    }
    const binormal = tangent.clone().cross(normal).normalize();
    for (let side = 0; side < sides; side += 1) {
      const angle = (side / sides) * Math.PI * 2;
      const offset = normal.clone().multiplyScalar(Math.cos(angle) * radius).addScaledVector(binormal, Math.sin(angle) * radius);
      const vertex = clean[index]!.clone().add(offset);
      positions.push(vertex.x, vertex.y, vertex.z);
    }
  }
  for (let index = 0; index < clean.length - 1; index += 1) {
    for (let side = 0; side < sides; side += 1) {
      const a = index * sides + side;
      const b = index * sides + ((side + 1) % sides);
      const c = (index + 1) * sides + side;
      const d = (index + 1) * sides + ((side + 1) % sides);
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** A piece's outline proxy: its insulated surface (drawing nothing itself), or null. */
export function pipePieceProxy(scene: readonly HvacElement[], runId: string, key: string): THREE.Mesh | null {
  const shape = pipePieceShape(scene, runId, key);
  const geometry = !shape ? null
    : shape.drainPiece && DRAIN_POINT_KINDS.has(shape.drainPiece.kind) ? pointGeometry(shape)
      : tubeGeometry(shape.path, shape.radius + 1.5) ?? pointGeometry(shape);
  if (!geometry) return null;
  const mesh = new THREE.Mesh(geometry, OUTLINE_PROXY_MATERIAL);
  mesh.name = `pipe-segment-proxy-${runId}-${key}`;
  return mesh;
}

/** A ring stands this far clear of the pipe's insulation, its tube this thick (radius), mm. */
const END_RING_GAP_MM = 14;
const END_RING_TUBE_MM = 6;

function endRing(centre: Vec3, axis: THREE.Vector3, radius: number): THREE.BufferGeometry {
  const ring = new THREE.TorusGeometry(radius + END_RING_GAP_MM + END_RING_TUBE_MM, END_RING_TUBE_MM, 8, 48);
  // A torus lies in its XY plane: turn its Z axis onto the pipe's.
  ring.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis.clone().normalize()));
  ring.translate(centre.x, centre.y, centre.z);
  return ring;
}

/** A short drain fitting with no length to sweep: a ball round its point. */
function pointGeometry(shape: { path: Vec3[]; radius: number; drainPiece: CondensatePiece | null }): THREE.BufferGeometry | null {
  const at = shape.drainPiece?.point ?? shape.path[0];
  if (!at) return null;
  const ball = new THREE.SphereGeometry(shape.radius * 1.6 + 1.5, 20, 14);
  ball.translate(at.x, at.y, at.z);
  return ball;
}

/** Rings round a piece's two ends, square to the pipe's axis there (a riser's are level); none for a drain's fitting. */
export function pipePieceEndRings(scene: readonly HvacElement[], runId: string, key: string): THREE.Mesh | null {
  const shape = pipePieceShape(scene, runId, key);
  if (!shape || shape.path.length < 2 || (shape.drainPiece && DRAIN_POINT_KINDS.has(shape.drainPiece.kind))) return null;
  const at = (a: Vec3, b: Vec3) => new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
  const path = shape.path;
  const radius = shape.radius;
  const parts = [endRing(path[0]!, at(path[0]!, path[1]!), radius), endRing(path[path.length - 1]!, at(path[path.length - 2]!, path[path.length - 1]!), radius)];
  const geometry = mergeGeometries(parts, false);
  parts.forEach((part) => part.dispose());
  if (!geometry) return null;
  const mesh = new THREE.Mesh(geometry, FOCUS_RING_MATERIAL);
  mesh.name = `pipe-segment-ends-${runId}-${key}`;
  return mesh;
}

/** The meshes a pipe is drawn with (visible ones), for an outline of the whole line; none for another element. */
export function pipeElementMeshes(root: THREE.Object3D, elementId: string): THREE.Mesh[] {
  const group = root.children.find((object) => {
    const type = object.userData.hvacElementType as HvacElement['type'];
    return object.userData.hvacElementId === elementId && object.visible && (isRefrigerantPipeElementType(type) || type === 'condensate-pipe');
  });
  const meshes: THREE.Mesh[] = [];
  group?.traverse((object) => {
    if (object instanceof THREE.Mesh && object.visible) meshes.push(object);
  });
  return meshes;
}

function projectRect(points: readonly Vec3[], camera: THREE.Camera, host: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const point of points) {
    const clip = modelPointToWorld({ x: point.x, y: point.y }, point.z).project(camera);
    if (!Number.isFinite(clip.x) || !Number.isFinite(clip.y) || clip.z < -1 || clip.z > 1) continue;
    xs.push(host.left + ((clip.x + 1) / 2) * host.width);
    ys.push(host.top + ((1 - clip.y) / 2) * host.height);
  }
  return { xs, ys };
}

/** A piece's box as `camera` sees it, in client pixels of a canvas whose client rect is `host`; null when off the drawing. */
export function pipeSegmentClientRect3D(
  scene: readonly HvacElement[],
  focus: Pick<SegmentFocus, 'runId' | 'key'>,
  camera: THREE.Camera,
  host: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
): ScreenRect | null {
  if (host.width <= 0 || host.height <= 0) return null;
  // A branch kit's card: its plan outline at its level; a piece's: its box round its centreline.
  const kitElement = focus.key === KIT_KEY ? scene.find((candidate) => candidate.id === focus.runId) : undefined;
  const kit = kitElement ? refrigerantKitOf(kitElement) : null;
  const drainElement = scene.find((candidate) => candidate.id === focus.runId && candidate.type === 'condensate-pipe');
  const drain = drainElement ? condensateRunOf(drainElement) : null;
  const drainPiece = drain ? condensatePieceOf(drain, focus.key) : null;
  const line = kit || drain ? null : lineIn(scene, focus.runId);
  const piece: RefrigerantPiece | null = line ? refrigerantPieceOf(line, focus.key) : null;
  let bounds: { min: Vec3; max: Vec3 };
  let middle: Vec3;
  if (drain && drainPiece) {
    bounds = condensatePieceBounds3D(drain, drainPiece);
    middle = condensatePieceMidpoint(drainPiece);
  } else if (kit) {
    const xs = kit.outline.map((point) => point.x);
    const ys = kit.outline.map((point) => point.y);
    bounds = { min: { x: Math.min(...xs), y: Math.min(...ys), z: kit.levelMm - 60 }, max: { x: Math.max(...xs), y: Math.max(...ys), z: kit.levelMm + 60 } };
    middle = { x: kit.centre.x, y: kit.centre.y, z: kit.levelMm };
  } else if (line && piece) {
    bounds = refrigerantPieceBounds3D(line, piece);
    middle = pieceMidpoint(piece);
  } else return null;
  camera.updateMatrixWorld();
  const corners: Vec3[] = [];
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) corners.push({ x, y, z });
  const { xs, ys } = projectRect(corners, camera, host);
  if (xs.length === 0) return null;
  const rect: ScreenRect = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
  if (rect.right < host.left || rect.left > host.left + host.width || rect.bottom < host.top || rect.top > host.top + host.height) return null;
  const pin = projectRect([middle], camera, host);
  if (pin.xs.length) {
    rect.pinX = pin.xs[0]!;
    rect.pinY = pin.ys[0]!;
  }
  return rect;
}
