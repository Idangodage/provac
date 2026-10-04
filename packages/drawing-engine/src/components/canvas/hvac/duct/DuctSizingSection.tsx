'use client';

/**
 * Constant-friction sizing in the Auto duct card. Per service: the main's
 * velocity and the friction rate, linked (the one set last drives, the other
 * follows at the system airflow), the velocity limits by part, and each
 * terminal's airflow. Before Generate it sets what Generate sizes at; with a
 * preview it re-sizes the preview live; on ducts already in the drawing each
 * committed change re-sizes them there as one undo step. The table shows each
 * section: its airflow, size, velocity, friction and what set it.
 */
import { Link2, Ruler, Wind } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { shallow } from 'zustand/shallow';

import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';

import { DuctNumberInput } from './DuctNumberInput';
import { measureDuctSystem, resizeDuctSystemOnDrawing } from './ductAutoController';
import type { DuctDesignSettings } from './ductSettings';
import { FAN_SPEED_LABELS, FAN_SPEEDS, readUnitAirData, type FanSpeed } from './ductSizing';
import {
  basisAirflowM3h,
  defaultSizingBasis,
  DUCT_SECTION_SET_BY_LABELS,
  ductSystemRootOf,
  linkSizingBasis,
  type DuctSystemSizingReport,
} from './ductSystemSizing';
import { readDuctRunSpec, type DuctService, type DuctSystemSizing } from './ductTypes';
import { legLabel } from './optimizer/sizingModel';

export type SizingMethod = DuctDesignSettings['autoSizingMethod'];
export type TerminalAirflows = Record<string, number | null>;

const SERVICE_LABEL: Record<DuctService, string> = { supply: 'Supply', return: 'Return' };

const fixed = (value: number, digits: number) => (Number.isFinite(value) ? value.toFixed(digits) : '–');

