import * as fabric from 'fabric';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { HvacElement, Point2D } from '../../../types';
import type { HvacPlanRenderer } from '../hvac/HvacPlanRenderer';
import {
  buildBranchKitInsertion,
  describeBranchKitConnectionType,
  proposeBranchKit,
  type BranchKitProposal,
  type BranchKitProposalValidity,
} from '../hvac/branchKitProposal';
import { planBundleBypasses } from '../hvac/pipeClashRouting';
import { getActivePipeRoutingSettings } from '../hvac/pipeRoutingSettings';
import {
  buildRefrigerantPipeElements,
  findNearestRefrigerantPipeBundleTarget,
  type RefrigerantPipeAngleMode,
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
  pipeAngleMode: RefrigerantPipeAngleMode;
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
  /** Remove an element by id — used to replace a tapped run with its split halves. */
  deleteHvacElement: (id: string, options?: { skipHistory?: boolean }) => void;
  setSelectedIds: (ids: string[]) => void;
  setProcessingStatus: (status: string, isProcessing: boolean) => void;
}

/** Summary of the live branch-kit proposal, surfaced so the canvas can render
 * the anchored "Insert branch kit" card. World coordinates (mm). */
export interface RefrigerantPipeBranchKitProposalState {
  teePoint: Point2D;
  connectionLabel: string;
  validity: BranchKitProposalValidity;
  violations: string[];
}

export interface UseRefrigerantPipeToolResult {
  isDrawing: boolean;
  handleMouseDown: (point: Point2D) => void;
  handleMouseMove: (point: Point2D) => void;
  handleDoubleClick: () => void;
  handleKeyDown: (event: KeyboardEvent) => boolean;
  handleKeyUp: (event: KeyboardEvent) => void;
  cancelDrawing: () => void;
  /** Live branch-kit proposal (or null) for the anchored insertion card. */
  branchKitProposal: RefrigerantPipeBranchKitProposalState | null;
  acceptBranchKitProposal: () => void;
  flipBranchKitProposal: () => void;
  dismissBranchKitProposal: () => void;
}

const PIPE_ROUTE_ANGLE_SNAP_DEG = 45;
const PIPE_SNAP_MARKER_RADIUS_PX = 14;
const PIPE_SNAP_MARKER_RADIUS_SELECTED_PX = 17;
const PIPE_CENTERLINE_CONTINUITY_TOLERANCE_MM = 0.25;
type RefrigerantPipeHoverSelection = 'gas' | 'liquid' | null;
type RefrigerantPipeSnapSource = 'model' | 'rendered' | 'visible' | null;

