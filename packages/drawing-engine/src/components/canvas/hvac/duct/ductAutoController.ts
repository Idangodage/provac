/**
 * Store glue for the duct auto layout: which unit and terminals the selection
 * means, Generate (into the preview), Apply (one command, one undo) and Discard;
 * and constant-friction sizing after Generate — live on the preview (the shown
 * design at once, the others after it), or on the drawing as one command.
 */
import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';

import {
  resizeAutoDuctDesign,
  terminalSpigotUpdates,
  terminalWithAirflow,
  withAutoDuctDesigns,
  type AutoDuctDesign,
  type AutoDuctRequest,
  type AutoDuctResult,
  type AutoDuctSizingBases,
} from './ductAutoLayout';
import { useDuctAutoPreviewStore } from './ductAutoPreviewStore';
import { toElementUpdate } from './ductFollow';
import { ductSystemRootOf, sizeDuctSystem, type DuctSystemSizingReport } from './ductSystemSizing';
import { cancelAutoDuctWorker, runAutoDuctInWorker } from './optimizer/ductOptimizerClient';
import { isDuctTerminalElement, listTerminalPorts } from './ductTerminals';
import { isDuctElement, readDuctRunSpec, type DuctService, type DuctSystemSizing } from './ductTypes';

/** Distance within which unconnected terminals count as a unit's when none are selected (mm). */
const NEARBY_TERMINALS_MM = 10000;

export interface AutoDuctSelection {
  unit: HvacElement;
  /** The terminals chosen: the selected ones, else the unconnected ones in the unit's room. */
  terminals: HvacElement[];
  fromSelection: boolean;
}

/** The ducted unit and terminals a selection means, or null when it holds no single ducted unit. */
export function autoDuctSelection(selectedIds: readonly string[], scene: readonly HvacElement[]): AutoDuctSelection | null {
  const selected = scene.filter((element) => selectedIds.includes(element.id));
  const units = selected.filter((element) => element.type === 'ducted-ac');
  if (units.length !== 1) return null;
  const unit = units[0]!;
  const picked = selected.filter(isDuctTerminalElement);
  if (picked.length) return { unit, terminals: picked, fromSelection: true };
  const served = new Set<string>();
  for (const element of scene) {
    const end = isDuctElement(element) ? readDuctRunSpec(element)?.end : null;
    if (end?.kind === 'terminal') served.add(end.terminalId);
  }
  const centre = { x: unit.position.x + unit.width / 2, y: unit.position.y + unit.depth / 2 };
  const ports = new Map(listTerminalPorts(scene).map((port) => [port.unitId, port]));
  const terminals = scene.filter((element) => {
    if (!isDuctTerminalElement(element) || served.has(element.id)) return false;
    if (unit.roomId && element.roomId) return element.roomId === unit.roomId;
    const port = ports.get(element.id);
    return Boolean(port) && Math.hypot(port!.lip.x - centre.x, port!.lip.y - centre.y) <= NEARBY_TERMINALS_MM;
  });
  return { unit, terminals, fromSelection: false };
}

/** Routes, sizes and verifies the designs in the worker; the preview shows the best life-cycle one. */
export async function generateAutoDuctPreview(request: AutoDuctRequest): Promise<void> {
  const { hvacElements, ductSettings, walls } = useSmartDrawingStore.getState();
  const preview = useDuctAutoPreviewStore.getState();
  cancelPreviewResize();
  preview.setRunning(request.unitId);
  try {
    // The drawing's walls come with it: the ducts stay in their room.
    const withWalls: AutoDuctRequest = {
      ...request, walls: request.walls ?? walls.map((wall) => ({ id: wall.id, startPoint: wall.startPoint, endPoint: wall.endPoint, thickness: wall.thickness })),
    };
    const result = await runAutoDuctInWorker(hvacElements, withWalls, ductSettings);
    useDuctAutoPreviewStore.getState().setPreview(result, request, hvacElements);
  } catch (error) {
    if (error instanceof Error && error.message === 'cancelled') return;
    useDuctAutoPreviewStore.getState().clear(error instanceof Error ? error.message : 'The duct layout could not be calculated.');
  }
}

