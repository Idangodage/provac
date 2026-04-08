/**
 * History Slice
 *
 * Domain-specific slice for history/undo state and actions.
 */

import type { StateCreator } from 'zustand';

import type {
    DetectedElement,
    Dimension2D,
    Annotation2D,
    Sketch2D,
    SymbolInstance2D,
    HistoryEntry,
    ElevationView,
    HvacElement,
    Room,
    SectionLine,
    Wall,
} from '../../types';
import { createHistoryEntry, createHistorySnapshot } from '../helpers';

// =============================================================================
// Types
// =============================================================================

export interface HistorySliceState {
    history: HistoryEntry[];
    historyIndex: number;
    canUndo: boolean;
    canRedo: boolean;
}

export interface HistorySliceActions {
    saveToHistory: (action: string) => void;
    undo: () => void;
    redo: () => void;
    clearHistory: () => void;
}

export type HistorySlice = HistorySliceState & HistorySliceActions;

// =============================================================================
// Slice Dependencies Interface
// =============================================================================

interface SliceDependencies {
    detectedElements: DetectedElement[];
    dimensions: Dimension2D[];
    annotations: Annotation2D[];
    sketches: Sketch2D[];
    symbols: SymbolInstance2D[];
    walls: Wall[];
    rooms: Room[];
    sectionLines: SectionLine[];
    elevationViews: ElevationView[];
    activeElevationViewId: string | null;
    hvacElements: HvacElement[];
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createHistorySlice: StateCreator<
    HistorySlice & SliceDependencies,
    [],
    [],
    HistorySlice
> = (set, get) => ({
    // Initial State
    history: [],
    historyIndex: -1,
    canUndo: false,
    canRedo: false,

    // Actions
    saveToHistory: (action) => {
        const state = get();
        const previousSnapshot = state.history[state.historyIndex]?.snapshot;
        const snapshot = createHistorySnapshot({
            detectedElements: state.detectedElements,
            dimensions: state.dimensions,
            annotations: state.annotations,
            sketches: state.sketches,
            symbols: state.symbols,
            walls: state.walls,
            rooms: state.rooms,
            sectionLines: state.sectionLines,
            elevationViews: state.elevationViews,
            activeElevationViewId: state.activeElevationViewId,
            hvacElements: state.hvacElements,
        }, previousSnapshot);
        const entry = createHistoryEntry(action, snapshot);
        const trimmedHistory = state.history.slice(0, state.historyIndex + 1);
        const newHistory = [...trimmedHistory, entry];
        const maxEntries = 50;
        const finalHistory = newHistory.slice(-maxEntries);
        set({
            history: finalHistory,
            historyIndex: finalHistory.length - 1,
            canUndo: finalHistory.length > 1,
            canRedo: false,
        });
    },

    undo: () => {
        const { history, historyIndex } = get();
        if (historyIndex <= 0) return;
        const targetIndex = historyIndex - 1;
        const snapshot = history[targetIndex]?.snapshot;
        if (!snapshot) return;
        set({
            detectedElements: snapshot.detectedElements,
            dimensions: snapshot.dimensions,
            annotations: snapshot.annotations,
            sketches: snapshot.sketches,
            symbols: snapshot.symbols,
            walls: snapshot.walls ?? [],
            rooms: snapshot.rooms ?? [],
            sectionLines: snapshot.sectionLines ?? [],
            elevationViews: snapshot.elevationViews ?? [],
            activeElevationViewId: snapshot.activeElevationViewId ?? null,
            hvacElements: snapshot.hvacElements ?? [],
            historyIndex: targetIndex,
            canUndo: targetIndex > 0,
            canRedo: true,
        });
    },

    redo: () => {
        const { history, historyIndex } = get();
        if (historyIndex >= history.length - 1) return;
        const targetIndex = historyIndex + 1;
        const snapshot = history[targetIndex]?.snapshot;
        if (!snapshot) return;
        set({
            detectedElements: snapshot.detectedElements,
            dimensions: snapshot.dimensions,
            annotations: snapshot.annotations,
            sketches: snapshot.sketches,
            symbols: snapshot.symbols,
            walls: snapshot.walls ?? [],
            rooms: snapshot.rooms ?? [],
            sectionLines: snapshot.sectionLines ?? [],
            elevationViews: snapshot.elevationViews ?? [],
            activeElevationViewId: snapshot.activeElevationViewId ?? null,
            hvacElements: snapshot.hvacElements ?? [],
            historyIndex: targetIndex,
            canUndo: true,
            canRedo: targetIndex < history.length - 1,
        });
    },

    clearHistory: () =>
        set({
            history: [],
            historyIndex: -1,
            canUndo: false,
            canRedo: false,
        }),
});
