'use client';

/**
 * Properties-panel UI for ducts:
 *  - DuctRunInspector: the selected run's construction (SMACNA minimum → stock
 *    sheet, class, joint), pieces, issues and its own BOM;
 *  - DuctToolSection: options while the Duct tool is active;
 *  - DuctSystemsSection: project duct settings with their sources, the project
 *    BOM and the fabrication schedule (CSV).
 * Unverified rule values are always labelled as such.
 */
import { useMemo, useState } from 'react';
import { shallow } from 'zustand/shallow';

import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';

import { DuctNumberInput } from './DuctNumberInput';
import { buildDuctBom, buildDuctFabricationSchedule, ductBomToCsv, ductScheduleToCsv, type DuctBomRow } from './ductBom';
import { findReattachTarget } from './ductBranchTargets';
import { gaugeLabelForSheet } from './ductCatalog';
import { commitDuctRunEdit, commitDuctRunSpec, commitDuctTerminalEdit, commitDuctTerminalRetype, isTerminalConnected, reattachDuctRun } from './ductEditController';
import { setDuctRiserRise } from './ductEdits';
import { getDuctRunPlan, type DuctFabricationPlan } from './ductFabricationPlanner';
import { DUCT_VANES, type DuctVaneType } from './ductFittingRules';
import { describeJoint } from './ductGauge';
import { ductBranchesOf } from './ductNetwork';
import { defaultPlenumSize } from './ductPlenum';
import { DUCT_RULE_SOURCES, DUCT_SUPPORTED_PRESSURE_CLASSES_PA, type DuctDesignSettings, type DuctJointSystem } from './ductSettings';
import { neckVelocityMs } from './ductSizing';
import { DUCT_SOURCES, isPracticeSource } from './ductSources';
import { getDuctSupportPlan, resolveSoffitZ } from './ductSupports';
import { ductSystemRootOfRun } from './ductSystemSizing';
import {
  DUCT_TERMINAL_FILTER_CLASSES,
  DUCT_TERMINAL_NECKS_MM,
  isDuctTerminalElement,
  readDuctTerminalSpec,
  TERMINAL_FACE_LABELS,
  TERMINAL_FILTER_LABELS,
  terminalFilterDropPa,
  terminalLabel,
  typicalTerminalSpec,
  type DuctTerminalFilterClass,
  type DuctTerminalKind,
  type DuctTerminalSpigotSide,
} from './ductTerminals';
import { tapStyleFor, useDuctToolStore } from './ductToolStore';
import { isDuctElement, isRoundLeg, readDuctRunSpec, type DuctLeg, type DuctNodeOverride, type DuctRunSpec } from './ductTypes';

const JOINT_OPTIONS: Array<{ value: DuctJointSystem; label: string }> = [
  { value: 'auto', label: 'Auto (TDC → angle)' },
  { value: 'tdc', label: 'TDC / TDF flange' },
  { value: 'ductmate', label: 'Ductmate' },
  { value: 'angle-flange', label: 'L-angle companion flange' },
];

function describeStart(spec: DuctRunSpec, hvacElements: readonly HvacElement[]): string {
  const start = spec.start;
  const parentLabel = (id: string) => {
    const parent = hvacElements.find((element) => element.id === id);
    return parent ? (parent.label || parent.id) : 'missing run';
  };
  if (start.kind === 'unit-port') return `unit collar (${start.portId})${start.connector ? ' + flexible connector' : ''}`;
  if (start.kind === 'tap') {
    return `${start.style === 'shoe-45' ? 'shoe' : 'straight'} take-off on ${parentLabel(start.parentRunId)} at ${(start.stationMm / 1000).toFixed(2)} m${start.vcd ? ' + VCD' : ''}`;
  }
  if (start.kind === 'split-branch') return `split outlet of ${parentLabel(start.parentRunId)}${start.vcd ? ' + VCD' : ''}`;
  if (start.kind === 'spigot') return `${start.style} spigot on the ${start.face} face of ${parentLabel(start.parentRunId)}'s plenum${start.vcd ? ' + VCD' : ''}`;
  if (start.kind === 'open') return start.orphaned ? 'open (its parent run was deleted)' : 'open';
  return start.kind;
}

function describeEnd(spec: DuctRunSpec): string {
  const end = spec.end;
  if (end.kind === 'split') return end.style === 'y' ? 'Y split' : end.style === 'wye' ? 'wye' : 'bullhead tee';
  if (end.kind === 'plenum') return `plenum ${Math.round(end.widthMm)} × ${Math.round(end.heightMm)} × ${Math.round(end.lengthMm)}`;
  if (end.kind === 'terminal') return `${end.flex ? 'flexible runout to ' : ''}an air terminal`;
  return end.kind === 'end-cap' ? 'end cap' : end.kind;
}

function Row({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-2 gap-y-1 py-1 text-sm" title={title}>
      <span className="min-w-0 flex-[1_1_6rem] break-words text-slate-500">{label}</span>
      <span className="ml-auto min-w-0 max-w-full break-words text-right text-slate-800 [&_input]:max-w-full [&_select]:min-w-0 [&_select]:max-w-full">{children}</span>
    </div>
  );
}

function SourceBadge({ settingKey }: { settingKey: keyof DuctDesignSettings }) {
  const source = DUCT_RULE_SOURCES[settingKey];
  if (!source) return null;
  const title = [DUCT_SOURCES[source.sourceId].document, source.reference, source.note].filter(Boolean).join(' — ');
  if (source.verified) return <span className="ml-1 rounded bg-emerald-50 px-1 text-[10px] text-emerald-700" title={title}>verified</span>;
  // SMACNA gives no number for these: labelled as the project's own practice, never as a standard.
  if (isPracticeSource(source.sourceId)) return <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] text-slate-600" title={title}>practice</span>;
  return <span className="ml-1 rounded bg-amber-50 px-1 text-[10px] text-amber-700" title={title}>unverified</span>;
}

type NumericSettingKey = {
  [K in keyof DuctDesignSettings]: DuctDesignSettings[K] extends number ? K : never
}[keyof DuctDesignSettings];

/** One numeric project setting, committed on blur, with its source badge. */
function SettingNumber({ settingKey, label, step, min, max, unit = 'mm' }: {
  settingKey: NumericSettingKey; label: string; step: number; min: number; max: number; unit?: string;
}) {
  const { value, setDuctSettings } = useSmartDrawingStore((state) => ({ value: state.ductSettings[settingKey], setDuctSettings: state.setDuctSettings }), shallow);
  return (
    <Row label={label}>
      <CommitNumber label={label} value={value} step={step} min={min} max={max} onCommit={(next) => setDuctSettings({ [settingKey]: next })} />
      {unit ? <span className="ml-0.5 text-[10px] text-slate-400">{unit}</span> : null}
      <SourceBadge settingKey={settingKey} />
    </Row>
  );
}

