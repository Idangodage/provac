/**
 * Drawing Canvas Component
 *
 * Main Fabric.js canvas wrapper for smart drawing.
 * Uses mode-specific hooks following industry best practices.
 */

"use client";

import * as fabric from "fabric";
import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import { shallow } from "zustand/shallow";

import type { ArchitecturalObjectDefinition } from "../data";
import { useSmartDrawingStore } from "../store";
import { useDrawingInteractionStore } from "../store/interactionStore";
import type { Point2D, SymbolInstance2D, Wall } from "../types";
import { generateId } from "../utils/geometry";

import { hideActiveSelectionChrome } from "./DrawingCanvas.types";
import type {
  DrawingCanvasProps,
  CanvasState,
  MarqueeSelectionState,
  OpeningPointerInteraction,
} from "./DrawingCanvas.types";
export type { DrawingCanvasProps } from "./DrawingCanvas.types";

import {
  Grid,
  PageLayout,
  Rulers,
  snapWallPoint,
  MM_TO_PX,
  toMillimeters,
  // Hooks
  useCanvasKeyboard,
  useSelectMode,
  useMiddlePan,
  useWallTool,
  useRoomTool,
  useDimensionTool,
  useOffsetTool,
  useTrimTool,
  useExtendTool,
  useTargetResolvers,
  useContextMenuHandlers,
  type UseContextMenuHandlersOptions,
  useGeometryHelpers,
  useHvacPlacement,
  useDuctTool,
  useRefrigerantPipeTool,
  useOpeningPlacement,
  useOpeningInteraction,
  useRendererSync,
  useCanvasMouseHandlers,
  useCanvasEventBinding,
  RoomRenderer,
  DimensionRenderer,
  ObjectRenderer,
  SectionLineRenderer,
  HvacPlanRenderer,
} from "./canvas";
import {
  isRefrigerantPipeElementType,
  translateRefrigerantPipeElementProperties,
  resolveUnitPortBundle,
  resolveBundleTargetsForElement,
  type RefrigerantPipeBundleConnection,
  type RefrigerantPipeConnection,
} from "./canvas/hvac/refrigerantPipePairModel";
import {
  findConnectedPipeElements,
  getFixedEndInfo,
  getExistingRoutePoints,
  getStoredLeadPivotPoint,
  buildReroutedPipePairProperties,
  buildReroutedSinglePipeProperties,
  buildReroutedPipeElementFrame,
  getMovingEndBundleConnection,
  getMovingEndPipeConnection,
} from "./canvas/hvac/pipeConnectionResolver";
import {
  reroutePipeBundleCenterline,
  reroutePipeCenterline,
} from "./canvas/hvac/pipeRouteOptimizer";
import {
  installCanvasRenderScheduler,
  restoreCanvasRenderScheduler,
} from "./canvas/renderScheduler";

// =============================================================================
// Component
// =============================================================================

