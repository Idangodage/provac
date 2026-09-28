import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveUnitAirPorts } from '../components/canvas/hvac/duct/ductAirPorts';
import { applyAutoDuctPreview, autoDuctSelection, generateAutoDuctPreview } from '../components/canvas/hvac/duct/ductAutoController';
import { useDuctAutoPreviewStore } from '../components/canvas/hvac/duct/ductAutoPreviewStore';
import { buildDuctRunDraftElement } from '../components/canvas/hvac/duct/ductDraft';
import { DEFAULT_DUCT_SETTINGS } from '../components/canvas/hvac/duct/ductSettings';
import { terminalEnvelope, typicalTerminalSpec } from '../components/canvas/hvac/duct/ductTerminals';
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

  it('previews without touching the drawing, applies as one command, and one undo removes it all', () => {
    const before = state().hvacElements;
    generateAutoDuctPreview({ unitId: 'fdum', terminalIds: ['sd1', 'sd2', 'sd3'], fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: true }, rebuildExisting: false });
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

  it('a preview of an older drawing is refused; Rebuild replaces the collar\'s duct in the same step', () => {
    generateAutoDuctPreview({ unitId: 'fdum', terminalIds: ['sd3'], fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: false }, rebuildExisting: false });
    state().commitHvacElementCommand('Something else', { add: [buildDuctRunDraftElement({ port: supply, points: [at(1500, 0)] }, 'old')] });
    expect(applyAutoDuctPreview()).toMatch(/changed since the preview/);
    expect(ducts().map((element) => element.id)).toEqual(['old']);
    const before = state().hvacElements;
    generateAutoDuctPreview({ unitId: 'fdum', terminalIds: ['sd3'], fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: false }, rebuildExisting: true });
    expect(applyAutoDuctPreview()).toMatch(/added, 1 replaced/);
    expect(ducts().some((element) => element.id === 'old')).toBe(false);
    expect(ducts().some((element) => readDuctRunSpec(element)?.end.kind === 'terminal')).toBe(true);
    state().undo();
    expect(state().hvacElements).toEqual(before);
  });
});
