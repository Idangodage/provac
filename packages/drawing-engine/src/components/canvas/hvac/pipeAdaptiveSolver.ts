/**
 * Adaptive pipe edit solver — a drag is a goal, not a transform.
 *
 * The existing kernel (`applyPipeRouteEdit`) moves the selected nodes rigidly
 * and `validatePipeBendSpace` then vetoes the result. Bends and leg lengths are
 * treated as facts, so any drag needing either to change is refused.
 *
 * This solver inverts that. The dragged node or leg states an intent; the
 * neighbouring geometry is then RE-SOLVED to accommodate it:
 *
 *   - adjoining straights extend or shorten to meet the moved geometry,
 *   - the bends at either end re-angle to whatever turn the new geometry needs
 *     (5°, 25°, 60° — not only 45/90),
 *   - a bend's PLANE rolls, which is what turns a vertical riser elbow into a
 *     horizontal plan elbow or anything between,
 *   - and when a turn can no longer be a catalogue socket elbow, the fitting is
 *     given up for a formed field bend and that change is REPORTED.
 *
 * Two stages, because a general non-linear solve is both overkill and
 * unpredictable at 60fps:
 *
 *   Stage A (analytic).  Moving a node with anchored neighbours, or sliding a
 *     leg while its neighbours keep their own directions, is fully determined —
 *     a line/line intersection. Sub-millisecond, deterministic, no iteration.
 *   Stage B (pivot).      When Stage A has no solution (the neighbour lines are
 *     parallel or skew to the moved leg), the neighbour legs pivot about their
 *     far anchors instead of holding their directions. Always solvable, and it
 *     is exactly the "rotate the bend as far as the move needs" behaviour.
 *
 * Constraints that are NEVER traded: a connected port's position and direction,
 * a pinned joint, a direction reversal, a degenerate leg. A drag against one of
 * those is CLAMPED to the nearest feasible position rather than refused, and the
 * clamp is named.
 *
 * PURE: skeleton in, skeleton out. No element, store or renderer imports.
 */

import type { PipeRouteNode3D } from './pipeRoute3d';
import {
  canFormAngle, describeAngleChange, describeLengthChange, evaluatePipeSkeletonRules,
  standardAngleFor, type PipeAdaptation, type PipeRelaxationKind, type PipeRuleContext,
  type PipeRuleViolation,
} from './pipeRuleModel';
import {
  intersectLegLines, normalizeVector, refreshPipeSkeleton, turnDegrees,
  type PipeSkeleton,
} from './pipeSkeleton';
import type { RefrigerantPipeMaterial } from './refrigerantPipePairModel';

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

const EPSILON = 1e-6;

/**
 * A route end. A connected port fixes both where the pipe lands and the
 * direction it must approach along; a free end fixes nothing.
 */
export interface AdaptiveTerminal {
  /** Position that must be preserved exactly, or null when the end is free. */
  position: PipeRouteNode3D | null;
  /** Approach direction (port into pipe) that must be preserved, or null. */
  direction: PipeRouteNode3D | null;
}

export type AdaptiveGoal =
  | { kind: 'move-node'; index: number; target: PipeRouteNode3D }
  | { kind: 'move-leg'; index: number; offset: PipeRouteNode3D }
  /** Translate the whole run in X/Y/Z, reconnecting whatever it stays tied to. */
  | { kind: 'move-run'; offset: PipeRouteNode3D };

export interface AdaptivePipeEditRequest {
  skeleton: PipeSkeleton;
  context: PipeRuleContext;
  goal: AdaptiveGoal;
  terminals: { start: AdaptiveTerminal; end: AdaptiveTerminal };
  /** Joints the user pinned: their turn angle and plane are held. */
  pinnedJoints?: readonly number[];
  /**
   * Concessions the solver may spend. Defaults to the full supported ladder.
   * `adjust-radius` is deliberately absent: a per-joint radius has nowhere to
   * persist yet, and a solution relying on one would be rejected by the
   * polyline validator at commit.
   */
  budget?: readonly PipeRelaxationKind[];
}

