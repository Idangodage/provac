/**
 * useCanvasEventBinding
 *
 * Extracted from DrawingCanvas.tsx – the single giant useEffect that subscribes
 * and unsubscribes all canvas / window event handlers (mouse, keyboard, wheel,
 * selection, context-menu, object moving/rotating, etc.).
 *
 * This hook contains NO logic changes – it is a 1-to-1 extraction of the
 * "Event Binding" useEffect block.
 */

import type * as fabric from "fabric";
import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";

import type {
  AcEquipmentDefinition,
  ArchitecturalObjectDefinition,
} from "../../../data";
import { useSmartDrawingStore } from "../../../store";
import type {
  DrawingTool,
  HvacElement,
  Point2D,
  Room,
  SectionLineDirection,
  SymbolInstance2D,
  Wall,
} from "../../../types";
import type {
  MarqueeSelectionState,
  OpeningPointerInteraction,
  OpeningResizeHandleHit,
  WallContextMenuState,
  DimensionContextMenuState,
  SectionLineContextMenuState,
  ObjectContextMenuState,
} from "../../DrawingCanvas.types";
import {
  clampValue,
  hideActiveSelectionChrome,
} from "../../DrawingCanvas.types";
import type { HvacPlanRenderer } from "../hvac/HvacPlanRenderer";
import { isRefrigerantBranchKitElement } from "../hvac/refrigerantBranchKitModel";
import {
  isRefrigerantPipeElementType,
  resolveRefrigerantPipeUnitPortReconnectionUpdates,
} from "../hvac/refrigerantPipePairModel";
import type { ObjectRenderer } from "../object/ObjectRenderer";
import { MM_TO_PX } from "../scale";
import { snapPointToGrid } from "../snapping";
import type { WallRenderer } from "../wall/WallRenderer";

import type { UseExtendToolResult } from "./useExtendTool";
import type { UseOffsetToolResult } from "./useOffsetTool";
import type { UseTrimToolResult } from "./useTrimTool";

type NamedFabricObject = fabric.Object & {
  name?: string;
};

function normalizeCanvasPoint(value: unknown): Point2D | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("x" in value) ||
    !("y" in value)
  ) {
    return null;
  }
  const candidate = value as { x?: unknown; y?: unknown };
  if (
    typeof candidate.x !== "number" ||
    !Number.isFinite(candidate.x) ||
    typeof candidate.y !== "number" ||
    !Number.isFinite(candidate.y)
  ) {
    return null;
  }
  return { x: candidate.x, y: candidate.y };
}

function getFabricGroupObjectCenterMm(
  group: fabric.Object,
  objectName: string,
): Point2D | null {
  if (typeof (group as fabric.Group).getObjects !== "function") {
    return null;
  }
  const object = (group as fabric.Group)
    .getObjects()
    .find((candidate) => (candidate as NamedFabricObject).name === objectName);
  if (!object || typeof object.getRelativeCenterPoint !== "function") {
    return null;
  }

  const centerInParentPlane = object.getRelativeCenterPoint();
  const centerPx = object.group
    ? (() => {
        const matrix = object.group.calcTransformMatrix();
        return {
          x:
            matrix[0] * centerInParentPlane.x +
            matrix[2] * centerInParentPlane.y +
            matrix[4],
          y:
            matrix[1] * centerInParentPlane.x +
            matrix[3] * centerInParentPlane.y +
            matrix[5],
        };
      })()
    : centerInParentPlane;

  if (!Number.isFinite(centerPx.x) || !Number.isFinite(centerPx.y)) {
    return null;
  }

  return {
    x: centerPx.x / MM_TO_PX,
    y: centerPx.y / MM_TO_PX,
  };
}

function setInlineBranchKitTargetTransform(
  target: fabric.Object,
  centerMm: Point2D,
  rotationDeg: number,
  anchorPointMm: Point2D | null,
): void {
  target.set({
    left: centerMm.x * MM_TO_PX,
    top: centerMm.y * MM_TO_PX,
    angle: rotationDeg,
  });
  if (!anchorPointMm) {
    target.setCoords();
    return;
  }

  const renderedAnchor = getFabricGroupObjectCenterMm(
    target,
    "hvac-branch-center-snap",
  );
  if (renderedAnchor) {
    const renderedAnchorPx = {
      x: renderedAnchor.x * MM_TO_PX,
      y: renderedAnchor.y * MM_TO_PX,
    };
    const targetAnchorPx = {
      x: anchorPointMm.x * MM_TO_PX,
      y: anchorPointMm.y * MM_TO_PX,
    };
    target.set({
      left:
        ((target.left as number | undefined) ?? centerMm.x * MM_TO_PX) +
        (targetAnchorPx.x - renderedAnchorPx.x),
      top:
        ((target.top as number | undefined) ?? centerMm.y * MM_TO_PX) +
        (targetAnchorPx.y - renderedAnchorPx.y),
    });
  }
  target.setCoords();
}

// =============================================================================
// Options
// =============================================================================

export interface UseCanvasEventBindingOptions {
  // Refs
  fabricRef: RefObject<fabric.Canvas | null>;
  outerRef: RefObject<HTMLDivElement | null>;
  wheelRafId: MutableRefObject<number | null>;
  marqueeSelectionRef: MutableRefObject<MarqueeSelectionState>;
  lastMarqueeSelectionRef: MutableRefObject<MarqueeSelectionState>;
  applyMarqueeFilterRef: MutableRefObject<boolean>;
  openingPointerInteractionRef: MutableRefObject<OpeningPointerInteraction | null>;
  suppressFabricSelectionSyncRef: MutableRefObject<number>;
  isWallHandleDraggingRef: MutableRefObject<boolean>;
  isDraggingObjectRef: MutableRefObject<boolean>;
  placementCursorRef: MutableRefObject<Point2D | null>;
  objectRendererRef: RefObject<ObjectRenderer | null>;
  hvacRendererRef: RefObject<HvacPlanRenderer | null>;
  roomRendererRef: RefObject<{
    getRoomIdAtPoint: (point: Point2D) => string | null;
  } | null>;

  // State values
  tool: string;
  selectedIds: string[];
  symbols: SymbolInstance2D[];
  hvacElements: HvacElement[];
  walls: Wall[];
  objectDefinitionsById: Map<string, ArchitecturalObjectDefinition>;
  resolvedSnapToGrid: boolean;
  effectiveSnapGridSize: number;
  projectionViewOnly?: boolean;
  pendingPlacementDefinition: ArchitecturalObjectDefinition | null;
  pendingPlacementEquipmentDefinition: AcEquipmentDefinition | null;
  sectionLineDrawingState: {
    isDrawing: boolean;
    direction: SectionLineDirection;
  };
  wallById: Map<string, Wall>;
  roomById: Map<string, Room>;
  wallIdSet: Set<string>;
  perimeterWallIdsForRooms: (roomIds: string[]) => string[];
  roomBoundaryDistance: (point: Point2D, vertices: Point2D[]) => number;
  selectWallSegmentAtPoint: (wallId: string, point: Point2D) => string;
  resolveRoomPerimeterWallSegments: (roomIds: string[]) => string[];
  projectPointToSegment: (
    point: Point2D,
    segStart: Point2D,
    segEnd: Point2D,
  ) => { projected: Point2D; t: number; distance: number };

  // Canvas mouse handlers (the main useCallback-s from DrawingCanvas)
  handleMouseDown: (e: fabric.TPointerEventInfo<fabric.TPointerEvent>) => void;
  handleMouseMove: (e: fabric.TPointerEventInfo<fabric.TPointerEvent>) => void;
  handleMouseUp: () => void;
  handleWheel: (e: fabric.TPointerEventInfo<WheelEvent>) => void;

  // Middle-pan handlers
  stopMiddlePan: () => void;
  handleMiddleMouseDown: (e: MouseEvent) => void;
  handleMiddleMouseMove: (e: MouseEvent) => void;
  handleMiddleMouseUp: (e: MouseEvent) => void;
  preventMiddleAuxClick: (e: MouseEvent) => void;

  // Select-mode handlers
  handleSelectDoubleClick: (e: MouseEvent) => boolean;
  updateSelectionFromTarget: (target: fabric.Object | null | undefined) => void;
  updateSelectionFromTargets: (targets: fabric.Object[]) => void;
  handleSelectMouseDown: (
    target: fabric.Object | null | undefined,
    wallPointMm: Point2D,
    addToSelection: boolean,
  ) => void;
  handleSelectObjectMoving: (target: fabric.Object) => void;
  finalizeHandleDrag: () => void;
  handleSelectMouseMove: (
    selectPoint: Point2D,
    target: fabric.Object | null,
  ) => void;

