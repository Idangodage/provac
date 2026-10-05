/**
 * Store glue for the duct auto layout: which unit and terminals the selection
 * means, Generate (into the preview), Apply (one command, one undo) and Discard;
 * and constant-friction sizing after Generate — live on the preview (the shown
 * design at once, the others after it), or on the drawing as one command.
 */
import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement, Room } from '../../../../types';

import { airSystemMembers, airSystemTags, analyseAirSystems, isAirSystemUnit, readAirSystemAssignment, roomIdOf, withSystemAssignments } from './ductAirSystems';
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
import { isAutoDuctPreviewCurrent, useDuctAutoPreviewStore } from './ductAutoPreviewStore';
import { ductWallInputs } from './ductBuilding';
import { toElementUpdate } from './ductFollow';
import { ductSystemRootOf, sizeDuctSystem, type DuctSystemSizingReport } from './ductSystemSizing';
import { isDuctTerminalElement, listTerminalPorts } from './ductTerminals';
import type { DuctService, DuctSystemSizing } from './ductTypes';
import { cancelAutoDuctWorker, runAutoDuctInWorker } from './optimizer/ductOptimizerClient';

/** Distance within which unconnected terminals count as a unit's when none are selected (mm). */
const NEARBY_TERMINALS_MM = 10000;

/**
 * Where the card's terminals come from: the ones selected with the unit, the
 * unit's air system (the terminals dedicated to it), or — while nothing is
 * dedicated to it yet — the unassigned free terminals in its room.
 */
export type AutoDuctSelectionSource = 'selection' | 'system' | 'room';

export interface AutoDuctSelection {
  unit: HvacElement;
  /** The terminals the design serves. */
  terminals: HvacElement[];
  source: AutoDuctSelectionSource;
  fromSelection: boolean;
  /** Terminals of the request in no system yet: Apply dedicates them to the unit. */
  unassignedIds: string[];
  /** Terminals left out because another unit's system holds them (or another unit's duct serves them). */
  otherSystems: Array<{ terminal: HvacElement; unitId: string }>;
  /** System source: unassigned terminals of its room taken too (the unit is the only ducted one there). */
  roomExtras?: number;
}

/**
 * The ducted unit and the terminals a selection means, or null when it holds
 * no single ducted unit. Never a terminal of another unit's system: a unit
 * designs for its own terminals only.
 */
export function autoDuctSelection(
  selectedIds: readonly string[],
  scene: readonly HvacElement[],
  options: { includeConnected?: boolean; rooms?: ReadonlyArray<Pick<Room, 'id' | 'vertices'>> } = {},
): AutoDuctSelection | null {
  const selectedSet = new Set(selectedIds);
  const selected = scene.filter((element) => selectedSet.has(element.id));
  const units = selected.filter(isAirSystemUnit);
  if (units.length !== 1) return null;
  const unit = units[0]!;
  const analysis = analyseAirSystems(scene, options.rooms);
  const ownerOf = (terminal: HvacElement) => analysis.byTerminal.get(terminal.id)?.unitId ?? null;
  const otherSystems: AutoDuctSelection['otherSystems'] = [];
  const keep = (terminal: HvacElement) => {
    const owner = ownerOf(terminal);
    if (owner && owner !== unit.id) {
      otherSystems.push({ terminal, unitId: owner });
      return false;
    }
    return true;
  };
  const unassignedOf = (terminals: readonly HvacElement[]) => terminals.filter((terminal) => !readAirSystemAssignment(terminal)).map((terminal) => terminal.id);
  const picked = selected.filter(isDuctTerminalElement);
  if (picked.length) {
    const terminals = picked.filter(keep);
    return { unit, terminals, source: 'selection', fromSelection: true, unassignedIds: unassignedOf(terminals), otherSystems };
  }
  // The unassigned free terminals in its room (within 10 m without room data).
  const unitRoom = roomIdOf(unit, options.rooms);
  const centre = { x: unit.position.x + unit.width / 2, y: unit.position.y + unit.depth / 2 };
  const ports = new Map(listTerminalPorts(scene).map((port) => [port.unitId, port]));
  const roomUnassigned = () => analysis.unassigned.filter((terminal) => {
    const room = roomIdOf(terminal, options.rooms);
    if (unitRoom && room) return room === unitRoom;
    const port = ports.get(terminal.id);
    return Boolean(port) && Math.hypot(port!.lip.x - centre.x, port!.lip.y - centre.y) <= NEARBY_TERMINALS_MM;
  });
  // The unit's own system: its free terminals, and with Rebuild those its ducts already serve. Alone in its
  // room, the unassigned ones there are plainly its too; sharing a room, they wait to be dedicated.
  const system = analysis.byUnit.get(unit.id);
  const members = system ? airSystemMembers(system) : [];
  if (members.length) {
    const own = members.filter((member) => !member.connection || (options.includeConnected && member.connection.unitId === unit.id))
      .map((member) => member.terminal);
    for (const member of members) if (member.mismatch && member.connection) otherSystems.push({ terminal: member.terminal, unitId: member.connection.unitId });
    const alone = Boolean(unitRoom) && !scene.some((element) => isAirSystemUnit(element) && element.id !== unit.id && roomIdOf(element, options.rooms) === unitRoom);
    const extra = alone ? roomUnassigned() : [];
    const terminals = [...own, ...extra];
    return { unit, terminals, source: 'system', fromSelection: false, unassignedIds: unassignedOf(terminals), otherSystems, roomExtras: extra.length };
  }
  // Nothing dedicated to it yet: the unassigned free terminals in its room.
  const terminals = roomUnassigned();
  return { unit, terminals, source: 'room', fromSelection: false, unassignedIds: terminals.map((terminal) => terminal.id), otherSystems };
}


