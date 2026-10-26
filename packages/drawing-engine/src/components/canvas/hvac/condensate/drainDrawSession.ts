/**
 * The drain tool (condensateDrawRoute): a drain drawn by hand on the plan.
 * Armed from the toolbox or the bar above the drawing, it waits for a start:
 * a unit's drain outlet or an open drain end. A gap's [Draw] starts it at the
 * gap's open end at once. Clicks on the plan then add the points where the
 * drain turns. Finishing on the other part's open end, on a drain (a wye) or on
 * a termination solves the network again for the fall, as Auto route does
 * (one undo). Resting on a finish shows the network as it would be; one that
 * cannot drain that way says why, and drawing goes on. Backspace takes the
 * last point back. Esc steps back: from drawing to picking a start (when the
 * tool is armed), then out of the tool.
 */
import { create } from 'zustand';

import { useSmartDrawingStore } from '../../../../store';
import type { Point2D } from '../../../../types';
import { useSegmentUiStore } from '../segments/segmentUiStore';

import { condensateOpenEnds } from './condensateCut';
import { drainDrawStarts, drainDrawTargets, drawDrainAlong, type DrainDrawStart, type DrainDrawTarget, type DrawnDrain } from './condensateDrawRoute';
import { condensateEditContext } from './condensateEditController';
import { seatedRiserFoot } from './condensateNetworkPlanner';
import { getCondensateOwnership } from './condensateTypes';

export interface DrainDrawSession {
  start: DrainDrawStart;
  /** The gap it closes (its open end's, or the unit connection's); null for a new drain. */
  gapId: string | null;
  /** Where the drawing starts: the open end, or the riser foot straight out of the unit's outlet. */
  from: Point2D;
  /** A unit's outlet (the stub to the riser foot is fixed). */
  outlet: Point2D | null;
  /** The other part's open end, when the gap has one: then the only place to finish. */
  to: Point2D | null;
  /** Where it turns, in order. */
  points: Point2D[];
}

export interface DrainToolState {
  /** The drain tool is armed: the plan's clicks pick where a drain starts. */
  armed: boolean;
  /** The design fall (%) a network it starts takes (the drain it was armed like); null: the drainage settings'. */
  fallPercent: number | null;
  session: DrainDrawSession | null;
}

export const useDrainDrawStore = create<DrainToolState>(() => ({ armed: false, fallPercent: null, session: null }));

const PREVIEW_ID = 'drain-draw';

function status(message: string): void {
  useSmartDrawingStore.getState().setProcessingStatus(message, false);
}

function clearPreview(): void {
  const segments = useSegmentUiStore.getState();
  if (segments.preview?.optionId === PREVIEW_ID) segments.setPreview(null);
}

const PICK_HINT = 'Drain tool: click a unit\'s drain outlet or an open drain end to start. Esc stops.';

/**
 * Arms the drain tool: the select tool's plan, nothing selected (the plan's clicks are the tool's). `fallPercent`: the
 * fall of a network it starts.
 */
export function armDrainTool(options: { fallPercent?: number | null } = {}): void {
  const store = useSmartDrawingStore.getState();
  if (store.activeTool !== 'select') store.setTool('select');
  store.setSelectedIds([]);
  clearPreview();
  useDrainDrawStore.setState({ armed: true, fallPercent: options.fallPercent ?? null, session: null });
  status(PICK_HINT);
}

/**
 * Starts drawing from `start` (a unit's outlet or an open end). From an outlet it leaves by the riser foot Auto route
 * would seat (false, and why, when none is clear).
 */
export function startDrainDrawFrom(picked: DrainDrawStart): boolean {
  const scene = useSmartDrawingStore.getState().hvacElements;
  let start = picked;
  if (picked.kind === 'unit') {
    // Its connection deleted: the network of the run it fed is the one it rejoins.
    const fed = picked.gapId ? condensateOpenEnds(scene).find((end) => end.gap.id === picked.gapId && end.end === 'start') : undefined;
    const run = fed ? scene.find((element) => element.id === fed.runId) : undefined;
    const editNetworkId = run ? getCondensateOwnership(run)?.networkId : undefined;
    const foot = seatedRiserFoot([...scene], picked.unitId, { ...condensateEditContext(), ...(editNetworkId ? { editNetworkId } : {}) });
    if (!foot) {
      status(`${picked.label}: no clear way out of its drain outlet (its riser or connection runs into something). Move what is beside it, or the unit.`);
      return false;
    }
    start = { ...picked, foot };
  }
  const targets = drainDrawTargets(scene, start);
  useSmartDrawingStore.getState().setSelectedIds([]);
  useDrainDrawStore.setState({
    session: {
      start,
      gapId: start.gapId,
      from: start.kind === 'unit' ? { ...start.foot } : { ...start.point },
      outlet: start.kind === 'unit' ? { ...start.outlet } : null,
      to: targets.partner,
      points: [],
    },
  });
  status(targets.partner
    ? 'Drawing the drain: click where it turns, finish on the other part\'s open end. Backspace takes a point back, Esc steps back.'
    : `Drawing the drain: click where it turns, finish on a drain (a wye) or a termination.${targets.reason ? ` ${targets.reason}` : ''} Backspace takes a point back, Esc steps back.`);
  return true;
}

