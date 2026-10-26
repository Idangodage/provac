'use client';

/**
 * The plan side of the drain tool (drainDrawSession). While the tool waits for
 * a start, the drain outlets of units that drain nowhere and the open drain ends
 * are ringed, and a click on one starts there. While drawing, it takes the
 * plan's clicks. The drain follows the pointer square to its last leg, as
 * drains are laid. It snaps to where it may finish: the other part's open end,
 * a drain (square off the last leg where it can), or a termination. There the
 * network shows as it would be, solved again, and a click finishes. Drawn in
 * the drawing's own frame.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { shallow } from 'zustand/shallow';

import type { HvacElement, Point2D } from '../../../../types';

import { drainDrawStarts, drainDrawTargets, nearestOnRoute, type DrainDrawStart, type DrainDrawTarget } from './condensateDrawRoute';
import { Tag, pathData } from './condensatePlanGlyphs';
import type { CondensateDesignSettings } from './condensateSettings';
import {
  addDrainDrawPoint,
  cancelDrainDraw,
  clearDrainDrawPreview,
  finishDrainDraw,
  previewDrainDraw,
  startDrainDrawFrom,
  stopDrainDraw,
  undoDrainDrawPoint,
  useDrainDrawStore,
} from './drainDrawSession';

/** How near a start or a finish the pointer snaps to it (screen px). */
const SNAP_PX = 16;
const COLOR = '#0d9488';
const OPEN_COLOR = '#d97706';

interface Cursor {
  point: Point2D;
  target: DrainDrawTarget | null;
  /** What a click there does. */
  label: string | null;
}

const sameStart = (a: DrainDrawStart, b: DrainDrawStart) => a.kind === b.kind
  && (a.kind === 'unit' ? a.unitId === (b as typeof a).unitId : a.gapId === (b as typeof a).gapId);

/** Where the segment a–b crosses the axis line through `from` (horizontal or vertical), if it does. */
function crossingOnAxis(a: Point2D, b: Point2D, from: Point2D, horizontal: boolean): Point2D | null {
  const [p, q, level] = horizontal ? [a.y, b.y, from.y] : [a.x, b.x, from.x];
  if ((p - level) * (q - level) > 0 || Math.abs(q - p) < 1e-9) return null;
  const t = (level - p) / (q - p);
  return horizontal ? { x: a.x + (b.x - a.x) * t, y: from.y } : { x: from.x, y: a.y + (b.y - a.y) * t };
}

