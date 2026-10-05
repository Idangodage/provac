import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveUnitAirPorts } from '../components/canvas/hvac/duct/ductAirPorts';
import { readAirSystemAssignment } from '../components/canvas/hvac/duct/ductAirSystems';
import { applyAutoDuctPreview, autoDuctSelection, generateAutoDuctPreview } from '../components/canvas/hvac/duct/ductAutoController';
import { useDuctAutoPreviewStore } from '../components/canvas/hvac/duct/ductAutoPreviewStore';
import { buildDuctRunDraftElement } from '../components/canvas/hvac/duct/ductDraft';
import { DEFAULT_DUCT_SETTINGS } from '../components/canvas/hvac/duct/ductSettings';
import { readDuctTerminalSpec, terminalEnvelope, typicalTerminalSpec } from '../components/canvas/hvac/duct/ductTerminals';
import { isDuctElement, readDuctRunSpec } from '../components/canvas/hvac/duct/ductTypes';
import type { HvacElement, Point2D } from '../types';

import { useDrawingStore } from './index';

const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'room-1', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const at = (along: number, across: number): Point2D => ({ x: supply.lip.x + across, y: supply.lip.y - along });

function diffuser(id: string, centre: Point2D, rotation: number, roomId = 'room-1'): HvacElement {
  const spec = typicalTerminalSpec('square-4way', 200);
  const envelope = terminalEnvelope(spec);
  return {
    id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId, properties: { terminal: spec },
  };
}

// Spigots facing the unit's axis / the unit (supply collar faces −Y here).
const sd1 = diffuser('sd1', at(900, 1700), 270);
const sd2 = diffuser('sd2', at(900, -1700), 90);
const sd3 = diffuser('sd3', at(2600, 0), 180);
const elsewhere = diffuser('sd9', at(2600, 5000), 180, 'room-2');

const state = () => useDrawingStore.getState();
const ducts = () => state().hvacElements.filter(isDuctElement);

