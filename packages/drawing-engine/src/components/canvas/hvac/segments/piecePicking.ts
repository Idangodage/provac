/**
 * Picking pieces with a modifier held, the same in every view: Ctrl/⌘ + click
 * puts a piece in or out of the picks; Shift + click adds the stretch of its
 * run from the last piece picked on that run (a piece of another run is added
 * on its own). A plain click pins one piece alone (the segment store's `pin`).
 */
import { useSmartDrawingStore } from '../../../../store';
import { condensateRunOf } from '../condensate/condensatePieces';
import { getDuctRunPlan } from '../duct/ductFabricationPlanner';
import { ductSegments } from '../duct/ductSegments';
import { refrigerantLineOf } from '../refrigerant/refrigerantPieces';

import { domainOf, useSegmentUiStore, type SegmentFocus } from './segmentUiStore';

/** The keys of a run's pieces in their order along it (null when its service does not say). */
function orderedKeys(focus: SegmentFocus): string[] | null {
  const state = useSmartDrawingStore.getState();
  const element = state.hvacElements.find((entry) => entry.id === focus.runId);
  if (!element) return null;
  if (domainOf(focus) === 'duct') {
    const plan = getDuctRunPlan(element, state.hvacElements, state.ductSettings);
    return plan ? ductSegments(plan).map((segment) => segment.key) : null;
  }
  if (domainOf(focus) === 'refrigerant') return refrigerantLineOf(element, state.hvacElements)?.pieces.map((piece) => piece.key) ?? null;
  if (domainOf(focus) === 'condensate') return condensateRunOf(element)?.pieces.map((piece) => piece.key) ?? null;
  return null;
}

/** A modified click on a piece: Ctrl/⌘ toggles it, Shift (`range`) adds the stretch to it. */
export function pickWithModifier(focus: SegmentFocus, range: boolean): void {
  const store = useSegmentUiStore.getState();
  if (!range) {
    store.togglePick(focus);
    return;
  }
  const anchor = [...store.picked].reverse().find((pick) => domainOf(pick) === domainOf(focus) && pick.runId === focus.runId);
  const keys = anchor ? orderedKeys(focus) : null;
  const from = anchor && keys ? keys.indexOf(anchor.key) : -1;
  const to = keys ? keys.indexOf(focus.key) : -1;
  if (!keys || from < 0 || to < 0) {
    store.addPicks([focus]);
    return;
  }
  const stretch = keys.slice(Math.min(from, to), Math.max(from, to) + 1)
    .filter((key) => key !== focus.key)
    .map((key): SegmentFocus => ({ ...focus, key, anchorMark: null }));
  // The clicked piece last: the card shows it.
  store.addPicks([...stretch, focus]);
}
