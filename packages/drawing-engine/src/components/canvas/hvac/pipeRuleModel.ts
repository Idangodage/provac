/**
 * Pipe fitting rules as data, with an explicit relaxation ladder.
 *
 * `validatePipeBendSpace` encodes the same engineering rules as a sequence of
 * `if (...) return 'message'` guards. That shape can only ever VETO an edit: a
 * bend angle and a leg length are facts, and a drag that needs either to change
 * comes back as a refusal. On a generated route almost every drag does.
 *
 * Here each rule becomes a typed constraint with a hardness, and each relaxable
 * constraint names the physical concessions that could satisfy it — a longer
 * straight, a re-angled bend, a rolled bend plane, a smaller former, a catalogue
 * elbow given up for a field bend. The solver walks that ladder cheapest-first
 * and reports every rung it spent, so "the pipe cannot move" becomes "the pipe
 * moved, and here is what changed to allow it".
 *
 * Hard constraints are never traded: a connected port's position and direction,
 * an explicit lock, a direction reversal, a radius below the manufacturer
 * minimum. Those still refuse, by name.
 *
 * PURE apart from reading the active routing settings, exactly as the existing
 * geometry model does.
 */

import type { HvacElement } from '../../../types';

import { resolveCopperSocketElbow, resolveCopperSocketElbowMinimumRadius, usesCopperSocketElbows } from './copperSocketElbows';
import { resolveFieldPipeBendRadiusMm } from './fieldPipeBends';
import { getActivePipeRoutingSettings } from './pipeRoutingSettings';
import type { PipeSkeleton } from './pipeSkeleton';
import { resolveRefrigerantPipePairSpec, resolveRefrigerantPipeSpec, type RefrigerantPipeMaterial } from './refrigerantPipePairModel';

/**
 * Concessions the solver may spend, cheapest first. The order IS the policy:
 * lengthening a straight is free draughting, re-angling a bend is a different
 * former setting, giving up a catalogue elbow changes the bill of materials.
 */
export const PIPE_RELAXATION_LADDER = [
  'extend-leg',
  're-angle-bend',
  'roll-bend-plane',
  'rotate-fitting',
  'adjust-radius',
  'refit-elbow',
  'elbow-to-field-bend',
  'insert-offset',
  'insert-riser',
] as const;
export type PipeRelaxationKind = typeof PIPE_RELAXATION_LADDER[number];

/** One concession actually spent, ready to render as a chip or ribbon line. */
export interface PipeAdaptation {
  kind: PipeRelaxationKind;
  jointIndex?: number;
  legIndex?: number;
  /** Short human label, e.g. "90° → 62°" or "elbow → field bend". */
  label: string;
}

export type PipeRuleViolation =
  | { kind: 'degenerate-segment'; legIndex: number; message: string }
  | { kind: 'direction-reversal'; jointIndex: number; message: string }
  | { kind: 'non-standard-angle'; jointIndex: number; angleDeg: number; message: string }
  | { kind: 'insufficient-straight'; legIndex: number; availableMm: number; requiredMm: number; message: string };

export interface PipeRuleContext {
  /** Catalogue socket elbows: discrete 45/90 turns with published takeoffs. */
  socketElbows: boolean;
  pipeDiameterMm: number;
  /** Minimum centreline radius a qualified socket elbow may be held to. */
  minimumSocketRadiusMm: number;
  /** Centreline radius of a formed field bend at this diameter. */
  fieldBendRadiusMm: number;
  /** Verified profile floor; a field bend is never tightened below this. */
  minimumFieldBendRadiusMm: number;
  /** Straight copper reserved along an equipment port normal before a bend. */
  minimumPortStubMm: number;
  startIsUnitPort: boolean;
  endIsUnitPort: boolean;
}

const STANDARD_ANGLES = [45, 90] as const;
const STANDARD_TOLERANCE_DEG = 0.01;

export function resolvePipeRuleContext(element: HvacElement): PipeRuleContext {
  const settings = getActivePipeRoutingSettings();
  const spec = resolveRefrigerantPipeSpec(element.properties);
  const outerDiameterMm = element.type === 'refrigerant-pipe-pair'
    ? (() => {
        const pair = resolveRefrigerantPipePairSpec(element.properties);
        return Math.max(pair.gasOuterDiameterMm, pair.liquidOuterDiameterMm);
      })()
    : spec.outerDiameterMm;
  return {
    socketElbows: usesCopperSocketElbows(element.properties),
    pipeDiameterMm: spec.pipeDiameterMm,
    minimumSocketRadiusMm: resolveCopperSocketElbowMinimumRadius(element.properties),
    fieldBendRadiusMm: resolveFieldPipeBendRadiusMm(outerDiameterMm, element.properties.bendRadiusFactor),
    minimumFieldBendRadiusMm: settings.minimumFieldBendRadiusMm,
    minimumPortStubMm: settings.minimumPortStubMm,
    startIsUnitPort: spec.startConnection?.connectionKind === 'unit-port',
    endIsUnitPort: spec.endConnection?.connectionKind === 'unit-port',
  };
}

