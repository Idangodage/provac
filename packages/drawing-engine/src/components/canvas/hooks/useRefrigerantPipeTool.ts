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
import {
  attachPipeRoute3dToElements,
  hasExplicitPipeRoute3d,
  type PipePlacementPoint,
} from '../hvac/pipeRoute3d';
import { getActivePipeRoutingSettings } from '../hvac/pipeRoutingSettings';
import {
  buildRefrigerantPipeElements,
  buildRefrigerantPipeExtensionMerge,
  findNearestRefrigerantPipeBundleTarget,
  findNearestRefrigerantPipeExtensionTarget,
  seedRefrigerantPipeRouteStart,
  type RefrigerantPipeAngleMode,
  type RefrigerantPipeBundleConnection,
  type RefrigerantPipeLineMode,
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
  /** Which line(s) to lay: coordinated `pair` (default), or a single `gas`/`liquid` line. */
  pipeLineMode: RefrigerantPipeLineMode;
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
  commitHvacElementCommand: (
    action: string,
    command: { add?: HvacElement[]; removeIds?: string[]; selectedIds?: string[] },
  ) => string[];
  /**
   * Update an element in place — used to merge an extension INTO the host pipe
   * (one continuous polyline, smooth junction bend) instead of committing a
   * second butted element. When absent, extensions fall back to new elements.
   */
  updateHvacElement?: (
    id: string,
    updates: Partial<HvacElement>,
    options?: { skipHistory?: boolean },
  ) => void;
  /** Batch the per-line merge writes into one undo step. */
  saveToHistory?: (label: string) => void;
  setSelectedIds: (ids: string[]) => void;
  setProcessingStatus: (status: string, isProcessing: boolean) => void;
  /**
   * When the SVG studio overlay owns the pipe preview, the tool pushes the live
   * draw route (world mm centreline) here so the overlay renders it as the studio
   * pair, and skips drawing its own Fabric pipe preview (branch-kit ghosts still
   * render on Fabric). null clears the overlay preview.
   */
  onDraftRouteChange?: (route: Point2D[] | null) => void;
  /**
   * Push the live pipe-draw preview elements (real gas/liquid diameters + baked
   * gap — the exact elements the commit will build) so the overlay renders the
   * preview through the same path as a committed pipe, and it never changes size
   * when the route is committed. null clears the preview.
   */
  onDraftPipesChange?: (elements: HvacElement[] | null) => void;
  /**
   * Show/hide the snap-hover indicator at a detected open end / port (world mm).
   * The overlay renders it with the SAME endpoint-handle bullseye a committed
   * pipe shows — the tool draws no marker of its own. null hides it.
   */
  onSnapIndicatorChange?: (point: Point2D | null) => void;
  overlayOwnsPipePreview?: boolean;
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
  /**
   * Start a routing session seeded from an existing bundle connection (an open
   * pipe end or a branch-kit port) — used to extend a run through the full draw
   * flow. `opts.lineMode` pins pair vs single gas/liquid for this session.
   */
  beginRouteFromBundle: (
    bundle: RefrigerantPipeBundleConnection,
    opts?: { lineMode?: RefrigerantPipeLineMode },
  ) => void;
  handleMouseDown: (point: PipePlacementPoint) => void;
  handleMouseMove: (point: PipePlacementPoint) => void;
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
const PIPE_CENTERLINE_CONTINUITY_TOLERANCE_MM = 0.25;
type RefrigerantPipeHoverSelection = 'gas' | 'liquid' | null;
type RefrigerantPipeSnapSource = 'projected' | 'model' | 'rendered' | 'visible' | null;

function readProjectedSnapTarget(point: PipePlacementPoint): RefrigerantPipeBundleConnection | null {
  const candidate = point.snapTarget;
  if (!candidate || typeof candidate !== 'object') return null;
  const bundle = candidate as Partial<RefrigerantPipeBundleConnection>;
  return bundle.point
    && typeof bundle.point.x === 'number'
    && typeof bundle.point.y === 'number'
    && typeof bundle.elevationMm === 'number'
    ? bundle as RefrigerantPipeBundleConnection
    : null;
}

function createRefrigerantBundleId(): string {
  return `refrigerant-bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function distance(a: PipePlacementPoint, b: PipePlacementPoint): number {
  const dz = typeof a.z === 'number' && typeof b.z === 'number' ? a.z - b.z : 0;
  return Math.hypot(a.x - b.x, a.y - b.y, dz);
}

/**
 * Resolves the effective angle constraint. `auto` keeps the legacy,
 * material-driven behaviour (hard ⇒ 45°, flexible ⇒ free); the explicit modes
 * give the user direct control over clean L / 45° / free-angle routing.
 */
function resolveEffectiveAngleMode(
  pipeAngleMode: RefrigerantPipeAngleMode,
  pipeMaterialMode: RefrigerantPipeMaterial,
): Exclude<RefrigerantPipeAngleMode, 'auto'> {
  return pipeAngleMode === 'auto'
    ? (pipeMaterialMode === 'hard' ? 'diagonal' : 'free')
    : pipeAngleMode;
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

/** Idle-hover affordance for the "click to continue this run" cue. */
function describeExtensionContinuation(lineMode: RefrigerantPipeLineMode): string {
  if (lineMode === 'gas') {
    return 'Continue gas line';
  }
  if (lineMode === 'liquid') {
    return 'Continue liquid line';
  }
  return 'Continue pair';
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
    pipeLineMode,
    hvacElements,
    zoom,
    snapToGrid,
    gridSize,
    addHvacElements,
    commitHvacElementCommand,
    updateHvacElement,
    saveToHistory,
    setSelectedIds,
    setProcessingStatus,
    onDraftRouteChange,
    onDraftPipesChange,
    onSnapIndicatorChange,
    overlayOwnsPipePreview,
  } = options;

  const routePointsRef = useRef<PipePlacementPoint[]>([]);
  const startBundleRef = useRef<RefrigerantPipeBundleConnection | null>(null);
  const endBundleRef = useRef<RefrigerantPipeBundleConnection | null>(null);
  const previewPointRef = useRef<PipePlacementPoint | null>(null);
  // Per-session line-mode override. When an extension session is seeded from an
  // existing end (continue that gas/liquid line, or the pair), it wins over the
  // global `pipeLineMode` selector; cleared on reset so plain drawing falls back
  // to the selector.
  const sessionLineModeRef = useRef<RefrigerantPipeLineMode | null>(null);
  const shiftPressedRef = useRef(false);
  // Alt = momentary free-angle override (bypasses angle + grid snapping).
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
  const debugOverlaysRef = useRef<fabric.FabricObject[]>([]);
  const debugEnabledRef = useRef(isPipeRoutingDebugEnabled());

  const clearSnapMarkers = useCallback(() => {
    onSnapIndicatorChange?.(null);
  }, [onSnapIndicatorChange]);

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

  // The tool draws NO snap marker of its own: it forwards the snap point (world
  // mm) to the overlay, which renders the same endpoint-handle bullseye a
  // committed pipe shows — one component for every snap affordance.
  const renderSnapMarkers = useCallback((bundle: RefrigerantPipeBundleConnection | null) => {
    onSnapIndicatorChange?.(bundle ? { x: bundle.point.x, y: bundle.point.y } : null);
  }, [onSnapIndicatorChange]);

  const clearPreview = useCallback(() => {
    hvacRendererRef.current?.clearPlacementPreview();
    onDraftRouteChange?.(null);
    onDraftPipesChange?.(null);
  }, [hvacRendererRef, onDraftRouteChange, onDraftPipesChange]);

  const clearBranchKitProposal = useCallback(() => {
    branchKitProposalRef.current = null;
    setBranchKitProposalState((previous) => (previous ? null : previous));
  }, []);

  const resetDrawing = useCallback(() => {
    routePointsRef.current = [];
    startBundleRef.current = null;
    endBundleRef.current = null;
    previewPointRef.current = null;
    sessionLineModeRef.current = null;
    proposalFlipRef.current = false;
    proposalSuppressRef.current = { active: false, at: null };
    lastProposalCursorRef.current = null;
    clearBranchKitProposal();
    clearPreview();
    clearSnapMarkers();
    clearDebugOverlays();
  }, [clearBranchKitProposal, clearDebugOverlays, clearPreview, clearSnapMarkers]);

  // Cursor→world snap radius (mm), zoom-compensated from the configured pixel
  // radius. Shared by the generic snap resolver and the extension-detection engine
  // so hovering, clicking, and welding all use one magnet size.
  const resolveExtensionThresholdMm = useCallback(
    () => getActivePipeRoutingSettings().snapRadiusPx / Math.max(zoom * MM_TO_PX, 0.01),
    [zoom],
  );

  const snapPoint = useCallback((point: PipePlacementPoint, allowBundleSnap: boolean): {
    point: PipePlacementPoint;
    bundle: RefrigerantPipeBundleConnection | null;
    source: RefrigerantPipeSnapSource;
  } => {
    const thresholdMm = resolveExtensionThresholdMm();
    let bundle: RefrigerantPipeBundleConnection | null = null;
    let source: RefrigerantPipeSnapSource = null;
    if (allowBundleSnap && !altPressedRef.current) {
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

      const projectedBundle = readProjectedSnapTarget(point);
      if (projectedBundle && !shouldExcludeBundle(projectedBundle)) {
        bundle = projectedBundle;
        source = 'projected';
      }
      const legacyPlanSnapAllowed = typeof point.z !== 'number' || !Number.isFinite(point.z);
      const renderedBundle = legacyPlanSnapAllowed
        ? (
        hvacRendererRef.current?.findNearestRenderedRefrigerantPipeBundleTarget(
          point,
          thresholdMm,
        ) ?? null
        )
        : null;
      const visibleFieldBundle = legacyPlanSnapAllowed
        ? (
        findNearestVisibleRefrigerantPipeBundleTarget(
          hvacElements,
          point,
          thresholdMm,
        ) ?? null
        )
        : null;
      const modelBundle = legacyPlanSnapAllowed
        ? (
        findNearestRefrigerantPipeBundleTarget(
          hvacElements,
          point,
          thresholdMm,
        ) ?? null
        )
        : null;

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
      if (bundle) {
        // Screen-space 3D resolver already chose this exact target.
      } else if (modelCandidate) {
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

    let nextPoint: PipePlacementPoint = snappedBundle
      ? { ...snappedBundle.point, z: snappedBundle.elevationMm }
      : point;
    // Alt = momentary free-angle override: skip angle + grid snapping so a vertex
    // can be placed exactly under the cursor.
    const freeAngleOverride = altPressedRef.current;
    const viewAdaptive3d = typeof nextPoint.z === 'number' && Number.isFinite(nextPoint.z);
    const effectiveAngleMode = resolveEffectiveAngleMode(pipeAngleMode, pipeMaterialMode);
    // Free/flexible routing should track the cursor continuously. Grid snapping
    // is reserved for constrained hard-angle runs; otherwise the preview jumps
    // from grid point to grid point instead of feeling like laid copper.
    const gridActive =
      snapToGrid &&
      !snappedBundle &&
      !freeAngleOverride &&
      !viewAdaptive3d &&
      effectiveAngleMode !== 'free';
    const previousPoint =
      !snappedBundle && routePointsRef.current.length > 0
        ? routePointsRef.current[routePointsRef.current.length - 1]!
        : null;

    if (previousPoint && !freeAngleOverride && !viewAdaptive3d) {
      const ortho = shiftPressedRef.current || effectiveAngleMode === 'ortho';
      const angleConstrained = ortho || effectiveAngleMode === 'diagonal';
      if (ortho) {
        nextPoint = { ...applyOrthogonalConstraint(previousPoint, nextPoint), z: nextPoint.z };
      } else if (effectiveAngleMode === 'diagonal') {
        nextPoint = {
          ...applyAngularConstraint(previousPoint, nextPoint, PIPE_ROUTE_ANGLE_SNAP_DEG),
          z: nextPoint.z,
        };
      }
      if (gridActive) {
        // Land near the grid while preserving the constrained bearing, so an
        // axis-aligned riser/main keeps its alignment to the previous vertex
        // instead of being knocked off by a full two-axis grid round — fixes A2
        // sub-grid drift that the previous "grid-then-angle" order reintroduced.
        const constrained = angleConstrained
          ? snapAlongRayToGrid(previousPoint, nextPoint, gridSize)
          : snapPointToGrid(nextPoint, gridSize);
        nextPoint = { ...constrained, z: nextPoint.z };
      }
    } else if (gridActive) {
      // First vertex (no previous point): snap freely to the grid.
      nextPoint = { ...snapPointToGrid(nextPoint, gridSize), z: nextPoint.z };
    }

    return { point: nextPoint, bundle: snappedBundle, source };
  }, [gridSize, hvacElements, hvacRendererRef, pipeAngleMode, pipeMaterialMode, resolveExtensionThresholdMm, snapToGrid]);

  const renderRoutePreview = useCallback((
    routePoints: PipePlacementPoint[],
    endBundleConnection: RefrigerantPipeBundleConnection | null = null,
    startBundleConnectionOverride: RefrigerantPipeBundleConnection | null = null,
    ghostElements: Array<Omit<HvacElement, 'id'>> = [],
  ) => {
    const rawBuiltElements = routePoints.length >= 2
      ? buildRefrigerantPipeElements(routePoints, {
          segmentMaterialMode: pipeMaterialMode,
          lineMode: sessionLineModeRef.current ?? pipeLineMode,
          startBundleConnection:
            startBundleConnectionOverride ?? startBundleRef.current,
          endBundleConnection,
          elevationMm: hasExplicitPipeRoute3d(routePoints)
            ? Math.min(...routePoints.map((point) => point.z!))
            : undefined,
        })
      : [];
    const builtElements = attachPipeRoute3dToElements(rawBuiltElements, routePoints);
    // Extension preview goes through the SAME merge the commit will run: the
    // draft becomes the host element(s) with the in-progress tail appended (real
    // host ids — the overlay hides its store copy while a draft overrides it), so
    // the junction bends in preview exactly as it will after commit — no crack.
    const startBundleForMerge =
      startBundleConnectionOverride ?? startBundleRef.current;
    const mergeUpdates =
      overlayOwnsPipePreview && builtElements.length > 0 && startBundleForMerge
        ? buildRefrigerantPipeExtensionMerge(
            hvacElements,
            startBundleForMerge,
            builtElements,
          )
        : null;
    const pipePreviewElements = mergeUpdates
      ? mergeUpdates.flatMap((update) => {
          const host = hvacElements.find((element) => element.id === update.id);
          return host
            ? [{
                ...host,
                position: update.position,
                width: update.width,
                depth: update.depth,
                properties: update.properties,
              }]
            : [];
        })
      : builtElements.map((previewElement, index) => ({
          ...previewElement,
          id: `__refrigerant-pipe-preview__-${index}`,
          rotation: previewElement.rotation ?? 0,
          category: previewElement.category ?? 'accessory',
          subtype: previewElement.subtype ?? 'refrigerant-pipe',
          modelLabel: previewElement.modelLabel ?? 'Refrigerant Pipe',
          supplyZoneRatio: previewElement.supplyZoneRatio ?? 0,
          properties: previewElement.properties ?? {},
        }));
    const ghostPreviewElements = ghostElements.map((ghost, index) => ({
      ...ghost,
      id: `__branch-kit-preview__-${index}`,
    }));
    // Hand the live route to the overlay so it draws the studio pair preview.
    onDraftRouteChange?.(routePoints.length >= 2 ? routePoints : null);
    // When the overlay owns the pipe preview, hand it the SAME real-diameter
    // elements the commit will build (via buildRefrigerantPipeElements above), so
    // the preview and the finished pipe are pixel-identical — no width/gap jump on
    // Enter. Otherwise Fabric keeps drawing the pipe preview itself.
    onDraftPipesChange?.(
      overlayOwnsPipePreview && pipePreviewElements.length > 0
        ? (pipePreviewElements as unknown as HvacElement[])
        : null,
    );
    // When the overlay owns the pipe preview, keep only the branch-kit ghosts on
    // Fabric — the studio pair (not the old flat line) becomes the pipe preview.
    const fabricPipeElements = overlayOwnsPipePreview ? [] : pipePreviewElements;
    const previewElements = [...fabricPipeElements, ...ghostPreviewElements];
    if (previewElements.length === 0) {
      hvacRendererRef.current?.clearPlacementPreview();
      return;
    }
    hvacRendererRef.current?.renderElementPreviews(previewElements, true);
  }, [hvacElements, hvacRendererRef, onDraftRouteChange, onDraftPipesChange, overlayOwnsPipePreview, pipeLineMode, pipeMaterialMode]);

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

  const commitRoute = useCallback((candidateFinalPoint?: PipePlacementPoint) => {
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

    const rawNextElements = buildRefrigerantPipeElements(dedupedPoints, {
      bundleId: createRefrigerantBundleId(),
      segmentMaterialMode: pipeMaterialMode,
      lineMode: sessionLineModeRef.current ?? pipeLineMode,
      startBundleConnection: startBundleRef.current,
      endBundleConnection: endBundleRef.current,
      elevationMm: hasExplicitPipeRoute3d(dedupedPoints)
        ? Math.min(...dedupedPoints.map((point) => point.z!))
        : undefined,
    });
    const nextElements = attachPipeRoute3dToElements(rawNextElements, dedupedPoints);
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
    // Extension from a plain open pipe end: MERGE the new segments into the host
    // pipe element(s) so the whole run stays one polyline per line — the junction
    // then bends exactly like a mid-draw vertex instead of two butted bodies
    // meeting with a crack. Falls through to add-new when merging doesn't apply
    // (fresh draw, unit-port / branch-kit starts, or no open matching host end).
    if (
      !hasExplicitPipeRoute3d(dedupedPoints)
      && startBundleRef.current
      && updateHvacElement
      && saveToHistory
    ) {
      const mergeUpdates = buildRefrigerantPipeExtensionMerge(
        hvacElements,
        startBundleRef.current,
        nextElements,
      );
      if (mergeUpdates) {
        mergeUpdates.forEach((update) => {
          updateHvacElement(
            update.id,
            {
              position: update.position,
              width: update.width,
              depth: update.depth,
              properties: update.properties,
            },
            { skipHistory: true },
          );
        });
        saveToHistory('Extend refrigerant pipe');
        setSelectedIds(mergeUpdates.map((update) => update.id));
        setProcessingStatus('Pipe extended — continuous run', false);
        resetDrawing();
        return true;
      }
    }

    // Detect clashes with existing routed pipes and auto-create Z-offset
    // bypasses. Off by default — routes commit exactly as drawn and the user
    // applies a bypass deliberately from the clash overlay card. Opt in via the
    // `autoBypassOnCommit` routing setting.
    if (!hasExplicitPipeRoute3d(dedupedPoints) && getActivePipeRoutingSettings().autoBypassOnCommit) {
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
    pipeLineMode,
    pipeMaterialMode,
    resetDrawing,
    saveToHistory,
    setProcessingStatus,
    setSelectedIds,
    updateHvacElement,
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
    const addedIds = commitHvacElementCommand('Insert refrigerant branch kit', {
      add: insertion.elementsToAdd,
      removeIds: insertion.removeElementIds,
      selectedIds: insertion.kitElementIds,
    });
    if (insertion.kitElementIds.length === 0) setSelectedIds(addedIds);
    setProcessingStatus(
      `Branch kit connected — ${describeBranchKitConnectionType(proposal.connectionType)}`,
      false,
    );
    resetDrawing();
    return true;
  }, [
    commitHvacElementCommand,
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
      // The proposal's tee point is the visible preview endpoint. Enter or a
      // double-click must commit that exact point, not the unsnapped cursor
      // sampled before proposal resolution.
      previewPointRef.current = proposal.teePoint;
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

  /**
   * Seed a fresh routing session from an existing bundle connection — an open
   * pipe end or a branch-kit port — so *extending* a run reuses the whole draw
   * flow (angle modes, grid, HUD, multi-vertex, weld-on-snap, branch-kit
   * proposals). `opts.lineMode` pins whether the continuation is a coordinated
   * pair or a single gas/liquid line, winning over the global selector for this
   * session. Mirrors the first-click branch of handleMouseDown.
   */
  const beginRouteFromBundle = useCallback((
    bundle: RefrigerantPipeBundleConnection,
    opts?: { lineMode?: RefrigerantPipeLineMode },
  ) => {
    resetDrawing();
    sessionLineModeRef.current = opts?.lineMode ?? null;
    const startPoint: PipePlacementPoint = { ...bundle.point, z: bundle.elevationMm };
    const routeStart = seedRefrigerantPipeRouteStart(
      startPoint,
      bundle,
      opts?.lineMode ?? pipeLineMode,
    );
    routePointsRef.current = routeStart;
    startBundleRef.current = bundle;
    previewPointRef.current = null;
    renderSnapMarkers(bundle);
    renderDebugOverlays(bundle, routeStart[0] ?? startPoint, 'model');
    if (routeStart.length >= 2) {
      renderRoutePreview(routeStart);
    } else {
      clearPreview();
    }
    onDraftRouteChange?.(routeStart);
  }, [
    clearPreview,
    onDraftRouteChange,
    pipeLineMode,
    renderDebugOverlays,
    renderRoutePreview,
    renderSnapMarkers,
    resetDrawing,
  ]);

  const handleMouseDown = useCallback((point: PipePlacementPoint) => {
    const authoritative3d = typeof point.z === 'number' && Number.isFinite(point.z);
    // First click always runs the detection engine: starting near ANY open end
    // (single or pair, gas or liquid) seamlessly continues that run with its real
    // identity — regardless of the toolbar Lines selector or how the tool was
    // re-entered. Only when nothing is near do we fall through to a fresh route.
    if (routePointsRef.current.length === 0) {
      const projectedTarget = readProjectedSnapTarget(point);
      if (projectedTarget) {
        beginRouteFromBundle(projectedTarget, {
          lineMode:
            projectedTarget.guideReference === 'gas'
            || projectedTarget.guideReference === 'liquid'
              ? projectedTarget.guideReference
              : 'pair',
        });
        return;
      }
      if (!authoritative3d) {
        const extension = findNearestRefrigerantPipeExtensionTarget(
          hvacElements,
          point,
          resolveExtensionThresholdMm(),
        );
        if (extension) {
          beginRouteFromBundle(extension.bundle, { lineMode: extension.lineMode });
          return;
        }
      }
    }

    const { point: snappedPoint, bundle, source } = snapPoint(point, true);

    if (routePointsRef.current.length === 0) {
      const routeStart = seedRefrigerantPipeRouteStart(
        snappedPoint,
        bundle,
        sessionLineModeRef.current ?? pipeLineMode,
      );
      routePointsRef.current = routeStart;
      startBundleRef.current = bundle;
      previewPointRef.current = null;
      renderSnapMarkers(bundle);
      renderDebugOverlays(bundle, routeStart[0] ?? snappedPoint, source);
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
      if (routeStart.length >= 2) {
        renderRoutePreview(routeStart);
      } else {
        clearPreview();
      }
      onDraftRouteChange?.(routeStart);
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

    // A single-line continuation can also FINISH by welding onto another lone open
    // end of the same kind — the case the generic pair/unit snapPoint above misses.
    const sessionMode = sessionLineModeRef.current;
    if (!authoritative3d && (sessionMode === 'gas' || sessionMode === 'liquid')) {
      const weld = findNearestRefrigerantPipeExtensionTarget(
        hvacElements,
        point,
        resolveExtensionThresholdMm(),
        {
          lineKind: sessionMode,
          excludeElementId: startBundleRef.current?.sourceElementId ?? undefined,
        },
      );
      if (weld) {
        endBundleRef.current = weld.bundle;
        commitRoute(weld.bundle.point);
        return;
      }
    }

    // A live, valid branch-kit proposal: clicking accepts it (inserts the
    // coordinated gas/liquid kits + inline-splits the tapped run). Only for a
    // fresh pair draw — never on a single line, and never mid-extension (a
    // session line-mode override), so a placement click during an extension can
    // never silently drop a branch kit before the user commits with Enter.
    const proposal =
      !authoritative3d && sessionLineModeRef.current === null && pipeLineMode === 'pair'
        ? branchKitProposalRef.current
        : null;
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
    beginRouteFromBundle,
    clearBranchKitProposal,
    clearPreview,
    commitRoute,
    hvacElements,
    logDebug,
    onDraftRouteChange,
    pipeLineMode,
    renderDebugOverlays,
    renderRoutePreview,
    renderSnapMarkers,
    resolveExtensionThresholdMm,
    snapPoint,
  ]);

  const handleMouseMove = useCallback((point: PipePlacementPoint) => {
    const authoritative3d = typeof point.z === 'number' && Number.isFinite(point.z);
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
      // Idle hover: run the same engine the first click will, so an open end lights
      // up with a "click to continue this run" cue that matches what the click does.
      const extension = authoritative3d
        ? null
        : findNearestRefrigerantPipeExtensionTarget(
            hvacElements,
            point,
            resolveExtensionThresholdMm(),
          );
      renderSnapMarkers(extension?.bundle ?? bundle);
      if (extension) {
        setProcessingStatus(
          `${describeExtensionContinuation(extension.lineMode)} — click to extend`,
          false,
        );
      } else if (bundle) {
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

    // A single-line continuation previews welding onto a compatible lone open end
    // (same kind, not its own start) so the connection is visible before the click —
    // the case the generic pair/unit snapPoint above does not surface.
    const singleWeldMode = sessionLineModeRef.current;
    if (
      !bundle
      && !authoritative3d
      && (singleWeldMode === 'gas' || singleWeldMode === 'liquid')
    ) {
      const weld = findNearestRefrigerantPipeExtensionTarget(
        hvacElements,
        point,
        resolveExtensionThresholdMm(),
        {
          lineKind: singleWeldMode,
          excludeElementId: startBundleRef.current?.sourceElementId ?? undefined,
        },
      );
      if (weld) {
        const weldPoint = weld.bundle.point;
        previewPointRef.current = weldPoint;
        renderSnapMarkers(weld.bundle);
        clearBranchKitProposal();
        renderRoutePreview([...routePointsRef.current, weldPoint], weld.bundle);
        const previousVertex =
          routePointsRef.current[routePointsRef.current.length - 1]!;
        setProcessingStatus(
          `${formatSegmentReadout(previousVertex, weldPoint)} · Weld to ${singleWeldMode} line — click to connect`,
          false,
        );
        return;
      }
    }

    // When not snapping to an explicit endpoint, look for a branch-kit tee on a
    // nearby run and show the dashed ghost kits + route. Otherwise plain route.
    // A branch kit is inherently a coordinated gas+liquid insertion, so it is
    // only offered while laying a fresh pair — never on a single line, and never
    // while EXTENDING an existing run (a session line-mode override marks an
    // extension: it continues that run, it does not tap another).
    const proposal =
      bundle || authoritative3d || sessionLineModeRef.current !== null || pipeLineMode !== 'pair'
        ? null
        : refreshBranchKitProposal(snappedPoint);
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
    hvacElements,
    logDebug,
    pipeLineMode,
    refreshBranchKitProposal,
    renderDebugOverlays,
    renderRoutePreview,
    renderSnapMarkers,
    resolveExtensionThresholdMm,
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
    beginRouteFromBundle,
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
