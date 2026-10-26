/**
 * "Re-design DU-1 as …": the unit's ducts designed again by the Auto duct
 * optimiser in the shape chosen (in its worker, a few seconds), as the system
 * was set (its terminals, airflows, services, sizing basis, fan speed), and
 * applied as one undo step — where the design breaks no more rules than the
 * ducts it replaces; else they stay, and the status says why. The status says
 * what changed: metres of duct, elbows, the fan's pressure, the first cost. A
 * change meanwhile to what the design replaces or serves leaves them as they are.
 */
import { create } from 'zustand';

import { useSmartDrawingStore } from '../../../../store';

import { cancelAutoDuctPreview } from './ductAutoController';
import type { AutoDuctResult, AutoDuctShape } from './ductAutoLayout';
import { ductWallInputs } from './ductBuilding';
import { shapePhrase, systemRedesignSummary, systemRedesignTarget, unitDuctFigures, withRedesignApplied } from './ductSystemRedesign';
import { appraiseDuctSystem, describeDuctErrors, ductSystemFigures, turnRedesignCommand } from './ductTurnRedesign';
import { cancelAutoDuctWorker, runAutoDuctInWorker } from './optimizer/ductOptimizerClient';
import { designSettingsForUnit } from './unitCriteria';

export interface SystemRedesignBusy {
  unitId: string;
  shape: AutoDuctShape;
  /** "DU-1's ducts". */
  subject: string;
}

export const useSystemRedesignStore = create<{ busy: SystemRedesignBusy | null }>(() => ({ busy: null }));

let generation = 0;

/** Stop a re-design under way: the ducts stay as they are. */
export function cancelSystemRedesign(): boolean {
  const busy = useSystemRedesignStore.getState().busy;
  if (!busy) return false;
  generation += 1;
  cancelAutoDuctWorker();
  useSystemRedesignStore.setState({ busy: null });
  useSmartDrawingStore.getState().setProcessingStatus(`${busy.subject} stay as they are.`, false);
  return true;
}

/** Re-design a unit's ducts in `shape` (one undo step when taken). */
export async function redesignSystemAs(unitId: string, shape: AutoDuctShape): Promise<void> {
  const state = useSmartDrawingStore.getState();
  const scene = state.hvacElements;
  // By the unit's own design criteria, else the rooms' it serves, else the project's.
  const settings = designSettingsForUnit(state.ductSettings, scene.find((element) => element.id === unitId), { scene, rooms: state.rooms });
  const asked = systemRedesignTarget(scene, unitId, shape, settings);
  if ('reason' in asked) {
    state.setProcessingStatus(`${asked.reason}.`, false);
    return;
  }
  const { target } = asked;
  const token = ++generation;
  // (The optimiser's worker is shared with Auto duct's card and the turn re-design: a preview being generated on the
  // card is stopped cleanly; a design started later stops this one, and the status says so.)
  cancelAutoDuctPreview();
  const subject = `${target.unitName}'s ducts`;
  useSystemRedesignStore.setState({ busy: { unitId, shape, subject } });
  try {
    let result: AutoDuctResult;
    try {
      result = await runAutoDuctInWorker(scene, {
        ...target.request, walls: ductWallInputs(state.walls), rooms: state.rooms.map((room) => ({ id: room.id, vertices: room.vertices })),
      }, settings);
    } catch (error) {
      if (token !== generation) return;
      const why = error instanceof Error && error.message === 'cancelled' ? 'another design took the optimiser' : error instanceof Error ? error.message : 'unknown';
      useSmartDrawingStore.getState().setProcessingStatus(`${subject} stay as they are: the optimiser stopped (${why}).`, false);
      return;
    }
    if (token !== generation) return;
    if (!result.runs.length) {
      // Why, in the optimiser's own words (its first error).
      const why = [...result.issues, ...result.services.flatMap((service) => service.issues)].find((issue) => issue.severity === 'error')?.message;
      useSmartDrawingStore.getState().setProcessingStatus(`No layout ${shapePhrase(shape)} fits ${target.unitName}'s terminals: its ducts stay as they are.${why ? ` ${why}` : ''}`, false);
      return;
    }
    const command = turnRedesignCommand(scene, result, target, settings, new Date().toISOString());
    const next = withRedesignApplied(scene, command);
    const after = appraiseDuctSystem(next, command.add.map((element) => element.id), settings, result.pricePerPa);
    const before = appraiseDuctSystem(scene, target.runIds, settings, result.pricePerPa);
    if (after.errors.length > before.errors.length) {
      useSmartDrawingStore.getState().setProcessingStatus(
        `${target.unitName}'s design ${shapePhrase(result.shape)} would break ${describeDuctErrors(after.errors)}: its ducts stay as they are.`, false);
      return;
    }
    // Nothing the design replaces or serves changed meanwhile.
    const now = useSmartDrawingStore.getState();
    const touched = new Set([...command.removeIds, ...command.updates.map((entry) => entry.id), target.unitId, ...target.request.terminalIds]);
    const was = new Map(scene.map((element) => [element.id, element]));
    const current = new Map(now.hvacElements.map((element) => [element.id, element]));
    if ([...touched].some((id) => was.get(id) !== current.get(id))) {
      now.setProcessingStatus(`The drawing changed while ${subject} were being re-designed: they stay as they are.`, false);
      return;
    }
    now.commitHvacElementCommand(`Re-design ${target.unitName} ${shapePhrase(result.shape)}`, { add: command.add, removeIds: command.removeIds, updates: command.updates });
    const summary = systemRedesignSummary(target.unitName, result.shape,
      { figures: unitDuctFigures(scene, target.runIds, settings), appraisal: before },
      { figures: ductSystemFigures(next, command.add, settings), appraisal: after }, result.currency);
    // Said too: a rectangular design that fell back, and what the command could not carry over.
    const fellBack = result.issues.find((issue) => issue.code === 'DU_AUTO_SHAPE');
    const notes = [...(fellBack ? [fellBack.message] : []), ...command.notes];
    now.setProcessingStatus([summary, ...notes.map((note) => `${note[0]!.toUpperCase()}${note.slice(1)}${/[.!?]$/.test(note) ? '' : '.'}`)].join(' '), false);
  } finally {
    if (token === generation) useSystemRedesignStore.setState({ busy: null });
  }
}
