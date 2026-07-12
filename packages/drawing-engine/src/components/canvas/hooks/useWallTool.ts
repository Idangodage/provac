/**
 * useWallTool Hook
 *
 * Handles wall drawing interactions: click to start, move to preview, click to commit.
 * Supports chain mode, snapping, and angle locking.
 */

import type { Canvas as FabricCanvas } from 'fabric';
import { useRef, useCallback, useEffect, useLayoutEffect } from 'react';

import type { Point2D, Room, Wall, WallSettings, WallDrawingState } from '../../../types';
import { MM_TO_PX } from '../scale'; // [SNAP WIRE]
import { resolveRoomBoundarySelectionSegments } from '../wall/RoomBoundarySelection';
import { buildTemporaryWall } from '../wall/WallJoinNetwork';
import { WallManager } from '../wall/WallManager';
import { WallPreview } from '../wall/WallPreview';
import { WallRenderer } from '../wall/WallRenderer';
import { WallSnapIndicatorRenderer } from '../wall/WallSnapIndicatorRenderer'; // [SNAP WIRE]
import { snapWallPoint } from '../wall/WallSnapping';
import type { EnhancedSnapResult } from '../wall/WallSnapping'; // [SNAP WIRE]

// =============================================================================
// Types
// =============================================================================

export interface UseWallToolOptions {
  fabricRef: React.RefObject<FabricCanvas | null>;
  canvas: FabricCanvas | null;  // Direct canvas reference for reactivity
  walls: Wall[];
  rooms: Room[];
  selectedIds: string[];
  isHandleDragging?: boolean;
  wallDrawingState: WallDrawingState;
  wallSettings: WallSettings;
  zoom: number;
  panOffset: { x: number; y: number }; // pan offset in scene pixels for snap indicator rendering
  pageHeight: number;
  overlayCanvasRef?: React.RefObject<HTMLCanvasElement | null>; // [SNAP WIRE] overlay for snap indicators
  startWallDrawing: (startPoint: Point2D) => void;
  updateWallPreview: (currentPoint: Point2D) => void;
  cancelWallDrawing: () => void;
  /**
   * Commit one segment through the shared-node wall graph (src/wallcore):
   * welds/splits/crossings happen inside the store command — the tool never
   * patches topology by hand.
   */
  wallGraphAddChain: (
    points: Point2D[],
    params?: Partial<{
      thickness: number;
      height: number;
      material: string;
      materialId: string;
    }>,
  ) => string[];
  onWallCreated?: (wallId: string) => void;
  onRoomClosed?: (wallIds: string[]) => void; // [SNAP WIRE]
}

