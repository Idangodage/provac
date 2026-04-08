/**
 * useRendererSync
 *
 * Encapsulates all renderer-synchronisation useEffect / useCallback blocks
 * that were previously inlined in DrawingCanvas.tsx (lines 1087-1814).
 *
 * These effects keep the wall, room, dimension, section-line, HVAC and object
 * renderers in sync with React state changes.
 */

import * as fabric from 'fabric';
import { useEffect, useCallback, useRef } from 'react';

import type { AcEquipmentDefinition, ArchitecturalObjectDefinition } from '../../../data';
import type {
    Point2D,
    Wall,
    Room,
    DrawingTool,
    SymbolInstance2D,
    Dimension2D,
    DimensionSettings,
    WallDrawingState,
    WallSettings,
    SectionLine,
    SectionLineDrawingState,
    HvacElement,
} from '../../../types';
import {
    hideActiveSelectionChrome,
    OPENING_RESIZE_HANDLE_SIZE_PX,
    OPENING_RESIZE_HANDLE_COLOR,
} from '../../DrawingCanvas.types';
import type {
    CanvasState,
    MarqueeSelectionState,
    OpeningPointerInteraction,
} from '../../DrawingCanvas.types';
import { getToolCursor } from '../toolUtils';
import { MM_TO_PX } from '../scale';
import { formatDimensionLength } from '../dimension/dimensionGeometry';
import type { WallRenderer } from '../wall/WallRenderer';
import type { RoomRenderer } from '../room/RoomRenderer';
import type { DimensionRenderer } from '../dimension/DimensionRenderer';
import type { ObjectRenderer } from '../object/ObjectRenderer';
import type { SectionLineRenderer } from '../elevation/SectionLineRenderer';
import type { HvacPlanRenderer } from '../hvac/HvacPlanRenderer';
import { startDragPerfTimer, endDragPerfTimer } from '../perf/dragPerf';

const DRAG_AUTO_DIMENSION_MIN_INTERVAL_MS = 120;

// =============================================================================
// Types
// =============================================================================

export interface UseRendererSyncOptions {
    // Refs
    fabricRef: React.RefObject<fabric.Canvas | null>;
    roomRendererRef: React.RefObject<RoomRenderer | null>;
    dimensionRendererRef: React.RefObject<DimensionRenderer | null>;
    objectRendererRef: React.RefObject<ObjectRenderer | null>;
    sectionLineRendererRef: React.RefObject<SectionLineRenderer | null>;
    hvacRendererRef: React.RefObject<HvacPlanRenderer | null>;
    wallsRef: React.MutableRefObject<Wall[]>;
    symbolsRef: React.MutableRefObject<SymbolInstance2D[]>;
    dimensionRefreshFrameRef: React.MutableRefObject<number | null>;
    autoDimensionSyncFrameRef: React.MutableRefObject<number | null>;
    wheelRafId: React.MutableRefObject<number | null>;
    zoomRef: React.MutableRefObject<number>;
    panOffsetRef: React.MutableRefObject<Point2D>;
    mousePositionRef: React.MutableRefObject<Point2D>;
    placementCursorRef: React.MutableRefObject<Point2D | null>;
    openingResizeHandlesRef: React.MutableRefObject<fabric.Object[]>;
    openingPointerInteractionRef: React.MutableRefObject<OpeningPointerInteraction | null>;
    canvasStateRef: React.MutableRefObject<CanvasState>;
    marqueeSelectionRef: React.MutableRefObject<MarqueeSelectionState>;
    lastMarqueeSelectionRef: React.MutableRefObject<MarqueeSelectionState>;
    applyMarqueeFilterRef: React.MutableRefObject<boolean>;

    // Renderers
    wallRenderer: WallRenderer | null;

    // Fabric canvas state ref
    fabricCanvas: fabric.Canvas | null;

    // State values
    tool: DrawingTool;
    viewportZoom: number;
    panOffset: Point2D;
    walls: Wall[];
    rooms: Room[];
    symbols: SymbolInstance2D[];
    dimensions: Dimension2D[];
    dimensionSettings: DimensionSettings;
    wallSettings: WallSettings;
    wallDrawingState: WallDrawingState;
    sectionLines: SectionLine[];
    sectionLineDrawingState: SectionLineDrawingState;
    hvacElements: HvacElement[];
    selectedIds: string[];
    hoveredElementId: string | null;
    wallIdSet: Set<string>;
    objectDefinitions: ArchitecturalObjectDefinition[];
    objectDefinitionsById: Map<string, ArchitecturalObjectDefinition>;
    doorWindowSymbolsSignature: string;
    isSpacePressed: boolean;
    canvasState: CanvasState;
    isHandleDragging: boolean;
    activeRoomDragId: string | null;
    persistentRoomControlId: string | null;
    openingInteractionActive: boolean;
    pendingPlacementDefinition: ArchitecturalObjectDefinition | null;
    pendingPlacementEquipmentDefinition: AcEquipmentDefinition | null;
    placementRotationDeg: number;

    // State setters
    setPlacementRotationDeg: React.Dispatch<React.SetStateAction<number>>;
    setPlacementValid: React.Dispatch<React.SetStateAction<boolean>>;
    setOpeningInteractionActive: React.Dispatch<React.SetStateAction<boolean>>;
    setActiveRoomDragId: React.Dispatch<React.SetStateAction<string | null>>;
    setPersistentRoomControlId: React.Dispatch<React.SetStateAction<string | null>>;

