import * as THREE from "three";
import {
  mergeGeometries,
  mergeVertices,
} from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ADDITION, Brush, Evaluator } from "three-bvh-csg";

/**
 * Geometry helpers for refrigerant pipe / branch-kit joints.
 *
 * The legacy renderer drew every multi-segment pipe as a chain of independent
 * capped cylinders plus a full-radius sphere at each bend, and built branch
 * tees by simply overlapping cylinders. That produced bulbous "ball joints",
 * interpenetrating saddles and z-fighting seams.
 *
 * These helpers replace that with:
 *  - a single continuous swept `TubeGeometry` per run, with rounded-elbow
 *    fillets at interior vertices (no per-segment caps, no spheres), and
 *  - real boolean unions (three-bvh-csg) for tee/saddle/reducer assemblies,
 *    welded into one watertight geometry.
 *
 * Everything here returns plain `THREE.BufferGeometry` in the caller's local
 * coordinate space (transforms are baked in) so results are cacheable,
 * mergeable and union-able, and the caller wraps a single `THREE.Mesh`.
 */

const EPSILON = 1e-4;
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

let sharedEvaluator: Evaluator | null = null;

function getEvaluator(): Evaluator {
  if (!sharedEvaluator) {
    const evaluator = new Evaluator();
    // Keep normals + uv so the unioned result shades correctly without a
    // recompute that would round off the saddle crease.
    evaluator.attributes = ["position", "normal", "uv"];
    evaluator.useGroups = false;
    evaluator.consolidateMaterials = false;
    sharedEvaluator = evaluator;
  }
  return sharedEvaluator;
}

export interface SweptTubeOptions {
  radialSegments?: number;
  /** Target elbow fillet radius (mm). Clamped to half of each adjacent leg. */
  bendRadiusMm?: number;
  /** Approximate spacing between tube cross-sections along the path (mm). */
  sampleStepMm?: number;
  /** Add a flat disc cap at the start (default true). */
  capStart?: boolean;
  /** Add a flat disc cap at the end (default true). */
  capEnd?: boolean;
  /** Weld vertices so the result is a manifold solid (for CSG input). */
  weld?: boolean;
}

/**
 * Drop consecutive duplicate points and near-collinear interior vertices.
 * Ported from the original `createTubeAlongPoints` cleanup so behaviour is
 * unchanged for the simple cases.
 */
export function simplifyTubePoints(
  points: THREE.Vector3[],
  weldMm = 0.5,
  angleToleranceDeg = 2,
  lateralToleranceMm = 0.2,
): THREE.Vector3[] {
  const cleaned: THREE.Vector3[] = [];
  points.forEach((point) => {
    const previous = cleaned[cleaned.length - 1];
    if (!previous || previous.distanceTo(point) > weldMm) {
      cleaned.push(point.clone());
    }
  });
  if (cleaned.length < 3) {
    return cleaned;
  }

  const simplified: THREE.Vector3[] = [cleaned[0]!];
  const angleToleranceCos = Math.cos((angleToleranceDeg * Math.PI) / 180);
  for (let index = 1; index < cleaned.length - 1; index += 1) {
    const previous = simplified[simplified.length - 1]!;
    const current = cleaned[index]!;
    const next = cleaned[index + 1]!;
    const incoming = current.clone().sub(previous);
    const outgoing = next.clone().sub(current);
    if (incoming.length() < 0.01 || outgoing.length() < 0.01) {
      continue;
    }
    const directionDot = incoming.normalize().dot(outgoing.normalize());
    const direct = next.clone().sub(previous);
    const directLength = direct.length();
    if (directLength < 0.01) {
      continue;
    }
    const projectedScale =
      current.clone().sub(previous).dot(direct) / (directLength * directLength);
    const projectedPoint = previous
      .clone()
      .add(direct.multiplyScalar(projectedScale));
    const lateralOffset = projectedPoint.distanceTo(current);
    if (directionDot >= angleToleranceCos && lateralOffset <= lateralToleranceMm) {
      continue;
    }
    simplified.push(current);
  }
  simplified.push(cleaned[cleaned.length - 1]!);
  return simplified;
}

/**
 * Build a continuous curve through `points` with rounded-elbow fillets at each
 * interior vertex. Straight legs are `LineCurve3`; corners are
 * `QuadraticBezierCurve3`. Returns null if there are fewer than two distinct
 * points.
 */
