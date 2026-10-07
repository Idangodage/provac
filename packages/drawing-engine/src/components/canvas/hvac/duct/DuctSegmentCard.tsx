'use client';

/**
 * The segment card of a duct run, in either view. Point at a segment of a
 * selected run and, after a short rest, a peek card shows what it is, the air
 * it carries and its best two alternatives; click it and the card pins beside
 * it, a leader line from the card to the piece and a chip naming it on the
 * drawing. The pinned card keeps text to a minimum: a header, one strip of
 * figures, and three tabs —
 *
 *  - Edit: the segment's own values, typed or nudged (a size, an elbow's
 *    radius, a taper, a take-off's or an accessory's position, a runout's
 *    length, a terminal's neck and airflow), each shown on the drawing and
 *    judged before it is applied;
 *  - Swap: the same air another way, one line per option (its change in
 *    pressure and mass as chips, its badges as icons);
 *  - Add: accessories, and taking them out.
 *
 * Why an option is offered, what it would change and the rules it would break
 * appear on one line at the foot of the card while it is hovered; how the
 * segment is built and its issues sit behind ⓘ. One card per segment
 * whichever view shows it — the plan overlay and the 3D layer only report what
 * the pointer is on and where that piece is on screen. The card and its leader
 * follow the piece every frame (pan, zoom, orbit) by writing their transforms
 * directly; React renders only when the focus or the drawing changes. Hover
 * content follows WCAG 2.2 SC 1.4.13: it can be dismissed (Esc), the pointer can
 * move onto it, and it stays while the pointer is on the segment or the card.
 */