    // Callbacks
    restackInteractiveOverlays: (canvas: fabric.Canvas) => void;
    cancelDimensionPlacement: () => void;
    syncAutoDimensions: () => void;
    updateWall: (
        id: string,
        updates: Partial<Wall>,
        options?: { skipHistory?: boolean; source?: 'ui' | 'drag'; skipRoomDetection?: boolean }
    ) => void;
    updateSymbol: (
        id: string,
        updates: Partial<SymbolInstance2D>,
        options?: { skipHistory?: boolean }
    ) => void;
    clearOpeningResizeHandles: () => void;
    buildHostedOpeningSymbolProperties: (
        definition: ArchitecturalObjectDefinition,
        wall: Wall,
        positionAlongWallMm: number,
        sourceProperties: Record<string, unknown> | undefined,
        openingWidthMm: number,
        openingHeightMm: number,
        openingSillHeightMm: number
    ) => Record<string, unknown>;
    fitOpeningToWall: (
        wall: Wall,
        opening: { position: number; width: number }
    ) => { position: number; width: number };
    resolveOpeningSillHeightMm: (
        definition: ArchitecturalObjectDefinition,
        properties?: Record<string, unknown>
    ) => number;
    computePlacement: (
        point: Point2D,
        definition: ArchitecturalObjectDefinition,
        options?: { ignoreSymbolId?: string; ignoreOpeningId?: string; openingWidthMm?: number }
    ) => {
        point: Point2D;
        rotationDeg: number;
        snappedWall: { wall: Wall; positionAlongWall: number } | null;
        alignmentPoint: Point2D | null;
        valid: boolean;
    };
    buildOpeningPreviewProperties: (
        definition: ArchitecturalObjectDefinition,
        snappedWall?: { wall: Wall; positionAlongWall: number } | null
    ) => Record<string, unknown> | undefined;
    computeHvacPlacement: (
        point: Point2D,
        source: AcEquipmentDefinition | HvacElement,
    ) => {
        point: Point2D;
        rotationDeg: number;
        valid: boolean;
    };

    // Tool hooks that need cleanup
    offsetTool: { cleanup: () => void };
    trimTool: { cleanup: () => void };
    extendTool: { cleanup: () => void };
}

export interface UseRendererSyncResult {
    /** Full re-render of dimension layer. Used by mouse handlers. */
    refreshDimensionLayer: () => void;
    /** rAF-throttled wrapper around refreshDimensionLayer. Used by mouse handlers. */
    scheduleDimensionLayerRefresh: () => void;
}

// =============================================================================
// Hook
// =============================================================================

