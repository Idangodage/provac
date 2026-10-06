'use client';

/**
 * The segment card of a duct run, in either view. Point at a segment of a
 * selected run and, after a short rest, a peek card shows what it is, the air
 * it carries and its best few alternatives; click it and the card pins beside
 * it with every option: its size, the same air another way (spiral or
 * rectangular, another fitting), a fitting's parameters, its accessories, and
 * how it is built. Hovering an option previews it on the drawing; a click
 * applies it as one undo step, and the card stays on the segment.
 *
 * One card per segment whichever view shows it — the plan overlay and the 3D
 * layer only report what the pointer is on and where that piece is on screen.
 * The card follows its piece every frame (pan, zoom, orbit) by writing its
 * transform directly; React renders only when the focus or the drawing
 * changes. Hover content follows WCAG 2.2 SC 1.4.13: it can be dismissed
 * (Esc), the pointer can move onto it, and it stays while the pointer is on
 * the segment or the card. Options are buttons: Tab or ↑ ↓ reach them,
 * Enter applies.
 */
import { ChevronLeft, ChevronRight, Minus, Plus, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';

import type { HvacElement } from '../../../../types';

import { DuctSegmentGlyph } from './DuctSegmentGlyph';
import { commitDuctSegmentEdit } from './ductEditController';
import { getDuctRunPlan, type DuctFabricationPlan } from './ductFabricationPlanner';
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
} from './ductSegmentOptions';
import { useDuctSegmentUiStore, type DuctSegmentFocus } from './ductSegmentUiStore';
import { ductSegmentOf, neighbourSegment, sectionLabel, segmentIssues, type DuctSegment } from './ductSegments';
import type { DuctDesignSettings } from './ductSettings';
import { equivalentDiameterMm } from './ductSizing';
import { isRoundLeg, roundLeg, type DuctLeg, type DuctRunSpec } from './ductTypes';
import { placePopover, type ScreenRect } from './popoverPlacement';

/** Rest on a segment this long before its card peeks (ms); moving on with a card open is quicker. */
const PEEK_DELAY_MS = 260;
const PEEK_SWITCH_MS = 90;
/** A peek stays this long after the pointer leaves, so it can be reached. */
const PEEK_GRACE_MS = 240;
/** Quick swaps a peek offers. */
const PEEK_SWAPS = 3;

const focusId = (focus: DuctSegmentFocus | null) => (focus ? `${focus.runId}|${focus.key}` : '');

const STATUS_DOT: Record<DuctFigureStatus, string> = { ok: 'bg-emerald-500', near: 'bg-amber-500', over: 'bg-red-500' };
const STATUS_TEXT: Record<DuctFigureStatus, string> = { ok: 'within the limit', near: 'near the limit', over: 'over the limit' };
const BADGES: Record<DuctOptionBadge, { label: string; tone: string; title: string }> = {
  recommended: { label: 'Recommended', tone: 'bg-emerald-50 text-emerald-700 ring-emerald-200', title: 'Lowest life-cycle cost (first cost + fan energy) of the options that break no rule' },
  'lowest-pressure': { label: 'Lowest ΔP', tone: 'bg-sky-50 text-sky-700 ring-sky-200', title: 'Lowest pressure on the fan\'s index path' },
  'lowest-cost': { label: 'Lowest cost', tone: 'bg-amber-50 text-amber-800 ring-amber-200', title: 'Lowest first cost (placeholder rates until the supplier\'s are entered)' },
  'saves-height': { label: 'Saves height', tone: 'bg-indigo-50 text-indigo-700 ring-indigo-200', title: 'Needs 25 mm or more less of the ceiling void' },
};

const number = (value: number, digits = 0) => value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (value: number, digits = 0) => `${value > 0 ? '+' : value < 0 ? '−' : '±'}${number(Math.abs(value), digits)}`;
const range = (span: { max: number; min: number }, digits: number) => (Math.abs(span.max - span.min) < 0.5 * 10 ** -digits
  ? number(span.max, digits)
  : `${number(span.max, digits)}–${number(span.min, digits)}`);

