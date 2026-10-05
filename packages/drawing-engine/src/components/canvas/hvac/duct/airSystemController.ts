/**
 * Store glue for air systems: every user intent is one command (one undo) and
 * returns the message it leaves in the status bar. The rules live in the pure
 * modules (ductAirSystems.ts, airSystemAssignment.ts).
 */
import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';

import { assignmentOptions, assignmentProblemFromScene, solveAirSystemAssignment } from './airSystemAssignment';
import { airSystemTags, analyseAirSystems, isAirSystemUnit, readAirSystemAssignment, roomIdOf, terminalTagOf } from './ductAirSystems';
import { isDuctTerminalElement, readDuctTerminalSpec } from './ductTerminals';

type ElementUpdate = { id: string; updates: Partial<HvacElement> };

/** The unit's tag written down (a unit without a stored tag keeps the one it is shown with). */
function tagUpdates(scene: readonly HvacElement[], unitIds: Iterable<string>): ElementUpdate[] {
  const tags = airSystemTags(scene);
  const out: ElementUpdate[] = [];
  for (const unitId of new Set(unitIds)) {
    const unit = scene.find((element) => element.id === unitId);
    if (!unit || (typeof unit.properties.airSystemTag === 'string' && unit.properties.airSystemTag.trim())) continue;
    out.push({ id: unit.id, updates: { properties: { airSystemTag: tags.get(unit.id) } } });
  }
  return out;
}

function tagOfTerminal(terminal: HvacElement): string {
  const spec = readDuctTerminalSpec(terminal);
  return spec ? terminalTagOf(terminal, spec) : terminal.label || terminal.id;
}

function listTags(terminals: readonly HvacElement[], limit = 6): string {
  const tags = terminals.map(tagOfTerminal);
  return tags.length > limit ? `${tags.slice(0, limit).join(', ')} +${tags.length - limit}` : tags.join(', ');
}

function report(message: string): string {
  useSmartDrawingStore.getState().setProcessingStatus(message, false);
  return message;
}

/** Dedicates terminals to a ducted unit (moving them from any other unit). */
export function assignTerminalsToUnit(unitId: string, terminalIds: readonly string[]): string {
  const state = useSmartDrawingStore.getState();
  const scene = state.hvacElements;
  const unit = scene.find((element) => element.id === unitId && isAirSystemUnit(element));
  if (!unit) return report('Air system: choose a ducted unit.');
  const tag = airSystemTags(scene).get(unit.id)!;
  const wanted = new Set(terminalIds);
  const terminals = scene.filter((element) => wanted.has(element.id) && isDuctTerminalElement(element));
  const changes = terminals.filter((terminal) => readAirSystemAssignment(terminal) !== unitId);
  if (!changes.length) return report(terminals.length ? `Air system: ${listTags(terminals)} already ${terminals.length === 1 ? 'belongs' : 'belong'} to ${tag}.` : 'Air system: select the terminals to assign.');
  const updates: ElementUpdate[] = [
    ...changes.map((terminal) => ({ id: terminal.id, updates: { properties: { airSystem: { unitId } } } })),
    ...tagUpdates(scene, [unitId]),
  ];
  const action = changes.length === 1 ? `Assign ${tagOfTerminal(changes[0]!)} to ${tag}` : `Assign ${changes.length} terminals to ${tag}`;
  state.commitHvacElementCommand(action, { updates });
  return report(`Air system ${tag}: ${listTags(changes)} assigned.`);
}

/** Takes terminals out of their system (back to unassigned; a connected terminal still follows its duct). */
export function unassignTerminals(terminalIds: readonly string[]): string {
  const state = useSmartDrawingStore.getState();
  const wanted = new Set(terminalIds);
  const changes = state.hvacElements.filter((element) => wanted.has(element.id) && isDuctTerminalElement(element) && readAirSystemAssignment(element));
  if (!changes.length) return report('Air system: nothing to unassign.');
  state.commitHvacElementCommand(changes.length === 1 ? `Unassign ${tagOfTerminal(changes[0]!)}` : `Unassign ${changes.length} terminals`, {
    updates: changes.map((terminal) => ({ id: terminal.id, updates: { properties: { airSystem: null } } })),
  });
  return report(`Air system: ${listTags(changes)} unassigned.`);
}