export function DrawingCanvas({
  className = "",
  gridSize,
  snapToGrid,
  showGrid,
  showRulers,
  paperUnit = "mm",
  realWorldUnit,
  scaleDrawing = 1,
  scaleReal = 50,
  rulerMode = "paper",
  majorTickInterval = 10,
  tickSubdivisions = 10,
  showRulerLabels = true,
  gridMode = "paper",
  majorGridSize = 10,
  gridSubdivisions = 10,
  backgroundColor = "transparent",
  onCanvasReady,
  objectDefinitions = [],
  equipmentDefinitions = [],
  pendingPlacementObjectId = null,
  pendingPlacementEquipmentId = null,
  onObjectPlaced,
  onCancelObjectPlacement,
  onEquipmentPlaced,
  onCancelEquipmentPlacement,
}: DrawingCanvasProps) {
  // Core refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const snapOverlayRef = useRef<HTMLCanvasElement>(null); // [SNAP WIRE] overlay for snap indicators
  const outerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const fabricRef = useRef<fabric.Canvas | null>(null);
  const roomRendererRef = useRef<RoomRenderer | null>(null);
  const dimensionRendererRef = useRef<DimensionRenderer | null>(null);
  const objectRendererRef = useRef<ObjectRenderer | null>(null);
  const sectionLineRendererRef = useRef<SectionLineRenderer | null>(null);
  const hvacRendererRef = useRef<HvacPlanRenderer | null>(null);
  const zoomRef = useRef(1);
  const panOffsetRef = useRef<Point2D>({ x: 0, y: 0 });
  // Smooth view transform sync: one store update per frame for zoom/pan.
  const wheelRafId = useRef<number | null>(null);
  const wheelPendingZoom = useRef<number>(1);
  const wheelPendingPan = useRef<Point2D>({ x: 0, y: 0 });
  const paperScaleRatioRef = useRef(1);
  const placementCursorRef = useRef<Point2D | null>(null);
  const mousePositionRef = useRef<Point2D>({ x: 0, y: 0 });
  const mousePositionFrameRef = useRef<number | null>(null);
  const marqueeSelectionRef = useRef<MarqueeSelectionState>({
    active: false,
    start: null,
    current: null,
    mode: "window",
  });
  const lastMarqueeSelectionRef = useRef<MarqueeSelectionState>({
    active: false,
    start: null,
    current: null,
    mode: "window",
  });
  const applyMarqueeFilterRef = useRef(false);
  const canvasStateRef = useRef<CanvasState>({
    isPanning: false,
    lastPanPoint: null,
    isDrawing: false,
    drawingPoints: [],
  });
  const wallClipboardRef = useRef<Wall[] | null>(null);
  const openingResizeHandlesRef = useRef<fabric.Object[]>([]);
  const openingPointerInteractionRef = useRef<OpeningPointerInteraction | null>(
    null,
  );
  const suppressFabricSelectionSyncRef = useRef(0);
  const dimensionRefreshFrameRef = useRef<number | null>(null);
  const autoDimensionSyncFrameRef = useRef<number | null>(null);

  // Drag interaction state
  const isDraggingObjectRef = useRef(false);

  // State
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [fabricCanvas, setFabricCanvas] = useState<fabric.Canvas | null>(null);
  const [placementRotationDeg, setPlacementRotationDeg] = useState(0);
  const [placementValid, setPlacementValid] = useState(true);
  const [openingInteractionActive, setOpeningInteractionActive] =
    useState(false);
  const [isHandleDragging, setIsHandleDragging] = useState(false);
  const [activeRoomDragId, setActiveRoomDragId] = useState<string | null>(null);
  const [persistentRoomControlId, setPersistentRoomControlId] = useState<
    string | null
  >(null);
  const [canvasState, setCanvasState] = useState<CanvasState>({
    isPanning: false,
    lastPanPoint: null,
    isDrawing: false,
    drawingPoints: [],
  });

  const setViewportSizeIfChanged = useCallback(
    (width: number, height: number) => {
      const nextWidth = Math.max(1, Math.floor(width));
      const nextHeight = Math.max(1, Math.floor(height));
      setViewportSize((prev) => {
        if (prev.width === nextWidth && prev.height === nextHeight) {
          return prev;
        }
        return { width: nextWidth, height: nextHeight };
      });
    },
    [],
  );

  // Store
  const {
    activeTool: tool,
    zoom: documentZoom,
    panOffset: documentPanOffset,
    displayUnit,
    selectedElementIds: selectedIds,
    dimensions,
    dimensionSettings,
    symbols,
    pageConfig,
    gridSize: storeGridSize,
    showGrid: storeShowGrid,
    showRulers: storeShowRulers,
    snapToGrid: storeSnapToGrid,
    setPanOffset,
    setViewTransform,
    setTool,
    setSelectedIds,
    setProcessingStatus,
    saveToHistory,
    detectRooms,
    addSketch,
    addDimension,
    updateDimension,
    deleteDimension,
    addSymbol,
    updateSymbol,
    deleteSymbol,
    addWall,
    deleteSelected,
    updateWall,
    updateWalls,
    updateWallBevel,
    resetWallBevel,
    getCornerBevelDots,
    deleteWall,
    getWall,
    // Wall state and actions
    walls,
    rooms,
    wallDrawingState,
    wallSettings,
    sectionLines,
    sectionLineDrawingState,
    startWallDrawing,
    updateWallPreview,
    commitWall,
    cancelWallDrawing,
    startSectionLineDrawing,
    updateSectionLinePreview,
    commitSectionLine,
    cancelSectionLineDrawing,
    setSectionLineDirection,
    flipSectionLineDirection,
    updateSectionLine,
    deleteSectionLine,
    generateElevationForSection,
    regenerateElevations,
    connectWalls,
    createRoomWalls,
    moveRoom,
    hvacElements,
    addHvacElement,
    addHvacElements,
    updateHvacElement,
    syncAutoDimensions,
    selectWallSegmentAtPoint,
    selectWallSegmentWithinInterval,
    resolveRoomPerimeterWallSegments,
  } = useSmartDrawingStore(
    (state) => ({
      activeTool: state.activeTool,
      zoom: state.zoom,
      panOffset: state.panOffset,
      displayUnit: state.displayUnit,
      selectedElementIds: state.selectedElementIds,
      dimensions: state.dimensions,
      dimensionSettings: state.dimensionSettings,
      symbols: state.symbols,
      pageConfig: state.pageConfig,
      gridSize: state.gridSize,
      showGrid: state.showGrid,
      showRulers: state.showRulers,
      snapToGrid: state.snapToGrid,
      setPanOffset: state.setPanOffset,
      setViewTransform: state.setViewTransform,
      setTool: state.setTool,
      setSelectedIds: state.setSelectedIds,
      setProcessingStatus: state.setProcessingStatus,
      saveToHistory: state.saveToHistory,
      detectRooms: state.detectRooms,
      addSketch: state.addSketch,
      addDimension: state.addDimension,
      updateDimension: state.updateDimension,
      deleteDimension: state.deleteDimension,
      addSymbol: state.addSymbol,
      updateSymbol: state.updateSymbol,
      deleteSymbol: state.deleteSymbol,
      addWall: state.addWall,
      deleteSelected: state.deleteSelected,
      updateWall: state.updateWall,
      updateWalls: state.updateWalls,
      updateWallBevel: state.updateWallBevel,
      resetWallBevel: state.resetWallBevel,
      getCornerBevelDots: state.getCornerBevelDots,
      deleteWall: state.deleteWall,
      getWall: state.getWall,
      walls: state.walls,
      rooms: state.rooms,
      wallDrawingState: state.wallDrawingState,
      wallSettings: state.wallSettings,
      sectionLines: state.sectionLines,
      sectionLineDrawingState: state.sectionLineDrawingState,
      startWallDrawing: state.startWallDrawing,
      updateWallPreview: state.updateWallPreview,
      commitWall: state.commitWall,
      cancelWallDrawing: state.cancelWallDrawing,
      startSectionLineDrawing: state.startSectionLineDrawing,
      updateSectionLinePreview: state.updateSectionLinePreview,
      commitSectionLine: state.commitSectionLine,
      cancelSectionLineDrawing: state.cancelSectionLineDrawing,
      setSectionLineDirection: state.setSectionLineDirection,
      flipSectionLineDirection: state.flipSectionLineDirection,
      updateSectionLine: state.updateSectionLine,
      deleteSectionLine: state.deleteSectionLine,
      generateElevationForSection: state.generateElevationForSection,
      regenerateElevations: state.regenerateElevations,
      connectWalls: state.connectWalls,
      createRoomWalls: state.createRoomWalls,
      moveRoom: state.moveRoom,
      hvacElements: state.hvacElements,
      addHvacElement: state.addHvacElement,
      addHvacElements: state.addHvacElements,
      updateHvacElement: state.updateHvacElement,
      syncAutoDimensions: state.syncAutoDimensions,
      selectWallSegmentAtPoint: state.selectWallSegmentAtPoint,
      selectWallSegmentWithinInterval: state.selectWallSegmentWithinInterval,
      resolveRoomPerimeterWallSegments: state.resolveRoomPerimeterWallSegments,
    }),
    shallow,
  );
  const {
    mousePosition,
    hoveredElementId,
    zoom,
    panOffset,
    setMousePosition: setInteractionMousePosition,
    setHoveredElement,
    setViewTransform: setInteractionViewTransform,
    resetInteractionState,
  } = useDrawingInteractionStore(
    (state) => ({
      mousePosition: state.mousePosition,
      hoveredElementId: state.hoveredElementId,
      zoom: state.zoom,
      panOffset: state.panOffset,
      setMousePosition: state.setMousePosition,
      setHoveredElement: state.setHoveredElement,
      setViewTransform: state.setViewTransform,
      resetInteractionState: state.resetInteractionState,
    }),
    shallow,
  );
  const wallsRef = useRef<Wall[]>(walls);
  const symbolsRef = useRef<SymbolInstance2D[]>(symbols);
  wallsRef.current = walls;
  symbolsRef.current = symbols;

  // Derived values
  const resolvedRealWorldUnit = realWorldUnit ?? displayUnit;
  const resolvedGridSize = gridSize ?? storeGridSize ?? 20;
  const resolvedShowGrid = showGrid ?? storeShowGrid ?? true;
  const resolvedShowRulers = showRulers ?? storeShowRulers ?? true;
  const resolvedSnapToGrid = snapToGrid ?? storeSnapToGrid ?? true;
  const safeScaleDrawing =
    Number.isFinite(scaleDrawing) && scaleDrawing > 0 ? scaleDrawing : 1;
  const safeScaleReal =
    Number.isFinite(scaleReal) && scaleReal > 0 ? scaleReal : 1;
  const paperPerRealRatio = safeScaleDrawing / safeScaleReal;
  const safePaperPerRealRatio = Math.max(paperPerRealRatio, 0.000001);
  const viewportZoom = zoom * safePaperPerRealRatio;
  const overlayPanOffset = useMemo(
    () => ({
      x: panOffset.x * safePaperPerRealRatio,
      y: panOffset.y * safePaperPerRealRatio,
    }),
    [panOffset.x, panOffset.y, safePaperPerRealRatio],
  );
  const rulerMousePosition = useMemo(
    () => ({
      x: mousePosition.x * safePaperPerRealRatio,
      y: mousePosition.y * safePaperPerRealRatio,
    }),
    [mousePosition.x, mousePosition.y, safePaperPerRealRatio],
  );
  const safeGridSubdivisions =
    Number.isFinite(gridSubdivisions) && gridSubdivisions >= 1
      ? Math.max(1, Math.floor(gridSubdivisions))
      : 1;
  const baseGridMajorMm =
    gridMode === "real"
      ? toMillimeters(majorGridSize, resolvedRealWorldUnit) * paperPerRealRatio
      : toMillimeters(majorGridSize, paperUnit);
  const configuredGridMajorPaperPx = Math.max(baseGridMajorMm * MM_TO_PX, 0.5);
  const effectiveSnapGridSize = Math.max(
    configuredGridMajorPaperPx / safeGridSubdivisions / safePaperPerRealRatio,
    0.5,
  );
  const rulerSize = 24;
  const leftRulerWidth = Math.round(rulerSize * 1.2);
  const originOffset = resolvedShowRulers
    ? { x: leftRulerWidth, y: rulerSize }
    : { x: 0, y: 0 };
  const hostWidth = Math.max(1, viewportSize.width - originOffset.x);
  const hostHeight = Math.max(1, viewportSize.height - originOffset.y);
  const objectDefinitionsById = useMemo(
    () =>
      new Map(
        objectDefinitions.map((definition) => [definition.id, definition]),
      ),
    [objectDefinitions],
  );
  const equipmentDefinitionsById = useMemo(
    () =>
      new Map(
        equipmentDefinitions.map((definition) => [definition.id, definition]),
      ),
    [equipmentDefinitions],
  );
  const wallIdSet = useMemo(
    () => new Set(walls.map((wall) => wall.id)),
    [walls],
  );
  const wallById = useMemo(
    () => new Map(walls.map((wall) => [wall.id, wall])),
    [walls],
  );
  const roomById = useMemo(
    () => new Map(rooms.map((room) => [room.id, room])),
    [rooms],
  );

  const {
    wallContextMenu,
    dimensionContextMenu,
    sectionLineContextMenu,
    objectContextMenu,
    setWallContextMenu,
    setDimensionContextMenu,
    setSectionLineContextMenu,
    setObjectContextMenu,
    closeWallContextMenu,
    closeDimensionContextMenu,
    closeSectionLineContextMenu,
    closeObjectContextMenu,
    handleEditWallProperties,
    handleDeleteWallFromContext,
    handleConvertWallToDoorOpening,
    handleEditDimensionProperties,
    handleDeleteDimensionFromContext,
    handleToggleDimensionVisibility,
    handleFlipSectionLineDirection,
    handleToggleSectionLineLock,
    handleGenerateElevationFromSection,
    handleDeleteSectionLineFromContext,
    handleEditObjectProperties,
    handleDeleteObjectFromContext,
    handleFlipDoorSwing,
  } = useContextMenuHandlers({
    selectedIds,
    dimensions,
    symbols,
    sectionLines,
    objectDefinitionsById: objectDefinitionsById as Map<
      string,
      { category?: string; widthMm?: number; depthMm?: number }
    >,
    setSelectedIds,
    setProcessingStatus,
    getWall: getWall as UseContextMenuHandlersOptions["getWall"],
    updateWall,
    deleteWall,
    deleteDimension,
    updateDimension,
    deleteSectionLine,
    updateSectionLine,
    flipSectionLineDirection,
    generateElevationForSection,
    deleteSymbol: deleteSymbol as (id: string) => void,
    updateSymbol,
  });

  const pendingPlacementDefinition = pendingPlacementObjectId
    ? (objectDefinitionsById.get(pendingPlacementObjectId) ?? null)
    : null;
  const pendingPlacementEquipmentDefinition = pendingPlacementEquipmentId
    ? (equipmentDefinitionsById.get(pendingPlacementEquipmentId) ?? null)
    : null;
  const contextObjectInstance = objectContextMenu
    ? (symbols.find((entry) => entry.id === objectContextMenu.objectId) ?? null)
    : null;
  const contextObjectDefinition = contextObjectInstance
    ? (objectDefinitionsById.get(contextObjectInstance.symbolId) ?? null)
    : null;
  const isContextDoorObject = contextObjectDefinition?.category === "doors";
  const doorWindowSymbolsSignature = useMemo(() => {
    return symbols
      .map((instance) => {
        const definition = objectDefinitionsById.get(instance.symbolId);
        if (!definition) return null;
        if (
          definition.category !== "doors" &&
          definition.category !== "windows"
        )
          return null;
        return [
          instance.id,
          definition.type,
          instance.rotation.toFixed(2),
          String(instance.properties?.swingDirection ?? ""),
          String(instance.properties?.type ?? ""),
          String(instance.properties?.widthMm ?? ""),
          String(instance.properties?.heightMm ?? ""),
          String(instance.properties?.hostWallId ?? ""),
        ].join(":");
      })
      .filter((entry): entry is string => Boolean(entry))
      .sort()
      .join("|");
  }, [symbols, objectDefinitionsById]);

  void MM_TO_PX;

  const queueMousePositionUpdate = useCallback(
    (position: Point2D) => {
      mousePositionRef.current = position;
      if (typeof window === "undefined") return;
      if (mousePositionFrameRef.current !== null) return;
      mousePositionFrameRef.current = window.requestAnimationFrame(() => {
        mousePositionFrameRef.current = null;
        const nextMousePosition = mousePositionRef.current;
        setInteractionMousePosition({
          x: nextMousePosition.x / MM_TO_PX,
          y: nextMousePosition.y / MM_TO_PX,
        });
      });
    },
    [setInteractionMousePosition],
  );

  const setMarqueeSelectionMode = useCallback((mode: "window" | "crossing") => {
    const canvas = fabricRef.current as
      | (fabric.Canvas & { selectionFullyContained?: boolean })
      | null;
    if (!canvas) return;
    canvas.selectionFullyContained = mode === "window";
  }, []);

  const getSelectionRect = useCallback((selection: MarqueeSelectionState) => {
    if (!selection.start || !selection.current) return null;
    return {
      minX: Math.min(selection.start.x, selection.current.x),
      minY: Math.min(selection.start.y, selection.current.y),
      maxX: Math.max(selection.start.x, selection.current.x),
      maxY: Math.max(selection.start.y, selection.current.y),
    };
  }, []);

  const getTargetBoundsMm = useCallback((target: fabric.Object) => {
    const rect = target.getBoundingRect();
    if (
      !Number.isFinite(rect.left) ||
      !Number.isFinite(rect.top) ||
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height)
    ) {
      return null;
    }
    return {
      minX: rect.left / MM_TO_PX,
      minY: rect.top / MM_TO_PX,
      maxX: (rect.left + rect.width) / MM_TO_PX,
      maxY: (rect.top + rect.height) / MM_TO_PX,
    };
  }, []);

  const filterMarqueeSelectionTargets = useCallback(
    (targets: fabric.Object[]) => {
      if (!applyMarqueeFilterRef.current) return targets;

      const lastSelection = lastMarqueeSelectionRef.current;
      const selectionRect = getSelectionRect(lastSelection);
      if (!selectionRect) return targets;

      const width = selectionRect.maxX - selectionRect.minX;
      const height = selectionRect.maxY - selectionRect.minY;
      if (width < 2 && height < 2) {
        return targets;
      }

      return targets.filter((target) => {
        const bounds = getTargetBoundsMm(target);
        if (!bounds) return true;

        const intersects = !(
          bounds.maxX < selectionRect.minX ||
          bounds.minX > selectionRect.maxX ||
          bounds.maxY < selectionRect.minY ||
          bounds.minY > selectionRect.maxY
        );

        if (lastSelection.mode === "crossing") {
          return intersects;
        }

        return (
          bounds.minX >= selectionRect.minX &&
          bounds.maxX <= selectionRect.maxX &&
          bounds.minY >= selectionRect.minY &&
          bounds.maxY <= selectionRect.maxY
        );
      });
    },
    [getSelectionRect, getTargetBoundsMm],
  );

  useEffect(() => {
    return () => {
      if (
        mousePositionFrameRef.current !== null &&
        typeof window !== "undefined"
      ) {
        window.cancelAnimationFrame(mousePositionFrameRef.current);
        mousePositionFrameRef.current = null;
      }
      resetInteractionState();
    };
  }, [resetInteractionState]);

  useEffect(() => {
    const previousRatio = paperScaleRatioRef.current;
    if (!Number.isFinite(previousRatio) || previousRatio <= 0) {
      paperScaleRatioRef.current = safePaperPerRealRatio;
      return;
    }
    if (Math.abs(previousRatio - safePaperPerRealRatio) < 0.0000001) {
      paperScaleRatioRef.current = safePaperPerRealRatio;
      return;
    }

    const currentPan = panOffsetRef.current;
    const nextPan = {
      x: (currentPan.x * previousRatio) / safePaperPerRealRatio,
      y: (currentPan.y * previousRatio) / safePaperPerRealRatio,
    };
    paperScaleRatioRef.current = safePaperPerRealRatio;
    panOffsetRef.current = nextPan;
    setInteractionViewTransform(zoom, nextPan);
    setPanOffset(nextPan);
  }, [safePaperPerRealRatio, setInteractionViewTransform, setPanOffset, zoom]);

  useEffect(() => {
    setInteractionViewTransform(documentZoom, documentPanOffset);
  }, [documentZoom, documentPanOffset, setInteractionViewTransform]);

  const {
    projectPointToSegment,
    roomBoundaryDistance,
    perimeterWallIdsForRooms,
    findWallPlacementSnap,
    findOpeningAtPoint,
  } = useGeometryHelpers({
    walls,
    rooms,
    roomById,
    wallById,
    wallIdSet,
    viewportZoom,
  });

  const {
    resolveOpeningWidthMm,
    resolveOpeningHeightMm,
    resolveOpeningSillHeightMm,
    fitOpeningToWall,
    hasFurnitureCollision,
    computePlacement,
    syncOpeningForSymbol,
    buildHostedOpeningSymbolProperties,
    buildOpeningPreviewProperties,
    placePendingObject,
  } = useOpeningPlacement({
    findWallPlacementSnap,
    projectPointToSegment,
    walls,
    rooms,
    symbols,
    objectDefinitionsById: objectDefinitionsById as Map<
      string,
      ArchitecturalObjectDefinition
    >,
    resolvedSnapToGrid,
    wallSettings,
    placementRotationDeg,
    pendingPlacementDefinition,
    addSymbol,
    updateWall,
    updateSymbol,
    setSelectedIds,
    setProcessingStatus,
    onObjectPlaced,
    setPlacementValid,
  });

  const { computeHvacPlacement, placePendingHvacElement } = useHvacPlacement({
    rooms,
    hvacElements,
    equipmentDefinitions,
    pendingPlacementEquipmentDefinition,
    placementRotationDeg,
    findWallPlacementSnap,
    addHvacElement,
    setSelectedIds,
    setProcessingStatus,
    onEquipmentPlaced,
  });

  const {
    resolveWallIdFromTarget,
    resolveRoomIdFromTarget,
    resolveDimensionIdFromTarget,
    resolveSectionLineIdFromTarget,
    resolveObjectIdFromTarget,
    resolveHvacIdFromTarget,
    resolveOpeningIdFromTarget,
    resolveOpeningResizeHandleFromTarget,
  } = useTargetResolvers();

  const {
    clearOpeningResizeHandles,
    updateOpeningPointerInteraction,
    beginOpeningPointerInteraction,
    finishOpeningPointerInteraction,
    nudgeSelectedObjects,
  } = useOpeningInteraction({
    fabricRef,
    walls,
    symbols,
    selectedIds,
    objectDefinitionsById: objectDefinitionsById as Map<
      string,
      ArchitecturalObjectDefinition
    >,
    openingResizeHandlesRef,
    openingPointerInteractionRef,
    computePlacement,
    syncOpeningForSymbol,
    buildHostedOpeningSymbolProperties,
    resolveOpeningWidthMm,
    resolveOpeningHeightMm,
    resolveOpeningSillHeightMm,
    hasFurnitureCollision,
    findWallPlacementSnap,
    projectPointToSegment,
    updateWall,
    updateSymbol,
    saveToHistory,
    setProcessingStatus,
    setOpeningInteractionActive,
  });

  const {
    handleMouseDown: handleDuctMouseDown,
    handleMouseMove: handleDuctMouseMove,
    handleDoubleClick: handleDuctDoubleClick,
    handleKeyDown: handleDuctKeyDown,
    handleKeyUp: handleDuctKeyUp,
    cancelDrawing: cancelDuctDrawing,
  } = useDuctTool({
    fabricRef,
    hvacRendererRef,
    activeTool: tool,
    hvacElements,
    zoom: viewportZoom,
    addHvacElement,
    updateHvacElement,
    setSelectedIds,
    setProcessingStatus,
  });

  const {
    handleMouseDown: handleRefrigerantPipeMouseDown,
    handleMouseMove: handleRefrigerantPipeMouseMove,
    handleDoubleClick: handleRefrigerantPipeDoubleClick,
    handleKeyDown: handleRefrigerantPipeKeyDown,
    handleKeyUp: handleRefrigerantPipeKeyUp,
    cancelDrawing: cancelRefrigerantPipeDrawing,
  } = useRefrigerantPipeTool({
    fabricRef,
    hvacRendererRef,
    activeTool: tool,
    hvacElements,
    zoom: viewportZoom,
    snapToGrid: resolvedSnapToGrid,
    gridSize: effectiveSnapGridSize,
    addHvacElements,
    setSelectedIds,
    setProcessingStatus,
  });

  const nudgeSelectedEntities = useCallback(
    (dxMm: number, dyMm: number) => {
      const movedObjects = nudgeSelectedObjects(dxMm, dyMm);
      const selectedSet = new Set(selectedIds);
      const selectedEquipment = hvacElements.filter((element) =>
        selectedSet.has(element.id),
      );
      let movedEquipment = false;

      for (const element of selectedEquipment) {
        if (isRefrigerantPipeElementType(element.type)) {
          updateHvacElement(element.id, {
            position: {
              x: element.position.x + dxMm,
              y: element.position.y + dyMm,
            },
            properties: translateRefrigerantPipeElementProperties(
              element.type,
              element.properties,
              {
                x: dxMm,
                y: dyMm,
              },
            ),
          });
          movedEquipment = true;
          continue;
        }
        const candidateCenter = {
          x: element.position.x + element.width / 2 + dxMm,
          y: element.position.y + element.depth / 2 + dyMm,
        };
        const placement = computeHvacPlacement(candidateCenter, element);
        if (!placement.valid) {
          setProcessingStatus(
            placement.invalidReason ??
              "Movement blocked: AC equipment cannot be placed there.",
            false,
          );
          continue;
        }

        const movedProps = {
          ...element.properties,
          ...(placement.placementProperties ?? {}),
        };
        updateHvacElement(element.id, {
          position: placement.point,
          rotation: placement.rotationDeg,
          width: placement.widthMm,
          depth: placement.depthMm,
          height: placement.heightMm,
          roomId: placement.roomId ?? undefined,
          wallId: placement.wallId ?? undefined,
          properties: movedProps,
        });

        // Reroute connected pipes after keyboard nudge
        const movedUnit = {
          ...element,
          position: placement.point,
          rotation: placement.rotationDeg,
          width: placement.widthMm,
          depth: placement.depthMm,
          height: placement.heightMm,
          roomId: placement.roomId ?? undefined,
          wallId: placement.wallId ?? undefined,
          properties: movedProps,
        };
        const connectedPipes = findConnectedPipeElements(element.id, hvacElements);
        const movedBundles = resolveBundleTargetsForElement(movedUnit);
        const unitBundle = resolveUnitPortBundle(movedUnit);
        const contextElements = hvacElements.map((candidate) =>
          candidate.id === element.id ? movedUnit : candidate,
        );
        const pickClosestBundle = (
          bundles: readonly RefrigerantPipeBundleConnection[],
          referencePoint: Point2D | null,
          resolveCandidatePoint: (bundle: RefrigerantPipeBundleConnection) => Point2D,
        ): RefrigerantPipeBundleConnection | null => {
          if (bundles.length === 0) return null;
          if (!referencePoint) return bundles[0]!;
          return bundles.reduce((best, candidate) => {
            const bestPoint = resolveCandidatePoint(best);
            const candidatePoint = resolveCandidatePoint(candidate);
            const bestDist = Math.hypot(
              bestPoint.x - referencePoint.x,
              bestPoint.y - referencePoint.y,
            );
            const candidateDist = Math.hypot(
              candidatePoint.x - referencePoint.x,
              candidatePoint.y - referencePoint.y,
            );
            return candidateDist < bestDist ? candidate : best;
          });
        };

        for (const info of connectedPipes) {
          const fixedInfo = getFixedEndInfo(info.pipeElement, info.fixedEnd);
          if (!fixedInfo) continue;
          const existingRoute = getExistingRoutePoints(info.pipeElement);
          const lockedPivotPoint = getStoredLeadPivotPoint(
            info.pipeElement,
            info.movingEnd,
          );

          if (info.isPipePair) {
            const existingMovingConn = getMovingEndBundleConnection(
              info.pipeElement,
              info.movingEnd,
            );
            let newBundle: RefrigerantPipeBundleConnection | null = null;
            if (existingMovingConn?.terminalRole && movedBundles.length > 0) {
              newBundle =
                movedBundles.find(
                  (b) => b.terminalRole === existingMovingConn.terminalRole,
                ) ?? null;
            }
            if (!newBundle && movedBundles.length === 1) newBundle = movedBundles[0]!;
            if (!newBundle && unitBundle) newBundle = unitBundle;
            if (!newBundle && movedBundles.length > 0) {
              newBundle = pickClosestBundle(
                movedBundles,
                existingMovingConn?.point ?? null,
                (bundle) => bundle.point,
              );
            }
            if (!newBundle) continue;

            const rerouteResult = reroutePipeBundleCenterline({
              fixedBundlePoint: fixedInfo.point,
              fixedDirection: fixedInfo.direction,
              movedBundlePoint: newBundle.point,
              movedDirection: newBundle.direction,
              existingRoutePoints: existingRoute,
              fixedEnd: info.fixedEnd,
              lockedPivotPoint,
            });
            const updatedMovingBundle: RefrigerantPipeBundleConnection = {
              ...newBundle,
              sourceElementId: element.id,
              guideReference:
                existingMovingConn?.guideReference ?? newBundle.guideReference,
              terminalRole:
                existingMovingConn?.terminalRole ?? newBundle.terminalRole,
            };
            const newProperties = buildReroutedPipePairProperties({
              existingProperties: info.pipeElement.properties,
              movingEnd: info.movingEnd,
              newRoutePoints: rerouteResult.routePoints,
              newMovingEndBundle: updatedMovingBundle,
              leadPivotPoint: rerouteResult.pivotPoint,
            });
            const frame = buildReroutedPipeElementFrame(
              info.pipeElement,
              newProperties,
              contextElements,
            );
            updateHvacElement(info.pipeElement.id, {
              position: frame.position,
              width: frame.width,
              depth: frame.depth,
              properties: newProperties,
            });
            continue;
          }

          const existingMovingConn = getMovingEndPipeConnection(
            info.pipeElement,
            info.movingEnd,
          );
          if (!existingMovingConn) continue;
          const lineKind =
            info.pipeElement.properties.lineKind === "liquid" ? "liquid" : "gas";

          let newBundle: RefrigerantPipeBundleConnection | null = null;
          if (movedBundles.length === 1) newBundle = movedBundles[0]!;
          if (!newBundle && unitBundle) newBundle = unitBundle;
          if (!newBundle && movedBundles.length > 0) {
            newBundle = pickClosestBundle(
              movedBundles,
              existingMovingConn.portPoint,
              (bundle) =>
                lineKind === "gas" ? bundle.gasPoint : bundle.liquidPoint,
            );
          }
          if (!newBundle) continue;

          const movedPortPoint =
            lineKind === "gas" ? newBundle.gasPoint : newBundle.liquidPoint;
          const movedDirection =
            lineKind === "gas"
              ? (newBundle.gasDirection ?? newBundle.direction)
              : (newBundle.liquidDirection ?? newBundle.direction);
          const movedElevationMm =
            lineKind === "gas"
              ? newBundle.gasElevationMm
              : newBundle.liquidElevationMm;

          const rerouteResult = reroutePipeCenterline({
            fixedPoint: fixedInfo.point,
            fixedDirection: fixedInfo.direction,
            movedPoint: movedPortPoint,
            movedDirection,
            existingRoutePoints: existingRoute,
            fixedEnd: info.fixedEnd,
            lockedPivotPoint,
          });

          const updatedMovingConnection: RefrigerantPipeConnection = {
            ...existingMovingConn,
            portPoint: movedPortPoint,
            direction: movedDirection,
            elevationMm: movedElevationMm,
            connectionKind: newBundle.connectionKind,
            sourceElementId: element.id,
          };
          const newProperties = buildReroutedSinglePipeProperties({
            existingProperties: info.pipeElement.properties,
            movingEnd: info.movingEnd,
            newRoutePoints: rerouteResult.routePoints,
            newMovingEndConnection: updatedMovingConnection,
            leadPivotPoint: rerouteResult.pivotPoint,
          });
          const frame = buildReroutedPipeElementFrame(
            info.pipeElement,
            newProperties,
            contextElements,
          );
          updateHvacElement(info.pipeElement.id, {
            position: frame.position,
            width: frame.width,
            depth: frame.depth,
            properties: newProperties,
          });
        }

        movedEquipment = true;
      }

      return movedObjects || movedEquipment;
    },
    [
      computeHvacPlacement,
      hvacElements,
      nudgeSelectedObjects,
      selectedIds,
      setProcessingStatus,
      updateHvacElement,
    ],
  );

  // Global close effect is inside useContextMenuHandlers hook.

  // Mode hooks
  const selectMode = useSelectMode({
    fabricRef,
    walls,
    rooms,
    selectedIds,
    wallSettings,
    zoom: viewportZoom,
    setSelectedIds,
    setHoveredElement,
    getWall,
    updateWall,
    updateWalls,
    updateWallBevel,
    resetWallBevel,
    getCornerBevelDots,
    moveRoom,
    connectWalls,
    selectWallSegmentWithinInterval,
    detectRooms,
    regenerateElevations,
    saveToHistory,
    setProcessingStatus,
    onDragStateChange: setIsHandleDragging,
    onRoomDragStateChange: setActiveRoomDragId,
    originOffset,
  });
  const {
    isWallHandleDraggingRef,
    getTargetMeta,
    updateSelectionFromTarget,
    updateSelectionFromTargets,
    finalizeHandleDrag,
    handleObjectMoving: handleSelectObjectMoving,
    handleDoubleClick: handleSelectDoubleClick,
    handleMouseDown: handleSelectMouseDown,
    handleMouseMove: handleSelectMouseMove,
    handleMouseUp: handleSelectMouseUp,
  } = selectMode;

  const {
    middlePanRef,
    stopMiddlePan,
    handleMiddleMouseDown,
    handleMiddleMouseMove,
    handleMiddleMouseUp,
    preventMiddleAuxClick,
  } = useMiddlePan({
    fabricRef,
    zoomRef,
    panOffsetRef,
    safePaperPerRealRatio,
    setInteractionViewTransform,
    setViewTransform,
    wheelPendingZoom,
    wheelPendingPan,
    wheelRafId,
    setCanvasState,
    canvasStateRef,
  });

  // Wall tool hook
  const {
    wallRenderer,
    handleMouseDown: handleWallMouseDown,
    handleMouseMove: handleWallMouseMove,
    handleDoubleClick: handleWallDoubleClick,
    handleKeyDown: handleWallToolKeyDown,
    handleKeyUp: handleWallToolKeyUp,
    isDrawing: isWallDrawing,
  } = useWallTool({
    fabricRef,
    canvas: fabricCanvas,
    walls,
    rooms,
    selectedIds,
    isHandleDragging,
    wallDrawingState,
    wallSettings,
    zoom: viewportZoom,
    panOffset,
    pageHeight: pageConfig.height,
    overlayCanvasRef: snapOverlayRef, // [SNAP WIRE]
    startWallDrawing,
    updateWallPreview,
    commitWall,
    cancelWallDrawing,
    connectWalls,
  });

  // Room tool hook (2-click rectangle)
  const roomTool = useRoomTool({
    gridSize: wallSettings.gridSize,
    wallThickness: wallSettings.defaultThickness,
    wallMaterial: wallSettings.defaultMaterial,
    snapPoint: (scenePoint) => {
      if (!resolvedSnapToGrid) {
        return scenePoint;
      }
      const snapResult = snapWallPoint(
        scenePoint,
        null,
        wallSettings,
        walls,
        false,
        viewportZoom,
        undefined,
      );
      return snapResult.snappedPoint;
    },
    createRoomWalls,
  });
  const {
    isDrawing: isRoomDrawing,
    startCorner: roomStartCorner,
    handleMouseDown: handleRoomMouseDown,
    handleMouseMove: handleRoomMouseMove,
    cancelRoomCreation,
  } = roomTool;

  const {
    handlePlacementMouseDown: handleDimensionPlacementMouseDown,
    handlePlacementMouseMove: handleDimensionPlacementMouseMove,
    handleSelectMouseDown: handleDimensionSelectMouseDown,
    handleSelectMouseMove: handleDimensionSelectMouseMove,
    handleSelectMouseUp: handleDimensionSelectMouseUp,
    handleDoubleClick: handleDimensionDoubleClick,
    handleKeyDown: handleDimensionKeyDown,
    cancelPlacement: cancelDimensionPlacement,
    isSelectDragActive: isDimensionSelectDragActive,
  } = useDimensionTool({
    fabricRef,
    walls,
    rooms,
    dimensions,
    dimensionSettings,
    wallSettings,
    zoom: viewportZoom,
    selectedIds,
    addDimension,
    updateDimension,
    deleteDimension,
    setSelectedIds,
    setHoveredElement,
    setProcessingStatus,
    saveToHistory,
  });

  const restackInteractiveOverlays = useCallback((canvas: fabric.Canvas) => {
    const selectModeOverlays: fabric.Object[] = [];
    const roomControlDecorations: fabric.Object[] = [];
    const roomControls: fabric.Object[] = [];
    const dimensionControlDecorations: fabric.Object[] = [];
    const dimensionControls: fabric.Object[] = [];
    const wallControlDecorations: fabric.Object[] = [];
    const wallControls: fabric.Object[] = [];
    const openingResizeHandles: fabric.Object[] = [];

    canvas.getObjects().forEach((obj) => {
      const typed = obj as fabric.Object & {
        isWallControl?: boolean;
        isWallControlDecoration?: boolean;
        isRoomControl?: boolean;
        isRoomControlDecoration?: boolean;
        isDimensionControl?: boolean;
        isDimensionControlDecoration?: boolean;
        isOpeningResizeHandle?: boolean;
        isSelectModeOverlay?: boolean;
      };

      if (typed.isSelectModeOverlay) {
        selectModeOverlays.push(obj);
        return;
      }
      if (typed.isRoomControlDecoration) {
        roomControlDecorations.push(obj);
        return;
      }
      if (typed.isRoomControl) {
        roomControls.push(obj);
        return;
      }
      if (typed.isDimensionControlDecoration) {
        dimensionControlDecorations.push(obj);
        return;
      }
      if (typed.isDimensionControl) {
        dimensionControls.push(obj);
        return;
      }
      if (typed.isWallControlDecoration) {
        wallControlDecorations.push(obj);
        return;
      }
      if (typed.isWallControl) {
        wallControls.push(obj);
        return;
      }
      if (typed.isOpeningResizeHandle) {
        openingResizeHandles.push(obj);
      }
    });

    [
      selectModeOverlays,
      roomControlDecorations,
      roomControls,
      dimensionControlDecorations,
      dimensionControls,
      wallControlDecorations,
      wallControls,
      openingResizeHandles,
    ].forEach((objects) => {
      objects.forEach((obj) => canvas.bringObjectToFront(obj));
    });
  }, []);

  // Offset tool hook
  const offsetTool = useOffsetTool({
    fabricRef,
    walls,
    selectedIds,
    zoom: viewportZoom,
    addWall,
    setSelectedIds,
    setTool,
    detectRooms,
    saveToHistory,
    setProcessingStatus,
  });

  // Trim tool hook
  const trimTool = useTrimTool({
    fabricRef,
    walls,
    updateWall,
    addWall,
    deleteWall,
    connectWalls,
    setTool,
    detectRooms,
    saveToHistory,
    setProcessingStatus,
  });

  const extendTool = useExtendTool({
    fabricRef,
    walls,
    updateWall,
    connectWalls,
    setTool,
    detectRooms,
    saveToHistory,
    setProcessingStatus,
  });

  const copySelectedWalls = useCallback(() => {
    const selectedWallIds = new Set(selectedIds);
    const selectedWalls = walls
      .filter((wall) => selectedWallIds.has(wall.id))
      .map((wall) => ({
        ...wall,
        startPoint: { ...wall.startPoint },
        endPoint: { ...wall.endPoint },
        interiorLine: {
          start: { ...wall.interiorLine.start },
          end: { ...wall.interiorLine.end },
        },
        exteriorLine: {
          start: { ...wall.exteriorLine.start },
          end: { ...wall.exteriorLine.end },
        },
        openings: wall.openings.map((opening) => ({ ...opening })),
        connectedWalls: [...wall.connectedWalls],
        startBevel: { ...wall.startBevel },
        endBevel: { ...wall.endBevel },
      }));
    if (selectedWalls.length === 0) return;
    wallClipboardRef.current = selectedWalls;
    setProcessingStatus(`Copied ${selectedWalls.length} wall(s).`, false);
  }, [selectedIds, walls, setProcessingStatus]);

  const pasteWalls = useCallback(() => {
    const copied = wallClipboardRef.current;
    if (!copied || copied.length === 0) return;

    const offset = Math.max(100, wallSettings.gridSize * 2);
    const idMap = new Map<string, string>();
    const newIds: string[] = [];

    for (const wall of copied) {
      const newId = addWall({
        startPoint: {
          x: wall.startPoint.x + offset,
          y: wall.startPoint.y + offset,
        },
        endPoint: { x: wall.endPoint.x + offset, y: wall.endPoint.y + offset },
        thickness: wall.thickness,
        material: wall.material,
        layer: wall.layer,
      });
      updateWall(
        newId,
        {
          openings: wall.openings.map((opening) => ({
            ...opening,
            id: generateId(),
          })),
          startBevel: { ...wall.startBevel },
          endBevel: { ...wall.endBevel },
        },
        { skipHistory: true, source: "ui" },
      );
      idMap.set(wall.id, newId);
      newIds.push(newId);
    }

    for (const wall of copied) {
      const sourceNewId = idMap.get(wall.id);
      if (!sourceNewId) continue;
      for (const connectedId of wall.connectedWalls) {
        const targetNewId = idMap.get(connectedId);
        if (!targetNewId || sourceNewId >= targetNewId) continue;
        connectWalls(sourceNewId, targetNewId);
      }
    }

    setSelectedIds(newIds);
    saveToHistory("Paste walls");
    setProcessingStatus(`Pasted ${newIds.length} wall(s).`, false);
  }, [
    wallSettings.gridSize,
    addWall,
    updateWall,
    connectWalls,
    setSelectedIds,
    saveToHistory,
    setProcessingStatus,
  ]);

  const handleEscapeShortcut = useCallback(() => {
    if (pendingPlacementDefinition || pendingPlacementEquipmentDefinition)
      return true;
    if ((tool === "wall" || tool === "partition-wall") && isWallDrawing)
      return true;
    if (tool === "room" && isRoomDrawing) {
      cancelRoomCreation();
      wallRenderer?.clearPreviewWall();
      return true;
    }
    if (tool === "refrigerant-pipe") {
      setTool("select");
      return true;
    }
    if (tool === "duct") {
      setTool("select");
      return true;
    }
    if (tool === "section-line" && sectionLineDrawingState.isDrawing)
      return true;
    if (selectedIds.length > 0 || persistentRoomControlId) {
      const canvas = fabricRef.current;
      if (canvas) {
        canvas.discardActiveObject();
        hideActiveSelectionChrome(canvas);
        canvas.requestRenderAll();
      }
      setSelectedIds([]);
      setHoveredElement(null);
      wallRenderer?.setHoveredWall(null);
      roomRendererRef.current?.setHoveredRoom(null);
      roomRendererRef.current?.setSelectedRooms([]);
      roomRendererRef.current?.setActiveDragRoom(null);
      roomRendererRef.current?.setPersistentControlRoom(null);
      setActiveRoomDragId(null);
      setPersistentRoomControlId(null);
      return true;
    }
    return false;
  }, [
    pendingPlacementDefinition,
    pendingPlacementEquipmentDefinition,
    tool,
    isWallDrawing,
    isRoomDrawing,
    cancelRoomCreation,
    setTool,
    sectionLineDrawingState.isDrawing,
    selectedIds.length,
    persistentRoomControlId,
    fabricRef,
    setSelectedIds,
    setHoveredElement,
    wallRenderer,
  ]);

  // Keyboard handling
  useCanvasKeyboard({
    tool,
    selectedIds,
    deleteSelected,
    setIsSpacePressed,
    setTool,
    onEscape: handleEscapeShortcut,
    onCopy: copySelectedWalls,
    onPaste: pasteWalls,
  });

  // Ensure room perimeter preview is cleared when leaving room tool.
  useEffect(() => {
    if (tool !== "room") {
      wallRenderer?.clearPreviewWall();
    }
  }, [tool, wallRenderer]);

  // ---------------------------------------------------------------------------
  // Canvas Initialization
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!canvasRef.current || !hostRef.current || !outerRef.current) return;

    const host = hostRef.current;
    const outer = outerRef.current;
    const canvas = new fabric.Canvas(canvasRef.current, {
      width: host.clientWidth,
      height: host.clientHeight,
      backgroundColor,
      selection: tool === "select",
      preserveObjectStacking: true,
      enableRetinaScaling: true,
    });
    installCanvasRenderScheduler(canvas);

    fabricRef.current = canvas;
    roomRendererRef.current = new RoomRenderer(canvas);
    dimensionRendererRef.current = new DimensionRenderer(canvas);
    objectRendererRef.current = new ObjectRenderer(canvas);
    sectionLineRendererRef.current = new SectionLineRenderer(canvas);
    hvacRendererRef.current = new HvacPlanRenderer(canvas);

    // Enable section line dragging with store update
    sectionLineRendererRef.current.setDraggable(true);
    sectionLineRendererRef.current.onMoved((id, deltaX, deltaY) => {
      const {
        sectionLines: lines,
        updateSectionLine: update,
        regenerateElevations: regen,
      } = useSmartDrawingStore.getState();
      const line = lines.find((l) => l.id === id);
      if (!line) return;
      const pxToMm = 1 / MM_TO_PX;
      update(id, {
        startPoint: {
          x: line.startPoint.x + deltaX * pxToMm,
          y: line.startPoint.y + deltaY * pxToMm,
        },
        endPoint: {
          x: line.endPoint.x + deltaX * pxToMm,
          y: line.endPoint.y + deltaY * pxToMm,
        },
      });
      regen({ debounce: true });
    });

    setFabricCanvas(canvas);
    onCanvasReady?.(canvas);
    setViewportSizeIfChanged(outer.clientWidth, outer.clientHeight);

    // [SNAP WIRE] Size overlay canvas to match fabric canvas
    if (snapOverlayRef.current) {
      snapOverlayRef.current.width = host.clientWidth;
      snapOverlayRef.current.height = host.clientHeight;
    }

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (entry.target === host) {
          const nextWidth = Math.max(1, Math.floor(width));
          const nextHeight = Math.max(1, Math.floor(height));
          if (nextWidth <= 2 || nextHeight <= 2) {
            continue;
          }
          canvas.setDimensions({ width: nextWidth, height: nextHeight });
          canvas.renderAll();
          // [SNAP WIRE] Keep overlay in sync
          if (snapOverlayRef.current) {
            snapOverlayRef.current.width = nextWidth;
            snapOverlayRef.current.height = nextHeight;
          }
        }
        if (entry.target === outer) {
          setViewportSizeIfChanged(width, height);
        }
      }
    });
    resizeObserver.observe(host);
    resizeObserver.observe(outer);

    return () => {
      roomRendererRef.current?.dispose();
      roomRendererRef.current = null;
      dimensionRendererRef.current?.dispose();
      dimensionRendererRef.current = null;
      objectRendererRef.current?.dispose();
      objectRendererRef.current = null;
      sectionLineRendererRef.current?.dispose();
      sectionLineRendererRef.current = null;
      hvacRendererRef.current?.dispose();
      hvacRendererRef.current = null;
      resizeObserver.disconnect();
      restoreCanvasRenderScheduler(canvas);
      canvas.dispose();
      fabricRef.current = null;
      setFabricCanvas(null);
    };
  }, [onCanvasReady, setViewportSizeIfChanged]);

  // Recover from transient layout glitches (tab restore/focus/resize) that can
  // leave Fabric canvas dimensions stale after heavy frame drops.
  useEffect(() => {
    const canvas = fabricRef.current;
    const outer = outerRef.current;
    if (!canvas || !outer) return;

    const syncCanvasDimensions = () => {
      const outerWidth = Math.max(1, Math.floor(outer.clientWidth));
      const outerHeight = Math.max(1, Math.floor(outer.clientHeight));
      setViewportSizeIfChanged(outerWidth, outerHeight);

      const targetWidth = Math.max(1, outerWidth - originOffset.x);
      const targetHeight = Math.max(1, outerHeight - originOffset.y);
      if (targetWidth <= 2 || targetHeight <= 2) {
        return;
      }

      const currentWidth = Math.round(canvas.getWidth());
      const currentHeight = Math.round(canvas.getHeight());
      if (
        Math.abs(currentWidth - targetWidth) > 1 ||
        Math.abs(currentHeight - targetHeight) > 1
      ) {
        canvas.setDimensions({ width: targetWidth, height: targetHeight });
        if (snapOverlayRef.current) {
          snapOverlayRef.current.width = targetWidth;
          snapOverlayRef.current.height = targetHeight;
        }
        canvas.requestRenderAll();
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) return;
      window.requestAnimationFrame(syncCanvasDimensions);
    };

    syncCanvasDimensions();
    window.addEventListener("resize", syncCanvasDimensions);
    window.addEventListener("focus", syncCanvasDimensions);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("resize", syncCanvasDimensions);
      window.removeEventListener("focus", syncCanvasDimensions);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fabricCanvas, originOffset.x, originOffset.y, setViewportSizeIfChanged]);

  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    canvas.set("backgroundColor", backgroundColor);
    canvas.renderAll();
  }, [backgroundColor]);

  // ---------------------------------------------------------------------------
  // Renderer Synchronisation
  // ---------------------------------------------------------------------------

  const { scheduleDimensionLayerRefresh } = useRendererSync({
    fabricRef,
    roomRendererRef,
    dimensionRendererRef,
    objectRendererRef,
    sectionLineRendererRef,
    hvacRendererRef,
    wallsRef,
    symbolsRef,
    dimensionRefreshFrameRef,
    autoDimensionSyncFrameRef,
    wheelRafId,
    zoomRef,
    panOffsetRef,
    mousePositionRef,
    placementCursorRef,
    openingResizeHandlesRef,
    openingPointerInteractionRef,
    canvasStateRef,
    marqueeSelectionRef,
    lastMarqueeSelectionRef,
    applyMarqueeFilterRef,
    wallRenderer,
    fabricCanvas,
    tool,
    viewportZoom,
    panOffset,
    walls,
    rooms,
    symbols,
    dimensions,
    dimensionSettings,
    wallSettings,
    wallDrawingState,
    sectionLines,
    sectionLineDrawingState,
    hvacElements,
    selectedIds,
    hoveredElementId,
    wallIdSet,
    objectDefinitions,
    objectDefinitionsById: objectDefinitionsById as Map<
      string,
      ArchitecturalObjectDefinition
    >,
    doorWindowSymbolsSignature,
    isSpacePressed,
    canvasState,
    isHandleDragging,
    activeRoomDragId,
    persistentRoomControlId,
    openingInteractionActive,
    pendingPlacementDefinition,
    pendingPlacementEquipmentDefinition,
    placementRotationDeg,
    setPlacementRotationDeg,
    setPlacementValid,
    setOpeningInteractionActive,
    setActiveRoomDragId,
    setPersistentRoomControlId,
    restackInteractiveOverlays,
    cancelDimensionPlacement,
    syncAutoDimensions,
    updateWall,
    updateSymbol,
    clearOpeningResizeHandles,
    buildHostedOpeningSymbolProperties,
    fitOpeningToWall,
    resolveOpeningSillHeightMm,
    computePlacement,
    buildOpeningPreviewProperties,
    computeHvacPlacement,
    offsetTool,
    trimTool,
    extendTool,
  });

  // ---------------------------------------------------------------------------
  // Mouse Event Handlers
  // ---------------------------------------------------------------------------

  const { handleMouseDown, handleMouseMove, handleMouseUp, handleWheel } =
    useCanvasMouseHandlers({
      fabricRef,
      canvasStateRef,
      zoomRef,
      panOffsetRef,
      mousePositionRef,
      placementCursorRef,
      middlePanRef,
      marqueeSelectionRef,
      lastMarqueeSelectionRef,
      applyMarqueeFilterRef,
      isDraggingObjectRef,
      isWallHandleDraggingRef,
      openingPointerInteractionRef,
      wheelPendingZoom,
      wheelPendingPan,
      wheelRafId,
      roomRendererRef,
      dimensionRendererRef,
      objectRendererRef,
      hvacRendererRef,
      tool,
      resolvedSnapToGrid,
      effectiveSnapGridSize,
      isSpacePressed,
      pendingPlacementDefinition,
      pendingPlacementEquipmentDefinition,
      isWallDrawing,
      isRoomDrawing,
      roomStartCorner,
      viewportZoom,
      safePaperPerRealRatio,
      walls,
      wallSettings,
      sectionLineDrawingState,
      queueMousePositionUpdate,
      closeWallContextMenu,
      closeDimensionContextMenu,
      closeSectionLineContextMenu,
      closeObjectContextMenu,
      placePendingObject,
      placePendingHvacElement,
      handleWallMouseDown,
      handleWallMouseMove,
      handleRoomMouseDown,
      handleRoomMouseMove,
      handleDimensionPlacementMouseDown,
      handleDimensionPlacementMouseMove,
      handleDimensionSelectMouseMove,
      isDimensionSelectDragActive,
      handleDimensionSelectMouseUp,
      handleDuctMouseDown,
      handleDuctMouseMove,
      handleRefrigerantPipeMouseDown,
      handleRefrigerantPipeMouseMove,
      handleSelectMouseMove,
      handleSelectMouseUp,
      findOpeningAtPoint,
      updateOpeningPointerInteraction,
      finishOpeningPointerInteraction,
      computePlacement,
      computeHvacPlacement,
      buildOpeningPreviewProperties,
      scheduleDimensionLayerRefresh,
      setViewTransform,
      setInteractionViewTransform,
      setCanvasState,
      setPlacementValid,
      setHoveredElement,
      setMarqueeSelectionMode,
      addSketch,
      getSelectionRect,
      getTargetMeta,
      resolveObjectIdFromTarget,
      resolveHvacIdFromTarget,
      resolveRoomIdFromTarget,
      resolveSectionLineIdFromTarget,
      startSectionLineDrawing,
      updateSectionLinePreview,
      commitSectionLine,
      wallRenderer,
      offsetTool,
      trimTool,
      extendTool,
    });

  // ---------------------------------------------------------------------------
  // Event Binding
  // ---------------------------------------------------------------------------

  useCanvasEventBinding({
    // Refs
    fabricRef,
    outerRef,
    wheelRafId,
    marqueeSelectionRef,
    lastMarqueeSelectionRef,
    applyMarqueeFilterRef,
    openingPointerInteractionRef,
    suppressFabricSelectionSyncRef,
    isWallHandleDraggingRef,
    isDraggingObjectRef,
    placementCursorRef,
    objectRendererRef,
    hvacRendererRef,
    roomRendererRef,
    // State values
    tool,
    selectedIds,
    symbols,
    hvacElements,
    walls,
    objectDefinitionsById: objectDefinitionsById as Map<
      string,
      ArchitecturalObjectDefinition
    >,
    resolvedSnapToGrid,
    effectiveSnapGridSize,
    pendingPlacementDefinition,
    pendingPlacementEquipmentDefinition,
    sectionLineDrawingState,
    wallById,
    roomById,
    wallIdSet,
    perimeterWallIdsForRooms,
    roomBoundaryDistance,
    projectPointToSegment,
    selectWallSegmentAtPoint,
    resolveRoomPerimeterWallSegments,
    // Canvas mouse handlers
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleWheel,
    // Middle-pan handlers
    stopMiddlePan,
    handleMiddleMouseDown,
    handleMiddleMouseMove,
    handleMiddleMouseUp,
    preventMiddleAuxClick,
    // Select-mode handlers
    handleSelectDoubleClick: handleSelectDoubleClick,
    updateSelectionFromTarget,
    updateSelectionFromTargets,
    handleSelectMouseDown: (
      target: fabric.Object | null | undefined,
      wallPointMm: Point2D,
      _addToSelection: boolean,
    ) => {
      // Adapter: the original event binding calls handleSelectMouseDown from useSelectMode
      // which has a different signature than our mouse handlers version
      handleSelectMouseDown(target as fabric.Object | null, wallPointMm);
    },
    handleSelectObjectMoving: handleSelectObjectMoving,
    finalizeHandleDrag,
    handleSelectMouseMove,
    // Target resolvers
    resolveWallIdFromTarget: resolveWallIdFromTarget as (
      target: fabric.Object | null | undefined,
    ) => string | null,
    resolveDimensionIdFromTarget: resolveDimensionIdFromTarget as (
      target: fabric.Object | null | undefined,
    ) => string | null,
    resolveSectionLineIdFromTarget,
    resolveRoomIdFromTarget,
    resolveObjectIdFromTarget,
    resolveHvacIdFromTarget,
    resolveOpeningIdFromTarget,
    resolveOpeningResizeHandleFromTarget,
    findOpeningAtPoint,
    filterMarqueeSelectionTargets,
    getTargetMeta,
    // Wall tool handlers
    handleWallDoubleClick,
    handleWallToolKeyDown,
    handleWallToolKeyUp,
    handleDuctDoubleClick,
    handleDuctKeyDown,
    handleDuctKeyUp,
    handleRefrigerantPipeDoubleClick,
    handleRefrigerantPipeKeyDown,
    handleRefrigerantPipeKeyUp,
    // Dimension tool handlers
    handleDimensionDoubleClick,
    handleDimensionKeyDown,
    handleDimensionSelectMouseDown,
    // Tool hooks
    offsetTool,
    trimTool,
    extendTool,
    // Opening placement
    computePlacement,
    syncOpeningForSymbol,
    buildHostedOpeningSymbolProperties,
    computeHvacPlacement,
    resolveOpeningWidthMm,
    resolveOpeningHeightMm,
    resolveOpeningSillHeightMm,
    hasFurnitureCollision,
    // Opening interaction
    beginOpeningPointerInteraction,
    finishOpeningPointerInteraction,
    // Context menus
    closeWallContextMenu,
    closeDimensionContextMenu,
    closeSectionLineContextMenu,
    closeObjectContextMenu,
    // Store actions
    setSelectedIds,
    setHoveredElement,
    setTool,
    setProcessingStatus,
    updateSymbol,
    updateHvacElement,
    placePendingObject,
    placePendingHvacElement,
    onCancelObjectPlacement,
    onCancelEquipmentPlacement,
    // Local state setters
    setOpeningInteractionActive,
    setMarqueeSelectionMode,
    setPersistentRoomControlId,
    setPlacementRotationDeg,
    setWallContextMenu,
    setDimensionContextMenu,
    setSectionLineContextMenu,
    setObjectContextMenu,
    // Section-line actions
    cancelSectionLineDrawing,
    commitSectionLine,
    setSectionLineDirection,
    // Nudge
    nudgeSelectedObjects: nudgeSelectedEntities,
    // Wall renderer
    wallRenderer,
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      ref={outerRef}
      className={`relative w-full h-full overflow-hidden ${className}`}
    >
      <div
        ref={hostRef}
        className="absolute"
        style={{
          top: originOffset.y,
          left: originOffset.x,
          width: hostWidth,
          height: hostHeight,
          overflow: "hidden",
        }}
      >
        <PageLayout
          pageWidth={pageConfig.width}
          pageHeight={pageConfig.height}
          zoom={zoom}
          panOffset={overlayPanOffset}
        />
        <Grid
          pageWidth={pageConfig.width}
          pageHeight={pageConfig.height}
          zoom={zoom}
          panOffset={overlayPanOffset}
          gridSize={resolvedGridSize}
          showGrid={resolvedShowGrid}
          viewportWidth={hostWidth}
          viewportHeight={hostHeight}
          gridMode={gridMode}
          paperUnit={paperUnit}
          realWorldUnit={resolvedRealWorldUnit}
          scaleDrawing={safeScaleDrawing}
          scaleReal={safeScaleReal}
          majorGridSize={majorGridSize}
          gridSubdivisions={safeGridSubdivisions}
        />
        <canvas ref={canvasRef} className="relative z-[2] block" />
        {/* [SNAP WIRE] Overlay canvas for snap indicators — sits on top, pointer-events: none */}
        <canvas
          ref={snapOverlayRef}
          className="absolute left-0 top-0 z-[10] block"
          style={{ pointerEvents: "none" }}
        />
      </div>

      {wallContextMenu && (
        <div
          className="absolute z-[30] min-w-[190px] rounded-md border border-slate-200 bg-white shadow-lg py-1"
          style={{ left: wallContextMenu.x, top: wallContextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={handleEditWallProperties}
            className="w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
          >
            Edit Properties
          </button>
          <button
            type="button"
            onClick={handleDeleteWallFromContext}
            className="w-full px-3 py-2 text-left text-sm text-rose-700 hover:bg-rose-50"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={handleConvertWallToDoorOpening}
            className="w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
          >
            Convert to Door Opening
          </button>
        </div>
      )}

      {dimensionContextMenu && (
        <div
          className="absolute z-[30] min-w-[190px] rounded-md border border-slate-200 bg-white shadow-lg py-1"
          style={{ left: dimensionContextMenu.x, top: dimensionContextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={handleEditDimensionProperties}
            className="w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
          >
            Properties
          </button>
          <button
            type="button"
            onClick={handleDeleteDimensionFromContext}
            className="w-full px-3 py-2 text-left text-sm text-rose-700 hover:bg-rose-50"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={handleToggleDimensionVisibility}
            className="w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
          >
            Toggle Display
          </button>
        </div>
      )}

      {sectionLineContextMenu && (
        <div
          className="absolute z-[30] min-w-[210px] rounded-md border border-slate-200 bg-white shadow-lg py-1"
          style={{
            left: sectionLineContextMenu.x,
            top: sectionLineContextMenu.y,
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={handleGenerateElevationFromSection}
            className="w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
          >
            Generate Elevation
          </button>
          <button
            type="button"
            onClick={handleFlipSectionLineDirection}
            className="w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
          >
            Flip View Direction
          </button>
          <button
            type="button"
            onClick={handleToggleSectionLineLock}
            className="w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
          >
            Toggle Lock
          </button>
          <button
            type="button"
            onClick={handleDeleteSectionLineFromContext}
            className="w-full px-3 py-2 text-left text-sm text-rose-700 hover:bg-rose-50"
          >
            Delete
          </button>
        </div>
      )}

      {objectContextMenu && (
        <div
          className="absolute z-[30] min-w-[190px] rounded-md border border-slate-200 bg-white shadow-lg py-1"
          style={{ left: objectContextMenu.x, top: objectContextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={handleEditObjectProperties}
            className="w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
          >
            Edit Properties
          </button>
          {isContextDoorObject && (
            <button
              type="button"
              onClick={handleFlipDoorSwing}
              className="w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
            >
              Flip Swing
            </button>
          )}
          <button
            type="button"
            onClick={handleDeleteObjectFromContext}
            className="w-full px-3 py-2 text-left text-sm text-rose-700 hover:bg-rose-50"
          >
            Delete
          </button>
        </div>
      )}

      {(pendingPlacementDefinition || pendingPlacementEquipmentDefinition) &&
        !placementValid && (
          <div className="absolute left-4 top-4 z-[25] rounded border border-rose-200 bg-rose-50 px-3 py-1 text-xs text-rose-700">
            {pendingPlacementEquipmentDefinition
              ? pendingPlacementEquipmentDefinition.placementMode === "outdoor"
                ? "Placement blocked: outdoor equipment must stay outside enclosed rooms."
                : pendingPlacementEquipmentDefinition.placementMode === "wall"
                  ? "Placement blocked: equipment must align to a valid room wall."
                  : "Placement blocked: equipment must be placed inside a valid room."
              : pendingPlacementDefinition &&
                  (pendingPlacementDefinition.category === "doors" ||
                    pendingPlacementDefinition.category === "windows")
                ? "Placement blocked: opening does not fit or overlaps an existing opening."
                : "Placement blocked: furniture overlap detected."}
          </div>
        )}

      <Rulers
        pageWidth={pageConfig.width}
        pageHeight={pageConfig.height}
        zoom={zoom}
        panOffset={overlayPanOffset}
        viewportWidth={hostWidth}
        viewportHeight={hostHeight}
        showRulers={resolvedShowRulers}
        rulerSize={rulerSize}
        originOffset={originOffset}
        gridSize={resolvedGridSize}
        displayUnit={resolvedRealWorldUnit}
        mousePosition={rulerMousePosition}
        rulerMode={rulerMode}
        paperUnit={paperUnit}
        realWorldUnit={resolvedRealWorldUnit}
        scaleDrawing={safeScaleDrawing}
        scaleReal={safeScaleReal}
        majorTickInterval={majorTickInterval}
        tickSubdivisions={tickSubdivisions}
        showRulerLabels={showRulerLabels}
      />
    </div>
  );
}

export default DrawingCanvas;
