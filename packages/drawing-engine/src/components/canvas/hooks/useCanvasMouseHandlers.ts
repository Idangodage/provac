/**
 * useCanvasMouseHandlers Hook
 *
 * Wraps the four core mouse event handler useCallbacks that were
 * previously inlined in DrawingCanvas.tsx:
 *   handleMouseDown, handleMouseMove, handleMouseUp, handleWheel
 *
 * All logic is preserved verbatim — only moved into hook form.
 */

import type * as fabric from "fabric";
import { useCallback } from "react";

import type {
  AcEquipmentDefinition,
  ArchitecturalObjectDefinition,
} from "../../../data";
import type {
  DrawingTool,
  Point2D,
  SectionLineDrawingState,
  Wall,
  WallSettings,
} from "../../../types";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  WHEEL_ZOOM_SENSITIVITY,
  type CanvasState,
  type MarqueeSelectionState,
} from "../../DrawingCanvas.types";
import type { DimensionRenderer } from "../dimension/DimensionRenderer";
import type { HvacPlanRenderer } from "../hvac/HvacPlanRenderer";
import type { ObjectRenderer } from "../object/ObjectRenderer";
import type { RoomRenderer } from "../room/RoomRenderer";
import { MM_TO_PX } from "../scale";
import { snapPointToGrid } from "../snapping";
import { isDrawingTool, renderDrawingPreview } from "../toolUtils";
import {
  buildViewportTransform,
  panForZoomAtViewportPoint,
  panFromViewportDelta,
} from "../viewTransform";
import type { WallRenderer } from "../wall/WallRenderer";
import { snapWallPoint } from "../wall/WallSnapping";

import type { UseExtendToolResult } from "./useExtendTool";
import type { UseOffsetToolResult } from "./useOffsetTool";
import type { UseTrimToolResult } from "./useTrimTool";

// =============================================================================
// Types
// =============================================================================

export interface UseCanvasMouseHandlersOptions {
  // ── Refs ──
  fabricRef: React.RefObject<fabric.Canvas | null>;
  canvasStateRef: React.MutableRefObject<CanvasState>;
  zoomRef: React.MutableRefObject<number>;
  panOffsetRef: React.MutableRefObject<Point2D>;
  mousePositionRef: React.MutableRefObject<Point2D>;
  placementCursorRef: React.MutableRefObject<Point2D | null>;
  middlePanRef: React.MutableRefObject<{ active: boolean }>;
  marqueeSelectionRef: React.MutableRefObject<MarqueeSelectionState>;
  lastMarqueeSelectionRef: React.MutableRefObject<MarqueeSelectionState>;
  applyMarqueeFilterRef: React.MutableRefObject<boolean>;
  isDraggingObjectRef: React.MutableRefObject<boolean>;
  isWallHandleDraggingRef: React.MutableRefObject<boolean>;
  openingPointerInteractionRef: React.MutableRefObject<unknown>;
  wheelPendingZoom: React.MutableRefObject<number>;
  wheelPendingPan: React.MutableRefObject<Point2D>;
  wheelRafId: React.MutableRefObject<number | null>;
  roomRendererRef: React.MutableRefObject<RoomRenderer | null>;
  dimensionRendererRef: React.MutableRefObject<DimensionRenderer | null>;
  objectRendererRef: React.MutableRefObject<ObjectRenderer | null>;
  hvacRendererRef: React.MutableRefObject<HvacPlanRenderer | null>;

  // ── State values ──
  tool: DrawingTool;
  resolvedSnapToGrid: boolean;
  effectiveSnapGridSize: number;
  isSpacePressed: boolean;
  pendingPlacementDefinition: ArchitecturalObjectDefinition | null;
  pendingPlacementEquipmentDefinition: AcEquipmentDefinition | null;
  projectionViewOnly?: boolean;
  isWallDrawing: boolean;
  isRoomDrawing: boolean;
  roomStartCorner: Point2D | null;
  viewportZoom: number;
  safePaperPerRealRatio: number;
  walls: Wall[];
  wallSettings: WallSettings;
  sectionLineDrawingState: SectionLineDrawingState;