/** A number field with − / + steps: live (every valid keystroke) or committed on Enter / blur. */
function StepNumber({ value, onChange, step, min, max, label, live, derived, placeholder, allowEmpty = false }: {
  value: number | null; onChange: (value: number | null) => void; step: number; min: number; max: number;
  label: string; live: boolean; derived?: boolean; placeholder?: string; allowEmpty?: boolean;
}) {
  return (
    <DuctNumberInput value={value} onChange={onChange} step={step} min={min} max={max} label={label}
      live={live} derived={derived} steppers allowEmpty={allowEmpty} placeholder={placeholder} className="w-14" />
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
        <StepNumber label="Main velocity" value={basis.mainVelocityMs} step={0.1} min={1} max={15} live={live} derived={!drivesVelocity}
          onChange={(value) => value !== null && onChange({ ...basis, drive: 'velocity', mainVelocityMs: value }, `main velocity ${fixed(basis.mainVelocityMs, 1)} → ${fixed(value, 1)} m/s`)} />
        <span className="w-8 text-[10px] text-slate-400">m/s</span>
      </Row>
      <Row label="Friction rate" hint="Every section is sized at this friction loss per metre (equal friction)">
        {marker(!drivesVelocity)}
        <StepNumber label="Friction rate" value={basis.frictionPaPerM} step={0.05} min={0.1} max={5} live={live} derived={drivesVelocity}
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
          <span className={report.maxEspPa !== null && report.pressure.indexPa > report.maxEspPa ? 'font-semibold text-red-600' : 'text-emerald-700'}>
            {Math.round(report.pressure.indexPa)} Pa{report.maxEspPa !== null ? <span className="text-slate-500"> of {report.maxEspPa} max</span> : null}
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

/** The basis a service of a unit is shown with: stored on its root run, else the project's defaults. */
export function basisForUnit(unit: HvacElement, service: DuctService, settings: DuctDesignSettings, stored: DuctSystemSizing | undefined, fanSpeed: FanSpeed = 'hi'): DuctSystemSizing {
  const basis = stored ?? defaultSizingBasis(settings, service, null, fanSpeed);
  return linkSizingBasis(basis, basisAirflowM3h(unit, basis).airflowM3h);
}

/**
 * The ducts already on the unit's collars: their sizing basis (stored, or the
 * project's defaults when the optimiser sized them), and their sections as
 * drawn. Each committed change re-sizes the system on the drawing (one undo).
 */
export function AppliedSystemSizing({ unit }: { unit: HvacElement }) {
  const { hvacElements, ductSettings } = useSmartDrawingStore((state) => ({ hvacElements: state.hvacElements, ductSettings: state.ductSettings }), shallow);
  const roots = useMemo(() => (['supply', 'return'] as const).flatMap((service) => {
    const root = ductSystemRootOf(hvacElements, unit.id, service);
    return root ? [{ service, root, spec: readDuctRunSpec(root)! }] : [];
  }), [hvacElements, unit.id]);
  const [tab, setTab] = useState<DuctService>('supply');
  const active = roots.find((entry) => entry.service === tab) ?? roots[0];
  const basis = useMemo(() => active ? basisForUnit(unit, active.service, ductSettings, active.spec.sizing) : null,
    [active, unit, ductSettings]);
  const report = useMemo(() => (active && basis ? measureDuctSystem(unit.id, active.service, basis) : null),
    // The drawing (and so the stored basis) is what the report follows.
    [hvacElements, ductSettings, active, basis, unit.id]);
  if (!active || !basis) return null;
  const air = readUnitAirData(unit);
  const neckCap = active.service === 'return' ? ductSettings.autoMaxNeckVelocityReturnMs : ductSettings.autoMaxNeckVelocitySupplyMs;
  const resize = (next: DuctSystemSizing, what: string, terminalAirflows?: TerminalAirflows) => {
    const linked = linkSizingBasis(next, basisAirflowM3h(unit, next).airflowM3h);
    resizeDuctSystemOnDrawing(unit.id, active.service, linked, terminalAirflows, `Duct sizing (${active.service}): ${what}`);
  };
  const airflow = basisAirflowM3h(unit, basis);
  return (
    <details className="rounded-md border border-sky-100 bg-white/70 p-1.5" open data-testid="duct-sizing-applied">
      <summary className="cursor-pointer text-[11px] font-semibold text-slate-700">Ducts on this unit — sizing</summary>
      <div className="mt-1 space-y-1">
        <ServiceTabs services={roots.map((entry) => entry.service)} active={active.service} onChange={setTab} />
        <p className="text-[10px] text-slate-500">
          {active.spec.sizing
            ? `Constant friction ${fixed(basis.frictionPaPerM, 2)} Pa/m · ${fixed(basis.mainVelocityMs, 1)} m/s in the main.`
            : 'Sized by the life-cycle optimum (or by hand): a change below sizes it by constant friction.'}
          {' '}Each change resizes the ducts on the drawing (one undo).
        </p>
        {air.airflowM3h ? (
          <Row label="Fan speed" hint="The unit's airflow at this speed is the system airflow, unless one is typed below">
            <select value={basis.fanSpeed} aria-label="Applied sizing fan speed" className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-xs"
              onChange={(event) => resize({ ...basis, fanSpeed: event.target.value as FanSpeed, airflowM3h: null }, `fan speed ${FAN_SPEED_LABELS[basis.fanSpeed]} → ${FAN_SPEED_LABELS[event.target.value as FanSpeed]}`)}>
              {FAN_SPEEDS.map((speed) => <option key={speed} value={speed}>{FAN_SPEED_LABELS[speed]} · {Math.round(air.airflowM3h![speed])} m³/h</option>)}
            </select>
          </Row>
        ) : null}
        <Row label="Airflow" hint="System airflow the friction rate and the main velocity are linked at (blank = the fan speed's)">
          <StepNumber key={`${unit.id}:${active.service}`} label="Applied sizing airflow" value={basis.airflowM3h} step={10} min={0.01} max={50000} live={false} allowEmpty
            onChange={(value) => resize({ ...basis, airflowM3h: value }, `airflow ${airflow.airflowM3h ? Math.round(airflow.airflowM3h) : '–'} → ${value === null ? 'fan speed' : Math.round(value)} m³/h`)} />
          <span className="w-8 text-[10px] text-slate-400">{basis.airflowM3h ? 'm³/h' : `${airflow.airflowM3h ? Math.round(airflow.airflowM3h) : '–'}`}</span>
        </Row>
        <BasisEditor key={`${unit.id}:${active.service}`} basis={basis} live={false} onChange={(next, what) => resize(next, what)} />
        {report ? (
          <TerminalAirflowList neckCapMs={neckCap} live={false} systemAirflowM3h={airflow.airflowM3h}
            rows={report.terminals.map((terminal) => ({ id: terminal.terminalId, label: terminal.label, airflowM3h: terminal.airflowM3h, fixed: terminal.fixed, neckMm: terminal.neckMm, neckVelocityMs: terminal.neckVelocityMs }))}
            onChange={(id, value, what) => resize(basis, what, { [id]: value })} />
        ) : null}
        {report ? <SizingTable report={report} /> : null}
        {report && report.issues.some((issue) => issue.severity !== 'info') ? (
          <ul className="space-y-0.5 text-[10px]">
            {report.issues.filter((issue) => issue.severity !== 'info').slice(0, 6).map((issue, index) => (
              <li key={index} className={issue.severity === 'error' ? 'text-red-600' : 'text-amber-700'}>{issue.code}: {issue.message}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}