/** Adds the terminal to the unit's system, or takes it out if it is already there (pick mode). */
export function toggleTerminalInSystem(unitId: string, terminalId: string): string {
  const terminal = useSmartDrawingStore.getState().hvacElements.find((element) => element.id === terminalId);
  if (!terminal) return '';
  return readAirSystemAssignment(terminal) === unitId ? unassignTerminals([terminalId]) : assignTerminalsToUnit(unitId, [terminalId]);
}

/** Renames a system (its unit's tag); tags stay unique. */
export function setAirSystemTag(unitId: string, raw: string): string {
  const state = useSmartDrawingStore.getState();
  const scene = state.hvacElements;
  const tag = raw.trim().slice(0, 24);
  if (!tag) return report('Air system: the tag cannot be empty.');
  const tags = airSystemTags(scene);
  if (tags.get(unitId) === tag && scene.find((element) => element.id === unitId)?.properties.airSystemTag === tag) return '';
  const clash = [...tags].find(([id, other]) => id !== unitId && other.toUpperCase() === tag.toUpperCase());
  if (clash) return report(`Air system: ${tag} is already used by another unit.`);
  state.commitHvacElementCommand(`Rename air system ${tags.get(unitId) ?? ''} to ${tag}`, { updates: [{ id: unitId, updates: { properties: { airSystemTag: tag } } }] });
  return report(`Air system renamed ${tag}.`);
}

/**
 * Assigns every terminal in no system to a unit, balanced by airflow (exact
 * min-cost flow, airSystemAssignment.ts): `unitId` limits it to that unit's
 * room; otherwise the whole drawing (a room without a ducted unit is served
 * from the nearest one, through its walls).
 */
export function autoAssignTerminals(options: { unitId?: string } = {}): string {
  const state = useSmartDrawingStore.getState();
  const scene = state.hvacElements;
  const unit = options.unitId ? scene.find((element) => element.id === options.unitId) : undefined;
  const roomId = unit ? roomIdOf(unit, state.rooms) : undefined;
  const problem = assignmentProblemFromScene(scene, state.rooms, state.walls, unit ? { roomId } : {});
  if (!problem.terminals.length) return report(unit ? 'Air system: every terminal in this room already belongs to a system.' : 'Air system: every terminal already belongs to a system.');
  const solved = solveAirSystemAssignment(problem.units, problem.terminals, problem.walls, assignmentOptions(state.ductSettings));
  if (!solved.assignments.length) {
    return report(`Air system: no terminal could be assigned${solved.unassignable[0] ? ` (${solved.unassignable[0].reason})` : ''}.`);
  }
  const updates: ElementUpdate[] = [
    ...solved.assignments.map((entry) => ({ id: entry.terminalId, updates: { properties: { airSystem: { unitId: entry.unitId } } } })),
    ...tagUpdates(scene, solved.assignments.map((entry) => entry.unitId)),
  ];
  state.commitHvacElementCommand(`Auto-assign ${solved.assignments.length} terminal${solved.assignments.length === 1 ? '' : 's'}`, { updates });
  const tags = airSystemTags(scene);
  const byUnit = new Map<string, number>();
  for (const entry of solved.assignments) byUnit.set(entry.unitId, (byUnit.get(entry.unitId) ?? 0) + 1);
  const left = solved.unassignable.length ? `; ${solved.unassignable.length} left unassigned (${solved.unassignable[0]!.reason})` : '';
  return report(`Air systems: ${[...byUnit].map(([id, count]) => `${tags.get(id)} +${count}`).join(', ')}${left}.`);
}

/** The terminals of a unit's system, and those the current selection would add (for the card's "Assign selected"). */
export function selectedTerminalsForUnit(unitId: string, selectedIds: readonly string[], scene: readonly HvacElement[]): HvacElement[] {
  const selected = new Set(selectedIds);
  const analysis = analyseAirSystems(scene);
  return scene.filter((element) => selected.has(element.id) && isDuctTerminalElement(element) && analysis.byTerminal.get(element.id)?.unitId !== unitId);
}
