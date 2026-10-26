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
  autoDuctTerminalUpdates,
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
import type { DesignCriteria } from './ductDesignCriteria';
import type { DuctDesignSettings } from './ductSettings';
import { stampDesignedAt, withInitialSizingRecords } from './ductSizingRecord';
import { ductSystemRootOf, initialSizingBasis, type DuctSystemSizingReport } from './ductSystemSizing';
import { isDuctTerminalElement, listTerminalPorts, readDuctTerminalSpec } from './ductTerminals';
import { isDuctElement, readDuctRunSpec, type DuctService, type DuctSystemSizing } from './ductTypes';
import { cancelAutoDuctWorker, runAutoDuctInWorker } from './optimizer/ductOptimizerClient';
import { continueBasis, measureUnitService, sizeUnitService } from './unitAirSide';
import { designSettingsForUnit, roomCriteriaKey } from './unitCriteria';

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

/**
 * The settings a unit's ducts are designed by: its own criteria, else the
 * strictest of the rooms it serves (`terminalIds`: a design's in hand), else
 * the project's (`unitCriteria.ts`).
 */
function settingsForUnit(scene: readonly HvacElement[], unitId: string | null | undefined, settings: DuctDesignSettings, terminalIds?: readonly string[]): DuctDesignSettings {
  const { rooms } = useSmartDrawingStore.getState();
  return designSettingsForUnit(settings, unitId ? scene.find((element) => element.id === unitId) : undefined, { scene, rooms, ...(terminalIds ? { terminalIds } : {}) });
}

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
    // Designed by the unit's own criteria, else its rooms'; the preview stays keyed to the project's settings and the
    // rooms' criteria (a change of the unit's criteria changes the drawing, which makes the preview stale too).
    const result = await runAutoDuctInWorker(hvacElements, withWalls, settingsForUnit(hvacElements, request.unitId, ductSettings, request.terminalIds));
    if (generation !== previewGeneration) return;
    const current = useSmartDrawingStore.getState();
    const inputs = { settings: ductSettings, walls, roomCriteria: roomCriteriaKey(rooms) };
    if (!isAutoDuctPreviewCurrent({ result, scene: hvacElements, inputs }, current.hvacElements, current.ductSettings, current.walls, current.rooms)) {
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
  if (!result || !request || !scene || preview.running || !isAutoDuctPreviewCurrent(preview, state.hvacElements, state.ductSettings, state.walls, state.rooms) || !result.designs.length) return null;
  const effectiveAirflows = terminalAirflows ?? request.terminalAirflows;
  const replaced = new Map<number, AutoDuctDesign>();
  const indices = options.all ? result.designs.map((_, index) => index) : [result.selected];
  const settings = settingsForUnit(scene, request.unitId, state.ductSettings, request.terminalIds);
  for (const index of indices) replaced.set(index, resizeAutoDuctDesign(result, index, bases, effectiveAirflows, scene, settings));
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
        if (index === undefined || !result || !scene || !isAutoDuctPreviewCurrent(preview, state.hvacElements, state.ductSettings, state.walls, state.rooms) || !result.designs[index]) {
          useDuctAutoPreviewStore.getState().setResizing(false);
          return;
        }
        try {
          const request = useDuctAutoPreviewStore.getState().request;
          const design = resizeAutoDuctDesign(result, index, bases, terminalAirflows ?? request?.terminalAirflows, scene, settingsForUnit(scene, result.unitId, state.ductSettings, request?.terminalIds));
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

/** The applied system of a unit's collar, its sections as drawn (nothing changes); the other service counts in the fan check. */
export function measureDuctSystem(unitId: string, service: DuctService, basis?: DuctSystemSizing): DuctSystemSizingReport | null {
  const { hvacElements, ductSettings } = useSmartDrawingStore.getState();
  return measureUnitService(hvacElements, unitId, service, settingsForUnit(hvacElements, unitId, ductSettings), basis);
}

/** An element as the command stores it (a terminal given another neck moves and resizes its box). */
function elementUpdate(element: HvacElement): { id: string; updates: Partial<HvacElement> } {
  const { position, width, depth, height, elevation, label, properties } = element;
  return { id: element.id, updates: { position, width, depth, height, elevation, label, properties } };
}

/**
 * Sizes the ducts on a unit's collar by constant friction at `basis`, on the
 * drawing, as one command (one undo): terminal necks grown to their airflow
 * (the project's choice), the resized runs, the branches that follow them,
 * the terminals whose airflow changed, the basis kept on the run off the
 * collar. Returns the report (null without such a system).
 */
export function resizeDuctSystemOnDrawing(
  unitId: string,
  service: DuctService,
  basis: DuctSystemSizing,
  terminalAirflows?: Record<string, number | null>,
  action = `Duct sizing (${service})`,
): DuctSystemSizingReport | null {
  const state = useSmartDrawingStore.getState();
  const settings = settingsForUnit(state.hvacElements, unitId, state.ductSettings);
  const sized = sizeUnitService(state.hvacElements, unitId, service, basis, terminalAirflows, settings, { necks: settings.autoNecksFollowAirflow });
  if (!sized) return null;
  if (sized.updates.length) {
    state.commitHvacElementCommand(action, { updates: sized.updates.map(elementUpdate) });
    const runs = sized.updates.filter(isDuctElement).length;
    const airflowOf = (element: HvacElement | undefined) => (element ? readDuctTerminalSpec(element)?.designAirflowM3h ?? null : null);
    const airflows = sized.updates.filter((element) => isDuctTerminalElement(element)
      && airflowOf(element) !== airflowOf(state.hvacElements.find((candidate) => candidate.id === element.id))).length;
    const parts = [
      `${runs} run${runs === 1 ? '' : 's'} resized`,
      ...(sized.necks.length ? [sized.necks.map((growth) => `${growth.label} neck Ø${growth.fromMm} → Ø${growth.toMm}`).join(', ')] : []),
      ...(airflows > 0 ? [`${airflows} terminal airflow${airflows === 1 ? '' : 's'}`] : []),
    ];
    state.setProcessingStatus(`${action}: ${parts.join(', ')}.`, false);
  }
  return sized.report;
}

/**
 * Sizes the system again at the basis it continues from (after hand edits or
 * new branches), as one command. Null without a system on that collar.
 */
export function resizeDuctSystemAtBasis(unitId: string, service: DuctService): DuctSystemSizingReport | null {
  const { hvacElements, ductSettings } = useSmartDrawingStore.getState();
  const { basis } = continueBasis(hvacElements, unitId, service, settingsForUnit(hvacElements, unitId, ductSettings));
  return resizeDuctSystemOnDrawing(unitId, service, basis, undefined, `Duct sizing (${service}): re-sized at ${basis.frictionPaPerM.toFixed(2)} Pa/m`);
}

/**
 * Sizes several of a unit's services on the drawing, each at its own basis,
 * as one command (one undo): the second sized on what the first made of the
 * drawing. `extraUpdates` (the unit with new criteria) apply first, by the
 * settings they give, and go in the same command. Returns each service's
 * report.
 */
export function resizeUnitDuctsOnDrawing(
  unitId: string,
  services: ReadonlyArray<{ service: DuctService; basis: DuctSystemSizing }>,
  action: string,
  options: { extraUpdates?: readonly HvacElement[] } = {},
): Partial<Record<DuctService, DuctSystemSizingReport>> {
  const state = useSmartDrawingStore.getState();
  const extra = new Map((options.extraUpdates ?? []).map((element) => [element.id, element]));
  const working: readonly HvacElement[] = extra.size ? state.hvacElements.map((element) => extra.get(element.id) ?? element) : state.hvacElements;
  const settings = settingsForUnit(working, unitId, state.ductSettings);
  const { changed, reports } = sizeUnitsInScene(working, [{ unitId, services, settings }]);
  for (const [id, element] of extra) if (!changed.has(id)) changed.set(id, element);
  if (changed.size) {
    state.commitHvacElementCommand(action, { updates: [...changed.values()].map(elementUpdate) });
    const runs = [...changed.values()].filter(isDuctElement).length;
    state.setProcessingStatus(runs ? `${action}: ${runs} run${runs === 1 ? '' : 's'} resized.` : `${action}.`, false);
  }
  return reports.get(unitId) ?? {};
}

interface UnitResize {
  unitId: string;
  services: ReadonlyArray<{ service: DuctService; basis: DuctSystemSizing }>;
  settings: DuctDesignSettings;
}

/** Sizes each unit's services on `scene`, one after another (each on what those before made of it). */
function sizeUnitsInScene(scene: readonly HvacElement[], entries: readonly UnitResize[]) {
  let working = scene;
  const changed = new Map<string, HvacElement>();
  const reports = new Map<string, Partial<Record<DuctService, DuctSystemSizingReport>>>();
  for (const { unitId, services, settings } of entries) {
    const unitReports: Partial<Record<DuctService, DuctSystemSizingReport>> = {};
    for (const { service, basis } of services) {
      const sized = sizeUnitService(working, unitId, service, basis, undefined, settings, { necks: settings.autoNecksFollowAirflow });
      if (!sized) continue;
      unitReports[service] = sized.report;
      const replaced = new Map(sized.updates.map((element) => [element.id, element]));
      for (const element of sized.updates) changed.set(element.id, element);
      working = working.map((element) => replaced.get(element.id) ?? element);
    }
    reports.set(unitId, unitReports);
  }
  return { changed, reports };
}

/**
 * Each of a unit's services that has ducts, at the basis a new design takes
 * from `settings` (new criteria): their limits and friction rate (the practice
 * rate, or the rate at which the main reaches its limit when that is lower),
 * its fan speed and any typed airflow kept.
 */
function basesForCriteria(scene: readonly HvacElement[], unitId: string, settings: DuctDesignSettings): Array<{ service: DuctService; basis: DuctSystemSizing }> {
  return (['supply', 'return'] as const).filter((service) => ductSystemRootOf(scene, unitId, service)).map((service) => {
    const { basis } = continueBasis(scene, unitId, service, settings);
    const airflow = basis.airflowM3h ?? measureUnitService(scene, unitId, service, settings, basis, { espCheck: false })?.airflowM3h ?? null;
    return { service, basis: { ...initialSizingBasis(settings, service, airflow, basis.fanSpeed), airflowM3h: basis.airflowM3h } };
  });
}

/** Each of a unit's services that has ducts, at the basis it continues from. */
function unitServiceBases(unitId: string): Array<{ service: DuctService; basis: DuctSystemSizing }> {
  const { hvacElements, ductSettings } = useSmartDrawingStore.getState();
  const settings = settingsForUnit(hvacElements, unitId, ductSettings);
  return (['supply', 'return'] as const)
    .filter((service) => ductSystemRootOf(hvacElements, unitId, service))
    .map((service) => ({ service, basis: continueBasis(hvacElements, unitId, service, settings).basis }));
}

/** Every duct of the unit sized again at its basis, both services one undo (after the size series changes). */
export function resizeUnitDuctsAtBasis(unitId: string, action: string): Partial<Record<DuctService, DuctSystemSizingReport>> {
  return resizeUnitDuctsOnDrawing(unitId, unitServiceBases(unitId), action);
}

/**
 * Gives the unit its own design criteria (null: back to its rooms', else the
 * project's) and sizes its ducts by them as a new design takes them
 * (`basesForCriteria`). The unit and its ducts change as one command (one
 * undo); the rooms' and the project's criteria stay as they are.
 */
export function applyDesignCriteriaToUnit(unitId: string, criteria: DesignCriteria | null, action: string): Partial<Record<DuctService, DuctSystemSizingReport>> {
  const { hvacElements, ductSettings, rooms } = useSmartDrawingStore.getState();
  const unit = hvacElements.find((element) => element.id === unitId);
  if (!unit) return {};
  // (An update merges properties: null, not a missing key, says "none of its own".)
  const updated: HvacElement = { ...unit, properties: { ...unit.properties, designCriteria: criteria ? { room: criteria.room, location: criteria.location } : null } };
  const scene = hvacElements.map((element) => (element.id === unitId ? updated : element));
  const settings = designSettingsForUnit(ductSettings, updated, { scene, rooms });
  return resizeUnitDuctsOnDrawing(unitId, basesForCriteria(scene, unitId, settings), action, { extraUpdates: [updated] });
}

/**
 * Gives a room its design criteria (null: back to the project's) and re-sizes
 * the ducts of every unit whose criteria that changes (a unit serving the room
 * without criteria of its own, where the room now sets, or no longer sets, its
 * limits) as a new design takes them. The room and the ducts change as one
 * command (one undo). Returns the units re-sized.
 */
export function applyDesignCriteriaToRoom(roomId: string, criteria: DesignCriteria | null, action: string): string[] {
  const state = useSmartDrawingStore.getState();
  if (!state.rooms.some((room) => room.id === roomId)) return [];
  const { hvacElements: scene, ductSettings } = state;
  const next = criteria ? { room: criteria.room, location: criteria.location } : null;
  const nextRooms = state.rooms.map((room) => (room.id === roomId ? { ...room, designCriteria: next } : room));
  const entries: UnitResize[] = [];
  for (const unit of scene.filter(isAirSystemUnit)) {
    const before = designSettingsForUnit(ductSettings, unit, { scene, rooms: state.rooms });
    const after = designSettingsForUnit(ductSettings, unit, { scene, rooms: nextRooms });
    if (before === after) continue;
    const services = basesForCriteria(scene, unit.id, after);
    if (services.length) entries.push({ unitId: unit.id, services, settings: after });
  }
  const { changed } = sizeUnitsInScene(scene, entries);
  state.setRoomDesignCriteria(roomId, next, { skipHistory: true });
  if (changed.size) {
    state.commitHvacElementCommand(action, { updates: [...changed.values()].map(elementUpdate) });
    const runs = [...changed.values()].filter(isDuctElement).length;
    state.setProcessingStatus(`${action}: ${runs} run${runs === 1 ? '' : 's'} of ${entries.length} unit${entries.length === 1 ? '' : 's'} resized.`, false);
  } else {
    state.saveToHistory(action);
    state.setProcessingStatus(`${action}.`, false);
  }
  return entries.map((entry) => entry.unitId);
}

/**
 * Back to how the system was first sized by constant friction: its basis and
 * each terminal's airflow as designed (set ones set again, shares shared), as
 * one command. A life-cycle design has no basis to return to: the reason.
 */
export function resetDuctSystemToInitial(unitId: string, service: DuctService): { report: DuctSystemSizingReport | null; refused?: string } {
  const { hvacElements } = useSmartDrawingStore.getState();
  const root = ductSystemRootOf(hvacElements, unitId, service);
  const record = root ? readDuctRunSpec(root)?.initialSizing : undefined;
  if (!record) return { report: null, refused: 'This system has no record of how it was first sized (it was applied before records were kept).' };
  if (!record.basis) return { report: null, refused: 'Its first sizes came from the life-cycle optimiser, not a basis: use Undo, or generate it again.' };
  const airflows = Object.fromEntries(record.terminals.map((terminal) => [terminal.terminalId, terminal.fixed ? terminal.airflowM3h : null]));
  return { report: resizeDuctSystemOnDrawing(unitId, service, record.basis, airflows, `Duct sizing (${service}): back to the initial basis`) };
}

/** Commits the preview as one command; returns what happened. */
export function applyAutoDuctPreview(): string {
  const state = useSmartDrawingStore.getState();
  const preview = useDuctAutoPreviewStore.getState();
  const { result } = preview;
  if (preview.running || preview.resizing) return 'Wait for the duct preview to finish updating before applying it.';
  if (!result) return 'Nothing to apply.';
  if (!isAutoDuctPreviewCurrent(preview, state.hvacElements, state.ductSettings, state.walls, state.rooms)) {
    const message = 'The drawing or duct settings changed since the preview; generate it again.';
    useDuctAutoPreviewStore.getState().clear(message);
    return message;
  }
  if (!result.runs.length) return 'The preview has no ducts to add.';
  cancelPreviewResize();
  const ids = result.runs.map((run) => run.id);
  const turned = result.terminalUpdates ?? [];
  const terminals = autoDuctTerminalUpdates(result);
  // The terminals it serves that no system held join the unit's air system, in the same command.
  const assigned = withSystemAssignments(terminals, result.runs, state.hvacElements, result.unitId);
  const joined = assigned.filter((element) => readAirSystemAssignment(element) === result.unitId
    && !readAirSystemAssignment(state.hvacElements.find((candidate) => candidate.id === element.id) ?? element)).length;
  const unit = state.hvacElements.find((element) => element.id === result.unitId);
  const unitTagged = typeof unit?.properties.airSystemTag === 'string' && unit.properties.airSystemTag.trim();
  const tag = airSystemTags(state.hvacElements).get(result.unitId) ?? 'its unit';
  const tagUpdates = unit && !unitTagged && joined ? [{ id: unit.id, updates: { properties: { airSystemTag: tag } } }] : [];
  // Each system keeps how it was first sized: the method, fan speed, airflow, the main as designed, the basis.
  const runs = stampDesignedAt(withInitialSizingRecords({
    fanSpeed: result.fanSpeed, airflowM3h: result.airflowM3h, airflowSource: result.airflowSource,
    runs: result.runs, removeIds: result.removeIds, terminalUpdates: result.terminalUpdates, terminalAirflowUpdates: result.terminalAirflowUpdates,
    services: result.services, shape: result.shape,
  }, state.hvacElements, settingsForUnit(state.hvacElements, result.unitId, state.ductSettings), 'auto-duct'), new Date().toISOString());
  state.commitHvacElementCommand('Auto duct', { add: runs, removeIds: result.removeIds, updates: [...terminalSpigotUpdates(assigned), ...tagUpdates], selectedIds: ids });
  const message = `Auto duct: ${result.runs.length} run${result.runs.length === 1 ? '' : 's'} added${result.removeIds.length ? `, ${result.removeIds.length} replaced` : ''}`
    + `${turned.length ? `, ${turned.length} spigot${turned.length === 1 ? '' : 's'} turned` : ''}${joined ? `, ${joined} terminal${joined === 1 ? '' : 's'} joined ${tag}` : ''}.`;
  useDuctAutoPreviewStore.getState().clear(message);
  state.setProcessingStatus(message, false);
  return message;
}
