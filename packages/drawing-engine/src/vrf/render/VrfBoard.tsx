'use client';

/**
 * The VRF board canvas. Konva stage with the mandated layer split; pipe + kit
 * layers are scaled by the single view transform so bodies are world-true, while
 * the grid stays screen-computed and glyphs divide by zoom to stay screen-constant.
 *
 * Gas / liquid live in separate visibility GROUPS inside each layer, so the
 * Gas/Liquid/Both toggle flips layer visibility without recomputing geometry.
 *
 * Pipe tool: rbush snapping (port → endpoint → parallel → grid) drives the draft
 * cursor; click drops a spine point on the snapped location, dbl-click / Enter
 * commits, Esc cancels. Branch-kit tool: a ghost kit snaps its inlet to a nearby
 * open run end; click places + connects. Select tool: drag a kit (endpoints follow),
 * empty drag pans, and hovering a run shows a "+" that splits + inserts a branch.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Group, Layer, Line, Stage } from 'react-konva';
import { produce } from 'immer';
import type Konva from 'konva';

import { Grid, niceStepMm } from './Grid';
import { CopperTube, PairedRunShape } from './PipeShape';
import { KitShape } from './KitShape';
import { useBoardStore } from '../model/store';
import { buildPairedGeometry } from '../geometry/offset';
import { clampBendRadius } from '../geometry/bend';
import { dist, nearestPointOnSpine } from '../geometry/path';
import { buildKitBodyGeometry, createRefnetKit, hitKit, snapKitToRunEnd } from '../geometry/kit';
import { connectRunEnd, insertBranchAt, moveKit, openRunEnds } from '../model/ops';
import { SnapIndex, type SnapResult } from '../snap';
import {
  identityView,
  panBy,
  pxToWorld,
  screenToWorld,
  visibleWorldBounds,
  zoomAt,
} from '../geometry/transform';
import type { BoardDoc, BranchKit, KitTransform, Point } from '../model/types';

let RUN_SEQ = 0;
let KIT_SEQ = 0;
let SPLIT_SEQ = 0;

interface KitPlacement {
  transform: KitTransform;
  snap: { runId: string; end: 'start' | 'end' } | null;
}

/** Snap a kit's inlet to the nearest open run end within tolerance, else free-place. */
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
  grab: Point;
  transform: KitTransform;
}
interface PlusAff {
  runId: string;
  segIndex: number;
  t: number;
  point: Point;
}

