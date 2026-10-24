'use client';

/**
 * Constant-friction sizing controls, shared by the Auto duct card and the
 * unit panel. Per service: the friction rate and the main's velocity as two
 * linked tiles (the one set last drives, the other follows at the system
 * airflow), the velocity limits by part, the fan speed, and each terminal's
 * airflow. Before Generate they set what Generate sizes at; with a preview
 * they re-size it live; on ducts already in the drawing (the unit panel)
 * each committed change re-sizes them there as one undo step. The sections
 * table shows each section's airflow, size, velocity and friction against
 * its limits, and what set it. The card's summary of applied ducts points to
 * the unit panel.
 */
import { AlertTriangle, ArrowLeftRight, Check, ChevronDown, ChevronLeft, Copy, Link2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';
import { Caption, InfoIcon, Meter, PanelButton, Segmented, StatusDot, fmt } from '../unit/unitPanelKit';

import { DuctNumberInput } from './DuctNumberInput';
import { figureStatus } from './ductSegmentFigures';
import type { DuctDesignSettings } from './ductSettings';
import { FAN_SPEED_LABELS, FAN_SPEEDS, type FanSpeed } from './ductSizing';
import {
  DUCT_SECTION_SET_BY_LABELS,
  ductSystemRootOf,
  sizeDuctSystem,
  sizingOutcomeLine,
  type DuctSectionSetBy,
  type DuctSystemSizingReport,
} from './ductSystemSizing';
import { readDuctRunSpec, type DuctService, type DuctSystemSizing } from './ductTypes';
import { legLabel } from './optimizer/sizingModel';

export type SizingMethod = DuctDesignSettings['autoSizingMethod'];
export type TerminalAirflows = Record<string, number | null>;

const SERVICE_LABEL: Record<DuctService, string> = { supply: 'Supply', return: 'Return' };

export function SizingMethodSwitch({ method, onChange }: { method: SizingMethod; onChange: (method: SizingMethod) => void }) {
  return (
    <Segmented label="Duct sizing method" value={method} onChange={onChange} testId="duct-sizing-method"
      options={[
        { value: 'constant-friction', label: 'Constant friction', title: 'Equal friction (ASHRAE Fundamentals ch. 21): every section at one friction rate, under velocity limits' },
        { value: 'life-cycle', label: 'Life-cycle optimum', title: 'The optimiser sizes every section for the least first cost plus fan energy over the life' },
      ]} />
  );
}

export interface ServiceChoice {
  service: DuctService;
  /** After the name: the service's rate, its terminals, "none". */
  note?: ReactNode;
  /** Why it cannot be chosen (no ducts and no terminals). */
  disabledReason?: string;
}

/** Supply | Return, each with its colour and a note. */
export function ServiceSwitch({ choices, active, onChange }: { choices: readonly ServiceChoice[]; active: DuctService; onChange: (service: DuctService) => void }) {
  return (
    <Segmented label="Sizing service" value={active} onChange={onChange} testId="duct-sizing-service"
      options={choices.map((choice) => ({
        value: choice.service, label: SERVICE_LABEL[choice.service], dot: choice.disabledReason ? 'none' as const : choice.service,
        sub: choice.note, disabled: Boolean(choice.disabledReason), title: choice.disabledReason,
      }))} />
  );
}

/** The services to switch between (none when there is only one). */
export function ServiceTabs({ services, active, onChange }: { services: DuctService[]; active: DuctService; onChange: (service: DuctService) => void }) {
  if (services.length < 2) return null;
  return <ServiceSwitch choices={services.map((service) => ({ service }))} active={active} onChange={onChange} />;
}

/** The fan speed as four segments, each with its airflow; nothing without the unit's airflow data. */
export function FanSpeedPicker({ value, airflowM3h, onChange, label }: {
  value: FanSpeed; airflowM3h: Readonly<Record<FanSpeed, number>> | null; onChange: (speed: FanSpeed) => void; label: string;
}) {
  if (!airflowM3h) return null;
  return (
    <Segmented variant="speed" label={label} value={value} onChange={onChange}
      options={FAN_SPEEDS.map((speed) => ({
        value: speed, label: FAN_SPEED_LABELS[speed], sub: Math.round(airflowM3h[speed]),
        ariaLabel: `${FAN_SPEED_LABELS[speed]} · ${Math.round(airflowM3h[speed])} m³/h`,
      }))} />
  );
}

/** "System airflow" on the left; where it comes from and the field on the right. */
export function SystemAirflowRow({ source, children }: { source?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-2">
      <span className="text-[11px] text-slate-500">System airflow</span>
      <span className="flex items-center gap-1.5">
        {source ? <span className="flex items-center gap-1 text-[10px] text-slate-400">{source}</span> : null}
        {children}
      </span>
    </div>
  );
}

/** What a change to the basis says in the undo history ("friction 0.80 → 1.00 Pa/m"). */
export type BasisChange = (next: DuctSystemSizing, what: string) => void;

const PARTS = [
  { part: 'trunk', label: 'Trunk', hint: 'Sections carrying two terminals or more' },
  { part: 'branch', label: 'Branch', hint: 'Sections carrying one terminal' },
  { part: 'runout', label: 'Runout', hint: 'Flexible runouts to the terminals' },
] as const;

/**
 * The friction rate ⇄ the main's velocity (linked at the system airflow: the
 * one set last drives and is marked SET, the other follows), and the velocity
 * limits by part behind one summary row.
 */
export function BasisEditor({ basis, live, onChange, limitsOpen, onLimitsOpenChange }: {
  basis: DuctSystemSizing; live: boolean; onChange: BasisChange; limitsOpen?: boolean; onLimitsOpenChange?: (open: boolean) => void;
}) {
  const drivesVelocity = basis.drive === 'velocity';
  const [ownOpen, setOwnOpen] = useState(false);
  const open = limitsOpen ?? ownOpen;
  const setOpen = onLimitsOpenChange ?? setOwnOpen;
  const tile = (driving: boolean, title: string, unit: string, hint: string, input: ReactNode) => (
    <div title={hint}
      className={`min-w-0 rounded-[9px] border px-1 pb-1 pt-1.5 transition-colors ${driving ? 'border-sky-300 bg-sky-50/70 shadow-[0_0_0_3px_rgba(14,165,233,0.08)]' : 'border-slate-200 bg-white'}`}>
      <div className="flex items-center justify-between gap-1 px-1 text-[10px] font-medium text-slate-500">
        <span className="truncate">{title}</span>
        {driving
          ? <span className="rounded bg-sky-600 px-1 text-[8.5px] font-bold uppercase leading-3 tracking-wider text-white" title="Set by you: the other follows">Set</span>
          : <Link2 size={11} className="shrink-0 text-slate-300" aria-label="Follows from the other" />}
      </div>
      <div className="mt-0.5 flex min-w-0 items-center">
        {input}
        <span className="shrink-0 pl-1 pr-0.5 text-[10px] text-slate-400">{unit}</span>
      </div>
    </div>
  );
  return (
    <div className="space-y-1" data-testid="duct-sizing-basis">
      <div className="grid grid-cols-[minmax(0,1fr)_14px_minmax(0,1fr)] items-center gap-1">
        {tile(!drivesVelocity, 'Friction rate', 'Pa/m', 'Every section is sized at this friction loss per metre (equal friction)',
          <DuctNumberInput variant="tile" steppers label="Friction rate" value={basis.frictionPaPerM} step={0.05} min={0.1} max={5} live={live} derived={drivesVelocity} digits={2} displayDigits={2} className="w-full"
            onChange={(value) => value !== null && onChange({ ...basis, drive: 'friction', frictionPaPerM: value }, `friction ${fmt(basis.frictionPaPerM, 2)} → ${fmt(value, 2)} Pa/m`)} />)}
        <ArrowLeftRight size={13} className="justify-self-center text-slate-300" aria-hidden="true" />
        {tile(drivesVelocity, 'Main velocity', 'm/s', 'Velocity in the main at the system airflow; the friction rate follows from it',
          <DuctNumberInput variant="tile" steppers label="Main velocity" value={basis.mainVelocityMs} step={0.1} min={1} max={15} live={live} derived={!drivesVelocity} digits={2} displayDigits={1} className="w-full"
            onChange={(value) => value !== null && onChange({ ...basis, drive: 'velocity', mainVelocityMs: value }, `main velocity ${fmt(basis.mainVelocityMs, 1)} → ${fmt(value, 1)} m/s`)} />)}
      </div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="duct-sizing-limits"
        className="flex min-h-7 w-full items-center gap-1.5 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">
        <span className="text-[11px] text-slate-500">Velocity limits</span>
        {open ? <span className="ml-auto text-[10px] text-slate-400">for noise</span>
          : <span className="ml-auto text-[11px] tabular-nums text-slate-700">{fmt(basis.maxVelocity.trunk, 1)} · {fmt(basis.maxVelocity.branch, 1)} · {fmt(basis.maxVelocity.runout, 1)}</span>}
        <span className="text-[10px] text-slate-400">m/s</span>
        <ChevronDown size={12} aria-hidden="true" className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <div className="grid grid-cols-3 gap-1.5">
          {PARTS.map(({ part, label, hint }) => (
            <div key={part} title={hint} className="min-w-0 rounded-lg border border-slate-100 bg-slate-50 px-0.5 pb-0.5 pt-1">
              <span className="block px-1 text-[9px] font-semibold uppercase tracking-[0.06em] text-slate-400">{label}</span>
              <DuctNumberInput variant="compact" steppers label={`${label} velocity limit`} value={basis.maxVelocity[part]} step={0.5} min={1} max={15} live={live} displayDigits={1} className="w-full"
                onChange={(value) => value !== null && onChange({ ...basis, maxVelocity: { ...basis.maxVelocity, [part]: value } }, `${part} limit ${fmt(basis.maxVelocity[part], 1)} → ${fmt(value, 1)} m/s`)} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface TerminalAirflowRow {
  id: string;
  label: string;
  airflowM3h: number;
  /** Set on the terminal (or in the card) rather than an equal share. */
  fixed: boolean;
  neckMm: number;
  neckVelocityMs: number;
  /** The neck it takes at the next resize (necks follow airflow), when larger than its own. */
  nextNeckMm?: number | null;
}

const TERMINAL_COLUMNS = 'grid grid-cols-[minmax(0,1fr)_56px_64px_40px] items-center gap-1.5';

/**
 * Each terminal on one line: its neck, its airflow (typed, or grey: an equal
 * share of what the typed ones leave) and its neck velocity against the cap;
 * the allocation against the system airflow above them. `foldable` folds the
 * rows behind their heading when there are more than four.
 */
export function TerminalAirflowList({ rows, neckCapMs, live, onChange, systemAirflowM3h, foldable = false, footer }: {
  rows: TerminalAirflowRow[]; neckCapMs: number; live: boolean; systemAirflowM3h?: number | null;
  onChange: (id: string, value: number | null, what: string) => void; foldable?: boolean; footer?: ReactNode;
}) {
  const [open, setOpen] = useState(!foldable || rows.length <= 4);
  if (!rows.length) return null;
  const allocated = rows.reduce((total, row) => total + row.airflowM3h, 0);
  const system = systemAirflowM3h ?? null;
  const difference = system === null ? 0 : allocated - system;
  const mismatch = system !== null && Math.abs(difference) > Math.max(0.01, system * 1e-6);
  const unserved = rows.filter((row) => row.airflowM3h <= 0).length;
  const ok = !mismatch && !unserved;
  const heading = (
    <>
      <span className="text-[9.5px] font-semibold uppercase tracking-[0.07em] text-slate-400">Terminals · {rows.length}</span>
      {system !== null ? (
        <span className={`ml-auto flex items-center gap-1 text-[10.5px] tabular-nums ${ok ? 'text-emerald-700' : 'text-amber-700'}`} data-testid="duct-sizing-allocation">
          {ok ? <Check size={11} strokeWidth={2.5} aria-hidden="true" /> : <AlertTriangle size={11} aria-hidden="true" />}
          {Number(allocated.toFixed(2))} / {Number(system.toFixed(2))} m³/h
        </span>
      ) : null}
    </>
  );
  return (
    <div data-testid="duct-sizing-terminals">
      {foldable ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">
          {heading}
          <ChevronDown size={12} aria-hidden="true" className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''} ${system === null ? 'ml-auto' : ''}`} />
        </button>
      ) : <div className="flex items-center gap-1.5">{heading}</div>}
      {system !== null && system > 0 ? (
        <Meter className="mt-1.5 h-1 rounded-full" segments={[{ fraction: allocated / system, className: ok ? 'bg-emerald-500' : 'bg-amber-500' }]} />
      ) : null}
      {mismatch || unserved ? (
        <p className="mt-1 text-[10.5px] leading-4 text-amber-800" role="status">
          {mismatch ? `${Number(Math.abs(difference).toFixed(2))} m³/h ${difference > 0 ? 'over the system airflow: lower a typed value or raise the system airflow.' : 'not allocated: clear a typed value to share it.'}` : ''}
          {unserved ? ` ${unserved} terminal${unserved === 1 ? ' gets' : 's get'} no air.` : ''}
        </p>
      ) : null}
      {open ? (
        <div role="table" aria-label="Terminal airflow" className="mt-1.5">
          <div role="row" className={`${TERMINAL_COLUMNS} text-[9px] font-semibold uppercase tracking-[0.06em] text-slate-400`}>
            <span role="columnheader">Terminal</span>
            <span role="columnheader">Neck</span>
            <span role="columnheader" className="flex items-center justify-end gap-1 normal-case tracking-normal">
              m³/h<InfoIcon label="About terminal airflow" tip="Grey figures are equal shares of what the typed ones leave. Type a value to fix a terminal's airflow; clear it to share again." />
            </span>
            <span role="columnheader" className="text-right">Neck v</span>
          </div>
          {rows.map((row) => {
            const grows = Boolean(row.nextNeckMm && row.nextNeckMm > row.neckMm);
            return (
              <div role="row" key={row.id} className={`${TERMINAL_COLUMNS} min-h-[27px] text-[11px]`}>
                <span role="cell" className="truncate font-medium text-slate-800" title={row.label}>{row.label}</span>
                <span role="cell" className="flex min-w-0 items-center gap-0.5 tabular-nums text-slate-500">
                  Ø{row.neckMm}
                  {grows ? <span className="rounded bg-amber-100 px-0.5 text-[9.5px] font-semibold text-amber-800" title="Its airflow needs a larger neck: it takes this one at the next resize, its runout with it">→{row.nextNeckMm}</span> : null}
                </span>
                <span role="cell" className="flex justify-end">
                  <DuctNumberInput variant="cell" label={`${row.label} airflow`} value={row.fixed ? row.airflowM3h : null} placeholder={String(Math.round(row.airflowM3h))}
                    step={10} min={0.01} max={20000} live={live} allowEmpty className="w-[58px]"
                    onChange={(value) => onChange(row.id, value, `${row.label} airflow ${row.fixed ? Math.round(row.airflowM3h) : 'share'} → ${value === null ? 'share' : Math.round(value)} m³/h`)} />
                </span>
                <span role="cell" className="flex items-center justify-end gap-1 tabular-nums text-slate-700" title={`Neck velocity ${fmt(row.neckVelocityMs, 2)} m/s (cap ${neckCapMs} m/s)`}>
                  {fmt(row.neckVelocityMs, 1)}
                  <StatusDot kind={figureStatus(row.neckVelocityMs, neckCapMs)} />
                </span>
              </div>
            );
          })}
          {footer ? <div className="mt-1 flex justify-end">{footer}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---- The sections ----

/** What set a section, as a colour: the rate, a limit, a size rule, a fitting, the terminal end, or as it is. */
const SET_BY_GROUP: Record<DuctSectionSetBy, { swatch: string; legend: string }> = {
  friction: { swatch: 'bg-sky-500', legend: 'friction rate' },
  velocity: { swatch: 'bg-amber-500', legend: 'velocity limit' },
  capped: { swatch: 'bg-red-500', legend: 'void' },
  minimum: { swatch: 'bg-slate-300', legend: 'size rule' },
  aspect: { swatch: 'bg-slate-300', legend: 'size rule' },
  'take-off': { swatch: 'bg-teal-500', legend: 'fitting' },
  split: { swatch: 'bg-teal-500', legend: 'fitting' },
  downstream: { swatch: 'bg-teal-500', legend: 'fitting' },
  carried: { swatch: 'bg-teal-500', legend: 'fitting' },
  neck: { swatch: 'bg-violet-400', legend: 'terminal' },
  runout: { swatch: 'bg-violet-400', legend: 'terminal' },
  'no-flow': { swatch: 'bg-slate-500', legend: 'as it is' },
  locked: { swatch: 'bg-slate-500', legend: 'as it is' },
  drawn: { swatch: 'bg-slate-500', legend: 'as it is' },
};

const SECTION_COLUMNS = 'grid grid-cols-[60px_58px_minmax(0,1fr)_30px_32px_8px] items-center gap-1';

const STATUS_TEXT_CLASS = { ok: '', near: 'font-semibold text-amber-700', over: 'font-semibold text-red-600' } as const;

/** A run's name in the table: "→ SAD-6" for "To SAD-6". */
const runName = (label: string) => label.replace(/^To /, '→ ');

/** Every section, grouped by run: size, airflow, velocity and friction against the limits, and what set it. Copies as a table. */
export function SizingTable({ report }: { report: DuctSystemSizingReport }) {
  const basis = report.basis;
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  const legend = useMemo(() => {
    const seen = new Map<string, string>();
    for (const section of report.sections) {
      const group = SET_BY_GROUP[section.setBy];
      if (!seen.has(group.legend)) seen.set(group.legend, group.swatch);
    }
    return [...seen.entries()];
  }, [report.sections]);
  const statuses = new Set(report.sections.map((section) => figureStatus(section.velocityMs, basis.maxVelocity[section.part])));
  const copy = () => {
    const lines = [
      ['Run', 'Size', 'Airflow m³/h', 'Velocity m/s', 'Friction Pa/m', 'Set by'].join('\t'),
      ...report.sections.map((section) => [section.runLabel, legLabel(section.section), Math.round(section.airflowM3h), fmt(section.velocityMs, 2),
        fmt(section.frictionPaPerM, 3), DUCT_SECTION_SET_BY_LABELS[section.setBy]].join('\t')),
    ];
    void navigator.clipboard?.writeText(lines.join('\n')).then(() => {
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  };
  return (
    <div data-testid="duct-sizing-table">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] text-slate-400">{SERVICE_LABEL[report.service]} at {fmt(basis.frictionPaPerM, 2)} Pa/m, each under its limit</span>
        <PanelButton tone="ghost" onClick={copy} title="Copy the table (paste it into a spreadsheet)" className="!px-1.5 text-[10.5px]">
          {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}{copied ? 'Copied' : 'Copy'}
        </PanelButton>
      </div>
      <div role="table" aria-label={`${SERVICE_LABEL[report.service]} sections`} className="max-h-72 overflow-y-auto text-[10.5px] tabular-nums text-slate-700">
        <div role="row" className={`${SECTION_COLUMNS} sticky top-0 border-b border-slate-100 bg-white pb-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-slate-400`}>
          <span role="columnheader">Run</span>
          <span role="columnheader">Size</span>
          <span role="columnheader" className="text-right normal-case tracking-normal">m³/h</span>
          <span role="columnheader" className="text-right normal-case tracking-normal">m/s</span>
          <span role="columnheader" className="text-right normal-case tracking-normal">Pa/m</span>
          <span role="columnheader" aria-label="Set by" />
        </div>
        {report.sections.map((section, index) => {
          const first = index === 0 || report.sections[index - 1]!.runId !== section.runId;
          const velocity = figureStatus(section.velocityMs, basis.maxVelocity[section.part]);
          const friction = section.frictionPaPerM > basis.frictionPaPerM * 1.001 && section.setBy !== 'runout' ? 'near' as const : 'ok' as const;
          const setBy = DUCT_SECTION_SET_BY_LABELS[section.setBy];
          return (
            <div role="row" key={index} className={`${SECTION_COLUMNS} min-h-[20px] ${first && index > 0 ? 'border-t border-slate-50' : ''}`}>
              <span role="cell" className={`truncate ${section.runId === report.rootRunId ? 'font-semibold text-slate-900' : ''}`} title={section.runLabel}>{first ? runName(section.runLabel) : ''}</span>
              <span role="cell" className="truncate text-slate-900">{legLabel(section.section)}</span>
              <span role="cell" className="text-right">{Math.round(section.airflowM3h)}</span>
              <span role="cell" className={`text-right ${STATUS_TEXT_CLASS[velocity]}`} title={`${fmt(section.velocityMs, 2)} m/s; ${section.part} limit ${fmt(basis.maxVelocity[section.part], 1)} m/s`}>{fmt(section.velocityMs, 1)}</span>
              <span role="cell" className={`text-right ${STATUS_TEXT_CLASS[friction]}`}>{fmt(section.frictionPaPerM, 2)}</span>
              <span role="cell" title={section.note ? `${setBy}: ${section.note}` : setBy} className={`h-[7px] w-[7px] justify-self-end rounded-[2px] ${SET_BY_GROUP[section.setBy].swatch}`} />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-1 text-[9.5px] text-slate-500" aria-label="What set each size">
        {legend.map(([label, swatch]) => (
          <span key={label} className="inline-flex items-center gap-1"><i className={`inline-block h-[7px] w-[7px] rounded-[2px] ${swatch}`} />{label}</span>
        ))}
        {statuses.has('near') ? <span className="inline-flex items-center gap-1"><b className="font-semibold text-amber-700">amber</b>near its limit</span> : null}
        {statuses.has('over') ? <span className="inline-flex items-center gap-1"><b className="font-semibold text-red-600">red</b>over it</span> : null}
      </div>
    </div>
  );
}

/** Asks the editor to show the unit panel (left side) for the selected unit. */
export function openUnitPanel(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('smart-drawing:open-unit-panel'));
}

/**
 * The ducts already on the unit's collars, one line per service: how each is
 * sized now. Continuing it — velocity, friction, each terminal's airflow, the
 * first sizing, the calculation — is the unit panel's (left side).
 */
export function AppliedSizingSummary({ unit }: { unit: HvacElement }) {
  const hvacElements = useSmartDrawingStore((state) => state.hvacElements);
  const ductSettings = useSmartDrawingStore((state) => state.ductSettings);
  const roots = useMemo(() => (['supply', 'return'] as const).flatMap((service) => {
    const root = ductSystemRootOf(hvacElements, unit.id, service);
    if (!root) return [];
    const spec = readDuctRunSpec(root)!;
    // Its basis and what came of it, measured on the ducts as they are.
    const line = spec.sizing ? sizingOutcomeLine(sizeDuctSystem(hvacElements, root.id, { basis: spec.sizing, measure: true, verify: false }, ductSettings).report) : null;
    return [{ service, spec, line }];
  }), [hvacElements, ductSettings, unit.id]);
  if (!roots.length) return null;
  return (
    <div className="space-y-1.5 rounded-[10px] border border-sky-100 bg-white p-2" data-testid="duct-sizing-applied-summary">
      <Caption>Ducts on this unit</Caption>
      <ul className="space-y-1 text-[10.5px] leading-4 text-slate-600">
        {roots.map(({ service, spec, line }) => (
          <li key={service} className="flex min-w-0 items-start gap-1.5">
            <StatusDot kind={service} className="mt-[5px]" />
            <span className="font-medium text-slate-800">{SERVICE_LABEL[service]}</span>
            <span className="min-w-0">
              {line ?? (spec.sizing ? `constant friction ${fmt(spec.sizing.frictionPaPerM, 2)} Pa/m · ${fmt(spec.sizing.mainVelocityMs, 1)} m/s`
                : spec.initialSizing ? 'life-cycle optimum' : 'no sizing basis')}
            </span>
          </li>
        ))}
      </ul>
      <PanelButton onClick={openUnitPanel} testId="duct-sizing-open-unit-panel" className="w-full justify-center" title="The unit panel (left) sizes the ducts on this unit">
        <ChevronLeft size={12} aria-hidden="true" />Size it in the unit panel
      </PanelButton>
    </div>
  );
}
