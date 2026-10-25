'use client';

/**
 * The constant-friction basis as the unit panel and the Auto duct card draw
 * it, in figures and graphics rather than sentences:
 *
 *  - the method strip: the main's velocity V₀ ⇄ the friction rate R (the one
 *    set last drives and is marked SET; the other follows at the system
 *    airflow), then what they give — every section a standard size at R, and
 *    each section's velocity within its limit;
 *  - R on a slider over the usual design range: dragging previews the sizes,
 *    letting go sizes them (one undo on ducts in the drawing);
 *  - the fan speed, with ✎ for a typed system airflow; the velocity limits,
 *    folded;
 *  - the terminals by spec: one airflow for the terminals of one spec (they
 *    share at one neck velocity), each below it when one is set on its own.
 *
 * Figures are held SI and shown in the document's unit system.
 */
import { AlertTriangle, Check, ChevronDown, ChevronRight, Link2, Pencil, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

import { useSmartDrawingStore } from '../../../../store';
import { Meter, Segmented, StatusDot } from '../unit/unitPanelKit';
import { useHvacUnits } from '../units/useHvacUnits';

import { DuctNumberInput } from './DuctNumberInput';
import type { BasisChange } from './DuctSizingSection';
import { figureStatus } from './ductSegmentFigures';
import { FAN_SPEED_LABELS, FAN_SPEEDS, type FanSpeed } from './ductSizing';
import type { DuctSystemSizingReport } from './ductSystemSizing';
import { TERMINAL_FACE_LABELS, type DuctTerminalSpec } from './ductTerminalCatalog';
import type { DuctSystemSizing } from './ductTypes';
import { groupTerminalsBySpec, terminalSpecLabel } from './terminalGroups';

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

// ---- The method strip ----

type StepTone = 'drive' | 'linked' | 'out';

const STEP_TONES: Record<StepTone, string> = {
  drive: 'border-sky-300 bg-sky-50 shadow-[0_0_0_3px_rgba(14,165,233,0.08)]',
  linked: 'border-slate-200 bg-white',
  out: 'border-slate-100 bg-slate-50',
};

function StripStep({ title, badge, tone, unit, tip, last = false, small = false, testId, children }: {
  title: string; badge?: ReactNode; tone: StepTone; unit: ReactNode; tip: string; last?: boolean;
  /** A long figure (a range in fpm) set smaller, so it stays on one line. */
  small?: boolean; testId?: string; children: ReactNode;
}) {
  return (
    <div title={tip} data-testid={testId} className={`relative min-w-0 rounded-[9px] border px-1.5 py-[5px] ${STEP_TONES[tone]}`}>
      <span className="flex items-center justify-between gap-0.5 text-[8.5px] font-bold uppercase tracking-[0.05em] text-slate-400">{title}{badge}</span>
      <span className={`mt-px flex min-w-0 whitespace-nowrap font-semibold leading-[17px] tabular-nums text-slate-900 ${small ? 'text-[11px]' : 'text-[13px]'}`}>{children}</span>
      <span className="block truncate text-[9px] text-slate-400">{unit}</span>
      {last ? null : <span aria-hidden="true" className="absolute -right-[7px] top-1/2 z-[1] -translate-y-[55%] bg-white text-[12px] leading-3 text-slate-400">›</span>}
    </div>
  );
}

const SetBadge = () => (
  <span title="Set by you: the other follows" className="rounded-[3px] bg-sky-600 px-[3px] text-[7.5px] font-extrabold leading-[11px] tracking-[0.06em] text-white">SET</span>
);
const LinkedMark = () => <Link2 size={9} className="shrink-0 text-slate-300" aria-label="Follows from the other" />;

/**
 * Constant friction step by step: V₀ ⇄ R (the one set last drives), the
 * standard sizes at R, and the velocities they give against their limits.
 */
export function MethodStrip({ basis, report, live, onChange, compact = false }: {
  basis: DuctSystemSizing;
  /** What the basis made of the network; null when nothing is sized yet. */
  report: Pick<DuctSystemSizingReport, 'sections'> | null;
  live: boolean;
  onChange: BasisChange;
  /** A narrow column (the Auto duct card): "V₀" for "V₀ main". */
  compact?: boolean;
}) {
  const units = useHvacUnits();
  const sizeSeries = useSmartDrawingStore((state) => state.ductSettings.sizeSeries);
  const drivesVelocity = basis.drive === 'velocity';
  const flowing = report?.sections.filter((section) => section.airflowM3h > 0) ?? [];
  const velocities = flowing.map((section) => section.velocityMs);
  const over = flowing.filter((section) => figureStatus(section.velocityMs, basis.maxVelocity[section.part]) === 'over').length;
  const inch = sizeSeries === 'imperial';
  const range = velocities.length ? `${units.num('velocity', Math.min(...velocities))}–${units.num('velocity', Math.max(...velocities))}` : '–';
  return (
    <div className="grid grid-cols-4 gap-1" role="group" aria-label="Constant friction, step by step" data-testid="duct-sizing-strip">
      <StripStep title={compact ? 'V₀' : 'V₀ main'} badge={drivesVelocity ? <SetBadge /> : <LinkedMark />} tone={drivesVelocity ? 'drive' : 'linked'} unit={units.unit('velocity')}
        tip={drivesVelocity ? 'The main\'s velocity, set: the friction rate follows from it at the system airflow' : 'The main\'s velocity (round equivalent) at the system airflow: follows from the friction rate'}>
        <DuctNumberInput variant="strip" label="Main velocity" value={basis.mainVelocityMs} quantity="velocity" unitSystem={units.system} step={0.1} min={1} max={15}
          live={live} derived={!drivesVelocity} digits={2} displayDigits={1} className="w-full"
          onChange={(value) => value !== null && onChange({ ...basis, drive: 'velocity', mainVelocityMs: value }, `main velocity ${units.fmt('velocity', basis.mainVelocityMs)} → ${units.fmt('velocity', value)}`)} />
      </StripStep>
      <StripStep title="R" badge={drivesVelocity ? <LinkedMark /> : <SetBadge />} tone={drivesVelocity ? 'linked' : 'drive'} unit={units.unit('friction')}
        tip="Constant friction: every section is sized at this friction loss per length">
        <DuctNumberInput variant="strip" label="Friction rate" value={basis.frictionPaPerM} quantity="friction" unitSystem={units.system} step={0.05} min={0.1} max={5}
          live={live} derived={drivesVelocity} digits={2} displayDigits={2} className="w-full"
          onChange={(value) => value !== null && onChange({ ...basis, drive: 'friction', frictionPaPerM: value }, `friction ${units.fmt('friction', basis.frictionPaPerM)} → ${units.fmt('friction', value)}`)} />
      </StripStep>
      <StripStep title="Sizes" tone="out" unit={inch ? 'inch series' : 'standard'} testId="duct-sizing-strip-sizes"
        tip={`Each section takes the smallest standard size within R and its velocity limit: ${inch ? 'rectangles in 2 in steps, round by the inch' : 'rectangles in the fabricator\'s steps, round from the stocked list'}`}>
        {report ? report.sections.length : '–'}
      </StripStep>
      <StripStep title="Velocity" tone="out" last testId="duct-sizing-strip-velocity" small={range.length > 7}
        unit={<span className={over ? 'font-semibold text-red-600' : ''}>{units.unit('velocity')} {flowing.length ? (over ? `· ${over} over` : '✓') : ''}</span>}
        tip="Each section's velocity in its standard size, against its part's limit (trunk, branch, runout)">
        {range}
      </StripStep>
    </div>
  );
}

// ---- The friction rate on a slider ----

/** The slider's range, the usual low-pressure design band and its ticks, in each system's own figures. */
const SLIDER_SCALES = {
  si: { min: 0.2, max: 1.6, band: [0.6, 1.0], ticks: [0.2, 0.6, 1.0, 1.6], step: 0.01, key: 0.05, short: 'Pa/m' },
  ip: { min: 0.025, max: 0.2, band: [0.075, 0.125], ticks: [0.025, 0.075, 0.125, 0.2], step: 0.001, key: 0.005, short: 'in. wg/100 ft' },
} as const;

const tickText = (tick: number) => tick.toFixed(Math.max(1, (String(tick).split('.')[1] ?? '').length));

/**
 * R on a slider over the usual design range (shaded): dragging (or the arrow
 * keys) previews the rate under the thumb, letting go (or a pause in the
 * keys) commits it; Escape lets it go unchanged.
 */
export function FrictionSlider({ frictionPaPerM, onPreview, onCommit, label = 'Friction rate slider', testId = 'duct-sizing-slider' }: {
  frictionPaPerM: number;
  /** While held: the rate under the thumb (SI); null once let go. */
  onPreview?: (frictionPaPerM: number | null) => void;
  /** The rate let go at (SI). */
  onCommit: (frictionPaPerM: number) => void;
  label?: string;
  testId?: string;
}) {
  const units = useHvacUnits();
  const scale = SLIDER_SCALES[units.system];
  const digits = units.digits('friction');
  const shown = units.toDisplay('friction', frictionPaPerM);
  const [held, setHeld] = useState<number | null>(null);
  const heldRef = useRef<number | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const frame = useRef<number | null>(null);
  const keyTimer = useRef<number | null>(null);
  const callbacks = useRef({ onPreview, onCommit, shown, toSi: (value: number) => units.fromDisplay('friction', value) });
  callbacks.current = { onPreview, onCommit, shown, toSi: (value: number) => units.fromDisplay('friction', value) };
  useEffect(() => () => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    if (keyTimer.current !== null) window.clearTimeout(keyTimer.current);
  }, []);

  const snap = (value: number) => Number((Math.round(Math.min(scale.max, Math.max(scale.min, value)) / scale.step) * scale.step).toFixed(digits));
  const hold = (value: number) => {
    heldRef.current = value;
    setHeld(value);
    // One preview a frame, the latest value.
    if (frame.current !== null) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      const current = heldRef.current;
      if (current !== null) callbacks.current.onPreview?.(callbacks.current.toSi(current));
    });
  };
  const finish = (commit: boolean) => {
    if (frame.current !== null) { window.cancelAnimationFrame(frame.current); frame.current = null; }
    if (keyTimer.current !== null) { window.clearTimeout(keyTimer.current); keyTimer.current = null; }
    const value = heldRef.current;
    heldRef.current = null;
    setHeld(null);
    callbacks.current.onPreview?.(null);
    if (commit && value !== null && Math.abs(value - callbacks.current.shown) > scale.step / 2) callbacks.current.onCommit(callbacks.current.toSi(value));
  };
  const atPointer = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    return snap(scale.min + clamp01((clientX - rect.left) / rect.width) * (scale.max - scale.min));
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const base = heldRef.current ?? shown;
    const by: Record<string, number> = { ArrowRight: scale.key, ArrowUp: scale.key, ArrowLeft: -scale.key, ArrowDown: -scale.key, PageUp: 4 * scale.key, PageDown: -4 * scale.key };
    let next: number | null = null;
    if (event.key in by) next = snap(base + by[event.key]!);
    else if (event.key === 'Home') next = scale.min;
    else if (event.key === 'End') next = scale.max;
    else if (event.key === 'Escape' && heldRef.current !== null) {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    hold(next);
    if (keyTimer.current !== null) window.clearTimeout(keyTimer.current);
    keyTimer.current = window.setTimeout(() => finish(true), 450);
  };

  const value = held ?? shown;
  const at = (figure: number) => clamp01((figure - scale.min) / (scale.max - scale.min)) * 100;
  const valueText = `${value.toFixed(digits)} ${units.unit('friction')}`;
  return (
    <div className="relative mx-1 mt-2 h-[30px] touch-none select-none" data-testid={testId}>
      <div ref={trackRef} role="slider" tabIndex={0} aria-label={label} aria-valuemin={scale.min} aria-valuemax={scale.max} aria-valuenow={Number(value.toFixed(digits))}
        aria-valuetext={valueText} onKeyDown={onKeyDown} onBlur={() => { if (keyTimer.current !== null) finish(true); }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.focus();
          const next = atPointer(event.clientX);
          if (next !== null) hold(next);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const next = atPointer(event.clientX);
          if (next !== null && next !== heldRef.current) hold(next);
        }}
        onPointerUp={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          finish(true);
        }}
        onPointerCancel={() => finish(false)}
        className="absolute inset-x-0 top-0 h-[18px] cursor-pointer rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">
        <span className="absolute inset-x-0 top-[7px] h-1 rounded-full bg-slate-200" />
        <span title="The usual low-pressure range" className="absolute top-[7px] h-1 bg-sky-200" style={{ left: `${at(scale.band[0])}%`, width: `${at(scale.band[1]) - at(scale.band[0])}%` }} />
        <span className={`absolute top-[1px] -ml-2 h-4 w-4 rounded-full border-2 bg-white shadow-[0_1px_3px_rgba(2,132,199,0.35)] ${held !== null ? 'border-sky-700' : 'border-sky-600'}`}
          style={{ left: `${at(value)}%` }} />
      </div>
      {scale.ticks.map((tick, index) => {
        if (Math.abs(at(tick) - at(value)) < 9) return null;
        const edge = index === 0 ? '' : index === scale.ticks.length - 1 ? '-translate-x-full' : '-translate-x-1/2';
        return (
          <span key={tick} aria-hidden="true" className={`absolute top-[19px] whitespace-nowrap text-[9px] tabular-nums text-slate-400 ${edge}`} style={{ left: `${at(tick)}%` }}>
            {tickText(tick)}{index === scale.ticks.length - 1 ? ` ${scale.short}` : ''}
          </span>
        );
      })}
      <span aria-hidden="true" className="absolute top-[19px] -translate-x-1/2 whitespace-nowrap text-[9px] font-semibold tabular-nums text-sky-700" style={{ left: `${at(value)}%` }}>
        {value.toFixed(digits)}
      </span>
    </div>
  );
}

