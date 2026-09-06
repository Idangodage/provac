import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_BOARD_SETTINGS } from '../components/canvas/measurement';

import { useSmartDrawingStore } from './index';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('board settings persistence', () => {
  it('initialises with the default board settings', () => {
    expect(useSmartDrawingStore.getState().boardSettings).toEqual(
      DEFAULT_BOARD_SETTINGS,
    );
  });

  it('round-trips board context through export/import', () => {
    const state = useSmartDrawingStore.getState();
    state.setBoardSettings({ scaleReal: 100, gridSubdivisions: 5 });
    state.setDisplayUnit('m');
    state.setPageConfig({ width: 1123, height: 794, orientation: 'landscape' });

    const json = useSmartDrawingStore.getState().exportData() as string;
    expect(typeof json).toBe('string');

    // Change everything, then import the snapshot back.
    state.setBoardSettings({ scaleReal: 50, gridSubdivisions: 10 });
    state.setDisplayUnit('mm');
    useSmartDrawingStore.getState().importFromJSON(json);

    const after = useSmartDrawingStore.getState();
    expect(after.boardSettings.scaleReal).toBe(100);
    expect(after.boardSettings.gridSubdivisions).toBe(5);
    expect(after.displayUnit).toBe('m');
    expect(after.pageConfig.width).toBe(1123);
    expect(after.pageConfig.orientation).toBe('landscape');
  });

  it('falls back to defaults when importing a legacy document', () => {
    useSmartDrawingStore
      .getState()
      .importFromJSON(JSON.stringify({ walls: [], rooms: [] }));
    const after = useSmartDrawingStore.getState();
    expect(after.boardSettings).toEqual(DEFAULT_BOARD_SETTINGS);
    expect(after.displayUnit).toBe('mm');
  });

  it('clamps invalid board settings updates', () => {
    const state = useSmartDrawingStore.getState();
    state.setBoardSettings({ scaleReal: -10, gridSubdivisions: 0 });
    const settings = useSmartDrawingStore.getState().boardSettings;
    expect(settings.scaleReal).toBeGreaterThan(0);
    expect(settings.gridSubdivisions).toBeGreaterThanOrEqual(1);
  });

  it('rejects malformed/non-finite documents atomically', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    useSmartDrawingStore.getState().setDisplayUnit('m');

    useSmartDrawingStore.getState().importFromJSON(
      '{"walls":[{"startPoint":{"x":1e999,"y":0},"endPoint":{"x":1,"y":1}}]}',
    );

    expect(useSmartDrawingStore.getState().displayUnit).toBe('m');
    expect(useSmartDrawingStore.getState().processingStatus).toBe('Failed to import drawing JSON.');
  });

  it('creates one fresh undo baseline after a successful document load', () => {
    useSmartDrawingStore.setState({
      sketches: [{ id: 'old', type: 'line', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
    });
    useSmartDrawingStore.getState().saveToHistory('Old document edit');

    useSmartDrawingStore.getState().importFromJSON('{"version":"1.0"}');

    const state = useSmartDrawingStore.getState();
    expect(state.sketches).toEqual([]);
    expect(state.history).toHaveLength(1);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
  });
});