export type AdaptivePipeEditResult =
  | {
      ok: true;
      nodes: PipeRouteNode3D[];
      /** Legs whose material had to change, by leg index. */
      materials: Map<number, RefrigerantPipeMaterial>;
      adaptations: PipeAdaptation[];
      /** Set when the goal was unreachable and the nearest feasible was used. */
      clampedTo?: string;
    }
  | { ok: false; message: string; violation?: PipeRuleViolation };

export const DEFAULT_ADAPTIVE_BUDGET: readonly PipeRelaxationKind[] =
  ['extend-leg', 're-angle-bend', 'roll-bend-plane', 'elbow-to-field-bend'];

/** Classifies a bend by the plane it turns in, which is what users name it. */
function bendOrientation(planeNormal: PipeRouteNode3D): 'plan' | 'riser' | 'compound' {
  const vertical = Math.abs(planeNormal.z);
  if (vertical > 0.94) return 'plan';
  if (vertical < 0.34) return 'riser';
  return 'compound';
}

const ORIENTATION_LABEL = { plan: 'horizontal', riser: 'vertical', compound: 'compound' } as const;

/** Project `point` onto the ray from `origin` along a unit `direction`. */
function projectOntoRay(point: PipeRouteNode3D, origin: PipeRouteNode3D,
  direction: PipeRouteNode3D, minimumMm: number): PipeRouteNode3D {
  const along = Math.max(minimumMm, dot(subtract(point, origin), direction));
  return add(origin, scale(direction, along));
}

interface SolveState {
  nodes: PipeRouteNode3D[];
  materials: Map<number, RefrigerantPipeMaterial>;
  clampedTo?: string;
  /**
   * Corners this solve INSERTED at each head. Leg and joint indices downstream
   * of an insertion shift, so a pre-existing complaint would otherwise read as a
   * brand-new one and refuse a move that changed nothing about it.
   */
  headInsertions?: { start: number; end: number };
}

/**
 * Stage A/B for a leg slide.
 *
 * Stage A holds each neighbour leg's direction and lets it change length only —
 * the classic orthogonal slide, generalised to any pair of leg directions via a
 * line/line intersection. Stage B lets the neighbour pivot about its far anchor
 * instead, which always has a solution and re-angles that bend.
 */
function solveLegSlide(request: AdaptivePipeEditRequest, legIndex: number,
  offset: PipeRouteNode3D): SolveState | { error: string } {
  const { skeleton, terminals } = request;
  const nodes = skeleton.nodes.map(node => ({ ...node }));
  const leg = skeleton.legs[legIndex];
  if (!leg) return { error: 'Select a valid straight segment.' };
  const direction = leg.direction;
  // Only the transverse component moves a leg; the along-leg component would
  // change its length, which is an endpoint edit, not a slide.
  const transverse = subtract(offset, scale(direction, dot(offset, direction)));
  if (magnitude(transverse) < EPSILON) {
    return { error: 'Move an endpoint to change this segment’s length.' };
  }

  const startIndex = legIndex;
  const endIndex = legIndex + 1;
  const slid = [add(nodes[startIndex]!, transverse), add(nodes[endIndex]!, transverse)] as const;
  const next = [...nodes];
  next[startIndex] = { ...slid[0] };
  next[endIndex] = { ...slid[1] };

  const state: SolveState = { nodes: next, materials: new Map() };

  for (const side of ['start', 'end'] as const) {
    const moving = side === 'start' ? startIndex : endIndex;
    const anchor = side === 'start' ? startIndex - 1 : endIndex + 1;
    const terminal = side === 'start' ? terminals.start : terminals.end;
    const isTerminalNode = side === 'start' ? startIndex === 0 : endIndex === nodes.length - 1;

    if (isTerminalNode) {
      // A connected port cannot travel with the leg. Slide the moved end back
      // along the port axis instead of refusing the whole gesture.
      if (terminal.position && terminal.direction) {
        const axis = normalizeVector(terminal.direction);
        if (!axis) return { error: 'The connected port has no usable approach direction.' };
        next[moving] = projectOntoRay(next[moving]!, terminal.position, axis, EPSILON);
        state.clampedTo = 'the connected port axis';
        continue;
      }
      if (terminal.position) {
        next[moving] = { ...terminal.position };
        state.clampedTo = 'the connected end';
      }
      continue;
    }
    if (anchor < 0 || anchor >= nodes.length) continue;

    const neighbourDirection = side === 'start'
      ? skeleton.legs[anchor]?.direction
      : skeleton.legs[moving]?.direction;
    const anchorIsFixedTerminal = side === 'start'
      ? anchor === 0 && Boolean(terminals.start.position && terminals.start.direction)
      : anchor === nodes.length - 1 && Boolean(terminals.end.position && terminals.end.direction);

    // Stage A: hold the neighbour's direction, move only where it ends.
    const meeting = neighbourDirection
      ? intersectLegLines(slid[side === 'start' ? 0 : 1], direction, nodes[anchor]!, neighbourDirection)
      : null;
    if (meeting && meeting.gapMm < 0.001) { next[moving] = meeting.point; continue; }

    // Stage B: the neighbour pivots about its anchor. Forbidden when that
    // anchor is a connected port whose approach direction is fixed.
    if (anchorIsFixedTerminal) {
      return { error: 'The connected ends constrain this direction. Move an adjoining segment.' };
    }
    // The moved endpoint keeps its slid position; the neighbour leg simply
    // re-aims at it, which re-angles (and may roll) that bend.
  }

  return { ...state, nodes: next };
}