function BomTable({ rows }: { rows: DuctBomRow[] }) {
  if (rows.length === 0) return <p className="text-xs text-slate-500">Nothing to schedule.</p>;
  return (
    <table className="w-full table-fixed text-[11px]">
      <tbody>
        {rows.map((row, index) => (
          <tr key={index} className={row.category === 'Issues' ? 'text-red-700' : 'text-slate-700'}>
            <td className="break-words py-0.5 pr-2 align-top">{row.description}{row.size !== '—' ? <span className="text-slate-400"> · {row.size}</span> : null}</td>
            <td className="w-20 break-words py-0.5 text-right align-top">{row.quantity} {row.unit}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

function usePlans(): DuctFabricationPlan[] {
  const { hvacElements, ductSettings } = useSmartDrawingStore((state) => ({
    hvacElements: state.hvacElements, ductSettings: state.ductSettings,
  }), shallow);
  return useMemo(() => hvacElements
    .filter(isDuctElement)
    .map((element) => getDuctRunPlan(element, hvacElements, ductSettings))
    .filter((plan): plan is DuctFabricationPlan => plan !== null), [hvacElements, ductSettings]);
}

/** A number field that commits on blur or Enter (never per keystroke). */
function CommitNumber({ value, onCommit, step = 10, min = 50, max = 3000, label }: {
  value: number; onCommit: (value: number) => void; step?: number; min?: number; max?: number; label: string;
}) {
  return (
    <DuctNumberInput value={value} label={label} step={step} min={min} max={max}
      onChange={(next) => { if (next !== null) onCommit(next); }} />
  );
}

/** "4 hangers · M8 rods · L25.4×3.2 · soffit 2900" (and any support issue). */
function supportSummary(supports: ReturnType<typeof getDuctSupportPlan>): string {
  const rods = [...new Set(supports.hangers.map((hanger) => hanger.rod?.label ?? 'special'))].join('/');
  const bars = [...new Set(supports.hangers.map((hanger) => hanger.bar?.member.label ?? (hanger.kind === 'band' ? 'band' : 'special')))].join('/');
  const risers = supports.risers.length > 0 ? ` · ${supports.risers.length} riser support${supports.risers.length === 1 ? '' : 's'}` : '';
  const issue = supports.issues[0] ? ` · ${supports.issues[0].message}` : '';
  return `${supports.hangers.length} hanger${supports.hangers.length === 1 ? '' : 's'} at ≤ ${supports.spacingMm} mm · ${rods} rods · ${bars} · soffit ${Math.round(supports.soffitZ)}${risers}${issue}`;
}

/** A vertical leg's rise (+ up, − down), or null for a level leg. */
function riseOf(spec: DuctRunSpec, index: number): number | null {
  const a = spec.path[index];
  const b = spec.path[index + 1];
  if (!a || !b || Math.hypot(b.x - a.x, b.y - a.y) >= 0.5 || Math.abs(b.z - a.z) <= 0.5) return null;
  return Math.round(b.z - a.z);
}

/** "Leg 2 · bottom 2669" for a level leg, "Leg 3 · drop ▼ 800" for a vertical one. */
function legCaption(spec: DuctRunSpec, index: number): string {
  const a = spec.path[index];
  const b = spec.path[index + 1];
  if (!a || !b) return `Leg ${index + 1}`;
  const plan = Math.hypot(b.x - a.x, b.y - a.y);
  const rise = b.z - a.z;
  if (plan < 0.5 && Math.abs(rise) > 0.5) return `Leg ${index + 1} · ${rise > 0 ? 'riser ▲' : 'drop ▼'} ${Math.round(Math.abs(rise))}`;
  return `Leg ${index + 1} · bottom ${Math.round(a.z)}`;
}

/** A diffuser or return grille: its size (typical catalog, practice), spigot and ceiling level. */
/** A number that may be left blank (null); commits on Enter or blur. */
function TerminalAirflowInput({ value, onCommit }: { value: number | null; onCommit: (value: number | null) => void }) {
  return (
    <DuctNumberInput value={value} onChange={onCommit} step={10} min={0.01} max={20000}
      label="Terminal design airflow" placeholder="share" allowEmpty />
  );
}

/** The faces offered for each service (in ceilings a louvred or egg-crate face is a return grille). */
const TERMINAL_FACES: Record<'supply' | 'return', readonly DuctTerminalKind[]> = {
  supply: ['square-4way', 'round', 'linear-slot', 'perforated'],
  return: ['return-egg-crate', 'louvred', 'perforated', 'square-4way', 'round', 'linear-slot'],
};

export function DuctTerminalInspector({ element }: { element: HvacElement }) {
  const { updateHvacElement, hvacElements, ductSettings } = useSmartDrawingStore((state) => ({
    updateHvacElement: state.updateHvacElement, hvacElements: state.hvacElements, ductSettings: state.ductSettings,
  }), shallow);
  const connected = useMemo(() => isTerminalConnected(hvacElements, element.id), [hvacElements, element.id]);
  const spec = readDuctTerminalSpec(element);
  if (!spec) return null;
  const select = 'min-w-0 max-w-full rounded border border-slate-200 px-1 py-0.5 text-xs';
  // A new neck keeps everything the designer set: the side, the airflow and the filter.
  const reshape = (neckDiameterMm: number) => ({
    ...typicalTerminalSpec(spec.kind, neckDiameterMm, {
      service: spec.service, mount: spec.mount, filter: spec.filter ?? null, ...(spec.slots !== undefined ? { slots: spec.slots } : {}),
      ...(spec.kind === 'linear-slot' ? { lengthMm: spec.faceWidthMm } : {}),
    }),
    spigotSide: spec.spigotSide,
    designAirflowM3h: spec.designAirflowM3h ?? null,
  });
  const faces = TERMINAL_FACES[spec.service].includes(spec.kind) ? TERMINAL_FACES[spec.service] : [spec.kind, ...TERMINAL_FACES[spec.service]];
  const filterDrop = spec.filter && spec.designAirflowM3h ? terminalFilterDropPa(spec, spec.designAirflowM3h, ductSettings) : null;
  const serviceHint = connected
    ? 'A duct is connected to this terminal: delete or re-route its runout to change supply ⇄ return.'
    : 'Supply air from its unit, or return air back to it.';
  return (
    <div className="space-y-1" data-testid="duct-terminal-inspector">
      <Row label="Label">
        <input type="text" value={element.label} onChange={(event) => updateHvacElement(element.id, { label: event.target.value })}
          className="w-36 rounded border border-amber-200/80 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400" />
      </Row>
      <Row label="Terminal">
        <span className="text-xs">{terminalLabel(spec)} · {spec.mount}</span>
        <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] text-slate-600" title="Typical catalog size; SMACNA gives none. Replace with the supplier's data.">practice</span>
      </Row>
      <Row label="Service" title={serviceHint}>
        <span className="inline-flex overflow-hidden rounded-md border border-slate-200" role="radiogroup" aria-label="Terminal service">
          {(['supply', 'return'] as const).map((service) => (
            <button key={service} type="button" role="radio" aria-checked={spec.service === service} disabled={connected && spec.service !== service}
              title={serviceHint}
              onClick={() => commitDuctTerminalRetype(element, { service }, service === 'return' ? 'Terminal to return' : 'Terminal to supply')}
              className={`px-1.5 py-0.5 text-[11px] disabled:opacity-40 ${spec.service === service
                ? (service === 'supply' ? 'bg-blue-700 text-white' : 'bg-teal-700 text-white') : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
              {service === 'supply' ? 'Supply' : 'Return'}
            </button>
          ))}
        </span>
      </Row>
      <Row label="Face">
        <select value={spec.kind} aria-label="Terminal face" className={select}
          onChange={(event) => commitDuctTerminalRetype(element, { kind: event.target.value as DuctTerminalKind }, 'Terminal face')}>
          {faces.map((kind) => <option key={kind} value={kind}>{TERMINAL_FACE_LABELS[kind]}</option>)}
        </select>
      </Row>
      {spec.service === 'return' ? (
        <Row label="Filter" title="Filter panel behind a hinged face, changed from the room. ASHRAE 62.1 §5.8 asks for MERV 8 (≈ M5) upstream of a wet cooling coil unless the unit filters the air itself.">
          <select value={spec.filter ?? ''} aria-label="Terminal filter" className={select}
            onChange={(event) => commitDuctTerminalEdit(element, { spec: { ...spec, filter: (event.target.value || null) as DuctTerminalFilterClass | null } }, 'Terminal filter')}>
            <option value="">None</option>
            {DUCT_TERMINAL_FILTER_CLASSES.map((filter) => (
              <option key={filter} value={filter}>{TERMINAL_FILTER_LABELS[filter].label} ({TERMINAL_FILTER_LABELS[filter].equivalent})</option>
            ))}
          </select>
          {filterDrop !== null ? <span className="ml-1 text-[10px] text-slate-500">≈ {Math.round(filterDrop)} Pa at its airflow</span> : null}
        </Row>
      ) : null}
      <Row label="Spigot Ø">
        <select value={spec.neckDiameterMm} aria-label="Terminal spigot diameter" className={select}
          onChange={(event) => commitDuctTerminalEdit(element, { spec: reshape(Number(event.target.value)) }, 'Terminal spigot size')}>
          {[...new Set([...DUCT_TERMINAL_NECKS_MM, spec.neckDiameterMm])].sort((a, b) => a - b).map((neck) => <option key={neck} value={neck}>Ø{neck}</option>)}
        </select>
      </Row>
      <Row label="Spigot side">
        <select value={spec.spigotSide} aria-label="Terminal spigot side" className={select}
          onChange={(event) => commitDuctTerminalEdit(element, { spec: { ...spec, spigotSide: event.target.value as DuctTerminalSpigotSide } }, 'Terminal spigot side')}>
          {(['back', 'front', 'left', 'right'] as const).map((side) => <option key={side} value={side}>{side}</option>)}
        </select>
      </Row>
      <Row label="Face / plenum box">
        <span className="text-xs">{Math.round(spec.faceWidthMm)} × {Math.round(spec.faceDepthMm)} · box {Math.round(spec.plenumWidthMm)} × {Math.round(spec.plenumDepthMm)} × {Math.round(spec.plenumHeightMm)} mm</span>
      </Row>
      <Row label="Ceiling level">
        <CommitNumber label="Terminal ceiling level" value={element.elevation} step={50} min={0} max={30000}
          onCommit={(elevation) => commitDuctTerminalEdit(element, { elevation }, 'Terminal ceiling level')} />
        <span className="ml-0.5 text-[10px] text-slate-400">mm (face)</span>
      </Row>
      <Row label="Design airflow" title="Used by Auto duct; blank = an equal share of its unit's airflow">
        <TerminalAirflowInput
          value={spec.designAirflowM3h ?? null}
          onCommit={(designAirflowM3h) => commitDuctTerminalEdit(element, { spec: { ...spec, designAirflowM3h } }, 'Terminal airflow')} />
        <span className="ml-0.5 text-[10px] text-slate-400">m³/h</span>
        {spec.designAirflowM3h ? (
          <span className="ml-1 text-[10px] text-slate-500">{neckVelocityMs(spec, spec.designAirflowM3h).toFixed(1)} m/s in the neck</span>
        ) : null}
      </Row>
    </div>
  );
}

/** The system a run belongs to: its unit, and how it is sized (constant friction at its basis, or the optimiser). */
function SystemLine({ element }: { element: HvacElement }) {
  const { hvacElements, selectElement } = useSmartDrawingStore((state) => ({ hvacElements: state.hvacElements, selectElement: state.selectElement }), shallow);
  const root = useMemo(() => ductSystemRootOfRun(hvacElements, element.id), [hvacElements, element.id]);
  const spec = root ? readDuctRunSpec(root) : null;
  if (!spec || spec.start.kind !== 'unit-port') return null;
  const unitId = spec.start.unitId;
  const unit = hvacElements.find((candidate) => candidate.id === unitId);
  const sizing = spec.sizing;
  return (
    <Row label="System">
      <span className="text-xs" data-testid="duct-run-system">
        {(unit?.label || 'Unit')} {spec.service} · {sizing
          ? `constant friction ${sizing.frictionPaPerM.toFixed(2)} Pa/m · ${sizing.mainVelocityMs.toFixed(1)} m/s`
          : 'life-cycle optimum'}
      </span>
      {unit ? (
        <button type="button" onClick={() => selectElement(unitId)} title="Select the unit: its Auto duct card sizes the ducts on it"
          className="ml-1 rounded border border-sky-200 bg-sky-50 px-1 text-[10px] text-sky-800 hover:bg-sky-100">
          Size this system
        </button>
      ) : null}
    </Row>
  );
}

export function DuctRunInspector({ element }: { element: HvacElement }) {
  const { hvacElements, ductSettings, updateHvacElement } = useSmartDrawingStore((state) => ({
    hvacElements: state.hvacElements,
    ductSettings: state.ductSettings,
    updateHvacElement: state.updateHvacElement,
  }), shallow);
  const tool = useDuctToolStore();
  const plan = useMemo(() => getDuctRunPlan(element, hvacElements, ductSettings), [element, hvacElements, ductSettings]);
  const bom = useMemo(() => (plan ? buildDuctBom([plan], [getDuctSupportPlan(plan, hvacElements, ductSettings)]) : []), [plan, hvacElements, ductSettings]);
  const reattachStyle = plan ? tapStyleFor(plan.spec.legs[0]) : tool.tapStyle;
  const reattach = useMemo(() => (plan && plan.spec.start.kind === 'open'
    ? findReattachTarget(element, hvacElements, ductSettings, { style: reattachStyle, vcd: tool.vcd }) : null),
  [plan, element, hvacElements, ductSettings, reattachStyle, tool.vcd]);
  if (!plan) return null;
  const spec = plan.spec;
  const construction = plan.constructionByLeg[0];
  const commit = (next: DuctRunSpec, action: string) => commitDuctRunSpec(element, next, action);
  const count = (kind: string) => plan.pieces.filter((piece) => piece.kind === kind).length;
  const pieceSummary = [
    [count('straight'), 'section'], [count('elbow'), 'elbow'], [count('offset'), 'offset'], [count('transition'), 'transition'],
    [count('takeoff'), 'take-off'], [count('damper'), 'damper'], [count('split'), 'split'],
    [count('connector'), 'connector'], [count('end-cap'), 'cap'],
  ].filter(([n]) => (n as number) > 0).map(([n, label]) => `${n} ${label}${n === 1 || label === 'cap' ? '' : 's'}`).join(' · ');
  const endValue = spec.end.kind === 'split' ? spec.end.style : spec.end.kind;
  // While branches leave the split, only its style may change.
  const splitBranches = ductBranchesOf(element.id, hvacElements).filter((branch) => branch.start.kind === 'split-branch').length;
  const spigotBranches = ductBranchesOf(element.id, hvacElements).filter((branch) => branch.start.kind === 'spigot').length;
  const setLeg = (index: number, update: Partial<DuctLeg>) => {
    const legs = spec.legs.map((leg, legIndex) => (legIndex === index ? { ...leg, ...update } : leg));
    commit({ ...spec, legs }, `Duct leg ${index + 1} size`);
  };
  const setNode = (node: number, update: Partial<DuctNodeOverride> | null) => {
    const nodeOverrides = { ...spec.nodeOverrides };
    const merged = update === null ? {} : { ...(nodeOverrides[String(node)] ?? {}), ...update };
    const cleaned = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as DuctNodeOverride;
    if (Object.keys(cleaned).length === 0) delete nodeOverrides[String(node)];
    else nodeOverrides[String(node)] = cleaned;
    commit({ ...spec, nodeOverrides }, `Duct elbow ${node}`);
  };
  const elbows = plan.pieces.filter((piece) => piece.kind === 'elbow' && piece.nodeIndex !== undefined);
  const select = 'min-w-0 max-w-full rounded border border-slate-200 px-1 py-0.5 text-xs';
  return (
    <div className="space-y-1" data-testid="duct-run-inspector">
      <Row label="Label">
        <input
          type="text"
          value={element.label}
          onChange={(event) => updateHvacElement(element.id, { label: event.target.value })}
          className="w-36 rounded border border-amber-200/80 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
        />
      </Row>
      <Row label="Service"><span className="capitalize">{spec.service}</span>{spec.legacy ? <span className="ml-1 text-xs text-slate-400">(old stub)</span> : null}</Row>
      <SystemLine element={element} />
      <Row label="Construction">
        <select value={spec.construction === 'gi-nbr' ? 'gi-nbr' : 'gi-bare'} aria-label="Run construction" className={select}
          onChange={(event) => {
            const construction = event.target.value as 'gi-bare' | 'gi-nbr';
            const insulationThicknessMm = construction === 'gi-nbr'
              ? (spec.service === 'return' ? ductSettings.nbrReturnThicknessMm : ductSettings.nbrSupplyThicknessMm) : 0;
            commit({ ...spec, construction, insulationThicknessMm }, 'Duct construction');
          }}>
          <option value="gi-bare">GI, bare</option>
          <option value="gi-nbr">GI + NBR insulation</option>
        </select>
        {spec.construction === 'gi-nbr' ? (
          <>
            {' '}
            <CommitNumber label="Insulation thickness" value={plan.insulationMm} step={1} min={6} max={50}
              onCommit={(insulationThicknessMm) => commit({ ...spec, insulationThicknessMm }, 'Duct insulation thickness')} />
            <span className="ml-0.5 text-[10px] text-slate-400">mm</span>
          </>
        ) : null}
      </Row>
      <Row label="Starts at">
        {describeStart(spec, hvacElements)}
        {reattach ? (
          <button type="button" className="ml-1 rounded border border-amber-300 px-1.5 text-xs text-amber-800 hover:bg-amber-50" data-testid="duct-reattach"
            onClick={() => reattachDuctRun(element, { style: reattachStyle, vcd: tool.vcd })}>
            Re-attach to {reattach.parent.label || reattach.parent.id}
          </button>
        ) : null}
      </Row>
      <Row label="Length">{(plan.polylineLengthMm / 1000).toFixed(2)} m · {spec.legs.length} leg(s)</Row>
      <Row label="Supports">
        <span className="text-xs" data-testid="duct-supports-summary">{supportSummary(getDuctSupportPlan(plan, hvacElements, ductSettings))}</span>
      </Row>
      {!spec.legacy ? (
        <div className="rounded border border-slate-100 px-2 py-1" data-testid="duct-leg-sizes">
          <div className="text-xs text-slate-500">Clear section per leg (W × H mm; a change adds a transition)</div>
          {spec.legs.map((leg, index) => (
            <div key={index} className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 py-0.5 text-xs">
              <span className="text-slate-500">
                {legCaption(spec, index)}
                {riseOf(spec, index) !== null ? (
                  <span className="ml-1" title="Rise (+) or drop (−) in mm; the run after it moves with it">
                    <CommitNumber label={`Leg ${index + 1} rise`} value={riseOf(spec, index)!} step={50} min={-30000} max={30000}
                      onCommit={(rise) => {
                        const result = setDuctRiserRise(spec, index, rise);
                        if (result) commitDuctRunEdit(element.id, result, 'Duct riser height');
                      }} />
                  </span>
                ) : null}
              </span>
              <span className="ml-auto max-w-full">
                <CommitNumber label={`Leg ${index + 1} width`} value={leg.widthMm} onCommit={(widthMm) => setLeg(index, { widthMm })} />
                {' × '}
                <CommitNumber label={`Leg ${index + 1} height`} value={leg.heightMm} onCommit={(heightMm) => setLeg(index, { heightMm })} />
              </span>
            </div>
          ))}
        </div>
      ) : (
        <Row label="Clear section">{Math.round(spec.legs[0]!.widthMm)} × {Math.round(spec.legs[0]!.heightMm)} mm</Row>
      )}
      <Row label="Pressure class">
        <select value={spec.pressureClassPa ?? 'project'} aria-label="Run pressure class" className={select}
          onChange={(event) => commit({ ...spec, pressureClassPa: event.target.value === 'project' ? null : Number(event.target.value) }, 'Duct pressure class')}>
          <option value="project">Project ({spec.service === 'supply' ? ductSettings.supplyPressureClassPa : ductSettings.returnPressureClassPa} Pa)</option>
          {DUCT_SUPPORTED_PRESSURE_CLASSES_PA.map((pa) => <option key={pa} value={pa}>{pa} Pa</option>)}
        </select>
      </Row>
      {construction && construction.status === 'ok' ? (
        <>
          <Row label="SMACNA minimum" title={construction.table ? `Table ${construction.table}, ${construction.spacingColumnMm} mm column` : 'longest-side table'}>
            {construction.smacnaMinThicknessMm?.toFixed(2)} mm{construction.table ? ` · T${construction.table}` : ''}
          </Row>
          <Row label="Joint class">{construction.requiredClass ?? 'none required'}{construction.tieRodAlternative ? ` (tie-rod ${construction.tieRodAlternative})` : ''}</Row>
          <Row label="Joint">{describeJoint(construction.joint)}</Row>
          {construction.crossBreak.width || construction.crossBreak.height ? <Row label="Cross-break">wide sides (S1.15)</Row> : null}
        </>
      ) : (
        <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{construction?.message ?? 'Construction unresolved.'}</p>
      )}
      <Row label="Sheet">
        <select value={spec.gaugeOverrideMm ?? 'auto'} aria-label="Run sheet" className={select}
          onChange={(event) => commit({ ...spec, gaugeOverrideMm: event.target.value === 'auto' ? null : Number(event.target.value) }, 'Duct sheet')}>
          <option value="auto">Auto{construction?.sheetThicknessMm ? ` (${construction.sheetThicknessMm.toFixed(2)} mm · ${gaugeLabelForSheet(construction.sheetThicknessMm)})` : ''}</option>
          {ductSettings.availableSheetThicknessesMm.map((sheet) => (
            <option key={sheet} value={sheet} disabled={construction?.smacnaMinThicknessMm !== null && construction?.smacnaMinThicknessMm !== undefined && sheet + 1e-6 < construction.smacnaMinThicknessMm}>
              {sheet.toFixed(2)} mm · {gaugeLabelForSheet(sheet)}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Joint system">
        <select value={spec.jointSystem ?? 'project'} aria-label="Run joint system" className={select}
          onChange={(event) => commit({ ...spec, jointSystem: event.target.value === 'project' ? null : (event.target.value as DuctJointSystem) }, 'Duct joint system')}>
          <option value="project">Project default</option>
          {JOINT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </Row>
      {elbows.length > 0 ? (
        <div className="rounded border border-slate-100 px-2 py-1" data-testid="duct-elbows">
          <div className="text-xs text-slate-500">Elbows (SMACNA Fig. 2-2 / 2-3)</div>
          {elbows.map((piece) => {
            const node = piece.nodeIndex!;
            const override = spec.nodeOverrides[String(node)] ?? {};
            const elbow = piece.elbow!;
            return (
              <div key={node} className="flex flex-wrap items-center justify-between gap-1 py-0.5 text-xs">
                <span className="text-slate-500">{piece.mark} · {Math.round(elbow.angleDeg)}°</span>
                <select value={override.elbowStyle ?? 'auto'} aria-label={`Elbow ${node} style`} className={select}
                  onChange={(event) => setNode(node, { elbowStyle: event.target.value === 'auto' ? undefined : (event.target.value as 'radius' | 'square-vaned') })}>
                  <option value="auto">Project ({elbow.style === 'radius' ? 'radius' : 'vaned'})</option>
                  <option value="radius">Radius</option>
                  <option value="square-vaned">Square, vanes</option>
                </select>
                {elbow.style === 'radius' ? (
                  <span>R/W <CommitNumber label={`Elbow ${node} R/W`} step={0.25} min={0.25} max={3}
                    value={override.centrelineRatio ?? ductSettings.elbowCentrelineRatio}
                    onCommit={(centrelineRatio) => setNode(node, { centrelineRatio })} /></span>
                ) : (
                  <select value={override.vaneType ?? 'auto'} aria-label={`Elbow ${node} vanes`} className={select}
                    onChange={(event) => setNode(node, { vaneType: event.target.value === 'auto' ? undefined : (event.target.value as DuctVaneType) })}>
                    <option value="auto">Vanes: project ({elbow.vanes?.spec.type ?? 'auto'})</option>
                    {Object.values(DUCT_VANES).map((vane) => <option key={vane.type} value={vane.type}>{vane.label}</option>)}
                  </select>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
      <Row label="Ends in">
        {spec.legacy ? describeEnd(spec) : (
          <select value={endValue} aria-label="Run end" className={select}
            onChange={(event) => {
              const value = event.target.value;
              const end: DuctRunSpec['end'] = value === 'y' || value === 'bullhead' || value === 'wye' ? { kind: 'split', style: value }
                : value === 'plenum' ? { kind: 'plenum', ...defaultPlenumSize(spec.legs[spec.legs.length - 1]!) }
                  : { kind: value as 'end-cap' | 'open' };
              commit({ ...spec, end }, 'Duct run end');
            }}>
            <option value="end-cap" disabled={splitBranches > 0 || spigotBranches > 0}>End cap</option>
            <option value="open" disabled={splitBranches > 0 || spigotBranches > 0}>Open</option>
            {isRoundLeg(spec.legs[spec.legs.length - 1]) ? (
              <option value="wye" disabled={spigotBranches > 0}>Wye (SMACNA Fig. 3-5)</option>
            ) : (
              <>
                <option value="y" disabled={spigotBranches > 0}>Y split</option>
                <option value="bullhead" disabled={spigotBranches > 0}>Bullhead tee</option>
              </>
            )}
            <option value="plenum" disabled={splitBranches > 0}>Plenum</option>
            {spec.end.kind === 'terminal' ? <option value="terminal" disabled>Air terminal</option> : null}
          </select>
        )}
      </Row>
      {spec.end.kind === 'plenum' ? (
        <Row label="Plenum W × H × L">
          {(['widthMm', 'heightMm', 'lengthMm'] as const).map((key) => (
            <CommitNumber key={key} label={`Plenum ${key.replace('Mm', '')}`} value={(spec.end as { widthMm: number; heightMm: number; lengthMm: number })[key]} step={50} min={100} max={5000}
              onCommit={(value) => commit({ ...spec, end: { ...(spec.end as { kind: 'plenum'; widthMm: number; heightMm: number; lengthMm: number }), [key]: value } }, 'Duct plenum size')} />
          ))}
        </Row>
      ) : null}
      <Row label="Pieces">{pieceSummary}</Row>
      <Row label="Joints">{plan.joints.length}</Row>
      <Row label="Sheet metal">{plan.totals.sheetAreaM2.toFixed(2)} m² · {plan.totals.massKg.toFixed(1)} kg</Row>
      {plan.issues.length > 0 ? (
        <ul className="space-y-0.5 pt-1" data-testid="duct-run-issues">
          {plan.issues.map((issue, index) => (
            <li key={index} className={`text-xs ${issue.severity === 'error' ? 'text-red-700' : issue.severity === 'warning' ? 'text-amber-700' : 'text-slate-500'}`}>
              {issue.code}: {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      <details className="pt-1">
        <summary className="cursor-pointer text-xs text-slate-600">Run BOM</summary>
        <BomTable rows={bom} />
        <div className="pt-1"><CopyButton text={ductBomToCsv(bom)} label="Copy CSV" /></div>
      </details>
      {plan.practiceRules.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs text-slate-600">Project-practice values used ({plan.practiceRules.length})</summary>
          <ul className="list-disc pl-4 text-[11px] text-slate-600">{plan.practiceRules.map((rule) => <li key={rule}>{rule}</li>)}</ul>
        </details>
      ) : null}
      {plan.unverifiedRules.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs text-amber-700">Unverified rules used ({plan.unverifiedRules.length})</summary>
          <ul className="list-disc pl-4 text-[11px] text-amber-800">{plan.unverifiedRules.map((rule) => <li key={rule}>{rule}</li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}

export function DuctToolSection() {
  const tool = useDuctToolStore();
  return (
    <div className="space-y-2 text-sm" data-testid="duct-tool-section">
      <p className="text-xs text-slate-500">
        Click a ducted unit&apos;s supply or return collar — or the side of a duct run for a take-off, a run&apos;s end for a split, or a run&apos;s open end to continue it — then click to add bends.
        Empty space starts a free run; finishing it on a run&apos;s side makes it a take-off. An orphaned open start re-attaches with one click.
        Double-click or Enter finishes; Backspace removes a leg; Esc cancels. A size change while drawing applies to the next leg (a transition is added).
        A new Level (or [ / ]) makes the next leg rise or drop where it starts; it then goes straight on (risers bend the easy way).
      </p>
      {tool.anchorLevelMm !== null ? (
        <Row label="Level (clear bottom)">
          <CommitNumber label="Next leg level" value={tool.levelMm ?? tool.anchorLevelMm} step={50} min={0} max={30000}
            onCommit={(levelMm) => tool.setLevel(levelMm)} />
          <span className="ml-0.5 text-[10px] text-slate-400">
            mm{tool.levelMm !== null && Math.abs(tool.levelMm - tool.anchorLevelMm) > 0.5
              ? ` · ${tool.levelMm > tool.anchorLevelMm ? '▲' : '▼'} ${Math.abs(tool.levelMm - tool.anchorLevelMm)} from ${tool.anchorLevelMm}`
              : ' · [ / ] ±50'}
          </span>
        </Row>
      ) : null}
      <Row label="Angles">
        <select value={tool.angleMode} onChange={(event) => tool.setAngleMode(event.target.value as '90' | '45')} className="rounded border border-slate-200 px-1 py-0.5 text-xs" aria-label="Angles">
          <option value="90">90° only</option>
          <option value="45">90° and 45° (Tab)</option>
        </select>
      </Row>
      <Row label="Size">
        <select value={tool.sizeMode} onChange={(event) => tool.setSize({ sizeMode: event.target.value as 'collar' | 'custom' })} className="rounded border border-slate-200 px-1 py-0.5 text-xs" aria-label="Size">
          <option value="collar">Match collar</option>
          <option value="custom">Custom W × H (transition from the collar)</option>
        </select>
      </Row>
      {tool.sizeMode === 'custom' ? (
        <Row label="W × H (clear)">
          <input type="number" step={50} value={tool.widthMm} onChange={(event) => tool.setSize({ widthMm: Number(event.target.value) })} className="w-16 rounded border border-slate-200 px-1 text-xs" aria-label="Duct width" />
          {' × '}
          <input type="number" step={50} value={tool.heightMm} onChange={(event) => tool.setSize({ heightMm: Number(event.target.value) })} className="w-16 rounded border border-slate-200 px-1 text-xs" aria-label="Duct height" />
        </Row>
      ) : null}
      <Row label="Branch shape">
        <select value={tool.branchShape} onChange={(event) => tool.setBranchOptions({ branchShape: event.target.value as 'rect' | 'round' })} className="rounded border border-slate-200 px-1 py-0.5 text-xs" aria-label="Branch shape">
          <option value="rect">Rectangular</option>
          <option value="round">Round (spin-in / conical)</option>
        </select>
      </Row>
      {tool.branchShape === 'round' ? (
        <>
          <Row label="Branch Ø">
            <CommitNumber label="Branch diameter" value={tool.branchDiameterMm} step={25} min={100} max={1000} onCommit={(branchDiameterMm) => tool.setBranchOptions({ branchDiameterMm })} />
            <span className="ml-0.5 text-[10px] text-slate-400">mm</span>
          </Row>
          <Row label="Round collar">
            <select value={tool.roundTapStyle} onChange={(event) => tool.setBranchOptions({ roundTapStyle: event.target.value as 'spin-in' | 'conical' })} className="rounded border border-slate-200 px-1 py-0.5 text-xs" aria-label="Round collar">
              <option value="spin-in">Spin-in with bead</option>
              <option value="conical">Conical (D1 ≥ D2)</option>
            </select>
          </Row>
        </>
      ) : null}
      <Row label="Off a round main">
        <select value={tool.roundMainTapStyle} onChange={(event) => tool.setBranchOptions({ roundMainTapStyle: event.target.value as 'round-conical' | 'round-tee' | 'round-lateral' })} className="rounded border border-slate-200 px-1 py-0.5 text-xs" aria-label="Round main take-off">
          <option value="round-conical">Conical tap (Fig. 3-5)</option>
          <option value="round-tee">90° tap (Fig. 3-4)</option>
          <option value="round-lateral">45° lateral (Fig. 3-4)</option>
        </select>
      </Row>
      <Row label="Branch W × H (clear)">
        <input type="number" step={50} value={tool.branchWidthMm} onChange={(event) => tool.setBranchSize({ branchWidthMm: Number(event.target.value) })} className="w-16 rounded border border-slate-200 px-1 text-xs" aria-label="Branch width" />
        {' × '}
        <input type="number" step={50} value={tool.branchHeightMm} onChange={(event) => tool.setBranchSize({ branchHeightMm: Number(event.target.value) })} className="w-16 rounded border border-slate-200 px-1 text-xs" aria-label="Branch height" />
      </Row>
      <Row label="Take-off">
        <select value={tool.tapStyle} onChange={(event) => tool.setBranchOptions({ tapStyle: event.target.value as 'shoe-45' | 'straight' })} className="rounded border border-slate-200 px-1 py-0.5 text-xs" aria-label="Take-off style">
          <option value="shoe-45">Shoe, 45° lead-in</option>
          <option value="straight">Straight collar</option>
        </select>
        <SourceBadge settingKey="tapCollarMm" />
      </Row>
      <Row label="Split">
        <select value={tool.splitStyle} onChange={(event) => tool.setBranchOptions({ splitStyle: event.target.value as 'y' | 'bullhead' })} className="rounded border border-slate-200 px-1 py-0.5 text-xs" aria-label="Split style">
          <option value="y">Y (divided flow, radius elbows)</option>
          <option value="bullhead">Bullhead tee with vanes</option>
        </select>
        <span className="ml-1 text-[10px] text-slate-400">a round main splits by a wye</span>
      </Row>
      <Row label="Damper at branch">
        <input type="checkbox" checked={tool.vcd} onChange={(event) => tool.setBranchOptions({ vcd: event.target.checked })} aria-label="Volume control damper" />
        <SourceBadge settingKey="vcdLengthMm" />
      </Row>
      <Row label="Free start">
        <select value={tool.freeService} onChange={(event) => tool.setBranchOptions({ freeService: event.target.value as 'supply' | 'return' })} className="rounded border border-slate-200 px-1 py-0.5 text-xs" aria-label="Free start service">
          <option value="supply">Supply</option>
          <option value="return">Return</option>
        </select>
        {' at '}
        <CommitNumber label="Free start level" value={tool.freeBottomMm} step={50} min={0} max={20000} onCommit={(freeBottomMm) => tool.setBranchOptions({ freeBottomMm })} />
        <span className="ml-0.5 text-[10px] text-slate-400">mm clear bottom</span>
      </Row>
      <Row label="Run end">
        <select value={tool.endKind} onChange={(event) => tool.setEndKind(event.target.value as 'end-cap' | 'open' | 'plenum')} className="rounded border border-slate-200 px-1 py-0.5 text-xs" aria-label="Run end">
          <option value="end-cap">End cap</option>
          <option value="open">Open</option>
          <option value="plenum">Plenum (spigots)</option>
        </select>
      </Row>
      <Row label="Terminal connection" title="Click a diffuser or grille spigot while drawing to finish the run on it">
        <select value={tool.terminalFlex ? 'flex' : 'rigid'} onChange={(event) => tool.setBranchOptions({ terminalFlex: event.target.value === 'flex' })} className="rounded border border-slate-200 px-1 py-0.5 text-xs" aria-label="Terminal connection">
          <option value="flex">Flexible runout</option>
          <option value="rigid">Rigid duct</option>
        </select>
        <SourceBadge settingKey="flexMaxLengthMm" />
      </Row>
      {tool.endKind === 'plenum' ? (
        <Row label="Plenum W × H × L" title="Blank = sized from the run's last section: 200 mm wider, tall enough for the branch spigot, 500 long (practice)">
          {(['widthMm', 'heightMm', 'lengthMm'] as const).map((key) => (
            <input key={key} type="number" step={50} placeholder="auto" aria-label={`Tool plenum ${key.replace('Mm', '')}`}
              value={tool.plenumSize?.[key] ?? ''}
              onChange={(event) => {
                const value = Number(event.target.value);
                const current = tool.plenumSize ?? { widthMm: 800, heightMm: 350, lengthMm: 500 };
                tool.setPlenumSize(event.target.value === '' ? null : { ...current, [key]: Math.max(100, value) });
              }}
              className="w-14 rounded border border-slate-200 px-1 text-xs" />
          ))}
        </Row>
      ) : null}
    </div>
  );
}

export function DuctSystemsSection() {
  const { hvacElements, ductSettings, setDuctSettings } = useSmartDrawingStore((state) => ({
    hvacElements: state.hvacElements, ductSettings: state.ductSettings, setDuctSettings: state.setDuctSettings,
  }), shallow);
  const plans = usePlans();
  const bom = useMemo(() => buildDuctBom(
    plans,
    plans.map((plan) => getDuctSupportPlan(plan, hvacElements, ductSettings)),
    hvacElements.filter(isDuctTerminalElement),
  ), [plans, hvacElements, ductSettings]);
  const schedule = useMemo(() => buildDuctFabricationSchedule(plans), [plans]);
  const [stockDraft, setStockDraft] = useState<string | null>(null);
  const pressureWarning = (value: number) => (DUCT_SUPPORTED_PRESSURE_CLASSES_PA.some((pa) => value <= pa) ? null
    : <span className="ml-1 text-[10px] text-red-600">unsupported (&gt;500 Pa)</span>);
  return (
    <div className="space-y-2 text-sm" data-testid="duct-systems-section">
      <Row label="Gauge rule">
        <select value={ductSettings.gaugeMode} onChange={(event) => setDuctSettings({ gaugeMode: event.target.value as DuctDesignSettings['gaugeMode'] })} className="rounded border border-slate-200 px-1 py-0.5 text-xs">
          <option value="smacna">SMACNA 1995 tables</option>
          <option value="longest-side">Longest-side table</option>
        </select>
        <SourceBadge settingKey="gaugeMode" />
      </Row>
      {(['supplyPressureClassPa', 'returnPressureClassPa'] as const).map((key) => (
        <Row key={key} label={key === 'supplyPressureClassPa' ? 'Supply pressure' : 'Return pressure'}>
          <select value={ductSettings[key]} onChange={(event) => setDuctSettings({ [key]: Number(event.target.value) })} className="rounded border border-slate-200 px-1 py-0.5 text-xs">
            {[125, 250, 500, 750, 1000].map((pa) => <option key={pa} value={pa}>{pa} Pa{pa > 500 ? ' (unsupported)' : ''}</option>)}
          </select>
          {pressureWarning(ductSettings[key])}
        </Row>
      ))}
      <Row label="Section length">
        <select value={ductSettings.sectionLengthMm} onChange={(event) => setDuctSettings({ sectionLengthMm: Number(event.target.value) })} className="rounded border border-slate-200 px-1 py-0.5 text-xs">
          <option value={1200}>1200 mm</option>
          <option value={1500}>1500 mm</option>
        </select>
      </Row>
      <Row label="Sheet stock (mm)">
        <input
          type="text"
          value={stockDraft ?? ductSettings.availableSheetThicknessesMm.join(', ')}
          onChange={(event) => setStockDraft(event.target.value)}
          onBlur={() => {
            if (stockDraft !== null) {
              const values = stockDraft.split(/[,\s]+/).map((value) => Number.parseFloat(value)).filter((value) => Number.isFinite(value));
              if (values.length > 0) setDuctSettings({ availableSheetThicknessesMm: values });
            }
            setStockDraft(null);
          }}
          className="w-40 rounded border border-slate-200 px-1 text-xs"
          aria-label="Available sheet thicknesses"
        />
        <SourceBadge settingKey="availableSheetThicknessesMm" />
      </Row>
      <Row label="Joint system">
        <select value={ductSettings.jointSystem} onChange={(event) => setDuctSettings({ jointSystem: event.target.value as DuctJointSystem })} className="rounded border border-slate-200 px-1 py-0.5 text-xs">
          {JOINT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <SourceBadge settingKey="jointSystem" />
      </Row>
      <Row label="Elbows">
        <select value={ductSettings.elbowStyle} onChange={(event) => setDuctSettings({ elbowStyle: event.target.value as DuctDesignSettings['elbowStyle'] })} className="rounded border border-slate-200 px-1 py-0.5 text-xs">
          <option value="auto">Auto (radius, vaned if tight)</option>
          <option value="radius">Radius</option>
          <option value="square-vaned">Square with vanes</option>
        </select>
        <SourceBadge settingKey="elbowStyle" />
      </Row>
      <SettingNumber settingKey="elbowCentrelineRatio" label="Radius elbow R/W" step={0.25} min={0.25} max={3} unit="" />
      <SettingNumber settingKey="elbowNeckMm" label="Elbow neck" step={10} min={0} max={300} />
      <Row label="Turning vanes">
        <select value={ductSettings.vaneType} aria-label="Turning vanes" className="rounded border border-slate-200 px-1 py-0.5 text-xs"
          onChange={(event) => setDuctSettings({ vaneType: event.target.value as DuctDesignSettings['vaneType'] })}>
          <option value="auto">Auto (lightest that spans the height)</option>
          {Object.values(DUCT_VANES).map((vane) => <option key={vane.type} value={vane.type}>{vane.label}</option>)}
        </select>
        <SourceBadge settingKey="vaneType" />
      </Row>
      <Row label="Round seam">
        <select value={ductSettings.roundSeam} aria-label="Round seam" className="rounded border border-slate-200 px-1 py-0.5 text-xs"
          onChange={(event) => setDuctSettings({ roundSeam: event.target.value as DuctDesignSettings['roundSeam'] })}>
          <option value="spiral">Spiral (RL-1, RT-1 sleeves)</option>
          <option value="longitudinal">Longitudinal (RT-5 crimp)</option>
        </select>
        <SourceBadge settingKey="roundSeam" />
      </Row>
      <Row label="Round elbow velocity">
        <select value={ductSettings.roundVelocityBand} aria-label="Round elbow velocity" className="rounded border border-slate-200 px-1 py-0.5 text-xs"
          onChange={(event) => setDuctSettings({ roundVelocityBand: event.target.value as DuctDesignSettings['roundVelocityBand'] })}>
          <option value="low">≤ 5.1 m/s: R/D 0.6, 3 pieces</option>
          <option value="medium">5.1–7.6 m/s: R/D 1.0, 4 pieces</option>
          <option value="high">&gt; 7.6 m/s: R/D 1.5, 5 pieces</option>
        </select>
        <SourceBadge settingKey="roundVelocityBand" />
      </Row>
      <SettingNumber settingKey="roundSectionLengthMm" label="Spiral section length" step={100} min={600} max={6000} />
      <SettingNumber settingKey="conicalFlareMm" label="Conical flare" step={10} min={0} max={300} />
      <Row label="Longitudinal seam">
        <select value={ductSettings.longitudinalSeam} aria-label="Longitudinal seam" className="rounded border border-slate-200 px-1 py-0.5 text-xs"
          onChange={(event) => setDuctSettings({ longitudinalSeam: event.target.value as DuctDesignSettings['longitudinalSeam'] })}>
          <option value="pittsburgh">Pittsburgh lock (L-1)</option>
          <option value="snaplock">Button-punch snaplock (L-2)</option>
        </select>
        <SourceBadge settingKey="longitudinalSeam" />
      </Row>
      <SettingNumber settingKey="coilWidthMm" label="Coil width" step={50} min={600} max={2000} />
      <SettingNumber settingKey="minMakeUpPieceMm" label="Shortest make-up piece" step={10} min={50} max={1000} />
      <SettingNumber settingKey="washersPerBolt" label="Washers per bolt" step={1} min={0} max={4} unit="" />
      <SettingNumber settingKey="transitionTaperDeg" label="Transition design taper" step={1} min={5} max={30} unit="° / side" />
      <div className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Auto duct sizing</div>
      <SettingNumber settingKey="autoFrictionSupplyPaPerM" label="Friction rate, supply" step={0.1} min={0.2} max={3} unit="Pa/m" />
      <SettingNumber settingKey="autoFrictionReturnPaPerM" label="Friction rate, return" step={0.1} min={0.2} max={3} unit="Pa/m" />
      <SettingNumber settingKey="autoMaxVelocityTrunkMs" label="Max velocity, trunk" step={0.5} min={1} max={12} unit="m/s" />
      <SettingNumber settingKey="autoMaxVelocityBranchMs" label="Max velocity, branch" step={0.5} min={1} max={10} unit="m/s" />
      <SettingNumber settingKey="autoMaxVelocityRunoutMs" label="Max velocity, runout" step={0.5} min={1} max={8} unit="m/s" />
      <SettingNumber settingKey="autoMaxNeckVelocitySupplyMs" label="Max neck velocity, diffuser" step={0.5} min={1} max={8} unit="m/s" />
      <SettingNumber settingKey="autoMaxNeckVelocityReturnMs" label="Max neck velocity, grille" step={0.5} min={1} max={8} unit="m/s" />
      <SettingNumber settingKey="autoDiffuserDropPa" label="Supply terminal pressure drop" step={1} min={0} max={150} unit="Pa" />
      <SettingNumber settingKey="autoGrilleDropPa" label="Return terminal pressure drop" step={1} min={0} max={150} unit="Pa" />
      <SettingNumber settingKey="filterG4RatedDropPa" label="G4 filter, clean drop" step={1} min={0} max={500} unit="Pa" />
      <SettingNumber settingKey="filterM5RatedDropPa" label="M5 filter, clean drop" step={1} min={0} max={500} unit="Pa" />
      <SettingNumber settingKey="filterRatedVelocityMs" label="… at face velocity" step={0.1} min={0.5} max={5} unit="m/s" />
      <SettingNumber settingKey="filterDesignFactor" label="Filter mid-life factor" step={0.1} min={1} max={3} unit="×" />
      <SettingNumber settingKey="autoReducerStepMm" label="Reduce the trunk from" step={50} min={0} max={500} />
      <div className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Optimiser</div>
      <SettingNumber settingKey="autoExactTerminals" label="Exact tree search up to" step={1} min={1} max={10} unit="terminals" />
      <SettingNumber settingKey="autoTimeBudgetMs" label="Time per unit" step={1000} min={1000} max={60000} unit="ms" />
      <Row label="Turn terminal spigots">
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={ductSettings.autoChooseSpigotSide} aria-label="Let the optimiser choose the spigot side"
            onChange={(event) => setDuctSettings({ autoChooseSpigotSide: event.target.checked })} />
          Square-box faces, round
        </label>
        <SourceBadge settingKey="autoChooseSpigotSide" />
      </Row>
      <Row label="Round-main fittings">
        <span className="flex flex-col items-end gap-0.5">
          {([['round-conical', 'Conical tap (Fig. 3-5)'], ['round-tee', '90° tap (Fig. 3-4)'], ['round-lateral', '45° lateral (Fig. 3-4)']] as const).map(([style, label]) => (
            <label key={style} className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={ductSettings.autoRoundMainStyles.includes(style)} aria-label={`Allow ${label}`}
                onChange={(event) => setDuctSettings({
                  autoRoundMainStyles: event.target.checked
                    ? [...new Set([...ductSettings.autoRoundMainStyles, style])]
                    : ductSettings.autoRoundMainStyles.filter((entry) => entry !== style),
                })} />
              {label}
            </label>
          ))}
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={ductSettings.autoAllowWye} aria-label="Allow wye splits" onChange={(event) => setDuctSettings({ autoAllowWye: event.target.checked })} />
            Wye split (Fig. 3-5)
          </label>
        </span>
        <SourceBadge settingKey="autoRoundMainStyles" />
      </Row>
      <div className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Economics ({ductSettings.econCurrency})</div>
      <Row label="Currency">
        <input type="text" maxLength={3} defaultValue={ductSettings.econCurrency} aria-label="Economics currency"
          onBlur={(event) => { const code = event.target.value.trim().toUpperCase(); if (/^[A-Z]{3}$/.test(code)) setDuctSettings({ econCurrency: code }); else event.target.value = ductSettings.econCurrency; }}
          className="w-14 rounded border border-slate-200 px-1 text-xs uppercase" />
        <SourceBadge settingKey="econCurrency" />
      </Row>
      <SettingNumber settingKey="econSheetPerKg" label="Galvanised sheet" step={0.1} min={0} max={10000} unit="/ kg" />
      <SettingNumber settingKey="econFabricationRectPerM2" label="Fabrication, rectangular" step={0.5} min={0} max={100000} unit="/ m²" />
      <SettingNumber settingKey="econFabricationSpiralPerM2" label="Fabrication, spiral round" step={0.5} min={0} max={100000} unit="/ m²" />
      <SettingNumber settingKey="econFittingFactor" label="Fittings, × a straight" step={0.1} min={1} max={10} unit="×" />
      <SettingNumber settingKey="econInstallPerM2" label="Installation" step={0.5} min={0} max={100000} unit="/ m²" />
      <SettingNumber settingKey="econInsulationPerM2" label="NBR insulation" step={0.5} min={0} max={100000} unit="/ m²" />
      <SettingNumber settingKey="econFlexPerM" label="Flexible duct, Ø200" step={0.5} min={0} max={100000} unit="/ m" />
      <SettingNumber settingKey="econDamperEach" label="Damper, Ø200" step={1} min={0} max={1000000} unit="each" />
      <SettingNumber settingKey="econHangerEach" label="Hanger" step={1} min={0} max={1000000} unit="each" />
      <SettingNumber settingKey="econJointPerM" label="Joint" step={0.5} min={0} max={100000} unit="/ m of perimeter" />
      <SettingNumber settingKey="econElectricityPerKWh" label="Electricity" step={0.01} min={0} max={1000} unit="/ kWh" />
      <SettingNumber settingKey="econHoursPerYear" label="Fan hours" step={100} min={0} max={8760} unit="h / year" />
      <SettingNumber settingKey="econFanEfficiency" label="Fan + motor efficiency" step={0.05} min={0.05} max={0.95} unit="" />
      <SettingNumber settingKey="econLifeYears" label="Life" step={1} min={1} max={60} unit="years" />
      <SettingNumber settingKey="econDiscountPercent" label="Discount rate" step={0.5} min={0} max={50} unit="%" />
      <SettingNumber settingKey="econEscalationPercent" label="Energy price rise" step={0.5} min={-10} max={50} unit="% / year" />
      <SettingNumber settingKey="transitionMaxDivergingIncludedDeg" label="Max diverging (concentric)" step={1} min={10} max={45} unit="° incl." />
      <SettingNumber settingKey="transitionMaxConvergingIncludedDeg" label="Max converging (concentric)" step={1} min={10} max={60} unit="° incl." />
      <SettingNumber settingKey="transitionMaxEccentricDeg" label="Max eccentric (flat bottom)" step={1} min={5} max={30} unit="°" />
      <SettingNumber settingKey="aspectRatioAdvisory" label="Aspect-ratio advisory" step={0.5} min={2} max={10} unit=": 1" />
      <SettingNumber settingKey="tapCollarMm" label="Take-off collar" step={10} min={50} max={400} />
      <SettingNumber settingKey="vcdLengthMm" label="Damper section" step={10} min={50} max={600} />
      <SettingNumber settingKey="tapWindowMarginMm" label="Take-off window margin" step={10} min={0} max={300} />
      <Row label="Flexible connector at unit">
        <input type="checkbox" checked={ductSettings.flexibleConnectorAtUnit} onChange={(event) => setDuctSettings({ flexibleConnectorAtUnit: event.target.checked })} />
        <SourceBadge settingKey="flexibleConnectorAtUnit" />
      </Row>
      <SettingNumber settingKey="connectorFabricMm" label="Connector fabric" step={1} min={76} max={254} />
      <SettingNumber settingKey="connectorMetalMm" label="Connector metal edge" step={1} min={76} max={200} />
      <div className="pt-1 text-xs font-medium text-slate-700">Insulation (NBR)</div>
      <Row label="New runs">
        <select value={ductSettings.defaultConstruction} aria-label="New run construction" className="rounded border border-slate-200 px-1 py-0.5 text-xs"
          onChange={(event) => setDuctSettings({ defaultConstruction: event.target.value as 'gi-bare' | 'gi-nbr' })}>
          <option value="gi-bare">GI, bare</option>
          <option value="gi-nbr">GI + NBR</option>
        </select>
        <SourceBadge settingKey="defaultConstruction" />
      </Row>
      <SettingNumber settingKey="nbrSupplyThicknessMm" label="NBR on supply" step={1} min={6} max={50} />
      <SettingNumber settingKey="nbrReturnThicknessMm" label="NBR on return" step={1} min={6} max={50} />
      <SettingNumber settingKey="nbrAdhesiveM2PerL" label="Adhesive coverage" step={0.5} min={7} max={9} unit="m²/L" />
      <SettingNumber settingKey="nbrWastePercent" label="Insulation waste" step={1} min={0} max={50} unit="%" />
      <div className="pt-1 text-xs font-medium text-slate-700">Supports (SMACNA chapter 4)</div>
      <SettingNumber settingKey="hangerSpacingMm" label="Hanger spacing" step={100} min={600} max={3050} />
      <Row label="Soffit (rods hang from)">
        <CommitNumber label="Soffit level" value={resolveSoffitZ(ductSettings)} step={50} min={500} max={30000}
          onCommit={(soffitMm) => setDuctSettings({ soffitMm })} />
        <span className="ml-0.5 text-[10px] text-slate-400">mm{ductSettings.soffitMm === null ? ' · routing ceiling' : ''}</span>
        {ductSettings.soffitMm !== null ? (
          <button type="button" className="ml-1 text-[10px] text-slate-500 underline" onClick={() => setDuctSettings({ soffitMm: null })}>use routing ceiling</button>
        ) : null}
        <SourceBadge settingKey="soffitMm" />
      </Row>
      <Row label="Smallest rod">
        <select value={ductSettings.minimumRod} aria-label="Smallest rod" className="rounded border border-slate-200 px-1 py-0.5 text-xs"
          onChange={(event) => setDuctSettings({ minimumRod: event.target.value as DuctDesignSettings['minimumRod'] })}>
          {(['M8', 'M10', 'M12', 'M16'] as const).map((rod) => <option key={rod} value={rod}>{rod}</option>)}
        </select>
        <SourceBadge settingKey="minimumRod" />
      </Row>
      <SettingNumber settingKey="hangerRodOffsetMm" label="Rod offset from duct side" step={5} min={15} max={152} />
      <SettingNumber settingKey="trapezeOverhangMm" label="Trapeze beyond rod" step={5} min={15} max={200} />
      <SettingNumber settingKey="hangerJointClearanceMm" label="Hanger clear of joints" step={10} min={0} max={400} />
      <SettingNumber settingKey="hangerFromUnitMm" label="First hanger past connector" step={10} min={50} max={610} />
      <SettingNumber settingKey="riserSupportIntervalMm" label="Riser support interval" step={10} min={3660} max={7320} />
      <Row label="Show">
        <label className="mr-2 text-xs"><input type="checkbox" checked={ductSettings.showSizeTags} onChange={(event) => setDuctSettings({ showSizeTags: event.target.checked })} /> tags</label>
        <label className="mr-2 text-xs"><input type="checkbox" checked={ductSettings.showJointTicks} onChange={(event) => setDuctSettings({ showJointTicks: event.target.checked })} /> joints</label>
        <label className="mr-2 text-xs"><input type="checkbox" checked={ductSettings.showPieceMarks} onChange={(event) => setDuctSettings({ showPieceMarks: event.target.checked })} /> marks</label>
        <label className="text-xs"><input type="checkbox" checked={ductSettings.showSupports} onChange={(event) => setDuctSettings({ showSupports: event.target.checked })} /> supports</label>
      </Row>
      <details open>
        <summary className="cursor-pointer text-xs font-medium text-slate-700">Project duct BOM ({plans.length} run{plans.length === 1 ? '' : 's'})</summary>
        <BomTable rows={bom} />
        <div className="flex flex-wrap gap-2 pt-1">
          <CopyButton text={ductBomToCsv(bom)} label="Copy BOM CSV" />
          <CopyButton text={ductScheduleToCsv(schedule)} label="Copy schedule CSV" />
        </div>
      </details>
    </div>
  );
}
