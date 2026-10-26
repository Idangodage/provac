'use client';

/**
 * The plan side of drawing a drain gap by hand (drainDrawSession): while a
 * session is open it takes the plan's clicks. The drawn drain follows the
 * pointer square to its last leg, as drains are laid; near the other part's
 * open end it snaps there, the network then shown as it would be, joined and
 * solved again, and a click finishes. Drawn in the drawing's own frame.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

import type { HvacElement, Point2D } from '../../../../types';

import { condensateOpenEnds } from './condensateCut';
import { Tag, pathData } from './condensatePlanGlyphs';
import {
  addDrainDrawPoint,
  cancelDrainDraw,
  clearDrainDrawPreview,
  finishDrainDraw,
  previewDrainDraw,
  stopDrainDraw,
  undoDrainDrawPoint,
  useDrainDrawStore,
} from './drainDrawSession';

/** How near the other part's open end the pointer snaps to it (screen px). */
const SNAP_PX = 16;
const COLOR = '#0d9488';

export function DrainDrawLayer({ gRef, hpx, hvacElements }: { gRef: RefObject<SVGGElement | null>; hpx: (n: number) => number; hvacElements: readonly HvacElement[] }) {
  const session = useDrainDrawStore((state) => state.session);
  const [cursor, setCursor] = useState<{ point: Point2D; onEnd: boolean } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const previewedRef = useRef<string | null>(null);

  // The gap closed or gone (an undo, another way applied): drawing stops.
  useEffect(() => {
    if (session && !condensateOpenEnds(hvacElements).some((end) => end.gap.id === session.gapId)) stopDrainDraw();
  }, [session, hvacElements]);

  const toWorld = useCallback((clientX: number, clientY: number): Point2D | null => {
    const ctm = gRef.current?.getScreenCTM();
    if (!ctm) return null;
    const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: point.x, y: point.y };
  }, [gRef]);

  /** The point the pointer means: the other part's open end when near it, else square to the last leg. */
  const resolve = useCallback((raw: Point2D) => {
    if (!session) return null;
    if (session.to && Math.hypot(raw.x - session.to.x, raw.y - session.to.y) <= hpx(SNAP_PX)) return { point: session.to, onEnd: true };
    const last = session.points[session.points.length - 1] ?? session.from;
    const square = Math.abs(raw.x - last.x) >= Math.abs(raw.y - last.y) ? { x: raw.x, y: last.y } : { x: last.x, y: raw.y };
    return { point: square, onEnd: false };
  }, [session, hpx]);

  // Resting on the other part's open end: the network as it would be (solved once per set of points).
  useEffect(() => {
    if (!session || !cursor?.onEnd) {
      if (previewedRef.current) { clearDrainDrawPreview(); previewedRef.current = null; setMessage(null); }
      return;
    }
    const key = JSON.stringify(session.points);
    if (previewedRef.current === key) return;
    previewedRef.current = key;
    const joined = previewDrainDraw();
    setMessage(joined && !joined.ok ? joined.message : null);
  }, [session, cursor]);

  useEffect(() => {
    if (!session) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancelDrainDraw(); }
      else if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); event.stopImmediatePropagation(); undoDrainDrawPoint(); }
      else if (event.key === 'Enter' && cursor?.onEnd) { event.preventDefault(); event.stopImmediatePropagation(); finishDrainDraw(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [session, cursor]);

  if (!session) return null;
  const onMove = (event: ReactPointerEvent) => {
    const world = toWorld(event.clientX, event.clientY);
    setCursor(world ? resolve(world) : null);
  };
  const onDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const world = toWorld(event.clientX, event.clientY);
    const at = world ? resolve(world) : null;
    if (!at) return;
    if (at.onEnd) finishDrainDraw();
    else addDrainDrawPoint(at.point);
  };
  const drawn = [session.from, ...session.points, ...(cursor ? [cursor.point] : [])];
  const label = cursor?.onEnd ? message ?? 'Join to the other part: click' : session.points.length ? 'Click where it turns' : 'Click where it turns, or on the other part\'s open end';
  return (
    <g data-testid="drain-draw">
      <rect x={-1e7} y={-1e7} width={2e7} height={2e7} fill="transparent" style={{ pointerEvents: 'all', cursor: 'crosshair' }}
        onPointerMove={onMove} onPointerDown={onDown} />
      <path d={pathData(drawn)} fill="none" stroke="#ffffff" strokeWidth={hpx(6)} strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: 'none' }} />
      <path d={pathData(drawn)} fill="none" stroke={COLOR} strokeWidth={hpx(2.5)} strokeDasharray={`${hpx(8)} ${hpx(5)}`} strokeLinecap="round" strokeLinejoin="round"
        style={{ pointerEvents: 'none' }} data-testid="drain-draw-path" />
      {session.points.map((point, index) => (
        <circle key={index} cx={point.x} cy={point.y} r={hpx(4)} fill="#ffffff" stroke={COLOR} strokeWidth={hpx(1.6)} style={{ pointerEvents: 'none' }} />
      ))}
      {session.to ? (
        <circle cx={session.to.x} cy={session.to.y} r={hpx(cursor?.onEnd ? 9 : 7)} fill="none" stroke={COLOR} strokeWidth={hpx(2)} strokeDasharray={`${hpx(3)} ${hpx(3)}`}
          style={{ pointerEvents: 'none' }} data-testid="drain-draw-target" />
      ) : null}
      {cursor ? (
        <g style={{ pointerEvents: 'none' }} data-testid="drain-draw-hint" data-on-end={cursor.onEnd ? 'true' : 'false'}>
          <Tag x={cursor.point.x + hpx(14)} y={cursor.point.y - hpx(18)} text={label} hpx={hpx} tone={cursor.onEnd ? (message ? 'bad' : 'ok') : undefined} />
        </g>
      ) : null}
    </g>
  );
}