export interface UseWallToolResult {
  wallRenderer: WallRenderer | null;
  wallPreview: WallPreview | null;
  wallManager: WallManager | null;
  handleMouseDown: (scenePoint: Point2D) => void;
  handleMouseMove: (scenePoint: Point2D) => void;
  handleDoubleClick: () => void;
  handleKeyDown: (e: KeyboardEvent) => void;
  handleKeyUp: (e: KeyboardEvent) => void;
  isDrawing: boolean;
  lastSnapResult: EnhancedSnapResult | null; // [SNAP WIRE]
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useWallTool({
  fabricRef,
  canvas,
  walls,
  rooms,
  selectedIds,
  isHandleDragging = false,
  wallDrawingState,
  wallSettings,
  zoom,
  panOffset,
  pageHeight,
  overlayCanvasRef, // [SNAP WIRE]
  startWallDrawing,
  updateWallPreview,
  cancelWallDrawing,
  wallGraphAddChain,
  onWallCreated,
  onRoomClosed, // [SNAP WIRE]
}: UseWallToolOptions): UseWallToolResult {
  // Refs for instances
  const wallRendererRef = useRef<WallRenderer | null>(null);
  const wallPreviewRef = useRef<WallPreview | null>(null);
  const wallManagerRef = useRef<WallManager | null>(null);
  const shiftPressedRef = useRef(false);
  const ctrlPressedRef = useRef(false); // [SNAP WIRE]
  const altPressedRef = useRef(false); // [SNAP WIRE]
  const snapEnabledRef = useRef(true); // [SNAP WIRE] toggle via S key
  const lastSnappedWallRef = useRef<{ wallId: string } | null>(null);
  const lastSnapResultRef = useRef<EnhancedSnapResult | null>(null); // [SNAP WIRE]
  const snapIndicatorRef = useRef<WallSnapIndicatorRenderer | null>(null); // [SNAP WIRE]
  const chainWallIdsRef = useRef<string[]>([]); // [SNAP WIRE] track wall chain for room close
  const chainStartPointRef = useRef<Point2D | null>(null); // first click of the chain (room close)
  const panOffsetRef = useRef(panOffset); // keep current pan offset for snap indicator coordinate conversion
  const selectionPresentationSignatureRef = useRef<string>('');
  const wallsRef = useRef(walls);
  panOffsetRef.current = panOffset; // always sync
  wallsRef.current = walls;

  // Initialize instances when canvas is available
  useEffect(() => {
    if (!canvas) return;

    // Create instances if not already created
    if (!wallRendererRef.current) {
      wallRendererRef.current = new WallRenderer(canvas, pageHeight);
      selectionPresentationSignatureRef.current = '';
    }
    if (!wallPreviewRef.current) {
      wallPreviewRef.current = new WallPreview(canvas, pageHeight);
    }
    if (!wallManagerRef.current) {
      wallManagerRef.current = new WallManager();
    }

    // Update page height
    wallRendererRef.current.setPageHeight(pageHeight);
    wallRendererRef.current.setDragOptimizedMode(false);
    wallPreviewRef.current.setPageHeight(pageHeight);

    // [SNAP WIRE] Initialize snap indicator renderer on overlay canvas
    if (overlayCanvasRef?.current && !snapIndicatorRef.current) {
      snapIndicatorRef.current = new WallSnapIndicatorRenderer(
        overlayCanvasRef.current,
        MM_TO_PX,
        () => canvas.getZoom(),
        () => panOffsetRef.current,
      );
    }

    // Cleanup
    return () => {
      wallPreviewRef.current?.dispose();
      wallRendererRef.current?.dispose();
      snapIndicatorRef.current?.clear(); // [SNAP WIRE]
      wallPreviewRef.current = null;
      wallRendererRef.current = null;
      wallManagerRef.current = null;
      snapIndicatorRef.current = null; // [SNAP WIRE]
      selectionPresentationSignatureRef.current = '';
    };
  }, [canvas, pageHeight]);

  useEffect(() => {
    if (!wallRendererRef.current) return;
    wallRendererRef.current.setDragOptimizedMode(false);
  }, [isHandleDragging, canvas]);

  // Update wall manager when walls change
  useEffect(() => {
    if (wallManagerRef.current) {
      wallManagerRef.current.setWalls(walls);
    }
    wallPreviewRef.current?.setWalls(walls);
  }, [walls]);

  // Rooms are lower-frequency than wall drag updates; keep this separate from
  // wall geometry rendering to avoid repeated room cloning work per frame.
  useEffect(() => {
    if (wallRendererRef.current && canvas) {
      wallRendererRef.current.setRooms(rooms);
      wallRendererRef.current.setRoomWallIds(rooms.flatMap((room) => room.wallIds));
    }
  }, [rooms, canvas]);

  // Update renderer when wall geometry changes.
  useLayoutEffect(() => {
    if (wallRendererRef.current && canvas) {
      wallRendererRef.current.setDragOptimizedMode(false);
      if (isHandleDragging) {
        wallRendererRef.current.renderWallsInteractive(walls);
        return;
      }
      wallRendererRef.current.renderAllWalls(walls);
      // Commit/delete wall updates should appear fully settled in the same UI turn
      // instead of waiting for the next incidental interaction to flush Fabric.
      canvas.renderAll();
    }
  }, [walls, canvas, isHandleDragging]);

  // Update selected wall highlights + control points
  useEffect(() => {
    if (!wallRendererRef.current) return;
    const wallIdSet = new Set(wallsRef.current.map((wall) => wall.id));
    const roomById = new Map(rooms.map((room) => [room.id, room]));
    const explicitSelectedWallIds = new Set<string>();
    const selectedRoomIds: string[] = [];

    selectedIds.forEach((id) => {
      if (wallIdSet.has(id)) {
        explicitSelectedWallIds.add(id);
        return;
      }
      const room = roomById.get(id);
      if (room) {
        selectedRoomIds.push(room.id);
      }
    });

    const nextSelectedWallIds = Array.from(explicitSelectedWallIds).sort();
    const boundarySelections = nextSelectedWallIds.length === 0 && selectedRoomIds.length > 0
      ? resolveRoomBoundarySelectionSegments(selectedRoomIds, rooms, wallsRef.current)
      : [];
    const signature = [
      nextSelectedWallIds.join('|'),
      boundarySelections.map((selection) => selection.key).sort().join('|'),
    ].join('::');
    if (selectionPresentationSignatureRef.current === signature) {
      return;
    }
    selectionPresentationSignatureRef.current = signature;
    wallRendererRef.current.setSelectionState(nextSelectedWallIds, boundarySelections);
  }, [rooms, selectedIds, canvas, walls]);

  // Update center lines visibility
  useEffect(() => {
    if (wallRendererRef.current) {
      wallRendererRef.current.setShowCenterLines(wallSettings.showCenterLines);
      wallRendererRef.current.setShowHeightTags(wallSettings.showHeightTags);
      wallRendererRef.current.setWallColorMode(wallSettings.wallColorMode);
      wallRendererRef.current.setShowLayerCountIndicators(wallSettings.showLayerCountIndicators);
    }
  }, [
    wallSettings.showCenterLines,
    wallSettings.showHeightTags,
    wallSettings.wallColorMode,
    wallSettings.showLayerCountIndicators,
  ]);

  /**
   * Handle mouse down - start wall or commit current wall
   */
  const handleMouseDown = useCallback(
    (scenePoint: Point2D) => {
      const canvas = fabricRef.current;
      if (!canvas) return;

      // [SNAP WIRE] Build effective settings based on modifier keys
      const effectiveSettings = { ...wallSettings };
      if (ctrlPressedRef.current) { // [SNAP WIRE] Ctrl forces grid-only snap
        effectiveSettings.snapToGrid = true;
        effectiveSettings.endpointSnapTolerance = 0;
        effectiveSettings.midpointSnapTolerance = 0;
      }
      const effectiveWalls = altPressedRef.current ? [] : walls; // [SNAP WIRE] Alt disables all snaps
      const effectiveShift = shiftPressedRef.current;

      // Snap the point
      const snapResult = snapWallPoint(
        scenePoint,
        wallDrawingState.startPoint,
        snapEnabledRef.current ? effectiveSettings : { ...effectiveSettings, endpointSnapTolerance: 0, midpointSnapTolerance: 0, snapToGrid: false }, // [SNAP WIRE]
        effectiveWalls, // [SNAP WIRE]
        effectiveShift, // [SNAP WIRE]
        zoom,
        undefined // excludeWallId
      );
      lastSnapResultRef.current = snapResult; // [SNAP WIRE]

      if (!wallDrawingState.isDrawing) {
        // First click: start wall drawing
        startWallDrawing(snapResult.snappedPoint);
        chainWallIdsRef.current = []; // [SNAP WIRE] reset chain
        chainStartPointRef.current = snapResult.snappedPoint;

        // Track if we snapped to an endpoint
        if (
          (snapResult.snapType === 'endpoint' || snapResult.snapType === 'midpoint') &&
          snapResult.connectedWallId
        ) {
          lastSnappedWallRef.current = {
            wallId: snapResult.connectedWallId,
          };
        } else {
          lastSnappedWallRef.current = null;
        }

        // Start preview
        wallPreviewRef.current?.startPreview(
          snapResult.snappedPoint,
          wallDrawingState.previewThickness,
          wallDrawingState.previewMaterial,
          wallDrawingState.previewMaterial === wallSettings.defaultMaterial
            ? wallSettings.defaultMaterialId
            : undefined
        );
      } else {
        // Second click: commit the segment THROUGH THE WALL GRAPH (shared-node
        // topology — reference-app semantics): endpoints WELD into existing
        // corners, clicking a wall body SPLITS it (T-junction), drawing across
        // a wall splits both (X-junction). No ad-hoc connect/split here — the
        // graph maintains all of it inside one store command.
        updateWallPreview(snapResult.snappedPoint);

        const drawStart = wallDrawingState.startPoint;
        if (!drawStart) return;
        const segmentLen = Math.hypot(
          snapResult.snappedPoint.x - drawStart.x,
          snapResult.snappedPoint.y - drawStart.y,
        );
        if (segmentLen < 1) return; // ignore sub-mm clicks

        // Room-close detection: back on the chain's first point within 2mm.
        const chainAnchor = chainStartPointRef.current ?? drawStart;
        const isRoomClose =
          chainWallIdsRef.current.length >= 2 &&
          Math.hypot(
            snapResult.snappedPoint.x - chainAnchor.x,
            snapResult.snappedPoint.y - chainAnchor.y,
          ) <= 2;

        const segmentIds = wallGraphAddChain(
          [drawStart, snapResult.snappedPoint],
          {
            thickness: wallDrawingState.previewThickness,
            material: wallDrawingState.previewMaterial,
            materialId: wallDrawingState.previewMaterial === wallSettings.defaultMaterial
              ? wallSettings.defaultMaterialId
              : undefined,
          },
        );
        if (segmentIds.length > 0) {
          chainWallIdsRef.current.push(...segmentIds);
          onWallCreated?.(segmentIds[segmentIds.length - 1]!);
        }

        if (isRoomClose) {
          onRoomClosed?.([...chainWallIdsRef.current]);
          cancelWallDrawing();
          wallPreviewRef.current?.clearPreview();
          snapIndicatorRef.current?.clear();
          lastSnappedWallRef.current = null;
          chainWallIdsRef.current = [];
          chainStartPointRef.current = null;
          return;
        }

        if (wallDrawingState.chainMode) {
          // Re-anchor the chain at the fresh corner and keep drafting.
          startWallDrawing(snapResult.snappedPoint);
          const continuationWall = buildTemporaryWall(
            '__preview-anchor__',
            drawStart,
            snapResult.snappedPoint,
            wallDrawingState.previewThickness,
            wallDrawingState.previewMaterial
          );
          wallPreviewRef.current?.startPreview(
            snapResult.snappedPoint,
            wallDrawingState.previewThickness,
            wallDrawingState.previewMaterial,
            wallDrawingState.previewMaterial === wallSettings.defaultMaterial
              ? wallSettings.defaultMaterialId
              : undefined,
            continuationWall
          );
        } else {
          cancelWallDrawing();
          wallPreviewRef.current?.clearPreview();
          snapIndicatorRef.current?.clear();
          chainStartPointRef.current = null;
        }
      }
    },
    [
      fabricRef,
      wallDrawingState,
      wallSettings,
      walls,
      zoom,
      startWallDrawing,
      updateWallPreview,
      wallGraphAddChain,
      cancelWallDrawing,
      onWallCreated,
      onRoomClosed, // [SNAP WIRE]
    ]
  );

  /**
   * Handle mouse move - update preview and show snap indicators
   */
  const handleMouseMove = useCallback(
    (scenePoint: Point2D) => {
      // [SNAP WIRE] Build effective settings based on modifier keys
      const effectiveSettings = { ...wallSettings };
      if (ctrlPressedRef.current) {
        effectiveSettings.snapToGrid = true;
        effectiveSettings.endpointSnapTolerance = 0;
        effectiveSettings.midpointSnapTolerance = 0;
      }
      const effectiveWalls = altPressedRef.current ? [] : walls;

      // Snap the point
      const snapResult = snapWallPoint(
        scenePoint,
        wallDrawingState.startPoint,
        snapEnabledRef.current ? effectiveSettings : { ...effectiveSettings, endpointSnapTolerance: 0, midpointSnapTolerance: 0, snapToGrid: false }, // [SNAP WIRE]
        effectiveWalls, // [SNAP WIRE]
        shiftPressedRef.current,
        zoom,
        undefined // excludeWallId
      );
      lastSnapResultRef.current = snapResult; // [SNAP WIRE]

      if (wallDrawingState.isDrawing) {
        // Update state
        updateWallPreview(snapResult.snappedPoint);

        // Update visual preview
        wallPreviewRef.current?.updatePreview(snapResult.snappedPoint);
      }

      // [SNAP WIRE] Render snap indicators on overlay canvas (even before drawing starts)
      // cursorPx is in scene-pixel space for the angle indicator; the renderer handles the mm→viewport conversion internally
      const cursorScenePx = {
        x: scenePoint.x * MM_TO_PX,
        y: scenePoint.y * MM_TO_PX,
      };
      snapIndicatorRef.current?.render(snapResult, cursorScenePx);
    },
    [wallDrawingState, wallSettings, walls, zoom, updateWallPreview]
  );

  /**
   * Handle double click - exit chain mode
   */
  const handleDoubleClick = useCallback(() => {
    if (wallDrawingState.isDrawing) {
      cancelWallDrawing();
      wallPreviewRef.current?.clearPreview();
      snapIndicatorRef.current?.clear(); // [SNAP WIRE]
      lastSnappedWallRef.current = null;
      chainWallIdsRef.current = []; // [SNAP WIRE]
    }
  }, [wallDrawingState.isDrawing, cancelWallDrawing]);

  /**
   * Handle key down - Shift for angle lock, Ctrl for grid-only, Alt for free draw, S to toggle, Escape to cancel
   */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        shiftPressedRef.current = true;
      }
      if (e.key === 'Control') { // [SNAP WIRE]
        ctrlPressedRef.current = true; // [SNAP WIRE]
      }
      if (e.key === 'Alt') { // [SNAP WIRE]
        altPressedRef.current = true; // [SNAP WIRE]
        e.preventDefault(); // prevent browser menu bar focus
      }
      if (e.key === 's' || e.key === 'S') { // [SNAP WIRE] toggle snap
        snapEnabledRef.current = !snapEnabledRef.current; // [SNAP WIRE]
      }
      if (e.key === 'Escape') {
        cancelWallDrawing();
        wallPreviewRef.current?.clearPreview();
        snapIndicatorRef.current?.clear(); // [SNAP WIRE]
        lastSnappedWallRef.current = null;
        chainWallIdsRef.current = []; // [SNAP WIRE]
      }
    },
    [cancelWallDrawing]
  );

  /**
   * Handle key up - release modifier keys
   */
  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Shift') {
      shiftPressedRef.current = false;
    }
    if (e.key === 'Control') { // [SNAP WIRE]
      ctrlPressedRef.current = false; // [SNAP WIRE]
    }
    if (e.key === 'Alt') { // [SNAP WIRE]
      altPressedRef.current = false; // [SNAP WIRE]
    }
  }, []);

  return {
    wallRenderer: wallRendererRef.current,
    wallPreview: wallPreviewRef.current,
    wallManager: wallManagerRef.current,
    handleMouseDown,
    handleMouseMove,
    handleDoubleClick,
    handleKeyDown,
    handleKeyUp,
    isDrawing: wallDrawingState.isDrawing,
    lastSnapResult: lastSnapResultRef.current, // [SNAP WIRE]
  };
}
