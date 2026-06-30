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

import { buildPipeCenterline, toPolyline, toSvgPathData } from './pipeCenterline';
import { DEFAULT_REFRIGERANT_PIPE_GAP_MM } from './refrigerantPipeDimensions';

const DEFAULT_OUTER_DIAMETER_MM = 28;
const GAS_COLORS = { ins: '#D2E2F1', core: '#1F6FB2', sheen: '#7FB2E0' };
const LIQUID_COLORS = { ins: '#F1E4CD', core: '#B5742F', sheen: '#E3A968' };

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
 * Places the partner line's new point a fixed perpendicular `gap` to one `side`
 * (+/-1) of the grabbed line's NEW segment (anchor -> np), using that segment's
 * own left normal. Because `gap` and `side` are frozen once when extension
 * begins (see captureBundleFrame), the spacing stays constant along the leg and
 * through corners, and the partner can never cross through the grabbed line as
 * the cursor swings around the anchor.
 */
function bundleOffsetPoint(anchor: Point2D, np: Point2D, side: number, gap: number): Point2D {
  const dir = unit(np.x - anchor.x, np.y - anchor.y);
  const nx = -dir.y;
  const ny = dir.x;
  return { x: np.x + nx * side * gap, y: np.y + ny * side * gap };
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
  // Active pipe extension: which pipe end is being continued + the live cursor,
  // plus the bundle frame (partner + perpendicular gap + side) frozen at start.
  const [extend, setExtend] = useState<{
    id: string;
    end: 'start' | 'end';
    cursor: Point2D | null;
    partnerId: string | null;
    partnerEnd: 'start' | 'end';
    gap: number;
    side: number;
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
  // Default behaviour when extending a bundled line: 'pair' grows both gas+liquid
  // together; 'single' grows only the grabbed line. Alt momentarily forces single.
  const [extendMode, setExtendMode] = useState<'pair' | 'single'>('pair');
  const [altDown, setAltDown] = useState(false);
  const orthoRef = useRef(false);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Ignore keys routed to a focused form control (e.g. the toolbar sliders),
      // so Enter/Escape there can't silently abort an in-progress draw.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Shift') orthoRef.current = true;
      if (e.key === 'Alt') setAltDown(true);
      if (e.key === 'Escape' || e.key === 'Enter') {
        setExtend(null);
        setBundleDraw(null);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Shift') orthoRef.current = false;
      if (e.key === 'Alt') setAltDown(false);
    };
    const blur = () => {
      orthoRef.current = false;
      setAltDown(false);
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
      // along the run). Mirrors captureBundleFrame for the single-line path.
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

  // Resolve a single line's bundle partner: prefer the explicit bundleId link
  // (authoritative), else the nearest opposite-kind line by midpoint. Returns
  // the partner plus which of its ends is the matching open end near `anchor`.
  const resolveBundlePartner = useCallback(
    (pipe: PipeView, anchor: Point2D): { partner: PipeView; end: 'start' | 'end' } | null => {
      if (pipe.isPair) return null;
      let partner: PipeView | null = null;
      if (pipe.bundleId) {
        partner =
          pipes.find(
            (q) => q.id !== pipe.id && q.bundleId === pipe.bundleId && q.lineKind !== pipe.lineKind,
          ) ??
          pipes.find((q) => q.id !== pipe.id && q.bundleId === pipe.bundleId) ??
          null;
      }
      if (!partner) {
        const pMid = routeMid(pipe.route);
        let bestD = 600;
        for (const q of pipes) {
          if (q.id === pipe.id || q.isPair) continue;
          if (pipe.lineKind && q.lineKind && pipe.lineKind === q.lineKind) continue;
          const qMid = routeMid(q.route);
          const d = Math.hypot(qMid.x - pMid.x, qMid.y - pMid.y);
          if (d < bestD) {
            bestD = d;
            partner = q;
          }
        }
      }
      if (!partner || partner.route.length < 1) return null;
      const first = partner.route[0]!;
      const last = partner.route[partner.route.length - 1]!;
      const dFirst = Math.hypot(first.x - anchor.x, first.y - anchor.y);
      const dLast = Math.hypot(last.x - anchor.x, last.y - anchor.y);
      return { partner, end: dFirst <= dLast ? 'start' : 'end' };
    },
    [pipes],
  );

  // Freeze the bundle spacing + side at the moment extension begins, so the
  // partner is offset by a CONSTANT perpendicular gap on a STABLE side for the
  // whole session — measured against the run's heading at the open end (not the
  // raw end-to-end distance, which inflates when the two ends are staggered).
  const captureBundleFrame = useCallback(
    (
      pipe: PipeView,
      end: 'start' | 'end',
    ): { partnerId: string; partnerEnd: 'start' | 'end'; gap: number; side: number } | null => {
      const route = pipe.route;
      const anchor = end === 'end' ? route[route.length - 1]! : route[0]!;
      const prev = end === 'end' ? route[route.length - 2] : route[1];
      const travel = prev ? unit(anchor.x - prev.x, anchor.y - prev.y) : { x: 1, y: 0, n: 1 };
      const bundle = resolveBundlePartner(pipe, anchor);
      if (!bundle) return null;
      const pr = bundle.partner.route;
      const b = bundle.end === 'end' ? pr[pr.length - 1]! : pr[0]!;
      const gapVec = { x: b.x - anchor.x, y: b.y - anchor.y };
      // Signed perpendicular distance of the partner end across the run heading.
      const perp = gapVec.x * -travel.y + gapVec.y * travel.x;
      let gap = Math.abs(perp);
      if (gap < 1) gap = Math.hypot(gapVec.x, gapVec.y) || Math.max(pipe.gapMm + pipe.outerMm, 12);
      const side = perp > 0.01 ? 1 : perp < -0.01 ? -1 : pipe.lineKind === 'liquid' ? -1 : 1;
      return { partnerId: bundle.partner.id, partnerEnd: bundle.end, gap, side };
    },
    [resolveBundlePartner],
  );

  const startExtend = useCallback(
    (e: ReactPointerEvent, id: string, end: 'start' | 'end') => {
      e.stopPropagation();
      setBundleDraw(null);
      const pipe = pipes.find((p) => p.id === id);
      const frame = pipe ? captureBundleFrame(pipe, end) : null;
      setExtend({
        id,
        end,
        cursor: null,
        partnerId: frame?.partnerId ?? null,
        partnerEnd: frame?.partnerEnd ?? 'end',
        gap: frame?.gap ?? 0,
        side: frame?.side ?? 1,
      });
    },
    [pipes, captureBundleFrame],
  );

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
      const appendAt = (route: Point2D[], end: 'start' | 'end', pt: Point2D) =>
        end === 'end' ? [...route, pt] : [pt, ...route];
      const grabbedNext = appendAt(pipe.route, extend.end, np);
      // 'Both' mode (default) advances the bundle partner in lockstep, holding
      // the frozen gap; 'Single' mode (or Alt held) grows just the grabbed line.
      const forceSingle = extendMode === 'single' || e.altKey;
      const partner =
        !forceSingle && extend.partnerId
          ? pipes.find((p) => p.id === extend.partnerId) ?? null
          : null;
      if (partner) {
        const nq = bundleOffsetPoint(anchor, np, extend.side, extend.gap);
        const partnerNext = appendAt(partner.route, extend.partnerEnd, nq);
        commitPair(pipe.id, grabbedNext, partner.id, partnerNext, 'Extend refrigerant pipe pair');
      } else {
        commitRoute(extend.id, grabbedNext, 'Extend refrigerant pipe');
      }
    },
    [extend, pipes, toWorld, extendConstrain, extendMode, commitPair, commitRoute],
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
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            Extend
            <span
              style={{
                display: 'inline-flex',
                border: '1px solid #d8d2c4',
                borderRadius: 7,
                overflow: 'hidden',
              }}
            >
              {(['pair', 'single'] as const).map((m) => {
                const active = (altDown ? 'single' : extendMode) === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setExtendMode(m)}
                    title={m === 'pair' ? 'Extend both bundle lines together' : 'Extend only this line (or hold Alt)'}
                    style={{
                      border: 'none',
                      padding: '4px 11px',
                      fontSize: 12.5,
                      cursor: 'pointer',
                      background: active ? '#0F766E' : '#fff',
                      color: active ? '#fff' : '#46433c',
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {m === 'pair' ? 'Both' : 'Single'}
                  </button>
                );
              })}
            </span>
          </span>
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
            : extendMode === 'single' || altDown || !extend?.partnerId
              ? 'Extending one line'
              : 'Extending pipe — both bundle lines follow, holding the gap'}
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
                {/* Live preview of the segment(s) being added — both bundle
                    lines when the pipe is paired. */}
                {extend?.id === p.id && extend.cursor
                  ? (() => {
                      const aBody = extend.end === 'end' ? hRoute[hRoute.length - 1]! : hRoute[0]!;
                      const aRoute = extend.end === 'end' ? p.route[p.route.length - 1]! : p.route[0]!;
                      const c = extend.cursor;
                      const singleMode = extendMode === 'single' || altDown;
                      let partnerSeg: { b: Point2D; q: Point2D } | null = null;
                      if (!singleMode && extend.partnerId && Math.hypot(c.x - aRoute.x, c.y - aRoute.y) > 0.5) {
                        const partner = pipes.find((q) => q.id === extend.partnerId);
                        if (partner && partner.route.length >= 1) {
                          const b =
                            extend.partnerEnd === 'end'
                              ? partner.route[partner.route.length - 1]!
                              : partner.route[0]!;
                          partnerSeg = { b, q: bundleOffsetPoint(aRoute, c, extend.side, extend.gap) };
                        }
                      }
                      return (
                        <g style={{ pointerEvents: 'none' }}>
                          <line x1={aBody.x} y1={aBody.y} x2={c.x} y2={c.y} stroke="#0F766E" strokeWidth={hpx(2)} strokeDasharray={`${hpx(7)} ${hpx(4)}`} strokeLinecap="round" />
                          <circle cx={c.x} cy={c.y} r={hpx(4)} fill="#fff" stroke="#0F766E" strokeWidth={hpx(1.8)} />
                          {partnerSeg ? (
                            <>
                              <line x1={partnerSeg.b.x} y1={partnerSeg.b.y} x2={partnerSeg.q.x} y2={partnerSeg.q.y} stroke="#0F766E" strokeWidth={hpx(1.6)} strokeDasharray={`${hpx(5)} ${hpx(4)}`} strokeLinecap="round" strokeOpacity={0.75} />
                              <circle cx={partnerSeg.q.x} cy={partnerSeg.q.y} r={hpx(3.2)} fill="#fff" stroke="#0F766E" strokeWidth={hpx(1.5)} strokeOpacity={0.85} />
                              <line x1={c.x} y1={c.y} x2={partnerSeg.q.x} y2={partnerSeg.q.y} stroke="#0F766E" strokeWidth={hpx(1)} strokeDasharray={`${hpx(2)} ${hpx(2)}`} strokeOpacity={0.5} />
                            </>
                          ) : null}
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
        </g>
        {/* While extending, a transparent capture layer turns canvas clicks into
            new pipe points (move = preview, click = place, right-click = finish).
            Dispatches to single-line or bundle-centerline draw. */}
        {extend || bundleDraw ? (
          <rect
            x={0}
            y={0}
            width={width}
            height={height}
            fill="rgba(0,0,0,0)"
            style={{ pointerEvents: 'auto', cursor: 'crosshair' }}
            onPointerMove={extend ? onExtendMove : onBundleMove}
            onClick={extend ? onExtendClick : onBundleClick}
            onContextMenu={finishExtend}
          />
        ) : null}
      </svg>
    </div>
  );
}
