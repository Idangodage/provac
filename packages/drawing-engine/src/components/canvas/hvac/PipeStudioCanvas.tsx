'use client';

/**
 * PipeStudioCanvas — the modern VRF pipe editor, as a real React component.
 *
 * This is the approved SVG prototype, productionised against the tested geometry
 * modules in this package:
 *   - {@link ./pipePairGeometry#buildPipePair} for the concentric gas/liquid
 *     pair with true arc elbow fittings (one centerline -> two pipes),
 *   - {@link ./pipeInteractionCore#moveVertex} for path editing.
 *
 * Self-contained (own state, native SVG, pointer events), so it renders
 * identically wherever it is mounted and does not depend on the Fabric canvas,
 * the store, or any existing pipe feature. Wire `onRoutesChange` to persist into
 * `hvacElements` when integrating into the editor.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type { Point2D } from '../../../types';

import { moveVertex } from './pipeInteractionCore';
import { buildPipePair } from './pipePairGeometry';

type Mode = 'draw' | 'edit';

const SAMPLE_ROUTE: Point2D[] = [
  { x: 80, y: 330 },
  { x: 80, y: 120 },
  { x: 260, y: 120 },
  { x: 360, y: 220 },
  { x: 560, y: 220 },
  { x: 560, y: 330 },
];

const GRID = 20;

export interface PipeStudioCanvasProps {
  width?: number;
  height?: number;
  initialRoutes?: Point2D[][];
  /** Emitted whenever the set of pipe routes changes (draw/edit/delete). */
  onRoutesChange?: (routes: Point2D[][]) => void;
}

