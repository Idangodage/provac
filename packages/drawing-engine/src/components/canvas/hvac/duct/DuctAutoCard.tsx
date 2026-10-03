'use client';

/**
 * Auto duct card: shown when the selection holds one ducted unit (with the
 * diffusers and grilles it serves). Generate routes the candidate trees, sizes
 * each exactly (first cost against fan pressure) and verifies the best in the
 * planner, off the main thread; the card then shows the cost–pressure frontier
 * of the verified designs with three picks — least first cost, least
 * life-cycle cost (shown on the canvas), least pressure — their costs, and the
 * design summary. Apply adds the design shown as one undo step.
 *
 * Sizing: the life-cycle optimum, or constant friction at a main velocity ⇄
 * friction rate the designer sets (with the velocity limits and each
 * terminal's airflow). Changed after Generate, the preview re-sizes live; on
 * ducts already applied, each change re-sizes them on the drawing (one undo).
 */
import { Circle, Coins, Fan, Gauge, LayoutGrid, Loader2, Ruler, ShieldCheck, Sparkles, Square, Star, Wand2, Wind, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { shallow } from 'zustand/shallow';

import { useSmartDrawingStore } from '../../../../store';

import { DuctFrontierChart } from './DuctFrontierChart';
import {
  AppliedSystemSizing,
  BasisEditor,
  ServiceTabs,
  SizingMethodSwitch,
  SizingTable,
  TerminalAirflowList,
  type SizingMethod,
  type TerminalAirflows,
} from './DuctSizingSection';
import {
  applyAutoDuctPreview,
  autoDuctSelection,
  cancelAutoDuctPreview,
  discardAutoDuctPreview,
  generateAutoDuctPreview,
  resizeAutoDuctPreview,
} from './ductAutoController';
import { AUTO_DUCT_LAYOUT_LABELS, type AutoDuctLayoutChoice, type AutoDuctRequest, type AutoDuctResult, type AutoDuctShape, type AutoDuctSizingBases } from './ductAutoLayout';
import { isAutoDuctPreviewCurrent, useDuctAutoPreviewStore } from './ductAutoPreviewStore';
import { sameAutoDuctInputs } from './ductAutoWorkflow';
import { formatCost, type DuctCostBreakdown } from './ductEconomics';
import { parseDuctNumber } from './ductNumericValue';
import { FAN_SPEED_LABELS, FAN_SPEEDS, neckVelocityMs, readUnitAirData, shareAirflow, type FanSpeed } from './ductSizing';
import { basisAirflowM3h, defaultSizingBasis, linkSizingBasis } from './ductSystemSizing';
import { readDuctTerminalSpec } from './ductTerminals';
import { isDuctElement, readDuctRunSpec, type DuctService, type DuctSystemSizing } from './ductTypes';

const select = 'rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-xs';

function Line({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5 text-xs">
      <span className="flex items-center gap-1 text-slate-500">{icon}{label}</span>
      <span className="flex items-center gap-1 text-right text-slate-800">{children}</span>
    </div>
  );
}

const SOURCE_LABEL: Record<NonNullable<AutoDuctResult['airflowSource']>, string> = {
  entered: 'entered',
  unit: "unit's Airflow field",
  manufacturer: 'manufacturer data',
};

export const AUTO_DUCT_SHAPE_OPTIONS: Array<{ key: AutoDuctShape; label: string; icon: ReactNode; hint: string }> = [
  { key: 'rect', label: 'Rect', icon: <Square size={12} />, hint: 'Rectangular trunks; round branches off spin-in or conical collars (SMACNA Fig. 2-6)' },
  { key: 'round', label: 'Round', icon: <Circle size={12} />, hint: 'Spiral round trunks after a square-to-round at the collar; conical taps, 90° taps, 45° laterals, wyes (Fig. 3-4 / 3-5)' },
  { key: 'optimal', label: 'Optimal', icon: <Sparkles size={12} />, hint: 'The optimiser chooses the shape of each stretch, with standard transitions where it changes' },
];

const COST_ROWS: Array<[keyof DuctCostBreakdown, string]> = [
  ['sheet', 'Galvanised sheet'], ['fabrication', 'Fabrication, straights'], ['fittings', 'Fabrication, fittings'],
  ['install', 'Installation'], ['insulation', 'Insulation'], ['flex', 'Flexible runouts'], ['dampers', 'Dampers'],
  ['joints', 'Joints'], ['hangers', 'Hangers and straps'],
];

function sectionText(section: { widthMm: number; heightMm: number; diameterMm?: number }): string {
  return section.diameterMm !== undefined ? `Ø${Math.round(section.diameterMm)}` : `${Math.round(section.widthMm)}×${Math.round(section.heightMm)}`;
}

function Designs({ result }: { result: AutoDuctResult }) {
  const selectDesign = useDuctAutoPreviewStore((state) => state.selectDesign);
  const design = result.designs[result.selected];
  if (!design || !result.picks) return null;
  const { picks, currency } = result;
  const reference = result.designs.find((candidate) => candidate.label.includes('(equal friction)'));
  const certificate = result.certificate;
  const pickButtons: Array<{ index: number; label: string; icon: ReactNode }> = [
    { index: picks.cheapest, label: 'Least first cost', icon: <Coins size={12} /> },
    { index: picks.lifeCycle, label: 'Best life-cycle', icon: <Star size={12} /> },
    { index: picks.quietest, label: 'Least pressure', icon: <Gauge size={12} /> },
  ];
  const saving = reference && reference !== design ? reference.lifeCycleCost - design.lifeCycleCost : 0;
  return (
    <div className="space-y-1.5 border-t border-sky-100 pt-1.5" data-testid="duct-auto-designs">
      {certificate ? (
        <div className="flex items-center gap-1 text-[10px] text-slate-600" title="Exact: every tree came from the exact tree router within its terminal limit, and every size set is the catalogue optimum for its tree.">
          <ShieldCheck size={12} className={certificate.exact ? 'text-emerald-600' : 'text-slate-400'} />
          <span className="font-medium">{result.sizing ? 'Optimised routes · sized by constant friction'
            : certificate.exact ? 'Optimal on the model'
              : certificate.grouped ? 'Grouped search (exact within groups)'
                : certificate.timeLimited ? 'Best found in the time allowed' : 'Best of the candidates'}</span>
          <span>· {result.designs.length} verified · {certificate.trees} trees sized · {(certificate.solveMs / 1000).toFixed(1)} s</span>
        </div>
      ) : null}
      <DuctFrontierChart designs={result.designs} picks={picks} selected={result.selected} maxEspPa={result.maxEspPa}
        pricePerPa={result.pricePerPa} currency={currency} onSelect={selectDesign} />
      <div className="grid grid-cols-3 gap-1" role="group" aria-label="Design picks">
        {pickButtons.map((pick) => {
          const candidate = result.designs[pick.index]!;
          const active = result.selected === pick.index;
          return (
            <button key={pick.label} type="button" onClick={() => selectDesign(pick.index)} aria-pressed={active}
              className={`rounded-md border px-1 py-1 text-left transition-colors ${active ? 'border-teal-600 bg-teal-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
              <span className={`flex items-center gap-1 text-[10px] font-medium ${active ? 'text-teal-800' : 'text-slate-600'}`}>{pick.icon}{pick.label}</span>
              <span className="block text-[11px] font-semibold text-slate-800">{formatCost(candidate.firstCost, currency)}</span>
              <span className="block text-[10px] text-slate-500">{candidate.requiredEspPa.toFixed(1)} Pa</span>
            </button>
          );
        })}
      </div>
      <div className="rounded-md bg-white/80 p-1.5">
        <Line label="First cost">{formatCost(design.firstCost, currency)}</Line>
        <Line label="Fan energy (present worth)">
          {formatCost(design.energyCost, currency)}
          <span className="text-[10px] text-slate-400" title="Each pascal of external static pressure, over the operating hours and life, at the tariff (Economics settings)">
            ({result.pricePerPa.toFixed(2)} / Pa)
          </span>
        </Line>
        <Line label="Life-cycle cost"><span className="font-semibold">{formatCost(design.lifeCycleCost, currency)}</span></Line>
        {saving > 0.5 ? (
          <p className="text-[10px] text-emerald-700">
            {formatCost(saving, currency)} ({Math.round((saving / reference!.lifeCycleCost) * 100)} %) less over the life than equal-friction sizing of the usual layout.
          </p>
        ) : null}
        <details className="pt-0.5 text-[10px] text-slate-600">
          <summary className="cursor-pointer text-slate-500">First cost by item</summary>
          <table className="mt-0.5 w-full">
            <tbody>
              {COST_ROWS.filter(([key]) => design.cost[key] > 0.5).map(([key, label]) => (
                <tr key={key}><td>{label}</td><td className="text-right">{formatCost(design.cost[key], currency)}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="pt-0.5 text-slate-400">Rates are placeholders (practice) until the supplier&apos;s prices are entered in Duct Systems → Economics.</p>
        </details>
      </div>
    </div>
  );
}

function Summary({ result }: { result: AutoDuctResult }) {
  const issues = [...result.issues, ...result.services.flatMap((service) => service.issues)];
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  const turned = issues.filter((issue) => issue.code === 'DU_AUTO_SPIGOT');
  const notes = issues.filter((issue) => issue.severity === 'info' && issue.code !== 'DU_AUTO_SPIGOT');
  const esp = result.requiredEspPa;
  return (
    <div className="mt-1 space-y-1 border-t border-sky-100 pt-1" data-testid="duct-auto-summary">
      {result.airflowM3h !== null ? (
        <Line label="Airflow">{Math.round(result.airflowM3h)} m³/h <span className="text-[10px] text-slate-500">({result.airflowSource ? SOURCE_LABEL[result.airflowSource] : ''})</span></Line>
      ) : null}
      {result.services.map((service) => (
        <div key={service.service} className="rounded-md bg-white/70 p-1">
          <div className="text-[11px] font-semibold text-slate-700">
            {service.service === 'supply' ? 'Supply' : 'Return'}: {service.label || (service.layout ? AUTO_DUCT_LAYOUT_LABELS[service.layout] : 'no layout')}
          </div>
          {service.trunkSections.length ? (
            <div className="text-[11px] text-slate-600">
              {service.layout === 'plenum' ? 'Plenum ' : 'Trunk '}
              {service.trunkSections.map(sectionText).join(' → ')}
            </div>
          ) : null}
          {service.sizingReport ? <div className="mt-0.5"><SizingTable report={service.sizingReport} /></div> : null}
          <table className="mt-0.5 w-full text-[10px] text-slate-600">
            <tbody>
              {service.terminals.map((terminal) => (
                <tr key={terminal.terminalId}>
                  <td className="pr-1">{terminal.label}</td>
                  <td className="pr-1 text-right">{terminal.airflowM3h} m³/h</td>
                  <td className="pr-1 text-right">Ø{terminal.branchDiameterMm}</td>
                  <td className="pr-1 text-right">{terminal.neckVelocityMs.toFixed(1)} m/s</td>
                  <td className="text-right" title="Pressure its damper throttles to balance">
                    {service.pressure ? `−${Math.round(service.pressure.throttlePa[terminal.terminalId] ?? 0)} Pa` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {esp !== null ? (
        <Line label="External static pressure">
          <span className={result.maxEspPa !== null && esp > result.maxEspPa ? 'font-semibold text-red-600' : 'text-emerald-700'}>
            {Math.round(esp)} Pa
          </span>
          {result.maxEspPa !== null ? <span className="text-[10px] text-slate-500"> of {result.maxEspPa} Pa max</span> : null}
        </Line>
      ) : null}
      {turned.length ? (
        <ul className="space-y-0.5 text-[10px] text-sky-700" data-testid="duct-auto-spigots">
          {turned.map((issue, index) => <li key={index}>{issue.message}</li>)}
        </ul>
      ) : null}
      {[...errors, ...warnings].length ? (
        <ul className="space-y-0.5 text-[10px]" data-testid="duct-auto-issues">
          {[...errors, ...warnings].map((issue, index) => (
            <li key={index} className={issue.severity === 'error' ? 'text-red-600' : 'text-amber-700'}>
              {issue.code}: {issue.message}
            </li>
          ))}
        </ul>
      ) : <p className="text-[10px] text-emerald-700">No errors or warnings.</p>}
      {notes.length ? (
        <details className="text-[10px] text-slate-500">
          <summary className="cursor-pointer">{notes.length} note{notes.length === 1 ? '' : 's'}</summary>
          <ul>{notes.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}

export function DuctAutoCard() {
  const { hvacElements, selectedElementIds, walls } = useSmartDrawingStore((state) => ({
    hvacElements: state.hvacElements, selectedElementIds: state.selectedElementIds, walls: state.walls,
  }), shallow);
  const preview = useDuctAutoPreviewStore((state) => ({
    result: state.result, scene: state.scene, message: state.message, running: state.running,
    request: state.request, inputs: state.inputs, resizing: state.resizing,
  }), shallow);
  const { result, message, running, request, resizing } = preview;
  const cardRef = useRef<HTMLDivElement>(null);
  const [fanSpeed, setFanSpeed] = useState<FanSpeed>('hi');
  const [airflowDraft, setAirflowDraft] = useState('');
  const [airflowBadInput, setAirflowBadInput] = useState(false);
  const [layout, setLayout] = useState<AutoDuctLayoutChoice>('auto');
  const [shape, setShape] = useState<AutoDuctShape>('optimal');
  const [services, setServices] = useState({ supply: true, return: true });
  const [rebuild, setRebuild] = useState(false);
  const { ductSettings, setDuctSettings } = useSmartDrawingStore((state) => ({ ductSettings: state.ductSettings, setDuctSettings: state.setDuctSettings }), shallow);
  /** Constant-friction bases the designer changed (per service), and terminal airflows typed in the card. */
  const [bases, setBases] = useState<Partial<Record<DuctService, DuctSystemSizing>>>({});
  const [terminalAirflows, setTerminalAirflows] = useState<TerminalAirflows>({});
  const [sizingTab, setSizingTab] = useState<DuctService>('supply');
  const selection = useMemo(() => autoDuctSelection(selectedElementIds, hvacElements, { includeConnected: rebuild }), [selectedElementIds, hvacElements, rebuild]);
  const unitId = selection?.unit.id ?? null;
  useEffect(() => {
    setBases({});
    setTerminalAirflows({});
    setAirflowDraft('');
    setAirflowBadInput(false);
    setRebuild(false);
  }, [unitId]);
  if (!selection) return null;
  const { unit, terminals } = selection;
  const air = readUnitAirData(unit);
  const counts = { supply: 0, return: 0 };
  for (const terminal of terminals) {
    const service = readDuctTerminalSpec(terminal)?.service;
    if (service) counts[service] += 1;
  }
  const occupiedServices = new Set(hvacElements.flatMap((element) => {
    const spec = isDuctElement(element) ? readDuctRunSpec(element) : null;
    return spec?.start.kind === 'unit-port' && spec.start.unitId === unit.id ? [spec.service] : [];
  }));
  const occupied = occupiedServices.size > 0;
  const airflowEntry = parseDuctNumber(airflowDraft, 0.01, 50000, true);
  const airflowError = airflowBadInput ? 'Enter a valid airflow.' : airflowEntry.valid ? null : airflowEntry.message;
  const airflowOverride = airflowEntry.valid ? airflowEntry.value : null;
  const current = result?.unitId === unit.id && isAutoDuctPreviewCurrent(preview, hvacElements, ductSettings, walls) ? result : null;
  // ---- Sizing ----
  const method: SizingMethod = ductSettings.autoSizingMethod;
  const defaultAirflow = basisAirflowM3h(unit, { airflowM3h: null, fanSpeed }).airflowM3h;
  const systemAirflow = airflowError ? null : basisAirflowM3h(unit, { airflowM3h: airflowOverride, fanSpeed }).airflowM3h;
  const sizingServices = (['supply', 'return'] as const).filter((service) => services[service] && counts[service] > 0);
  const tab: DuctService = sizingServices.includes(sizingTab) ? sizingTab : sizingServices[0] ?? 'supply';
  const basisFor = (service: DuctService, from = bases): DuctSystemSizing => linkSizingBasis({
    ...(from[service] ?? defaultSizingBasis(ductSettings, service, null, fanSpeed)), fanSpeed, airflowM3h: airflowOverride,
  }, systemAirflow);
  const allBases = (from = bases): AutoDuctSizingBases => Object.fromEntries(sizingServices.map((service) => [service, basisFor(service, from)]));
  const airflowEntries = Object.keys(terminalAirflows).length ? terminalAirflows : undefined;
  const updateBasis = (service: DuctService, next: DuctSystemSizing) => {
    const nextBases = { ...bases, [service]: next };
    setBases(nextBases);
    if (current && method === 'constant-friction') resizeAutoDuctPreview(allBases(nextBases), airflowEntries);
  };
  const updateAirflow = (id: string, value: number | null) => {
    const next = { ...terminalAirflows, [id]: value };
    setTerminalAirflows(next);
    if (current && method === 'constant-friction') resizeAutoDuctPreview(allBases(), next);
  };
  const changeMethod = (next: SizingMethod) => {
    if (next !== method) setDuctSettings({ autoSizingMethod: next });
  };
  const tabTerminals = terminals.filter((terminal) => readDuctTerminalSpec(terminal)?.service === tab);
  const tabShares = shareAirflow(systemAirflow ?? 0, tabTerminals.map((terminal) => {
    const spec = readDuctTerminalSpec(terminal)!;
    const set = Object.prototype.hasOwnProperty.call(terminalAirflows, terminal.id) ? terminalAirflows[terminal.id] : spec.designAirflowM3h;
    return { id: terminal.id, spec: { designAirflowM3h: set ?? null } };
  }));
  const airflowRows = tabTerminals.map((terminal, index) => {
    const spec = readDuctTerminalSpec(terminal)!;
    const share = tabShares[index]!;
    return {
      id: terminal.id, label: terminal.label || spec.kind, airflowM3h: share.airflowM3h, fixed: share.fixed,
      neckMm: spec.neckDiameterMm, neckVelocityMs: neckVelocityMs(spec, share.airflowM3h),
    };
  });
  const neckCap = tab === 'return' ? ductSettings.autoMaxNeckVelocityReturnMs : ductSettings.autoMaxNeckVelocitySupplyMs;
  const intendedRequest: AutoDuctRequest = {
    unitId: unit.id, terminalIds: terminals.map((terminal) => terminal.id), fanSpeed,
    airflowM3h: airflowOverride, layout, services, rebuildExisting: rebuild, shape,
    sizing: method === 'constant-friction' ? allBases() : null,
    ...(airflowEntries ? { terminalAirflows: airflowEntries } : {}),
  };
  const inputsChanged = Boolean(current && (!request || !sameAutoDuctInputs(request, intendedRequest)));
  const stale = result?.unitId === unit.id && !current;
  const busy = running === unit.id;
  const occupiedSelection = sizingServices.filter((service) => occupiedServices.has(service));
  const generateProblem = airflowError ? `Airflow: ${airflowError}`
    : !systemAirflow ? 'Enter this unit’s airflow in m³/h before generating ducts.'
      : !services.supply && !services.return ? 'Choose Supply, Return, or both.'
        : !sizingServices.length ? 'Select the diffusers (supply) and grilles (return) this unit serves.'
          : !rebuild && occupiedSelection.length ? `The ${occupiedSelection.join(' and ')} duct is already connected. Enable Rebuild existing or turn off that service.` : null;
  const canGenerate = !busy && !generateProblem;
  const validFields = () => {
    const invalid = cardRef.current?.querySelector<HTMLInputElement>('input[aria-invalid="true"]');
    if (invalid) {
      let parent = invalid.parentElement;
      while (parent && parent !== cardRef.current) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
      }
      invalid.focus();
      return false;
    }
    return true;
  };
  const generate = () => {
    if (canGenerate && validFields()) void generateAutoDuctPreview(intendedRequest);
  };
  return (
    <div ref={cardRef} className="mb-2 space-y-1.5 rounded-lg border border-sky-200 bg-sky-50/60 p-2" data-testid="duct-auto-card" aria-busy={busy || resizing}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-sky-800"><Wand2 size={12} />Auto duct</span>
        <span className="text-[11px] text-slate-600" title={`${counts.supply} diffuser(s), ${counts.return} return grille(s)`}>
          {unit.label || 'Unit'} · {counts.supply} diffuser{counts.supply === 1 ? '' : 's'} · {counts.return} grille{counts.return === 1 ? '' : 's'}
        </span>
      </div>
      {!selection.fromSelection ? (
        <p className="text-[10px] text-slate-500">
          {rebuild ? `Using ${terminals.length} terminals connected to this unit or available nearby.`
            : `Using ${terminals.length} unconnected terminals in this room or within 10 m when room data is missing.`}
          {' '}Shift-click or drag a box with the unit to choose specific terminals.
        </p>
      ) : null}
      <div className="grid grid-cols-3 gap-0.5 rounded-md border border-slate-200 bg-white p-0.5" role="radiogroup" aria-label="Auto duct shape">
        {AUTO_DUCT_SHAPE_OPTIONS.map((option) => (
          <button key={option.key} type="button" role="radio" aria-checked={shape === option.key} title={option.hint} onClick={() => setShape(option.key)}
            className={`flex items-center justify-center gap-1 rounded px-1 py-0.5 text-[11px] ${shape === option.key ? 'bg-sky-700 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
            {option.icon}{option.label}
          </button>
        ))}
      </div>
      <Line label="Fan speed" icon={<Fan size={12} />}>
        {air.airflowM3h ? (
          <select value={fanSpeed} onChange={(event) => setFanSpeed(event.target.value as FanSpeed)} className={select} aria-label="Auto duct fan speed">
            {FAN_SPEEDS.map((speed) => <option key={speed} value={speed}>{FAN_SPEED_LABELS[speed]} · {Math.round(air.airflowM3h![speed])} m³/h</option>)}
          </select>
        ) : <span className={`text-[10px] ${defaultAirflow ? 'text-slate-500' : 'text-amber-700'}`}>{defaultAirflow ? 'using the unit’s airflow' : 'no airflow data: enter it below'}</span>}
      </Line>
      <Line label="Airflow" icon={<Wind size={12} />}>
        <input type="number" step={10} min={0.01} max={50000} value={airflowDraft} placeholder={defaultAirflow ? String(Math.round(defaultAirflow)) : 'm³/h'}
          onChange={(event) => { setAirflowDraft(event.target.value); setAirflowBadInput(event.target.validity.badInput); }}
          onKeyDown={(event) => { if (event.key === 'Escape') { setAirflowDraft(''); setAirflowBadInput(false); event.stopPropagation(); } }}
          className={`w-20 rounded-md border px-1 text-xs ${airflowError ? 'border-red-400' : 'border-slate-200'}`} aria-label="Auto duct airflow"
          aria-invalid={Boolean(airflowError)} aria-describedby="duct-auto-airflow-help" />
        <span className="text-[10px] text-slate-400">m³/h</span>
      </Line>
      <p id="duct-auto-airflow-help" className={`text-[10px] ${airflowError ? 'text-red-600' : 'text-slate-500'}`}>
        {airflowError ?? (airflowDraft ? 'Manual airflow override. Clear to use the unit’s airflow.' : defaultAirflow ? `Using ${Math.round(defaultAirflow)} m³/h from the unit. Enter a value to override.` : 'Enter a positive airflow from the unit specification.')}
      </p>
      <Line label="Layout" icon={<LayoutGrid size={12} />}>
        <select value={layout} onChange={(event) => setLayout(event.target.value as AutoDuctLayoutChoice)} className={select} aria-label="Auto duct layout">
          <option value="auto">Any (optimiser)</option>
          <option value="plenum">Plenum + runouts</option>
          <option value="trunk">Trunk + branches</option>
        </select>
      </Line>
      <Line label="Ducts">
        <label className="flex items-center gap-1"><input type="checkbox" checked={services.supply} onChange={(event) => setServices({ ...services, supply: event.target.checked })} aria-label="Auto duct supply" /><span className="inline-block h-2 w-3 rounded-[2px] border-[1.5px] border-blue-700 bg-blue-500/15" aria-hidden="true" />Supply</label>
        <label className="ml-1 flex items-center gap-1"><input type="checkbox" checked={services.return} onChange={(event) => setServices({ ...services, return: event.target.checked })} aria-label="Auto duct return" /><span className="inline-block h-2 w-3 rounded-[2px] border-[1.5px] border-teal-700 bg-teal-500/15" aria-hidden="true" />Return</label>
      </Line>
      {!occupied || rebuild || current ? (
      <div className="space-y-1 border-t border-sky-100 pt-1" data-testid="duct-sizing">
        <Line label="Sizing" icon={<Ruler size={12} />}>
          <span className="text-[10px] text-slate-500">
            {method === 'constant-friction' ? (current ? 'changes resize the preview live' : 'Generate sizes at this basis') : 'least first cost + fan energy'}
          </span>
        </Line>
        <SizingMethodSwitch method={method} onChange={changeMethod} />
        <ServiceTabs services={sizingServices} active={tab} onChange={setSizingTab} />
        {method === 'constant-friction' && sizingServices.length ? (
          <BasisEditor key={`${unit.id}:${tab}`} basis={basisFor(tab)} live onChange={(next) => updateBasis(tab, next)} />
        ) : null}
        <TerminalAirflowList rows={airflowRows} neckCapMs={neckCap} systemAirflowM3h={systemAirflow} live onChange={(id, value) => updateAirflow(id, value)} />
      </div>
      ) : null}
      {occupied ? (
        <div>
          <Line label="Rebuild existing">
            <input type="checkbox" checked={rebuild} onChange={(event) => setRebuild(event.target.checked)} aria-label="Auto duct rebuild existing" />
          </Line>
          {rebuild ? <p className="text-[10px] text-slate-500">Apply replaces the selected services’ ducts and keeps the change in one undo step.</p> : null}
        </div>
      ) : null}
      <div className="flex gap-1 pt-0.5">
        {busy ? (
          <button type="button" onClick={cancelAutoDuctPreview} aria-label="Cancel duct generation"
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-slate-700 px-2 py-1 text-xs font-medium text-white hover:bg-slate-800">
            <Loader2 size={12} className="animate-spin" />Routing and sizing… Cancel <X size={12} />
          </button>
        ) : (
          <button type="button" disabled={!canGenerate} onClick={generate}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-sky-700 px-2 py-1 text-xs font-medium text-white hover:bg-sky-800 disabled:opacity-40">
            <Wand2 size={12} />{current || stale ? 'Regenerate ducts' : 'Generate ducts'}
          </button>
        )}
        {current && current.runs.length ? (
          <button type="button" disabled={Boolean(running) || resizing || inputsChanged || Boolean(airflowError)}
            onClick={() => { if (validFields()) applyAutoDuctPreview(); }}
            className="rounded-md bg-emerald-700 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-40">
            Apply ducts
          </button>
        ) : null}
        {current ? (
          <button type="button" onClick={() => discardAutoDuctPreview()} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
            Discard
          </button>
        ) : null}
      </div>
      {generateProblem && !busy ? <p className="text-[10px] text-amber-700" role="status">{generateProblem}</p> : null}
      {resizing && current ? <p className="text-[10px] text-sky-700" role="status">Updating duct sizes and design costs…</p> : null}
      {inputsChanged && !resizing ? <p className="text-[10px] text-amber-700" role="status">Inputs changed. Regenerate ducts to review and apply a matching design.</p> : null}
      {stale ? <p className="text-[10px] text-amber-700" role="status">The drawing or duct settings changed since the preview. Regenerate ducts.</p> : null}
      {message && !current ? <p className="text-[10px] text-slate-600" role="status">{message}</p> : null}
      {occupied && !current && !busy && !rebuild ? <AppliedSystemSizing unit={unit} /> : null}
      {current ? <Designs result={current} /> : null}
      {current ? <Summary result={current} /> : null}
    </div>
  );
}
