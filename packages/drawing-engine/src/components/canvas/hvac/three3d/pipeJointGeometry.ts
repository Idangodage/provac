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
  /**
   * Target circular-elbow centreline radius (mm). Callers must resolve this
   * from the document's pipe-routing policy; the 3D sweep must not invent a
   * renderer-local radius from the mesh radius.
   */
  bendRadiusMm: number;
  /** Plan routes already contain the coordinated pair's sampled concentric bends. */
  preservePlanGeometry?: boolean;
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
 * Exact circular arc in an arbitrary 3D plane.
 *
 * `THREE.EllipseCurve` is XY-only, while pipe risers can bend in any plane.
 * Rotating the start radius around the bend-plane normal preserves an exact
 * radius and gives TubeGeometry an analytic tangent at both line/arc joins.
 */
export class CircularArcCurve3 extends THREE.Curve<THREE.Vector3> {
  readonly radius: number;

  constructor(
    readonly center: THREE.Vector3,
    readonly start: THREE.Vector3,
    readonly planeNormal: THREE.Vector3,
    readonly sweepRadians: number,
  ) {
    super();
    this.center = center.clone();
    this.start = start.clone();
    this.planeNormal = planeNormal.clone().normalize();
    this.radius = this.start.distanceTo(this.center);
  }

  override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    return target
      .copy(this.start)
      .sub(this.center)
      .applyAxisAngle(this.planeNormal, this.sweepRadians * THREE.MathUtils.clamp(t, 0, 1))
      .add(this.center);
  }

  override getTangent(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const radial = this.getPoint(t, target).sub(this.center);
    return target
      .crossVectors(this.planeNormal, radial)
      .multiplyScalar(Math.sign(this.sweepRadians) || 1)
      .normalize();
  }

  override getLength(): number {
    return this.radius * Math.abs(this.sweepRadians);
  }
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

interface RecoveredPlanArc {
  startIndex: number;
  endIndex: number;
  curve: CircularArcCurve3;
}

/**
 * Recover the circles already authored by the plan model. Sampling a circle as
 * independent lines loses its exact tangent at the first/last tube ring. This
 * only accepts a run of at least four coplanar, co-circular samples, with small
 * consistently directed steps and verified tangent joins. It does not fit a
 * new fillet to a manual corner or change the stored radius/endpoints.
 */
function recoverSampledPlanArcs(points: THREE.Vector3[]): Map<number, RecoveredPlanArc> {
  const candidates: RecoveredPlanArc[] = [];
  for (let startIndex = 0; startIndex < points.length - 3;) {
    const a = points[startIndex]!;
    const b = points[startIndex + 1]!.clone().sub(a);
    const c = points[startIndex + 2]!.clone().sub(a);
    const denominator = 2 * (b.x * c.y - b.y * c.x);
    if (Math.abs(b.z) > EPSILON || Math.abs(c.z) > EPSILON || Math.abs(denominator) < 1e-8) {
      startIndex += 1;
      continue;
    }
    // Work relative to the first point so large drawing coordinates do not
    // reduce the precision of the circumcenter calculation.
    const center = new THREE.Vector3(
      a.x + (b.lengthSq() * c.y - c.lengthSq() * b.y) / denominator,
      a.y + (b.x * c.lengthSq() - c.x * b.lengthSq()) / denominator,
      a.z,
    );
    const radius = center.distanceTo(a);
    if (!Number.isFinite(radius) || radius < EPSILON) {
      startIndex += 1;
      continue;
    }
    const radialTolerance = Math.max(EPSILON, radius * 1e-7);
    let endIndex = startIndex;
    let sweepRadians = 0;
    let direction = 0;
    let previousRadial = a.clone().sub(center);
    for (let index = startIndex + 1; index < points.length; index += 1) {
      const point = points[index]!;
      const radial = point.clone().sub(center);
      if (Math.abs(point.z - a.z) > EPSILON || Math.abs(radial.length() - radius) > radialTolerance) break;
      const step = Math.atan2(previousRadial.x * radial.y - previousRadial.y * radial.x, previousRadial.dot(radial));
      if (Math.abs(step) < 1e-7 || Math.abs(step) > Math.PI / 12 + 1e-7
        || (direction !== 0 && Math.sign(step) !== direction)
        || Math.abs(sweepRadians + step) > Math.PI + 1e-7) break;
      direction = Math.sign(step);
      sweepRadians += step;
      previousRadial = radial;
      endIndex = index;
    }
    if (endIndex - startIndex < 3) {
      startIndex += 1;
      continue;
    }
    const curve = new CircularArcCurve3(center, a, Z_AXIS, sweepRadians);
    if (curve.getPoint(1).distanceTo(points[endIndex]!) > EPSILON) {
      startIndex += 1;
      continue;
    }
    candidates.push({ startIndex, endIndex, curve });
    // Adjacent reverse-curvature circles can share one tangent point.
    startIndex = endIndex;
  }

  const starts = new Map(candidates.map(arc => [arc.startIndex, arc]));
  const ends = new Map(candidates.map(arc => [arc.endIndex, arc]));
  const accepted = new Set(candidates);
  const sameHeading = (a: THREE.Vector3, b: THREE.Vector3): boolean => a.dot(b) > 1 - 1e-8;
  let changed = true;
  while (changed) {
    changed = false;
    for (const arc of accepted) {
      const previous = ends.get(arc.startIndex);
      const next = starts.get(arc.endIndex);
      const incoming = previous && accepted.has(previous) ? previous.curve.getTangent(1)
        : arc.startIndex > 0 ? points[arc.startIndex]!.clone().sub(points[arc.startIndex - 1]!).normalize() : null;
      const outgoing = next && accepted.has(next) ? next.curve.getTangent(0)
        : arc.endIndex < points.length - 1 ? points[arc.endIndex + 1]!.clone().sub(points[arc.endIndex]!).normalize() : null;
      if ((incoming && !sameHeading(incoming, arc.curve.getTangent(0)))
        || (outgoing && !sameHeading(arc.curve.getTangent(1), outgoing))) {
        accepted.delete(arc);
        changed = true;
      }
    }
  }
  return new Map([...accepted].map(arc => [arc.startIndex, arc]));
}