  // ── Callbacks ──
  queueMousePositionUpdate: (position: Point2D) => void;
  closeWallContextMenu: () => void;
  closeDimensionContextMenu: () => void;
  closeSectionLineContextMenu: () => void;
  closeObjectContextMenu: () => void;
  placePendingObject: (point: Point2D) => boolean;
  placePendingHvacElement: (point: Point2D) => boolean;
  handleWallMouseDown: (point: Point2D) => void;
  handleWallMouseMove: (point: Point2D) => void;
  handleRoomMouseDown: (point: Point2D) => void;
  handleRoomMouseMove: (point: Point2D) => void;
  handleDimensionPlacementMouseDown: (
    point: Point2D,
    target: fabric.Object | null,
  ) => void;
  handleDimensionPlacementMouseMove: (point: Point2D) => boolean;
  handleDuctMouseDown: (point: Point2D) => void;
  handleDuctMouseMove: (point: Point2D) => void;
  handleRefrigerantPipeMouseDown: (point: Point2D) => void;
  handleRefrigerantPipeMouseMove: (point: Point2D) => void;
  handleDimensionSelectMouseMove: (
    point: Point2D,
    target: fabric.Object | null | undefined,
  ) => boolean;
  isDimensionSelectDragActive: () => boolean;
  handleDimensionSelectMouseUp: () => boolean;
  handleSelectMouseMove: (
    point: Point2D,
    target: fabric.Object | null,
  ) => boolean;
  handleSelectMouseUp: () => boolean;
  findOpeningAtPoint: (
    pointMm: Point2D,
  ) => { openingId: string; wallId: string } | null;
  updateOpeningPointerInteraction: (pointerMm: Point2D) => boolean;
  finishOpeningPointerInteraction: () => boolean;
  computePlacement: (
    point: Point2D,
    definition: ArchitecturalObjectDefinition,
    options?: {
      ignoreSymbolId?: string;
      ignoreOpeningId?: string;
      openingWidthMm?: number;
    },
  ) => {
    point: Point2D;
    rotationDeg: number;
    snappedWall: { wall: Wall; positionAlongWall: number } | null;
    alignmentPoint: Point2D | null;
    valid: boolean;
  };
  buildOpeningPreviewProperties: (
    definition: ArchitecturalObjectDefinition,
    snappedWall?: { wall: Wall; positionAlongWall: number } | null,
  ) => Record<string, unknown> | undefined;
  computeHvacPlacement: (
    point: Point2D,
    source: AcEquipmentDefinition,
  ) => {
    point: Point2D;
    center: Point2D;
    rotationDeg: number;
    valid: boolean;
    roomId?: string | null;
    wallId?: string | null;
    invalidReason?: string | null;
    widthMm?: number;
    depthMm?: number;
    heightMm?: number;
    placementProperties?: Record<string, unknown>;
  };
  scheduleDimensionLayerRefresh: () => void;
  setViewTransform: (zoom: number, pan: Point2D) => void;
  setInteractionViewTransform: (zoom: number, pan: Point2D) => void;
  setCanvasState: (state: CanvasState) => void;
  setPlacementValid: (valid: boolean) => void;
  setHoveredElement: (id: string | null) => void;
  setMarqueeSelectionMode: (mode: "window" | "crossing") => void;
  addSketch: (sketch: {
    points: Point2D[];
    type: "freehand" | "spline";
  }) => void;
  getSelectionRect: (
    selection: MarqueeSelectionState,
  ) => { minX: number; maxX: number; minY: number; maxY: number } | null;
  getTargetMeta: (target: fabric.Object | null | undefined) => {
    isWallControl?: boolean;
    isRoomControl?: boolean;
    isPipeControl?: boolean;
    wallId?: string;
  };
  resolveObjectIdFromTarget: (
    target: fabric.Object | null | undefined,
  ) => string | null | undefined;
  resolveHvacIdFromTarget: (
    target: fabric.Object | null | undefined,
  ) => string | null | undefined;
  resolveRoomIdFromTarget: (
    target: fabric.Object | null | undefined,
  ) => string | null | undefined;
  resolveSectionLineIdFromTarget: (
    target: fabric.Object | null | undefined,
  ) => string | null | undefined;
  startSectionLineDrawing: (point: Point2D) => void;
  updateSectionLinePreview: (point: Point2D) => void;
  commitSectionLine: () => void;
  wallRenderer: WallRenderer | null;
  offsetTool: UseOffsetToolResult;
  trimTool: UseTrimToolResult;
  extendTool: UseExtendToolResult;
}

