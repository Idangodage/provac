/**
 * Store-facing duct edits: every gesture is one command (one undo) that also
 * carries whatever follows from it — branches re-anchored on their parent,
 * runs moved with their unit. The engine functions stay pure (ductFollow.ts).
 */
import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';

import { findReattachTarget, REATTACH_REACH_MM } from './ductBranchTargets';
import { applyDuctRunEdit, type DuctEditResult } from './ductEdits';
import { ductRunElementWithSpec, followDuctsForUnitMove, moveDuctRuns, reanchorBranches, toElementUpdate } from './ductFollow';
import type { DuctRunSpec, DuctTapStyle } from './ductTypes';

/** Runs that follow moved units, to fold into the move's own command. */
export function followDuctsForMove(before: readonly HvacElement[], after: readonly HvacElement[], movedIds: readonly string[]): HvacElement[] {
  return followDuctsForUnitMove(before, after, movedIds, useSmartDrawingStore.getState().ductSettings);
}

/**
 * Runs follow an equipment drag that the caller records in its own history
 * step (the drag commits the unit with skipHistory, then saves once).
 */
export function followDuctsWithoutHistory(before: readonly HvacElement[], after: readonly HvacElement[], movedIds: readonly string[]): void {
  const moved = followDuctsForMove(before, after, movedIds);
  if (moved.length === 0) return;
  useSmartDrawingStore.getState().commitHvacElementCommand('Ducts follow', { updates: moved.map(toElementUpdate) }, { skipHistory: true });
}

/** Commit a changed run spec; its branch tree is re-anchored in the same command. */
export function commitDuctRunSpec(element: HvacElement, spec: DuctRunSpec, action: string): void {
  const state = useSmartDrawingStore.getState();
  const next = ductRunElementWithSpec(element, spec);
  const scene = state.hvacElements.map((candidate) => (candidate.id === element.id ? next : candidate));
  const branches = reanchorBranches(scene, new Map([[element.id, next]]), state.ductSettings);
  state.commitHvacElementCommand(action, { updates: [next, ...branches].map(toElementUpdate) });
}

/** Commit an in-place edit (a leg, the end or a riser moved; a rise changed): one command, branches follow. */
export function commitDuctRunEdit(elementId: string, result: DuctEditResult, action: string): void {
  const state = useSmartDrawingStore.getState();
  const element = state.hvacElements.find((candidate) => candidate.id === elementId);
  if (!element) return;
  state.commitHvacElementCommand(action, { updates: applyDuctRunEdit(state.hvacElements, element, result, state.ductSettings).map(toElementUpdate) });
}

/** Move the selected runs by a plan delta (one command); branches follow. */
export function commitDuctRunMove(ids: readonly string[], delta: { x: number; y: number }): void {
  const state = useSmartDrawingStore.getState();
  const result = moveDuctRuns(state.hvacElements, ids, delta, state.ductSettings);
  if (result.refused) state.setProcessingStatus(result.refused, false);
  if (result.moved.length === 0) return;
  state.commitHvacElementCommand('Move duct run', { updates: result.moved.map(toElementUpdate) });
}

/**
 * Re-attach a run with an open start (e.g. orphaned by a deleted parent) as a
 * take-off on the nearest run wall behind it; one command, branches follow.
 */
export function reattachDuctRun(element: HvacElement, options: { style: DuctTapStyle; vcd: boolean }): boolean {
  const state = useSmartDrawingStore.getState();
  const target = findReattachTarget(element, state.hvacElements, state.ductSettings, options);
  if (!target) {
    state.setProcessingStatus(`No duct run wall lies square behind this open start within ${REATTACH_REACH_MM / 1000} m.`, false);
    return false;
  }
  commitDuctRunSpec(element, target.spec, 'Re-attach duct branch');
  state.setProcessingStatus(`Re-attached as a take-off on ${target.parent.label || target.parent.id}.`, false);
  return true;
}
