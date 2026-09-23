/**
 * Pipe design skeleton — the editable abstraction behind a fabrication route.
 *
 * A stored pipe route is a FABRICATION polyline: it carries arc tessellation
 * (~4mm chords), port stubs, 45-degree takeoff fans and body detours as ordinary
 * vertices. A generated route reaches ~77 points for four real corners. Editing
 * that polyline directly is what makes generated pipes uneditable — there are no
 * corner handles, and any direction change invalidates the arc chords beside it.
 *
 * This module recovers the DESIGN geometry from the fabrication polyline: sharp
 * corners, one per real fitting, plus the joint (turn angle, bend plane, radius,
 * takeoff) and leg (direction, length, material, minimum straight) records the
 * adaptive solver reasons about.
 *
 * It is the 3D inverse of {@link ./fieldPipeBends#buildCircularFieldPipeSegments}
 * and the model-space counterpart of `PipeStudioOverlay#reconstructCorners`,
 * which already performs the same decimation in plan for RENDERING. The two use
 * the same 12mm leg threshold on purpose: arc chords sample at <=~10mm while the
 * shortest real fitting legs (port stubs, risers, gathers) are tens of mm.
 *
 * PURE: geometry in, geometry out. No element, store, React or renderer imports,
 * so the round trip is unit-tested in isolation.
 */

import type { PipeRouteNode3D } from './pipeRoute3d';
import type { RefrigerantPipeMaterial } from './refrigerantPipePairModel';

/** Within this heading change (rad, ~11.5deg) a segment continues its leg. */
const HEADING_TOLERANCE = 0.2;
/** Below this length (mm) a run is bend tessellation, not a real leg. */
const MINIMUM_LEG_MM = 12;
const EPSILON = 1e-9;

export interface PipeSkeletonJoint {
  /** Index of the corner in {@link PipeSkeleton.nodes}. */
  index: number;
  /** Turn between the incoming and outgoing legs, 0..180. */
  angleDeg: number;
  /**
   * Unit normal of the plane containing both legs — the degree of freedom that
   * distinguishes a vertical bend from a horizontal one. Rolling this normal
   * about the incoming leg is how the solver re-orients a fitting in place.
   */
  planeNormal: PipeRouteNode3D;
  /** Centreline bend radius recovered from the tessellated arc, when present. */
  radiusMm: number;
  /** Straight consumed on each leg by the fitting: radius * tan(angle / 2). */
  takeoffMm: number;
  /** True when the corner was recovered from sampled arc chords. */
  filleted: boolean;
}

export interface PipeSkeletonLeg {
  /** Leg between nodes[index] and nodes[index + 1]. */
  index: number;
  material: RefrigerantPipeMaterial;
  lengthMm: number;
  /** Unit direction from nodes[index] towards nodes[index + 1]. */
  direction: PipeRouteNode3D;
}

export interface PipeSkeleton {
  /** Sharp design corners, endpoints preserved exactly. */
  nodes: PipeRouteNode3D[];
  /** One entry per interior corner. */
  joints: PipeSkeletonJoint[];
  /** One entry per leg. */
  legs: PipeSkeletonLeg[];
  /**
   * For each skeleton node, the index of the source polyline node it came from.
   * Lets a selection made against the stored route address the design corner.
   */
  sourceIndices: number[];
  /** True when the source polyline carried tessellation that was collapsed. */
  decimated: boolean;
}

const add = (a: PipeRouteNode3D, b: PipeRouteNode3D): PipeRouteNode3D =>
  ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const subtract = (a: PipeRouteNode3D, b: PipeRouteNode3D): PipeRouteNode3D =>
  ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a: PipeRouteNode3D, amount: number): PipeRouteNode3D =>
  ({ x: a.x * amount, y: a.y * amount, z: a.z * amount });
const dot = (a: PipeRouteNode3D, b: PipeRouteNode3D): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: PipeRouteNode3D, b: PipeRouteNode3D): PipeRouteNode3D =>
  ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const magnitude = (a: PipeRouteNode3D): number => Math.hypot(a.x, a.y, a.z);
const distance = (a: PipeRouteNode3D, b: PipeRouteNode3D): number => magnitude(subtract(a, b));

export function normalizeVector(a: PipeRouteNode3D): PipeRouteNode3D | null {
  const length = magnitude(a);
  return Number.isFinite(length) && length > EPSILON ? scale(a, 1 / length) : null;
}

