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

import { buildDuctBom, buildDuctFabricationSchedule, ductBomToCsv, ductScheduleToCsv, type DuctBomRow } from './ductBom';
import { gaugeLabelForSheet } from './ductCatalog';
import { getDuctRunPlan, type DuctFabricationPlan } from './ductFabricationPlanner';
import { describeJoint } from './ductGauge';
import { DUCT_RULE_SOURCES, DUCT_SUPPORTED_PRESSURE_CLASSES_PA, type DuctDesignSettings, type DuctJointSystem } from './ductSettings';
import { useDuctToolStore } from './ductToolStore';
import { buildDuctRunElement, isDuctElement } from './ductTypes';

const JOINT_OPTIONS: Array<{ value: DuctJointSystem; label: string }> = [
  { value: 'auto', label: 'Auto (TDC → angle)' },
  { value: 'tdc', label: 'TDC / TDF flange' },
  { value: 'ductmate', label: 'Ductmate' },
  { value: 'angle-flange', label: 'L-angle companion flange' },
];

function Row({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="flex items-start justify-between gap-2 py-1 text-sm" title={title}>
      <span className="text-slate-500">{label}</span>
      <span className="text-right text-slate-800">{children}</span>
    </div>
  );
}

function SourceBadge({ settingKey }: { settingKey: keyof DuctDesignSettings }) {
  const source = DUCT_RULE_SOURCES[settingKey];
  if (!source) return null;
  const title = [source.reference, source.note].filter(Boolean).join(' — ');
  return source.verified
    ? <span className="ml-1 rounded bg-emerald-50 px-1 text-[10px] text-emerald-700" title={title}>verified</span>
    : <span className="ml-1 rounded bg-amber-50 px-1 text-[10px] text-amber-700" title={title}>unverified</span>;
}

