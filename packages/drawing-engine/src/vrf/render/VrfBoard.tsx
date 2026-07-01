'use client';

/**
 * The VRF board canvas. Konva stage with the mandated layer split; the pipe + kit
 * layers are scaled by the single view transform so bodies are world-true, while the
 * grid stays screen-computed and glyphs divide by zoom to stay screen-constant.
 *
 * Pipe tool: click to drop spine points (live paired preview), dbl-click / Enter to
 * commit, Esc to cancel. Branch-kit tool: a ghost kit follows the cursor and snaps
 * its inlet onto a nearby run open end; click places it and connects (by port id).
 * Select tool: drag a kit to move it (connected endpoints follow); empty drag pans.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Layer, Stage } from 'react-konva';
import { produce } from 'immer';
import type Konva from 'konva';

import { Grid } from './Grid';
import { PairedRunShape, RunShape } from './PipeShape';
import { KitShape } from './KitShape';
import { useBoardStore } from '../model/store';
import { buildPairedGeometry } from '../geometry/offset';
import { dist } from '../geometry/path';
import {
  createRefnetKit,
  hitKit,
  kitGapMm,
  snapKitToRunEnd,
} from '../geometry/kit';
import { connectRunEnd, moveKit, openRunEnds } from '../model/ops';
import { identityView, panBy, screenToWorld, zoomAt } from '../geometry/transform';
import type { BoardDoc, BranchKit, KitTransform, Point } from '../model/types';

let RUN_SEQ = 0;
let KIT_SEQ = 0;

interface KitPlacement {
  transform: KitTransform;
  snap: { runId: string; end: 'start' | 'end' } | null;
}

/** Resolve where a kit would land for a given cursor: snap its inlet to the nearest
 *  open run end within tolerance, else free-place upright at the cursor. */
function resolveKitPlacement(
  runs: BoardDoc['runs'],
  connections: BoardDoc['connections'],
  cursor: Point,
  zoom: number,
): KitPlacement {
  const tol = 24 / zoom;
  let best: ReturnType<typeof openRunEnds>[number] | null = null;
  let bestD = tol;
  for (const oe of openRunEnds({ runs, kits: {}, connections, selection: [] })) {
    const d = Math.hypot(oe.pos.x - cursor.x, oe.pos.y - cursor.y);
    if (d <= bestD) {
      bestD = d;
      best = oe;
    }
  }
  if (best) return { transform: snapKitToRunEnd(best.pos, best.outward), snap: { runId: best.runId, end: best.end } };
  return { transform: { pos: cursor, rotation: 0, mirror: false }, snap: null };
}

interface DragState {
  kitId: string;
  grab: Point; // cursor − kit.pos at grab time
  transform: KitTransform;
}

