/**
 * Gas and liquid solved as one assembly.
 *
 * A VRF bundle is two physically separate pipes that must stay a fixed distance
 * apart. Today every editing path solves exactly one element: `bundlePartnerId`
 * is computed in the environment model and never read, and multi-selecting the
 * two lanes forces the RIGID kernel, which disqualifies the adaptive solver
 * entirely. The result is that moving one line silently separates the pair and
 * the VRF report raises `pipe-pair-separation` after the fact.
 *
 * This module makes a bundle edit a single transaction:
 *
 *   - partners are resolved from EXPLICIT identity (`bundleId`), never from
 *     proximity — two lines that merely look parallel are not a bundle,
 *   - the same world-space transform is applied to every line, which is what
 *     preserves separation exactly rather than approximately,
 *   - every line must solve; if one cannot, NOTHING is committed, because half a
 *     bundle is worse than no edit,
 *   - the resulting separation is measured and reported against what the
 *     assembly requires, so a change is visible before it is committed.
 *
 * Each line keeps its own identity, diameter, material and port records. The
 * two lines are never treated as offsets of one polyline: their interfaces
 * genuinely differ, and a pair element that stores one centreline is reported as
 * unsupported here rather than silently half-edited.
 *
 * PURE: elements in, elements out.
 */

import type { HvacElement } from '../../../types';

import { readPipeDesign } from './pipeDesignModel';
import type { PipeAdaptation } from './pipeRuleModel';

export interface PipeBundleMember {
  elementId: string;
  lineKind: 'gas' | 'liquid';
  /** Centre-to-centre spacing the assembly was built with, when recorded. */
  requiredSeparationMm: number | null;
}

export interface PipeBundle {
  bundleId: string;
  members: PipeBundleMember[];
}

const isPipe = (element: HvacElement) =>
  element.type === 'refrigerant-pipe' || element.type === 'refrigerant-pipe-pair';

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function lineKindOf(element: HvacElement): 'gas' | 'liquid' {
  // Mirrors the model's own normalisation, which treats anything that is not
  // explicitly liquid as gas.
  return element.properties.lineKind === 'liquid' ? 'liquid' : 'gas';
}

/**
 * Required centre-to-centre separation for a line.
 *
 * `pairCenterSpacingMm` is stamped at creation. Falling back to the clear gap
 * plus both radii reproduces how the assembly derived it. When neither is
 * recorded the requirement is genuinely unknown and stays `null` — it must not
 * become zero, which would read as "any separation is correct".
 */
function requiredSeparationMm(element: HvacElement): number | null {
  const stamped = readNumber(element.properties.pairCenterSpacingMm);
  if (stamped !== null && stamped > 0) return stamped;
  const gap = readNumber(element.properties.pipeGapMm);
  const outer = readNumber(element.properties.outerDiameterMm);
  return gap !== null && outer !== null ? gap + outer : null;
}

/**
 * The bundle a pipe belongs to, by explicit identity only.
 *
 * Returns null for a pipe with no `bundleId` — a single line is not half a
 * bundle, and nothing may be inferred from a neighbour that happens to run
 * alongside it.
 */
export function resolvePipeBundle(element: HvacElement,
  elements: readonly HvacElement[]): PipeBundle | null {
  const bundleId = typeof element.properties.bundleId === 'string' ? element.properties.bundleId : null;
  if (!bundleId) return null;
  const members = elements
    .filter(candidate => isPipe(candidate) && candidate.properties.bundleId === bundleId)
    .map(candidate => ({
      elementId: candidate.id,
      lineKind: lineKindOf(candidate),
      requiredSeparationMm: requiredSeparationMm(candidate),
    }));
  return members.length >= 2 ? { bundleId, members } : null;
}

/**
 * Median centre-to-centre separation between two routes.
 *
 * Sampled at 30/50/70 percent of the run rather than at the ends, because port
 * fan-in and fan-out legs legitimately diverge there. Measured in 3D: two lines
 * stacked vertically are separated, and a plan-only measurement would report
 * them as coincident.
 */
export function measureBundleSeparationMm(a: HvacElement, b: HvacElement,
  scene: readonly HvacElement[] = []): number | null {
  const left = readPipeDesign(a, scene).nodes;
  const right = readPipeDesign(b, scene).nodes;
  if (left.length < 2 || right.length < 2) return null;

  const pointAt = (nodes: typeof left, fraction: number): { x: number; y: number; z: number } => {
    const lengths: number[] = [];
    let total = 0;
    for (let index = 1; index < nodes.length; index += 1) {
      const step = Math.hypot(
        nodes[index]!.x - nodes[index - 1]!.x,
        nodes[index]!.y - nodes[index - 1]!.y,
        nodes[index]!.z - nodes[index - 1]!.z);
      lengths.push(step);
      total += step;
    }
    if (total <= 1e-9) return nodes[0]!;
    let travelled = fraction * total;
    for (let index = 0; index < lengths.length; index += 1) {
      if (travelled <= lengths[index]!) {
        const t = lengths[index]! > 1e-9 ? travelled / lengths[index]! : 0;
        const from = nodes[index]!;
        const to = nodes[index + 1]!;
        return {
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t,
          z: from.z + (to.z - from.z) * t,
        };
      }
      travelled -= lengths[index]!;
    }
    return nodes[nodes.length - 1]!;
  };

  const samples = [0.3, 0.5, 0.7].map(fraction => {
    const from = pointAt(left, fraction);
    const to = pointAt(right, fraction);
    return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  }).sort((first, second) => first - second);
  return samples[1] ?? null;
}

