/**
 * Store Helper Functions
 *
 * Shared utility functions used by store actions.
 * Extracted for better organization and testability.
 */

import type {
    DetectedElement,
    Dimension2D,
    Annotation2D,
    Sketch2D,
    ElevationView,
    HvacElement,
    SectionLine,
    SymbolInstance2D,
    HistoryEntry,
    Room,
    Wall,
} from '../types';
import { generateId } from '../utils/geometry';

type HistorySnapshotSourceRefs = {
    detectedElements: DetectedElement[];
    dimensions: Dimension2D[];
    annotations: Annotation2D[];
    sketches: Sketch2D[];
    symbols: SymbolInstance2D[];
    walls: Wall[];
    rooms: Room[];
    sectionLines: SectionLine[];
    elevationViews: ElevationView[];
    hvacElements: HvacElement[];
};

const historySnapshotSourceRefs = new WeakMap<HistoryEntry['snapshot'], HistorySnapshotSourceRefs>();

// =============================================================================
// Deep Clone
// =============================================================================

export function deepClone<T>(value: T): T {
    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value)) as T;
}

// =============================================================================
// History Helpers
// =============================================================================

export function createEmptyHistorySnapshot(): HistoryEntry['snapshot'] {
    const snapshot = {
        detectedElements: [],
        dimensions: [],
        annotations: [],
        sketches: [],
        symbols: [],
        walls: [],
        rooms: [],
        sectionLines: [],
        elevationViews: [],
        activeElevationViewId: null,
        hvacElements: [],
    };
    historySnapshotSourceRefs.set(snapshot, {
        detectedElements: snapshot.detectedElements,
        dimensions: snapshot.dimensions,
        annotations: snapshot.annotations,
        sketches: snapshot.sketches,
        symbols: snapshot.symbols,
        walls: snapshot.walls,
        rooms: snapshot.rooms,
        sectionLines: snapshot.sectionLines,
        elevationViews: snapshot.elevationViews,
        hvacElements: snapshot.hvacElements,
    });
    return snapshot;
}

export function createHistoryEntry(action: string, snapshot: HistoryEntry['snapshot']): HistoryEntry {
    return {
        id: generateId(),
        timestamp: Date.now(),
        action,
        snapshot,
    };
}

export function createHistorySnapshot(state: {
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
}, previousSnapshot?: HistoryEntry['snapshot']): HistoryEntry['snapshot'] {
    const previousRefs = previousSnapshot ? historySnapshotSourceRefs.get(previousSnapshot) : undefined;
    const snapshot = {
        detectedElements:
            previousSnapshot && previousRefs?.detectedElements === state.detectedElements
                ? previousSnapshot.detectedElements
                : deepClone(state.detectedElements),
        dimensions:
            previousSnapshot && previousRefs?.dimensions === state.dimensions
                ? previousSnapshot.dimensions
                : deepClone(state.dimensions),
        annotations:
            previousSnapshot && previousRefs?.annotations === state.annotations
                ? previousSnapshot.annotations
                : deepClone(state.annotations),
        sketches:
            previousSnapshot && previousRefs?.sketches === state.sketches
                ? previousSnapshot.sketches
                : deepClone(state.sketches),
        symbols:
            previousSnapshot && previousRefs?.symbols === state.symbols
                ? previousSnapshot.symbols
                : deepClone(state.symbols),
        walls:
            previousSnapshot && previousRefs?.walls === state.walls
                ? previousSnapshot.walls
                : deepClone(state.walls),
        rooms:
            previousSnapshot && previousRefs?.rooms === state.rooms
                ? previousSnapshot.rooms
                : deepClone(state.rooms),
        sectionLines:
            previousSnapshot && previousRefs?.sectionLines === state.sectionLines
                ? previousSnapshot.sectionLines
                : deepClone(state.sectionLines),
        elevationViews:
            previousSnapshot && previousRefs?.elevationViews === state.elevationViews
                ? previousSnapshot.elevationViews
                : deepClone(state.elevationViews),
        activeElevationViewId: state.activeElevationViewId,
        hvacElements:
            previousSnapshot && previousRefs?.hvacElements === state.hvacElements
                ? previousSnapshot.hvacElements
                : deepClone(state.hvacElements),
    };
    historySnapshotSourceRefs.set(snapshot, {
        detectedElements: state.detectedElements,
        dimensions: state.dimensions,
        annotations: state.annotations,
        sketches: state.sketches,
        symbols: state.symbols,
        walls: state.walls,
        rooms: state.rooms,
        sectionLines: state.sectionLines,
        elevationViews: state.elevationViews,
        hvacElements: state.hvacElements,
    });
    return snapshot;
}
