import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});