/**
 * Build a continuous curve through `points` with rounded-elbow fillets at each
 * interior vertex. Straight legs are `LineCurve3`; corners are exact circular
 * arcs in the plane of their adjacent legs. Returns null if there are fewer
 * than two distinct points.
 */
export function buildTubeCurve(
  points: THREE.Vector3[],
  bendRadiusMm: number,
  preservePlanGeometry = false,
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
  // fillet entry, then the exact circular arc.
  let cursor = points[0]!.clone();
  const planArcs = preservePlanGeometry ? recoverSampledPlanArcs(points) : new Map<number, RecoveredPlanArc>();
  for (let index = planArcs.has(0) ? 0 : 1; index < points.length - 1; index += 1) {
    const planArc = planArcs.get(index);
    if (planArc) {
      const entry = points[index]!;
      if (cursor.distanceTo(entry) > EPSILON) path.add(new THREE.LineCurve3(cursor.clone(), entry.clone()));
      path.add(planArc.curve);
      cursor = points[planArc.endIndex]!.clone();
      index = planArc.endIndex - 1;
      continue;
    }
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

    const turnRadians = Math.acos(THREE.MathUtils.clamp(inDir.dot(outDir), -1, 1));
    const bendPlaneNormal = new THREE.Vector3().crossVectors(inDir, outDir);
    if (
      turnRadians < EPSILON
      || turnRadians > Math.PI - EPSILON
      || bendPlaneNormal.lengthSq() < EPSILON * EPSILON
      || bendRadiusMm <= EPSILON
      || (preservePlanGeometry && Math.abs(inDir.z) < EPSILON && Math.abs(outDir.z) < EPSILON)
    ) {
      path.add(new THREE.LineCurve3(cursor.clone(), vertex.clone()));
      cursor = vertex.clone();
      continue;
    }

    bendPlaneNormal.normalize();
    const tangentFactor = Math.tan(turnRadians / 2);
    const desiredSetback = bendRadiusMm * tangentFactor;
    const setback = Math.max(
      0,
      // The incoming length starts at the previous fillet's exit, so its
      // reserved bend space has already been consumed. Halving it again
      // shrinks the second elbow of an otherwise buildable 2R riser to R/2.
      // Only the untouched outgoing leg needs space reserved for its next bend.
      Math.min(desiredSetback, inLen, outLen * 0.5),
    );
    if (setback < EPSILON || tangentFactor < EPSILON) {
      path.add(new THREE.LineCurve3(cursor.clone(), vertex.clone()));
      cursor = vertex.clone();
      continue;
    }
    const effectiveRadius = setback / tangentFactor;
    const filletEntry = vertex.clone().addScaledVector(inDir, -setback);
    const filletExit = vertex.clone().addScaledVector(outDir, setback);
    const inwardNormal = new THREE.Vector3()
      .crossVectors(bendPlaneNormal, inDir)
      .normalize();
    const center = filletEntry
      .clone()
      .addScaledVector(inwardNormal, effectiveRadius);
    if (cursor.distanceTo(filletEntry) > EPSILON) {
      path.add(new THREE.LineCurve3(cursor.clone(), filletEntry));
    }
    const arc = new CircularArcCurve3(
      center,
      filletEntry,
      bendPlaneNormal,
      turnRadians,
    );
    // Pin construction drift at the tangent endpoint before accepting the arc.
    if (arc.getPoint(1).distanceTo(filletExit) > 1e-3) {
      path.add(new THREE.LineCurve3(filletEntry, vertex.clone()));
      cursor = vertex.clone();
      continue;
    }
    path.add(arc);
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
  options: SweptTubeOptions,
): THREE.BufferGeometry | null {
  if (radius <= EPSILON) {
    return null;
  }
  // Do not remove a shallow circle's exact tangent endpoint before recovery.
  // Only duplicate/actually collinear samples may be discarded on model paths.
  const simplified = options.preservePlanGeometry
    ? simplifyTubePoints(points, 1e-6, 1e-4, 1e-6)
    : simplifyTubePoints(points);
  if (simplified.length < 2) {
    return null;
  }

  const curve = buildTubeCurve(
    simplified,
    Math.max(0, options.bendRadiusMm),
    options.preservePlanGeometry,
  );
  if (!curve) {
    return null;
  }

  return buildSweptTubeGeometryFromCurve(curve, radius, options);
}

export type SweptTubeCurveOptions = Omit<SweptTubeOptions, "bendRadiusMm">;

/**
 * TubeGeometry normally distributes all rings by total route length. On long
 * runs that skips over small elbows, cutting diagonally across their centreline.
 * Allocate rings to each curve instead: straight spans need only their ends,
 * while circular bends retain the same angular detail at every route length.
 */
function adaptTubeCurveSampling(
  source: THREE.Curve<THREE.Vector3>,
  sampleStepMm: number,
): { curve: THREE.Curve<THREE.Vector3>; segments: number } {
  if (!(source instanceof THREE.CurvePath)) {
    return {
      curve: source,
      segments: Math.min(600, Math.max(2, Math.ceil(source.getLength() / sampleStepMm))),
    };
  }

  const points: THREE.Vector3[] = [];
  const tangents: THREE.Vector3[] = [];
  for (const part of source.curves) {
    const divisions = part instanceof THREE.LineCurve3
      ? 1
      : part instanceof CircularArcCurve3
        ? Math.max(2, Math.ceil(Math.abs(part.sweepRadians) / (Math.PI / 48)))
        : Math.min(256, Math.max(2, Math.ceil(part.getLength() / sampleStepMm)));
    for (let index = 0; index <= divisions; index += 1) {
      const t = index / divisions;
      const point = part.getPoint(t);
      const tangent = part.getTangent(t).normalize();
      const previous = points[points.length - 1];
      if (previous && previous.distanceToSquared(point) < EPSILON * EPSILON) {
        // Adjacent sampled chords share a ring with a bisecting normal, giving
        // a smooth sleeve while preserving every authoritative plan vertex.
        const previousTangent = tangents[tangents.length - 1]!;
        const bisector = previousTangent.clone().add(tangent);
        if (bisector.lengthSq() > EPSILON * EPSILON) previousTangent.copy(bisector.normalize());
        continue;
      }
      points.push(point);
      tangents.push(tangent);
    }
  }

  class SampledTubeCurve extends THREE.Curve<THREE.Vector3> {
    constructor() { super(); }

    override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
      const station = THREE.MathUtils.clamp(t, 0, 1) * (points.length - 1);
      const index = Math.min(Math.floor(station), points.length - 2);
      return target.copy(points[index]!).lerp(points[index + 1]!, station - index);
    }

    override getPointAt(t: number, target = new THREE.Vector3()): THREE.Vector3 {
      return this.getPoint(t, target);
    }

    override getTangent(t: number, target = new THREE.Vector3()): THREE.Vector3 {
      const station = THREE.MathUtils.clamp(t, 0, 1) * (tangents.length - 1);
      const index = Math.min(Math.floor(station), tangents.length - 2);
      return target.copy(tangents[index]!).lerp(tangents[index + 1]!, station - index).normalize();
    }

    override getTangentAt(t: number, target = new THREE.Vector3()): THREE.Vector3 {
      return this.getTangent(t, target);
    }
  }

  if (points.length < 2) return { curve: source, segments: 2 };
  return { curve: new SampledTubeCurve(), segments: points.length - 1 };
}

/**
 * Sweeps a tube over an already-canonical curve. This is the adapter boundary
 * used by `pipeCenterline3d`: its circular arcs are authoritative, so no second
 * corner fillet is applied here.
 */
export function buildSweptTubeGeometryFromCurve(
  curve: THREE.Curve<THREE.Vector3>,
  radius: number,
  options: SweptTubeCurveOptions = {},
): THREE.BufferGeometry | null {
  if (radius <= EPSILON) {
    return null;
  }
  const radialSegments = Math.max(3, options.radialSegments ?? 24);
  const sampleStepMm = Math.max(0.1, options.sampleStepMm ?? 8);
  const sampling = adaptTubeCurveSampling(curve, sampleStepMm);

  const tube = new THREE.TubeGeometry(
    sampling.curve,
    sampling.segments,
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