export function cancelAutoDuctPreview(): void {
  cancelAutoDuctWorker();
  useDuctAutoPreviewStore.getState().setRunning(null);
}

export function discardAutoDuctPreview(): void {
  cancelAutoDuctWorker();
  cancelPreviewResize();
  useDuctAutoPreviewStore.getState().clear();
}

// ---- Constant friction on the preview ----

let resizeTimer: ReturnType<typeof setTimeout> | null = null;
let resizeGeneration = 0;

function cancelPreviewResize(): void {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = null;
  resizeGeneration += 1;
}

/** The terminals the preview's request serves, with the airflows the card set (only those that change). */
function airflowUpdates(scene: readonly HvacElement[], terminalIds: readonly string[], airflows: AutoDuctRequest['terminalAirflows']): HvacElement[] {
  return scene.filter((element) => terminalIds.includes(element.id) && isDuctTerminalElement(element))
    .map((element) => terminalWithAirflow(element, airflows)).filter((element) => !scene.includes(element));
}

/**
 * Sizes the preview by constant friction at `bases` now: the shown design,
 * and with `all` every other one too (its picks found again). The drawing is
 * untouched; Apply commits the sizes shown.
 */
export function resizeAutoDuctPreviewNow(bases: AutoDuctSizingBases, terminalAirflows?: Record<string, number | null>, options: { all?: boolean } = {}): AutoDuctResult | null {
  const { result, request, scene } = useDuctAutoPreviewStore.getState();
  const state = useSmartDrawingStore.getState();
  if (!result || !request || !scene || scene !== state.hvacElements || !result.designs.length) return null;
  const replaced = new Map<number, AutoDuctDesign>();
  const indices = options.all ? result.designs.map((_, index) => index) : [result.selected];
  for (const index of indices) replaced.set(index, resizeAutoDuctDesign(result, index, bases, terminalAirflows, scene, state.ductSettings));
  const next = withAutoDuctDesigns(result, replaced, bases, airflowUpdates(scene, request.terminalIds, terminalAirflows));
  useDuctAutoPreviewStore.getState().setPreview(next, { ...request, sizing: bases, ...(terminalAirflows ? { terminalAirflows } : {}) }, scene);
  return next;
}

/**
 * Live sizing while the designer types (debounced): the shown design at once,
 * then the others one at a time so the canvas stays live; a newer change
 * drops the older one's remaining work.
 */
export function resizeAutoDuctPreview(bases: AutoDuctSizingBases, terminalAirflows?: Record<string, number | null>, delayMs = 150): void {
  cancelPreviewResize();
  const generation = resizeGeneration;
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    const shown = resizeAutoDuctPreviewNow(bases, terminalAirflows);
    if (!shown) return;
    const pending = shown.designs.map((_, index) => index).filter((index) => index !== shown.selected);
    const step = () => {
      if (generation !== resizeGeneration) return;
      const { result, scene } = useDuctAutoPreviewStore.getState();
      const state = useSmartDrawingStore.getState();
      const index = pending.shift();
      if (index === undefined || !result || !scene || scene !== state.hvacElements || !result.designs[index]) return;
      const design = resizeAutoDuctDesign(result, index, bases, terminalAirflows, scene, state.ductSettings);
      const request = useDuctAutoPreviewStore.getState().request;
      if (request) useDuctAutoPreviewStore.getState().setPreview(withAutoDuctDesigns(result, new Map([[index, design]]), bases, result.terminalAirflowUpdates), request, scene);
      if (pending.length) resizeTimer = setTimeout(step, 0);
    };
    if (pending.length) resizeTimer = setTimeout(step, 0);
  }, delayMs);
}

// ---- Constant friction on the drawing ----