export interface BundleSeparationReport {
  beforeMm: number | null;
  afterMm: number | null;
  requiredMm: number | null;
  /** True only when a requirement is known AND the result meets it. */
  withinRequirement: boolean;
  /** Set when the requirement is unknown; never treated as a pass. */
  unresolvedReason?: string;
}

export type PipeBundleEditOutcome =
  | {
      ok: true;
      elements: HvacElement[];
      adaptations: PipeAdaptation[];
      separation: BundleSeparationReport;
    }
  | { ok: false; message: string; failedElementId?: string };

/** Tolerance the assembly rule already uses for a separation comparison. */
const SEPARATION_TOLERANCE_MM = 1;

/**
 * Solve one goal across every line of a bundle.
 *
 * `solveLine` is injected so this module stays free of the solver's own
 * dependencies and can be unit-tested against a stub. It must apply the SAME
 * world-space transform to each line; that is what keeps the separation exact.
 */
export function solvePipeBundleEdit(input: {
  elementId: string;
  elements: readonly HvacElement[];
  solveLine: (elementId: string, elements: readonly HvacElement[]) =>
    { ok: true; element: HvacElement; adaptations: PipeAdaptation[] } | { ok: false; message: string };
}): PipeBundleEditOutcome {
  const element = input.elements.find(candidate => candidate.id === input.elementId);
  if (!element) return { ok: false, message: 'Select an editable refrigerant pipe.' };

  const bundle = resolvePipeBundle(element, input.elements);
  if (!bundle) {
    return { ok: false, message: 'This pipe is not part of a gas/liquid bundle.' };
  }
  if (bundle.members.some(member =>
    input.elements.find(candidate => candidate.id === member.elementId)?.type === 'refrigerant-pipe-pair')) {
    return {
      ok: false,
      message: 'This bundle is a legacy composite pipe. Convert it to separate gas and liquid runs to edit them together.',
    };
  }

  const before = bundle.members.length === 2
    ? measureBundleSeparationMm(
        input.elements.find(candidate => candidate.id === bundle.members[0]!.elementId)!,
        input.elements.find(candidate => candidate.id === bundle.members[1]!.elementId)!,
        input.elements)
    : null;

  // Solve every line before committing any of them. A bundle that only half
  // moves is a worse outcome than one that does not move at all.
  const solved: HvacElement[] = [];
  const adaptations: PipeAdaptation[] = [];
  for (const member of bundle.members) {
    const result = input.solveLine(member.elementId, input.elements);
    if (!result.ok) {
      return {
        ok: false,
        failedElementId: member.elementId,
        message: `The ${member.lineKind} line cannot follow this move, so the bundle was left unchanged. ${result.message}`,
      };
    }
    solved.push(result.element);
    adaptations.push(...result.adaptations);
  }

  const nextScene = input.elements.map(candidate =>
    solved.find(entry => entry.id === candidate.id) ?? candidate);
  const after = solved.length === 2
    ? measureBundleSeparationMm(solved[0]!, solved[1]!, nextScene) : null;
  const required = bundle.members
    .map(member => member.requiredSeparationMm)
    .find((value): value is number => value !== null) ?? null;

  const separation: BundleSeparationReport = {
    beforeMm: before,
    afterMm: after,
    requiredMm: required,
    withinRequirement: required !== null && after !== null
      && Math.abs(after - required) <= SEPARATION_TOLERANCE_MM,
    ...(required === null
      ? { unresolvedReason: 'This assembly records no required pair separation, so the result cannot be checked against one.' }
      : {}),
  };

  return { ok: true, elements: solved, adaptations, separation };
}

/**
 * One readable line describing what happened to the pair spacing.
 *
 * An unknown requirement is stated as unverified rather than dressed up as a
 * pass — the separation may be correct, but nothing here establishes that.
 */
export function describeBundleSeparation(report: BundleSeparationReport): string {
  if (report.afterMm === null) return 'Pair separation could not be measured.';
  if (report.requiredMm === null) {
    return `Pair separation ${report.afterMm.toFixed(0)} mm — unverified: ${report.unresolvedReason ?? 'no requirement is recorded.'}`;
  }
  return report.withinRequirement
    ? `Pair separation ${report.afterMm.toFixed(0)} mm (required ${report.requiredMm.toFixed(0)} mm).`
    : `Pair separation ${report.afterMm.toFixed(0)} mm differs from the required ${report.requiredMm.toFixed(0)} mm.`;
}
