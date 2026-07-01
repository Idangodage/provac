'use client';

/**
 * The VRF board canvas.
 *
 * Layer roles (each layer is its own canvas; Konva redraws a layer only when one of
 * its nodes changes):
 *   - Grid          — redraws on pan / zoom.
 *   - staticPipes   — committed run bodies (gas / liquid visibility groups). Static.
 *   - kits          — committed kit copper bodies, each CACHED (local geometry in a
 *                     transformed Group), so a kit drag re-blits instead of re-stroking.
 *   - activeGeometry— the pipe draft preview, snap marker/guide, ghost kit. Redraws
 *                     while drawing / placing.
 *   - overlays      — hover + selection highlights, the "+" split affordance, and kit
 *                     port glyphs. HOVER + SELECTION therefore redraw ONLY this layer.
 *
 * Pointer input is coalesced through requestAnimationFrame (one update per frame), and
 * geometry is rebuilt only for the objects a command actually changed (identity-keyed
 * caches), which keeps a drag within the frame budget.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Group, Layer, Line, Stage } from 'react-konva';
import { produce } from 'immer';
import type Konva from 'konva';

import { Grid, niceStepMm } from './Grid';
import { CopperTube, PairedRunShape } from './PipeShape';
import { KitBody, KitPorts } from './KitShape';
import { makeKitBodyCache, makeRunGeometryCache } from './geometryCache';
import { useBoardStore } from '../model/store';
import { buildPairedGeometry } from '../geometry/offset';
import { clampBendRadius } from '../geometry/bend';
import { dist, nearestPointOnSpine, samplePath, simplifyRDP } from '../geometry/path';
import { createRefnetKit, hitKit, kitGapMm, snapKitToRunEnd } from '../geometry/kit';
import { connectRunEnd, insertBranchAt, moveKit, openRunEnds, syncKitConnections } from '../model/ops';
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
const ACCENT = '#0f766e';

const polylineLength = (pts: Point[]): number => {
  let s = 0;
  for (let i = 1; i < pts.length; i += 1) s += dist(pts[i - 1]!, pts[i]!);
  return s;
};

/** A live freehand pen stroke (Pipe tool press-drag). */
interface Stroke {
  points: Point[];
  start: Point;
  moved: boolean;
}

