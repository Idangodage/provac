import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveUnitAirPorts } from '../components/canvas/hvac/duct/ductAirPorts';
import { buildDuctRunDraftElement } from '../components/canvas/hvac/duct/ductDraft';
import { DEFAULT_DUCT_SETTINGS } from '../components/canvas/hvac/duct/ductSettings';
import type { HvacElement } from '../types';

import { useDrawingStore } from './index';

const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
  properties: { modelCode: 'FDUM22KXE6F-W' },
};

describe('duct run in the document', () => {
  beforeEach(() => {
    useDrawingStore.setState({ hvacElements: [unit], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    useDrawingStore.getState().setDuctSettings(DEFAULT_DUCT_SETTINGS);
    useDrawingStore.getState().clearHistory();
  });

  afterEach(() => {
    useDrawingStore.setState({ hvacElements: [], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    useDrawingStore.getState().setDuctSettings(DEFAULT_DUCT_SETTINGS);
    useDrawingStore.getState().clearHistory();
  });

  it('a drawn run is one undo step', () => {
    const port = resolveUnitAirPorts(unit).find((candidate) => candidate.kind === 'supply')!;
    const run = buildDuctRunDraftElement({ port, points: [{ x: port.lip.x, y: port.lip.y - 3000 }, { x: port.lip.x + 3000, y: port.lip.y - 3000 }] }, 'run-1');
    const store = useDrawingStore.getState();
    const before = store.hvacElements;
    store.commitHvacElementCommand('Draw duct run', { add: [run], selectedIds: [run.id] });
    expect(useDrawingStore.getState().hvacElements.map((element) => element.id)).toEqual(['fdum', 'run-1']);
    useDrawingStore.getState().undo();
    expect(useDrawingStore.getState().hvacElements).toEqual(before);
    useDrawingStore.getState().redo();
    expect(useDrawingStore.getState().hvacElements.find((element) => element.id === 'run-1')?.properties.ductRun).toEqual(run.properties.ductRun);
  });

  it('duct settings travel with the document and resolve safely on import', () => {
    useDrawingStore.getState().setDuctSettings({ availableSheetThicknessesMm: [0.55, 0.7, 0.85], supplyPressureClassPa: 250 });
    const json = useDrawingStore.getState().exportToJSON();
    expect(JSON.parse(json).ductSettings.availableSheetThicknessesMm).toEqual([0.55, 0.7, 0.85]);
    useDrawingStore.getState().setDuctSettings(DEFAULT_DUCT_SETTINGS);
    useDrawingStore.getState().importFromJSON(json);
    expect(useDrawingStore.getState().ductSettings.availableSheetThicknessesMm).toEqual([0.55, 0.7, 0.85]);
    expect(useDrawingStore.getState().ductSettings.supplyPressureClassPa).toBe(250);
    // A document from before ducts existed gets the defaults.
    const legacy = JSON.parse(json) as Record<string, unknown>;
    delete legacy.ductSettings;
    useDrawingStore.getState().importFromJSON(JSON.stringify(legacy));
    expect(useDrawingStore.getState().ductSettings.availableSheetThicknessesMm).toEqual(DEFAULT_DUCT_SETTINGS.availableSheetThicknessesMm);
  });
});
