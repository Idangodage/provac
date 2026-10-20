'use client';

/**
 * The parts of a segment card every service shares: keeping the card beside
 * its piece every frame without a React render, evaluating options a slice at
 * a time, option rows and chips, typed values with steppers, the result line
 * with Apply, and the list keys. The service-specific parts (figures, chips,
 * editors) come from its SegmentProvider.
 */
import { Minus, Plus } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { placePopover, type ScreenRect } from '../duct/popoverPlacement';

import type { SegmentBadge, SegmentEvaluationLike, SegmentFieldHost, SegmentOptionLike } from './segmentProvider';

/** Rest on a piece this long before its card peeks (ms); moving on with a card open is quicker. */
export const PEEK_DELAY_MS = 260;
export const PEEK_SWITCH_MS = 90;
/** A peek stays this long after the pointer leaves, so it can be reached. */
export const PEEK_GRACE_MS = 240;
/** Quick picks a peek offers. */
export const PEEK_SWAPS = 2;
/** Option rows a tab shows before "more". */
export const ROWS_SHOWN = 6;

export type FigureStatus = 'ok' | 'near' | 'over';
export const STATUS_DOT: Record<FigureStatus, string> = { ok: 'bg-emerald-500', near: 'bg-amber-500', over: 'bg-red-500' };
export const STATUS_TEXT: Record<FigureStatus, string> = { ok: 'within the limit', near: 'near the limit', over: 'over the limit' };

export const formatNumber = (value: number, digits = 0) => value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const formatSigned = (value: number, digits = 0) => `${value > 0 ? '+' : value < 0 ? '−' : '±'}${formatNumber(Math.abs(value), digits)}`;
export const formatRange = (span: { max: number; min: number }, digits: number) => (Math.abs(span.max - span.min) < 0.5 * 10 ** -digits
  ? formatNumber(span.max, digits)
  : `${formatNumber(span.max, digits)}–${formatNumber(span.min, digits)}`);
export const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export interface CardDecor {
  leaderRef: RefObject<SVGSVGElement | null>;
  chipRef: RefObject<HTMLDivElement | null>;
}

/** A new placement keeps this far clear of the pointer (px): a twitch of the hand does not land on it. */
const POINTER_CLEARANCE_PX = 8;

/**
 * Where the pointer last moved or pressed, and over what: one listener for the page, so a card that comes up while
 * the pointer rests (a peek, after its delay) still knows where it is.
 */
const lastPointer: { x: number; y: number; target: EventTarget | null } = { x: Number.NaN, y: Number.NaN, target: null };
let trackingPointer = false;
function trackPointer(): void {
  if (trackingPointer || typeof window === 'undefined') return;
  trackingPointer = true;
  const update = (event: PointerEvent) => {
    lastPointer.x = event.clientX;
    lastPointer.y = event.clientY;
    lastPointer.target = event.target;
  };
  window.addEventListener('pointermove', update, true);
  window.addEventListener('pointerdown', update, true);
}

/**
 * Keep a card beside its anchor every frame (no React render), writing its
 * transform directly; with `decor`, also the leader line from the card to the
 * piece and the chip naming it (above the piece, else below it).
 *
 * A card never comes up under the pointer: a click meant for the drawing would
 * land on it (a quick pick applied, a neighbour pinned). Where no side clears
 * the piece it stands beside the pointer instead, and one that grows under a
 * still pointer is placed again. A card the pointer moved onto stays put.
 */
