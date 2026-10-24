'use client';

/**
 * The parts the unit panel is built from, shared with the Auto duct card's
 * sizing block: a card and its sections, captions, key-figure tiles, segmented
 * pickers (tabs, choices, fan speeds), chips and status dots, a switch, a
 * folding row, one-line alerts, a meter and a hover tip. Presentational:
 * values in, callbacks out; the figures come from the duct engine unchanged.
 *
 * Look: white cards with a warm border on the toolbox's cream, slate text,
 * figures in tabular numerals, sky for what the designer sets, blue / teal for
 * supply / return, and the segment cards' status colours.
 */
import { AlertTriangle, CheckCircle2, ChevronRight, Info, XCircle } from 'lucide-react';
import {
  useEffect, useId, useLayoutEffect, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from 'react';

import { STATUS_DOT, STATUS_TEXT, type FigureStatus } from '../segments/SegmentCardKit';

export { STATUS_DOT, STATUS_TEXT, type FigureStatus };

/** Numbers as the panel shows them: '–' for what is not known. */
export const fmt = (value: number | null | undefined, digits = 0): string => (
  value === null || value === undefined || !Number.isFinite(value) ? '–' : value.toFixed(digits));

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

// ---- Card, sections, captions ----

export function PanelCard({ children, label, testId, className = '' }: { children: ReactNode; label?: string; testId?: string; className?: string }) {
  return (
    <section aria-label={label} data-testid={testId}
      className={`overflow-hidden rounded-xl border border-amber-200/80 bg-white shadow-[0_1px_2px_rgba(120,53,15,0.05)] ${className}`}>
      {children}
    </section>
  );
}

/** A part of a card, under a hairline (`noDivider`: the card's first part). */
export function CardSection({ children, testId, className = '', noDivider = false }: { children: ReactNode; testId?: string; className?: string; noDivider?: boolean }) {
  return <div data-testid={testId} className={`px-3 py-2.5 ${noDivider ? '' : 'border-t border-slate-100'} ${className}`}>{children}</div>;
}

/** A small capitalised heading, with what it sums up on the right. */
export function Caption({ children, aside, className = '' }: { children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={`flex min-w-0 items-center justify-between gap-2 ${className}`}>
      <span className="shrink-0 text-[9.5px] font-semibold uppercase tracking-[0.07em] text-slate-400">{children}</span>
      {aside ? <span className="flex min-w-0 items-center gap-1 truncate text-[10.5px] text-slate-500">{aside}</span> : null}
    </div>
  );
}

// ---- Chips, dots, meters ----

export type ChipTone = 'slate' | 'sky' | 'amber' | 'green' | 'red' | 'violet';

const CHIP_TONES: Record<ChipTone, string> = {
  slate: 'bg-slate-100 text-slate-600',
  sky: 'bg-sky-100 text-sky-800',
  amber: 'bg-amber-100 text-amber-900',
  green: 'bg-emerald-100 text-emerald-800',
  red: 'bg-red-100 text-red-800',
  violet: 'bg-violet-100 text-violet-800',
};

export function Chip({ tone = 'slate', children, title, testId }: { tone?: ChipTone; children: ReactNode; title?: string; testId?: string }) {
  return (
    <span title={title} data-testid={testId}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-[7px] text-[10px] font-medium leading-[17px] ${CHIP_TONES[tone]}`}>
      {children}
    </span>
  );
}

export type DotKind = FigureStatus | 'none' | 'supply' | 'return' | 'sky';

const DOT_KINDS: Record<DotKind, string> = {
  ...STATUS_DOT, none: 'bg-slate-300', supply: 'bg-blue-600', return: 'bg-teal-600', sky: 'bg-sky-600',
};

export function StatusDot({ kind, title, className = '' }: { kind: DotKind; title?: string; className?: string }) {
  return <span title={title} aria-hidden={title ? undefined : true} className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT_KINDS[kind]} ${className}`} />;
}

export interface MeterSegment {
  /** Share of the whole bar, 0–1. */
  fraction: number;
  className: string;
}

/** A thin bar of stacked shares (supply and return against the fan; allocated airflow). */
export function Meter({ segments, className = 'h-1 rounded-full' }: { segments: readonly MeterSegment[]; className?: string }) {
  return (
    <div className={`flex overflow-hidden bg-slate-200 ${className}`} aria-hidden="true">
      {segments.map((segment, index) => (
        <span key={index} className={`block h-full ${segment.className}`} style={{ width: `${clamp01(segment.fraction) * 100}%` }} />
      ))}
    </div>
  );
}

// ---- Key-figure tiles ----

export function KpiTile({ label, value, unit, sub, meter, title, testId }: {
  label: string; value: ReactNode; unit?: string; sub?: ReactNode; meter?: readonly MeterSegment[]; title?: string; testId?: string;
}) {
  return (
    <div title={title} data-testid={testId}
      className="relative min-w-0 overflow-hidden rounded-[9px] border border-slate-100 bg-slate-50/80 px-2 pb-2 pt-1.5">
      <p className="truncate text-[9.5px] font-semibold uppercase tracking-[0.07em] text-slate-400">{label}</p>
      <p className="truncate leading-5">
        <span className="text-[15px] font-semibold tabular-nums tracking-tight text-slate-900">{value}</span>
        {unit ? <span className="text-[10px] text-slate-400">{` ${unit}`}</span> : null}
      </p>
      {sub ? <div className="flex min-w-0 items-center gap-1 truncate text-[10px] text-slate-500">{sub}</div> : null}
      {meter ? <Meter segments={meter} className="absolute inset-x-0 bottom-0 h-[3px]" /> : null}
    </div>
  );
}

// ---- Segmented pickers ----

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** A second line (fan speeds: the airflow) or a quiet note after the label. */
  sub?: ReactNode;
  dot?: DotKind;
  disabled?: boolean;
  title?: string;
  /** The accessible name when the label alone does not say it. */
  ariaLabel?: string;
  testId?: string;
}

