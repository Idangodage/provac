'use client';

/**
 * The VRF board canvas. Konva stage with the mandated layer split; the pipe
 * layers (staticPipes / activeGeometry) are scaled by the single view transform
 * so pipe bodies are world-true, while the grid + overlays stay screen-computed.
 *
 * Pipe tool: click to drop spine points (live paired preview follows the cursor),
 * double-click / Enter to commit as one undoable run, Esc to cancel. Pan is the
 * Select tool; wheel zoom is always cursor-anchored.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Circle, Layer, Stage } from 'react-konva';
import type Konva from 'konva';

import { Grid } from './Grid';
import { PairedRunShape, RunShape } from './PipeShape';
import { useBoardStore } from '../model/store';
import { buildPairedGeometry } from '../geometry/offset';
import { dist } from '../geometry/path';
import { identityView, panBy, screenToWorld, zoomAt } from '../geometry/transform';
import type { Point } from '../model/types';

let RUN_SEQ = 0;

export function VrfBoard(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const view = useBoardStore((s) => s.view);
  const tool = useBoardStore((s) => s.tool);
  const runs = useBoardStore((s) => s.doc.runs);
  const lineFilter = useBoardStore((s) => s.lineFilter);
  const pipeGapMm = useBoardStore((s) => s.pipeGapMm);
  const bendRadiusMm = useBoardStore((s) => s.bendRadiusMm);
  const activeSize = useBoardStore((s) => s.activeSize);
  const setView = useBoardStore((s) => s.setView);
  const undo = useBoardStore((s) => s.undo);
  const redo = useBoardStore((s) => s.redo);

  const [draftSpine, setDraftSpine] = useState<Point[]>([]);
  const [draftCursor, setDraftCursor] = useState<Point | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const finishDraft = useCallback(() => {
    setDraftSpine((spine) => {
      const clean: Point[] = [];
      for (const p of spine) {
        const last = clean[clean.length - 1];
        if (!last || dist(last, p) > 1e-4) clean.push({ x: p.x, y: p.y });
      }
      if (clean.length >= 2) {
        const st = useBoardStore.getState();
        const id = `run-${++RUN_SEQ}`;
        st.commit('Draw run', (doc) => {
          doc.runs[id] = {
            id,
            spine: clean,
            lineType: 'paired',
            size: st.activeSize,
            bendRadiusMm: st.bendRadiusMm,
          };
          doc.selection = [id];
        });
      }
      return [];
    });
    setDraftCursor(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (meta && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (e.key === 'Enter') {
        finishDraft();
      } else if (e.key === 'Escape') {
        setDraftSpine([]);
        setDraftCursor(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, finishDraft]);

  const worldPointer = (e: Konva.KonvaEventObject<unknown>): Point | null => {
    const p = e.target.getStage()?.getPointerPosition();
    return p ? screenToWorld(useBoardStore.getState().view, p) : null;
  };

  const onWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      const p = e.target.getStage()?.getPointerPosition();
      if (!p) return;
      setView(zoomAt(useBoardStore.getState().view, p, Math.exp(-e.evt.deltaY * 0.0015)));
    },
    [setView],
  );

  const panRef = useRef<{ x: number; y: number } | null>(null);
  const onMouseDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (useBoardStore.getState().tool !== 'select') return;
    const p = e.target.getStage()?.getPointerPosition();
    if (p) panRef.current = { x: p.x, y: p.y };
  }, []);
  const onMouseMove = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      const st = useBoardStore.getState();
      if (panRef.current && st.tool === 'select') {
        const p = e.target.getStage()?.getPointerPosition();
        if (!p) return;
        const dx = p.x - panRef.current.x;
        const dy = p.y - panRef.current.y;
        panRef.current = { x: p.x, y: p.y };
        setView(panBy(st.view, dx, dy));
        return;
      }
      if (st.tool === 'pipe') {
        const w = worldPointer(e);
        if (w) setDraftCursor(w);
      }
    },
    [setView],
  );
  const endPan = useCallback(() => {
    panRef.current = null;
  }, []);

  const onClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (useBoardStore.getState().tool !== 'pipe') return;
    const w = worldPointer(e);
    if (w) setDraftSpine((s) => [...s, w]);
  }, []);
  const onDblClick = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      if (useBoardStore.getState().tool !== 'pipe') return;
      e.evt.preventDefault();
      finishDraft();
    },
    [finishDraft],
  );

  const previewSpine = draftCursor ? [...draftSpine, draftCursor] : draftSpine;
  const previewGeom = previewSpine.length >= 2 ? buildPairedGeometry(previewSpine, pipeGapMm, bendRadiusMm) : null;

  const layerProps = { scaleX: view.zoom, scaleY: view.zoom, x: view.panX, y: view.panY, listening: false };

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        cursor: tool === 'pipe' ? 'crosshair' : 'grab',
      }}
    >
      {size.width > 0 && size.height > 0 ? (
        <Stage
          width={size.width}
          height={size.height}
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endPan}
          onMouseLeave={endPan}
          onClick={onClick}
          onDblClick={onDblClick}
        >
          <Grid view={view} width={size.width} height={size.height} />

          <Layer name="staticPipes" {...layerProps}>
            {Object.values(runs).map((run) => (
              <RunShape key={run.id} run={run} gapMm={pipeGapMm} filter={lineFilter} />
            ))}
          </Layer>

          <Layer name="activeGeometry" {...layerProps}>
            {previewGeom ? (
              <PairedRunShape
                geometry={previewGeom}
                gasWidthMm={activeSize.gasOuterMm}
                liquidWidthMm={activeSize.liquidOuterMm}
                filter={lineFilter}
                preview
              />
            ) : null}
            {draftSpine.map((p, i) => (
              <Circle key={i} x={p.x} y={p.y} radius={3.5 / view.zoom} fill="#0f766e" stroke="#fff" strokeWidth={1.2 / view.zoom} listening={false} />
            ))}
          </Layer>

          <Layer name="overlays" />
        </Stage>
      ) : null}

      <div
        style={{
          position: 'absolute',
          right: 10,
          bottom: 10,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          background: 'rgba(255,255,255,0.9)',
          border: '1px solid #e2e1dc',
          borderRadius: 8,
          padding: '5px 9px',
          fontSize: 12,
          color: '#57564f',
        }}
      >
        <span>{Math.round(view.zoom * 100)}%</span>
        <button
          type="button"
          onClick={() => setView(identityView())}
          style={{ border: '1px solid #d8d7d2', borderRadius: 6, background: '#fff', padding: '2px 8px', cursor: 'pointer' }}
        >
          Reset view
        </button>
      </div>
    </div>
  );
}