export function buildTubeCurve(
  points: THREE.Vector3[],
  bendRadiusMm: number,
): THREE.CurvePath<THREE.Vector3> | null {
  if (points.length < 2) {
    return null;
  }

  const path = new THREE.CurvePath<THREE.Vector3>();

  if (points.length === 2) {
    path.add(new THREE.LineCurve3(points[0]!.clone(), points[1]!.clone()));
    return path;
  }

  // `cursor` tracks where the previous curve ended (a fillet exit, or the very
  // first point). For each interior vertex we draw a straight leg up to the
  // fillet entry, then the corner bezier.
  let cursor = points[0]!.clone();
  for (let index = 1; index < points.length - 1; index += 1) {
    const vertex = points[index]!;
    const next = points[index + 1]!;
    const inDir = vertex.clone().sub(cursor);
    const outDir = next.clone().sub(vertex);
    const inLen = inDir.length();
    const outLen = outDir.length();
    if (inLen < EPSILON || outLen < EPSILON) {
      continue;
    }
    inDir.normalize();
    outDir.normalize();

    const fillet = Math.max(
      0,
      Math.min(bendRadiusMm, inLen * 0.5, outLen * 0.5),
    );

    if (fillet < EPSILON) {
      path.add(new THREE.LineCurve3(cursor.clone(), vertex.clone()));
      cursor = vertex.clone();
      continue;
    }

    const filletEntry = vertex.clone().addScaledVector(inDir, -fillet);
    const filletExit = vertex.clone().addScaledVector(outDir, fillet);
    if (cursor.distanceTo(filletEntry) > EPSILON) {
      path.add(new THREE.LineCurve3(cursor.clone(), filletEntry));
    }
    path.add(
      new THREE.QuadraticBezierCurve3(filletEntry, vertex.clone(), filletExit),
    );
    cursor = filletExit;
  }

  const last = points[points.length - 1]!;
  if (cursor.distanceTo(last) > EPSILON) {
    path.add(new THREE.LineCurve3(cursor.clone(), last.clone()));
  }

  return path.curves.length > 0 ? path : null;
}

function buildEndCap(
  center: THREE.Vector3,
  tangentOutward: THREE.Vector3,
  radius: number,
  radialSegments: number,
): THREE.BufferGeometry {
  const cap = new THREE.CircleGeometry(radius, radialSegments);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    Z_AXIS,
    tangentOutward.clone().normalize(),
  );
  const matrix = new THREE.Matrix4()
    .makeRotationFromQuaternion(quaternion)
    .setPosition(center);
  cap.applyMatrix4(matrix);
  return cap;
}

/**
 * Build one continuous swept tube geometry for a poly-line centreline.
 * Replaces the legacy cylinder-chain-plus-spheres so corners are smooth and
 * there are no interior caps to z-fight.
 */
export function buildSweptTubeGeometry(
  points: THREE.Vector3[],
  radius: number,
  options: SweptTubeOptions = {},
): THREE.BufferGeometry | null {
  if (radius <= EPSILON) {
    return null;
  }
  const simplified = simplifyTubePoints(points);
  if (simplified.length < 2) {
    return null;
  }

  const radialSegments = Math.max(3, options.radialSegments ?? 24);
  const bendRadiusMm =
    options.bendRadiusMm ?? Math.max(radius * 1.5, 12);
  const curve = buildTubeCurve(simplified, bendRadiusMm);
  if (!curve) {
    return null;
  }

  const length = curve.getLength();
  const sampleStepMm = options.sampleStepMm ?? 8;
  const tubularSegments = Math.min(
    600,
    Math.max(2, Math.round(length / sampleStepMm)),
  );

  const tube = new THREE.TubeGeometry(
    curve,
    tubularSegments,
    radius,
    radialSegments,
    false,
  );

  const parts: THREE.BufferGeometry[] = [tube];
  const capStart = options.capStart ?? true;
  const capEnd = options.capEnd ?? true;

  if (capStart) {
    const start = curve.getPoint(0);
    const tangent = curve.getTangent(0).multiplyScalar(-1);
    parts.push(buildEndCap(start, tangent, radius, radialSegments));
  }
  if (capEnd) {
    const end = curve.getPoint(1);
    const tangent = curve.getTangent(1);
    parts.push(buildEndCap(end, tangent, radius, radialSegments));
  }

  let geometry: THREE.BufferGeometry;
  if (parts.length === 1) {
    geometry = tube;
  } else {
    const merged = mergeGeometries(parts, false);
    if (merged) {
      parts.forEach((part) => part.dispose());
      geometry = merged;
    } else {
      // Merge failed: keep the tube, drop the orphaned cap geometries.
      geometry = tube;
      parts.forEach((part) => {
        if (part !== tube) {
          part.dispose();
        }
      });
    }
  }

  if (options.weld) {
    const welded = mergeVertices(geometry, 1e-3);
    if (welded !== geometry) {
      geometry.dispose();
      geometry = welded;
    }
  }

  return geometry;
}