/** Turn between two unit directions, in degrees (0 straight, 180 reversal). */
export function turnDegrees(incoming: PipeRouteNode3D, outgoing: PipeRouteNode3D): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(incoming, outgoing)))) * 180 / Math.PI;
}

/**
 * Plane of the turn. A straight pass-through has no defined plane, so the
 * caller receives a deterministic perpendicular instead of a zero vector —
 * a collinear joint must still carry a rollable frame for the solver.
 */
export function bendPlaneNormal(incoming: PipeRouteNode3D, outgoing: PipeRouteNode3D): PipeRouteNode3D {
  const normal = normalizeVector(cross(incoming, outgoing));
  if (normal) return normal;
  const reference = Math.abs(incoming.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  return normalizeVector(cross(incoming, reference)) ?? { x: 0, y: 0, z: 1 };
}

/** Rotate `vector` about a unit `axis` by `angle` radians (Rodrigues). */
export function rotateAboutAxis(vector: PipeRouteNode3D, axis: PipeRouteNode3D, angle: number): PipeRouteNode3D {
  const cosine = Math.cos(angle);
  return add(
    add(scale(vector, cosine), scale(cross(axis, vector), Math.sin(angle))),
    scale(axis, dot(axis, vector) * (1 - cosine)),
  );
}

/**
 * Point where two 3D leg lines meet. Real routes are built from coplanar
 * fittings, but an edited chain can leave neighbouring lines skew; the midpoint
 * of the common perpendicular is the least-surprising corner in that case and
 * the caller decides whether the residual is acceptable.
 */
export function intersectLegLines(
  originA: PipeRouteNode3D, directionA: PipeRouteNode3D,
  originB: PipeRouteNode3D, directionB: PipeRouteNode3D,
): { point: PipeRouteNode3D; gapMm: number } | null {
  const separation = subtract(originB, originA);
  const aa = dot(directionA, directionA);
  const ab = dot(directionA, directionB);
  const bb = dot(directionB, directionB);
  const denominator = aa * bb - ab * ab;
  if (Math.abs(denominator) < 1e-12) return null;
  const ac = dot(directionA, separation);
  const bc = dot(directionB, separation);
  const alongA = (ac * bb - ab * bc) / denominator;
  const alongB = (ab * ac - aa * bc) / denominator;
  const pointA = add(originA, scale(directionA, alongA));
  const pointB = add(originB, scale(directionB, alongB));
  return { point: scale(add(pointA, pointB), 0.5), gapMm: distance(pointA, pointB) };
}

interface RunSegment { startIndex: number; endIndex: number; lengthMm: number; direction: PipeRouteNode3D }
interface Run extends RunSegment {
  /**
   * The single longest segment inside the run. A real leg contains one long
   * straight; a tessellated fillet contains only short chords. Measuring the
   * LONGEST SEGMENT rather than the accumulated run length is what separates
   * them: several chords in a row accumulate past any fixed leg threshold, and
   * the straight's own line is the one that actually locates the corner.
   */
  longest: RunSegment;
}

/** Group consecutive segments into straight runs by accumulated heading change. */
function collectRuns(nodes: readonly PipeRouteNode3D[]): Run[] {
  const runs: Run[] = [];
  let open: Run | null = null;
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const edge = subtract(nodes[index + 1]!, nodes[index]!);
    const direction = normalizeVector(edge);
    if (!direction) continue;
    const segment: RunSegment = { startIndex: index, endIndex: index + 1, lengthMm: magnitude(edge), direction };
    if (open && Math.acos(Math.max(-1, Math.min(1, dot(open.direction, direction)))) < HEADING_TOLERANCE) {
      open.endIndex = segment.endIndex;
      open.lengthMm += segment.lengthMm;
      if (segment.lengthMm > open.longest.lengthMm) open.longest = segment;
      continue;
    }
    if (open) runs.push(open);
    open = { ...segment, longest: segment };
  }
  if (open) runs.push(open);
  return runs;
}

/** Drop coincident points; a duplicated vertex has no direction to recover. */
function dedupe(nodes: readonly PipeRouteNode3D[]): { nodes: PipeRouteNode3D[]; sourceIndices: number[] } {
  const kept: PipeRouteNode3D[] = [];
  const sourceIndices: number[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (kept.length && distance(kept[kept.length - 1]!, node) < 1e-6) continue;
    kept.push({ ...node }); sourceIndices.push(index);
  }
  return { nodes: kept, sourceIndices };
}

