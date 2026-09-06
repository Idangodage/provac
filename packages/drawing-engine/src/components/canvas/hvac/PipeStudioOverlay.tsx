'use client';

/**
 * PipeStudioOverlay — the pipe-studio editor, applied in-place on the drawing
 * canvas.
 *
 * A transparent SVG overlay synchronized with the drawing viewport. It renders
 * the persisted gas/liquid lanes through the shared pipe model and edits them
 * through history commands. Edit handles simplify sampled bends while the
 * visible pipes retain the authoritative connection geometry.
 *
 * Gated by the caller (`enabled`) behind the `hvac.pipe.engine` flag, so the
 * default Fabric canvas is unaffected until it is switched on.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import { useSmartDrawingStore } from '../../../store';
import type { HvacElement, Point2D } from '../../../types';
import { generateId } from '../../../utils/geometry';
import type { ManufacturerRuleProfile } from '../../../vrf/rules';
import {
  affineMatrixToSvg,
  canvasTransformToSvgMatrix,
  clientPointToWorldFromFabricViewport,
  fabricViewportToWorldSvgMatrix,
  getCanvasTransform,
  type FabricViewportMatrix,
} from '../coordinateTransform';
import { MM_TO_PX } from '../scale';

import { CopperSocketElbowPlan } from './CopperSocketElbowPlan';
import { PipeRoutingToolbar } from './PipeRoutingToolbar';
import {
  solveBranchKitSnap,
  type BranchKitSnap,
  type PlaceablePort,
  type PlacementTransform,
} from './branchKitPlacementSnap';
import {
  BRANCH_KIT_SPRITE_ASPECT,
  BRANCH_KIT_SPRITE_GAS,
  BRANCH_KIT_SPRITE_LIQUID,
} from './branchKitSprite';
import { branchKitSpriteTransform } from './branchKitSpriteTransform';
import type { CopperSocketElbowPlacement } from './copperSocketElbowRoute';
import type { PipeSnapIndicator } from './pipeDraftingPolicy';
import { resolveEditablePipeVertexIndex } from './pipeInteractionCore';
import { buildPipeKitConnectionTargets } from './pipeKitConnectionTargets';
import { buildPipePlanTubes, pipePolylinePath } from './pipePlanPresentation';
import { withCanonicalPipeRoute } from './pipeRoute3d';
import { getActivePipeRoutingSettings } from './pipeRoutingSettings';
import {
  buildRefrigerantBranchKitViewModel,
  resolveRefrigerantBranchKitConnectionIdentity,
} from './refrigerantBranchKitModel';
import { DEFAULT_REFRIGERANT_PIPE_GAP_MM } from './refrigerantPipeDimensions';
import {
  findNearestRefrigerantPipeBundleTarget,
  findNearestRefrigerantPipeExtensionTarget,
  getBranchKitPortConnections,
  constrainRefrigerantPipeRouteForConnections,
  resolveRefrigerantPipeBranchKitReconnectionUpdates,
  resolveRefrigerantPipePairSpec,
  resolveRefrigerantPipeSpec,
  type RefrigerantPipeBundleConnection,
  type RefrigerantPipeLineMode,
} from './refrigerantPipePairModel';

const PIPE_SELECTION_HIT_PADDING_PX = 12;
const PIPE_SELECTION_MIN_HIT_WIDTH_PX = 28;
const BRANCH_KIT_PORT_REVEAL_RADIUS_PX = 30;
const BRANCH_KIT_PORT_HIT_PADDING_PX = 10;

// One branch-kit port (gas+liquid bundle) in world coords, carrying its identity
// (sourceElementId + terminalRole) — the origin for drawing a pipe out of the kit.
type KitPortConn = ReturnType<typeof getBranchKitPortConnections>[number];

function branchKitPortKey(kitId?: string | null, terminalRole?: string | null): string {
  return `${kitId ?? 'kit'}:${terminalRole ?? 'port'}`;
}

// 2D symbol for the copper branch kit: the REAL DIS-371-1G geometry projected +
// copper-shaded from the manufacturer IFC mesh, embedded as data URIs so the
// package is self-contained (no /public asset, no fetch, no dev-server coupling).
// The exact fitting — inlet-left, run-right, branch dropping down — not a drawing.
const KIT_IMG: Record<'gas' | 'liquid' | 'both', string> = {
  both: BRANCH_KIT_SPRITE_GAS,
  gas: BRANCH_KIT_SPRITE_GAS,
  liquid: BRANCH_KIT_SPRITE_LIQUID,
};
const KIT_IMG_ASPECT = BRANCH_KIT_SPRITE_ASPECT;
const DEFAULT_OUTER_DIAMETER_MM = 28;
const GAS_COLORS = { ins: '#D2E2F1', core: '#1F6FB2', sheen: '#7FB2E0' };
const LIQUID_COLORS = { ins: '#F1E4CD', core: '#B5742F', sheen: '#E3A968' };
// Copper Refnet body pieces (local mm coords), matching the real DIS-22-1G:
// slim glossy tubes (layered strokes so bends read as cylinders), bamboo swage
// bulges with ring seams, a bulb junction, and flared end sockets.
function kitPathD(pts: Point2D[]): string {
  return 'M' + pts.map((p) => `${p.x} ${p.y}`).join(' L');
}
function kitGlossPath(key: string, d: string, r: number): JSX.Element {
  const s = { fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  // Layered strokes wide->narrow build a cylindrical copper cross-section: deep
  // shadowed edges, a warm body, and a crisp central specular = polished metal.
  return (
    <g key={key}>
      <path d={d} stroke="#4a2610" strokeWidth={2 * r + r * 0.5} {...s} />
      <path d={d} stroke="#7d3f1c" strokeWidth={2 * r + r * 0.1} {...s} />
      <path d={d} stroke="#b56f37" strokeWidth={2 * r * 0.86} {...s} />
      <path d={d} stroke="#e19c60" strokeWidth={r * 1.15} strokeOpacity={0.8} {...s} />
      <path d={d} stroke="#ffe3c4" strokeWidth={r * 0.55} strokeOpacity={0.75} {...s} />
      <path d={d} stroke="#fffdf8" strokeWidth={r * 0.2} strokeOpacity={0.92} {...s} />
    </g>
  );
}
function kitGloss(key: string, pts: Point2D[], r: number): JSX.Element {
  return kitGlossPath(key, kitPathD(pts), r);
}
// A stepped reducer (the "different pipe size" bamboo section): a wider cylinder
// joined to the base tube by short ANGLED tapers — not a round balloon bulge.
function kitSwage(key: string, c: Point2D, dir: Point2D, r: number): JSX.Element {
  const dl = Math.hypot(dir.x, dir.y) || 1;
  const dx = dir.x / dl;
  const dy = dir.y / dl;
  const nx = -dy;
  const ny = dx;
  const R = r * 1.4; // wider section
  const L = r * 1.25; // half-length of the wide flat
  const T = r * 0.7; // taper length
  const P = (t: number, w: number) => `${c.x + dx * t + nx * w} ${c.y + dy * t + ny * w}`;
  const d =
    `M ${P(-L - T, r)} L ${P(-L, R)} L ${P(L, R)} L ${P(L + T, r)}` +
    ` L ${P(L + T, -r)} L ${P(L, -R)} L ${P(-L, -R)} L ${P(-L - T, -r)} Z`;
  return (
    <g key={key}>
      <path d={d} fill="url(#bkCu)" stroke="#7d3f1c" strokeWidth={Math.max(r * 0.08, 0.35)} strokeLinejoin="round" />
      <path d={`M ${P(-L, R * 0.5)} L ${P(L, R * 0.5)}`} fill="none" stroke="#fff1df" strokeWidth={r * 0.5} strokeLinecap="round" strokeOpacity={0.55} />
    </g>
  );
}
// The DIS-22-1G connection: the thin inlet widens through a STRAIGHT-SIDED
// trapezoidal flare into the body; the run continues flat along the top and the
// branch peels off the bottom through a concave crotch — per the drawing crop.
function kitWedge(key: string, jn: Point2D, r: number, bs: Point2D): JSX.Element {
  const Lw = r * 3.0; // flare length along the main tube
  const topRun = jn.y - r; // run-through top line
  const topIn = jn.y - r * 0.62; // inlet is thinner than the run
  const d =
    `M ${jn.x - Lw} ${topIn}` +
    ` L ${jn.x - Lw * 0.35} ${topRun}` + // straight diagonal flare up to the run top
    ` L ${jn.x + Lw} ${topRun}` + // run continues flat
    ` C ${jn.x + Lw * 0.62} ${jn.y + r * 1.2} ${bs.x + r * 1.25} ${bs.y - r * 0.7} ${bs.x + r} ${bs.y}` + // concave crotch into branch (run side)
    ` L ${bs.x - r} ${bs.y}` + // branch neck
    ` C ${bs.x - r * 1.7} ${bs.y - r * 0.9} ${jn.x - Lw * 0.35} ${jn.y + r * 0.95} ${jn.x - Lw} ${jn.y + r * 0.62} Z`; // straight-ish flare bottom back to the thin inlet
  return (
    <g key={key}>
      <path d={d} fill="#7d3f1c" strokeLinejoin="round" />
      <path d={d} fill="url(#bkCub)" transform="translate(0 -0.5)" strokeLinejoin="round" />
      <ellipse cx={jn.x - Lw * 0.1} cy={jn.y - r * 0.4} rx={Lw * 0.5} ry={r * 0.8} fill="#fff4e8" opacity={0.4} />
    </g>
  );
}
function kitSocket(key: string, c: Point2D, dir: Point2D, r: number): JSX.Element {
  const rx = Math.abs(dir.x) * r * 0.55 + Math.abs(dir.y) * r;
  const ry = Math.abs(dir.x) * r + Math.abs(dir.y) * r * 0.55;
  return (
    <g key={key}>
      <ellipse cx={c.x} cy={c.y} rx={rx} ry={ry} fill="#8a4a24" stroke="#7d3f1c" strokeWidth={r * 0.1} />
      <ellipse cx={c.x - dir.x * r * 0.2} cy={c.y - dir.y * r * 0.2} rx={rx * 0.6} ry={ry * 0.6} fill="#3e2410" />
    </g>
  );
}

interface PipeStudioOverlayProps {
  ruleProfile?: ManufacturerRuleProfile;
  enabled: boolean;
  /** Keep pipe artwork mounted while the plan sheet tilts; disable editing separately. */
  interactive?: boolean;
  width: number;
  height: number;
  viewportZoom: number;
  panOffset: Point2D;
  selectionHitTesting: boolean;
  pipeToolActive: boolean;
  /** Global Lines selector — decides pair vs single gas/liquid when pulling from a kit port. */
  pipeLineMode: RefrigerantPipeLineMode;
  hvacElements: HvacElement[];
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  commitHvacElementCommand: (
    action: string,
    command: {
      add?: HvacElement[];
      updates?: Array<{ id: string; updates: Partial<HvacElement> }>;
      selectedIds?: string[];
    },
  ) => string[];
  /**
   * Continue a run from an existing end: a pipe-end / bundle / branch-kit-port
   * grip hands up the bundle connection to route from + which line(s) to lay.
   * The parent switches to the pipe tool and seeds a full routing session.
   */
  onBeginExtendRoute: (
    bundle: RefrigerantPipeBundleConnection,
    lineMode: RefrigerantPipeLineMode,
  ) => void;
}