/**
 * Straight cylinder geometry between two points (baked transform), optionally
 * closed with end caps so it can feed a CSG union.
 */
export function buildCylinderGeometry(
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  radialSegments = 24,
  closed = true,
): THREE.BufferGeometry | null {
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length < EPSILON || radius <= EPSILON) {
    return null;
  }
  const geometry = new THREE.CylinderGeometry(
    radius,
    radius,
    length,
    radialSegments,
    1,
    !closed,
  );
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    Y_AXIS,
    delta.normalize(),
  );
  const center = start.clone().add(end).multiplyScalar(0.5);
  const matrix = new THREE.Matrix4()
    .makeRotationFromQuaternion(quaternion)
    .setPosition(center);
  geometry.applyMatrix4(matrix);
  return geometry;
}

/**
 * Tapered cylinder (reducer / cone) geometry between two points.
 */
export function buildReducerGeometry(
  start: THREE.Vector3,
  end: THREE.Vector3,
  startRadius: number,
  endRadius: number,
  radialSegments = 24,
  closed = true,
): THREE.BufferGeometry | null {
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length < EPSILON) {
    return null;
  }
  const geometry = new THREE.CylinderGeometry(
    Math.max(endRadius, EPSILON),
    Math.max(startRadius, EPSILON),
    length,
    radialSegments,
    1,
    !closed,
  );
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    Y_AXIS,
    delta.normalize(),
  );
  const center = start.clone().add(end).multiplyScalar(0.5);
  const matrix = new THREE.Matrix4()
    .makeRotationFromQuaternion(quaternion)
    .setPosition(center);
  geometry.applyMatrix4(matrix);
  return geometry;
}

/**
 * Boolean-union a set of (preferably closed) geometries into one watertight
 * geometry, so overlapping pipes / fittings share a clean exterior with no
 * interpenetrating surfaces. Falls back to a plain merge if CSG fails, so a
 * geometry edge case can never crash the renderer.
 */
export function unionGeometries(
  geometries: Array<THREE.BufferGeometry | null | undefined>,
): THREE.BufferGeometry | null {
  const valid = geometries.filter(
    (geometry): geometry is THREE.BufferGeometry => Boolean(geometry),
  );
  if (valid.length === 0) {
    return null;
  }
  if (valid.length === 1) {
    return valid[0]!;
  }

  try {
    const evaluator = getEvaluator();
    let result = new Brush(valid[0]!);
    result.updateMatrixWorld(true);
    for (let index = 1; index < valid.length; index += 1) {
      const next = new Brush(valid[index]!);
      next.updateMatrixWorld(true);
      const previous = result;
      result = evaluator.evaluate(previous, next, ADDITION);
      // Free the intermediate result geometry (never the original inputs).
      if (index > 1 && previous.geometry) {
        previous.geometry.dispose();
      }
    }
    // The inputs have been consumed into `result`; release their buffers.
    valid.forEach((geometry) => geometry.dispose());
    return result.geometry;
  } catch (error) {
    console.warn(
      "[pipeJointGeometry] CSG union failed, falling back to merge",
      error,
    );
    const merged = mergeGeometries(valid, false);
    valid.forEach((geometry) => geometry.dispose());
    return merged;
  }
}

/**
 * Dispose every geometry under an Object3D subtree. Shared (cached) materials
 * are intentionally left untouched.
 */
export function disposeGeometryTree(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
  });
}
