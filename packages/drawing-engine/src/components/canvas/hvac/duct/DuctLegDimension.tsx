'use client';

/**
 * The temporary dimension of the straight whose card is pinned on the plan:
 * its centreline length, corner to corner, drawn beside it with extension
 * lines (as Revit's temporary dimensions). Click the figure, type a length,
 * Enter: the straight takes it through the same edit as its card (the run
 * re-solved elastically, every end kept, one undo step); Esc or leaving the
 * field keeps it as it is. A length it cannot take says why, in place.
 * The figure keeps clear of the segment's own tag (the card's chip): its
 * side away from the run, else the other side, else beyond the tag.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement, Point2D } from '../../../../types';
import { MM_TO_PX } from '../../scale';

import { commitDuctSegmentEdit } from './ductEditController';
import { ductLegs } from './ductGeometry';
import { applyDuctSegmentEdit } from './ductSegmentEdits';
import { domainOf, useDuctSegmentUiStore } from './ductSegmentUiStore';
import { readDuctRunSpec } from './ductTypes';

/** How far beyond the duct's side the dimension line runs, and the extension lines' gap and overshoot (px). */
const OFFSET_PX = 26;
/** Further out, to clear the segment's tag (px). */
const PAST_TAG_PX = 36;
const GAP_PX = 4;
const OVERSHOOT_PX = 6;
const COLOUR = '#0369a1';

const formatMm = (value: number) => Math.round(value).toLocaleString('en-GB');

