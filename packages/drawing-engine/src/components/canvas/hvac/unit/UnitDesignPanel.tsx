'use client';

/**
 * The unit panel (left side, Unit mode): opens when one AC unit is selected.
 *
 *  - Header: the unit's tag, model and room, SI | IP, and three key figures —
 *    its capacity, the airflow its ducts are designed for, and the external
 *    static pressure the fan gives: supply and return together against its
 *    maximum, with the setting to make on the remote.
 *  - Duct sizing (ducted units), one card per service, drawn rather than
 *    written: the design basis (the ASHRAE criteria chip; V₀ ⇄ R → standard
 *    sizes → velocities; R on a slider; the fan speed), the network as a
 *    tree (each stretch's size, airflow and velocity; hovering one outlines
 *    it on the plan), the terminals by spec, the friction chart and the first
 *    sizing. On ducts in the drawing each committed change resizes them as
 *    one undo step (dragging R previews first); before ducts the same
 *    controls set what Generate sizes at (the Auto duct card's draft), and an
 *    open preview shows its network.
 *  - Specification: the maker's sheet, compact, with its source.
 *
 * Figures are held SI and shown in the document's unit system. The panel is
 * about 312 px wide: one line per item, explanations in tooltips.
 */
import { ArrowRight, Check, ChevronLeft, ExternalLink, MapPin, RotateCcw, Wind } from 'lucide-react';
import { useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import { shallow } from 'zustand/shallow';

import { unitSpecificationFor, type AcUnitSpecification } from '../../../../data/unitSpecifications';
import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement, Room } from '../../../../types';
import { DesignCriteriaPicker } from '../duct/DuctDesignCriteriaPicker';
import { FanSpeedAirflow, FrictionSlider, MethodStrip, TerminalGroupList, VelocityLimits, type TerminalRow } from '../duct/DuctSizingBasis';
import { ServiceSwitch, SizingMethodSwitch, type ServiceChoice } from '../duct/DuctSizingSection';
import { resolveUnitAirPorts } from '../duct/ductAirPorts';
import { airSystemTags, isAirSystemUnit } from '../duct/ductAirSystems';
import {
  autoDuctSelection, resetDuctSystemToInitial, resizeAutoDuctPreview, resizeDuctSystemAtBasis, resizeDuctSystemOnDrawing, resizeUnitDuctsAtBasis,
} from '../duct/ductAutoController';
import { isAutoDuctPreviewCurrent, useDuctAutoPreviewStore } from '../duct/ductAutoPreviewStore';
import { ductNetworkRows } from '../duct/ductNetworkTree';
import type { DuctDesignSettings } from '../duct/ductSettings';
import { FAN_SPEED_LABELS, FAN_SPEEDS, neckVelocityMs, readUnitAirData, shareAirflow, type FanSpeed } from '../duct/ductSizing';
import { draftAirflow, draftBases, draftBasis, draftServices, useDuctSizingDraft, useDuctSizingDraftStore, type DuctSizingDraft } from '../duct/ductSizingDraft';
import {
  velocityAtFriction, type DuctAirflowSource, type DuctSectionSetBy, type DuctSystemSizingReport,
} from '../duct/ductSystemSizing';
import { readDuctTerminalSpec } from '../duct/ductTerminals';
import type { DuctRunSpec, DuctService, DuctSizingRecord, DuctSystemSizing } from '../duct/ductTypes';
import {
  continueBasis, dryRunSizing, measureUnitService, necksToGrow, unitDuctSystems, unitEspCheck,
  type ContinueBasisSource, type UnitEspCheck, type UnitEspSettings,
} from '../duct/unitAirSide';
import { designSettingsForUnit } from '../duct/unitCriteria';
import { EquipmentIcon, equipmentIconKind } from '../equipmentIcons';
import { UnitSystemSwitch } from '../units/UnitSystemSwitch';
import { inchFractionText, inchesText, tonsOf } from '../units/hvacUnits';
import { useHvacUnits, type HvacUnits } from '../units/useHvacUnits';

