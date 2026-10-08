import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assignTerminalsToUnit, autoAssignTerminals, farPlacementNote, reassignableFarTerminals, reassignToNearestUnits, setAirSystemTag, toggleTerminalInSystem, unassignTerminals,
} from '../components/canvas/hvac/duct/airSystemController';
import { airSystemTags, analyseAirSystems, readAirSystemAssignment } from '../components/canvas/hvac/duct/ductAirSystems';
import { DEFAULT_DUCT_SETTINGS } from '../components/canvas/hvac/duct/ductSettings';
import { terminalEnvelope, typicalTerminalSpec, type DuctTerminalSpec } from '../components/canvas/hvac/duct/ductTerminals';
import type { HvacElement, Point2D } from '../types';

import { useDrawingStore } from './index';

function unit(id: string, x: number, properties: Record<string, unknown> = {}): HvacElement {
  return {
    id, type: 'ducted-ac', position: { x, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300, elevation: 2400,
    mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'room-1', properties: { modelCode: 'FDUM22KXE6F-W', ...properties },
  };
}

function terminal(id: string, centre: Point2D, spec: DuctTerminalSpec): HvacElement {
  const envelope = terminalEnvelope(spec);
  return {
    id, type: spec.service === 'return' ? 'return-grille' : 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 },
    rotation: 0, width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId: 'room-1', properties: { terminal: spec },
  };
}

const supply = typicalTerminalSpec('square-4way', 200);
const ret = typicalTerminalSpec('return-egg-crate', 250);
// Two units 8 m apart in one room, three diffusers in front of each, a return grille behind each.
const scene: HvacElement[] = [
  unit('u1', 0), unit('u2', 8000),
  ...[-1000, 500, 2000].map((x, index) => terminal(`sad-${index + 1}`, { x, y: -3000 }, supply)),
  ...[6500, 8000, 9500].map((x, index) => terminal(`sad-${index + 4}`, { x, y: -3000 }, supply)),
  terminal('rag-1', { x: 500, y: 2500 }, ret), terminal('rag-2', { x: 8500, y: 2500 }, ret),
];

const state = () => useDrawingStore.getState();
const assignmentOf = (id: string) => readAirSystemAssignment(state().hvacElements.find((element) => element.id === id)!);