export function VrfBoard(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const view = useBoardStore((s) => s.view);
  const tool = useBoardStore((s) => s.tool);
  const runs = useBoardStore((s) => s.doc.runs);
  const kits = useBoardStore((s) => s.doc.kits);
  const connections = useBoardStore((s) => s.doc.connections);
  const selection = useBoardStore((s) => s.doc.selection);
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
  const [freehand, setFreehand] = useState<Point[] | null>(null);
  const strokeRef = useRef<Stroke | null>(null);
  const [snapRes, setSnapRes] = useState<SnapResult | null>(null);
  const [kitGhost, setKitGhost] = useState<KitPlacement | null>(null);
  const [plusAff, setPlusAff] = useState<PlusAff | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [drag, setDragState] = useState<DragState | null>(null);
  const [frameMs, setFrameMs] = useState(0);

  const dragRef = useRef<DragState | null>(null);
  const setDrag = (d: DragState | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const didInteractRef = useRef(false);
  const snapIdxRef = useRef<SnapIndex | null>(null);

  // rAF pointer coalescing + drag frame-compute meter.
  const rafRef = useRef(0);
  const pendingRef = useRef<Point | null>(null);
  const computeRef = useRef(0); // ms spent rebuilding geometry this render
  const meterAtRef = useRef(0);

  // Identity-keyed geometry caches (survive across renders).
  const runCacheRef = useRef(makeRunGeometryCache());
  const kitBodyCacheRef = useRef(makeKitBodyCache());

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setSnapRes(null);
    setPlusAff(null);
    setKitGhost(null);
    setHoverId(null);
    strokeRef.current = null;
    setFreehand(null);
  }, [tool]);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  const ensureSnap = (): SnapIndex => {
    const st = useBoardStore.getState();
    const opts = { gapMm: st.pipeGapMm, gridMm: niceStepMm(st.view.zoom), tolerancePx: 9 };
    if (!snapIdxRef.current) snapIdxRef.current = new SnapIndex(st.doc, opts);
    else snapIdxRef.current.ensure(st.doc, opts);
    return snapIdxRef.current;
  };

  const commitRun = useCallback((spine: Point[]) => {
    const clean: Point[] = [];
    for (const p of spine) {
      const last = clean[clean.length - 1];
      if (!last || dist(last, p) > 1e-4) clean.push({ x: p.x, y: p.y });
    }
    if (clean.length < 2) return;
    const st = useBoardStore.getState();
    const id = `run-${++RUN_SEQ}`;
    const bend = clampBendRadius(st.bendRadiusMm, st.activeSize, st.pipeGapMm).value;
    st.commit('Draw run', (doc) => {
      doc.runs[id] = { id, spine: clean, lineType: 'paired', size: st.activeSize, bendRadiusMm: bend };
      doc.selection = [id];
    });
  }, []);

  const finishDraft = useCallback(() => {
    setDraftSpine((spine) => {
      commitRun(spine);
      return [];
    });
    setDraftCursor(null);
    setSnapRes(null);
  }, [commitRun]);

  const nudge = useCallback((dx: number, dy: number) => {
    const st = useBoardStore.getState();
    const sel = new Set(st.doc.selection);
    if (sel.size === 0) return;
    st.commit('Nudge', (doc) => {
      // Move runs first, then kits — a kit re-pins its connected endpoints last, so a
      // kit + its run nudged together stay joined.
      for (const id of sel) {
        const run = doc.runs[id];
        if (run) for (const p of run.spine) { p.x += dx; p.y += dy; }
      }
      for (const id of sel) {
        const kit = doc.kits[id];
        if (kit) moveKit(doc, id, { ...kit.transform, pos: { x: kit.transform.pos.x + dx, y: kit.transform.pos.y + dy } });
      }
      // A connected run nudged WITHOUT its kit would drag its pinned endpoint off the
      // port. Re-pin every kit that a moved run connects to (kits in the selection were
      // already synced by moveKit; this heals the rest) so no joint goes stale.
      const affected = new Set<string>();
      for (const c of doc.connections) if (sel.has(c.pipeId)) affected.add(c.kitId);
      for (const kitId of affected) syncKitConnections(doc, kitId);
    });
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
        strokeRef.current = null;
        setFreehand(null);
      } else if (e.key.startsWith('Arrow')) {
        if (useBoardStore.getState().doc.selection.length === 0) return;
        e.preventDefault();
        const step = e.shiftKey ? 50 : e.altKey ? 1 : 10;
        const d = e.key === 'ArrowLeft' ? [-step, 0] : e.key === 'ArrowRight' ? [step, 0] : e.key === 'ArrowUp' ? [0, -step] : [0, step];
        nudge(d[0]!, d[1]!);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, finishDraft, nudge]);

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
    const p = e.target.getStage()?.getPointerPosition();
    const w = p ? screenToWorld(st.view, p) : null;
    if (st.tool === 'pipe') {
      if (!w) return;
      // Begin a pen stroke. A press-drag traces the pointer (freehand); a plain click
      // (no drag) drops a straight polyline vertex on release. Snap the start point.
      const start = ensureSnap().query(w, st.view)?.point ?? w;
      strokeRef.current = { points: [start], start, moved: false };
      setFreehand([start]);
      setSnapRes(null);
      return;
    }
    if (st.tool !== 'select') return;
    if (w) {
      const hit = Object.values(st.doc.kits).find((k) => hitKit(k, w));
      if (hit) {
        setDrag({ kitId: hit.id, grab: { x: w.x - hit.transform.pos.x, y: w.y - hit.transform.pos.y }, transform: hit.transform });
        st.setSelection([hit.id]);
        return;
      }
    }
    if (p) panRef.current = { x: p.x, y: p.y };
  }, []);

  // The actual per-frame processing (coalesced pointer).
  const processMove = useCallback(() => {
    rafRef.current = 0;
    const p = pendingRef.current;
    if (!p) return;
    const st = useBoardStore.getState();
    const w = screenToWorld(st.view, p);
    if (dragRef.current && st.tool === 'select') {
      didInteractRef.current = true;
      const d = dragRef.current;
      setDrag({ ...d, transform: { ...d.transform, pos: { x: w.x - d.grab.x, y: w.y - d.grab.y } } });
      return;
    }
    if (panRef.current && st.tool === 'select') {
      const dx = p.x - panRef.current.x;
      const dy = p.y - panRef.current.y;
      if (dx || dy) didInteractRef.current = true;
      panRef.current = { x: p.x, y: p.y };
      setView(panBy(st.view, dx, dy));
      return;
    }
    if (st.tool === 'pipe') {
      const stroke = strokeRef.current;
      if (stroke) {
        // Freehand: accumulate the pointer path (min-distance filtered to stay clean).
        const last = stroke.points[stroke.points.length - 1]!;
        if (dist(last, w) >= pxToWorld(st.view, 3)) {
          stroke.points.push(w);
          if (!stroke.moved && dist(stroke.start, w) > pxToWorld(st.view, 4)) stroke.moved = true;
          setFreehand(stroke.points.slice());
        }
        setSnapRes(null);
      } else {
        const res = ensureSnap().query(w, st.view);
        setSnapRes(res);
        setDraftCursor(res ? res.point : w);
      }
    } else if (st.tool === 'branch-kit') {
      setKitGhost(resolveKitPlacement(st.doc.runs, st.doc.connections, w, st.view.zoom));
    } else if (st.tool === 'select') {
      const hit = Object.values(st.doc.kits).find((k) => hitKit(k, w));
      if (hit) {
        setHoverId(hit.id);
        setPlusAff(null);
      } else {
        setHoverId(null);
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
    }
  }, [setView]);

  const onMouseMove = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      const p = e.target.getStage()?.getPointerPosition();
      if (!p) return;
      pendingRef.current = { x: p.x, y: p.y };
      if (!rafRef.current) rafRef.current = requestAnimationFrame(processMove);
    },
    [processMove],
  );

  const endInteraction = useCallback(() => {
    panRef.current = null;
    const stroke = strokeRef.current;
    if (stroke) {
      strokeRef.current = null;
      setFreehand(null);
      const st = useBoardStore.getState();
      if (st.tool === 'pipe') {
        if (stroke.moved) {
          // Freehand run: snap the end, simplify the trail, commit (the fillet rounds it).
          const raw = stroke.points;
          const endSnap = ensureSnap().query(raw[raw.length - 1]!, st.view)?.point;
          const pts = endSnap ? [...raw.slice(0, -1), endSnap] : raw.slice();
          const simplified = simplifyRDP(pts, pxToWorld(st.view, 3.5));
          if (simplified.length >= 2 && polylineLength(simplified) > pxToWorld(st.view, 6)) {
            commitRun(simplified);
          }
        } else {
          // A plain click: add a straight polyline vertex (dbl-click / Enter commits).
          setDraftSpine((s) => [...s, stroke.start]);
        }
      }
      return;
    }
    const d = dragRef.current;
    if (d) {
      if (didInteractRef.current) {
        useBoardStore.getState().commit('Move branch kit', (doc) => moveKit(doc, d.kitId, d.transform));
      }
      setDrag(null);
    }
  }, [commitRun]);

  const onMouseLeave = useCallback(() => {
    endInteraction();
    setKitGhost(null);
    setPlusAff(null);
    setSnapRes(null);
    setHoverId(null);
  }, [endInteraction]);

  const onClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    const st = useBoardStore.getState();
    if (st.tool === 'select') {
      if (didInteractRef.current) return;
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
    const p = e.target.getStage()?.getPointerPosition();
    const w = p ? screenToWorld(st.view, p) : null;
    if (!w) return;
    // Pipe vertices are added on mouse-up (press = vertex, press-drag = freehand), so
    // the click event only drives branch-kit placement here.
    if (st.tool === 'branch-kit') {
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

  // Freehand stroke follows the pointer trail; otherwise the click-polyline rubber band.
  const previewSpine = freehand
    ? freehand.length >= 2
      ? simplifyRDP(freehand, pxToWorld(view, 2))
      : freehand
    : draftCursor
      ? [...draftSpine, draftCursor]
      : draftSpine;
  const previewGeom = previewSpine.length >= 2 ? buildPairedGeometry(previewSpine, pipeGapMm, bendRadiusMm) : null;

  // Transient kit-drag doc (endpoints follow) without committing.
  const display = useMemo(() => {
    if (!drag) return { runs, kits };
    const t0 = performance.now();
    const next = produce({ runs, kits, connections, selection: [] } as BoardDoc, (d) => {
      moveKit(d, drag.kitId, drag.transform);
    });
    computeRef.current = performance.now() - t0;
    return { runs: next.runs, kits: next.kits };
  }, [drag, runs, kits, connections]);

  // Identity-keyed geometry: only objects a command changed are rebuilt.
  const runGeoms = useMemo(() => {
    const t0 = performance.now();
    const cache = runCacheRef.current;
    const list = Object.values(display.runs).map((run) => ({ run, geom: cache.get(run, pipeGapMm) }));
    cache.prune(new Set(Object.keys(display.runs)));
    computeRef.current += performance.now() - t0;
    return list;
  }, [display.runs, pipeGapMm]);

  // Surface the per-frame geometry-rebuild cost while dragging (throttled). This is
  // the JS work slice the ≤8ms budget targets; Konva's paint is separate (DevTools).
  useEffect(() => {
    if (!dragRef.current) return;
    const now = performance.now();
    if (now - meterAtRef.current > 200) {
      meterAtRef.current = now;
      setFrameMs(computeRef.current);
    }
  });

  const kitBodyCache = kitBodyCacheRef.current;
  const kitList = useMemo(() => Object.values(display.kits), [display.kits]);

  const connectedPorts = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const c of connections) {
      if (!m.has(c.kitId)) m.set(c.kitId, new Set());
      m.get(c.kitId)!.add(c.portId);
    }
    return m;
  }, [connections]);

  const selectionSet = useMemo(() => new Set(selection), [selection]);
  const ghostKit: BranchKit | null = kitGhost ? createRefnetKit('ghost', kitGhost.transform, pipeGapMm) : null;

  const layerProps = { scaleX: view.zoom, scaleY: view.zoom, x: view.panX, y: view.panY, listening: false };

  const cursor =
    tool === 'pipe' || tool === 'branch-kit'
      ? 'crosshair'
      : drag
        ? 'grabbing'
        : hoverId
          ? 'move'
          : plusAff
            ? 'copy'
            : 'grab';

  const guideLine = (() => {
    if (!snapRes || snapRes.kind !== 'parallel' || !snapRes.guideDir) return null;
    const b = visibleWorldBounds(view, size.width, size.height);
    const span = Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
    const d = snapRes.guideDir;
    const pt = snapRes.point;
    return [pt.x - d.x * span, pt.y - d.y * span, pt.x + d.x * span, pt.y + d.y * span];
  })();

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

          <Layer name="kits" {...layerProps}>
            <Group visible={showGas}>
              {kitList.map((kit) => (
                <KitBody key={kit.id} kit={kit} body={kitBodyCache.get(kitGapMm(kit))} only="gas" gasWidthMm={activeSize.gasOuterMm} liquidWidthMm={activeSize.liquidOuterMm} zoom={view.zoom} />
              ))}
            </Group>
            <Group visible={showLiquid}>
              {kitList.map((kit) => (
                <KitBody key={kit.id} kit={kit} body={kitBodyCache.get(kitGapMm(kit))} only="liquid" gasWidthMm={activeSize.gasOuterMm} liquidWidthMm={activeSize.liquidOuterMm} zoom={view.zoom} />
              ))}
            </Group>
          </Layer>

          <Layer name="activeGeometry" {...layerProps}>
            {previewGeom ? (
              <PairedRunShape geometry={previewGeom} gasWidthMm={activeSize.gasOuterMm} liquidWidthMm={activeSize.liquidOuterMm} filter={lineFilter} preview />
            ) : null}
            {draftSpine.map((p, i) => (
              <Circle key={i} x={p.x} y={p.y} radius={3.5 / view.zoom} fill={ACCENT} stroke="#fff" strokeWidth={1.2 / view.zoom} listening={false} />
            ))}
            {ghostKit ? (
              <>
                <KitBody kit={ghostKit} body={kitBodyCache.get(pipeGapMm)} gasWidthMm={activeSize.gasOuterMm} liquidWidthMm={activeSize.liquidOuterMm} zoom={view.zoom} cache={false} opacity={0.85} />
                <KitPorts kit={ghostKit} zoom={view.zoom} filter={lineFilter} portState={(pid) => (kitGhost?.snap && (pid === 'in-gas' || pid === 'in-liquid') ? 'valid' : 'idle')} />
              </>
            ) : null}
            {guideLine ? (
              <Line points={guideLine} stroke={SNAP_COLOR.parallel} strokeWidth={1 / view.zoom} dash={[6 / view.zoom, 5 / view.zoom]} opacity={0.7} listening={false} />
            ) : null}
            {snapRes && snapRes.kind !== 'grid' ? (
              <Circle x={snapRes.point.x} y={snapRes.point.y} radius={5 / view.zoom} stroke={SNAP_COLOR[snapRes.kind]} strokeWidth={2 / view.zoom} fill="#fff" listening={false} />
            ) : null}
          </Layer>

          {/* Hover + selection + ports — the ONLY layer hover/selection redraws. */}
          <Layer name="overlays" {...layerProps}>
            {runGeoms.map(({ run, geom }) =>
              selectionSet.has(run.id) ? (
                <Line
                  key={`sel-${run.id}`}
                  points={samplePath(geom.center, 2).flatMap((p) => [p.x, p.y])}
                  stroke={ACCENT}
                  strokeWidth={2.5 / view.zoom}
                  opacity={0.65}
                  dash={[8 / view.zoom, 6 / view.zoom]}
                  lineCap="round"
                  listening={false}
                />
              ) : null,
            )}
            {kitList.map((kit) => {
              const sel = selectionSet.has(kit.id);
              const hov = hoverId === kit.id;
              return (
                <Fragment key={`k-${kit.id}`}>
                  {sel || hov ? (
                    <Circle x={kit.transform.pos.x} y={kit.transform.pos.y} radius={130} stroke={ACCENT} strokeWidth={(sel ? 2 : 1.2) / view.zoom} opacity={sel ? 0.75 : 0.4} dash={[7 / view.zoom, 6 / view.zoom]} listening={false} />
                  ) : null}
                  <KitPorts kit={kit} zoom={view.zoom} filter={lineFilter} portState={(pid) => (connectedPorts.get(kit.id)?.has(pid) ? 'valid' : 'idle')} />
                </Fragment>
              );
            })}
            {plusAff ? (
              <Group listening={false}>
                <Circle x={plusAff.point.x} y={plusAff.point.y} radius={8 / view.zoom} fill="#fff" stroke={ACCENT} strokeWidth={1.6 / view.zoom} />
                <Line points={[plusAff.point.x - 4.5 / view.zoom, plusAff.point.y, plusAff.point.x + 4.5 / view.zoom, plusAff.point.y]} stroke={ACCENT} strokeWidth={1.6 / view.zoom} />
                <Line points={[plusAff.point.x, plusAff.point.y - 4.5 / view.zoom, plusAff.point.x, plusAff.point.y + 4.5 / view.zoom]} stroke={ACCENT} strokeWidth={1.6 / view.zoom} />
              </Group>
            ) : null}
          </Layer>
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
        {frameMs > 0 ? (
          <span
            title="Per-frame geometry rebuild during a drag (budget ≤ 8 ms). Konva paint is measured separately in DevTools."
            style={{ color: frameMs <= 8 ? '#2f9e68' : '#b45309', fontVariantNumeric: 'tabular-nums' }}
          >
            {frameMs.toFixed(2)} ms geom
          </span>
        ) : null}
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
