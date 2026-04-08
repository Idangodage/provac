/**
 * Store Types
 *
 * Type definitions for the drawing store.
 * Extracted for cleaner imports and better separation of concerns.
 */

import type {
    Point2D,
    DisplayUnit,
    Dimension2D,
    DimensionSettings,
    HvacDesignConditions,
    Annotation2D,
    Sketch2D,
    Guide,
    SymbolInstance2D,
    DrawingLayer,
    DrawingTool,
    ImportedDrawing,
    DetectedElement,
    PageConfig,
    HistoryEntry,
    SplineSettings,
    SplineMethod,
} from '../types';

// =============================================================================
// State Types
// =============================================================================

export interface DrawingState {
    // Drawing Elements
    dimensions: Dimension2D[];
    dimensionSettings: DimensionSettings;
    hvacDesignConditions: HvacDesignConditions;
    annotations: Annotation2D[];
    sketches: Sketch2D[];
    guides: Guide[];
    symbols: SymbolInstance2D[];
    layers: DrawingLayer[];

    // Import State
    importedDrawing: ImportedDrawing | null;
    importProgress: number;
    isProcessing: boolean;
    processingStatus: string;
    detectedElements: DetectedElement[];

    // Tool State
    activeTool: DrawingTool;
    activeLayerId: string | null;
    selectedElementIds: string[];
    hoveredElementId: string | null;

    // Aliases for backward compatibility
    tool: DrawingTool;
    selectedIds: string[];

    // View State
    zoom: number;
    zoomToFitRequestId: number;
    resetViewRequestId: number;
    panOffset: Point2D;
    displayUnit: DisplayUnit;
    gridSize: number;
    snapToGrid: boolean;
    showGrid: boolean;
    showRulers: boolean;
    pageConfig: PageConfig;

    // Preview State
    previewHeight: number;
    show3DPreview: boolean;
    autoSync3D: boolean;

    // Calibration State
    isCalibrating: boolean;
    calibrationStep: number;

    // History State
    history: HistoryEntry[];
    historyIndex: number;

    // Spline Settings
    splineSettings: SplineSettings;
    splineEditMode: 'draw' | 'edit-points' | 'add-point' | 'remove-point';
    editingSplineId: string | null;

    // Computed properties
    canUndo: boolean;
    canRedo: boolean;
}

// =============================================================================
// Action Types
// =============================================================================

export interface ImportActions {
    setImportedDrawing: (drawing: ImportedDrawing | null) => void;
    updateImportedDrawing: (data: Partial<ImportedDrawing>) => void;
    setImportProgress: (progress: number) => void;
    setProcessingStatus: (status: string, isProcessing: boolean) => void;
    clearImportedDrawing: () => void;
}

export interface DetectionActions {
    setDetectedElements: (elements: DetectedElement[]) => void;
    acceptDetectedElement: (id: string) => void;
    rejectDetectedElement: (id: string) => void;
    acceptAllDetectedElements: () => void;
    clearDetectedElements: () => void;
}

export interface AnnotationActions {
    addDimension: (dimension: Omit<Dimension2D, 'id'>, options?: { skipHistory?: boolean }) => string;
    updateDimension: (id: string, data: Partial<Dimension2D>, options?: { skipHistory?: boolean }) => void;
    deleteDimension: (id: string) => void;
    setDimensionSettings: (settings: Partial<DimensionSettings>) => void;
    autoDimensionExteriorWalls: () => void;
    syncAutoDimensions: () => void;
    addAreaDimensions: () => void;
    setHvacDesignConditions: (updates: Partial<HvacDesignConditions>) => void;
    applyRoomTemplateToSelectedRooms: (templateId: string) => void;
    addAnnotation: (annotation: Omit<Annotation2D, 'id'>) => string;
    updateAnnotation: (id: string, data: Partial<Annotation2D>) => void;
    deleteAnnotation: (id: string) => void;
    addSketch: (sketch: Omit<Sketch2D, 'id'>) => string;
    updateSketch: (id: string, data: Partial<Sketch2D>) => void;
    deleteSketch: (id: string) => void;
    addGuide: (guide: Guide) => void;
    removeGuide: (id: string) => void;
    clearGuides: () => void;
    addSymbol: (symbol: Omit<SymbolInstance2D, 'id'>) => string;
    updateSymbol: (id: string, data: Partial<SymbolInstance2D>, options?: { skipHistory?: boolean }) => void;
    deleteSymbol: (id: string) => void;
}

