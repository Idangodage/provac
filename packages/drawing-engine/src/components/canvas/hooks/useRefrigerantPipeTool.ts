import * as fabric from 'fabric';
import { useCallback, useEffect, useRef } from 'react';

import type { HvacElement, Point2D } from '../../../types';
import type { HvacPlanRenderer } from '../hvac/HvacPlanRenderer';
import {
  buildRefrigerantPipeElements,
  findNearestRefrigerantPipeBundleTarget,
  type RefrigerantPipeConnectionKind,
  type RefrigerantPipeBundleConnection,
  type RefrigerantPipeMaterial,
} from '../hvac/refrigerantPipePairModel';
import { findNearestVisibleRefrigerantPipeBundleTarget } from '../hvac/refrigerantPipeRenderState';
import { MM_TO_PX } from '../scale';
import { snapPointToGrid, applyAngularConstraint, applyOrthogonalConstraint } from '../snapping';

export interface UseRefrigerantPipeToolOptions {
  fabricRef: React.RefObject<fabric.Canvas | null>;
  hvacRendererRef: React.RefObject<HvacPlanRenderer | null>;
  activeTool: string;
  pipeMaterialMode: RefrigerantPipeMaterial;
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
const PIPE_SNAP_THRESHOLD_PX = 15;
const PIPE_CENTERLINE_CONTINUITY_TOLERANCE_MM = 0.25;
type RefrigerantPipeHoverSelection = 'gas' | 'liquid' | null;
type RefrigerantPipeSnapSource = 'model' | 'rendered' | 'visible' | null;

function createRefrigerantBundleId(): string {
  return `refrigerant-bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function resolveBundleHoverSelection(
  bundle: RefrigerantPipeBundleConnection,
  cursorPoint: Point2D,
): RefrigerantPipeHoverSelection {
  const gasDistance = distance(cursorPoint, bundle.gasPoint);
  const liquidDistance = distance(cursorPoint, bundle.liquidPoint);
  return gasDistance <= liquidDistance ? 'gas' : 'liquid';
}

function resolveBundleMarkerSelection(
  bundle: RefrigerantPipeBundleConnection,
): RefrigerantPipeHoverSelection {
  if (bundle.guideReference === 'gas' || bundle.guideReference === 'liquid') {
    return bundle.guideReference;
  }
  return resolveBundleHoverSelection(bundle, bundle.point);
}

function isPipeRoutingDebugEnabled(): boolean {
  const root = globalThis as Record<string, unknown>;
  if (root.__HVAC_PIPE_ROUTING_DEBUG__ === true) {
    return true;
  }
  if (typeof window !== 'undefined') {
    try {
      return window.localStorage.getItem('hvac.pipe.debug') === '1';
    } catch {
      return false;
    }
  }
  return false;
}

function toDebugPointString(point: Point2D): string {
  return `${point.x.toFixed(2)}, ${point.y.toFixed(2)}`;
}

function formatPortTooltip(
  bundle: RefrigerantPipeBundleConnection,
  hoverSelection: RefrigerantPipeHoverSelection,
): string {
  const isLiquid = hoverSelection === 'liquid';
  const diameterMm = isLiquid
    ? bundle.liquidOuterDiameterMm ?? 0
    : bundle.gasOuterDiameterMm ?? 0;
  const label = isLiquid ? 'Liquid Port' : 'Gas Port';
  return `${label} — Ø${diameterMm.toFixed(2)}mm`;
}

export function useRefrigerantPipeTool(
  options: UseRefrigerantPipeToolOptions,
): UseRefrigerantPipeToolResult {
  const {
    fabricRef,
    hvacRendererRef,
    activeTool,
    pipeMaterialMode,
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
  const debugOverlaysRef = useRef<fabric.FabricObject[]>([]);
  const snapMarkerKindRef = useRef<RefrigerantPipeConnectionKind | null>(null);
  const debugEnabledRef = useRef(isPipeRoutingDebugEnabled());

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

  const clearDebugOverlays = useCallback(() => {
    const canvas = fabricRef.current;
    if (!canvas || debugOverlaysRef.current.length === 0) {
      return;
    }
    debugOverlaysRef.current.forEach((overlay) => canvas.remove(overlay));
    debugOverlaysRef.current = [];
    canvas.requestRenderAll();
  }, [fabricRef]);

  const renderDebugOverlays = useCallback((
    bundle: RefrigerantPipeBundleConnection | null,
    snappedPoint: Point2D | null,
    snapSource: RefrigerantPipeSnapSource,
  ) => {
    if (!debugEnabledRef.current) {
      clearDebugOverlays();
      return;
    }
    const canvas = fabricRef.current;
    if (!canvas) {
      return;
    }
    clearDebugOverlays();
    if (!bundle || !snappedPoint) {
      return;
    }

    const createMarker = (point: Point2D, color: string): void => {
      const marker = new fabric.Circle({
        left: point.x * MM_TO_PX,
        top: point.y * MM_TO_PX,
        radius: 4,
        originX: 'center',
        originY: 'center',
        fill: color,
        stroke: '#0f172a',
        strokeWidth: 1,
        selectable: false,
        evented: false,
        excludeFromExport: true,
      });
      debugOverlaysRef.current.push(marker);
      canvas.add(marker);
      canvas.bringObjectToFront(marker);
    };

    const createVector = (origin: Point2D, direction: Point2D, color: string): void => {
      const vectorLengthMm = 40;
      const endpoint = {
        x: origin.x + direction.x * vectorLengthMm,
        y: origin.y + direction.y * vectorLengthMm,
      };
      const line = new fabric.Line(
        [
          origin.x * MM_TO_PX,
          origin.y * MM_TO_PX,
          endpoint.x * MM_TO_PX,
          endpoint.y * MM_TO_PX,
        ],
        {
          stroke: color,
          strokeWidth: 2,
          selectable: false,
          evented: false,
          excludeFromExport: true,
        },
      );
      debugOverlaysRef.current.push(line);
      canvas.add(line);
      canvas.bringObjectToFront(line);
    };

    createMarker(bundle.gasPoint, '#ea580c');
    createMarker(bundle.liquidPoint, '#2563eb');
    createMarker(snappedPoint, '#10b981');
    createVector(bundle.gasPoint, bundle.gasDirection ?? bundle.direction, '#ea580c');
    createVector(bundle.liquidPoint, bundle.liquidDirection ?? bundle.direction, '#2563eb');

    const debugLabel = new fabric.Text(
      `snap:${snapSource ?? 'none'} start:${toDebugPointString(snappedPoint)}`,
      {
        left: snappedPoint.x * MM_TO_PX + 8,
        top: snappedPoint.y * MM_TO_PX - 14,
        originX: 'left',
        originY: 'center',
        fontSize: 12,
        fontFamily: 'monospace',
        fill: '#0f172a',
        selectable: false,
        evented: false,
        excludeFromExport: true,
      },
    );
    debugOverlaysRef.current.push(debugLabel);
    canvas.add(debugLabel);
    canvas.bringObjectToFront(debugLabel);
    canvas.requestRenderAll();
  }, [clearDebugOverlays, fabricRef]);

  const logDebug = useCallback((message: string, payload: Record<string, unknown>) => {
    if (!debugEnabledRef.current) {
      return;
    }
    // eslint-disable-next-line no-console
    console.debug(`[pipe-routing] ${message}`, payload);
  }, []);

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
    const selectedMarkerFill = 'rgba(34,197,94,0.36)';
    const selectedMarkerStroke = 'rgba(22,163,74,1)';
    const selectedMarkerStrokeWidth = 5;
    const hoveredPipe = resolveBundleMarkerSelection(bundle);
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
      const markerRadius = Math.max(
        isSelected ? PIPE_SNAP_MARKER_RADIUS_SELECTED_PX : PIPE_SNAP_MARKER_RADIUS_PX,
        Math.min(
          isSelected ? PIPE_SNAP_MARKER_RADIUS_SELECTED_PX + 1 : PIPE_SNAP_MARKER_RADIUS_PX + 1,
          config.diameterMm * MM_TO_PX * (isSelected ? 0.26 : 0.22),
        ),
      );
      marker.set({
        left: config.point.x * MM_TO_PX,
        top: config.point.y * MM_TO_PX,
      });
      if (marker instanceof fabric.Circle) {
        marker.set({
          radius: markerRadius,
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
    clearDebugOverlays();
  }, [clearDebugOverlays, clearPreview, clearSnapMarkers]);

  const snapPoint = useCallback((point: Point2D, allowBundleSnap: boolean): {
    point: Point2D;
    bundle: RefrigerantPipeBundleConnection | null;
    source: RefrigerantPipeSnapSource;
  } => {
    const thresholdMm = PIPE_SNAP_THRESHOLD_PX / Math.max(zoom * MM_TO_PX, 0.01);
    let bundle: RefrigerantPipeBundleConnection | null = null;
    let source: RefrigerantPipeSnapSource = null;
    if (allowBundleSnap) {
      const shouldExcludeBundle = (candidate: RefrigerantPipeBundleConnection | null): boolean => {
        if (!candidate || !startBundleRef.current?.sourceElementId) {
          return false;
        }
        if (candidate.sourceElementId !== startBundleRef.current.sourceElementId) {
          return false;
        }
        // Same element: only exclude the exact same terminal role; allow
        // snapping to a different terminal (e.g. run-outlet vs branch-outlet)
        // on the same branch kit so the user can connect a field pipe between
        // different outlets.
        return (
          !candidate.terminalRole
          || !startBundleRef.current.terminalRole
          || candidate.terminalRole === startBundleRef.current.terminalRole
        );
      };

      const renderedBundle =
        hvacRendererRef.current?.findNearestRenderedRefrigerantPipeBundleTarget(
          point,
          thresholdMm,
        ) ?? null;
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

      const renderedCandidate = !shouldExcludeBundle(renderedBundle)
        ? renderedBundle
        : null;
      const visibleFieldCandidate = !shouldExcludeBundle(visibleFieldBundle)
        ? visibleFieldBundle
        : null;
      const modelCandidate = !shouldExcludeBundle(modelBundle)
        ? modelBundle
        : null;

      // Routing datum must always be centerline model data. Use rendered targets
      // only as fallback when model targets are not available.
      if (modelCandidate) {
        bundle = modelCandidate;
        source = 'model';
      } else if (renderedCandidate) {
        bundle = renderedCandidate;
        source = 'rendered';
      } else if (visibleFieldCandidate) {
        bundle = visibleFieldCandidate;
        source = 'visible';
      } else {
        bundle = null;
        source = null;
      }

      if (bundle?.connectionKind === 'field-pipe' && source !== 'model') {
        // Do not allow continuation from rendered geometry for field-pipe snaps.
        bundle = null;
        source = null;
      }
    }

    const snappedBundle = bundle
      ? (() => {
          const selectedPipe = resolveBundleHoverSelection(bundle, point);
          return {
            ...bundle,
            guideReference: selectedPipe ?? bundle.guideReference,
          };
        })()
      : null;

    let nextPoint = snappedBundle?.point ?? point;
    if (pipeMaterialMode === 'hard' && snapToGrid && !snappedBundle) {
      nextPoint = snapPointToGrid(nextPoint, gridSize);
    }
    if (!snappedBundle && routePointsRef.current.length > 0) {
      const previousPoint = routePointsRef.current[routePointsRef.current.length - 1]!;
      nextPoint = shiftPressedRef.current
        ? applyOrthogonalConstraint(previousPoint, nextPoint)
        : pipeMaterialMode === 'hard'
          ? applyAngularConstraint(previousPoint, nextPoint, PIPE_ROUTE_ANGLE_SNAP_DEG)
          : nextPoint;
    }

    return { point: nextPoint, bundle: snappedBundle, source };
  }, [gridSize, hvacElements, hvacRendererRef, pipeMaterialMode, snapToGrid, zoom]);

  const renderRoutePreview = useCallback((
    routePoints: Point2D[],
    endBundleConnection: RefrigerantPipeBundleConnection | null = null,
    startBundleConnectionOverride: RefrigerantPipeBundleConnection | null = null,
  ) => {
    if (routePoints.length < 2) {
      clearPreview();
      return;
    }
    const previewElements = buildRefrigerantPipeElements(routePoints, {
      segmentMaterialMode: pipeMaterialMode,
      startBundleConnection:
        startBundleConnectionOverride ?? startBundleRef.current,
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
  }, [clearPreview, hvacRendererRef, pipeMaterialMode]);

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
      segmentMaterialMode: pipeMaterialMode,
      startBundleConnection: startBundleRef.current,
      endBundleConnection: endBundleRef.current,
    });
    if (debugEnabledRef.current && startBundleRef.current) {
      nextElements.forEach((element) => {
        const properties = (element.properties ?? {}) as {
          lineKind?: string;
          routePoints?: Array<{ x?: unknown; y?: unknown }>;
        };
        if (!Array.isArray(properties.routePoints) || properties.routePoints.length < 1) {
          return;
        }
        const firstPoint = properties.routePoints[0];
        if (
          !firstPoint
          || typeof firstPoint.x !== 'number'
          || typeof firstPoint.y !== 'number'
        ) {
          return;
        }
        const expectedStart = properties.lineKind === 'liquid'
          ? startBundleRef.current?.liquidFieldPoint ?? null
          : startBundleRef.current?.gasFieldPoint ?? null;
        if (!expectedStart) {
          return;
        }
        const deviation = distance(
          { x: firstPoint.x, y: firstPoint.y },
          expectedStart,
        );
        if (deviation > PIPE_CENTERLINE_CONTINUITY_TOLERANCE_MM) {
          logDebug('CENTERLINE_CONTINUITY_DEVIATION', {
            lineKind: properties.lineKind ?? 'gas',
            deviationMm: deviation,
            expectedStart: toDebugPointString(expectedStart),
            committedStart: toDebugPointString({ x: firstPoint.x, y: firstPoint.y }),
          });
        }

        if (endBundleRef.current) {
          const lastPoint = properties.routePoints[properties.routePoints.length - 1];
          if (
            lastPoint
            && typeof lastPoint.x === 'number'
            && typeof lastPoint.y === 'number'
          ) {
            const expectedEnd = properties.lineKind === 'liquid'
              ? endBundleRef.current.liquidFieldPoint
              : endBundleRef.current.gasFieldPoint;
            const endDeviation = distance(
              { x: lastPoint.x, y: lastPoint.y },
              expectedEnd,
            );
            if (endDeviation > PIPE_CENTERLINE_CONTINUITY_TOLERANCE_MM) {
              logDebug('CENTERLINE_END_CONTINUITY_DEVIATION', {
                lineKind: properties.lineKind ?? 'gas',
                deviationMm: endDeviation,
                expectedEnd: toDebugPointString(expectedEnd),
                committedEnd: toDebugPointString({ x: lastPoint.x, y: lastPoint.y }),
              });
            }
          }
        }
      });
    }
    const elementIds = addHvacElements(nextElements);
    setSelectedIds(elementIds);
    resetDrawing();
    return true;
  }, [
    addHvacElements,
    logDebug,
    pipeMaterialMode,
    resetDrawing,
    setProcessingStatus,
    setSelectedIds,
  ]);

  const handleMouseDown = useCallback((point: Point2D) => {
    const { point: snappedPoint, bundle, source } = snapPoint(point, true);

    if (routePointsRef.current.length === 0) {
      routePointsRef.current = [snappedPoint];
      startBundleRef.current = bundle;
      previewPointRef.current = null;
      renderSnapMarkers(bundle);
      renderDebugOverlays(bundle, snappedPoint, source);
      if (bundle) {
        logDebug('SNAP_LOCKED', {
          source,
          connectionKind: bundle.connectionKind,
          sourceElementId: bundle.sourceElementId ?? null,
          start: toDebugPointString(snappedPoint),
          gasPoint: toDebugPointString(bundle.gasPoint),
          liquidPoint: toDebugPointString(bundle.liquidPoint),
          guideReference: bundle.guideReference ?? null,
        });
      }
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
      logDebug('SNAP_LOCKED_END', {
        source,
        connectionKind: bundle.connectionKind,
        sourceElementId: bundle.sourceElementId ?? null,
        end: toDebugPointString(snappedPoint),
      });
      commitRoute(snappedPoint);
      return;
    }

    routePointsRef.current = [...routePointsRef.current, snappedPoint];
    previewPointRef.current = null;
    renderRoutePreview(routePointsRef.current);
  }, [
    clearPreview,
    commitRoute,
    logDebug,
    renderDebugOverlays,
    renderRoutePreview,
    renderSnapMarkers,
    snapPoint,
  ]);

  const handleMouseMove = useCallback((point: Point2D) => {
    const { point: snappedPoint, bundle, source } = snapPoint(point, true);
    renderDebugOverlays(bundle, snappedPoint, source);
    if (bundle && source !== 'model') {
      logDebug('NON_MODEL_SNAP_SOURCE', {
        source,
        connectionKind: bundle.connectionKind,
        sourceElementId: bundle.sourceElementId ?? null,
      });
    }

    if (routePointsRef.current.length === 0) {
      renderSnapMarkers(bundle);
      if (bundle) {
        setProcessingStatus(
          formatPortTooltip(bundle, resolveBundleHoverSelection(bundle, point)),
          false,
        );
      } else {
        setProcessingStatus('', false);
      }
      clearPreview();
      return;
    }

    previewPointRef.current = snappedPoint;
    renderSnapMarkers(bundle);
    renderRoutePreview(
      [...routePointsRef.current, snappedPoint],
      bundle,
    );
  }, [
    clearPreview,
    logDebug,
    renderDebugOverlays,
    renderRoutePreview,
    renderSnapMarkers,
    setProcessingStatus,
    snapPoint,
  ]);

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
