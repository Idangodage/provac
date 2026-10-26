'use client';

/**
 * The reconnect chip: point at a gap left by deleted duct, refrigerant or
 * drain pieces (on the plan or in 3D) and its best way to reconnect shows on
 * the drawing, with a chip beside it — what the way is (as it was, the
 * shortest, the fewest fittings, back to its terminal or port …), its length
 * and turns (and what else it changes: a drain network's levels solved
 * again), and Apply (Enter), another way (Tab), draw it by hand, or dismiss
 * (Esc). With several gaps open it offers to reconnect them all. The chip
 * follows the gap as the view moves (its transform written each frame, no
 * React render).
 */
import { CornerDownLeft, Repeat2, Spline, Workflow, X } from 'lucide-react';
import { useEffect, useMemo, useRef, type RefObject } from 'react';

import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';
import { condensateOpenEnds } from '../condensate/condensateCut';
import { refrigerantOpenEnds } from '../refrigerant/refrigerantCut';

import { ductOpenEnds } from './ductCut';
import { applyGapWay, dismissGap, nextGapWay, openGapIds, pointAtGap, reconnectAllGaps, turnsLabel, useDuctGapStore, type GapDomain } from './ductGapController';
import type { DuctPoint3 } from './ductTypes';

/** How near the pointer must come to a gap (screen px). */
const REACH_PX = 26;
/** Leaving the gap, the chip stays this long for the pointer to reach it (ms). */
const GRACE_MS = 600;

interface DuctGapChipProps {
  enabled: boolean;
  /** A model point (a duct's clear-bottom level, a pipe's centreline) on screen, in the view shown; null when it is not. */
  toClient: (point: DuctPoint3) => { x: number; y: number } | null;
  hostRef: RefObject<HTMLElement | null>;
  /** [Draw it]: the gap's tool (duct or pipe) from its open end. */
  onDraw?: (gapId: string, domain: GapDomain) => void;
}

/**
 * A gap's lines on the drawing: the stretch deleted (a pair's two), else its two ends, else its one end. A pipe's lone
 * end that had no connection is no gap (nothing to go back to).
 */
function gapLines(scene: readonly HvacElement[]): Map<string, DuctPoint3[][]> {
  const out = new Map<string, DuctPoint3[][]>();
  const add = (id: string, removed: DuctPoint3[] | null | undefined, point: DuctPoint3, joined: boolean) => {
    const lines = out.get(id) ?? [];
    if (removed && removed.length >= 2 && joined) lines.push(removed);
    else lines.push([point]);
    out.set(id, lines);
  };
  for (const end of ductOpenEnds(scene)) if (end.gap) add(end.gap.id, end.gap.removed?.path, end.point, Boolean(end.gap.partner));
  for (const end of refrigerantOpenEnds(scene)) {
    if (!end.gap.partner && !end.gap.was) continue;
    // Both ends of a line's gap remember its stretch: it is drawn once (a lone end's, the stub to its port).
    if (end.gap.partner && end.end === 'start') continue;
    add(end.gap.id, end.gap.removed, end.point, true);
  }
  for (const end of condensateOpenEnds(scene)) {
    if (!end.gap.partner && !end.gap.was && !end.gap.removedRun) continue;
    if (end.gap.partner && end.end === 'start') continue;
    add(end.gap.id, end.gap.removed, end.point, true);
  }
  return out;
}

function distanceToPolyline(point: { x: number; y: number }, line: ReadonlyArray<{ x: number; y: number }>): number {
  if (line.length === 1) return Math.hypot(point.x - line[0]!.x, point.y - line[0]!.y);
  let best = Infinity;
  for (let index = 1; index < line.length; index += 1) {
    const a = line[index - 1]!;
    const b = line[index]!;
    const ab = { x: b.x - a.x, y: b.y - a.y };
    const lengthSq = ab.x * ab.x + ab.y * ab.y || 1;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * ab.x + (point.y - a.y) * ab.y) / lengthSq));
    best = Math.min(best, Math.hypot(a.x + ab.x * t - point.x, a.y + ab.y * t - point.y));
  }
  return best;
}