/**
 * Build the head of the route at one end, from its anchor to the (already
 * translated) corner next to it.
 *
 * The port has not moved and its straight approach must survive, so the gap
 * between the stub and the displaced run is closed with an axis-aligned
 * staircase in the route's OWN frame: along the port axis, then along the
 * direction the next leg already runs, then along the remaining axis. Each step
 * that is actually needed becomes a real corner — a plan offset becomes a
 * dog-leg, and a vertical component becomes a riser with an elbow at each end.
 *
 * Expressing it in the route's own frame is what keeps an orthogonal
 * installation orthogonal. Letting the first leg simply swing to meet the run
 * would "work" geometrically and produce a diagonal nobody would install.
 */
function reconnectionChain(translated: readonly PipeRouteNode3D[], original: readonly PipeRouteNode3D[],
  terminal: AdaptiveTerminal): PipeRouteNode3D[] | null {
  const target = translated[1];
  if (!target) return null;
  const anchor = terminal.position;
  if (!anchor) return [{ ...translated[0]! }, { ...target }];
  const axis = normalizeVector(terminal.direction ?? subtract(original[1]!, original[0]!));
  if (!axis) return null;

  const firstLegMm = distance(original[0]!, original[1]!);
  const stubEnd = add(anchor, scale(axis, firstLegMm));
  const gap = subtract(target, stubEnd);

  // Second axis follows the leg the route already runs along after its first
  // corner, so the staircase lies in the planes the installation already uses.
  const nextLeg = original.length > 2 ? subtract(original[2]!, original[1]!) : gap;
  const lateral = normalizeVector(subtract(nextLeg, scale(axis, dot(nextLeg, axis))))
    ?? normalizeVector(subtract(gap, scale(axis, dot(gap, axis))))
    ?? normalizeVector(cross(axis, Math.abs(axis.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 }));
  if (!lateral) return null;
  const third = cross(axis, lateral);

  const chain: PipeRouteNode3D[] = [{ ...anchor }, add(anchor, scale(axis, firstLegMm + dot(gap, axis)))];

  // The component along the NEXT leg's own direction needs no fitting at all —
  // that leg simply gets longer or shorter. Emitting a corner for it would add a
  // second riser beside an existing one and fold the route back on itself.
  // Only fall back to a corner when absorbing it would collapse or reverse the
  // leg.
  const nextLegMm = original.length > 2 ? distance(original[1]!, original[2]!) : 0;
  const absorbed = dot(gap, lateral);
  const absorbable = original.length > 2 && nextLegMm + absorbed > 1;
  for (const [direction, amount] of [[lateral, absorbable ? 0 : absorbed], [third, dot(gap, third)]] as const) {
    if (Math.abs(amount) <= 0.5) continue;
    chain.push(add(chain[chain.length - 1]!, scale(direction, amount)));
  }
  return chain;
}