export function useAnchoredCard(cardRef: RefObject<HTMLDivElement | null>, containerRef: RefObject<HTMLDivElement | null>, anchor: () => ScreenRect | null, active: boolean, decor?: CardDecor) {
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const decorRef = useRef(decor);
  decorRef.current = decor;
  useLayoutEffect(() => {
    if (!active) return undefined;
    let frame = 0;
    let last = '';
    // The card stays put while its anchor does: growing (the hover line at its foot) or shrinking never moves it under
    // the pointer. It is placed again when the anchor moves, or when it would run off the drawing — once the pointer
    // is off it.
    let held: { key: string; placed: ReturnType<typeof placePopover> } | null = null;
    trackPointer();
    // Whether the pointer last moved onto this card. A row re-rendered under it (a tab switched, a list redrawn)
    // leaves the event's target detached: the answer stands until the pointer moves again.
    let pointerOnCard = false;
    const show = (node: HTMLElement | SVGElement | null | undefined, visible: boolean) => {
      if (node && node.style.visibility !== (visible ? 'visible' : 'hidden')) node.style.visibility = visible ? 'visible' : 'hidden';
    };
    const place = () => {
      frame = requestAnimationFrame(place);
      const card = cardRef.current;
      const container = containerRef.current;
      const leader = decorRef.current?.leaderRef.current;
      const chip = decorRef.current?.chipRef.current;
      if (!card || !container) return;
      const rect = anchorRef.current();
      const host = container.getBoundingClientRect();
      if (!rect || host.width <= 0) {
        show(card, false);
        show(leader, false);
        show(chip, false);
        return;
      }
      const local = { left: rect.left - host.left, top: rect.top - host.top, right: rect.right - host.left, bottom: rect.bottom - host.top };
      // The card keeps clear of the piece and of what is round it (a straight's grips); the chip names the piece itself.
      const zone = rect.avoid ? {
        left: Math.min(local.left, rect.avoid.left - host.left), top: Math.min(local.top, rect.avoid.top - host.top),
        right: Math.max(local.right, rect.avoid.right - host.left), bottom: Math.max(local.bottom, rect.avoid.bottom - host.top),
      } : local;
      const anchorKey = [zone.left, zone.top, zone.right, zone.bottom, host.width, host.height].map((value) => Math.round(value)).join(',');
      // A card placed clear of its piece that has since grown over it (its rows and chips arrive after it opens) is
      // placed again — but never from under the pointer (a hovered row's foot grows it too); one that had no room but
      // to cover its piece from the start stays.
      const covers = (at: { x: number; y: number; overlaps: boolean }) => !at.overlaps && !card.matches(':hover')
        && at.x < zone.right && at.x + card.offsetWidth > zone.left && at.y < zone.bottom && at.y + card.offsetHeight > zone.top;
      // The pointer, in the drawing, unless it moved onto the card: a placement keeps `reach` clear of it.
      if (lastPointer.target instanceof Node && lastPointer.target.isConnected) pointerOnCard = card.contains(lastPointer.target);
      const pointerAt = Number.isFinite(lastPointer.x) && !pointerOnCard ? { x: lastPointer.x - host.left, y: lastPointer.y - host.top } : null;
      const near = pointerAt && pointerAt.x >= 0 && pointerAt.y >= 0 && pointerAt.x <= host.width && pointerAt.y <= host.height ? pointerAt : null;
      const overPointer = (spot: { x: number; y: number }, reach: number) => near !== null
        && spot.x < near.x + reach && spot.x + card.offsetWidth > near.x - reach && spot.y < near.y + reach && spot.y + card.offsetHeight > near.y - reach;
      // A card the pointer is on stays put, even grown past the drawing's edge (a hovered row's foot): moving it would
      // take the row from under the pointer. It is placed again once the pointer leaves it.
      const inView = (spot: { x: number; y: number }) => pointerOnCard
        || (spot.x + card.offsetWidth <= host.width - 2 && spot.y + card.offsetHeight <= host.height - 2);
      const fits = (spot: { x: number; y: number; overlaps: boolean }) => inView(spot) && !covers(spot) && !overPointer(spot, 0);
      // Nor does its piece moving or changing size (an option applied, a neighbour stepped to) move it from under the
      // pointer: its leader follows the piece, and it settles by the piece once the pointer leaves it.
      if (!held || (!pointerOnCard && (held.key !== anchorKey || !fits(held.placed)))) {
        const size = { width: card.offsetWidth, height: card.offsetHeight };
        const view = { width: host.width, height: host.height };
        const sides = rect.sides ? { sides: rect.sides } : undefined;
        let placed = placePopover(zone, size, view, sides);
        if (near && overPointer(placed, POINTER_CLEARANCE_PX)) {
          // No side clears both the piece and the pointer: beside the pointer, over the piece.
          const zone = { left: near.x - POINTER_CLEARANCE_PX, top: near.y - POINTER_CLEARANCE_PX, right: near.x + POINTER_CLEARANCE_PX, bottom: near.y + POINTER_CLEARANCE_PX };
          const beside = placePopover(zone, size, view, sides);
          if (!overPointer(beside, 0)) placed = { ...beside, overlaps: true };
        }
        held = { key: anchorKey, placed };
      }
      const placed = held.placed;
      const pin = rect.pinX !== undefined && rect.pinY !== undefined
        ? { x: rect.pinX - host.left, y: rect.pinY - host.top }
        : { x: (local.left + local.right) / 2, y: (local.top + local.bottom) / 2 };
      const box = { left: placed.x, top: placed.y, right: placed.x + card.offsetWidth, bottom: placed.y + card.offsetHeight };
      let chipAt: { x: number; y: number } | null = null;
      if (chip) {
        const w = chip.offsetWidth;
        const h = chip.offsetHeight;
        // Centred over the pin, but kept on the far side of it from the card (never under the card).
        let x = pin.x - w / 2;
        if (placed.side === 'right') x = Math.min(x, box.left - w - 8);
        else if (placed.side === 'left') x = Math.max(x, box.right + 8);
        x = clamp(x, 4, Math.max(4, host.width - w - 4));
        const clear = (y: number) => y >= 4 && y + h <= host.height - 4 && !(x < box.right && x + w > box.left && y < box.bottom && y + h > box.top);
        const above = Math.min(local.top, pin.y - 14) - h - 8;
        const below = Math.max(local.bottom, pin.y + 14) + 8;
        chipAt = { x, y: clear(above) ? above : clear(below) ? below : clamp(above, 4, host.height - h - 4) };
      }
      const attach = { x: clamp(pin.x, box.left, box.right), y: clamp(pin.y, box.top, box.bottom) };
      const value = `${Math.round(placed.x)},${Math.round(placed.y)}|${Math.round(pin.x)},${Math.round(pin.y)}|${chipAt ? `${Math.round(chipAt.x)},${Math.round(chipAt.y)}` : ''}`;
      if (value !== last) {
        card.style.transform = `translate(${Math.round(placed.x)}px, ${Math.round(placed.y)}px)`;
        card.dataset.side = placed.side;
        if (leader) {
          const line = leader.querySelector('line');
          line?.setAttribute('x1', String(attach.x));
          line?.setAttribute('y1', String(attach.y));
          line?.setAttribute('x2', String(pin.x));
          line?.setAttribute('y2', String(pin.y));
          for (const [selector, point] of [['[data-pin]', pin], ['[data-attach]', attach]] as const) {
            const dot = leader.querySelector(selector);
            dot?.setAttribute('cx', String(point.x));
            dot?.setAttribute('cy', String(point.y));
          }
        }
        if (chip && chipAt) chip.style.transform = `translate(${Math.round(chipAt.x)}px, ${Math.round(chipAt.y)}px)`;
        last = value;
      }
      show(card, true);
      // A leader only where the card stands clear of the piece.
      show(leader, Math.hypot(attach.x - pin.x, attach.y - pin.y) > 6);
      show(chip, true);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [active, cardRef, containerRef]);
}

/**
 * Evaluate the options a few at a time (about 12 ms per slice), so the drawing
 * stays responsive while the card fills in; rows not yet judged show without
 * chips until they are.
 */
export function useOptionEvaluations<O extends SegmentOptionLike, E extends SegmentEvaluationLike>(evaluate: ((option: O) => E) | null, options: readonly O[]) {
  const [evaluations, setEvaluations] = useState<Map<string, E>>(() => new Map());
  useEffect(() => {
    if (!evaluate) return undefined;
    let cancelled = false;
    const result = new Map<string, E>();
    let index = 0;
    let timer = 0;
    const step = () => {
      if (cancelled) return;
      const started = performance.now();
      while (index < options.length && performance.now() - started < 12) {
        const option = options[index]!;
        index += 1;
        result.set(option.id, evaluate(option));
      }
      setEvaluations(new Map(result));
      if (index < options.length) timer = window.setTimeout(step, 0);
    };
    timer = window.setTimeout(step, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [evaluate, options]);
  return evaluations;
}

export interface HoverInfo<O extends SegmentOptionLike, E extends SegmentEvaluationLike> {
  option: O;
  evaluation: E | undefined;
}

/** An option on one line: its picture, its name, its badges as icons, its change as chips. */
export function OptionRow<O extends SegmentOptionLike, E extends SegmentEvaluationLike>({ option, evaluation, badges, badgeDefs, glyph, chips, onHover, onApply }: {
  option: O;
  evaluation: E | undefined;
  badges: readonly string[];
  badgeDefs: Readonly<Record<string, SegmentBadge>> | undefined;
  glyph: ReactNode;
  chips: (evaluation: E) => ReactNode;
  onHover: (info: HoverInfo<O, E> | null) => void;
  onApply: (option: O) => void;
}) {
  const reason = option.disabledReason ?? evaluation?.refused;
  const disabled = Boolean(reason) || option.current;
  return (
    <button
      type="button"
      data-option-row={option.id}
      aria-disabled={disabled || undefined}
      aria-current={option.current ? 'true' : undefined}
      className={`group flex w-full items-center gap-2 rounded-lg px-2 py-[5px] text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${option.current
        ? 'bg-violet-50 ring-1 ring-inset ring-violet-200' : reason ? 'cursor-not-allowed opacity-45' : 'hover:bg-slate-50 focus-visible:bg-slate-50'}`}
      title={reason ?? option.detail}
      onPointerEnter={() => onHover({ option, evaluation })}
      onPointerLeave={() => onHover(null)}
      onFocus={() => onHover({ option, evaluation })}
      onBlur={() => onHover(null)}
      onClick={() => (disabled ? undefined : onApply(option))}
    >
      <span className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md ${option.current ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-500 group-hover:bg-violet-100 group-hover:text-violet-700'}`}>
        {glyph}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-slate-800">{option.title}</span>
      {badges.map((badge) => {
        const def = badgeDefs?.[badge];
        if (!def) return null;
        return (
          <span key={badge} className={`shrink-0 ${def.tone}`} title={def.title}>
            {def.icon}<span className="sr-only">{def.label}</span>
          </span>
        );
      })}
      {option.current ? <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-violet-600">current</span> : null}
      {!option.current && evaluation && !evaluation.refused ? chips(evaluation) : null}
    </button>
  );
}

/** Quick picks as chips (taper angles, attenuator lengths, sizes): each an option, applied with a click. */
export function ChipRow<O extends SegmentOptionLike, E extends SegmentEvaluationLike>({ options, evaluations, onHover, onApply }: {
  options: readonly O[];
  evaluations: ReadonlyMap<string, E>;
  onHover: (info: HoverInfo<O, E> | null) => void;
  onApply: (option: O) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((option) => {
        const evaluation = evaluations.get(option.id);
        const reason = option.disabledReason ?? evaluation?.refused;
        const errors = evaluation ? evaluation.newIssues.filter((issue) => issue.severity === 'error').length : 0;
        const disabled = Boolean(reason) || option.current;
        return (
          <button key={option.id} type="button" data-option-row={option.id} aria-disabled={disabled || undefined} aria-current={option.current ? 'true' : undefined}
            title={reason ?? option.detail}
            className={`rounded-full px-2 py-[2px] text-[11px] tabular-nums transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${option.current
              ? 'bg-violet-600 font-semibold text-white' : reason ? 'cursor-not-allowed bg-slate-50 text-slate-300' : errors
                ? 'bg-red-50 text-red-700 ring-1 ring-inset ring-red-200 hover:bg-red-100' : 'bg-slate-100 text-slate-700 hover:bg-violet-100 hover:text-violet-800'}`}
            onPointerEnter={() => onHover({ option, evaluation })}
            onPointerLeave={() => onHover(null)}
            onFocus={() => onHover({ option, evaluation })}
            onBlur={() => onHover(null)}
            onClick={() => (disabled ? undefined : onApply(option))}>
            {option.title}
            {errors && !option.current ? <span className="sr-only"> {errors} new error{errors === 1 ? '' : 's'}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** Arrow keys move between a list's option buttons. */
export function onListKey(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-option-row]')].filter((row) => row.offsetParent !== null);
  const index = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next = rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length];
  next?.focus();
  event.preventDefault();
  event.stopPropagation();
}

/** Screen pixels the pointer travels per step while a value is scrubbed. */
const SCRUB_PX_PER_STEP = 6;

/**
 * A number scrubbed by dragging sideways on its label, as in Figma or
 * Blender: a step per 6 px (Shift: five steps; Alt: one unit per pixel),
 * snapped to the step and kept within its limits. `onEnd` runs once a scrub
 * that changed it ends, after the last value has rendered.
 */
export function useScrub({ value, onChange, step, min, max, decimals = 0, onEnd }: {
  value: string;
  onChange: (value: string) => void;
  step: number;
  min: number;
  max: number;
  decimals?: number;
  onEnd?: () => void;
}) {
  const drag = useRef<{ x: number; start: number; moved: boolean } | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [ended, setEnded] = useState(0);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  useEffect(() => {
    if (ended > 0) onEndRef.current?.();
  }, [ended]);
  const handlers = {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const start = Number.parseFloat(value);
      if (!Number.isFinite(start)) return;
      drag.current = { x: event.clientX, start, moved: false };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const current = drag.current;
      if (!current) return;
      const dx = event.clientX - current.x;
      if (!current.moved && Math.abs(dx) < 3) return;
      if (!current.moved) {
        current.moved = true;
        setScrubbing(true);
      }
      const unit = 10 ** -decimals;
      const next = event.altKey
        ? clamp(Math.round((current.start + dx * unit) / unit) * unit, min, max)
        : clamp(Math.round((current.start + Math.round(dx / SCRUB_PX_PER_STEP) * step * (event.shiftKey ? 5 : 1)) / step) * step, min, max);
      onChange(decimals ? next.toFixed(decimals) : String(Math.round(next)));
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      const current = drag.current;
      drag.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      if (current?.moved) {
        setScrubbing(false);
        setEnded((count) => count + 1);
      }
    },
    onPointerCancel: () => {
      drag.current = null;
      setScrubbing(false);
    },
  };
  return { scrubbing, handlers };
}

/**
 * A number typed or nudged (± buttons, ↑ ↓; Shift for a fine step), Enter to
 * apply; with `scrubLabel`, a label inside it scrubs the number sideways and
 * `onScrubEnd` runs when a scrub ends.
 */
export function Stepper({ label, value, onChange, onEnter, step, fineStep, min, max, width = 'w-14', signed = false, scrubLabel, onScrubEnd }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  step: number;
  fineStep?: number;
  min: number;
  max: number;
  width?: string;
  /** Accept a minus sign (an offset, a level change). */
  signed?: boolean;
  /** A short label inside the field ("W", "D", "Ø") that scrubs the number when dragged sideways. */
  scrubLabel?: string;
  onScrubEnd?: () => void;
}) {
  const decimals = step < 1 ? 2 : 0;
  const scrub = useScrub({ value, onChange, step, min, max, decimals, ...(onScrubEnd ? { onEnd: onScrubEnd } : {}) });
  const bump = (delta: number) => {
    const current = Number.parseFloat(value);
    if (!Number.isFinite(current)) return;
    const next = clamp(Math.round((current + delta) / (fineStep ?? step)) * (fineStep ?? step), min, max);
    onChange(decimals ? next.toFixed(decimals) : String(Math.round(next)));
  };
  return (
    <span className="inline-flex items-center rounded-lg border border-slate-200 bg-white shadow-sm focus-within:border-violet-400 focus-within:ring-2 focus-within:ring-violet-100">
      {scrubLabel ? (
        <span className={`cursor-ew-resize select-none pl-1.5 text-[10.5px] font-semibold ${scrub.scrubbing ? 'text-violet-700' : 'text-slate-400 hover:text-violet-700'}`}
          title={`Drag sideways to change the ${label.toLowerCase()} (Shift: 5 steps; Alt: 1 mm)`} data-scrub={label} {...scrub.handlers}>
          {scrubLabel}
        </span>
      ) : null}
      <button type="button" className="px-1 py-0.5 text-slate-400 hover:text-violet-700" aria-label={`${label} smaller`} onClick={() => bump(-step)}><Minus size={11} /></button>
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        className={`${width} bg-transparent py-0.5 text-center text-[12px] font-medium tabular-nums text-slate-800 focus:outline-none`}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(signed ? /[^0-9.-]/g : /[^0-9.]/g, ''))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            onEnter();
            event.preventDefault();
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            bump((event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey && fineStep ? fineStep : step));
            event.preventDefault();
          }
          event.stopPropagation();
        }}
      />
      <button type="button" className="px-1 py-0.5 text-slate-400 hover:text-violet-700" aria-label={`${label} larger`} onClick={() => bump(step)}><Plus size={11} /></button>
    </span>
  );
}

export function ApplyButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      className="ml-auto shrink-0 rounded-lg bg-violet-600 px-2.5 py-[3px] text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none">
      Apply
    </button>
  );
}

/** A changed value's result on one line, and the button that applies it. */
export function ResultRow<E extends SegmentEvaluationLike>({ evaluation, result, onApply }: { evaluation: E; result: (evaluation: E) => ReactNode; onApply: () => void }) {
  return (
    <div className="mt-1 flex items-center gap-2 pl-[76px] text-[10.5px] text-slate-500">
      <span className="min-w-0 flex-1">{result(evaluation)}</span>
      <ApplyButton disabled={Boolean(evaluation.refused)} onClick={onApply} />
    </div>
  );
}

/**
 * One value of the piece, the designer's own: typed or nudged, judged as it
 * changes (its result on one line, refused with the reason when it cannot be
 * built), shown on the drawing while the pointer is on it, applied with Enter.
 */
export function ValueField<O extends SegmentOptionLike, E extends SegmentEvaluationLike>({ host, label, unit, current, min, max, step, fineStep, decimals = 0, hint, makeOption, testId, extra, signed, scrub = false }: {
  host: SegmentFieldHost<O, E>;
  label: string;
  unit: string;
  current: number;
  min: number;
  max: number;
  step: number;
  fineStep?: number;
  decimals?: number;
  hint?: string;
  makeOption: (value: number) => O | null;
  testId: string;
  extra?: ReactNode;
  signed?: boolean;
  /** Its label scrubs the value when dragged sideways (release applies it). */
  scrub?: boolean;
}) {
  const format = useCallback((value: number) => (decimals ? value.toFixed(decimals) : String(Math.round(value))), [decimals]);
  const [text, setText] = useState(() => format(current));
  useEffect(() => setText(format(current)), [current, format]);
  const parsed = Number.parseFloat(text);
  const valid = Number.isFinite(parsed) && parsed >= min - 1e-9 && parsed <= max + 1e-9;
  const value = valid ? Number(parsed.toFixed(decimals)) : null;
  const changed = value !== null && Math.abs(value - current) > 0.5 * 10 ** -decimals;
  const option = changed && value !== null ? makeOption(value) : null;
  const evaluation = option ? host.evaluate(option) : null;
  const apply = () => {
    if (option && evaluation && !evaluation.refused) host.onApply(option);
  };
  const [inside, setInside] = useState(false);
  const enter = () => {
    setInside(true);
    if (option && !evaluation?.refused) host.onPreview(option);
    if (option) host.onHover({ option, evaluation: evaluation ?? undefined });
  };
  const leave = () => {
    setInside(false);
    host.onPreview(null);
    host.onHover(null);
  };
  // While the pointer is on it, the drawing follows the value as it changes (typed, stepped or scrubbed).
  const hostRef = useRef(host);
  hostRef.current = host;
  const shown = option && !evaluation?.refused ? option : null;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    if (inside) hostRef.current.onPreview(shownRef.current);
  }, [inside, shown?.id]);
  const scrubbing = useScrub({ value: text, onChange: setText, step: fineStep ?? step, min, max, decimals, onEnd: apply });
  return (
    <div className="rounded-lg px-1 py-1" data-testid={testId} onPointerEnter={enter} onPointerLeave={leave} onFocus={enter} onBlur={leave}>
      <div className="flex items-center gap-2">
        {scrub ? (
          <span className={`w-[68px] shrink-0 cursor-ew-resize select-none text-[11px] font-medium ${scrubbing.scrubbing ? 'text-violet-700' : 'text-slate-500 hover:text-violet-700'}`}
            title={`Drag sideways to change the ${label.toLowerCase()} (Shift: 5 steps; Alt: 1 ${unit}); release applies it`} data-scrub={label} {...scrubbing.handlers}>
            {label} <span aria-hidden="true" className="text-[9px] text-slate-300">⇔</span>
          </span>
        ) : (
          <span className="w-[68px] shrink-0 text-[11px] font-medium text-slate-500">{label}</span>
        )}
        <Stepper label={label} value={text} onChange={setText} onEnter={apply} step={step} {...(fineStep ? { fineStep } : {})} min={min} max={max} signed={signed} />
        <span className="text-[10.5px] text-slate-400">{unit}</span>
        {extra}
      </div>
      {changed && evaluation ? <ResultRow evaluation={evaluation} result={host.result} onApply={apply} />
        : !valid ? <div className="mt-0.5 pl-[76px] text-[10.5px] text-red-600">{format(min)}–{format(max)} {unit}</div>
          : hint ? <div className="mt-0.5 pl-[76px] text-[10.5px] text-slate-400">{hint}</div> : null}
    </div>
  );
}

/** A small section of the Edit tab: a caption and its fields. */
export function EditBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{title}</div>
      {children}
    </div>
  );
}
