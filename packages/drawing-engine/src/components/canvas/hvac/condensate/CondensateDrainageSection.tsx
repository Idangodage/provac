'use client';

/**
 * Properties-panel section for condensate drainage: design settings (with
 * their engineering sources), the generation result per unit, refrigerant hop
 * approvals and the bill of materials.
 */
import { useMemo, useState } from 'react';
import { shallow } from 'zustand/shallow';

import { useSmartDrawingStore } from '../../../../store';
import type { ManufacturerRuleProfile } from '../../../../vrf/rules';
import { applyAutoRoutePreview, discardAutoRoutePreview, runAutoRoute } from '../autoRouteController';
import { fromDisplay, slopeText, toDisplay, toDisplayText, unitLabel } from '../units/hvacUnits';
import { useHvacUnitSystem } from '../units/useHvacUnits';

import { buildCondensateBom, condensateBomRowIn, condensateBomToCsv } from './condensateBom';
import { drainNetworksOffSeries, resizeDrainNetworksToSeries } from './condensateEditController';
import { deriveCondensateEnvelope } from './condensateEnvironment';
import { CONDENSATE_PIPE_SYSTEMS } from './condensatePipeCatalog';
import { useCondensatePreviewStore } from './condensatePreviewStore';
import {
  CONDENSATE_RULE_SOURCES,
  DEFAULT_CONDENSATE_SETTINGS,
  formatFallRatio,
  type CondensateDesignSettings,
} from './condensateSettings';
import { isCondensateElement } from './condensateTypes';

type NumericKey = {
  [K in keyof CondensateDesignSettings]: CondensateDesignSettings[K] extends number ? K : never;
}[keyof CondensateDesignSettings];

/** `ip`: how the row reads in IP (a fall in in/ft, a thickness in inches); the rest are lengths and levels, in mm in either system. */
const NUMBER_ROWS: Array<{ key: NumericKey; label: string; unit: string; step: number; ip?: { kind: 'slope' | 'size'; step: number } }> = [
  { key: 'minSlopePercent', label: 'Minimum fall', unit: '%', step: 0.1, ip: { kind: 'slope', step: 0.01 } },
  { key: 'preferredSlopePercent', label: 'Preferred fall', unit: '%', step: 0.1, ip: { kind: 'slope', step: 0.01 } },
  { key: 'insulationThicknessMm', label: 'Anti-sweat insulation', unit: 'mm', step: 1, ip: { kind: 'size', step: 0.125 } },
  { key: 'envelopeClearanceMm', label: 'Clear space in void', unit: 'mm', step: 5 },
  { key: 'refrigerantClearanceMm', label: 'Clearance to refrigerant', unit: 'mm', step: 5 },
  { key: 'defaultPumpMaxLiftMm', label: 'Default pump lift', unit: 'mm', step: 25 },
  { key: 'mainBelowPortsMm', label: 'Main below drain outlets', unit: 'mm', step: 10 },
  { key: 'junctionSpacingMm', label: 'Junction spacing', unit: 'mm', step: 50 },
  { key: 'supportSpacingHorizontalMm', label: 'Hanger spacing', unit: 'mm', step: 100 },
  { key: 'cleanoutMaxSpacingMm', label: 'Rodding eye spacing', unit: 'mm', step: 1000 },
];

function SettingRow({ label, value, unit, step, modified, source, onCommit }: {
  label: string; value: number; unit: string; step: number; modified: boolean; source?: string; onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="flex items-center justify-between gap-2 py-1.5 text-sm text-slate-600" title={source}>
      <span>{label}{modified ? <span className="ml-1 text-amber-600" aria-label="modified">●</span> : null}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          step={step}
          value={draft ?? String(value)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft !== null) {
              const parsed = Number.parseFloat(draft);
              if (Number.isFinite(parsed)) onCommit(parsed);
            }
            setDraft(null);
          }}
          onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }}
          className="w-20 rounded border border-amber-200/80 bg-white px-2 py-1 text-right text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
        />
        <span className="min-w-6 text-xs text-slate-500">{unit}</span>
      </span>
    </label>
  );
}

/**
 * The drains' pipe: the series new drains are sized from; with IP, PVC
 * Schedule 40 (sized by the inch) offered, back in SI the metric series; and
 * drains of another series re-sized to it (one undo).
 */