export interface DecimatedPipeRoute {
  nodes: PipeRouteNode3D[];
  sourceIndices: number[];
  /** Recovered centreline radius per interior corner, 0 when it was already sharp. */
  radii: number[];
  decimated: boolean;
}

/**
 * Collapse a fabrication polyline to its design corners.
 *
 * Runs shorter than {@link MINIMUM_LEG_MM} are bend tessellation and are
 * discarded; each surviving pair of legs contributes one corner at the
 * intersection of their lines, and the arc radius follows from the setback
 * between that corner and where the straight actually ended. Endpoints are
 * preserved exactly — a port weld is not a fitted quantity.
 */
export function decimatePipeRoute(nodes: readonly PipeRouteNode3D[]): DecimatedPipeRoute {
  const cleaned = dedupe(nodes);
  if (cleaned.nodes.length <= 2) {
    return { nodes: cleaned.nodes, sourceIndices: cleaned.sourceIndices, radii: [], decimated: false };
  }
  const runs = collectRuns(cleaned.nodes);
  const legs = runs.filter(run => run.longest.lengthMm >= MINIMUM_LEG_MM);
  if (legs.length < 2) {
    return { nodes: cleaned.nodes, sourceIndices: cleaned.sourceIndices, radii: cleaned.nodes.map(() => 0), decimated: false };
  }

  const corners: PipeRouteNode3D[] = [{ ...cleaned.nodes[legs[0]!.startIndex]! }];
  const sourceIndices: number[] = [cleaned.sourceIndices[legs[0]!.startIndex]!];
  const radii: number[] = [0];
  for (let index = 0; index < legs.length - 1; index += 1) {
    const before = legs[index]!;
    const after = legs[index + 1]!;
    // Locate the corner from the two real straights, never from an arc chord:
    // the chord's own endpoint lies off the straight's line by the sagitta.
    const straightEnd = cleaned.nodes[before.longest.endIndex]!;
    const straightStart = cleaned.nodes[after.longest.startIndex]!;
    const meeting = intersectLegLines(straightEnd, before.longest.direction, straightStart, after.longest.direction);
    const corner = meeting?.point ?? { ...straightEnd };
    // The straight stopped at the arc's tangent point; the setback back to the
    // sharp corner is exactly radius * tan(turn / 2), so the radius follows.
    const setbackMm = (distance(corner, straightEnd) + distance(corner, straightStart)) / 2;
    const angle = turnDegrees(before.longest.direction, after.longest.direction) * Math.PI / 180;
    const tangent = Math.tan(Math.min(angle, Math.PI - 1e-6) / 2);
    corners.push(corner);
    sourceIndices.push(cleaned.sourceIndices[before.endIndex]!);
    radii.push(tangent > EPSILON && setbackMm > EPSILON ? setbackMm / tangent : 0);
  }
  const last = legs[legs.length - 1]!;
  corners.push({ ...cleaned.nodes[last.endIndex]! });
  sourceIndices.push(cleaned.sourceIndices[last.endIndex]!);
  radii.push(0);

  // Terminals are welds, not fittings: restore the exact stored endpoints even
  // when the final leg's line was recovered from a slightly noisy run.
  corners[0] = { ...cleaned.nodes[0]! };
  corners[corners.length - 1] = { ...cleaned.nodes[cleaned.nodes.length - 1]! };
  sourceIndices[0] = cleaned.sourceIndices[0]!;
  sourceIndices[sourceIndices.length - 1] = cleaned.sourceIndices[cleaned.sourceIndices.length - 1]!;

  const deduped = dedupe(corners);
  return {
    nodes: deduped.nodes,
    sourceIndices: deduped.sourceIndices.map(index => sourceIndices[index]!),
    radii: deduped.sourceIndices.map(index => radii[index] ?? 0),
    decimated: deduped.nodes.length < cleaned.nodes.length,
  };
}

export interface PipeSkeletonOptions {
  /** Per-segment material of the SOURCE polyline (one per source segment). */
  materials?: readonly RefrigerantPipeMaterial[];
  /** Radius applied where none could be recovered from tessellation. */
  defaultBendRadiusMm?: number;
}

/**
 * Build the design skeleton for a fabrication polyline.
 *
 * A leg inherits the strictest material of the source segments it covers: a
 * recovered leg that spans both hard and flexible source runs must satisfy the
 * hard-pipe fitting rules until the user deliberately reassigns it.
 */
