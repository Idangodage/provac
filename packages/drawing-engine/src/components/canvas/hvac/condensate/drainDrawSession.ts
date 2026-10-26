/**
 * Drawing a drain gap by hand: from the gap's open end, clicks on the plan
 * where the drain turns, finished on the other part's open end. The run is
 * then joined along the points and its whole network solved again for the
 * fall, as Auto route solves one (one undo). Resting on the other part's open
 * end shows the network as it would be; a network that cannot drain along the
 * points says why and drawing goes on. Backspace takes the last point back,
 * Esc cancels.
 */
import { create } from 'zustand';

import { useSmartDrawingStore } from '../../../../store';
import type { Point2D } from '../../../../types';
import { useSegmentUiStore } from '../segments/segmentUiStore';

import { condensateOpenEnds } from './condensateCut';
import { condensateEditContext } from './condensateEditController';
import { joinDrainAlong, type DrainJoin } from './condensateGapProposal';

export interface DrainDrawSession {
  gapId: string;
  /** The open end it starts from, and the other part's open end it finishes on (plan). */
  from: Point2D;
  to: Point2D | null;
  /** Where it turns, in order. */
  points: Point2D[];
}

export const useDrainDrawStore = create<{ session: DrainDrawSession | null }>(() => ({ session: null }));

const PREVIEW_ID = 'drain-draw';

function status(message: string): void {
  useSmartDrawingStore.getState().setProcessingStatus(message, false);
}

function clearPreview(): void {
  const segments = useSegmentUiStore.getState();
  if (segments.preview?.optionId === PREVIEW_ID) segments.setPreview(null);
}

/** Starts drawing the drain gap `gapId` on from its open end; false when it is not open. */
export function startDrainDraw(gapId: string): boolean {
  const ends = condensateOpenEnds(useSmartDrawingStore.getState().hvacElements).filter((end) => end.gap.id === gapId);
  const from = ends.find((end) => end.end === 'end');
  const to = ends.find((end) => end.end === 'start');
  if (!from) return false;
  // The plan's clicks are the drawing's now: nothing stays selected (a selected drain's handles would take them).
  useSmartDrawingStore.getState().setSelectedIds([]);
  useDrainDrawStore.setState({ session: { gapId, from: { x: from.point.x, y: from.point.y }, to: to ? { x: to.point.x, y: to.point.y } : null, points: [] } });
  status('Drawing the drain on from its open end: click where it turns, finish on the other part\'s open end. Backspace takes a point back, Esc cancels.');
  return true;
}

export function cancelDrainDraw(): void {
  if (!useDrainDrawStore.getState().session) return;
  useDrainDrawStore.setState({ session: null });
  clearPreview();
  status('Drawing the drain cancelled: the gap is still open.');
}

/** Stops drawing without a word (the gap closed or gone, the view or tool changed). */
export function stopDrainDraw(): void {
  if (!useDrainDrawStore.getState().session) return;
  useDrainDrawStore.setState({ session: null });
  clearPreview();
}

export function addDrainDrawPoint(point: Point2D): void {
  const session = useDrainDrawStore.getState().session;
  if (!session) return;
  const last = session.points[session.points.length - 1] ?? session.from;
  if (Math.hypot(point.x - last.x, point.y - last.y) < 1) return;
  useDrainDrawStore.setState({ session: { ...session, points: [...session.points, { ...point }] } });
}

export function undoDrainDrawPoint(): void {
  const session = useDrainDrawStore.getState().session;
  if (!session?.points.length) return;
  useDrainDrawStore.setState({ session: { ...session, points: session.points.slice(0, -1) } });
}

/** The network as it would be, joined along the points drawn (shown while the pointer rests on the other part's open end). */
export function previewDrainDraw(): DrainJoin | null {
  const session = useDrainDrawStore.getState().session;
  if (!session) return null;
  const joined = joinDrainAlong(useSmartDrawingStore.getState().hvacElements, session.gapId, session.points, condensateEditContext());
  if (joined.ok) useSegmentUiStore.getState().setPreview({ domain: 'condensate', optionId: PREVIEW_ID, updates: joined.updates, add: joined.add, removeIds: joined.removeIds });
  else clearPreview();
  return joined;
}

export function clearDrainDrawPreview(): void {
  clearPreview();
}

/** Finishes on the other part's open end: joined and solved (one undo). False, and why, when it cannot drain so. */
export function finishDrainDraw(): boolean {
  const session = useDrainDrawStore.getState().session;
  if (!session) return false;
  const state = useSmartDrawingStore.getState();
  const joined = joinDrainAlong(state.hvacElements, session.gapId, session.points, condensateEditContext());
  if (!joined.ok) {
    status(`${joined.message} Draw on, or Esc to cancel.`);
    return false;
  }
  const runId = joined.updates[0]?.id;
  state.commitHvacElementCommand('Draw drain', {
    updates: joined.updates.map((element) => ({ id: element.id, updates: element })),
    add: joined.add,
    removeIds: joined.removeIds,
    ...(runId ? { selectedIds: [runId] } : {}),
  });
  useDrainDrawStore.setState({ session: null });
  clearPreview();
  status(`Joined: the drain drawn, the gap closed; ${joined.note}.`);
  return true;
}
