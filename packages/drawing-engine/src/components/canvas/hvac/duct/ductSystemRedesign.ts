/**
 * A unit's ducts re-designed in another shape ("Re-design DU-1 as
 * rectangular"): the request (the system as the designer set it — its
 * terminals, airflows, services, sizing basis and fan speed — in the shape
 * asked), the design as one command (the turn re-design's: the old runs out,
 * the new ones in with their sizing records, the accessories set again), and
 * what changed in a sentence: metres of duct, elbows, the fan's pressure and
 * the first cost, each against what it was.
 *
 * Pure: the optimiser itself runs where the caller chooses (its worker).
 */
import type { HvacElement } from '../../../../types';

import { AUTO_DUCT_SHAPE_LABELS, type AutoDuctShape } from './ductAutoLayout';
import { formatCost } from './ductEconomics';
import type { DuctDesignSettings } from './ductSettings';
import {
  ductSystemFigures, turnRedesignTargets, unitDuctSystems,
  type DuctSystemAppraisal, type DuctSystemFigures, type TurnRedesignCommand, type TurnRedesignTarget,
} from './ductTurnRedesign';
import { isRoundLeg } from './ductTypes';

/** The shape a unit's ducts are in: as they were designed (kept on the system), else read off its trunk. */
export function unitDuctShape(scene: readonly HvacElement[], unitId: string): AutoDuctShape | null {
  const roots = unitDuctSystems(scene, unitId).filter(({ spec }) => spec.start.kind === 'unit-port');
  if (!roots.length) return null;
  const recorded = roots.find(({ spec }) => spec.initialSizing?.shape)?.spec.initialSizing?.shape;
  if (recorded) return recorded;
  const trunk = roots.find(({ spec }) => spec.service === 'supply') ?? roots[0]!;
  return isRoundLeg(trunk.spec.legs[0]) ? 'round' : 'rect';
}

/** The request re-designing a unit's ducts in `shape`, or why there is none. */
export function systemRedesignTarget(
  scene: readonly HvacElement[], unitId: string, shape: AutoDuctShape, settings: DuctDesignSettings,
): { target: TurnRedesignTarget } | { reason: string } {
  const { targets, skipped } = turnRedesignTargets(scene, scene, new Set([unitId]), new Set(), settings);
  if (skipped.length) return { reason: skipped[0]!.reason.replace(': they keep the turn\'s re-route', ': unlock it to re-design them') };
  const target = targets[0];
  if (!target) return { reason: 'It has no ducts serving terminals to re-design' };
  return { target: { ...target, request: { ...target.request, shape } } };
}

/** The drawing with a re-design's command applied (as the store applies it). */
export function withRedesignApplied(scene: readonly HvacElement[], command: TurnRedesignCommand): HvacElement[] {
  const removed = new Set(command.removeIds);
  const added = new Set(command.add.map((element) => element.id));
  const updates = new Map(command.updates.map((entry) => [entry.id, entry.updates]));
  return [
    ...scene.filter((element) => !removed.has(element.id) && !added.has(element.id)).map((element) => {
      const update = updates.get(element.id);
      return update ? { ...element, ...update, properties: { ...element.properties, ...(update.properties ?? {}) } } : element;
    }),
    ...command.add,
  ];
}

const metres = (mm: number) => `${(mm / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} m`;

/** A shape as the status names it: "as rectangular", "with a rectangular main and round branches". */
export function shapePhrase(shape: AutoDuctShape): string {
  return shape === 'rect' ? 'with a rectangular main and round branches' : shape === 'optimal' ? 'in the optimiser\'s mix of shapes' : `as ${AUTO_DUCT_SHAPE_LABELS[shape].toLowerCase()}`;
}

/**
 * What a re-design changed, in a sentence: "DU-1's ducts re-designed as
 * rectangular: 14.2 m of duct (was 12.8 m), 9 elbows (was 7), 86 Pa for the
 * fan (was 92 Pa), first cost USD 1,240 (was USD 1,180)."
 */
export function systemRedesignSummary(
  unitName: string, shape: AutoDuctShape,
  before: { figures: DuctSystemFigures; appraisal: DuctSystemAppraisal },
  after: { figures: DuctSystemFigures; appraisal: DuctSystemAppraisal },
  currency: string,
): string {
  const elbows = (count: number) => `${count} elbow${count === 1 ? '' : 's'}`;
  return `${unitName}'s ducts re-designed ${shapePhrase(shape)}: ${metres(after.figures.lengthMm)} of duct (was ${metres(before.figures.lengthMm)}), `
    + `${elbows(after.figures.elbows)} (was ${before.figures.elbows}), ${Math.round(after.appraisal.espPa)} Pa for the fan (was ${Math.round(before.appraisal.espPa)} Pa), `
    + `first cost ${formatCost(after.appraisal.firstCost, currency)} (was ${formatCost(before.appraisal.firstCost, currency)}).`;
}

/** The figures of a unit's ducts as they stand (for the sentence). */
export function unitDuctFigures(scene: readonly HvacElement[], runIds: readonly string[], settings: DuctDesignSettings): DuctSystemFigures {
  const ids = new Set(runIds);
  return ductSystemFigures(scene, scene.filter((element) => ids.has(element.id)), settings);
}