function markRange(segment: DuctSegment): string {
  return segment.marks.length > 1 ? `${segment.marks[0]}…${segment.marks[segment.marks.length - 1]}` : segment.marks[0] ?? '';
}

/** Keep a card beside its anchor every frame (no React render): writes the card's transform directly. */
function useAnchoredCard(cardRef: RefObject<HTMLDivElement | null>, containerRef: RefObject<HTMLDivElement | null>, anchor: () => ScreenRect | null, active: boolean) {
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  useLayoutEffect(() => {
    if (!active) return undefined;
    let frame = 0;
    let last = '';
    const place = () => {
      frame = requestAnimationFrame(place);
      const card = cardRef.current;
      const container = containerRef.current;
      if (!card || !container) return;
      const rect = anchorRef.current();
      const host = container.getBoundingClientRect();
      if (!rect || host.width <= 0) {
        if (card.style.visibility !== 'hidden') card.style.visibility = 'hidden';
        return;
      }
      const local = { left: rect.left - host.left, top: rect.top - host.top, right: rect.right - host.left, bottom: rect.bottom - host.top };
      const placed = placePopover(local, { width: card.offsetWidth, height: card.offsetHeight }, { width: host.width, height: host.height });
      const value = `translate(${Math.round(placed.x)}px, ${Math.round(placed.y)}px)`;
      if (value !== last) {
        card.style.transform = value;
        card.dataset.side = placed.side;
        last = value;
      }
      if (card.style.visibility !== 'visible') card.style.visibility = 'visible';
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

function FlowTiles({ figures }: { figures: DuctSegmentFigures }) {
  const flow = figures.flow!;
  return (
    <div className="grid grid-cols-3 gap-1 px-3 py-2" data-testid="duct-segment-figures">
      <div className="rounded-lg bg-slate-50 px-2 py-1.5">
        <div className="text-[10px] uppercase tracking-wide text-slate-400">Airflow</div>
        <div className="text-[13px] font-semibold tabular-nums text-slate-800">{range(flow.airflowM3h, 0)}</div>
        <div className="text-[10px] text-slate-400">m³/h · {flow.part}</div>
      </div>
      <div className="rounded-lg bg-slate-50 px-2 py-1.5" title={`Velocity ${STATUS_TEXT[flow.velocityStatus]} (${number(flow.limits.velocityMs, 1)} m/s for a ${flow.part})`}>
        <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-400">
          Velocity <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[flow.velocityStatus]}`} aria-hidden="true" />
        </div>
        <div className="text-[13px] font-semibold tabular-nums text-slate-800">{range(flow.velocityMs, 1)}</div>
        <div className="text-[10px] text-slate-400">m/s · ≤ {number(flow.limits.velocityMs, 1)}</div>
      </div>
      <div className="rounded-lg bg-slate-50 px-2 py-1.5" title="Friction over its length, its fitting loss and the main's loss at take-offs along it">
        <div className="text-[10px] uppercase tracking-wide text-slate-400">Pressure</div>
        <div className="text-[13px] font-semibold tabular-nums text-slate-800">{number(flow.totalPa, flow.totalPa < 10 ? 1 : 0)}</div>
        <div className="text-[10px] text-slate-400">Pa{flow.coefficient !== null ? ` · ζ ${number(flow.coefficient, 2)}` : ''}</div>
      </div>
    </div>
  );
}

/** What an option would do, in a line of chips. */
function OptionMetrics({ evaluation }: { evaluation: DuctOptionEvaluation }) {
  const chips: Array<{ text: string; tone: string; title: string }> = [];
  if (evaluation.velocityMs !== null) {
    const status = evaluation.velocityStatus ?? 'ok';
    chips.push({ text: `${number(evaluation.velocityMs, 1)} m/s`, tone: status === 'over' ? 'text-red-700' : status === 'near' ? 'text-amber-700' : 'text-slate-600', title: `Velocity ${STATUS_TEXT[status]}` });
  }
  const pressure = evaluation.deltaIndexPa ?? evaluation.deltaSegmentPa;
  if (pressure !== null && Math.abs(pressure) >= 0.05) {
    chips.push({ text: `ΔP ${signed(pressure, 1)} Pa`, tone: pressure < 0 ? 'text-emerald-700' : 'text-amber-700', title: evaluation.deltaIndexPa !== null ? 'Change on the fan\'s index path' : 'Change in this segment\'s loss' });
  }
  if (Math.abs(evaluation.deltaMassKg) >= 0.05) {
    chips.push({ text: `${signed(evaluation.deltaMassKg, 1)} kg`, tone: evaluation.deltaMassKg < 0 ? 'text-emerald-700' : 'text-slate-600', title: 'Change in galvanised sheet' });
  }
  if (evaluation.deltaOuterHeightMm !== null && Math.abs(evaluation.deltaOuterHeightMm) >= 5) {
    chips.push({ text: `${signed(evaluation.deltaOuterHeightMm)} mm high`, tone: evaluation.deltaOuterHeightMm < 0 ? 'text-emerald-700' : 'text-amber-700', title: 'Change in the height it needs of the void' });
  }
  const errors = evaluation.newIssues.filter((issue) => issue.severity === 'error').length;
  const warnings = evaluation.newIssues.length - errors;
  if (errors) chips.push({ text: `${errors} new error${errors === 1 ? '' : 's'}`, tone: 'text-red-700', title: evaluation.newIssues.filter((issue) => issue.severity === 'error').map((issue) => `${issue.code}: ${issue.message}`).join('\n') });
  if (warnings) chips.push({ text: `${warnings} new warning${warnings === 1 ? '' : 's'}`, tone: 'text-amber-700', title: evaluation.newIssues.filter((issue) => issue.severity === 'warning').map((issue) => `${issue.code}: ${issue.message}`).join('\n') });
  if (chips.length === 0) return null;
  return (
    <span className="mt-0.5 flex flex-wrap gap-x-2 text-[10.5px] tabular-nums">
      {chips.map((chip) => <span key={chip.text} className={chip.tone} title={chip.title}>{chip.text}</span>)}
    </span>
  );
}

function OptionRow({ option, evaluation, badges, compact, onPreview, onApply }: {
  option: DuctSegmentOption;
  evaluation: DuctOptionEvaluation | undefined;
  badges: readonly DuctOptionBadge[];
  compact?: boolean;
  onPreview: (option: DuctSegmentOption | null) => void;
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
      className={`group flex w-full items-start gap-2 rounded-lg px-2 ${compact ? 'py-1' : 'py-1.5'} text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${option.current
        ? 'bg-violet-50/70 ring-1 ring-violet-200' : reason ? 'cursor-not-allowed opacity-50' : 'hover:bg-violet-50/60 focus-visible:bg-violet-50/60'}`}
      title={reason ?? option.detail}
      onPointerEnter={() => (disabled ? undefined : onPreview(option))}
      onPointerLeave={() => onPreview(null)}
      onFocus={() => (disabled ? undefined : onPreview(option))}
      onBlur={() => onPreview(null)}
      onClick={() => (disabled ? undefined : onApply(option))}
    >
      <DuctSegmentGlyph glyph={option.glyph} className={`mt-0.5 shrink-0 ${option.current ? 'text-violet-600' : 'text-slate-500 group-hover:text-violet-600'}`} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1">
          <span className="text-xs font-medium text-slate-800">{option.title}</span>
          {option.current ? <span className="rounded bg-violet-100 px-1 text-[10px] text-violet-700">current</span> : null}
          {badges.map((badge) => (
            <span key={badge} className={`rounded px-1 text-[10px] ring-1 ${BADGES[badge].tone}`} title={BADGES[badge].title}>{BADGES[badge].label}</span>
          ))}
        </span>
        {!compact || reason ? <span className="block text-[11px] leading-snug text-slate-500">{reason ?? option.detail}</span> : null}
        {evaluation && !evaluation.refused && !option.current ? <OptionMetrics evaluation={evaluation} /> : null}
      </span>
    </button>
  );
}

/** Arrow keys move between a list's option buttons. */
function onListKey(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-option-row]')];
  const index = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next = rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length];
  if (next) {
    next.focus();
    event.preventDefault();
    event.stopPropagation();
  }
}

/** Equal-friction size of `section` in the other shape, at the void the duct has. */
function otherShape(section: DuctLeg, settings: DuctDesignSettings, voidHeightMm: number): DuctLeg {
  if (isRoundLeg(section)) {
    const rects = rectangularEquivalents(section.diameterMm!, { maxHeightMm: Math.min(voidHeightMm, section.diameterMm!), maxAspect: settings.aspectRatioAdvisory });
    return [...rects].sort((a, b) => Math.abs(a.widthMm / a.heightMm - 2) - Math.abs(b.widthMm / b.heightMm - 2))[0] ?? { widthMm: section.widthMm, heightMm: section.heightMm };
  }
  return roundEquivalents(section, settings.autoRoundSizesMm).atOrAbove ?? roundLeg(Math.round(equivalentDiameterMm(section)));
}

const STEP = 50;
const FINE_STEP = 10;

function SizeInput({ label, value, onChange, onEnter }: { label: string; value: string; onChange: (value: string) => void; onEnter: () => void }) {
  const bump = (delta: number) => {
    const number = Number.parseFloat(value);
    if (Number.isFinite(number)) onChange(String(Math.max(50, Math.round((number + delta) / 10) * 10)));
  };
  return (
    <span className="inline-flex items-center rounded-md border border-slate-200 bg-white">
      <button type="button" className="px-1 text-slate-500 hover:text-violet-700" aria-label={`${label} smaller`} onClick={() => bump(-STEP)}><Minus size={11} /></button>
      <input
        type="text"
        inputMode="numeric"
        aria-label={label}
        className="w-12 bg-transparent py-0.5 text-center text-xs tabular-nums text-slate-800 focus:outline-none"
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/[^0-9.]/g, ''))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            onEnter();
            event.preventDefault();
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            bump((event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? FINE_STEP : STEP));
            event.preventDefault();
          }
          event.stopPropagation();
        }}
      />
      <button type="button" className="px-1 text-slate-500 hover:text-violet-700" aria-label={`${label} larger`} onClick={() => bump(STEP)}><Plus size={11} /></button>
    </span>
  );
}

/** Type the size of a leg (or of every leg of its size), round or rectangular; see what it does, then apply. */
function SizeEditor({ scene, settings, focus, segment, spec, voidHeightMm, onPreview, onApply }: {
  scene: readonly HvacElement[];
  settings: DuctDesignSettings;
  focus: DuctSegmentFocus;
  segment: DuctSegment;
  spec: DuctRunSpec;
  voidHeightMm: number;
  onPreview: (option: DuctSegmentOption | null) => void;
  onApply: (option: DuctSegmentOption) => void;
}) {
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
    if (option && evaluation && !evaluation.refused) onApply(option);
  };
  return (
    <div className="border-t border-slate-100 px-3 py-2" data-testid="duct-segment-size"
      onPointerEnter={() => (option && !evaluation?.refused ? onPreview(option) : undefined)} onPointerLeave={() => onPreview(null)}>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Size</span>
        <span className="inline-flex rounded-md border border-slate-200 p-0.5" role="radiogroup" aria-label="Shape">
          {(['rect', 'round'] as const).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={shape === value}
              className={`rounded px-1.5 text-[11px] ${shape === value ? 'bg-violet-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              onClick={() => switchShape(value)}>{value === 'rect' ? '▭ Rect' : '◯ Round'}</button>
          ))}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {shape === 'round' ? (
          <>
            <span className="text-xs text-slate-500">Ø</span>
            <SizeInput label="Diameter" value={diameter} onChange={setDiameter} onEnter={apply} />
          </>
        ) : (
          <>
            <SizeInput label="Width" value={width} onChange={setWidth} onEnter={apply} />
            <span className="text-xs text-slate-400">×</span>
            <SizeInput label="Height" value={height} onChange={setHeight} onEnter={apply} />
          </>
        )}
        <span className="text-[10px] text-slate-400">mm</span>
        <button type="button" disabled={!option || Boolean(evaluation?.refused)} onClick={apply}
          className="ml-auto rounded-md bg-violet-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400">
          Apply
        </button>
      </div>
      {sameSize > 1 ? (
        <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500" role="radiogroup" aria-label="Apply to">
          {(['leg', 'size'] as const).map((value) => (
            <label key={value} className="inline-flex cursor-pointer items-center gap-1">
              <input type="radio" name={`scope-${focus.runId}-${focus.key}`} checked={scope === value} onChange={() => setScope(value)} className="accent-violet-600" />
              {value === 'leg' ? 'This leg' : `All ${sameSize} legs of ${sectionLabel(current)}`}
            </label>
          ))}
        </div>
      ) : null}
      {evaluation ? (
        <div className="mt-1 text-[11px]">
          {evaluation.refused ? <span className="text-red-700">{evaluation.refused}</span> : <OptionMetrics evaluation={evaluation} />}
        </div>
      ) : null}
    </div>
  );
}

/** An elbow's radius as a slider: the throat radius in mm, its ratio and the loss; release applies. */
function ElbowTune({ scene, settings, focus, plan, segment, onPreview, onApply }: {
  scene: readonly HvacElement[];
  settings: DuctDesignSettings;
  focus: DuctSegmentFocus;
  plan: DuctFabricationPlan;
  segment: DuctSegment;
  onPreview: (option: DuctSegmentOption | null) => void;
  onApply: (option: DuctSegmentOption) => void;
}) {
  const piece = plan.pieces[segment.pieceIndices[0]!]!;
  const elbow = piece.elbow;
  const node = segment.nodeIndex;
  const inPlane = elbow?.inPlaneMm ?? piece.widthMm;
  const now = elbow && inPlane > 0 ? Math.round((elbow.centrelineRadiusMm / inPlane) * 100) / 100 : 1;
  const [value, setValue] = useState(now);
  useEffect(() => setValue(now), [now]);
  if (!elbow || node === undefined || elbow.style === 'square-vaned') return null;
  const round = elbow.style === 'gored';
  const min = round ? 1 : 0.5;
  const ratioName = round ? 'R/D' : elbow.plane === 'vertical' ? 'R/H' : 'R/W';
  const override = plan.spec.nodeOverrides[String(node)] ?? {};
  const optionAt = (ratio: number): DuctSegmentOption => ({
    id: `tune:${ratio}`, group: 'tune', glyph: round ? 'elbow-gored' : 'elbow-radius', title: `${ratioName} ${ratio}`, detail: 'radius',
    edit: { kind: 'node', runId: focus.runId, node, override: { ...override, ...(round ? {} : { elbowStyle: 'radius' as const }), centrelineRatio: ratio } },
  });
  const throat = Math.max(0, Math.round(value * inPlane - inPlane / 2));
  const changed = Math.abs(value - now) > 0.001;
  const evaluation = changed ? evaluateDuctSegmentOption(scene, settings, focus.runId, focus.key, optionAt(value)) : null;
  const commit = () => {
    if (changed && evaluation && !evaluation.refused) onApply(optionAt(value));
  };
  return (
    <div className="border-t border-slate-100 px-3 py-2" data-testid="duct-segment-tune">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Inner radius</span>
        <span className="text-xs tabular-nums text-slate-700">throat {throat} mm · {ratioName} {value.toFixed(2)}</span>
      </div>
      <input
        type="range" min={min} max={2} step={0.05} value={value} aria-label={`Elbow ${ratioName}`}
        aria-valuetext={`throat radius ${throat} millimetres, ${ratioName} ${value.toFixed(2)}`}
        className="mt-1 w-full accent-violet-600"
        onChange={(event) => {
          const next = Number.parseFloat(event.target.value);
          setValue(next);
          if (Math.abs(next - now) > 0.001) onPreview(optionAt(next));
          else onPreview(null);
        }}
        onPointerUp={commit}
        onKeyUp={(event) => {
          if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End' || event.key === 'PageUp' || event.key === 'PageDown') commit();
        }}
        onKeyDown={(event) => event.stopPropagation()}
      />
      <div className="flex justify-between text-[10px] text-slate-400">
        <span>{round ? 'R/D 1.0 compact' : 'R/W 0.5 square throat (≤ 5 m/s)'}</span>
        <span>{round ? '1.5 Table 3-1' : '1.5 SMACNA RE1'}</span>
        <span>2.0</span>
      </div>
      {evaluation && !evaluation.refused ? <div className="mt-0.5"><OptionMetrics evaluation={evaluation} /></div> : null}
    </div>
  );
}

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
  const [hovered, setHovered] = useState<DuctSegmentOption | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  useAnchoredCard(cardRef, containerRef, () => resolveAnchor(focus), Boolean(segment));
  const pin = useDuctSegmentUiStore((state) => state.pin);
  const unpin = useDuctSegmentUiStore((state) => state.unpin);
  const preview = useCallback((option: DuctSegmentOption | null) => {
    setHovered(option);
    const store = useDuctSegmentUiStore.getState();
    if (!option) {
      if (store.preview) store.setPreview(null);
      return;
    }
    const evaluation = evaluations.get(option.id) ?? evaluateDuctSegmentOption(scene, settings, focus.runId, focus.key, option);
    store.setPreview(evaluation.refused || evaluation.updates.length === 0 ? null : { optionId: option.id, updates: evaluation.updates });
  }, [evaluations, scene, settings, focus.runId, focus.key]);
  // A card closing (or turning to another segment) leaves no preview behind.
  useEffect(() => () => {
    if (useDuctSegmentUiStore.getState().preview) useDuctSegmentUiStore.getState().setPreview(null);
  }, [focus.runId, focus.key]);
  if (!plan || !segment || !context) return null;
  const service = plan.spec.service;
  const pinned = variant === 'pinned';
  const step = (direction: -1 | 1) => {
    const next = neighbourSegment(plan, focus.key, direction);
    if (next) pin({ runId: focus.runId, key: next.key, anchorMark: next.marks[0] ?? null, view: focus.view });
  };
  const apply = (option: DuctSegmentOption) => {
    setHovered(null);
    onApply(focus, option, evaluations.get(option.id));
  };
  const flow = figures?.flow ?? null;
  const construction = figures?.construction ?? null;
  const swaps = options.filter((option) => option.group === 'size' || option.group === 'swap');
  const tunes = options.filter((option) => option.group === 'tune');
  const terminalOptions = options.filter((option) => option.group === 'terminal');
  const accessories = options.filter((option) => option.group === 'accessory');
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
  const editable = !plan.spec.locked && !plan.spec.legacy;
  const sizeable = editable && (segment.kind === 'straight' || segment.kind === 'riser');
  const notes = hovered ? evaluations.get(hovered.id)?.notes ?? [] : [];
  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`${segment.title} ${segment.size}, ${markRange(segment)}`}
      data-testid={pinned ? 'duct-segment-card' : 'duct-segment-peek'}
      data-segment-key={focus.key}
      data-segment-run={focus.runId}
      // The 3D layer leaves pointer events on this card to it.
      data-pipe-edit-gizmo="duct-segment"
      className={`pointer-events-auto absolute left-0 top-0 flex max-h-[min(80vh,640px)] flex-col ${pinned ? 'w-[340px]' : 'w-[290px]'} overflow-hidden rounded-xl border border-slate-200 bg-white/95 text-slate-700 shadow-xl ring-1 ring-black/5 backdrop-blur`}
      style={{ visibility: 'hidden', zIndex: pinned ? 2 : 3 }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="flex items-start gap-2 px-3 pt-2.5">
        <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${service === 'return' ? 'bg-teal-500' : 'bg-blue-600'}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-slate-900">{segment.title}</span>
            <span className="shrink-0 rounded bg-violet-50 px-1 py-0.5 font-mono text-[10px] text-violet-700">{markRange(segment)}</span>
          </div>
          <div className="truncate text-xs text-slate-500" title={segment.detail}>{segment.size}{segment.detail ? ` · ${segment.detail}` : ''}</div>
        </div>
        {pinned ? (
          <div className="flex shrink-0 items-center">
            <button type="button" className="rounded-md p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30" aria-label="Previous segment" title="Previous segment ( [ )"
              disabled={!neighbourSegment(plan, focus.key, -1)} onClick={() => step(-1)}><ChevronLeft size={14} /></button>
            <button type="button" className="rounded-md p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30" aria-label="Next segment" title="Next segment ( ] )"
              disabled={!neighbourSegment(plan, focus.key, 1)} onClick={() => step(1)}><ChevronRight size={14} /></button>
            <button type="button" className="rounded-md p-1 text-slate-500 hover:bg-slate-100" aria-label="Close" title="Close (Esc)" onClick={unpin}><X size={14} /></button>
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {flow ? <FlowTiles figures={figures!} /> : (
          <p className="px-3 py-2 text-xs text-slate-500" data-testid="duct-segment-no-flow">
            {!figures?.system ? 'No airflow: this run is not on a unit\'s system.'
              : !figures.system.terminals ? 'No airflow yet: the system reaches no air terminal.'
                : 'The system has no airflow yet: give the unit or its terminals an airflow.'}
          </p>
        )}
        {flow ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2 text-[11px] text-slate-500">
            <span title={`Friction ${STATUS_TEXT[flow.frictionStatus]} (target ${number(flow.limits.frictionPaPerM, 2)} Pa/m)`}>
              <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle ${STATUS_DOT[flow.frictionStatus]}`} aria-hidden="true" />
              {number(flow.frictionPaPerM, 2)} Pa/m
            </span>
            <span>{flow.terminals} terminal{flow.terminals === 1 ? '' : 's'}</span>
            {flow.onIndexPath ? (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-800" title="The path the fan has to overcome runs through this segment">
                Index path{figures?.system?.indexPa ? ` · ${number(figures.system.indexPa)} Pa` : ''}
              </span>
            ) : null}
          </div>
        ) : null}
        {pinned ? (
          <>
            {sizeable ? (
              <SizeEditor key={`${focus.runId}|${focus.key}|${sectionLabel(plan.spec.legs[segment.legIndex] ?? { widthMm: 0, heightMm: 0 })}`}
                scene={scene} settings={settings} focus={focus} segment={segment} spec={plan.spec} voidHeightMm={context.voidHeightMm}
                onPreview={preview} onApply={apply} />
            ) : null}
            {swaps.length ? (
              <div className="border-t border-slate-100 px-1.5 py-1.5" data-testid="duct-segment-swaps" onKeyDown={onListKey}>
                <div className="px-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  {segment.kind === 'straight' || segment.kind === 'riser' ? 'Same air, another way' : 'Alternatives'}
                </div>
                {swaps.map((option) => (
                  <OptionRow key={option.id} option={option} evaluation={evaluations.get(option.id)} badges={badges.get(option.id) ?? []}
                    onPreview={preview} onApply={apply} />
                ))}
              </div>
            ) : null}
            {tunes.length ? (
              <div className="border-t border-slate-100 px-1.5 py-1.5" data-testid="duct-segment-tunes" onKeyDown={onListKey}>
                <div className="px-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{segment.kind === 'transition' ? 'Taper' : 'Tune'}</div>
                {tunes.map((option) => (
                  <OptionRow key={option.id} option={option} evaluation={evaluations.get(option.id)} badges={[]} compact onPreview={preview} onApply={apply} />
                ))}
              </div>
            ) : null}
            {editable && segment.kind === 'elbow' ? (
              <ElbowTune scene={scene} settings={settings} focus={focus} plan={plan} segment={segment} onPreview={preview} onApply={apply} />
            ) : null}
            {terminalOptions.length ? (
              <div className="border-t border-slate-100 px-1.5 py-1.5" data-testid="duct-segment-terminal" onKeyDown={onListKey}>
                <div className="px-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Terminal</div>
                {terminalOptions.map((option) => (
                  <OptionRow key={option.id} option={option} evaluation={evaluations.get(option.id)} badges={[]} compact onPreview={preview} onApply={apply} />
                ))}
              </div>
            ) : null}
            {accessories.length ? (
              <div className="border-t border-slate-100 px-1.5 py-1.5" data-testid="duct-segment-accessories" onKeyDown={onListKey}>
                <div className="px-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Accessories</div>
                {accessories.map((option) => (
                  <OptionRow key={option.id} option={option} evaluation={evaluations.get(option.id)} badges={[]} compact onPreview={preview} onApply={apply} />
                ))}
              </div>
            ) : null}
            {notes.length ? (
              <div className="border-t border-violet-100 bg-violet-50/60 px-3 py-1.5 text-[11px] text-violet-900" data-testid="duct-segment-notes" aria-live="polite">
                <span className="font-medium">Also changes: </span>{notes.join(' · ')}
              </div>
            ) : null}
            <details className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-600" data-testid="duct-segment-info">
              <summary className="cursor-pointer select-none text-[10px] font-semibold uppercase tracking-wide text-slate-400">How it is built</summary>
              <div className="mt-1 space-y-1">
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
                {figures?.system ? (
                  <div>{figures.system.unitLabel ?? 'unit'} {figures.system.service}{figures.system.airflowM3h ? ` · ${number(figures.system.airflowM3h)} m³/h` : ''}</div>
                ) : null}
              </div>
            </details>
            {issues.length > 0 ? (
              <ul className="space-y-0.5 border-t border-slate-100 px-3 py-1.5 text-[11px]" data-testid="duct-segment-issues">
                {issues.map((issue, index) => (
                  <li key={index} className={issue.severity === 'error' ? 'text-red-700' : 'text-amber-700'}>{issue.code}: {issue.message}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          quick.length ? (
            <div className="border-t border-slate-100 px-1.5 py-1" data-testid="duct-segment-quick" onKeyDown={onListKey}>
              {quick.map((option) => (
                <OptionRow key={option.id} option={option} evaluation={evaluations.get(option.id)} badges={badges.get(option.id) ?? []} compact
                  onPreview={preview} onApply={apply} />
              ))}
            </div>
          ) : null
        )}
      </div>
      <div className="border-t border-slate-100 px-3 py-1.5 text-[10px] text-slate-400">
        {pinned ? '[ ] previous / next segment · ↑ ↓ options · Esc closes'
          : <button type="button" className="hover:text-violet-700" onClick={() => pin(focus)}>All options: click the segment · Esc hides this</button>}
      </div>
    </div>
  );
}

export interface DuctSegmentCardLayerProps {
  enabled: boolean;
  hvacElements: HvacElement[];
  settings: DuctDesignSettings;
  selectedIds: string[];
  /** Client rectangle of a focused segment's anchor piece, or null when it is off screen or gone. */
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

  // A pinned card closes with its run: deselected, deleted, or another tool taken.
  useEffect(() => {
    if (pinned && (!enabled || !selectedIds.includes(pinned.runId))) unpin();
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
