/**
 * After a turn is stored: each turned unit's ducts re-designed by the Auto
 * duct optimiser for its new collars (in its worker, a few seconds), the
 * design joined to the turn's own undo step where it is the better of the
 * two (fewer errors, then the lower life-cycle cost); else the turn keeps its
 * own re-route and the status says why. Meanwhile the turn shows its own quick
 * re-route and a badge says the optimiser is at work (Esc, or the badge's
 * button, keeps the re-route). A newer turn, or a change meanwhile to what the
 * design replaces, leaves the turn as it was stored.
 */
import { create } from 'zustand';

import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';
import { cancelAutoDuctPreview } from '../duct/ductAutoController';
import type { AutoDuctResult } from '../duct/ductAutoLayout';
import { ductWallInputs } from '../duct/ductBuilding';
import { formatCost } from '../duct/ductEconomics';
import type { DuctDesignSettings } from '../duct/ductSettings';
import {
  appraiseDuctSystem, betterAppraisal, chooseTurnRedesign, turnRedesignAttempts, turnRedesignCommand, turnRedesignTargets,
  type DuctSystemAppraisal, type TurnRedesignCommand,
} from '../duct/ductTurnRedesign';
import { cancelAutoDuctWorker, runAutoDuctInWorker } from '../duct/optimizer/ductOptimizerClient';

import { terminalsTurnedWhole } from './ductNetworkMove';
import type { HvacMovePlan } from './hvacMoveModel';

export interface TurnRedesignBusy {
  unitIds: string[];
  /** "DU-1's ducts". */
  subject: string;
  /** The runs being re-designed (drawn faded until the design lands). */
  runIds: string[];
}

export const useTurnRedesignStore = create<{ busy: TurnRedesignBusy | null }>(() => ({ busy: null }));

let generation = 0;

/** Stop a re-design under way: the turn keeps its own re-route. */
export function cancelTurnRedesign(): boolean {
  if (!useTurnRedesignStore.getState().busy) return false;
  generation += 1;
  cancelAutoDuctWorker();
  useTurnRedesignStore.setState({ busy: null });
  useSmartDrawingStore.getState().setProcessingStatus('The turn keeps its re-routed ducts (Auto duct can re-design them).', false);
  return true;
}

/** The units and terminals a turn turned, and the terminals whose whole system turned with them (their layout holds). */
export function turnedBy(plan: HvacMovePlan, before: readonly HvacElement[]): { turnedIds: string[]; turnedWhole: Set<string> } {
  const turnedIds = [...plan.outcomes].filter(([, outcome]) => outcome.kind === 'moved').map(([id]) => id);
  return { turnedIds, turnedWhole: plan.rotation?.pivot ? terminalsTurnedWhole(before, new Set(turnedIds)) : new Set<string>() };
}

/** While a turn is dragged: what happens to the ducts on release, for the readout (null: nothing to say). */
export function turnRedesignNote(plan: HvacMovePlan, before: readonly HvacElement[], settings: DuctDesignSettings): string | null {
  const { turnedIds, turnedWhole } = turnedBy(plan, before);
  if (!turnedIds.length) return null;
  const { targets, skipped } = turnRedesignTargets(before, before, new Set(turnedIds), turnedWhole, settings);
  const lines = [
    ...(targets.length ? [`On release, ${targets.map((target) => target.unitName).join(' and ')}'s ducts are designed for the new collar.`] : []),
    ...skipped.map((entry) => `${entry.reason}.`),
  ];
  return lines.length ? lines.join(' ') : null;
}

const metres = (mm: number) => `${(mm / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} m`;