describe('air system commands (one undo each)', () => {
  beforeEach(() => {
    useDrawingStore.setState({ hvacElements: scene, rooms: [], walls: [], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().setDuctSettings(DEFAULT_DUCT_SETTINGS);
    state().clearHistory();
  });

  afterEach(() => {
    useDrawingStore.setState({ hvacElements: [], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().clearHistory();
  });

  it('assigns terminals and writes the unit\'s tag in the same step; undo restores both', () => {
    expect(assignTerminalsToUnit('u1', ['sad-1', 'sad-2', 'rag-1'])).toContain('DU-1');
    expect(['sad-1', 'sad-2', 'rag-1'].map(assignmentOf)).toEqual(['u1', 'u1', 'u1']);
    expect(state().hvacElements.find((element) => element.id === 'u1')!.properties.airSystemTag).toBe('DU-1');
    state().undo();
    expect(['sad-1', 'sad-2', 'rag-1'].map(assignmentOf)).toEqual([null, null, null]);
    expect(state().hvacElements.find((element) => element.id === 'u1')!.properties.airSystemTag).toBeUndefined();
  });

  it('moves a terminal between units, unassigns it, and toggles it in pick mode', () => {
    assignTerminalsToUnit('u1', ['sad-1']);
    assignTerminalsToUnit('u2', ['sad-1']);
    expect(assignmentOf('sad-1')).toBe('u2');
    unassignTerminals(['sad-1']);
    expect(assignmentOf('sad-1')).toBeNull();
    toggleTerminalInSystem('u1', 'sad-1');
    expect(assignmentOf('sad-1')).toBe('u1');
    toggleTerminalInSystem('u1', 'sad-1');
    expect(assignmentOf('sad-1')).toBeNull();
    // Each was its own step.
    state().undo();
    expect(assignmentOf('sad-1')).toBe('u1');
  });

  it('renames a system, keeping tags unique', () => {
    setAirSystemTag('u1', 'AHU-L1');
    expect(airSystemTags(state().hvacElements).get('u1')).toBe('AHU-L1');
    expect(setAirSystemTag('u2', 'ahu-l1')).toContain('already used');
    expect(airSystemTags(state().hvacElements).get('u2')).not.toBe('ahu-l1');
  });

  it('auto-assigns the room balanced between the two units, as one step', () => {
    const message = autoAssignTerminals({ unitId: 'u1' });
    expect(message).toMatch(/DU-1 \+4, DU-2 \+4/);
    expect(['sad-1', 'sad-2', 'sad-3', 'rag-1'].map(assignmentOf)).toEqual(['u1', 'u1', 'u1', 'u1']);
    expect(['sad-4', 'sad-5', 'sad-6', 'rag-2'].map(assignmentOf)).toEqual(['u2', 'u2', 'u2', 'u2']);
    const analysis = analyseAirSystems(state().hvacElements);
    expect(analysis.unassigned).toEqual([]);
    state().undo();
    expect(analyseAirSystems(state().hvacElements).unassigned).toHaveLength(8);
  });

  it('deleting a unit leaves its terminals unassigned (undo puts both back); a copied unit takes a new tag', () => {
    assignTerminalsToUnit('u1', ['sad-1', 'rag-1']);
    state().deleteHvacElement('u1');
    expect(assignmentOf('sad-1')).toBeNull();
    expect(assignmentOf('rag-1')).toBeNull();
    state().undo();
    expect(assignmentOf('sad-1')).toBe('u1');
    const copy = state().duplicateHvacElement('u1')!;
    const tags = airSystemTags(state().hvacElements);
    expect(tags.get('u1')).toBe('DU-1');
    expect(tags.get(copy)).not.toBe('DU-1');
  });
});

describe('reassigning terminals served by far units (one undo)', () => {
  const assigned = (element: HvacElement, unitId: string): HvacElement => ({ ...element, properties: { ...element.properties, airSystem: { unitId } } });
  // Two units 20 m apart, each with a diffuser of its own and one by the other unit.
  const swapped: HvacElement[] = [
    unit('u1', 0), unit('u2', 20000),
    assigned(terminal('sad-1', { x: 1000, y: -3000 }, supply), 'u2'), assigned(terminal('sad-2', { x: 2500, y: -3000 }, supply), 'u1'),
    assigned(terminal('sad-3', { x: 19000, y: -3000 }, supply), 'u1'), assigned(terminal('sad-4', { x: 21000, y: -3000 }, supply), 'u2'),
  ];

  beforeEach(() => {
    useDrawingStore.setState({ hvacElements: swapped, rooms: [], walls: [], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().setDuctSettings(DEFAULT_DUCT_SETTINGS);
    state().clearHistory();
  });

  afterEach(() => {
    useDrawingStore.setState({ hvacElements: [], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().clearHistory();
  });

  it('gives each far terminal to the nearest unit, balanced, in one step; undo puts them back', () => {
    expect(reassignableFarTerminals()).toEqual(['sad-1', 'sad-3']);
    expect(reassignToNearestUnits(reassignableFarTerminals())).toBe('Air systems: SAD-1 → DU-1, SAD-3 → DU-2.');
    expect(['sad-1', 'sad-2', 'sad-3', 'sad-4'].map(assignmentOf)).toEqual(['u1', 'u1', 'u2', 'u2']);
    expect(reassignableFarTerminals()).toEqual([]);
    state().undo();
    expect(['sad-1', 'sad-2', 'sad-3', 'sad-4'].map(assignmentOf)).toEqual(['u2', 'u1', 'u1', 'u2']);
    expect(reassignToNearestUnits([])).toContain('no terminal to reassign');
  });

  it('notes a terminal placed for a far unit, naming the nearer one', () => {
    expect(farPlacementNote(state().hvacElements, 'sad-1')).toMatch(/^; DU-1 is nearer \(\d+\.\d m, DU-2 \d+\.\d m\)$/);
    expect(farPlacementNote(state().hvacElements, 'sad-2')).toBe('');
  });
});