  // Target resolvers
  resolveWallIdFromTarget: (
    target: fabric.Object | null | undefined,
  ) => string | null;
  resolveDimensionIdFromTarget: (
    target: fabric.Object | null | undefined,
  ) => string | null;
  resolveSectionLineIdFromTarget: (
    target: fabric.Object | null | undefined,
  ) => string | null;
  resolveRoomIdFromTarget: (
    target: fabric.Object | null | undefined,
  ) => string | null;
  resolveObjectIdFromTarget: (
    target: fabric.Object | null | undefined,
  ) => string | null;
  resolveHvacIdFromTarget: (
    target: fabric.Object | null | undefined,
  ) => string | null;
  resolveOpeningIdFromTarget: (
    target: fabric.Object | null | undefined,
  ) => string | null;
  resolveOpeningResizeHandleFromTarget: (
    target: fabric.Object | null | undefined,
  ) => OpeningResizeHandleHit | null;
  findOpeningAtPoint: (
    point: Point2D,
  ) => { openingId: string; wallId: string } | null;
  filterMarqueeSelectionTargets: (targets: fabric.Object[]) => fabric.Object[];
  getTargetMeta: (target: fabric.Object | null | undefined) => {
    isWallControl?: boolean;
    isRoomControl?: boolean;
    isPipeControl?: boolean;
    wallId?: string | null;
    roomId?: string | null;
  };

  // Wall tool handlers
  handleWallDoubleClick: () => void;
  handleWallToolKeyDown: (e: KeyboardEvent) => void;
  handleWallToolKeyUp: (e: KeyboardEvent) => void;
  handleDuctDoubleClick: () => void;
  handleDuctKeyDown: (e: KeyboardEvent) => boolean;
  handleDuctKeyUp: (e: KeyboardEvent) => void;
  handleRefrigerantPipeDoubleClick: () => void;
  handleRefrigerantPipeKeyDown: (e: KeyboardEvent) => boolean;
  handleRefrigerantPipeKeyUp: (e: KeyboardEvent) => void;

  // Dimension tool handlers
  handleDimensionDoubleClick: (
    target: fabric.Object | null | undefined,
  ) => boolean;
  handleDimensionKeyDown: (e: KeyboardEvent) => boolean;
  handleDimensionSelectMouseDown: (
    target: fabric.Object | null | undefined,
    wallPointMm: Point2D,
    addToSelection: boolean,
  ) => boolean;

  // Tool hooks
  offsetTool: Pick<UseOffsetToolResult, "handleKeyDown">;
  trimTool: Pick<UseTrimToolResult, "handleKeyDown">;
  extendTool: Pick<UseExtendToolResult, "handleKeyDown">;

  // Opening placement
  computePlacement: (
    position: Point2D,
    definition: ArchitecturalObjectDefinition,
    options?: {
      ignoreOpeningId?: string;
      ignoreSymbolId?: string;
      openingWidthMm?: number;
    },
  ) => {
    valid: boolean;
    point: Point2D;
    rotationDeg: number;
    snappedWall: { wall: Wall; positionAlongWall: number } | null;
  };
  syncOpeningForSymbol: (
    symbolId: string,
    definition: ArchitecturalObjectDefinition,
    wallSnap: { wall: Wall; positionAlongWall: number },
    dims: {
      openingWidthMm: number;
      openingHeightMm: number;
      sillHeightMm: number;
    },
  ) => void;
  buildHostedOpeningSymbolProperties: (
    definition: ArchitecturalObjectDefinition,
    wall: Wall,
    positionAlongWall: number,
    existingProperties: Record<string, unknown> | undefined,
    openingWidthMm: number,
    openingHeightMm: number,
    sillHeightMm: number,
  ) => Record<string, unknown>;
  computeHvacPlacement: (
    position: Point2D,
    source: AcEquipmentDefinition | HvacElement,
  ) => {
    center: Point2D;
    point: Point2D;
    rotationDeg: number;
    valid: boolean;
    roomId: string | null;
    wallId: string | null;
    invalidReason: string | null;
    widthMm: number;
    depthMm: number;
    heightMm: number;
    placementProperties?: Record<string, unknown>;
  };
  resolveOpeningWidthMm: (
    definition: ArchitecturalObjectDefinition,
    properties?: Record<string, unknown>,
  ) => number;
  resolveOpeningHeightMm: (
    definition: ArchitecturalObjectDefinition,
    properties?: Record<string, unknown>,
  ) => number;
  resolveOpeningSillHeightMm: (
    definition: ArchitecturalObjectDefinition,
    properties?: Record<string, unknown>,
  ) => number;
  hasFurnitureCollision: (
    position: Point2D,
    definition: ArchitecturalObjectDefinition,
    options?: { ignoreSymbolId?: string },
  ) => boolean;

  // Opening interaction
  beginOpeningPointerInteraction: (
    interaction: OpeningPointerInteraction,
  ) => void;
  finishOpeningPointerInteraction: () => void;

  // Context menus
  closeWallContextMenu: () => void;
  closeDimensionContextMenu: () => void;
  closeSectionLineContextMenu: () => void;
  closeObjectContextMenu: () => void;

  // Store actions
  setSelectedIds: (ids: string[]) => void;
  setHoveredElement: (id: string | null) => void;
  setTool: (tool: DrawingTool) => void;
  setProcessingStatus: (message: string, loading: boolean) => void;
  saveToHistory: (description: string) => void;
  updateSymbol: (id: string, updates: Partial<SymbolInstance2D>) => void;
  updateHvacElement: (
    id: string,
    updates: Partial<HvacElement>,
    options?: { skipHistory?: boolean },
  ) => void;
  placePendingObject: (cursor: Point2D) => boolean;
  placePendingHvacElement: (cursor: Point2D) => boolean;
  onCancelObjectPlacement?: (() => void) | null;
  onCancelEquipmentPlacement?: (() => void) | null;

  // Local state setters
  setOpeningInteractionActive: (active: boolean) => void;
  setMarqueeSelectionMode: (mode: "window" | "crossing") => void;
  setPersistentRoomControlId: (id: string | null) => void;
  setPlacementRotationDeg: Dispatch<SetStateAction<number>>;
  setWallContextMenu: (state: WallContextMenuState) => void;
  setDimensionContextMenu: (state: DimensionContextMenuState) => void;
  setSectionLineContextMenu: (state: SectionLineContextMenuState) => void;
  setObjectContextMenu: (state: ObjectContextMenuState) => void;

  // Section-line actions
  cancelSectionLineDrawing: () => void;
  commitSectionLine: () => void;
  setSectionLineDirection: (direction: SectionLineDirection) => void;

  // Nudge
  nudgeSelectedObjects: (dx: number, dy: number) => boolean;

  // Wall renderer
  wallRenderer: WallRenderer | null;
}

// =============================================================================
// Result
// =============================================================================

export interface UseCanvasEventBindingResult {
  // Currently returns nothing – the effect is purely side-effectful.
}

// =============================================================================
// Hook
// =============================================================================