export function DuctGapChip({ enabled, toClient, hostRef, onDraw }: DuctGapChipProps) {
  const hvacElements = useSmartDrawingStore((state) => state.hvacElements);
  const gapId = useDuctGapStore((state) => state.gapId);
  const proposals = useDuctGapStore((state) => state.proposals);
  const index = useDuctGapStore((state) => state.index);
  const lines = useMemo(() => gapLines(hvacElements), [hvacElements]);
  const chipRef = useRef<HTMLDivElement | null>(null);
  const toClientRef = useRef(toClient);
  toClientRef.current = toClient;

  // The gap under the pointer (either view): nearest within reach of its line on screen.
  useEffect(() => {
    if (!enabled || !lines.size) {
      pointAtGap(null);
      return undefined;
    }
    let frame = 0;
    let grace = 0;
    let last: PointerEvent | null = null;
    const hold = () => { if (grace) { window.clearTimeout(grace); grace = 0; } };
    const leave = () => {
      // The pointer left the gap: the chip waits a moment, so the pointer can reach it.
      if (grace || !useDuctGapStore.getState().gapId) return;
      grace = window.setTimeout(() => { grace = 0; pointAtGap(null); }, GRACE_MS);
    };
    const check = () => {
      frame = 0;
      const event = last;
      if (!event || event.buttons !== 0) return;
      const target = event.target as Element | null;
      if (target?.closest?.('[data-testid="duct-gap-chip"]')) { hold(); return; }
      const host = hostRef.current?.getBoundingClientRect();
      if (!host || event.clientX < host.left || event.clientX > host.right || event.clientY < host.top || event.clientY > host.bottom) {
        leave();
        return;
      }
      let best: { id: string; distance: number } | null = null;
      for (const [id, polylines] of lines) {
        for (const line of polylines) {
          const screen = line.map((point) => toClientRef.current(point)).filter((point): point is { x: number; y: number } => point !== null);
          if (!screen.length) continue;
          const distance = distanceToPolyline({ x: event.clientX, y: event.clientY }, screen);
          if (distance <= REACH_PX && (!best || distance < best.distance)) best = { id, distance };
        }
      }
      if (best) {
        hold();
        pointAtGap(best.id);
      } else leave();
    };
    const onMove = (event: PointerEvent) => {
      last = event;
      if (!frame) frame = requestAnimationFrame(check);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (frame) cancelAnimationFrame(frame);
      hold();
    };
  }, [enabled, lines, hostRef]);

  // Enter applies, Tab shows another way, Esc dismisses (not while typing in a field).
  useEffect(() => {
    if (!gapId) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (event.key === 'Enter') { if (applyGapWay()) { event.preventDefault(); event.stopPropagation(); } return; }
      if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); nextGapWay(); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissGap(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [gapId]);

  // The chip beside the gap, following it every frame while shown.
  useEffect(() => {
    if (!gapId) return undefined;
    let frame = 0;
    const place = () => {
      frame = requestAnimationFrame(place);
      const chip = chipRef.current;
      const host = hostRef.current?.getBoundingClientRect();
      const polylines = lines.get(gapId);
      if (!chip || !host || !polylines) return;
      const screen = polylines.flat().map((point) => toClientRef.current(point)).filter((point): point is { x: number; y: number } => point !== null);
      if (!screen.length) { chip.style.visibility = 'hidden'; return; }
      const xs = screen.map((point) => point.x);
      const ys = screen.map((point) => point.y);
      const width = chip.offsetWidth;
      const height = chip.offsetHeight;
      const centreX = (Math.min(...xs) + Math.max(...xs)) / 2;
      // Above the gap, else below it when there is no room above.
      let top = Math.min(...ys) - height - 18;
      if (top < host.top + 8) top = Math.max(...ys) + 18;
      const left = Math.max(host.left + 8, Math.min(host.right - width - 8, centreX - width / 2));
      chip.style.transform = `translate(${Math.round(left - host.left)}px, ${Math.round(top - host.top)}px)`;
      chip.style.visibility = 'visible';
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [gapId, lines, hostRef]);

  if (!enabled || !gapId || !proposals) return null;
  const candidate = proposals.candidates[index] ?? null;
  const gaps = openGapIds().length;
  const pair = proposals.domain === 'refrigerant' && (candidate?.updates.length ?? 0) > 1;
  const button = 'inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium transition-colors';
  return (
    <div ref={chipRef} role="dialog" aria-label="Reconnect the gap" data-testid="duct-gap-chip" data-hvac-overlay-ui="" data-gap={gapId} data-domain={proposals.domain} data-way={candidate?.key ?? ''}
      className="pointer-events-auto absolute left-0 top-0 z-[30] flex max-w-[30rem] items-center gap-2 rounded-2xl border border-teal-200 bg-white/95 py-1.5 pl-3 pr-1.5 text-xs text-slate-700 shadow-lg backdrop-blur"
      style={{ visibility: 'hidden' }}>
      <Workflow size={14} className="shrink-0 text-teal-600" aria-hidden="true" />
      {candidate ? (
        <div className="min-w-0">
          <div className="truncate font-semibold text-slate-800" data-testid="duct-gap-way">
            Reconnect · {candidate.label}
            {proposals.candidates.length > 1 ? <span className="ml-1 font-normal text-slate-400">{index + 1}/{proposals.candidates.length}</span> : null}
          </div>
          <div className="text-[11px] text-slate-500" data-testid="duct-gap-figures">
            {(candidate.lengthMm / 1000).toFixed(2)} m · {candidate.elbows} {turnsLabel(proposals.domain, candidate.elbows)}{pair ? ' · gas + liquid' : ''}
          </div>
          {candidate.note ? <div className="text-[11px] text-sky-700" data-testid="duct-gap-note">{candidate.note}</div> : null}
        </div>
      ) : (
        <div className="max-w-[16rem] text-[11px] text-amber-800" data-testid="duct-gap-reason">{proposals.reason}</div>
      )}
      <div className="ml-1 flex items-center gap-1">
        {candidate ? (
          <button type="button" data-testid="duct-gap-apply" title="Apply this way (Enter)" onClick={() => applyGapWay()}
            className={`${button} bg-teal-600 text-white hover:bg-teal-700`}>
            <CornerDownLeft size={12} aria-hidden="true" />Apply
          </button>
        ) : null}
        {proposals.candidates.length > 1 ? (
          <button type="button" data-testid="duct-gap-next" title="Another way (Tab)" onClick={() => nextGapWay()}
            className={`${button} border border-slate-200 bg-white text-slate-600 hover:bg-slate-50`}>
            <Repeat2 size={12} aria-hidden="true" />Other
          </button>
        ) : null}
        {onDraw ? (
          <button type="button" data-testid="duct-gap-draw" title={`Draw it with the ${proposals.domain === 'duct' ? 'duct' : proposals.domain === 'condensate' ? 'drain' : 'pipe'} tool from its open end`} onClick={() => onDraw(gapId, proposals.domain)}
            className={`${button} border border-slate-200 bg-white text-slate-600 hover:bg-slate-50`}>
            <Spline size={12} aria-hidden="true" />Draw
          </button>
        ) : null}
        {gaps > 1 ? (
          <button type="button" data-testid="duct-gap-all" title="Reconnect every open gap the best way (one undo)" onClick={() => reconnectAllGaps()}
            className={`${button} border border-teal-200 bg-teal-50 text-teal-800 hover:bg-teal-100`}>
            All {gaps}
          </button>
        ) : null}
        <button type="button" data-testid="duct-gap-dismiss" title="Dismiss (Esc)" aria-label="Dismiss" onClick={() => dismissGap()}
          className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
          <X size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
