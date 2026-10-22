'use client';

/**
 * Constant-friction sizing controls, shared by the Auto duct card and the
 * unit panel. Per service: the main's velocity and the friction rate, linked
 * (the one set last drives, the other follows at the system airflow), the
 * velocity limits by part, and each terminal's airflow. Before Generate they
 * set what Generate sizes at; with a preview they re-size it live; on ducts
 * already in the drawing (the unit panel) each committed change re-sizes them
 * there as one undo step. The table shows each section: its airflow, size,
 * velocity, friction and what set it. The card's summary of applied ducts
 * points to the unit panel.
 */
import { Link2, Ruler, Wind } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';

import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';

import { DuctNumberInput } from './DuctNumberInput';
import type { DuctDesignSettings } from './ductSettings';
import {
  DUCT_SECTION_SET_BY_LABELS,
  ductSystemRootOf,
  sizeDuctSystem,
  sizingOutcomeLine,
  type DuctSystemSizingReport,
} from './ductSystemSizing';
import { readDuctRunSpec, type DuctService, type DuctSystemSizing } from './ductTypes';
import { legLabel } from './optimizer/sizingModel';

export type SizingMethod = DuctDesignSettings['autoSizingMethod'];
export type TerminalAirflows = Record<string, number | null>;

const SERVICE_LABEL: Record<DuctService, string> = { supply: 'Supply', return: 'Return' };

const fixed = (value: number, digits: number) => (Number.isFinite(value) ? value.toFixed(digits) : '–');

/** A number field with − / + steps: live (every valid keystroke) or committed on Enter / blur. */
function StepNumber({ value, onChange, step, min, max, label, live, derived, digits, placeholder, allowEmpty = false }: {
  value: number | null; onChange: (value: number | null) => void; step: number; min: number; max: number;
  label: string; live: boolean; derived?: boolean; digits?: number; placeholder?: string; allowEmpty?: boolean;
}) {
  return (
    <DuctNumberInput value={value} onChange={onChange} step={step} min={min} max={max} label={label}
      live={live} derived={derived} digits={digits} steppers allowEmpty={allowEmpty} placeholder={placeholder} className="w-14" />
  );
}

function Row({ label, hint, children }: { label: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 py-0.5 text-xs" title={hint}>
      <span className="flex min-w-0 items-center gap-1 text-slate-500">{label}</span>
      <span className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1 text-slate-800">{children}</span>
    </div>
  );
}