function createRefrigerantBundleId(): string {
  return `refrigerant-bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Snaps `target` toward the grid while keeping it exactly on the ray from
 * `from` through `target`. This lets an angle-constrained segment (ortho / 45°)
 * land near the grid without a full two-axis round knocking it off its bearing —
 * e.g. a plumb riser from an off-grid port keeps the port's x and only its
 * landing distance snaps. Guards a zero/degenerate grid or length.
 */
function snapAlongRayToGrid(from: Point2D, target: Point2D, gridSize: number): Point2D {
  if (!Number.isFinite(gridSize) || gridSize <= 0) {
    return target;
  }
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) {
    return target;
  }
  const snapped = snapPointToGrid(target, gridSize);
  const ux = dx / length;
  const uy = dy / length;
  // Project the grid-snapped point back onto the constrained bearing.
  const t = (snapped.x - from.x) * ux + (snapped.y - from.y) * uy;
  return { x: from.x + ux * t, y: from.y + uy * t };
}

/**
 * Live HUD text for the in-progress segment: length (mm) and bearing. The plan
 * canvas y-axis increases downward, so we negate dy to make 0° = right and
 * 90° = up, matching what a draughtsman expects to read.
 */
function formatSegmentReadout(from: Point2D, to: Point2D): string {
  const dxMm = to.x - from.x;
  const dyMm = to.y - from.y;
  const lengthMm = Math.hypot(dxMm, dyMm);
  let angleDeg = (Math.atan2(-dyMm, dxMm) * 180) / Math.PI;
  if (angleDeg < 0) {
    angleDeg += 360;
  }
  return `L ${Math.round(lengthMm)} mm · ∠ ${Math.round(angleDeg)}°`;
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
  const lineLabel = isLiquid ? 'Liquid' : 'Gas';
  const terminalLabel = bundle.terminalRole
    ? bundle.terminalRole.replace('-', ' ')
    : 'port';
  return `Snap ${lineLabel} ${terminalLabel} | OD ${diameterMm.toFixed(2)} mm`;
}

export function useRefrigerantPipeTool(
  options: UseRefrigerantPipeToolOptions,
): UseRefrigerantPipeToolResult {
  const {
    fabricRef,
    hvacRendererRef,
    activeTool,
    pipeMaterialMode,
    pipeAngleMode,
    hvacElements,
    zoom,
    snapToGrid,
    gridSize,
    addHvacElements,
    deleteHvacElement,
    setSelectedIds,
    setProcessingStatus,
  } = options;

  const routePointsRef = useRef<Point2D[]>([]);
  const startBundleRef = useRef<RefrigerantPipeBundleConnection | null>(null);
  const endBundleRef = useRef<RefrigerantPipeBundleConnection | null>(null);
  const previewPointRef = useRef<Point2D | null>(null);
  const shiftPressedRef = useRef(false);
  // Alt = momentary freehand override (bypasses angle + grid snapping).
  const altPressedRef = useRef(false);
  // --- Branch-kit proposal state (real-time) ---
  const branchKitProposalRef = useRef<BranchKitProposal | null>(null);
  const proposalFlipRef = useRef(false);
  const proposalSuppressRef = useRef<{ active: boolean; at: Point2D | null }>({
    active: false,
    at: null,
  });
  const lastProposalCursorRef = useRef<Point2D | null>(null);
  const [branchKitProposalState, setBranchKitProposalState] =
    useState<RefrigerantPipeBranchKitProposalState | null>(null);
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
        pipeKind: 'gas' as const,
        point: bundle.gasPoint,
        diameterMm: bundle.gasOuterDiameterMm ?? 60,
      },
      {
        pipeKind: 'liquid' as const,
        point: bundle.liquidPoint,
        diameterMm: bundle.liquidOuterDiameterMm ?? 56,
      },
    ];
    const markerTheme = {
      gas: {
        fill: 'rgba(234,88,12,0.22)',
        stroke: 'rgba(234,88,12,0.98)',
        selectedFill: 'rgba(234,88,12,0.36)',
        selectedStroke: 'rgba(194,65,12,1)',
      },
      liquid: {
        fill: 'rgba(37,99,235,0.22)',
        stroke: 'rgba(37,99,235,0.98)',
        selectedFill: 'rgba(37,99,235,0.36)',
        selectedStroke: 'rgba(29,78,216,1)',
      },
    } as const;
    const markerStrokeWidth = 4;
    const selectedMarkerStrokeWidth = 5;
    const hoveredPipe = resolveBundleMarkerSelection(bundle);
    const createPipeCenterMarker = (
      point: Point2D,
      diameterMm: number,
      pipeKind: 'gas' | 'liquid',
      isSelected: boolean,
    ): fabric.Circle => {
      const theme = markerTheme[pipeKind];
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
        fill: isSelected ? theme.selectedFill : theme.fill,
        stroke: isSelected ? theme.selectedStroke : theme.stroke,
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
      snapMarkersRef.current = markerConfigs.map(({ point, diameterMm, pipeKind }) => {
        const marker = createPipeCenterMarker(
          point,
          diameterMm,
          pipeKind,
          hoveredPipe === pipeKind,
        );
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
      const pipeKind = config.pipeKind;
      const theme = markerTheme[pipeKind];
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
          fill: isSelected ? theme.selectedFill : theme.fill,
          stroke: isSelected ? theme.selectedStroke : theme.stroke,
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

  const clearBranchKitProposal = useCallback(() => {
    branchKitProposalRef.current = null;
    setBranchKitProposalState((previous) => (previous ? null : previous));
  }, []);

  const resetDrawing = useCallback(() => {
    routePointsRef.current = [];
    startBundleRef.current = null;
    endBundleRef.current = null;
    previewPointRef.current = null;
    proposalFlipRef.current = false;
    proposalSuppressRef.current = { active: false, at: null };
    lastProposalCursorRef.current = null;
    clearBranchKitProposal();
    clearPreview();
    clearSnapMarkers();
    clearDebugOverlays();
  }, [clearBranchKitProposal, clearDebugOverlays, clearPreview, clearSnapMarkers]);

  const snapPoint = useCallback((point: Point2D, allowBundleSnap: boolean): {
    point: Point2D;
    bundle: RefrigerantPipeBundleConnection | null;
    source: RefrigerantPipeSnapSource;
  } => {
    const thresholdMm =
      getActivePipeRoutingSettings().snapRadiusPx / Math.max(zoom * MM_TO_PX, 0.01);
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
    // Alt = momentary freehand override: skip angle + grid snapping so a vertex
    // can be placed exactly under the cursor.
    const freehand = altPressedRef.current;
    // Grid snap applies whenever the document setting is on and we are not bound
    // to a port/bundle (its position is authoritative) — for BOTH hard and
    // flexible routes (previously, incorrectly, restricted to hard mode).
    const gridActive = snapToGrid && !snappedBundle && !freehand;
    const previousPoint =
      !snappedBundle && routePointsRef.current.length > 0
        ? routePointsRef.current[routePointsRef.current.length - 1]!
        : null;

    if (previousPoint && !freehand) {
      // Resolve the effective angle constraint. `auto` keeps the legacy,
      // material-driven behaviour (hard ⇒ 45°, flexible ⇒ free); the explicit
      // modes give the user direct control over clean L / 45° / free routing.
      const effectiveAngleMode = pipeAngleMode === 'auto'
        ? (pipeMaterialMode === 'hard' ? 'diagonal' : 'free')
        : pipeAngleMode;
      const ortho = shiftPressedRef.current || effectiveAngleMode === 'ortho';
      const angleConstrained = ortho || effectiveAngleMode === 'diagonal';
      if (ortho) {
        nextPoint = applyOrthogonalConstraint(previousPoint, nextPoint);
      } else if (effectiveAngleMode === 'diagonal') {
        nextPoint = applyAngularConstraint(previousPoint, nextPoint, PIPE_ROUTE_ANGLE_SNAP_DEG);
      }
      if (gridActive) {
        // Land near the grid while preserving the constrained bearing, so an
        // axis-aligned riser/main keeps its alignment to the previous vertex
        // instead of being knocked off by a full two-axis grid round — fixes A2
        // sub-grid drift that the previous "grid-then-angle" order reintroduced.
        nextPoint = angleConstrained
          ? snapAlongRayToGrid(previousPoint, nextPoint, gridSize)
          : snapPointToGrid(nextPoint, gridSize);
      }
    } else if (gridActive) {
      // First vertex (no previous point): snap freely to the grid.
      nextPoint = snapPointToGrid(nextPoint, gridSize);
    }

    return { point: nextPoint, bundle: snappedBundle, source };
  }, [gridSize, hvacElements, hvacRendererRef, pipeAngleMode, pipeMaterialMode, snapToGrid, zoom]);

  const renderRoutePreview = useCallback((
    routePoints: Point2D[],
    endBundleConnection: RefrigerantPipeBundleConnection | null = null,
    startBundleConnectionOverride: RefrigerantPipeBundleConnection | null = null,
    ghostElements: Array<Omit<HvacElement, 'id'>> = [],
  ) => {
    const pipePreviewElements = routePoints.length >= 2
      ? buildRefrigerantPipeElements(routePoints, {
          segmentMaterialMode: pipeMaterialMode,
          startBundleConnection:
            startBundleConnectionOverride ?? startBundleRef.current,
          endBundleConnection,
        }).map((previewElement, index) => ({
          ...previewElement,
          id: `__refrigerant-pipe-preview__-${index}`,
          rotation: previewElement.rotation ?? 0,
          category: previewElement.category ?? 'accessory',
          subtype: previewElement.subtype ?? 'refrigerant-pipe',
          modelLabel: previewElement.modelLabel ?? 'Refrigerant Pipe',
          supplyZoneRatio: previewElement.supplyZoneRatio ?? 0,
          properties: previewElement.properties ?? {},
        }))
      : [];
    const ghostPreviewElements = ghostElements.map((ghost, index) => ({
      ...ghost,
      id: `__branch-kit-preview__-${index}`,
    }));
    const previewElements = [...pipePreviewElements, ...ghostPreviewElements];
    if (previewElements.length === 0) {
      clearPreview();
      return;
    }
    hvacRendererRef.current?.renderElementPreviews(previewElements, true);
  }, [clearPreview, hvacRendererRef, pipeMaterialMode]);

  const refreshBranchKitProposal = useCallback((
    cursorPoint: Point2D,
  ): BranchKitProposal | null => {
    lastProposalCursorRef.current = cursorPoint;
    const startBundle = startBundleRef.current;
    if (routePointsRef.current.length === 0 || !startBundle) {
      clearBranchKitProposal();
      return null;
    }
    const suppress = proposalSuppressRef.current;
    if (suppress.active) {
      if (suppress.at && distance(cursorPoint, suppress.at) > 120) {
        proposalSuppressRef.current = { active: false, at: null };
      } else {
        clearBranchKitProposal();
        return null;
      }
    }
    const proposal = proposeBranchKit(hvacElements, startBundle, cursorPoint, {
      flip: proposalFlipRef.current,
    });
    if (!proposal) {
      clearBranchKitProposal();
      return null;
    }
    branchKitProposalRef.current = proposal;
    setBranchKitProposalState({
      teePoint: proposal.teePoint,
      connectionLabel: describeBranchKitConnectionType(proposal.connectionType),
      validity: proposal.validity,
      violations: proposal.violations,
    });
    return proposal;
  }, [clearBranchKitProposal, hvacElements]);

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
    // Detect clashes with existing routed pipes and auto-create Z-offset
    // bypasses. Off by default — routes commit exactly as drawn and the user
    // applies a bypass deliberately from the clash overlay card. Opt in via the
    // `autoBypassOnCommit` routing setting.
    if (getActivePipeRoutingSettings().autoBypassOnCommit) {
      try {
        const stagedElements = nextElements.map((element, index) => ({
          ...element,
          id: `__refrigerant-pipe-new__-${index}`,
        })) as HvacElement[];
        const scene = [...hvacElements, ...stagedElements];
        const routingSettings = getActivePipeRoutingSettings();
        const plan = planBundleBypasses(
          scene,
          stagedElements.map((element) => element.id),
          {
            mode: 'auto',
            clearanceMm: routingSettings.zOffsetClearanceMm,
            fittingAngleDeg: routingSettings.bypassFittingAngleDeg,
            ceilingLimitMm: routingSettings.ceilingLimitMm,
            floorLimitMm: routingSettings.floorLimitMm,
          },
        );
        if (plan.clashCount > 0) {
          stagedElements.forEach((stagedElement, index) => {
            const bypasses = plan.byElementId.get(stagedElement.id);
            if (bypasses && bypasses.length > 0) {
              nextElements[index]!.properties = {
                ...(nextElements[index]?.properties ?? {}),
                bypasses,
              };
            }
          });
          const directionLabel = plan.recommendedDirection === 'below' ? 'Below' : 'Above';
          const clashWord = plan.clashCount > 1 ? 'clashes' : 'clash';
          setProcessingStatus(
            `${plan.clashCount} pipe ${clashWord} bypassed — Offset ${directionLabel} +${routingSettings.zOffsetClearanceMm} mm clearance`,
            false,
          );
        }
      } catch (error) {
        if (debugEnabledRef.current) {
          // eslint-disable-next-line no-console
          console.debug('[pipe-routing] clash detection failed', error);
        }
      }
    }

    const elementIds = addHvacElements(nextElements);
    setSelectedIds(elementIds);
    resetDrawing();
    return true;
  }, [
    addHvacElements,
    hvacElements,
    logDebug,
    pipeMaterialMode,
    resetDrawing,
    setProcessingStatus,
    setSelectedIds,
  ]);

  const acceptBranchKitProposal = useCallback((): boolean => {
    const proposal = branchKitProposalRef.current;
    const startBundle = startBundleRef.current;
    if (!proposal || !startBundle || proposal.validity === 'invalid') {
      return false;
    }
    let insertion = null;
    try {
      insertion = buildBranchKitInsertion(proposal, startBundle, hvacElements);
    } catch (error) {
      if (debugEnabledRef.current) {
        // eslint-disable-next-line no-console
        console.debug('[pipe-routing] branch-kit insertion failed', error);
      }
      insertion = null;
    }
    if (!insertion) {
      setProcessingStatus('Could not place a branch kit on this run.', false);
      return false;
    }
    // Place the two joints + connect each line (gas/liquid) independently to its
    // joint outlet so the connections never cross.
    const addedIds = addHvacElements(
      insertion.elementsToAdd as unknown as Parameters<typeof addHvacElements>[0],
    );
    // Replace any tapped run(s) the insertion split into run-in/run-out halves.
    // Empty unless the real-tee topology path produced a split (W3b); skipHistory
    // so the add + removes collapse into the single "insert branch kit" undo step.
    insertion.removeElementIds.forEach((id) => {
      deleteHvacElement(id, { skipHistory: true });
    });
    setSelectedIds(insertion.kitElementIds.length > 0 ? insertion.kitElementIds : addedIds);
    setProcessingStatus(
      `Branch kit connected — ${describeBranchKitConnectionType(proposal.connectionType)}`,
      false,
    );
    resetDrawing();
    return true;
  }, [
    addHvacElements,
    deleteHvacElement,
    hvacElements,
    resetDrawing,
    setProcessingStatus,
    setSelectedIds,
  ]);

  const flipBranchKitProposal = useCallback(() => {
    proposalFlipRef.current = !proposalFlipRef.current;
    const cursor = lastProposalCursorRef.current ?? previewPointRef.current;
    if (!cursor) {
      return;
    }
    const proposal = refreshBranchKitProposal(cursor);
    if (proposal) {
      renderRoutePreview(
        [...routePointsRef.current, proposal.teePoint],
        null,
        null,
        [proposal.gasGhost.element, proposal.liquidGhost.element],
      );
    }
  }, [refreshBranchKitProposal, renderRoutePreview]);

  const dismissBranchKitProposal = useCallback(() => {
    const cursor = lastProposalCursorRef.current ?? previewPointRef.current;
    proposalSuppressRef.current = { active: true, at: cursor ?? null };
    clearBranchKitProposal();
    if (cursor && routePointsRef.current.length >= 1) {
      renderRoutePreview([...routePointsRef.current, cursor]);
    }
  }, [clearBranchKitProposal, renderRoutePreview]);

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

    // A live, valid branch-kit proposal: clicking accepts it (inserts the
    // coordinated gas/liquid kits + inline-splits the tapped run).
    const proposal = branchKitProposalRef.current;
    if (proposal && proposal.validity !== 'invalid') {
      if (acceptBranchKitProposal()) {
        return;
      }
    }

    routePointsRef.current = [...routePointsRef.current, snappedPoint];
    previewPointRef.current = null;
    clearBranchKitProposal();
    renderRoutePreview(routePointsRef.current);
  }, [
    acceptBranchKitProposal,
    clearBranchKitProposal,
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
      clearBranchKitProposal();
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

    // When not snapping to an explicit endpoint, look for a branch-kit tee on a
    // nearby run and show the dashed ghost kits + route. Otherwise plain route.
    const proposal = bundle ? null : refreshBranchKitProposal(snappedPoint);
    if (proposal) {
      renderRoutePreview(
        [...routePointsRef.current, proposal.teePoint],
        null,
        null,
        [proposal.gasGhost.element, proposal.liquidGhost.element],
      );
      setProcessingStatus(
        `Branch kit · ${describeBranchKitConnectionType(proposal.connectionType)}`,
        false,
      );
    } else {
      if (bundle) {
        clearBranchKitProposal();
      }
      renderRoutePreview(
        [...routePointsRef.current, snappedPoint],
        bundle,
      );
      // Live HUD: in-progress segment length + bearing from the previous vertex,
      // with the snap target appended when the endpoint binds to a port.
      const previousVertex =
        routePointsRef.current[routePointsRef.current.length - 1]!;
      const readout = formatSegmentReadout(previousVertex, snappedPoint);
      setProcessingStatus(
        bundle
          ? `${readout} · ${formatPortTooltip(bundle, resolveBundleHoverSelection(bundle, point))}`
          : readout,
        false,
      );
    }
  }, [
    clearBranchKitProposal,
    clearPreview,
    logDebug,
    refreshBranchKitProposal,
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
    if (event.key === 'Alt') {
      altPressedRef.current = true;
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
    if (event.key === 'Alt') {
      altPressedRef.current = false;
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
    branchKitProposal: branchKitProposalState,
    acceptBranchKitProposal,
    flipBranchKitProposal,
    dismissBranchKitProposal,
  };
}