export function DuctLegDimension(props: {
  enabled: boolean;
  /** A drag is in progress (the dimension waits). */
  hidden: boolean;
  width: number;
  height: number;
  viewportZoom: number;
  panOffset: Point2D;
  hvacElements: readonly HvacElement[];
}) {
  const { enabled, hidden, width, height, viewportZoom, panOffset, hvacElements } = props;
  const pinned = useDuctSegmentUiStore((state) => state.pinned);
  /** The text being typed (null: not editing), and why the last length could not be made. */
  const [typed, setTyped] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Where the figure goes: 0 its own side, 1 the other side, 2 its own side past the segment's tag. */
  const [spot, setSpot] = useState(0);
  const figureRef = useRef<HTMLElement | null>(null);

  const leg = useMemo(() => {
    if (!enabled || !pinned || pinned.view !== '2d' || domainOf(pinned) !== 'duct') return null;
    const match = /^leg:(\d+)$/.exec(pinned.key);
    const element = match ? hvacElements.find((candidate) => candidate.id === pinned.runId) : undefined;
    const spec = element ? readDuctRunSpec(element) : null;
    if (!match || !element || !spec || spec.legacy || spec.locked) return null;
    const legIndex = Number(match[1]);
    const geometry = ductLegs(spec)[legIndex];
    const runout = spec.end.kind === 'terminal' && spec.end.flex && legIndex === spec.legs.length - 1;
    if (!geometry || geometry.vertical || geometry.sloped || runout) return null;
    const section = spec.legs[legIndex]!;
    // Drawn on the side away from the rest of the run (outside a loop, clear of its other legs), as a draughtsman would.
    const middle = { x: (geometry.start.x + geometry.end.x) / 2, y: (geometry.start.y + geometry.end.y) / 2 };
    const centre = spec.path.reduce((sum, point) => ({ x: sum.x + point.x / spec.path.length, y: sum.y + point.y / spec.path.length }), { x: 0, y: 0 });
    const left = { x: -geometry.direction.y, y: geometry.direction.x };
    const towardCentre = (centre.x - middle.x) * left.x + (centre.y - middle.y) * left.y;
    const side = towardCentre > 1 ? -1 : 1;
    return {
      runId: element.id, legIndex, start: geometry.start, end: geometry.end, direction: geometry.direction, lengthMm: geometry.lengthMm,
      halfMm: (section.diameterMm ?? section.widthMm) / 2 + spec.insulationThicknessMm,
      normal: { x: left.x * side, y: left.y * side },
    };
  }, [enabled, pinned, hvacElements]);

  // Another straight, or this one at a new length: whatever was being typed goes.
  const identity = leg ? `${leg.runId}|${leg.legIndex}|${Math.round(leg.lengthMm)}` : '';
  useEffect(() => {
    setTyped(null);
    setRefusal(null);
  }, [identity]);
  const editing = typed !== null;
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  // A new straight or view: its own side first.
  useEffect(() => setSpot(0), [identity, viewportZoom, panOffset.x, panOffset.y]);
  // The segment's tag is placed by the card layer's own frame loop: the figure moves on while it covers it.
  useEffect(() => {
    if (!leg || hidden) return undefined;
    let frame = 0;
    const check = () => {
      frame = requestAnimationFrame(check);
      const chip = document.querySelector<HTMLElement>('[data-testid="duct-segment-chip"]');
      const figure = figureRef.current;
      if (!chip || !figure || chip.style.visibility === 'hidden') return;
      const a = chip.getBoundingClientRect();
      const b = figure.getBoundingClientRect();
      if (a.left < b.right + 4 && b.left < a.right + 4 && a.top < b.bottom + 4 && b.top < a.bottom + 4) {
        setSpot((current) => (current < 2 ? current + 1 : current));
      }
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [leg, hidden, spot]);

  if (!leg || hidden) return null;
  const k = MM_TO_PX * viewportZoom;
  const toScreen = (point: Point2D) => ({ x: -panOffset.x * viewportZoom + point.x * k, y: -panOffset.y * viewportZoom + point.y * k });
  const a = toScreen(leg.start);
  const b = toScreen(leg.end);
  if (Math.hypot(b.x - a.x, b.y - a.y) < 24) return null;
  // (The plan's screen is not mirrored: the plan's side is the screen's.)
  const n = spot === 1 ? { x: -leg.normal.x, y: -leg.normal.y } : leg.normal;
  const side = leg.halfMm * k;
  const off = side + OFFSET_PX + (spot === 2 ? PAST_TAG_PX : 0);
  const at = (point: Point2D, distance: number) => ({ x: point.x + n.x * distance, y: point.y + n.y * distance });
  const a2 = at(a, off);
  const b2 = at(b, off);
  const mid = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 };
  let angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  if (angle > 90) angle -= 180;
  if (angle <= -90) angle += 180;
  const tick = (point: Point2D) => {
    const d = { x: (leg.direction.x - n.x) * 4, y: (leg.direction.y - n.y) * 4 };
    return `M${point.x - d.x},${point.y - d.y} L${point.x + d.x},${point.y + d.y}`;
  };
  const line = (from: Point2D, to: Point2D) => `M${from.x},${from.y} L${to.x},${to.y}`;

  const commit = () => {
    if (typed === null) return;
    const value = Number.parseFloat(typed.replace(',', '.').replace(/\s/g, ''));
    if (!Number.isFinite(value) || Math.abs(value - leg.lengthMm) < 0.5) {
      setTyped(null);
      setRefusal(null);
      return;
    }
    const state = useSmartDrawingStore.getState();
    const result = applyDuctSegmentEdit(state.hvacElements, state.ductSettings, { kind: 'leg-length', runId: leg.runId, legIndex: leg.legIndex, lengthMm: value });
    if (result.refused) {
      setRefusal(result.refused);
      state.setProcessingStatus(result.refused, false);
      return;
    }
    commitDuctSegmentEdit(result.updates, result.action);
    state.setProcessingStatus([`${result.action}.`, ...result.notes].join(' '), false);
    setTyped(null);
    setRefusal(null);
  };

  return (
    <div className="pointer-events-none absolute left-0 top-0 z-[13] overflow-hidden" style={{ width, height }} data-testid="duct-leg-dimension">
      <svg width={width} height={height} className="pointer-events-none absolute left-0 top-0" aria-hidden="true">
        <path d={`${line(at(a, side + GAP_PX), at(a, off + OVERSHOOT_PX))} ${line(at(b, side + GAP_PX), at(b, off + OVERSHOOT_PX))}`}
          stroke={COLOUR} strokeWidth={0.9} fill="none" />
        <path d={`${line(a2, b2)} ${tick(a2)} ${tick(b2)}`} stroke={COLOUR} strokeWidth={1.2} fill="none" />
      </svg>
      {editing ? (
        <div ref={(node) => { figureRef.current = node; }} className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2" style={{ left: mid.x, top: mid.y }}>
          <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            value={typed}
            aria-label={`Length of straight ${leg.legIndex + 1} (mm)`}
            aria-invalid={Boolean(refusal)}
            title={refusal ?? 'Type a length (mm), Enter to make it, Esc to leave it'}
            onChange={(event) => { setTyped(event.target.value); setRefusal(null); }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') { event.preventDefault(); commit(); }
              if (event.key === 'Escape') { event.preventDefault(); setTyped(null); setRefusal(null); }
            }}
            onBlur={() => { setTyped(null); setRefusal(null); }}
            className={`h-6 w-20 rounded-md border bg-white px-1.5 text-center font-mono text-[12px] font-semibold tabular-nums shadow-md focus:outline-none focus:ring-2 ${refusal ? 'border-red-400 text-red-700 focus:ring-red-300' : 'border-sky-400 text-sky-800 focus:ring-sky-300'}`}
          />
          {refusal ? (
            <div role="alert" className="absolute left-1/2 top-7 w-64 -translate-x-1/2 rounded-md bg-red-50 px-2 py-1 text-[11px] leading-4 text-red-800 shadow ring-1 ring-red-200">
              {refusal}
            </div>
          ) : null}
        </div>
      ) : (
        <button
          ref={(node) => { figureRef.current = node; }}
          type="button"
          className="pointer-events-auto absolute rounded-md bg-white/95 px-1.5 py-px font-mono text-[11.5px] font-semibold tabular-nums text-sky-800 shadow-sm ring-1 ring-sky-300 transition-colors hover:bg-sky-50 hover:ring-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          style={{ left: mid.x, top: mid.y, transform: `translate(-50%, -50%) rotate(${angle}deg)`, cursor: 'text' }}
          title="Click to type this straight's length (centreline, corner to corner)"
          aria-label={`Straight ${leg.legIndex + 1}: ${formatMm(leg.lengthMm)} mm. Click to change its length`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setTyped(String(Math.round(leg.lengthMm)))}
        >
          {formatMm(leg.lengthMm)}
        </button>
      )}
    </div>
  );
}
