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

function createRefrigerantBundleId(): string {
  return `refrigerant-bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
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
        direction: bundle.gasDirection ?? bundle.direction,
      },
      {
        point: bundle.liquidPoint,
        diameterMm: bundle.liquidOuterDiameterMm ?? 56,
        direction: bundle.liquidDirection ?? bundle.direction,
      },
    ];
    const markerFill = 'rgba(37,99,235,0.2)';
    const markerStroke = 'rgba(29,78,216,0.98)';
    const markerStrokeWidth = 2.4;
    const createFieldPipeMarker = (
      point: Point2D,
      direction: Point2D,
      diameterMm: number,
    ): fabric.Circle => {
      const markerRadius = Math.max(4, Math.min(6, diameterMm * MM_TO_PX * 0.16));
      const insetMm = markerRadius / Math.max(MM_TO_PX, 0.0001);
      const markerPoint = {
        x: point.x - direction.x * insetMm,
        y: point.y - direction.y * insetMm,
      };
      return new fabric.Circle({
        left: markerPoint.x * MM_TO_PX,
        top: markerPoint.y * MM_TO_PX,
        radius: markerRadius,
        originX: 'center',
        originY: 'center',
        fill: markerFill,
        stroke: markerStroke,
        strokeWidth: markerStrokeWidth,
        selectable: false,
        evented: false,
        excludeFromExport: true,
      });
    };
    const createUnitPortMarker = (point: Point2D, diameterMm: number): fabric.Circle => new fabric.Circle({
      left: point.x * MM_TO_PX,
      top: point.y * MM_TO_PX,
      radius: Math.max(4, Math.min(6, diameterMm * MM_TO_PX * 0.16)),
      originX: 'center',
      originY: 'center',
      fill: markerFill,
      stroke: markerStroke,
      strokeWidth: markerStrokeWidth,
      selectable: false,
      evented: false,
      excludeFromExport: true,
    });

    const shouldRecreateMarkers =
      snapMarkersRef.current.length !== markerConfigs.length
      || snapMarkerKindRef.current !== bundle.connectionKind;

    if (shouldRecreateMarkers) {
      clearSnapMarkers();
      snapMarkersRef.current = markerConfigs.map(({ point, diameterMm, direction }) => {
        const marker = bundle.connectionKind === 'field-pipe'
          ? createFieldPipeMarker(point, direction, diameterMm)
          : createUnitPortMarker(point, diameterMm);
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
      const crossSizePx = 10;
      const insetMm = bundle.connectionKind === 'field-pipe'
        ? Math.min(
            config.diameterMm * 0.22,
            (crossSizePx * 0.5) / Math.max(MM_TO_PX, 0.0001),
          )
        : 0;
      const markerPoint = bundle.connectionKind === 'field-pipe'
        ? {
            x: config.point.x - config.direction.x * insetMm,
            y: config.point.y - config.direction.y * insetMm,
          }
        : config.point;
      marker.set({
        left: markerPoint.x * MM_TO_PX,
        top: markerPoint.y * MM_TO_PX,
      });
      if (marker instanceof fabric.Circle) {
        marker.set({
          radius: Math.max(4, Math.min(6, config.diameterMm * MM_TO_PX * 0.16)),
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
    previewPointRef.current = null;
    clearPreview();
    clearSnapMarkers();
  }, [clearPreview, clearSnapMarkers]);

  const snapPoint = useCallback((point: Point2D, allowBundleSnap: boolean): {
    point: Point2D;
    bundle: RefrigerantPipeBundleConnection | null;
  } => {
    const thresholdMm = Math.max(10, 28 / Math.max(zoom * MM_TO_PX, 0.01));
    const bundle = allowBundleSnap
      ? hvacRendererRef.current?.findNearestRenderedRefrigerantPipeBundleTarget(point, thresholdMm)
        ?? findNearestRefrigerantPipeBundleTarget(hvacElements, point, thresholdMm)
      : null;

    let nextPoint = bundle?.point ?? point;
    if (snapToGrid && !bundle) {
      nextPoint = snapPointToGrid(nextPoint, gridSize);
    }
    if (routePointsRef.current.length > 0) {
      const previousPoint = routePointsRef.current[routePointsRef.current.length - 1]!;
      nextPoint = shiftPressedRef.current
        ? applyOrthogonalConstraint(previousPoint, nextPoint)
        : applyAngularConstraint(previousPoint, nextPoint, PIPE_ROUTE_ANGLE_SNAP_DEG);
    }

    return { point: nextPoint, bundle };
  }, [gridSize, hvacElements, hvacRendererRef, snapToGrid, zoom]);

  const renderRoutePreview = useCallback((routePoints: Point2D[]) => {
    if (routePoints.length < 2) {
      clearPreview();
      return;
    }
    const previewElements = buildRefrigerantPipeElements(routePoints, {
      startBundleConnection: startBundleRef.current,
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
    });
    const elementIds = addHvacElements(nextElements);
    setSelectedIds(elementIds);
    resetDrawing();
    return true;
  }, [addHvacElements, resetDrawing, setProcessingStatus, setSelectedIds]);

  const handleMouseDown = useCallback((point: Point2D) => {
    const { point: snappedPoint, bundle } = snapPoint(point, routePointsRef.current.length === 0);

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

    routePointsRef.current = [...routePointsRef.current, snappedPoint];
    previewPointRef.current = null;
    renderRoutePreview(routePointsRef.current);
  }, [clearPreview, renderRoutePreview, snapPoint]);

  const handleMouseMove = useCallback((point: Point2D) => {
    if (routePointsRef.current.length === 0) {
      const { bundle } = snapPoint(point, true);
      renderSnapMarkers(bundle);
      return;
    }

    const { point: snappedPoint } = snapPoint(point, false);
    previewPointRef.current = snappedPoint;
    renderRoutePreview([...routePointsRef.current, snappedPoint]);
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
