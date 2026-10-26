/**
 * A plenum's neck off the collar (400 mm, nothing taken off it) has no room
 * for a transition: whatever the main velocity or friction rate asked,
 * constant friction carries it at the collar's own size, so the plan never
 * squeezes a transition into it (the duct-sizing canvas check's 78° and 148°
 * DU_TRANSITION_ANGLE, a taller section than the collar's).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveUnitAirPorts } from '../components/canvas/hvac/duct/ductAirPorts';
import { applyAutoDuctPreview, generateAutoDuctPreview, resizeAutoDuctPreviewNow, resizeDuctSystemOnDrawing } from '../components/canvas/hvac/duct/ductAutoController';
import type { AutoDuctDesign, AutoDuctRequest, AutoDuctServiceResult } from '../components/canvas/hvac/duct/ductAutoLayout';
import { useDuctAutoPreviewStore } from '../components/canvas/hvac/duct/ductAutoPreviewStore';
import { getDuctRunPlan } from '../components/canvas/hvac/duct/ductFabricationPlanner';
import { DEFAULT_DUCT_SETTINGS } from '../components/canvas/hvac/duct/ductSettings';
import { ductSystemRootOf } from '../components/canvas/hvac/duct/ductSystemSizing';
import { terminalEnvelope, typicalTerminalSpec } from '../components/canvas/hvac/duct/ductTerminals';
import { isDuctElement, readDuctRunSpec, type DuctSystemSizing } from '../components/canvas/hvac/duct/ductTypes';
import type { HvacElement, Point2D } from '../types';

import { useDrawingStore } from './index';

const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'room-1', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const at = (along: number, across: number): Point2D => ({ x: supply.lip.x + across, y: supply.lip.y - along });

function diffuser(id: string, centre: Point2D): HvacElement {
  const spec = typicalTerminalSpec('square-4way', 200);
  const envelope = terminalEnvelope(spec);
  return {
    id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation: 0,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId: 'room-1', properties: { terminal: spec },
  };
}

// The canvas check's two dropped diffusers: 1.6 m ahead of the collar, 0.8 m either side.
const terminals = [diffuser('sd1', at(1600, -800)), diffuser('sd2', at(1600, 800))];
const limits = { trunk: 5, branch: 4, runout: 3 };
const atVelocity: DuctSystemSizing = { method: 'constant-friction', drive: 'velocity', mainVelocityMs: 3, frictionPaPerM: 0.291, maxVelocity: limits, fanSpeed: 'hi', airflowM3h: 1200 };
const atFriction: DuctSystemSizing = { method: 'constant-friction', drive: 'friction', mainVelocityMs: 5.36, frictionPaPerM: 1.2, maxVelocity: limits, fanSpeed: 'hi', airflowM3h: 1200 };
const request: AutoDuctRequest = {
  unitId: 'fdum', terminalIds: terminals.map((terminal) => terminal.id), fanSpeed: 'hi', layout: 'plenum',
  services: { supply: true, return: false }, rebuildExisting: false, shape: 'rect', airflowM3h: 1200,
  sizing: { supply: { ...atVelocity, drive: 'friction', frictionPaPerM: 0.8, mainVelocityMs: 4.54 } },
};
const state = () => useDrawingStore.getState();
const collar = `${supply.widthMm}x${supply.heightMm}`;
const neckOf = (scene: readonly HvacElement[]) => {
  const leg = readDuctRunSpec(ductSystemRootOf(scene, 'fdum', 'supply')!)!.legs[0]!;
  return `${leg.widthMm}x${leg.heightMm}`;
};
const supplyOf = (design: AutoDuctDesign | undefined): AutoDuctServiceResult | undefined => design?.services.find((entry) => entry.service === 'supply');
const transitionErrors = (scene: readonly HvacElement[]) => scene.filter(isDuctElement)
  .flatMap((element) => (getDuctRunPlan(element, scene, state().ductSettings)?.issues ?? [])
    .filter((issue) => issue.code === 'DU_TRANSITION_ANGLE').map((issue) => `${element.id}: ${issue.message}`));

describe('a plenum\'s neck under constant friction', () => {
  beforeEach(() => {
    useDrawingStore.setState({ hvacElements: [unit, ...terminals], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().setDuctSettings({ ...DEFAULT_DUCT_SETTINGS, autoSizingMethod: 'constant-friction' });
    state().clearHistory();
    useDuctAutoPreviewStore.getState().clear();
  });

  afterEach(() => {
    useDrawingStore.setState({ hvacElements: [], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().clearHistory();
    useDuctAutoPreviewStore.getState().clear();
  });

  it('keeps the collar\'s size when the main asked is taller than the collar, on the preview and on the drawing', async () => {
    await generateAutoDuctPreview(request);
    const generated = useDuctAutoPreviewStore.getState().result;
    expect(supplyOf(generated?.designs[generated.selected])?.layout).toBe('plenum');
    // 3 m/s asks for a section taller than the 674×164 collar: the neck has no room for that transition.
    const resized = resizeAutoDuctPreviewNow({ supply: atVelocity })!;
    const main = supplyOf(resized.designs[resized.selected])!.sizingReport!.sections[0]!;
    expect(main.setBy).toBe('carried');
    expect(`${main.section.widthMm}x${main.section.heightMm}`).toBe(collar);
    expect(applyAutoDuctPreview()).not.toMatch(/changed|wait|nothing/i);
    expect(neckOf(state().hvacElements)).toBe(collar);
    expect(transitionErrors(state().hvacElements)).toEqual([]);
    // 1.2 Pa/m asks for a narrower, taller main: carried again, the plan clean.
    resizeDuctSystemOnDrawing('fdum', 'supply', atFriction);
    expect(neckOf(state().hvacElements)).toBe(collar);
    expect(transitionErrors(state().hvacElements)).toEqual([]);
  }, 60000);
});