const SNAP_COLOR: Record<SnapResult['kind'], string> = {
  port: '#2f9e68',
  endpoint: '#0f766e',
  parallel: '#2563eb',
  grid: '#9ca3af',
};

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

  const showGas = lineFilter !== 'liquid';
  const showLiquid = lineFilter !== 'gas';

  const [draftSpine, setDraftSpine] = useState<Point[]>([]);
  const [draftCursor, setDraftCursor] = useState<Point | null>(null);
  const [snapRes, setSnapRes] = useState<SnapResult | null>(null);
  const [kitGhost, setKitGhost] = useState<KitPlacement | null>(null);
  const [plusAff, setPlusAff] = useState<PlusAff | null>(null);
  const [drag, setDragState] = useState<DragState | null>(null);

  const dragRef = useRef<DragState | null>(null);
  const setDrag = (d: DragState | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const didInteractRef = useRef(false); // a select drag/pan actually moved
  const snapIdxRef = useRef<SnapIndex | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Clear transient overlays when the tool changes.
  useEffect(() => {
    setSnapRes(null);
    setPlusAff(null);
    setKitGhost(null);
  }, [tool]);

  const ensureSnap = (): SnapIndex => {
    const st = useBoardStore.getState();
    const opts = { gapMm: st.pipeGapMm, gridMm: niceStepMm(st.view.zoom), tolerancePx: 9 };
    if (!snapIdxRef.current) snapIdxRef.current = new SnapIndex(st.doc, opts);
    else snapIdxRef.current.ensure(st.doc, opts);
    return snapIdxRef.current;
  };

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
        const bend = clampBendRadius(st.bendRadiusMm, st.activeSize, st.pipeGapMm).value;
        st.commit('Draw run', (doc) => {
          doc.runs[id] = { id, spine: clean, lineType: 'paired', size: st.activeSize, bendRadiusMm: bend };
          doc.selection = [id];
        });
      }
      return [];
    });
    setDraftCursor(null);
    setSnapRes(null);
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
        setSnapRes(null);
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

  const onMouseDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    const st = useBoardStore.getState();
    didInteractRef.current = false;
    if (st.tool !== 'select') return;
    const w = worldPointer(e);
    if (w) {
      const hit = Object.values(st.doc.kits).find((k) => hitKit(k, w));
      if (hit) {
        setDrag({ kitId: hit.id, grab: { x: w.x - hit.transform.pos.x, y: w.y - hit.transform.pos.y }, transform: hit.transform });
        st.setSelection([hit.id]);
        return;
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
          didInteractRef.current = true;
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
        if (dx || dy) didInteractRef.current = true;
        panRef.current = { x: p.x, y: p.y };
        setView(panBy(st.view, dx, dy));
        return;
      }
      const w = worldPointer(e);
      if (!w) return;
      if (st.tool === 'pipe') {
        const res = ensureSnap().query(w, st.view);
        setSnapRes(res);
        setDraftCursor(res ? res.point : w);
      } else if (st.tool === 'branch-kit') {
        setKitGhost(resolveKitPlacement(st.doc.runs, st.doc.connections, w, st.view.zoom));
      } else if (st.tool === 'select') {
        // "+" affordance: nearest point on any run spine within ~12px.
        const tol = pxToWorld(st.view, 12);
        let best: PlusAff | null = null;
        let bestD = tol;
        for (const run of Object.values(st.doc.runs)) {
          const np = nearestPointOnSpine(run.spine, w);
          if (np && np.distMm <= bestD) {
            bestD = np.distMm;
            best = { runId: run.id, segIndex: np.segIndex, t: np.t, point: np.point };
          }
        }
        setPlusAff(best);
      }
    },
    [setView],
  );

  const endInteraction = useCallback(() => {
    panRef.current = null;
    const d = dragRef.current;
    if (d) {
      if (didInteractRef.current) {
        useBoardStore.getState().commit('Move branch kit', (doc) => moveKit(doc, d.kitId, d.transform));
      }
      setDrag(null);
    }
  }, []);

  const onMouseLeave = useCallback(() => {
    endInteraction();
    setKitGhost(null);
    setPlusAff(null);
    setSnapRes(null);
  }, [endInteraction]);

  const onClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    const st = useBoardStore.getState();
    if (st.tool === 'select') {
      if (didInteractRef.current) return; // was a drag/pan, not a click
      if (plusAff) {
        const before = SPLIT_SEQ;
        let after = before;
        st.commit('Insert branch', (doc) => {
          after = insertBranchAt(doc, plusAff.runId, { segIndex: plusAff.segIndex, t: plusAff.t }, before, st.pipeGapMm);
          if (after !== before) doc.selection = [`run_${before + 2}`];
        });
        SPLIT_SEQ = after;
        setPlusAff(null);
      }
      return;
    }
    const w = worldPointer(e);
    if (!w) return;
    if (st.tool === 'pipe') {
      const res = ensureSnap().query(w, st.view);
      setDraftSpine((s) => [...s, res ? res.point : w]);
    } else if (st.tool === 'branch-kit') {
      const { transform, snap } = resolveKitPlacement(st.doc.runs, st.doc.connections, w, st.view.zoom);
      const id = `kit-${++KIT_SEQ}`;
      st.commit('Place branch kit', (doc) => {
        doc.kits[id] = createRefnetKit(id, transform, st.pipeGapMm);
        if (snap) connectRunEnd(doc, snap.runId, snap.end, id, 'in');
        doc.selection = [id];
      });
    }
  }, [plusAff]);

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

  const runGeoms = useMemo(
    () => Object.values(display.runs).map((run) => ({ run, geom: buildPairedGeometry(run.spine, pipeGapMm, run.bendRadiusMm) })),
    [display.runs, pipeGapMm],
  );

  // Kit body geometry computed ONCE per kit (shared by the gas + liquid passes).
  const kitGeoms = useMemo(
    () => Object.values(display.kits).map((kit) => ({ kit, body: buildKitBodyGeometry(kit) })),
    [display.kits],
  );

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

  // Guide line endpoints (world) for a parallel snap.
  const guideLine = (() => {
    if (!snapRes || snapRes.kind !== 'parallel' || !snapRes.guideDir) return null;
    const b = visibleWorldBounds(view, size.width, size.height);
    const span = Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
    const d = snapRes.guideDir;
    const p = snapRes.point;
    return [p.x - d.x * span, p.y - d.y * span, p.x + d.x * span, p.y + d.y * span];
  })();

  const kitShapeCommon = (kit: BranchKit) => ({
    gasWidthMm: activeSize.gasOuterMm,
    liquidWidthMm: activeSize.liquidOuterMm,
    zoom: view.zoom,
    portState: (pid: string) => (connectedPorts.get(kit.id)?.has(pid) ? ('valid' as const) : ('idle' as const)),
  });

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', cursor }}>
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

          {/* Pipes — gas / liquid split into visibility groups. */}
          <Layer name="staticPipes" {...layerProps}>
            <Group visible={showGas}>
              {runGeoms.map(({ run, geom }) => (
                <CopperTube key={run.id} path={geom.gas} widthMm={run.size.gasOuterMm} />
              ))}
            </Group>
            <Group visible={showLiquid}>
              {runGeoms.map(({ run, geom }) => (
                <CopperTube key={run.id} path={geom.liquid} widthMm={run.size.liquidOuterMm} />
              ))}
            </Group>
          </Layer>

          {/* Kits — gas / liquid split into visibility groups. */}
          <Layer name="kits" {...layerProps}>
            <Group visible={showGas}>
              {kitGeoms.map(({ kit, body }) => (
                <KitShape key={kit.id} kit={kit} body={body} only="gas" {...kitShapeCommon(kit)} />
              ))}
            </Group>
            <Group visible={showLiquid}>
              {kitGeoms.map(({ kit, body }) => (
                <KitShape key={kit.id} kit={kit} body={body} only="liquid" {...kitShapeCommon(kit)} />
              ))}
            </Group>
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
                gasWidthMm={activeSize.gasOuterMm}
                liquidWidthMm={activeSize.liquidOuterMm}
                filter={lineFilter}
                zoom={view.zoom}
                ghost
                portState={(pid) => (kitGhost?.snap && (pid === 'in-gas' || pid === 'in-liquid') ? 'valid' : 'idle')}
              />
            ) : null}

            {/* Snap feedback: guide line + marker. */}
            {guideLine ? (
              <Line points={guideLine} stroke={SNAP_COLOR.parallel} strokeWidth={1 / view.zoom} dash={[6 / view.zoom, 5 / view.zoom]} opacity={0.7} listening={false} />
            ) : null}
            {snapRes && snapRes.kind !== 'grid' ? (
              <Circle
                x={snapRes.point.x}
                y={snapRes.point.y}
                radius={5 / view.zoom}
                stroke={SNAP_COLOR[snapRes.kind]}
                strokeWidth={2 / view.zoom}
                fill="#ffffff"
                listening={false}
              />
            ) : null}

            {/* "+" split affordance. */}
            {plusAff ? (
              <Group listening={false}>
                <Circle x={plusAff.point.x} y={plusAff.point.y} radius={8 / view.zoom} fill="#ffffff" stroke="#0f766e" strokeWidth={1.6 / view.zoom} />
                <Line points={[plusAff.point.x - 4.5 / view.zoom, plusAff.point.y, plusAff.point.x + 4.5 / view.zoom, plusAff.point.y]} stroke="#0f766e" strokeWidth={1.6 / view.zoom} />
                <Line points={[plusAff.point.x, plusAff.point.y - 4.5 / view.zoom, plusAff.point.x, plusAff.point.y + 4.5 / view.zoom]} stroke="#0f766e" strokeWidth={1.6 / view.zoom} />
              </Group>
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
        {snapRes ? <span style={{ color: SNAP_COLOR[snapRes.kind], fontWeight: 600 }}>⊹ {snapRes.kind}</span> : null}
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