/** Drop interior points that no longer turn — a staircase step can land on a
 * leg the route already runs along, and that is not a fitting. */
function dropCollinear(nodes: readonly PipeRouteNode3D[]): PipeRouteNode3D[] {
  const kept: PipeRouteNode3D[] = [];
  for (const node of nodes) {
    if (kept.length && distance(kept[kept.length - 1]!, node) < 0.5) continue;
    kept.push({ ...node });
  }
  for (let index = kept.length - 2; index >= 1; index -= 1) {
    const incoming = normalizeVector(subtract(kept[index]!, kept[index - 1]!));
    const outgoing = normalizeVector(subtract(kept[index + 1]!, kept[index]!));
    if (incoming && outgoing && turnDegrees(incoming, outgoing) < 0.05) kept.splice(index, 1);
  }
  return kept;
}

/** Legs that rise or fall with no plan travel — the risers in a route. */
function verticalLegCount(nodes: readonly PipeRouteNode3D[]): number {
  let count = 0;
  for (let index = 1; index < nodes.length; index += 1) {
    const a = nodes[index - 1]!;
    const b = nodes[index]!;
    if (Math.abs(b.z - a.z) > 0.5 && Math.hypot(b.x - a.x, b.y - a.y) < 0.5) count += 1;
  }
  return count;
}

/**
 * Translate the whole run, then re-make every connection it keeps.
 *
 * Both ends are re-made against the TRANSLATED route, never one after the other
 * against the partly-rebuilt one: on a short run the two heads would otherwise
 * claim the same middle corner and the second pass would fold the first pass's
 * riser back on itself.
 */
function solveRunMove(request: AdaptivePipeEditRequest, offset: PipeRouteNode3D,
  generated: PipeAdaptation[]): SolveState | { error: string } {
  const { skeleton, terminals } = request;
  const original = skeleton.nodes;
  if (magnitude(offset) < EPSILON) return { error: 'Drag the pipe to move it.' };
  if (original.length < 2) return { error: 'The pipe has no valid route.' };
  const translated = original.map(node => add(node, offset));
  if (original.length === 2 && terminals.start.position && terminals.end.position) {
    return { error: 'Both ends of this pipe are connected. Move an adjoining segment instead.' };
  }

  const reversed = <T>(list: readonly T[]): T[] => [...list].reverse();
  const startChain = reconnectionChain(translated, original, terminals.start);
  const endChain = reconnectionChain(reversed(translated), reversed(original), terminals.end);
  if (!startChain || !endChain) return { error: 'This connection cannot be re-made from that position.' };
  const tail = reversed(endChain);

  // The two heads meet in the middle; on a three-corner run they meet ON the
  // same corner, so it is contributed once.
  const middle = translated.slice(2, Math.max(2, translated.length - 2));
  const joined = original.length <= 3
    ? [...startChain, ...tail.slice(1)]
    : [...startChain, ...middle, ...tail];
  const nodes = dropCollinear(joined);
  const headInsertions = {
    start: Math.max(0, startChain.length - 2),
    end: Math.max(0, endChain.length - 2),
  };

  const newCorners = nodes.length - original.length;
  if (newCorners > 0) {
    const newRisers = Math.max(0, verticalLegCount(nodes) - verticalLegCount(original));
    if (newRisers > 0) {
      generated.push({ kind: 'insert-riser',
        label: `${newRisers} riser${newRisers === 1 ? '' : 's'} added to keep the connections` });
    }
    if (newCorners > newRisers) {
      generated.push({ kind: 'insert-offset',
        label: `offset added (${newCorners - newRisers} new bend${newCorners - newRisers === 1 ? '' : 's'})` });
    }
  }
  return { nodes, materials: new Map(), headInsertions };
}

