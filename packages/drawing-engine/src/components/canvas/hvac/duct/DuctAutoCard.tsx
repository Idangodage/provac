'use client';

/**
 * Auto duct card: shown when the selection holds one ducted unit (with the
 * diffusers and grilles it serves). Generate lays the ducts out as a preview
 * on the canvas with the design summary; Apply adds them as one undo step.
 */
import { useMemo, useState } from 'react';
import { shallow } from 'zustand/shallow';

import { useSmartDrawingStore } from '../../../../store';

import { applyAutoDuctPreview, autoDuctSelection, discardAutoDuctPreview, generateAutoDuctPreview } from './ductAutoController';
import { AUTO_DUCT_LAYOUT_LABELS, type AutoDuctLayoutChoice, type AutoDuctResult } from './ductAutoLayout';
import { useDuctAutoPreviewStore } from './ductAutoPreviewStore';
import { FAN_SPEED_LABELS, FAN_SPEEDS, readUnitAirData, type FanSpeed } from './ductSizing';
import { readDuctTerminalSpec } from './ductTerminals';
import { isDuctElement, readDuctRunSpec } from './ductTypes';

const select = 'rounded border border-slate-200 px-1 py-0.5 text-xs';

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5 text-xs">
      <span className="text-slate-500">{label}</span>
      <span className="text-right text-slate-800">{children}</span>
    </div>
  );
}

const SOURCE_LABEL: Record<NonNullable<AutoDuctResult['airflowSource']>, string> = {
  entered: 'entered',
  unit: "unit's Airflow field",
  manufacturer: 'manufacturer data',
};

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
        <div key={service.service} className="rounded bg-white/70 p-1">
          <div className="text-[11px] font-semibold text-slate-700">
            {service.service === 'supply' ? 'Supply' : 'Return'}: {service.layout ? AUTO_DUCT_LAYOUT_LABELS[service.layout] : 'no layout'}
          </div>
          {service.trunkSections.length ? (
            <div className="text-[11px] text-slate-600">
              {service.layout === 'plenum' ? 'Plenum ' : 'Trunk '}
              {service.trunkSections.map((section) => `${section.widthMm}×${section.heightMm}`).join(' → ')}
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
  const { result, scene, message } = useDuctAutoPreviewStore((state) => ({ result: state.result, scene: state.scene, message: state.message }), shallow);
  const [fanSpeed, setFanSpeed] = useState<FanSpeed>('hi');
  const [airflowDraft, setAirflowDraft] = useState('');
  const [layout, setLayout] = useState<AutoDuctLayoutChoice>('auto');
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
  const canGenerate = (services.supply && counts.supply > 0) || (services.return && counts.return > 0);
  const generate = () => generateAutoDuctPreview({
    unitId: unit.id, terminalIds: terminals.map((terminal) => terminal.id), fanSpeed,
    airflowM3h: airflowOverride, layout, services, rebuildExisting: rebuild,
  });
  return (
    <div className="mb-2 space-y-1 rounded-lg border border-sky-200 bg-sky-50/60 p-2" data-testid="duct-auto-card">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-sky-800">Auto duct</span>
        <span className="text-[11px] text-slate-600">
          {unit.label || 'Unit'} · {counts.supply} diffuser{counts.supply === 1 ? '' : 's'} · {counts.return} grille{counts.return === 1 ? '' : 's'}
        </span>
      </div>
      {!selection.fromSelection ? (
        <p className="text-[10px] text-slate-500">
          No terminals selected: using the {terminals.length} unconnected one{terminals.length === 1 ? '' : 's'} in this room. Shift-click or drag a box to choose.
        </p>
      ) : null}
      <Line label="Fan speed">
        {air.airflowM3h ? (
          <select value={fanSpeed} onChange={(event) => setFanSpeed(event.target.value as FanSpeed)} className={select} aria-label="Auto duct fan speed">
            {FAN_SPEEDS.map((speed) => <option key={speed} value={speed}>{FAN_SPEED_LABELS[speed]} · {Math.round(air.airflowM3h![speed])} m³/h</option>)}
          </select>
        ) : <span className="text-[10px] text-amber-700">no airflow data: enter it below</span>}
      </Line>
      <Line label="Airflow">
        <input type="number" step={10} min={0} value={airflowDraft} placeholder={air.airflowM3h ? String(Math.round(air.airflowM3h[fanSpeed])) : 'm³/h'}
          onChange={(event) => setAirflowDraft(event.target.value)} className="w-20 rounded border border-slate-200 px-1 text-xs" aria-label="Auto duct airflow" />
        <span className="ml-0.5 text-[10px] text-slate-400">m³/h</span>
      </Line>
      <Line label="Layout">
        <select value={layout} onChange={(event) => setLayout(event.target.value as AutoDuctLayoutChoice)} className={select} aria-label="Auto duct layout">
          <option value="auto">Auto (cheapest that checks clean)</option>
          <option value="plenum">Plenum + runouts</option>
          <option value="trunk">Trunk + branches</option>
        </select>
      </Line>
      <Line label="Ducts">
        <label className="mr-2"><input type="checkbox" checked={services.supply} onChange={(event) => setServices({ ...services, supply: event.target.checked })} aria-label="Auto duct supply" /> Supply</label>
        <label><input type="checkbox" checked={services.return} onChange={(event) => setServices({ ...services, return: event.target.checked })} aria-label="Auto duct return" /> Return</label>
      </Line>
      {occupied ? (
        <Line label="Rebuild existing">
          <input type="checkbox" checked={rebuild} onChange={(event) => setRebuild(event.target.checked)} aria-label="Auto duct rebuild existing" />
        </Line>
      ) : null}
      <div className="flex gap-1 pt-1">
        <button type="button" disabled={!canGenerate} onClick={generate}
          className="rounded bg-sky-700 px-2 py-0.5 text-xs font-medium text-white hover:bg-sky-800 disabled:opacity-40">
          Generate ducts
        </button>
        {current && current.runs.length ? (
          <button type="button" onClick={() => applyAutoDuctPreview()} className="rounded bg-emerald-700 px-2 py-0.5 text-xs font-medium text-white hover:bg-emerald-800">
            Apply ducts
          </button>
        ) : null}
        {current ? (
          <button type="button" onClick={() => discardAutoDuctPreview()} className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50">
            Discard
          </button>
        ) : null}
      </div>
      {!canGenerate ? <p className="text-[10px] text-slate-500">Select the diffusers (supply) and grilles (return) this unit serves.</p> : null}
      {stale ? <p className="text-[10px] text-amber-700">The drawing changed since the preview: generate again.</p> : null}
      {message && !current ? <p className="text-[10px] text-slate-600">{message}</p> : null}
      {current ? <Summary result={current} /> : null}
    </div>
  );
}
