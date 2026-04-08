/**
 * Selection Slice
 * 
 * Domain-specific slice for selection and tool state.
 * Uses Zustand slice pattern for composition.
 */

import type { StateCreator } from 'zustand';

import type {
    DrawingTool,
    Dimension2D,
    Annotation2D,
    Sketch2D,
    SymbolInstance2D,
} from '../../types';

// =============================================================================
// Types
// =============================================================================

export interface SelectionSliceState {
    activeTool: DrawingTool;
    activeLayerId: string | null;
    selectedElementIds: string[];
    hoveredElementId: string | null;
    // Aliases for backward compatibility
    tool: DrawingTool;
    selectedIds: string[];
}

export interface SelectionSliceActions {
    selectElement: (id: string, addToSelection?: boolean) => void;
    deselectElement: (id: string) => void;
    clearSelection: () => void;
    selectAll: () => void;
    setHoveredElement: (id: string | null) => void;
    deleteSelectedElements: () => void;
    setActiveTool: (tool: DrawingTool) => void;
    setActiveLayer: (id: string | null) => void;
    // Aliases
    setSelectedIds: (ids: string[]) => void;
    deleteSelected: () => void;
    setTool: (tool: DrawingTool) => void;
}

export type SelectionSlice = SelectionSliceState & SelectionSliceActions;

// =============================================================================
// Slice Dependencies Interface
// =============================================================================

interface SliceDependencies {
    dimensions: Dimension2D[];
    annotations: Annotation2D[];
    sketches: Sketch2D[];
    symbols: SymbolInstance2D[];
    saveToHistory: (action: string) => void;
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createSelectionSlice: StateCreator<
    SelectionSlice & SliceDependencies,
    [],
    [],
    SelectionSlice
> = (set, get) => ({
    // Initial State
    activeTool: 'select',
    activeLayerId: 'default',
    selectedElementIds: [],
    hoveredElementId: null,
    // Aliases
    tool: 'select',
    selectedIds: [],

    // Actions
    selectElement: (id, addToSelection = false) =>
        set((state) => ({
            selectedElementIds: addToSelection
                ? [...state.selectedElementIds, id]
                : [id],
            selectedIds: addToSelection
                ? [...state.selectedElementIds, id]
                : [id],
        })),

    deselectElement: (id) =>
        set((state) => ({
            selectedElementIds: state.selectedElementIds.filter((eid) => eid !== id),
            selectedIds: state.selectedElementIds.filter((eid) => eid !== id),
        })),

    clearSelection: () => set({ selectedElementIds: [], selectedIds: [] }),

    selectAll: () =>
        set((state) => {
            const allIds = [
                ...state.dimensions.map((d) => d.id),
                ...state.annotations.map((a) => a.id),
                ...state.sketches.map((s) => s.id),
                ...state.symbols.map((s) => s.id),
            ];
            return {
                selectedElementIds: allIds,
                selectedIds: allIds,
            };
        }),

    setHoveredElement: (id) => set({ hoveredElementId: id }),

    deleteSelectedElements: () => {
        const { selectedElementIds, dimensions, annotations, sketches, symbols } = get();

        set({
            dimensions: dimensions.filter((d) => !selectedElementIds.includes(d.id)),
            annotations: annotations.filter((a) => !selectedElementIds.includes(a.id)),
            sketches: sketches.filter((s) => !selectedElementIds.includes(s.id)),
            symbols: symbols.filter((s) => !selectedElementIds.includes(s.id)),
            selectedElementIds: [],
            selectedIds: [],
        });
        get().saveToHistory('Delete selected elements');
    },

    setActiveTool: (tool) =>
        set({
            activeTool: tool,
            tool,
            selectedElementIds: [],
            selectedIds: [],
        }),

    setActiveLayer: (id) => set({ activeLayerId: id }),

    // Aliases
    setSelectedIds: (ids) => set({ selectedElementIds: ids, selectedIds: ids }),
    deleteSelected: () => get().deleteSelectedElements(),
    setTool: (tool) => get().setActiveTool(tool),
});