/** Moving one corner with anchored neighbours is fully determined. */
function solveNodeMove(request: AdaptivePipeEditRequest, nodeIndex: number,
  target: PipeRouteNode3D): SolveState | { error: string } {
  const { skeleton, terminals } = request;
  const nodes = skeleton.nodes.map(node => ({ ...node }));
  if (nodeIndex < 0 || nodeIndex >= nodes.length) return { error: 'Select a valid route point.' };
  const state: SolveState = { nodes, materials: new Map() };

  const terminal = nodeIndex === 0 ? terminals.start
    : nodeIndex === nodes.length - 1 ? terminals.end : null;
  if (terminal?.position) {
    return { error: `The ${nodeIndex === 0 ? 'start' : 'end'} connection must remain fixed. Adjust the adjoining route or explicitly disconnect it first.` };
  }

  // A corner adjacent to a connected port may only travel along that port's
  // approach axis, otherwise the weld direction would change. Clamp instead of
  // refusing: the pipe follows the pointer as far as the constraint permits.
  const startAxis = nodeIndex === 1 && terminals.start.position && terminals.start.direction
    ? { origin: terminals.start.position, direction: normalizeVector(terminals.start.direction) } : null;
  const endAxis = nodeIndex === nodes.length - 2 && terminals.end.position && terminals.end.direction
    ? { origin: terminals.end.position, direction: normalizeVector(terminals.end.direction) } : null;
  const axis = startAxis?.direction ? startAxis : endAxis?.direction ? endAxis : null;
  if (axis?.direction) {
    nodes[nodeIndex] = projectOntoRay(target, axis.origin, axis.direction, EPSILON);
    state.clampedTo = 'the connected port axis';
    return state;
  }

  nodes[nodeIndex] = { ...target };
  return state;
}

/**
 * Identity of a rule violation, so the same complaint can be recognised before
 * and after an edit. Node count is invariant under these goals, so leg and
 * joint indices address the same geometry in both evaluations.
 */
function violationKey(violation: PipeRuleViolation, index: number | null = null): string {
  const resolved = index ?? (violation.kind === 'insufficient-straight' || violation.kind === 'degenerate-segment'
    ? violation.legIndex : violation.jointIndex);
  return violation.kind === 'insufficient-straight' || violation.kind === 'degenerate-segment'
    ? `${violation.kind}:leg${resolved}`
    : `${violation.kind}:joint${resolved}`;
}

/**
 * Map a candidate leg or joint back to the one it was before the edit.
 *
 * Insertions only ever happen at the two heads, so anything past the start head
 * is simply shifted, the two terminal elements keep their identity, and geometry
 * created inside a head has no predecessor at all.
 */
function baselineIndexMapper(insertions: { start: number; end: number }, candidateCount: number,
  baselineCount: number): (index: number) => number | null {
  return (index: number): number | null => {
    if (insertions.start === 0 && insertions.end === 0) return index;
    if (index === 0) return 0;
    if (index === candidateCount - 1) return baselineCount - 1;
    if (index <= insertions.start) return null;
    if (candidateCount - 1 - index <= insertions.end) return null;
    return index - insertions.start;
  };
}

/** How badly a rule is broken, so an edit can be judged as better or worse. */
function violationSeverity(violation: PipeRuleViolation): number {
  return violation.kind === 'insufficient-straight' ? violation.requiredMm - violation.availableMm : 1;
}

/**
 * Walk the relaxation ladder until the candidate satisfies every rule or a hard
 * constraint refuses. Each concession spent is recorded for the caller to show.
 *
 * Judged against the route as it ARRIVED, not against perfection. Generated
 * routes routinely land with pre-existing complaints — a port stub that is
 * exactly the reserve with a fitting takeoff inside it, a gather leg shorter
 * than its two takeoffs. Holding an edit to a standard the original never met
 * makes every generated pipe permanently uneditable, which is precisely the
 * behaviour this work exists to remove. An edit must only never make a rule
 * WORSE than it already was.
 */