export function PipeStudioCanvas({
  width = 668,
  height = 408,
  initialRoutes,
  onRoutesChange,
}: PipeStudioCanvasProps): JSX.Element {
  const [pipes, setPipes] = useState<Point2D[][]>(initialRoutes ?? []);
  const [current, setCurrent] = useState<Point2D[]>([]);
  const [cursor, setCursor] = useState<Point2D | null>(null);
  const [mode, setMode] = useState<Mode>('draw');
  const [bendRadius, setBendRadius] = useState(54);
  const [gap, setGap] = useState(24);

  const orthoRef = useRef(false);
  const dragRef = useRef<{ pi: number; vi: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const commitPipes = useCallback(
    (next: Point2D[][]) => {
      setPipes(next);
      onRoutesChange?.(next);
    },
    [onRoutesChange],
  );

  const toSvg = useCallback((clientX: number, clientY: number): Point2D => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }, []);

  const constrain = useCallback(
    (q: Point2D, anchor: Point2D | null): Point2D => {
      let out = q;
      if (orthoRef.current && anchor) {
        const dx = out.x - anchor.x;
        const dy = out.y - anchor.y;
        const step = Math.PI / 4;
        const snapped = Math.round(Math.atan2(dy, dx) / step) * step;
        const d = Math.hypot(dx, dy);
        out = { x: anchor.x + Math.cos(snapped) * d, y: anchor.y + Math.sin(snapped) * d };
      }
      out = { x: Math.round(out.x / GRID) * GRID, y: Math.round(out.y / GRID) * GRID };
      return {
        x: Math.max(8, Math.min(width - 8, out.x)),
        y: Math.max(8, Math.min(height - 8, out.y)),
      };
    },
    [width, height],
  );

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Shift') orthoRef.current = true;
      if (e.key === 'Escape') {
        setCurrent([]);
        setCursor(null);
      }
      if (e.key === 'Enter') {
        setCurrent((cur) => {
          if (cur.length >= 2) commitPipes([...pipes, cur]);
          return [];
        });
        setCursor(null);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Shift') orthoRef.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [pipes, commitPipes]);

  const finishDraw = useCallback(() => {
    if (current.length >= 2) {
      commitPipes([...pipes, current]);
      setCurrent([]);
      setCursor(null);
    }
  }, [current, pipes, commitPipes]);

  const switchMode = useCallback(
    (next: Mode) => {
      if (next === 'edit' && current.length >= 2) {
        commitPipes([...pipes, current]);
        setCurrent([]);
      }
      setCursor(null);
      setMode(next);
    },
    [current, pipes, commitPipes],
  );

  const onSvgPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      if (mode !== 'draw') return;
      const anchor = current.length ? current[current.length - 1]! : null;
      setCurrent([...current, constrain(toSvg(e.clientX, e.clientY), anchor)]);
    },
    [mode, current, constrain, toSvg],
  );

  const onSvgPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      if (dragRef.current) {
        const { pi, vi } = dragRef.current;
        const route = pipes[pi];
        if (!route) return;
        const next = pipes.map((r, i) => (i === pi ? moveVertex(r, vi, constrain(toSvg(e.clientX, e.clientY), null)) : r));
        commitPipes(next);
        return;
      }
      if (mode === 'draw' && current.length) {
        setCursor(constrain(toSvg(e.clientX, e.clientY), current[current.length - 1]!));
      }
    },
    [pipes, mode, current, constrain, toSvg, commitPipes],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  const startVertexDrag = useCallback((e: ReactPointerEvent, pi: number, vi: number) => {
    e.stopPropagation();
    dragRef.current = { pi, vi };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, []);

  const insertVertexAt = useCallback(
    (e: ReactPointerEvent, pi: number, si: number) => {
      e.stopPropagation();
      const route = pipes[pi];
      if (!route) return;
      const mid = constrain(
        { x: (route[si]!.x + route[si + 1]!.x) / 2, y: (route[si]!.y + route[si + 1]!.y) / 2 },
        null,
      );
      const next = pipes.map((r, i) => (i === pi ? [...r.slice(0, si + 1), mid, ...r.slice(si + 1)] : r));
      commitPipes(next);
    },
    [pipes, constrain, commitPipes],
  );

  const deleteVertexAt = useCallback(
    (e: ReactMouseEvent, pi: number, vi: number) => {
      e.preventDefault();
      e.stopPropagation();
      const route = pipes[pi];
      if (!route || route.length <= 2) return;
      const next = pipes.map((r, i) => (i === pi ? r.filter((_, j) => j !== vi) : r));
      commitPipes(next);
    },
    [pipes, commitPipes],
  );

  const renderPair = (route: Point2D[], key: string) => {
    if (route.length < 2) return null;
    const pair = buildPipePair(route, { bendRadiusMm: bendRadius, gapMm: gap });
    const a = route[0]!;
    const b = route[route.length - 1]!;
    return (
      <g key={key}>
        <path d={pair.gasPath} fill="none" stroke="#B5D4F4" strokeWidth={15} strokeLinecap="round" strokeLinejoin="round" />
        <path d={pair.liquidPath} fill="none" stroke="#FAC775" strokeWidth={13} strokeLinecap="round" strokeLinejoin="round" />
        <path d={pair.gasPath} fill="none" stroke="#185FA5" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
        <path d={pair.liquidPath} fill="none" stroke="#BA7517" strokeWidth={4.5} strokeLinecap="round" strokeLinejoin="round" />
        <path d={pair.centerlinePath} fill="none" stroke="#888780" strokeWidth={1} strokeDasharray="2 5" strokeOpacity={0.85} />
        <circle cx={a.x} cy={a.y} r={4.5} fill="#fff" stroke="#0F6E56" strokeWidth={1.5} />
        <circle cx={b.x} cy={b.y} r={4.5} fill="#fff" stroke="#0F6E56" strokeWidth={1.5} />
      </g>
    );
  };

  const previewRoute = mode === 'draw' && cursor ? [...current, cursor] : current;

  const segButton = (m: Mode, label: string) => (
    <button
      type="button"
      onClick={() => switchMode(m)}
      style={{
        border: 0,
        borderRadius: 0,
        background: mode === m ? 'var(--bg-accent, #E6F1FB)' : 'transparent',
        color: mode === m ? 'var(--text-accent, #185FA5)' : 'inherit',
        padding: '7px 14px',
        fontSize: 14,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ display: 'inline-flex', border: '1px solid var(--border-strong, #b4b2a9)', borderRadius: 8, overflow: 'hidden' }}>
          {segButton('draw', 'Draw')}
          {segButton('edit', 'Edit path')}
        </div>
        <button type="button" onClick={() => switchMode('edit')} onPointerUp={() => commitPipes([SAMPLE_ROUTE.map((p) => ({ ...p }))])} style={btn}>
          Sample route
        </button>
        <button type="button" onClick={() => { commitPipes([]); setCurrent([]); setCursor(null); }} style={btn}>
          Clear
        </button>
        <label style={lab}>Bend radius</label>
        <input type="range" min={24} max={110} step={1} value={bendRadius} onChange={(e) => setBendRadius(Number(e.target.value))} style={{ flex: 1, minWidth: 120 }} />
        <span style={{ fontSize: 13, fontWeight: 500, minWidth: 46 }}>{Math.round(bendRadius)} mm</span>
        <label style={lab}>Pipe gap</label>
        <input type="range" min={12} max={40} step={1} value={gap} onChange={(e) => setGap(Number(e.target.value))} style={{ flex: 1, minWidth: 120 }} />
        <span style={{ fontSize: 13, fontWeight: 500, minWidth: 46 }}>{Math.round(gap)} mm</span>
      </div>

      <div style={{ background: 'var(--surface-2, #fff)', border: '1px solid var(--border, #d3d1c7)', borderRadius: 12, padding: 6 }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          style={{ display: 'block', touchAction: 'none', borderRadius: 8, background: 'var(--surface-1, #f7f6f2)' }}
          onPointerDown={onSvgPointerDown}
          onPointerMove={onSvgPointerMove}
          onPointerUp={endDrag}
          onDoubleClick={finishDraw}
        >
          <defs>
            <pattern id="ps-grid" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
              <path d={`M ${GRID} 0 L 0 0 0 ${GRID}`} fill="none" stroke="#888780" strokeOpacity={0.16} strokeWidth={1} />
            </pattern>
          </defs>
          <rect x={0} y={0} width={width} height={height} fill="url(#ps-grid)" />

          {pipes.map((route, i) => renderPair(route, `pipe-${i}`))}
          {previewRoute.length >= 2 ? renderPair(previewRoute, 'preview') : null}
          {mode === 'draw'
            ? current.map((p, i) => <circle key={`c-${i}`} cx={p.x} cy={p.y} r={4} fill="#185FA5" stroke="#fff" strokeWidth={1.5} />)
            : null}
          {mode === 'draw' && cursor ? <circle cx={cursor.x} cy={cursor.y} r={5} fill="rgba(24,95,165,0.18)" stroke="#185FA5" strokeWidth={1.5} /> : null}

          {mode === 'edit'
            ? pipes.map((route, pi) => (
                <g key={`h-${pi}`}>
                  {route.slice(0, -1).map((_, si) => {
                    const m = { x: (route[si]!.x + route[si + 1]!.x) / 2, y: (route[si]!.y + route[si + 1]!.y) / 2 };
                    return (
                      <g key={`ins-${si}`} style={{ cursor: 'copy' }} onPointerDown={(e) => insertVertexAt(e, pi, si)}>
                        <circle cx={m.x} cy={m.y} r={9} fill="rgba(0,0,0,0.001)" />
                        <circle cx={m.x} cy={m.y} r={5} fill="#fff" stroke="#639922" strokeWidth={1.5} style={{ pointerEvents: 'none' }} />
                        <path d={`M ${m.x - 2.4} ${m.y} H ${m.x + 2.4} M ${m.x} ${m.y - 2.4} V ${m.y + 2.4}`} stroke="#3B6D11" strokeWidth={1.4} style={{ pointerEvents: 'none' }} />
                      </g>
                    );
                  })}
                  {route.map((pt, vi) => {
                    const ep = vi === 0 || vi === route.length - 1;
                    return (
                      <g
                        key={`v-${vi}`}
                        style={{ cursor: 'grab' }}
                        onPointerDown={(e) => startVertexDrag(e, pi, vi)}
                        onContextMenu={(e) => deleteVertexAt(e, pi, vi)}
                      >
                        <circle cx={pt.x} cy={pt.y} r={11} fill="rgba(0,0,0,0.001)" />
                        <circle cx={pt.x} cy={pt.y} r={6.5} fill="#fff" stroke={ep ? '#0F6E56' : '#185FA5'} strokeWidth={2} style={{ pointerEvents: 'none' }} />
                        <circle cx={pt.x} cy={pt.y} r={2.6} fill={ep ? '#0F6E56' : '#185FA5'} style={{ pointerEvents: 'none' }} />
                      </g>
                    );
                  })}
                </g>
              ))
            : null}
        </svg>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10, fontSize: 13, color: 'var(--text-secondary, #5f5e5a)' }}>
        <span><span style={{ display: 'inline-block', width: 14, height: 6, borderRadius: 3, background: '#185FA5' }} /> gas line</span>
        <span><span style={{ display: 'inline-block', width: 14, height: 6, borderRadius: 3, background: '#BA7517' }} /> liquid line</span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted, #888780)' }}>
          {mode === 'draw' ? 'click to add points · double-click to finish · hold Shift for 45°' : 'drag a vertex · click + to insert · right-click to delete'}
        </span>
      </div>
    </div>
  );
}

const btn: CSSProperties = {
  border: '1px solid var(--border-strong, #b4b2a9)',
  borderRadius: 8,
  background: 'transparent',
  padding: '7px 12px',
  fontSize: 14,
  cursor: 'pointer',
};
const lab: CSSProperties = { fontSize: 13, color: 'var(--text-secondary, #5f5e5a)', minWidth: 74 };