/** Starts drawing the drain gap `gapId` from its open end (or its unit's outlet); false when it is not open. */
export function startDrainDraw(gapId: string): boolean {
  const state = useSmartDrawingStore.getState();
  const start = drainDrawStarts(state.hvacElements, state.condensateSettings).find((candidate) => candidate.gapId === gapId);
  return start ? startDrainDrawFrom(start) : false;
}

/** Esc: drawing goes back to picking a start while the tool is armed, else it ends; an armed tool with no drawing is put down. */
export function cancelDrainDraw(): void {
  const { armed, session } = useDrainDrawStore.getState();
  clearPreview();
  if (session) {
    useDrainDrawStore.setState({ session: null });
    if (armed) status(PICK_HINT);
    else status(session.gapId ? 'Drawing the drain cancelled: the gap is still open.' : 'Drawing the drain cancelled.');
    return;
  }
  if (armed) {
    useDrainDrawStore.setState({ armed: false });
    status('Drain tool put down.');
  }
}

/** Stops drawing and puts the tool down without a word (the gap closed or gone, the view or tool changed). */
export function stopDrainDraw(): void {
  const { armed, session } = useDrainDrawStore.getState();
  if (!armed && !session) return;
  useDrainDrawStore.setState({ armed: false, session: null });
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

function drawn(target: DrainDrawTarget): DrawnDrain | null {
  const { session, fallPercent } = useDrainDrawStore.getState();
  if (!session) return null;
  return drawDrainAlong(useSmartDrawingStore.getState().hvacElements, session.start, session.points, target, condensateEditContext(), { fallPercent });
}

/** The network as it would be, finished on `target` (shown while the pointer rests there). */
export function previewDrainDraw(target: DrainDrawTarget): DrawnDrain | null {
  const result = drawn(target);
  if (result?.ok) useSegmentUiStore.getState().setPreview({ domain: 'condensate', optionId: PREVIEW_ID, updates: result.updates, add: result.add, removeIds: result.removeIds });
  else clearPreview();
  return result;
}

export function clearDrainDrawPreview(): void {
  clearPreview();
}

/** Finishes on `target`: drawn and solved (one undo). False, and why, when it cannot drain so. */
export function finishDrainDraw(target: DrainDrawTarget): boolean {
  const { session, armed } = useDrainDrawStore.getState();
  const result = drawn(target);
  if (!session || !result) return false;
  if (!result.ok) {
    status(`${result.message} Draw on, or Esc to step back.`);
    return false;
  }
  const state = useSmartDrawingStore.getState();
  state.commitHvacElementCommand('Draw drain', {
    updates: result.updates.map((element) => ({ id: element.id, updates: element })),
    add: result.add,
    removeIds: result.removeIds,
    // The tool stays armed for the next drain; drawn from a gap's [Draw], the drain is selected.
    ...(result.runId && !armed ? { selectedIds: [result.runId] } : {}),
  });
  useDrainDrawStore.setState({ session: null });
  clearPreview();
  const onto = target.kind === 'partner' ? null : state.hvacElements.find((element) => element.id === (target.kind === 'pipe' ? target.pipeId : target.gullyId));
  const what = target.kind === 'partner' ? 'Joined: the drain drawn, the gap closed'
    : target.kind === 'pipe' ? `Drain drawn, joined to ${onto?.label || 'the drain'} with a wye` : `Drain drawn into ${onto?.label || 'the termination'}`;
  status(`${what}; ${result.note}.${armed ? ' Click the next outlet or open end, or Esc to stop.' : ''}`);
  return true;
}