describe('auto duct: select, generate, apply as one undo', () => {
  beforeEach(() => {
    useDrawingStore.setState({ hvacElements: [unit, sd1, sd2, sd3, elsewhere], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().setDuctSettings(DEFAULT_DUCT_SETTINGS);
    state().clearHistory();
    useDuctAutoPreviewStore.getState().clear();
  });

  afterEach(() => {
    useDrawingStore.setState({ hvacElements: [], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().clearHistory();
    useDuctAutoPreviewStore.getState().clear();
  });

  it('reads the selection: the unit and its selected terminals, else the free ones in its room', () => {
    expect(autoDuctSelection(['sd1'], state().hvacElements)).toBeNull();
    const picked = autoDuctSelection(['fdum', 'sd1', 'sd3'], state().hvacElements)!;
    expect(picked.terminals.map((element) => element.id)).toEqual(['sd1', 'sd3']);
    expect(picked.fromSelection).toBe(true);
    const room = autoDuctSelection(['fdum'], state().hvacElements)!;
    expect(room.terminals.map((element) => element.id)).toEqual(['sd1', 'sd2', 'sd3']);
    expect(room.fromSelection).toBe(false);
  });

  it('designs a unit for its own air system, never another unit\'s terminal, and Apply dedicates what it serves', async () => {
    const other: HvacElement = { ...unit, id: 'fdum-b', position: { x: 9000, y: 0 }, label: 'FDUM22 B' };
    const mine = { ...sd3, properties: { ...sd3.properties, airSystem: { unitId: 'fdum' } } };
    const theirs = { ...sd1, properties: { ...sd1.properties, airSystem: { unitId: 'fdum-b' } } };
    useDrawingStore.setState({ hvacElements: [unit, other, theirs, sd2, mine] });
    state().clearHistory();
    // Its system holds sd3; sd2 is in no system and the room is shared with fdum-b, so it waits to be dedicated.
    const system = autoDuctSelection(['fdum'], state().hvacElements)!;
    expect(system.source).toBe('system');
    expect(system.terminals.map((element) => element.id)).toEqual(['sd3']);
    // Selected with the unit: another unit's terminal is left out (and named), an unassigned one is taken.
    const picked = autoDuctSelection(['fdum', 'sd1', 'sd2'], state().hvacElements)!;
    expect(picked.terminals.map((element) => element.id)).toEqual(['sd2']);
    expect(picked.otherSystems.map((entry) => [entry.terminal.id, entry.unitId])).toEqual([['sd1', 'fdum-b']]);
    expect(picked.unassignedIds).toEqual(['sd2']);
    // Apply: the runs, and sd2 joining DU-1, as one command.
    await generateAutoDuctPreview({ unitId: 'fdum', terminalIds: ['sd2', 'sd3'], fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: false }, rebuildExisting: false });
    expect(applyAutoDuctPreview()).toMatch(/1 terminal joined DU-1/);
    const assignment = (id: string) => readAirSystemAssignment(state().hvacElements.find((element) => element.id === id)!);
    expect(assignment('sd2')).toBe('fdum');
    expect(state().hvacElements.find((element) => element.id === 'fdum')!.properties.airSystemTag).toBe('DU-1');
    state().undo();
    expect(assignment('sd2')).toBeNull();
    expect(ducts()).toEqual([]);
  });

  it('previews without touching the drawing, applies as one command, and one undo removes it all', async () => {
    const before = state().hvacElements;
    await generateAutoDuctPreview({ unitId: 'fdum', terminalIds: ['sd1', 'sd2', 'sd3'], fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: true }, rebuildExisting: false });
    expect(state().hvacElements).toBe(before);
    const preview = useDuctAutoPreviewStore.getState().result!;
    expect(preview.runs.length).toBe(4);
    expect(applyAutoDuctPreview()).toMatch(/4 runs added/);
    expect(ducts().map((element) => element.id).sort()).toEqual(preview.runs.map((run) => run.id).sort());
    expect(state().selectedElementIds.sort()).toEqual(preview.runs.map((run) => run.id).sort());
    expect(useDuctAutoPreviewStore.getState().result).toBeNull();
    state().undo();
    expect(state().hvacElements).toEqual(before);
  });

  it('a preview of an older drawing is refused; Rebuild replaces the collar\'s duct in the same step', async () => {
    await generateAutoDuctPreview({ unitId: 'fdum', terminalIds: ['sd3'], fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: false }, rebuildExisting: false });
    state().commitHvacElementCommand('Something else', { add: [buildDuctRunDraftElement({ port: supply, points: [at(1500, 0)] }, 'old')] });
    expect(applyAutoDuctPreview()).toMatch(/changed since the preview/);
    expect(ducts().map((element) => element.id)).toEqual(['old']);
    const before = state().hvacElements;
    await generateAutoDuctPreview({ unitId: 'fdum', terminalIds: ['sd3'], fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: false }, rebuildExisting: true });
    expect(applyAutoDuctPreview()).toMatch(/added, 1 replaced/);
    expect(ducts().some((element) => element.id === 'old')).toBe(false);
    expect(ducts().some((element) => readDuctRunSpec(element)?.end.kind === 'terminal')).toBe(true);
    // Rebuild discovers the terminals of this unit even when they are connected.
    expect(autoDuctSelection(['fdum'], state().hvacElements)!.terminals.map((element) => element.id)).not.toContain('sd3');
    expect(autoDuctSelection(['fdum'], state().hvacElements, { includeConnected: true })!.terminals.map((element) => element.id)).toContain('sd3');
    state().undo();
    expect(state().hvacElements).toEqual(before);
  });

  it('turns the spigots the design chooses in the same command, and the one undo turns them back', async () => {
    // Dropped as they come (no rotation): the optimiser picks the plenum-box side each duct reaches best.
    const a = diffuser('sa', at(3000, 1500), 0);
    const b = diffuser('sb', at(3000, -1500), 0);
    useDrawingStore.setState({ hvacElements: [unit, a, b] });
    state().clearHistory();
    const before = state().hvacElements;
    await generateAutoDuctPreview({ unitId: 'fdum', terminalIds: ['sa', 'sb'], fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: false }, rebuildExisting: false });
    const preview = useDuctAutoPreviewStore.getState().result!;
    expect(state().hvacElements).toBe(before);
    expect(preview.terminalUpdates.length).toBeGreaterThan(0);
    const sides = new Map(preview.terminalUpdates.map((element) => [element.id, readDuctTerminalSpec(element)!.spigotSide]));
    // The card says which, from which side to which.
    const notes = preview.services.flatMap((service) => service.issues).filter((issue) => issue.code === 'DU_AUTO_SPIGOT');
    expect(notes.length).toBe(sides.size);
    expect(applyAutoDuctPreview()).toMatch(/spigots? turned/);
    for (const [id, side] of sides) expect(readDuctTerminalSpec(state().hvacElements.find((element) => element.id === id)!)!.spigotSide).toBe(side);
    // Each run ends on its terminal's spigot as turned.
    for (const run of ducts()) {
      const end = readDuctRunSpec(run)!.end;
      if (end.kind === 'terminal' && sides.has(end.terminalId)) expect(end.portId).toBeTruthy();
    }
    state().undo();
    expect(state().hvacElements).toEqual(before);
  });
});
