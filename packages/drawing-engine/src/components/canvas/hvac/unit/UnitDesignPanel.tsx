'use client';

/**
 * The unit panel (left side, Unit mode): opens when one AC unit is selected.
 *
 *  - Specification: the maker's data (capacity, airflow per fan speed, the
 *    fan's ESP range and settings, collars, casing, refrigerant, drain,
 *    power, sound), with its sources.
 *  - Duct sizing (ducted units), per service: how the system was first sized
 *    (the record kept at Apply) and what has changed since; continuing it by
 *    constant friction — fan speed, system airflow, main velocity ⇄ friction
 *    rate, velocity limits, each terminal's airflow — where every committed
 *    change resizes the ducts on the drawing as one undo step; the method
 *    step by step; drift from the basis. Before ducts exist the same controls
 *    set what Generate sizes at (the Auto duct card's draft).
 *  - Fan: supply and return together against the fan's ESP, and the setting.
 *
 * The panel is about 300 px wide: two-line rows, not tables.
 */
import {
  AlertTriangle, ArrowRight, CheckCircle2, ChevronLeft, FileText, Gauge, History, Info, RotateCcw, Ruler, Wind,
} from 'lucide-react';
import { useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import { shallow } from 'zustand/shallow';

import { unitSpecificationFor, type AcUnitSpecification } from '../../../../data/unitSpecifications';
import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement, Room } from '../../../../types';
import { DuctNumberInput } from '../duct/DuctNumberInput';
import { BasisEditor, ServiceTabs, SizingMethodSwitch, SizingTable, TerminalAirflowList, type TerminalAirflowRow } from '../duct/DuctSizingSection';
import { airSystemTags, isAirSystemUnit } from '../duct/ductAirSystems';
import {
  autoDuctSelection, resetDuctSystemToInitial, resizeAutoDuctPreview, resizeDuctSystemAtBasis, resizeDuctSystemOnDrawing,
} from '../duct/ductAutoController';
import { isAutoDuctPreviewCurrent, useDuctAutoPreviewStore } from '../duct/ductAutoPreviewStore';
import type { DuctDesignSettings } from '../duct/ductSettings';
import { FAN_SPEED_LABELS, FAN_SPEEDS, neckVelocityMs, readUnitAirData, shareAirflow, type FanSpeed } from '../duct/ductSizing';
import { draftAirflow, draftBases, draftBasis, draftServices, useDuctSizingDraft, useDuctSizingDraftStore, type DuctSizingDraft } from '../duct/ductSizingDraft';
import {
  DUCT_SECTION_SET_BY_LABELS, diameterAtVelocityMm, velocityAtFriction, type DuctMainCheck, type DuctSystemSizingReport,
} from '../duct/ductSystemSizing';
import { readDuctTerminalSpec } from '../duct/ductTerminals';
import type { DuctRunSpec, DuctService, DuctSizingRecord, DuctSystemSizing } from '../duct/ductTypes';
import { legLabel } from '../duct/optimizer/sizingModel';
import {
  continueBasis, dryRunSizing, measureUnitService, necksToGrow, unitDuctSystems, unitEspCheck,
  type ContinueBasisSource, type UnitEspCheck,
} from '../duct/unitAirSide';
import { EquipmentIcon, equipmentIconKind } from '../equipmentIcons';

const SERVICE_LABEL: Record<DuctService, string> = { supply: 'Supply', return: 'Return' };
const SOURCE_LABEL = { entered: 'typed', unit: "the unit's Airflow field", manufacturer: "maker's data" } as const;
const CONTINUE_LABEL: Record<ContinueBasisSource, string> = {
  stored: 'as last sized',
  initial: 'from its first sizing',
  drawn: 'from the main as drawn',
  defaults: 'project defaults',
};

const fixed = (value: number | null | undefined, digits = 0) => (value === null || value === undefined || !Number.isFinite(value) ? '–' : value.toFixed(digits));
const m3h = (m3min: number) => Math.round(m3min * 60);

/** Opens the Properties panel on its Inspect tab (the Auto duct card lives there). */
function openPropertiesPanel(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('smart-drawing:open-properties-panel'));
}

function Card({ title, icon, aside, children, testId, open = true }: { title: string; icon: ReactNode; aside?: ReactNode; children: ReactNode; testId: string; open?: boolean }) {
  return (
    <details className="group rounded-xl border border-amber-200/80 bg-white/90 shadow-[0_1px_0_rgba(148,107,25,0.06)]" open={open} data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-2 text-slate-700 [&::-webkit-details-marker]:hidden">
        <span className="text-slate-500">{icon}</span>
        <span className="text-[11px] font-semibold uppercase tracking-wide">{title}</span>
        {aside ? <span className="ml-auto min-w-0 truncate text-[10px] font-normal normal-case tracking-normal text-slate-500">{aside}</span> : null}
      </summary>
      <div className="space-y-2 border-t border-amber-100 px-2.5 pb-2.5 pt-2">{children}</div>
    </details>
  );
}

function SpecRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_1fr] gap-x-2 text-[11px] leading-4">
      <span className="text-slate-400">{label}</span>
      <span className="min-w-0 text-slate-800">{children}</span>
    </div>
  );
}

