'use client';

/**
 * PipeStudioOverlay — the pipe-studio editor, applied in-place on the drawing
 * canvas.
 *
 * A transparent SVG overlay (same mount + viewport sync as the Konva layer) that
 * renders every refrigerant pipe in the store as the studio's concentric VRF
 * pair (via {@link ./pipePairGeometry#buildPipePair}) and lets the user edit the
 * path by dragging / inserting / deleting vertices, writing the result back to
 * `hvacElements`. Pure presentation + interaction; the geometry is the same
 * tested module used by the standalone {@link ./PipeStudioCanvas}.
 *
 * Gated by the caller (`enabled`) behind the `hvac.pipe.engine` flag, so the
 * default Fabric canvas is unaffected until it is switched on.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import type { HvacElement, Point2D } from '../../../types';
import { viewportToViewTransform } from '../coordinateTransform';
import { MM_TO_PX } from '../scale';

import {
  solveBranchKitSnap,
  type BranchKitSnap,
  type PlaceablePort,
  type PlacementTransform,
  type SnapTargetEnd,
} from './branchKitPlacementSnap';
import { buildPipeCenterline, toPolyline, toSvgPathData } from './pipeCenterline';
import {
  buildRefrigerantBranchKitViewModel,
  resolveRefrigerantBranchKitConnectionIdentity,
} from './refrigerantBranchKitModel';
import { DEFAULT_REFRIGERANT_PIPE_GAP_MM } from './refrigerantPipeDimensions';
import { getBranchKitPortConnections } from './refrigerantPipePairModel';
import {
  BRANCH_KIT_SPRITE_ASPECT,
  BRANCH_KIT_SPRITE_GAS,
  BRANCH_KIT_SPRITE_LIQUID,
} from './branchKitSprite';

const KIT_ELEVATION_MM = 2600;

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
// The inlet + run-outlet sit at the far ends on the top line of the projection.
const KIT_IMG_ANCHOR = { inlet: { x: 0.01, y: 0.21 }, run: { x: 0.99, y: 0.21 } };

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
  enabled: boolean;
  width: number;
  height: number;
  viewportZoom: number;
  panOffset: Point2D;
  hvacElements: HvacElement[];
  selectedIds: string[];
  updateHvacElement: (
    id: string,
    updates: Partial<HvacElement>,
    options?: { skipHistory?: boolean },
  ) => void;
  addHvacElement: (
    element: Omit<Partial<HvacElement>, 'id'> &
      Pick<
        HvacElement,
        'type' | 'position' | 'width' | 'depth' | 'height' | 'elevation' | 'mountType' | 'label'
      >,
  ) => string;
  saveToHistory: (action: string) => void;
}

interface PipeView {
  id: string;
  route: Point2D[];
  isPair: boolean;
  lineKind: 'gas' | 'liquid' | null;
  gapMm: number;
  outerMm: number;
  bendMm: number;
  /** Which perpendicular side of its bundle partner this single line sits on. */
  offsetSign: number;
  /** Explicit gas<->liquid linkage (same id for the two lines of one bundle). */
  bundleId: string | null;
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

function routeMid(route: Point2D[]): Point2D {
  if (route.length === 0) return { x: 0, y: 0 };
  return route[Math.floor(route.length / 2)]!;
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

function firstDir(route: Point2D[]): Point2D {
  if (route.length < 2) return { x: 1, y: 0 };
  const dx = route[1]!.x - route[0]!.x;
  const dy = route[1]!.y - route[0]!.y;
  const n = Math.hypot(dx, dy) || 1;
  return { x: dx / n, y: dy / n };
}

/**
 * Offsets a SHARP route polyline perpendicular by `off` (left normal), mitred at
 * corners. The caller fillets the result, so the bend radius stays independent
 * of the offset (offsetting the centerline shifts position only, not the bend).
 */
function offsetPolyline(route: Point2D[], off: number): Point2D[] {
  if (route.length < 2 || off === 0) return route.map((p) => ({ x: p.x, y: p.y }));
  const segN = (i: number): Point2D => {
    const dx = route[i + 1]!.x - route[i]!.x;
    const dy = route[i + 1]!.y - route[i]!.y;
    const n = Math.hypot(dx, dy) || 1;
    return { x: -dy / n, y: dx / n };
  };
  const out: Point2D[] = [];
  const last = route.length - 1;
  for (let i = 0; i <= last; i += 1) {
    if (i === 0) {
      const n0 = segN(0);
      out.push({ x: route[0]!.x + off * n0.x, y: route[0]!.y + off * n0.y });
    } else if (i === last) {
      const nl = segN(last - 1);
      out.push({ x: route[last]!.x + off * nl.x, y: route[last]!.y + off * nl.y });
    } else {
      const a = segN(i - 1);
      const b = segN(i);
      let mx = a.x + b.x;
      let my = a.y + b.y;
      const ml = Math.hypot(mx, my);
      if (ml < 1e-6) {
        out.push({ x: route[i]!.x + off * b.x, y: route[i]!.y + off * b.y });
      } else {
        mx /= ml;
        my /= ml;
        const dotv = mx * a.x + my * a.y;
        const scale = Math.min(Math.abs(dotv) > 1e-3 ? 1 / dotv : 1, 4);
        out.push({ x: route[i]!.x + off * mx * scale, y: route[i]!.y + off * my * scale });
      }
    }
  }
  return out;
}

/**
 * Collapses runs of near-collinear points so each fitting (elbow) is a single
 * vertex. Geometry-preserving: only points within `tolMm` of the straight line
 * between their kept neighbours are dropped. Real corners are kept.
 */
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

  const maxLen = Math.max(...runs.map((r) => r.len));
  const minLeg = Math.max(6, maxLen * 0.15);
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
  return out;
}

