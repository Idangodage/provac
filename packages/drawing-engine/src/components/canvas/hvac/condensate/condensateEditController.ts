/**
 * Store side of condensate micro-editing: builds the edit context, commits an
 * edit result as ONE undo step, runs the edit-bar actions, and lets drains
 * follow moved units / gullies inside the move's own history step.
 */
import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';

import {
  createCondensateEditSession,
  followCondensateDrains,
  isUnitBranchSpec,
  type CondensateEdit,
  type CondensateEditContext,
  type CondensateEditResult,
  type CondensateFittingEdit,
} from './condensateEditing';
import { fixedPrefixLength, insertRouteVertex } from './condensateRouteOps';
import { getCondensateOwnership, isCondensatePipe, readCondensatePipeSpec, type CondensateNetworkOwnership } from './condensateTypes';

export function condensateEditContext(): CondensateEditContext {
  const state = useSmartDrawingStore.getState();
  return { settings: state.condensateSettings, routingSettings: state.pipeRoutingSettings, walls: state.walls, rooms: state.rooms };
}

function report(message: string): void {
  useSmartDrawingStore.getState().setProcessingStatus(message, false);
}

/** Commits a successful edit (one history entry); reports why when it cannot. Returns whether it committed. */
export function commitCondensateEdit(result: CondensateEditResult, action: string, selectedIds?: string[]): boolean {
  if (!result.ok) {
    report(result.message);
    return false;
  }
  if (!result.add.length && !result.updates.length && !result.removeIds.length) return false;
  useSmartDrawingStore.getState().commitHvacElementCommand(action, {
    add: result.add,
    removeIds: result.removeIds,
    updates: result.updates.map((element) => ({ id: element.id, updates: element })),
    ...(selectedIds ? { selectedIds } : {}),
  });
  report(`${action}: ${result.message}`);
  return true;
}

/** The drain networks of the drawing whose pipes are not of the drainage settings' pipe system. */
export function drainNetworksOffSeries(scene: readonly HvacElement[], pipeSystem: string): string[] {
  const ids = new Set<string>();
  for (const element of scene) {
    if (!isCondensatePipe(element)) continue;
    const networkId = getCondensateOwnership(element)?.networkId;
    if (networkId && readCondensatePipeSpec(element).pipeSystem !== pipeSystem) ids.add(networkId);
  }
  return [...ids];
}

/**
 * Every drain network not of the drainage settings' pipe system re-solved
 * along its own routes with the settings as they are (its sizes come from
 * their pipe system: PVC Schedule 40 by the inch after IP, say), as one
 * command (one undo). Falls, routes and fittings are kept; a network that
 * cannot be re-solved stays as it is and says why.
 */
export function resizeDrainNetworksToSeries(action: string): { resized: number; refused: string[] } {
  const state = useSmartDrawingStore.getState();
  const context = condensateEditContext();
  let scene = [...state.hvacElements];
  const add = new Map<string, HvacElement>();
  const updates = new Map<string, HvacElement>();
  const removeIds = new Set<string>();
  const refused: string[] = [];
  let resized = 0;
  for (const networkId of drainNetworksOffSeries(scene, state.condensateSettings.pipeSystem)) {
    const result = createCondensateEditSession(scene, networkId, context)?.solve({}, { markEdited: false });
    if (!result) continue;
    if (!result.ok) { refused.push(result.message); continue; }
    if (!result.add.length && !result.updates.length && !result.removeIds.length) continue;
    resized += 1;
    const gone = new Set(result.removeIds);
    const replaced = new Map(result.updates.map((element) => [element.id, element]));
    scene = [...scene.filter((element) => !gone.has(element.id)).map((element) => replaced.get(element.id) ?? element), ...result.add];
    for (const id of gone) {
      if (!add.delete(id)) removeIds.add(id);
      updates.delete(id);
    }
    for (const element of result.updates) (add.has(element.id) ? add : updates).set(element.id, element);
    for (const element of result.add) add.set(element.id, element);
  }
  if (resized) {
    state.commitHvacElementCommand(action, {
      add: [...add.values()], removeIds: [...removeIds], updates: [...updates.values()].map((element) => ({ id: element.id, updates: element })),
    });
  }
  report(resized ? `${action}: ${resized} network${resized === 1 ? '' : 's'}.${refused.length ? ` ${refused[0]}` : ''}` : refused[0] ?? 'Every drain is of that pipe already.');
  return { resized, refused };
}

export function condensateNetworkIdOf(element: HvacElement | undefined): string | null {
  return element && isCondensatePipe(element) ? getCondensateOwnership(element)?.networkId ?? null : null;
}

/** Runs one edit on the network of `pipe` against the current drawing and commits it. */
export function runCondensateEdit(pipe: HvacElement, edit: CondensateEdit, action: string, options: { markEdited?: boolean; select?: boolean } = {}): CondensateEditResult | null {
  const networkId = condensateNetworkIdOf(pipe);
  if (!networkId) return null;
  const scene = [...useSmartDrawingStore.getState().hvacElements];
  const session = createCondensateEditSession(scene, networkId, condensateEditContext());
  if (!session) return null;
  const result = session.solve(edit, { markEdited: options.markEdited });
  const keep = result.elements.some((element) => element.id === pipe.id) ? [pipe.id] : [];
  commitCondensateEdit(result, action, options.select === false ? undefined : keep);
  return result;
}