export function buildPipeSkeleton(
  nodes: readonly PipeRouteNode3D[],
  options: PipeSkeletonOptions = {},
): PipeSkeleton {
  const decimated = decimatePipeRoute(nodes);
  const skeletonNodes = decimated.nodes;
  const legs: PipeSkeletonLeg[] = [];
  for (let index = 0; index < skeletonNodes.length - 1; index += 1) {
    const direction = normalizeVector(subtract(skeletonNodes[index + 1]!, skeletonNodes[index]!))
      ?? { x: 1, y: 0, z: 0 };
    const from = decimated.sourceIndices[index]!;
    const to = decimated.sourceIndices[index + 1]!;
    const covered = (options.materials ?? []).slice(from, Math.max(from + 1, to));
    legs.push({
      index,
      material: covered.includes('hard') ? 'hard' : covered[0] ?? 'flexible',
      lengthMm: distance(skeletonNodes[index]!, skeletonNodes[index + 1]!),
      direction,
    });
  }

  const joints: PipeSkeletonJoint[] = [];
  for (let index = 1; index < skeletonNodes.length - 1; index += 1) {
    const incoming = legs[index - 1]!.direction;
    const outgoing = legs[index]!.direction;
    const angleDeg = turnDegrees(incoming, outgoing);
    const recovered = decimated.radii[index] ?? 0;
    const radiusMm = recovered > EPSILON ? recovered : options.defaultBendRadiusMm ?? 0;
    joints.push({
      index,
      angleDeg,
      planeNormal: bendPlaneNormal(incoming, outgoing),
      radiusMm,
      takeoffMm: radiusMm * Math.tan(Math.min(angleDeg * Math.PI / 180, Math.PI - 1e-6) / 2),
      filleted: recovered > EPSILON,
    });
  }

  return { nodes: skeletonNodes, joints, legs, sourceIndices: decimated.sourceIndices, decimated: decimated.decimated };
}

/**
 * Map a selection index made against the SOURCE polyline onto the skeleton.
 * Returns the nearest design corner, so a handle placed on an arc chord edits
 * the fitting that chord belongs to rather than failing.
 */
export function skeletonNodeIndexForSource(skeleton: PipeSkeleton, sourceIndex: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < skeleton.sourceIndices.length; index += 1) {
    const separation = Math.abs(skeleton.sourceIndices[index]! - sourceIndex);
    if (separation < bestDistance) { best = index; bestDistance = separation; }
  }
  return best;
}

/** Segment index on the skeleton covering a source segment index. */
export function skeletonLegIndexForSource(skeleton: PipeSkeleton, sourceSegmentIndex: number): number {
  for (let index = 0; index < skeleton.legs.length; index += 1) {
    const from = skeleton.sourceIndices[index]!;
    const to = skeleton.sourceIndices[index + 1]!;
    if (sourceSegmentIndex >= from && sourceSegmentIndex < to) return index;
  }
  return Math.max(0, Math.min(skeleton.legs.length - 1, sourceSegmentIndex));
}

/** Recompute joints and legs after the solver has moved corners. */
export function refreshPipeSkeleton(skeleton: PipeSkeleton, nodes: readonly PipeRouteNode3D[]): PipeSkeleton {
  const next = nodes.map(node => ({ ...node }));
  const legs = next.slice(1).map((end, index) => ({
    index,
    material: skeleton.legs[index]?.material ?? 'flexible',
    lengthMm: distance(next[index]!, end),
    direction: normalizeVector(subtract(end, next[index]!)) ?? skeleton.legs[index]?.direction ?? { x: 1, y: 0, z: 0 },
  } satisfies PipeSkeletonLeg));
  const joints = next.slice(1, -1).map((_, offset) => {
    const index = offset + 1;
    const previous = skeleton.joints.find(joint => joint.index === index);
    const incoming = legs[index - 1]!.direction;
    const outgoing = legs[index]!.direction;
    const angleDeg = turnDegrees(incoming, outgoing);
    const radiusMm = previous?.radiusMm ?? 0;
    return {
      index,
      angleDeg,
      planeNormal: bendPlaneNormal(incoming, outgoing),
      radiusMm,
      takeoffMm: radiusMm * Math.tan(Math.min(angleDeg * Math.PI / 180, Math.PI - 1e-6) / 2),
      filleted: previous?.filleted ?? false,
    } satisfies PipeSkeletonJoint;
  });
  return { ...skeleton, nodes: next, legs, joints };
}