function toPipeView(el: HvacElement, edited: boolean): PipeView | null {
  if (el.type !== 'refrigerant-pipe' && el.type !== 'refrigerant-pipe-pair') return null;
  const props = (el.properties ?? {}) as Record<string, unknown>;
  const raw = readRoute(props.routePoints);
  // Un-edited pipes get their rounded bends collapsed to clean corners. Once the
  // user has edited a pipe we trust its route as-is (only drop coincident
  // points), so inserted/collinear vertices are not simplified away.
  const route = edited ? dedupe(raw, 0.5) : reconstructCorners(raw);
  if (route.length < 2) return null;
  const outerMm = readNumber(props.outerDiameterMm, DEFAULT_OUTER_DIAMETER_MM);
  const rawKind = typeof props.lineKind === 'string' ? props.lineKind : null;
  return {
    id: el.id,
    route,
    isPair: el.type === 'refrigerant-pipe-pair',
    lineKind: rawKind === 'gas' ? 'gas' : rawKind === 'liquid' ? 'liquid' : null,
    gapMm: readNumber(props.pipeGapMm, DEFAULT_REFRIGERANT_PIPE_GAP_MM),
    outerMm,
    // Short-radius elbow: tight, realistic copper bend (~0.8x the insulated OD),
    // not a long sweeping curve.
    bendMm: Math.max(outerMm * 0.8, 12),
    offsetSign: 0,
    bundleId: typeof props.bundleId === 'string' && props.bundleId.length > 0 ? props.bundleId : null,
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

export function PipeStudioOverlay({
  enabled,
  width,
  height,
  viewportZoom,
  panOffset,
  hvacElements,
  selectedIds,
  updateHvacElement,
  addHvacElement,
  saveToHistory,
}: PipeStudioOverlayProps): JSX.Element | null {
  const gRef = useRef<SVGGElement | null>(null);
  const dragRef = useRef<{ id: string; vi: number; startWorld: Point2D; startRoute: Point2D[] } | null>(null);
  const editedIdsRef = useRef<Set<string>>(new Set());
  // Each single line's bundle side, determined once and kept stable so editing a
  // vertex can't make the inferred side flip and drop the gap offset.
  const offsetSignCacheRef = useRef<Map<string, number>>(new Map());
  const [ghost, setGhost] = useState<{ id: string; route: Point2D[] } | null>(null);
  const [bendRadiusMm, setBendRadiusMm] = useState(24);
  // Relative spread added to the existing gap (0 = pipes as drawn).
  const [gapSpreadMm, setGapSpreadMm] = useState(0);
  // Active SINGLE-line extension: which pipe end is being continued + the live
  // cursor. One line only — extending a whole bundle uses the shared-center grip
  // (select both lines). Selection decides the behaviour; no mode toggle.
  const [extend, setExtend] = useState<{
    id: string;
    end: 'start' | 'end';
    cursor: Point2D | null;
  } | null>(null);
  // Active BUNDLE extension from the shared-center grip: draw on the centerline,
  // both lines fall out as symmetric +/- gap/2 offsets. aSide fixes which side
  // line A sits on; the centerline anchor is recomputed live from the two ends.
  const [bundleDraw, setBundleDraw] = useState<{
    aId: string;
    aEnd: 'start' | 'end';
    bId: string;
    bEnd: 'start' | 'end';
    aSide: number;
    gap: number;
    outX: number;
    outY: number;
    cursor: Point2D | null;
  } | null>(null);
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

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Ignore keys routed to a focused form control (e.g. the toolbar sliders),
      // so Enter/Escape there can't silently abort an in-progress draw.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Shift') orthoRef.current = true;
      if (e.key === 'Escape' || e.key === 'Enter') {
        setExtend(null);
        setBundleDraw(null);
        setPlacingKit(false);
        setKitGhost(null);
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
  }, []);

  const view = viewportToViewTransform(viewportZoom, panOffset);
  const k = MM_TO_PX * view.zoom;
  const matrix = `matrix(${k} 0 0 ${k} ${view.panPx.x} ${view.panPx.y})`;
  const hpx = (n: number) => n / Math.max(k, 1e-6); // screen px -> g-space (mm) units

  const pipes = useMemo(() => {
    const list: PipeView[] = [];
    for (const el of hvacElements) {
      const v = toPipeView(el, editedIdsRef.current.has(el.id));
      if (v) list.push(v);
    }
    // For single gas/liquid lines, find the bundle partner and record which
    // perpendicular side this line sits on, so the gap spread pushes the two
    // APART from where they are (never toward / through each other).
    const cache = offsetSignCacheRef.current;
    const singles = list.filter((p) => !p.isPair);
    for (const p of singles) {
      // Reuse the side decided the first time we saw this line; do not re-infer
      // it from positions that an edit may have moved.
      const cached = cache.get(p.id);
      if (cached !== undefined && cached !== 0) {
        p.offsetSign = cached;
        continue;
      }
      const pMid = routeMid(p.route);
      let partner: PipeView | null = null;
      let bestD = Infinity;
      for (const q of singles) {
        if (q === p) continue;
        if (p.lineKind && q.lineKind && p.lineKind === q.lineKind) continue;
        const qMid = routeMid(q.route);
        const dd = Math.hypot(pMid.x - qMid.x, pMid.y - qMid.y);
        if (dd < bestD) {
          bestD = dd;
          partner = q;
        }
      }
      if (partner && bestD < 600) {
        // Measure the side at the SAME reference: p's start point + first-segment
        // normal, against the nearest point on the partner. (Mixing midpoint with
        // start-normal gave the wrong sign and made pipes cross.)
        const dir = firstDir(p.route);
        const perp = { x: -dir.y, y: dir.x };
        const pRef = p.route[0]!;
        let qRef = partner.route[0]!;
        let qd = Infinity;
        for (const qp of partner.route) {
          const dd2 = Math.hypot(qp.x - pRef.x, qp.y - pRef.y);
          if (dd2 < qd) {
            qd = dd2;
            qRef = qp;
          }
        }
        const along = (pRef.x - qRef.x) * perp.x + (pRef.y - qRef.y) * perp.y;
        p.offsetSign =
          Math.abs(along) > 2 ? (along > 0 ? 1 : -1) : p.lineKind === 'liquid' ? -1 : 1;
      }
      if (p.offsetSign !== 0) cache.set(p.id, p.offsetSign);
    }
    return list;
  }, [hvacElements]);

  // Fail-safe: if a pipe being extended/drawn is deleted (or otherwise leaves the
  // store) mid-draw, drop the draw so the capture overlay can't trap all input.
  useEffect(() => {
    if (extend && !pipes.some((p) => p.id === extend.id)) setExtend(null);
    if (
      bundleDraw &&
      !(pipes.some((p) => p.id === bundleDraw.aId) && pipes.some((p) => p.id === bundleDraw.bId))
    ) {
      setBundleDraw(null);
    }
  }, [pipes, extend, bundleDraw]);

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
    if (!sameBundle && !oppositeKind) return null;
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
  const branchKitPorts = useMemo(() => {
    const out: { id: string; ports: ReturnType<typeof getBranchKitPortConnections> }[] = [];
    for (const el of hvacElements) {
      if (el.type !== 'refrigerant-branch-kit' || !selectedSet.has(el.id)) continue;
      const ports = getBranchKitPortConnections(el);
      if (ports.length > 0) out.push({ id: el.id, ports });
    }
    return out;
  }, [hvacElements, selectedSet]);

  // Every PLACED branch kit, positioned by its inlet + run-outlet world ports, so
  // the overlay draws them (as the real-geometry sprite) like it draws pipes.
  const placedKits = useMemo(() => {
    const out: { id: string; inlet: Point2D; run: Point2D; kind: 'gas' | 'liquid' | 'both' }[] = [];
    for (const el of hvacElements) {
      if (el.type !== 'refrigerant-branch-kit') continue;
      const ports = getBranchKitPortConnections(el);
      const inlet = ports.find((p) => p.terminalRole === 'inlet')?.point;
      const run = ports.find((p) => p.terminalRole === 'run-outlet')?.point;
      if (!inlet || !run) continue;
      const raw = (el.properties as Record<string, unknown>)?.branchKitLineKind;
      const kind = raw === 'gas' ? 'gas' : raw === 'liquid' ? 'liquid' : 'both';
      out.push({ id: el.id, inlet: { x: inlet.x, y: inlet.y }, run: { x: run.x, y: run.y }, kind });
    }
    return out;
  }, [hvacElements]);

  const toWorld = useCallback((clientX: number, clientY: number): Point2D | null => {
    const g = gRef.current;
    if (!g) return null;
    const ctm = g.getScreenCTM();
    if (!ctm) return null;
    const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  }, []);

  const elementById = useCallback(
    (id: string) => hvacElements.find((e) => e.id === id) ?? null,
    [hvacElements],
  );

  // Write a single pipe's route to the store WITHOUT touching history, so a
  // multi-element edit can batch several writes under one saveToHistory call.
  const writeRoute = useCallback(
    (id: string, route: Point2D[]) => {
      const el = elementById(id);
      if (!el) return;
      // From now on this pipe's route is authoritative — stop re-collapsing it,
      // so inserted/edited vertices persist.
      editedIdsRef.current.add(id);
      const box = bbox(route);
      const margin = readNumber((el.properties as Record<string, unknown>)?.outerDiameterMm, DEFAULT_OUTER_DIAMETER_MM);
      updateHvacElement(
        id,
        {
          position: { x: box.minX - margin, y: box.minY - margin },
          width: box.maxX - box.minX + margin * 2,
          depth: box.maxY - box.minY + margin * 2,
          properties: { ...(el.properties ?? {}), routePoints: route },
        },
        { skipHistory: true },
      );
    },
    [elementById, updateHvacElement],
  );

  const commitRoute = useCallback(
    (id: string, route: Point2D[], label: string) => {
      writeRoute(id, route);
      saveToHistory(label);
    },
    [writeRoute, saveToHistory],
  );

  // Commit BOTH lines of a bundle in ONE history entry: two skip-history writes
  // followed by a single saveToHistory (the store snapshots the whole element
  // list, so this lands as one undo step).
  const commitPair = useCallback(
    (id1: string, route1: Point2D[], id2: string, route2: Point2D[], label: string) => {
      writeRoute(id1, route1);
      writeRoute(id2, route2);
      saveToHistory(label);
    },
    [writeRoute, saveToHistory],
  );

  const onVertexDown = useCallback(
    (e: ReactPointerEvent, id: string, vi: number, route: Point2D[]) => {
      e.stopPropagation();
      const startWorld = toWorld(e.clientX, e.clientY) ?? route[vi]!;
      const startRoute = route.map((p) => ({ ...p }));
      dragRef.current = { id, vi, startWorld, startRoute };
      setGhost({ id, route: startRoute.map((p) => ({ ...p })) });
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [toWorld],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
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
    [toWorld],
  );

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && ghost && ghost.id === drag.id) {
      commitRoute(drag.id, ghost.route, 'Edit refrigerant pipe vertex');
    }
    setGhost(null);
  }, [ghost, commitRoute]);

  const onInsert = useCallback(
    (e: ReactPointerEvent, id: string, si: number, route: Point2D[]) => {
      e.stopPropagation();
      const mid = { x: (route[si]!.x + route[si + 1]!.x) / 2, y: (route[si]!.y + route[si + 1]!.y) / 2 };
      commitRoute(id, [...route.slice(0, si + 1), mid, ...route.slice(si + 1)], 'Insert refrigerant pipe vertex');
    },
    [commitRoute],
  );

  const onDelete = useCallback(
    (e: ReactMouseEvent, id: string, vi: number, route: Point2D[]) => {
      e.preventDefault();
      e.stopPropagation();
      if (route.length <= 2) return;
      commitRoute(id, route.filter((_, i) => i !== vi), 'Delete refrigerant pipe vertex');
    },
    [commitRoute],
  );

  // --- Pipe extension: continue a pipe from one of its open ends ------------
  // Snap the live cursor to a nearby open pipe end (so an extension can connect
  // to another pipe), else lock to 45deg increments off the anchor when Shift is
  // held, else free.
  const extendConstrain = useCallback(
    (w: Point2D, anchor: Point2D, exclude: string | Set<string>, enableSnap = true): Point2D => {
      const skip = typeof exclude === 'string' ? new Set([exclude]) : exclude;
      if (enableSnap) {
        const tol = 14 / Math.max(k, 1e-6);
        let best: Point2D | null = null;
        let bd = tol;
        for (const q of pipes) {
          if (skip.has(q.id)) continue;
          for (const ep of [q.route[0], q.route[q.route.length - 1]]) {
            if (!ep) continue;
            const d = Math.hypot(ep.x - w.x, ep.y - w.y);
            if (d < bd) {
              bd = d;
              best = ep;
            }
          }
        }
        if (best) return { x: best.x, y: best.y };
      }
      if (orthoRef.current) {
        const dx = w.x - anchor.x;
        const dy = w.y - anchor.y;
        const dist = Math.hypot(dx, dy);
        const step = Math.PI / 4;
        const ang = Math.round(Math.atan2(dy, dx) / step) * step;
        return { x: anchor.x + Math.cos(ang) * dist, y: anchor.y + Math.sin(ang) * dist };
      }
      return { x: w.x, y: w.y };
    },
    [pipes, k],
  );

  const startExtend = useCallback((e: ReactPointerEvent, id: string, end: 'start' | 'end') => {
    e.stopPropagation();
    setBundleDraw(null);
    setExtend({ id, end, cursor: null });
  }, []);

  const onExtendMove = useCallback(
    (e: ReactPointerEvent) => {
      const cx = e.clientX;
      const cy = e.clientY;
      setExtend((ex) => {
        if (!ex) return ex;
        const w = toWorld(cx, cy);
        if (!w) return ex;
        const pipe = pipes.find((p) => p.id === ex.id);
        if (!pipe) return ex;
        const anchor = ex.end === 'end' ? pipe.route[pipe.route.length - 1]! : pipe.route[0]!;
        return { ...ex, cursor: extendConstrain(w, anchor, ex.id) };
      });
    },
    [pipes, toWorld, extendConstrain],
  );

  const onExtendClick = useCallback(
    (e: ReactMouseEvent) => {
      if (!extend) return;
      const w = toWorld(e.clientX, e.clientY);
      if (!w) return;
      const pipe = pipes.find((p) => p.id === extend.id);
      if (!pipe) return;
      const anchor = extend.end === 'end' ? pipe.route[pipe.route.length - 1]! : pipe.route[0]!;
      const np = extendConstrain(w, anchor, extend.id);
      // Skip a zero-length click on the anchor itself.
      if (Math.hypot(np.x - anchor.x, np.y - anchor.y) < 0.5) return;
      // Single line only: the grabbed line grows on its own. To grow the whole
      // bundle, select both lines and use the shared-center grip.
      const next = extend.end === 'end' ? [...pipe.route, np] : [np, ...pipe.route];
      commitRoute(extend.id, next, 'Extend refrigerant pipe');
    },
    [extend, pipes, toWorld, extendConstrain, commitRoute],
  );

  const finishExtend = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    setExtend(null);
    setBundleDraw(null);
  }, []);

  // --- Bundle extension from the shared-center grip -------------------------
  // Live centerline anchor + frozen gap/side for the active bundle draw.
  const bundleAnchor = useCallback(
    (bd: NonNullable<typeof bundleDraw>): Point2D | null => {
      const a = pipes.find((p) => p.id === bd.aId);
      const b = pipes.find((p) => p.id === bd.bId);
      if (!a || !b) return null;
      const aPt = bd.aEnd === 'end' ? a.route[a.route.length - 1]! : a.route[0]!;
      const bPt = bd.bEnd === 'end' ? b.route[b.route.length - 1]! : b.route[0]!;
      return { x: (aPt.x + bPt.x) / 2, y: (aPt.y + bPt.y) / 2 };
    },
    [pipes],
  );

  const startBundleDraw = useCallback(
    (
      e: ReactPointerEvent,
      info: { aEnd: 'start' | 'end'; bEnd: 'start' | 'end'; aPt: Point2D; bPt: Point2D; center: Point2D; out: Point2D; gap: number },
    ) => {
      e.stopPropagation();
      if (!bundleSelection) return;
      setExtend(null);
      // Side of line A across the run heading, so both lines stay on their side.
      // Near-zero projection (ends staggered along the run) -> stable lineKind
      // tiebreak instead of trusting numerical noise.
      const perpX = -info.out.y;
      const perpY = info.out.x;
      const dot = (info.aPt.x - info.center.x) * perpX + (info.aPt.y - info.center.y) * perpY;
      const aSide = Math.abs(dot) < 0.01 ? (bundleSelection.aKind === 'liquid' ? -1 : 1) : dot > 0 ? 1 : -1;
      setBundleDraw({
        aId: bundleSelection.aId,
        aEnd: info.aEnd,
        bId: bundleSelection.bId,
        bEnd: info.bEnd,
        aSide,
        gap: info.gap,
        outX: info.out.x,
        outY: info.out.y,
        cursor: null,
      });
    },
    [bundleSelection],
  );

  const onBundleMove = useCallback(
    (e: ReactPointerEvent) => {
      const cx = e.clientX;
      const cy = e.clientY;
      setBundleDraw((bd) => {
        if (!bd) return bd;
        const w = toWorld(cx, cy);
        if (!w) return bd;
        const anchor = bundleAnchor(bd);
        if (!anchor) return bd;
        // No endpoint snap on the centerline: a bundle has no body there, so a
        // snap would promise a connection the committed legs never make.
        return { ...bd, cursor: extendConstrain(w, anchor, new Set([bd.aId, bd.bId]), false) };
      });
    },
    [toWorld, bundleAnchor, extendConstrain],
  );

  const onBundleClick = useCallback(
    (e: ReactMouseEvent) => {
      if (!bundleDraw) return;
      const w = toWorld(e.clientX, e.clientY);
      if (!w) return;
      const a = pipes.find((p) => p.id === bundleDraw.aId);
      const b = pipes.find((p) => p.id === bundleDraw.bId);
      const anchor = bundleAnchor(bundleDraw);
      if (!a || !b || !anchor) return;
      const cnp = extendConstrain(w, anchor, new Set([bundleDraw.aId, bundleDraw.bId]), false);
      if (Math.hypot(cnp.x - anchor.x, cnp.y - anchor.y) < 0.5) return;
      const dir = unit(cnp.x - anchor.x, cnp.y - anchor.y);
      const nx = -dir.y;
      const ny = dir.x;
      // Keep line A on its frozen geometric side even when the user folds the new
      // segment back over the run (the new normal flips, so re-align by dir.out).
      const effSide = bundleDraw.aSide * (dir.x * bundleDraw.outX + dir.y * bundleDraw.outY >= 0 ? 1 : -1);
      const half = bundleDraw.gap / 2;
      const aNew = { x: cnp.x + nx * effSide * half, y: cnp.y + ny * effSide * half };
      const bNew = { x: cnp.x - nx * effSide * half, y: cnp.y - ny * effSide * half };
      const appendAt = (route: Point2D[], end: 'start' | 'end', pt: Point2D) =>
        end === 'end' ? [...route, pt] : [pt, ...route];
      commitPair(
        a.id,
        appendAt(a.route, bundleDraw.aEnd, aNew),
        b.id,
        appendAt(b.route, bundleDraw.bEnd, bNew),
        'Extend refrigerant pipe pair',
      );
    },
    [bundleDraw, pipes, toWorld, bundleAnchor, extendConstrain, commitPair],
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
    for (const role of roles) {
      const id = resolveRefrigerantBranchKitConnectionIdentity({
        model,
        role,
        lineSelection: kitKind,
        worldCenter: { x: 0, y: 0 },
        rotationDeg: 0,
      });
      if (!id) continue;
      const point =
        kitKind === 'gas'
          ? id.gasPoint
          : kitKind === 'liquid'
            ? id.liquidPoint
            : { x: (id.gasPoint.x + id.liquidPoint.x) / 2, y: (id.gasPoint.y + id.liquidPoint.y) / 2 };
      ports.push({ role, point, direction: id.direction });
    }
    return { width: model.widthMm, depth: model.depthMm, height: model.heightMm, ports };
  }, [kitKind]);

  // Open pipe ends (world) the kit can snap onto.
  const openEnds = useMemo<SnapTargetEnd[]>(() => {
    const out: SnapTargetEnd[] = [];
    for (const p of pipes) {
      if (p.route.length < 2) continue;
      const a0 = p.route[0]!;
      const a1 = p.route[1]!;
      const b0 = p.route[p.route.length - 1]!;
      const b1 = p.route[p.route.length - 2]!;
      const da = unit(a0.x - a1.x, a0.y - a1.y);
      const db = unit(b0.x - b1.x, b0.y - b1.y);
      out.push({ id: `${p.id}:start`, point: { x: a0.x, y: a0.y }, direction: { x: da.x, y: da.y } });
      out.push({ id: `${p.id}:end`, point: { x: b0.x, y: b0.y }, direction: { x: db.x, y: db.y } });
    }
    return out;
  }, [pipes]);

  const startPlaceKit = useCallback(() => {
    setExtend(null);
    setBundleDraw(null);
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
      const { transform } = solveBranchKitSnap(kitPlacement.ports, openEnds, w, tol);
      const { width: kw, depth: kd, height: kh } = kitPlacement;
      addHvacElement({
        type: 'refrigerant-branch-kit',
        position: { x: transform.tx - kw / 2, y: transform.ty - kd / 2 },
        rotation: transform.rotDeg,
        width: kw,
        depth: kd,
        height: kh,
        elevation: KIT_ELEVATION_MM,
        mountType: 'ceiling',
        label: 'Copper branch kit',
        properties: {
          branchKitType: 'dis-22-1g',
          branchKitLineKind: kitKind,
          branchKitWallAllowanceMm: 0.9,
        },
      });
      saveToHistory('Place copper branch kit');
      setPlacingKit(false);
      setKitGhost(null);
    },
    [toWorld, k, kitPlacement, openEnds, kitKind, addHvacElement, saveToHistory],
  );

  const finishPlaceKit = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    setPlacingKit(false);
    setKitGhost(null);
  }, []);

  if (!enabled || width <= 0 || height <= 0) return null;

  const handleR = hpx(6.5);
  const handleHit = hpx(11);
  const insR = hpx(5);

  return (
    <div className="absolute left-0 top-0 z-[8]" style={{ width, height, pointerEvents: 'none' }}>
      {pipes.length > 0 ? (
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            background: '#ffffff',
            border: '1px solid #e6e1d6',
            borderRadius: 10,
            padding: '8px 16px',
            boxShadow: '0 2px 10px rgba(0,0,0,0.10)',
            fontSize: 13,
            color: '#46433c',
            whiteSpace: 'nowrap',
            zIndex: 20,
          }}
        >
          <span style={{ fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: '#B5742F', display: 'inline-block' }} />
            Pipe
          </span>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            Bend radius
            <input
              type="range"
              min={4}
              max={1000}
              step={1}
              value={bendRadiusMm}
              onChange={(e) => setBendRadiusMm(Number(e.target.value))}
              style={{ width: 120 }}
            />
            <span style={{ fontWeight: 500, minWidth: 46 }}>{Math.round(bendRadiusMm)} mm</span>
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            Pipe gap
            <input
              type="range"
              min={0}
              max={600}
              step={1}
              value={gapSpreadMm}
              onChange={(e) => setGapSpreadMm(Number(e.target.value))}
              style={{ width: 120 }}
            />
            <span style={{ fontWeight: 500, minWidth: 46 }}>+{Math.round(gapSpreadMm)} mm</span>
          </label>
          <span style={{ width: 1, height: 22, background: '#e6e1d6', display: 'inline-block' }} />
          <button
            type="button"
            onClick={placingKit ? () => { setPlacingKit(false); setKitGhost(null); } : startPlaceKit}
            title="Place a copper branch kit — click, then drop a port onto an open pipe end"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              border: 'none',
              borderRadius: 7,
              padding: '5px 11px',
              fontSize: 13,
              cursor: 'pointer',
              background: placingKit ? '#0F766E' : '#f3ede3',
              color: placingKit ? '#fff' : '#46433c',
              fontWeight: 500,
            }}
          >
            <span style={{ width: 12, height: 8, borderRadius: 2, background: 'linear-gradient(#c9824c,#f4d0a6,#75401d)', display: 'inline-block' }} />
            Branch kit
          </button>
          <span style={{ display: 'inline-flex', border: '1px solid #d8d2c4', borderRadius: 7, overflow: 'hidden' }}>
            {(['gas', 'liquid', 'both'] as const).map((m) => {
              const on = kitKind === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setKitKind(m)}
                  style={{
                    border: 'none',
                    padding: '5px 10px',
                    fontSize: 12.5,
                    cursor: 'pointer',
                    background: on ? '#B5742F' : '#fff',
                    color: on ? '#fff' : '#46433c',
                    fontWeight: on ? 600 : 400,
                  }}
                >
                  {m === 'gas' ? 'Gas' : m === 'liquid' ? 'Liquid' : 'Both'}
                </button>
              );
            })}
          </span>
        </div>
      ) : null}
      {placingKit ? (
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
      {extend || bundleDraw ? (
        <div
          style={{
            position: 'absolute',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            pointerEvents: 'none',
            background: bundleDraw ? '#7C3AED' : '#0F766E',
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
          {bundleDraw
            ? 'Extending bundle on the centerline — both lines stay centered, holding the gap'
            : 'Extending one line'}
          {' · click to add a point · Shift = straight · right-click / Enter / Esc to finish'}
        </div>
      ) : null}
      <svg
        width={width}
        height={height}
        style={{ display: 'block', touchAction: 'none', pointerEvents: 'none' }}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
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
          {pipes.map((p) => {
            const route = ghost && ghost.id === p.id ? ghost.route : p.route;
            const pairGap = Math.max(0, p.gapMm + gapSpreadMm);
            const insW = p.outerMm; // insulation outer diameter
            const coreW = Math.max(p.outerMm * 0.55, 3); // copper tube
            const sheenW = Math.max(coreW * 0.3, 1);
            const selected = selectedSet.has(p.id);
            // Offset each line perpendicular, THEN fillet with the bend-radius
            // slider value - so the gap only shifts position and never changes
            // the bend radius of either line. Gas reads blue, liquid copper/amber.
            const pathFor = (offMm: number) =>
              toSvgPathData(buildPipeCenterline(offsetPolyline(route, offMm), bendRadiusMm));
            let tubes: { d: string; ins: string; core: string; sheen: string }[];
            if (p.isPair) {
              tubes = [
                { d: pathFor(pairGap / 2), ...GAS_COLORS },
                { d: pathFor(-pairGap / 2), ...LIQUID_COLORS },
              ];
            } else {
              tubes = [
                {
                  d: pathFor((p.offsetSign * gapSpreadMm) / 2),
                  ...(p.lineKind === 'liquid' ? LIQUID_COLORS : GAS_COLORS),
                },
              ];
            }
            // Place the handles on the SAME offset as the visible body, so the
            // dots / + sit on the pipe even when the gap shifts it. Edits still
            // operate on the un-offset centerline (route).
            const handleOff = p.isPair ? 0 : (p.offsetSign * gapSpreadMm) / 2;
            const hRoute = handleOff === 0 ? route : offsetPolyline(route, handleOff);
            // The rendered (filleted) body the handles snap onto, so a vertex
            // handle sits on the rounded fitting as the bend radius changes.
            const bodyPoly = toPolyline(buildPipeCenterline(hRoute, bendRadiusMm), 1);
            return (
              <g key={p.id}>
                {/* insulation sleeves */}
                {tubes.map((t, i) => (
                  <path key={`ins-${i}`} d={t.d} fill="none" stroke={t.ins} strokeWidth={insW} strokeLinecap="round" strokeLinejoin="round" />
                ))}
                {/* tube cores */}
                {tubes.map((t, i) => (
                  <path key={`core-${i}`} d={t.d} fill="none" stroke={t.core} strokeWidth={coreW} strokeLinecap="round" strokeLinejoin="round" />
                ))}
                {/* sheen */}
                {tubes.map((t, i) => (
                  <path key={`sheen-${i}`} d={t.d} fill="none" stroke={t.sheen} strokeWidth={sheenW} strokeLinecap="round" strokeLinejoin="round" strokeOpacity={0.7} />
                ))}
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
                          onPointerDown={(e) => onVertexDown(e, p.id, vi, route)}
                          onContextMenu={(e) => onDelete(e, p.id, vi, route)}
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
                      const active = extend?.id === p.id && extend.end === end;
                      return (
                        <g
                          key={`ext-${end}`}
                          style={{ cursor: 'crosshair', pointerEvents: 'auto' }}
                          onPointerDown={(e) => startExtend(e, p.id, end)}
                        >
                          <line x1={e0.x} y1={e0.y} x2={hx} y2={hy} stroke="#0F766E" strokeWidth={hpx(1.4)} strokeDasharray={`${hpx(3)} ${hpx(2)}`} style={{ pointerEvents: 'none' }} />
                          <circle cx={hx} cy={hy} r={handleHit} fill="rgba(0,0,0,0.001)" />
                          <circle cx={hx} cy={hy} r={hpx(7)} fill={active ? '#0F766E' : '#fff'} stroke="#0F766E" strokeWidth={hpx(1.8)} style={{ pointerEvents: 'none' }} />
                          <path
                            d={`M ${hx - hpx(3)} ${hy} H ${hx + hpx(3)} M ${hx} ${hy - hpx(3)} V ${hy + hpx(3)}`}
                            stroke={active ? '#fff' : '#0F766E'}
                            strokeWidth={hpx(1.6)}
                            style={{ pointerEvents: 'none' }}
                          />
                        </g>
                      );
                    })
                  : null}
                {/* Live preview of the single line's next segment. */}
                {extend?.id === p.id && extend.cursor
                  ? (() => {
                      const aBody = extend.end === 'end' ? hRoute[hRoute.length - 1]! : hRoute[0]!;
                      const c = extend.cursor;
                      return (
                        <g style={{ pointerEvents: 'none' }}>
                          <line x1={aBody.x} y1={aBody.y} x2={c.x} y2={c.y} stroke="#0F766E" strokeWidth={hpx(2)} strokeDasharray={`${hpx(7)} ${hpx(4)}`} strokeLinecap="round" />
                          <circle cx={c.x} cy={c.y} r={hpx(4)} fill="#fff" stroke="#0F766E" strokeWidth={hpx(1.8)} />
                        </g>
                      );
                    })()
                  : null}
              </g>
            );
          })}
          {/* Common shared-center extend grip(s): shown when both lines of one
              bundle are selected and no draw is active. Positions track the
              VISIBLE bodies, so the grip stays centered when gapSpread > 0. */}
          {bundleSelection && !bundleDraw
            ? (() => {
                const la = pipes.find((p) => p.id === bundleSelection.aId);
                const lb = pipes.find((p) => p.id === bundleSelection.bId);
                const visEnd = (pipe: PipeView | undefined, end: 'start' | 'end', fallback: Point2D): Point2D => {
                  if (!pipe) return fallback;
                  const off = (pipe.offsetSign * gapSpreadMm) / 2;
                  const r = off === 0 ? pipe.route : offsetPolyline(pipe.route, off);
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
                          onPointerDown={(e) => startBundleDraw(e, en)}
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
          {/* Live bundle preview — gated on the active draw only, so it never
              blanks if the selection changes mid-draw. */}
          {bundleDraw && bundleDraw.cursor
            ? (() => {
                const a = pipes.find((p) => p.id === bundleDraw.aId);
                const b = pipes.find((p) => p.id === bundleDraw.bId);
                const anchor = bundleAnchor(bundleDraw);
                const c = bundleDraw.cursor;
                if (!a || !b || !anchor || Math.hypot(c.x - anchor.x, c.y - anchor.y) < 0.5) return null;
                const dir = unit(c.x - anchor.x, c.y - anchor.y);
                const nx = -dir.y;
                const ny = dir.x;
                const effSide = bundleDraw.aSide * (dir.x * bundleDraw.outX + dir.y * bundleDraw.outY >= 0 ? 1 : -1);
                const half = bundleDraw.gap / 2;
                const aPt = bundleDraw.aEnd === 'end' ? a.route[a.route.length - 1]! : a.route[0]!;
                const bPt = bundleDraw.bEnd === 'end' ? b.route[b.route.length - 1]! : b.route[0]!;
                const aNew = { x: c.x + nx * effSide * half, y: c.y + ny * effSide * half };
                const bNew = { x: c.x - nx * effSide * half, y: c.y - ny * effSide * half };
                return (
                  <g style={{ pointerEvents: 'none' }}>
                    <line x1={anchor.x} y1={anchor.y} x2={c.x} y2={c.y} stroke="#7C3AED" strokeWidth={hpx(1.4)} strokeDasharray={`${hpx(4)} ${hpx(3)}`} strokeOpacity={0.7} />
                    <line x1={aPt.x} y1={aPt.y} x2={aNew.x} y2={aNew.y} stroke="#0F766E" strokeWidth={hpx(2)} strokeDasharray={`${hpx(7)} ${hpx(4)}`} strokeLinecap="round" />
                    <line x1={bPt.x} y1={bPt.y} x2={bNew.x} y2={bNew.y} stroke="#0F766E" strokeWidth={hpx(2)} strokeDasharray={`${hpx(7)} ${hpx(4)}`} strokeLinecap="round" />
                    <line x1={aNew.x} y1={aNew.y} x2={bNew.x} y2={bNew.y} stroke="#7C3AED" strokeWidth={hpx(1)} strokeDasharray={`${hpx(2)} ${hpx(2)}`} strokeOpacity={0.6} />
                    <circle cx={aNew.x} cy={aNew.y} r={hpx(3.6)} fill="#fff" stroke="#0F766E" strokeWidth={hpx(1.7)} />
                    <circle cx={bNew.x} cy={bNew.y} r={hpx(3.6)} fill="#fff" stroke="#0F766E" strokeWidth={hpx(1.7)} />
                    <circle cx={c.x} cy={c.y} r={hpx(2.6)} fill="#7C3AED" />
                  </g>
                );
              })()
            : null}
          {/* Branch-kit port grips: the 3 bundle ports (inlet / run-outlet /
              branch-outlet) of a selected copper kit. Open = teal ring + outward
              arrow with gas (blue) + liquid (amber) points. Draw-from-port next. */}
          {branchKitPorts.map((kit) =>
            kit.ports.map((port) => {
              const c = port.point;
              const dl = Math.hypot(port.direction.x, port.direction.y) || 1;
              const dx = port.direction.x / dl;
              const dy = port.direction.y / dl;
              const tip = { x: c.x + dx * hpx(20), y: c.y + dy * hpx(20) };
              const label =
                port.terminalRole === 'inlet'
                  ? 'inlet'
                  : port.terminalRole === 'run-outlet'
                    ? 'run'
                    : 'branch';
              return (
                <g key={`bkp-${kit.id}-${port.terminalRole}`} style={{ pointerEvents: 'none' }}>
                  <line x1={port.gasPoint.x} y1={port.gasPoint.y} x2={port.liquidPoint.x} y2={port.liquidPoint.y} stroke="#0F766E" strokeWidth={hpx(1)} strokeOpacity={0.55} strokeDasharray={`${hpx(2)} ${hpx(2)}`} />
                  <circle cx={port.gasPoint.x} cy={port.gasPoint.y} r={hpx(3.2)} fill="#1F6FB2" />
                  <circle cx={port.liquidPoint.x} cy={port.liquidPoint.y} r={hpx(3.2)} fill="#B5742F" />
                  <line x1={c.x} y1={c.y} x2={tip.x} y2={tip.y} stroke="#0F766E" strokeWidth={hpx(2)} strokeLinecap="round" />
                  <circle cx={tip.x} cy={tip.y} r={hpx(2)} fill="#0F766E" />
                  <circle cx={c.x} cy={c.y} r={hpx(8)} fill="#fff" stroke="#0F766E" strokeWidth={hpx(2)} />
                  <path
                    d={`M ${c.x - hpx(3)} ${c.y} H ${c.x + hpx(3)} M ${c.x} ${c.y - hpx(3)} V ${c.y + hpx(3)}`}
                    stroke="#0F766E"
                    strokeWidth={hpx(1.6)}
                  />
                  <text
                    x={c.x - dx * hpx(15)}
                    y={c.y - dy * hpx(15) + hpx(3)}
                    fontSize={hpx(11)}
                    textAnchor="middle"
                    fill="#0F766E"
                    style={{ fontWeight: 500 }}
                  >
                    {label}
                  </text>
                </g>
              );
            }),
          )}
          {/* Every PLACED branch kit, drawn in the overlay (real-geometry sprite)
              like the pipes — a similarity transform lands the image's inlet/run
              anchors on the element's world ports, so it scales + rotates with the
              kit. Replaces the flat Fabric symbol (hidden while the overlay owns it). */}
          {placedKits.map((kit) => {
            const img = kitImg[kit.kind];
            if (!img?.ok) return null;
            const Wimg = 1000;
            const Himg = Wimg * (img.aspect || 0.3);
            const a0x = KIT_IMG_ANCHOR.inlet.x * Wimg;
            const a0y = KIT_IMG_ANCHOR.inlet.y * Himg;
            const a1x = KIT_IMG_ANCHOR.run.x * Wimg;
            const a1y = KIT_IMG_ANCHOR.run.y * Himg;
            const avx = a1x - a0x;
            const avy = a1y - a0y;
            const bvx = kit.run.x - kit.inlet.x;
            const bvy = kit.run.y - kit.inlet.y;
            const s = Math.hypot(bvx, bvy) / (Math.hypot(avx, avy) || 1);
            const theta = ((Math.atan2(bvy, bvx) - Math.atan2(avy, avx)) * 180) / Math.PI;
            return (
              <g
                key={`pk-${kit.id}`}
                style={{ pointerEvents: 'none' }}
                transform={`translate(${kit.inlet.x} ${kit.inlet.y}) rotate(${theta}) scale(${s}) translate(${-a0x} ${-a0y})`}
              >
                <image href={KIT_IMG[kit.kind]} x={0} y={0} width={Wimg} height={Himg} preserveAspectRatio="none" />
              </g>
            );
          })}
          {/* Copper branch-kit placement ghost, attached to the cursor, snapping
              a port onto an open pipe end (auto-rotated to meet it). */}
          {placingKit && kitGhost
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
                if (inlet && run && img?.ok) {
                  // Photo-real sprite: place the image so its inlet/run anchors
                  // land on the model ports (the kit frame handles rotation).
                  const span = KIT_IMG_ANCHOR.run.x - KIT_IMG_ANCHOR.inlet.x || 1;
                  const W = (run.x - inlet.x) / span;
                  const H = W * (img.aspect || 0.5);
                  const x0 = inlet.x - KIT_IMG_ANCHOR.inlet.x * W;
                  const y0 = inlet.y - KIT_IMG_ANCHOR.inlet.y * H;
                  parts.push(
                    <image key="kimg" href={KIT_IMG[kitKind]} x={x0} y={y0} width={W} height={H} preserveAspectRatio="none" />,
                  );
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
        </g>
        {/* While extending, a transparent capture layer turns canvas clicks into
            new pipe points (move = preview, click = place, right-click = finish).
            Dispatches to single-line or bundle-centerline draw. */}
        {extend || bundleDraw || placingKit ? (
          <rect
            x={0}
            y={0}
            width={width}
            height={height}
            fill="rgba(0,0,0,0)"
            style={{ pointerEvents: 'auto', cursor: 'crosshair' }}
            onPointerMove={placingKit ? onKitMove : extend ? onExtendMove : onBundleMove}
            onClick={placingKit ? onKitClick : extend ? onExtendClick : onBundleClick}
            onContextMenu={placingKit ? finishPlaceKit : finishExtend}
          />
        ) : null}
      </svg>
    </div>
  );
}
