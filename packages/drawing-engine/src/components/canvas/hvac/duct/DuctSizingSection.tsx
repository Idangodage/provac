'use client';

/**
 * Constant-friction sizing parts shared by the Auto duct card and the unit
 * panel: the sizing method and service switches, the sections table (each
 * section's airflow, size, velocity and friction against its limits, and
 * what set it) and the card's summary of ducts already applied, which points
 * to the unit panel. The basis controls themselves — V₀ ⇄ R, the friction
 * slider, the fan speed, the limits, the terminals by spec — are in
 * DuctSizingBasis. Figures are shown in the document's unit system.
 */
import { Check, ChevronLeft, Copy } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';
import { Caption, PanelButton, Segmented, StatusDot } from '../unit/unitPanelKit';
import { useHvacUnits } from '../units/useHvacUnits';

import { figureStatus } from './ductSegmentFigures';
import type { DuctDesignSettings } from './ductSettings';
import {
  DUCT_SECTION_SET_BY_LABELS,
  ductSystemRootOf,
  sizeDuctSystem,
  sizingOutcomeLine,
  type DuctSectionSetBy,
  type DuctSystemSizingReport,
} from './ductSystemSizing';
import { readDuctRunSpec, type DuctService, type DuctSystemSizing } from './ductTypes';

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

/** What a change to the basis says in the undo history ("friction 0.80 → 1.00 Pa/m"). */
export type BasisChange = (next: DuctSystemSizing, what: string) => void;

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

const SECTION_COLUMNS = 'grid grid-cols-[60px_58px_minmax(0,1fr)_32px_36px_8px] items-center gap-1';

const STATUS_TEXT_CLASS = { ok: '', near: 'font-semibold text-amber-700', over: 'font-semibold text-red-600' } as const;

/** A run's name in the table: "→ SAD-6" for "To SAD-6". */
const runName = (label: string) => label.replace(/^To /, '→ ');

/** Every section, grouped by run: size, airflow, velocity and friction against the limits, and what set it. Copies as a table. */
export function SizingTable({ report }: { report: DuctSystemSizingReport }) {
  const units = useHvacUnits();
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
      ['Run', 'Size', `Airflow ${units.unit('airflow')}`, `Velocity ${units.unit('velocity')}`, `Friction ${units.unit('friction')}`, 'Set by'].join('\t'),
      ...report.sections.map((section) => [section.runLabel, units.section(section.section), units.num('airflow', section.airflowM3h),
        units.num('velocity', section.velocityMs, units.digits('velocity') + 1), units.num('friction', section.frictionPaPerM, units.digits('friction') + 1),
        DUCT_SECTION_SET_BY_LABELS[section.setBy]].join('\t')),
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
        <span className="text-[10px] text-slate-400">{SERVICE_LABEL[report.service]} at {units.fmt('friction', basis.frictionPaPerM)}, each under its limit</span>
        <PanelButton tone="ghost" onClick={copy} title="Copy the table (paste it into a spreadsheet)" className="!px-1.5 text-[10.5px]">
          {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}{copied ? 'Copied' : 'Copy'}
        </PanelButton>
      </div>
      <div role="table" aria-label={`${SERVICE_LABEL[report.service]} sections`} className="max-h-72 overflow-y-auto text-[10.5px] tabular-nums text-slate-700">
        <div role="row" className={`${SECTION_COLUMNS} sticky top-0 border-b border-slate-100 bg-white pb-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-slate-400`}>
          <span role="columnheader">Run</span>
          <span role="columnheader">Size</span>
          <span role="columnheader" className="text-right normal-case tracking-normal">{units.unit('airflow')}</span>
          <span role="columnheader" className="text-right normal-case tracking-normal">{units.unit('velocity')}</span>
          <span role="columnheader" className="truncate text-right normal-case tracking-normal" title={units.unit('friction')}>{units.system === 'ip' ? 'in/100' : 'Pa/m'}</span>
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
              <span role="cell" className="truncate text-slate-900">{units.section(section.section)}</span>
              <span role="cell" className="text-right">{units.num('airflow', section.airflowM3h)}</span>
              <span role="cell" className={`text-right ${STATUS_TEXT_CLASS[velocity]}`} title={`${units.fmt('velocity', section.velocityMs)}; ${section.part} limit ${units.fmt('velocity', basis.maxVelocity[section.part])}`}>{units.num('velocity', section.velocityMs)}</span>
              <span role="cell" className={`text-right ${STATUS_TEXT_CLASS[friction]}`}>{units.num('friction', section.frictionPaPerM)}</span>
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
 * sized now. Continuing it — the basis, each terminal's airflow, the network,
 * the friction chart, the first sizing — is the unit panel's (left side).
 */
export function AppliedSizingSummary({ unit }: { unit: HvacElement }) {
  const units = useHvacUnits();
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
              {line ? units.text(line) : spec.sizing ? `constant friction ${units.fmt('friction', spec.sizing.frictionPaPerM)} · ${units.fmt('velocity', spec.sizing.mainVelocityMs)}`
                : spec.initialSizing ? 'life-cycle optimum' : 'no sizing basis'}
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