export interface UseCanvasMouseHandlersResult {
  handleMouseDown: (e: fabric.TPointerEventInfo<fabric.TPointerEvent>) => void;
  handleMouseMove: (e: fabric.TPointerEventInfo<fabric.TPointerEvent>) => void;
  handleMouseUp: () => void;
  handleWheel: (e: fabric.TPointerEventInfo<WheelEvent>) => void;
}

// =============================================================================
// Hook
// =============================================================================

export function useCanvasMouseHandlers(
  options: UseCanvasMouseHandlersOptions,
): UseCanvasMouseHandlersResult {
  const {
    // Refs
    fabricRef,
    canvasStateRef,
    zoomRef,
    panOffsetRef,
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

    // State
    tool,
    resolvedSnapToGrid,
    effectiveSnapGridSize,
    isSpacePressed,
    pendingPlacementDefinition,
    pendingPlacementEquipmentDefinition,
    projectionViewOnly = false,
    isWallDrawing,
    isRoomDrawing,
    roomStartCorner,
    viewportZoom,
    safePaperPerRealRatio,
    walls,
    wallSettings,
    sectionLineDrawingState,

    // Callbacks
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
    handleDuctMouseDown,
    handleDuctMouseMove,
    handleRefrigerantPipeMouseDown,
    handleRefrigerantPipeMouseMove,
    handleDimensionSelectMouseMove,
    isDimensionSelectDragActive,
    handleDimensionSelectMouseUp,
    handleSelectMouseMove,
    handleSelectMouseUp,
    findOpeningAtPoint,
    updateOpeningPointerInteraction,
    finishOpeningPointerInteraction,
    computePlacement,
    buildOpeningPreviewProperties,
    computeHvacPlacement,
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
  } = options;

  const scheduleViewTransformSync = useCallback(
    (viewportZoomValue: number, panOffsetValue: Point2D) => {
      const nextZoom = viewportZoomValue / safePaperPerRealRatio;
      wheelPendingZoom.current = nextZoom;
      wheelPendingPan.current = panOffsetValue;
      setInteractionViewTransform(nextZoom, panOffsetValue);
      if (wheelRafId.current) return;
      wheelRafId.current = requestAnimationFrame(() => {
        wheelRafId.current = null;
        setViewTransform(wheelPendingZoom.current, wheelPendingPan.current);
      });
    },
    [
      wheelPendingZoom,
      wheelPendingPan,
      wheelRafId,
      safePaperPerRealRatio,
      setInteractionViewTransform,
      setViewTransform,
    ],
  );

  const applyViewportTransformImmediate = useCallback(
    (nextViewportZoom: number, nextPanOffset: Point2D) => {
      const canvas = fabricRef.current;
      if (!canvas) return;
      canvas.setViewportTransform(
        buildViewportTransform(nextViewportZoom, nextPanOffset),
      );
      canvas.requestRenderAll();
      zoomRef.current = nextViewportZoom;
      panOffsetRef.current = nextPanOffset;
    },
    [fabricRef, zoomRef, panOffsetRef],
  );

  // ── handleMouseDown ─────────────────────────────────────────────────
  const handleMouseDown = useCallback(
    (e: fabric.TPointerEventInfo<fabric.TPointerEvent>) => {
      const canvas = fabricRef.current;
      if (!canvas) return;

      const viewportPoint = canvas.getViewportPoint(e.e);
      const scenePoint = canvas.getScenePoint(e.e);
      const rawPoint = { x: scenePoint.x, y: scenePoint.y };
      const point = resolvedSnapToGrid
        ? snapPointToGrid(rawPoint, effectiveSnapGridSize)
        : rawPoint;
      queueMousePositionUpdate(rawPoint);
      closeWallContextMenu();
      closeDimensionContextMenu();
      closeSectionLineContextMenu();
      closeObjectContextMenu();

      const mouseEvent = e.e as MouseEvent;
      if ("button" in mouseEvent && mouseEvent.button === 1) {
        mouseEvent.preventDefault();
        return;
      }
      if ("button" in mouseEvent && mouseEvent.button === 2) {
        return;
      }

      const shouldPan = tool === "pan" || isSpacePressed || projectionViewOnly;
      if (shouldPan) {
        const nextState: CanvasState = {
          ...canvasStateRef.current,
          isPanning: true,
          lastPanPoint: { x: viewportPoint.x, y: viewportPoint.y },
        };
        canvasStateRef.current = nextState;
        setCanvasState(nextState);
        return;
      }

      if (tool === "select") {
        const pointerMm = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        const inferredOpening = findOpeningAtPoint(pointerMm);
        if (!e.target && !inferredOpening) {
          const start = {
            x: rawPoint.x / MM_TO_PX,
            y: rawPoint.y / MM_TO_PX,
          };
          const initialSelection: MarqueeSelectionState = {
            active: true,
            start,
            current: start,
            mode: "window",
          };
          marqueeSelectionRef.current = initialSelection;
          lastMarqueeSelectionRef.current = initialSelection;
          applyMarqueeFilterRef.current = false;
          setMarqueeSelectionMode("window");
        } else {
          marqueeSelectionRef.current = {
            active: false,
            start: null,
            current: null,
            mode: "window",
          };
          lastMarqueeSelectionRef.current = {
            active: false,
            start: null,
            current: null,
            mode: "window",
          };
          applyMarqueeFilterRef.current = false;
          setMarqueeSelectionMode("window");
        }
      }

      if (pendingPlacementDefinition) {
        const placementPoint = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        placePendingObject(placementPoint);
        return;
      }

      if (pendingPlacementEquipmentDefinition) {
        const placementPoint = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        placePendingHvacElement(placementPoint);
        return;
      }

      // Handle wall tool - convert from pixels to mm
      if (tool === "wall" || tool === "partition-wall") {
        const wallPoint = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        handleWallMouseDown(wallPoint);
        return;
      }

      // Handle room tool (2-click rectangle) - convert from pixels to mm
      if (tool === "room") {
        const wasRoomDrawing = isRoomDrawing;
        const roomPoint = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        handleRoomMouseDown(roomPoint);
        if (wasRoomDrawing) {
          wallRenderer?.clearPreviewWall();
        }
        return;
      }

      if (tool === "dimension") {
        const dimensionPoint = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        handleDimensionPlacementMouseDown(
          dimensionPoint,
          (e.target as fabric.Object | null | undefined) ?? null,
        );
        return;
      }

      if (tool === "section-line") {
        const sectionPoint = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        if (!sectionLineDrawingState.isDrawing) {
          startSectionLineDrawing(sectionPoint);
        } else {
          updateSectionLinePreview(sectionPoint);
          commitSectionLine();
        }
        return;
      }

      if (tool === "refrigerant-pipe") {
        const pipePoint = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        handleRefrigerantPipeMouseDown(pipePoint);
        return;
      }

      if (tool === "duct") {
        const ductPoint = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        handleDuctMouseDown(ductPoint);
        return;
      }

      if (tool === "offset") {
        offsetTool.handleMouseDown(rawPoint);
        return;
      }

      if (tool === "trim") {
        trimTool.handleMouseDown(rawPoint);
        return;
      }

      if (tool === "extend") {
        extendTool.handleMouseDown(rawPoint);
        return;
      }

      if (isDrawingTool(tool)) {
        const nextState: CanvasState = {
          ...canvasStateRef.current,
          isDrawing: true,
          drawingPoints: [point],
        };
        canvasStateRef.current = nextState;
      }
    },
    [
      tool,
      resolvedSnapToGrid,
      effectiveSnapGridSize,
      isSpacePressed,
      pendingPlacementDefinition,
      pendingPlacementEquipmentDefinition,
      queueMousePositionUpdate,
      closeWallContextMenu,
      closeDimensionContextMenu,
      closeSectionLineContextMenu,
      closeObjectContextMenu,
      placePendingObject,
      placePendingHvacElement,
      handleWallMouseDown,
      isRoomDrawing,
      handleRoomMouseDown,
      findOpeningAtPoint,
      handleDimensionPlacementMouseDown,
      handleDuctMouseDown,
      handleRefrigerantPipeMouseDown,
      setMarqueeSelectionMode,
      sectionLineDrawingState.isDrawing,
      startSectionLineDrawing,
      updateSectionLinePreview,
      commitSectionLine,
      wallRenderer,
      offsetTool,
      trimTool,
      extendTool,
    ],
  );

  // ── handleMouseMove ─────────────────────────────────────────────────
  const handleMouseMove = useCallback(
    (e: fabric.TPointerEventInfo<fabric.TPointerEvent>) => {
      const canvas = fabricRef.current;
      if (!canvas) return;

      const viewportPoint = canvas.getViewportPoint(e.e);
      const scenePoint = canvas.getScenePoint(e.e);
      const rawPoint = { x: scenePoint.x, y: scenePoint.y };
      const point = resolvedSnapToGrid
        ? snapPointToGrid(rawPoint, effectiveSnapGridSize)
        : rawPoint;
      queueMousePositionUpdate(rawPoint);

      const currentState = canvasStateRef.current;
      if (middlePanRef.current.active) return;

      if (tool === "select" && isWallHandleDraggingRef.current) {
        const selectPoint = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        handleSelectMouseMove(selectPoint, null);
        return;
      }

      if (currentState.isPanning && currentState.lastPanPoint) {
        const dx = viewportPoint.x - currentState.lastPanPoint.x;
        const dy = viewportPoint.y - currentState.lastPanPoint.y;
        const nextPan = panFromViewportDelta(
          panOffsetRef.current,
          dx,
          dy,
          zoomRef.current,
        );
        applyViewportTransformImmediate(zoomRef.current, nextPan);
        scheduleViewTransformSync(zoomRef.current, nextPan);
        const nextState: CanvasState = {
          ...currentState,
          lastPanPoint: { x: viewportPoint.x, y: viewportPoint.y },
        };
        canvasStateRef.current = nextState;
        return;
      }

      if (projectionViewOnly) {
        setHoveredElement(null);
        return;
      }

      if (tool === "select" && openingPointerInteractionRef.current) {
        const pointerMm = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        const handled = updateOpeningPointerInteraction(pointerMm);
        if (handled) {
          return;
        }
      }

      if (
        tool === "select" &&
        marqueeSelectionRef.current.active &&
        marqueeSelectionRef.current.start
      ) {
        const current = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        const mode: "window" | "crossing" =
          current.x >= marqueeSelectionRef.current.start.x
            ? "window"
            : "crossing";
        marqueeSelectionRef.current = {
          ...marqueeSelectionRef.current,
          current,
          mode,
        };
        lastMarqueeSelectionRef.current = {
          ...marqueeSelectionRef.current,
          start: marqueeSelectionRef.current.start
            ? { ...marqueeSelectionRef.current.start }
            : null,
          current: marqueeSelectionRef.current.current
            ? { ...marqueeSelectionRef.current.current }
            : null,
        };
        setMarqueeSelectionMode(mode);
      }

      if (pendingPlacementDefinition) {
        const placementPoint = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        placementCursorRef.current = placementPoint;
        const placement = computePlacement(
          placementPoint,
          pendingPlacementDefinition,
        );
        setPlacementValid(placement.valid);
        objectRendererRef.current?.renderPlacementPreview(
          pendingPlacementDefinition,
          placement.point,
          placement.rotationDeg,
          placement.valid,
          placement.snappedWall
            ? {
                wall: placement.snappedWall.wall,
                positionAlongWall: placement.snappedWall.positionAlongWall,
              }
            : null,
          buildOpeningPreviewProperties(
            pendingPlacementDefinition,
            placement.snappedWall
              ? {
                  wall: placement.snappedWall.wall,
                  positionAlongWall: placement.snappedWall.positionAlongWall,
                }
              : null,
          ),
        );
        return;
      }

      if (pendingPlacementEquipmentDefinition) {
        const placementPoint = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        placementCursorRef.current = placementPoint;
        const placement = computeHvacPlacement(
          placementPoint,
          pendingPlacementEquipmentDefinition,
        );
        setPlacementValid(placement.valid);
        hvacRendererRef.current?.renderPlacementPreview(
          pendingPlacementEquipmentDefinition,
          placement.point,
          placement.rotationDeg,
          placement.valid,
          placement.placementProperties,
        );
        return;
      }

      // Handle wall tool movement - convert from pixels to mm
      // Show snap indicators on hover even before drawing starts
      if (tool === "wall" || tool === "partition-wall") {
        const wallPoint = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        handleWallMouseMove(wallPoint);
        scheduleDimensionLayerRefresh();
        if (!isWallDrawing) {
          // Don't return early — allow other handlers below to still fire
          // But snap indicators are already rendered by handleWallMouseMove
        }
        if (isWallDrawing) return;
      }

      if (tool === "room") {
        const roomPoint = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        // Reuse wall-tool snap indicator rendering so room mode shows
        // the same magnetic endpoint proposal marker.
        if (resolvedSnapToGrid) {
          handleWallMouseMove(roomPoint);
        }
        handleRoomMouseMove(roomPoint);
        scheduleDimensionLayerRefresh();
        if (isRoomDrawing && roomStartCorner) {
          const snappedEnd = resolvedSnapToGrid
            ? snapWallPoint(
                roomPoint,
                null,
                wallSettings,
                walls,
                false,
                viewportZoom,
                undefined,
              ).snappedPoint
            : roomPoint;
          const minX = Math.min(roomStartCorner.x, snappedEnd.x);
          const maxX = Math.max(roomStartCorner.x, snappedEnd.x);
          const minY = Math.min(roomStartCorner.y, snappedEnd.y);
          const maxY = Math.max(roomStartCorner.y, snappedEnd.y);
          const segments = [
            {
              startPoint: { x: minX, y: minY },
              endPoint: { x: maxX, y: minY },
            },
            {
              startPoint: { x: maxX, y: minY },
              endPoint: { x: maxX, y: maxY },
            },
            {
              startPoint: { x: maxX, y: maxY },
              endPoint: { x: minX, y: maxY },
            },
            {
              startPoint: { x: minX, y: maxY },
              endPoint: { x: minX, y: minY },
            },
          ];
          wallRenderer?.renderPreviewWalls(
            segments,
            wallSettings.defaultThickness,
            wallSettings.defaultMaterial,
          );
          return;
        }
        wallRenderer?.clearPreviewWall();
      }

      if (tool === "section-line" && sectionLineDrawingState.isDrawing) {
        const sectionPoint = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        updateSectionLinePreview(sectionPoint);
        return;
      }

      if (tool === "refrigerant-pipe") {
        const pipePoint = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        handleRefrigerantPipeMouseMove(pipePoint);
        return;
      }

      if (tool === "duct") {
        const ductPoint = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        handleDuctMouseMove(ductPoint);
        return;
      }

      if (tool === "dimension") {
        const dimensionPoint = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        const handled = handleDimensionPlacementMouseMove(dimensionPoint);
        if (handled) {
          return;
        }
      }

      if (tool === "offset") {
        offsetTool.handleMouseMove(rawPoint);
        return;
      }

      if (tool === "trim") {
        trimTool.handleMouseMove(rawPoint);
        return;
      }

      if (tool === "extend") {
        extendTool.handleMouseMove(rawPoint);
        return;
      }

      if (tool === "select") {
        const hitTarget =
          (e.target as fabric.Object | null | undefined) ??
          canvas.findTarget(e.e as unknown as fabric.TPointerEvent) ??
          null;
        const subTargets =
          (
            e as fabric.TPointerEventInfo<fabric.TPointerEvent> & {
              subTargets?: fabric.Object[];
            }
          ).subTargets ?? [];
        const candidateTargets = [
          ...subTargets,
          ...(hitTarget ? [hitTarget] : []),
        ];
        const selectPoint = {
          x: rawPoint.x / MM_TO_PX,
          y: rawPoint.y / MM_TO_PX,
        };
        const hoveredHvacIdAtCanvasPoint =
          hvacRendererRef.current?.findElementAtCanvasPoint(rawPoint) ?? null;
        const prioritizedControlTarget =
          candidateTargets.find((target) => {
            const meta = getTargetMeta(
              target as fabric.Object | null | undefined,
            );
            return Boolean(
              meta.isWallControl || meta.isRoomControl || meta.isPipeControl,
            );
          }) ?? null;
        const hoveredObjectId =
          candidateTargets
            .map((target) => resolveObjectIdFromTarget(target))
            .find((entry): entry is string => Boolean(entry)) ??
          resolveObjectIdFromTarget(hitTarget);
        const inferredOpening = findOpeningAtPoint(selectPoint);
        const openingHoverId =
          hoveredObjectId ?? inferredOpening?.openingId ?? null;
        if (openingHoverId) {
          wallRenderer?.setHoveredWall(null);
          setHoveredElement(openingHoverId);
          return;
        }
        const hoveredHvacId =
          candidateTargets
            .map((target) => resolveHvacIdFromTarget(target))
            .find((entry): entry is string => Boolean(entry)) ??
          resolveHvacIdFromTarget(hitTarget) ??
          hoveredHvacIdAtCanvasPoint;
        if (hoveredHvacId) {
          wallRenderer?.setHoveredWall(null);
          setHoveredElement(hoveredHvacId);
          return;
        }
        const hoveredSectionLineId =
          candidateTargets
            .map((target) => resolveSectionLineIdFromTarget(target))
            .find((entry): entry is string => Boolean(entry)) ??
          resolveSectionLineIdFromTarget(hitTarget);
        if (hoveredSectionLineId) {
          wallRenderer?.setHoveredWall(null);
          setHoveredElement(hoveredSectionLineId);
          return;
        }
        if (isDimensionSelectDragActive()) {
          const dimensionHandled = handleDimensionSelectMouseMove(
            selectPoint,
            hitTarget,
          );
          if (dimensionHandled) {
            return;
          }
        }
        if (prioritizedControlTarget) {
          const prioritizedMeta = getTargetMeta(
            prioritizedControlTarget as fabric.Object | null | undefined,
          );
          wallRenderer?.setHoveredWall(prioritizedMeta.wallId ?? null);
          handleSelectMouseMove(selectPoint, prioritizedControlTarget);
          return;
        }

        const hoveredWallId =
          wallRenderer?.getWallIdAtPoint(selectPoint) ?? null;
        wallRenderer?.setHoveredWall(hoveredWallId);
        if (hoveredWallId) {
          setHoveredElement(hoveredWallId);
          return;
        }

        const dimensionHandled = handleDimensionSelectMouseMove(
          selectPoint,
          hitTarget,
        );
        if (dimensionHandled) {
          return;
        }
        const handled = handleSelectMouseMove(selectPoint, hitTarget);
        if (handled) {
          return;
        }
        const hoveredRoomId =
          roomRendererRef.current?.getRoomIdAtPoint(selectPoint) ??
          resolveRoomIdFromTarget(hitTarget);
        if (hoveredRoomId) {
          wallRenderer?.setHoveredWall(null);
          setHoveredElement(hoveredRoomId);
          return;
        }
      }

      if (!currentState.isDrawing) return;
      const nextPoints = [...currentState.drawingPoints, point];
      const nextState: CanvasState = {
        ...currentState,
        drawingPoints: nextPoints,
      };
      canvasStateRef.current = nextState;
      renderDrawingPreview(canvas, nextPoints, tool);
    },
    [
      tool,
      resolvedSnapToGrid,
      effectiveSnapGridSize,
      queueMousePositionUpdate,
      middlePanRef,
      pendingPlacementDefinition,
      pendingPlacementEquipmentDefinition,
      projectionViewOnly,
      computePlacement,
      computeHvacPlacement,
      isWallDrawing,
      isRoomDrawing,
      roomStartCorner,
      handleWallMouseMove,
      handleRoomMouseMove,
      handleDimensionPlacementMouseMove,
      handleDuctMouseMove,
      handleRefrigerantPipeMouseMove,
      handleDimensionSelectMouseMove,
      isDimensionSelectDragActive,
      handleSelectMouseMove,
      sectionLineDrawingState.isDrawing,
      updateSectionLinePreview,
      getTargetMeta,
      resolveObjectIdFromTarget,
      resolveHvacIdFromTarget,
      resolveRoomIdFromTarget,
      resolveSectionLineIdFromTarget,
      findOpeningAtPoint,
      walls,
      viewportZoom,
      wallRenderer,
      hvacRendererRef,
      offsetTool,
      trimTool,
      extendTool,
      scheduleDimensionLayerRefresh,
      wallSettings.gridSize,
      wallSettings.defaultThickness,
      setHoveredElement,
      setMarqueeSelectionMode,
      updateOpeningPointerInteraction,
      applyViewportTransformImmediate,
      scheduleViewTransformSync,
    ],
  );

  // ── handleMouseUp ───────────────────────────────────────────────────
  const handleMouseUp = useCallback(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;

    // ── Safety cleanup for drag optimisation state ──
    if (isDraggingObjectRef.current) {
      isDraggingObjectRef.current = false;
      canvas.skipTargetFind = false;
    }

    const currentState = canvasStateRef.current;

    if (currentState.isPanning) {
      const nextState: CanvasState = {
        ...currentState,
        isPanning: false,
        lastPanPoint: null,
      };
      canvasStateRef.current = nextState;
      setCanvasState(nextState);
      return;
    }

    if (projectionViewOnly) {
      return;
    }

    if (tool === "select") {
      const handledOpeningInteraction = finishOpeningPointerInteraction();
      if (handledOpeningInteraction) {
        return;
      }
    }

    if (tool === "select" && marqueeSelectionRef.current.active) {
      const currentSelection = marqueeSelectionRef.current;
      const rect = getSelectionRect(currentSelection);
      const hasMarqueeDrag = Boolean(
        rect && rect.maxX - rect.minX > 2 && rect.maxY - rect.minY > 2,
      );
      lastMarqueeSelectionRef.current = {
        ...currentSelection,
        active: false,
        start: currentSelection.start ? { ...currentSelection.start } : null,
        current: currentSelection.current
          ? { ...currentSelection.current }
          : null,
      };
      marqueeSelectionRef.current = {
        active: false,
        start: null,
        current: null,
        mode: "window",
      };
      applyMarqueeFilterRef.current = hasMarqueeDrag;
    } else if (tool === "select") {
      applyMarqueeFilterRef.current = false;
    }

    if (tool === "select") {
      const dimensionHandled = handleDimensionSelectMouseUp();
      if (dimensionHandled) {
        return;
      }
      const handled = handleSelectMouseUp();
      if (handled) {
        return;
      }
    }

    if (currentState.isDrawing && currentState.drawingPoints.length > 1) {
      if (tool === "pencil" || tool === "spline") {
        addSketch({
          points: currentState.drawingPoints,
          type: tool === "spline" ? "spline" : "freehand",
        });
      }
    }

    const nextState: CanvasState = {
      ...currentState,
      isDrawing: false,
      drawingPoints: [],
    };
    canvasStateRef.current = nextState;
    setCanvasState(nextState);
  }, [
    tool,
    addSketch,
    projectionViewOnly,
    handleDimensionSelectMouseUp,
    handleSelectMouseUp,
    getSelectionRect,
    finishOpeningPointerInteraction,
  ]);

  // ── handleWheel (zoom) ──────────────────────────────────────────────
  const handleWheel = useCallback(
    (e: fabric.TPointerEventInfo<WheelEvent>) => {
      e.e.preventDefault();
      const canvas = fabricRef.current;
      if (!canvas) return;

      // Read zoom from ref so rapid wheel ticks compound correctly
      // without waiting for React re-renders.
      const currentVpZoom = zoomRef.current;
      const currentZoom = currentVpZoom / safePaperPerRealRatio;

      // Exponential zoom factor from wheel delta.
      const zoomFactor = Math.exp(-e.e.deltaY * WHEEL_ZOOM_SENSITIVITY);
      const newZoom = Math.min(
        Math.max(currentZoom * zoomFactor, MIN_ZOOM),
        MAX_ZOOM,
      );
      if (Math.abs(newZoom - currentZoom) < 0.0001) return;
      const newVpZoom = newZoom * safePaperPerRealRatio;

      // Use Fabric pointer conversion so zoom anchor is correct on
      // retina scaling and any canvas offset/layout shifts.
      const viewportPoint = canvas.getViewportPoint(e.e);
      const vpX = viewportPoint.x;
      const vpY = viewportPoint.y;

      // Scene-space point under cursor (from refs, not canvas — avoids lag).
      const nextPan = panForZoomAtViewportPoint(
        panOffsetRef.current,
        currentVpZoom,
        newVpZoom,
        { x: vpX, y: vpY },
      );

      // Apply immediately for low-latency feedback.
      applyViewportTransformImmediate(newVpZoom, nextPan);
      dimensionRendererRef.current?.setViewportZoom(newVpZoom);
      scheduleViewTransformSync(newVpZoom, nextPan);
    },
    [
      safePaperPerRealRatio,
      panOffsetRef,
      zoomRef,
      dimensionRendererRef,
      applyViewportTransformImmediate,
      scheduleViewTransformSync,
    ],
  );

  return {
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleWheel,
  };
}