interface PipeView {
  id: string;
  element: HvacElement;
  route: Point2D[];
  isPair: boolean;
  lineKind: 'gas' | 'liquid' | null;
  gapMm: number;
  outerMm: number;
  bendMm: number;
  /** Which perpendicular side of its bundle partner this single line sits on. */
  /** Explicit gas<->liquid linkage (same id for the two lines of one bundle). */
  bundleId: string | null;
  startConnected: boolean;
  endConnected: boolean;
  startProtectedVertexCount: number;
  endProtectedVertexCount: number;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readRoute(value: unknown): Point2D[] {
  if (!Array.isArray(value)) return [];
  const pts: Point2D[] = [];
  for (const p of value) {
    if (p && typeof p.x === 'number' && typeof p.y === 'number') pts.push({ x: p.x, y: p.y });
  }
  return pts;
}

/** Closest point on a polyline to `pt` (used to sit handles on the rounded body). */
function nearestOnPolyline(pt: Point2D, poly: Point2D[]): Point2D {
  let best = poly[0] ?? pt;
  let bd = Infinity;
  for (let i = 0; i < poly.length - 1; i += 1) {
    const a = poly[i]!;
    const b = poly[i + 1]!;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const l2 = abx * abx + aby * aby;
    let t = l2 < 1e-9 ? 0 : ((pt.x - a.x) * abx + (pt.y - a.y) * aby) / l2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + abx * t;
    const py = a.y + aby * t;
    const d = (pt.x - px) ** 2 + (pt.y - py) ** 2;
    if (d < bd) {
      bd = d;
      best = { x: px, y: py };
    }
  }
  return best;
}

function dedupe(route: Point2D[], epsMm: number): Point2D[] {
  const out: Point2D[] = [];
  for (const p of route) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > epsMm) out.push({ x: p.x, y: p.y });
  }
  return out;
}

function unit(ax: number, ay: number): { x: number; y: number; n: number } {
  const n = Math.hypot(ax, ay);
  return n < 1e-9 ? { x: 1, y: 0, n: 0 } : { x: ax / n, y: ay / n, n };
}

function simplifyRoute(route: Point2D[], tolMm: number): Point2D[] {
  if (route.length <= 2) return route;
  const out: Point2D[] = [route[0]!];
  for (let i = 1; i < route.length - 1; i += 1) {
    const a = out[out.length - 1]!;
    const c = route[i]!;
    const b = route[i + 1]!;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len = Math.hypot(abx, aby);
    const d = len < 1e-6
      ? Math.hypot(c.x - a.x, c.y - a.y)
      : Math.abs((c.x - a.x) * aby - (c.y - a.y) * abx) / len;
    if (d > tolMm) out.push(c);
  }
  out.push(route[route.length - 1]!);
  return out;
}

/** Removes only coincident points (keeps intentional collinear vertices). */
/** Intersection of two infinite lines (point + direction), or null if parallel. */
function lineIntersect(p: Point2D, d1: Point2D, q: Point2D, d2: Point2D): Point2D | null {
  const det = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(det) < 1e-9) return null;
  const t = ((q.x - p.x) * d2.y - (q.y - p.y) * d2.x) / det;
  return { x: p.x + d1.x * t, y: p.y + d1.y * t };
}

/**
 * Rebuilds a route as straight legs meeting at single corner vertices. A pipe
 * run drawn/stored with rounded multi-point bends is collapsed to its real
 * fittings: group segments into straight runs (by accumulated heading change),
 * keep the long ones as legs, and place one vertex at each leg-to-leg
 * intersection. Each elbow becomes exactly one vertex, ready for a short fillet.
 * Falls back to the lightly-simplified route when it can't find clean legs.
 */
function reconstructCorners(route: Point2D[]): Point2D[] {
  const cleaned = simplifyRoute(route, 1);
  if (cleaned.length <= 3) return cleaned;

  const segs: { aIdx: number; bIdx: number; dx: number; dy: number; len: number }[] = [];
  for (let i = 0; i < cleaned.length - 1; i += 1) {
    const dx = cleaned[i + 1]!.x - cleaned[i]!.x;
    const dy = cleaned[i + 1]!.y - cleaned[i]!.y;
    const l = Math.hypot(dx, dy);
    if (l > 1e-6) segs.push({ aIdx: i, bIdx: i + 1, dx: dx / l, dy: dy / l, len: l });
  }
  if (segs.length < 2) return cleaned;

  const HEADING_TOL = 0.2; // ~11deg: within this of the run's start heading -> same leg
  type Run = { start: Point2D; end: Point2D; len: number };
  const runs: Run[] = [];
  let ref = segs[0]!;
  let start = cleaned[segs[0]!.aIdx]!;
  let end = cleaned[segs[0]!.bIdx]!;
  let runLen = segs[0]!.len;
  for (let i = 1; i < segs.length; i += 1) {
    const s = segs[i]!;
    const ang = Math.acos(Math.max(-1, Math.min(1, ref.dx * s.dx + ref.dy * s.dy)));
    if (ang < HEADING_TOL) {
      end = cleaned[s.bIdx]!;
      runLen += s.len;
    } else {
      runs.push({ start, end, len: runLen });
      ref = s;
      start = cleaned[s.aIdx]!;
      end = cleaned[s.bIdx]!;
      runLen = s.len;
    }
  }
  runs.push({ start, end, len: runLen });

  // Real legs and bend-arc fragments separate by absolute scale, not by
  // proportion of the longest run: arc chords sample at <=~10mm while the
  // shortest real fitting legs (port stubs, risers, gathers) are tens of mm.
  // A proportional cutoff on a long main discards genuine short legs and
  // renders pipes detached from the units they are welded to.
  const minLeg = 12;
  const legs = runs
    .filter((r) => r.len >= minLeg)
    .map((r) => {
      const u = unit(r.end.x - r.start.x, r.end.y - r.start.y);
      return { start: r.start, end: r.end, dir: { x: u.x, y: u.y } };
    });
  if (legs.length < 2) return cleaned;

  const out: Point2D[] = [{ x: legs[0]!.start.x, y: legs[0]!.start.y }];
  for (let i = 0; i < legs.length - 1; i += 1) {
    const x = lineIntersect(legs[i]!.start, legs[i]!.dir, legs[i + 1]!.start, legs[i + 1]!.dir);
    out.push(x ?? { x: legs[i]!.end.x, y: legs[i]!.end.y });
  }
  const last = legs[legs.length - 1]!;
  out.push({ x: last.end.x, y: last.end.y });
  out[0] = { ...route[0]! }; out[out.length - 1] = { ...route[route.length - 1]! }; return out;
}

function toPipeView(el: HvacElement, edited = false): PipeView | null {
  if (el.type !== 'refrigerant-pipe' && el.type !== 'refrigerant-pipe-pair') return null;
  const props = (el.properties ?? {}) as Record<string, unknown>;
  const raw = readRoute(props.routePoints);
  // Un-edited pipes get their rounded bends collapsed to clean corners. Once the
  // user has edited a pipe we trust its route as-is (only drop coincident
  // points), so inserted/collinear vertices are not simplified away.
  const route = edited ? dedupe(raw, 0.01) : reconstructCorners(raw);
  if (route.length < 2) return null;
  const outerMm = readNumber(props.outerDiameterMm, DEFAULT_OUTER_DIAMETER_MM);
  const rawKind = typeof props.lineKind === 'string' ? props.lineKind : null;
  const connectionState = el.type === 'refrigerant-pipe'
    ? (() => {
        const spec = resolveRefrigerantPipeSpec(props);
        return {
          start: Boolean(spec.startConnection),
          end: Boolean(spec.endConnection),
          startProtected: spec.startConnection?.connectionKind === 'unit-port' ? 2 : 1,
          endProtected: spec.endConnection?.connectionKind === 'unit-port' ? 2 : 1,
        };
      })()
    : (() => {
        const spec = resolveRefrigerantPipePairSpec(props);
        return {
          start: Boolean(spec.startBundleConnection),
          end: Boolean(spec.endBundleConnection),
          startProtected: spec.startBundleConnection?.connectionKind === 'unit-port' ? 2 : 1,
          endProtected: spec.endBundleConnection?.connectionKind === 'unit-port' ? 2 : 1,
        };
      })();
  return {
    id: el.id,
    element: el,
    route,
    isPair: el.type === 'refrigerant-pipe-pair',
    lineKind: rawKind === 'gas' ? 'gas' : rawKind === 'liquid' ? 'liquid' : null,
    gapMm: readNumber(props.pipeGapMm, DEFAULT_REFRIGERANT_PIPE_GAP_MM),
    outerMm,
    // Short-radius elbow: tight, realistic copper bend (~0.8x the insulated OD),
    // not a long sweeping curve.
    bendMm: Math.max(outerMm * 0.8, 12),
    bundleId: typeof props.bundleId === 'string' && props.bundleId.length > 0 ? props.bundleId : null,
    startConnected: connectionState.start,
    endConnected: connectionState.end,
    startProtectedVertexCount: connectionState.startProtected,
    endProtectedVertexCount: connectionState.endProtected,
  };
}

