/**
 * Reconnect proposals on the drawing: the gap the pointer is at (a duct's, or
 * a refrigerant line's), the way to reconnect it that is shown (as a preview,
 * in plan and 3D) and the chip's actions — Apply (one undo), another way,
 * dismiss, and reconnecting every gap at once. The ways come from
 * ductGapProposal and refrigerantGapProposal, computed once per gap and
 * drawing.
 */
import { create } from 'zustand';

import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';
import { refrigerantOpenEnds } from '../refrigerant/refrigerantCut';
import { proposeRefrigerantGap } from '../refrigerant/refrigerantGapProposal';
import { useSegmentUiStore } from '../segments/segmentUiStore';

import { getActiveDuctBuilding } from './ductBuilding';
import { ductOpenEnds } from './ductCut';
import { proposeDuctGap } from './ductGapProposal';
import type { DuctDesignSettings } from './ductSettings';

export type GapDomain = 'duct' | 'refrigerant';

/** One way to reconnect a gap, whichever service it is in. */
export interface GapWay {
  key: string;
  label: string;
  updates: HvacElement[];
  removeIds: string[];
  /** The new stretch (a pair's gas line), its length and turns. */
  bridge: Array<{ x: number; y: number; z: number }>;
  /** The new stretch of every line the way joins (a pair's two). */
  bridges?: Array<Array<{ x: number; y: number; z: number }>>;
  lengthMm: number;
  elbows: number;
}

export interface GapProposals {
  gapId: string;
  domain: GapDomain;
  candidates: GapWay[];
  reason: string | null;
}

interface GapUiState {
  /** The gap the pointer is at, its ways and the one shown. */
  gapId: string | null;
  proposals: GapProposals | null;
  index: number;
  /** A gap dismissed with Esc stays quiet until the pointer leaves it. */
  dismissed: string | null;
}

export const useDuctGapStore = create<GapUiState>(() => ({ gapId: null, proposals: null, index: 0, dismissed: null }));

const PREVIEW_PREFIX = 'gap:';
let cache: { scene: unknown; settings: unknown; gapId: string; proposals: GapProposals } | null = null;

/** Which service a gap is in (a refrigerant line's open end remembers it, else a duct's). */
export function gapDomainOf(scene: readonly HvacElement[], gapId: string): GapDomain {
  return refrigerantOpenEnds(scene).some((end) => end.gap.id === gapId) ? 'refrigerant' : 'duct';
}

/** The ways to reconnect gap `gapId` in `scene`, best first. */
export function proposeGap(scene: readonly HvacElement[], gapId: string, settings: DuctDesignSettings): GapProposals {
  if (gapDomainOf(scene, gapId) === 'refrigerant') {
    const result = proposeRefrigerantGap(scene, gapId);
    return { gapId, domain: 'refrigerant', candidates: result.candidates, reason: result.reason };
  }
  const result = proposeDuctGap(scene, gapId, settings, getActiveDuctBuilding());
  return { gapId, domain: 'duct', candidates: result.candidates, reason: result.reason };
}

function proposalsFor(gapId: string): GapProposals {
  const state = useSmartDrawingStore.getState();
  if (cache && cache.scene === state.hvacElements && cache.settings === state.ductSettings && cache.gapId === gapId) return cache.proposals;
  const proposals = proposeGap(state.hvacElements, gapId, state.ductSettings);
  cache = { scene: state.hvacElements, settings: state.ductSettings, gapId, proposals };
  return proposals;
}

/** The shown way on the drawing (an option preview of the gap's service), or none. */
function publish(): void {
  const { proposals, index } = useDuctGapStore.getState();
  const segments = useSegmentUiStore.getState();
  const candidate = proposals?.candidates[index] ?? null;
  if (candidate) {
    segments.setPreview({ domain: proposals!.domain, optionId: `${PREVIEW_PREFIX}${proposals!.gapId}:${candidate.key}`, updates: candidate.updates, removeIds: candidate.removeIds });
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

/** "elbows" for a duct, "bends" for a pipe. */
export function turnsLabel(domain: GapDomain, count: number): string {
  return domain === 'duct' ? `elbow${count === 1 ? '' : 's'}` : `bend${count === 1 ? '' : 's'}`;
}

/** Applies the way shown (one undo); the joined run (or line) is selected. */
export function applyGapWay(): boolean {
  const { proposals, index } = useDuctGapStore.getState();
  const candidate = proposals?.candidates[index];
  if (!proposals || !candidate) return false;
  const state = useSmartDrawingStore.getState();
  const runId = candidate.updates[0]?.id;
  const what = proposals.domain === 'duct' ? 'duct' : candidate.updates.length > 1 ? 'refrigerant lines' : 'refrigerant line';
  state.commitHvacElementCommand(`Reconnect ${what} (${candidate.label.toLowerCase()})`, {
    updates: candidate.updates.map((element) => ({ id: element.id, updates: element })),
    removeIds: candidate.removeIds,
    selectedIds: runId ? [runId] : [],
  });
  useDuctGapStore.setState({ gapId: null, proposals: null, index: 0, dismissed: null });
  publish();
  const metres = (candidate.lengthMm / 1000).toFixed(2);
  const lines = proposals.domain === 'refrigerant' && candidate.updates.length > 1 ? ' (gas + liquid)' : '';
  state.setProcessingStatus(`Reconnected${lines}: ${candidate.label.toLowerCase()}, ${metres} m, ${candidate.elbows} ${turnsLabel(proposals.domain, candidate.elbows)}.`, false);
  return true;
}

/** The ids of the gaps open on the drawing (each once): ducts', then refrigerant lines'. */
export function openGapIds(): string[] {
  const scene = useSmartDrawingStore.getState().hvacElements;
  return [...new Set([
    ...ductOpenEnds(scene).flatMap((end) => (end.gap ? [end.gap.id] : [])),
    ...refrigerantOpenEnds(scene).filter((end) => end.gap.partner || end.gap.was).map((end) => end.gap.id),
  ])];
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
    const best = proposeGap(scene, gapId, state.ductSettings).candidates[0];
    if (!best) continue;
    const replaced = new Map(best.updates.map((element) => [element.id, element]));
    scene = scene.filter((element) => !best.removeIds.includes(element.id)).map((element) => replaced.get(element.id) ?? element);
    for (const element of best.updates) updates.set(element.id, element);
    for (const id of best.removeIds) { removed.add(id); updates.delete(id); }
    reconnected += 1;
  }
  if (reconnected) {
    state.commitHvacElementCommand(`Reconnect ${reconnected} gap${reconnected === 1 ? '' : 's'}`, {
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
