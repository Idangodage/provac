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
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import type { HvacElement, Point2D } from '../../../types';
import { viewportToViewTransform } from '../coordinateTransform';
import { MM_TO_PX } from '../scale';

import { buildPipeCenterline, toSvgPathData } from './pipeCenterline';
import { buildPipePair, offsetCenterline } from './pipePairGeometry';
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

function firstDir(route: Point2D[]): Point2D {
  if (route.length < 2) return { x: 1, y: 0 };
  const dx = route[1]!.x - route[0]!.x;
  const dy = route[1]!.y - route[0]!.y;
  const n = Math.hypot(dx, dy) || 1;
  return { x: dx / n, y: dy / n };
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
  const dragRef = useRef<{ id: string; vi: number } | null>(null);
  const editedIdsRef = useRef<Set<string>>(new Set());
  const [ghost, setGhost] = useState<{ id: string; route: Point2D[] } | null>(null);
  const [bendRadiusMm, setBendRadiusMm] = useState(24);
  // Relative spread added to the existing gap (0 = pipes as drawn).
  const [gapSpreadMm, setGapSpreadMm] = useState(0);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

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
    const singles = list.filter((p) => !p.isPair);
    for (const p of singles) {
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
    }
    return list;
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

  const commitRoute = useCallback(
    (id: string, route: Point2D[], label: string) => {
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
      saveToHistory(label);
    },
    [elementById, updateHvacElement, saveToHistory],
  );

  const onVertexDown = useCallback((e: ReactPointerEvent, id: string, vi: number, route: Point2D[]) => {
    e.stopPropagation();
    dragRef.current = { id, vi };
    setGhost({ id, route: route.map((p) => ({ ...p })) });
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const w = toWorld(e.clientX, e.clientY);
      if (!w) return;
      setGhost((g) => (g && g.id === drag.id ? { id: g.id, route: g.route.map((p, i) => (i === drag.vi ? w : p)) } : g));
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
            const safeBend = Math.max(bendRadiusMm, pairGap / 2 + 4);
            const insW = p.outerMm; // insulation outer diameter
            const coreW = Math.max(p.outerMm * 0.55, 3); // copper tube
            const sheenW = Math.max(coreW * 0.3, 1);
            const selected = selectedSet.has(p.id);
            // Gas (suction) line reads blue; liquid line reads copper/amber.
            // A pair draws both lines from one centerline; a single gas/liquid
            // line is offset +/- gap/2 by its lineKind so the gap slider spaces a
            // coincident bundle (cosmetic; the editable route is unchanged).
            let tubes: { d: string; ins: string; core: string; sheen: string }[];
            if (p.isPair) {
              const pair = buildPipePair(route, { bendRadiusMm: safeBend, gapMm: pairGap });
              tubes = [
                { d: pair.gasPath, ...GAS_COLORS },
                { d: pair.liquidPath, ...LIQUID_COLORS },
              ];
            } else {
              const off = (p.offsetSign * gapSpreadMm) / 2;
              const cl = buildPipeCenterline(route, safeBend);
              const d = toSvgPathData(off === 0 ? cl : offsetCenterline(cl, off));
              tubes = [{ d, ...(p.lineKind === 'liquid' ? LIQUID_COLORS : GAS_COLORS) }];
            }
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
                  ? route.slice(0, -1).map((_, si) => {
                      const m = { x: (route[si]!.x + route[si + 1]!.x) / 2, y: (route[si]!.y + route[si + 1]!.y) / 2 };
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
                  ? route.map((pt, vi) => {
                      const ep = vi === 0 || vi === route.length - 1;
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
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
