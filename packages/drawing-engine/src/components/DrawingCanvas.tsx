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
import type { HvacElement, Point2D, SymbolInstance2D, Wall } from "../types";
import { generateId } from "../utils/geometry";

import {
  hideActiveSelectionChrome,
  type DrawingCanvasProps,
  type CanvasState,
  type MarqueeSelectionState,
  type OpeningPointerInteraction,
} from "./DrawingCanvas.types";
import {
  snapWallPoint,
  snapPointToGrid,
  MM_TO_PX,
  PX_TO_MM,
  toMillimeters,
  formatDistance,
  BoardCursorHud,
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
import { PipeBranchKitProposalCard } from "./canvas/hvac/PipeBranchKitProposalCard";
import { PipeClashOverlay } from "./canvas/hvac/PipeClashOverlay";
import { PipeKonvaInteractionLayer } from "./canvas/hvac/PipeKonvaInteractionLayer";
import {
  PipeStudioOverlay,
  type PipeStudioOverlayHandle,
} from "./canvas/hvac/PipeStudioOverlay";
import {
  isRefrigerantPipeElementType,
  resolveRefrigerantPipeUnitPortReconnectionUpdates,
  translateRefrigerantPipeElementProperties,
  type RefrigerantPipeBundleConnection,
  type RefrigerantPipeLineMode,
} from "./canvas/hvac/refrigerantPipePairModel";
import {
  HybridProjectionLayer,
  type Hybrid3DViewState,
} from "./canvas/hybrid/HybridProjectionLayer";
import {
  BoardGrid,
  BoardRulers,
  cycleBoardUnit,
  type BoardUnit,
} from "./canvas/board";
import {
  installCanvasRenderScheduler,
  restoreCanvasRenderScheduler,
} from "./canvas/renderScheduler";
export type { DrawingCanvasProps } from "./DrawingCanvas.types";

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const DEFAULT_HYBRID_VIEW: Hybrid3DViewState = {
  blend: 0,
  yawDeg: -42,
  pitchDeg: 58,
  targetMm: { x: 0, y: 0 },
  distanceMm: 8000,
  perspectiveStrength: 0.72,
  isInteracting: false,
};

type HybridAnchorScreen = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Vector3Like = {
  x: number;
  y: number;
  z: number;
};

function dot3(first: Vector3Like, second: Vector3Like): number {
  return first.x * second.x + first.y * second.y + first.z * second.z;
}

function normalize3(vector: Vector3Like): Vector3Like {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function getHybridCameraBasis(view: Hybrid3DViewState) {
  const yaw = (view.yawDeg * Math.PI) / 180;
  const pitch = (clampNumber(view.pitchDeg, 18, 82) * Math.PI) / 180;
  const horizontal = Math.cos(pitch);
  const direction = normalize3({
    x: Math.cos(yaw) * horizontal,
    y: Math.sin(yaw) * horizontal,
    z: Math.sin(pitch),
  });
  const lookDirection = {
    x: -direction.x,
    y: -direction.y,
    z: -direction.z,
  };
  const right = normalize3({
    x: -Math.sin(yaw),
    y: Math.cos(yaw),
    z: 0,
  });
  const up = normalize3({
    x: right.y * lookDirection.z - right.z * lookDirection.y,
    y: right.z * lookDirection.x - right.x * lookDirection.z,
    z: right.x * lookDirection.y - right.y * lookDirection.x,
  });

  return { direction, lookDirection, right, up };
}

function projectHybridPointToScreen(
  view: Hybrid3DViewState,
  pointMm: Point2D,
  screen: HybridAnchorScreen,
) {
  const basis = getHybridCameraBasis(view);
  const distance = clampNumber(view.distanceMm, 800, 220000);
  const target = { x: view.targetMm.x, y: view.targetMm.y, z: 220 };
  const camera = {
    x: target.x + basis.direction.x * distance,
    y: target.y + basis.direction.y * distance,
    z: target.z + basis.direction.z * distance,
  };
  const point = { x: pointMm.x, y: pointMm.y, z: 0 };
  const relative = {
    x: point.x - camera.x,
    y: point.y - camera.y,
    z: point.z - camera.z,
  };
  const depth = Math.max(1, dot3(relative, basis.lookDirection));
  const fovDeg = 30 + clampNumber(view.perspectiveStrength, 0, 1) * 14;
  const tanHalfFov = Math.tan((fovDeg * Math.PI) / 360);
  const aspect = Math.max(0.01, screen.width / Math.max(1, screen.height));
  const ndcX = dot3(relative, basis.right) / (depth * tanHalfFov * aspect);
  const ndcY = dot3(relative, basis.up) / (depth * tanHalfFov);

  return {
    x: ((ndcX + 1) / 2) * screen.width,
    y: ((1 - ndcY) / 2) * screen.height,
    depth,
    basis,
    tanHalfFov,
    aspect,
  };
}

function stabilizeHybridAnchor(
  candidate: Hybrid3DViewState,
  anchorPointMm: Point2D,
  anchorScreen: HybridAnchorScreen,
): Hybrid3DViewState {
  let next = candidate;

  for (let index = 0; index < 3; index += 1) {
    const projected = projectHybridPointToScreen(
      next,
      anchorPointMm,
      anchorScreen,
    );
    const deltaX = projected.x - anchorScreen.x;
    const deltaY = projected.y - anchorScreen.y;
    if (Math.hypot(deltaX, deltaY) < 0.35) {
      break;
    }

    const verticalSpan = 2 * projected.tanHalfFov * projected.depth;
    const horizontalSpan = verticalSpan * projected.aspect;
    const rightOffset = (deltaX / Math.max(1, anchorScreen.width)) * horizontalSpan;
    const upOffset = (-deltaY / Math.max(1, anchorScreen.height)) * verticalSpan;
    next = {
      ...next,
      targetMm: {
        x:
          next.targetMm.x +
          projected.basis.right.x * rightOffset +
          projected.basis.up.x * upOffset,
        y:
          next.targetMm.y +
          projected.basis.right.y * rightOffset +
          projected.basis.up.y * upOffset,
      },
    };
  }

  return next;
}

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
  const hybridBlendFrameRef = useRef<number | null>(null);
  const hybridDragRef = useRef<{
    active: boolean;
    startClientX: number;
    startClientY: number;
    startView: Hybrid3DViewState;
    anchorPointMm: Point2D;
    anchorScreen: HybridAnchorScreen;
  } | null>(null);

  // Drag interaction state
  const isDraggingObjectRef = useRef(false);

  // State
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [fabricCanvas, setFabricCanvas] = useState<fabric.Canvas | null>(null);
  const [placementRotationDeg, setPlacementRotationDeg] = useState(0);
  const [placementValid, setPlacementValid] = useState(true);
  // Board rulers' active display unit (cycles mm → cm → m via the corner box).
  const [boardUnit, setBoardUnit] = useState<BoardUnit>("mm");
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
  const [hybridView, setHybridView] =
    useState<Hybrid3DViewState>(DEFAULT_HYBRID_VIEW);
  const hybridViewRef = useRef<Hybrid3DViewState>(DEFAULT_HYBRID_VIEW);
  const hybridViewOnly = hybridView.blend > 0.05;

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
    refrigerantPipeDrawMode,
    refrigerantPipeAngleMode,
    refrigerantPipeLineMode,
    zoom: documentZoom,
    panOffset: documentPanOffset,
    displayUnit,
    selectedElementIds: selectedIds,
    dimensions,
    dimensionSettings: storeDimensionSettings,
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
    wallSettings: storeWallSettings,
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
    resetViewRequestId,
    addHvacElement,
    addHvacElements,
    updateHvacElement,
    deleteHvacElement,
    syncAutoDimensions,
    selectWallSegmentAtPoint,
    selectWallSegmentWithinInterval,
    resolveRoomPerimeterWallSegments,
  } = useSmartDrawingStore(
    (state) => ({
      activeTool: state.activeTool,
      refrigerantPipeDrawMode: state.refrigerantPipeDrawMode,
      refrigerantPipeAngleMode: state.refrigerantPipeAngleMode,
      refrigerantPipeLineMode: state.refrigerantPipeLineMode,
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
      resetViewRequestId: state.resetViewRequestId,
      addHvacElement: state.addHvacElement,
      addHvacElements: state.addHvacElements,
      updateHvacElement: state.updateHvacElement,
      deleteHvacElement: state.deleteHvacElement,
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
  const projectionViewOnly = hybridViewOnly;
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
  // The same step expressed in real millimetres — the space wall/room/dimension
  // tools snap in.
  const snapStepMm = effectiveSnapGridSize * PX_TO_MM;
  // Bind every tool's grid step to the board's visible sub-grid (and the
  // ribbon snap toggle) so previews and commits land where the grid says they
  // will, at any unit, scale or grid density. `wallSettings.gridSize` remains
  // in documents for backward compatibility but no longer drives snapping.
  const wallSettings = useMemo(
    () => ({
      ...storeWallSettings,
      gridSize: snapStepMm,
      snapToGrid: resolvedSnapToGrid,
    }),
    [storeWallSettings, snapStepMm, resolvedSnapToGrid],
  );
  // Dimension labels follow the assigned display unit when the format is
  // 'auto' (mm/cm → mm, m → m, ft-in → ft-in) so measurements read the same
  // on rulers, dimensions and the coordinate readout.
  const dimensionSettings = useMemo(
    () => ({
      ...storeDimensionSettings,
      preferredUnit:
        displayUnit === "m"
          ? ("m" as const)
          : displayUnit === "ft-in"
            ? ("ft-in" as const)
            : ("mm" as const),
    }),
    [storeDimensionSettings, displayUnit],
  );
  // While a drawing tool is active with snapping on, the ruler cursor lines
  // and the HUD track the grid-snapped point — where the vertex will actually
  // land — instead of the raw mouse position.
  const drawingToolActive =
    tool === "wall" ||
    tool === "partition-wall" ||
    tool === "room" ||
    tool === "dimension" ||
    tool === "refrigerant-pipe" ||
    tool === "duct";
  const cursorSnapActive =
    resolvedSnapToGrid && drawingToolActive && !projectionViewOnly;
  const displayMousePosition = useMemo(
    () =>
      cursorSnapActive
        ? snapPointToGrid(mousePosition, effectiveSnapGridSize)
        : mousePosition,
    [cursorSnapActive, mousePosition, effectiveSnapGridSize],
  );
  const rulerMousePosition = useMemo(
    () => ({
      x: displayMousePosition.x * safePaperPerRealRatio,
      y: displayMousePosition.y * safePaperPerRealRatio,
    }),
    [displayMousePosition, safePaperPerRealRatio],
  );
  const boardFormatLength = useCallback(
    (mm: number) => formatDistance(mm, displayUnit),
    [displayUnit],
  );
  const rulerSize = 24;
  const leftRulerWidth = Math.round(rulerSize * 1.2);
  const originOffset = resolvedShowRulers
    ? { x: leftRulerWidth, y: rulerSize }
    : { x: 0, y: 0 };
  const hostWidth = Math.max(1, viewportSize.width - originOffset.x);
  const hostHeight = Math.max(1, viewportSize.height - originOffset.y);
  const hybridDrawingBounds = useMemo(() => {
    const points: Point2D[] = [];
    rooms.forEach((room) => {
      points.push(...room.vertices);
      room.holes?.forEach((hole) => points.push(...hole));
    });
    walls.forEach((wall) => {
      points.push(wall.startPoint, wall.endPoint);
    });
    hvacElements.forEach((element) => {
      points.push(
        element.position,
        { x: element.position.x + element.width, y: element.position.y },
        {
          x: element.position.x + element.width,
          y: element.position.y + element.depth,
        },
        { x: element.position.x, y: element.position.y + element.depth },
      );
    });
    symbols.forEach((symbol) => points.push(symbol.position));

    if (points.length === 0) {
      return {
        center: { x: pageConfig.width / 2, y: pageConfig.height / 2 },
        radius: Math.max(pageConfig.width, pageConfig.height) / 2,
      };
    }

    const bounds = points.reduce(
      (acc, point) => ({
        minX: Math.min(acc.minX, point.x),
        minY: Math.min(acc.minY, point.y),
        maxX: Math.max(acc.maxX, point.x),
        maxY: Math.max(acc.maxY, point.y),
      }),
      {
        minX: Number.POSITIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      },
    );
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    return {
      center: {
        x: bounds.minX + width / 2,
        y: bounds.minY + height / 2,
      },
      radius: Math.max(width, height, Math.hypot(width, height) / 2),
    };
  }, [hvacElements, pageConfig.height, pageConfig.width, rooms, symbols, walls]);
  // The flat plan cross-dissolves *in place* into the tilting 3D scene, which
  // owns the tilt entirely (fixed-pivot camera orbit + its own ground grid, see
  // HybridProjectionLayer). No DOM translate/scale/rotate — those used to slide
  // and shrink the whole plane. Fades out by blend 0.18 so the 3D view reads.
  const planLayerOpacity = clampNumber(1 - hybridView.blend / 0.18, 0, 1);
  const projectionPlaneStyle = useMemo(
    () => ({
      opacity: planLayerOpacity,
      transition: hybridView.isInteracting ? "none" : "opacity 120ms linear",
      willChange: "opacity" as const,
    }),
    [planLayerOpacity, hybridView.isInteracting],
  );

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
  const konvaPipeEditorEnabled = useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      return window.localStorage.getItem("hvac.pipe.engine") === "konva";
    } catch {
      return false;
    }
  }, []);
  const selectedRefrigerantPipeCount = useMemo(() => {
    const selectedSet = new Set(selectedIds);
    return hvacElements.reduce((count, element) => {
      if (!selectedSet.has(element.id)) {
        return count;
      }
      return element.type === "refrigerant-pipe" ? count + 1 : count;
    }, 0);
  }, [hvacElements, selectedIds]);
  const konvaPipeOverlayActive =
    konvaPipeEditorEnabled &&
    tool === "select" &&
    selectedRefrigerantPipeCount > 0;
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

  useEffect(() => {
    hybridViewRef.current = hybridView;
  }, [hybridView]);

  const commitHybridView = useCallback(
    (
      updater:
        | Hybrid3DViewState
        | ((previous: Hybrid3DViewState) => Hybrid3DViewState),
    ) => {
      setHybridView((previous) => {
        const next =
          typeof updater === "function" ? updater(previous) : updater;
        hybridViewRef.current = next;
        return next;
      });
    },
    [],
  );

  const animateHybridBlend = useCallback(
    (targetBlend: number) => {
      const target = clampNumber(targetBlend, 0, 1);
      if (typeof window === "undefined") {
        commitHybridView((previous) => ({
          ...previous,
          blend: target,
          isInteracting: target > 0 ? previous.isInteracting : false,
        }));
        return;
      }

      if (hybridBlendFrameRef.current !== null) {
        window.cancelAnimationFrame(hybridBlendFrameRef.current);
        hybridBlendFrameRef.current = null;
      }

      const startBlend = hybridViewRef.current.blend;
      const startedAt = performance.now();
      const durationMs = target > startBlend ? 140 : 110;
      const step = (timestamp: number) => {
        const rawProgress = clampNumber(
          (timestamp - startedAt) / durationMs,
          0,
          1,
        );
        const easedProgress = 1 - Math.pow(1 - rawProgress, 3);
        const nextBlend =
          startBlend + (target - startBlend) * easedProgress;
        commitHybridView((previous) => ({
          ...previous,
          blend: nextBlend,
          isInteracting:
            target > 0 ? previous.isInteracting : rawProgress < 1,
        }));
        if (rawProgress < 1) {
          hybridBlendFrameRef.current = window.requestAnimationFrame(step);
          return;
        }
        hybridBlendFrameRef.current = null;
        commitHybridView((previous) => ({
          ...previous,
          blend: target,
          isInteracting: target > 0 ? previous.isInteracting : false,
        }));
      };

      hybridBlendFrameRef.current = window.requestAnimationFrame(step);
    },
    [commitHybridView],
  );

  const resetHybridView = useCallback(() => {
    hybridDragRef.current = null;
    commitHybridView((previous) => ({
      ...previous,
      isInteracting: false,
    }));
    animateHybridBlend(0);
  }, [animateHybridBlend, commitHybridView]);

  useEffect(() => {
    if (resetViewRequestId > 0) {
      resetHybridView();
    }
  }, [resetHybridView, resetViewRequestId]);

  useEffect(() => {
    if (hybridViewRef.current.blend > 0.001) {
      return;
    }
    commitHybridView((previous) => ({
      ...previous,
      targetMm: hybridDrawingBounds.center,
      distanceMm: Math.max(2500, hybridDrawingBounds.radius * 2.6),
    }));
  }, [commitHybridView, hybridDrawingBounds.center, hybridDrawingBounds.radius]);

  const handleHybridWebglUnavailable = useCallback(() => {
    resetHybridView();
  }, [resetHybridView]);

  useEffect(() => {
    const canvas = fabricRef.current;
    const upperCanvasEl = canvas?.upperCanvasEl;
    if (!canvas || !upperCanvasEl) {
      return;
    }

    const closeAllContextMenus = () => {
      closeWallContextMenu();
      closeDimensionContextMenu();
      closeSectionLineContextMenu();
      closeObjectContextMenu();
    };

    const scenePointFromEvent = (event: MouseEvent): Point2D => {
      const scenePoint = canvas.getScenePoint(
        event as unknown as fabric.TPointerEvent,
      );
      return {
        x: scenePoint.x / MM_TO_PX,
        y: scenePoint.y / MM_TO_PX,
      };
    };

    const stopPlainRmbEvent = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    // Plan⇄tilt magnetics (SPEC §10): releasing near flat settles the plane back
    // to exact 2D; otherwise it stays at the tilt the drag left it.
    const finishHybridDrag = () => {
      if (!hybridDragRef.current?.active) {
        return;
      }
      hybridDragRef.current = null;
      if (hybridViewRef.current.blend < 0.06) {
        animateHybridBlend(0);
      }
      commitHybridView((previous) => ({
        ...previous,
        isInteracting: false,
      }));
    };

    const engageFraming = (current: Hybrid3DViewState) => {
      if (current.blend > 0.05) {
        return { targetMm: current.targetMm, distanceMm: current.distanceMm };
      }
      // Pivot the tilt around whatever is at the viewport centre, at a distance
      // whose apparent scale matches the 2D board — so the 3D view starts exactly
      // where the flat plan is (no jump to origin, no blank at high zoom).
      const pivotMm = {
        x: (hostWidth / 2 / viewportZoom + panOffset.x) / MM_TO_PX,
        y: (hostHeight / 2 / viewportZoom + panOffset.y) / MM_TO_PX,
      };
      const fovDeg = 30 + 0.32 * 14; // start pose perspectiveStrength ≈ 0.32
      const tanHalfFov = Math.tan((fovDeg * Math.PI) / 360);
      const distanceMm = clampNumber(
        hostHeight / (2 * tanHalfFov * viewportZoom * MM_TO_PX),
        800,
        220000,
      );
      return { targetMm: pivotMm, distanceMm };
    };

    // Right-drag grabs the *same* plane and tilts it into 3D — the sole 2D→3D
    // affordance (no slider). Down only arms + re-frames (invisibly while flat);
    // the tilt follows the drag continuously.
    const handleRightMouseDown = (event: MouseEvent) => {
      if (event.button !== 2 || event.shiftKey) {
        return;
      }
      stopPlainRmbEvent(event);
      closeAllContextMenus();
      const anchorPointMm = scenePointFromEvent(event);
      const canvasBounds = upperCanvasEl.getBoundingClientRect();
      const anchorScreen: HybridAnchorScreen = {
        x: event.clientX - canvasBounds.left,
        y: event.clientY - canvasBounds.top,
        width: Math.max(1, canvasBounds.width || hostWidth),
        height: Math.max(1, canvasBounds.height || hostHeight),
      };
      const current = hybridViewRef.current;
      const framing = engageFraming(current);
      hybridDragRef.current = {
        active: true,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startView: { ...current, ...framing },
        anchorPointMm,
        anchorScreen,
      };
      commitHybridView((previous) => ({
        ...previous,
        ...framing,
        isInteracting: true,
      }));
    };

    const handleRightMouseMove = (event: MouseEvent) => {
      const drag = hybridDragRef.current;
      if (!drag?.active) {
        return;
      }
      if ((event.buttons & 2) !== 2) {
        finishHybridDrag();
        return;
      }
      stopPlainRmbEvent(event);
      const dx = event.clientX - drag.startClientX;
      const dy = event.clientY - drag.startClientY;
      // Vertical drag = blend (drag down lifts the flat plan into full 3D);
      // horizontal drag = yaw. Pitch derives from blend so every notch reads.
      const nextBlend = clampNumber(drag.startView.blend + dy / 240, 0, 1);
      // Fixed-pivot orbit around the model centre (target + distance stay put —
      // no sliding): pitch eases 82° (≈ top-down / plan) → 38° (isometric) as
      // the plane tilts; horizontal drag orbits (yaw).
      const nextPitch = clampNumber(82 - nextBlend * 44, 38, 82);
      commitHybridView((previous) => ({
        ...previous,
        blend: nextBlend,
        yawDeg: drag.startView.yawDeg + dx * 0.22,
        pitchDeg: nextPitch,
        perspectiveStrength: clampNumber(0.32 + nextBlend * 0.32, 0.3, 0.72),
        targetMm: drag.startView.targetMm,
        distanceMm: drag.startView.distanceMm,
        isInteracting: true,
      }));
    };

    const handleRightMouseUp = (event: MouseEvent) => {
      if (event.button !== 2 && !hybridDragRef.current?.active) {
        return;
      }
      if (hybridDragRef.current?.active) {
        stopPlainRmbEvent(event);
      }
      finishHybridDrag();
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (event.shiftKey) {
        return;
      }
      stopPlainRmbEvent(event);
    };

    const handleDoubleClick = (event: MouseEvent) => {
      if (hybridViewRef.current.blend <= 0.05) {
        return;
      }
      stopPlainRmbEvent(event);
      resetHybridView();
    };

    upperCanvasEl.addEventListener("mousedown", handleRightMouseDown, true);
    upperCanvasEl.addEventListener("contextmenu", handleContextMenu, true);
    upperCanvasEl.addEventListener("dblclick", handleDoubleClick, true);
    window.addEventListener("mousemove", handleRightMouseMove, true);
    window.addEventListener("mouseup", handleRightMouseUp, true);
    window.addEventListener("blur", finishHybridDrag);

    return () => {
      upperCanvasEl.removeEventListener("mousedown", handleRightMouseDown, true);
      upperCanvasEl.removeEventListener("contextmenu", handleContextMenu, true);
      upperCanvasEl.removeEventListener("dblclick", handleDoubleClick, true);
      window.removeEventListener("mousemove", handleRightMouseMove, true);
      window.removeEventListener("mouseup", handleRightMouseUp, true);
      window.removeEventListener("blur", finishHybridDrag);
    };
  }, [
    animateHybridBlend,
    closeDimensionContextMenu,
    closeObjectContextMenu,
    closeSectionLineContextMenu,
    closeWallContextMenu,
    commitHybridView,
    fabricCanvas,
    hostHeight,
    hostWidth,
    viewportZoom,
    panOffset.x,
    panOffset.y,
    resetHybridView,
  ]);

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
      if (
        hybridBlendFrameRef.current !== null &&
        typeof window !== "undefined"
      ) {
        window.cancelAnimationFrame(hybridBlendFrameRef.current);
        hybridBlendFrameRef.current = null;
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
    cancelDrawing: _cancelDuctDrawing,
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

  // The studio overlay renders the live draw preview as its own pair, so the
  // draw tool feeds it the route here (imperatively — only the overlay re-renders).
  const pipeStudioOverlayRef = useRef<PipeStudioOverlayHandle | null>(null);
  // Last committed vertex of the pipe draft (real mm) — the HUD measures the
  // active run from here. Guarded set: the route updates on every mouse move.
  const [draftPipeAnchorMm, setDraftPipeAnchorMm] = useState<Point2D | null>(
    null,
  );
  const handleDraftPipeRoute = useCallback((route: Point2D[] | null) => {
    pipeStudioOverlayRef.current?.setDraftRoute(route);
    const anchor =
      route && route.length >= 2 ? route[route.length - 2] ?? null : null;
    setDraftPipeAnchorMm((current) => {
      if (!anchor) return current === null ? current : null;
      if (current && current.x === anchor.x && current.y === anchor.y) {
        return current;
      }
      return { x: anchor.x, y: anchor.y };
    });
  }, []);
  // Real-diameter preview elements for the in-progress pipe — rendered by the
  // overlay exactly like a committed pipe so the preview never changes size on
  // Enter (imperative: only the overlay re-renders).
  const handleDraftPipes = useCallback((elements: HvacElement[] | null) => {
    pipeStudioOverlayRef.current?.setDraftPipes(elements);
  }, []);
  // Snap-hover indicator: the tool forwards the detected snap point; the overlay
  // renders it with the same endpoint-handle bullseye a committed pipe shows.
  const handleSnapIndicator = useCallback((point: Point2D | null) => {
    pipeStudioOverlayRef.current?.setSnapIndicator(point);
  }, []);

  const {
    handleMouseDown: handleRefrigerantPipeMouseDown,
    handleMouseMove: handleRefrigerantPipeMouseMove,
    handleDoubleClick: handleRefrigerantPipeDoubleClick,
    handleKeyDown: handleRefrigerantPipeKeyDown,
    handleKeyUp: handleRefrigerantPipeKeyUp,
    cancelDrawing: _cancelRefrigerantPipeDrawing,
    beginRouteFromBundle: beginRefrigerantRouteFromBundle,
    branchKitProposal: refrigerantBranchKitProposal,
    acceptBranchKitProposal: acceptRefrigerantBranchKit,
    flipBranchKitProposal: flipRefrigerantBranchKit,
    dismissBranchKitProposal: dismissRefrigerantBranchKit,
  } = useRefrigerantPipeTool({
    fabricRef,
    hvacRendererRef,
    activeTool: tool,
    pipeMaterialMode: refrigerantPipeDrawMode,
    pipeAngleMode: refrigerantPipeAngleMode,
    pipeLineMode: refrigerantPipeLineMode,
    hvacElements,
    zoom: viewportZoom,
    snapToGrid: resolvedSnapToGrid,
    gridSize: effectiveSnapGridSize,
    addHvacElements,
    deleteHvacElement,
    updateHvacElement,
    saveToHistory,
    setSelectedIds,
    setProcessingStatus,
    onDraftRouteChange: handleDraftPipeRoute,
    onDraftPipesChange: handleDraftPipes,
    onSnapIndicatorChange: handleSnapIndicator,
    overlayOwnsPipePreview: !projectionViewOnly,
  });

  // Extension: a pipe-end / bundle / branch-kit-port grip hands us the bundle to
  // continue from. Switch to the pipe tool (so its mouse/keys are live) and seed
  // a routing session there, so extension reuses the full draw flow.
  const handleBeginExtendRoute = useCallback(
    (bundle: RefrigerantPipeBundleConnection, lineMode: RefrigerantPipeLineMode) => {
      setTool("refrigerant-pipe");
      beginRefrigerantRouteFromBundle(bundle, { lineMode });
    },
    [setTool, beginRefrigerantRouteFromBundle],
  );

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

        updateHvacElement(element.id, {
          position: placement.point,
          rotation: placement.rotationDeg,
          width: placement.widthMm,
          depth: placement.depthMm,
          height: placement.heightMm,
          roomId: placement.roomId ?? undefined,
          wallId: placement.wallId ?? undefined,
          properties: {
            ...element.properties,
            ...(placement.placementProperties ?? {}),
          },
        });
        const movedElement = {
          ...element,
          position: placement.point,
          rotation: placement.rotationDeg,
          width: placement.widthMm,
          depth: placement.depthMm,
          height: placement.heightMm,
          roomId: placement.roomId ?? undefined,
          wallId: placement.wallId ?? undefined,
          properties: {
            ...element.properties,
            ...(placement.placementProperties ?? {}),
          },
        };
        const connectedPipeUpdates =
          resolveRefrigerantPipeUnitPortReconnectionUpdates(
            hvacElements,
            movedElement,
          );
        connectedPipeUpdates.forEach((pipeUpdate) => {
          if (pipeUpdate.id === element.id) {
            return;
          }
          updateHvacElement(pipeUpdate.id, pipeUpdate.updates);
        });
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
    hvacElements,
    setSelectedIds,
    setHoveredElement,
    getWall,
    updateWall,
    updateWalls,
    updateWallBevel,
    updateHvacElement,
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

  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;

    if (projectionViewOnly) {
      canvas.discardActiveObject();
      hideActiveSelectionChrome(canvas);
      canvas.skipTargetFind = true;
      canvas.requestRenderAll();
      return;
    }

    canvas.skipTargetFind = false;
    canvas.requestRenderAll();
  }, [projectionViewOnly]);

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
    projectionViewOnly,
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
    konvaPipeEditorEnabled: konvaPipeOverlayActive,
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
      projectionViewOnly,
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
    projectionViewOnly,
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
    saveToHistory,
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
          <div
            className="absolute inset-0"
            style={projectionPlaneStyle}
          >
          <BoardGrid
            width={hostWidth}
            height={hostHeight}
            viewportZoom={viewportZoom}
            panOffset={panOffset}
            show={resolvedShowGrid}
          />
          <canvas ref={canvasRef} className="relative z-[2] block" />
          <PipeKonvaInteractionLayer
            enabled={konvaPipeOverlayActive && !projectionViewOnly}
            width={hostWidth}
            height={hostHeight}
            viewportZoom={viewportZoom}
            panOffset={panOffset}
            hvacElements={hvacElements}
            selectedIds={selectedIds}
            wallSettings={wallSettings}
            updateHvacElement={updateHvacElement}
            saveToHistory={saveToHistory}
            setProcessingStatus={setProcessingStatus}
            setSelectedIds={setSelectedIds}
          />
          <PipeStudioOverlay
            ref={pipeStudioOverlayRef}
            enabled={!projectionViewOnly}
            width={hostWidth}
            height={hostHeight}
            viewportZoom={viewportZoom}
            panOffset={panOffset}
            selectionHitTesting={tool === "select"}
            pipeToolActive={tool === "refrigerant-pipe"}
            pipeLineMode={refrigerantPipeLineMode}
            hvacElements={hvacElements}
            selectedIds={selectedIds}
            setSelectedIds={setSelectedIds}
            updateHvacElement={updateHvacElement}
            addHvacElement={addHvacElement}
            saveToHistory={saveToHistory}
            onBeginExtendRoute={handleBeginExtendRoute}
          />
          <PipeClashOverlay
            enabled={!projectionViewOnly}
            width={hostWidth}
            height={hostHeight}
            viewportZoom={viewportZoom}
            panOffset={panOffset}
            hvacElements={hvacElements}
            selectedIds={selectedIds}
            updateHvacElement={updateHvacElement}
            setProcessingStatus={setProcessingStatus}
          />
          {!projectionViewOnly &&
            tool === "refrigerant-pipe" &&
            refrigerantBranchKitProposal && (
              <PipeBranchKitProposalCard
                screenX={
                  -panOffset.x * viewportZoom +
                  viewportZoom * refrigerantBranchKitProposal.teePoint.x * MM_TO_PX
                }
                screenY={
                  -panOffset.y * viewportZoom +
                  viewportZoom * refrigerantBranchKitProposal.teePoint.y * MM_TO_PX
                }
                connectionLabel={refrigerantBranchKitProposal.connectionLabel}
                validity={refrigerantBranchKitProposal.validity}
                violations={refrigerantBranchKitProposal.violations}
                onAccept={acceptRefrigerantBranchKit}
                onFlip={flipRefrigerantBranchKit}
                onDismiss={dismissRefrigerantBranchKit}
              />
            )}
          <canvas
            ref={snapOverlayRef}
            className="absolute left-0 top-0 z-[10] block"
            style={{ pointerEvents: "none" }}
          />
          <BoardCursorHud
            cursorScenePx={displayMousePosition}
            anchorMm={
              tool === "wall" || tool === "partition-wall"
                ? wallDrawingState.isDrawing
                  ? wallDrawingState.startPoint
                  : null
                : tool === "room"
                  ? isRoomDrawing
                    ? roomStartCorner
                    : null
                  : tool === "refrigerant-pipe"
                    ? draftPipeAnchorMm
                    : null
            }
            formatLength={boardFormatLength}
            viewportZoom={viewportZoom}
            panOffset={panOffset}
            viewportWidth={hostWidth}
            viewportHeight={hostHeight}
            visible={!projectionViewOnly && drawingToolActive}
            snapped={cursorSnapActive}
          />
        </div>
        <HybridProjectionLayer
          width={hostWidth}
          height={hostHeight}
          pageWidth={pageConfig.width}
          pageHeight={pageConfig.height}
          viewportZoom={viewportZoom}
          view={hybridView}
          walls={walls}
          rooms={rooms}
          symbols={symbols}
          objectDefinitions={objectDefinitions}
          hvacElements={hvacElements}
          onWebglUnavailable={handleHybridWebglUnavailable}
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

      <div
        style={{
          opacity: planLayerOpacity,
          transition: hybridView.blend > 0 ? "opacity 120ms linear" : undefined,
          pointerEvents: projectionViewOnly ? "none" : undefined,
        }}
      >
        <BoardRulers
          width={viewportSize.width}
          height={viewportSize.height}
          viewportZoom={viewportZoom}
          panOffset={panOffset}
          offset={originOffset}
          unit={boardUnit}
          onCycleUnit={() => setBoardUnit((prev) => cycleBoardUnit(prev))}
          cursorScreen={null}
          topSize={rulerSize}
          leftSize={leftRulerWidth}
          show={resolvedShowRulers}
        />
      </div>
    </div>
  );
}

export default DrawingCanvas;