function Notice({ tone, children, testId }: { tone: 'info' | 'warn' | 'ok' | 'error'; children: ReactNode; testId?: string }) {
  const style = {
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    warn: 'border-amber-300 bg-amber-50 text-amber-900',
    ok: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    error: 'border-red-200 bg-red-50 text-red-800',
  }[tone];
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'info' ? Info : AlertTriangle;
  return (
    <div className={`flex items-start gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] leading-4 ${style}`} role="status" data-testid={testId}>
      <Icon size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function SmallButton({ onClick, children, title, testId, tone = 'neutral' }: { onClick: () => void; children: ReactNode; title?: string; testId?: string; tone?: 'neutral' | 'primary' }) {
  return (
    <button type="button" onClick={onClick} title={title} data-testid={testId}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium transition-colors ${tone === 'primary'
        ? 'border-sky-700 bg-sky-700 text-white hover:bg-sky-800' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}>
      {children}
    </button>
  );
}

// ---- Header ----

function UnitHeader({ unit, spec, tag, roomName, onShowToolbox }: { unit: HvacElement; spec: AcUnitSpecification | null; tag: string; roomName: string; onShowToolbox: () => void }) {
  const kind = unit.type === 'ducted-ac' ? (spec?.range.includes('high static') ? 'Ducted · high static' : 'Ducted')
    : unit.type === 'outdoor-unit' ? 'Outdoor unit' : unit.type === 'ceiling-cassette-ac' ? 'Cassette' : 'Indoor unit';
  const capacity = spec?.coolingKw ?? (typeof unit.properties.capacityKw === 'number' ? unit.properties.capacityKw : null);
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-amber-200/80 bg-white/90 p-2.5" data-testid="unit-panel-header">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-800 ring-1 ring-sky-200">
        <EquipmentIcon kind={equipmentIconKind({ type: unit.type, subtype: unit.subtype ?? '' })} size={24} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-slate-900" data-testid="unit-panel-tag">{tag}</span>
          {capacity ? <span className="shrink-0 rounded bg-slate-100 px-1 text-[10px] font-medium tabular-nums text-slate-700">{capacity} kW</span> : null}
        </div>
        <p className="truncate text-[11px] text-slate-600" title={unit.modelLabel}>{unit.modelLabel ?? spec?.modelCode ?? unit.type}</p>
        <p className="truncate text-[10px] text-slate-400">{kind} · {roomName}</p>
      </div>
      <button type="button" onClick={onShowToolbox} title="Back to the toolbox (the unit stays selected)" data-testid="unit-panel-toolbox"
        className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-amber-200/80 bg-white px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-amber-50">
        <ChevronLeft size={11} aria-hidden="true" />Toolbox
      </button>
    </div>
  );
}

// ---- Specification ----

function SpecificationCard({ unit, spec }: { unit: HvacElement; spec: AcUnitSpecification | null }) {
  const air = readUnitAirData(unit);
  const typedLps = typeof unit.properties.airflowLps === 'number' && unit.properties.airflowLps > 0 ? unit.properties.airflowLps : null;
  if (!spec) {
    // No maker sheet in the catalogue yet: what the library entry and the element hold, said as such.
    const number = (key: string) => (typeof unit.properties[key] === 'number' && (unit.properties[key] as number) > 0 ? unit.properties[key] as number : null);
    const capacity = number('capacityKw');
    const heating = number('heatingCapacityKw');
    const index = number('capacityIndex');
    const manufacturer = typeof unit.properties.manufacturer === 'string' ? unit.properties.manufacturer : null;
    return (
      <Card title="Specification" icon={<FileText size={12} />} testId="unit-spec" aside={capacity ? `${capacity} kW` : undefined}>
        {manufacturer ? <SpecRow label="Maker">{manufacturer}</SpecRow> : null}
        {capacity ? <SpecRow label="Capacity">{capacity} kW cooling{heating ? ` · ${heating} kW heating` : ''}{index ? ` · index ${index}` : ''}</SpecRow> : null}
        {air.airflowM3h ? <SpecRow label="Airflow">Hi {Math.round(air.airflowM3h.hi)} m³/h</SpecRow> : null}
        <SpecRow label="Size">{Math.round(unit.height)} × {Math.round(unit.width)} × {Math.round(unit.depth)} mm (H × W × D, as placed)</SpecRow>
        {unit.properties.source === 'ifc-glb' ? <SpecRow label="3D body">The maker&apos;s 3D model (MEPcontent IFC)</SpecRow> : null}
        <p className="text-[10px] text-slate-500">No maker specification sheet in the catalogue for {unit.modelLabel ?? 'this model'} yet: airflow, ESP, pipes and sound are not shown.</p>
      </Card>
    );
  }
  const esp = spec.esp;
  const pumpInDrawing = unit.properties.hasDrainPump === true;
  return (
    <Card title="Specification" icon={<FileText size={12} />} testId="unit-spec"
      aside={`${spec.coolingKw} kW${spec.airflowM3min ? ` · ${m3h(spec.airflowM3min.hi)} m³/h` : ''}${esp ? ` · ≤${esp.maxPa} Pa` : ''}`}>
      <SpecRow label="Range">{spec.range}</SpecRow>
      <SpecRow label="Capacity">{spec.coolingKw} kW cooling{spec.heatingKw ? ` · ${spec.heatingKw} kW heating` : ''}</SpecRow>
      {spec.airflowM3min ? (
        <div className="space-y-0.5" data-testid="unit-spec-airflow">
          <span className="text-[11px] text-slate-400">Airflow by fan speed (cooling)</span>
          <div className="grid grid-cols-4 gap-1">
            {FAN_SPEEDS.map((speed) => (
              <div key={speed} className="rounded-md bg-slate-50 px-1 py-0.5 text-center ring-1 ring-slate-100">
                <div className="text-[9px] font-medium uppercase tracking-wide text-slate-400">{FAN_SPEED_LABELS[speed]}</div>
                <div className="text-[11px] font-semibold tabular-nums text-slate-800">{m3h(spec.airflowM3min![speed])}</div>
                <div className="text-[9px] tabular-nums text-slate-400">{Math.round(m3h(spec.airflowM3min![speed]) / 3.6)} L/s</div>
              </div>
            ))}
          </div>
          <span className="block text-[9px] text-slate-400">m³/h · {spec.airflowM3min.hi} m³/min at Hi</span>
        </div>
      ) : null}
      {typedLps ? <Notice tone="info">Its Airflow field ({typedLps} L/s = {Math.round(typedLps * 3.6)} m³/h) overrides the fan speed&apos;s airflow in duct sizing.</Notice> : null}
      {esp ? (
        <SpecRow label="Fan ESP">
          up to {esp.maxPa} Pa{esp.atAirflowM3min ? ` at ${m3h(esp.atAirflowM3min)} m³/h` : ''}{esp.ratedPa ? ` · rated at ${esp.ratedPa} Pa` : ''}
          {esp.settingsPa?.length ? (
            <span className="block text-[10px] text-slate-500">
              Settings {esp.settingsPa[0]}–{esp.settingsPa[esp.settingsPa.length - 1]} Pa{esp.factoryRangePa ? `; as delivered ${esp.factoryRangePa[0]}–${esp.factoryRangePa[1]} Pa` : ''}{esp.extendedBy ? ` (wider: ${esp.extendedBy})` : ''}
            </span>
          ) : null}
        </SpecRow>
      ) : null}
      {spec.collars ? <SpecRow label="Duct collars">Supply {spec.collars.supply[0]} × {spec.collars.supply[1]} · Return {spec.collars.return[0]} × {spec.collars.return[1]} mm</SpecRow> : null}
      <SpecRow label="Casing">{spec.casingMm.height} × {spec.casingMm.width} × {spec.casingMm.depth} mm (H × W × D){spec.weightKg ? ` · ${spec.weightKg} kg` : ''}</SpecRow>
      <SpecRow label="Refrigerant">{spec.refrigerant} · liquid Ø{spec.liquidMm} · gas Ø{spec.gasMm} · {spec.joint}</SpecRow>
      <SpecRow label="Drain">
        {spec.drain.connection} · {spec.drain.pump ? 'drain pump built in' : 'no drain pump'}
        {spec.drain.pump && !pumpInDrawing ? <span className="block text-[10px] text-amber-700">This drawing treats it as gravity (its Drain pump setting).</span> : null}
      </SpecRow>
      <SpecRow label="Power">{spec.power.supply}{spec.power.inputKw ? ` · ${spec.power.inputKw} kW` : ''}</SpecRow>
      {spec.soundDbA ? <SpecRow label="Sound">{FAN_SPEEDS.filter((speed) => spec.soundDbA![speed] !== undefined).map((speed) => `${FAN_SPEED_LABELS[speed]} ${spec.soundDbA![speed]}`).join(' · ')} dB(A)</SpecRow> : null}
      {spec.fan ? <SpecRow label="Fan">{spec.fan}</SpecRow> : null}
      <SpecRow label="3D body">{spec.body === 'catalog-3d' ? "The maker's 3D model (MEPcontent IFC)" : "Drawn to the maker's dimension drawing (no 3D file yet)"}</SpecRow>
      <details className="text-[10px] text-slate-500">
        <summary className="cursor-pointer">Sources ({spec.sources.length})</summary>
        <ul className="mt-0.5 space-y-0.5">
          {spec.sources.map((source) => (
            <li key={source.id}>
              {source.url ? <a href={source.url} target="_blank" rel="noreferrer" className="text-sky-700 underline-offset-2 hover:underline">{source.document}</a> : source.document}
              <span className="text-slate-400"> — {source.reference}</span>
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

// ---- Fan: both services together ----

function FanCard({ esp, unitLabel }: { esp: UnitEspCheck; unitLabel: string }) {
  const max = esp.maxEspPa;
  const share = max ? Math.min(100, (esp.requiredPa / max) * 100) : null;
  const over = esp.withinFan === false;
  const bar = over ? 'bg-red-500' : share !== null && share > 85 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <Card title="Fan" icon={<Gauge size={12} />} testId="unit-fan" aside={`${Math.round(esp.requiredPa)} Pa${max ? ` of ${max}` : ''}`}>
      <div className="space-y-1">
        <div className="flex items-baseline justify-between text-[11px]">
          <span className="text-slate-500">Supply {fixed(esp.supplyPa)} + Return {fixed(esp.returnPa)}</span>
          <span className={`font-semibold tabular-nums ${over ? 'text-red-700' : 'text-slate-900'}`} data-testid="unit-fan-required">{Math.round(esp.requiredPa)} Pa</span>
        </div>
        {share !== null ? (
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
            <div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.max(2, share)}%` }} />
          </div>
        ) : null}
        <p className="text-[10px] text-slate-500">
          One fan delivers both: the two index paths together are the external static pressure {unitLabel} must give{max ? ` (at most ${max} Pa)` : ''}.
        </p>
      </div>
      {over ? <Notice tone="error">Over the fan: lower a friction rate, shorten an index run, or choose a unit with more ESP.</Notice> : null}
      {esp.setting ? (
        <Notice tone={esp.setting.inFactoryRange ? 'ok' : 'warn'} testId="unit-fan-setting">
          Set the unit&apos;s ESP to <strong>{esp.setting.pa} Pa</strong> on the wired remote{esp.setting.note ? ` — ${esp.setting.note}` : ''}.
        </Notice>
      ) : null}
    </Card>
  );
}

// ---- The first sizing ----

function recordDiffs(record: DuctSizingRecord, current: DuctSystemSizing | null, report: DuctSystemSizingReport | null): string[] {
  const out: string[] = [];
  const first = record.basis;
  if (first && current) {
    if (first.fanSpeed !== current.fanSpeed) out.push(`fan speed ${FAN_SPEED_LABELS[first.fanSpeed]} → ${FAN_SPEED_LABELS[current.fanSpeed]}`);
    if ((first.airflowM3h ?? null) !== (current.airflowM3h ?? null)) out.push(`system airflow ${first.airflowM3h ? Math.round(first.airflowM3h) : 'fan speed'} → ${current.airflowM3h ? Math.round(current.airflowM3h) : 'fan speed'} m³/h`);
    if (current.drive === 'friction' && Math.abs(first.frictionPaPerM - current.frictionPaPerM) > 0.004) out.push(`friction ${first.frictionPaPerM.toFixed(2)} → ${current.frictionPaPerM.toFixed(2)} Pa/m`);
    if (current.drive === 'velocity' && Math.abs(first.mainVelocityMs - current.mainVelocityMs) > 0.04) out.push(`main velocity ${first.mainVelocityMs.toFixed(1)} → ${current.mainVelocityMs.toFixed(1)} m/s`);
    for (const part of ['trunk', 'branch', 'runout'] as const) {
      if (Math.abs(first.maxVelocity[part] - current.maxVelocity[part]) > 0.04) out.push(`${part} limit ${first.maxVelocity[part].toFixed(1)} → ${current.maxVelocity[part].toFixed(1)} m/s`);
    }
  }
  if (report) {
    for (const terminal of report.terminals) {
      const then = record.terminals.find((entry) => entry.terminalId === terminal.terminalId);
      if (!then) out.push(`${terminal.label} added`);
      else if (Math.abs(then.airflowM3h - terminal.airflowM3h) > 1) out.push(`${terminal.label} ${Math.round(then.airflowM3h)} → ${Math.round(terminal.airflowM3h)} m³/h`);
    }
  }
  return out;
}

function InitialSizing({ record, current, report, onReset }: {
  record: DuctSizingRecord | undefined; current: DuctSystemSizing | null; report: DuctSystemSizingReport | null; onReset: () => string | null;
}) {
  const [refusal, setRefusal] = useState<string | null>(null);
  if (!record) {
    return (
      <div className="rounded-lg bg-slate-50 px-2 py-1.5 text-[11px] text-slate-500" data-testid="unit-sizing-initial">
        <span className="flex items-center gap-1 font-medium text-slate-600"><History size={11} aria-hidden="true" />First sizing</span>
        No record: these ducts were applied before records were kept (or drawn by hand).
      </div>
    );
  }
  const when = record.designedAt ? new Date(record.designedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;
  const diffs = recordDiffs(record, current, report);
  return (
    <div className="space-y-1 rounded-lg bg-slate-50 px-2 py-1.5 ring-1 ring-slate-100" data-testid="unit-sizing-initial">
      <div className="flex items-center gap-1 text-[11px] font-medium text-slate-700">
        <History size={11} aria-hidden="true" />First sizing
        <span className="ml-auto text-[10px] font-normal text-slate-400">{record.origin === 'auto-route' ? 'Auto route' : 'Auto duct'}{when ? ` · ${when}` : ''}</span>
      </div>
      <SpecRow label="Method">{record.method === 'constant-friction' ? 'Constant friction' : 'Life-cycle optimum'}{record.label ? <span className="block text-[10px] text-slate-500">{record.label}</span> : null}</SpecRow>
      <SpecRow label="Airflow">{FAN_SPEED_LABELS[record.fanSpeed]} · {record.airflowM3h ? `${Math.round(record.airflowM3h)} m³/h` : '–'}{record.airflowSource ? ` (${SOURCE_LABEL[record.airflowSource]})` : ''}</SpecRow>
      <SpecRow label="Main">
        {fixed(record.mainVelocityMs, 1)} m/s · {fixed(record.mainFrictionPaPerM, 2)} Pa/m
        {record.basis ? <span className="block text-[10px] text-slate-500">basis {record.basis.drive === 'friction' ? `${record.basis.frictionPaPerM.toFixed(2)} Pa/m set` : `${record.basis.mainVelocityMs.toFixed(1)} m/s set`}</span> : null}
      </SpecRow>
      <SpecRow label="Limits">trunk {record.maxVelocity.trunk.toFixed(1)} · branch {record.maxVelocity.branch.toFixed(1)} · runout {record.maxVelocity.runout.toFixed(1)} m/s</SpecRow>
      {diffs.length ? (
        <div className="text-[10px] text-slate-600" data-testid="unit-sizing-changes">
          <span className="font-medium text-slate-500">Changed since: </span>{diffs.slice(0, 5).join('; ')}{diffs.length > 5 ? `; and ${diffs.length - 5} more` : ''}
        </div>
      ) : <p className="text-[10px] text-emerald-700">Unchanged since.</p>}
      {record.basis && diffs.length ? (
        <SmallButton testId="unit-sizing-reset" title="Size it again at its first basis, each terminal's airflow as designed (one undo)"
          onClick={() => setRefusal(onReset())}>
          <RotateCcw size={11} aria-hidden="true" />Reset to the first sizing
        </SmallButton>
      ) : null}
      {refusal ? <p className="text-[10px] text-amber-700">{refusal}</p> : null}
    </div>
  );
}

// ---- The method, step by step ----

function Step({ index, title, children }: { index: number; title: string; children: ReactNode }) {
  return (
    <li className="relative pl-6">
      <span className="absolute left-0 top-0 flex h-4 w-4 items-center justify-center rounded-full bg-sky-700 text-[9px] font-semibold text-white">{index}</span>
      <p className="text-[11px] font-medium text-slate-800">{title}</p>
      <div className="mt-0.5 space-y-0.5 text-[10px] leading-4 text-slate-600">{children}</div>
    </li>
  );
}

function ConstantFrictionSteps({ report, sized, sizedMatchesDrawing, basis, service, esp }: {
  report: DuctSystemSizingReport; sized: DuctSystemSizingReport; sizedMatchesDrawing: boolean; basis: DuctSystemSizing; service: DuctService; esp: UnitEspCheck | null;
}) {
  const q = report.main?.airflowM3h ?? report.terminalsAirflowM3h;
  const diameter = q > 0 && basis.mainVelocityMs > 0 ? diameterAtVelocityMm(q, basis.mainVelocityMs) : null;
  const main = (sizedMatchesDrawing ? sized.main : report.main) ?? null;
  const shown = sizedMatchesDrawing ? sized : report;
  const throttled = report.terminals.filter((terminal) => (terminal.throttlePa ?? 0) > 0).sort((a, b) => (b.throttlePa ?? 0) - (a.throttlePa ?? 0));
  return (
    <details className="rounded-lg ring-1 ring-slate-100" data-testid="unit-sizing-steps">
      <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-slate-700">How constant friction sizes it — step by step</summary>
      <ol className="space-y-2 px-2 pb-2">
        <Step index={1} title="System airflow">
          <p>Q = <strong>{report.airflowM3h ? Math.round(report.airflowM3h) : '–'} m³/h</strong> at {FAN_SPEED_LABELS[basis.fanSpeed]}{report.airflowSource ? ` (${SOURCE_LABEL[report.airflowSource]})` : ''}.</p>
          {Math.round(report.terminalsAirflowM3h) !== Math.round(report.airflowM3h ?? 0) ? <p>The terminals take {Math.round(report.terminalsAirflowM3h)} m³/h: the main is linked at that.</p> : null}
        </Step>
        <Step index={2} title="Main velocity ⇄ friction rate">
          <p>
            V = <strong>{basis.mainVelocityMs.toFixed(2)} m/s</strong>{basis.drive === 'velocity' ? ' (set)' : ''} → round equivalent
            Ø = √(4Q / πV) = <strong>{diameter ? Math.round(diameter) : '–'} mm</strong> → R = <strong>{basis.frictionPaPerM.toFixed(2)} Pa/m</strong>{basis.drive === 'friction' ? ' (set)' : ''}.
          </p>
          <p className="text-slate-400">Darcy–Weisbach with the Altshul–Tsal factor; galvanised ε 0.09 mm; air 1.2 kg/m³. A rectangle carrying the same friction is larger than its round equivalent, so it runs slower than V.</p>
        </Step>
        <Step index={3} title={`Every ${SERVICE_LABEL[service].toLowerCase()} section at R, under its velocity limit`}>
          {main ? (
            <p>
              Main {legLabel(main.section)}: {main.velocityMs.toFixed(1)} m/s · {main.frictionPaPerM.toFixed(2)} Pa/m — {DUCT_SECTION_SET_BY_LABELS[main.setBy]}.
              {main.velocityCapped ? ` The ${main.part} limit (${basis.maxVelocity[main.part].toFixed(1)} m/s) governs: under ${basis.frictionPaPerM.toFixed(2)} Pa/m.` : ''}
            </p>
          ) : null}
          {!sizedMatchesDrawing ? <p className="text-amber-700">The drawing differs from constant friction at this basis: the sections below are as drawn; the next change sizes them by it.</p> : null}
          <SizingTable report={shown} />
        </Step>
        {esp ? (
          <Step index={4} title="The fan: index paths together">
            <p>Supply {fixed(esp.supplyPa)} Pa + Return {fixed(esp.returnPa)} Pa = <strong>{Math.round(esp.requiredPa)} Pa</strong>{esp.maxEspPa ? ` against ${esp.maxEspPa} Pa` : ''}.</p>
          </Step>
        ) : null}
        <Step index={esp ? 5 : 4} title="Balancing: dampers take up the rest">
          {throttled.length ? (
            <ul className="space-y-0.5">
              {throttled.slice(0, 6).map((terminal) => <li key={terminal.terminalId}>{terminal.label}: throttle {terminal.throttlePa} Pa</li>)}
            </ul>
          ) : <p>Every path is about the index path: little to throttle.</p>}
        </Step>
      </ol>
    </details>
  );
}

// ---- Applied ducts: continuing by constant friction ----

/** The main as the basis sizes it (as drawn while the drawing differs): section, velocity, friction, and what set it. */
function MainResult({ main, basis, drawn }: { main: DuctMainCheck; basis: DuctSystemSizing; drawn: boolean }) {
  let why: string;
  if (drawn) why = 'as drawn';
  else if (main.setBy === 'minimum' && main.frictionPaPerM < basis.frictionPaPerM - 0.005) {
    // At its smallest it runs under the basis, so a change above that does nothing: say where it starts to grow.
    // Rounded down, so the figure typed does enlarge it.
    const frictionBelow = Math.floor(main.frictionPaPerM * 100) / 100;
    const velocityBelow = Math.floor(velocityAtFriction(main.airflowM3h, main.frictionPaPerM) * 10) / 10;
    why = `already its smallest (never narrower than tall), under the basis: it grows at ≤ ${frictionBelow.toFixed(2)} Pa/m or ≤ ${velocityBelow.toFixed(1)} m/s`;
  } else if (main.setBy === 'friction') why = 'sized by the friction rate';
  else if (main.setBy === 'velocity') why = `the ${main.part} velocity limit sizes it`;
  else why = DUCT_SECTION_SET_BY_LABELS[main.setBy];
  return (
    <div className="rounded-md bg-white px-2 py-1 ring-1 ring-sky-100" data-testid="unit-sizing-main">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-slate-500">Main</span>
        <span className="font-semibold tabular-nums text-slate-900">{legLabel(main.section)} · {main.velocityMs.toFixed(1)} m/s · {main.frictionPaPerM.toFixed(2)} Pa/m</span>
      </div>
      <p className="text-[10px] leading-4 text-slate-500">{why}</p>
    </div>
  );
}

function AppliedSizing({ unit, service, root, rootSpec, report, settings, scene, esp }: {
  unit: HvacElement; service: DuctService; root: HvacElement; rootSpec: DuctRunSpec; report: DuctSystemSizingReport | null;
  settings: DuctDesignSettings; scene: readonly HvacElement[]; esp: UnitEspCheck | null;
}) {
  const setDuctSettings = useSmartDrawingStore((state) => state.setDuctSettings);
  const continued = useMemo(() => continueBasis(scene, unit.id, service, settings), [scene, unit.id, service, settings]);
  const dry = useMemo(() => dryRunSizing(scene, root.id, continued.basis, settings), [scene, root.id, continued.basis, settings]);
  const growing = useMemo(() => necksToGrow(scene, root.id, continued.basis, undefined, settings), [scene, root.id, continued.basis, settings]);
  const air = readUnitAirData(unit);
  const basis = report?.basis ?? continued.basis;
  const sizedByBasis = continued.from === 'stored';
  const matches = sizedByBasis && dry.driftRunIds.length === 0;
  const neckCap = service === 'return' ? settings.autoMaxNeckVelocityReturnMs : settings.autoMaxNeckVelocitySupplyMs;
  const resize = (next: DuctSystemSizing, what: string, airflows?: Record<string, number | null>) => {
    resizeDuctSystemOnDrawing(unit.id, service, next, airflows, `Duct sizing (${service}): ${what}`);
  };
  const rows: TerminalAirflowRow[] = (report?.terminals ?? []).map((terminal) => ({
    id: terminal.terminalId, label: terminal.label, airflowM3h: terminal.airflowM3h, fixed: terminal.fixed,
    neckMm: terminal.neckMm, neckVelocityMs: terminal.neckVelocityMs,
    nextNeckMm: settings.autoNecksFollowAirflow ? growing.find((growth) => growth.terminalId === terminal.terminalId)?.toMm ?? null : null,
  }));
  const capped = report?.main?.velocityCapped ? report.main : null;
  // What the basis makes of the main (the drawing is that when it matches; else the main as drawn).
  const mainNow = matches ? dry.report.main : report?.main ?? null;
  const issues = (report?.issues ?? []).filter((issue) => issue.severity !== 'info');
  return (
    <div className="space-y-2" data-testid="unit-sizing-applied">
      <div className="flex flex-wrap items-center gap-1 text-[11px]" data-testid="unit-sizing-status">
        <span className={`rounded px-1.5 py-0.5 font-medium ${sizedByBasis ? 'bg-sky-100 text-sky-900' : 'bg-violet-100 text-violet-900'}`}>
          {sizedByBasis ? 'Constant friction'
            : rootSpec.initialSizing ? (rootSpec.initialSizing.method === 'life-cycle' ? 'Life-cycle optimum' : 'Constant friction') : 'No sizing basis'}
        </span>
        <span className="tabular-nums text-slate-700">{basis.frictionPaPerM.toFixed(2)} Pa/m · {basis.mainVelocityMs.toFixed(1)} m/s</span>
        <span className="text-[10px] text-slate-400">({CONTINUE_LABEL[continued.from]})</span>
      </div>
      <InitialSizing record={rootSpec.initialSizing} current={sizedByBasis ? continued.basis : null} report={report}
        onReset={() => resetDuctSystemToInitial(unit.id, service).refused ?? null} />

      <div className="space-y-1 rounded-lg border border-sky-100 bg-sky-50/40 p-2" data-testid="unit-sizing-continue">
        <div className="flex items-center gap-1 text-[11px] font-medium text-slate-700">
          <Ruler size={11} aria-hidden="true" />Continue by constant friction
        </div>
        <p className="text-[10px] text-slate-500">
          {sizedByBasis ? 'Each change resizes the ducts on the drawing (one undo).'
            : `${rootSpec.initialSizing ? 'Sized by the life-cycle optimum' : 'Not sized by a basis yet'}: the first change sizes every section by constant friction, ${CONTINUE_LABEL[continued.from]} (${continued.basis.frictionPaPerM.toFixed(2)} Pa/m).`}
        </p>
        {air.airflowM3h ? (
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-slate-500">Fan speed</span>
            <select value={basis.fanSpeed} aria-label="Unit panel fan speed" className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px]"
              onChange={(event) => resize({ ...continued.basis, fanSpeed: event.target.value as FanSpeed, airflowM3h: null }, `fan speed ${FAN_SPEED_LABELS[basis.fanSpeed]} → ${FAN_SPEED_LABELS[event.target.value as FanSpeed]}`)}>
              {FAN_SPEEDS.map((speed) => <option key={speed} value={speed}>{FAN_SPEED_LABELS[speed]} · {Math.round(air.airflowM3h![speed])} m³/h</option>)}
            </select>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="text-slate-500" title="The airflow the main velocity and friction rate are linked at (blank: the fan speed's)">System airflow</span>
          <span className="flex items-center gap-1">
            <DuctNumberInput key={`${unit.id}:${service}:airflow`} label="Unit panel system airflow" value={basis.airflowM3h} step={10} min={0.01} max={50000}
              allowEmpty steppers placeholder={report?.airflowM3h ? String(Math.round(report.airflowM3h)) : 'm³/h'} className="w-16"
              onChange={(value) => resize({ ...continued.basis, airflowM3h: value }, `airflow ${report?.airflowM3h ? Math.round(report.airflowM3h) : '–'} → ${value === null ? 'fan speed' : Math.round(value)} m³/h`)} />
            <span className="text-[10px] text-slate-400">m³/h</span>
          </span>
        </div>
        <BasisEditor key={`${unit.id}:${service}:basis`} basis={basis} live={false} onChange={(next, what) => resize(next, what)} />
        {mainNow ? <MainResult main={mainNow} basis={matches ? dry.report.basis : basis} drawn={!matches} /> : null}
        {capped ? (
          <Notice tone="warn" testId="unit-sizing-governs">
            The main velocity {basis.mainVelocityMs.toFixed(1)} m/s is over the {capped.part} limit ({basis.maxVelocity[capped.part].toFixed(1)} m/s): the limit sizes it ({capped.velocityMs.toFixed(1)} m/s, {capped.frictionPaPerM.toFixed(2)} Pa/m).
            <span className="mt-1 block">
              <SmallButton testId="unit-sizing-raise-limit" title="Raise the limit so the friction rate sizes the main (one undo)"
                onClick={() => {
                  const raised = Math.ceil(basis.mainVelocityMs * 10) / 10;
                  resize({ ...continued.basis, maxVelocity: { ...continued.basis.maxVelocity, [capped.part]: raised } }, `${capped.part} limit ${basis.maxVelocity[capped.part].toFixed(1)} → ${raised.toFixed(1)} m/s`);
                }}>
                Raise the {capped.part} limit to {(Math.ceil(basis.mainVelocityMs * 10) / 10).toFixed(1)} m/s
              </SmallButton>
            </span>
          </Notice>
        ) : null}
        <label className="flex items-center gap-1.5 text-[10px] text-slate-600" title="A terminal whose airflow needs more than its neck's velocity cap takes the next catalogue neck, its flexible runout with it (necks never shrink on their own)">
          <input type="checkbox" checked={settings.autoNecksFollowAirflow} onChange={(event) => setDuctSettings({ autoNecksFollowAirflow: event.target.checked })}
            aria-label="Necks follow airflow" />
          Terminal necks follow their airflow
        </label>
      </div>

      {report ? (
        <div className="space-y-1" data-testid="unit-sizing-terminals">
          <TerminalAirflowList rows={rows} neckCapMs={Math.min(neckCap, basis.maxVelocity.runout)} live={false} systemAirflowM3h={report.airflowM3h}
            onChange={(id, value, what) => resize(continued.basis, what, { [id]: value })} />
          {rows.some((row) => row.fixed) ? (
            <SmallButton testId="unit-sizing-share" title="Clear every terminal's own airflow: each takes an equal share (one undo)"
              onClick={() => resize(continued.basis, 'every terminal → an equal share', Object.fromEntries(rows.map((row) => [row.id, null])))}>
              <Wind size={11} aria-hidden="true" />Share equally
            </SmallButton>
          ) : null}
        </div>
      ) : null}

      {report ? <ConstantFrictionSteps report={report} sized={dry.report} sizedMatchesDrawing={matches} basis={basis} service={service} esp={esp} /> : null}

      {sizedByBasis && dry.driftRunIds.length ? (
        <Notice tone="warn" testId="unit-sizing-drift">
          {dry.driftRunIds.length} run{dry.driftRunIds.length === 1 ? '' : 's'} no longer match {continued.basis.frictionPaPerM.toFixed(2)} Pa/m (a hand edit, a new branch or a changed airflow).
          <span className="mt-1 block">
            <SmallButton testId="unit-sizing-resize" tone="primary" title="Size every section again at this basis (one undo)" onClick={() => resizeDuctSystemAtBasis(unit.id, service)}>
              Re-size at this basis <ArrowRight size={11} aria-hidden="true" />
            </SmallButton>
          </span>
        </Notice>
      ) : null}
      {issues.length ? (
        <ul className="space-y-0.5 text-[10px]" data-testid="unit-sizing-issues">
          {issues.slice(0, 6).map((issue, index) => (
            <li key={index} className={issue.severity === 'error' ? 'text-red-700' : 'text-amber-800'}>{issue.message}</li>
          ))}
          {issues.length > 6 ? <li className="text-slate-400">and {issues.length - 6} more (the run inspector lists them)</li> : null}
        </ul>
      ) : report ? <Notice tone="ok">The {service} ducts plan with no errors or warnings.</Notice> : null}
    </div>
  );
}

// ---- Before ducts exist: what Generate sizes at ----

function DraftSizing({ unit, service, terminals, settings }: { unit: HvacElement; service: DuctService; terminals: readonly HvacElement[]; settings: DuctDesignSettings }) {
  const draft = useDuctSizingDraft(unit.id);
  const update = useDuctSizingDraftStore((state) => state.update);
  const { hvacElements, walls, setDuctSettings } = useSmartDrawingStore((state) => ({ hvacElements: state.hvacElements, walls: state.walls, setDuctSettings: state.setDuctSettings }), shallow);
  const preview = useDuctAutoPreviewStore((state) => ({ result: state.result, scene: state.scene, inputs: state.inputs }), shallow);
  const current = preview.result?.unitId === unit.id && isAutoDuctPreviewCurrent(preview, hvacElements, settings, walls);
  const air = readUnitAirData(unit);
  const counts = { supply: 0, return: 0 };
  for (const terminal of terminals) {
    const kind = readDuctTerminalSpec(terminal)?.service;
    if (kind) counts[kind] += 1;
  }
  const services = draftServices(draft, counts);
  const airflow = draftAirflow(unit, draft);
  const method = settings.autoSizingMethod;
  const basis = draftBasis(service, draft, settings, airflow);
  const serviceTerminals = terminals.filter((terminal) => readDuctTerminalSpec(terminal)?.service === service);
  const shares = shareAirflow(airflow.systemAirflowM3h ?? 0, serviceTerminals.map((terminal) => {
    const spec = readDuctTerminalSpec(terminal)!;
    const set = Object.prototype.hasOwnProperty.call(draft.terminalAirflows, terminal.id) ? draft.terminalAirflows[terminal.id] : spec.designAirflowM3h;
    return { id: terminal.id, spec: { designAirflowM3h: set ?? null } };
  }));
  const rows: TerminalAirflowRow[] = serviceTerminals.map((terminal, index) => {
    const spec = readDuctTerminalSpec(terminal)!;
    const share = shares[index]!;
    return { id: terminal.id, label: terminal.label || spec.kind, airflowM3h: share.airflowM3h, fixed: share.fixed, neckMm: spec.neckDiameterMm, neckVelocityMs: neckVelocityMs(spec, share.airflowM3h) };
  });
  const neckCap = service === 'return' ? settings.autoMaxNeckVelocityReturnMs : settings.autoMaxNeckVelocitySupplyMs;
  const resizePreview = (next: DuctSizingDraft) => {
    if (!current || method !== 'constant-friction') return;
    // The services the preview holds (what the card generated), so its request and the card's inputs stay equal.
    const held = preview.result?.services.filter((entry) => entry.runs.length).map((entry) => entry.service) ?? [];
    resizeAutoDuctPreview(draftBases(held.length ? held : services, next, settings, draftAirflow(unit, next)),
      Object.keys(next.terminalAirflows).length ? next.terminalAirflows : undefined);
  };
  if (!serviceTerminals.length) {
    return (
      <Notice tone="info" testId="unit-sizing-draft">
        No {service} terminals for this unit yet: place them for it from the Air system card (Properties), or pick them on the plan.
      </Notice>
    );
  }
  return (
    <div className="space-y-1.5" data-testid="unit-sizing-draft">
      <Notice tone="info">
        {current ? 'A preview is open: changes resize it live. Apply it in the Auto duct card.'
          : `No ${service} ducts yet. These are what Generate sizes at; generate in the Auto duct card.`}
        <span className="mt-1 block">
          <SmallButton onClick={openPropertiesPanel} testId="unit-sizing-open-auto-duct">Open the Auto duct card <ArrowRight size={11} aria-hidden="true" /></SmallButton>
        </span>
      </Notice>
      <SizingMethodSwitch method={method} onChange={(next) => { if (next !== method) setDuctSettings({ autoSizingMethod: next }); }} />
      {air.airflowM3h ? (
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="text-slate-500">Fan speed</span>
          <select value={draft.fanSpeed} aria-label="Unit panel draft fan speed" className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px]"
            onChange={(event) => update(unit.id, { fanSpeed: event.target.value as FanSpeed })}>
            {FAN_SPEEDS.map((speed) => <option key={speed} value={speed}>{FAN_SPEED_LABELS[speed]} · {Math.round(air.airflowM3h![speed])} m³/h</option>)}
          </select>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-slate-500">System airflow</span>
        <span className="flex items-center gap-1">
          <DuctNumberInput key={`${unit.id}:draft-airflow`} label="Unit panel draft airflow" value={airflow.override} step={10} min={0.01} max={50000} allowEmpty steppers live
            placeholder={airflow.defaultAirflowM3h ? String(Math.round(airflow.defaultAirflowM3h)) : 'm³/h'} className="w-16"
            onChange={(value) => update(unit.id, { airflowDraft: value === null ? '' : String(value) })} />
          <span className="text-[10px] text-slate-400">m³/h</span>
        </span>
      </div>
      {method === 'constant-friction' ? (
        <BasisEditor key={`${unit.id}:${service}:draft`} basis={basis} live onChange={(next) => {
          const nextDraft = { ...draft, bases: { ...draft.bases, [service]: next } };
          update(unit.id, { bases: nextDraft.bases });
          resizePreview(nextDraft);
        }} />
      ) : <p className="text-[10px] text-slate-500">The life-cycle optimum sizes each section for the least first cost plus fan energy; switch to constant friction to set the basis.</p>}
      <TerminalAirflowList rows={rows} neckCapMs={neckCap} systemAirflowM3h={airflow.systemAirflowM3h} live onChange={(id, value) => {
        const nextDraft = { ...draft, terminalAirflows: { ...draft.terminalAirflows, [id]: value } };
        update(unit.id, { terminalAirflows: nextDraft.terminalAirflows });
        resizePreview(nextDraft);
      }} />
    </div>
  );
}

// ---- Duct sizing (both services) and the fan ----

function DuctSizingCards({ unit, spec, settings, scene, rooms }: {
  unit: HvacElement; spec: AcUnitSpecification | null; settings: DuctDesignSettings; scene: readonly HvacElement[]; rooms: ReadonlyArray<Pick<Room, 'id' | 'vertices'>>;
}) {
  const systems = useMemo(() => unitDuctSystems(scene, unit.id), [scene, unit.id]);
  const selection = useMemo(() => autoDuctSelection([unit.id], scene, { rooms, includeConnected: true }), [scene, unit.id, rooms]);
  const terminals = selection?.terminals ?? [];
  const services = (['supply', 'return'] as const).filter((service) => systems.some((system) => system.service === service)
    || terminals.some((terminal) => readDuctTerminalSpec(terminal)?.service === service));
  const [tab, setTab] = useState<DuctService>('supply');
  const active: DuctService = services.includes(tab) ? tab : services[0] ?? 'supply';
  // Each service as drawn; the fan check is the unit's (both together), shown once below.
  const measured = useMemo(() => {
    const out: Partial<Record<DuctService, DuctSystemSizingReport | null>> = {};
    for (const system of systems) out[system.service] = measureUnitService(scene, unit.id, system.service, settings, undefined, { espCheck: false });
    return out;
  }, [systems, scene, unit.id, settings]);
  const air = readUnitAirData(unit);
  const esp = systems.length ? unitEspCheck(measured.supply?.pressure?.indexPa ?? null, measured.return?.pressure?.indexPa ?? null,
    spec?.esp ? { maxPa: spec.esp.maxPa, ...(spec.esp.settingsPa ? { settingsPa: spec.esp.settingsPa } : {}), ...(spec.esp.factoryRangePa ? { factoryRangePa: spec.esp.factoryRangePa } : {}), ...(spec.esp.extendedBy ? { extendedBy: spec.esp.extendedBy } : {}) }
      : { maxPa: air.maxEspPa }) : null;
  const system = systems.find((entry) => entry.service === active);
  const status = systems.length ? systems.map((entry) => `${SERVICE_LABEL[entry.service]} ${entry.spec.sizing ? `${entry.spec.sizing.frictionPaPerM.toFixed(2)} Pa/m` : 'optimum'}`).join(' · ') : 'no ducts yet';
  return (
    <>
      <Card title="Duct sizing" icon={<Ruler size={12} />} testId="unit-sizing" aside={status}>
        {services.length ? (
          <>
            <ServiceTabs services={services} active={active} onChange={setTab} />
            {system ? (
              <AppliedSizing key={`${unit.id}:${active}`} unit={unit} service={active} root={system.root} rootSpec={system.spec} report={measured[active] ?? null}
                settings={settings} scene={scene} esp={esp} />
            ) : <DraftSizing key={`${unit.id}:${active}:draft`} unit={unit} service={active} terminals={terminals} settings={settings} />}
          </>
        ) : (
          <Notice tone="info" testId="unit-sizing-draft">No ducts and no terminals for this unit yet: place supply and return terminals for it from the Air system card (Properties), then generate its ducts.</Notice>
        )}
      </Card>
      {esp ? <FanCard esp={esp} unitLabel={unit.label || spec?.modelCode || 'the unit'} /> : null}
    </>
  );
}

// ---- The panel ----

export interface UnitDesignPanelProps {
  unitId: string | null;
  onShowToolbox: () => void;
  /** The panel opens by itself when a unit is selected. */
  autoOpen: boolean;
  onAutoOpenChange: (value: boolean) => void;
}

export function UnitDesignPanel({ unitId, onShowToolbox, autoOpen, onAutoOpenChange }: UnitDesignPanelProps) {
  const { hvacElements, ductSettings, rooms } = useSmartDrawingStore((state) => ({
    hvacElements: state.hvacElements, ductSettings: state.ductSettings, rooms: state.rooms,
  }), shallow);
  // Figures follow the drawing a beat behind typing and dragging, never in the way of them.
  const scene = useDeferredValue(hvacElements);
  const unit = unitId ? scene.find((element) => element.id === unitId) ?? hvacElements.find((element) => element.id === unitId) ?? null : null;
  const spec = useMemo(() => (unit ? unitSpecificationFor(unit) : null), [unit]);
  const tags = useMemo(() => airSystemTags(scene), [scene]);
  return (
    <div className="space-y-2.5 p-2.5" data-testid="unit-panel">
      {unit ? (
        <>
          <UnitHeader unit={unit} spec={spec} tag={(isAirSystemUnit(unit) ? tags.get(unit.id) : null) ?? (unit.label || 'Unit')}
            roomName={unit.roomId ? rooms.find((room) => room.id === unit.roomId)?.name ?? 'Unassigned room' : 'No room'} onShowToolbox={onShowToolbox} />
          <SpecificationCard unit={unit} spec={spec} />
          {unit.type === 'ducted-ac' ? <DuctSizingCards unit={unit} spec={spec} settings={ductSettings} scene={scene} rooms={rooms} /> : (
            <p className="px-1 text-[10px] text-slate-500">{unit.type === 'outdoor-unit' ? 'An outdoor unit: no ducts.' : 'Not a ducted unit: no duct sizing.'}</p>
          )}
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-amber-300 bg-white/70 p-4 text-center" data-testid="unit-panel-empty">
          <EquipmentIcon kind="ducted" size={28} className="mx-auto text-slate-400" />
          <p className="mt-2 text-xs font-medium text-slate-700">Select an AC unit</p>
          <p className="mt-1 text-[11px] text-slate-500">Click a unit on the plan: its specification and duct sizing open here.</p>
        </div>
      )}
      <label className="flex items-center gap-1.5 px-1 text-[10px] text-slate-500">
        <input type="checkbox" checked={autoOpen} onChange={(event) => onAutoOpenChange(event.target.checked)} aria-label="Open the unit panel when a unit is selected" />
        Open this panel when a unit is selected
      </label>
    </div>
  );
}