function bbox(route: Point2D[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of route) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function withPipeRoute(element: HvacElement, route: Point2D[]): HvacElement {
  const constrainedRoute = constrainRefrigerantPipeRouteForConnections(
    element.type,
    element.properties,
    route,
  );
  const box = bbox(constrainedRoute);
  const margin = readNumber(
    (element.properties as Record<string, unknown>)?.outerDiameterMm,
    DEFAULT_OUTER_DIAMETER_MM,
  );
  const routedElement = withCanonicalPipeRoute(element, constrainedRoute);
  return {
    ...routedElement,
    position: { x: box.minX - margin, y: box.minY - margin },
    width: box.maxX - box.minX + margin * 2,
    depth: box.maxY - box.minY + margin * 2,
  };
}

export interface PipeStudioOverlayHandle {
  /**
   * Feed the live pipe-draw route (world mm centreline) so the overlay renders
   * the studio pair AS the draw preview — identical to how a committed pipe looks.
   * Pass null to clear it. Called imperatively so only the overlay re-renders.
   */
  setDraftRoute: (route: Point2D[] | null) => void;
  /**
   * Feed the live pipe-draw preview ELEMENTS (the exact gas/liquid elements the
   * commit will build — real insulated diameters + baked gap). The overlay renders
   * them through the same path as a committed pipe, so the preview never changes
   * size on Enter. Pass null to clear.
   */
  setDraftPipes: (elements: HvacElement[] | null) => void;
  /**
   * Show the snap-hover indicator (world mm) at an open end / port the draw tool
   * detected — rendered as the SAME endpoint-handle bullseye a committed pipe
   * shows, so every snap affordance is one component. Pass null to hide.
   */
  setSnapIndicator: (point: PipeSnapIndicator | null) => void;
  /**
   * Same-frame viewport bond: the host calls this from Fabric's `after:render`
   * with the live viewportTransform `[z,0,0,z,tx,ty]`, and the overlay writes
   * it straight onto the root `<g>` — pipes pan/zoom in the SAME paint as the
   * walls instead of trailing the rAF-deferred store by a frame or two.
   */
  syncViewTransform: (viewportTransform: readonly number[]) => void;
}

export const PipeStudioOverlay = forwardRef<PipeStudioOverlayHandle, PipeStudioOverlayProps>(
  function PipeStudioOverlay(
    {
      enabled,
      interactive = true,
      width,
      height,
      viewportZoom,
      panOffset,
      selectionHitTesting,
      pipeToolActive,
      ruleProfile,
      pipeLineMode,
      hvacElements,
      selectedIds,
      setSelectedIds,
      commitHvacElementCommand,
      onBeginExtendRoute,
    },
    ref,
  ): JSX.Element | null {
  const fittingDisplay = useSmartDrawingStore(state => state.pipeRoutingSettings.fittingDisplay);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const gRef = useRef<SVGGElement | null>(null);
  const dragRef = useRef<{ id: string; vi: number; startWorld: Point2D; startRoute: Point2D[] } | null>(null);
  // Whole-element move (the overlay owns pipes AND kits now that neither has a
  // Fabric body). One press-drag translates the pressed item — or, if it was
  // already part of the selection, the WHOLE selection — rigidly by the cursor
  // delta from the press point. Each snapshot is captured once so the applied
  // translation is absolute (never compounds as the store re-renders each frame).
  // Kits additionally heal every pipe bound to one of their ports so it follows.
  const moveDragRef = useRef<{
    startWorld: Point2D;
    moved: boolean;
    items: (
      | { kind: 'pipe'; id: string; route: Point2D[] }
      | { kind: 'kit'; id: string; position: Point2D }
    )[];
  } | null>(null);
  const [movePreviewElements, setMovePreviewElements] = useState<HvacElement[] | null>(null);
  const movePreviewFrameRef = useRef<number | null>(null);
  const queuedMovePreviewRef = useRef<HvacElement[] | null>(null);
  const lastMovePreviewRef = useRef<HvacElement[] | null>(null);
  const editedIdsRef = useRef<Set<string>>(new Set());
  // Each single line's bundle side, determined once and kept stable so editing a
  // vertex can't make the inferred side flip and drop the gap offset.
  const [ghost, setGhost] = useState<{ id: string; route: Point2D[] } | null>(null);
  // Live pipe-draw preview route (world mm), pushed in imperatively by the draw
  // tool so the preview renders as the overlay studio pair, not the Fabric line.
  const [draftRoute, setDraftRoute] = useState<Point2D[] | null>(null);
  // Live pipe-draw preview ELEMENTS (real gas/liquid diameters + baked gap),
  // pushed by the draw tool so the preview renders through the same tube helper
  // as a committed pipe — no width/gap change when the route commits on Enter.
  const [draftPipes, setDraftPipes] = useState<HvacElement[] | null>(null);
  // Snap-hover indicator (world mm) pushed by the draw tool — rendered with the
  // same endpoint-handle bullseye a committed pipe shows.
  const [snapIndicator, setSnapIndicator] = useState<PipeSnapIndicator | null>(null);
  // The matrix used to render the overlay is also the matrix used to invert
  // pointer positions. Keeping this ref in the imperative same-frame path
  // avoids stale React pan/zoom values during camera navigation.
  const liveViewportRef = useRef<FabricViewportMatrix>([
    viewportZoom,
    0,
    0,
    viewportZoom,
    -panOffset.x * viewportZoom,
    -panOffset.y * viewportZoom,
  ]);
  const hasImperativeViewportRef = useRef(false);
  // Same-frame viewport bond (see PipeStudioOverlayHandle.syncViewTransform).
  // The camera pump and Fabric after:render both publish the authoritative
  // matrix. A layout effect also restores it after any stale React commit.
  const syncViewTransform = useCallback((vpt: readonly number[]) => {
    if (vpt.length < 6) return;
    const live: FabricViewportMatrix = [
      Number(vpt[0]),
      Number(vpt[1]),
      Number(vpt[2]),
      Number(vpt[3]),
      Number(vpt[4]),
      Number(vpt[5]),
    ];
    if (!live.every(Number.isFinite)) return;
    hasImperativeViewportRef.current = true;
    liveViewportRef.current = live;
    const g = gRef.current;
    if (!g) return;
    const value = affineMatrixToSvg(fabricViewportToWorldSvgMatrix(live));
    if (g.getAttribute('transform') !== value) {
      g.setAttribute('transform', value);
    }
  }, []);
  useLayoutEffect(() => {
    // Store updates may arrive one frame behind the imperative viewport.
    // Correct the SVG before paint if React applied an older prop matrix.
    if (hasImperativeViewportRef.current) syncViewTransform(liveViewportRef.current);
  });
  useImperativeHandle(
    ref,
    () => ({ setDraftRoute, setDraftPipes, setSnapIndicator, syncViewTransform }),
    [syncViewTransform],
  );
  // Extension is unified with the draw tool: grabbing a pipe-end / bundle /
  // branch-kit-port grip seeds a full routing session in useRefrigerantPipeTool
  // (via onBeginExtendRoute), so it inherits angle modes, grid, HUD, multi-vertex,
  // weld-on-snap, and Lines mode — no bespoke one-shot extend state here.
  const [nearBranchKitPortKey, setNearBranchKitPortKey] = useState<string | null>(null);
  // Copper branch-kit placement: which line(s) to place, whether we're placing,
  // and the live cursor-attached ghost (transform + snap-to-pipe-end).
  const [kitKind, setKitKind] = useState<'gas' | 'liquid' | 'both'>('both');
  const [placingKit, setPlacingKit] = useState(false);
  const [kitGhost, setKitGhost] = useState<{ transform: PlacementTransform; snap: BranchKitSnap | null } | null>(null);
  // The branch-kit sprites are embedded data URIs with known aspect ratios, so
  // they're available synchronously — no async load, no "not yet ready" gap that
  // would drop the kit to the crude vector fallback (or nothing).
  const kitImg: Record<string, { ok: boolean; aspect: number }> = {
    gas: { ok: true, aspect: KIT_IMG_ASPECT.gas },
    liquid: { ok: true, aspect: KIT_IMG_ASPECT.liquid },
    both: { ok: true, aspect: KIT_IMG_ASPECT.both },
  };
  const orthoRef = useRef(false);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const canInteract = enabled && interactive;

  const scheduleMovePreview = useCallback((elements: HvacElement[]): void => {
    lastMovePreviewRef.current = elements;
    queuedMovePreviewRef.current = elements;
    if (movePreviewFrameRef.current !== null) {
      return;
    }
    movePreviewFrameRef.current = window.requestAnimationFrame(() => {
      movePreviewFrameRef.current = null;
      setMovePreviewElements(queuedMovePreviewRef.current);
    });
  }, []);

  const clearMovePreview = useCallback((): void => {
    if (movePreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(movePreviewFrameRef.current);
      movePreviewFrameRef.current = null;
    }
    queuedMovePreviewRef.current = null;
    lastMovePreviewRef.current = null;
    setMovePreviewElements(null);
  }, []);

  useEffect(
    () => () => {
      if (movePreviewFrameRef.current !== null) {
        window.cancelAnimationFrame(movePreviewFrameRef.current);
      }
    },
    [],
  );

  const previewElements = useMemo(() => {
    if (!movePreviewElements || movePreviewElements.length === 0) {
      return hvacElements;
    }
    const overrides = new Map(movePreviewElements.map((element) => [element.id, element]));
    return hvacElements.map((element) => overrides.get(element.id) ?? element);
  }, [hvacElements, movePreviewElements]);

  useEffect(() => {
    if (canInteract) return;
    // Switching views cancels overlay-owned previews without committing geometry.
    // The drawing tool retains its independent route session across views.
    dragRef.current = null;
    moveDragRef.current = null;
    orthoRef.current = false;
    clearMovePreview();
    setGhost(null);
    setPlacingKit(false);
    setKitGhost(null);
    setNearBranchKitPortKey(null);
  }, [canInteract, clearMovePreview]);

  useEffect(() => {
    if (!canInteract) return;
    const down = (e: KeyboardEvent) => {
      // Ignore keys routed to a focused form control (e.g. the toolbar sliders),
      // so Enter/Escape there can't silently abort an in-progress draw.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Shift') orthoRef.current = true;
      if (e.key === 'Escape' || e.key === 'Enter') {
        // Extension now runs on the draw tool, which owns its own Enter/Escape;
        // here we only clear the overlay-owned kit placement hints. The flip
        // suggestion is tied to selection, so it clears when the kit deselects.
        setPlacingKit(false);
        setKitGhost(null);
        setNearBranchKitPortKey(null);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Shift') orthoRef.current = false;
    };
    const blur = () => {
      orthoRef.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [canInteract]);

  const view = getCanvasTransform(viewportZoom, panOffset);
  const k = MM_TO_PX * view.zoom;
  const matrix = canvasTransformToSvgMatrix(view);
  const hpx = (n: number) => n / Math.max(k, 1e-6); // screen px -> g-space (mm) units

  // Real-geometry gas/liquid tubes for a pipe view. Shared by committed pipes AND
  // the live draw preview so the two can NEVER differ in width / gap / bend — the
  // preview is the exact pipe the commit will produce, minus opacity.
  const pipeTubes = (p: PipeView, route: Point2D[]) => {
    const element = route === p.route ? p.element : withPipeRoute(p.element, route);
    const tubes = buildPipePlanTubes(element, previewElements).map((tube) => ({
      d: pipePolylinePath(tube.points),
      insulationD: tube.insulationSegments?.map(pipePolylinePath).join(' '),
      copperD: tube.copperSegments?.map(pipePolylinePath).join(' '),
      fittings: tube.fittings,
      points: tube.points,
      unresolvedPaths: tube.unresolvedSegments?.map(pipePolylinePath),
      insW: tube.outerDiameterMm,
      coreW: tube.copperDiameterMm,
      sheenW: Math.max(tube.copperDiameterMm * 0.3, 1),
      ...(tube.lineKind === 'liquid' ? LIQUID_COLORS : GAS_COLORS),
    }));
    const insW = Math.max(...tubes.map((tube) => tube.insW), p.outerMm);
    const coreW = Math.max(...tubes.map((tube) => tube.coreW), 1);
    const sheenW = Math.max(coreW * 0.3, 1);
    return { tubes, insW, coreW, sheenW };
  };
  // Insulation sleeve + copper core + sheen strokes for a set of tubes. Butt caps:
  // a real cut refrigerant pipe ends in a flat perpendicular face, not a dome;
  // bends stay smooth via round line joins.
  const renderTubeBody = (
    tubes: { d: string; insulationD?: string; copperD?: string; fittings?: CopperSocketElbowPlacement[]; ins: string; core: string; sheen: string; insW: number; coreW: number; sheenW: number; unresolvedPaths?: string[] }[],
    insW: number,
    coreW: number,
    sheenW: number,
    keyPrefix: string,
  ): JSX.Element => (
    <>
      {tubes.map((t, i) => (
        <path key={`${keyPrefix}-ins-${i}`} d={t.insulationD ?? t.d} fill="none" stroke={t.ins} strokeWidth={t.insW} strokeLinecap="butt" strokeLinejoin="round" />
      ))}
      {tubes.map((t, i) => (
        <path key={`${keyPrefix}-core-${i}`} d={t.copperD ?? t.d} fill="none" stroke={t.core} strokeWidth={t.coreW} strokeLinecap="butt" strokeLinejoin="round" />
      ))}
      {tubes.map((t, i) => (
        <path key={`${keyPrefix}-sheen-${i}`} d={t.copperD ?? t.d} fill="none" stroke={t.sheen} strokeWidth={t.sheenW} strokeLinecap="butt" strokeLinejoin="round" strokeOpacity={0.7} />
      ))}
      {tubes.flatMap((tube, i) => tube.fittings?.map((fitting, index) => <CopperSocketElbowPlan
        key={`${keyPrefix}-elbow-${i}-${index}`} fitting={fitting} insulated={fittingDisplay === 'insulated'}
        insulationThicknessMm={(tube.insW - tube.coreW) / 2} insulationColor={tube.ins} />) ?? [])}
      {tubes.flatMap((t, i) => t.unresolvedPaths?.map((d, index) => (
        <path key={`${keyPrefix}-unresolved-${i}-${index}`} d={d} fill="none" stroke="#b45309"
          strokeWidth={hpx(1.5)} strokeDasharray={`${hpx(4)} ${hpx(4)}`} strokeLinecap="butt"
          data-unresolved-pipe-bend="true">
          <title>More straight space is needed for this bend.</title>
        </path>
      )) ?? [])}
    </>
  );

  // Draft elements and committed elements use the same presentation geometry.
  const draftPipeViews = useMemo(() => {
    if (!draftPipes || draftPipes.length === 0) return [] as PipeView[];
    const out: PipeView[] = [];
    for (const el of draftPipes) {
      const v = toPipeView(el, editedIdsRef.current.has(el.id));
      if (v) out.push(v);
    }
    return out;
  }, [draftPipes]);

  const pipes = useMemo(() => {
    // A draft pipe carrying a REAL element id is an extension-merge preview: it
    // renders the host's whole run (with the in-progress tail appended), so hide
    // the store copy while the draft overrides it — otherwise the two bodies
    // stack and the junction reads as a crack.
    const draftOverrideIds = new Set(
      (draftPipes ?? [])
        .map((el) => el.id)
        .filter((id) => !id.startsWith('__')),
    );
    const list: PipeView[] = [];
    for (const el of previewElements) {
      if (draftOverrideIds.has(el.id)) continue;
      const v = toPipeView(el, editedIdsRef.current.has(el.id));
      if (v) list.push(v);
    }
    return list;
  }, [draftPipes, previewElements]);

  // When exactly the two lines of one bundle are selected, expose a single
  // shared-center "extend" grip per bundle end (the common + the user asked for).
  // The bundle's centerline endpoint is the midpoint of the two matching ends.
  const bundleSelection = useMemo(() => {
    if (selectedIds.length !== 2) return null;
    const a = pipes.find((p) => p.id === selectedIds[0] && !p.isPair);
    const b = pipes.find((p) => p.id === selectedIds[1] && !p.isPair);
    if (!a || !b || a.route.length < 2 || b.route.length < 2) return null;
    const sameBundle = !!a.bundleId && a.bundleId === b.bundleId;
    const oppositeKind = !!a.lineKind && !!b.lineKind && a.lineKind !== b.lineKind;
    if (!sameBundle || !oppositeKind) return null;
    const aEnds = [
      { end: 'start' as const, pt: a.route[0]! },
      { end: 'end' as const, pt: a.route[a.route.length - 1]! },
    ];
    const bEnds = [
      { end: 'start' as const, pt: b.route[0]! },
      { end: 'end' as const, pt: b.route[b.route.length - 1]! },
    ];
    const d = (p: Point2D, q: Point2D) => Math.hypot(p.x - q.x, p.y - q.y);
    // Pair a-start with the nearer b-end, a-end with the other.
    const straight = d(aEnds[0].pt, bEnds[0].pt) <= d(aEnds[0].pt, bEnds[1].pt);
    const pairs: [(typeof aEnds)[number], (typeof bEnds)[number]][] = straight
      ? [
          [aEnds[0], bEnds[0]],
          [aEnds[1], bEnds[1]],
        ]
      : [
          [aEnds[0], bEnds[1]],
          [aEnds[1], bEnds[0]],
        ];
    // Inferred (no shared bundleId) pairs must actually sit close, or two
    // unrelated gas/liquid lines would spawn a phantom grip between them.
    if (!sameBundle) {
      const maxPair = Math.max(d(pairs[0][0].pt, pairs[0][1].pt), d(pairs[1][0].pt, pairs[1][1].pt));
      if (maxPair > 600) return null;
    }
    const ends = pairs.map(([ae, be], i) => {
      const aPrev = ae.end === 'end' ? a.route[a.route.length - 2]! : a.route[1]!;
      const out = unit(ae.pt.x - aPrev.x, ae.pt.y - aPrev.y);
      // Bundle gap = the perpendicular spacing across the run heading, NOT the
      // raw end-to-end distance (which inflates when the two ends are staggered
      // along the run).
      const gv = { x: be.pt.x - ae.pt.x, y: be.pt.y - ae.pt.y };
      const perp = gv.x * -out.y + gv.y * out.x;
      const gap = Math.abs(perp) > 1 ? Math.abs(perp) : Math.hypot(gv.x, gv.y);
      return {
        key: i,
        aEnd: ae.end,
        bEnd: be.end,
        aPt: ae.pt,
        bPt: be.pt,
        center: { x: (ae.pt.x + be.pt.x) / 2, y: (ae.pt.y + be.pt.y) / 2 },
        out: { x: out.x, y: out.y },
        gap,
      };
    });
    return { aId: a.id, bId: b.id, aKind: a.lineKind, ends };
  }, [selectedIds, pipes]);

  // Selected copper branch kits → their 3 bundle ports (world gas/liquid points,
  // outward direction, terminalRole) for the port grips + draw-from-port.
  // Port snap-points for EVERY placed kit (not just the selected one), so its 3
  // ports are always available to draw a pipe from — standalone or already piped.
  // The selected kit gets the verbose grips (arrow + role label); the rest show a
  // quieter clickable snap dot.
  const branchKitPorts = useMemo(() => {
    const out: {
      id: string;
      selected: boolean;
      ports: {
        conn: KitPortConn;
        center: Point2D;
        gasPos: Point2D;
        liquidPos: Point2D;
      }[];
    }[] = [];
    for (const el of previewElements) {
      if (el.type !== 'refrigerant-branch-kit') continue;
      const conns = getBranchKitPortConnections(el);
      if (conns.length === 0) continue;
      const ports = conns.map((conn) => ({
        conn, center: conn.point, gasPos: conn.gasPoint, liquidPos: conn.liquidPoint,
      }));
      out.push({ id: el.id, selected: selectedSet.has(el.id), ports });
    }
    return out;
  }, [previewElements, selectedSet]);

  // Every PLACED branch kit, drawn with the SAME real-geometry sprite the toggle
  // ghost previews. Its inlet + run-outlet world ports are resolved exactly as the
  // ghost does (buildRefrigerantBranchKitViewModel + resolveRefrigerantBranchKit-
  // ConnectionIdentity at the element's own world centre + rotation + kind), so the
  // committed kit is pixel-identical to the preview and sits where it was dropped —
  // for gas, liquid AND both kits.
  const placedKits = useMemo(() => {
    // A 'both' kit is a REAL pair of fittings — a gas branch on the gas line and a
    // liquid branch on the liquid line — so it draws two sprites, each aligned to
    // its own line's inlet/run ports (not one sprite floating on the centreline
    // between the pipe's two tubes). Single-kind kits draw one sprite on their line.
    const out: {
      id: string;
      sprites: { line: 'gas' | 'liquid'; inlet: Point2D; run: Point2D; branch: Point2D }[];
    }[] = [];
    for (const el of previewElements) {
      if (el.type !== 'refrigerant-branch-kit') continue;
      const raw = (el.properties as Record<string, unknown>)?.branchKitLineKind;
      const kind = raw === 'gas' ? 'gas' : raw === 'liquid' ? 'liquid' : 'both';
      const model = buildRefrigerantBranchKitViewModel(el);
      const center = { x: el.position.x + el.width / 2, y: el.position.y + el.depth / 2 };
      const rot = el.rotation ?? 0;
      const inletId = resolveRefrigerantBranchKitConnectionIdentity({ model, role: 'inlet', lineSelection: kind, worldCenter: center, rotationDeg: rot });
      const runId = resolveRefrigerantBranchKitConnectionIdentity({ model, role: 'run-outlet', lineSelection: kind, worldCenter: center, rotationDeg: rot });
      const branchId = resolveRefrigerantBranchKitConnectionIdentity({ model, role: 'branch-outlet', lineSelection: kind, worldCenter: center, rotationDeg: rot });
      if (!inletId || !runId || !branchId) continue;
      const lines: ('gas' | 'liquid')[] = kind === 'both' ? ['gas', 'liquid'] : [kind];
      const sprites = lines.map((line) => ({
        line,
        inlet: line === 'gas' ? { x: inletId.gasPoint.x, y: inletId.gasPoint.y } : { x: inletId.liquidPoint.x, y: inletId.liquidPoint.y },
        run: line === 'gas' ? { x: runId.gasPoint.x, y: runId.gasPoint.y } : { x: runId.liquidPoint.x, y: runId.liquidPoint.y },
        branch: line === 'gas' ? branchId.gasPoint : branchId.liquidPoint,
      }));
      out.push({ id: el.id, sprites });
    }
    return out;
  }, [previewElements]);

  const toWorld = useCallback((clientX: number, clientY: number): Point2D | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    return clientPointToWorldFromFabricViewport(
      clientX,
      clientY,
      svg.getBoundingClientRect(),
      liveViewportRef.current,
    );
  }, []);

  const updateNearbyBranchKitPort = useCallback(
    (clientX: number, clientY: number): string | null => {
      const world = toWorld(clientX, clientY);
      if (!world) {
        setNearBranchKitPortKey((previous) => (previous ? null : previous));
        return null;
      }

      const pxToMm = (px: number) => px / Math.max(k, 1e-6);
      let bestKey: string | null = null;
      let bestDistance = Infinity;

      for (const kit of branchKitPorts) {
        for (const port of kit.ports) {
          const halfSpan =
            Math.hypot(port.gasPos.x - port.liquidPos.x, port.gasPos.y - port.liquidPos.y) / 2;
          const revealRadius = Math.max(
            pxToMm(BRANCH_KIT_PORT_REVEAL_RADIUS_PX),
            halfSpan + pxToMm(BRANCH_KIT_PORT_HIT_PADDING_PX),
          );
          const distanceToPort = Math.hypot(world.x - port.center.x, world.y - port.center.y);
          if (distanceToPort <= revealRadius && distanceToPort < bestDistance) {
            bestDistance = distanceToPort;
            bestKey = branchKitPortKey(kit.id, port.conn.terminalRole);
          }
        }
      }

      setNearBranchKitPortKey((previous) => (previous === bestKey ? previous : bestKey));
      return bestKey;
    },
    [branchKitPorts, k, toWorld],
  );

  const elementById = useCallback(
    (id: string) => hvacElements.find((e) => e.id === id) ?? null,
    [hvacElements],
  );

  // Build one pipe update without mutating the store; the caller commits the
  // completed drag as a single auditable history command.
  const writeRoute = useCallback(
    (id: string, route: Point2D[]) => {
      const el = elementById(id);
      if (!el) return;
      // From now on this pipe's route is authoritative — stop re-collapsing it,
      // so inserted/edited vertices persist.
      editedIdsRef.current.add(id);
      const nextElement = withPipeRoute(el, route);
      return nextElement;
    },
    [elementById],
  );

  const commitRoute = useCallback(
    (id: string, route: Point2D[], label: string) => {
      const nextElement = writeRoute(id, route);
      if (!nextElement) return;
      commitHvacElementCommand(label, {
        updates: [{
          id,
          updates: {
            position: nextElement.position,
            width: nextElement.width,
            depth: nextElement.depth,
            properties: nextElement.properties,
          },
        }],
      });
    },
    [commitHvacElementCommand, writeRoute],
  );

  const buildMovePreview = useCallback(
    (drag: NonNullable<typeof moveDragRef.current>, dx: number, dy: number): HvacElement[] => {
      const overrides = new Map<string, HvacElement>();
      const baseById = new Map(hvacElements.map((element) => [element.id, element]));

      for (const item of drag.items) {
        if (item.kind !== 'kit') continue;
        const element = baseById.get(item.id);
        if (!element || element.type !== 'refrigerant-branch-kit') continue;
        overrides.set(item.id, {
          ...element,
          position: { x: item.position.x + dx, y: item.position.y + dy },
        });
      }

      const sceneWithMovedKits = hvacElements.map((element) => overrides.get(element.id) ?? element);
      for (const item of drag.items) {
        if (item.kind !== 'kit') continue;
        const movedKit = overrides.get(item.id);
        if (!movedKit) continue;

        for (const update of resolveRefrigerantPipeBranchKitReconnectionUpdates(sceneWithMovedKits, movedKit)) {
          const base = overrides.get(update.id) ?? baseById.get(update.id);
          if (!base) continue;
          overrides.set(update.id, {
            ...base,
            ...update.updates,
            properties: update.updates.properties
              ? { ...base.properties, ...update.updates.properties }
              : base.properties,
          });
        }
      }

      for (const item of drag.items) {
        if (item.kind !== 'pipe') continue;
        const base = overrides.get(item.id) ?? baseById.get(item.id);
        if (!base) continue;
        overrides.set(
          item.id,
          withPipeRoute(
            base,
            item.route.map((point) => ({ x: point.x + dx, y: point.y + dy })),
          ),
        );
      }

      return Array.from(overrides.values());
    },
    [hvacElements],
  );

  const onVertexDown = useCallback(
    (e: ReactPointerEvent, pipe: PipeView, vi: number, route: Point2D[]) => {
      e.stopPropagation();
      const editableIndex = resolveEditablePipeVertexIndex({
        routeLength: route.length,
        vertexIndex: vi,
        startConnected: pipe.startConnected,
        endConnected: pipe.endConnected,
        startProtectedVertexCount: pipe.startProtectedVertexCount,
        endProtectedVertexCount: pipe.endProtectedVertexCount,
      });
      if (editableIndex === null) return;
      const startWorld = toWorld(e.clientX, e.clientY) ?? route[vi]!;
      const startRoute = route.map((p) => ({ ...p }));
      dragRef.current = { id: pipe.id, vi: editableIndex, startWorld, startRoute };
      setGhost({ id: pipe.id, route: startRoute.map((p) => ({ ...p })) });
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [toWorld],
  );

  // Press on a pipe body or a branch-kit sprite to begin a whole-element move.
  // Selection-aware, like a modern design tool: Shift/Ctrl toggles selection only
  // (no move); a plain press on an already-selected item drags the WHOLE current
  // selection; a plain press on anything else selects just it and drags it alone.
  // A small screen-space threshold (applied in onPointerMove) keeps a click from
  // nudging the item, so click-to-select still works.
  const beginMove = useCallback(
    (e: ReactPointerEvent, pressedId: string) => {
      e.stopPropagation();
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      if (additive) {
        const current = new Set(selectedIds);
        if (current.has(pressedId)) {
          current.delete(pressedId);
        } else {
          current.add(pressedId);
        }
        setSelectedIds(Array.from(current));
        return;
      }

      const w = toWorld(e.clientX, e.clientY);
      if (!w) return;

      const dragWholeSelection = selectedSet.has(pressedId) && selectedIds.length > 0;
      const pressedPipe = pipes.find((pipe) => pipe.id === pressedId);
      const bundleIds = pressedPipe?.bundleId
        ? pipes.filter((pipe) => pipe.bundleId === pressedPipe.bundleId).map((pipe) => pipe.id)
        : [pressedId];
      const dragIds = dragWholeSelection ? selectedIds.slice() : bundleIds;
      if (!dragWholeSelection) {
        setSelectedIds(dragIds);
      }

      const items: NonNullable<typeof moveDragRef.current>['items'] = [];
      for (const id of dragIds) {
        const pipeView = pipes.find((p) => p.id === id);
        if (pipeView) {
          items.push({ kind: 'pipe', id, route: pipeView.route.map((p) => ({ ...p })) });
          continue;
        }
        const el = hvacElements.find((x) => x.id === id);
        if (el && el.type === 'refrigerant-branch-kit') {
          items.push({ kind: 'kit', id, position: { x: el.position.x, y: el.position.y } });
        }
      }
      if (items.length === 0) return;

      clearMovePreview();
      moveDragRef.current = { startWorld: w, moved: false, items };
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [selectedIds, selectedSet, setSelectedIds, toWorld, pipes, hvacElements, clearMovePreview],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      updateNearbyBranchKitPort(e.clientX, e.clientY);

      // Whole-element move: rigidly translate every snapshot item by the absolute
      // cursor delta from the press point. Ignore the first few screen-pixels of
      // travel so a click still selects without nudging the item. Pipes rewrite
      // their route; kits reposition + heal every pipe bound to one of their ports.
      const md = moveDragRef.current;
      if (md) {
        const w = toWorld(e.clientX, e.clientY);
        if (!w) return;
        const dx = w.x - md.startWorld.x;
        const dy = w.y - md.startWorld.y;
        if (!md.moved && Math.hypot(dx, dy) * k > 3) md.moved = true;
        if (!md.moved) return;
        scheduleMovePreview(buildMovePreview(md, dx, dy));
        return;
      }
      const drag = dragRef.current;
      if (!drag) return;
      const w = toWorld(e.clientX, e.clientY);
      if (!w) return;
      // Move the underlying centerline vertex by the cursor delta, so the handle
      // (rendered on the offset body) tracks the cursor while the route updates.
      const dx = w.x - drag.startWorld.x;
      const dy = w.y - drag.startWorld.y;
      setGhost({
        id: drag.id,
        route: drag.startRoute.map((p, i) =>
          i === drag.vi ? { x: p.x + dx, y: p.y + dy } : { x: p.x, y: p.y },
        ),
      });
    },
    [toWorld, k, buildMovePreview, scheduleMovePreview, updateNearbyBranchKitPort],
  );

  const endDrag = useCallback(() => {
    const md = moveDragRef.current;
    if (md) {
      moveDragRef.current = null;
      setNearBranchKitPortKey(null);
      if (md.moved) {
        const finalElements = lastMovePreviewRef.current ?? [];
        const movedPipeIds = new Set(
          md.items.filter((item) => item.kind === 'pipe')
            .map((item) => item.id),
        );
        const updates = finalElements.map((element) => {
          if (movedPipeIds.has(element.id)) {
            editedIdsRef.current.add(element.id);
          }
          return {
            id: element.id,
            updates: {
              position: element.position,
              rotation: element.rotation,
              width: element.width,
              depth: element.depth,
              height: element.height,
              roomId: element.roomId,
              wallId: element.wallId,
              properties: element.properties,
            },
          };
        });
        const hasPipe = md.items.some((i) => i.kind === 'pipe');
        const hasKit = md.items.some((i) => i.kind === 'kit');
        const label =
          hasPipe && hasKit
            ? 'Move items'
            : md.items.length > 1
              ? hasKit
                ? 'Move branch kits'
                : 'Move refrigerant pipes'
              : hasKit
                ? 'Move branch kit'
                : 'Move refrigerant pipe';
        if (updates.length > 0) {
          commitHvacElementCommand(label, { updates });
        }
      }
      clearMovePreview();
      return;
    }
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && ghost && ghost.id === drag.id) {
      commitRoute(drag.id, ghost.route, 'Edit refrigerant pipe vertex');
    }
    setGhost(null);
    setNearBranchKitPortKey(null);
  }, [clearMovePreview, commitHvacElementCommand, commitRoute, ghost]);

  const onInsert = useCallback(
    (e: ReactPointerEvent, id: string, si: number, route: Point2D[]) => {
      e.stopPropagation();
      const mid = { x: (route[si]!.x + route[si + 1]!.x) / 2, y: (route[si]!.y + route[si + 1]!.y) / 2 };
      commitRoute(id, [...route.slice(0, si + 1), mid, ...route.slice(si + 1)], 'Insert refrigerant pipe vertex');
    },
    [commitRoute],
  );

  const onDelete = useCallback(
    (e: ReactMouseEvent, pipe: PipeView, vi: number, route: Point2D[]) => {
      e.preventDefault();
      e.stopPropagation();
      const lastIndex = route.length - 1;
      const protectedAtStart = pipe.startConnected ? pipe.startProtectedVertexCount : 1;
      const protectedAtEnd = pipe.endConnected ? pipe.endProtectedVertexCount : 1;
      if (
        route.length <= 2
        || vi < protectedAtStart
        || vi > lastIndex - protectedAtEnd
      ) return;
      commitRoute(pipe.id, route.filter((_, i) => i !== vi), 'Delete refrigerant pipe vertex');
    },
    [commitRoute],
  );

  // --- Extension: continue a run from an open end / bundle / kit port --------
  // Grips no longer run a bespoke one-shot draw; each resolves a bundle
  // connection and hands it to the parent (onBeginExtendRoute), which switches to
  // the pipe tool and seeds a full routing session there.

  // "+" grip on one open line end. A paired line resolves to its real field-pipe
  // bundle (single Lines mode then reads the matching gas/liquid side); a lone
  // single line — which is not a paired snap target — is synthesized from its own
  // end geometry so it can still be continued.
  const beginExtendFromLineEnd = useCallback(
    (p: PipeView, end: 'start' | 'end') => {
      const route = p.route;
      if (route.length < 2) return;
      const endIdx = end === 'end' ? route.length - 1 : 0;
      const endPt = route[endIdx]!;
      const lineMode: RefrigerantPipeLineMode = p.isPair ? 'pair' : p.lineKind ?? 'gas';
      const found = findNearestRefrigerantPipeBundleTarget(
        hvacElements,
        endPt,
        Math.max(60, p.outerMm),
      );
      if (found) {
        onBeginExtendRoute(found, lineMode);
        return;
      }
      // Lone single line: reuse the shared engine's endpoint synthesis (identical
      // geometry) instead of hand-building the bundle, so the "+" grip and the plain
      // pipe-tool click resolve extensions through one code path.
      const singleTarget = findNearestRefrigerantPipeExtensionTarget(
        hvacElements,
        endPt,
        Math.max(60, p.outerMm),
        { lineKind: p.lineKind ?? 'gas' },
      );
      if (singleTarget) {
        onBeginExtendRoute(singleTarget.bundle, lineMode);
      }
    },
    [hvacElements, onBeginExtendRoute],
  );

  // Shared-center grip when both lines of a bundle are selected: resolve the
  // paired field bundle at the two ends' midpoint and continue it as a pair.
  const beginExtendFromBundleEnd = useCallback(
    (aPt: Point2D, bPt: Point2D) => {
      const mid = { x: (aPt.x + bPt.x) / 2, y: (aPt.y + bPt.y) / 2 };
      const halfMm = Math.hypot(aPt.x - bPt.x, aPt.y - bPt.y) / 2;
      const found = findNearestRefrigerantPipeBundleTarget(
        hvacElements,
        mid,
        halfMm + 80,
      );
      if (found) onBeginExtendRoute(found, 'pair');
    },
    [hvacElements, onBeginExtendRoute],
  );

  // --- Copper branch-kit placement ------------------------------------------
  // The chosen kit's footprint + its 3 ports in LOCAL (centre-origin) coords,
  // driving the snap solver and the ghost. Rebuilt only when the line kind flips.
  const kitPlacement = useMemo(() => {
    const source = {
      type: 'refrigerant-branch-kit' as const,
      subtype: 'dis-22-1g',
      modelLabel: null,
      properties: { branchKitType: 'dis-22-1g', branchKitLineKind: kitKind },
    };
    const model = buildRefrigerantBranchKitViewModel(source as unknown as HvacElement);
    const roles = ['inlet', 'run-outlet', 'branch-outlet'] as const;
    const ports: PlaceablePort[] = [];
    // Per-role gas/liquid LOCAL points, so the ghost can preview a 'both' kit as
    // two fittings on their own lines (matching the committed render).
    const localById: Record<string, { gas: Point2D; liquid: Point2D }> = {};
    for (const role of roles) {
      const id = resolveRefrigerantBranchKitConnectionIdentity({
        model,
        role,
        lineSelection: kitKind,
        worldCenter: { x: 0, y: 0 },
        rotationDeg: 0,
      });
      if (!id) continue;
      localById[role] = { gas: id.gasPoint, liquid: id.liquidPoint };
      const point =
        kitKind === 'gas'
          ? id.gasPoint
          : kitKind === 'liquid'
            ? id.liquidPoint
            : { x: (id.gasPoint.x + id.liquidPoint.x) / 2, y: (id.gasPoint.y + id.liquidPoint.y) / 2 };
      ports.push({ role, point, direction: id.direction, lineKind: kitKind });
    }
    return { width: model.widthMm, depth: model.depthMm, height: model.heightMm, ports, localById };
  }, [kitKind]);

  // Open pipe ends (world) the kit can snap onto.
  const openEnds = useMemo(() => buildPipeKitConnectionTargets(hvacElements), [hvacElements]);

  const startPlaceKit = useCallback(() => {
    setNearBranchKitPortKey(null);
    setKitGhost(null);
    setPlacingKit(true);
  }, []);

  const onKitMove = useCallback(
    (e: ReactPointerEvent) => {
      const w = toWorld(e.clientX, e.clientY);
      if (!w) return;
      const tol = 16 / Math.max(k, 1e-6);
      const solved = solveBranchKitSnap(kitPlacement.ports, openEnds, w, tol);
      setKitGhost(solved);
    },
    [toWorld, k, kitPlacement, openEnds],
  );

  const onKitClick = useCallback(
    (e: ReactMouseEvent) => {
      const w = toWorld(e.clientX, e.clientY);
      if (!w) return;
      const tol = 16 / Math.max(k, 1e-6);
      const { transform, snap } = solveBranchKitSnap(kitPlacement.ports, openEnds, w, tol);
      const target = snap ? openEnds.find((candidate) => candidate.id === snap.targetId) : null;
      const { width: kw, depth: kd, height: kh } = kitPlacement;
      const kitPosition = { x: transform.tx - kw / 2, y: transform.ty - kd / 2 };
      const kitProperties = {
        branchKitType: 'dis-22-1g',
        branchKitLineKind: kitKind,
        branchKitWallAllowanceMm: 0.9,
        branchType: 'y-joint',
      };
      const kitId = generateId();
      const kitEl: HvacElement = {
        id: kitId,
        type: 'refrigerant-branch-kit',
        category: 'accessory',
        subtype: kitKind === 'both' ? 'dis-22-1g' : `dis-22-1g-${kitKind}`,
        modelLabel: kitKind === 'both' ? 'DIS-22-1G Gas + Liquid' : kitKind === 'gas' ? 'DIS-22-1G Gas' : 'DIS-22-1G Liquid',
        position: kitPosition,
        rotation: transform.rotDeg,
        width: kw,
        depth: kd,
        height: kh,
        elevation: getActivePipeRoutingSettings().defaultPipeElevationMm,
        mountType: 'ceiling',
        label: 'Copper branch kit',
        supplyZoneRatio: 0.5,
        properties: kitProperties,
      };
      const pipeUpdates: Array<{ id: string; updates: Partial<HvacElement> }> = [];
      if (snap && target) {
        const port = getBranchKitPortConnections(kitEl).find((candidate) => candidate.terminalRole === snap.portRole);
        if (port) {
          const offsets = target.pipes.map((end) => end.elevationMm - (
            end.lineKind === 'gas' ? port.gasElevationMm : end.lineKind === 'liquid' ? port.liquidElevationMm : port.elevationMm
          ));
          kitEl.elevation += offsets.reduce((sum, value) => sum + value, 0) / offsets.length;
        }
      }

      // If a port snapped onto an open pipe end, BIND that pipe end to the kit
      // port: record the connection (sourceElementId + terminalRole) so the kit
      // and pipe are a joined network, and pin the pipe's route endpoint exactly
      // onto the port so they meet with no gap. The move engine + healer then keep
      // them together (see resolveRefrigerantPipeBranchKitReconnectionUpdates).
      if (snap && target) {
        for (const targetEnd of target.pipes) {
        const pipeId = targetEnd.elementId;
        const whichEnd = targetEnd.end;
        const pipeEl = hvacElements.find((x) => x.id === pipeId);
        if (pipeEl) {
          const port = getBranchKitPortConnections(kitEl).find(
            (p) => p.terminalRole === snap.portRole,
          );
          if (port) {
            const props = (pipeEl.properties ?? {}) as Record<string, unknown>;
            const route = readRoute(props.routePoints).map((p) => ({ x: p.x, y: p.y }));
            const isPair = pipeEl.type === 'refrigerant-pipe-pair';
            const lineKind = props.lineKind === 'liquid' ? 'liquid' : 'gas';
            const endPoint = isPair
              ? port.point
              : lineKind === 'liquid'
                ? port.liquidPoint
                : port.gasPoint;
            if (route.length >= 1) {
              const at = whichEnd === 'start' ? 0 : route.length - 1;
              route[at] = { x: endPoint.x, y: endPoint.y };
            }
            const connKey = isPair
              ? whichEnd === 'start'
                ? 'startBundleConnection'
                : 'endBundleConnection'
              : whichEnd === 'start'
                ? 'startConnection'
                : 'endConnection';
            const connVal = isPair
              ? port
              : {
                  portPoint: { x: endPoint.x, y: endPoint.y },
                  direction:
                    lineKind === 'liquid'
                      ? (port.liquidDirection ?? port.direction)
                      : (port.gasDirection ?? port.direction),
                  elevationMm: lineKind === 'liquid' ? port.liquidElevationMm : port.gasElevationMm,
                  connectionKind: 'field-pipe' as const,
                  sourceElementId: kitId,
                  terminalRole: snap.portRole,
                };
            const connected = {
              ...pipeEl,
              properties: { ...props, [connKey]: connVal },
            };
            const routed = withPipeRoute(connected, route);
            pipeUpdates.push({
              id: pipeId,
              updates: {
                position: routed.position,
                width: routed.width,
                depth: routed.depth,
                properties: routed.properties,
              },
            });
          }
        }
        }
      }

      commitHvacElementCommand('Place copper branch kit', {
        add: [kitEl],
        updates: pipeUpdates,
        selectedIds: [kitId],
      });
      setPlacingKit(false);
      setKitGhost(null);
      setNearBranchKitPortKey(null);
      // Auto-select the fresh kit so the flip suggestion (ghost + "Flip" chip)
      // appears immediately after this first click — no extra gesture needed.
    },
    [toWorld, k, kitPlacement, openEnds, kitKind, hvacElements, commitHvacElementCommand],
  );

  const finishPlaceKit = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    setPlacingKit(false);
    setKitGhost(null);
    setNearBranchKitPortKey(null);
  }, []);

  const pipeRouteStarted = !!draftRoute && draftRoute.length > 0;
  const visibleBranchKitPortKeys = useMemo(() => {
    const keys = new Set<string>();
    const pxToMm = (px: number) => px / Math.max(k, 1e-6);

    const revealPortsNearPoint = (point: Point2D | null | undefined): void => {
      if (!point) return;
      for (const kit of branchKitPorts) {
        for (const port of kit.ports) {
          const halfSpan =
            Math.hypot(port.gasPos.x - port.liquidPos.x, port.gasPos.y - port.liquidPos.y) / 2;
          const revealRadius = Math.max(
            pxToMm(BRANCH_KIT_PORT_REVEAL_RADIUS_PX),
            halfSpan + pxToMm(BRANCH_KIT_PORT_HIT_PADDING_PX),
          );
          if (Math.hypot(point.x - port.center.x, point.y - port.center.y) <= revealRadius) {
            keys.add(branchKitPortKey(kit.id, port.conn.terminalRole));
          }
        }
      }
    };

    if (nearBranchKitPortKey) {
      keys.add(nearBranchKitPortKey);
    }
    // A live extension/draw pushes its route through draftRoute (the draw tool
    // owns the session now), so reveal ports near the growing route's head.
    if (draftRoute && draftRoute.length > 0) {
      revealPortsNearPoint(draftRoute[draftRoute.length - 1]);
    }
    if (ghost?.route) {
      for (const point of ghost.route) {
        revealPortsNearPoint(point);
      }
    }

    return keys;
  }, [
    branchKitPorts,
    draftRoute,
    ghost,
    k,
    nearBranchKitPortKey,
  ]);

  if (!enabled || width <= 0 || height <= 0) return null;

  const handleR = hpx(6.5);
  const handleHit = hpx(11);
  const insR = hpx(5);

  return (
    <div className="absolute left-0 top-0 z-[8]" style={{ width, height, pointerEvents: 'none' }}>
      {canInteract && (pipeToolActive || placingKit || pipes.some((pipe) => selectedSet.has(pipe.id))
        || (selectionHitTesting && hvacElements.some(element => element.type === 'outdoor-unit'))) ? (
        <PipeRoutingToolbar
          ruleProfile={ruleProfile}
          drawing={pipeToolActive}
          placingKit={placingKit}
          kitKind={kitKind}
          onKitKindChange={setKitKind}
          onPlaceKit={placingKit ? () => { setPlacingKit(false); setKitGhost(null); } : startPlaceKit}
        />
      ) : null}
      {canInteract && placingKit ? (
        <div
          style={{
            position: 'absolute',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            pointerEvents: 'none',
            background: '#0F766E',
            color: '#fff',
            borderRadius: 8,
            padding: '7px 14px',
            fontSize: 12.5,
            fontWeight: 500,
            boxShadow: '0 2px 10px rgba(0,0,0,0.18)',
            whiteSpace: 'nowrap',
            zIndex: 20,
          }}
        >
          {kitGhost?.snap
            ? 'Release to place — port snapped to ' + kitGhost.snap.portRole
            : 'Move a port near an open pipe end to snap · click to place · right-click / Esc to cancel'}
        </div>
      ) : null}
      <svg
        ref={svgRef}
        width={width}
        height={height}
        style={{ display: 'block', touchAction: 'none', pointerEvents: 'none' }}
        onPointerMove={canInteract ? onPointerMove : undefined}
        onPointerUp={canInteract ? endDrag : undefined}
        onPointerLeave={() => {
          if (!canInteract) return;
          setNearBranchKitPortKey(null);
          endDrag();
        }}
      >
        <defs>
          <linearGradient id="bkCu" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4a2610" />
            <stop offset="0.12" stopColor="#8a5228" />
            <stop offset="0.3" stopColor="#d99a5f" />
            <stop offset="0.4" stopColor="#fff0dc" />
            <stop offset="0.5" stopColor="#e8b57e" />
            <stop offset="0.72" stopColor="#a5632f" />
            <stop offset="1" stopColor="#59300f" />
          </linearGradient>
          <radialGradient id="bkCub" cx="0.38" cy="0.32" r="0.75">
            <stop offset="0" stopColor="#f8d9af" />
            <stop offset="0.5" stopColor="#c9824c" />
            <stop offset="1" stopColor="#6b3818" />
          </radialGradient>
        </defs>
        <g ref={gRef} transform={matrix}>
          {/* Live draw preview: render the in-progress route through the SAME
              gas/liquid elements the commit will build (real insulated diameters +
              baked gap), via the shared tube helper — so the preview is pixel-
              identical to the finished pipe and never changes size on Enter. */}
          {draftPipeViews.map((p) => {
            const { tubes, insW, coreW, sheenW } = pipeTubes(p, p.route);
            return (
              <g key={`draft-${p.id}`} style={{ pointerEvents: 'none' }} opacity={0.75}>
                {renderTubeBody(tubes, insW, coreW, sheenW, `draft-${p.id}`)}
              </g>
            );
          })}
          {pipes.map((p) => {
            const route = ghost && ghost.id === p.id ? ghost.route : p.route;
            // Real gas/liquid tubes via the shared helper — the SAME code the live
            // draw preview uses, so a committed pipe and its preview can't differ.
            const { tubes, insW, coreW, sheenW } = pipeTubes(p, route);
            const selected = canInteract && selectedSet.has(p.id);
            const hRoute = route;
            // Place the handles on the SAME offset as the visible body, so the
            // dots / + sit on the pipe even when the gap shifts it. Edits still
            // operate on the un-offset centerline (route).
            // The rendered (filleted) body the handles snap onto, so a vertex
            // handle sits on the rounded fitting as the bend radius changes.
            const bodyPoly = p.isPair ? route : tubes[0]?.points ?? route;
            return (
              <g key={p.id}>
                {canInteract && selectionHitTesting
                  ? tubes.map((t, i) => (
                      <path
                        key={`hit-${i}`}
                        d={t.d}
                        fill="none"
                        stroke="rgba(0,0,0,0.001)"
                        strokeWidth={Math.max(insW + hpx(PIPE_SELECTION_HIT_PADDING_PX * 2), hpx(PIPE_SELECTION_MIN_HIT_WIDTH_PX))}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ cursor: selected ? 'move' : 'pointer', pointerEvents: 'stroke' }}
                        onPointerDown={(e) => beginMove(e, p.id)}
                      />
                    ))
                  : null}
                {/* insulation sleeve + copper core + sheen — shared with the live
                    preview so widths always match. Butt caps: a real cut pipe ends
                    in a flat perpendicular face; bends stay smooth via round joins. */}
                {renderTubeBody(tubes, insW, coreW, sheenW, `c-${p.id}`)}
                {selected
                  ? hRoute.slice(0, -1).map((_, si) => {
                      const mid = { x: (hRoute[si]!.x + hRoute[si + 1]!.x) / 2, y: (hRoute[si]!.y + hRoute[si + 1]!.y) / 2 };
                      const m = nearestOnPolyline(mid, bodyPoly);
                      return (
                        <g key={`ins-h-${si}`} style={{ cursor: 'copy', pointerEvents: 'auto' }} onPointerDown={(e) => onInsert(e, p.id, si, route)}>
                          <circle cx={m.x} cy={m.y} r={handleHit} fill="rgba(0,0,0,0.001)" />
                          <circle cx={m.x} cy={m.y} r={insR} fill="#fff" stroke="#639922" strokeWidth={hpx(1.5)} style={{ pointerEvents: 'none' }} />
                          <path
                            d={`M ${m.x - hpx(2.4)} ${m.y} H ${m.x + hpx(2.4)} M ${m.x} ${m.y - hpx(2.4)} V ${m.y + hpx(2.4)}`}
                            stroke="#3B6D11"
                            strokeWidth={hpx(1.4)}
                            style={{ pointerEvents: 'none' }}
                          />
                        </g>
                      );
                    })
                  : null}
                {selected
                  ? hRoute.map((rawPt, vi) => {
                      const ep = vi === 0 || vi === hRoute.length - 1;
                      const pt = ep ? rawPt : nearestOnPolyline(rawPt, bodyPoly);
                      return (
                        <g
                          key={`v-${vi}`}
                          style={{ cursor: 'grab', pointerEvents: 'auto' }}
                          onPointerDown={(e) => onVertexDown(e, p, vi, route)}
                          onContextMenu={(e) => onDelete(e, p, vi, route)}
                        >
                          <circle cx={pt.x} cy={pt.y} r={handleHit} fill="rgba(0,0,0,0.001)" />
                          <circle cx={pt.x} cy={pt.y} r={handleR} fill="#fff" stroke={ep ? '#0F6E56' : '#185FA5'} strokeWidth={hpx(2)} style={{ pointerEvents: 'none' }} />
                          <circle cx={pt.x} cy={pt.y} r={hpx(2.6)} fill={ep ? '#0F6E56' : '#185FA5'} style={{ pointerEvents: 'none' }} />
                        </g>
                      );
                    })
                  : null}
                {/* Extend grips: a teal "+" just past each open end. Click one to
                    continue the pipe from that end (click to place, right-click /
                    Enter / Esc to finish). */}
                {selected && !bundleSelection
                  ? (['start', 'end'] as const).map((end) => {
                      const endIdx = end === 'end' ? hRoute.length - 1 : 0;
                      const adjIdx = end === 'end' ? hRoute.length - 2 : 1;
                      const e0 = hRoute[endIdx]!;
                      const e1 = hRoute[adjIdx] ?? e0;
                      const o = unit(e0.x - e1.x, e0.y - e1.y);
                      const hx = e0.x + o.x * hpx(20);
                      const hy = e0.y + o.y * hpx(20);
                      return (
                        <g
                          key={`ext-${end}`}
                          style={{ cursor: 'crosshair', pointerEvents: 'auto' }}
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            beginExtendFromLineEnd(p, end);
                          }}
                        >
                          <line x1={e0.x} y1={e0.y} x2={hx} y2={hy} stroke="#0F766E" strokeWidth={hpx(1.4)} strokeDasharray={`${hpx(3)} ${hpx(2)}`} style={{ pointerEvents: 'none' }} />
                          <circle cx={hx} cy={hy} r={handleHit} fill="rgba(0,0,0,0.001)" />
                          <circle cx={hx} cy={hy} r={hpx(7)} fill="#fff" stroke="#0F766E" strokeWidth={hpx(1.8)} style={{ pointerEvents: 'none' }} />
                          <path
                            d={`M ${hx - hpx(3)} ${hy} H ${hx + hpx(3)} M ${hx} ${hy - hpx(3)} V ${hy + hpx(3)}`}
                            stroke="#0F766E"
                            strokeWidth={hpx(1.6)}
                            style={{ pointerEvents: 'none' }}
                          />
                        </g>
                      );
                    })
                  : null}
              </g>
            );
          })}
          {/* Common shared-center extend grip(s): shown when both lines of one
              bundle are selected and no draw is active. Positions track the
              VISIBLE bodies, so the grip stays centered when gapSpread > 0. */}
          {canInteract && bundleSelection
            ? (() => {
                const la = pipes.find((p) => p.id === bundleSelection.aId);
                const lb = pipes.find((p) => p.id === bundleSelection.bId);
                const visEnd = (pipe: PipeView | undefined, end: 'start' | 'end', fallback: Point2D): Point2D => {
                  if (!pipe) return fallback;
                  const r = pipe.route;
                  return end === 'end' ? r[r.length - 1]! : r[0]!;
                };
                return (
                  <g>
                    {bundleSelection.ends.map((en) => {
                      const aVis = visEnd(la, en.aEnd, en.aPt);
                      const bVis = visEnd(lb, en.bEnd, en.bPt);
                      const cx = (aVis.x + bVis.x) / 2;
                      const cy = (aVis.y + bVis.y) / 2;
                      const gx = cx + en.out.x * hpx(22);
                      const gy = cy + en.out.y * hpx(22);
                      return (
                        <g
                          key={`bgrip-${en.key}`}
                          style={{ cursor: 'crosshair', pointerEvents: 'auto' }}
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            beginExtendFromBundleEnd(en.aPt, en.bPt);
                          }}
                        >
                          <line x1={cx} y1={cy} x2={gx} y2={gy} stroke="#7C3AED" strokeWidth={hpx(1.4)} strokeDasharray={`${hpx(3)} ${hpx(2)}`} style={{ pointerEvents: 'none' }} />
                          <circle cx={gx} cy={gy} r={handleHit + hpx(2)} fill="rgba(0,0,0,0.001)" />
                          <circle cx={gx} cy={gy} r={hpx(9)} fill="#fff" stroke="#7C3AED" strokeWidth={hpx(2)} style={{ pointerEvents: 'none' }} />
                          <path
                            d={`M ${gx - hpx(4)} ${gy} H ${gx + hpx(4)} M ${gx} ${gy - hpx(4)} V ${gy + hpx(4)}`}
                            stroke="#7C3AED"
                            strokeWidth={hpx(2)}
                            style={{ pointerEvents: 'none' }}
                          />
                          <circle cx={aVis.x} cy={aVis.y} r={hpx(2.4)} fill="#7C3AED" style={{ pointerEvents: 'none' }} />
                          <circle cx={bVis.x} cy={bVis.y} r={hpx(2.4)} fill="#7C3AED" style={{ pointerEvents: 'none' }} />
                        </g>
                      );
                    })}
                  </g>
                );
              })()
            : null}
          {/* Extension previews are rendered by the draw tool via draftPipes —
              no bespoke bundle/port preview lives here anymore. */}
          {/* Every PLACED branch kit (real-geometry sprite), drawn BEFORE the port
              grips so the grips sit on top (visible + clickable). A 'both' kit is
              two fittings, one per line. The sprite is the kit's select + drag target. */}
          {placedKits.flatMap((kit) => {
            return kit.sprites.map((sp) => {
              const img = kitImg[sp.line];
              if (!img?.ok) return null;
              const Wimg = 1000;
              const Himg = Wimg * img.aspect;
              const matrix = branchKitSpriteTransform(sp.line, img.aspect, sp);
              return (
                <g
                  key={`pk-${kit.id}-${sp.line}`}
                  transform={`matrix(${matrix.join(" ")})`}
                >
                  <image
                    href={KIT_IMG[sp.line]}
                    x={0}
                    y={0}
                    width={Wimg}
                    height={Himg}
                    preserveAspectRatio="none"
                    style={{ pointerEvents: canInteract ? 'auto' : 'none', cursor: canInteract ? 'move' : undefined }}
                    onPointerDown={canInteract ? (e) => beginMove(e, kit.id) : undefined}
                  />
                </g>
              );
            });
          })}
          {/* Branch-kit port grips: hidden at rest, revealed near active pipe work. */}
          {branchKitPorts.map((kit) =>
            kit.ports.map((port) => {
              const c = port.center;
              const dir = port.conn.direction;
              const dl = Math.hypot(dir.x, dir.y) || 1;
              const dx = dir.x / dl;
              const dy = dir.y / dl;
              const label =
                port.conn.terminalRole === 'inlet'
                  ? 'inlet'
                  : port.conn.terminalRole === 'run-outlet'
                    ? 'run'
                    : 'branch';
              const sel = kit.selected;
              // The clickable draw-origin must span BOTH tube ends (gas + liquid),
              // since a 'both' kit's visible ports sit at those points, not at the
              // bundle centre between them — otherwise hovering a tube end misses.
              const halfSpan =
                Math.hypot(port.gasPos.x - port.liquidPos.x, port.gasPos.y - port.liquidPos.y) / 2;
              const hitR = Math.max(hpx(13), halfSpan + hpx(10));
              const portKey = branchKitPortKey(kit.id, port.conn.terminalRole);
              const showPortGrip = canInteract && visibleBranchKitPortKeys.has(portKey);
              const canStartPipeFromPort =
                canInteract && pipeToolActive && !pipeRouteStarted && !placingKit;
              return (
                // In pipe-start mode this hidden disc can start a route from the
                // port; otherwise the group is visual-only and cannot steal picks.
                <g
                  key={`bkp-${kit.id}-${port.conn.terminalRole}`}
                  style={{
                    pointerEvents: canStartPipeFromPort ? 'auto' : 'none',
                    cursor: canStartPipeFromPort ? 'crosshair' : 'default',
                  }}
                  onPointerMove={(e) => {
                    if (canStartPipeFromPort) updateNearbyBranchKitPort(e.clientX, e.clientY);
                  }}
                  onPointerLeave={() => {
                    if (canStartPipeFromPort) setNearBranchKitPortKey(null);
                  }}
                  onPointerDown={(e) => {
                    if (!canStartPipeFromPort) return;
                    e.stopPropagation();
                    // Pull a run from the kit port, honoring the global Lines
                    // selector: pair, or a single gas/liquid line from its outlet.
                    onBeginExtendRoute(port.conn, pipeLineMode);
                  }}
                >
                  {/* Transparent hit disc so the whole port area is pressable. */}
                  <circle cx={c.x} cy={c.y} r={hitR} fill="rgba(0,0,0,0.001)" />
                  <g opacity={showPortGrip ? 1 : 0} style={{ pointerEvents: 'none' }}>
                  {/* For a 'both' kit only, faint gas/liquid points so both lines read. */}
                  {halfSpan > hpx(2.5) ? (
                    <>
                      <circle cx={port.gasPos.x} cy={port.gasPos.y} r={hpx(2.6)} fill="#1F6FB2" fillOpacity={0.85} />
                      <circle cx={port.liquidPos.x} cy={port.liquidPos.y} r={hpx(2.6)} fill="#B5742F" fillOpacity={0.85} />
                    </>
                  ) : null}
                  {/* Green dashed snap ring centred exactly on the port. */}
                  <circle
                    cx={c.x}
                    cy={c.y}
                    r={hpx(sel ? 13 : 11)}
                    fill="none"
                    stroke="#2F9E68"
                    strokeWidth={hpx(sel ? 2.6 : 2.1)}
                    strokeDasharray={`${hpx(4)} ${hpx(4)}`}
                  />
                  <circle cx={c.x} cy={c.y} r={hpx(2)} fill="#2F9E68" />
                  {sel ? (
                    <text
                      x={c.x - dx * hpx(19)}
                      y={c.y - dy * hpx(19) + hpx(3)}
                      fontSize={hpx(11)}
                      textAnchor="middle"
                      fill="#2F9E68"
                      style={{ fontWeight: 500 }}
                    >
                      {label}
                    </text>
                  ) : null}
                  </g>
                </g>
              );
            }),
          )}
          {/* Copper branch-kit placement ghost, attached to the cursor, snapping
              a port onto an open pipe end (auto-rotated to meet it). */}
          {canInteract && placingKit && kitGhost
            ? (() => {
                const tf = kitGhost.transform;
                const op = kitGhost.snap ? 0.98 : 0.6;
                const byRole = new Map(kitPlacement.ports.map((p) => [p.role, p.point]));
                const inlet = byRole.get('inlet');
                const run = byRole.get('run-outlet');
                const branch = byRole.get('branch-outlet');
                // Slim tube radius (mm) — real DIS-22-1G stubs are thin vs the body.
                const r = kitKind === 'both' ? 11 : kitKind === 'liquid' ? 8 : 10;
                const end = kitGhost.snap ? openEnds.find((e) => e.id === kitGhost.snap!.targetId) : null;
                const lerp = (a: Point2D, b: Point2D, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
                const parts: JSX.Element[] = [];
                const img = kitImg[kitKind];
                const li = kitPlacement.localById['inlet'];
                const lr = kitPlacement.localById['run-outlet'];
                const lb = kitPlacement.localById['branch-outlet'];
                if (img?.ok && li && lr && lb) {
                  // Photo-real sprite(s): a 'both' kit previews as two fittings, gas
                  // on the gas line + liquid on the liquid line, each image placed so
                  // its inlet/run anchors land on that line's local ports (the outer
                  // kit frame handles rotation). Matches the committed render.
                  const lines: ('gas' | 'liquid')[] = kitKind === 'both' ? ['gas', 'liquid'] : [kitKind];
                  for (const line of lines) {
                    const lineImg = kitImg[line];
                    if (!lineImg?.ok) continue;
                    const inP = line === 'gas' ? li.gas : li.liquid;
                    const runP = line === 'gas' ? lr.gas : lr.liquid;
                    const branchP = line === 'gas' ? lb.gas : lb.liquid;
                    const matrix = branchKitSpriteTransform(line, lineImg.aspect, { inlet: inP, run: runP, branch: branchP });
                    parts.push(
                      <image key={`kimg-${line}`} href={KIT_IMG[line]} x={0} y={0} width={1000} height={1000 * lineImg.aspect} transform={`matrix(${matrix.join(' ')})`} preserveAspectRatio="none" />,
                    );
                  }
                } else if (inlet && run) {
                  const dTrunk = unit(run.x - inlet.x, run.y - inlet.y);
                  // Straight trunk, inlet -> run (smoothest); junction sits ~58%
                  // along it, over the branch tap.
                  parts.push(kitGloss('gt', [inlet, run], r));
                  // Branch taps ~40% along the straight run-through (per the
                  // DIS-22-1G drawing).
                  const jn = lerp(inlet, run, 0.4);
                  const rb = r * 0.92;
                  if (branch) {
                    // Branch peels off the wedge bottom and turns with a 45-deg
                    // bend (mitered): a 45-deg diagonal drop, then HORIZONTAL to
                    // the socket — not a smooth curve (per the drawing).
                    const bs = { x: jn.x + r * 0.4, y: jn.y + r };
                    // 45-deg diagonal (dx = dy) down to the branch level, clamped
                    // to leave room for the horizontal run to the socket.
                    const drop = Math.min(Math.max(branch.y - bs.y, 1), (branch.x - bs.x) * 0.7);
                    const diagEnd = { x: bs.x + drop, y: branch.y };
                    const d = `M ${bs.x} ${bs.y} L ${diagEnd.x} ${diagEnd.y} L ${branch.x} ${branch.y}`;
                    parts.push(kitGlossPath('gb', d, rb));
                    parts.push(kitWedge('gwedge', jn, r, bs));
                    parts.push(kitSwage('gbw1', lerp(diagEnd, branch, 0.42), { x: 1, y: 0 }, rb));
                    parts.push(kitSwage('gbw2', lerp(diagEnd, branch, 0.78), { x: 1, y: 0 }, rb));
                    parts.push(kitSocket('gsb', branch, { x: 1, y: 0 }, rb));
                  }
                  parts.push(kitSwage('gw1', lerp(inlet, jn, 0.36), dTrunk, r));
                  parts.push(kitSwage('gw2', lerp(inlet, jn, 0.72), dTrunk, r));
                  parts.push(kitSwage('gw3', lerp(jn, run, 0.55), dTrunk, r));
                  parts.push(kitSwage('gw4', lerp(jn, run, 0.85), dTrunk, r));
                  parts.push(kitSocket('gsi', inlet, { x: -1, y: 0 }, r));
                  parts.push(kitSocket('gsr', run, { x: 1, y: 0 }, r));
                }
                return (
                  <g style={{ pointerEvents: 'none' }}>
                    <g transform={`translate(${tf.tx} ${tf.ty}) rotate(${tf.rotDeg})`} opacity={op}>
                      {parts}
                    </g>
                    {end ? (
                      <circle cx={end.point.x} cy={end.point.y} r={hpx(13)} fill="none" stroke="#2F9E68" strokeWidth={hpx(2.6)} strokeDasharray={`${hpx(4)} ${hpx(4)}`} />
                    ) : null}
                  </g>
                );
              })()
            : null}
          {/* Snap-hover indicator (pushed by the draw tool): the SAME
              endpoint-handle bullseye a committed pipe shows — white disc, teal
              ring, solid teal dot — so every snap affordance is one component. */}
          {snapIndicator ? (
            <g style={{ pointerEvents: 'none' }}>
              <circle cx={snapIndicator.x} cy={snapIndicator.y} r={handleR} fill="#fff" stroke="#0F6E56" strokeWidth={hpx(2)} />
              <circle cx={snapIndicator.x} cy={snapIndicator.y} r={hpx(2.6)} fill="#0F6E56" />
              {snapIndicator.label ? (
                <g transform={`translate(${snapIndicator.x + hpx(13)} ${snapIndicator.y - hpx(28)})`}>
                  <rect width={hpx(Math.min(340, snapIndicator.label.length * 6 + 16))} height={hpx(23)} rx={hpx(5)} fill="#f0fdfa" stroke="#99f6e4" strokeWidth={hpx(1)} />
                  <text x={hpx(8)} y={hpx(15)} fontSize={hpx(11)} fontFamily="system-ui, sans-serif" fill="#115e59">{snapIndicator.label}</text>
                </g>
              ) : null}
            </g>
          ) : null}
        </g>
        {/* Kit placement uses a transparent capture layer (move = ghost, click =
            place, right-click = cancel). Extension no longer needs one — the draw
            tool owns the canvas gestures once a session is seeded. */}
        {canInteract && placingKit ? (
          <rect
            x={0}
            y={0}
            width={width}
            height={height}
            fill="rgba(0,0,0,0)"
            style={{ pointerEvents: 'auto', cursor: 'crosshair' }}
            onPointerMove={onKitMove}
            onClick={onKitClick}
            onContextMenu={finishPlaceKit}
          />
        ) : null}
      </svg>
    </div>
  );
});