function resolveViolations(request: AdaptivePipeEditRequest, state: SolveState,
  adaptations: PipeAdaptation[]): { ok: true } | { ok: false; message: string; violation?: PipeRuleViolation } {
  const budget = new Set(request.budget ?? DEFAULT_ADAPTIVE_BUDGET);
  const pinned = new Set(request.pinnedJoints ?? []);
  const baseline = new Map(evaluatePipeSkeletonRules(request.skeleton, request.context)
    .map(violation => [violationKey(violation), violationSeverity(violation)]));
  const insertions = state.headInsertions ?? { start: 0, end: 0 };
  const mapLeg = baselineIndexMapper(insertions, state.nodes.length - 1, request.skeleton.legs.length);
  const mapJoint = baselineIndexMapper(insertions, state.nodes.length, request.skeleton.nodes.length);
  const isRegression = (violation: PipeRuleViolation): boolean => {
    const mapped = violation.kind === 'insufficient-straight' || violation.kind === 'degenerate-segment'
      ? mapLeg(violation.legIndex) : mapJoint(violation.jointIndex);
    if (mapped === null) return true;
    const before = baseline.get(violationKey(violation, mapped));
    return before === undefined || violationSeverity(violation) > before + 0.5;
  };

  for (let pass = 0; pass < 4; pass += 1) {
    const skeleton = refreshPipeSkeleton(request.skeleton, state.nodes);
    const violations = evaluatePipeSkeletonRules(skeleton, request.context, { materials: state.materials })
      .filter(isRegression);
    if (!violations.length) return { ok: true };

    // Spend every affordable concession this pass, THEN re-evaluate. A rule
    // that a concession elsewhere would have satisfied must not refuse the
    // gesture merely because it was inspected first.
    let progressed = false;
    let blocking: PipeRuleViolation | null = null;
    for (const violation of violations) {
      if (violation.kind !== 'non-standard-angle') { blocking ??= violation; continue; }
      if (pinned.has(violation.jointIndex)) {
        return { ok: false, message: `Point ${violation.jointIndex + 1} is pinned. Unpin it to let this move re-angle its bend.`, violation };
      }
      if (!budget.has('elbow-to-field-bend')) { blocking ??= violation; continue; }
      // The turn is no longer a catalogue angle, so it can no longer be a
      // socket elbow. Both adjoining legs become formed tube; this is a
      // bill-of-materials change and is reported as one.
      let converted = false;
      for (const legIndex of [violation.jointIndex - 1, violation.jointIndex]) {
        if (legIndex < 0 || legIndex >= state.nodes.length - 1) continue;
        if (state.materials.get(legIndex) === 'flexible') continue;
        state.materials.set(legIndex, 'flexible');
        converted = true;
      }
      if (converted) {
        progressed = true;
        adaptations.push({ kind: 'elbow-to-field-bend', jointIndex: violation.jointIndex,
          label: `elbow → field bend (${violation.angleDeg.toFixed(1)}°)` });
      } else blocking ??= violation;
    }
    if (!progressed) {
      const first = blocking ?? violations[0]!;
      return { ok: false, message: first.message, violation: first };
    }
  }
  const skeleton = refreshPipeSkeleton(request.skeleton, state.nodes);
  const remaining = evaluatePipeSkeletonRules(skeleton, request.context, { materials: state.materials })
    .filter(isRegression);
  return remaining.length
    ? { ok: false, message: remaining[0]!.message, violation: remaining[0] }
    : { ok: true };
}

/** Compare before/after and describe every concession the move actually spent. */
function describeAdaptations(before: PipeSkeleton, afterNodes: readonly PipeRouteNode3D[],
  budget: ReadonlySet<PipeRelaxationKind>): PipeAdaptation[] {
  const after = refreshPipeSkeleton(before, afterNodes);
  const adaptations: PipeAdaptation[] = [];

  for (const joint of before.joints) {
    const next = after.joints.find(candidate => candidate.index === joint.index);
    if (!next) continue;
    if (Math.abs(next.angleDeg - joint.angleDeg) > 0.05 && budget.has('re-angle-bend')) {
      adaptations.push({ kind: 're-angle-bend', jointIndex: joint.index,
        label: describeAngleChange(joint.angleDeg, next.angleDeg) });
    }
    const roll = turnDegrees(joint.planeNormal, next.planeNormal);
    if (roll > 1 && budget.has('roll-bend-plane')) {
      const from = bendOrientation(joint.planeNormal);
      const to = bendOrientation(next.planeNormal);
      adaptations.push({ kind: 'roll-bend-plane', jointIndex: joint.index,
        label: from === to ? `bend rolled ${roll.toFixed(0)}°`
          : `bend rolled ${ORIENTATION_LABEL[from]} → ${ORIENTATION_LABEL[to]}` });
    }
  }

  for (const leg of before.legs) {
    const next = after.legs[leg.index];
    if (!next || Math.abs(next.lengthMm - leg.lengthMm) <= 1) continue;
    adaptations.push({ kind: 'extend-leg', legIndex: leg.index,
      label: `segment ${leg.index + 1} ${describeLengthChange(leg.lengthMm, next.lengthMm)}` });
  }
  return adaptations;
}