let previewGeneration = 0;

/** Routes, sizes and verifies the designs in the worker; the preview shows the best life-cycle one. */
export async function generateAutoDuctPreview(request: AutoDuctRequest): Promise<void> {
  const generation = ++previewGeneration;
  const { hvacElements, ductSettings, walls, rooms } = useSmartDrawingStore.getState();
  const preview = useDuctAutoPreviewStore.getState();
  cancelPreviewResize();
  preview.clear();
  preview.setRunning(request.unitId);
  try {
    // The drawing's walls (their heights and construction) and rooms come with it: a one-room system stays in its
    // room; one serving several passes through the walls between them by sleeve.
    const withWalls: AutoDuctRequest = {
      ...request, walls: request.walls ?? ductWallInputs(walls),
      rooms: request.rooms ?? rooms.map((room) => ({ id: room.id, vertices: room.vertices })),
    };
    const result = await runAutoDuctInWorker(hvacElements, withWalls, ductSettings);
    if (generation !== previewGeneration) return;
    const current = useSmartDrawingStore.getState();
    const inputs = { settings: ductSettings, walls };
    if (!isAutoDuctPreviewCurrent({ result, scene: hvacElements, inputs }, current.hvacElements, current.ductSettings, current.walls)) {
      useDuctAutoPreviewStore.getState().clear('The drawing or duct settings changed during generation; generate it again.');
      return;
    }
    useDuctAutoPreviewStore.getState().setPreview(result, request, hvacElements, inputs);
  } catch (error) {
    if (generation !== previewGeneration) return;
    if (error instanceof Error && error.message === 'cancelled') return;
    useDuctAutoPreviewStore.getState().clear(error instanceof Error ? error.message : 'The duct layout could not be calculated.');
  }
}

export function cancelAutoDuctPreview(): void {
  previewGeneration += 1;
  cancelAutoDuctWorker();
  cancelPreviewResize();
  useDuctAutoPreviewStore.getState().setRunning(null);
}

export function discardAutoDuctPreview(): void {
  cancelAutoDuctPreview();
  useDuctAutoPreviewStore.getState().clear();
}

// ---- Constant friction on the preview ----

let resizeTimer: ReturnType<typeof setTimeout> | null = null;
let resizeGeneration = 0;

function cancelPreviewResize(): void {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = null;
  resizeGeneration += 1;
  useDuctAutoPreviewStore.getState().setResizing(false);
}

/** The terminals the preview's request serves, with the airflows the card set (only those that change). */
function airflowUpdates(scene: readonly HvacElement[], terminalIds: readonly string[], airflows: AutoDuctRequest['terminalAirflows']): HvacElement[] {
  const ids = new Set(terminalIds);
  return scene.filter((element) => ids.has(element.id) && isDuctTerminalElement(element))
    .map((element) => terminalWithAirflow(element, airflows)).filter((element) => !scene.includes(element));
}

/**
 * Sizes the preview by constant friction at `bases` now: the shown design,
 * and with `all` every other one too (its picks found again). The drawing is
 * untouched; Apply commits the sizes shown.
 */