import { ArrowDownToLine, ChevronLeft, ChevronRight, Coins, Flag, Gauge, Info, Keyboard, Minus, Plus, Star, TriangleAlert, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import type { HvacElement } from '../../../../types';

import { DuctSegmentGlyph } from './DuctSegmentGlyph';
import { commitDuctSegmentEdit } from './ductEditController';
import { getDuctRunPlan, type DuctFabricationPlan } from './ductFabricationPlanner';
import { ductLegs } from './ductGeometry';
import { rectangularEquivalents, roundEquivalents, sameSectionSize } from './ductSectionEquivalents';
import { ductSegmentFigures, type DuctFigureStatus, type DuctSegmentFigures } from './ductSegmentFigures';
import {
  ductSegmentOptions,
  evaluateDuctSegmentOption,
  rankDuctOptions,
  scopeLegs,
  segmentOptionContext,
  type DuctOptionBadge,
  type DuctOptionEvaluation,
  type DuctOptionScope,
  type DuctSegmentOption,
  type DuctSegmentOptionContext,
} from './ductSegmentOptions';
import { useDuctSegmentUiStore, type DuctSegmentFocus } from './ductSegmentUiStore';
import { ductSegmentOf, neighbourSegment, sectionLabel, segmentIssues, type DuctSegment } from './ductSegments';
import type { DuctDesignSettings } from './ductSettings';
import { equivalentDiameterMm } from './ductSizing';
import { readDuctTerminalSpec } from './ductTerminals';
import { isRoundLeg, roundLeg, type DuctLeg, type DuctRunSpec } from './ductTypes';
import { placePopover, type ScreenRect } from './popoverPlacement';

/** Rest on a segment this long before its card peeks (ms); moving on with a card open is quicker. */
const PEEK_DELAY_MS = 260;
const PEEK_SWITCH_MS = 90;
/** A peek stays this long after the pointer leaves, so it can be reached. */
const PEEK_GRACE_MS = 240;
/** Quick swaps a peek offers. */
const PEEK_SWAPS = 2;
/** Option rows a tab shows before "more". */
const ROWS_SHOWN = 6;

const focusId = (focus: DuctSegmentFocus | null) => (focus ? `${focus.runId}|${focus.key}` : '');

const STATUS_DOT: Record<DuctFigureStatus, string> = { ok: 'bg-emerald-500', near: 'bg-amber-500', over: 'bg-red-500' };
const STATUS_TEXT: Record<DuctFigureStatus, string> = { ok: 'within the limit', near: 'near the limit', over: 'over the limit' };
const BADGES: Record<DuctOptionBadge, { icon: typeof Star; tone: string; label: string; title: string }> = {
  recommended: { icon: Star, tone: 'text-emerald-600 fill-emerald-500/20', label: 'Recommended', title: 'Recommended: the lowest life-cycle cost (first cost + fan energy) of the options that break no rule' },
  'lowest-pressure': { icon: Gauge, tone: 'text-sky-600', label: 'Lowest ΔP', title: 'Lowest pressure on the fan\'s index path' },
  'lowest-cost': { icon: Coins, tone: 'text-amber-600', label: 'Lowest cost', title: 'Lowest first cost (placeholder rates until the supplier\'s are entered)' },
  'saves-height': { icon: ArrowDownToLine, tone: 'text-indigo-600', label: 'Saves height', title: 'Needs 25 mm or more less of the ceiling void' },
};

type CardTab = 'edit' | 'swap' | 'add';
const TAB_TITLES: Record<CardTab, string> = { edit: 'Edit', swap: 'Swap', add: 'Add' };
/** The tab a designer last used for a kind of segment (this session). */
const LAST_TAB = new Map<string, CardTab>();

const number = (value: number, digits = 0) => value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (value: number, digits = 0) => `${value > 0 ? '+' : value < 0 ? '−' : '±'}${number(Math.abs(value), digits)}`;
const range = (span: { max: number; min: number }, digits: number) => (Math.abs(span.max - span.min) < 0.5 * 10 ** -digits
  ? number(span.max, digits)
  : `${number(span.max, digits)}–${number(span.min, digits)}`);
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function markRange(segment: DuctSegment): string {
  return segment.marks.length > 1 ? `${segment.marks[0]}…${segment.marks[segment.marks.length - 1]}` : segment.marks[0] ?? '';
}

interface CardDecor {
  leaderRef: RefObject<SVGSVGElement | null>;
  chipRef: RefObject<HTMLDivElement | null>;
}

/**
 * Keep a card beside its anchor every frame (no React render), writing its
 * transform directly; with `decor`, also the leader line from the card to the
 * piece and the chip naming it (above the piece, else below it).
 */
function useAnchoredCard(cardRef: RefObject<HTMLDivElement | null>, containerRef: RefObject<HTMLDivElement | null>, anchor: () => ScreenRect | null, active: boolean, decor?: CardDecor) {
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const decorRef = useRef(decor);
  decorRef.current = decor;
  useLayoutEffect(() => {
    if (!active) return undefined;
    let frame = 0;
    let last = '';
    // The card stays put while its anchor does: growing (the hover line at its foot) or shrinking never moves it under
    // the pointer. It is placed again when the anchor moves, or when it would run off the drawing.
    let held: { key: string; placed: ReturnType<typeof placePopover> } | null = null;
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
      const anchorKey = [local.left, local.top, local.right, local.bottom, host.width, host.height].map((value) => Math.round(value)).join(',');
      const fits = (at: { x: number; y: number }) => at.x + card.offsetWidth <= host.width - 2 && at.y + card.offsetHeight <= host.height - 2;
      if (!held || held.key !== anchorKey || !fits(held.placed)) {
        held = { key: anchorKey, placed: placePopover(local, { width: card.offsetWidth, height: card.offsetHeight }, { width: host.width, height: host.height }) };
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

/** Evaluate the options a few at a time (about 12 ms per slice), so the drawing stays responsive while the card fills in. */
function useOptionEvaluations(scene: readonly HvacElement[], settings: DuctDesignSettings, focus: DuctSegmentFocus, options: readonly DuctSegmentOption[]) {
  const [evaluations, setEvaluations] = useState<Map<string, DuctOptionEvaluation>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    const result = new Map<string, DuctOptionEvaluation>();
    let index = 0;
    let timer = 0;
    const step = () => {
      if (cancelled) return;
      const started = performance.now();
      while (index < options.length && performance.now() - started < 12) {
        const option = options[index]!;
        index += 1;
        result.set(option.id, evaluateDuctSegmentOption(scene, settings, focus.runId, focus.key, option));
      }
      setEvaluations(new Map(result));
      if (index < options.length) timer = window.setTimeout(step, 0);
    };
    timer = window.setTimeout(step, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [scene, settings, focus.runId, focus.key, options]);
  return evaluations;
}

// ---------------------------------------------------------------------------------------------------- small parts

/** The segment's air in one strip: airflow · velocity (against its limit) · pressure; the rest in tooltips. */
function FigureStrip({ figures }: { figures: DuctSegmentFigures | null }) {
  const flow = figures?.flow ?? null;
  if (!flow) {
    const why = !figures?.system ? 'This run is not on a unit\'s system.'
      : !figures.system.terminals ? 'The system reaches no air terminal yet.' : 'Give the unit or its terminals an airflow.';
    return <p className="px-3 pb-2 text-[11px] text-slate-400" data-testid="duct-segment-no-flow" title={why}>No airflow yet</p>;
  }
  const stat = (value: string, unit: string, title: string, dot?: string) => (
    <span className="inline-flex items-baseline gap-1" title={title}>
      {dot ? <span className={`h-1.5 w-1.5 shrink-0 self-center rounded-full ${dot}`} aria-hidden="true" /> : null}
      <span className="text-[13px] font-semibold tabular-nums text-slate-900">{value}</span>
      <span className="text-[10.5px] text-slate-400">{unit}</span>
    </span>
  );
  const system = figures?.system;
  return (
    <div className="flex items-center gap-x-3 px-3 pb-2" data-testid="duct-segment-figures">
      {stat(range(flow.airflowM3h, 0), 'm³/h', `Airflow ${range(flow.airflowM3h, 0)} m³/h (${flow.part}) · ${flow.terminals} terminal${flow.terminals === 1 ? '' : 's'}`)}
      {stat(range(flow.velocityMs, 1), 'm/s', `Velocity ${range(flow.velocityMs, 1)} m/s, ${STATUS_TEXT[flow.velocityStatus]} (${number(flow.limits.velocityMs, 1)} m/s for a ${flow.part})`, STATUS_DOT[flow.velocityStatus])}
      {stat(number(flow.totalPa, flow.totalPa < 10 ? 1 : 0), 'Pa', `Pressure ${number(flow.totalPa, 1)} Pa${flow.coefficient !== null ? ` · ζ ${number(flow.coefficient, 2)}` : ''} · friction ${number(flow.frictionPaPerM, 2)} Pa/m (${STATUS_TEXT[flow.frictionStatus]}, target ${number(flow.limits.frictionPaPerM, 2)})`)}
      {flow.onIndexPath ? (
        <span className="ml-auto inline-flex shrink-0 items-center rounded-full bg-amber-50 p-1 text-amber-600 ring-1 ring-inset ring-amber-200"
          title={`On the fan's index path${system?.indexPa ? ` (${number(system.indexPa)} Pa)` : ''}: the path the fan has to overcome runs through this segment`}>
          <Flag size={10} aria-hidden="true" /><span className="sr-only">On the index path</span>
        </span>
      ) : null}
    </div>
  );
}

/** What an option does, as chips: its change in pressure and mass, and any rule it would newly break. */
function DeltaChips({ evaluation }: { evaluation: DuctOptionEvaluation }) {
  const chips: ReactNode[] = [];
  const pressure = evaluation.deltaIndexPa ?? evaluation.deltaSegmentPa;
  if (pressure !== null && Math.abs(pressure) >= 0.05) {
    chips.push(<span key="dp" className={`rounded px-1 tabular-nums ${pressure < 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}
      title={evaluation.deltaIndexPa !== null ? 'Change on the fan\'s index path' : 'Change in this segment\'s loss'}>ΔP {signed(pressure, 1)}</span>);
  }
  if (Math.abs(evaluation.deltaMassKg) >= 0.05) {
    chips.push(<span key="kg" className="rounded bg-slate-100 px-1 tabular-nums text-slate-600" title="Change in galvanised sheet">{signed(evaluation.deltaMassKg, 1)} kg</span>);
  }
  const errors = evaluation.newIssues.filter((issue) => issue.severity === 'error');
  if (errors.length) {
    chips.push(
      <span key="err" className="inline-flex items-center gap-0.5 rounded bg-red-50 px-1 font-medium text-red-700"
        title={errors.map((issue) => `${issue.code}: ${issue.message}`).join('\n')}>
        <TriangleAlert size={10} aria-hidden="true" />{errors.length}
        <span className="sr-only"> new error{errors.length === 1 ? '' : 's'}</span>
      </span>,
    );
  }
  if (chips.length === 0) return null;
  return <span className="flex shrink-0 items-center gap-1 text-[10.5px]">{chips}</span>;
}

/** An option's whole result on one line: velocity, pressure, mass, height, and the rules it would break. */
function ResultLine({ evaluation }: { evaluation: DuctOptionEvaluation }) {
  if (evaluation.refused) return <span className="text-red-700">{evaluation.refused}</span>;
  const parts: ReactNode[] = [];
  if (evaluation.velocityMs !== null) {
    const status = evaluation.velocityStatus ?? 'ok';
    parts.push(<span key="v" className={status === 'over' ? 'text-red-700' : status === 'near' ? 'text-amber-700' : ''}>{number(evaluation.velocityMs, 1)} m/s</span>);
  }
  const pressure = evaluation.deltaIndexPa ?? evaluation.deltaSegmentPa;
  if (pressure !== null && Math.abs(pressure) >= 0.05) parts.push(<span key="p" className={pressure < 0 ? 'text-emerald-700' : 'text-amber-700'}>ΔP {signed(pressure, 1)} Pa</span>);
  if (Math.abs(evaluation.deltaMassKg) >= 0.05) parts.push(<span key="m">{signed(evaluation.deltaMassKg, 1)} kg</span>);
  if (evaluation.deltaOuterHeightMm !== null && Math.abs(evaluation.deltaOuterHeightMm) >= 5) {
    parts.push(<span key="h" className={evaluation.deltaOuterHeightMm < 0 ? 'text-emerald-700' : 'text-amber-700'}>{signed(evaluation.deltaOuterHeightMm)} mm high</span>);
  }
  const errors = evaluation.newIssues.filter((issue) => issue.severity === 'error').length;
  const warnings = evaluation.newIssues.length - errors;
  if (errors) parts.push(<span key="e" className="font-medium text-red-700">{errors} new error{errors === 1 ? '' : 's'}</span>);
  if (warnings) parts.push(<span key="w" className="text-amber-700">{warnings} new warning{warnings === 1 ? '' : 's'}</span>);
  return <span className="tabular-nums">{parts.map((part, index) => <span key={index}>{index ? ' · ' : ''}{part}</span>)}</span>;
}

interface HoverInfo {
  option: DuctSegmentOption;
  evaluation: DuctOptionEvaluation | undefined;
}

/** An option on one line: its picture, its name, its badges as icons, its change as chips. */
function OptionRow({ option, evaluation, badges, onHover, onApply }: {
  option: DuctSegmentOption;
  evaluation: DuctOptionEvaluation | undefined;
  badges: readonly DuctOptionBadge[];
  onHover: (info: HoverInfo | null) => void;
  onApply: (option: DuctSegmentOption) => void;
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
        <DuctSegmentGlyph glyph={option.glyph} className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-slate-800">{option.title}</span>
      {badges.map((badge) => {
        const Icon = BADGES[badge].icon;
        return (
          <span key={badge} className={`shrink-0 ${BADGES[badge].tone}`} title={BADGES[badge].title}>
            <Icon size={12} aria-hidden="true" /><span className="sr-only">{BADGES[badge].label}</span>
          </span>
        );
      })}
      {option.current ? <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-violet-600">current</span> : null}
      {!option.current && evaluation && !evaluation.refused ? <DeltaChips evaluation={evaluation} /> : null}
    </button>
  );
}

/** Quick picks as chips (taper angles, attenuator lengths, necks): each an option, applied with a click. */
function ChipRow({ options, evaluations, onHover, onApply }: {
  options: readonly DuctSegmentOption[];
  evaluations: ReadonlyMap<string, DuctOptionEvaluation>;
  onHover: (info: HoverInfo | null) => void;
  onApply: (option: DuctSegmentOption) => void;
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
function onListKey(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-option-row]')].filter((row) => row.offsetParent !== null);
  const index = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next = rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length];
  next?.focus();
  event.preventDefault();
  event.stopPropagation();
}

/** A number typed or nudged (± buttons, ↑ ↓; Shift for a fine step), Enter to apply. */
function Stepper({ label, value, onChange, onEnter, step, fineStep, min, max, width = 'w-14' }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  step: number;
  fineStep?: number;
  min: number;
  max: number;
  width?: string;
}) {
  const decimals = step < 1 ? 2 : 0;
  const bump = (delta: number) => {
    const current = Number.parseFloat(value);
    if (!Number.isFinite(current)) return;
    const next = clamp(Math.round((current + delta) / (fineStep ?? step)) * (fineStep ?? step), min, max);
    onChange(decimals ? next.toFixed(decimals) : String(Math.round(next)));
  };
  return (
    <span className="inline-flex items-center rounded-lg border border-slate-200 bg-white shadow-sm focus-within:border-violet-400 focus-within:ring-2 focus-within:ring-violet-100">
      <button type="button" className="px-1 py-0.5 text-slate-400 hover:text-violet-700" aria-label={`${label} smaller`} onClick={() => bump(-step)}><Minus size={11} /></button>
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        className={`${width} bg-transparent py-0.5 text-center text-[12px] font-medium tabular-nums text-slate-800 focus:outline-none`}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/[^0-9.]/g, ''))}
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

function ApplyButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      className="ml-auto shrink-0 rounded-lg bg-violet-600 px-2.5 py-[3px] text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none">
      Apply
    </button>
  );
}

/** A changed value's result on one line, and the button that applies it. */
function ResultRow({ evaluation, onApply }: { evaluation: DuctOptionEvaluation; onApply: () => void }) {
  return (
    <div className="mt-1 flex items-center gap-2 pl-[76px] text-[10.5px] text-slate-500">
      <span className="min-w-0 flex-1"><ResultLine evaluation={evaluation} /></span>
      <ApplyButton disabled={Boolean(evaluation.refused)} onClick={onApply} />
    </div>
  );
}

interface FieldHost {
  scene: readonly HvacElement[];
  settings: DuctDesignSettings;
  focus: DuctSegmentFocus;
  onPreview: (option: DuctSegmentOption | null) => void;
  onHover: (info: HoverInfo | null) => void;
  onApply: (option: DuctSegmentOption) => void;
}

/**
 * One value of the segment, the designer's own: typed or nudged, judged as it
 * changes (its result on one line, refused with the reason when it cannot be
 * built), shown on the drawing while the pointer is on it, applied with Enter.
 */
function ValueField({ host, label, unit, current, min, max, step, fineStep, decimals = 0, hint, makeOption, testId, extra }: {
  host: FieldHost;
  label: string;
  unit: string;
  current: number;
  min: number;
  max: number;
  step: number;
  fineStep?: number;
  decimals?: number;
  hint?: string;
  makeOption: (value: number) => DuctSegmentOption | null;
  testId: string;
  extra?: ReactNode;
}) {
  const format = useCallback((value: number) => (decimals ? value.toFixed(decimals) : String(Math.round(value))), [decimals]);
  const [text, setText] = useState(() => format(current));
  useEffect(() => setText(format(current)), [current, format]);
  const parsed = Number.parseFloat(text);
  const valid = Number.isFinite(parsed) && parsed >= min - 1e-9 && parsed <= max + 1e-9;
  const value = valid ? Number(parsed.toFixed(decimals)) : null;
  const changed = value !== null && Math.abs(value - current) > 0.5 * 10 ** -decimals;
  const option = changed && value !== null ? makeOption(value) : null;
  const evaluation = option ? evaluateDuctSegmentOption(host.scene, host.settings, host.focus.runId, host.focus.key, option) : null;
  const apply = () => {
    if (option && evaluation && !evaluation.refused) host.onApply(option);
  };
  const enter = () => {
    if (option && !evaluation?.refused) host.onPreview(option);
    if (option) host.onHover({ option, evaluation: evaluation ?? undefined });
  };
  const leave = () => {
    host.onPreview(null);
    host.onHover(null);
  };
  return (
    <div className="rounded-lg px-1 py-1" data-testid={testId} onPointerEnter={enter} onPointerLeave={leave} onFocus={enter} onBlur={leave}>
      <div className="flex items-center gap-2">
        <span className="w-[68px] shrink-0 text-[11px] font-medium text-slate-500">{label}</span>
        <Stepper label={label} value={text} onChange={setText} onEnter={apply} step={step} {...(fineStep ? { fineStep } : {})} min={min} max={max} />
        <span className="text-[10.5px] text-slate-400">{unit}</span>
        {extra}
      </div>
      {changed && evaluation ? <ResultRow evaluation={evaluation} onApply={apply} />
        : !valid ? <div className="mt-0.5 pl-[76px] text-[10.5px] text-red-600">{format(min)}–{format(max)} {unit}</div>
          : hint ? <div className="mt-0.5 pl-[76px] text-[10.5px] text-slate-400">{hint}</div> : null}
    </div>
  );
}

/** Equal-friction size of `section` in the other shape, at the void the duct has. */
function otherShape(section: DuctLeg, settings: DuctDesignSettings, voidHeightMm: number): DuctLeg {
  if (isRoundLeg(section)) {
    const rects = rectangularEquivalents(section.diameterMm!, { maxHeightMm: Math.min(voidHeightMm, section.diameterMm!), maxAspect: settings.aspectRatioAdvisory });
    return [...rects].sort((a, b) => Math.abs(a.widthMm / a.heightMm - 2) - Math.abs(b.widthMm / b.heightMm - 2))[0] ?? { widthMm: section.widthMm, heightMm: section.heightMm };
  }
  return roundEquivalents(section, settings.autoRoundSizesMm).atOrAbove ?? roundLeg(Math.round(equivalentDiameterMm(section)));
}

/** Type the size of a leg (or of every leg of its size), round or rectangular; see what it does, then apply. */
function SizeEditor({ host, segment, spec, voidHeightMm }: { host: FieldHost; segment: DuctSegment; spec: DuctRunSpec; voidHeightMm: number }) {
  const { scene, settings, focus } = host;
  const current = spec.legs[segment.legIndex]!;
  const [shape, setShape] = useState<'rect' | 'round'>(isRoundLeg(current) ? 'round' : 'rect');
  const [width, setWidth] = useState(String(Math.round(current.widthMm)));
  const [height, setHeight] = useState(String(Math.round(current.heightMm)));
  const [diameter, setDiameter] = useState(String(Math.round(current.diameterMm ?? equivalentDiameterMm(current))));
  const [scope, setScope] = useState<DuctOptionScope>('leg');
  const sameSize = scopeLegs(spec, segment.legIndex, 'size').length;
  const legs = scopeLegs(spec, segment.legIndex, scope);
  const section: DuctLeg | null = useMemo(() => {
    if (shape === 'round') {
      const d = Number.parseFloat(diameter);
      return Number.isFinite(d) && d >= 75 && d <= 2000 ? roundLeg(Math.round(d)) : null;
    }
    const w = Number.parseFloat(width);
    const h = Number.parseFloat(height);
    return Number.isFinite(w) && Number.isFinite(h) && w >= 50 && h >= 50 && w <= 4000 && h <= 2000 ? { widthMm: Math.round(w), heightMm: Math.round(h) } : null;
  }, [shape, width, height, diameter]);
  const option = useMemo<DuctSegmentOption | null>(() => (section && !sameSectionSize(section, current) && legs.length
    ? {
      id: `custom:${sectionLabel(section)}:${scope}`, group: 'size', glyph: isRoundLeg(section) ? 'round' : 'rect', title: sectionLabel(section), detail: 'as typed',
      edit: { kind: 'leg-section', runId: focus.runId, sections: legs.map((leg) => ({ leg, section })) },
    } : null), [section, current, legs, scope, focus.runId]);
  const evaluation = useMemo(() => (option ? evaluateDuctSegmentOption(scene, settings, focus.runId, focus.key, option) : null), [option, scene, settings, focus.runId, focus.key]);
  const switchShape = (next: 'rect' | 'round') => {
    if (next === shape) return;
    const base = section ?? current;
    const other = otherShape(base, settings, voidHeightMm);
    if (next === 'round') setDiameter(String(other.diameterMm ?? Math.round(equivalentDiameterMm(base))));
    else {
      setWidth(String(other.widthMm));
      setHeight(String(other.heightMm));
    }
    setShape(next);
  };
  const apply = () => {
    if (option && evaluation && !evaluation.refused) host.onApply(option);
  };
  return (
    <div className="rounded-lg px-1 py-1" data-testid="duct-segment-size"
      onPointerEnter={() => {
        if (option && !evaluation?.refused) host.onPreview(option);
        if (option) host.onHover({ option, evaluation: evaluation ?? undefined });
      }}
      onPointerLeave={() => {
        host.onPreview(null);
        host.onHover(null);
      }}>
      <div className="flex items-center gap-2">
        <span className="w-[68px] shrink-0 text-[11px] font-medium text-slate-500">Size</span>
        <span className="inline-flex rounded-lg bg-slate-100 p-0.5" role="radiogroup" aria-label="Shape">
          {(['rect', 'round'] as const).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={shape === value}
              className={`rounded-md px-2 py-[1px] text-[11px] font-medium transition-colors ${shape === value ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
              onClick={() => switchShape(value)}>{value === 'rect' ? '▭ Rect' : '◯ Round'}</button>
          ))}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 pl-[76px]">
        {shape === 'round' ? (
          <>
            <span className="text-[11px] text-slate-500">Ø</span>
            <Stepper label="Diameter" value={diameter} onChange={setDiameter} onEnter={apply} step={50} fineStep={10} min={75} max={2000} />
          </>
        ) : (
          <>
            <Stepper label="Width" value={width} onChange={setWidth} onEnter={apply} step={50} fineStep={10} min={50} max={4000} width="w-12" />
            <span className="text-[11px] text-slate-400">×</span>
            <Stepper label="Height" value={height} onChange={setHeight} onEnter={apply} step={50} fineStep={10} min={50} max={2000} width="w-12" />
          </>
        )}
        <span className="text-[10.5px] text-slate-400">mm</span>
      </div>
      {sameSize > 1 ? (
        <div className="mt-1 flex items-center gap-3 pl-[76px] text-[11px] text-slate-500" role="radiogroup" aria-label="Apply to">
          {(['leg', 'size'] as const).map((value) => (
            <label key={value} className="inline-flex cursor-pointer items-center gap-1">
              <input type="radio" name={`scope-${focus.runId}-${focus.key}`} checked={scope === value} onChange={() => setScope(value)} className="accent-violet-600" />
              {value === 'leg' ? 'This leg' : `All ${sameSize} of ${sectionLabel(current)}`}
            </label>
          ))}
        </div>
      ) : null}
      {evaluation ? <ResultRow evaluation={evaluation} onApply={apply} /> : null}
    </div>
  );
}

/** An elbow's inner radius: a slider of its ratio, and the ratio and the throat radius as numbers; release or Enter applies. */
function RadiusEditor({ host, plan, segment }: { host: FieldHost; plan: DuctFabricationPlan; segment: DuctSegment }) {
  const { scene, settings, focus } = host;
  const piece = plan.pieces[segment.pieceIndices[0]!]!;
  const elbow = piece.elbow;
  const node = segment.nodeIndex;
  const inPlane = elbow?.inPlaneMm ?? piece.widthMm;
  const now = elbow && inPlane > 0 ? Math.round((elbow.centrelineRadiusMm / inPlane) * 100) / 100 : 1;
  const [value, setValue] = useState(now);
  const [text, setText] = useState(now.toFixed(2));
  const [throatText, setThroatText] = useState(String(Math.max(0, Math.round(now * inPlane - inPlane / 2))));
  useEffect(() => {
    setValue(now);
    setText(now.toFixed(2));
    setThroatText(String(Math.max(0, Math.round(now * inPlane - inPlane / 2))));
  }, [now, inPlane]);
  if (!elbow || node === undefined || elbow.style === 'square-vaned') return null;
  const round = elbow.style === 'gored';
  const min = round ? 1 : 0.5;
  const ratioName = round ? 'R/D' : elbow.plane === 'vertical' ? 'R/H' : 'R/W';
  const override = plan.spec.nodeOverrides[String(node)] ?? {};
  const optionAt = (ratio: number): DuctSegmentOption => ({
    id: `tune:${ratio}`, group: 'tune', glyph: round ? 'elbow-gored' : 'elbow-radius', title: `${ratioName} ${ratio.toFixed(2)}`, detail: `inner radius: throat ${Math.max(0, Math.round(ratio * inPlane - inPlane / 2))} mm`,
    edit: { kind: 'node', runId: focus.runId, node, override: { ...override, ...(round ? {} : { elbowStyle: 'radius' as const }), centrelineRatio: ratio } },
  });
  const setRatio = (ratio: number, from: 'ratio' | 'throat' | 'slider') => {
    const next = Math.round(clamp(ratio, min, 3) * 100) / 100;
    setValue(next);
    if (from !== 'ratio') setText(next.toFixed(2));
    if (from !== 'throat') setThroatText(String(Math.max(0, Math.round(next * inPlane - inPlane / 2))));
  };
  const changed = Math.abs(value - now) > 0.001;
  const evaluation = changed ? evaluateDuctSegmentOption(scene, settings, focus.runId, focus.key, optionAt(value)) : null;
  const commit = () => {
    if (changed && evaluation && !evaluation.refused) host.onApply(optionAt(value));
  };
  const preview = (ratio: number) => {
    if (Math.abs(ratio - now) > 0.001) {
      host.onPreview(optionAt(ratio));
      host.onHover({ option: optionAt(ratio), evaluation: evaluateDuctSegmentOption(scene, settings, focus.runId, focus.key, optionAt(ratio)) });
    } else {
      host.onPreview(null);
      host.onHover(null);
    }
  };
  return (
    <div className="rounded-lg px-1 py-1" data-testid="duct-segment-tune" onPointerLeave={() => { host.onPreview(null); host.onHover(null); }}>
      <div className="flex items-center gap-2">
        <span className="w-[68px] shrink-0 text-[11px] font-medium text-slate-500">Inner radius</span>
        <input
          type="range" min={min} max={2} step={0.05} value={Math.min(value, 2)} aria-label={`Elbow ${ratioName}`}
          aria-valuetext={`throat radius ${throatText} millimetres, ${ratioName} ${value.toFixed(2)}`}
          className="h-1.5 min-w-0 flex-1 cursor-pointer accent-violet-600"
          onChange={(event) => {
            const next = Number.parseFloat(event.target.value);
            setRatio(next, 'slider');
            preview(next);
          }}
          onPointerUp={commit}
          onKeyUp={(event) => {
            if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End' || event.key === 'PageUp' || event.key === 'PageDown') commit();
          }}
          onKeyDown={(event) => event.stopPropagation()}
        />
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 pl-[76px]">
        <Stepper label={`${ratioName} ratio`} value={text} min={min} max={3} step={0.05}
          onChange={(next) => {
            setText(next);
            const ratio = Number.parseFloat(next);
            if (Number.isFinite(ratio) && ratio >= min && ratio <= 3) {
              setRatio(ratio, 'ratio');
              preview(Math.round(ratio * 100) / 100);
            }
          }} onEnter={commit} width="w-11" />
        <span className="text-[10.5px] text-slate-400">{ratioName}</span>
        <Stepper label="Throat radius" value={throatText} min={0} max={Math.round(3 * inPlane - inPlane / 2)} step={25} fineStep={5}
          onChange={(next) => {
            setThroatText(next);
            const throat = Number.parseFloat(next);
            if (Number.isFinite(throat) && inPlane > 0) {
              const ratio = (throat + inPlane / 2) / inPlane;
              if (ratio >= min && ratio <= 3) {
                setRatio(ratio, 'throat');
                preview(Math.round(ratio * 100) / 100);
              }
            }
          }} onEnter={commit} width="w-11" />
        <span className="text-[10.5px] text-slate-400">mm</span>
      </div>
      {evaluation ? <ResultRow evaluation={evaluation} onApply={commit} />
        : <div className="mt-0.5 pl-[76px] text-[10.5px] text-slate-400">{round ? 'R/D 1.5 is SMACNA Table 3-1' : 'R/W 1.5 is SMACNA RE1; under 1.0 only up to 5 m/s'}</div>}
    </div>
  );
}

/** A small section of the Edit tab: a caption and its fields. */
function EditBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{title}</div>
      {children}
    </div>
  );
}

/** The Edit tab: the segment's own values, by kind. */
function EditPanel({ host, plan, segment, context, options, evaluations }: {
  host: FieldHost;
  plan: DuctFabricationPlan;
  segment: DuctSegment;
  context: DuctSegmentOptionContext;
  options: readonly DuctSegmentOption[];
  evaluations: ReadonlyMap<string, DuctOptionEvaluation>;
}): ReactNode {
  const { scene, settings, focus } = host;
  const spec = plan.spec;
  const editable = !spec.locked && !spec.legacy;
  if (!editable) return null;
  const runId = focus.runId;
  const blocks: ReactNode[] = [];
  const chips = (prefix: string) => options.filter((option) => option.id.startsWith(prefix));
  const chipRow = (prefix: string) => <ChipRow options={chips(prefix)} evaluations={evaluations} onHover={host.onHover} onApply={host.onApply} />;
  const kind = segment.kind;
  if (kind === 'straight' || kind === 'riser') {
    blocks.push(<SizeEditor key={`size|${sectionLabel(spec.legs[segment.legIndex] ?? { widthMm: 0, heightMm: 0 })}`} host={host} segment={segment} spec={spec} voidHeightMm={context.voidHeightMm} />);
  }
  if (kind === 'elbow') blocks.push(<RadiusEditor key="radius" host={host} plan={plan} segment={segment} />);
  if (kind === 'transition') {
    const node = segment.legIndex;
    const override = spec.nodeOverrides[String(node)] ?? {};
    const project = settings.transitionTaperDeg;
    const now = override.taperDeg ?? project;
    blocks.push(
      <EditBlock key="taper" title="Taper">
        <div className="px-1">{chipRow('taper:')}</div>
        <ValueField host={host} label="Custom" unit="° a side" current={now} min={5} max={45} step={1} testId="duct-segment-taper"
          hint="gentler is longer and loses less (SMACNA Fig. 2-7)"
          makeOption={(value) => ({
            id: `taper-custom:${value}`, group: 'tune', glyph: 'taper', title: `${value}° a side`, detail: 'a taper of your own',
            edit: { kind: 'node', runId, node, override: { ...override, taperDeg: value === project ? undefined : value } },
          })} />
      </EditBlock>,
    );
  }
  if (kind === 'takeoff' && spec.start.kind === 'tap') {
    const start = spec.start;
    const parent = scene.find((element) => element.id === start.parentRunId);
    const parentSpec = parent ? getDuctRunPlan(parent, scene, settings)?.spec : null;
    const leg = parentSpec ? ductLegs(parentSpec)[start.legIndex] : undefined;
    if (leg) {
      blocks.push(
        <ValueField key="station" host={host} label="Position" unit="mm" current={start.stationMm} min={0} max={Math.round(leg.lengthMm)} step={50} fineStep={10}
          testId="duct-segment-station" hint={`along leg ${start.legIndex + 1} of the main (0–${Math.round(leg.lengthMm)} mm)`}
          makeOption={(value) => ({
            id: `tap-station:${value}`, group: 'tune', glyph: 'tap-tee', title: `${value} mm along the main`, detail: 'the take-off moved; its branch keeps its end',
            edit: { kind: 'tap-station', runId, stationMm: value },
          })} />,
      );
    }
  }
  if (segment.key.startsWith('inline:')) {
    const id = segment.key.slice('inline:'.length);
    const item = spec.inline?.find((candidate) => candidate.id === id);
    const leg = item ? ductLegs(spec)[item.legIndex] : undefined;
    if (item && leg) {
      blocks.push(
        <ValueField key="position" host={host} label="Position" unit="mm" current={item.stationMm} min={0} max={Math.round(leg.lengthMm)} step={50} fineStep={10}
          testId="duct-segment-position" hint={`its centre along leg ${item.legIndex + 1} (0–${Math.round(leg.lengthMm)} mm)`}
          makeOption={(value) => ({
            id: `inline-move:${id}:${value}`, group: 'tune', glyph: item.kind === 'damper' ? 'damper' : item.kind, title: `${value} mm along the leg`, detail: 'moved along its leg',
            edit: { kind: 'inline-move', runId, id, stationMm: value },
          })} />,
      );
      if (item.kind === 'attenuator') {
        blocks.push(
          <EditBlock key="length" title="Length">
            <div className="px-1">{chipRow('attenuator:')}</div>
            <ValueField host={host} label="Custom" unit="mm" current={item.lengthMm ?? 900} min={300} max={3000} step={50} fineStep={10} testId="duct-segment-length"
              hint="longer: more attenuation and loss"
              makeOption={(value) => ({
                id: `inline-length:${id}:${value}`, group: 'tune', glyph: 'attenuator', title: `${value} mm`, detail: 'an attenuator of your own length',
                edit: { kind: 'inline-length', runId, id, lengthMm: value },
              })} />
          </EditBlock>,
        );
      }
      if (item.kind === 'access-door') {
        const door = plan.pieces.find((piece) => piece.inlineId === id)?.accessDoor?.sizeMm ?? item.doorMm ?? 300;
        blocks.push(
          <ValueField key="door" host={host} label="Door" unit="mm □" current={door} min={100} max={600} step={50} fineStep={10} testId="duct-segment-door"
            makeOption={(value) => ({
              id: `inline-door:${id}:${value}`, group: 'tune', glyph: 'access-door', title: `${value}×${value} door`, detail: 'a door of your own size',
              edit: { kind: 'inline-door', runId, id, doorMm: value },
            })} />,
        );
      }
    }
  }
  if (kind === 'flex') {
    const flex = plan.pieces[segment.pieceIndices[0]!];
    if (flex && spec.path.length >= 3) {
      blocks.push(
        <ValueField key="flex" host={host} label="Length" unit="mm" current={Math.round(flex.lengthMm)} min={300} max={3000} step={50} fineStep={10}
          testId="duct-segment-flex" hint={`SMACNA S3.23: as short as practical (≤ ${Math.round(settings.flexMaxLengthMm)} mm here)`}
          makeOption={(value) => ({
            id: `runout-length:${value}`, group: 'tune', glyph: 'flex', title: `${value} mm runout`, detail: 'the rigid duct runs on or stops short',
            edit: { kind: 'runout-length', runId, flexMm: value },
          })} />,
      );
    }
  }
  // The terminal at the run's end: its neck (quick picks) and its design airflow.
  const end = spec.end;
  const onTerminalEnd = end.kind === 'terminal' && (kind === 'flex' || (!end.flex && segment.legIndex === spec.legs.length - 1 && (kind === 'straight' || kind === 'riser')));
  if (onTerminalEnd && end.kind === 'terminal') {
    const terminal = scene.find((element) => element.id === end.terminalId);
    const terminalSpec = terminal ? readDuctTerminalSpec(terminal) : null;
    if (terminal && terminalSpec) {
      const share = context.figures?.flow?.airflowM3h.min ?? 0;
      const designed = terminalSpec.designAirflowM3h ?? null;
      const terminalId = terminal.id;
      blocks.push(
        <EditBlock key="terminal" title={`Terminal ${terminal.label || ''}`.trim()}>
          <div className="flex items-center gap-2 px-1">
            <span className="w-[68px] shrink-0 text-[11px] font-medium text-slate-500">Neck</span>
            {chipRow('neck:')}
          </div>
          <ValueField host={host} label="Airflow" unit="m³/h" current={Math.round(designed ?? share)} min={10} max={10000} step={10} fineStep={5} testId="duct-segment-airflow"
            hint={designed ? 'its design airflow' : 'an equal share of the system airflow'}
            extra={designed ? (
              <button type="button" className="rounded-md px-1.5 text-[10.5px] text-slate-500 hover:bg-slate-100 hover:text-slate-800" title="Back to an equal share of the system airflow"
                onClick={() => host.onApply({ id: 'airflow:share', group: 'tune', glyph: 'terminal', title: 'Shared airflow', detail: 'an equal share', edit: { kind: 'terminal', terminalId, airflowM3h: null } })}>
                Share
              </button>
            ) : null}
            makeOption={(value) => ({
              id: `airflow:${value}`, group: 'tune', glyph: 'terminal', title: `${value} m³/h`, detail: 'its design airflow',
              edit: { kind: 'terminal', terminalId, airflowM3h: value },
            })} />
        </EditBlock>,
      );
    }
  }
  if (blocks.length === 0) return null;
  return <div className="space-y-2">{blocks}</div>;
}

// ---------------------------------------------------------------------------------------------------- the card

function SegmentCard({ variant, focus, scene, settings, resolveAnchor, containerRef, onPointerEnter, onPointerLeave, onApply }: {
  variant: 'peek' | 'pinned';
  focus: DuctSegmentFocus;
  scene: HvacElement[];
  settings: DuctDesignSettings;
  resolveAnchor: (focus: DuctSegmentFocus) => ScreenRect | null;
  containerRef: RefObject<HTMLDivElement | null>;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onApply: (focus: DuctSegmentFocus, option: DuctSegmentOption, evaluation: DuctOptionEvaluation | undefined) => void;
}) {
  const element = scene.find((candidate) => candidate.id === focus.runId);
  const plan = element ? getDuctRunPlan(element, scene, settings) : null;
  const segment = plan ? ductSegmentOf(plan, focus.key) : null;
  const figures = useMemo(() => (segment ? ductSegmentFigures(scene, settings, focus.runId, focus.key) : null), [scene, settings, focus.runId, focus.key, segment]);
  const issues = useMemo(() => (plan && segment ? segmentIssues(plan, focus.key).filter((issue) => issue.severity !== 'info') : []), [plan, segment, focus.key]);
  const context = useMemo(() => (segment ? segmentOptionContext(scene, settings, focus.runId, focus.key) : null), [scene, settings, focus.runId, focus.key, segment]);
  const options = useMemo(() => (segment ? ductSegmentOptions(scene, settings, focus.runId, focus.key) : []), [scene, settings, focus.runId, focus.key, segment]);
  const evaluations = useOptionEvaluations(scene, settings, focus, options);
  const badges = useMemo(() => rankDuctOptions(options, evaluations), [options, evaluations]);
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [moreRows, setMoreRows] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const leaderRef = useRef<SVGSVGElement | null>(null);
  const chipRef = useRef<HTMLDivElement | null>(null);
  const pinned = variant === 'pinned';
  useAnchoredCard(cardRef, containerRef, () => resolveAnchor(focus), Boolean(segment), pinned ? { leaderRef, chipRef } : undefined);
  const pin = useDuctSegmentUiStore((state) => state.pin);
  const unpin = useDuctSegmentUiStore((state) => state.unpin);
  const preview = useCallback((option: DuctSegmentOption | null) => {
    const store = useDuctSegmentUiStore.getState();
    if (!option) {
      if (store.preview) store.setPreview(null);
      return;
    }
    const evaluation = evaluations.get(option.id) ?? evaluateDuctSegmentOption(scene, settings, focus.runId, focus.key, option);
    store.setPreview(evaluation.refused || evaluation.updates.length === 0 ? null : { optionId: option.id, updates: evaluation.updates });
  }, [evaluations, scene, settings, focus.runId, focus.key]);
  // Hovering an option (a row, a chip, a field) explains it at the card's foot, and shows it on the drawing when it can be built.
  const hover = useCallback((info: HoverInfo | null) => {
    setHoverInfo(info);
    if (!info) {
      preview(null);
      return;
    }
    const reason = info.option.disabledReason ?? info.evaluation?.refused;
    preview(reason || info.option.current ? null : info.option);
  }, [preview]);
  // A card closing (or turning to another segment) leaves no preview behind.
  useEffect(() => () => {
    if (useDuctSegmentUiStore.getState().preview) useDuctSegmentUiStore.getState().setPreview(null);
  }, [focus.runId, focus.key]);
  const swaps = useMemo(() => options.filter((option) => option.group === 'size' || option.group === 'swap' || option.id.startsWith('face:')), [options]);
  const accessories = useMemo(() => options.filter((option) => option.group === 'accessory'), [options]);
  const editContent = plan && segment && context
    ? EditPanel({ host: { scene, settings, focus, onPreview: preview, onHover: hover, onApply: (option) => apply(option) }, plan, segment, context, options, evaluations })
    : null;
  const tabs = useMemo(() => {
    const list: CardTab[] = [];
    if (editContent) list.push('edit');
    if (swaps.length) list.push('swap');
    if (accessories.length) list.push('add');
    return list;
  }, [editContent, swaps.length, accessories.length]);
  const kindKey = segment?.kind ?? '';
  const [tab, setTab] = useState<CardTab | null>(null);
  const activeTab: CardTab | null = tab && tabs.includes(tab) ? tab
    : (LAST_TAB.get(kindKey) && tabs.includes(LAST_TAB.get(kindKey)!) ? LAST_TAB.get(kindKey)! : tabs.includes('swap') ? 'swap' : tabs[0] ?? null);
  if (!plan || !segment || !context) return null;
  const service = plan.spec.service;
  const step = (direction: -1 | 1) => {
    const next = neighbourSegment(plan, focus.key, direction);
    if (next) pin({ runId: focus.runId, key: next.key, anchorMark: next.marks[0] ?? null, view: focus.view });
  };
  function apply(option: DuctSegmentOption) {
    setHoverInfo(null);
    onApply(focus, option, evaluations.get(option.id));
  }
  const chooseTab = (next: CardTab) => {
    setTab(next);
    LAST_TAB.set(kindKey, next);
    setMoreRows(false);
  };
  // The peek's quick swaps: those that break no rule, the recommended first, then by life-cycle cost.
  const quick = swaps.filter((option) => {
    const evaluation = evaluations.get(option.id);
    return !option.current && !option.disabledReason && evaluation && !evaluation.refused && !evaluation.newIssues.some((issue) => issue.severity === 'error');
  })
    .sort((a, b) => {
      const ra = badges.get(a.id)?.includes('recommended') ? -1 : 0;
      const rb = badges.get(b.id)?.includes('recommended') ? -1 : 0;
      if (ra !== rb) return ra - rb;
      return (evaluations.get(a.id)?.deltaLifeCycleCost ?? 0) - (evaluations.get(b.id)?.deltaLifeCycleCost ?? 0);
    }).slice(0, PEEK_SWAPS);
  const construction = figures?.construction ?? null;
  const rows = (list: readonly DuctSegmentOption[], limit: boolean) => {
    const shown = limit && !moreRows ? list.slice(0, ROWS_SHOWN) : list;
    return (
      <>
        {shown.map((option) => (
          <OptionRow key={option.id} option={option} evaluation={evaluations.get(option.id)} badges={badges.get(option.id) ?? []} onHover={hover} onApply={apply} />
        ))}
        {limit && list.length > ROWS_SHOWN && !moreRows ? (
          <button type="button" className="w-full rounded-lg px-2 py-1 text-left text-[11px] font-medium text-violet-700 hover:bg-violet-50" onClick={() => setMoreRows(true)}>
            {list.length - ROWS_SHOWN} more…
          </button>
        ) : null}
      </>
    );
  };
  const hoverReason = hoverInfo ? hoverInfo.option.disabledReason ?? hoverInfo.evaluation?.refused : null;
  const hoverNotes = hoverInfo?.evaluation && !hoverInfo.evaluation.refused ? hoverInfo.evaluation.notes : [];
  return (
    <>
      {pinned ? (
        <>
          <svg ref={leaderRef} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" style={{ visibility: 'hidden', zIndex: 1 }}
            aria-hidden="true" data-testid="duct-segment-leader">
            <line stroke="#7c3aed" strokeWidth={1.5} strokeLinecap="round" />
            <circle data-attach r={2.5} fill="#7c3aed" />
            <circle data-pin r={4.5} fill="#7c3aed" stroke="#ffffff" strokeWidth={2} />
          </svg>
          <div ref={chipRef} data-testid="duct-segment-chip"
            className="pointer-events-none absolute left-0 top-0 whitespace-nowrap rounded-full bg-violet-600 px-2 py-[2px] text-[10.5px] font-semibold text-white shadow-md ring-2 ring-white"
            style={{ visibility: 'hidden', zIndex: 1 }}>
            {markRange(segment)} · {segment.size}
          </div>
        </>
      ) : null}
      <div
        ref={cardRef}
        role="dialog"
        aria-label={`${segment.title} ${segment.size}, ${markRange(segment)}`}
        data-testid={pinned ? 'duct-segment-card' : 'duct-segment-peek'}
        data-segment-key={focus.key}
        data-segment-run={focus.runId}
        // The 3D layer leaves pointer events on this card to it.
        data-pipe-edit-gizmo="duct-segment"
        className={`pointer-events-auto absolute left-0 top-0 flex max-h-[min(72vh,560px)] flex-col ${pinned ? 'w-[320px]' : 'w-[272px]'} overflow-hidden rounded-2xl border border-slate-200/80 bg-white/95 text-slate-700 shadow-[0_18px_48px_-16px_rgba(15,23,42,0.38)] backdrop-blur-md`}
        style={{ visibility: 'hidden', zIndex: pinned ? 2 : 3 }}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        {/* Header: what it is, where it is in the run. */}
        <div className="flex items-start gap-2 px-3 pt-2.5">
          <span className={`mt-[3px] flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${service === 'return' ? 'bg-teal-50 text-teal-600' : 'bg-blue-50 text-blue-600'}`} aria-hidden="true">
            <DuctSegmentGlyph glyph={segmentGlyph(segment)} className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-semibold text-slate-900">{segment.title}</span>
              <span className="shrink-0 rounded-md bg-violet-50 px-1 py-[1px] font-mono text-[10px] text-violet-700">{markRange(segment)}</span>
            </div>
            <div className="truncate text-[11.5px] text-slate-500" title={segment.detail}>{segment.size}{segment.detail ? ` · ${segment.detail}` : ''}</div>
          </div>
          {pinned ? (
            <div className="-mr-1 flex shrink-0 items-center text-slate-400">
              {issues.length ? (
                <button type="button" className="mr-0.5 inline-flex items-center gap-0.5 rounded-md bg-red-50 px-1 py-[1px] text-[10.5px] font-semibold text-red-700 hover:bg-red-100"
                  aria-label={`${issues.length} issue${issues.length === 1 ? '' : 's'}`} title="Its issues" onClick={() => setInfoOpen(true)}>
                  <TriangleAlert size={11} aria-hidden="true" />{issues.length}
                </button>
              ) : null}
              <button type="button" className={`rounded-md p-1 hover:bg-slate-100 hover:text-slate-700 ${infoOpen ? 'bg-slate-100 text-slate-700' : ''}`}
                aria-label="How it is built" aria-expanded={infoOpen} title="How it is built" onClick={() => setInfoOpen((open) => !open)}><Info size={13} /></button>
              <button type="button" className="rounded-md p-1 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30" aria-label="Previous segment" title="Previous segment ( [ )"
                disabled={!neighbourSegment(plan, focus.key, -1)} onClick={() => step(-1)}><ChevronLeft size={14} /></button>
              <button type="button" className="rounded-md p-1 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30" aria-label="Next segment" title="Next segment ( ] )"
                disabled={!neighbourSegment(plan, focus.key, 1)} onClick={() => step(1)}><ChevronRight size={14} /></button>
              <button type="button" className="rounded-md p-1 hover:bg-slate-100 hover:text-slate-700" aria-label="Close" title="Close (Esc)" onClick={unpin}><X size={14} /></button>
            </div>
          ) : null}
        </div>
        <div className="pt-1.5"><FigureStrip figures={figures} /></div>
        {pinned ? (
          <>
            {/* How it is built, and its issues: behind ⓘ (kept in the page for assistive technology). */}
            <div className="mx-3 mb-2 space-y-1 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-600" data-testid="duct-segment-info" hidden={!infoOpen}>
              {construction ? (
                <div>
                  GI {construction.sheetMm !== null ? `${construction.sheetMm.toFixed(2)} mm (${construction.gauge})` : '—'} · {construction.joint} · {construction.seam}
                  {construction.insulationMm > 0 ? ` · NBR ${Math.round(construction.insulationMm)}` : ''} · {construction.pressureClassPa} Pa class
                </div>
              ) : null}
              {figures ? (
                <div>
                  {figures.fabrication.pieces} piece{figures.fabrication.pieces === 1 ? '' : 's'} · {(figures.fabrication.lengthMm / 1000).toFixed(2)} m
                  {figures.fabrication.areaM2 > 0 ? ` · ${figures.fabrication.areaM2.toFixed(2)} m² · ${figures.fabrication.massKg.toFixed(1)} kg` : ''}
                </div>
              ) : null}
              {figures?.system ? <div>{figures.system.unitLabel ?? 'unit'} {figures.system.service}{figures.system.airflowM3h ? ` · ${number(figures.system.airflowM3h)} m³/h` : ''}</div> : null}
              {issues.length ? (
                <ul className="space-y-0.5 pt-0.5" data-testid="duct-segment-issues">
                  {issues.map((issue, index) => (
                    <li key={index} className={issue.severity === 'error' ? 'text-red-700' : 'text-amber-700'}>{issue.code}: {issue.message}</li>
                  ))}
                </ul>
              ) : null}
              <div className="flex items-center gap-1 pt-0.5 text-[10.5px] text-slate-400">
                <Keyboard size={11} aria-hidden="true" />[ ] previous / next segment · ↑ ↓ options · Enter applies · Esc closes
              </div>
            </div>
            {tabs.length ? (
              <div className="mx-3 mb-1.5 flex rounded-xl bg-slate-100 p-0.5" role="tablist" aria-label="Segment options">
                {tabs.map((value) => (
                  <button key={value} type="button" role="tab" aria-selected={activeTab === value} data-segment-tab={value}
                    className={`flex-1 rounded-lg px-2 py-[3px] text-[11.5px] font-semibold transition-colors ${activeTab === value ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                    onClick={() => chooseTab(value)}>
                    {TAB_TITLES[value]}
                    {value === 'swap' ? <span className="ml-1 text-[10.5px] font-medium text-slate-400">{swaps.length}</span> : null}
                    {value === 'add' ? <span className="ml-1 text-[10.5px] font-medium text-slate-400">{accessories.length}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
              <div role="tabpanel" data-tab-panel="edit" hidden={activeTab !== 'edit'} data-testid="duct-segment-edit" onKeyDown={onListKey}>{editContent}</div>
              <div role="tabpanel" data-tab-panel="swap" hidden={activeTab !== 'swap'} data-testid="duct-segment-swaps" onKeyDown={onListKey}>{rows(swaps, true)}</div>
              <div role="tabpanel" data-tab-panel="add" hidden={activeTab !== 'add'} data-testid="duct-segment-accessories" onKeyDown={onListKey}>{rows(accessories, false)}</div>
            </div>
            {/* What the option under the pointer is, does and changes — one line or two, only while it is pointed at. */}
            {hoverInfo ? (
              <div className="border-t border-slate-100 bg-slate-50/80 px-3 py-1.5 text-[11px] leading-snug" aria-live="polite" data-testid="duct-segment-hover">
                <div className={hoverReason ? 'text-red-700' : 'text-slate-600'}>{hoverReason ?? hoverInfo.option.detail}</div>
                {!hoverReason && hoverInfo.evaluation ? <div className="text-slate-500"><ResultLine evaluation={hoverInfo.evaluation} /></div> : null}
                {hoverNotes.length ? (
                  <div className="line-clamp-2 text-violet-800" data-testid="duct-segment-notes" title={hoverNotes.join(' · ')}>
                    <span className="font-medium">Also changes: </span>{hoverNotes.join(' · ')}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          quick.length ? (
            <div className="border-t border-slate-100 px-1.5 py-1" data-testid="duct-segment-quick" onKeyDown={onListKey}>
              {quick.map((option) => (
                <OptionRow key={option.id} option={option} evaluation={evaluations.get(option.id)} badges={badges.get(option.id) ?? []} onHover={hover} onApply={apply} />
              ))}
            </div>
          ) : null
        )}
      </div>
    </>
  );
}

/** The picture in a card's header: the segment's kind. */
function segmentGlyph(segment: DuctSegment): Parameters<typeof DuctSegmentGlyph>[0]['glyph'] {
  switch (segment.kind) {
    case 'elbow': return segment.round ? 'elbow-gored' : 'elbow-radius';
    case 'transition': return 'taper';
    case 'takeoff': return 'tap-spin';
    case 'damper': return 'damper';
    case 'connector': return 'connector';
    case 'fire-damper': return 'fire-damper';
    case 'end-cap': return 'cap';
    case 'flex': return 'flex';
    case 'split': return 'split-y';
    case 'access-door': return 'access-door';
    case 'attenuator': return 'attenuator';
    case 'plenum': return 'rect';
    default: return segment.round ? 'round' : 'rect';
  }
}

export interface DuctSegmentCardLayerProps {
  enabled: boolean;
  hvacElements: HvacElement[];
  settings: DuctDesignSettings;
  selectedIds: string[];
  /** Client rectangle of a focused segment's anchor piece (and a point on it), or null when it is off screen or gone. */
  resolveAnchor: (focus: DuctSegmentFocus) => ScreenRect | null;
}

export function DuctSegmentCardLayer({ enabled, hvacElements, settings, selectedIds, resolveAnchor }: DuctSegmentCardLayerProps) {
  const hovered = useDuctSegmentUiStore((state) => state.hovered);
  const pinned = useDuctSegmentUiStore((state) => state.pinned);
  const unpin = useDuctSegmentUiStore((state) => state.unpin);
  const pin = useDuctSegmentUiStore((state) => state.pin);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [peek, setPeek] = useState<DuctSegmentFocus | null>(null);
  const [dismissed, setDismissed] = useState('');
  const overPeekRef = useRef(false);
  /** Where the card should go once an applied option has re-planned the run (its segment may have changed key). */
  const afterApplyRef = useRef<{ focus: DuctSegmentFocus; legIndex: number } | null>(null);
  const peekOpen = peek !== null;

  // Hover intent: a short rest before a card peeks; leaving gives a moment to reach the card.
  useEffect(() => {
    if (!enabled) {
      setPeek(null);
      return undefined;
    }
    const onPinned = hovered && pinned && pinned.runId === hovered.runId && pinned.key === hovered.key;
    if (hovered && !onPinned && focusId(hovered) !== dismissed) {
      const timer = window.setTimeout(() => setPeek(hovered), peekOpen ? PEEK_SWITCH_MS : PEEK_DELAY_MS);
      return () => window.clearTimeout(timer);
    }
    if (!hovered && dismissed) setDismissed('');
    const timer = window.setTimeout(() => {
      if (!overPeekRef.current || onPinned) setPeek(null);
    }, onPinned ? 0 : PEEK_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, hovered, pinned, dismissed, peekOpen]);

  // A pinned card closes with its run: deselected, deleted, or another tool taken. Judged when the selection changes (or
  // the tool), so a card pinned by the same click that selects its run is never closed before that selection arrives.
  const selectionRef = useRef(selectedIds);
  useEffect(() => {
    const selectionChanged = selectionRef.current !== selectedIds;
    selectionRef.current = selectedIds;
    if (pinned && (!enabled || (selectionChanged && !selectedIds.includes(pinned.runId)))) unpin();
  }, [enabled, pinned, selectedIds, unpin]);

  // After an option is applied the card stays on its segment, or on the leg it became.
  useEffect(() => {
    const after = afterApplyRef.current;
    if (!after || !pinned || focusId(pinned) !== focusId(after.focus)) return;
    const element = hvacElements.find((candidate) => candidate.id === pinned.runId);
    const plan = element ? getDuctRunPlan(element, hvacElements, settings) : null;
    afterApplyRef.current = null;
    if (!plan || ductSegmentOf(plan, pinned.key)) return;
    const fallback = ductSegmentOf(plan, `leg:${after.legIndex}`);
    if (fallback) pin({ ...pinned, key: fallback.key, anchorMark: fallback.marks[0] ?? null });
    else unpin();
  }, [hvacElements, settings, pinned, pin, unpin]);

  const apply = useCallback((focus: DuctSegmentFocus, option: DuctSegmentOption, evaluated: DuctOptionEvaluation | undefined) => {
    const evaluation = evaluated ?? evaluateDuctSegmentOption(hvacElements, settings, focus.runId, focus.key, option);
    useDuctSegmentUiStore.getState().setPreview(null);
    if (evaluation.refused || evaluation.updates.length === 0) return;
    const element = hvacElements.find((candidate) => candidate.id === focus.runId);
    const plan = element ? getDuctRunPlan(element, hvacElements, settings) : null;
    const legIndex = plan ? ductSegmentOf(plan, focus.key)?.legIndex ?? 0 : 0;
    afterApplyRef.current = { focus: useDuctSegmentUiStore.getState().pinned ?? focus, legIndex };
    commitDuctSegmentEdit(evaluation.updates, evaluation.action || option.title);
  }, [hvacElements, settings]);

  const step = useCallback((direction: -1 | 1) => {
    if (!pinned) return;
    const element = hvacElements.find((candidate) => candidate.id === pinned.runId);
    const plan = element ? getDuctRunPlan(element, hvacElements, settings) : null;
    const next = plan ? neighbourSegment(plan, pinned.key, direction) : null;
    if (next) pin({ runId: pinned.runId, key: next.key, anchorMark: next.marks[0] ?? null, view: pinned.view });
  }, [pinned, hvacElements, settings, pin]);

  // Esc hides a peek (until the pointer moves to another segment), else closes the pinned card; [ ] step along the run.
  useEffect(() => {
    if (!peek && !pinned) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable));
      if (event.key === 'Escape') {
        if (peek) {
          setDismissed(focusId(peek));
          setPeek(null);
        } else if (pinned && !typing) {
          unpin();
        } else return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!pinned || typing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === '[' || event.key === ']') {
        step(event.key === '[' ? -1 : 1);
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [peek, pinned, unpin, step]);

  if (!enabled) return null;
  const showPeek = peek && !(pinned && pinned.runId === peek.runId && pinned.key === peek.key);
  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 z-[28]" data-testid="duct-segment-cards">
      {pinned ? (
        <SegmentCard key={`pin|${focusId(pinned)}`} variant="pinned" focus={pinned} scene={hvacElements} settings={settings}
          resolveAnchor={resolveAnchor} containerRef={containerRef} onApply={apply} />
      ) : null}
      {showPeek ? (
        <SegmentCard key={`peek|${focusId(peek)}`} variant="peek" focus={peek} scene={hvacElements} settings={settings}
          resolveAnchor={resolveAnchor} containerRef={containerRef} onApply={apply}
          onPointerEnter={() => { overPeekRef.current = true; }}
          onPointerLeave={() => {
            overPeekRef.current = false;
            if (!useDuctSegmentUiStore.getState().hovered) setPeek(null);
          }} />
      ) : null}
    </div>
  );
}
