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

import { buildPipePair } from './pipePairGeometry';
import { DEFAULT_REFRIGERANT_PIPE_GAP_MM } from './refrigerantPipeDimensions';

const DEFAULT_OUTER_DIAMETER_MM = 28;

interface PipeStudioOverlayProps {
  enabled: boolean;
  width: number;
  height: number;
  viewportZoom: number;
  panOffset: Point2D;
  hvacElements: HvacElement[];
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
  gapMm: number;
  outerMm: number;
  bendMm: number;
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

function toPipeView(el: HvacElement): PipeView | null {
  if (el.type !== 'refrigerant-pipe' && el.type !== 'refrigerant-pipe-pair') return null;
  const props = (el.properties ?? {}) as Record<string, unknown>;
  const route = readRoute(props.routePoints);
  if (route.length < 2) return null;
  const outerMm = readNumber(props.outerDiameterMm, DEFAULT_OUTER_DIAMETER_MM);
  return {
    id: el.id,
    route,
    isPair: el.type === 'refrigerant-pipe-pair',
    gapMm: readNumber(props.pipeGapMm, DEFAULT_REFRIGERANT_PIPE_GAP_MM),
    outerMm,
    bendMm: Math.max(outerMm * 1.5, 36),
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
  updateHvacElement,
  saveToHistory,
}: PipeStudioOverlayProps): JSX.Element | null {
  const gRef = useRef<SVGGElement | null>(null);
  const dragRef = useRef<{ id: string; vi: number } | null>(null);
  const [ghost, setGhost] = useState<{ id: string; route: Point2D[] } | null>(null);

  const view = viewportToViewTransform(viewportZoom, panOffset);
  const k = MM_TO_PX * view.zoom;
  const matrix = `matrix(${k} 0 0 ${k} ${view.panPx.x} ${view.panPx.y})`;
  const hpx = (n: number) => n / Math.max(k, 1e-6); // screen px -> g-space (mm) units

  const pipes = useMemo(() => {
    const list: PipeView[] = [];
    for (const el of hvacElements) {
      const v = toPipeView(el);
      if (v) list.push(v);
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
    <div className="absolute left-0 top-0 z-[8]" style={{ width, height }}>
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
            const pair = buildPipePair(route, { bendRadiusMm: p.bendMm, gapMm: p.isPair ? p.gapMm : 0 });
            const insW = p.outerMm;
            const coreW = Math.max(p.outerMm * 0.42, 4);
            return (
              <g key={p.id}>
                {p.isPair ? (
                  <>
                    <path d={pair.gasPath} fill="none" stroke="#B5D4F4" strokeWidth={insW} strokeLinecap="round" strokeLinejoin="round" />
                    <path d={pair.liquidPath} fill="none" stroke="#FAC775" strokeWidth={insW * 0.9} strokeLinecap="round" strokeLinejoin="round" />
                    <path d={pair.gasPath} fill="none" stroke="#185FA5" strokeWidth={coreW} strokeLinecap="round" strokeLinejoin="round" />
                    <path d={pair.liquidPath} fill="none" stroke="#BA7517" strokeWidth={coreW * 0.9} strokeLinecap="round" strokeLinejoin="round" />
                    <path d={pair.centerlinePath} fill="none" stroke="#888780" strokeWidth={hpx(1)} strokeDasharray={`${hpx(2)} ${hpx(5)}`} strokeOpacity={0.85} />
                  </>
                ) : (
                  <>
                    <path d={pair.centerlinePath} fill="none" stroke="#D3D1C7" strokeWidth={insW} strokeLinecap="round" strokeLinejoin="round" />
                    <path d={pair.centerlinePath} fill="none" stroke="#B45309" strokeWidth={coreW} strokeLinecap="round" strokeLinejoin="round" />
                  </>
                )}
                {route.slice(0, -1).map((_, si) => {
                  const m = { x: (route[si]!.x + route[si + 1]!.x) / 2, y: (route[si]!.y + route[si + 1]!.y) / 2 };
                  return (
                    <g key={`ins-${si}`} style={{ cursor: 'copy', pointerEvents: 'auto' }} onPointerDown={(e) => onInsert(e, p.id, si, route)}>
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
                })}
                {route.map((pt, vi) => {
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
                })}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
