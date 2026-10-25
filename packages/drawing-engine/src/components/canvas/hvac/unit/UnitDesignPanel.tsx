'use client';

/**
 * The unit panel (left side, Unit mode): opens when one AC unit is selected.
 *
 *  - Header: the unit's tag, model and room, and three key figures — its
 *    capacity, the airflow its ducts are designed for, and the external static
 *    pressure the fan gives: supply and return together against its maximum,
 *    with the setting to make on the remote.
 *  - Duct sizing (ducted units), one card per service: the constant-friction
 *    basis (fan speed, system airflow, friction rate ⇄ main velocity, velocity
 *    limits), the main duct it gives, each terminal's airflow; folded: the
 *    sections, the calculation and the first sizing. On ducts in the drawing
 *    each committed change resizes them as one undo step; before ducts the same
 *    controls set what Generate sizes at (the Auto duct card's draft).
 *  - Specification: the maker's sheet, compact, with its source.
 *
 * The panel shows figures; explanations sit in tooltips. It is about 312 px
 * wide: one line per item, tables rather than sentences.
 */
import { ArrowRight, Check, ChevronLeft, ExternalLink, MapPin, RotateCcw, Wind, X } from 'lucide-react';
import { useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import { shallow } from 'zustand/shallow';

import { unitSpecificationFor, type AcUnitSpecification } from '../../../../data/unitSpecifications';
import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement, Room } from '../../../../types';
import { DuctNumberInput } from '../duct/DuctNumberInput';
import {
  BasisEditor, FanSpeedPicker, ServiceSwitch, SizingMethodSwitch, SizingTable, SystemAirflowRow, TerminalAirflowList,
  type ServiceChoice, type TerminalAirflowRow,
} from '../duct/DuctSizingSection';
import { airSystemTags, isAirSystemUnit } from '../duct/ductAirSystems';
import {
  autoDuctSelection, resetDuctSystemToInitial, resizeAutoDuctPreview, resizeDuctSystemAtBasis, resizeDuctSystemOnDrawing,
} from '../duct/ductAutoController';
import { isAutoDuctPreviewCurrent, useDuctAutoPreviewStore } from '../duct/ductAutoPreviewStore';
import { figureStatus } from '../duct/ductSegmentFigures';
import type { DuctDesignSettings } from '../duct/ductSettings';
import { FAN_SPEED_LABELS, FAN_SPEEDS, neckVelocityMs, readUnitAirData, shareAirflow, type FanSpeed } from '../duct/ductSizing';
import { draftAirflow, draftBases, draftBasis, draftServices, useDuctSizingDraft, useDuctSizingDraftStore, type DuctSizingDraft } from '../duct/ductSizingDraft';
import {
  DUCT_SECTION_SET_BY_LABELS, diameterAtVelocityMm, velocityAtFriction,
  type DuctAirflowSource, type DuctMainCheck, type DuctSectionSetBy, type DuctSystemSizingReport,
} from '../duct/ductSystemSizing';
import { readDuctTerminalSpec } from '../duct/ductTerminals';
import type { DuctRunSpec, DuctService, DuctSizingRecord, DuctSystemSizing } from '../duct/ductTypes';
import { legLabel } from '../duct/optimizer/sizingModel';
import {
  continueBasis, dryRunSizing, measureUnitService, necksToGrow, unitDuctSystems, unitEspCheck,
  type ContinueBasisSource, type UnitEspCheck, type UnitEspSettings,
} from '../duct/unitAirSide';
import { EquipmentIcon, equipmentIconKind } from '../equipmentIcons';

import {
  CardSection, Caption, Chip, Disclosure, InfoIcon, InfoTip, InlineAlert, KpiTile, PanelButton, PanelCard, Segmented, SpecRows, StatusDot, Switch,
  fmt, type ChipTone, type DotKind, type MeterSegment,
} from './unitPanelKit';
import { useUnitPanelSection, useUnitPanelUiStore, type UnitPanelTab } from './unitPanelUiStore';

const SOURCE_LABEL: Record<DuctAirflowSource, string> = { entered: 'typed', unit: "the unit's Airflow field", manufacturer: "maker's data" };
const CONTINUE_LABEL: Record<ContinueBasisSource, string> = {
  stored: 'as last sized',
  initial: 'from its first sizing',
  drawn: 'from the main as drawn',
  defaults: 'project defaults',
};

const m3h = (m3min: number) => Math.round(m3min * 60);
const lps = (m3hValue: number) => Math.round(m3hValue / 3.6);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Opens the Properties panel on its Inspect tab (the Auto duct card lives there). */
function openPropertiesPanel(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('smart-drawing:open-properties-panel'));
}

/** The fan's ESP settings as the check takes them: the maker's where known, else the unit's maximum. */
function espSettings(spec: AcUnitSpecification | null, maxEspPa: number | null): UnitEspSettings {
  if (!spec?.esp) return { maxPa: maxEspPa };
  return {
    maxPa: spec.esp.maxPa,
    ...(spec.esp.settingsPa ? { settingsPa: spec.esp.settingsPa } : {}),
    ...(spec.esp.factoryRangePa ? { factoryRangePa: spec.esp.factoryRangePa } : {}),
    ...(spec.esp.extendedBy ? { extendedBy: spec.esp.extendedBy } : {}),
  };
}

// ---- The unit's air side, measured once for the header, the tab and the cards ----

interface UnitAirSide {
  systems: ReturnType<typeof unitDuctSystems>;
  measured: Partial<Record<DuctService, DuctSystemSizingReport | null>>;
  /** Supply and return together against the fan; null without ducts. */
  esp: UnitEspCheck | null;
}

function useUnitAirSide(unit: HvacElement | null, spec: AcUnitSpecification | null, settings: DuctDesignSettings, scene: readonly HvacElement[]): UnitAirSide | null {
  return useMemo(() => {
    if (!unit || unit.type !== 'ducted-ac') return null;
    const systems = unitDuctSystems(scene, unit.id);
    // Each service as drawn; the fan check is the unit's (both together).
    const measured: UnitAirSide['measured'] = {};
    for (const system of systems) measured[system.service] = measureUnitService(scene, unit.id, system.service, settings, undefined, { espCheck: false });
    const esp = systems.length
      ? unitEspCheck(measured.supply?.pressure?.indexPa ?? null, measured.return?.pressure?.indexPa ?? null, espSettings(spec, readUnitAirData(unit).maxEspPa))
      : null;
    return { systems, measured, esp };
  }, [unit, spec, settings, scene]);
}

/** The tab's dot: red for errors or a fan short of pressure, amber for warnings, green when clean, grey without ducts. */
function airSideHealth(airSide: UnitAirSide | null): DotKind {
  if (!airSide?.systems.length) return 'none';
  const reports = Object.values(airSide.measured).filter((report): report is DuctSystemSizingReport => Boolean(report));
  if (airSide.esp?.withinFan === false || reports.some((report) => report.errors > 0)) return 'over';
  return reports.some((report) => report.warnings > 0) ? 'near' : 'ok';
}

// ---- Header ----

/** The unit's kind in a word (its pressure class is in its ESP tile and its specification). */
function unitKind(unit: HvacElement): string {
  return unit.type === 'ducted-ac' ? 'Ducted' : unit.type === 'outdoor-unit' ? 'Outdoor' : unit.type === 'ceiling-cassette-ac' ? 'Cassette' : 'Indoor';
}

