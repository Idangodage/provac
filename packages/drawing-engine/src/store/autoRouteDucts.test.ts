import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyAutoRoutePreview, discardAutoRoutePreview, runAutoRoute } from '../components/canvas/hvac/autoRouteController';
import { useCondensatePreviewStore } from '../components/canvas/hvac/condensate/condensatePreviewStore';
import { resolveUnitAirPorts } from '../components/canvas/hvac/duct/ductAirPorts';
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

function diffuser(id: string, centre: Point2D, rotation: number): HvacElement {
  const spec = typicalTerminalSpec('square-4way', 200);
  const envelope = terminalEnvelope(spec);
  return {
    id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId: 'room-1', properties: { terminal: spec },
  };
}

const scene = [unit, diffuser('sd1', at(900, 1700), 270), diffuser('sd2', at(900, -1700), 90), diffuser('sd3', at(2600, 0), 180)];
const state = () => useDrawingStore.getState();
const ducts = () => state().hvacElements.filter(isDuctElement);
const ductsOnly = { gas: false, liquid: false, condensate: false, supplyDuct: true, returnDuct: false };

async function route(): Promise<void> {
  runAutoRoute({ services: ductsOnly, scope: 'drawing', duct: { shape: 'rect', fanSpeed: 'hi', rebuildExisting: false } });
  await vi.waitFor(() => expect(useCondensatePreviewStore.getState().unified).not.toBeNull(), { timeout: 20000, interval: 20 });
}

describe('Auto route with duct ticks: preview, then one Apply and one undo', () => {
  beforeEach(() => {
    useDrawingStore.setState({ hvacElements: scene, selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().setDuctSettings(DEFAULT_DUCT_SETTINGS);
    state().clearHistory();
    discardAutoRoutePreview();
  });

  afterEach(() => {
    discardAutoRoutePreview();
    useDrawingStore.setState({ hvacElements: [], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().clearHistory();
  });

  it('previews the ducts without touching the drawing, applies them as one command, and one undo removes them', async () => {
    const before = state().hvacElements;
    await route();
    expect(state().hvacElements).toBe(before);
    const proposal = useCondensatePreviewStore.getState().unified!.ducts!;
    expect(proposal.units[0]!.status).toBe('designed');
    const message = applyAutoRoutePreview();
    expect(message).toMatch(/duct runs? for 1 unit/);
    expect(ducts().map((element) => element.id).sort()).toEqual(proposal.elementsToAdd.map((run) => run.id).sort());
    expect(ducts().filter((element) => readDuctRunSpec(element)?.end.kind === 'terminal').length).toBe(3);
    expect(useCondensatePreviewStore.getState().unified).toBeNull();
    state().undo();
    expect(state().hvacElements).toEqual(before);
  });

  it('refuses a preview of a drawing that has changed since', async () => {
    await route();
    state().commitHvacElementCommand('Move a diffuser', { updates: [{ id: 'sd3', updates: { position: { x: scene[3]!.position.x + 200, y: scene[3]!.position.y } } }] });
    expect(applyAutoRoutePreview()).toMatch(/changed since the preview/);
    expect(ducts()).toHaveLength(0);
  });
});