/** Terminal geometry must survive the solve exactly; verify, never assume. */
function terminalsIntact(nodes: readonly PipeRouteNode3D[], terminals: AdaptivePipeEditRequest['terminals']): string | null {
  for (const side of ['start', 'end'] as const) {
    const terminal = terminals[side];
    if (!terminal.position) continue;
    const node = side === 'start' ? nodes[0]! : nodes[nodes.length - 1]!;
    if (distance(node, terminal.position) > 0.01) {
      return `The ${side} connection must remain fixed. Adjust the adjoining route or explicitly disconnect it first.`;
    }
    const required = normalizeVector(terminal.direction ?? { x: 0, y: 0, z: 0 });
    if (!required) continue;
    const actual = normalizeVector(side === 'start'
      ? subtract(nodes[1]!, nodes[0]!)
      : subtract(nodes[nodes.length - 2]!, nodes[nodes.length - 1]!));
    if (!actual || turnDegrees(required, actual) > 0.1) {
      return `The ${side} connection would point in the wrong direction. Keep its straight approach aligned or explicitly adjust the connection first.`;
    }
  }
  return null;
}

/**
 * Solve a drag against the design skeleton, travelling as far as the rules
 * allow when the requested position is out of reach.
 *
 * A refusal is the behaviour this work exists to remove. When the exact goal
 * cannot be met, the goal is scaled back along its own direction until it can:
 * the corner follows the pointer to the last buildable position and the reason
 * it stopped is named. Only a goal that is unreachable even infinitesimally —
 * a fixed port, a pinned joint, a reversal — comes back as a refusal.
 */
export function solveAdaptivePipeEdit(request: AdaptivePipeEditRequest): AdaptivePipeEditResult {
  const exact = solveExactAdaptivePipeEdit(request);
  if (exact.ok) return exact;

  // Only a FITTING limit is worth creeping up to. A pinned joint, a fixed port,
  // a reversal or a collapsed leg are matters of identity, not of degree —
  // sliding a pinned bend by a hundredth of a degree would satisfy the letter of
  // the check while breaking the promise the pin makes.
  if (exact.violation?.kind !== 'insufficient-straight' && exact.violation?.kind !== 'non-standard-angle') {
    return exact;
  }

  const { skeleton, goal } = request;
  const origin = goal.kind === 'move-node' ? skeleton.nodes[goal.index] : null;
  if (goal.kind === 'move-node' && !origin) return exact;
  const scaledGoal = (fraction: number): AdaptiveGoal => {
    if (goal.kind === 'move-node') {
      return { kind: 'move-node', index: goal.index,
        target: add(origin!, scale(subtract(goal.target, origin!), fraction)) };
    }
    if (goal.kind === 'move-leg') return { kind: 'move-leg', index: goal.index, offset: scale(goal.offset, fraction) };
    return { kind: 'move-run', offset: scale(goal.offset, fraction) };
  };

  // Bisect the travel. Feasibility is monotonic in practice — the further the
  // geometry is pushed the tighter the fittings get — so twelve probes locate
  // the limit to well under a millimetre of a typical drag.
  let reachable = 0;
  let blocked = 1;
  let best: AdaptivePipeEditResult | null = null;
  for (let probe = 0; probe < 12; probe += 1) {
    const fraction = (reachable + blocked) / 2;
    const attempt = solveExactAdaptivePipeEdit({ ...request, goal: scaledGoal(fraction) });
    if (attempt.ok) { best = attempt; reachable = fraction; } else blocked = fraction;
  }
  if (!best) return exact;
  return { ...best, clampedTo: best.clampedTo ?? describeLimit(exact) };
}

