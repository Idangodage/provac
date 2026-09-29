'use client';

/**
 * Auto duct card: shown when the selection holds one ducted unit (with the
 * diffusers and grilles it serves). Generate routes the candidate trees, sizes
 * each exactly (first cost against fan pressure) and verifies the best in the
 * planner, off the main thread; the card then shows the cost–pressure frontier
 * of the verified designs with three picks — least first cost, least
 * life-cycle cost (shown on the canvas), least pressure — their costs, and the
 * design summary. Apply adds the design shown as one undo step.
 */
import { Circle, Coins, Fan, Gauge, LayoutGrid, Loader2, ShieldCheck, Sparkles, Square, Star, Wand2, Wind, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { shallow } from 'zustand/shallow';

import { useSmartDrawingStore } from '../../../../store';

import { applyAutoDuctPreview, autoDuctSelection, cancelAutoDuctPreview, discardAutoDuctPreview, generateAutoDuctPreview } from './ductAutoController';
import { AUTO_DUCT_LAYOUT_LABELS, type AutoDuctLayoutChoice, type AutoDuctResult, type AutoDuctShape } from './ductAutoLayout';
import { useDuctAutoPreviewStore } from './ductAutoPreviewStore';
import { formatCost, type DuctCostBreakdown } from './ductEconomics';
import { DuctFrontierChart } from './DuctFrontierChart';
import { FAN_SPEED_LABELS, FAN_SPEEDS, readUnitAirData, type FanSpeed } from './ductSizing';
import { readDuctTerminalSpec } from './ductTerminals';
import { isDuctElement, readDuctRunSpec } from './ductTypes';

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
          <span className="font-medium">{certificate.exact ? 'Optimal on the model' : 'Best of the candidates'}</span>
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
  const notes = issues.filter((issue) => issue.severity === 'info');
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
  const { hvacElements, selectedElementIds } = useSmartDrawingStore((state) => ({
    hvacElements: state.hvacElements, selectedElementIds: state.selectedElementIds,
  }), shallow);
  const { result, scene, message, running } = useDuctAutoPreviewStore((state) => ({
    result: state.result, scene: state.scene, message: state.message, running: state.running,
  }), shallow);
  const [fanSpeed, setFanSpeed] = useState<FanSpeed>('hi');
  const [airflowDraft, setAirflowDraft] = useState('');
  const [layout, setLayout] = useState<AutoDuctLayoutChoice>('auto');
  const [shape, setShape] = useState<AutoDuctShape>('optimal');
  const [services, setServices] = useState({ supply: true, return: true });
  const [rebuild, setRebuild] = useState(false);
  const selection = useMemo(() => autoDuctSelection(selectedElementIds, hvacElements), [selectedElementIds, hvacElements]);
  if (!selection) return null;
  const { unit, terminals } = selection;
  const air = readUnitAirData(unit);
  const counts = { supply: 0, return: 0 };
  for (const terminal of terminals) {
    const service = readDuctTerminalSpec(terminal)?.service;
    if (service) counts[service] += 1;
  }
  const occupied = hvacElements.some((element) => {
    const start = isDuctElement(element) ? readDuctRunSpec(element)?.start : null;
    return start?.kind === 'unit-port' && start.unitId === unit.id;
  });
  const typed = Number.parseFloat(airflowDraft);
  const airflowOverride = Number.isFinite(typed) && typed > 0 ? typed : null;
  const current = result && result.unitId === unit.id && scene === hvacElements ? result : null;
  const stale = result && result.unitId === unit.id && scene !== hvacElements;
  const busy = running === unit.id;
  const canGenerate = !busy && ((services.supply && counts.supply > 0) || (services.return && counts.return > 0));
  const generate = () => {
    void generateAutoDuctPreview({
      unitId: unit.id, terminalIds: terminals.map((terminal) => terminal.id), fanSpeed,
      airflowM3h: airflowOverride, layout, services, rebuildExisting: rebuild, shape,
    });
  };
  return (
    <div className="mb-2 space-y-1.5 rounded-lg border border-sky-200 bg-sky-50/60 p-2" data-testid="duct-auto-card">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-sky-800"><Wand2 size={12} />Auto duct</span>
        <span className="text-[11px] text-slate-600" title={`${counts.supply} diffuser(s), ${counts.return} return grille(s)`}>
          {unit.label || 'Unit'} · {counts.supply} diffuser{counts.supply === 1 ? '' : 's'} · {counts.return} grille{counts.return === 1 ? '' : 's'}
        </span>
      </div>
      {!selection.fromSelection ? (
        <p className="text-[10px] text-slate-500">
          No terminals selected: using the {terminals.length} unconnected one{terminals.length === 1 ? '' : 's'} in this room. Shift-click or drag a box to choose.
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
        ) : <span className="text-[10px] text-amber-700">no airflow data: enter it below</span>}
      </Line>
      <Line label="Airflow" icon={<Wind size={12} />}>
        <input type="number" step={10} min={0} value={airflowDraft} placeholder={air.airflowM3h ? String(Math.round(air.airflowM3h[fanSpeed])) : 'm³/h'}
          onChange={(event) => setAirflowDraft(event.target.value)} className="w-20 rounded-md border border-slate-200 px-1 text-xs" aria-label="Auto duct airflow" />
        <span className="text-[10px] text-slate-400">m³/h</span>
      </Line>
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
      {occupied ? (
        <Line label="Rebuild existing">
          <input type="checkbox" checked={rebuild} onChange={(event) => setRebuild(event.target.checked)} aria-label="Auto duct rebuild existing" />
        </Line>
      ) : null}
      <div className="flex gap-1 pt-0.5">
        {busy ? (
          <button type="button" onClick={cancelAutoDuctPreview}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-slate-700 px-2 py-1 text-xs font-medium text-white hover:bg-slate-800">
            <Loader2 size={12} className="animate-spin" />Routing and sizing… <X size={12} />
          </button>
        ) : (
          <button type="button" disabled={!canGenerate} onClick={generate}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-sky-700 px-2 py-1 text-xs font-medium text-white hover:bg-sky-800 disabled:opacity-40">
            <Wand2 size={12} />Generate ducts
          </button>
        )}
        {current && current.runs.length ? (
          <button type="button" onClick={() => applyAutoDuctPreview()} className="rounded-md bg-emerald-700 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-800">
            Apply ducts
          </button>
        ) : null}
        {current ? (
          <button type="button" onClick={() => discardAutoDuctPreview()} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
            Discard
          </button>
        ) : null}
      </div>
      {!canGenerate && !busy ? <p className="text-[10px] text-slate-500">Select the diffusers (supply) and grilles (return) this unit serves.</p> : null}
      {stale ? <p className="text-[10px] text-amber-700">The drawing changed since the preview: generate again.</p> : null}
      {message && !current ? <p className="text-[10px] text-slate-600">{message}</p> : null}
      {current ? <Designs result={current} /> : null}
      {current ? <Summary result={current} /> : null}
    </div>
  );
}