const SEGMENTED_STYLES = {
  tabs: {
    frame: 'gap-0.5 rounded-[10px] bg-[#efe6d0] p-0.5',
    button: 'rounded-lg py-[5px] text-[11.5px] font-medium',
    on: 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(120,53,15,0.12)]',
    off: 'text-stone-500 hover:text-stone-800',
  },
  plain: {
    frame: 'gap-0.5 rounded-[9px] bg-slate-100 p-0.5',
    button: 'rounded-[7px] py-1 text-[11px] font-medium',
    on: 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.08),0_0_0_1px_rgba(15,23,42,0.05)]',
    off: 'text-slate-500 hover:text-slate-800',
  },
  speed: {
    frame: 'gap-0.5 rounded-[9px] bg-slate-100 p-0.5',
    button: 'flex-col gap-0 rounded-[7px] pb-1 pt-[3px] leading-tight',
    on: 'bg-white text-sky-800 shadow-[0_0_0_1.5px_#38bdf8]',
    off: 'text-slate-500 hover:text-slate-800',
  },
} as const;

/**
 * One choice of a few, as a row of segments: a radio group (or the panel's tab
 * list), arrow keys moving the choice the way a native radio group does.
 */
export function Segmented<T extends string>({ options, value, onChange, label, variant = 'plain', role = 'radiogroup', testId, className = '' }: {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  variant?: keyof typeof SEGMENTED_STYLES;
  role?: 'radiogroup' | 'tablist';
  testId?: string;
  className?: string;
}) {
  const style = SEGMENTED_STYLES[variant];
  const itemRole = role === 'tablist' ? 'tab' : 'radio';
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  // One segment takes the Tab key: the chosen one, else the first that can be chosen.
  const tabStop = options.some((option) => option.value === value) ? value : options.find((option) => !option.disabled)?.value;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    const enabled = options.map((option, index) => ({ option, index })).filter(({ option }) => !option.disabled);
    const at = enabled.findIndex(({ option }) => option.value === value);
    const next = enabled[(at + step + enabled.length) % enabled.length];
    if (!next) return;
    event.preventDefault();
    onChange(next.option.value);
    refs.current[next.index]?.focus();
  };
  return (
    <div role={role} aria-label={label} data-testid={testId} onKeyDown={onKeyDown}
      className={`grid ${style.frame} ${className}`} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((option, index) => {
        const on = option.value === value;
        const state = role === 'tablist' ? { 'aria-selected': on } : { 'aria-checked': on };
        return (
          <button key={option.value} ref={(node) => { refs.current[index] = node; }} type="button" role={itemRole} {...state}
            aria-label={option.ariaLabel} tabIndex={option.value === tabStop ? 0 : -1} disabled={option.disabled} title={option.title} data-testid={option.testId}
            onClick={() => { if (!on) onChange(option.value); }}
            className={`flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 disabled:cursor-not-allowed disabled:text-slate-300 ${style.button} ${on ? style.on : style.off}`}>
            {variant === 'speed' ? (
              <>
                <span className="text-[11px] font-semibold">{option.label}</span>
                {option.sub !== undefined ? <span className={`text-[9.5px] tabular-nums ${on ? 'text-sky-600' : 'text-slate-400'}`}>{option.sub}</span> : null}
              </>
            ) : (
              <>
                {option.dot ? <StatusDot kind={option.dot} /> : null}
                <span className="truncate">{option.label}</span>
                {option.sub !== undefined ? <span className={`truncate text-[10px] font-normal tabular-nums ${on ? 'text-slate-400' : 'text-slate-400/80'}`}>{option.sub}</span> : null}
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---- Switch, buttons ----

export function Switch({ checked, onChange, label, testId }: { checked: boolean; onChange: (checked: boolean) => void; label: string; testId?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} data-testid={testId} onClick={() => onChange(!checked)}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${checked ? 'bg-sky-600' : 'bg-slate-300'}`}>
      <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-[left] ${checked ? 'left-[14px]' : 'left-0.5'}`} />
    </button>
  );
}

export type PanelButtonTone = 'primary' | 'neutral' | 'warn' | 'ghost';

const BUTTON_TONES: Record<PanelButtonTone, string> = {
  primary: 'border-sky-700 bg-sky-700 text-white hover:bg-sky-800',
  neutral: 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
  warn: 'border-amber-300 bg-white text-amber-900 hover:bg-amber-50',
  ghost: 'border-transparent bg-transparent text-slate-600 hover:bg-slate-100',
};

export function PanelButton({ onClick, children, title, testId, tone = 'neutral', disabled = false, className = '' }: {
  onClick: () => void; children: ReactNode; title?: string; testId?: string; tone?: PanelButtonTone; disabled?: boolean; className?: string;
}) {
  return (
    <button type="button" onClick={onClick} title={title} data-testid={testId} disabled={disabled}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-[7px] border px-2 py-[3px] text-[11px] font-medium leading-4 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 disabled:cursor-not-allowed disabled:opacity-40 ${BUTTON_TONES[tone]} ${className}`}>
      {children}
    </button>
  );
}

// ---- Folding rows, alerts ----

/** A row that folds what it heads: its title, and a one-line summary of what is inside. */
export function Disclosure({ title, summary, open, onToggle, children, testId }: {
  title: ReactNode; summary?: ReactNode; open: boolean; onToggle: (open: boolean) => void; children: ReactNode; testId?: string;
}) {
  const id = useId();
  return (
    <div data-testid={testId} className="border-t border-slate-100">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => onToggle(!open)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-slate-50/80 focus:outline-none focus-visible:bg-slate-50">
        <ChevronRight size={12} aria-hidden="true" className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="shrink-0 text-[11.5px] font-semibold text-slate-700">{title}</span>
        {summary ? <span className="ml-auto flex min-w-0 items-center gap-1.5 truncate text-[10.5px] text-slate-400">{summary}</span> : null}
      </button>
      {open ? <div id={id} className="px-3 pb-3">{children}</div> : null}
    </div>
  );
}

export type AlertTone = 'info' | 'warn' | 'error' | 'ok';

const ALERT_TONES: Record<AlertTone, string> = {
  info: 'border-sky-100 bg-sky-50 text-sky-950',
  warn: 'border-amber-200 bg-amber-50 text-amber-950',
  error: 'border-red-200 bg-red-50 text-red-900',
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-900',
};

/** One short line (or two) and at most an action or two under it. */
export function InlineAlert({ tone, children, actions, testId }: { tone: AlertTone; children: ReactNode; actions?: ReactNode; testId?: string }) {
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'info' ? Info : tone === 'error' ? XCircle : AlertTriangle;
  return (
    <div role="status" data-testid={testId} className={`flex items-start gap-2 rounded-[9px] border px-2.5 py-1.5 text-[11px] leading-[15px] ${ALERT_TONES[tone]}`}>
      <Icon size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {children}
        {actions ? <div className="mt-1.5 flex flex-wrap gap-1.5">{actions}</div> : null}
      </div>
    </div>
  );
}

// ---- A hover tip for what used to be a sentence ----

const TIP_WIDTH = 248;

function TipCard({ id, anchor, children }: { id: string; anchor: DOMRect; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState(anchor.bottom + 6);
  const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - TIP_WIDTH / 2, window.innerWidth - TIP_WIDTH - 8));
  useLayoutEffect(() => {
    const height = ref.current?.getBoundingClientRect().height ?? 0;
    // Below the anchor, else above it.
    setTop(anchor.bottom + 6 + height <= window.innerHeight - 8 ? anchor.bottom + 6 : Math.max(8, anchor.top - 6 - height));
  }, [anchor]);
  return (
    <div ref={ref} id={id} role="tooltip" style={{ left, top, width: TIP_WIDTH }}
      className="pointer-events-none fixed z-[1000] rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[11px] font-normal normal-case leading-4 tracking-normal text-slate-600 shadow-xl ring-1 ring-black/5">
      {children}
    </div>
  );
}

/**
 * Its children, with `tip` shown beside them on hover (after a beat) or at
 * once on keyboard focus. Fixed to the window, so a card's clipping or the
 * panel's scroll never cuts it. `block` wraps a block (a tile) rather than a
 * line of text.
 */
export function InfoTip({ tip, children, className = '', block = false }: { tip: ReactNode; children: ReactNode; className?: string; block?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLElement | null>(null);
  const timer = useRef<number | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const show = (delay: number) => {
    clear();
    timer.current = window.setTimeout(() => {
      if (ref.current) setAnchor(ref.current.getBoundingClientRect());
    }, delay);
  };
  const hide = () => {
    clear();
    setAnchor(null);
  };
  useEffect(() => clear, []);
  const handlers = {
    'aria-describedby': anchor ? id : undefined,
    onPointerEnter: () => show(250),
    onPointerLeave: hide,
    onFocus: () => show(0),
    onBlur: hide,
  };
  if (block) {
    return (
      <div ref={(node) => { ref.current = node; }} className={`min-w-0 ${className}`} {...handlers}>
        {children}
        {anchor ? <TipCard id={id} anchor={anchor}>{tip}</TipCard> : null}
      </div>
    );
  }
  return (
    <span ref={(node) => { ref.current = node; }} className={`inline-flex min-w-0 items-center ${className}`} {...handlers}>
      {children}
      {anchor ? <TipCard id={id} anchor={anchor}>{tip}</TipCard> : null}
    </span>
  );
}

/** The (i) a tip hangs on, focusable for the keyboard. */
export function InfoIcon({ tip, label = 'More' }: { tip: ReactNode; label?: string }) {
  return (
    <InfoTip tip={tip}>
      <span tabIndex={0} role="img" aria-label={label} className="inline-flex rounded-full text-slate-300 hover:text-slate-500 focus:outline-none focus-visible:text-sky-600">
        <Info size={11} aria-hidden="true" />
      </span>
    </InfoTip>
  );
}

// ---- Label / value rows ----

/** Label on the left, value on the right, the label column fixed: a short spec sheet. */
export function SpecRows({ rows }: { rows: ReadonlyArray<{ label: string; value: ReactNode; title?: string } | null | false> }) {
  return (
    <dl className="mt-1.5 grid grid-cols-[82px_minmax(0,1fr)] items-baseline gap-x-2 gap-y-[5px] text-[11px]">
      {rows.map((row) => (row ? (
        <div key={row.label} className="contents">
          <dt className="text-slate-400">{row.label}</dt>
          <dd className="min-w-0 tabular-nums text-slate-800" title={row.title}>{row.value}</dd>
        </div>
      ) : null))}
    </dl>
  );
}
