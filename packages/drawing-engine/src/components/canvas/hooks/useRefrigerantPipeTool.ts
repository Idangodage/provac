import * as fabric from 'fabric';
import { useCallback, useEffect, useRef } from 'react';

import type { HvacElement, Point2D } from '../../../types';
import { MM_TO_PX } from '../scale';
import { snapPointToGrid, applyAngularConstraint, applyOrthogonalConstraint } from '../snapping';
import type { HvacPlanRenderer } from '../hvac/HvacPlanRenderer';
import {
  buildRefrigerantPipeElements,
  findNearestRefrigerantPipeBundleTarget,
  type RefrigerantPipeConnectionKind,
  type RefrigerantPipeBundleConnection,
} from '../hvac/refrigerantPipePairModel';
import { findNearestVisibleRefrigerantPipeBundleTarget } from '../hvac/refrigerantPipeRenderState';

export interface UseRefrigerantPipeToolOptions {
  fabricRef: React.RefObject<fabric.Canvas | null>;
  hvacRendererRef: React.RefObject<HvacPlanRenderer | null>;
  activeTool: string;
  hvacElements: HvacElement[];
  zoom: number;
  snapToGrid: boolean;
  gridSize: number;
  addHvacElements: (
    elements: Array<
      Omit<Partial<HvacElement>, 'id'> &
      Pick<HvacElement, 'type' | 'position' | 'width' | 'depth' | 'height' | 'elevation' | 'mountType' | 'label'>
    >
  ) => string[];
  setSelectedIds: (ids: string[]) => void;
  setProcessingStatus: (status: string, isProcessing: boolean) => void;
}

export interface UseRefrigerantPipeToolResult {
  isDrawing: boolean;
  handleMouseDown: (point: Point2D) => void;
  handleMouseMove: (point: Point2D) => void;
  handleDoubleClick: () => void;
  handleKeyDown: (event: KeyboardEvent) => boolean;
  handleKeyUp: (event: KeyboardEvent) => void;
  cancelDrawing: () => void;
}

const PIPE_ROUTE_ANGLE_SNAP_DEG = 45;
const PIPE_SNAP_MARKER_RADIUS_PX = 14;
const PIPE_SNAP_MARKER_RADIUS_SELECTED_PX = 17;
const PIPE_SNAP_THRESHOLD_PX = 64;
type RefrigerantPipeHoverSelection = 'gas' | 'liquid' | null;