export interface SelectionActions {
    selectElement: (id: string, addToSelection?: boolean) => void;
    deselectElement: (id: string) => void;
    clearSelection: () => void;
    selectAll: () => void;
    setHoveredElement: (id: string | null) => void;
    deleteSelectedElements: () => void;
    setSelectedIds: (ids: string[]) => void;
    deleteSelected: () => void;
}

export interface ToolActions {
    setActiveTool: (tool: DrawingTool) => void;
    setTool: (tool: DrawingTool) => void;
}

export interface ViewActions {
    setZoom: (zoom: number) => void;
    setPanOffset: (offset: Point2D) => void;
    setViewTransform: (zoom: number, offset: Point2D) => void;
    setDisplayUnit: (unit: DisplayUnit) => void;
    setGridSize: (size: number) => void;
    setSnapToGrid: (snap: boolean) => void;
    setShowGrid: (show: boolean) => void;
    setShowRulers: (show: boolean) => void;
    toggleRulers: () => void;
    setPageConfig: (config: Partial<PageConfig>) => void;
    resetView: () => void;
    zoomToFit: () => void;
}

export interface PreviewActions {
    setPreviewHeight: (height: number) => void;
    setShow3DPreview: (show: boolean) => void;
    setAutoSync3D: (sync: boolean) => void;
}

export interface CalibrationActions {
    startCalibration: () => void;
    addCalibrationPoint: (point: Point2D) => void;
    setCalibrationDistance: (distance: number) => void;
    finishCalibration: () => void;
    cancelCalibration: () => void;
}

export interface LayerActions {
    addLayer: (name: string) => string;
    updateLayer: (id: string, data: Partial<DrawingLayer>) => void;
    deleteLayer: (id: string) => void;
    setActiveLayer: (id: string | null) => void;
    moveElementToLayer: (elementId: string, layerId: string) => void;
    toggleLayerVisibility: (id: string) => void;
    toggleLayerLock: (id: string) => void;
}

export interface HistoryActions {
    saveToHistory: (action: string) => void;
    undo: () => void;
    redo: () => void;
    clearHistory: () => void;
}

export interface DataActions {
    exportToJSON: () => string;
    importFromJSON: (json: string) => void;
    loadData: (data: unknown) => void;
    exportData: () => unknown;
}

export interface SplineActions {
    setSplineSettings: (settings: Partial<SplineSettings>) => void;
    setSplineEditMode: (mode: 'draw' | 'edit-points' | 'add-point' | 'remove-point') => void;
    setEditingSpline: (id: string | null) => void;
    addSplineControlPoint: (sketchId: string, point: Point2D, index?: number) => void;
    updateSplineControlPoint: (sketchId: string, pointIndex: number, position: Point2D) => void;
    removeSplineControlPoint: (sketchId: string, pointIndex: number) => void;
    toggleSplineClosed: (sketchId: string) => void;
    convertSplineMethod: (sketchId: string, method: SplineMethod) => void;
}

// Combined store type
export type DrawingStore = DrawingState &
    ImportActions &
    DetectionActions &
    AnnotationActions &
    SelectionActions &
    ToolActions &
    ViewActions &
    PreviewActions &
    CalibrationActions &
    LayerActions &
    HistoryActions &
    DataActions &
    SplineActions;

// Alias for backward compatibility
export type SmartDrawingState = DrawingStore;