/** The drawing with a command applied (as the store applies it). */
function applied(scene: readonly HvacElement[], command: TurnRedesignCommand): HvacElement[] {
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

/**
 * Re-design the ducts of the units a turn just stored turned. `before` is the
 * drawing before the turn; `turnedWhole` the terminals whose whole system
 * turned with them (their layout holds); `label` the turn's undo step.
 */
export async function redesignAfterTurn(options: {
  before: readonly HvacElement[];
  turnedIds: readonly string[];
  turnedWhole: ReadonlySet<string>;
  label: string;
}): Promise<void> {
  const state = useSmartDrawingStore.getState();
  const after = state.hvacElements;
  // The turn's own undo step (the design joins it while it is still the latest).
  const turnStep = state.history[state.historyIndex];
  const settings = state.ductSettings;
  const { targets, skipped } = turnRedesignTargets(options.before, after, new Set(options.turnedIds), options.turnedWhole, settings);
  if (!targets.length) {
    if (skipped.length) state.setProcessingStatus(`${skipped.map((entry) => entry.reason).join('; ')}.`, false);
    return;
  }
  const token = ++generation;
  // (The optimiser's worker is shared with Auto duct's card: a preview being generated there is stopped cleanly.)
  cancelAutoDuctPreview();
  const subject = `${targets.map((target) => target.unitName).join(' and ')}'s ducts`;
  useTurnRedesignStore.setState({ busy: { unitIds: targets.map((target) => target.unitId), subject, runIds: targets.flatMap((target) => target.runIds) } });
  const walls = ductWallInputs(state.walls);
  const rooms = state.rooms.map((room) => ({ id: room.id, vertices: room.vertices }));
  let scene: HvacElement[] = [...after];
  const total = { add: [] as HvacElement[], removeIds: [] as string[], updates: [] as TurnRedesignCommand['updates'] };
  const lines: string[] = skipped.map((entry) => `${entry.reason}.`);
  try {
    for (const target of targets) {
      // The trunk's own shape first; where that gives no clean layout, the optimiser's own choice of shapes too.
      type Candidate = { result: AutoDuctResult; command: TurnRedesignCommand; next: HvacElement[]; appraisal: DuctSystemAppraisal };
      let best: Candidate | null = null;
      let failure: string | null = null;
      for (const attempt of turnRedesignAttempts(target)) {
        let result: AutoDuctResult;
        try {
          result = await runAutoDuctInWorker(scene, { ...attempt.request, walls, rooms }, settings);
        } catch (error) {
          if (token !== generation) return;
          if (error instanceof Error && error.message === 'cancelled') {
            // Auto duct's card took the optimiser meanwhile.
            useSmartDrawingStore.getState().setProcessingStatus('The turn keeps its re-routed ducts: Auto duct took the optimiser.', false);
            return;
          }
          failure = error instanceof Error ? error.message : 'unknown';
          break;
        }
        if (token !== generation) return;
        if (!result.runs.length) continue;
        const command = turnRedesignCommand(scene, result, target, settings, new Date().toISOString(), attempt.note);
        const next = applied(scene, command);
        // Appraised as the canvas checks it (the optimiser's own count can miss what the planner finds).
        const appraisal = appraiseDuctSystem(next, command.add.map((element) => element.id), settings, result.pricePerPa);
        // (A tie keeps the trunk's own shape, tried first.)
        if (!best || betterAppraisal(appraisal, best.appraisal)) best = { result, command, next, appraisal };
        if (!appraisal.errors.length) break;
      }
      if (!best) {
        lines.push(failure
          ? `${target.unitName}: the optimiser could not design its ducts (${failure}); they keep the turn's re-route.`
          : `${target.unitName}: no duct design fits here; its ducts keep the turn's re-route (Auto duct's card says why).`);
        continue;
      }
      const { result, command, next } = best;
      // The better of the two: the turn's own re-route as it stands, or the design (fewer errors, then the cheaper).
      const choice = chooseTurnRedesign(appraiseDuctSystem(scene, target.runIds, settings, result.pricePerPa), best.appraisal, result.currency);
      if (choice.take === 'reroute') {
        lines.push(`${target.unitName}'s ducts keep the turn's re-route: ${choice.why}.`);
        continue;
      }
      scene = next;
      total.add = [...total.add.filter((element) => !command.removeIds.includes(element.id)), ...command.add];
      total.removeIds = [...new Set([...total.removeIds, ...command.removeIds])];
      total.updates = [...total.updates, ...command.updates];
      const design = result.designs[result.selected];
      const figures = `${metres(command.after.lengthMm)} of duct (was ${metres(target.before.lengthMm)}), ${command.after.elbows} elbow${command.after.elbows === 1 ? '' : 's'} (was ${target.before.elbows})`;
      const pressure = result.requiredEspPa !== null ? `, ${Math.round(result.requiredEspPa)} Pa for the fan` : '';
      const cost = design ? `, first cost ${formatCost(design.firstCost, result.currency)}` : '';
      const notes = command.notes.join('; ');
      lines.push(`${target.unitName}'s ducts re-designed for the turn by the optimiser: ${figures}${pressure}${cost}${choice.why ? `; ${choice.why}` : ''}.${notes ? ` ${notes[0]!.toUpperCase()}${notes.slice(1)}.` : ''}`);
    }
    if (token !== generation) return;
    const now = useSmartDrawingStore.getState();
    // The turn's step still the latest, and nothing the design replaces or serves changed since: the design joins
    // that step (one undo for both). (A change elsewhere, made without a step of its own, is kept as it is.)
    const touched = new Set([
      ...total.removeIds, ...total.updates.map((entry) => entry.id),
      ...targets.flatMap((target) => [target.unitId, ...(target.request.terminalIds ?? [])]),
    ]);
    const was = new Map(after.map((element) => [element.id, element]));
    const current = now.hvacElements === after ? was : new Map(now.hvacElements.map((element) => [element.id, element]));
    const stepIsLatest = Boolean(turnStep) && now.history[now.historyIndex] === turnStep && now.historyIndex === now.history.length - 1;
    if (!stepIsLatest || [...touched].some((id) => was.get(id) !== current.get(id))) {
      now.setProcessingStatus('The drawing changed while the ducts were being re-designed: the turn keeps its re-route (Auto duct can re-design them).', false);
      return;
    }
    if (total.add.length || total.removeIds.length) {
      now.commitHvacElementCommand(options.label, { add: total.add, removeIds: total.removeIds, updates: total.updates }, { skipHistory: true });
      now.amendLastHistoryEntry(`${options.label}, ducts re-designed`);
    }
    now.setProcessingStatus(lines.join(' '), false);
  } finally {
    if (token === generation) useTurnRedesignStore.setState({ busy: null });
  }
}
