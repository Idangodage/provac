/**
 * Constant-friction sizing through the store: on the preview (live, the
 * drawing untouched until Apply), on applied ducts (one command, one undo,
 * the terminals' airflow in the same command), and Generate with it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveUnitAirPorts } from '../components/canvas/hvac/duct/ductAirPorts';
import {
  applyAutoDuctPreview,
  generateAutoDuctPreview,
  resizeAutoDuctPreviewNow,
  resizeDuctSystemOnDrawing,
} from '../components/canvas/hvac/duct/ductAutoController';
import type { AutoDuctRequest } from '../components/canvas/hvac/duct/ductAutoLayout';
import { useDuctAutoPreviewStore } from '../components/canvas/hvac/duct/ductAutoPreviewStore';
import { DEFAULT_DUCT_SETTINGS } from '../components/canvas/hvac/duct/ductSettings';
import { defaultSizingBasis, ductSystemRootOf } from '../components/canvas/hvac/duct/ductSystemSizing';
import { readDuctTerminalSpec, terminalEnvelope, typicalTerminalSpec } from '../components/canvas/hvac/duct/ductTerminals';
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

const terminals = [0, 1, 2, 3].map((k) => diffuser(`sd${k}`, at(2500 + k * 1800, 1200)));
const state = () => useDrawingStore.getState();
const request: AutoDuctRequest = {
  unitId: 'fdum', terminalIds: terminals.map((terminal) => terminal.id), fanSpeed: 'hi', layout: 'auto',
  services: { supply: true, return: false }, rebuildExisting: false, shape: 'rect', airflowM3h: 1500,
};
const basisAt = (friction: number): DuctSystemSizing => ({ ...defaultSizingBasis(DEFAULT_DUCT_SETTINGS, 'supply', null), frictionPaPerM: friction, airflowM3h: 1500 });
const rootSpec = () => readDuctRunSpec(ductSystemRootOf(state().hvacElements, 'fdum', 'supply')!)!;
const sections = (elements: readonly HvacElement[]) => elements.filter(isDuctElement)
  .map((element) => `${element.id}:${readDuctRunSpec(element)!.legs.map((leg) => leg.diameterMm ?? `${leg.widthMm}x${leg.heightMm}`).join(',')}`).sort();

describe('constant-friction sizing in the store', () => {
  beforeEach(() => {
    useDrawingStore.setState({ hvacElements: [unit, ...terminals], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().setDuctSettings(DEFAULT_DUCT_SETTINGS);
    state().clearHistory();
    useDuctAutoPreviewStore.getState().clear();
  });

  afterEach(() => {
    useDrawingStore.setState({ hvacElements: [], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().clearHistory();
    useDuctAutoPreviewStore.getState().clear();
  });

  it('resizes the preview without touching the drawing; Apply commits the sizes shown', async () => {
    await generateAutoDuctPreview(request);
    const drawing = state().hvacElements;
    const before = useDuctAutoPreviewStore.getState().result!;
    expect(before.sizing).toBeNull();
    const next = resizeAutoDuctPreviewNow({ supply: basisAt(0.5) }, undefined, { all: true })!;
    expect(state().hvacElements).toBe(drawing);
    expect(next.sizing?.supply?.frictionPaPerM).toBe(0.5);
    expect(next.services[0]!.label).toMatch(/constant friction/);
    expect(next.services[0]!.sizingReport!.sections.length).toBeGreaterThan(0);
    expect(sections(next.runs)).not.toEqual(sections(before.runs));
    expect(next.picks).not.toBeNull();
    applyAutoDuctPreview();
    expect(sections(state().hvacElements)).toEqual(sections(next.runs));
    expect(rootSpec().sizing?.frictionPaPerM).toBe(0.5);
    state().undo();
    expect(state().hvacElements).toEqual(drawing);
  }, 120000);

  it('resizes applied ducts as one command; one undo restores them, the terminals\' airflow included', async () => {
    await generateAutoDuctPreview(request);
    applyAutoDuctPreview();
    const applied = state().hvacElements;
    const report = resizeDuctSystemOnDrawing('fdum', 'supply', basisAt(0.5), undefined, 'Duct sizing (supply): friction 0.80 → 0.50 Pa/m')!;
    expect(report.changedRunIds.length).toBeGreaterThan(0);
    expect(report.errors).toBe(0);
    expect(rootSpec().sizing?.frictionPaPerM).toBe(0.5);
    const atHalf = state().hvacElements;
    expect(sections(atHalf)).not.toEqual(sections(applied));
    // A terminal's airflow: the terminal and the runs in the same command.
    resizeDuctSystemOnDrawing('fdum', 'supply', basisAt(0.5), { sd3: 600 }, 'Duct sizing (supply): SD3 airflow share → 600 m³/h');
    expect(readDuctTerminalSpec(state().hvacElements.find((element) => element.id === 'sd3')!)!.designAirflowM3h).toBe(600);
    state().undo();
    expect(state().hvacElements).toEqual(atHalf);
    state().undo();
    expect(state().hvacElements).toEqual(applied);
    // Sizing again at the basis already there changes nothing (no command).
    resizeDuctSystemOnDrawing('fdum', 'supply', basisAt(0.5));
    const once = state().hvacElements;
    resizeDuctSystemOnDrawing('fdum', 'supply', basisAt(0.5));
    expect(state().hvacElements).toBe(once);
  }, 120000);

  it('generates by constant friction: the sections meet the rate, the basis is kept, terminal airflows are applied with the runs', async () => {
    await generateAutoDuctPreview({ ...request, sizing: { supply: basisAt(0.6) }, terminalAirflows: { sd0: 450 } });
    const result = useDuctAutoPreviewStore.getState().result!;
    expect(result.sizing?.supply?.frictionPaPerM).toBe(0.6);
    expect(result.designs.every((design) => design.label.includes('constant friction'))).toBe(true);
    const report = result.services[0]!.sizingReport!;
    for (const section of report.sections.filter((entry) => entry.setBy === 'friction')) expect(section.frictionPaPerM).toBeLessThanOrEqual(0.6 * 1.001);
    expect(result.terminalAirflowUpdates.map((element) => element.id)).toEqual(['sd0']);
    // Adjusting only the friction basis must preserve the terminal flow already entered.
    const resized = resizeAutoDuctPreviewNow({ supply: basisAt(0.5) })!;
    expect(resized.terminalAirflowUpdates.map((element) => element.id)).toEqual(['sd0']);
    expect(resized.services[0]!.sizingReport!.terminals.find((terminal) => terminal.terminalId === 'sd0')!.airflowM3h).toBe(450);
    applyAutoDuctPreview();
    expect(rootSpec().sizing?.frictionPaPerM).toBe(0.5);
    expect(readDuctTerminalSpec(state().hvacElements.find((element) => element.id === 'sd0')!)!.designAirflowM3h).toBe(450);
    state().undo();
    expect(readDuctTerminalSpec(state().hvacElements.find((element) => element.id === 'sd0')!)!.designAirflowM3h ?? null).toBeNull();
    expect(state().hvacElements.some(isDuctElement)).toBe(false);
  }, 120000);
});
