/**
 * Orientation edits: rolling a bend about the pipe axis, and rotating a
 * component about a connection.
 *
 * The existing kernel treats `rotate` as a rigid transform of the selected
 * nodes and then demands that the boundary edge to any unselected neighbour
 * still point exactly where the rotation would have put it — within 0.1 deg.
 * For anything but a selection whose neighbour lies on the rotation axis that
 * condition is unsatisfiable, so rotation is refused rather than solved.
 *
 * The distinction this module draws is the one requirement 5 asks for:
 *
 *   - **Rolling** a joint turns the geometry after it about the INCOMING leg's
 *     own axis. The included angle and the radius are untouched by construction
 *     — only the plane the bend turns in changes. A request for 5, 25 or 60
 *     degrees is nearly always this.
 *   - **Rotating a component** turns a chosen sub-chain about an explicit pivot
 *     and axis. The sub-chain is rigid, so the fittings inside it keep their
 *     angles; the joints at the boundary absorb the change and are reported.
 *   - Neither ever alters a joint's included angle. Changing that means buying a
 *     different fitting, which is a separate, explicit operation.
 *
 * When the exact angle cannot be reached — a pinned port downstream, a fitting
 * left without straight — the rotation is bisected down to the largest angle
 * that is buildable and the achieved value is reported alongside the requested
 * one. Only a hard constraint (a pinned joint, a reversal, a collapsed leg)
 * refuses outright.
 *
 * PURE: design in, positions out.
 */

import {
  designRouteNodes, refreshPipeDesign, type PipeDesign,
} from './pipeDesignModel';
import { normalizeVec3, type PipePortFrame, type Vec3 } from './pipePortFrame';
import type { PipeRouteNode3D } from './pipeRoute3d';
import {
  evaluatePipeSkeletonRules, type PipeAdaptation, type PipeRuleContext, type PipeRuleViolation,
} from './pipeRuleModel';
import { buildPipeSkeleton, rotateAboutAxis, turnDegrees } from './pipeSkeleton';

/** Below this a requested rotation is not an edit. */
const MINIMUM_ANGLE_DEG = 1e-4;
/** A rotation must preserve every included angle to at least this precision. */
export const ANGLE_PRESERVATION_TOLERANCE_DEG = 1e-6;

const subtract = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const distance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export type PipeOrientationGoal =
  /** Turn everything after `jointId` about the incoming leg's axis. */
  | { kind: 'roll-joint'; jointId: string; angleDeg: number }
  /** Turn a named set of nodes rigidly about an explicit pivot and axis. */
  | { kind: 'rotate-component'; nodeIds: readonly string[]; pivot: Vec3; axis: Vec3; angleDeg: number };

export interface PipeOrientationRequest {
  design: PipeDesign;
  context: PipeRuleContext;
  goal: PipeOrientationGoal;
}

export type PipeOrientationResult =
  | {
      ok: true;
      /** `exact` when the full angle was reached, `approximate` when clamped. */
      status: 'exact' | 'approximate';
      nodes: PipeRouteNode3D[];
      requestedAngleDeg: number;
      achievedAngleDeg: number;
      adaptations: PipeAdaptation[];
      limitedBy?: string;
    }
  | { ok: false; message: string; violation?: PipeRuleViolation };

/** Nodes a port frame pins in place. */
function pinnedNodeIndices(design: PipeDesign): { start: boolean; end: boolean } {
  const pins = (port: PipePortFrame) => port.kind !== 'open' && port.origin !== null;
  return { start: pins(design.ports.start), end: pins(design.ports.end) };
}

/** Indices this goal moves, and the joint that must keep its angle exactly. */
function resolveScope(design: PipeDesign, goal: PipeOrientationGoal):
  { indices: number[]; pivot: Vec3; axis: Vec3; preservedJointIndex: number | null } | { error: string } {
  if (goal.kind === 'roll-joint') {
    const jointIndex = design.nodes.findIndex(node =>
      node.id === design.joints.find(joint => joint.id === goal.jointId)?.nodeId);
    if (jointIndex <= 0 || jointIndex >= design.nodes.length - 1) {
      return { error: 'Select an interior bend to roll.' };
    }
    // The roll axis IS the incoming leg. Rotating about it cannot change the
    // angle between that leg and the next one — the included angle is preserved
    // by construction rather than by a check.
    const axis = normalizeVec3(subtract(design.nodes[jointIndex]!, design.nodes[jointIndex - 1]!));
    if (!axis) return { error: 'This bend has no usable incoming leg to roll about.' };
    return {
      indices: design.nodes.map((_, index) => index).filter(index => index > jointIndex),
      pivot: design.nodes[jointIndex]!,
      axis,
      preservedJointIndex: jointIndex,
    };
  }

  const wanted = new Set(goal.nodeIds);
  const indices = design.nodes.flatMap((node, index) => wanted.has(node.id) ? [index] : []);
  if (!indices.length) return { error: 'Select geometry to rotate.' };
  const axis = normalizeVec3(goal.axis);
  if (!axis) return { error: 'Choose a valid rotation axis.' };
  return { indices, pivot: goal.pivot, axis, preservedJointIndex: null };
}