export function SizingMethodSwitch({ method, onChange }: { method: SizingMethod; onChange: (method: SizingMethod) => void }) {
  const options: Array<{ key: SizingMethod; label: string; hint: string }> = [
    { key: 'life-cycle', label: 'Life-cycle optimum', hint: 'The optimiser sizes every section for the least first cost plus fan energy over the life' },
    { key: 'constant-friction', label: 'Constant friction', hint: 'Equal friction (ASHRAE Fundamentals ch. 21): every section at one friction rate, under velocity limits' },
  ];
  return (
    <div className="grid grid-cols-2 gap-0.5 rounded-md border border-slate-200 bg-white p-0.5" role="radiogroup" aria-label="Duct sizing method">
      {options.map((option) => (
        <button key={option.key} type="button" role="radio" aria-checked={method === option.key} title={option.hint} onClick={() => onChange(option.key)}
          className={`rounded px-1 py-0.5 text-[11px] ${method === option.key ? 'bg-sky-700 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ServiceTabs({ services, active, onChange }: { services: DuctService[]; active: DuctService; onChange: (service: DuctService) => void }) {
  if (services.length < 2) return null;
  return (
    <div className="flex gap-0.5 text-[11px]" role="tablist" aria-label="Sizing service">
      {services.map((service) => (
        <button key={service} type="button" role="tab" aria-selected={active === service} onClick={() => onChange(service)}
          className={`rounded-t border-b-2 px-2 py-0.5 ${active === service ? (service === 'supply' ? 'border-blue-600 text-blue-800' : 'border-teal-600 text-teal-800') : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
          {SERVICE_LABEL[service]}
        </button>
      ))}
    </div>
  );
}

/** What a change to the basis says in the undo history ("friction 0.80 → 1.00 Pa/m"). */
export type BasisChange = (next: DuctSystemSizing, what: string) => void;

/** The main velocity ⇄ friction rate (linked) and the velocity limits by part. */
export function BasisEditor({ basis, live, onChange }: { basis: DuctSystemSizing; live: boolean; onChange: BasisChange }) {
  const drivesVelocity = basis.drive === 'velocity';
  const marker = (driving: boolean) => (driving
    ? <span className="rounded bg-sky-100 px-1 text-[9px] font-semibold uppercase text-sky-800" title="Set by you">set</span>
    : <span title="Follows from the other at the system airflow"><Link2 size={11} className="text-slate-400" /></span>);
  const limit = (part: 'trunk' | 'branch' | 'runout', label: string) => (
    <Row label={label}>
      <StepNumber label={`${label} velocity limit`} value={basis.maxVelocity[part]} step={0.5} min={1} max={15} live={live}
        onChange={(value) => value !== null && onChange({ ...basis, maxVelocity: { ...basis.maxVelocity, [part]: value } }, `${part} limit ${fixed(basis.maxVelocity[part], 1)} → ${fixed(value, 1)} m/s`)} />
      <span className="w-8 text-[10px] text-slate-400">m/s</span>
    </Row>
  );
  return (
    <div className="space-y-0.5" data-testid="duct-sizing-basis">
      <Row label="Main velocity" hint="Velocity in the main at the system airflow; the friction rate follows from it">
        {marker(drivesVelocity)}
        <StepNumber label="Main velocity" value={basis.mainVelocityMs} step={0.1} min={1} max={15} live={live} derived={!drivesVelocity} digits={2}
          onChange={(value) => value !== null && onChange({ ...basis, drive: 'velocity', mainVelocityMs: value }, `main velocity ${fixed(basis.mainVelocityMs, 1)} → ${fixed(value, 1)} m/s`)} />
        <span className="w-8 text-[10px] text-slate-400">m/s</span>
      </Row>
      <Row label="Friction rate" hint="Every section is sized at this friction loss per metre (equal friction)">
        {marker(!drivesVelocity)}
        <StepNumber label="Friction rate" value={basis.frictionPaPerM} step={0.05} min={0.1} max={5} live={live} derived={drivesVelocity} digits={2}
          onChange={(value) => value !== null && onChange({ ...basis, drive: 'friction', frictionPaPerM: value }, `friction ${fixed(basis.frictionPaPerM, 2)} → ${fixed(value, 2)} Pa/m`)} />
        <span className="w-8 text-[10px] text-slate-400">Pa/m</span>
      </Row>
      <details className="text-[10px] text-slate-600">
        <summary className="cursor-pointer text-slate-500">Velocity limits (noise) · trunk {fixed(basis.maxVelocity.trunk, 1)} · branch {fixed(basis.maxVelocity.branch, 1)} · runout {fixed(basis.maxVelocity.runout, 1)} m/s</summary>
        {limit('trunk', 'Trunk')}
        {limit('branch', 'Branch')}
        {limit('runout', 'Runout')}
      </details>
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

/** Each terminal's airflow: typed, or blank for an equal share of the rest. */
export function TerminalAirflowList({ rows, neckCapMs, live, onChange, systemAirflowM3h }: {
  rows: TerminalAirflowRow[]; neckCapMs: number; live: boolean; systemAirflowM3h?: number | null; onChange: (id: string, value: number | null, what: string) => void;
}) {
  if (!rows.length) return null;
  const allocated = rows.reduce((total, row) => total + row.airflowM3h, 0);
  const difference = systemAirflowM3h === null || systemAirflowM3h === undefined ? 0 : allocated - systemAirflowM3h;
  const mismatch = Math.abs(difference) > Math.max(0.01, (systemAirflowM3h ?? 0) * 1e-6);
  const unserved = rows.filter((row) => row.airflowM3h <= 0).length;
  return (
    <details className="text-[10px] text-slate-600" open={rows.length <= 6} data-testid="duct-sizing-terminals">
      <summary className="flex cursor-pointer items-center gap-1 text-slate-500"><Wind size={11} />Terminal airflow ({rows.length}) · blank = equal share</summary>
      {systemAirflowM3h !== null && systemAirflowM3h !== undefined ? (
        <p className={`mt-1 ${mismatch || unserved ? 'text-amber-700' : 'text-slate-500'}`} role="status">
          {Number(allocated.toFixed(2))} of {Number(systemAirflowM3h.toFixed(2))} m³/h allocated.
          {mismatch ? ` ${Number(Math.abs(difference).toFixed(2))} m³/h ${difference > 0 ? 'over the system airflow: reduce fixed values or increase system airflow.' : 'unallocated: clear a fixed value to share the remainder.'}` : ''}
          {unserved ? ` ${unserved} terminal${unserved === 1 ? ' has' : 's have'} no airflow; reduce fixed values or increase system airflow.` : ''}
        </p>
      ) : null}
      {/* Two lines a terminal: the panel is narrow. */}
      <ul className="mt-0.5 space-y-1">
        {rows.map((row) => (
          <li key={row.id} className="rounded bg-white/70 px-1 py-0.5">
            <div className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate" title={row.label}>{row.label}</span>
              <span className="text-slate-500">Ø{row.neckMm}</span>
              {row.nextNeckMm && row.nextNeckMm > row.neckMm ? (
                <span className="rounded bg-amber-100 px-1 font-medium text-amber-800" title="Its airflow needs a larger neck: it takes this one at the next resize, its runout with it">→ Ø{row.nextNeckMm}</span>
              ) : null}
              <span className={row.neckVelocityMs > neckCapMs + 1e-6 ? 'font-semibold text-amber-700' : 'text-slate-500'} title={`Neck velocity (cap ${neckCapMs} m/s)`}>
                {fixed(row.neckVelocityMs, 1)} m/s
              </span>
            </div>
            <div className="flex items-center gap-1">
              <StepNumber label={`${row.label} airflow`} value={row.fixed ? row.airflowM3h : null} step={10} min={0.01} max={20000} live={live} placeholder="share" allowEmpty
                onChange={(value) => onChange(row.id, value, `${row.label} airflow ${row.fixed ? Math.round(row.airflowM3h) : 'share'} → ${value === null ? 'share' : Math.round(value)} m³/h`)} />
              <span className="text-slate-400">m³/h</span>
              {!row.fixed ? <span className="text-slate-400" title="Equal share of the system airflow">(share {Math.round(row.airflowM3h)})</span> : null}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Every section: airflow, size, velocity, friction and what set it; the fan pressure against the unit's. */
export function SizingTable({ report }: { report: DuctSystemSizingReport }) {
  const basis = report.basis;
  const limitOf = (part: 'trunk' | 'branch' | 'runout') => basis.maxVelocity[part];
  return (
    <div className="rounded-md bg-white/80 p-1" data-testid="duct-sizing-table">
      <div className="flex items-center justify-between text-[10px] text-slate-500">
        <span className="flex items-center gap-1"><Ruler size={11} />{SERVICE_LABEL[report.service]} sections at {fixed(basis.frictionPaPerM, 2)} Pa/m</span>
        {report.pressure ? (
          <span className={report.maxEspPa !== null && (report.requiredEspPa ?? report.pressure.indexPa) > report.maxEspPa ? 'font-semibold text-red-600' : 'text-emerald-700'}
            title="One fan delivers supply and return: their index paths together against its maximum ESP">
            {Math.round(report.pressure.indexPa)} Pa
            {report.otherServicePa ? <span className="text-slate-500"> + {report.service === 'supply' ? 'return' : 'supply'} {Math.round(report.otherServicePa)} = {Math.round(report.requiredEspPa ?? 0)} Pa</span> : null}
            {report.maxEspPa !== null ? <span className="text-slate-500"> of {report.maxEspPa} max</span> : null}
          </span>
        ) : null}
      </div>
      {/* Two lines a section (the panel is narrow): name and size, then airflow · velocity · friction · what set it. */}
      <ul className="max-h-56 space-y-0.5 overflow-y-auto text-[10px] text-slate-700">
        {report.sections.map((section, index) => {
          const overFriction = section.frictionPaPerM > basis.frictionPaPerM * 1.001 && section.setBy !== 'runout';
          const overVelocity = section.velocityMs > limitOf(section.part) * 1.001;
          const setBy = DUCT_SECTION_SET_BY_LABELS[section.setBy];
          return (
            <li key={index} className="border-b border-slate-100 pb-0.5 last:border-0">
              <div className="flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate" title={section.runLabel}>{section.runLabel}</span>
                <span className="font-semibold text-slate-900">{legLabel(section.section)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-1 text-slate-500" title={section.note ? `${setBy}: ${section.note}` : setBy}>
                <span>{section.airflowM3h} m³/h</span>·
                <span className={overVelocity ? 'font-semibold text-amber-700' : ''}>{fixed(section.velocityMs, 1)} m/s</span>·
                <span className={overFriction ? 'font-semibold text-amber-700' : ''}>{fixed(section.frictionPaPerM, 2)} Pa/m</span>·
                <span className="italic">{setBy}</span>
              </div>
            </li>
          );
        })}
      </ul>
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
 * first sizing, the method step by step — is the unit panel's (left side).
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
    <div className="space-y-1 rounded-md border border-sky-100 bg-white/70 p-1.5" data-testid="duct-sizing-applied-summary">
      <p className="text-[11px] font-semibold text-slate-700">Ducts on this unit</p>
      <ul className="space-y-0.5 text-[10px] text-slate-600">
        {roots.map(({ service, spec, line }) => (
          <li key={service} className="flex min-w-0 items-center gap-1">
            <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${service === 'supply' ? 'bg-blue-600' : 'bg-teal-600'}`} aria-hidden="true" />
            <span className="font-medium text-slate-700">{SERVICE_LABEL[service]}</span>
            <span className="truncate">
              {line ?? (spec.sizing ? `constant friction ${fixed(spec.sizing.frictionPaPerM, 2)} Pa/m · ${fixed(spec.sizing.mainVelocityMs, 1)} m/s`
                : spec.initialSizing ? 'life-cycle optimum' : 'no sizing basis')}
            </span>
          </li>
        ))}
      </ul>
      <button type="button" onClick={openUnitPanel} data-testid="duct-sizing-open-unit-panel"
        className="w-full rounded-md border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[11px] font-medium text-sky-800 hover:bg-sky-100">
        ◂ Size it in the unit panel
      </button>
    </div>
  );
}