function DrainPipeSeries() {
  const { pipeSystem, setSettings, hvacElements } = useSmartDrawingStore((state) => ({
    pipeSystem: state.condensateSettings.pipeSystem, setSettings: state.setCondensateSettings, hvacElements: state.hvacElements,
  }), shallow);
  const system = useHvacUnitSystem();
  const [declined, setDeclined] = useState<string | null>(null);
  const wanted = system === 'ip' ? 'astm-sch40' : pipeSystem === 'astm-sch40' ? 'bs-en-1329' : null;
  const offered = wanted && wanted !== pipeSystem && declined !== `${system}:${pipeSystem}` ? wanted : null;
  const offSeries = useMemo(() => drainNetworksOffSeries(hvacElements, pipeSystem).length, [hvacElements, pipeSystem]);
  const label = CONDENSATE_PIPE_SYSTEMS[pipeSystem].label;
  return (
    <div className="space-y-1.5" data-testid="condensate-pipe-series">
      <label className="flex items-center justify-between gap-2 text-xs text-slate-600">Drain pipe
        <select value={pipeSystem} aria-label="Drain pipe series" data-testid="condensate-pipe-system"
          onChange={(event) => setSettings({ pipeSystem: event.target.value as typeof pipeSystem })}
          className="min-w-0 max-w-[60%] rounded-md border border-slate-200 bg-white px-1.5 py-1 text-xs">
          {Object.values(CONDENSATE_PIPE_SYSTEMS).map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>
      {offered ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-sky-50 p-2 text-xs text-sky-900" data-testid="condensate-pipe-series-offer">
          <span>{offered === 'astm-sch40' ? 'Inch drain pipe too? PVC Schedule 40, sized by the inch.' : 'Metric drain pipe too? uPVC waste (BS EN 1329).'}</span>
          <span className="flex gap-1.5">
            <button type="button" onClick={() => setSettings({ pipeSystem: offered })} className="rounded bg-sky-700 px-2 py-0.5 font-medium text-white hover:bg-sky-800">
              Use {offered === 'astm-sch40' ? 'Schedule 40' : 'metric'}
            </button>
            <button type="button" onClick={() => setDeclined(`${system}:${pipeSystem}`)} className="rounded px-1.5 py-0.5 text-sky-800 hover:bg-sky-100">Keep</button>
          </span>
        </div>
      ) : null}
      {offSeries ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-slate-50 p-2 text-xs text-slate-700" data-testid="condensate-pipe-series-resize">
          <span>{offSeries} drain network{offSeries === 1 ? ' is' : 's are'} of another pipe.</span>
          <button type="button" onClick={() => resizeDrainNetworksToSeries(`Drains re-sized to ${label}`)}
            className="rounded border border-slate-300 bg-white px-2 py-0.5 font-medium text-slate-800 hover:bg-slate-100" title={`Size every drain network again in ${label}: routes and falls kept (one undo)`}>
            Re-size to {pipeSystem === 'astm-sch40' ? 'Schedule 40' : label}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function CondensateDrainageSection({ profile }: { profile?: ManufacturerRuleProfile } = {}) {
  const { settings, setSettings, hvacElements, routing, rooms } = useSmartDrawingStore((state) => ({
    settings: state.condensateSettings,
    setSettings: state.setCondensateSettings,
    hvacElements: state.hvacElements,
    routing: state.pipeRoutingSettings,
    rooms: state.rooms,
  }), shallow);
  const preview = useCondensatePreviewStore((state) => state.result);
  const blockingIssue = useCondensatePreviewStore((state) => state.unified?.blockingIssues?.[0]);
  const running = useCondensatePreviewStore((state) => state.running);
  const message = useCondensatePreviewStore((state) => state.message);
  const approved = useCondensatePreviewStore((state) => state.approvedHopKeys);
  const toggleHop = useCondensatePreviewStore((state) => state.toggleHop);
  const setHighlight = useCondensatePreviewStore((state) => state.setHighlightUnit);
  const [copied, setCopied] = useState(false);
  const system = useHvacUnitSystem();
  const ip = system === 'ip';

  const envelope = useMemo(() => deriveCondensateEnvelope(hvacElements, settings, routing, rooms), [hvacElements, settings, routing, rooms]);
  const committedBom = useMemo(() => buildCondensateBom(hvacElements.filter(isCondensateElement), settings), [hvacElements, settings]);
  const bom = preview?.bom ?? committedBom;
  const gullyCount = hvacElements.filter((element) => element.type === 'condensate-gully').length;
  // (While a run goes on, what it shows is only to look at: Apply and Discard wait for its answer.)
  const applyIssue = running ? undefined : blockingIssue ?? (preview?.hopProposals.some((hop) => !approved.includes(hop.key))
    ? 'Review and approve the required refrigerant hops before applying.' : undefined);

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-lg bg-sky-50 p-2 text-xs leading-5 text-sky-900">
        <p className="font-medium">Ceiling void {Math.round(envelope.ceilingPlaneMm)}–{Math.round(envelope.soffitMm)} mm</p>
        <p className="text-sky-800/80">{envelope.derivation}</p>
        <div className="mt-1.5 grid grid-cols-2 gap-2">
          <label className="flex min-w-0 flex-col gap-1">Ceiling
            <input type="number" step={10} placeholder="auto" value={settings.ceilingPlaneMm ?? ''}
              onChange={(event) => setSettings({ ceilingPlaneMm: event.target.value.trim() === '' ? null : Number.parseFloat(event.target.value) })}
              className="min-w-0 w-full rounded border border-sky-200 bg-white px-1.5 py-0.5 text-right" />
          </label>
          <label className="flex min-w-0 flex-col gap-1">Soffit
            <input type="number" step={10} placeholder="auto" value={settings.soffitMm ?? ''}
              onChange={(event) => setSettings({ soffitMm: event.target.value.trim() === '' ? null : Number.parseFloat(event.target.value) })}
              className="min-w-0 w-full rounded border border-sky-200 bg-white px-1.5 py-0.5 text-right" />
          </label>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={running || !gullyCount} onClick={() => runAutoRoute({ services: { gas: false, liquid: false, condensate: true }, scope: 'drawing', profile })}
          className="rounded-lg bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-800 disabled:opacity-40">
          {running ? 'Calculating…' : preview ? 'Regenerate' : 'Generate network'}
        </button>
        {preview && !running ? (
          <>
            <button type="button" onClick={() => applyAutoRoutePreview()} disabled={Boolean(applyIssue)} title={applyIssue}
              className="rounded-lg bg-teal-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-800 disabled:opacity-40">Apply</button>
            <button type="button" onClick={discardAutoRoutePreview} className="rounded-lg px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-100">Discard</button>
          </>
        ) : null}
      </div>
      {!gullyCount ? <p className="text-xs text-slate-500">Place a floor gully, stack connection or external discharge from the Condensate Drainage palette first.</p> : null}
      <DrainPipeSeries />

      {message ? <p role="status" className="rounded-md bg-slate-50 p-2 text-xs leading-4 text-slate-700">{toDisplayText(message, system)}</p> : null}
      {applyIssue && !message ? <p role="status" className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">{applyIssue}</p> : null}

      {preview ? (
        <div className="space-y-2">
          {preview.issues.map((issue) => <p key={issue} className="rounded-md bg-amber-50 p-2 text-xs text-amber-800">{toDisplayText(issue, system)}</p>)}
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500"><tr><th className="py-1">Unit</th><th>Drain</th><th className="text-right">Run</th><th className="text-right">Margin</th></tr></thead>
            <tbody>
              {preview.perUnit.map((unit) => (
                <tr key={unit.unitId} className="border-t border-slate-100" onMouseEnter={() => setHighlight(unit.unitId)} onMouseLeave={() => setHighlight(null)}>
                  <td className="py-1 pr-1 text-slate-700">{unit.label}</td>
                  <td className={unit.status === 'infeasible' ? 'text-red-700' : unit.status === 'pumped' ? 'text-indigo-700' : unit.status === 'gravity' ? 'text-green-700' : 'text-slate-500'} title={unit.reason}>
                    {unit.status === 'gravity' ? 'Gravity' : unit.status === 'pumped' ? `Pump +${Math.round(unit.liftMm)}` : unit.status === 'infeasible' ? `Short ${unit.shortfallMm ?? '?'} mm` : 'Skipped'}
                  </td>
                  <td className="text-right text-slate-600">{unit.lengthMm ? `${(unit.lengthMm / 1000).toFixed(1)} m` : '–'}</td>
                  <td className="text-right text-slate-600">{unit.status === 'gravity' || unit.status === 'pumped' ? `${Math.round(unit.headMarginMm)} mm` : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.networks.map((network) => (
            <p key={network.networkId} className="text-xs text-slate-600">
              {network.gullyLabel}: {network.unitIds.length} unit{network.unitIds.length === 1 ? '' : 's'}, main fall {formatFallRatio(network.mainSlopePercent)} ({ip ? slopeText(network.mainSlopePercent) : `${network.mainSlopePercent.toFixed(2)} %`})
            </p>
          ))}
          {preview.crossings.length ? (
            <p className="text-xs text-slate-600">
              Refrigerant crossings: {preview.crossings.filter((c) => c.relation === 'below').length} below, {preview.crossings.filter((c) => c.relation === 'above').length} above, {preview.hopProposals.length} need a hop.
            </p>
          ) : null}
          {preview.hopProposals.length ? (
            <div className="space-y-1 rounded-md border border-fuchsia-200 bg-fuchsia-50 p-2 text-xs text-fuchsia-900">
              <p className="font-medium">Refrigerant hops (gravity drainage has priority)</p>
              <p className="text-fuchsia-800/80">The drain cannot pass below or above these runs. Approve a hop to raise the refrigerant over the drain with plumb risers. Approved hops mark that refrigerant run as field-edited.</p>
              {preview.hopProposals.map((hop) => (
                <label key={hop.key} className="flex items-center gap-2">
                  <input type="checkbox" checked={approved.includes(hop.key)} disabled={!hop.withinSoffit} onChange={() => toggleHop(hop.key)} />
                  <span>{hop.refrigerantElementId.slice(0, 10)} → centreline ≥ {Math.round(hop.requiredCentrelineZ)} mm{hop.withinSoffit ? '' : ' (no room below soffit)'}</span>
                </label>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <details>
        <summary className="cursor-pointer py-1 text-xs font-medium text-slate-700">Design rules</summary>
        <div className="divide-y divide-amber-100/70">
          {NUMBER_ROWS.map((row) => {
            // In IP a fall is typed in in/ft and a thickness in inches (to the thousandth); the settings keep % and mm.
            const asIp = ip && row.ip ? row.ip : null;
            return (
              <SettingRow key={row.key} label={row.label} value={asIp ? Number(toDisplay(asIp.kind, settings[row.key], 'ip').toFixed(3)) : settings[row.key]}
                unit={asIp ? unitLabel(asIp.kind, 'ip') : row.unit} step={asIp ? asIp.step : row.step}
                modified={settings[row.key] !== DEFAULT_CONDENSATE_SETTINGS[row.key]}
                source={CONDENSATE_RULE_SOURCES[row.key] ? `${CONDENSATE_RULE_SOURCES[row.key]!.source}${CONDENSATE_RULE_SOURCES[row.key]!.verified ? '' : ' (unverified — confirm for this project)'}` : undefined}
                onCommit={(value) => setSettings({ [row.key]: asIp ? Math.round(fromDisplay(asIp.kind, value, 'ip') * 1e4) / 1e4 : value } as Partial<CondensateDesignSettings>)} />
            );
          })}
          <label className="flex items-center justify-between py-1.5 text-sm text-slate-600">Grouped main min. OD{ip ? ' (in)' : ''}
            <input type="number" step={ip ? 0.125 : 1} placeholder="off"
              value={settings.groupedMainMinOuterDiameterMm === null ? '' : ip ? Number((settings.groupedMainMinOuterDiameterMm / 25.4).toFixed(3)) : settings.groupedMainMinOuterDiameterMm}
              onChange={(event) => {
                const typed = Number.parseFloat(event.target.value);
                setSettings({ groupedMainMinOuterDiameterMm: event.target.value.trim() === '' || !Number.isFinite(typed) ? null : ip ? Math.round(typed * 25.4 * 100) / 100 : typed });
              }}
              className="w-20 rounded border border-amber-200/80 bg-white px-2 py-1 text-right text-sm" />
          </label>
          {([
            ['airVentForPumpedMains', 'Air vent at head of pumped mains'],
            ['trapNegativePressureUnits', 'P-trap on negative-pressure units'],
            ['showFallTags', 'Show fall tags'],
            ['showLevelTags', 'Show invert levels'],
            ['showHangers', 'Show hangers'],
          ] as const).map(([key, label]) => (
            <label key={key} className="flex items-center justify-between py-1.5 text-sm text-slate-600">{label}
              <input type="checkbox" checked={settings[key]} onChange={(event) => setSettings({ [key]: event.target.checked } as Partial<CondensateDesignSettings>)} />
            </label>
          ))}
          <p className="py-2 text-[11px] leading-4 text-slate-400">
            Sizing: {CONDENSATE_RULE_SOURCES.capacityTable?.source} — {CONDENSATE_RULE_SOURCES.capacityTable?.note}
          </p>
          <button type="button" onClick={() => setSettings({ ...DEFAULT_CONDENSATE_SETTINGS })} className="py-1 text-xs text-sky-700 hover:underline">Reset to defaults</button>
        </div>
      </details>

      {bom.length ? (
        <details>
          <summary className="cursor-pointer py-1 text-xs font-medium text-slate-700">Bill of materials{preview ? ' (preview)' : ''}</summary>
          <table className="w-full text-left text-xs">
            <tbody>
              {bom.map((source) => condensateBomRowIn(source, system)).map((row, index) => (
                <tr key={index} className="border-t border-slate-100">
                  <td className="py-1 pr-1 text-slate-700">{row.description}</td>
                  <td className="text-slate-500">{row.size}</td>
                  <td className="text-right text-slate-700">{row.quantity} {row.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="mt-1 text-xs text-sky-700 hover:underline" onClick={() => {
            void navigator.clipboard?.writeText(condensateBomToCsv(bom, system)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
          }}>{copied ? 'Copied' : 'Copy CSV'}</button>
        </details>
      ) : null}
    </div>
  );
}
