/**
 * Delete with pieces picked: only those pieces go, not their runs (ductCut for
 * ducts, refrigerantCut for refrigerant lines; a coordinated pair loses the
 * same stretch on both lines unless Alt is held). One undo step for all of
 * them; the status bar says what went and what was left open. Picks count only
 * on runs still selected. With no piece picked Delete deletes the selection
 * whole, as before.
 */
import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';
import { getActiveDuctBuilding } from '../duct/ductBuilding';
import { cutDuctPieces } from '../duct/ductCut';
import { cutRefrigerantPieces } from '../refrigerant/refrigerantCut';

import { domainOf, useSegmentUiStore } from './segmentUiStore';

/** The pieces Delete would take now (picked on selected runs). */
export function deletablePicks() {
  const ui = useSegmentUiStore.getState();
  const selected = new Set(useSmartDrawingStore.getState().selectedElementIds);
  const picks = ui.picked.length ? ui.picked : ui.pinned ? [ui.pinned] : [];
  return picks.filter((pick) => selected.has(pick.runId));
}

/** Deletes the picked pieces; false when there are none (the caller deletes the selection whole). `alt`: a pair's picked line only. */
export function deletePickedPieces(options: { alt?: boolean } = {}): boolean {
  const picks = deletablePicks();
  const ductPicks = picks.filter((pick) => domainOf(pick) === 'duct');
  const pipePicks = picks.filter((pick) => domainOf(pick) === 'refrigerant');
  if (!ductPicks.length && !pipePicks.length) return false;
  const state = useSmartDrawingStore.getState();
  const ducts = ductPicks.length
    ? cutDuctPieces(state.hvacElements, ductPicks.map(({ runId, key }) => ({ runId, key })), { settings: state.ductSettings, building: getActiveDuctBuilding() })
    : null;
  const pipes = pipePicks.length ? cutRefrigerantPieces(state.hvacElements, pipePicks.map(({ runId, key }) => ({ runId, key })), { pairs: !options.alt }) : null;
  const pieces = (ducts?.pieces ?? 0) + (pipes?.pieces ?? 0);
  const refused = [...(ducts?.refused ?? []), ...(pipes?.refused ?? [])];
  if (!pieces) {
    state.setProcessingStatus(refused.length ? `${refused.map((refusal) => refusal.reason).join('; ')}.` : 'Nothing there to delete.', false);
    return true;
  }
  const updates: HvacElement[] = [...(ducts?.updates ?? []), ...(pipes?.updates ?? [])];
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  state.commitHvacElementCommand(`Delete ${plural(pieces, 'piece')}`, {
    add: [...(ducts?.add ?? []), ...(pipes?.add ?? [])],
    updates: updates.map((element) => ({ id: element.id, updates: element })),
    removeIds: [...(ducts?.removeIds ?? []), ...(pipes?.removeIds ?? [])],
    selectedIds: [],
  });
  useSegmentUiStore.getState().unpin();
  const gaps = (ducts?.gaps ?? 0) + (pipes?.gaps ?? 0);
  const orphaned = ducts?.orphaned ?? 0;
  const left = [
    ...(gaps ? [`${plural(gaps, 'gap')} left open`] : []),
    ...(orphaned === 1 ? ['1 branch without its take-off'] : orphaned > 1 ? [`${orphaned} branches without their take-off`] : []),
  ];
  const open = left.length ? ` ${left.join(', and ')}: point at a gap to reconnect it, or draw it.` : '';
  const refusedText = refused.length ? ` ${refused.map((refusal) => refusal.reason).join('; ')}.` : '';
  state.setProcessingStatus(`${plural(pieces, 'piece')} deleted.${open}${refusedText}`, false);
  return true;
}
