/**
 * Undo and redo keep the selection where the selected elements are still in
 * the drawing they restore (a panel or an inspector on them stays open), and
 * drop what the step removes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../types';

import { useDrawingStore } from './index';

const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const cassette: HvacElement = {
  id: 'cassette', type: 'ceiling-cassette-ac', position: { x: 3000, y: 0 }, rotation: 0, width: 840, depth: 840, height: 250,
  elevation: 2600, mountType: 'ceiling', label: 'FDT28', supplyZoneRatio: 0.5, properties: {},
};
const state = () => useDrawingStore.getState();
const ids = () => state().hvacElements.map((element) => element.id);

describe('undo and redo keep the selection', () => {
  beforeEach(() => {
    useDrawingStore.setState({ hvacElements: [unit], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().clearHistory();
  });

  afterEach(() => {
    useDrawingStore.setState({ hvacElements: [], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().clearHistory();
  });

  it('keeps a selected element that is still there after the step', () => {
    useDrawingStore.setState({ selectedElementIds: ['fdum'], selectedIds: ['fdum'] });
    state().commitHvacElementCommand('Move the unit', { updates: [{ id: 'fdum', updates: { position: { x: 500, y: 0 } } }] });
    expect(state().selectedElementIds).toEqual(['fdum']);
    state().undo();
    expect(state().hvacElements[0]!.position.x).toBe(0);
    expect(state().selectedElementIds).toEqual(['fdum']);
    expect(state().selectedIds).toEqual(['fdum']);
    state().redo();
    expect(state().hvacElements[0]!.position.x).toBe(500);
    expect(state().selectedElementIds).toEqual(['fdum']);
  });

  it('drops what the step removes, and keeps the rest', () => {
    state().commitHvacElementCommand('Add a cassette', { add: [cassette], selectedIds: ['fdum', 'cassette'] });
    expect(state().selectedElementIds).toEqual(['fdum', 'cassette']);
    state().undo();
    expect(ids()).toEqual(['fdum']);
    expect(state().selectedElementIds).toEqual(['fdum']);
    expect(state().selectedIds).toEqual(['fdum']);
    // Redo brings the cassette back; the selection is what it was before the redo.
    state().redo();
    expect(ids()).toEqual(['fdum', 'cassette']);
    expect(state().selectedElementIds).toEqual(['fdum']);
  });

  it('keeps nothing selected when nothing was', () => {
    state().commitHvacElementCommand('Move the unit', { updates: [{ id: 'fdum', updates: { position: { x: 250, y: 0 } } }] });
    useDrawingStore.setState({ selectedElementIds: [], selectedIds: [] });
    state().undo();
    expect(state().selectedElementIds).toEqual([]);
  });
});