import { FrictionChart } from './FrictionChart';
import { NetworkTree } from './NetworkTree';
import {
  CardSection, Caption, Chip, Disclosure, InfoIcon, InfoTip, InlineAlert, KpiTile, PanelButton, PanelCard, Segmented, SpecRows, StatusDot, Switch,
  type DotKind, type MeterSegment,
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
const stretches = (count: number) => `${count} stretch${count === 1 ? '' : 'es'}`;

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

/** A body's sizes ("1084 × 697 × 300 mm", "42.7 × 27.4 × 11.8 in"). */
function dimensions(units: HvacUnits, sizesMm: readonly number[]): string {
  return units.system === 'ip' ? `${sizesMm.map(inchesText).join(' × ')} in` : `${sizesMm.map((size) => Math.round(size)).join(' × ')} mm`;
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
  const units = useHvacUnits();
  const pa = (value: number | null | undefined) => units.num('pressure', value);
  // The tile is narrow: "in" for in. wg (the tip says it in full).
  const short = units.system === 'ip' ? 'in' : 'Pa';
  if (!esp) {
    if (maxEspPa === null) return null;
    return <KpiTile label="Fan ESP" value={pa(maxEspPa)} unit={`${short} max`} sub="no ducts yet" testId="unit-fan" />;
  }
  const max = esp.maxEspPa;
  const over = esp.withinFan === false;
  const meter: MeterSegment[] | undefined = max ? [
    { fraction: (esp.supplyPa ?? 0) / max, className: over ? 'bg-red-500' : 'bg-blue-600' },
    { fraction: (esp.returnPa ?? 0) / max, className: over ? 'bg-red-400' : 'bg-teal-600' },
  ] : undefined;
  const sentence = `Supply ${units.fmt('pressure', esp.supplyPa)} + return ${units.fmt('pressure', esp.returnPa)} = ${units.fmt('pressure', esp.requiredPa)}${max ? ` of the fan's ${units.fmt('pressure', max)}` : ''}: one fan delivers both.`
    + (esp.setting ? ` Set the unit's ESP to ${units.fmt('pressure', esp.setting.pa)} on the wired remote${esp.setting.note ? ` — ${esp.setting.note}` : ''}.` : '')
    + (over ? ' Over the fan: lower a friction rate, shorten the index run, or choose a unit with more ESP.' : '');
  const sub = over ? <span className="font-medium text-red-700">over by {pa(esp.requiredPa - (max ?? 0))} {short}</span>
    : esp.setting ? <><StatusDot kind={esp.setting.inFactoryRange ? 'ok' : 'near'} />set {pa(esp.setting.pa)} {short}</>
      : <>
        <StatusDot kind="supply" /><span className="sr-only">supply</span> {pa(esp.supplyPa)}
        <StatusDot kind="return" className="ml-1" /><span className="sr-only">return</span> {pa(esp.returnPa)}
      </>;
  return (
    <InfoTip tip={sentence} block>
      <KpiTile label="Fan ESP" value={pa(esp.requiredPa)} unit={max ? `/ ${pa(max)} ${short}` : short} meter={meter} testId="unit-fan"
        sub={<span className="flex min-w-0 items-center gap-1" data-testid="unit-fan-setting">{sub}</span>} />
    </InfoTip>
  );
}

function UnitHeader({ unit, spec, tag, roomName, design, esp, onShowToolbox }: {
  unit: HvacElement; spec: AcUnitSpecification | null; tag: string; roomName: string; design: DesignAirflow; esp: UnitEspCheck | null; onShowToolbox: () => void;
}) {
  const units = useHvacUnits();
  const ip = units.system === 'ip';
  const cooling = spec?.coolingKw ?? numberProperty(unit, 'capacityKw');
  const heating = spec?.heatingKw ?? numberProperty(unit, 'heatingCapacityKw');
  const ducted = unit.type === 'ducted-ac';
  const speed = design.source === 'entered' ? 'typed' : design.source === 'unit' ? 'Airflow field' : FAN_SPEED_LABELS[design.fanSpeed];
  const airflowSub = design.airflowM3h === null ? 'no airflow data' : ip ? speed : `${speed} · ${lps(design.airflowM3h)} L/s`;
  const capacity = (kw: number) => (ip ? units.num('capacity', kw) : String(kw));
  const tiles: ReactNode[] = [];
  if (cooling) {
    const sub = ip ? `${tonsOf(cooling).toFixed(1)} TR${heating ? ` · ${capacity(heating)} heat` : ''}` : heating ? `${heating} kW heat` : undefined;
    tiles.push(<KpiTile key="cooling" label="Cooling" value={capacity(cooling)} unit={units.unit('capacity')} sub={sub} testId="unit-kpi-cooling"
      title={heating ? `${units.fmt('capacity', cooling)} cooling · ${units.fmt('capacity', heating)} heating` : undefined} />);
  } else if (heating) tiles.push(<KpiTile key="heating" label="Heating" value={capacity(heating)} unit={units.unit('capacity')} testId="unit-kpi-heating" />);
  if (design.airflowM3h !== null || ducted) {
    tiles.push(<KpiTile key="airflow" label="Airflow" value={design.airflowM3h === null ? '–' : units.num('airflow', design.airflowM3h)} unit={units.unit('airflow')} sub={airflowSub} testId="unit-kpi-airflow" />);
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
        <div className="-mr-1.5 -mt-1 flex shrink-0 flex-col items-end gap-1">
          <UnitSystemSwitch />
          <PanelButton tone="ghost" onClick={onShowToolbox} title="Back to the toolbox (the unit stays selected)" testId="unit-panel-toolbox" className="!px-1.5 text-[10.5px]">
            <ChevronLeft size={12} aria-hidden="true" />Toolbox
          </PanelButton>
        </div>
      </div>
      {tiles.length ? <div className="mt-2.5 grid grid-cols-3 gap-1.5">{tiles}</div> : null}
    </PanelCard>
  );
}

// ---- Specification ----

function FanSpeedTable({ airflowM3min, sound, designSpeed }: {
  airflowM3min: Readonly<Record<FanSpeed, number>>; sound: AcUnitSpecification['soundDbA']; designSpeed: FanSpeed;
}) {
  const units = useHvacUnits();
  const rows: Array<{ unit: string; value: (speed: FanSpeed) => string }> = units.system === 'ip'
    ? [{ unit: 'CFM', value: (speed) => units.num('airflow', m3h(airflowM3min[speed])) }]
    : [
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
  const units = useHvacUnits();
  const at = (pa: number) => `${Math.min(100, Math.max(0, (pa / esp.maxPa) * 100))}%`;
  const settings = esp.settingsPa?.length ? [esp.settingsPa[0]!, esp.settingsPa[esp.settingsPa.length - 1]!] as const : null;
  return (
    <div className="relative mt-2 h-[30px]" aria-hidden="true">
      <div className="absolute inset-x-0 top-2 h-1.5 rounded-full bg-slate-100" />
      {settings ? <div className="absolute top-2 h-1.5 rounded-full bg-sky-200" style={{ left: at(settings[0]), right: `calc(100% - ${at(settings[1])})` }} /> : null}
      {esp.factoryRangePa ? <div className="absolute top-2 h-1.5 rounded-sm bg-sky-500" style={{ left: at(esp.factoryRangePa[0]), right: `calc(100% - ${at(esp.factoryRangePa[1])})` }} /> : null}
      {esp.ratedPa ? <div className="absolute top-1 h-3.5 w-0.5 rounded-sm bg-slate-900" style={{ left: at(esp.ratedPa) }} /> : null}
      <span className="absolute left-0 top-[19px] text-[9.5px] tabular-nums text-slate-400">0</span>
      {esp.ratedPa ? <span className="absolute top-[19px] -translate-x-1/2 whitespace-nowrap text-[9.5px] tabular-nums text-slate-500" style={{ left: at(esp.ratedPa) }}>rated {units.num('pressure', esp.ratedPa)}</span> : null}
      <span className="absolute right-0 top-[19px] text-[9.5px] tabular-nums text-slate-400">{units.fmt('pressure', esp.maxPa)}</span>
    </div>
  );
}

function SpecificationTab({ unit, spec, designSpeed }: { unit: HvacElement; spec: AcUnitSpecification | null; designSpeed: FanSpeed }) {
  const units = useHvacUnits();
  const ip = units.system === 'ip';
  const ducted = unit.type === 'ducted-ac';
  const air = readUnitAirData(unit);
  const typedLps = numberProperty(unit, 'airflowLps');
  const pa = (value: number) => units.fmt('pressure', value);
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
            air.airflowM3h ? { label: 'Airflow', value: `${units.fmt('airflow', air.airflowM3h.hi)} at Hi` } : null,
            { label: 'Size', value: <>{dimensions(units, [unit.height, unit.width, unit.depth])} <span className="text-[10px] text-slate-400">as placed</span></> },
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
  const collar = (size: readonly [number, number]) => `${units.section({ widthMm: size[0], heightMm: size[1] })} ${units.unit('size')}`;
  return (
    <PanelCard testId="unit-spec" label="Specification">
      <CardSection noDivider>
        <p className="text-[11px] font-medium text-slate-700">{spec.manufacturer}</p>
        <p className="text-[10.5px] text-slate-500">{spec.range}</p>
      </CardSection>
      {spec.airflowM3min ? (
        <CardSection>
          <Caption aside={typedLps ? (
            <InfoTip tip={`Its Airflow field (${typedLps} L/s = ${units.fmt('airflow', typedLps * 3.6)}) overrides the fan speed's airflow in duct sizing.`}>
              <Chip tone="amber">field {ip ? units.fmt('airflow', typedLps * 3.6) : `${typedLps} L/s`}</Chip>
            </InfoTip>
          ) : <span className="text-slate-400">{ducted ? `cooling · ducts at ${FAN_SPEED_LABELS[designSpeed]}` : 'cooling'}</span>}>Fan speeds</Caption>
          <FanSpeedTable airflowM3min={spec.airflowM3min} sound={spec.soundDbA} designSpeed={designSpeed} />
        </CardSection>
      ) : null}
      {esp ? (
        <CardSection testId="unit-spec-esp">
          <Caption aside={<span className="font-semibold tabular-nums text-slate-800">up to {pa(esp.maxPa)}</span>}>Fan pressure (ESP)</Caption>
          <EspRange esp={esp} />
          <SpecRows rows={[
            { label: 'Maximum', value: `${pa(esp.maxPa)}${esp.atAirflowM3min ? ` at ${units.fmt('airflow', m3h(esp.atAirflowM3min))}` : ''}` },
            esp.ratedPa ? { label: 'Rated at', value: pa(esp.ratedPa) } : null,
            esp.factoryRangePa ? { label: 'As delivered', value: <><i className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-sky-500 align-[-1px]" />{units.num('pressure', esp.factoryRangePa[0])}–{pa(esp.factoryRangePa[1])}</> } : null,
            esp.settingsPa?.length ? {
              label: 'Settable', title: esp.extendedBy ? `Wider than as delivered: ${esp.extendedBy}` : undefined,
              value: <><i className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-sky-200 align-[-1px]" />{units.num('pressure', esp.settingsPa[0]!)}–{pa(esp.settingsPa[esp.settingsPa.length - 1]!)}{esp.extendedBy ? <span className="text-slate-400"> · {esp.extendedBy.split(',')[0]}</span> : null}</>,
            } : null,
          ]} />
        </CardSection>
      ) : null}
      <CardSection>
        <Caption>Connections</Caption>
        <SpecRows rows={[
          spec.collars ? { label: 'Supply collar', value: <span className="flex items-center gap-1.5"><StatusDot kind="supply" />{collar(spec.collars.supply)}</span> } : null,
          spec.collars ? { label: 'Return collar', value: <span className="flex items-center gap-1.5"><StatusDot kind="return" />{collar(spec.collars.return)}</span> } : null,
          { label: 'Refrigerant', value: `${spec.refrigerant} · ${spec.joint === 'brazing' ? 'brazed' : 'flare'}` },
          { label: 'Pipes', value: ip ? `${inchFractionText(spec.liquidMm)} in liquid · ${inchFractionText(spec.gasMm)} in gas` : `Ø${spec.liquidMm} liquid · Ø${spec.gasMm} gas` },
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
          { label: 'Casing', value: <>{dimensions(units, [spec.casingMm.height, spec.casingMm.width, spec.casingMm.depth])} <span className="text-[10px] text-slate-400">H × W × D</span></> },
          spec.weightKg ? { label: 'Weight', value: units.fmt('mass', spec.weightKg) } : null,
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

function recordDiffs(units: HvacUnits, record: DuctSizingRecord, current: DuctSystemSizing | null, report: DuctSystemSizingReport | null): string[] {
  const out: string[] = [];
  const first = record.basis;
  if (first && current) {
    if (first.fanSpeed !== current.fanSpeed) out.push(`fan speed ${FAN_SPEED_LABELS[first.fanSpeed]} → ${FAN_SPEED_LABELS[current.fanSpeed]}`);
    if ((first.airflowM3h ?? null) !== (current.airflowM3h ?? null)) {
      out.push(`system airflow ${first.airflowM3h ? units.fmt('airflow', first.airflowM3h) : 'fan speed'} → ${current.airflowM3h ? units.fmt('airflow', current.airflowM3h) : 'fan speed'}`);
    }
    if (current.drive === 'friction' && Math.abs(first.frictionPaPerM - current.frictionPaPerM) > 0.004) out.push(`friction ${units.num('friction', first.frictionPaPerM)} → ${units.fmt('friction', current.frictionPaPerM)}`);
    if (current.drive === 'velocity' && Math.abs(first.mainVelocityMs - current.mainVelocityMs) > 0.04) out.push(`main velocity ${units.num('velocity', first.mainVelocityMs)} → ${units.fmt('velocity', current.mainVelocityMs)}`);
    for (const part of ['trunk', 'branch', 'runout'] as const) {
      if (Math.abs(first.maxVelocity[part] - current.maxVelocity[part]) > 0.04) out.push(`${part} limit ${units.num('velocity', first.maxVelocity[part])} → ${units.fmt('velocity', current.maxVelocity[part])}`);
    }
  }
  if (report) {
    for (const terminal of report.terminals) {
      const then = record.terminals.find((entry) => entry.terminalId === terminal.terminalId);
      if (!then) out.push(`${terminal.label} added`);
      else if (Math.abs(then.airflowM3h - terminal.airflowM3h) > 1) out.push(`${terminal.label} ${units.num('airflow', then.airflowM3h)} → ${units.fmt('airflow', terminal.airflowM3h)}`);
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
  const units = useHvacUnits();
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
  const diffs = recordDiffs(units, record, current, report);
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
        <MiniFigure label="Airflow">{FAN_SPEED_LABELS[record.fanSpeed]} · {record.airflowM3h ? units.fmt('airflow', record.airflowM3h) : '–'}</MiniFigure>
        <MiniFigure label="Basis">
          {record.basis ? (record.basis.drive === 'friction' ? `${units.fmt('friction', record.basis.frictionPaPerM)} set` : `${units.fmt('velocity', record.basis.mainVelocityMs)} set`) : 'optimum'}
        </MiniFigure>
        <MiniFigure label="Main">{units.fmt('velocity', record.mainVelocityMs)} · {units.num('friction', record.mainFrictionPaPerM)}</MiniFigure>
      </div>
      <p className="mt-1.5 text-[10px] tabular-nums text-slate-400">
        Limits {units.num('velocity', record.maxVelocity.trunk)} · {units.num('velocity', record.maxVelocity.branch)} · {units.fmt('velocity', record.maxVelocity.runout)}
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

// ---- Duct sizing: shared parts ----

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

/** The unit's collar on a service (the network's first line). */
function collarOf(unit: HvacElement, service: DuctService): { widthMm: number; heightMm: number } | null {
  const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === service);
  return port ? { widthMm: port.widthMm, heightMm: port.heightMm } : null;
}

/** "Necks follow airflow", with the cap a neck is held to. */
function NecksRow({ settings, capMs }: { settings: DuctDesignSettings; capMs: number }) {
  const units = useHvacUnits();
  const setDuctSettings = useSmartDrawingStore((state) => state.setDuctSettings);
  return (
    <div className="flex min-h-7 items-center justify-between gap-2 border-t border-slate-100 pt-1.5">
      <span className="flex items-center gap-1 text-[11px] text-slate-500">
        Necks follow airflow
        <InfoIcon label="About necks following airflow" tip="A terminal whose airflow needs more than its neck's velocity cap takes the next catalogue neck, its flexible runout with it. Necks never shrink on their own." />
      </span>
      <span className="flex items-center gap-2">
        <span className="text-[10px] tabular-nums text-slate-400">cap {units.fmt('velocity', capMs)}</span>
        <Switch checked={settings.autoNecksFollowAirflow} onChange={(checked) => setDuctSettings({ autoNecksFollowAirflow: checked })} label="Necks follow airflow" />
      </span>
    </div>
  );
}

/** Each terminal's row from a sizing report (its spec from the drawing). */
function terminalRowsOf(report: DuctSystemSizingReport | null, byId: ReadonlyMap<string, HvacElement>, nextNeck?: (terminalId: string) => number | null): TerminalRow[] {
  return (report?.terminals ?? []).flatMap((terminal) => {
    const element = byId.get(terminal.terminalId);
    const spec = element ? readDuctTerminalSpec(element) : null;
    if (!spec) return [];
    return [{
      id: terminal.terminalId, label: terminal.label, spec, airflowM3h: terminal.airflowM3h, fixed: terminal.fixed,
      neckMm: terminal.neckMm, neckVelocityMs: terminal.neckVelocityMs, nextNeckMm: nextNeck?.(terminal.terminalId) ?? null,
    }];
  });
}

/** Short titles for what the sizing reports (each message in full is in its tip). */
const ISSUE_TITLES: Record<string, string> = {
  DU_TERMINAL_VELOCITY: 'Neck velocity over its cap',
  DU_SIZE_NECK_KEPT: 'Neck kept: no room for a larger one',
  DU_SIZE_VELOCITY: 'Velocity over its limit',
  DU_SIZE_CAPPED: 'Held by the ceiling void',
  DU_SIZE_VOID: 'Taller than the ceiling void',
  DU_AUTO_AIRFLOW: 'Terminal airflows do not add up',
  DU_AUTO_ESP: 'Over the fan\'s pressure',
  DU_TRANSITION_ANGLE: 'Steep transition',
  DU_CLASH: 'Clash',
  DU_TAP_CLASH: 'Take-off clash',
  DU_TAP_TOO_BIG: 'Take-off too big for its main',
  DU_FLEX_LENGTH: 'Long flexible runout',
};

interface IssueGroup {
  code: string;
  severity: 'error' | 'warning';
  title: string;
  /** What the messages are about: the terminal or run each starts with ("SAD-5: …"). */
  subjects: string[];
  messages: string[];
}

/** The warnings and errors by kind, errors first: one line a kind. */
function issueGroups(issues: ReadonlyArray<{ code: string; severity: 'error' | 'warning' | 'info'; message: string }>): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const issue of issues) {
    if (issue.severity === 'info') continue;
    const subject = /^([^:]{1,24}):\s/.exec(issue.message)?.[1] ?? null;
    const group = groups.get(issue.code) ?? {
      code: issue.code, severity: issue.severity, subjects: [], messages: [],
      title: ISSUE_TITLES[issue.code] ?? issue.message.replace(/^[^:]{1,24}:\s/, '').split(/[.:(]/)[0]!.trim(),
    };
    if (issue.severity === 'error') group.severity = 'error';
    if (subject && !group.subjects.includes(subject)) group.subjects.push(subject);
    group.messages.push(issue.message);
    groups.set(issue.code, group);
  }
  return [...groups.values()].sort((a, b) => (a.severity === b.severity ? b.messages.length - a.messages.length : a.severity === 'error' ? -1 : 1));
}

// ---- Duct sizing: applied ducts ----

function AppliedSizing({ unit, unitTag, service, root, rootSpec, report, settings, scene, esp, airflowM3h }: {
  unit: HvacElement; unitTag: string; service: DuctService; root: HvacElement; rootSpec: DuctRunSpec; report: DuctSystemSizingReport | null;
  settings: DuctDesignSettings; scene: readonly HvacElement[]; esp: UnitEspCheck | null; airflowM3h: Readonly<Record<FanSpeed, number>> | null;
}) {
  const units = useHvacUnits();
  const [limitsOpen, setLimitsOpen] = useUnitPanelSection('limits');
  const [chartOpen, setChartOpen] = useUnitPanelSection('chart');
  const continued = useMemo(() => continueBasis(scene, unit.id, service, settings), [scene, unit.id, service, settings]);
  const dry = useMemo(() => dryRunSizing(scene, root.id, continued.basis, settings), [scene, root.id, continued.basis, settings]);
  const growing = useMemo(() => necksToGrow(scene, root.id, continued.basis, undefined, settings), [scene, root.id, continued.basis, settings]);
  // While R is held on the slider: the network at the rate under the thumb (a dry run; nothing changes until it is let go).
  const [held, setHeld] = useState<number | null>(null);
  const heldRate = useDeferredValue(held);
  const previewed = useMemo(() => (heldRate === null ? null
    : dryRunSizing(scene, root.id, { ...continued.basis, drive: 'friction', frictionPaPerM: heldRate }, settings).report), [heldRate, scene, root.id, continued.basis, settings]);
  const byId = useMemo(() => new Map(scene.map((element) => [element.id, element])), [scene]);
  const basis = report?.basis ?? continued.basis;
  const sizedByBasis = continued.from === 'stored';
  const matches = sizedByBasis && dry.driftRunIds.length === 0;
  const neckCap = service === 'return' ? settings.autoMaxNeckVelocityReturnMs : settings.autoMaxNeckVelocitySupplyMs;
  const resize = (next: DuctSystemSizing, what: string, airflows?: Record<string, number | null>) => {
    resizeDuctSystemOnDrawing(unit.id, service, next, airflows, `Duct sizing (${service}): ${what}`);
  };
  // What the network shows: the preview while R is held, else the basis's sizes (the drawing, when it matches), else as drawn.
  const shown = previewed ?? (matches ? dry.report : report);
  const shownBasis = shown?.basis ?? basis;
  const rows = useMemo(() => (shown ? ductNetworkRows(shown, scene) : []), [shown, scene]);
  const terminalRows = terminalRowsOf(report, byId,
    settings.autoNecksFollowAirflow ? (id) => growing.find((growth) => growth.terminalId === id)?.toMm ?? null : undefined);
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
  // enlarges it (rounded down, so it does), offered in the figure that drives.
  const smallest = matches && mainNow && mainNow.setBy === 'minimum' && mainNow.frictionPaPerM < mainBasis.frictionPaPerM - 0.005
    ? { friction: Math.floor(mainNow.frictionPaPerM * 100) / 100, velocity: Math.floor(velocityAtFriction(mainNow.airflowM3h, mainNow.frictionPaPerM) * 10) / 10 } : null;
  const useVelocity = continued.basis.drive === 'velocity' && smallest !== null && smallest.velocity >= 1;
  const useSmallest = () => {
    if (!smallest) return;
    if (useVelocity) {
      resize({ ...continued.basis, drive: 'velocity', mainVelocityMs: smallest.velocity }, `main velocity ${units.fmt('velocity', continued.basis.mainVelocityMs)} → ${units.fmt('velocity', smallest.velocity)}`);
    } else if (smallest.friction >= 0.1) {
      resize({ ...continued.basis, drive: 'friction', frictionPaPerM: smallest.friction }, `friction ${units.fmt('friction', continued.basis.frictionPaPerM)} → ${units.fmt('friction', smallest.friction)}`);
    }
  };
  const part = (name: string) => `${name[0]!.toUpperCase()}${name.slice(1)}`;
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
              The first change sizes every section by constant friction, {CONTINUE_LABEL[continued.from]} ({units.fmt('friction', continued.basis.frictionPaPerM)}).
            </InlineAlert>
          ) : null}
          {drift ? (
            <InlineAlert tone="warn" testId="unit-sizing-drift"
              actions={<PanelButton tone="primary" testId="unit-sizing-resize" title="Size every section again at this basis (one undo)" onClick={() => resizeDuctSystemAtBasis(unit.id, service)}>
                Re-size at this basis<ArrowRight size={11} aria-hidden="true" />
              </PanelButton>}>
              {plural(drift, 'run')} no longer match {units.fmt('friction', continued.basis.frictionPaPerM)} (a hand edit, a new branch or a changed airflow).
            </InlineAlert>
          ) : null}
          {esp?.withinFan === false ? (
            <InlineAlert tone="error">{units.fmt('pressure', esp.requiredPa)} is over the fan&apos;s {units.fmt('pressure', esp.maxEspPa)}: lower a friction rate, shorten the index run, or choose a unit with more ESP.</InlineAlert>
          ) : null}
          {issues.length ? (
            <InlineAlert tone={errors ? 'error' : 'warn'} testId="unit-sizing-issues">
              <ul className="space-y-0.5">
                {issueGroups(issues).slice(0, 4).map((group) => (
                  <li key={group.code}>
                    <InfoTip tip={<ul className="space-y-1">
                      {group.messages.slice(0, 5).map((message, index) => <li key={index}>{units.text(message)}</li>)}
                      {group.messages.length > 5 ? <li className="text-slate-400">and {group.messages.length - 5} more</li> : null}
                    </ul>}>
                      <span tabIndex={0} className="min-w-0 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300">
                        <span className="font-semibold">{group.title}</span>
                        {group.subjects.length ? <span className="opacity-80"> · {group.subjects.slice(0, 3).join(', ')}{group.subjects.length > 3 ? ` +${group.subjects.length - 3}` : ''}</span>
                          : group.messages.length > 1 ? <span className="opacity-80"> · {group.messages.length}</span> : null}
                      </span>
                    </InfoTip>
                  </li>
                ))}
                {issueGroups(issues).length > 4 ? <li className="text-[10.5px] opacity-75">and more (the run inspector lists them)</li> : null}
              </ul>
            </InlineAlert>
          ) : null}
        </div>
      ) : null}

      <CardSection testId="unit-sizing-continue">
        <DesignCriteriaPicker unit={unit} unitTag={unitTag} hasDucts />
        <div className="mt-2 space-y-1">
          <MethodStrip basis={shownBasis} report={shown} live={false} onChange={(next, what) => resize(next, what)} />
          <FrictionSlider frictionPaPerM={basis.frictionPaPerM} onPreview={setHeld}
            onCommit={(rate) => resize({ ...continued.basis, drive: 'friction', frictionPaPerM: rate }, `friction ${units.fmt('friction', basis.frictionPaPerM)} → ${units.fmt('friction', rate)}`)} />
          <FanSpeedAirflow speedLabel="Unit panel fan speed" airflowLabel="Unit panel system airflow" fanSpeed={basis.fanSpeed} airflowM3h={airflowM3h}
            typedM3h={basis.airflowM3h} defaultM3h={report?.airflowM3h ?? null}
            sourceNote={report?.airflowSource === 'unit' ? 'Airflow field' : report?.airflowSource === 'manufacturer' ? 'fan speed' : null}
            onFanSpeed={(speed) => resize({ ...continued.basis, fanSpeed: speed, airflowM3h: null }, `fan speed ${FAN_SPEED_LABELS[basis.fanSpeed]} → ${FAN_SPEED_LABELS[speed]}`)}
            onTypedAirflow={(value) => resize({ ...continued.basis, airflowM3h: value }, `airflow ${report?.airflowM3h ? units.fmt('airflow', report.airflowM3h) : '–'} → ${value === null ? 'fan speed' : units.fmt('airflow', value)}`)} />
          <VelocityLimits basis={basis} live={false} onChange={(next, what) => resize(next, what)} open={limitsOpen} onOpenChange={setLimitsOpen} />
        </div>
        {mainNow && (smallest || capped) ? (
          <div className="mt-1.5" data-testid="unit-sizing-main">
            {smallest ? (
              <div className="flex items-center justify-between gap-2 text-[10.5px] text-slate-500">
                <span className="min-w-0">Main {units.section(mainNow.section)} is at its smallest; it grows at ≤ {useVelocity ? units.fmt('velocity', smallest.velocity) : units.fmt('friction', smallest.friction)}.</span>
                <PanelButton testId="unit-sizing-use" title="Apply the figure at which the main grows (one undo)" onClick={useSmallest}>
                  Use {useVelocity ? units.fmt('velocity', smallest.velocity) : units.fmt('friction', smallest.friction)}
                </PanelButton>
              </div>
            ) : null}
            {capped ? (
              <InlineAlert tone="warn" testId="unit-sizing-governs"
                actions={raising?.changes && raisedLimit !== null ? (
                  <PanelButton tone="warn" testId="unit-sizing-raise-limit" title="Raise the limit so the friction rate sizes the main (one undo)"
                    onClick={() => resize({ ...continued.basis, maxVelocity: { ...continued.basis.maxVelocity, [capped.part]: raisedLimit } },
                      `${capped.part} limit ${units.fmt('velocity', basis.maxVelocity[capped.part])} → ${units.fmt('velocity', raisedLimit)}`)}>
                    Raise the limit to {units.fmt('velocity', raisedLimit)}
                  </PanelButton>
                ) : undefined}>
                {part(capped.part)} limit {units.fmt('velocity', basis.maxVelocity[capped.part])} holds the main below the basis ({units.fmt('velocity', basis.mainVelocityMs)}).
                {!raising?.changes ? (
                  <span className="mt-0.5 block text-[10.5px] opacity-80">
                    Raising it changes nothing here: {(raising?.mainSetBy && RAISE_KEPT_BY[raising.mainSetBy]) ?? 'another rule sizes the main as well'}.
                  </span>
                ) : null}
              </InlineAlert>
            ) : null}
          </div>
        ) : null}
      </CardSection>

      {shown ? (
        <CardSection testId="unit-sizing-network">
          <NetworkTree report={shown} rows={rows} unitTag={unitTag} collar={collarOf(unit, service)} />
          {previewed ? <p className="mt-1 text-[10.5px] text-sky-700" role="status">Preview at {units.fmt('friction', previewed.basis.frictionPaPerM)}: let go to size every section.</p>
            : !matches ? <p className="mt-1 text-[10.5px] leading-4 text-amber-800">As drawn: it differs from constant friction at this basis; the next change sizes it.</p> : null}
        </CardSection>
      ) : null}

      {report ? (
        <CardSection testId="unit-sizing-terminals">
          <TerminalGroupList rows={terminalRows} neckCapMs={Math.min(neckCap, basis.maxVelocity.runout)} live={false} systemAirflowM3h={report.airflowM3h}
            onChange={(ids, value, what) => resize(continued.basis, what, Object.fromEntries(ids.map((id) => [id, value])))}
            footer={<>
              {terminalRows.some((row) => row.fixed) ? (
                <div className="mb-1 flex justify-end">
                  <PanelButton tone="ghost" testId="unit-sizing-share" title="Clear every terminal's own airflow: they share again, the same spec the same airflow (one undo)"
                    onClick={() => resize(continued.basis, 'every terminal → shared', Object.fromEntries(terminalRows.map((row) => [row.id, null])))}>
                    <Wind size={11} aria-hidden="true" />Share all again
                  </PanelButton>
                </div>
              ) : null}
              <NecksRow settings={settings} capMs={neckCap} />
            </>} />
        </CardSection>
      ) : null}

      {shown && rows.length ? (
        <Disclosure title="Friction chart" summary={`${stretches(rows.filter((row) => row.section.airflowM3h > 0).length)} · R ${units.num('friction', shownBasis.frictionPaPerM)}`}
          open={chartOpen} onToggle={setChartOpen} testId="unit-sizing-chart">
          <FrictionChart report={shown} rows={rows} />
        </Disclosure>
      ) : null}
      <FirstSizing record={rootSpec.initialSizing} current={sizedByBasis ? continued.basis : null} report={report}
        onReset={() => resetDuctSystemToInitial(unit.id, service).refused ?? null} />
    </div>
  );
}

// ---- Duct sizing: before ducts exist (what Generate sizes at) ----

function DraftSizing({ unit, unitTag, service, terminals, settings }: { unit: HvacElement; unitTag: string; service: DuctService; terminals: readonly HvacElement[]; settings: DuctDesignSettings }) {
  const units = useHvacUnits();
  const draft = useDuctSizingDraft(unit.id);
  const update = useDuctSizingDraftStore((state) => state.update);
  const [limitsOpen, setLimitsOpen] = useUnitPanelSection('limits');
  const [chartOpen, setChartOpen] = useUnitPanelSection('chart');
  const { hvacElements, walls, rooms, setDuctSettings, projectSettings } = useSmartDrawingStore((state) => ({
    hvacElements: state.hvacElements, walls: state.walls, rooms: state.rooms, setDuctSettings: state.setDuctSettings, projectSettings: state.ductSettings,
  }), shallow);
  const preview = useDuctAutoPreviewStore((state) => ({ result: state.result, scene: state.scene, inputs: state.inputs }), shallow);
  // (A preview is keyed to the project's settings and the rooms' criteria; `settings` are the unit's own or its rooms'.)
  const current = preview.result?.unitId === unit.id && isAutoDuctPreviewCurrent(preview, hvacElements, projectSettings, walls, rooms);
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
  // The open preview's network for this service (its runs are not in the drawing yet).
  const previewService = current ? preview.result?.services.find((entry) => entry.service === service && entry.runs.length) ?? null : null;
  const previewReport = previewService?.sizingReport ?? null;
  const rows = useMemo(() => (previewReport && previewService ? ductNetworkRows(previewReport, previewService.runs) : []), [previewReport, previewService]);
  const serviceTerminals = terminals.filter((terminal) => readDuctTerminalSpec(terminal)?.service === service);
  const shares = shareAirflow(airflow.systemAirflowM3h ?? 0, serviceTerminals.map((terminal) => {
    const spec = readDuctTerminalSpec(terminal)!;
    const set = Object.prototype.hasOwnProperty.call(draft.terminalAirflows, terminal.id) ? draft.terminalAirflows[terminal.id] : spec.designAirflowM3h;
    return { id: terminal.id, spec: { designAirflowM3h: set ?? null, neckDiameterMm: spec.neckDiameterMm } };
  }));
  const terminalRows: TerminalRow[] = serviceTerminals.map((terminal, index) => {
    const spec = readDuctTerminalSpec(terminal)!;
    const share = shares[index]!;
    return {
      id: terminal.id, label: terminal.label || spec.kind, spec, airflowM3h: share.airflowM3h, fixed: share.fixed,
      neckMm: spec.neckDiameterMm, neckVelocityMs: neckVelocityMs(spec, share.airflowM3h),
    };
  });
  const neckCap = service === 'return' ? settings.autoMaxNeckVelocityReturnMs : settings.autoMaxNeckVelocitySupplyMs;
  const resizePreview = (next: DuctSizingDraft) => {
    if (!current || method !== 'constant-friction') return;
    // The services the preview holds (what the card generated), so its request and the card's inputs stay equal.
    const held = preview.result?.services.filter((entry) => entry.runs.length).map((entry) => entry.service) ?? [];
    resizeAutoDuctPreview(draftBases(held.length ? held : services, next, settings, draftAirflow(unit, next)),
      Object.keys(next.terminalAirflows).length ? next.terminalAirflows : undefined);
  };
  const setBasis = (next: DuctSystemSizing) => {
    const nextDraft = { ...draft, bases: { ...draft.bases, [service]: next } };
    update(unit.id, { bases: nextDraft.bases });
    resizePreview(nextDraft);
  };
  const setRate = (rate: number | null) => {
    if (rate !== null) setBasis({ ...basis, drive: 'friction', frictionPaPerM: rate });
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
      <CardSection testId="unit-sizing-continue">
        <DesignCriteriaPicker unit={unit} unitTag={unitTag} />
        <div className="mt-2 space-y-1">
          {method === 'constant-friction' ? (
            <>
              <MethodStrip basis={basis} report={previewReport} live onChange={(next) => setBasis(next)} />
              <FrictionSlider frictionPaPerM={basis.frictionPaPerM} onPreview={setRate} onCommit={setRate} />
            </>
          ) : <p className="text-[10.5px] text-slate-500">Least first cost plus fan energy over the life; switch to constant friction to set a basis.</p>}
          <FanSpeedAirflow speedLabel="Unit panel draft fan speed" airflowLabel="Unit panel draft airflow" fanSpeed={draft.fanSpeed} airflowM3h={air.airflowM3h}
            typedM3h={airflow.override} defaultM3h={airflow.defaultAirflowM3h} live
            sourceNote={airflow.defaultAirflowM3h ? (numberProperty(unit, 'airflowLps') ? 'Airflow field' : 'fan speed') : null}
            onFanSpeed={(speed) => update(unit.id, { fanSpeed: speed })}
            onTypedAirflow={(value) => update(unit.id, { airflowDraft: value === null ? '' : String(value) })} />
          {method === 'constant-friction' ? <VelocityLimits basis={basis} live onChange={(next) => setBasis(next)} open={limitsOpen} onOpenChange={setLimitsOpen} /> : null}
        </div>
      </CardSection>
      {previewReport && rows.length ? (
        <CardSection testId="unit-sizing-network">
          <NetworkTree report={previewReport} rows={rows} unitTag={unitTag} collar={collarOf(unit, service)} interactive={false} />
        </CardSection>
      ) : null}
      <CardSection testId="unit-sizing-terminals">
        <TerminalGroupList rows={terminalRows} neckCapMs={neckCap} systemAirflowM3h={airflow.systemAirflowM3h} live
          onChange={(ids, value) => {
            const nextDraft = { ...draft, terminalAirflows: { ...draft.terminalAirflows, ...Object.fromEntries(ids.map((id) => [id, value])) } };
            update(unit.id, { terminalAirflows: nextDraft.terminalAirflows });
            resizePreview(nextDraft);
          }}
          footer={<NecksRow settings={settings} capMs={neckCap} />} />
      </CardSection>
      {previewReport && rows.length ? (
        <Disclosure title="Friction chart" summary={`${stretches(rows.filter((row) => row.section.airflowM3h > 0).length)} · R ${units.num('friction', previewReport.basis.frictionPaPerM)}`}
          open={chartOpen} onToggle={setChartOpen} testId="unit-sizing-chart">
          <FrictionChart report={previewReport} rows={rows} interactive={false} />
        </Disclosure>
      ) : null}
    </div>
  );
}

// ---- Duct sizing: the card ----

/**
 * After a switch of units, the size series to go with it, offered once a
 * session: inch sizes with IP, metric with SI; and, with ducts, re-sizing them.
 */
function SizeSeriesOffer({ unitId, unitTag, hasDucts }: { unitId: string; unitTag: string; hasDucts: boolean }) {
  const units = useHvacUnits();
  const sizeSeries = useSmartDrawingStore((state) => state.ductSettings.sizeSeries);
  const setDuctSettings = useSmartDrawingStore((state) => state.setDuctSettings);
  const declined = useUnitPanelUiStore((state) => state.seriesDeclined[units.system] ?? false);
  const declineSeries = useUnitPanelUiStore((state) => state.declineSeries);
  const [resizeOffered, setResizeOffered] = useState(false);
  const wanted = units.system === 'ip' ? 'imperial' : 'metric';
  const name = wanted === 'imperial' ? 'inch' : 'metric';
  if (resizeOffered && sizeSeries === wanted && hasDucts) {
    return (
      <div className="px-2 pb-2">
        <InlineAlert tone="info" testId="unit-sizing-series-resize"
          actions={<>
            <PanelButton tone="primary" testId="unit-sizing-series-resize-go" title={`Size every duct of ${unitTag} again at its basis in ${name} sizes (one undo)`}
              onClick={() => { resizeUnitDuctsAtBasis(unitId, `Duct sizing: ${unitTag} re-sized to ${name} sizes`); setResizeOffered(false); }}>
              Re-size {unitTag}
            </PanelButton>
            <PanelButton tone="ghost" onClick={() => setResizeOffered(false)}>Later</PanelButton>
          </>}>
          New sizing uses {name} sizes. {unitTag}&apos;s ducts keep theirs until re-sized.
        </InlineAlert>
      </div>
    );
  }
  if (sizeSeries === wanted || declined) return null;
  return (
    <div className="px-2 pb-2">
      <InlineAlert tone="info" testId="unit-sizing-series-offer"
        actions={<>
          <PanelButton tone="primary" testId="unit-sizing-series-use" onClick={() => { setDuctSettings({ sizeSeries: wanted }); setResizeOffered(true); }}>
            Use {name} sizes
          </PanelButton>
          <PanelButton tone="ghost" onClick={() => declineSeries(units.system)}>Keep {wanted === 'imperial' ? 'metric' : 'inch'}</PanelButton>
        </>}>
        {wanted === 'imperial' ? 'Inch duct sizes too? Rectangles in 2 in steps, round by the inch.' : 'Metric duct sizes too? Rectangles in 50 mm steps, round from the stocked list.'}
      </InlineAlert>
    </div>
  );
}

function DuctSizingTab({ unit, unitTag, settings, scene, rooms, airSide, airflowM3h }: {
  unit: HvacElement; unitTag: string; settings: DuctDesignSettings; scene: readonly HvacElement[]; rooms: ReadonlyArray<Pick<Room, 'id' | 'vertices'>>;
  airSide: UnitAirSide; airflowM3h: Readonly<Record<FanSpeed, number>> | null;
}) {
  const units = useHvacUnits();
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
    if (system) return { service, note: system.spec.sizing ? units.num('friction', system.spec.sizing.frictionPaPerM) : system.spec.initialSizing?.method === 'life-cycle' ? 'optimum' : 'drawn' };
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
          <SizeSeriesOffer unitId={unit.id} unitTag={unitTag} hasDucts={systems.length > 0} />
          {system ? (
            <AppliedSizing key={`${unit.id}:${active}`} unit={unit} unitTag={unitTag} service={active} root={system.root} rootSpec={system.spec} report={measured[active] ?? null}
              settings={settings} scene={scene} esp={esp} airflowM3h={airflowM3h} />
          ) : <DraftSizing key={`${unit.id}:${active}:draft`} unit={unit} unitTag={unitTag} service={active} terminals={terminals} settings={settings} />}
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
  // The unit's ducts are designed and checked by its own criteria, else the rooms' it serves, else the project's.
  const designSettings = designSettingsForUnit(ductSettings, unit, { scene, rooms });
  const airSide = useUnitAirSide(unit, spec, designSettings, scene);
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
  const tag = unit ? (isAirSystemUnit(unit) ? tags.get(unit.id) : null) ?? (unit.label || 'Unit') : '';
  return (
    <div className="space-y-2.5 p-2.5" data-testid="unit-panel">
      {unit ? (
        <>
          <UnitHeader unit={unit} spec={spec} tag={tag}
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
                  ? <DuctSizingTab unit={unit} unitTag={tag} settings={designSettings} scene={scene} rooms={rooms} airSide={airSide} airflowM3h={air?.airflowM3h ?? null} />
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