export function resizeAutoDuctPreviewNow(bases: AutoDuctSizingBases, terminalAirflows?: Record<string, number | null>, options: { all?: boolean } = {}): AutoDuctResult | null {
  const preview = useDuctAutoPreviewStore.getState();
  const { result, request, scene } = preview;
  const state = useSmartDrawingStore.getState();
  if (!result || !request || !scene || preview.running || !isAutoDuctPreviewCurrent(preview, state.hvacElements, state.ductSettings, state.walls) || !result.designs.length) return null;
  const effectiveAirflows = terminalAirflows ?? request.terminalAirflows;
  const replaced = new Map<number, AutoDuctDesign>();
  const indices = options.all ? result.designs.map((_, index) => index) : [result.selected];
  for (const index of indices) replaced.set(index, resizeAutoDuctDesign(result, index, bases, effectiveAirflows, scene, state.ductSettings));
  const next = withAutoDuctDesigns(result, replaced, bases, airflowUpdates(scene, request.terminalIds, effectiveAirflows));
  useDuctAutoPreviewStore.getState().setPreview(next, { ...request, sizing: bases, ...(effectiveAirflows ? { terminalAirflows: effectiveAirflows } : {}) }, scene);
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
  useDuctAutoPreviewStore.getState().setResizing(true);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    try {
      const shown = resizeAutoDuctPreviewNow(bases, terminalAirflows);
      if (!shown) { useDuctAutoPreviewStore.getState().setResizing(false); return; }
      const pending = shown.designs.map((_, index) => index).filter((index) => index !== shown.selected);
      const step = () => {
        if (generation !== resizeGeneration) return;
        const preview = useDuctAutoPreviewStore.getState();
        const { result, scene } = preview;
        const state = useSmartDrawingStore.getState();
        const index = pending.shift();
        if (index === undefined || !result || !scene || !isAutoDuctPreviewCurrent(preview, state.hvacElements, state.ductSettings, state.walls) || !result.designs[index]) {
          useDuctAutoPreviewStore.getState().setResizing(false);
          return;
        }
        try {
          const request = useDuctAutoPreviewStore.getState().request;
          const design = resizeAutoDuctDesign(result, index, bases, terminalAirflows ?? request?.terminalAirflows, scene, state.ductSettings);
          if (request) useDuctAutoPreviewStore.getState().setPreview(withAutoDuctDesigns(result, new Map([[index, design]]), bases, result.terminalAirflowUpdates), request, scene);
          if (pending.length) resizeTimer = setTimeout(step, 0);
          else useDuctAutoPreviewStore.getState().setResizing(false);
        } catch (error) {
          useDuctAutoPreviewStore.getState().clear(error instanceof Error ? error.message : 'The duct sizes could not be updated.');
        }
      };
      if (pending.length) resizeTimer = setTimeout(step, 0);
      else useDuctAutoPreviewStore.getState().setResizing(false);
    } catch (error) {
      useDuctAutoPreviewStore.getState().clear(error instanceof Error ? error.message : 'The duct sizes could not be updated.');
    }
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
  const preview = useDuctAutoPreviewStore.getState();
  const { result } = preview;
  if (preview.running || preview.resizing) return 'Wait for the duct preview to finish updating before applying it.';
  if (!result) return 'Nothing to apply.';
  if (!isAutoDuctPreviewCurrent(preview, state.hvacElements, state.ductSettings, state.walls)) {
    const message = 'The drawing or duct settings changed since the preview; generate it again.';
    useDuctAutoPreviewStore.getState().clear(message);
    return message;
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
  // The terminals it serves that no system held join the unit's air system, in the same command.
  const assigned = withSystemAssignments(terminals, result.runs, state.hvacElements, result.unitId);
  const joined = assigned.filter((element) => readAirSystemAssignment(element) === result.unitId
    && !readAirSystemAssignment(state.hvacElements.find((candidate) => candidate.id === element.id) ?? element)).length;
  const unit = state.hvacElements.find((element) => element.id === result.unitId);
  const unitTagged = typeof unit?.properties.airSystemTag === 'string' && unit.properties.airSystemTag.trim();
  const tag = airSystemTags(state.hvacElements).get(result.unitId) ?? 'its unit';
  const tagUpdates = unit && !unitTagged && joined ? [{ id: unit.id, updates: { properties: { airSystemTag: tag } } }] : [];
  state.commitHvacElementCommand('Auto duct', { add: result.runs, removeIds: result.removeIds, updates: [...terminalSpigotUpdates(assigned), ...tagUpdates], selectedIds: ids });
  const message = `Auto duct: ${result.runs.length} run${result.runs.length === 1 ? '' : 's'} added${result.removeIds.length ? `, ${result.removeIds.length} replaced` : ''}`
    + `${turned.length ? `, ${turned.length} spigot${turned.length === 1 ? '' : 's'} turned` : ''}${joined ? `, ${joined} terminal${joined === 1 ? '' : 's'} joined ${tag}` : ''}.`;
  useDuctAutoPreviewStore.getState().clear(message);
  state.setProcessingStatus(message, false);
  return message;
}
