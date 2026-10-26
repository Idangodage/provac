/**
 * Delete with pieces picked: only those pieces go, not their runs (ductCut for
 * ducts). One undo step; the status bar says what went and what was left
 * open. Picks count only on runs still selected. With no piece picked Delete
 * deletes the selection whole, as before.
 */
import { useSmartDrawingStore } from '../../../../store';
import { getActiveDuctBuilding } from '../duct/ductBuilding';
import { cutDuctPieces } from '../duct/ductCut';

import { domainOf, useSegmentUiStore } from './segmentUiStore';

/** The pieces Delete would take now (picked on selected runs). */
export function deletablePicks() {
  const ui = useSegmentUiStore.getState();
  const selected = new Set(useSmartDrawingStore.getState().selectedElementIds);
  const picks = ui.picked.length ? ui.picked : ui.pinned ? [ui.pinned] : [];
  return picks.filter((pick) => selected.has(pick.runId));
}

/** Deletes the picked pieces; false when there are none (the caller deletes the selection whole). */
export function deletePickedPieces(): boolean {
  const picks = deletablePicks();
  const ductPicks = picks.filter((pick) => domainOf(pick) === 'duct');
  if (!ductPicks.length) return false;
  const state = useSmartDrawingStore.getState();
  const result = cutDuctPieces(state.hvacElements, ductPicks.map(({ runId, key }) => ({ runId, key })), {
    settings: state.ductSettings, building: getActiveDuctBuilding(),
  });
  if (!result.pieces) {
    state.setProcessingStatus(result.refused.length ? `${result.refused.map((refusal) => refusal.reason).join('; ')}.` : 'Nothing there to delete.', false);
    return true;
  }
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const action = `Delete ${plural(result.pieces, 'piece')}`;
  state.commitHvacElementCommand(action, {
    add: result.add,
    updates: result.updates.map((element) => ({ id: element.id, updates: element })),
    removeIds: result.removeIds,
    selectedIds: [],
  });
  useSegmentUiStore.getState().unpin();
  const left = [
    ...(result.gaps ? [`${plural(result.gaps, 'gap')} left open`] : []),
    ...(result.orphaned === 1 ? ['1 branch without its take-off'] : result.orphaned > 1 ? [`${result.orphaned} branches without their take-off`] : []),
  ];
  const open = left.length ? ` ${left.join(', and ')}: point at a gap to reconnect it, or draw it.` : '';
  const refused = result.refused.length ? ` ${result.refused.map((refusal) => refusal.reason).join('; ')}.` : '';
  state.setProcessingStatus(`${plural(result.pieces, 'piece')} deleted.${open}${refused}`, false);
  return true;
}
