/**
 * Store-facing duct edits: every gesture is one command (one undo) that also
 * carries whatever follows from it — branches re-anchored on their parent,
 * runs moved with their unit. The engine functions stay pure (ductFollow.ts).
 */
import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';

import { findReattachTarget, REATTACH_REACH_MM } from './ductBranchTargets';
import { applyDuctRunEdit, type DuctEditResult } from './ductEdits';
import { ductRunElementWithSpec, followDuctsForUnitMove, moveDuctRuns, reanchorBranchesKeepingEnds, toElementUpdate } from './ductFollow';
import {
  nextTerminalTag,
  readDuctTerminalSpec,
  TERMINAL_TAG_PATTERN,
  terminalEnvelope,
  terminalTypeTag,
  typicalTerminalSpec,
  type DuctTerminalKind,
  type DuctTerminalSpec,
} from './ductTerminals';
import { isDuctElement, readDuctRunSpec, type DuctRunSpec, type DuctService, type DuctTapStyle } from './ductTypes';

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
  // An edit (a size, a fitting, an end) keeps where each branch goes: its end stays on its terminal.
  const branches = reanchorBranchesKeepingEnds(scene, new Map([[element.id, next]]), state.ductSettings);
  state.commitHvacElementCommand(action, { updates: [next, ...branches].map(toElementUpdate) });
}

/** Commit what a segment card's option changes (the run and everything that follows it), as one command. */
export function commitDuctSegmentEdit(updates: readonly HvacElement[], action: string): void {
  if (updates.length === 0) return;
  // A terminal's tag (its label) and type change with its face; a run's stay as they are.
  useSmartDrawingStore.getState().commitHvacElementCommand(action, {
    updates: updates.map((element) => ({ id: element.id, updates: { ...toElementUpdate(element).updates, label: element.label, type: element.type } })),
  });
}

/** Commit an in-place edit (a leg, the end or a riser moved; a rise changed): one command, branches follow. */
export function commitDuctRunEdit(elementId: string, result: DuctEditResult, action: string): void {
  const state = useSmartDrawingStore.getState();
  const element = state.hvacElements.find((candidate) => candidate.id === elementId);
  if (!element) return;
  state.commitHvacElementCommand(action, { updates: applyDuctRunEdit(state.hvacElements, element, result, state.ductSettings).map(toElementUpdate) });
}

/**
 * Change an air terminal (its neck, spigot side or ceiling level) in one
 * command; the runs connected to its spigot follow in the same command.
 */
export function commitDuctTerminalEdit(element: HvacElement, update: { spec?: DuctTerminalSpec; elevation?: number }, action: string): void {
  const state = useSmartDrawingStore.getState();
  const spec = update.spec ?? readDuctTerminalSpec(element);
  if (!spec) return;
  const envelope = terminalEnvelope(spec);
  // Resize about the centre, so the terminal stays where it is.
  const centre = { x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 };
  const next: HvacElement = {
    ...element,
    position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 },
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
    elevation: update.elevation ?? element.elevation,
    properties: { ...element.properties, terminal: spec },
  };
  const after = state.hvacElements.map((candidate) => (candidate.id === element.id ? next : candidate));
  const followers = followDuctsForMove(state.hvacElements, after, [element.id]);
  state.commitHvacElementCommand(action, { updates: [
    { id: next.id, updates: { position: next.position, width: next.width, depth: next.depth, height: next.height, elevation: next.elevation, properties: next.properties } },
    ...followers.map(toElementUpdate),
  ] });
}

/**
 * Change a terminal's service (supply ⇄ return: the element type follows) or
 * its face, as one command. The spigot side, neck, mount, design airflow and
 * (on a return) the filter carry over; a supply loses its filter. A terminal
 * still labelled with its old type's tag ("SAD-3") takes the next tag of the
 * new type ("RAD-1"). A terminal with a duct on its spigot keeps its service:
 * the run would be of the other service.
 */
export function commitDuctTerminalRetype(element: HvacElement, change: { service?: DuctService; kind?: DuctTerminalKind }, action: string): boolean {
  const state = useSmartDrawingStore.getState();
  const spec = readDuctTerminalSpec(element);
  if (!spec) return false;
  const service = change.service ?? spec.service;
  const kind = change.kind ?? spec.kind;
  if (service === spec.service && kind === spec.kind) return false;
  if (service !== spec.service && isTerminalConnected(state.hvacElements, element.id)) {
    state.setProcessingStatus('A duct is connected to this terminal: delete or re-route its runout before changing supply ⇄ return.', false);
    return false;
  }
  const next = typicalTerminalSpec(kind, spec.neckDiameterMm, {
    service, mount: spec.mount, filter: service === 'return' ? spec.filter ?? null : null,
    ...(spec.slots !== undefined ? { slots: spec.slots } : {}),
    ...(spec.kind === 'linear-slot' && kind === 'linear-slot' ? { lengthMm: spec.faceWidthMm } : {}),
  });
  const reshaped: DuctTerminalSpec = { ...next, spigotSide: spec.spigotSide, designAirflowM3h: spec.designAirflowM3h ?? null };
  const oldTag = terminalTypeTag(spec);
  const retag = TERMINAL_TAG_PATTERN.exec(element.label.trim())?.[1] === oldTag && terminalTypeTag(reshaped) !== oldTag;
  const type = service === 'return' ? 'return-grille' : 'diffuser';
  const envelope = terminalEnvelope(reshaped);
  const centre = { x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 };
  const moved: HvacElement = {
    ...element, type,
    position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 },
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
    label: retag ? nextTerminalTag(state.hvacElements, reshaped) : element.label,
    properties: { ...element.properties, terminal: reshaped },
  };
  const after = state.hvacElements.map((candidate) => (candidate.id === element.id ? moved : candidate));
  const followers = followDuctsForMove(state.hvacElements, after, [element.id]);
  state.commitHvacElementCommand(action, { updates: [
    { id: moved.id, updates: { type, label: moved.label, position: moved.position, width: moved.width, depth: moved.depth, height: moved.height, properties: moved.properties } },
    ...followers.map(toElementUpdate),
  ] });
  return true;
}

/** Whether a duct run ends on the terminal's spigot. */
export function isTerminalConnected(scene: readonly HvacElement[], terminalId: string): boolean {
  return scene.some((candidate) => {
    if (!isDuctElement(candidate)) return false;
    const end = readDuctRunSpec(candidate)?.end;
    return end?.kind === 'terminal' && end.terminalId === terminalId;
  });
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