function createRefrigerantBundleId(): string {
  return `refrigerant-bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function resolveBundleSnapPoint(
  bundle: RefrigerantPipeBundleConnection,
  cursorPoint: Point2D,
): Point2D {
  const selectedPipe = resolveBundleHoverSelection(bundle, cursorPoint);
  if (selectedPipe === 'gas') {
    return bundle.gasPoint;
  }
  if (selectedPipe === 'liquid') {
    return bundle.liquidPoint;
  }
  return bundle.point;
}

function resolveBundleHoverSelection(
  bundle: RefrigerantPipeBundleConnection,
  cursorPoint: Point2D,
): RefrigerantPipeHoverSelection {
  const gasDistance = distance(cursorPoint, bundle.gasPoint);
  const liquidDistance = distance(cursorPoint, bundle.liquidPoint);
  return gasDistance <= liquidDistance ? 'gas' : 'liquid';
}

export function useRefrigerantPipeTool(
  options: UseRefrigerantPipeToolOptions,
): UseRefrigerantPipeToolResult {
  const {
    fabricRef,
    hvacRendererRef,
    activeTool,
    hvacElements,
    zoom,
    snapToGrid,
    gridSize,
    addHvacElements,
    setSelectedIds,
    setProcessingStatus,
  } = options;

  const routePointsRef = useRef<Point2D[]>([]);
  const startBundleRef = useRef<RefrigerantPipeBundleConnection | null>(null);
  const endBundleRef = useRef<RefrigerantPipeBundleConnection | null>(null);
  const previewPointRef = useRef<Point2D | null>(null);
  const shiftPressedRef = useRef(false);
  const snapMarkersRef = useRef<fabric.FabricObject[]>([]);
  const snapMarkerKindRef = useRef<RefrigerantPipeConnectionKind | null>(null);

  const clearSnapMarkers = useCallback(() => {
    const canvas = fabricRef.current;
    if (!canvas || snapMarkersRef.current.length === 0) {
      snapMarkerKindRef.current = null;
      return;
    }
    snapMarkersRef.current.forEach((marker) => canvas.remove(marker));
    snapMarkersRef.current = [];
    snapMarkerKindRef.current = null;
    canvas.requestRenderAll();
  }, [fabricRef]);

  const renderSnapMarkers = useCallback((bundle: RefrigerantPipeBundleConnection | null) => {
    const canvas = fabricRef.current;
    if (!canvas) {
      return;
    }
    if (!bundle) {
      clearSnapMarkers();
      return;
    }

    const markerConfigs = [
      {
        point: bundle.gasPoint,
        diameterMm: bundle.gasOuterDiameterMm ?? 60,
      },
      {
        point: bundle.liquidPoint,
        diameterMm: bundle.liquidOuterDiameterMm ?? 56,
      },
    ];
    const markerFill = 'rgba(37,99,235,0.2)';
    const markerStroke = 'rgba(29,78,216,0.98)';
    const markerStrokeWidth = 4;
    const selectedMarkerFill = 'rgba(14,116,144,0.4)';
    const selectedMarkerStroke = 'rgba(8,145,178,1)';
    const selectedMarkerStrokeWidth = 5;
    const hoveredPipe = resolveBundleHoverSelection(bundle, bundle.point);
    const createPipeCenterMarker = (
      point: Point2D,
      diameterMm: number,
      isSelected: boolean,
    ): fabric.Circle => {
      const markerRadius = Math.max(
        isSelected ? PIPE_SNAP_MARKER_RADIUS_SELECTED_PX : PIPE_SNAP_MARKER_RADIUS_PX,
        Math.min(
          isSelected ? PIPE_SNAP_MARKER_RADIUS_SELECTED_PX + 1 : PIPE_SNAP_MARKER_RADIUS_PX + 1,
          diameterMm * MM_TO_PX * (isSelected ? 0.26 : 0.22),
        ),
      );
      return new fabric.Circle({
        left: point.x * MM_TO_PX,
        top: point.y * MM_TO_PX,
        radius: markerRadius,
        originX: 'center',
        originY: 'center',
        fill: isSelected ? selectedMarkerFill : markerFill,
        stroke: isSelected ? selectedMarkerStroke : markerStroke,
        strokeWidth: isSelected ? selectedMarkerStrokeWidth : markerStrokeWidth,
        selectable: false,
        evented: false,
        excludeFromExport: true,
      });
    };

    const shouldRecreateMarkers =
      snapMarkersRef.current.length !== markerConfigs.length
      || snapMarkerKindRef.current !== bundle.connectionKind;

    if (shouldRecreateMarkers) {
      clearSnapMarkers();
      snapMarkersRef.current = markerConfigs.map(({ point, diameterMm }, index) => {
        const pipeKind = index === 0 ? 'gas' : 'liquid';
        const marker = createPipeCenterMarker(point, diameterMm, hoveredPipe === pipeKind);
        canvas.add(marker);
        canvas.bringObjectToFront(marker);
        return marker;
      });
      snapMarkerKindRef.current = bundle.connectionKind;
      canvas.requestRenderAll();
      return;
    }

    snapMarkersRef.current.forEach((marker, index) => {
      const config = markerConfigs[index]!;
      const pipeKind = index === 0 ? 'gas' : 'liquid';
      const isSelected = hoveredPipe === pipeKind;
      marker.set({
        left: config.point.x * MM_TO_PX,
        top: config.point.y * MM_TO_PX,
      });
      if (marker instanceof fabric.Circle) {
        marker.set({
          radius: Math.max(4, Math.min(6, config.diameterMm * MM_TO_PX * (isSelected ? 0.18 : 0.16))),
          fill: isSelected ? selectedMarkerFill : markerFill,
          stroke: isSelected ? selectedMarkerStroke : markerStroke,
          strokeWidth: isSelected ? selectedMarkerStrokeWidth : markerStrokeWidth,
        });
      }
      canvas.bringObjectToFront(marker);
    });
    canvas.requestRenderAll();
  }, [clearSnapMarkers, fabricRef]);

  const clearPreview = useCallback(() => {
    hvacRendererRef.current?.clearPlacementPreview();
  }, [hvacRendererRef]);

  const resetDrawing = useCallback(() => {
    routePointsRef.current = [];
    startBundleRef.current = null;
    endBundleRef.current = null;
    previewPointRef.current = null;
    clearPreview();
    clearSnapMarkers();
  }, [clearPreview, clearSnapMarkers]);

  const snapPoint = useCallback((point: Point2D, allowBundleSnap: boolean): {
    point: Point2D;
    bundle: RefrigerantPipeBundleConnection | null;
  } => {
    const thresholdMm = Math.max(14, PIPE_SNAP_THRESHOLD_PX / Math.max(zoom * MM_TO_PX, 0.01));
    let bundle: RefrigerantPipeBundleConnection | null = null;
    if (allowBundleSnap) {
      const shouldExcludeBundle = (candidate: RefrigerantPipeBundleConnection | null): boolean => {
        if (!candidate || !startBundleRef.current?.sourceElementId) {
          return false;
        }
        if (candidate.sourceElementId !== startBundleRef.current.sourceElementId) {
          return false;
        }
        // Same element: only exclude the exact same terminal role — allow
        // snapping to a different terminal (e.g. run-outlet vs branch-outlet)
        // on the same branch kit so the user can connect a field pipe between
        // different outlets.
        return (
          !candidate.terminalRole
          || !startBundleRef.current.terminalRole
          || candidate.terminalRole === startBundleRef.current.terminalRole
        );
      };

      bundle = hvacRendererRef.current?.findNearestRenderedRefrigerantPipeBundleTarget(point, thresholdMm) ?? null;
      if (shouldExcludeBundle(bundle)) {
        bundle = null;
      }
      // Fall back to the model-based snap targets when the rendered target was
      // excluded or not found — this ensures field pipe endpoints and other
      // branch kit terminals are still reachable.
      if (!bundle) {
        bundle =
          findNearestVisibleRefrigerantPipeBundleTarget(
            hvacElements,
            point,
            thresholdMm,
          ) ??
          findNearestRefrigerantPipeBundleTarget(
            hvacElements,
            point,
            thresholdMm,
          );
        if (shouldExcludeBundle(bundle)) {
          bundle = null;
        }
      }
      const visibleFieldBundle =
        findNearestVisibleRefrigerantPipeBundleTarget(
          hvacElements,
          point,
          thresholdMm,
        ) ?? null;
      const modelBundle =
        findNearestRefrigerantPipeBundleTarget(
          hvacElements,
          point,
          thresholdMm,
        ) ?? null;

      if (!shouldExcludeBundle(visibleFieldBundle)) {
        bundle = visibleFieldBundle;
      } else if (bundle?.connectionKind === 'field-pipe') {
        bundle =
          !shouldExcludeBundle(modelBundle) ? modelBundle : null;
      } else if (!bundle && !shouldExcludeBundle(modelBundle)) {
        bundle = modelBundle;
      }
    }

    const snappedBundle = bundle
      ? (() => {
          const selectedPipe = resolveBundleHoverSelection(bundle, point);
          return {
            ...bundle,
            point: resolveBundleSnapPoint(bundle, point),
            guideReference: selectedPipe ?? bundle.guideReference,
          };
        })()
      : null;

    let nextPoint = snappedBundle?.point ?? point;
    if (snapToGrid && !snappedBundle) {
      nextPoint = snapPointToGrid(nextPoint, gridSize);
    }
    if (!snappedBundle && routePointsRef.current.length > 0) {
      const previousPoint = routePointsRef.current[routePointsRef.current.length - 1]!;
      nextPoint = shiftPressedRef.current
        ? applyOrthogonalConstraint(previousPoint, nextPoint)
        : applyAngularConstraint(previousPoint, nextPoint, PIPE_ROUTE_ANGLE_SNAP_DEG);
    }

    return { point: nextPoint, bundle: snappedBundle };
  }, [gridSize, hvacElements, hvacRendererRef, snapToGrid, zoom]);

  const renderRoutePreview = useCallback((
    routePoints: Point2D[],
    endBundleConnection: RefrigerantPipeBundleConnection | null = null,
  ) => {
    if (routePoints.length < 2) {
      clearPreview();
      return;
    }
    const previewElements = buildRefrigerantPipeElements(routePoints, {
      startBundleConnection: startBundleRef.current,
      endBundleConnection,
    });
    hvacRendererRef.current?.renderElementPreviews(
      previewElements.map((previewElement, index) => ({
        ...previewElement,
        id: `__refrigerant-pipe-preview__-${index}`,
        rotation: previewElement.rotation ?? 0,
        category: previewElement.category ?? 'accessory',
        subtype: previewElement.subtype ?? 'refrigerant-pipe',
        modelLabel: previewElement.modelLabel ?? 'Refrigerant Pipe',
        supplyZoneRatio: previewElement.supplyZoneRatio ?? 0,
        properties: previewElement.properties ?? {},
      })),
      true,
    );
  }, [clearPreview, hvacRendererRef]);

  const commitRoute = useCallback((candidateFinalPoint?: Point2D) => {
    const routePoints = [...routePointsRef.current];
    if (candidateFinalPoint) {
      const lastPoint = routePoints[routePoints.length - 1];
      if (!lastPoint || distance(lastPoint, candidateFinalPoint) > 0.01) {
        routePoints.push(candidateFinalPoint);
      }
    }
    const dedupedPoints = routePoints.filter((point, index) => {
      const previous = routePoints[index - 1];
      return !previous || distance(previous, point) > 0.01;
    });
    if (dedupedPoints.length < 2) {
      setProcessingStatus('Pipe route needs at least a start point and an end point.', false);
      return false;
    }

    const nextElements = buildRefrigerantPipeElements(dedupedPoints, {
      bundleId: createRefrigerantBundleId(),
      startBundleConnection: startBundleRef.current,
      endBundleConnection: endBundleRef.current,
    });
    const elementIds = addHvacElements(nextElements);
    setSelectedIds(elementIds);
    resetDrawing();
    return true;
  }, [addHvacElements, resetDrawing, setProcessingStatus, setSelectedIds]);

  const handleMouseDown = useCallback((point: Point2D) => {
    const { point: snappedPoint, bundle } = snapPoint(point, true);

    if (routePointsRef.current.length === 0) {
      routePointsRef.current = [snappedPoint];
      startBundleRef.current = bundle;
      previewPointRef.current = null;
      renderSnapMarkers(bundle);
      clearPreview();
      return;
    }

    const lastPoint = routePointsRef.current[routePointsRef.current.length - 1]!;
    if (distance(lastPoint, snappedPoint) <= 0.01) {
      return;
    }

    // If we snapped to a bundle endpoint, auto-commit the route
    if (bundle) {
      endBundleRef.current = bundle;
      commitRoute(snappedPoint);
      return;
    }

    routePointsRef.current = [...routePointsRef.current, snappedPoint];
    previewPointRef.current = null;
    renderRoutePreview(routePointsRef.current);
  }, [clearPreview, commitRoute, renderRoutePreview, renderSnapMarkers, snapPoint]);

  const handleMouseMove = useCallback((point: Point2D) => {
    const { point: snappedPoint, bundle } = snapPoint(point, true);

    if (routePointsRef.current.length === 0) {
      renderSnapMarkers(bundle);
      return;
    }

    previewPointRef.current = snappedPoint;
    renderSnapMarkers(bundle);
    renderRoutePreview(
      [...routePointsRef.current, snappedPoint],
      bundle,
    );
  }, [renderRoutePreview, renderSnapMarkers, snapPoint]);

  const handleDoubleClick = useCallback(() => {
    void commitRoute(previewPointRef.current ?? undefined);
  }, [commitRoute]);

  const cancelDrawing = useCallback(() => {
    resetDrawing();
  }, [resetDrawing]);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Shift') {
      shiftPressedRef.current = true;
      return false;
    }
    if (event.key === 'Escape') {
      if (routePointsRef.current.length === 0) {
        return false;
      }
      if (routePointsRef.current.length >= 2) {
        return commitRoute();
      }
      cancelDrawing();
      return true;
    }
    if (event.key === 'Enter') {
      return commitRoute(previewPointRef.current ?? undefined);
    }
    return false;
  }, [cancelDrawing, commitRoute]);

  const handleKeyUp = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Shift') {
      shiftPressedRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (activeTool === 'refrigerant-pipe') {
      return;
    }
    resetDrawing();
  }, [activeTool, resetDrawing]);

  useEffect(() => {
    return () => {
      resetDrawing();
    };
  }, [resetDrawing]);

  return {
    isDrawing: routePointsRef.current.length > 0,
    handleMouseDown,
    handleMouseMove,
    handleDoubleClick,
    handleKeyDown,
    handleKeyUp,
    cancelDrawing,
  };
}