// ---- Fan speed and system airflow ----

/**
 * The fan speed as four segments, each with its airflow, and ✎ for a typed
 * system airflow (shown while typed, or without the unit's airflow data).
 */
export function FanSpeedAirflow({ speedLabel, airflowLabel, fanSpeed, airflowM3h, typedM3h, defaultM3h, sourceNote, live = false, expanded = false, onFanSpeed, onTypedAirflow }: {
  speedLabel: string;
  airflowLabel: string;
  fanSpeed: FanSpeed;
  /** The unit's airflow at each speed (m³/h); null without its data. */
  airflowM3h: Readonly<Record<FanSpeed, number>> | null;
  /** The system airflow typed (m³/h); null: the fan speed's. */
  typedM3h: number | null;
  /** What the system takes when nothing is typed (m³/h). */
  defaultM3h: number | null;
  /** Where the untyped airflow comes from ("fan speed", "Airflow field"). */
  sourceNote?: string | null;
  live?: boolean;
  /** The system airflow field always shown (no ✎). */
  expanded?: boolean;
  onFanSpeed: (speed: FanSpeed) => void;
  onTypedAirflow: (value: number | null) => void;
}) {
  const units = useHvacUnits();
  const [editing, setEditing] = useState(false);
  const typed = typedM3h !== null;
  const open = expanded || editing || typed || !airflowM3h;
  return (
    <div className="space-y-1" data-testid="duct-sizing-airflow">
      {airflowM3h && expanded ? (
        <Segmented variant="speed" label={speedLabel} value={fanSpeed} onChange={onFanSpeed}
          options={FAN_SPEEDS.map((speed) => ({
            value: speed, label: FAN_SPEED_LABELS[speed], sub: units.num('airflow', airflowM3h[speed]),
            ariaLabel: `${FAN_SPEED_LABELS[speed]} · ${units.fmt('airflow', airflowM3h[speed])}`,
          }))} />
      ) : airflowM3h ? (
        <div className="grid grid-cols-[minmax(0,1fr)_26px] gap-0.5 rounded-[9px] bg-slate-100 p-0.5">
          <Segmented variant="speed" label={speedLabel} value={fanSpeed} onChange={onFanSpeed} className="!bg-transparent !p-0"
            options={FAN_SPEEDS.map((speed) => ({
              value: speed, label: FAN_SPEED_LABELS[speed], sub: units.num('airflow', airflowM3h[speed]),
              ariaLabel: `${FAN_SPEED_LABELS[speed]} · ${units.fmt('airflow', airflowM3h[speed])}`,
            }))} />
          <button type="button" aria-pressed={open} aria-label="Type the system airflow" title={typed ? 'A typed system airflow is in use' : 'Type the system airflow'}
            onClick={() => setEditing(!editing)} data-testid="duct-sizing-airflow-edit"
            className={`flex items-center justify-center rounded-[7px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${typed ? 'bg-white text-sky-700 shadow-[0_0_0_1.5px_#38bdf8]' : open ? 'bg-white text-slate-700' : 'text-slate-500 hover:text-slate-800'}`}>
            <Pencil size={11} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {open ? (
        <div className="flex min-h-7 items-center justify-between gap-2">
          <span className="text-[11px] text-slate-500">System airflow</span>
          <span className="flex items-center gap-1.5">
            {typed ? (
              <button type="button" aria-label={airflowM3h ? "Use the fan speed's airflow" : "Use the unit's airflow"} title={airflowM3h ? "Clear: the fan speed's airflow" : "Clear: the unit's airflow"}
                onClick={() => { setEditing(false); onTypedAirflow(null); }}
                className="inline-flex items-center gap-0.5 rounded px-0.5 text-[10px] text-slate-400 hover:bg-slate-100 hover:text-slate-700">typed<X size={10} aria-hidden="true" /></button>
            ) : sourceNote ? <span className="text-[10px] text-slate-400">{sourceNote}</span> : null}
            <DuctNumberInput variant="cell" label={airflowLabel} quantity="airflow" unitSystem={units.system} value={typedM3h} step={10} min={0.01} max={50000} allowEmpty live={live}
              placeholder={defaultM3h ? units.num('airflow', defaultM3h) : units.unit('airflow')} className="w-[52px]" suffix={units.unit('airflow')} onChange={onTypedAirflow} />
          </span>
        </div>
      ) : null}
    </div>
  );
}

// ---- Velocity limits ----

const PARTS = [
  { part: 'trunk', label: 'Trunk', hint: 'Sections carrying two terminals or more' },
  { part: 'branch', label: 'Branch', hint: 'Sections carrying one terminal' },
  { part: 'runout', label: 'Runout', hint: 'Flexible runouts to the terminals' },
] as const;

/** The velocity limits by part behind one summary row. */
export function VelocityLimits({ basis, live, onChange, open, onOpenChange }: {
  basis: DuctSystemSizing; live: boolean; onChange: BasisChange; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const units = useHvacUnits();
  return (
    <div className="space-y-1">
      <button type="button" aria-expanded={open} onClick={() => onOpenChange(!open)} data-testid="duct-sizing-limits"
        className="flex min-h-7 w-full items-center gap-1.5 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">
        <span className="text-[11px] text-slate-500">Velocity limits</span>
        {open ? <span className="ml-auto text-[10px] text-slate-400">trunk · branch · runout</span>
          : <span className="ml-auto text-[11px] tabular-nums text-slate-700">{units.num('velocity', basis.maxVelocity.trunk)} · {units.num('velocity', basis.maxVelocity.branch)} · {units.num('velocity', basis.maxVelocity.runout)}</span>}
        <span className="text-[10px] text-slate-400">{units.unit('velocity')}</span>
        <ChevronDown size={12} aria-hidden="true" className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <div className="grid grid-cols-3 gap-1.5">
          {PARTS.map(({ part, label, hint }) => (
            <div key={part} title={hint} className="min-w-0 rounded-lg border border-slate-100 bg-slate-50 px-0.5 pb-0.5 pt-1">
              <span className="block px-1 text-[9px] font-semibold uppercase tracking-[0.06em] text-slate-400">{label}</span>
              <DuctNumberInput variant="compact" steppers label={`${label} velocity limit`} value={basis.maxVelocity[part]} quantity="velocity" unitSystem={units.system}
                step={0.5} min={1} max={15} live={live} displayDigits={1} className="w-full"
                onChange={(value) => value !== null && onChange({ ...basis, maxVelocity: { ...basis.maxVelocity, [part]: value } }, `${part} limit ${units.fmt('velocity', basis.maxVelocity[part])} → ${units.fmt('velocity', value)}`)} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---- Terminals by spec ----

export interface TerminalRow {
  id: string;
  label: string;
  spec: DuctTerminalSpec;
  airflowM3h: number;
  /** Set on the terminal (or in the card) rather than a share. */
  fixed: boolean;
  neckMm: number;
  neckVelocityMs: number;
  /** The neck it takes at the next resize (necks follow airflow), when larger than its own. */
  nextNeckMm?: number | null;
}

/** A terminal face as a small glyph: a 4-way's diagonals, a round's rings, a slot's lines, a grille's grid. */
function TerminalGlyph({ spec }: { spec: DuctTerminalSpec }) {
  const tone = spec.service === 'return' ? 'bg-teal-50 text-teal-700' : 'bg-blue-50 text-blue-700';
  const path = spec.kind === 'round' ? <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /></>
    : spec.kind === 'linear-slot' ? <><rect x="3" y="7" width="18" height="10" rx="1.5" /><path d="M7 10.5h10M7 13.5h10" /></>
      : spec.kind === 'return-egg-crate' || spec.kind === 'louvred' || spec.kind === 'perforated' ? <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16" /></>
        : <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 4l16 16M20 4 4 20" /></>;
  return (
    <span className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md ${tone}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">{path}</svg>
    </span>
  );
}

const SPLIT_TONES = ['bg-blue-500', 'bg-blue-400', 'bg-sky-400', 'bg-sky-300', 'bg-indigo-300'] as const;
const GROUP_COLUMNS = 'grid grid-cols-[22px_minmax(0,1fr)_66px_34px_14px] items-center gap-1.5';
const MEMBER_COLUMNS = 'grid grid-cols-[minmax(0,1fr)_66px_34px_14px] items-center gap-1.5';

/**
 * The terminals by spec, against the system airflow: how it is shared (a bar
 * by group), one airflow for each group ("each": every terminal of the spec),
 * and each terminal under its group — open by itself where one is set on its
 * own. A typed value fixes it; clearing it shares again.
 */
export function TerminalGroupList({ rows, neckCapMs, systemAirflowM3h, live, onChange, footer }: {
  rows: readonly TerminalRow[];
  neckCapMs: number;
  systemAirflowM3h: number | null;
  live: boolean;
  /** Sets (a number) or shares again (null) the airflow of the terminals named, as one change. */
  onChange: (ids: string[], value: number | null, what: string) => void;
  footer?: ReactNode;
}) {
  const units = useHvacUnits();
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  if (!rows.length) return null;
  const neck = (diameterMm: number) => units.section({ widthMm: diameterMm, heightMm: diameterMm, diameterMm });
  const groups = groupTerminalsBySpec(rows, (row) => row.spec).map((group) => {
    const members = [...group.members].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    const fixed = members.filter((member) => member.fixed);
    const shares = members.filter((member) => !member.fixed).map((member) => member.airflowM3h);
    const common = fixed.length === members.length && fixed.every((member) => Math.abs(member.airflowM3h - fixed[0]!.airflowM3h) < 0.01) ? fixed[0]!.airflowM3h : null;
    const own = common === null ? fixed.length : 0;
    return {
      key: group.key, spec: group.spec, label: terminalSpecLabel(group.spec, neck), members, common, own,
      share: shares.length ? shares[0]! : members[0]!.airflowM3h,
      totalM3h: members.reduce((sum, member) => sum + member.airflowM3h, 0),
      neckVelocityMs: Math.max(...members.map((member) => member.neckVelocityMs)),
      grows: members.find((member) => member.nextNeckMm && member.nextNeckMm > member.neckMm)?.nextNeckMm ?? null,
    };
  });
  const allocated = rows.reduce((sum, row) => sum + row.airflowM3h, 0);
  const system = systemAirflowM3h;
  const difference = system === null ? 0 : allocated - system;
  const mismatch = system !== null && Math.abs(difference) > Math.max(0.01, system * 1e-6);
  const unserved = rows.filter((row) => row.airflowM3h <= 0).length;
  const ok = !mismatch && !unserved;
  const whole = system && system > 0 ? system : allocated;
  return (
    <div data-testid="duct-sizing-terminals">
      <div className="flex items-center gap-1.5">
        <span className="text-[9.5px] font-semibold uppercase tracking-[0.07em] text-slate-400">Terminals · {rows.length}</span>
        {system !== null ? (
          <span className={`ml-auto flex items-center gap-1 text-[10.5px] tabular-nums ${ok ? 'text-emerald-700' : 'text-amber-700'}`} data-testid="duct-sizing-allocation">
            {ok ? <Check size={11} strokeWidth={2.5} aria-hidden="true" /> : <AlertTriangle size={11} aria-hidden="true" />}
            {units.num('airflow', allocated)} / {units.fmt('airflow', system)}
          </span>
        ) : null}
      </div>
      {groups.length > 1 && whole > 0 ? (
        <div className="mt-1.5 flex h-4 overflow-hidden rounded-md bg-slate-200 text-[9px] font-semibold leading-4 text-white" aria-label="How the airflow is shared" data-testid="duct-sizing-split">
          {groups.map((group, index) => {
            const fraction = clamp01(group.totalM3h / whole);
            return (
              <span key={group.key} title={`${group.members.length} × ${group.label}: ${units.fmt('airflow', group.totalM3h)}`}
                className={`block truncate px-1 ${SPLIT_TONES[index % SPLIT_TONES.length]}`} style={{ width: `${fraction * 100}%` }}>
                {fraction > 0.3 ? `${group.members.length} × ${neck(group.spec.neckDiameterMm)} · ${units.num('airflow', group.totalM3h)}`
                  : fraction > 0.12 ? `${group.members.length} × ${neck(group.spec.neckDiameterMm)}` : ''}
              </span>
            );
          })}
        </div>
      ) : system !== null && system > 0 ? (
        <Meter className="mt-1.5 h-1 rounded-full" segments={[{ fraction: allocated / system, className: ok ? 'bg-emerald-500' : 'bg-amber-500' }]} />
      ) : null}
      {mismatch || unserved ? (
        <p className="mt-1 text-[10.5px] leading-4 text-amber-800" role="status">
          {mismatch ? `${units.fmt('airflow', Math.abs(difference))} ${difference > 0 ? 'over the system airflow: lower a typed value or raise the system airflow.' : 'not allocated: clear a typed value to share it.'}` : ''}
          {unserved ? ` ${unserved} terminal${unserved === 1 ? ' gets' : 's get'} no air.` : ''}
        </p>
      ) : groups.length > 1 ? <p className="mt-1 text-[9.5px] text-slate-400">Shared at one neck velocity: the same spec, the same airflow.</p> : null}
      <div role="table" aria-label="Terminal airflow" className="mt-1">
        {groups.map((group) => {
          const many = group.members.length > 1;
          const open = many && (opened[group.key] ?? group.own > 0);
          const names = many ? `${group.members[0]!.label}…${group.members.at(-1)!.label}` : group.members[0]!.label;
          const ids = group.members.map((member) => member.id);
          return (
            <div key={group.key} role="rowgroup" data-testid="duct-sizing-group">
              <div role="row" className={`${GROUP_COLUMNS} min-h-[32px]`}>
                <TerminalGlyph spec={group.spec} />
                <span role="cell" className="min-w-0">
                  <span className="block truncate text-[11px] text-slate-600" title={group.label}>
                    <b className="font-semibold text-slate-900">{neck(group.spec.neckDiameterMm)}</b> · {TERMINAL_FACE_LABELS[group.spec.kind]}{group.spec.kind === 'linear-slot' && group.spec.slots ? ` ×${group.spec.slots}` : ''}{group.spec.filter ? ` · ${group.spec.filter}` : ''}
                  </span>
                  <span className="block truncate text-[10px] text-slate-400">×{group.members.length} · {group.own ? `${group.own} set on ${group.own === 1 ? 'its' : 'their'} own` : many && group.common === null ? 'same airflow' : names}</span>
                </span>
                <span role="cell" className="flex justify-end">
                  <DuctNumberInput variant="cell" label={many ? `${group.label} airflow each` : `${group.members[0]!.label} airflow`} quantity="airflow" unitSystem={units.system}
                    value={group.common} placeholder={units.num('airflow', group.share)} step={10} min={0.01} max={20000} live={live} allowEmpty className="w-[40px]"
                    suffix={many ? 'each' : units.unit('airflow')}
                    onChange={(value) => onChange(ids, value, `${many ? `${group.label} ×${group.members.length}` : group.members[0]!.label} airflow → ${value === null ? 'share' : `${units.fmt('airflow', value)}${many ? ' each' : ''}`}`)} />
                </span>
                <span role="cell" className="flex items-center justify-end gap-1 text-[10.5px] tabular-nums text-slate-700"
                  title={`Neck velocity ${units.fmt('velocity', group.neckVelocityMs)} (cap ${units.fmt('velocity', neckCapMs)})${group.grows ? `; takes a ${neck(group.grows)} neck at the next resize` : ''}`}>
                  {group.grows ? <span className="rounded bg-amber-100 px-0.5 text-[9px] font-semibold text-amber-800">→{neck(group.grows)}</span> : units.num('velocity', group.neckVelocityMs)}
                  <StatusDot kind={figureStatus(group.neckVelocityMs, neckCapMs)} />
                </span>
                {many ? (
                  <button type="button" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} each ${group.label}`} onClick={() => setOpened({ ...opened, [group.key]: !open })}
                    className="flex h-5 w-3.5 items-center justify-center rounded text-slate-400 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">
                    {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                  </button>
                ) : <span />}
              </div>
              {open ? group.members.map((member) => (
                <div role="row" key={member.id} className={`${MEMBER_COLUMNS} ml-7 min-h-[26px] text-[11px]`}>
                  <span role="cell" className={`truncate ${member.fixed ? 'font-semibold text-slate-800' : 'text-slate-600'}`} title={member.label}>{member.label}</span>
                  <span role="cell" className="flex justify-end">
                    <DuctNumberInput variant="cell" label={`${member.label} airflow`} quantity="airflow" unitSystem={units.system} value={member.fixed ? member.airflowM3h : null}
                      placeholder={units.num('airflow', member.airflowM3h)} step={10} min={0.01} max={20000} live={live} allowEmpty className="w-[40px]" suffix={units.unit('airflow')}
                      onChange={(value) => onChange([member.id], value, `${member.label} airflow ${member.fixed ? units.fmt('airflow', member.airflowM3h) : 'share'} → ${value === null ? 'share' : units.fmt('airflow', value)}`)} />
                  </span>
                  <span role="cell" className={`text-right text-[10.5px] tabular-nums ${figureStatus(member.neckVelocityMs, neckCapMs) === 'ok' ? 'text-slate-600' : 'font-semibold text-amber-700'}`}
                    title={`Neck velocity ${units.fmt('velocity', member.neckVelocityMs)} (cap ${units.fmt('velocity', neckCapMs)})`}>
                    {units.num('velocity', member.neckVelocityMs)}
                  </span>
                  {member.fixed ? (
                    <button type="button" aria-label={`Share ${member.label} again`} title="Share again" onClick={() => onChange([member.id], null, `${member.label} airflow ${units.fmt('airflow', member.airflowM3h)} → share`)}
                      className="flex h-5 w-3.5 items-center justify-center rounded text-slate-400 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">
                      <X size={11} aria-hidden="true" />
                    </button>
                  ) : <span />}
                </div>
              )) : null}
            </div>
          );
        })}
      </div>
      {footer ? <div className="mt-1.5">{footer}</div> : null}
    </div>
  );
}
