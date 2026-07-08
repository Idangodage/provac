import { describe, expect, it } from 'vitest';

import { DEFAULT_BOARD_SETTINGS } from '../components/canvas/measurement';

import { useSmartDrawingStore } from './index';

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
});
