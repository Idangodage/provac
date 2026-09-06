import { beforeEach, describe, expect, it } from 'vitest';

import { useSmartDrawingStore } from './index';

describe('compound drawing command history', () => {
  beforeEach(() => {
    useSmartDrawingStore.getState().importFromJSON('{"version":"1.0"}');
  });

  it('creates a room rectangle as one undoable command', () => {
    const ids = useSmartDrawingStore.getState().createRoomWalls(
      { width: 4_000, height: 3_000, wallThickness: 150, material: 'partition' },
      { x: 500, y: 500 },
    );

    const created = useSmartDrawingStore.getState();
    expect(ids).toHaveLength(4);
    expect(created.walls).toHaveLength(4);
    expect(created.history).toHaveLength(2);

    created.undo();
    expect(useSmartDrawingStore.getState().walls).toEqual([]);
  });

  it('supports composing multiple wall mutations into one explicit entry', () => {
    const store = useSmartDrawingStore.getState();
    store.addWall(
      { startPoint: { x: 0, y: 0 }, endPoint: { x: 1_000, y: 0 } },
      { skipHistory: true },
    );
    store.addWall(
      { startPoint: { x: 0, y: 300 }, endPoint: { x: 1_000, y: 300 } },
      { skipHistory: true },
    );
    useSmartDrawingStore.getState().saveToHistory('Offset walls');

    expect(useSmartDrawingStore.getState().history).toHaveLength(2);
    useSmartDrawingStore.getState().undo();
    expect(useSmartDrawingStore.getState().walls).toEqual([]);
  });
});