export function useRendererSync(options: UseRendererSyncOptions): UseRendererSyncResult {
    const {
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
        objectDefinitionsById,
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
    } = options;

    // Debounce timer: after zoom/pan settles, refresh dimension labels so
    // they render at the correct screen-space size for the new zoom level.
    const zoomSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Stable ref to the latest refreshDimensionLayer so the settle timer
    // can call it without a declaration-order dependency.
    const refreshDimensionLayerRef = useRef<(() => void) | null>(null);
    const lastDragAutoDimensionSyncAtRef = useRef(0);
    const previousWallSyncSignatureRef = useRef<{ walls: Wall[] | null; symbols: string | null }>({
        walls: null,
        symbols: null,
    });

    // ── Sync view transform ──────────────────────────────────────────────
    // HOT PATH — runs on every zoom tick and every pan frame.
    // Only the O(1) viewport-transform update + a single requestRenderAll
    // happen here.  All per-object visual updates (wall stroke widths, room
    // label scales, dimension font sizes) are deferred to the settle timer
    // so that complex drawings don't stutter during active zoom / pan.
    useEffect(() => {
        const canvas = fabricRef.current;
        if (!canvas) return;
        // During active drag/wheel interactions we optimistically apply view
        // transforms directly to Fabric. If a store commit for an older frame
        // lands while a newer frame is already queued, skip this stale sync
        // so we don't briefly jump backward.
        if (wheelRafId.current !== null) {
            const panMismatchX = Math.abs(panOffsetRef.current.x - panOffset.x);
            const panMismatchY = Math.abs(panOffsetRef.current.y - panOffset.y);
            const zoomMismatch = Math.abs(zoomRef.current - viewportZoom);
            if (panMismatchX > 0.0001 || panMismatchY > 0.0001 || zoomMismatch > 0.0001) {
                return;
            }
        }
        const viewportTransform: fabric.TMat2D = [
            viewportZoom,
            0,
            0,
            viewportZoom,
            -panOffset.x * viewportZoom,
            -panOffset.y * viewportZoom,
        ];
        canvas.setViewportTransform(viewportTransform);
        hideActiveSelectionChrome(canvas);
        roomRendererRef.current?.setViewportZoom(viewportZoom, {
            requestRender: false,
            refreshVisibility: false,
            applyLabelScaling: false,
        });
        dimensionRendererRef.current?.setViewportZoom(viewportZoom);
        roomRendererRef.current?.refreshViewportVisibility();
        dimensionRendererRef.current?.refreshViewportVisibility();
        sectionLineRendererRef.current?.refreshViewportVisibility();
        hvacRendererRef.current?.refreshViewportVisibility();
        canvas.requestRenderAll();
        zoomRef.current = viewportZoom;
        panOffsetRef.current = panOffset;

        // Schedule a deferred visual-property update for ALL renderers.
        // Wall stroke widths, room label scales, and dimension font sizes
        // only need to match the final zoom level — not every intermediate
        // tick — so we batch them into a single update after 150 ms of
        // inactivity.  This keeps the hot path O(1).
        if (zoomSettleTimerRef.current !== null) {
            clearTimeout(zoomSettleTimerRef.current);
        }
        zoomSettleTimerRef.current = setTimeout(() => {
            zoomSettleTimerRef.current = null;
            const currentZoom = zoomRef.current;
            wallRenderer?.setViewportZoom(currentZoom);
            roomRendererRef.current?.setViewportZoom(currentZoom, { requestRender: false });
            const dimRenderer = dimensionRendererRef.current;
            if (dimRenderer) {
                dimRenderer.setViewportZoom(currentZoom);
                dimRenderer.updateZoomVisuals();
            }
            dimensionRendererRef.current?.refreshViewportVisibility();
            sectionLineRendererRef.current?.refreshViewportVisibility();
            hvacRendererRef.current?.refreshViewportVisibility();
        }, 150);
    }, [
        viewportZoom,
        panOffset,
        wallRenderer,
        fabricRef,
        roomRendererRef,
        dimensionRendererRef,
        sectionLineRendererRef,
        hvacRendererRef,
        wheelRafId,
        zoomRef,
        panOffsetRef,
    ]);

    useEffect(() => {
        if (tool === 'select') {
            return;
        }
        const hoveredWallId = hoveredElementId && wallIdSet.has(hoveredElementId)
            ? hoveredElementId
            : null;
        wallRenderer?.setHoveredWall(hoveredWallId);
    }, [wallRenderer, hoveredElementId, wallIdSet, tool]);

    useEffect(() => {
        if (tool !== 'dimension') {
            cancelDimensionPlacement();
        }
    }, [tool, cancelDimensionPlacement]);

    useEffect(() => {
        if (tool !== 'offset') {
            offsetTool.cleanup();
        }
    }, [tool, offsetTool]);

    useEffect(() => {
        if (tool !== 'trim') {
            trimTool.cleanup();
        }
    }, [tool, trimTool]);

    useEffect(() => {
        if (tool !== 'extend') {
            extendTool.cleanup();
        }
    }, [tool, extendTool]);

    // Live elastic dimension shown while drawing a wall.
    useEffect(() => {
        const renderer = dimensionRendererRef.current;
        if (!renderer) return;
        if (
            (tool === 'wall' || tool === 'partition-wall') &&
            wallDrawingState.isDrawing &&
            wallDrawingState.startPoint &&
            wallDrawingState.currentPoint
        ) {
            const start = wallDrawingState.startPoint;
            const end = wallDrawingState.currentPoint;
            const lengthMm = Math.hypot(end.x - start.x, end.y - start.y);
            const label = formatDimensionLength(lengthMm, dimensionSettings);
            renderer.setViewportZoom(viewportZoom);
            renderer.renderLiveDimension(start, end, label);
        } else {
            renderer.clearLiveDimension();
        }
    }, [tool, wallDrawingState, dimensionSettings, viewportZoom, dimensionRendererRef]);

    // Read zoom from ref so this callback identity stays stable across zoom
    // changes. This prevents the cascading re-render chain where every zoom
    // tick would trigger full wall/room/dimension rebuilds.
    const refreshDimensionLayer = useCallback(() => {
        const perfStart = startDragPerfTimer();
        const renderer = dimensionRendererRef.current;
        const canvas = fabricRef.current;
        if (!renderer || !canvas) {
            endDragPerfTimer('canvas.refreshDimensionLayer', perfStart, {
                dimensions: dimensions.length,
                walls: walls.length,
                rooms: rooms.length,
            });
            return;
        }
        renderer.setViewportZoom(zoomRef.current);
        const contextChanged = renderer.setContext(walls, rooms, dimensionSettings);
        renderer.syncDimensions(dimensions, { force: contextChanged });
        const dimensionIdSet = new Set(dimensions.map((dimension) => dimension.id));
        const selectedDimensionIds = selectedIds.filter((id) => dimensionIdSet.has(id));
        const hoveredDimensionId =
            hoveredElementId && dimensionIdSet.has(hoveredElementId)
                ? hoveredElementId
                : null;
        renderer.setSelectedDimensions(selectedDimensionIds);
        renderer.setHoveredDimension(hoveredDimensionId);
        restackInteractiveOverlays(canvas);
        canvas.requestRenderAll();
        endDragPerfTimer('canvas.refreshDimensionLayer', perfStart, {
            dimensions: dimensions.length,
            walls: walls.length,
            rooms: rooms.length,
        });
    }, [
        walls,
        rooms,
        dimensionSettings,
        dimensions,
        // viewportZoom intentionally excluded — read from zoomRef to keep
        // this callback reference stable during zoom and avoid cascading
        // full rebuilds of walls, rooms, and dimensions on every wheel tick.
        selectedIds,
        hoveredElementId,
        restackInteractiveOverlays,
        fabricRef,
        dimensionRendererRef,
        zoomRef,
    ]);
    // Keep the ref in sync so the zoom-settle timer always calls the latest version.
    refreshDimensionLayerRef.current = refreshDimensionLayer;

    const scheduleAutoDimensionSync = useCallback(() => {
        if (typeof window === 'undefined') {
            syncAutoDimensions();
            return;
        }
        if (autoDimensionSyncFrameRef.current !== null) return;
        autoDimensionSyncFrameRef.current = window.requestAnimationFrame(() => {
            autoDimensionSyncFrameRef.current = null;
            syncAutoDimensions();
        });
    }, [syncAutoDimensions, autoDimensionSyncFrameRef]);

    // Automatically rebuild all auto-generated dimensions whenever walls, rooms,
    // or dimension settings change — so dimensions are always visible without
    // requiring a manual "Auto Dimension" button press.
    // During handle dragging, frame-throttle updates so wall dimensions stay live.
    useEffect(() => {
        if (wallDrawingState.isDrawing) return;
        if (walls.length === 0 && rooms.length === 0) return;
        if (isHandleDragging) {
            const now =
                typeof performance !== 'undefined' && typeof performance.now === 'function'
                    ? performance.now()
                    : Date.now();
            if (now - lastDragAutoDimensionSyncAtRef.current < DRAG_AUTO_DIMENSION_MIN_INTERVAL_MS) {
                return;
            }
            lastDragAutoDimensionSyncAtRef.current = now;
            scheduleAutoDimensionSync();
            return;
        }
        lastDragAutoDimensionSyncAtRef.current = 0;
        syncAutoDimensions();
    }, [
        walls,
        rooms,
        dimensionSettings,
        wallDrawingState.isDrawing,
        isHandleDragging,
        scheduleAutoDimensionSync,
        syncAutoDimensions,
    ]);

    const scheduleDimensionLayerRefresh = useCallback(() => {
        if (typeof window === 'undefined') {
            refreshDimensionLayer();
            return;
        }
        if (dimensionRefreshFrameRef.current !== null) return;
        dimensionRefreshFrameRef.current = window.requestAnimationFrame(() => {
            dimensionRefreshFrameRef.current = null;
            refreshDimensionLayer();
        });
    }, [refreshDimensionLayer, dimensionRefreshFrameRef]);

    useEffect(() => {
        if (isHandleDragging) {
            return;
        }
        roomRendererRef.current?.setWallContext(walls);
        roomRendererRef.current?.syncRooms(rooms);
        scheduleDimensionLayerRefresh();
    }, [rooms, walls, fabricCanvas, scheduleDimensionLayerRefresh, isHandleDragging, roomRendererRef]);

    useEffect(() => {
        return () => {
            if (zoomSettleTimerRef.current !== null) {
                clearTimeout(zoomSettleTimerRef.current);
                zoomSettleTimerRef.current = null;
            }
            if (
                dimensionRefreshFrameRef.current !== null &&
                typeof window !== 'undefined'
            ) {
                window.cancelAnimationFrame(dimensionRefreshFrameRef.current);
                dimensionRefreshFrameRef.current = null;
            }
            if (
                autoDimensionSyncFrameRef.current !== null &&
                typeof window !== 'undefined'
            ) {
                window.cancelAnimationFrame(autoDimensionSyncFrameRef.current);
                autoDimensionSyncFrameRef.current = null;
            }
        };
    }, [dimensionRefreshFrameRef, autoDimensionSyncFrameRef]);

    useEffect(() => {
        roomRendererRef.current?.setShowTemperatureIcons(wallSettings.showRoomTemperatureIcons);
        roomRendererRef.current?.setShowVentilationBadges(wallSettings.showRoomVentilationBadges);
    }, [wallSettings.showRoomTemperatureIcons, wallSettings.showRoomVentilationBadges, fabricCanvas, roomRendererRef]);

    useEffect(() => {
        if (isHandleDragging) return;
        scheduleDimensionLayerRefresh();
    }, [scheduleDimensionLayerRefresh, fabricCanvas, isHandleDragging]);

    useEffect(() => {
        const roomIdSet = new Set(rooms.map((room) => room.id));
        const selectedRoomIds = selectedIds.filter((id) => roomIdSet.has(id));
        roomRendererRef.current?.setSelectedRooms(selectedRoomIds);
        if (selectedRoomIds.length > 0) {
            setPersistentRoomControlId(selectedRoomIds[0] ?? null);
        }
    }, [rooms, selectedIds, roomRendererRef, setPersistentRoomControlId]);

    useEffect(() => {
        const roomIdSet = new Set(rooms.map((room) => room.id));
        const resolvedRoomDragId =
            activeRoomDragId && roomIdSet.has(activeRoomDragId)
                ? activeRoomDragId
                : null;
        roomRendererRef.current?.setActiveDragRoom(resolvedRoomDragId);
        if (resolvedRoomDragId !== activeRoomDragId) {
            setActiveRoomDragId(resolvedRoomDragId);
        }
    }, [rooms, activeRoomDragId, roomRendererRef, setActiveRoomDragId]);

    useEffect(() => {
        const roomIdSet = new Set(rooms.map((room) => room.id));
        const resolvedPersistentRoomControlId =
            persistentRoomControlId && roomIdSet.has(persistentRoomControlId)
                ? persistentRoomControlId
                : null;
        roomRendererRef.current?.setPersistentControlRoom(resolvedPersistentRoomControlId);
        if (resolvedPersistentRoomControlId !== persistentRoomControlId) {
            setPersistentRoomControlId(resolvedPersistentRoomControlId);
        }
    }, [rooms, persistentRoomControlId, roomRendererRef, setPersistentRoomControlId]);

    useEffect(() => {
        const dimensionIdSet = new Set(dimensions.map((dimension) => dimension.id));
        const selectedDimensionIds = selectedIds.filter((id) => dimensionIdSet.has(id));
        dimensionRendererRef.current?.setSelectedDimensions(selectedDimensionIds);
    }, [dimensions, selectedIds, dimensionRendererRef]);

    useEffect(() => {
        const roomIdSet = new Set(rooms.map((room) => room.id));
        const hoveredRoomId = hoveredElementId && roomIdSet.has(hoveredElementId)
            ? hoveredElementId
            : null;
        roomRendererRef.current?.setHoveredRoom(hoveredRoomId);
    }, [rooms, hoveredElementId, roomRendererRef]);

    useEffect(() => {
        const dimensionIdSet = new Set(dimensions.map((dimension) => dimension.id));
        const hoveredDimensionId = hoveredElementId && dimensionIdSet.has(hoveredElementId)
            ? hoveredElementId
            : null;
        dimensionRendererRef.current?.setHoveredDimension(hoveredDimensionId);
    }, [dimensions, hoveredElementId, dimensionRendererRef]);

    useEffect(() => {
        if (!objectRendererRef.current) return;
        objectRendererRef.current.setDefinitions(objectDefinitions);
    }, [objectDefinitions, fabricCanvas, objectRendererRef]);

    useEffect(() => {
        if (isHandleDragging) return;
        objectRendererRef.current?.renderIncremental(symbols);
    }, [symbols, objectDefinitions, fabricCanvas, isHandleDragging, objectRendererRef]);

    useEffect(() => {
        if (!wallRenderer) return;
        const openingSymbols = symbolsRef.current.filter((instance) => {
            const definition = objectDefinitionsById.get(instance.symbolId);
            return definition?.category === 'doors' || definition?.category === 'windows';
        });
        wallRenderer.setOpeningSymbolInstances(openingSymbols);
        const previousWallSync = previousWallSyncSignatureRef.current;
        const wallsChanged = previousWallSync.walls !== walls;
        const openingSymbolsChanged = previousWallSync.symbols !== doorWindowSymbolsSignature;
        previousWallSyncSignatureRef.current = {
            walls,
            symbols: doorWindowSymbolsSignature,
        };
        if (isHandleDragging) {
            wallRenderer.renderWallsInteractive(wallsRef.current);
            if (fabricRef.current) {
                restackInteractiveOverlays(fabricRef.current);
            }
            return;
        }
        if (wallsChanged || !openingSymbolsChanged) {
            // Keep wall visuals identical while dragging and idle when geometry changed.
            wallRenderer.renderAllWalls(wallsRef.current);
        } else {
            const wallsWithHostedOpenings = wallsRef.current
                .filter((wall) => wall.openings.length > 0)
                .map((wall) => wall.id);
            wallRenderer.rerenderWallsByIds(wallsWithHostedOpenings);
        }
        // Rebuild dimensions after wall re-renders, then restore edit-handle priority.
        scheduleDimensionLayerRefresh();
    }, [
        wallRenderer,
        walls,
        doorWindowSymbolsSignature,
        objectDefinitionsById,
        scheduleDimensionLayerRefresh,
        restackInteractiveOverlays,
        isHandleDragging,
        symbolsRef,
        wallsRef,
        fabricRef,
    ]);

    useEffect(() => {
        if (isHandleDragging) return;
        if (walls.length === 0 || symbols.length === 0) return;

        let adjustedAnyWall = false;
        for (const wall of walls) {
            if (wall.openings.length === 0) continue;
            let hasWallChange = false;
            const nextOpenings = wall.openings.map((opening) => {
                const fitted = fitOpeningToWall(wall, opening);
                if (
                    Math.abs(fitted.position - opening.position) > 0.01 ||
                    Math.abs(fitted.width - opening.width) > 0.01
                ) {
                    hasWallChange = true;
                    return {
                        ...opening,
                        position: fitted.position,
                        width: fitted.width,
                    };
                }
                return opening;
            });

            if (hasWallChange) {
                adjustedAnyWall = true;
                updateWall(
                    wall.id,
                    { openings: nextOpenings },
                    { skipHistory: true, source: 'drag' }
                );
            }
        }

        if (adjustedAnyWall) {
            return;
        }

        const openingLookup = new Map<string, { wall: Wall; opening: Wall['openings'][number] }>();
        for (const wall of walls) {
            for (const opening of wall.openings) {
                openingLookup.set(opening.id, { wall, opening });
            }
        }

        for (const instance of symbols) {
            const definition = objectDefinitionsById.get(instance.symbolId);
            if (!definition) continue;
            if (definition.category !== 'doors' && definition.category !== 'windows') continue;

            const linked = openingLookup.get(instance.id);
            if (!linked) continue;

            const { wall, opening } = linked;
            const dx = wall.endPoint.x - wall.startPoint.x;
            const dy = wall.endPoint.y - wall.startPoint.y;
            const wallLength = Math.hypot(dx, dy) || 1;
            const t = opening.position / wallLength;
            const nextPosition = {
                x: wall.startPoint.x + dx * t,
                y: wall.startPoint.y + dy * t,
            };
            const nextRotation = (Math.atan2(dy, dx) * 180) / Math.PI;
            const nextWidthMm = Math.max(1, opening.width - 50);
            const nextHeightMm = Math.max(1, opening.height);
            const nextSillHeightMm =
                definition.category === 'windows'
                    ? Math.max(0, opening.sillHeight ?? resolveOpeningSillHeightMm(definition, instance.properties))
                    : 0;
            const nextBaseElevationMm =
                definition.category === 'windows'
                    ? (wall.properties3D.baseElevation ?? 0) + nextSillHeightMm
                    : (wall.properties3D.baseElevation ?? 0);
            const nextProperties = buildHostedOpeningSymbolProperties(
                definition,
                wall,
                opening.position,
                instance.properties,
                nextWidthMm,
                nextHeightMm,
                nextSillHeightMm
            );

            const properties = instance.properties ?? {};
            const changed =
                Math.abs(instance.position.x - nextPosition.x) > 0.01 ||
                Math.abs(instance.position.y - nextPosition.y) > 0.01 ||
                Math.abs(instance.rotation - nextRotation) > 0.01 ||
                Math.abs(Number(properties.widthMm ?? 0) - nextWidthMm) > 0.01 ||
                Math.abs(Number(properties.depthMm ?? 0) - wall.thickness) > 0.01 ||
                Math.abs(Number(properties.heightMm ?? 0) - nextHeightMm) > 0.01 ||
                Math.abs(Number(properties.positionAlongWallMm ?? 0) - opening.position) > 0.01 ||
                String(properties.hostWallId ?? '') !== wall.id ||
                Math.abs(Number(properties.baseElevationMm ?? 0) - nextBaseElevationMm) > 0.01 ||
                String(properties.doorOpenSide ?? '') !== String(nextProperties.doorOpenSide ?? '') ||
                (definition.category === 'windows' &&
                    Math.abs(Number(properties.sillHeightMm ?? 0) - nextSillHeightMm) > 0.01);

            if (!changed) continue;

            updateSymbol(
                instance.id,
                {
                    position: nextPosition,
                    rotation: nextRotation,
                    properties: nextProperties,
                },
                { skipHistory: true }
            );
        }
    }, [
        walls,
        symbols,
        objectDefinitionsById,
        buildHostedOpeningSymbolProperties,
        fitOpeningToWall,
        resolveOpeningSillHeightMm,
        updateWall,
        updateSymbol,
        isHandleDragging,
    ]);

    useEffect(() => {
        const symbolIdSet = new Set(symbols.map((symbol) => symbol.id));
        const selectedSymbolIds = selectedIds.filter((id) => symbolIdSet.has(id));
        objectRendererRef.current?.setSelectedObjects(selectedSymbolIds);
        if (tool === 'select' && selectedIds.length === 1 && selectedSymbolIds.length === 1) {
            objectRendererRef.current?.activateObject(selectedSymbolIds[0]);
            hideActiveSelectionChrome(fabricRef.current);
        }
    }, [symbols, selectedIds, objectRendererRef, fabricRef]);

    useEffect(() => {
        const symbolIdSet = new Set(symbols.map((symbol) => symbol.id));
        const hoveredSymbolId = hoveredElementId && symbolIdSet.has(hoveredElementId)
            ? hoveredElementId
            : null;
        objectRendererRef.current?.setHoveredObject(hoveredSymbolId);
    }, [symbols, hoveredElementId, objectRendererRef]);

    // Track which opening+wall the handles were built for so we can skip
    // full recreation when only zoom changes.
    const resizeHandleContextRef = useRef<{
        openingId: string;
        wallId: string;
        zoom: number;
    } | null>(null);

    // Create or update opening resize handles.  When only zoom changes we
    // update existing handle geometry in-place instead of destroying and
    // recreating, which avoids expensive canvas.add/remove cycles.
    useEffect(() => {
        const canvas = fabricRef.current;
        if (!canvas) return;

        if (tool !== 'select' || selectedIds.length === 0) {
            if (openingResizeHandlesRef.current.length > 0) {
                clearOpeningResizeHandles();
                resizeHandleContextRef.current = null;
            }
            return;
        }

        const selectedId = selectedIds.find((id) =>
            walls.some((wall) => wall.openings.some((opening) => opening.id === id))
        );
        if (!selectedId) {
            if (openingResizeHandlesRef.current.length > 0) {
                clearOpeningResizeHandles();
                resizeHandleContextRef.current = null;
            }
            return;
        }
        const hostWall = walls.find((wall) => wall.openings.some((opening) => opening.id === selectedId));
        if (!hostWall) {
            clearOpeningResizeHandles();
            resizeHandleContextRef.current = null;
            return;
        }
        const hostOpening = hostWall.openings.find((opening) => opening.id === selectedId);
        if (!hostOpening) {
            clearOpeningResizeHandles();
            resizeHandleContextRef.current = null;
            return;
        }

        const dx = hostWall.endPoint.x - hostWall.startPoint.x;
        const dy = hostWall.endPoint.y - hostWall.startPoint.y;
        const wallLength = Math.hypot(dx, dy);
        if (!Number.isFinite(wallLength) || wallLength <= 0.001) return;

        const currentZoom = zoomRef.current;
        const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
        const direction = { x: dx / wallLength, y: dy / wallLength };
        const startEdge = hostOpening.position - hostOpening.width / 2;
        const endEdge = hostOpening.position + hostOpening.width / 2;
        const handleSizePx = OPENING_RESIZE_HANDLE_SIZE_PX / Math.max(currentZoom, 0.01);
        const strokeW = 2 / Math.max(currentZoom, 0.01);
        const setHandleGeometry = (
            handle: fabric.Object & {
                openingResizeSide?: 'start' | 'end';
            },
            side: 'start' | 'end',
            edgeAlongWallMm: number,
        ) => {
            const pointMm = {
                x: hostWall.startPoint.x + direction.x * edgeAlongWallMm,
                y: hostWall.startPoint.y + direction.y * edgeAlongWallMm,
            };
            const angle = side === 'start' ? angleDeg + 270 : angleDeg + 90;
            handle.set({
                left: pointMm.x * MM_TO_PX,
                top: pointMm.y * MM_TO_PX,
                width: handleSizePx,
                height: handleSizePx,
                angle,
                strokeWidth: strokeW,
                visible: true,
            });
            handle.openingResizeSide = side;
            handle.setCoords();
            canvas.bringObjectToFront(handle);
        };

        // Fast path: if the same opening is still selected, keep the existing
        // triangles and update their geometry in place instead of recreating them.
        const ctx = resizeHandleContextRef.current;
        if (
            ctx &&
            ctx.openingId === selectedId &&
            ctx.wallId === hostWall.id &&
            openingResizeHandlesRef.current.length === 2
        ) {
            const [startHandle, endHandle] = openingResizeHandlesRef.current as Array<
                fabric.Object & { openingResizeSide?: 'start' | 'end' }
            >;
            setHandleGeometry(startHandle, 'start', startEdge);
            setHandleGeometry(endHandle, 'end', endEdge);
            resizeHandleContextRef.current = { openingId: selectedId, wallId: hostWall.id, zoom: currentZoom };
            canvas.requestRenderAll();
            return;
        }

        // Full rebuild (selection changed or first time).
        clearOpeningResizeHandles();

        const createHandle = (side: 'start' | 'end', edgeAlongWallMm: number) => {
            const handle = new fabric.Triangle({
                left: 0,
                top: 0,
                width: handleSizePx,
                height: handleSizePx,
                angle: 0,
                fill: OPENING_RESIZE_HANDLE_COLOR,
                stroke: '#ffffff',
                strokeWidth: strokeW,
                originX: 'center',
                originY: 'center',
                selectable: false,
                evented: true,
                hasControls: false,
                hasBorders: false,
                objectCaching: false,
                hoverCursor: 'ew-resize',
                moveCursor: 'ew-resize',
            });
            const typedHandle = handle as fabric.Object & {
                id?: string;
                name?: string;
                openingId?: string;
                wallId?: string;
                openingResizeSide?: 'start' | 'end';
                isOpeningResizeHandle?: boolean;
            };
            typedHandle.id = `${selectedId}-resize-${side}`;
            typedHandle.name = `opening-resize-${side}`;
            typedHandle.openingId = selectedId;
            typedHandle.wallId = hostWall.id;
            typedHandle.openingResizeSide = side;
            typedHandle.isOpeningResizeHandle = true;
            canvas.add(handle);
            setHandleGeometry(typedHandle, side, edgeAlongWallMm);
            openingResizeHandlesRef.current.push(handle);
        };

        createHandle('start', startEdge);
        createHandle('end', endEdge);
        resizeHandleContextRef.current = { openingId: selectedId, wallId: hostWall.id, zoom: currentZoom };
        canvas.requestRenderAll();
    }, [
        tool,
        selectedIds,
        symbols,
        walls,
        objectDefinitionsById,
        viewportZoom,
        clearOpeningResizeHandles,
        fabricRef,
        openingResizeHandlesRef,
        zoomRef,
    ]);

    useEffect(() => {
        if (tool !== 'select') {
            openingPointerInteractionRef.current = null;
            setOpeningInteractionActive(false);
        }
    }, [tool, openingPointerInteractionRef, setOpeningInteractionActive]);

    useEffect(() => {
        if (!sectionLineRendererRef.current) return;
        sectionLineRendererRef.current.setShowReferenceIndicators(wallSettings.showSectionReferenceLines);
        sectionLineRendererRef.current.syncSectionLines(sectionLines);
    }, [sectionLines, wallSettings.showSectionReferenceLines, fabricCanvas, sectionLineRendererRef]);

    // Render HVAC elements on plan canvas
    useEffect(() => {
        roomRendererRef.current?.setHvacContext(hvacElements);
        if (!hvacRendererRef.current) return;
        hvacRendererRef.current.syncElements(hvacElements);
    }, [hvacElements, fabricCanvas, hvacRendererRef, roomRendererRef]);

    useEffect(() => {
        const hvacIds = new Set(hvacElements.map((element) => element.id));
        const selectedHvacIds = selectedIds.filter((id) => hvacIds.has(id));
        hvacRendererRef.current?.setSelectedElements(selectedHvacIds);
    }, [hvacElements, selectedIds, hvacRendererRef]);

    useEffect(() => {
        const hvacIds = new Set(hvacElements.map((element) => element.id));
        const hoveredHvacId = hoveredElementId && hvacIds.has(hoveredElementId)
            ? hoveredElementId
            : null;
        hvacRendererRef.current?.setHoveredElement(hoveredHvacId);
    }, [hvacElements, hoveredElementId, hvacRendererRef]);

    useEffect(() => {
        const sectionIds = new Set(sectionLines.map((line) => line.id));
        const selectedSectionIds = selectedIds.filter((id) => sectionIds.has(id));
        sectionLineRendererRef.current?.setSelectedSectionLines(selectedSectionIds);
    }, [sectionLines, selectedIds, sectionLineRendererRef]);

    useEffect(() => {
        const sectionIds = new Set(sectionLines.map((line) => line.id));
        const hoveredSectionId = hoveredElementId && sectionIds.has(hoveredElementId)
            ? hoveredElementId
            : null;
        sectionLineRendererRef.current?.setHoveredSectionLine(hoveredSectionId);
    }, [sectionLines, hoveredElementId, sectionLineRendererRef]);

    useEffect(() => {
        const renderer = sectionLineRendererRef.current;
        if (!renderer) return;
        if (
            tool === 'section-line' &&
            sectionLineDrawingState.isDrawing &&
            sectionLineDrawingState.startPoint &&
            sectionLineDrawingState.currentPoint
        ) {
            renderer.renderPreview(
                sectionLineDrawingState.startPoint,
                sectionLineDrawingState.currentPoint,
                sectionLineDrawingState.direction,
                sectionLineDrawingState.nextLabel
            );
            return;
        }
        renderer.clearPreview();
    }, [tool, sectionLineDrawingState, sectionLineRendererRef]);

    useEffect(() => {
        if (!pendingPlacementDefinition) {
            objectRendererRef.current?.clearPlacementPreview();
            if (!pendingPlacementEquipmentDefinition) {
                placementCursorRef.current = null;
                setPlacementValid(true);
            }
            return;
        }
        hvacRendererRef.current?.clearPlacementPreview();
        setPlacementRotationDeg(pendingPlacementDefinition.defaultRotationDeg ?? 0);
        if (!placementCursorRef.current) {
            const seedPoint = {
                x: mousePositionRef.current.x / MM_TO_PX,
                y: mousePositionRef.current.y / MM_TO_PX,
            };
            placementCursorRef.current = seedPoint;
            const placement = computePlacement(seedPoint, pendingPlacementDefinition);
            setPlacementValid(placement.valid);
            objectRendererRef.current?.renderPlacementPreview(
                pendingPlacementDefinition,
                placement.point,
                placement.rotationDeg,
                placement.valid,
                placement.snappedWall ? {
                    wall: placement.snappedWall.wall,
                    positionAlongWall: placement.snappedWall.positionAlongWall,
                } : null,
                buildOpeningPreviewProperties(
                    pendingPlacementDefinition,
                    placement.snappedWall ? {
                        wall: placement.snappedWall.wall,
                        positionAlongWall: placement.snappedWall.positionAlongWall,
                    } : null
                ),
            );
        }
    }, [pendingPlacementDefinition, pendingPlacementEquipmentDefinition, buildOpeningPreviewProperties, computePlacement, hvacRendererRef, objectRendererRef, placementCursorRef, mousePositionRef, setPlacementValid, setPlacementRotationDeg]);

    useEffect(() => {
        if (!pendingPlacementDefinition || !placementCursorRef.current) return;
        const placement = computePlacement(placementCursorRef.current, pendingPlacementDefinition);
        setPlacementValid(placement.valid);
        objectRendererRef.current?.renderPlacementPreview(
            pendingPlacementDefinition,
            placement.point,
            placement.rotationDeg,
            placement.valid,
            placement.snappedWall ? {
                wall: placement.snappedWall.wall,
                positionAlongWall: placement.snappedWall.positionAlongWall,
            } : null,
            buildOpeningPreviewProperties(
                pendingPlacementDefinition,
                placement.snappedWall ? {
                    wall: placement.snappedWall.wall,
                    positionAlongWall: placement.snappedWall.positionAlongWall,
                } : null
            ),
        );
    }, [pendingPlacementDefinition, placementRotationDeg, buildOpeningPreviewProperties, computePlacement, objectRendererRef, placementCursorRef, setPlacementValid]);

    useEffect(() => {
        if (!pendingPlacementEquipmentDefinition) {
            hvacRendererRef.current?.clearPlacementPreview();
            if (!pendingPlacementDefinition) {
                placementCursorRef.current = null;
                setPlacementValid(true);
            }
            return;
        }
        objectRendererRef.current?.clearPlacementPreview();
        setPlacementRotationDeg(pendingPlacementEquipmentDefinition.defaultRotationDeg ?? 0);
        if (!placementCursorRef.current) {
            const seedPoint = {
                x: mousePositionRef.current.x / MM_TO_PX,
                y: mousePositionRef.current.y / MM_TO_PX,
            };
            placementCursorRef.current = seedPoint;
            const placement = computeHvacPlacement(seedPoint, pendingPlacementEquipmentDefinition);
            setPlacementValid(placement.valid);
            hvacRendererRef.current?.renderPlacementPreview(
                pendingPlacementEquipmentDefinition,
                placement.point,
                placement.rotationDeg,
                placement.valid,
            );
        }
    }, [pendingPlacementDefinition, pendingPlacementEquipmentDefinition, computeHvacPlacement, hvacRendererRef, mousePositionRef, objectRendererRef, placementCursorRef, setPlacementValid, setPlacementRotationDeg]);

    useEffect(() => {
        if (!pendingPlacementEquipmentDefinition || !placementCursorRef.current) return;
        const placement = computeHvacPlacement(placementCursorRef.current, pendingPlacementEquipmentDefinition);
        setPlacementValid(placement.valid);
        hvacRendererRef.current?.renderPlacementPreview(
            pendingPlacementEquipmentDefinition,
            placement.point,
            placement.rotationDeg,
            placement.valid,
        );
    }, [pendingPlacementEquipmentDefinition, placementRotationDeg, computeHvacPlacement, hvacRendererRef, placementCursorRef, setPlacementValid]);

    useEffect(() => { canvasStateRef.current = canvasState; }, [canvasState, canvasStateRef]);

    // ── Tool Change Handler ──────────────────────────────────────────────
    useEffect(() => {
        const canvas = fabricRef.current;
        if (!canvas) return;

        const effectiveTool = isSpacePressed ? 'pan' : tool;
        const allowSelection =
            effectiveTool === 'select' &&
            !pendingPlacementDefinition &&
            !pendingPlacementEquipmentDefinition &&
            !openingInteractionActive;
        const pointerCursor = canvasState.isPanning
            ? 'grabbing'
            : (pendingPlacementDefinition || pendingPlacementEquipmentDefinition)
                ? 'crosshair'
                : getToolCursor(effectiveTool);

        canvas.selection = allowSelection;
        (canvas as fabric.Canvas & { selectionFullyContained?: boolean }).selectionFullyContained = allowSelection;
        canvas.defaultCursor = pointerCursor;
        canvas.hoverCursor = pointerCursor;
        if (!allowSelection) {
            marqueeSelectionRef.current = { active: false, start: null, current: null, mode: 'window' };
            lastMarqueeSelectionRef.current = { active: false, start: null, current: null, mode: 'window' };
            applyMarqueeFilterRef.current = false;
        }

        canvas.forEachObject((obj) => {
            const typed = obj as fabric.Object & {
                isWallControl?: boolean;
                isWallControlDecoration?: boolean;
                isRoomControl?: boolean;
                isRoomControlDecoration?: boolean;
                isDimensionControl?: boolean;
                isDimensionControlDecoration?: boolean;
                sectionLineId?: string;
                isOpeningResizeHandle?: boolean;
            };
            if (typed.isWallControlDecoration) {
                obj.selectable = false;
                obj.evented = false;
                return;
            }
            if (typed.isRoomControlDecoration) {
                obj.selectable = false;
                obj.evented = false;
                return;
            }
            if (typed.isWallControl) {
                obj.selectable = allowSelection;
                obj.evented = allowSelection;
                return;
            }
            if (typed.isRoomControl) {
                obj.selectable = allowSelection;
                obj.evented = allowSelection;
                return;
            }
            if (typed.isDimensionControlDecoration) {
                obj.selectable = false;
                obj.evented = false;
                return;
            }
            if (typed.isDimensionControl) {
                obj.selectable = allowSelection;
                obj.evented = allowSelection;
                return;
            }
            if (typed.sectionLineId) {
                obj.selectable = false;
                obj.evented = allowSelection;
                return;
            }
            if (typed.isOpeningResizeHandle) {
                obj.selectable = false;
                obj.evented = allowSelection;
                return;
            }
            obj.selectable = allowSelection;
            obj.evented = allowSelection;
        });
        if (allowSelection) {
            hideActiveSelectionChrome(canvas);
        }
        canvas.renderAll();
    }, [tool, isSpacePressed, canvasState.isPanning, pendingPlacementDefinition, pendingPlacementEquipmentDefinition, openingInteractionActive, fabricRef, marqueeSelectionRef, lastMarqueeSelectionRef, applyMarqueeFilterRef]);

    return {
        refreshDimensionLayer,
        scheduleDimensionLayerRefresh,
    };
}