/** The standard fitting angle a turn matches exactly, if any. */
export function standardAngleFor(angleDeg: number): 45 | 90 | null {
  return STANDARD_ANGLES.find(angle => Math.abs(angleDeg - angle) < STANDARD_TOLERANCE_DEG) ?? null;
}

/**
 * Straight consumed on each adjoining leg by the fitting at this turn.
 *
 * Mirrors `validatePipeBendSpace`: a qualified socket elbow contributes its
 * published centre-to-face, a formed bend contributes radius * tan(turn / 2),
 * and the minimum qualified radius is a floor under both.
 */
export function jointTakeoffMm(angleDeg: number, context: PipeRuleContext, radiusOverrideMm?: number): number {
  const angle = angleDeg * Math.PI / 180;
  if (angle < 1e-5) return 0;
  const tangent = Math.tan(Math.min(angle, Math.PI - 1e-6) / 2);
  const standard = standardAngleFor(angleDeg);
  const elbow = standard && context.socketElbows ? resolveCopperSocketElbow(context.pipeDiameterMm, standard) : null;
  const formedRadius = radiusOverrideMm ?? context.fieldBendRadiusMm;
  return Math.max(context.minimumSocketRadiusMm * tangent, elbow?.centerToFaceMm ?? formedRadius * tangent);
}

/** Straight a terminal reserves before the first bend (equipment approach). */
export function terminalStubMm(context: PipeRuleContext, endpoint: 'start' | 'end'): number {
  return (endpoint === 'start' ? context.startIsUnitPort : context.endIsUnitPort) ? context.minimumPortStubMm : 0;
}

export interface PipeRuleEvaluationOptions {
  /** Radius actually applied per joint index, when the solver has retuned one. */
  radiiMm?: ReadonlyMap<number, number>;
  /** Material actually applied per leg index, when the solver has converted one. */
  materials?: ReadonlyMap<number, RefrigerantPipeMaterial>;
}

/**
 * Every rule a design skeleton either satisfies or does not.
 *
 * Unlike the polyline validator this needs no sampled-bend exemption: a
 * skeleton has no arc chords, only real fittings, so each interior corner is a
 * turn boundary and each leg carries exactly two takeoffs.
 */
export function evaluatePipeSkeletonRules(
  skeleton: PipeSkeleton,
  context: PipeRuleContext,
  options: PipeRuleEvaluationOptions = {},
): PipeRuleViolation[] {
  const violations: PipeRuleViolation[] = [];
  const materialAt = (legIndex: number): RefrigerantPipeMaterial =>
    options.materials?.get(legIndex) ?? skeleton.legs[legIndex]?.material ?? 'flexible';
  const takeoffs = skeleton.nodes.map(() => 0);

  for (const joint of skeleton.joints) {
    const { index, angleDeg } = joint;
    if (angleDeg < 1e-5) continue;
    if (angleDeg > 180 - 1e-5) {
      violations.push({ kind: 'direction-reversal', jointIndex: index,
        message: `Point ${index + 1} reverses the pipe direction without a valid return bend.` });
      continue;
    }
    const standard = standardAngleFor(angleDeg);
    const hardAdjoining = materialAt(index - 1) === 'hard' || materialAt(index) === 'hard';
    if (!standard && hardAdjoining) {
      violations.push({ kind: 'non-standard-angle', jointIndex: index, angleDeg,
        message: `Point ${index + 1} requires a ${angleDeg.toFixed(1)}° fitting. Hard pipe supports 45° or 90° turns.` });
    }
    takeoffs[index] = jointTakeoffMm(angleDeg, context, options.radiiMm?.get(index));
  }

  for (const leg of skeleton.legs) {
    if (leg.lengthMm <= 0.001) {
      violations.push({ kind: 'degenerate-segment', legIndex: leg.index,
        message: 'A route segment is too short.' });
      continue;
    }
    const requiredMm = takeoffs[leg.index]! + takeoffs[leg.index + 1]!
      + (leg.index === 0 ? terminalStubMm(context, 'start') : 0)
      + (leg.index === skeleton.legs.length - 1 ? terminalStubMm(context, 'end') : 0);
    if (requiredMm > leg.lengthMm + 0.001) {
      violations.push({ kind: 'insufficient-straight', legIndex: leg.index,
        availableMm: leg.lengthMm, requiredMm,
        message: `Segment ${leg.index + 1} is too short for the specified bend radius, fitting sockets or equipment approach. Extend the adjoining straight sections.` });
    }
  }
  return violations;
}

/** Whether a joint's turn can be formed at all once concessions are allowed. */
export function canFormAngle(angleDeg: number, material: RefrigerantPipeMaterial, allowElbowConversion: boolean): boolean {
  if (angleDeg > 180 - 1e-5) return false;
  if (angleDeg < 1e-5) return true;
  return material !== 'hard' || standardAngleFor(angleDeg) !== null || allowElbowConversion;
}

export function describeAngleChange(beforeDeg: number, afterDeg: number): string {
  return `${beforeDeg.toFixed(beforeDeg % 1 === 0 ? 0 : 1)}° → ${afterDeg.toFixed(afterDeg % 1 === 0 ? 0 : 1)}°`;
}

export function describeLengthChange(beforeMm: number, afterMm: number): string {
  const delta = afterMm - beforeMm;
  return `${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(0)} mm`;
}