function rotatedNodes(design: PipeDesign, indices: readonly number[], pivot: Vec3,
  axis: Vec3, angleDeg: number): PipeRouteNode3D[] {
  const moving = new Set(indices);
  const radians = angleDeg * Math.PI / 180;
  return designRouteNodes(design).map((node, index) => moving.has(index)
    ? add(pivot, rotateAboutAxis(subtract(node, pivot), axis, radians))
    : node);
}

/** Included angle at every interior corner, for a preservation check. */
function includedAngles(nodes: readonly PipeRouteNode3D[]): number[] {
  const angles: number[] = [];
  for (let index = 1; index < nodes.length - 1; index += 1) {
    const incoming = normalizeVec3(subtract(nodes[index]!, nodes[index - 1]!));
    const outgoing = normalizeVec3(subtract(nodes[index + 1]!, nodes[index]!));
    angles.push(incoming && outgoing ? turnDegrees(incoming, outgoing) : 0);
  }
  return angles;
}

/**
 * Does this candidate hold together?
 *
 * Terminals that the design says are welded must not have moved, no leg may
 * collapse, nothing may double back, and no fitting rule may be made worse than
 * it already was. The baseline comparison matters as much here as for a
 * translation: a generated route arrives with pre-existing complaints and a
 * rotation must not be blamed for them.
 */
function candidateBlocker(design: PipeDesign, nodes: readonly PipeRouteNode3D[],
  context: PipeRuleContext, baseline: ReadonlyMap<string, number>):
  { message: string; violation?: PipeRuleViolation } | null {
  const pins = pinnedNodeIndices(design);
  const original = designRouteNodes(design);
  if (pins.start && distance(nodes[0]!, original[0]!) > 0.01) {
    return { message: 'The start connection must remain fixed. Adjust the adjoining route or explicitly disconnect it first.' };
  }
  if (pins.end && distance(nodes[nodes.length - 1]!, original[original.length - 1]!) > 0.01) {
    return { message: 'The end connection must remain fixed. Adjust the adjoining route or explicitly disconnect it first.' };
  }
  for (let index = 1; index < nodes.length; index += 1) {
    if (distance(nodes[index - 1]!, nodes[index]!) < 0.001) {
      return { message: `The edit would create a zero-length or too-short segment at route point ${index + 1}.` };
    }
  }
  for (const angle of includedAngles(nodes)) {
    if (angle > 180 - 0.001) return { message: 'The edit would make the pipe double back.' };
  }

  const skeleton = buildPipeSkeleton(nodes, {
    materials: design.legs.map(leg => leg.material),
  });
  for (const violation of evaluatePipeSkeletonRules(skeleton, context)) {
    const key = violationKey(violation);
    const before = baseline.get(key);
    const severity = violationSeverity(violation);
    if (before === undefined || severity > before + 0.5) return { message: violation.message, violation };
  }
  return null;
}

function violationKey(violation: PipeRuleViolation): string {
  return violation.kind === 'insufficient-straight' || violation.kind === 'degenerate-segment'
    ? `${violation.kind}:leg${violation.legIndex}`
    : `${violation.kind}:joint${violation.jointIndex}`;
}

function violationSeverity(violation: PipeRuleViolation): number {
  return violation.kind === 'insufficient-straight' ? violation.requiredMm - violation.availableMm : 1;
}

const orientationName = (normal: Vec3): string =>
  Math.abs(normal.z) > 0.94 ? 'horizontal' : Math.abs(normal.z) < 0.34 ? 'vertical' : 'compound';

/**
 * Solve an orientation edit.
 *
 * Returns the largest buildable rotation up to the requested one. A pinned
 * joint or a broken weld refuses; running out of fitting space clamps.
 */
