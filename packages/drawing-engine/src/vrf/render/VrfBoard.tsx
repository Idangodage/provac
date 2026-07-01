'use client';

/**
 * The VRF board canvas. Konva stage with the mandated layer split
 * (staticPipes / activeGeometry / overlays) plus the grid. Phase 1 renders only
 * the grid + rulers; the pipe layers are wired but empty.
 *
 * The stage is kept at scale 1 / position 0 — every world→screen mapping goes
 * through the single {@link ViewTransform} in the store, so there is no second
 * source of truth for zoom/pan.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Layer, Stage } from 'react-konva';
import type Konva from 'konva';

import { Grid } from './Grid';
import { useBoardStore } from '../model/store';
import { identityView, panBy, zoomAt } from '../geometry/transform';

export function VrfBoard(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const view = useBoardStore((s) => s.view);
  const setView = useBoardStore((s) => s.setView);
  const undo = useBoardStore((s) => s.undo);
  const redo = useBoardStore((s) => s.redo);

  // Size the stage to the container.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Keyboard undo / redo.
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const onWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      const stage = e.target.getStage();
      const pointer = stage?.getPointerPosition();
      if (!pointer) return;
      const factor = Math.exp(-e.evt.deltaY * 0.0015);
      setView(zoomAt(useBoardStore.getState().view, pointer, factor));
    },
    [setView],
  );

  // Drag-to-pan on the empty canvas (Phase 1 has no draggable content yet).
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const onMouseDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = e.target.getStage();
    const p = stage?.getPointerPosition();
    if (p) panRef.current = { x: p.x, y: p.y };
  }, []);
  const onMouseMove = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      if (!panRef.current) return;
      const stage = e.target.getStage();
      const p = stage?.getPointerPosition();
      if (!p) return;
      const dx = p.x - panRef.current.x;
      const dy = p.y - panRef.current.y;
      panRef.current = { x: p.x, y: p.y };
      setView(panBy(useBoardStore.getState().view, dx, dy));
    },
    [setView],
  );
  const endPan = useCallback(() => {
    panRef.current = null;
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', cursor: 'grab' }}
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
        >
          <Grid view={view} width={size.width} height={size.height} />
          {/* Mandated layer split — empty in Phase 1. */}
          <Layer name="staticPipes" />
          <Layer name="activeGeometry" />
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
          boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
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