/** What stopped the drag, phrased for a status line. */
function describeLimit(refusal: Extract<AdaptivePipeEditResult, { ok: false }>): string {
  const violation = refusal.violation;
  if (violation?.kind === 'insufficient-straight') return `the fitting space on segment ${violation.legIndex + 1}`;
  if (violation?.kind === 'non-standard-angle') return `the fitting angle at point ${violation.jointIndex + 1}`;
  return 'the nearest buildable position';
}

/** The single-shot solve: the exact goal, or the constraint that refused it. */
function solveExactAdaptivePipeEdit(request: AdaptivePipeEditRequest): AdaptivePipeEditResult {
  const { skeleton, goal } = request;
  if (skeleton.nodes.length < 2) return { ok: false, message: 'The pipe has no valid route.' };
  const budget = new Set(request.budget ?? DEFAULT_ADAPTIVE_BUDGET);

  const generated: PipeAdaptation[] = [];
  const solved = goal.kind === 'move-node'
    ? solveNodeMove(request, goal.index, goal.target)
    : goal.kind === 'move-leg'
      ? solveLegSlide(request, goal.index, goal.offset)
      : solveRunMove(request, goal.offset, generated);
  if ('error' in solved) return { ok: false, message: solved.error };

  const moved = solved.nodes.some((node, index) => distance(node, skeleton.nodes[index]!) > EPSILON);
  if (!moved) return { ok: false, message: 'This move is fully constrained. Adjust an adjoining segment instead.' };

  // A reversal or a collapsed leg is not a concession the ladder can buy.
  for (let index = 1; index < solved.nodes.length; index += 1) {
    if (distance(solved.nodes[index - 1]!, solved.nodes[index]!) < 0.001) {
      return { ok: false, message: `The edit would create a zero-length or too-short segment at route point ${index + 1}.` };
    }
  }
  for (let index = 1; index < solved.nodes.length - 1; index += 1) {
    const incoming = normalizeVector(subtract(solved.nodes[index]!, solved.nodes[index - 1]!));
    const outgoing = normalizeVector(subtract(solved.nodes[index + 1]!, solved.nodes[index]!));
    if (incoming && outgoing && turnDegrees(incoming, outgoing) > 180 - 0.001) {
      return { ok: false, message: `The edit would make the pipe double back at route point ${index + 1}.` };
    }
  }

  const pinned = new Set(request.pinnedJoints ?? []);
  for (const jointIndex of pinned) {
    const before = skeleton.joints.find(joint => joint.index === jointIndex);
    const after = refreshPipeSkeleton(skeleton, solved.nodes).joints.find(joint => joint.index === jointIndex);
    if (before && after && Math.abs(before.angleDeg - after.angleDeg) > 0.05) {
      return { ok: false, message: `Point ${jointIndex + 1} is pinned. Unpin it to let this move re-angle its bend.` };
    }
  }

  const terminalConflict = terminalsIntact(solved.nodes, request.terminals);
  if (terminalConflict) return { ok: false, message: terminalConflict };

  // Material conversions are collected separately so the ribbon reads geometry
  // first, bill-of-materials second.
  const conversions: PipeAdaptation[] = [];
  const resolution = resolveViolations(request, solved, conversions);
  if (!resolution.ok) return { ok: false, message: resolution.message, violation: resolution.violation };
  const adaptations = [...generated, ...describeAdaptations(skeleton, solved.nodes, budget), ...conversions];

  return {
    ok: true,
    nodes: solved.nodes,
    materials: solved.materials,
    adaptations,
    ...(solved.clampedTo ? { clampedTo: solved.clampedTo } : {}),
  };
}

/** True when a turn still matches a purchasable fitting angle. */
export function isCatalogueTurn(angleDeg: number): boolean {
  return standardAngleFor(angleDeg) !== null;
}

/** Whether a material/angle combination is buildable under the given budget. */
export function isBuildableTurn(angleDeg: number, material: RefrigerantPipeMaterial,
  budget: readonly PipeRelaxationKind[] = DEFAULT_ADAPTIVE_BUDGET): boolean {
  return canFormAngle(angleDeg, material, budget.includes('elbow-to-field-bend'));
}