export function useCanvasEventBinding(
  options: UseCanvasEventBindingOptions,
): UseCanvasEventBindingResult {
  const latestOptionsRef = useRef(options);
  latestOptionsRef.current = options;
  const { fabricRef, outerRef, wheelRafId } = options;

  const syncConnectedRefrigerantPipes = useCallback(
    (
      elements: HvacElement[],
      movedElement: HvacElement,
      updateHvacElement: UseCanvasEventBindingOptions["updateHvacElement"],
    ) => {
      const connectedPipeUpdates =
        resolveRefrigerantPipeUnitPortReconnectionUpdates(
          elements,
          movedElement,
        );
      connectedPipeUpdates.forEach((pipeUpdate) => {
        if (pipeUpdate.id === movedElement.id) {
          return;
        }
        updateHvacElement(pipeUpdate.id, pipeUpdate.updates, {
          skipHistory: true,
        });
      });
    },
    [],
  );

  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;

    const upperCanvasEl = canvas.upperCanvasEl;
    const handleMouseDownProxy = (
      event: fabric.TPointerEventInfo<fabric.TPointerEvent>,
    ) => {
      latestOptionsRef.current.handleMouseDown(event);
    };
    const handleMouseMoveProxy = (
      event: fabric.TPointerEventInfo<fabric.TPointerEvent>,
    ) => {
      latestOptionsRef.current.handleMouseMove(event);
    };
    const handleMouseUpProxy = () => {
      latestOptionsRef.current.handleMouseUp();
    };
    const handleWheelProxy = (event: fabric.TPointerEventInfo<WheelEvent>) => {
      latestOptionsRef.current.handleWheel(event);
    };
    const handleMiddleMouseDownProxy = (event: MouseEvent) => {
      latestOptionsRef.current.handleMiddleMouseDown(event);
    };
    const handleMiddleMouseMoveProxy = (event: MouseEvent) => {
      latestOptionsRef.current.handleMiddleMouseMove(event);
    };
    const handleMiddleMouseUpProxy = (event: MouseEvent) => {
      latestOptionsRef.current.handleMiddleMouseUp(event);
    };
    const preventMiddleAuxClickProxy = (event: MouseEvent) => {
      latestOptionsRef.current.preventMiddleAuxClick(event);
    };

    const handleCanvasDoubleClick = (event: MouseEvent) => {
      const {
        tool,
        handleDimensionDoubleClick,
        handleSelectDoubleClick,
        handleDuctDoubleClick,
        handleRefrigerantPipeDoubleClick,
        resolveRoomIdFromTarget,
        setSelectedIds,
        handleWallDoubleClick,
      } = latestOptionsRef.current;
      const target = canvas.findTarget(
        event as unknown as fabric.TPointerEvent,
      );
      if (tool === "select") {
        const dimensionHandled = handleDimensionDoubleClick(
          (target as fabric.Object | null | undefined) ?? null,
        );
        if (dimensionHandled) {
          return;
        }
        const selectHandled = handleSelectDoubleClick(event);
        if (selectHandled) {
          return;
        }
        const roomId = resolveRoomIdFromTarget(target ?? null);
        if (roomId && typeof window !== "undefined") {
          setSelectedIds([roomId]);
          window.dispatchEvent(
            new CustomEvent("smart-drawing:open-room-properties"),
          );
        }
      }
      if (tool === "wall" || tool === "partition-wall") {
        handleWallDoubleClick();
        return;
      }
      if (tool === "refrigerant-pipe") {
        handleRefrigerantPipeDoubleClick();
      }
      if (tool === "duct") {
        handleDuctDoubleClick();
      }
    };

    // Wall tool keyboard handlers
    const handleWallKeyDown = (e: KeyboardEvent) => {
      const {
        pendingPlacementDefinition,
        pendingPlacementEquipmentDefinition,
        onCancelObjectPlacement,
        onCancelEquipmentPlacement,
        objectRendererRef,
        hvacRendererRef,
        placementCursorRef,
        placePendingObject,
        placePendingHvacElement,
        setPlacementRotationDeg,
        tool,
        handleWallToolKeyDown,
        nudgeSelectedObjects,
        cancelSectionLineDrawing,
        sectionLineDrawingState,
        commitSectionLine,
        setSectionLineDirection,
        handleDimensionKeyDown,
        handleDuctKeyDown,
        handleRefrigerantPipeKeyDown,
        offsetTool,
        setTool,
        trimTool,
        extendTool,
      } = latestOptionsRef.current;
      if (pendingPlacementDefinition || pendingPlacementEquipmentDefinition) {
        if (e.key === "Escape") {
          onCancelObjectPlacement?.();
          onCancelEquipmentPlacement?.();
          objectRendererRef.current?.clearPlacementPreview();
          hvacRendererRef.current?.clearPlacementPreview();
          e.preventDefault();
          return;
        }
        if (e.key.toLowerCase() === "r") {
          const step = e.shiftKey ? 15 : 90;
          setPlacementRotationDeg(
            (prev) => (((prev + step) % 360) + 360) % 360,
          );
          e.preventDefault();
          return;
        }
        if (e.key === "Enter" && placementCursorRef.current) {
          const handled = pendingPlacementEquipmentDefinition
            ? placePendingHvacElement(placementCursorRef.current)
            : placePendingObject(placementCursorRef.current);
          if (handled) {
            e.preventDefault();
            return;
          }
        }
      }

      if (tool === "wall" || tool === "partition-wall") {
        handleWallToolKeyDown(e);
        return;
      }
      if (tool === "select") {
        const arrowStep = e.shiftKey ? 1 : 10;
        if (e.key === "ArrowUp") {
          if (nudgeSelectedObjects(0, -arrowStep)) e.preventDefault();
          return;
        }
        if (e.key === "ArrowDown") {
          if (nudgeSelectedObjects(0, arrowStep)) e.preventDefault();
          return;
        }
        if (e.key === "ArrowLeft") {
          if (nudgeSelectedObjects(-arrowStep, 0)) e.preventDefault();
          return;
        }
        if (e.key === "ArrowRight") {
          if (nudgeSelectedObjects(arrowStep, 0)) e.preventDefault();
          return;
        }
      }
      if (tool === "section-line") {
        if (e.key === "Escape") {
          cancelSectionLineDrawing();
          e.preventDefault();
          return;
        }
        if (e.key === "Enter" && sectionLineDrawingState.isDrawing) {
          commitSectionLine();
          e.preventDefault();
          return;
        }
        if (e.key.toLowerCase() === "f") {
          const nextDirection =
            sectionLineDrawingState.direction === 1 ? -1 : 1;
          setSectionLineDirection(nextDirection);
          e.preventDefault();
        }
        return;
      }
      if (tool === "refrigerant-pipe") {
        const handled = handleRefrigerantPipeKeyDown(e);
        if (e.key === "Escape") {
          e.preventDefault();
          setTool("select");
          return;
        }
        if (handled) {
          e.preventDefault();
        }
        return;
      }
      if (tool === "duct") {
        const handled = handleDuctKeyDown(e);
        if (e.key === "Escape") {
          e.preventDefault();
          setTool("select");
          return;
        }
        if (handled) {
          e.preventDefault();
        }
        return;
      }
      if (tool === "dimension") {
        const handled = handleDimensionKeyDown(e);
        if (handled) {
          e.preventDefault();
        }
      }
      if (tool === "offset") {
        const handled = offsetTool.handleKeyDown(e);
        if (handled) {
          e.preventDefault();
        }
      }
      if (tool === "trim") {
        const handled = trimTool.handleKeyDown(e);
        if (handled) {
          e.preventDefault();
        }
      }
      if (tool === "extend") {
        const handled = extendTool.handleKeyDown(e);
        if (handled) {
          e.preventDefault();
        }
      }
    };
    const handleWallKeyUp = (e: KeyboardEvent) => {
      const {
        tool,
        handleWallToolKeyUp,
        handleDuctKeyUp,
        handleRefrigerantPipeKeyUp,
      } = latestOptionsRef.current;
      if (tool === "wall" || tool === "partition-wall") {
        handleWallToolKeyUp(e);
        return;
      }
      if (tool === "duct") {
        handleDuctKeyUp(e);
        return;
      }
      if (tool === "refrigerant-pipe") {
        handleRefrigerantPipeKeyUp(e);
      }
    };

    const handleSelectionCreated = (
      event: fabric.CanvasEvents["selection:created"],
    ) => {
      const {
        tool,
        projectionViewOnly,
        suppressFabricSelectionSyncRef,
        openingPointerInteractionRef,
        setPersistentRoomControlId,
        setSelectedIds,
        filterMarqueeSelectionTargets,
        applyMarqueeFilterRef,
        resolveObjectIdFromTarget,
        resolveHvacIdFromTarget,
        resolveRoomIdFromTarget,
        updateSelectionFromTargets,
      } = latestOptionsRef.current;
      if (tool !== "select" || projectionViewOnly) return;
      hideActiveSelectionChrome(canvas);
      const nativeEvent = event.e as MouseEvent | PointerEvent | undefined;
      if (
        nativeEvent?.shiftKey ||
        nativeEvent?.ctrlKey ||
        nativeEvent?.metaKey
      ) {
        return;
      }
      if (suppressFabricSelectionSyncRef.current > 0) {
        suppressFabricSelectionSyncRef.current -= 1;
        return;
      }
      const openingInteraction = openingPointerInteractionRef.current;
      if (openingInteraction) {
        setPersistentRoomControlId(null);
        setSelectedIds([openingInteraction.openingId]);
        return;
      }
      const targets = filterMarqueeSelectionTargets(event.selected ?? []);
      applyMarqueeFilterRef.current = false;
      const objectIds = targets
        .map((target) => resolveObjectIdFromTarget(target))
        .filter((id): id is string => Boolean(id));
      const hvacIds = targets
        .map((target) => resolveHvacIdFromTarget(target))
        .filter((id): id is string => Boolean(id));
      const directlySelectableIds = Array.from(
        new Set([...objectIds, ...hvacIds]),
      );
      if (directlySelectableIds.length > 0) {
        setPersistentRoomControlId(null);
        setSelectedIds(directlySelectableIds);
        return;
      }
      const roomIds = targets
        .map((target) => resolveRoomIdFromTarget(target))
        .filter((id): id is string => Boolean(id));
      if (roomIds.length > 0) {
        const roomSelectionIds = Array.from(new Set(roomIds));
        if (roomSelectionIds.length > 0) {
          setPersistentRoomControlId(roomIds[0] ?? null);
          setSelectedIds(roomSelectionIds);
          return;
        }
      }
      setPersistentRoomControlId(null);
      updateSelectionFromTargets(targets);
    };

    const handleSelectionUpdated = (
      event: fabric.CanvasEvents["selection:updated"],
    ) => {
      const {
        tool,
        projectionViewOnly,
        suppressFabricSelectionSyncRef,
        openingPointerInteractionRef,
        setPersistentRoomControlId,
        setSelectedIds,
        filterMarqueeSelectionTargets,
        applyMarqueeFilterRef,
        resolveObjectIdFromTarget,
        resolveHvacIdFromTarget,
        resolveRoomIdFromTarget,
        updateSelectionFromTargets,
      } = latestOptionsRef.current;
      if (tool !== "select" || projectionViewOnly) return;
      hideActiveSelectionChrome(canvas);
      const nativeEvent = event.e as MouseEvent | PointerEvent | undefined;
      if (
        nativeEvent?.shiftKey ||
        nativeEvent?.ctrlKey ||
        nativeEvent?.metaKey
      ) {
        return;
      }
      if (suppressFabricSelectionSyncRef.current > 0) {
        suppressFabricSelectionSyncRef.current -= 1;
        return;
      }
      const openingInteraction = openingPointerInteractionRef.current;
      if (openingInteraction) {
        setPersistentRoomControlId(null);
        setSelectedIds([openingInteraction.openingId]);
        return;
      }
      const targets = filterMarqueeSelectionTargets(event.selected ?? []);
      applyMarqueeFilterRef.current = false;
      const objectIds = targets
        .map((target) => resolveObjectIdFromTarget(target))
        .filter((id): id is string => Boolean(id));
      const hvacIds = targets
        .map((target) => resolveHvacIdFromTarget(target))
        .filter((id): id is string => Boolean(id));
      const directlySelectableIds = Array.from(
        new Set([...objectIds, ...hvacIds]),
      );
      if (directlySelectableIds.length > 0) {
        setPersistentRoomControlId(null);
        setSelectedIds(directlySelectableIds);
        return;
      }
      const roomIds = targets
        .map((target) => resolveRoomIdFromTarget(target))
        .filter((id): id is string => Boolean(id));
      if (roomIds.length > 0) {
        const roomSelectionIds = Array.from(new Set(roomIds));
        if (roomSelectionIds.length > 0) {
          setPersistentRoomControlId(roomIds[0] ?? null);
          setSelectedIds(roomSelectionIds);
          return;
        }
      }
      setPersistentRoomControlId(null);
      updateSelectionFromTargets(targets);
    };

    const handleSelectionCleared = (
      event: fabric.CanvasEvents["selection:cleared"],
    ) => {
      const {
        projectionViewOnly,
        suppressFabricSelectionSyncRef,
        applyMarqueeFilterRef,
        openingPointerInteractionRef,
        setPersistentRoomControlId,
        setSelectedIds,
        isWallHandleDraggingRef,
      } = latestOptionsRef.current;
      if (projectionViewOnly) return;

      const nativeEvent = event?.e as MouseEvent | PointerEvent | undefined;
      if (
        nativeEvent?.shiftKey ||
        nativeEvent?.ctrlKey ||
        nativeEvent?.metaKey
      ) {
        return;
      }
      if (suppressFabricSelectionSyncRef.current > 0) {
        suppressFabricSelectionSyncRef.current -= 1;
        return;
      }
      applyMarqueeFilterRef.current = false;
      const openingInteraction = openingPointerInteractionRef.current;
      if (openingInteraction) {
        setPersistentRoomControlId(null);
        setSelectedIds([openingInteraction.openingId]);
        return;
      }
      if (!isWallHandleDraggingRef.current) {
        setPersistentRoomControlId(null);
        setSelectedIds([]);
      }
    };

    const handleCanvasMouseDown = (
      event: fabric.CanvasEvents["mouse:down"],
    ) => {
      const {
        closeWallContextMenu,
        closeDimensionContextMenu,
        closeSectionLineContextMenu,
        closeObjectContextMenu,
        projectionViewOnly,
        pendingPlacementDefinition,
        pendingPlacementEquipmentDefinition,
        tool,
        suppressFabricSelectionSyncRef,
        openingPointerInteractionRef,
        setOpeningInteractionActive,
        resolveOpeningResizeHandleFromTarget,
        setPersistentRoomControlId,
        marqueeSelectionRef,
        lastMarqueeSelectionRef,
        applyMarqueeFilterRef,
        setMarqueeSelectionMode,
        setSelectedIds,
        setHoveredElement,
        walls,
        beginOpeningPointerInteraction,
        findOpeningAtPoint,
        resolveOpeningIdFromTarget,
        projectPointToSegment,
        resolveSectionLineIdFromTarget,
        hvacRendererRef,
        resolveHvacIdFromTarget,
        resolveObjectIdFromTarget,
        getTargetMeta,
        resolveWallIdFromTarget,
        wallRenderer,
        roomRendererRef,
        resolveRoomIdFromTarget,
        roomById,
        roomBoundaryDistance,
        wallById,
        selectWallSegmentAtPoint,
        handleDimensionSelectMouseDown,
        updateSelectionFromTarget,
        handleSelectMouseDown,
        selectedIds,
      } = latestOptionsRef.current;
      closeWallContextMenu();
      closeDimensionContextMenu();
      closeSectionLineContextMenu();
      closeObjectContextMenu();
      if (projectionViewOnly) {
        setHoveredElement(null);
        return;
      }
      if (pendingPlacementDefinition || pendingPlacementEquipmentDefinition)
        return;
      if (tool !== "select") return;
      suppressFabricSelectionSyncRef.current = 0;
      const suppressNextFabricSelectionSync = (count: number = 3) => {
        suppressFabricSelectionSyncRef.current = Math.max(
          suppressFabricSelectionSyncRef.current,
          count,
        );
      };
      const getLiveSelectedSet = () =>
        new Set(useSmartDrawingStore.getState().selectedElementIds);
      const toggleSelectedId = (id: string) => {
        const current = getLiveSelectedSet();
        if (current.has(id)) {
          current.delete(id);
        } else {
          current.add(id);
        }
        setSelectedIds(Array.from(current));
      };
      const toggleSelectedIds = (ids: string[]) => {
        const current = getLiveSelectedSet();
        const alreadySelected = ids.every((id) => current.has(id));
        ids.forEach((id) => {
          if (alreadySelected) {
            current.delete(id);
          } else {
            current.add(id);
          }
        });
        setSelectedIds(Array.from(current));
      };
      const hitTarget =
        (event.target as fabric.Object | null | undefined) ??
        (event.e
          ? canvas.findTarget(event.e as unknown as fabric.TPointerEvent)
          : null) ??
        null;
      const subTargets =
        (
          event as fabric.CanvasEvents["mouse:down"] & {
            subTargets?: fabric.Object[];
          }
        ).subTargets ?? [];
      const candidateTargets = [
        ...subTargets,
        ...(hitTarget ? [hitTarget] : []),
      ];
      const addToSelection = Boolean(
        event.e?.shiftKey || event.e?.ctrlKey || event.e?.metaKey,
      );
      const scenePoint = event.e ? canvas.getScenePoint(event.e) : null;
      const hvacIdAtCanvasPoint = scenePoint
        ? hvacRendererRef.current?.findElementAtCanvasPoint({
            x: scenePoint.x,
            y: scenePoint.y,
          }) ?? null
        : null;
      const wallPoint = scenePoint
        ? {
            x: scenePoint.x / MM_TO_PX,
            y: scenePoint.y / MM_TO_PX,
          }
        : null;
      openingPointerInteractionRef.current = null;
      setOpeningInteractionActive(false);
      const openingResizeHandle =
        candidateTargets
          .map((target) => resolveOpeningResizeHandleFromTarget(target))
          .find((entry): entry is OpeningResizeHandleHit => Boolean(entry)) ??
        null;
      if (openingResizeHandle) {
        suppressNextFabricSelectionSync();
        setPersistentRoomControlId(null);
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
        setSelectedIds([openingResizeHandle.openingId]);
        setHoveredElement(openingResizeHandle.openingId);
        const hostWall =
          walls.find((wall) => wall.id === openingResizeHandle.wallId) ??
          walls.find((wall) =>
            wall.openings.some(
              (opening) => opening.id === openingResizeHandle.openingId,
            ),
          );
        const hostOpening = hostWall?.openings.find(
          (opening) => opening.id === openingResizeHandle.openingId,
        );
        if (hostWall && hostOpening) {
          const anchorEdgeAlongWall =
            openingResizeHandle.side === "start"
              ? hostOpening.position + hostOpening.width / 2
              : hostOpening.position - hostOpening.width / 2;
          beginOpeningPointerInteraction({
            openingId: openingResizeHandle.openingId,
            mode:
              openingResizeHandle.side === "start"
                ? "resize-start"
                : "resize-end",
            wallId: hostWall.id,
            anchorEdgeAlongWall,
            changed: false,
          });
        }
        return;
      }

      const inferredOpening = wallPoint ? findOpeningAtPoint(wallPoint) : null;
      const openingVisualId =
        candidateTargets
          .map((target) => resolveOpeningIdFromTarget(target))
          .find((entry): entry is string => Boolean(entry)) ??
        resolveOpeningIdFromTarget(hitTarget) ??
        inferredOpening?.openingId ??
        null;
      if (openingVisualId) {
        suppressNextFabricSelectionSync();
        setPersistentRoomControlId(null);
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
        if (addToSelection) {
          toggleSelectedId(openingVisualId);
        } else {
          setSelectedIds([openingVisualId]);
        }
        setHoveredElement(openingVisualId);
        if (!addToSelection) {
          const hostWall =
            inferredOpening?.openingId === openingVisualId
              ? walls.find((wall) => wall.id === inferredOpening.wallId)
              : undefined;
          const fallbackWall = walls.find((wall) =>
            wall.openings.some((opening) => opening.id === openingVisualId),
          );
          const linkedWall = hostWall ?? fallbackWall;
          const linkedOpening = linkedWall?.openings.find(
            (opening) => opening.id === openingVisualId,
          );
          let grabOffsetAlongWallMm = 0;

          if (linkedWall && linkedOpening && wallPoint) {
            const wallLength = Math.hypot(
              linkedWall.endPoint.x - linkedWall.startPoint.x,
              linkedWall.endPoint.y - linkedWall.startPoint.y,
            );
            if (Number.isFinite(wallLength) && wallLength > 0.001) {
              const projection = projectPointToSegment(
                wallPoint,
                linkedWall.startPoint,
                linkedWall.endPoint,
              );
              const pointerAlongWall = projection.t * wallLength;
              const rawOffset = pointerAlongWall - linkedOpening.position;
              grabOffsetAlongWallMm = clampValue(
                rawOffset,
                -linkedOpening.width / 2,
                linkedOpening.width / 2,
              );
            }
          }

          beginOpeningPointerInteraction({
            openingId: openingVisualId,
            mode: "move",
            wallId: linkedWall?.id,
            grabOffsetAlongWallMm,
            changed: false,
          });
        }
        return;
      }

      const sectionLineId =
        candidateTargets
          .map((target) => resolveSectionLineIdFromTarget(target))
          .find((entry): entry is string => Boolean(entry)) ??
        resolveSectionLineIdFromTarget(hitTarget);
      if (sectionLineId) {
        suppressNextFabricSelectionSync();
        setPersistentRoomControlId(null);
        if (addToSelection) {
          toggleSelectedId(sectionLineId);
        } else {
          setSelectedIds([sectionLineId]);
        }
        setHoveredElement(sectionLineId);
        return;
      }

      const objectId =
        candidateTargets
          .map((target) => resolveObjectIdFromTarget(target))
          .find((entry): entry is string => Boolean(entry)) ??
        resolveObjectIdFromTarget(hitTarget);
      if (objectId) {
        suppressNextFabricSelectionSync();
        setPersistentRoomControlId(null);
        if (addToSelection) {
          toggleSelectedId(objectId);
        } else {
          setSelectedIds([objectId]);
        }
        setHoveredElement(objectId);
        return;
      }

      const prioritizedControlTarget =
        candidateTargets.find((target) => {
          const meta = getTargetMeta(
            target as fabric.Object | null | undefined,
          );
          return Boolean(
            meta.isWallControl || meta.isRoomControl || meta.isPipeControl,
          );
        }) ?? null;

      if (!scenePoint) {
        updateSelectionFromTarget(prioritizedControlTarget ?? hitTarget);
        return;
      }

      const wallPointMm = {
        x: scenePoint.x / MM_TO_PX,
        y: scenePoint.y / MM_TO_PX,
      };

      if (prioritizedControlTarget) {
        suppressNextFabricSelectionSync();
        const prioritizedMeta = getTargetMeta(prioritizedControlTarget);
        if (prioritizedMeta.roomId) {
          setPersistentRoomControlId(prioritizedMeta.roomId);
        } else if (!prioritizedMeta.isRoomControl) {
          setPersistentRoomControlId(null);
        }
        handleSelectMouseDown(
          prioritizedControlTarget,
          wallPointMm,
          addToSelection,
        );
        return;
      }

      const hvacId =
        candidateTargets
          .map((target) => resolveHvacIdFromTarget(target))
          .find((entry): entry is string => Boolean(entry)) ??
        resolveHvacIdFromTarget(hitTarget) ??
        hvacIdAtCanvasPoint;
      if (hvacId) {
        suppressNextFabricSelectionSync();
        setPersistentRoomControlId(null);
        if (addToSelection) {
          toggleSelectedId(hvacId);
        } else {
          setSelectedIds([hvacId]);
        }
        setHoveredElement(hvacId);
        return;
      }

      const prioritizedDimensionControlTarget =
        candidateTargets.find((target) => {
          const typed = target as fabric.Object & {
            isDimensionControl?: boolean;
          };
          return Boolean(typed.isDimensionControl);
        }) ?? null;
      const targetMeta = getTargetMeta(
        hitTarget,
      );
      const directWallId =
        candidateTargets
          .map((target) => resolveWallIdFromTarget(target))
          .find((entry): entry is string => Boolean(entry)) ??
        resolveWallIdFromTarget(hitTarget);
      const clickedWallId =
        directWallId ?? wallRenderer?.getWallIdAtPoint(wallPointMm) ?? null;
      const clickedRoomId =
        roomRendererRef.current?.getRoomIdAtPoint(wallPointMm) ??
        resolveRoomIdFromTarget(hitTarget);
      const clickedRoom = clickedRoomId
        ? (roomById.get(clickedRoomId) ?? null)
        : null;
      const roomInteriorDistance = clickedRoom
        ? roomBoundaryDistance(wallPointMm, clickedRoom.vertices)
        : Number.POSITIVE_INFINITY;
      const roomWallThicknesses = clickedRoom
        ? clickedRoom.wallIds
            .map((wId) => wallById.get(wId)?.thickness)
            .filter((value): value is number => Number.isFinite(value))
        : [];
      const roomInteriorThreshold =
        roomWallThicknesses.length > 0
          ? Math.max(10, Math.min(28, Math.min(...roomWallThicknesses) * 0.35))
          : 14;
      const isRoomAreaClick = roomInteriorDistance > roomInteriorThreshold;
      if (
        clickedRoomId &&
        isRoomAreaClick &&
        !targetMeta.isRoomControl &&
        !targetMeta.isWallControl &&
        !targetMeta.isPipeControl &&
        !targetMeta.wallId
      ) {
        const roomSelectionIds = [clickedRoomId];
        if (roomSelectionIds.length > 0) {
          suppressNextFabricSelectionSync();
          setPersistentRoomControlId(clickedRoomId);
          wallRenderer?.setHoveredWall(null);
          setHoveredElement(clickedRoomId);

          const roomAlreadySelected = selectedIds.includes(clickedRoomId);
          if (roomAlreadySelected && !addToSelection) {
            const syntheticRoomTarget = {
              roomId: clickedRoomId,
              id: clickedRoomId,
              name: `room-${clickedRoomId}`,
            } as unknown as fabric.Object;
            handleSelectMouseDown(syntheticRoomTarget, wallPointMm, false);
          } else if (addToSelection) {
            toggleSelectedIds(roomSelectionIds);
          } else {
            setSelectedIds(roomSelectionIds);
          }
          return;
        }
      }
      if (clickedWallId) {
        const selectedWallId = selectWallSegmentAtPoint(
          clickedWallId,
          wallPointMm,
        );
        suppressNextFabricSelectionSync();
        setPersistentRoomControlId(null);
        if (addToSelection) {
          canvas.discardActiveObject();
          toggleSelectedId(selectedWallId);
        } else {
          setSelectedIds([selectedWallId]);
        }
        wallRenderer?.setHoveredWall(selectedWallId);
        setHoveredElement(selectedWallId);
        return;
      }
      const dimensionHandled = handleDimensionSelectMouseDown(
        prioritizedDimensionControlTarget ?? hitTarget,
        wallPointMm,
        addToSelection,
      );
      if (dimensionHandled) {
        suppressNextFabricSelectionSync();
        setPersistentRoomControlId(null);
        return;
      }
      setPersistentRoomControlId(null);
      handleSelectMouseDown(
        hitTarget,
        wallPointMm,
        addToSelection,
      );
    };

    const handleCanvasContextMenu = (event: MouseEvent) => {
      const {
        tool,
        closeWallContextMenu,
        closeDimensionContextMenu,
        closeSectionLineContextMenu,
        closeObjectContextMenu,
        resolveSectionLineIdFromTarget,
        resolveObjectIdFromTarget,
        wallRenderer,
        setSelectedIds,
        outerRef,
        setWallContextMenu,
        resolveDimensionIdFromTarget,
        setDimensionContextMenu,
        setSectionLineContextMenu,
        setObjectContextMenu,
        resolveWallIdFromTarget,
        selectWallSegmentAtPoint,
        projectionViewOnly,
      } = latestOptionsRef.current;
      if (tool !== "select") {
        closeWallContextMenu();
        closeDimensionContextMenu();
        closeSectionLineContextMenu();
        closeObjectContextMenu();
        return;
      }

      const previousSkipTargetFind = canvas.skipTargetFind;
      if (projectionViewOnly && event.shiftKey) {
        canvas.skipTargetFind = false;
      }
      let target: fabric.Object | undefined;
      try {
        target = canvas.findTarget(
          event as unknown as fabric.TPointerEvent,
        );
      } finally {
        canvas.skipTargetFind = previousSkipTargetFind;
      }
      const scenePoint = canvas.getScenePoint(
        event as unknown as fabric.TPointerEvent,
      );
      const wallPointMm = scenePoint
        ? {
            x: scenePoint.x / MM_TO_PX,
            y: scenePoint.y / MM_TO_PX,
          }
        : null;
      const targetSectionLineId = resolveSectionLineIdFromTarget(
        target ?? null,
      );
      const targetObjectId = resolveObjectIdFromTarget(target ?? null);
      const directWallId = resolveWallIdFromTarget(target ?? null);
      const clickedWallId = wallPointMm
        ? (directWallId ?? wallRenderer?.getWallIdAtPoint(wallPointMm) ?? null)
        : directWallId;
      if (!targetSectionLineId && !targetObjectId && clickedWallId) {
        event.preventDefault();
        event.stopPropagation();
        const selectedWallId = wallPointMm
          ? selectWallSegmentAtPoint(clickedWallId, wallPointMm)
          : clickedWallId;
        setSelectedIds([selectedWallId]);
        closeDimensionContextMenu();
        closeSectionLineContextMenu();
        closeObjectContextMenu();

        const outerRect = outerRef.current?.getBoundingClientRect();
        const x = outerRect ? event.clientX - outerRect.left : event.clientX;
        const y = outerRect ? event.clientY - outerRect.top : event.clientY;
        setWallContextMenu({ wallId: selectedWallId, x, y });
        return;
      }
      const dimensionId = resolveDimensionIdFromTarget(target ?? null);
      if (dimensionId) {
        event.preventDefault();
        event.stopPropagation();
        setSelectedIds([dimensionId]);
        closeWallContextMenu();
        closeSectionLineContextMenu();
        closeObjectContextMenu();

        const outerRect = outerRef.current?.getBoundingClientRect();
        const x = outerRect ? event.clientX - outerRect.left : event.clientX;
        const y = outerRect ? event.clientY - outerRect.top : event.clientY;
        setDimensionContextMenu({ dimensionId, x, y });
        return;
      }

      const sectionLineId = targetSectionLineId;
      if (sectionLineId) {
        event.preventDefault();
        event.stopPropagation();
        setSelectedIds([sectionLineId]);
        closeWallContextMenu();
        closeDimensionContextMenu();
        closeObjectContextMenu();

        const outerRect = outerRef.current?.getBoundingClientRect();
        const x = outerRect ? event.clientX - outerRect.left : event.clientX;
        const y = outerRect ? event.clientY - outerRect.top : event.clientY;
        setSectionLineContextMenu({ sectionLineId, x, y });
        return;
      }

      const contextObjectId = targetObjectId;
      if (contextObjectId) {
        event.preventDefault();
        event.stopPropagation();
        setSelectedIds([contextObjectId]);
        closeWallContextMenu();
        closeDimensionContextMenu();
        closeSectionLineContextMenu();

        const outerRect = outerRef.current?.getBoundingClientRect();
        const x = outerRect ? event.clientX - outerRect.left : event.clientX;
        const y = outerRect ? event.clientY - outerRect.top : event.clientY;
        setObjectContextMenu({ objectId: contextObjectId, x, y });
        return;
      }

      const wallId = resolveWallIdFromTarget(target ?? null);
      if (!wallId) {
        closeWallContextMenu();
        closeDimensionContextMenu();
        closeSectionLineContextMenu();
        closeObjectContextMenu();
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setSelectedIds([wallId]);
      closeDimensionContextMenu();
      closeSectionLineContextMenu();
      closeObjectContextMenu();

      const outerRect = outerRef.current?.getBoundingClientRect();
      const x = outerRect ? event.clientX - outerRect.left : event.clientX;
      const y = outerRect ? event.clientY - outerRect.top : event.clientY;
      setWallContextMenu({ wallId, x, y });
    };

    const handleObjectMoving = (
      event: fabric.CanvasEvents["object:moving"],
    ) => {
      const {
        tool,
        resolveObjectIdFromTarget,
        resolveHvacIdFromTarget,
        isDraggingObjectRef,
        symbols,
        hvacElements,
        objectDefinitionsById,
        resolvedSnapToGrid,
        effectiveSnapGridSize,
        resolveOpeningWidthMm,
        computePlacement,
        computeHvacPlacement,
        hvacRendererRef,
        updateHvacElement,
        handleSelectObjectMoving,
      } = latestOptionsRef.current;
      if (!event.target || tool !== "select") return;

      const objectId = resolveObjectIdFromTarget(event.target);
      if (objectId) {
        const target = event.target as fabric.Object;

        // ── Drag-start optimisation: skip target-find while dragging ──
        if (!isDraggingObjectRef.current) {
          isDraggingObjectRef.current = true;
          // Tell Fabric not to hit-test other objects on every mouse move
          if (canvas) canvas.skipTargetFind = true;
        }

        const instance = symbols.find((entry) => entry.id === objectId);
        const definition = instance
          ? objectDefinitionsById.get(instance.symbolId)
          : undefined;
        const isFurnitureLike =
          definition?.category === "furniture" ||
          definition?.category === "fixtures";

        if (resolvedSnapToGrid && !isFurnitureLike) {
          const center = target.getCenterPoint();
          const snappedPx = snapPointToGrid(
            { x: center.x, y: center.y },
            effectiveSnapGridSize,
          );
          target.set({ left: snappedPx.x, top: snappedPx.y });
        }

        const movedCenter = target.getCenterPoint();
        const movedPositionMm = {
          x: movedCenter.x / MM_TO_PX,
          y: movedCenter.y / MM_TO_PX,
        };

        if (instance && definition) {
          const isOpening =
            definition.category === "doors" ||
            definition.category === "windows";
          if (isOpening) {
            const openingWidthMm = resolveOpeningWidthMm(
              definition,
              instance.properties,
            );
            const snappedPlacement = computePlacement(
              movedPositionMm,
              definition,
              {
                ignoreOpeningId: objectId,
                ignoreSymbolId: objectId,
                openingWidthMm,
              },
            );

            if (!snappedPlacement.valid || !snappedPlacement.snappedWall) {
              target.set({
                left: instance.position.x * MM_TO_PX,
                top: instance.position.y * MM_TO_PX,
                angle: instance.rotation,
              });
              return;
            }

            target.set({
              left: snappedPlacement.point.x * MM_TO_PX,
              top: snappedPlacement.point.y * MM_TO_PX,
              angle: snappedPlacement.rotationDeg,
            });
            return;
          }
        }
        return;
      }

      const hvacId = resolveHvacIdFromTarget(event.target);
      if (hvacId) {
        const target = event.target as fabric.Object;

        if (!isDraggingObjectRef.current) {
          isDraggingObjectRef.current = true;
          if (canvas) canvas.skipTargetFind = true;
        }

        const existing = hvacElements.find((entry) => entry.id === hvacId);
        if (!existing) {
          hvacRendererRef.current?.clearSceneElementOverrides();
          return;
        }

        if (isRefrigerantPipeElementType(existing.type)) {
          const existingCenterMm = {
            x: existing.position.x + existing.width / 2,
            y: existing.position.y + existing.depth / 2,
          };
          hvacRendererRef.current?.clearSceneElementOverrides();
          target.set({
            left: existingCenterMm.x * MM_TO_PX,
            top: existingCenterMm.y * MM_TO_PX,
            angle: existing.rotation,
          });
          fabricRef.current?.requestRenderAll();
          return;
        }

        const movedCenter = target.getCenterPoint();
        const movedCenterMm = {
          x: movedCenter.x / MM_TO_PX,
          y: movedCenter.y / MM_TO_PX,
        };
        const placement = computeHvacPlacement(movedCenterMm, existing);
        if (placement.valid) {
          const nextPosition = placement.point;
          const nextRotation = placement.rotationDeg;
          const nextRoomId = placement.roomId ?? undefined;
          const nextWallId = placement.wallId ?? undefined;
          const nextProperties = placement.placementProperties
            ? {
                ...existing.properties,
                ...placement.placementProperties,
              }
            : existing.properties;
          const changed =
            Math.abs(existing.position.x - nextPosition.x) > 0.01 ||
            Math.abs(existing.position.y - nextPosition.y) > 0.01 ||
            Math.abs(existing.rotation - nextRotation) > 0.01 ||
            Math.abs(existing.width - placement.widthMm) > 0.01 ||
            Math.abs(existing.depth - placement.depthMm) > 0.01 ||
            Math.abs(existing.height - placement.heightMm) > 0.01 ||
            existing.roomId !== nextRoomId ||
            existing.wallId !== nextWallId ||
            nextProperties !== existing.properties;

          if (changed) {
            const movedElement: HvacElement = {
              ...existing,
              position: nextPosition,
              rotation: nextRotation,
              width: placement.widthMm,
              depth: placement.depthMm,
              height: placement.heightMm,
              roomId: nextRoomId,
              wallId: nextWallId,
              properties: nextProperties,
            };
            hvacRendererRef.current?.setSceneElementOverrides([movedElement]);
            syncConnectedRefrigerantPipes(
              hvacElements,
              movedElement,
              updateHvacElement,
            );
          } else {
            hvacRendererRef.current?.clearSceneElementOverrides();
          }

          const inlineAnchorPoint = isRefrigerantBranchKitElement(existing)
            ? normalizeCanvasPoint(
                placement.placementProperties?.branchKitSnapPoint ??
                  existing.properties.branchKitSnapPoint,
              )
            : null;
          if (inlineAnchorPoint) {
            setInlineBranchKitTargetTransform(
              target,
              placement.center,
              placement.rotationDeg,
              inlineAnchorPoint,
            );
          } else {
            target.set({
              left: placement.center.x * MM_TO_PX,
              top: placement.center.y * MM_TO_PX,
              angle: placement.rotationDeg,
            });
          }
        } else {
          hvacRendererRef.current?.clearSceneElementOverrides();
        }
        return;
      }

      handleSelectObjectMoving(event.target);
    };

    const handleObjectModified = (
      event: fabric.CanvasEvents["object:modified"],
    ) => {
      const {
        isDraggingObjectRef,
        resolveObjectIdFromTarget,
        resolveHvacIdFromTarget,
        hvacRendererRef,
        symbols,
        hvacElements,
        objectDefinitionsById,
        resolveOpeningWidthMm,
        resolveOpeningHeightMm,
        resolveOpeningSillHeightMm,
        computePlacement,
        computeHvacPlacement,
        fabricRef,
        setProcessingStatus,
        saveToHistory,
        buildHostedOpeningSymbolProperties,
        syncOpeningForSymbol,
        updateSymbol,
        updateHvacElement,
        hasFurnitureCollision,
        finalizeHandleDrag,
      } = latestOptionsRef.current;
      // ── Drag-end cleanup: restore canvas interactive behaviour ──
      if (isDraggingObjectRef.current) {
        isDraggingObjectRef.current = false;
        if (canvas) canvas.skipTargetFind = false;
      }
      hvacRendererRef.current?.clearSceneElementOverrides();

      if (!event.target) return;
      const objectId = resolveObjectIdFromTarget(event.target);
      if (objectId) {
        const target = event.target as fabric.Object;
        const center = target.getCenterPoint();
        const position = {
          x: center.x / MM_TO_PX,
          y: center.y / MM_TO_PX,
        };
        const rotation = target.angle ?? 0;
        const existing = symbols.find((entry) => entry.id === objectId);
        if (existing) {
          const definition = objectDefinitionsById.get(existing.symbolId);
          if (
            definition &&
            (definition.category === "doors" ||
              definition.category === "windows")
          ) {
            const openingWidthMm = resolveOpeningWidthMm(
              definition,
              existing.properties,
            );
            const openingHeightMm = resolveOpeningHeightMm(
              definition,
              existing.properties,
            );
            const openingSillHeightMm = resolveOpeningSillHeightMm(
              definition,
              existing.properties,
            );
            const placement = computePlacement(position, definition, {
              ignoreOpeningId: objectId,
              ignoreSymbolId: objectId,
              openingWidthMm,
            });

            if (!placement.valid || !placement.snappedWall) {
              target.set({
                left: existing.position.x * MM_TO_PX,
                top: existing.position.y * MM_TO_PX,
                angle: existing.rotation,
              });
              fabricRef.current?.requestRenderAll();
              setProcessingStatus(
                "Move blocked: opening must remain on a valid wall segment.",
                false,
              );
              return;
            }

            const snappedWall = placement.snappedWall.wall;
            const nextRotation = placement.rotationDeg;
            const nextPosition = placement.point;
            const nextProperties = buildHostedOpeningSymbolProperties(
              definition,
              snappedWall,
              placement.snappedWall.positionAlongWall,
              existing.properties,
              openingWidthMm,
              openingHeightMm,
              openingSillHeightMm,
            );

            syncOpeningForSymbol(
              objectId,
              definition,
              {
                wall: snappedWall,
                positionAlongWall: placement.snappedWall.positionAlongWall,
              },
              {
                openingWidthMm,
                openingHeightMm,
                sillHeightMm: openingSillHeightMm,
              },
            );

            const changed =
              Math.abs(existing.position.x - nextPosition.x) > 0.01 ||
              Math.abs(existing.position.y - nextPosition.y) > 0.01 ||
              Math.abs(existing.rotation - nextRotation) > 0.01 ||
              existing.properties?.hostWallId !== nextProperties.hostWallId ||
              Math.abs(
                Number(existing.properties?.widthMm ?? 0) -
                  Number(nextProperties.widthMm ?? 0),
              ) > 0.01 ||
              Math.abs(
                Number(existing.properties?.heightMm ?? 0) -
                  Number(nextProperties.heightMm ?? 0),
              ) > 0.01 ||
              Math.abs(
                Number(existing.properties?.positionAlongWallMm ?? 0) -
                  Number(nextProperties.positionAlongWallMm ?? 0),
              ) > 0.01 ||
              String(existing.properties?.doorOpenSide ?? "") !==
                String(nextProperties.doorOpenSide ?? "");

            if (changed) {
              updateSymbol(objectId, {
                position: nextPosition,
                rotation: nextRotation,
                properties: nextProperties,
              });
            }

            target.set({
              left: nextPosition.x * MM_TO_PX,
              top: nextPosition.y * MM_TO_PX,
              angle: nextRotation,
            });
            fabricRef.current?.requestRenderAll();
            return;
          }

          if (
            definition &&
            (definition.category === "furniture" ||
              definition.category === "fixtures")
          ) {
            const collides = hasFurnitureCollision(position, definition, {
              ignoreSymbolId: objectId,
            });
            if (collides) {
              setProcessingStatus(
                "Warning: furniture overlap detected.",
                false,
              );
            }
          }
        }

        if (
          existing &&
          (Math.abs(existing.position.x - position.x) > 0.01 ||
            Math.abs(existing.position.y - position.y) > 0.01 ||
            Math.abs(existing.rotation - rotation) > 0.01)
        ) {
          updateSymbol(objectId, { position, rotation });
        }
        return;
      }

      const hvacId = resolveHvacIdFromTarget(event.target);
      if (hvacId) {
        const target = event.target as fabric.Object;
        const center = target.getCenterPoint();
        const centerMm = {
          x: center.x / MM_TO_PX,
          y: center.y / MM_TO_PX,
        };
        const existing = hvacElements.find((entry) => entry.id === hvacId);
        if (!existing) {
          return;
        }

        if (isRefrigerantPipeElementType(existing.type)) {
          const existingCenterMm = {
            x: existing.position.x + existing.width / 2,
            y: existing.position.y + existing.depth / 2,
          };
          target.set({
            left: existingCenterMm.x * MM_TO_PX,
            top: existingCenterMm.y * MM_TO_PX,
            angle: existing.rotation,
          });
          fabricRef.current?.requestRenderAll();
          return;
        }

        const placement = computeHvacPlacement(centerMm, existing);
        if (!placement.valid) {
          syncConnectedRefrigerantPipes(
            hvacElements,
            existing,
            updateHvacElement,
          );
          const existingCenterMm = {
            x: existing.position.x + existing.width / 2,
            y: existing.position.y + existing.depth / 2,
          };
          const existingInlineAnchorPoint = isRefrigerantBranchKitElement(existing)
            ? normalizeCanvasPoint(existing.properties.branchKitSnapPoint)
            : null;
          if (existingInlineAnchorPoint) {
            setInlineBranchKitTargetTransform(
              target,
              existingCenterMm,
              existing.rotation,
              existingInlineAnchorPoint,
            );
          } else {
            target.set({
              left: existingCenterMm.x * MM_TO_PX,
              top: existingCenterMm.y * MM_TO_PX,
              angle: existing.rotation,
            });
          }
          fabricRef.current?.requestRenderAll();
          setProcessingStatus(
            placement.invalidReason ??
              "Move blocked: AC equipment cannot be placed there.",
            false,
          );
          return;
        }

        const nextPosition = placement.point;
        const nextRotation = placement.rotationDeg;
        const nextRoomId = placement.roomId ?? undefined;
        const nextWallId = placement.wallId ?? undefined;
        const nextProperties = placement.placementProperties
          ? {
              ...existing.properties,
              ...placement.placementProperties,
            }
          : existing.properties;
        const changed =
          Math.abs(existing.position.x - nextPosition.x) > 0.01 ||
          Math.abs(existing.position.y - nextPosition.y) > 0.01 ||
          Math.abs(existing.rotation - nextRotation) > 0.01 ||
          Math.abs(existing.width - placement.widthMm) > 0.01 ||
          Math.abs(existing.depth - placement.depthMm) > 0.01 ||
          Math.abs(existing.height - placement.heightMm) > 0.01 ||
          existing.roomId !== nextRoomId ||
          existing.wallId !== nextWallId ||
          nextProperties !== existing.properties;

        if (changed) {
          const movedElement: HvacElement = {
            ...existing,
            position: nextPosition,
            rotation: nextRotation,
            width: placement.widthMm,
            depth: placement.depthMm,
            height: placement.heightMm,
            roomId: nextRoomId ?? undefined,
            wallId: nextWallId ?? undefined,
            properties: nextProperties,
          };
          updateHvacElement(
            hvacId,
            {
              position: nextPosition,
              rotation: nextRotation,
              width: placement.widthMm,
              depth: placement.depthMm,
              height: placement.heightMm,
              roomId: nextRoomId,
              wallId: nextWallId,
              properties: nextProperties,
            },
            { skipHistory: true },
          );
          syncConnectedRefrigerantPipes(
            hvacElements,
            movedElement,
            updateHvacElement,
          );
          saveToHistory("Update AC equipment");
        }

        const nextInlineAnchorPoint = isRefrigerantBranchKitElement(existing)
          ? normalizeCanvasPoint(
              placement.placementProperties?.branchKitSnapPoint ??
                nextProperties.branchKitSnapPoint,
            )
          : null;
        if (nextInlineAnchorPoint) {
          setInlineBranchKitTargetTransform(
            target,
            placement.center,
            nextRotation,
            nextInlineAnchorPoint,
          );
        } else {
          target.set({
            left: placement.center.x * MM_TO_PX,
            top: placement.center.y * MM_TO_PX,
            angle: nextRotation,
          });
        }
        fabricRef.current?.requestRenderAll();
        return;
      }
      finalizeHandleDrag();
    };

    const handleObjectRotating = (
      event: fabric.CanvasEvents["object:rotating"],
    ) => {
      const { tool, resolveObjectIdFromTarget, setProcessingStatus } =
        latestOptionsRef.current;
      if (!event.target || tool !== "select") return;
      const objectId = resolveObjectIdFromTarget(event.target);
      if (!objectId) return;
      const nativeEvent = event.e as MouseEvent | undefined;
      const normalizeAngle = (value: number) => ((value % 360) + 360) % 360;
      const majorAngles = [0, 45, 90, 135, 180, 225, 270, 315];
      const currentAngle = normalizeAngle(event.target.angle ?? 0);
      const nearestMajorAngle = majorAngles.reduce((best, candidate) => {
        const candidateDelta = Math.abs(candidate - currentAngle);
        const wrappedDelta = Math.min(candidateDelta, 360 - candidateDelta);
        const bestDelta = Math.abs(best - currentAngle);
        const wrappedBestDelta = Math.min(bestDelta, 360 - bestDelta);
        return wrappedDelta < wrappedBestDelta ? candidate : best;
      }, majorAngles[0] ?? 0);
      const snapToIncrement = nativeEvent?.shiftKey || nativeEvent?.ctrlKey;
      if (snapToIncrement) {
        event.target.set("angle", Math.round(currentAngle / 15) * 15);
      } else {
        const delta = Math.abs(nearestMajorAngle - currentAngle);
        const wrappedDelta = Math.min(delta, 360 - delta);
        if (wrappedDelta <= 4) {
          event.target.set("angle", nearestMajorAngle);
        }
      }
      const liveAngle = (((event.target.angle ?? 0) % 360) + 360) % 360;
      setProcessingStatus(`Object rotation: ${liveAngle.toFixed(1)}deg`, false);
    };

    const handleWindowBlur = () => {
      latestOptionsRef.current.hvacRendererRef.current?.clearSceneElementOverrides();
      latestOptionsRef.current.stopMiddlePan();
      latestOptionsRef.current.finalizeHandleDrag();
      latestOptionsRef.current.finishOpeningPointerInteraction();
    };

    const handleSelectDragMouseMove = (event: MouseEvent) => {
      const { tool, isWallHandleDraggingRef, handleSelectMouseMove } =
        latestOptionsRef.current;
      if (tool !== "select") return;
      if (!isWallHandleDraggingRef.current) return;
      if (
        upperCanvasEl &&
        event.target instanceof Node &&
        upperCanvasEl.contains(event.target)
      ) {
        return;
      }
      const scenePoint = canvas.getScenePoint(
        event as unknown as fabric.TPointerEvent,
      );
      const selectPoint = {
        x: scenePoint.x / MM_TO_PX,
        y: scenePoint.y / MM_TO_PX,
      };
      handleSelectMouseMove(selectPoint, null);
    };

    const handleCanvasMouseLeave = () => {
      const { wallRenderer, setHoveredElement } = latestOptionsRef.current;
      wallRenderer?.setHoveredWall(null);
      setHoveredElement(null);
    };

    canvas.on("mouse:down", handleMouseDownProxy);
    canvas.on("mouse:move", handleMouseMoveProxy);
    canvas.on("mouse:up", handleMouseUpProxy);
    canvas.on("mouse:wheel", handleWheelProxy);
    canvas.on("selection:created", handleSelectionCreated);
    canvas.on("selection:updated", handleSelectionUpdated);
    canvas.on("selection:cleared", handleSelectionCleared);
    canvas.on("mouse:down", handleCanvasMouseDown);
    canvas.on("object:moving", handleObjectMoving);
    canvas.on("object:rotating", handleObjectRotating);
    canvas.on("object:modified", handleObjectModified);
    window.addEventListener("mouseup", handleMouseUpProxy);

    upperCanvasEl?.addEventListener("mousedown", handleMiddleMouseDownProxy);
    upperCanvasEl?.addEventListener("auxclick", preventMiddleAuxClickProxy);
    upperCanvasEl?.addEventListener("dblclick", handleCanvasDoubleClick);
    upperCanvasEl?.addEventListener("mouseleave", handleCanvasMouseLeave);
    upperCanvasEl?.addEventListener("contextmenu", handleCanvasContextMenu);
    window.addEventListener("mousemove", handleSelectDragMouseMove);
    window.addEventListener("mousemove", handleMiddleMouseMoveProxy, {
      passive: false,
    });
    window.addEventListener("mouseup", handleMiddleMouseUpProxy);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("keydown", handleWallKeyDown);
    window.addEventListener("keyup", handleWallKeyUp);

    return () => {
      canvas.off("mouse:down", handleMouseDownProxy);
      canvas.off("mouse:move", handleMouseMoveProxy);
      canvas.off("mouse:up", handleMouseUpProxy);
      canvas.off("mouse:wheel", handleWheelProxy);
      canvas.off("selection:created", handleSelectionCreated);
      canvas.off("selection:updated", handleSelectionUpdated);
      canvas.off("selection:cleared", handleSelectionCleared);
      canvas.off("mouse:down", handleCanvasMouseDown);
      canvas.off("object:moving", handleObjectMoving);
      canvas.off("object:rotating", handleObjectRotating);
      canvas.off("object:modified", handleObjectModified);
      window.removeEventListener("mouseup", handleMouseUpProxy);
      upperCanvasEl?.removeEventListener(
        "mousedown",
        handleMiddleMouseDownProxy,
      );
      upperCanvasEl?.removeEventListener(
        "auxclick",
        preventMiddleAuxClickProxy,
      );
      upperCanvasEl?.removeEventListener("dblclick", handleCanvasDoubleClick);
      upperCanvasEl?.removeEventListener("mouseleave", handleCanvasMouseLeave);
      upperCanvasEl?.removeEventListener(
        "contextmenu",
        handleCanvasContextMenu,
      );
      window.removeEventListener("mousemove", handleSelectDragMouseMove);
      window.removeEventListener("mousemove", handleMiddleMouseMoveProxy);
      window.removeEventListener("mouseup", handleMiddleMouseUpProxy);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("keydown", handleWallKeyDown);
      window.removeEventListener("keyup", handleWallKeyUp);
      // Cancel any pending wheel rAF store sync.
      if (wheelRafId.current) {
        cancelAnimationFrame(wheelRafId.current);
        wheelRafId.current = null;
      }
    };
  }, [fabricRef, outerRef, wheelRafId]);

  return {};
}
