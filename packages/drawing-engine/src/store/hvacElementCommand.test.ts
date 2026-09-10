import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { autoRouteElementSignature, pipeRegenerationPolicy } from '../components/canvas/hvac/pipeEditRetention';
import type { HvacElement } from '../types';

import { useDrawingStore } from './index';

function pipe(id: string, from: number, to: number): HvacElement {
  return {
    id,
    type: 'refrigerant-pipe',
    category: 'accessory',
    subtype: 'gas',
    modelLabel: 'Gas Pipe',
    position: { x: from, y: 0 },
    rotation: 0,
    width: Math.max(1, to - from),
    depth: 20,
    height: 20,
    elevation: 2600,
    mountType: 'ceiling',
    label: id,
    supplyZoneRatio: 0,
    properties: {
      lineKind: 'gas',
      routePoints: [{ x: from, y: 0 }, { x: to, y: 0 }],
    },
  };
}

describe('commitHvacElementCommand', () => {
  beforeEach(() => {
    useDrawingStore.setState({
      hvacElements: [pipe('host', 0, 1000)],
      selectedElementIds: ['host'],
      selectedIds: ['host'],
      hoveredElementId: 'host',
    });
    useDrawingStore.getState().clearHistory();
  });

  afterEach(() => {
    useDrawingStore.setState({
      hvacElements: [],
      selectedElementIds: [],
      selectedIds: [],
      hoveredElementId: null,
    });
    useDrawingStore.getState().clearHistory();
  });

  it('round-trips a split insertion as one exact undo/redo state', () => {
    const left = pipe('left', 0, 400);
    const right = pipe('right', 600, 1000);
    useDrawingStore.getState().commitHvacElementCommand('Insert branch kit', {
      removeIds: ['host'],
      add: [left, right],
      selectedIds: ['left'],
    });

    expect(useDrawingStore.getState().hvacElements.map((element) => element.id)).toEqual([
      'left',
      'right',
    ]);
    expect(useDrawingStore.getState().selectedElementIds).toEqual(['left']);
    expect(useDrawingStore.getState().history).toHaveLength(2);

    useDrawingStore.getState().undo();
    expect(useDrawingStore.getState().hvacElements.map((element) => element.id)).toEqual(['host']);

    useDrawingStore.getState().redo();
    expect(useDrawingStore.getState().hvacElements.map((element) => element.id)).toEqual([
      'left',
      'right',
    ]);
    expect(useDrawingStore.getState().hvacElements.some((element) => element.id === 'host')).toBe(false);
  });

  it('retains generated edits and neighboring adjustments as one exact reversible action', () => {
    const generated = [pipe('gas', 0, 1000), pipe('liquid', 0, 1000)].map(element => ({ ...element,
      properties: { ...element.properties, systemId: 'system-a', autoRouteNetwork: { version: 1, networkId: 'network',
        outdoorUnitId: 'outdoor', indoorUnitIds: ['indoor'], signature: autoRouteElementSignature({ ...element,
          properties: { ...element.properties, systemId: 'system-a' } }) } } }));
    useDrawingStore.getState().commitHvacElementCommand('Place pair', { removeIds: ['host'], add: generated });
    useDrawingStore.getState().clearHistory();
    const before = structuredClone(useDrawingStore.getState().hvacElements);
    useDrawingStore.getState().commitHvacElementCommand('Move connected pair', { updates: generated.map(element => ({
      id: element.id, updates: { elevation: 2800, properties: { routePoints: [{ x: 0, y: 150 }, { x: 1000, y: 150 }] } },
    })) });
    const after = structuredClone(useDrawingStore.getState().hvacElements);
    expect(after.every(element => pipeRegenerationPolicy(element) === 'retain')).toBe(true);
    expect(after.map(element => element.id)).toEqual(['gas', 'liquid']);
    expect(after.every(element => element.properties.systemId === 'system-a')).toBe(true);
    expect(useDrawingStore.getState().history).toHaveLength(2);
    useDrawingStore.getState().undo();
    expect(useDrawingStore.getState().hvacElements).toEqual(before);
    useDrawingStore.getState().redo();
    expect(useDrawingStore.getState().hvacElements).toEqual(after);

    useDrawingStore.getState().setPipeRegenerationPolicy(['gas'], 'reconsider');
    expect(useDrawingStore.getState().hvacElements.every(element => pipeRegenerationPolicy(element) === 'reconsider')).toBe(true);
    useDrawingStore.getState().undo();
    expect(useDrawingStore.getState().hvacElements).toEqual(after);
    useDrawingStore.getState().redo();
    useDrawingStore.getState().updateHvacElement('gas', { elevation: 2900 });
    expect(pipeRegenerationPolicy(useDrawingStore.getState().hvacElements[0]!)).toBe('retain');

    const serialized = useDrawingStore.getState().exportToJSON();
    const saved = structuredClone(useDrawingStore.getState().hvacElements);
    useDrawingStore.getState().importFromJSON(serialized);
    expect(useDrawingStore.getState().hvacElements).toEqual(saved);
  });

  it('does not record an empty or unchanged editing command', () => {
    const original = structuredClone(useDrawingStore.getState().hvacElements);
    useDrawingStore.getState().commitHvacElementCommand('No movement', { updates: [{ id: 'host', updates: original[0]! }] });
    useDrawingStore.getState().commitHvacElementCommand('Cancelled edit', {});
    expect(useDrawingStore.getState().history).toHaveLength(1);
    expect(useDrawingStore.getState().hvacElements).toEqual(original);
  });
});