export function solvePipeOrientation(request: PipeOrientationRequest): PipeOrientationResult {
  const { design, context, goal } = request;
  if (design.nodes.length < 2) return { ok: false, message: 'The pipe has no valid route.' };
  if (Math.abs(goal.angleDeg) < MINIMUM_ANGLE_DEG) {
    return { ok: false, message: 'Enter a rotation angle.' };
  }

  const scope = resolveScope(design, goal);
  if ('error' in scope) return { ok: false, message: scope.error };

  if (goal.kind === 'roll-joint') {
    const joint = design.joints.find(candidate => candidate.id === goal.jointId);
    if (joint?.lock === 'plane' || joint?.lock === 'rigid' || joint?.lock === 'pinned') {
      return { ok: false, message: `This bend's orientation is locked. Unlock it to roll the fitting.` };
    }
  }

  const baseline = new Map(
    evaluatePipeSkeletonRules(
      buildPipeSkeleton(designRouteNodes(design), { materials: design.legs.map(leg => leg.material) }),
      context,
    ).map(violation => [violationKey(violation), violationSeverity(violation)]),
  );

  const attempt = (angleDeg: number) => {
    const nodes = rotatedNodes(design, scope.indices, scope.pivot, scope.axis, angleDeg);
    return { nodes, blocker: candidateBlocker(design, nodes, context, baseline) };
  };

  const exact = attempt(goal.angleDeg);
  let achievedAngleDeg = goal.angleDeg;
  let nodes = exact.nodes;
  let limitedBy: string | undefined;

  if (exact.blocker) {
    // A broken weld or a pinned joint is a matter of identity, not of degree.
    if (!exact.blocker.violation) return { ok: false, message: exact.blocker.message };
    let reachable = 0;
    let blocked = goal.angleDeg;
    let best: PipeRouteNode3D[] | null = null;
    for (let probe = 0; probe < 14; probe += 1) {
      const midpoint = (reachable + blocked) / 2;
      const candidate = attempt(midpoint);
      if (candidate.blocker) blocked = midpoint;
      else { best = candidate.nodes; reachable = midpoint; }
    }
    if (!best || Math.abs(reachable) < MINIMUM_ANGLE_DEG) {
      return { ok: false, message: exact.blocker.message, violation: exact.blocker.violation };
    }
    nodes = best;
    achievedAngleDeg = reachable;
    limitedBy = exact.blocker.message;
  }

  // The defining property of both operations: no included angle changed.
  const before = includedAngles(designRouteNodes(design));
  const after = includedAngles(nodes);
  const adaptations: PipeAdaptation[] = [];
  before.forEach((angle, offset) => {
    const jointIndex = offset + 1;
    const changed = Math.abs((after[offset] ?? angle) - angle);
    if (changed <= ANGLE_PRESERVATION_TOLERANCE_DEG) return;
    // Only a boundary joint may change, and it is reported rather than hidden.
    adaptations.push({
      kind: 're-angle-bend', jointIndex,
      label: `${angle.toFixed(1)}° → ${(after[offset] ?? angle).toFixed(1)}°`,
    });
  });

  if (goal.kind === 'roll-joint') {
    const refreshed = refreshPipeDesign({
      ...design,
      nodes: design.nodes.map((node, index) => ({
        id: node.id, x: nodes[index]!.x, y: nodes[index]!.y, z: nodes[index]!.z,
      })),
    });
    const rolled = refreshed.joints.find(joint => joint.id === goal.jointId);
    const original = design.joints.find(joint => joint.id === goal.jointId);
    if (rolled && original) {
      const from = orientationName(original.planeNormal);
      const to = orientationName(rolled.planeNormal);
      adaptations.unshift({
        kind: 'roll-bend-plane',
        label: from === to
          ? `bend rolled ${Math.abs(achievedAngleDeg).toFixed(0)}°`
          : `bend rolled ${from} → ${to}`,
      });
    }
  }

  return {
    ok: true,
    status: Math.abs(achievedAngleDeg - goal.angleDeg) <= MINIMUM_ANGLE_DEG ? 'exact' : 'approximate',
    nodes,
    requestedAngleDeg: goal.angleDeg,
    achievedAngleDeg,
    adaptations,
    ...(limitedBy ? { limitedBy } : {}),
  };
}

/** Included angles, exposed so callers can assert preservation themselves. */
export function pipeIncludedAngles(nodes: readonly PipeRouteNode3D[]): number[] {
  return includedAngles(nodes);
}