function numberProperty(unit: HvacElement, key: string): number | null {
  const value = unit.properties[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** The airflow the unit's ducts are designed for, and where it comes from. */
interface DesignAirflow {
  airflowM3h: number | null;
  source: DuctAirflowSource | null;
  fanSpeed: FanSpeed;
}

function FanEspTile({ esp, maxEspPa }: { esp: UnitEspCheck | null; maxEspPa: number | null }) {
  if (!esp) {
    if (maxEspPa === null) return null;
    return <KpiTile label="Fan ESP" value={maxEspPa} unit="Pa max" sub="no ducts yet" testId="unit-fan" />;
  }
  const max = esp.maxEspPa;
  const over = esp.withinFan === false;
  const meter: MeterSegment[] | undefined = max ? [
    { fraction: (esp.supplyPa ?? 0) / max, className: over ? 'bg-red-500' : 'bg-blue-600' },
    { fraction: (esp.returnPa ?? 0) / max, className: over ? 'bg-red-400' : 'bg-teal-600' },
  ] : undefined;
  const sentence = `Supply ${fmt(esp.supplyPa)} Pa + return ${fmt(esp.returnPa)} Pa = ${Math.round(esp.requiredPa)} Pa${max ? ` of the fan's ${max} Pa` : ''}: one fan delivers both.`
    + (esp.setting ? ` Set the unit's ESP to ${esp.setting.pa} Pa on the wired remote${esp.setting.note ? ` — ${esp.setting.note}` : ''}.` : '')
    + (over ? ' Over the fan: lower a friction rate, shorten the index run, or choose a unit with more ESP.' : '');
  const sub = over ? <span className="font-medium text-red-700">over by {Math.round(esp.requiredPa - (max ?? 0))} Pa</span>
    : esp.setting ? <><StatusDot kind={esp.setting.inFactoryRange ? 'ok' : 'near'} />set {esp.setting.pa} Pa</>
      : <>
        <StatusDot kind="supply" /><span className="sr-only">supply</span> {fmt(esp.supplyPa)}
        <StatusDot kind="return" className="ml-1" /><span className="sr-only">return</span> {fmt(esp.returnPa)}
      </>;
  return (
    <InfoTip tip={sentence} block>
      <KpiTile label="Fan ESP" value={Math.round(esp.requiredPa)} unit={max ? `/ ${max} Pa` : 'Pa'} meter={meter} testId="unit-fan"
        sub={<span className="flex min-w-0 items-center gap-1" data-testid="unit-fan-setting">{sub}</span>} />
    </InfoTip>
  );
}

function UnitHeader({ unit, spec, tag, roomName, design, esp, onShowToolbox }: {
  unit: HvacElement; spec: AcUnitSpecification | null; tag: string; roomName: string; design: DesignAirflow; esp: UnitEspCheck | null; onShowToolbox: () => void;
}) {
  const cooling = spec?.coolingKw ?? numberProperty(unit, 'capacityKw');
  const heating = spec?.heatingKw ?? numberProperty(unit, 'heatingCapacityKw');
  const ducted = unit.type === 'ducted-ac';
  const airflowSub = design.airflowM3h === null ? 'no airflow data'
    : design.source === 'entered' ? `typed · ${lps(design.airflowM3h)} L/s`
      : design.source === 'unit' ? `Airflow field · ${lps(design.airflowM3h)} L/s`
        : `${FAN_SPEED_LABELS[design.fanSpeed]} · ${lps(design.airflowM3h)} L/s`;
  const tiles: ReactNode[] = [];
  if (cooling) tiles.push(<KpiTile key="cooling" label="Cooling" value={cooling} unit="kW" sub={heating ? `${heating} kW heat` : undefined} testId="unit-kpi-cooling" title={heating ? `${cooling} kW cooling · ${heating} kW heating` : undefined} />);
  else if (heating) tiles.push(<KpiTile key="heating" label="Heating" value={heating} unit="kW" testId="unit-kpi-heating" />);
  if (design.airflowM3h !== null || ducted) {
    tiles.push(<KpiTile key="airflow" label="Airflow" value={design.airflowM3h === null ? '–' : Math.round(design.airflowM3h)} unit="m³/h" sub={airflowSub} testId="unit-kpi-airflow" />);
  }
  const maxEspPa = spec?.esp?.maxPa ?? readUnitAirData(unit).maxEspPa;
  if (ducted && (esp || maxEspPa !== null)) tiles.push(<FanEspTile key="esp" esp={esp} maxEspPa={maxEspPa} />);
  return (
    <PanelCard testId="unit-panel-header" className="p-3">
      <div className="flex items-start gap-2.5">
        <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] bg-sky-50 text-sky-800 ring-1 ring-inset ring-sky-200">
          <EquipmentIcon kind={equipmentIconKind({ type: unit.type, subtype: unit.subtype ?? '' })} size={24} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-[15px] font-bold tracking-tight text-slate-900" title={tag} data-testid="unit-panel-tag">{tag}</span>
            <Chip>{unitKind(unit)}</Chip>
          </div>
          <p className="truncate text-[11.5px] tabular-nums text-slate-600" title={unit.modelLabel}>{spec?.modelCode ?? unit.modelLabel ?? unit.type}</p>
          <p className="flex min-w-0 items-center gap-1 truncate text-[10.5px] text-slate-400"><MapPin size={11} className="shrink-0" aria-hidden="true" />{roomName}</p>
        </div>
        <PanelButton tone="ghost" onClick={onShowToolbox} title="Back to the toolbox (the unit stays selected)" testId="unit-panel-toolbox" className="-mr-1.5 -mt-1 !px-1.5 text-[10.5px]">
          <ChevronLeft size={12} aria-hidden="true" />Toolbox
        </PanelButton>
      </div>
      {tiles.length ? <div className="mt-2.5 grid grid-cols-3 gap-1.5">{tiles}</div> : null}
    </PanelCard>
  );
}

// ---- Specification ----

function FanSpeedTable({ airflowM3min, sound, designSpeed }: {
  airflowM3min: Readonly<Record<FanSpeed, number>>; sound: AcUnitSpecification['soundDbA']; designSpeed: FanSpeed;
}) {
  const rows: Array<{ unit: string; value: (speed: FanSpeed) => string }> = [
    { unit: 'm³/h', value: (speed) => String(m3h(airflowM3min[speed])) },
    { unit: 'L/s', value: (speed) => String(lps(m3h(airflowM3min[speed]))) },
  ];
  if (sound && FAN_SPEEDS.some((speed) => sound[speed] !== undefined)) rows.push({ unit: 'dB(A)', value: (speed) => (sound[speed] !== undefined ? String(sound[speed]) : '–') });
  // The design speed's column is outlined: its sides on every row, its foot on the last (classes written out whole,
  // so Tailwind finds them).
  const cell = (speed: FanSpeed, last: boolean) => (speed !== designSpeed ? 'text-slate-800'
    : last ? 'rounded-b-[7px] bg-sky-50 font-semibold text-sky-900 shadow-[inset_1px_0_0_#bae6fd,inset_-1px_0_0_#bae6fd,inset_0_-1px_0_#bae6fd]'
      : 'bg-sky-50 font-semibold text-sky-900 shadow-[inset_1px_0_0_#bae6fd,inset_-1px_0_0_#bae6fd]');
  return (
    <div role="table" aria-label="Airflow and sound by fan speed" className="mt-1.5 grid grid-cols-[40px_repeat(4,minmax(0,1fr))] text-[11px] tabular-nums" data-testid="unit-spec-airflow">
      <span role="columnheader" />
      {FAN_SPEEDS.map((speed) => (
        <span key={speed} role="columnheader" title={speed === designSpeed ? 'The ducts are designed at this speed' : undefined}
          className={`py-[3px] text-center text-[10px] font-semibold ${speed === designSpeed ? 'rounded-t-[7px] bg-sky-50 text-sky-700 shadow-[inset_1px_0_0_#bae6fd,inset_-1px_0_0_#bae6fd,inset_0_1px_0_#bae6fd]' : 'text-slate-500'}`}>
          {FAN_SPEED_LABELS[speed]}
        </span>
      ))}
      {rows.map((row, index) => (
        <div key={row.unit} role="row" className="contents">
          <span role="rowheader" className="py-[3px] text-[10px] text-slate-400">{row.unit}</span>
          {FAN_SPEEDS.map((speed) => <span key={speed} role="cell" className={`py-[3px] text-center ${cell(speed, index === rows.length - 1)}`}>{row.value(speed)}</span>)}
        </div>
      ))}
    </div>
  );
}

/** The fan's pressure range on one bar: what it can be set to, what it is delivered at, where its capacity is rated. */
function EspRange({ esp }: { esp: NonNullable<AcUnitSpecification['esp']> }) {
  const at = (pa: number) => `${Math.min(100, Math.max(0, (pa / esp.maxPa) * 100))}%`;
  const settings = esp.settingsPa?.length ? [esp.settingsPa[0]!, esp.settingsPa[esp.settingsPa.length - 1]!] as const : null;
  return (
    <div className="relative mt-2 h-[30px]" aria-hidden="true">
      <div className="absolute inset-x-0 top-2 h-1.5 rounded-full bg-slate-100" />
      {settings ? <div className="absolute top-2 h-1.5 rounded-full bg-sky-200" style={{ left: at(settings[0]), right: `calc(100% - ${at(settings[1])})` }} /> : null}
      {esp.factoryRangePa ? <div className="absolute top-2 h-1.5 rounded-sm bg-sky-500" style={{ left: at(esp.factoryRangePa[0]), right: `calc(100% - ${at(esp.factoryRangePa[1])})` }} /> : null}
      {esp.ratedPa ? <div className="absolute top-1 h-3.5 w-0.5 rounded-sm bg-slate-900" style={{ left: at(esp.ratedPa) }} /> : null}
      <span className="absolute left-0 top-[19px] text-[9.5px] tabular-nums text-slate-400">0</span>
      {esp.ratedPa ? <span className="absolute top-[19px] -translate-x-1/2 whitespace-nowrap text-[9.5px] tabular-nums text-slate-500" style={{ left: at(esp.ratedPa) }}>rated {esp.ratedPa}</span> : null}
      <span className="absolute right-0 top-[19px] text-[9.5px] tabular-nums text-slate-400">{esp.maxPa} Pa</span>
    </div>
  );
}

function SpecificationTab({ unit, spec, designSpeed }: { unit: HvacElement; spec: AcUnitSpecification | null; designSpeed: FanSpeed }) {
  const ducted = unit.type === 'ducted-ac';
  const air = readUnitAirData(unit);
  const typedLps = numberProperty(unit, 'airflowLps');
  if (!spec) {
    // No maker sheet in the catalogue yet: what the library entry and the element hold.
    const manufacturer = typeof unit.properties.manufacturer === 'string' ? unit.properties.manufacturer : null;
    const index = numberProperty(unit, 'capacityIndex');
    return (
      <PanelCard testId="unit-spec" label="Specification">
        <CardSection noDivider>
          <Caption>Unit</Caption>
          <SpecRows rows={[
            manufacturer ? { label: 'Maker', value: manufacturer } : null,
            index ? { label: 'Capacity index', value: index } : null,
            air.airflowM3h ? { label: 'Airflow', value: `${Math.round(air.airflowM3h.hi)} m³/h at Hi` } : null,
            { label: 'Size', value: <>{Math.round(unit.height)} × {Math.round(unit.width)} × {Math.round(unit.depth)} mm <span className="text-[10px] text-slate-400">as placed</span></> },
            unit.properties.source === 'ifc-glb' ? { label: '3D model', value: <Chip>Maker&apos;s 3D model</Chip> } : null,
          ]} />
          <p className="mt-2 text-[10.5px] text-slate-400">No maker sheet in the catalogue for this model yet.</p>
        </CardSection>
      </PanelCard>
    );
  }
  const esp = spec.esp;
  const pumpDrawnAsGravity = spec.drain.pump && unit.properties.hasDrainPump !== true;
  const [source] = spec.sources;
  return (
    <PanelCard testId="unit-spec" label="Specification">
      <CardSection noDivider>
        <p className="text-[11px] font-medium text-slate-700">{spec.manufacturer}</p>
        <p className="text-[10.5px] text-slate-500">{spec.range}</p>
      </CardSection>
      {spec.airflowM3min ? (
        <CardSection>
          <Caption aside={typedLps ? (
            <InfoTip tip={`Its Airflow field (${typedLps} L/s = ${Math.round(typedLps * 3.6)} m³/h) overrides the fan speed's airflow in duct sizing.`}>
              <Chip tone="amber">field {typedLps} L/s</Chip>
            </InfoTip>
          ) : <span className="text-slate-400">{ducted ? `cooling · ducts at ${FAN_SPEED_LABELS[designSpeed]}` : 'cooling'}</span>}>Fan speeds</Caption>
          <FanSpeedTable airflowM3min={spec.airflowM3min} sound={spec.soundDbA} designSpeed={designSpeed} />
        </CardSection>
      ) : null}
      {esp ? (
        <CardSection testId="unit-spec-esp">
          <Caption aside={<span className="font-semibold tabular-nums text-slate-800">up to {esp.maxPa} Pa</span>}>Fan pressure (ESP)</Caption>
          <EspRange esp={esp} />
          <SpecRows rows={[
            { label: 'Maximum', value: `${esp.maxPa} Pa${esp.atAirflowM3min ? ` at ${m3h(esp.atAirflowM3min)} m³/h` : ''}` },
            esp.ratedPa ? { label: 'Rated at', value: `${esp.ratedPa} Pa` } : null,
            esp.factoryRangePa ? { label: 'As delivered', value: <><i className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-sky-500 align-[-1px]" />{esp.factoryRangePa[0]}–{esp.factoryRangePa[1]} Pa</> } : null,
            esp.settingsPa?.length ? {
              label: 'Settable', title: esp.extendedBy ? `Wider than as delivered: ${esp.extendedBy}` : undefined,
              value: <><i className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-sky-200 align-[-1px]" />{esp.settingsPa[0]}–{esp.settingsPa[esp.settingsPa.length - 1]} Pa{esp.extendedBy ? <span className="text-slate-400"> · {esp.extendedBy.split(',')[0]}</span> : null}</>,
            } : null,
          ]} />
        </CardSection>
      ) : null}
      <CardSection>
        <Caption>Connections</Caption>
        <SpecRows rows={[
          spec.collars ? { label: 'Supply collar', value: <span className="flex items-center gap-1.5"><StatusDot kind="supply" />{spec.collars.supply[0]} × {spec.collars.supply[1]} mm</span> } : null,
          spec.collars ? { label: 'Return collar', value: <span className="flex items-center gap-1.5"><StatusDot kind="return" />{spec.collars.return[0]} × {spec.collars.return[1]} mm</span> } : null,
          { label: 'Refrigerant', value: `${spec.refrigerant} · ${spec.joint === 'brazing' ? 'brazed' : 'flare'}` },
          { label: 'Pipes', value: `Ø${spec.liquidMm} liquid · Ø${spec.gasMm} gas` },
          {
            label: 'Drain',
            value: (
              <span className="flex flex-wrap items-center gap-1">
                {spec.drain.connection} · {spec.drain.pump ? 'pump built in' : 'no pump'}
                {pumpDrawnAsGravity ? <Chip tone="amber" title="This drawing treats it as gravity (its Drain pump setting)">drawn as gravity</Chip> : null}
              </span>
            ),
          },
        ]} />
      </CardSection>
      <CardSection>
        <Caption>Body and power</Caption>
        <SpecRows rows={[
          { label: 'Casing', value: <>{spec.casingMm.height} × {spec.casingMm.width} × {spec.casingMm.depth} mm <span className="text-[10px] text-slate-400">H × W × D</span></> },
          spec.weightKg ? { label: 'Weight', value: `${spec.weightKg} kg` } : null,
          { label: 'Power', value: `${spec.power.supply}${spec.power.inputKw ? ` · ${spec.power.inputKw} kW` : ''}` },
          spec.soundDbA && !spec.airflowM3min ? { label: 'Sound', value: FAN_SPEEDS.filter((speed) => spec.soundDbA![speed] !== undefined).map((speed) => `${FAN_SPEED_LABELS[speed]} ${spec.soundDbA![speed]}`).join(' · ') + ' dB(A)' } : null,
          spec.fan ? { label: 'Fan', value: spec.fan.replace(', ', ' · ') } : null,
          { label: '3D model', value: <Chip>{spec.body === 'catalog-3d' ? "Maker's 3D model (IFC)" : "Drawn to the maker's drawing"}</Chip> },
        ]} />
      </CardSection>
      {source ? (
        <CardSection className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-slate-400">{spec.sources.length > 1 ? `Sources (${spec.sources.length})` : 'Source'}</span>
          <span className="flex min-w-0 flex-col items-end gap-0.5">
            {spec.sources.map((entry) => (
              <InfoTip key={entry.id} tip={<><span className="font-medium text-slate-800">{entry.document}</span><br />{entry.reference}</>}>
                {entry.url ? (
                  <a href={entry.url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 truncate text-[10.5px] text-sky-700 hover:underline">
                    <span className="truncate">{entry.document.split(' — ')[0]}</span><ExternalLink size={10} className="shrink-0" aria-hidden="true" />
                  </a>
                ) : <span className="truncate text-[10.5px] text-slate-600">{entry.document.split(' — ')[0]}</span>}
              </InfoTip>
            ))}
          </span>
        </CardSection>
      ) : null}
    </PanelCard>
  );
}

// ---- Duct sizing: the first sizing ----

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

function MiniFigure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-100 bg-slate-50 px-2 py-1">
      <span className="block text-[9px] font-semibold uppercase tracking-[0.06em] text-slate-400">{label}</span>
      <span className="block truncate text-[11px] font-semibold tabular-nums text-slate-900">{children}</span>
    </div>
  );
}

function FirstSizing({ record, current, report, onReset }: {
  record: DuctSizingRecord | undefined; current: DuctSystemSizing | null; report: DuctSystemSizingReport | null; onReset: () => string | null;
}) {
  const [open, setOpen] = useUnitPanelSection('first-sizing');
  const [refusal, setRefusal] = useState<string | null>(null);
  if (!record) {
    return (
      <Disclosure title="First sizing" summary="no record" open={open} onToggle={setOpen} testId="unit-sizing-initial">
        <p className="text-[10.5px] text-slate-500">These ducts were applied before records were kept, or drawn by hand.</p>
      </Disclosure>
    );
  }
  const date = record.designedAt ? new Date(record.designedAt) : null;
  const diffs = recordDiffs(record, current, report);
  const origin = record.origin === 'auto-route' ? 'Auto route' : 'Auto duct';
  return (
    <Disclosure title="First sizing" open={open} onToggle={setOpen} testId="unit-sizing-initial"
      summary={<>
        <span className="truncate">{origin}{date ? ` · ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''}</span>
        {diffs.length ? <Chip tone="amber">{plural(diffs.length, 'change')}</Chip> : <Chip tone="green">Unchanged</Chip>}
      </>}>
      <p className="text-[10.5px] text-slate-500">
        {origin}{date ? `, ${date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : ''}{record.label ? ` · ${record.label}` : ''}
      </p>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <MiniFigure label="Method">{record.method === 'constant-friction' ? 'Constant friction' : 'Life-cycle optimum'}</MiniFigure>
        <MiniFigure label="Airflow">{FAN_SPEED_LABELS[record.fanSpeed]} · {record.airflowM3h ? `${Math.round(record.airflowM3h)} m³/h` : '–'}</MiniFigure>
        <MiniFigure label="Basis">
          {record.basis ? (record.basis.drive === 'friction' ? `${record.basis.frictionPaPerM.toFixed(2)} Pa/m set` : `${record.basis.mainVelocityMs.toFixed(1)} m/s set`) : 'optimum'}
        </MiniFigure>
        <MiniFigure label="Main">{fmt(record.mainVelocityMs, 1)} m/s · {fmt(record.mainFrictionPaPerM, 2)} Pa/m</MiniFigure>
      </div>
      <p className="mt-1.5 text-[10px] tabular-nums text-slate-400">
        Limits {record.maxVelocity.trunk.toFixed(1)} · {record.maxVelocity.branch.toFixed(1)} · {record.maxVelocity.runout.toFixed(1)} m/s
        {record.airflowSource ? ` · airflow from ${SOURCE_LABEL[record.airflowSource]}` : ''}
      </p>
      {diffs.length ? (
        <div className="mt-2" data-testid="unit-sizing-changes">
          <span className="text-[9.5px] font-semibold uppercase tracking-[0.07em] text-slate-400">Changed since</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {diffs.slice(0, 8).map((diff) => <Chip key={diff} tone="amber">{diff}</Chip>)}
            {diffs.length > 8 ? <Chip>+{diffs.length - 8} more</Chip> : null}
          </div>
        </div>
      ) : <p className="mt-2 flex items-center gap-1 text-[10.5px] text-emerald-700"><Check size={11} strokeWidth={2.5} aria-hidden="true" />Unchanged since.</p>}
      {record.basis && diffs.length ? (
        <PanelButton testId="unit-sizing-reset" className="mt-2" title="Size it again at its first basis, each terminal's airflow as designed (one undo)" onClick={() => setRefusal(onReset())}>
          <RotateCcw size={11} aria-hidden="true" />Reset to the first sizing
        </PanelButton>
      ) : null}
      {refusal ? <p className="mt-1 text-[10.5px] text-amber-800">{refusal}</p> : null}
    </Disclosure>
  );
}

// ---- Duct sizing: the calculation ----

function TraceRow({ symbol, value, note }: { symbol: string; value: ReactNode; note: ReactNode }) {
  return (
    <>
      <span className="font-mono text-[10.5px] font-semibold text-sky-700">{symbol}</span>
      <span className="whitespace-nowrap font-semibold tabular-nums text-slate-900">{value}</span>
      <span className="min-w-0 text-[10.5px] text-slate-500">{note}</span>
    </>
  );
}

function CalculationTrace({ report, sized, sizedMatchesDrawing, basis, esp }: {
  report: DuctSystemSizingReport; sized: DuctSystemSizingReport; sizedMatchesDrawing: boolean; basis: DuctSystemSizing; esp: UnitEspCheck | null;
}) {
  const [open, setOpen] = useUnitPanelSection('calculation');
  const q = report.main?.airflowM3h ?? report.terminalsAirflowM3h;
  const diameter = q > 0 && basis.mainVelocityMs > 0 ? diameterAtVelocityMm(q, basis.mainVelocityMs) : null;
  const main = (sizedMatchesDrawing ? sized.main : report.main) ?? null;
  const throttled = report.terminals.filter((terminal) => (terminal.throttlePa ?? 0) > 0).sort((a, b) => (b.throttlePa ?? 0) - (a.throttlePa ?? 0));
  const terminalsDiffer = Math.round(report.terminalsAirflowM3h) !== Math.round(report.airflowM3h ?? 0);
  return (
    <Disclosure title="Calculation" summary="Q → V → Ø → R" open={open} onToggle={setOpen} testId="unit-sizing-steps">
      <div className="grid grid-cols-[30px_78px_minmax(0,1fr)] items-baseline gap-x-1.5 gap-y-1 text-[11px]">
        <TraceRow symbol="Q" value={`${report.airflowM3h ? Math.round(report.airflowM3h) : '–'} m³/h`}
          note={`${FAN_SPEED_LABELS[basis.fanSpeed]}${report.airflowSource ? `, ${SOURCE_LABEL[report.airflowSource]}` : ''}`} />
        {terminalsDiffer ? <TraceRow symbol="ΣQ" value={`${Math.round(report.terminalsAirflowM3h)} m³/h`} note="the terminals take this: the main is linked at it" /> : null}
        <TraceRow symbol="V" value={`${basis.mainVelocityMs.toFixed(2)} m/s`} note={basis.drive === 'velocity' ? 'main velocity, set' : 'main velocity, from R'} />
        <TraceRow symbol="Ø" value={`${diameter ? Math.round(diameter) : '–'} mm`} note="√(4Q / πV), round equivalent" />
        <TraceRow symbol="R" value={`${basis.frictionPaPerM.toFixed(2)} Pa/m`} note={basis.drive === 'friction' ? 'set: every section at R' : 'from V: every section at R'} />
        {main ? (
          <TraceRow symbol="main" value={legLabel(main.section)}
            note={main.velocityCapped
              ? `${main.part} limit ${basis.maxVelocity[main.part].toFixed(1)} m/s holds it at ${main.velocityMs.toFixed(1)} m/s`
              : `${main.velocityMs.toFixed(1)} m/s · ${main.frictionPaPerM.toFixed(2)} Pa/m, ${DUCT_SECTION_SET_BY_LABELS[main.setBy]}`} />
        ) : null}
        {esp ? <TraceRow symbol="ESP" value={`${Math.round(esp.requiredPa)} Pa`} note={`supply ${fmt(esp.supplyPa)} + return ${fmt(esp.returnPa)}${esp.maxEspPa ? `, of ${esp.maxEspPa} Pa` : ''}`} /> : null}
        <TraceRow symbol="Δp" value="dampers"
          note={throttled.length ? throttled.slice(0, 3).map((terminal) => `${terminal.label} −${terminal.throttlePa} Pa`).join(' · ') + (throttled.length > 3 ? ` · +${throttled.length - 3}` : '') : 'every path is about the index path'} />
      </div>
      <p className="mt-2 text-[9.5px] leading-[13px] text-slate-400">
        Equal friction (ASHRAE Fundamentals ch. 21) · Darcy–Weisbach, Altshul–Tsal factor · galvanised ε 0.09 mm · air 1.2 kg/m³ · a rectangle at R runs slower than V
      </p>
    </Disclosure>
  );
}

// ---- Duct sizing: applied ducts ----

/** What sized the main, for its chip. */
function mainSetBy(main: DuctMainCheck): { label: string; tone: ChipTone; tip: string } {
  const label = DUCT_SECTION_SET_BY_LABELS[main.setBy];
  switch (main.setBy) {
    case 'friction': return { label: 'Friction rate', tone: 'sky', tip: 'Sized by the friction rate.' };
    case 'velocity': return { label: `${main.part[0]!.toUpperCase()}${main.part.slice(1)} limit`, tone: 'amber', tip: `The ${main.part} velocity limit sizes it.` };
    case 'minimum': return { label: 'Smallest size', tone: 'slate', tip: 'Already its smallest section: never narrower than tall, heights step from the collar.' };
    case 'capped': return { label: 'Void limit', tone: 'red', tip: 'The largest section the ceiling void allows.' };
    case 'drawn': return { label: 'As drawn', tone: 'slate', tip: 'As drawn: the drawing differs from constant friction at this basis.' };
    default: return { label: `${label[0]!.toUpperCase()}${label.slice(1)}`, tone: 'slate', tip: `Set by the ${label}.` };
  }
}

/** Why a main keeps its size when its velocity limit is raised: what sizes it at the raised limit. */
const RAISE_KEPT_BY: Partial<Record<DuctSectionSetBy, string>> = {
  friction: 'the friction rate gives the same section',
  velocity: 'the raised limit gives the same section',
  split: 'the split it feeds needs that width',
  'take-off': 'a take-off cut in it needs that size',
  downstream: 'the section after it is as large',
  minimum: 'it is already its smallest section',
  aspect: 'the aspect limit sets it',
  capped: 'the ceiling void caps it',
  neck: "the terminal's neck sets it",
  carried: 'a step under the reducer step carries it on',
  locked: 'it is locked',
};

function AppliedSizing({ unit, service, root, rootSpec, report, settings, scene, esp, airflowM3h }: {
  unit: HvacElement; service: DuctService; root: HvacElement; rootSpec: DuctRunSpec; report: DuctSystemSizingReport | null;
  settings: DuctDesignSettings; scene: readonly HvacElement[]; esp: UnitEspCheck | null; airflowM3h: Readonly<Record<FanSpeed, number>> | null;
}) {
  const setDuctSettings = useSmartDrawingStore((state) => state.setDuctSettings);
  const [limitsOpen, setLimitsOpen] = useUnitPanelSection('limits');
  const [sectionsOpen, setSectionsOpen] = useUnitPanelSection('sections');
  const continued = useMemo(() => continueBasis(scene, unit.id, service, settings), [scene, unit.id, service, settings]);
  const dry = useMemo(() => dryRunSizing(scene, root.id, continued.basis, settings), [scene, root.id, continued.basis, settings]);
  const growing = useMemo(() => necksToGrow(scene, root.id, continued.basis, undefined, settings), [scene, root.id, continued.basis, settings]);
  const basis = report?.basis ?? continued.basis;
  const sizedByBasis = continued.from === 'stored';
  const matches = sizedByBasis && dry.driftRunIds.length === 0;
  const neckCap = service === 'return' ? settings.autoMaxNeckVelocityReturnMs : settings.autoMaxNeckVelocitySupplyMs;
  const resize = (next: DuctSystemSizing, what: string, airflows?: Record<string, number | null>) => {
    resizeDuctSystemOnDrawing(unit.id, service, next, airflows, `Duct sizing (${service}): ${what}`);
  };
  // By tag (SAD-1, SAD-2 … SAD-10), not in the order the duct tree reaches them.
  const rows: TerminalAirflowRow[] = (report?.terminals ?? []).map((terminal) => ({
    id: terminal.terminalId, label: terminal.label, airflowM3h: terminal.airflowM3h, fixed: terminal.fixed,
    neckMm: terminal.neckMm, neckVelocityMs: terminal.neckVelocityMs,
    nextNeckMm: settings.autoNecksFollowAirflow ? growing.find((growth) => growth.terminalId === terminal.terminalId)?.toMm ?? null : null,
  })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const capped = report?.main?.velocityCapped ? report.main : null;
  // Raising the limit is offered only when it would change the ducts (another fitting may size the main as well).
  const raisedLimit = capped ? Math.ceil(basis.mainVelocityMs * 10) / 10 : null;
  const raising = useMemo(() => {
    if (!capped || raisedLimit === null) return null;
    const raised = { ...continued.basis, maxVelocity: { ...continued.basis.maxVelocity, [capped.part]: raisedLimit } };
    const dryRaised = dryRunSizing(scene, root.id, raised, settings);
    return { changes: dryRaised.driftRunIds.length > 0, mainSetBy: dryRaised.report.main?.setBy ?? null };
  }, [capped, raisedLimit, continued.basis, scene, root.id, settings]);
  // What the basis makes of the main (the drawing is that when it matches; else the main as drawn).
  const mainNow = matches ? dry.report.main : report?.main ?? null;
  const mainBasis = matches ? dry.report.basis : basis;
  const issues = (report?.issues ?? []).filter((issue) => issue.severity !== 'info');
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const drift = sizedByBasis ? dry.driftRunIds.length : 0;
  const method = sizedByBasis ? { label: 'Constant friction', tone: 'sky' as const }
    : rootSpec.initialSizing?.method === 'life-cycle' ? { label: 'Life-cycle optimum', tone: 'violet' as const }
      : rootSpec.initialSizing ? { label: 'Constant friction', tone: 'sky' as const } : { label: 'No sizing basis', tone: 'slate' as const };
  const health = errors ? <Chip tone="red">{plural(errors, 'error')}</Chip>
    : issues.length || drift ? <Chip tone="amber">{issues.length ? plural(issues.length, 'warning') : `${drift} drifted`}</Chip>
      : <Chip tone="green"><Check size={10} strokeWidth={2.75} aria-hidden="true" />No issues</Chip>;
  // Already at its smallest and under the basis: a change above where it starts to grow does nothing. The figure that
  // enlarges it (rounded down, so it does), offered in the unit that drives.
  const smallest = matches && mainNow && mainNow.setBy === 'minimum' && mainNow.frictionPaPerM < mainBasis.frictionPaPerM - 0.005
    ? { friction: Math.floor(mainNow.frictionPaPerM * 100) / 100, velocity: Math.floor(velocityAtFriction(mainNow.airflowM3h, mainNow.frictionPaPerM) * 10) / 10 } : null;
  const useSmallest = () => {
    if (!smallest) return;
    if (continued.basis.drive === 'velocity' && smallest.velocity >= 1) {
      resize({ ...continued.basis, drive: 'velocity', mainVelocityMs: smallest.velocity }, `main velocity ${fmt(continued.basis.mainVelocityMs, 1)} → ${fmt(smallest.velocity, 1)} m/s`);
    } else if (smallest.friction >= 0.1) {
      resize({ ...continued.basis, drive: 'friction', frictionPaPerM: smallest.friction }, `friction ${fmt(continued.basis.frictionPaPerM, 2)} → ${fmt(smallest.friction, 2)} Pa/m`);
    }
  };
  const setBy = mainNow ? (matches ? mainSetBy(mainNow) : mainSetBy({ ...mainNow, setBy: 'drawn' })) : null;
  const shown = matches ? dry.report : report;
  const maxVelocity = shown ? Math.max(0, ...shown.sections.map((section) => section.velocityMs)) : 0;
  return (
    <div data-testid="unit-sizing-applied">
      <div className="flex min-w-0 items-center gap-1.5 px-3 pb-2.5 pt-0.5" data-testid="unit-sizing-status">
        <Chip tone={method.tone}>{method.label}</Chip>
        <span className="min-w-0 truncate text-[10.5px] text-slate-400">{CONTINUE_LABEL[continued.from]}</span>
        <span className="ml-auto">{health}</span>
      </div>

      {!sizedByBasis || drift || issues.length || esp?.withinFan === false ? (
        <div className="space-y-1.5 px-3 pb-2.5">
          {!sizedByBasis ? (
            <InlineAlert tone="info">
              The first change sizes every section by constant friction, {CONTINUE_LABEL[continued.from]} ({continued.basis.frictionPaPerM.toFixed(2)} Pa/m).
            </InlineAlert>
          ) : null}
          {drift ? (
            <InlineAlert tone="warn" testId="unit-sizing-drift"
              actions={<PanelButton tone="primary" testId="unit-sizing-resize" title="Size every section again at this basis (one undo)" onClick={() => resizeDuctSystemAtBasis(unit.id, service)}>
                Re-size at this basis<ArrowRight size={11} aria-hidden="true" />
              </PanelButton>}>
              {plural(drift, 'run')} no longer match {continued.basis.frictionPaPerM.toFixed(2)} Pa/m (a hand edit, a new branch or a changed airflow).
            </InlineAlert>
          ) : null}
          {esp?.withinFan === false ? (
            <InlineAlert tone="error">{Math.round(esp.requiredPa)} Pa is over the fan&apos;s {esp.maxEspPa} Pa: lower a friction rate, shorten the index run, or choose a unit with more ESP.</InlineAlert>
          ) : null}
          {issues.length ? (
            <InlineAlert tone={errors ? 'error' : 'warn'} testId="unit-sizing-issues">
              <ul className="space-y-0.5">
                {issues.slice(0, 3).map((issue, index) => <li key={index}>{issue.message}</li>)}
                {issues.length > 3 ? <li className="text-[10.5px] opacity-75">and {issues.length - 3} more (the run inspector lists them)</li> : null}
              </ul>
            </InlineAlert>
          ) : null}
        </div>
      ) : null}

      <div data-testid="unit-sizing-continue">
        <CardSection>
          <Caption>Basis</Caption>
          <div className="mt-1.5 space-y-1">
            <FanSpeedPicker label="Unit panel fan speed" value={basis.fanSpeed} airflowM3h={airflowM3h}
              onChange={(speed) => resize({ ...continued.basis, fanSpeed: speed, airflowM3h: null }, `fan speed ${FAN_SPEED_LABELS[basis.fanSpeed]} → ${FAN_SPEED_LABELS[speed]}`)} />
            <SystemAirflowRow source={basis.airflowM3h ? (
              <button type="button" aria-label="Use the fan speed's airflow" title="Clear: the fan speed's airflow"
                onClick={() => resize({ ...continued.basis, airflowM3h: null }, `airflow ${Math.round(basis.airflowM3h!)} → fan speed m³/h`)}
                className="inline-flex items-center gap-0.5 rounded px-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">typed<X size={10} aria-hidden="true" /></button>
            ) : report?.airflowSource === 'unit' ? 'Airflow field' : report?.airflowSource === 'manufacturer' ? 'fan speed' : null}>
              <DuctNumberInput key={`${unit.id}:${service}:airflow`} variant="cell" label="Unit panel system airflow" value={basis.airflowM3h} step={10} min={0.01} max={50000}
                allowEmpty placeholder={report?.airflowM3h ? String(Math.round(report.airflowM3h)) : 'm³/h'} className="w-[52px]" suffix="m³/h"
                onChange={(value) => resize({ ...continued.basis, airflowM3h: value }, `airflow ${report?.airflowM3h ? Math.round(report.airflowM3h) : '–'} → ${value === null ? 'fan speed' : Math.round(value)} m³/h`)} />
            </SystemAirflowRow>
            <BasisEditor key={`${unit.id}:${service}:basis`} basis={basis} live={false} onChange={(next, what) => resize(next, what)}
              limitsOpen={limitsOpen} onLimitsOpenChange={setLimitsOpen} />
            <div className="flex min-h-7 items-center justify-between gap-2">
              <span className="flex items-center gap-1 text-[11px] text-slate-500">
                Necks follow airflow
                <InfoIcon label="About necks following airflow" tip="A terminal whose airflow needs more than its neck's velocity cap takes the next catalogue neck, its flexible runout with it. Necks never shrink on their own." />
              </span>
              <Switch checked={settings.autoNecksFollowAirflow} onChange={(checked) => setDuctSettings({ autoNecksFollowAirflow: checked })} label="Necks follow airflow" />
            </div>
          </div>
        </CardSection>

        {mainNow && setBy ? (
          <CardSection testId="unit-sizing-main">
            <Caption aside={<InfoTip tip={setBy.tip}><Chip tone={setBy.tone}>{setBy.label}</Chip></InfoTip>}>Main duct</Caption>
            <div className="mt-1 flex items-baseline gap-2.5">
              <span className="text-[18px] font-bold tabular-nums tracking-tight text-slate-900">{legLabel(mainNow.section)}</span>
              <span className="flex items-center gap-1 text-[11.5px] tabular-nums text-slate-700" title={`${mainNow.part} limit ${fmt(mainBasis.maxVelocity[mainNow.part], 1)} m/s`}>
                <StatusDot kind={figureStatus(mainNow.velocityMs, mainBasis.maxVelocity[mainNow.part])} />{mainNow.velocityMs.toFixed(1)} m/s
              </span>
              <span className="text-[11.5px] tabular-nums text-slate-500">{mainNow.frictionPaPerM.toFixed(2)} Pa/m</span>
            </div>
            {smallest ? (
              <div className="mt-1.5 flex items-center justify-between gap-2 text-[10.5px] text-slate-500">
                <span className="min-w-0">Already at its smallest size; grows at ≤ {smallest.velocity.toFixed(1)} m/s (≤ {smallest.friction.toFixed(2)} Pa/m).</span>
                <PanelButton testId="unit-sizing-use" title="Apply the figure at which the main grows (one undo)" onClick={useSmallest}>
                  Use {continued.basis.drive === 'velocity' && smallest.velocity >= 1 ? `${smallest.velocity.toFixed(1)} m/s` : `${smallest.friction.toFixed(2)} Pa/m`}
                </PanelButton>
              </div>
            ) : null}
            {capped ? (
              <div className="mt-2">
                <InlineAlert tone="warn" testId="unit-sizing-governs"
                  actions={raising?.changes && raisedLimit !== null ? (
                    <PanelButton tone="warn" testId="unit-sizing-raise-limit" title="Raise the limit so the friction rate sizes the main (one undo)"
                      onClick={() => resize({ ...continued.basis, maxVelocity: { ...continued.basis.maxVelocity, [capped.part]: raisedLimit } },
                        `${capped.part} limit ${basis.maxVelocity[capped.part].toFixed(1)} → ${raisedLimit.toFixed(1)} m/s`)}>
                      Raise the limit to {raisedLimit.toFixed(1)} m/s
                    </PanelButton>
                  ) : undefined}>
                  {capped.part[0]!.toUpperCase()}{capped.part.slice(1)} limit {basis.maxVelocity[capped.part].toFixed(1)} m/s holds the main below the basis ({basis.mainVelocityMs.toFixed(1)} m/s).
                  {!raising?.changes ? (
                    <span className="mt-0.5 block text-[10.5px] opacity-80">
                      Raising it changes nothing here: {(raising?.mainSetBy && RAISE_KEPT_BY[raising.mainSetBy]) ?? 'another rule sizes the main as well'}.
                    </span>
                  ) : null}
                </InlineAlert>
              </div>
            ) : null}
          </CardSection>
        ) : null}
      </div>

      {report ? (
        <CardSection testId="unit-sizing-terminals">
          <TerminalAirflowList rows={rows} neckCapMs={Math.min(neckCap, basis.maxVelocity.runout)} live={false} systemAirflowM3h={report.airflowM3h}
            onChange={(id, value, what) => resize(continued.basis, what, { [id]: value })}
            footer={rows.some((row) => row.fixed) ? (
              <PanelButton tone="ghost" testId="unit-sizing-share" title="Clear every terminal's own airflow: each takes an equal share (one undo)"
                onClick={() => resize(continued.basis, 'every terminal → an equal share', Object.fromEntries(rows.map((row) => [row.id, null])))}>
                <Wind size={11} aria-hidden="true" />Share equally
              </PanelButton>
            ) : undefined} />
        </CardSection>
      ) : null}

      {shown ? (
        <Disclosure title="Sections" summary={`${shown.sections.length} · max ${maxVelocity.toFixed(1)} m/s`} open={sectionsOpen} onToggle={setSectionsOpen} testId="unit-sizing-sections">
          {!matches ? <p className="mb-1.5 text-[10.5px] leading-4 text-amber-800">As drawn: the drawing differs from constant friction at this basis; the next change sizes it.</p> : null}
          <SizingTable report={shown} />
        </Disclosure>
      ) : null}
      {report ? <CalculationTrace report={report} sized={dry.report} sizedMatchesDrawing={matches} basis={basis} esp={esp} /> : null}
      <FirstSizing record={rootSpec.initialSizing} current={sizedByBasis ? continued.basis : null} report={report}
        onReset={() => resetDuctSystemToInitial(unit.id, service).refused ?? null} />
    </div>
  );
}

// ---- Duct sizing: before ducts exist (what Generate sizes at) ----

function DraftSizing({ unit, service, terminals, settings }: { unit: HvacElement; service: DuctService; terminals: readonly HvacElement[]; settings: DuctDesignSettings }) {
  const draft = useDuctSizingDraft(unit.id);
  const update = useDuctSizingDraftStore((state) => state.update);
  const [limitsOpen, setLimitsOpen] = useUnitPanelSection('limits');
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
    return { id: terminal.id, spec: { designAirflowM3h: set ?? null, neckDiameterMm: spec.neckDiameterMm } };
  }));
  const rows: TerminalAirflowRow[] = serviceTerminals.map((terminal, index) => {
    const spec = readDuctTerminalSpec(terminal)!;
    const share = shares[index]!;
    return { id: terminal.id, label: terminal.label || spec.kind, airflowM3h: share.airflowM3h, fixed: share.fixed, neckMm: spec.neckDiameterMm, neckVelocityMs: neckVelocityMs(spec, share.airflowM3h) };
  }).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const neckCap = service === 'return' ? settings.autoMaxNeckVelocityReturnMs : settings.autoMaxNeckVelocitySupplyMs;
  const resizePreview = (next: DuctSizingDraft) => {
    if (!current || method !== 'constant-friction') return;
    // The services the preview holds (what the card generated), so its request and the card's inputs stay equal.
    const held = preview.result?.services.filter((entry) => entry.runs.length).map((entry) => entry.service) ?? [];
    resizeAutoDuctPreview(draftBases(held.length ? held : services, next, settings, draftAirflow(unit, next)),
      Object.keys(next.terminalAirflows).length ? next.terminalAirflows : undefined);
  };
  return (
    <div data-testid="unit-sizing-draft">
      <div className="px-3 pb-2.5 pt-0.5">
        <InlineAlert tone="info"
          actions={<PanelButton tone="primary" onClick={openPropertiesPanel} testId="unit-sizing-open-auto-duct" title="The Auto duct card (Properties) generates and applies the ducts">
            {current ? 'Apply in Auto duct' : 'Generate in Auto duct'}<ArrowRight size={11} aria-hidden="true" />
          </PanelButton>}>
          {current ? <><span className="font-semibold">Preview open.</span> Changes here resize it live.</>
            : <><span className="font-semibold">No {service} ducts yet.</span> Generate sizes them at this basis.</>}
        </InlineAlert>
      </div>
      <CardSection>
        <SizingMethodSwitch method={method} onChange={(next) => { if (next !== method) setDuctSettings({ autoSizingMethod: next }); }} />
      </CardSection>
      <CardSection>
        <Caption>Basis</Caption>
        <div className="mt-1.5 space-y-1">
          <FanSpeedPicker label="Unit panel draft fan speed" value={draft.fanSpeed} airflowM3h={air.airflowM3h} onChange={(speed) => update(unit.id, { fanSpeed: speed })} />
          <SystemAirflowRow source={airflow.override !== null ? (
            <button type="button" aria-label="Use the fan speed's airflow" title="Clear: the fan speed's airflow" onClick={() => update(unit.id, { airflowDraft: '' })}
              className="inline-flex items-center gap-0.5 rounded px-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">typed<X size={10} aria-hidden="true" /></button>
          ) : airflow.defaultAirflowM3h ? (numberProperty(unit, 'airflowLps') ? 'Airflow field' : 'fan speed') : null}>
            <DuctNumberInput key={`${unit.id}:draft-airflow`} variant="cell" label="Unit panel draft airflow" value={airflow.override} step={10} min={0.01} max={50000} allowEmpty live
              placeholder={airflow.defaultAirflowM3h ? String(Math.round(airflow.defaultAirflowM3h)) : 'm³/h'} className="w-[52px]" suffix="m³/h"
              onChange={(value) => update(unit.id, { airflowDraft: value === null ? '' : String(value) })} />
          </SystemAirflowRow>
          {method === 'constant-friction' ? (
            <BasisEditor key={`${unit.id}:${service}:draft`} basis={basis} live limitsOpen={limitsOpen} onLimitsOpenChange={setLimitsOpen} onChange={(next) => {
              const nextDraft = { ...draft, bases: { ...draft.bases, [service]: next } };
              update(unit.id, { bases: nextDraft.bases });
              resizePreview(nextDraft);
            }} />
          ) : <p className="text-[10.5px] text-slate-500">Least first cost plus fan energy over the life; switch to constant friction to set a basis.</p>}
        </div>
      </CardSection>
      <CardSection testId="unit-sizing-terminals">
        <TerminalAirflowList rows={rows} neckCapMs={neckCap} systemAirflowM3h={airflow.systemAirflowM3h} live onChange={(id, value) => {
          const nextDraft = { ...draft, terminalAirflows: { ...draft.terminalAirflows, [id]: value } };
          update(unit.id, { terminalAirflows: nextDraft.terminalAirflows });
          resizePreview(nextDraft);
        }} />
      </CardSection>
    </div>
  );
}

// ---- Duct sizing: the card ----

function DuctSizingTab({ unit, settings, scene, rooms, airSide, airflowM3h }: {
  unit: HvacElement; settings: DuctDesignSettings; scene: readonly HvacElement[]; rooms: ReadonlyArray<Pick<Room, 'id' | 'vertices'>>;
  airSide: UnitAirSide; airflowM3h: Readonly<Record<FanSpeed, number>> | null;
}) {
  const { systems, measured, esp } = airSide;
  const selection = useMemo(() => autoDuctSelection([unit.id], scene, { rooms, includeConnected: true }), [scene, unit.id, rooms]);
  const terminals = selection?.terminals ?? [];
  const counts = { supply: 0, return: 0 };
  for (const terminal of terminals) {
    const kind = readDuctTerminalSpec(terminal)?.service;
    if (kind) counts[kind] += 1;
  }
  const choices: ServiceChoice[] = (['supply', 'return'] as const).map((service) => {
    const system = systems.find((entry) => entry.service === service);
    if (system) return { service, note: system.spec.sizing ? `${system.spec.sizing.frictionPaPerM.toFixed(2)} Pa/m` : system.spec.initialSizing?.method === 'life-cycle' ? 'optimum' : 'drawn' };
    if (counts[service]) return { service, note: plural(counts[service], 'terminal') };
    return {
      service, note: 'none',
      disabledReason: service === 'return' ? 'No return terminals: the collar draws from the ceiling void (plenum return)' : 'No supply terminals for this unit yet',
    };
  });
  const available = choices.filter((choice) => !choice.disabledReason).map((choice) => choice.service);
  const [tab, setTab] = useState<DuctService>('supply');
  const active: DuctService = available.includes(tab) ? tab : available[0] ?? 'supply';
  const system = systems.find((entry) => entry.service === active);
  return (
    <PanelCard testId="unit-sizing" label="Duct sizing">
      {available.length ? (
        <>
          <div className="px-2 pb-2 pt-2"><ServiceSwitch choices={choices} active={active} onChange={setTab} /></div>
          {system ? (
            <AppliedSizing key={`${unit.id}:${active}`} unit={unit} service={active} root={system.root} rootSpec={system.spec} report={measured[active] ?? null}
              settings={settings} scene={scene} esp={esp} airflowM3h={airflowM3h} />
          ) : <DraftSizing key={`${unit.id}:${active}:draft`} unit={unit} service={active} terminals={terminals} settings={settings} />}
        </>
      ) : (
        <div className="p-3" data-testid="unit-sizing-draft">
          <InlineAlert tone="info" actions={<PanelButton onClick={openPropertiesPanel} testId="unit-sizing-open-auto-duct">Open Properties<ArrowRight size={11} aria-hidden="true" /></PanelButton>}>
            <span className="font-semibold">No terminals for this unit yet.</span> Place supply and return terminals from its Air system card, then generate its ducts.
          </InlineAlert>
        </div>
      )}
    </PanelCard>
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
  const airSide = useUnitAirSide(unit, spec, ductSettings, scene);
  const draft = useDuctSizingDraft(unit?.id);
  const tab = useUnitPanelUiStore((state) => state.tab);
  const setTab = useUnitPanelUiStore((state) => state.setTab);
  const ducted = unit?.type === 'ducted-ac';
  const air = unit ? readUnitAirData(unit) : null;
  // The airflow the ducts are designed for: as measured on them, else the draft Generate would use.
  const measuredReport = airSide ? airSide.measured.supply ?? airSide.measured.return ?? null : null;
  const design: DesignAirflow = (() => {
    if (!unit) return { airflowM3h: null, source: null, fanSpeed: 'hi' };
    if (measuredReport) return { airflowM3h: measuredReport.airflowM3h, source: measuredReport.airflowSource, fanSpeed: measuredReport.basis.fanSpeed };
    if (ducted) {
      const airflow = draftAirflow(unit, draft);
      const source: DuctAirflowSource | null = airflow.override !== null ? 'entered' : numberProperty(unit, 'airflowLps') ? 'unit' : airflow.defaultAirflowM3h ? 'manufacturer' : null;
      return { airflowM3h: airflow.systemAirflowM3h, source, fanSpeed: draft.fanSpeed };
    }
    return { airflowM3h: air?.airflowM3h?.hi ?? null, source: air?.airflowM3h ? 'manufacturer' : null, fanSpeed: 'hi' };
  })();
  const activeTab: UnitPanelTab = ducted ? tab : 'spec';
  return (
    <div className="space-y-2.5 p-2.5" data-testid="unit-panel">
      {unit ? (
        <>
          <UnitHeader unit={unit} spec={spec} tag={(isAirSystemUnit(unit) ? tags.get(unit.id) : null) ?? (unit.label || 'Unit')}
            roomName={unit.roomId ? rooms.find((room) => room.id === unit.roomId)?.name ?? 'Unassigned room' : 'No room'}
            design={design} esp={airSide?.esp ?? null} onShowToolbox={onShowToolbox} />
          {ducted && airSide ? (
            <>
              <div className="sticky top-0 z-10 -mx-2.5 bg-[#fbf7ee] px-2.5 py-1.5 shadow-[0_6px_8px_-8px_rgba(120,53,15,0.35)]">
                <Segmented role="tablist" variant="tabs" label="Unit panel" value={activeTab} onChange={setTab} testId="unit-panel-tabs"
                  options={[
                    { value: 'sizing', label: 'Duct sizing', dot: airSideHealth(airSide), testId: 'unit-panel-tab-sizing' },
                    { value: 'spec', label: 'Specification', testId: 'unit-panel-tab-spec' },
                  ]} />
              </div>
              <div role="tabpanel" aria-label={activeTab === 'sizing' ? 'Duct sizing' : 'Specification'}>
                {activeTab === 'sizing'
                  ? <DuctSizingTab unit={unit} settings={ductSettings} scene={scene} rooms={rooms} airSide={airSide} airflowM3h={air?.airflowM3h ?? null} />
                  : <SpecificationTab unit={unit} spec={spec} designSpeed={design.fanSpeed} />}
              </div>
            </>
          ) : (
            <>
              <SpecificationTab unit={unit} spec={spec} designSpeed={design.fanSpeed} />
              <p className="px-1 text-[10.5px] text-slate-400">{unit.type === 'outdoor-unit' ? 'An outdoor unit: no ducts.' : 'Not a ducted unit: no duct sizing.'}</p>
            </>
          )}
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-amber-300 bg-white/70 p-4 text-center" data-testid="unit-panel-empty">
          <EquipmentIcon kind="ducted" size={28} className="mx-auto text-slate-400" />
          <p className="mt-2 text-xs font-medium text-slate-700">Select an AC unit</p>
          <p className="mt-1 text-[11px] text-slate-500">Its key figures, duct sizing and specification open here.</p>
        </div>
      )}
      <div className="flex items-center justify-between gap-2 px-1 text-[10.5px] text-slate-500">
        <span>Open this panel when a unit is selected</span>
        <Switch checked={autoOpen} onChange={onAutoOpenChange} label="Open the unit panel when a unit is selected" />
      </div>
    </div>
  );
}