export function VrfBoard(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const view = useBoardStore((s) => s.view);
  const tool = useBoardStore((s) => s.tool);
  const runs = useBoardStore((s) => s.doc.runs);
  const kits = useBoardStore((s) => s.doc.kits);
  const connections = useBoardStore((s) => s.doc.connections);
  const lineFilter = useBoardStore((s) => s.lineFilter);
  const pipeGapMm = useBoardStore((s) => s.pipeGapMm);
  const bendRadiusMm = useBoardStore((s) => s.bendRadiusMm);
  const activeSize = useBoardStore((s) => s.activeSize);
  const setView = useBoardStore((s) => s.setView);
  const undo = useBoardStore((s) => s.undo);
  const redo = useBoardStore((s) => s.redo);

  const [draftSpine, setDraftSpine] = useState<Point[]>([]);
  const [draftCursor, setDraftCursor] = useState<Point | null>(null);
  const [kitGhost, setKitGhost] = useState<KitPlacement | null>(null);
  const [drag, setDragState] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const setDrag = (d: DragState | null) => {
    dragRef.current = d;
    setDragState(d);
  };

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
        setKitGhost(null);
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
    const st = useBoardStore.getState();
    if (st.tool !== 'select') return;
    const w = worldPointer(e);
    if (w) {
      const hit = Object.values(st.doc.kits).find((k) => hitKit(k, w));
      if (hit) {
        setDrag({ kitId: hit.id, grab: { x: w.x - hit.transform.pos.x, y: w.y - hit.transform.pos.y }, transform: hit.transform });
        st.setSelection([hit.id]);
        return; // grabbing a kit, not panning
      }
    }
    const p = e.target.getStage()?.getPointerPosition();
    if (p) panRef.current = { x: p.x, y: p.y };
  }, []);

  const onMouseMove = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      const st = useBoardStore.getState();
      if (dragRef.current && st.tool === 'select') {
        const w = worldPointer(e);
        if (w) {
          const d = dragRef.current;
          setDrag({ ...d, transform: { ...d.transform, pos: { x: w.x - d.grab.x, y: w.y - d.grab.y } } });
        }
        return;
      }
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
      } else if (st.tool === 'branch-kit') {
        const w = worldPointer(e);
        if (w) setKitGhost(resolveKitPlacement(st.doc.runs, st.doc.connections, w, st.view.zoom));
      }
    },
    [setView],
  );

  const endInteraction = useCallback(() => {
    panRef.current = null;
    const d = dragRef.current;
    if (d) {
      useBoardStore.getState().commit('Move branch kit', (doc) => moveKit(doc, d.kitId, d.transform));
      setDrag(null);
    }
  }, []);

  const onMouseLeave = useCallback(() => {
    endInteraction();
    setKitGhost(null);
  }, [endInteraction]);

  const onClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    const st = useBoardStore.getState();
    const w = worldPointer(e);
    if (!w) return;
    if (st.tool === 'pipe') {
      setDraftSpine((s) => [...s, w]);
    } else if (st.tool === 'branch-kit') {
      const { transform, snap } = resolveKitPlacement(st.doc.runs, st.doc.connections, w, st.view.zoom);
      const id = `kit-${++KIT_SEQ}`;
      st.commit('Place branch kit', (doc) => {
        doc.kits[id] = createRefnetKit(id, transform, st.pipeGapMm);
        if (snap) connectRunEnd(doc, snap.runId, snap.end, id, 'in');
        doc.selection = [id];
      });
    }
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

  // While dragging a kit, show the transient move (endpoints follow) without committing.
  const display = useMemo(() => {
    if (!drag) return { runs, kits };
    const next = produce({ runs, kits, connections, selection: [] } as BoardDoc, (d) => {
      moveKit(d, drag.kitId, drag.transform);
    });
    return { runs: next.runs, kits: next.kits };
  }, [drag, runs, kits, connections]);

  const connectedPorts = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const c of connections) {
      if (!m.has(c.kitId)) m.set(c.kitId, new Set());
      m.get(c.kitId)!.add(c.portId);
    }
    return m;
  }, [connections]);

  const ghostKit: BranchKit | null = kitGhost ? createRefnetKit('ghost', kitGhost.transform, pipeGapMm) : null;

  const layerProps = { scaleX: view.zoom, scaleY: view.zoom, x: view.panX, y: view.panY, listening: false };
  const cursor = tool === 'pipe' || tool === 'branch-kit' ? 'crosshair' : drag ? 'grabbing' : 'grab';

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', cursor }}
    >
      {size.width > 0 && size.height > 0 ? (
        <Stage
          width={size.width}
          height={size.height}
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endInteraction}
          onMouseLeave={onMouseLeave}
          onClick={onClick}
          onDblClick={onDblClick}
        >
          <Grid view={view} width={size.width} height={size.height} />

          <Layer name="staticPipes" {...layerProps}>
            {Object.values(display.runs).map((run) => (
              <RunShape key={run.id} run={run} gapMm={pipeGapMm} filter={lineFilter} />
            ))}
          </Layer>

          <Layer name="kits" {...layerProps}>
            {Object.values(display.kits).map((kit) => {
              const bound = connectedPorts.get(kit.id);
              return (
                <KitShape
                  key={kit.id}
                  kit={kit}
                  gapMm={kitGapMm(kit)}
                  gasWidthMm={activeSize.gasOuterMm}
                  liquidWidthMm={activeSize.liquidOuterMm}
                  filter={lineFilter}
                  zoom={view.zoom}
                  portState={(pid) => (bound?.has(pid) ? 'valid' : 'idle')}
                />
              );
            })}
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
            {ghostKit ? (
              <KitShape
                kit={ghostKit}
                gapMm={pipeGapMm}
                gasWidthMm={activeSize.gasOuterMm}
                liquidWidthMm={activeSize.liquidOuterMm}
                filter={lineFilter}
                zoom={view.zoom}
                ghost
                portState={(pid) =>
                  kitGhost?.snap && (pid === 'in-gas' || pid === 'in-liquid') ? 'valid' : 'idle'
                }
              />
            ) : null}
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