function BomTable({ rows }: { rows: DuctBomRow[] }) {
  if (rows.length === 0) return <p className="text-xs text-slate-500">Nothing to schedule.</p>;
  return (
    <table className="w-full text-[11px]">
      <tbody>
        {rows.map((row, index) => (
          <tr key={index} className={row.category === 'Issues' ? 'text-red-700' : 'text-slate-700'}>
            <td className="py-0.5 pr-1 align-top">{row.description}{row.size !== '—' ? <span className="text-slate-400"> · {row.size}</span> : null}</td>
            <td className="whitespace-nowrap py-0.5 text-right align-top">{row.quantity} {row.unit}</td>
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

export function DuctRunInspector({ element }: { element: HvacElement }) {
  const { hvacElements, ductSettings, commitHvacElementCommand, updateHvacElement } = useSmartDrawingStore((state) => ({
    hvacElements: state.hvacElements,
    ductSettings: state.ductSettings,
    commitHvacElementCommand: state.commitHvacElementCommand,
    updateHvacElement: state.updateHvacElement,
  }), shallow);
  const plan = useMemo(() => getDuctRunPlan(element, hvacElements, ductSettings), [element, hvacElements, ductSettings]);
  const bom = useMemo(() => (plan ? buildDuctBom([plan]) : []), [plan]);
  if (!plan) return null;
  const spec = plan.spec;
  const construction = plan.constructionByLeg[0];
  const leg = spec.legs[0]!;
  const count = (kind: string) => plan.pieces.filter((piece) => piece.kind === kind).length;
  const setJointSystem = (value: string) => {
    const next = { ...spec, jointSystem: value === 'project' ? null : (value as DuctJointSystem) };
    commitHvacElementCommand('Duct joint system', { updates: [{ id: element.id, updates: { properties: buildDuctRunElement(next).properties } }] });
  };
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
      <Row label="Construction">GI, bare</Row>
      <Row label="Clear section">{Math.round(leg.widthMm)} × {Math.round(leg.heightMm)} mm</Row>
      <Row label="Length">{(plan.polylineLengthMm / 1000).toFixed(2)} m · {spec.legs.length} leg(s)</Row>
      {construction && construction.status === 'ok' ? (
        <>
          <Row label="Pressure class">{construction.pressureClassPa} Pa ({construction.pressureMode})</Row>
          <Row label="SMACNA minimum" title={construction.table ? `Table ${construction.table}, ${construction.spacingColumnMm} mm column` : 'longest-side table'}>
            {construction.smacnaMinThicknessMm?.toFixed(2)} mm{construction.table ? ` · T${construction.table}` : ''}
          </Row>
          <Row label="Sheet (stock)">{construction.sheetThicknessMm?.toFixed(2)} mm · {gaugeLabelForSheet(construction.sheetThicknessMm ?? 0)}</Row>
          <Row label="Joint class">{construction.requiredClass ?? 'none required'}{construction.tieRodAlternative ? ` (tie-rod ${construction.tieRodAlternative})` : ''}</Row>
          <Row label="Joint">{describeJoint(construction.joint)}</Row>
          {construction.crossBreak.width || construction.crossBreak.height ? <Row label="Cross-break">wide sides (S1.15)</Row> : null}
        </>
      ) : (
        <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{construction?.message ?? 'Construction unresolved.'}</p>
      )}
      <Row label="Joint system">
        <select
          value={spec.jointSystem ?? 'project'}
          onChange={(event) => setJointSystem(event.target.value)}
          className="rounded border border-slate-200 px-1 py-0.5 text-xs"
        >
          <option value="project">Project default</option>
          {JOINT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </Row>
      <Row label="Pieces">{count('straight')} sections · {count('elbow')} elbows · {count('connector')} connector · {count('end-cap')} cap</Row>
      <Row label="Joints">{plan.joints.length}</Row>
      <Row label="Sheet">{plan.totals.sheetAreaM2.toFixed(2)} m² · {plan.totals.massKg.toFixed(1)} kg</Row>
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
        Click a ducted unit&apos;s supply or return collar, then click to add bends. Double-click or Enter finishes; Backspace removes a leg; Esc cancels.
      </p>
      <Row label="Angles">
        <select value={tool.angleMode} onChange={(event) => tool.setAngleMode(event.target.value as '90' | '45')} className="rounded border border-slate-200 px-1 py-0.5 text-xs">
          <option value="90">90° only</option>
          <option value="45">90° and 45° (Tab)</option>
        </select>
      </Row>
      <Row label="Size">
        <select value={tool.sizeMode} onChange={(event) => tool.setSize({ sizeMode: event.target.value as 'collar' | 'custom' })} className="rounded border border-slate-200 px-1 py-0.5 text-xs">
          <option value="collar">Match collar</option>
          <option value="custom">Custom (needs transition — phase 2)</option>
        </select>
      </Row>
      {tool.sizeMode === 'custom' ? (
        <Row label="W × H (clear)">
          <input type="number" step={50} value={tool.widthMm} onChange={(event) => tool.setSize({ widthMm: Number(event.target.value) })} className="w-16 rounded border border-slate-200 px-1 text-xs" />
          {' × '}
          <input type="number" step={50} value={tool.heightMm} onChange={(event) => tool.setSize({ heightMm: Number(event.target.value) })} className="w-16 rounded border border-slate-200 px-1 text-xs" />
        </Row>
      ) : null}
      <Row label="Run end">
        <select value={tool.endKind} onChange={(event) => tool.setEndKind(event.target.value as 'end-cap' | 'open')} className="rounded border border-slate-200 px-1 py-0.5 text-xs">
          <option value="end-cap">End cap</option>
          <option value="open">Open</option>
        </select>
      </Row>
    </div>
  );
}

export function DuctSystemsSection() {
  const { ductSettings, setDuctSettings } = useSmartDrawingStore((state) => ({
    ductSettings: state.ductSettings, setDuctSettings: state.setDuctSettings,
  }), shallow);
  const plans = usePlans();
  const bom = useMemo(() => buildDuctBom(plans), [plans]);
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
      <Row label="Radius elbow R/W">
        <input type="number" step={0.25} min={0.5} max={3} value={ductSettings.elbowCentrelineRatio}
          onChange={(event) => setDuctSettings({ elbowCentrelineRatio: Number(event.target.value) })} className="w-16 rounded border border-slate-200 px-1 text-xs" />
        <SourceBadge settingKey="elbowCentrelineRatio" />
      </Row>
      <Row label="Flexible connector at unit">
        <input type="checkbox" checked={ductSettings.flexibleConnectorAtUnit} onChange={(event) => setDuctSettings({ flexibleConnectorAtUnit: event.target.checked })} />
        <SourceBadge settingKey="connectorFabricMm" />
      </Row>
      <Row label="Show">
        <label className="mr-2 text-xs"><input type="checkbox" checked={ductSettings.showSizeTags} onChange={(event) => setDuctSettings({ showSizeTags: event.target.checked })} /> tags</label>
        <label className="mr-2 text-xs"><input type="checkbox" checked={ductSettings.showJointTicks} onChange={(event) => setDuctSettings({ showJointTicks: event.target.checked })} /> joints</label>
        <label className="text-xs"><input type="checkbox" checked={ductSettings.showPieceMarks} onChange={(event) => setDuctSettings({ showPieceMarks: event.target.checked })} /> marks</label>
      </Row>
      <details open>
        <summary className="cursor-pointer text-xs font-medium text-slate-700">Project duct BOM ({plans.length} run{plans.length === 1 ? '' : 's'})</summary>
        <BomTable rows={bom} />
        <div className="flex gap-2 pt-1">
          <CopyButton text={ductBomToCsv(bom)} label="Copy BOM CSV" />
          <CopyButton text={ductScheduleToCsv(schedule)} label="Copy schedule CSV" />
        </div>
      </details>
    </div>
  );
}