/** The applied system of a unit's collar, its sections as drawn (nothing changes). */
export function measureDuctSystem(unitId: string, service: DuctService, basis: DuctSystemSizing): DuctSystemSizingReport | null {
  const { hvacElements, ductSettings } = useSmartDrawingStore.getState();
  const root = ductSystemRootOf(hvacElements, unitId, service);
  return root ? sizeDuctSystem(hvacElements, root.id, { basis, measure: true }, ductSettings).report : null;
}

/**
 * Sizes the ducts on a unit's collar by constant friction at `basis`, on the
 * drawing, as one command (one undo): the resized runs, the branches that
 * follow them, the terminals whose airflow changed, the basis kept on the
 * run off the collar. Returns the report (null without such a system).
 */
export function resizeDuctSystemOnDrawing(
  unitId: string,
  service: DuctService,
  basis: DuctSystemSizing,
  terminalAirflows?: Record<string, number | null>,
  action = `Duct sizing (${service})`,
): DuctSystemSizingReport | null {
  const state = useSmartDrawingStore.getState();
  const root = ductSystemRootOf(state.hvacElements, unitId, service);
  if (!root) return null;
  const sized = sizeDuctSystem(state.hvacElements, root.id, { basis, ...(terminalAirflows ? { terminalAirflows } : {}) }, state.ductSettings);
  const changed = new Set(sized.report.changedRunIds);
  const updates = [
    ...sized.runs.filter((run) => changed.has(run.id)).map(toElementUpdate),
    ...sized.terminals.map((terminal) => ({ id: terminal.id, updates: { properties: terminal.properties } })),
  ];
  if (updates.length) {
    state.commitHvacElementCommand(action, { updates });
    state.setProcessingStatus(`${action}: ${changed.size} run${changed.size === 1 ? '' : 's'} resized${sized.terminals.length ? `, ${sized.terminals.length} terminal airflow${sized.terminals.length === 1 ? '' : 's'}` : ''}.`, false);
  }
  return sized.report;
}

/** Commits the preview as one command; returns what happened. */
export function applyAutoDuctPreview(): string {
  const state = useSmartDrawingStore.getState();
  const { result, scene } = useDuctAutoPreviewStore.getState();
  if (!result) return 'Nothing to apply.';
  if (scene !== state.hvacElements) {
    useDuctAutoPreviewStore.getState().clear('The drawing changed since the preview; generate it again.');
    return 'The drawing changed since the preview; generate it again.';
  }
  if (!result.runs.length) return 'The preview has no ducts to add.';
  cancelPreviewResize();
  const ids = result.runs.map((run) => run.id);
  const turned = result.terminalUpdates ?? [];
  // A terminal both turned and given an airflow: the turned one carries the airflow.
  const airflow = new Map((result.terminalAirflowUpdates ?? []).map((element) => [element.id, element]));
  const terminals = [
    ...turned.map((element) => {
      const set = airflow.get(element.id);
      return set ? { ...element, properties: { ...element.properties, terminal: { ...(element.properties.terminal as object), designAirflowM3h: (set.properties.terminal as { designAirflowM3h?: number | null }).designAirflowM3h ?? null } } } : element;
    }),
    ...[...airflow.values()].filter((element) => !turned.some((entry) => entry.id === element.id)),
  ];
  state.commitHvacElementCommand('Auto duct', { add: result.runs, removeIds: result.removeIds, updates: terminalSpigotUpdates(terminals), selectedIds: ids });
  const message = `Auto duct: ${result.runs.length} run${result.runs.length === 1 ? '' : 's'} added${result.removeIds.length ? `, ${result.removeIds.length} replaced` : ''}`
    + `${turned.length ? `, ${turned.length} spigot${turned.length === 1 ? '' : 's'} turned` : ''}.`;
  useDuctAutoPreviewStore.getState().clear(message);
  state.setProcessingStatus(message, false);
  return message;
}
