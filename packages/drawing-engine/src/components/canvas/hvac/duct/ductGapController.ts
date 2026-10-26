/**
 * Reconnect proposals on the drawing: the gap the pointer is at, the way to
 * reconnect it that is shown (as a preview, in plan and 3D) and the chip's
 * actions — Apply (one undo), another way, dismiss, and reconnecting every gap
 * at once. The ways come from ductGapProposal, computed once per gap and
 * drawing.
 */
import { create } from 'zustand';

import { useSmartDrawingStore } from '../../../../store';
import { useSegmentUiStore } from '../segments/segmentUiStore';

import { getActiveDuctBuilding } from './ductBuilding';
import { ductOpenEnds } from './ductCut';
import { proposeDuctGap, type DuctGapProposals } from './ductGapProposal';

interface DuctGapUiState {
  /** The gap the pointer is at, its ways and the one shown. */
  gapId: string | null;
  proposals: DuctGapProposals | null;
  index: number;
  /** A gap dismissed with Esc stays quiet until the pointer leaves it. */
  dismissed: string | null;
}

export const useDuctGapStore = create<DuctGapUiState>(() => ({ gapId: null, proposals: null, index: 0, dismissed: null }));

const PREVIEW_PREFIX = 'gap:';
let cache: { scene: unknown; settings: unknown; gapId: string; proposals: DuctGapProposals } | null = null;

function proposalsFor(gapId: string): DuctGapProposals {
  const state = useSmartDrawingStore.getState();
  if (cache && cache.scene === state.hvacElements && cache.settings === state.ductSettings && cache.gapId === gapId) return cache.proposals;
  const proposals = proposeDuctGap(state.hvacElements, gapId, state.ductSettings, getActiveDuctBuilding());
  cache = { scene: state.hvacElements, settings: state.ductSettings, gapId, proposals };
  return proposals;
}

/** The shown way on the drawing (a duct option preview), or none. */
function publish(): void {
  const { proposals, index } = useDuctGapStore.getState();
  const segments = useSegmentUiStore.getState();
  const candidate = proposals?.candidates[index] ?? null;
  if (candidate) {
    segments.setPreview({ domain: 'duct', optionId: `${PREVIEW_PREFIX}${proposals!.gapId}:${candidate.key}`, updates: candidate.updates, removeIds: candidate.removeIds });
  } else if (segments.preview?.optionId.startsWith(PREVIEW_PREFIX)) {
    segments.setPreview(null);
  }
}

/** The pointer is at a gap (or at none): its ways are shown, best first. */
export function pointAtGap(gapId: string | null): void {
  const current = useDuctGapStore.getState();
  if (gapId === current.dismissed) gapId = null;
  if (!gapId) {
    if (current.gapId || current.dismissed) useDuctGapStore.setState({ gapId: null, proposals: null, index: 0, dismissed: null });
    publish();
    return;
  }
  const proposals = proposalsFor(gapId);
  if (current.gapId === gapId && current.proposals === proposals) return;
  useDuctGapStore.setState({ gapId, proposals, index: current.gapId === gapId ? Math.min(current.index, Math.max(0, proposals.candidates.length - 1)) : 0 });
  publish();
}

/** The next way (Tab), round to the first. */
export function nextGapWay(): void {
  const { proposals, index } = useDuctGapStore.getState();
  if (!proposals || proposals.candidates.length < 2) return;
  useDuctGapStore.setState({ index: (index + 1) % proposals.candidates.length });
  publish();
}

/** Esc: the chip and the preview go until the pointer leaves the gap. */
export function dismissGap(): void {
  const { gapId } = useDuctGapStore.getState();
  useDuctGapStore.setState({ gapId: null, proposals: null, index: 0, dismissed: gapId });
  publish();
}

/** Applies the way shown (one undo); the joined run is selected. */
export function applyGapWay(): boolean {
  const { proposals, index } = useDuctGapStore.getState();
  const candidate = proposals?.candidates[index];
  if (!candidate) return false;
  const state = useSmartDrawingStore.getState();
  const runId = candidate.updates[0]?.id;
  state.commitHvacElementCommand(`Reconnect duct (${candidate.label.toLowerCase()})`, {
    updates: candidate.updates.map((element) => ({ id: element.id, updates: element })),
    removeIds: candidate.removeIds,
    selectedIds: runId ? [runId] : [],
  });
  useDuctGapStore.setState({ gapId: null, proposals: null, index: 0, dismissed: null });
  publish();
  const metres = (candidate.lengthMm / 1000).toFixed(2);
  state.setProcessingStatus(`Reconnected: ${candidate.label.toLowerCase()}, ${metres} m, ${candidate.elbows} elbow${candidate.elbows === 1 ? '' : 's'}.`, false);
  return true;
}

/** The ids of the gaps open on the drawing (each once). */
export function openGapIds(): string[] {
  return [...new Set(ductOpenEnds(useSmartDrawingStore.getState().hvacElements).flatMap((end) => (end.gap ? [end.gap.id] : [])))];
}

/** Every open gap reconnected the best way, one after another on the drawing as it becomes (one undo). */
export function reconnectAllGaps(): { reconnected: number; left: number } {
  const state = useSmartDrawingStore.getState();
  let scene = state.hvacElements;
  const updates = new Map<string, (typeof scene)[number]>();
  const removed = new Set<string>();
  let reconnected = 0;
  const ids = openGapIds();
  for (const gapId of ids) {
    const best = proposeDuctGap(scene, gapId, state.ductSettings, getActiveDuctBuilding()).candidates[0];
    if (!best) continue;
    const replaced = new Map(best.updates.map((element) => [element.id, element]));
    scene = scene.filter((element) => !best.removeIds.includes(element.id)).map((element) => replaced.get(element.id) ?? element);
    for (const element of best.updates) updates.set(element.id, element);
    for (const id of best.removeIds) { removed.add(id); updates.delete(id); }
    reconnected += 1;
  }
  if (reconnected) {
    state.commitHvacElementCommand(`Reconnect ${reconnected} duct gap${reconnected === 1 ? '' : 's'}`, {
      updates: [...updates.values()].filter((element) => !removed.has(element.id)).map((element) => ({ id: element.id, updates: element })),
      removeIds: [...removed],
    });
  }
  useDuctGapStore.setState({ gapId: null, proposals: null, index: 0, dismissed: null });
  publish();
  const left = ids.length - reconnected;
  state.setProcessingStatus(`${reconnected} gap${reconnected === 1 ? '' : 's'} reconnected${left ? `; ${left} with no clear way (draw ${left === 1 ? 'it' : 'them'})` : ''}.`, false);
  return { reconnected, left };
}