export function DrainDrawLayer({ gRef, hpx, hvacElements, settings }: {
  gRef: RefObject<SVGGElement | null>;
  hpx: (n: number) => number;
  hvacElements: readonly HvacElement[];
  settings: CondensateDesignSettings;
}) {
  const { armed, session } = useDrainDrawStore((state) => ({ armed: state.armed, session: state.session }), shallow);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const previewedRef = useRef<string | null>(null);
  const starts = useMemo(() => (armed || session ? drainDrawStarts(hvacElements, settings) : []), [armed, session, hvacElements, settings]);
  const targets = useMemo(() => (session ? drainDrawTargets(hvacElements, session.start) : null), [session, hvacElements]);

  // Its start gone (its gap closed or gone, the unit drained: an undo, another way applied): drawing stops.
  useEffect(() => {
    if (!session || starts.some((start) => sameStart(start, session.start))) return;
    if (armed) useDrainDrawStore.setState({ session: null });
    else stopDrainDraw();
  }, [session, starts, armed]);
  useEffect(() => { if (!session) setCursor(null); }, [session]);

  const toWorld = useCallback((clientX: number, clientY: number): Point2D | null => {
    const ctm = gRef.current?.getScreenCTM();
    if (!ctm) return null;
    const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: point.x, y: point.y };
  }, [gRef]);

  /** The start a click there takes, when near one. */
  const startNear = useCallback((raw: Point2D): DrainDrawStart | null => {
    let best: { start: DrainDrawStart; gap: number } | null = null;
    for (const start of starts) {
      const at = start.kind === 'unit' ? start.outlet : start.point;
      const gap = Math.hypot(raw.x - at.x, raw.y - at.y);
      if (gap <= hpx(SNAP_PX) && (!best || gap < best.gap)) best = { start, gap };
    }
    return best?.start ?? null;
  }, [starts, hpx]);

  /** What the pointer means while drawing: a finish when near one, else a point square to the last leg. */
  const resolve = useCallback((raw: Point2D): Cursor | null => {
    if (!session) return null;
    const snap = hpx(SNAP_PX);
    const last = session.points[session.points.length - 1] ?? session.from;
    const horizontal = Math.abs(raw.x - last.x) >= Math.abs(raw.y - last.y);
    if (session.to) {
      if (Math.hypot(raw.x - session.to.x, raw.y - session.to.y) <= snap) return { point: session.to, target: { kind: 'partner' }, label: 'Join to the other part: click' };
    } else if (targets) {
      for (const gully of targets.gullies) {
        if (Math.hypot(raw.x - gully.point.x, raw.y - gully.point.y) <= snap * 1.5) {
          return { point: gully.point, target: { kind: 'gully', gullyId: gully.id }, label: `Into ${gully.label}${gully.networkId ? '' : ' (a new network)'}: click` };
        }
      }
      let best: { point: Point2D; gap: number; id: string; label: string; square: boolean } | null = null;
      for (const pipe of targets.pipes) {
        // Square off the last leg where the drain crosses it, else its nearest point.
        for (let index = 1; index < pipe.route.length; index += 1) {
          const square = crossingOnAxis(pipe.route[index - 1]!, pipe.route[index]!, last, horizontal);
          const gap = square ? Math.hypot(raw.x - square.x, raw.y - square.y) : Infinity;
          if (square && gap <= snap && (!best || !best.square || gap < best.gap)) best = { point: square, gap, id: pipe.id, label: pipe.label, square: true };
        }
        if (best?.square) continue;
        const near = nearestOnRoute(pipe.route, raw);
        if (near && near.distanceMm <= snap && (!best || near.distanceMm < best.gap)) best = { point: near.point, gap: near.distanceMm, id: pipe.id, label: pipe.label, square: false };
      }
      if (best) return { point: best.point, target: { kind: 'pipe', pipeId: best.id, point: best.point }, label: `Join ${best.label} with a wye: click` };
    }
    return { point: horizontal ? { x: raw.x, y: last.y } : { x: last.x, y: raw.y }, target: null, label: null };
  }, [session, targets, hpx]);

  // Resting on a finish: the network as it would be (solved once per set of points and finish).
  useEffect(() => {
    if (!session || !cursor?.target) {
      if (previewedRef.current) { clearDrainDrawPreview(); previewedRef.current = null; setMessage(null); }
      return;
    }
    const key = JSON.stringify([session.points, cursor.target]);
    if (previewedRef.current === key) return;
    previewedRef.current = key;
    const result = previewDrainDraw(cursor.target);
    setMessage(result && !result.ok ? result.message : null);
  }, [session, cursor]);

  useEffect(() => {
    if (!armed && !session) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancelDrainDraw(); }
      else if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); event.stopImmediatePropagation(); undoDrainDrawPoint(); }
      else if (event.key === 'Enter' && cursor?.target) { event.preventDefault(); event.stopImmediatePropagation(); finishDrainDraw(cursor.target); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [armed, session, cursor]);

  if (!armed && !session) return null;
  const onMove = (event: ReactPointerEvent) => {
    const world = toWorld(event.clientX, event.clientY);
    if (!world) { setCursor(null); return; }
    if (session) { setCursor(resolve(world)); return; }
    const start = startNear(world);
    setCursor({
      point: start ? (start.kind === 'unit' ? start.outlet : start.point) : world,
      target: null,
      label: start ? (start.kind === 'unit' ? `Start at ${start.label}'s drain outlet: click` : 'Start at this open end: click') : null,
    });
  };
  const onDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const world = toWorld(event.clientX, event.clientY);
    if (!world) return;
    if (!session) {
      const start = startNear(world);
      if (start) startDrainDrawFrom(start);
      return;
    }
    const at = resolve(world);
    if (!at) return;
    if (at.target) finishDrainDraw(at.target);
    else addDrainDrawPoint(at.point);
  };

  const capture = (
    <rect x={-1e7} y={-1e7} width={2e7} height={2e7} fill="transparent" style={{ pointerEvents: 'all', cursor: 'crosshair' }}
      onPointerMove={onMove} onPointerDown={onDown} onPointerLeave={() => setCursor(null)} />
  );
  if (!session) {
    const hint = cursor?.label ?? (starts.length ? 'Click a unit\'s drain outlet or an open drain end' : 'Every unit drains and no drain end is open');
    return (
      <g data-testid="drain-draw" data-mode="pick">
        {capture}
        {starts.map((start) => {
          const at = start.kind === 'unit' ? start.outlet : start.point;
          const hot = cursor !== null && Math.hypot(cursor.point.x - at.x, cursor.point.y - at.y) < 0.01;
          const color = start.kind === 'unit' ? COLOR : OPEN_COLOR;
          return (
            <g key={start.kind === 'unit' ? `u:${start.unitId}` : `g:${start.gapId}`} style={{ pointerEvents: 'none' }} data-testid="drain-draw-start"
              data-kind={start.kind} data-id={start.kind === 'unit' ? start.unitId : start.gapId}>
              {start.kind === 'unit' ? <path d={pathData([start.outlet, start.foot])} stroke={color} strokeWidth={hpx(2)} fill="none" /> : null}
              <circle cx={at.x} cy={at.y} r={hpx(hot ? 10 : 7)} fill={hot ? '#ffffff' : 'none'} stroke={color} strokeWidth={hpx(hot ? 2.4 : 1.8)}
                strokeDasharray={hot ? undefined : `${hpx(3)} ${hpx(2.5)}`} />
            </g>
          );
        })}
        {cursor ? (
          <g style={{ pointerEvents: 'none' }} data-testid="drain-draw-hint" data-on-end="false">
            <Tag x={cursor.point.x + hpx(14)} y={cursor.point.y - hpx(18)} text={hint} hpx={hpx} tone={cursor.label ? 'ok' : undefined} />
          </g>
        ) : null}
      </g>
    );
  }

  const drawn = [...(session.outlet ? [session.outlet] : []), session.from, ...session.points, ...(cursor ? [cursor.point] : [])];
  const onFinish = Boolean(cursor?.target);
  const label = onFinish ? message ?? cursor!.label!
    : session.points.length ? 'Click where it turns'
      : session.to ? 'Click where it turns, or on the other part\'s open end' : 'Click where it turns; finish on a drain or a termination';
  return (
    <g data-testid="drain-draw" data-mode="draw">
      {capture}
      <path d={pathData(drawn)} fill="none" stroke="#ffffff" strokeWidth={hpx(6)} strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: 'none' }} />
      <path d={pathData(drawn)} fill="none" stroke={COLOR} strokeWidth={hpx(2.5)} strokeDasharray={`${hpx(8)} ${hpx(5)}`} strokeLinecap="round" strokeLinejoin="round"
        style={{ pointerEvents: 'none' }} data-testid="drain-draw-path" />
      {session.points.map((point, index) => (
        <circle key={index} cx={point.x} cy={point.y} r={hpx(4)} fill="#ffffff" stroke={COLOR} strokeWidth={hpx(1.6)} style={{ pointerEvents: 'none' }} />
      ))}
      {session.to ? (
        <circle cx={session.to.x} cy={session.to.y} r={hpx(cursor?.target?.kind === 'partner' ? 9 : 7)} fill="none" stroke={COLOR} strokeWidth={hpx(2)}
          strokeDasharray={`${hpx(3)} ${hpx(3)}`} style={{ pointerEvents: 'none' }} data-testid="drain-draw-target" />
      ) : (targets?.gullies ?? []).map((gully) => (
        <circle key={gully.id} cx={gully.point.x} cy={gully.point.y} r={hpx(cursor?.target?.kind === 'gully' && cursor.target.gullyId === gully.id ? 12 : 9)} fill="none"
          stroke={COLOR} strokeWidth={hpx(2)} strokeDasharray={`${hpx(3)} ${hpx(3)}`} style={{ pointerEvents: 'none' }} data-testid="drain-draw-gully" data-id={gully.id} />
      ))}
      {cursor?.target?.kind === 'pipe' ? (
        <circle cx={cursor.point.x} cy={cursor.point.y} r={hpx(6)} fill="#ffffff" stroke={COLOR} strokeWidth={hpx(2.4)} style={{ pointerEvents: 'none' }}
          data-testid="drain-draw-join" />
      ) : null}
      {cursor ? (
        <g style={{ pointerEvents: 'none' }} data-testid="drain-draw-hint" data-on-end={onFinish ? 'true' : 'false'} data-target={cursor.target?.kind ?? ''}>
          <Tag x={cursor.point.x + hpx(14)} y={cursor.point.y - hpx(18)} text={label} hpx={hpx} tone={onFinish ? (message ? 'bad' : 'ok') : undefined} />
        </g>
      ) : null}
    </g>
  );
}
