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
import { buildTemporaryWall } from '../wall/WallJoinNetwork';
import { WallManager } from '../wall/WallManager';
import { WallPreview } from '../wall/WallPreview';
import { resolveRoomBoundarySelectionSegments } from '../wall/RoomBoundarySelection';
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
  commitWall: () => string | null;
  cancelWallDrawing: () => void;
  connectWalls: (wallId: string, otherWallId: string) => void;
  addWall?: (params: { startPoint: Point2D; endPoint: Point2D; thickness?: number; material?: string; layer?: string }) => string; // [SNAP WIRE]
  deleteWall?: (id: string) => void; // [SNAP WIRE]
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
  commitWall,
  cancelWallDrawing,
  connectWalls,
  addWall: addWallProp, // [SNAP WIRE]
  deleteWall: deleteWallProp, // [SNAP WIRE]
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
          wallDrawingState.previewMaterial
        );
      } else {
        // Second click: commit wall
        updateWallPreview(snapResult.snappedPoint);

        // [SNAP WIRE] Room close detection — if snapped point matches drawState.startPoint within 2mm
        const drawStart = wallDrawingState.startPoint;
        const isRoomClose = drawStart && chainWallIdsRef.current.length >= 2 &&
          snapResult.snapType === 'endpoint' &&
          Math.hypot(
            snapResult.snappedPoint.x - (chainWallIdsRef.current.length > 0 ? walls.find(w => w.id === chainWallIdsRef.current[0])?.startPoint?.x ?? drawStart.x : drawStart.x),
            snapResult.snappedPoint.y - (chainWallIdsRef.current.length > 0 ? walls.find(w => w.id === chainWallIdsRef.current[0])?.startPoint?.y ?? drawStart.y : drawStart.y)
          ) <= 2; // [SNAP WIRE] 2mm tolerance

        // [SNAP WIRE] T-junction detection: snapped to a wall body, not its endpoints
        const isTJunction = snapResult.snapType === 'endpoint' &&
          snapResult.connectedWallId &&
          snapResult.endpoint === undefined;

        const newWallId = commitWall();

        if (newWallId) {
          chainWallIdsRef.current.push(newWallId); // [SNAP WIRE]

          // Connect to start point wall if snapped
          if (lastSnappedWallRef.current) {
            connectWalls(newWallId, lastSnappedWallRef.current.wallId);
          }

          // [SNAP WIRE] Handle T-junction splitting
          if (isTJunction && snapResult.connectedWallId && addWallProp && deleteWallProp) {
            const hostWall = walls.find(w => w.id === snapResult.connectedWallId);
            if (hostWall) {
              // Create segment A (hostWall start → snap point)
              const segmentAParams = {
                startPoint: { ...hostWall.startPoint },
                endPoint: { ...snapResult.snappedPoint },
                thickness: hostWall.thickness,
                material: hostWall.material as any,
                layer: hostWall.layer as any,
              };

              // Create segment B (snap point → hostWall end)
              const segmentBParams = {
                startPoint: { ...snapResult.snappedPoint },
                endPoint: { ...hostWall.endPoint },
                thickness: hostWall.thickness,
                material: hostWall.material as any,
                layer: hostWall.layer as any,
              };

              // Remove host wall, add segments
              deleteWallProp(hostWall.id);
              const actualSegAId = addWallProp(segmentAParams);
              const actualSegBId = addWallProp(segmentBParams);

              // Connect the new wall and segments at the junction
              connectWalls(newWallId, actualSegAId);
              connectWalls(newWallId, actualSegBId);
              connectWalls(actualSegAId, actualSegBId);

              // Preserve original host connections on the new segments
              for (const connId of hostWall.connectedWalls) {
                if (connId !== newWallId) {
                  // Check which segment the connected wall is closer to
                  const connWall = walls.find(w => w.id === connId);
                  if (connWall) {
                    const dToStart = Math.min(
                      Math.hypot(connWall.startPoint.x - hostWall.startPoint.x, connWall.startPoint.y - hostWall.startPoint.y),
                      Math.hypot(connWall.endPoint.x - hostWall.startPoint.x, connWall.endPoint.y - hostWall.startPoint.y)
                    );
                    const dToEnd = Math.min(
                      Math.hypot(connWall.startPoint.x - hostWall.endPoint.x, connWall.startPoint.y - hostWall.endPoint.y),
                      Math.hypot(connWall.endPoint.x - hostWall.endPoint.x, connWall.endPoint.y - hostWall.endPoint.y)
                    );
                    if (dToStart < dToEnd) {
                      connectWalls(actualSegAId, connId);
                    } else {
                      connectWalls(actualSegBId, connId);
                    }
                  }
                }
              }
            }
          } else if (
            // [SNAP WIRE] Endpoint connection (snapping to existing endpoint)
            (snapResult.snapType === 'endpoint' || snapResult.snapType === 'midpoint') &&
            snapResult.connectedWallId
          ) {
            connectWalls(newWallId, snapResult.connectedWallId);
            lastSnappedWallRef.current = {
              wallId: snapResult.connectedWallId,
            };
          } else {
            lastSnappedWallRef.current = null;
          }

          onWallCreated?.(newWallId);

          // [SNAP WIRE] Room close detection
          if (isRoomClose) {
            const roomWallIds = [...chainWallIdsRef.current];
            onRoomClosed?.(roomWallIds);
            cancelWallDrawing();
            wallPreviewRef.current?.clearPreview();
            snapIndicatorRef.current?.clear(); // [SNAP WIRE]
            lastSnappedWallRef.current = null;
            chainWallIdsRef.current = [];
            return;
          }

          // If chain mode, update preview for next wall
          if (wallDrawingState.chainMode) {
            const continuationWall = buildTemporaryWall(
              '__preview-anchor__',
              wallDrawingState.startPoint ?? snapResult.snappedPoint,
              snapResult.snappedPoint,
              wallDrawingState.previewThickness,
              wallDrawingState.previewMaterial
            );
            wallPreviewRef.current?.startPreview(
              snapResult.snappedPoint,
              wallDrawingState.previewThickness,
              wallDrawingState.previewMaterial,
              continuationWall
            );
          } else {
            wallPreviewRef.current?.clearPreview();
            snapIndicatorRef.current?.clear(); // [SNAP WIRE]
          }
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
      commitWall,
      cancelWallDrawing,
      connectWalls,
      addWallProp, // [SNAP WIRE]
      deleteWallProp, // [SNAP WIRE]
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