export function addBendToRun(pipe: HvacElement): CondensateEditResult | null {
  const spec = readCondensatePipeSpec(pipe);
  const prefix = fixedPrefixLength(isUnitBranchSpec(spec));
  const route = spec.routePoints;
  let best = -1;
  let length = 0;
  for (let index = Math.max(0, prefix - 1); index < route.length - 1; index += 1) {
    const span = Math.hypot(route[index + 1]!.x - route[index]!.x, route[index + 1]!.y - route[index]!.y);
    if (span > length) { length = span; best = index; }
  }
  if (best < 0 || length < 200) {
    report('This run has no leg long enough for another bend.');
    return null;
  }
  const a = route[best]!;
  const b = route[best + 1]!;
  const next = insertRouteVertex(route, best, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, prefix);
  return runCondensateEdit(pipe, { routes: new Map([[pipe.id, next]]) }, 'Add bend to drain');
}

export function rerouteDrainRun(pipe: HvacElement): CondensateEditResult | null {
  const spec = readCondensatePipeSpec(pipe);
  if (!isUnitBranchSpec(spec)) {
    report('Re-route works on a unit\'s drain run; select the run from the unit.');
    return null;
  }
  return runCondensateEdit(pipe, { rerouteUnitIds: [spec.drainStart!.unitId!] }, 'Re-route drain run');
}

export function deleteDrainRun(pipe: HvacElement): CondensateEditResult | null {
  const spec = readCondensatePipeSpec(pipe);
  if (!isUnitBranchSpec(spec)) return deleteDrainNetwork(pipe);
  return runCondensateEdit(pipe, { removePipeIds: [pipe.id] }, 'Delete drain run', { select: false });
}

/** Deleting a main or drop removes its whole network (every unit upstream of it loses its drain). */
export function deleteDrainNetwork(pipe: HvacElement): null {
  const networkId = condensateNetworkIdOf(pipe);
  if (!networkId) return null;
  const state = useSmartDrawingStore.getState();
  const ids = state.hvacElements.filter((element) => condensateNetworkIdOf(element) === networkId).map((element) => element.id);
  state.commitHvacElementCommand('Delete drain network', { removeIds: ids, selectedIds: [] });
  report(`Deleted the drain network (${ids.length} run${ids.length === 1 ? '' : 's'}). Undo restores it.`);
  return null;
}

export function setNetworkFall(pipe: HvacElement, percent: number | null): CondensateEditResult | null {
  return runCondensateEdit(pipe, { fallPercent: percent }, percent ? `Set drain fall ${percent} %` : 'Reset drain fall');
}

export function setRunSize(pipe: HvacElement, outerDiameterMm: number | null): CondensateEditResult | null {
  return runCondensateEdit(pipe, { minOuterDiameterMm: { [pipe.id]: outerDiameterMm } }, outerDiameterMm ? 'Upsize drain run' : 'Reset drain size');
}

export function setRiserLimit(pipe: HvacElement, liftMm: number | null): CondensateEditResult | null {
  const unitId = readCondensatePipeSpec(pipe).drainStart?.unitId;
  if (!unitId) return null;
  return runCondensateEdit(pipe, { liftLimitMm: { [unitId]: liftMm } }, liftMm === null ? 'Riser to the high point' : `Riser height ${Math.round(liftMm)} mm`);
}

export function setRunLevelCap(pipe: HvacElement, levelMm: number | null): CondensateEditResult | null {
  return runCondensateEdit(pipe, { levelCapMm: { [pipe.id]: levelMm } }, levelMm === null ? 'Clear drain level limit' : `Drain level limit ${Math.round(levelMm)} mm`);
}

export function editRunFittings(pipe: HvacElement, edits: CondensateFittingEdit[], action: string): CondensateEditResult | null {
  return runCondensateEdit(pipe, { fittingEdits: { [pipe.id]: edits } }, action);
}

export function setRunLocked(pipe: HvacElement, locked: boolean): void {
  useSmartDrawingStore.getState().commitHvacElementCommand(locked ? 'Lock drain run' : 'Unlock drain run', {
    updates: [{ id: pipe.id, updates: { properties: { ...pipe.properties, locked } } }],
  });
}

/** Hands a hand-edited network back to Auto route (it may regenerate it). */
export function releaseDrainNetwork(pipe: HvacElement): void {
  const networkId = condensateNetworkIdOf(pipe);
  if (!networkId) return;
  const state = useSmartDrawingStore.getState();
  const updates = state.hvacElements.filter((element) => condensateNetworkIdOf(element) === networkId).map((element) => {
    const owner = getCondensateOwnership(element)!;
    const next: CondensateNetworkOwnership = { ...owner, editPolicy: 'reconsider' };
    return { id: element.id, updates: { properties: { ...element.properties, condensateNetwork: next } } };
  });
  state.commitHvacElementCommand('Release drain network to Auto route', { updates });
  report('Auto route may now regenerate this drain network.');
}

/**
 * Drains follow an equipment drag that the caller records in its own history
 * step (the drag commits the unit with skipHistory, then saves once).
 */
export function followDrainsWithoutHistory(before: readonly HvacElement[], after: HvacElement[], movedIds: readonly string[]): void {
  const result = followDrainsForMove(before, after, movedIds);
  if (!result.add.length && !result.updates.length && !result.removeIds.length) return;
  useSmartDrawingStore.getState().commitHvacElementCommand('Drains follow', {
    add: result.add,
    removeIds: result.removeIds,
    updates: result.updates.map((element) => ({ id: element.id, updates: element })),
  }, { skipHistory: true });
}

/**
 * Drains follow moved units / gullies. Returns the extra changes to fold into
 * the move's own command (so one undo reverts both), plus messages.
 */
export function followDrainsForMove(before: readonly HvacElement[], after: HvacElement[], movedIds: readonly string[]) {
  const result = followCondensateDrains(before, after, movedIds, condensateEditContext());
  if (result.messages.length) report(result.messages.join(' '));
  return result;
}
