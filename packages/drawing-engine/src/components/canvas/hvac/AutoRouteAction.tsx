'use client';

/**
 * One Auto route for supply and return ducts, gas, liquid and condensate. The
 * ticks choose the services (and double as the colour legend: duct swatches,
 * pipe dots); one run routes them in coordinated order (ducts, refrigerant,
 * condensate), previews the result with a cross-service clash list, and Apply
 * commits everything as a single undo step.
 */
import { AlertTriangle, Check, ChevronDown, Loader2, SlidersHorizontal, Wand2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useSmartDrawingStore } from '../../../store';
import type { ManufacturerRuleProfile } from '../../../vrf/rules';

import { AutoRouteResultPanel } from './AutoRouteResultPanel';
import { applyAutoRoutePreview, cancelAutoRoute, discardAutoRoutePreview, runAutoRoute } from './autoRouteController';
import { autoRouteDuctFeedback } from './autoRouteDuctFeedback';
import type { AutoRouteCostRates } from './autoRouteEvaluation';
import { buildAutoRouteReview } from './autoRouteReview';
import {
  readStoredAutoRouteServices,
  storeAutoRouteServices,
  useCondensatePreviewStore,
} from './condensate/condensatePreviewStore';
import { formatFallRatio } from './condensate/condensateSettings';
import { AUTO_DUCT_SHAPE_OPTIONS } from './duct/DuctAutoCard';
import type { AutoDuctShape } from './duct/ductAutoLayout';
import { FAN_SPEED_LABELS, FAN_SPEEDS, type FanSpeed } from './duct/ductSizing';
import { wantsDucts, type AutoRouteServices } from './unifiedAutoRoute';

const RATE_FIELDS = [
  ['gasPipePerMetre', 'Gas pipe + insulation / m'],
  ['liquidPipePerMetre', 'Liquid pipe + insulation / m'],
  ['elbowEach', 'Installed bends / 90° equivalent'],
  ['branchPairEach', 'Installed branch kit pair'],
  ['riserEach', 'Extra installation / riser'],
] as const;
type Objective = 'balanced' | 'cost' | 'fewest-fittings';
type RateDraft = Record<(typeof RATE_FIELDS)[number][0] | 'currency', string>;
const EMPTY_RATES: RateDraft = { currency: '', gasPipePerMetre: '', liquidPipePerMetre: '', elbowEach: '', branchPairEach: '', riserEach: '' };

type ServiceKey = keyof AutoRouteServices;
interface ServiceTick { key: ServiceKey; label: string; aria: string; hint: string; swatch: string }
/** Ducts: a duct-section swatch in the plan colour of the service. */
const DUCT_TICKS: ServiceTick[] = [
  { key: 'supplyDuct', label: 'Supply', aria: 'Route supply ducts', hint: 'Supply ducts from each ducted unit to its supply terminals — the optimiser\'s best life-cycle design', swatch: 'border-blue-700 bg-blue-500/15' },
  { key: 'returnDuct', label: 'Return', aria: 'Route return ducts', hint: 'Return ducts from each ducted unit\'s return terminals (grilles and return diffusers) back to its return collar', swatch: 'border-teal-700 bg-teal-500/15' },
];
/** Pipes: a dot in the plan colour of the line. */
const PIPE_TICKS: ServiceTick[] = [
  { key: 'gas', label: 'Gas', aria: 'Route gas pipes', hint: 'Refrigerant gas line', swatch: 'text-orange-600' },
  { key: 'liquid', label: 'Liquid', aria: 'Route liquid pipes', hint: 'Refrigerant liquid line', swatch: 'text-blue-600' },
  { key: 'condensate', label: 'Condensate', aria: 'Route condensate pipes', hint: 'Condensate drains to the gullies, by gravity', swatch: 'text-sky-500' },
];
const ALL_SERVICES: AutoRouteServices = { gas: true, liquid: true, condensate: true, supplyDuct: true, returnDuct: true };

function ServiceChip({ tick, checked, disabled, onToggle, duct }: { tick: ServiceTick; checked: boolean; disabled: boolean; onToggle: () => void; duct: boolean }) {
  return (
    <label title={tick.hint}
      className={`flex cursor-pointer items-center gap-1 rounded-md border px-1.5 py-1 text-xs transition-colors ${checked ? 'border-slate-300 bg-white text-slate-800 shadow-sm' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
      <input type="checkbox" className="h-3.5 w-3.5 accent-teal-700" checked={checked} disabled={disabled} onChange={onToggle} aria-label={tick.aria} />
      {duct
        ? <span className={`inline-block h-2.5 w-3.5 rounded-[2px] border-[1.5px] ${tick.swatch} ${checked ? '' : 'opacity-50'}`} aria-hidden="true" />
        : <span className={tick.swatch} aria-hidden="true">●</span>}
      {tick.label}
    </label>
  );
}

export function AutoRouteAction({ profile, disabled = false }: { profile?: ManufacturerRuleProfile; disabled?: boolean }) {
  const unified = useCondensatePreviewStore((state) => state.unified);
  const running = useCondensatePreviewStore((state) => state.running);
  const progress = useCondensatePreviewStore((state) => state.progress);
  const message = useCondensatePreviewStore((state) => state.message);
  const setMessage = useCondensatePreviewStore((state) => state.setMessage);
  const approved = useCondensatePreviewStore((state) => state.approvedHopKeys);
  const toggleHop = useCondensatePreviewStore((state) => state.toggleHop);
  const condensateSettings = useSmartDrawingStore((state) => state.condensateSettings);
  const ductSettings = useSmartDrawingStore((state) => state.ductSettings);
  const setDuctSettings = useSmartDrawingStore((state) => state.setDuctSettings);
  const setCondensateSettings = useSmartDrawingStore((state) => state.setCondensateSettings);
  const [services, setServices] = useState<AutoRouteServices>(ALL_SERVICES);
  const [ductShape, setDuctShape] = useState<AutoDuctShape>('optimal');
  const [ductFanSpeed, setDuctFanSpeed] = useState<FanSpeed>('hi');
  const [ductRebuild, setDuctRebuild] = useState(false);
  const [objective, setObjective] = useState<Objective>('balanced');
  const [scope, setScope] = useState<'drawing' | 'selection'>('drawing');
  const [rebuildExisting, setRebuildExisting] = useState(true);
  const [useRates, setUseRates] = useState(false);
  const [rateDraft, setRateDraft] = useState<RateDraft>(EMPTY_RATES);
  const [showOptions, setShowOptions] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelLeft, setPanelLeft] = useState(0);

  useEffect(() => { setServices(readStoredAutoRouteServices()); }, []);
  useLayoutEffect(() => {
    const place = () => {
      if (!anchorRef.current || !panelRef.current) return;
      const anchor = anchorRef.current.getBoundingClientRect();
      const width = panelRef.current.getBoundingClientRect().width;
      setPanelLeft(Math.max(12 - anchor.left, Math.min(0, window.innerWidth - 12 - width - anchor.left)));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [showOptions, showDetails, unified]);

  const toggleService = (key: ServiceKey) => {
    const next = { ...services, [key]: !services[key] };
    setServices(next);
    storeAutoRouteServices(next);
    if (unified) {
      discardAutoRoutePreview();
      setMessage('Services changed. Run Auto route to update the preview.');
    }
  };
  const ductsTicked = wantsDucts(services);
  const nothingTicked = !services.gas && !services.liquid && !services.condensate && !ductsTicked;

  const route = () => {
    let rates: AutoRouteCostRates | undefined;
    if (useRates && (services.gas || services.liquid)) {
      const values = RATE_FIELDS.map(([key]) => (rateDraft[key].trim() ? Number(rateDraft[key]) : Number.NaN));
      if (!/^[A-Za-z]{3}$/.test(rateDraft.currency.trim()) || values.some((value) => !Number.isFinite(value) || value < 0 || value > 1e9)) {
        setMessage('Enter a three-letter currency and all five rates, or turn off project rates.');
        setShowOptions(true);
        return;
      }
      rates = {
        currency: rateDraft.currency.trim().toUpperCase(),
        gasPipePerMetre: values[0]!, liquidPipePerMetre: values[1]!, elbowEach: values[2]!, branchPairEach: values[3]!, riserEach: values[4]!,
      };
    }
    setShowOptions(false);
    setShowDetails(false);
    runAutoRoute({ services, scope, profile, objective, rates, rebuildExisting, duct: { shape: ductShape, fanSpeed: ductFanSpeed, rebuildExisting: ductRebuild } });
  };

  const ducts = unified?.ducts ?? null;
  const refrigerant = unified?.refrigerant ?? null;
  const condensate = unified?.condensate ?? null;
  const refrigerantChanges = refrigerant ? refrigerant.elementsToAdd.length + refrigerant.removeElementIds.length + refrigerant.updates.length : 0;
  const condensateChanges = condensate ? condensate.elementsToAdd.length + condensate.removeElementIds.length : 0;
  const ductChanges = ducts ? ducts.elementsToAdd.length + ducts.removeElementIds.length + ducts.terminalUpdates.length : 0;
  const ductFeedback = autoRouteDuctFeedback(ducts);
  const ductsNeedAttention = ductFeedback?.needsAttention ?? false;
  const hasChanges = ductChanges + refrigerantChanges + condensateChanges > 0;
  const pendingHops = condensate?.hopProposals.filter((proposal) => !approved.includes(proposal.key)).length ?? 0;
  const review = unified ? buildAutoRouteReview(unified, approved) : null;
  const applyReason = review?.applyReason ?? null;
  const summary = unified ? [
    review?.state === 'blocked' ? 'Needs review' : review?.state === 'ready' ? 'Preview ready' : 'No new routes',
    ductFeedback?.summary,
    refrigerant && !refrigerantChanges ? 'refrigerant unchanged' : null,
    refrigerant && refrigerantChanges ? `refrigerant ${refrigerant.connectedIndoorIds.length}/${refrigerant.connectedIndoorIds.length + refrigerant.unconnectedIndoorIds.length}` : null,
    condensate ? `drains ${condensate.metrics.unitsConnected}/${condensate.metrics.unitsTotal}${condensate.networks.length ? ` · ${formatFallRatio(Math.min(...condensate.networks.map((network) => network.mainSlopePercent)))}` : ''}` : null,
    pendingHops ? `${pendingHops} hop${pendingHops === 1 ? '' : 's'} to approve` : null,
  ].filter(Boolean).join(' · ') : null;
  // A message (e.g. why Apply was refused) outranks the preview summary until the next run.
  const status = running ? progress?.stage ?? 'Calculating…' : message ?? summary;

  useEffect(() => {
    if (!unified) { setShowDetails(false); return; }
    if (running || (!ductsNeedAttention && !applyReason)) return;
    setShowOptions(false);
    setShowDetails(true);
  }, [unified, running, ductsNeedAttention, applyReason]);

  return (
    <div ref={anchorRef} className="relative flex flex-wrap items-center gap-1.5" data-testid="auto-route-action"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        if (running) cancelAutoRoute();
        else { setShowOptions(false); setShowDetails(false); }
      }}>
      <span className="flex min-w-0 max-w-full flex-wrap items-center gap-1" role="group" aria-label="Services to route">
        <span className="flex items-center gap-0.5 rounded-lg bg-slate-50 p-0.5" role="group" aria-label="Ducts">
          <span className="px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400" aria-hidden="true">Duct</span>
          {DUCT_TICKS.map((tick) => (
            <ServiceChip key={tick.key} tick={tick} duct checked={Boolean(services[tick.key])} disabled={running} onToggle={() => toggleService(tick.key)} />
          ))}
        </span>
        <span className="flex items-center gap-0.5 rounded-lg bg-slate-50 p-0.5" role="group" aria-label="Pipes">
          <span className="px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400" aria-hidden="true">Pipe</span>
          {PIPE_TICKS.map((tick) => (
            <ServiceChip key={tick.key} tick={tick} duct={false} checked={Boolean(services[tick.key])} disabled={running} onToggle={() => toggleService(tick.key)} />
          ))}
        </span>
      </span>
      <button type="button" onClick={running ? cancelAutoRoute : route} disabled={(disabled || nothingTicked) && !running}
        title={nothingTicked ? 'Tick at least one service' : 'Route the ticked services together (ducts, then refrigerant, then condensate), clash-checked against each other; preview before applying'}
        className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-teal-800 disabled:opacity-40">
        {running ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
        {running ? 'Cancel' : unified ? 'Route again' : 'Auto route'}
      </button>
      {unified && !running ? (
        <>
          <button type="button" onClick={() => applyAutoRoutePreview()} disabled={!hasChanges || Boolean(applyReason)}
            title={applyReason ?? (hasChanges ? 'Commit every ticked service (and the approved hops) as one undo step' : 'Nothing to apply — open the status for the reason')}
            className="inline-flex items-center gap-1 rounded-lg bg-sky-700 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-sky-800 disabled:opacity-40">
            <Check size={13} /> Apply
          </button>
          <button type="button" onClick={discardAutoRoutePreview}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-100">
            <X size={13} /> Discard
          </button>
        </>
      ) : null}
      <button type="button" aria-label="Auto route options" aria-expanded={showOptions} disabled={running}
        onClick={() => { setShowOptions(!showOptions); setShowDetails(false); }} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40">
        <SlidersHorizontal size={14} />
      </button>
      {status ? (
        <span role="status" aria-live="polite" className="min-w-0">
          <button type="button" onClick={() => { if (unified) { setShowOptions(false); setShowDetails(!showDetails); } }} aria-expanded={showDetails}
            className={`flex max-w-[24rem] items-center gap-1 px-1 text-left text-xs ${applyReason || ductsNeedAttention ? 'text-amber-800' : 'text-slate-600'} ${unified ? 'hover:underline' : ''}`} title={status}>
            {!running && (applyReason || ductsNeedAttention) ? <AlertTriangle size={13} className="shrink-0" aria-hidden="true" /> : null}
            <span className="truncate">{status}</span>
            {unified && !running ? <ChevronDown size={13} className="shrink-0" aria-hidden="true" /> : null}
          </button>
        </span>
      ) : null}

      {showOptions || showDetails ? (
        <div ref={panelRef} style={{ left: panelLeft }}
          className="absolute top-full z-30 mt-2 max-h-[min(78vh,720px)] w-[400px] max-w-[calc(100vw-24px)] space-y-3 overflow-auto rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-lg">
          <div className="sticky -top-3 z-10 -mx-3 -mt-3 flex items-center justify-between border-b border-slate-100 bg-white px-3 py-2 font-semibold text-slate-800">
            {showOptions ? 'Auto route options' : 'Auto route result'}
            <button type="button" aria-label="Close" onClick={() => { setShowOptions(false); setShowDetails(false); }} className="p-1 text-slate-400"><X size={14} /></button>
          </div>
          {showOptions ? (
            <>
              <label className="block space-y-1 text-slate-600">
                <span>Units</span>
                <select value={scope} onChange={(event) => setScope(event.target.value as 'drawing' | 'selection')} className="w-full rounded-md border border-slate-200 p-2">
                  <option value="drawing">All units in the drawing</option>
                  <option value="selection">Selected units (and their selected gullies, diffusers, grilles)</option>
                </select>
              </label>
              <ol className="space-y-0.5 rounded-md bg-slate-50 p-2 leading-4 text-slate-500">
                <li><span className="font-medium text-slate-600">1 · Ducts</span> — each ducted unit to its terminals, the optimiser's best life-cycle design.</li>
                <li><span className="font-medium text-slate-600">2 · Refrigerant</span> — around the ducts; gas and liquid as a pair (one ticked keeps room for the other).</li>
                <li><span className="font-medium text-slate-600">3 · Condensate</span> — falls to its gullies around both (below, else above, else a hop you approve).</li>
                <li>Everything new is clash-checked in 3D against the rest before you apply.</li>
              </ol>
              <fieldset className="space-y-2" disabled={!ductsTicked}>
                <legend className="font-medium text-slate-700">Ducts</legend>
                <div className="space-y-1 text-slate-600">
                  <span>Trunk shape</span>
                  <div className="grid grid-cols-3 gap-0.5 rounded-md border border-slate-200 bg-white p-0.5" role="radiogroup" aria-label="Auto route duct shape">
                    {AUTO_DUCT_SHAPE_OPTIONS.map((option) => (
                      <button key={option.key} type="button" role="radio" aria-checked={ductShape === option.key} title={option.hint} onClick={() => setDuctShape(option.key)}
                        className={`flex items-center justify-center gap-1 rounded px-1 py-1 text-[11px] ${ductShape === option.key ? 'bg-sky-700 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
                        {option.icon}{option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="flex items-center justify-between gap-3 text-slate-600">
                  <span>Sizing</span>
                  <select value={ductSettings.autoSizingMethod} aria-label="Auto route duct sizing"
                    onChange={(event) => setDuctSettings({ autoSizingMethod: event.target.value as typeof ductSettings.autoSizingMethod })}
                    className="rounded-md border border-slate-200 p-1.5"
                    title="Constant friction sizes at the project's friction rates and velocity limits (Duct Systems settings); the Auto duct card sets them per unit">
                    <option value="life-cycle">Life-cycle optimum</option>
                    <option value="constant-friction">Constant friction · {ductSettings.autoFrictionSupplyPaPerM.toFixed(2)} Pa/m</option>
                  </select>
                </label>
                <label className="flex items-center justify-between gap-3 text-slate-600">
                  <span>Fan speed (airflow)</span>
                  <select value={ductFanSpeed} onChange={(event) => setDuctFanSpeed(event.target.value as FanSpeed)} aria-label="Auto route duct fan speed"
                    className="rounded-md border border-slate-200 p-1.5">
                    {FAN_SPEEDS.map((speed) => <option key={speed} value={speed}>{FAN_SPEED_LABELS[speed]}</option>)}
                  </select>
                </label>
                <label className="flex items-start gap-2 text-slate-600">
                  <input type="checkbox" checked={ductRebuild} onChange={(event) => setDuctRebuild(event.target.checked)} className="mt-0.5" aria-label="Auto route rebuild existing ducts" />
                  <span>Rebuild existing ducts (replace the run on a collar and its branches)</span>
                </label>
                <p className="leading-4 text-slate-500">Costs, sizes and the frontier of each unit: select it and use the Auto duct card.</p>
              </fieldset>
              <fieldset className="space-y-2" disabled={!services.gas && !services.liquid}>
                <legend className="font-medium text-slate-700">Refrigerant</legend>
                <label className="block space-y-1 text-slate-600">
                  <span>Optimize for</span>
                  <select value={objective} onChange={(event) => setObjective(event.target.value as Objective)} className="w-full rounded-md border border-slate-200 p-2">
                    <option value="balanced">Balanced cost and routing</option>
                    <option value="cost">Lowest estimated installation cost</option>
                    <option value="fewest-fittings">Fewest fittings, then shortest runs</option>
                  </select>
                </label>
                <label className="flex items-start gap-2 text-slate-600">
                  <input type="checkbox" checked={rebuildExisting} onChange={(event) => setRebuildExisting(event.target.checked)} className="mt-0.5" />
                  <span>Optimize eligible complete layouts (manual edits and locks are kept)</span>
                </label>
                <label className="flex items-center gap-2 text-slate-600">
                  <input type="checkbox" checked={useRates} onChange={(event) => setUseRates(event.target.checked)} /> Use project installation rates
                </label>
                {useRates ? (
                  <div className="space-y-2 rounded-lg bg-slate-50 p-2">
                    <label className="flex items-center justify-between gap-3 text-slate-600">Currency
                      <input aria-label="Cost currency" value={rateDraft.currency} maxLength={3} placeholder="e.g. EUR"
                        onChange={(event) => setRateDraft({ ...rateDraft, currency: event.target.value.toUpperCase() })}
                        className="w-24 rounded border border-slate-200 px-2 py-1" />
                    </label>
                    {RATE_FIELDS.map(([key, label]) => (
                      <label key={key} className="flex items-center justify-between gap-3 text-slate-600">{label}
                        <input aria-label={label} type="number" min={0} step="any" value={rateDraft[key]}
                          onChange={(event) => setRateDraft({ ...rateDraft, [key]: event.target.value })}
                          className="w-24 rounded border border-slate-200 px-2 py-1 text-right" />
                      </label>
                    ))}
                  </div>
                ) : null}
                <p className="leading-4 text-slate-500">Rules: {profile?.family ?? 'Current project defaults'}.</p>
              </fieldset>
              <fieldset className="space-y-2" disabled={!services.condensate}>
                <legend className="font-medium text-slate-700">Condensate</legend>
                <label className="block space-y-1 text-slate-600">
                  <span>Drain pumps</span>
                  <select value={condensateSettings.pumpPolicy} onChange={(event) => setCondensateSettings({ pumpPolicy: event.target.value as typeof condensateSettings.pumpPolicy })} className="w-full rounded-md border border-slate-200 p-2">
                    <option value="always">Rise to the high point at the unit</option>
                    <option value="when-needed">Lift only as high as the fall needs</option>
                    <option value="never">Gravity only (ignore pumps)</option>
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1 text-slate-600">
                    <span>Minimum fall %</span>
                    <input type="number" step={0.1} min={0.25} value={condensateSettings.minSlopePercent}
                      onChange={(event) => { const value = Number.parseFloat(event.target.value); if (Number.isFinite(value)) setCondensateSettings({ minSlopePercent: value }); }}
                      className="w-full rounded-md border border-slate-200 p-1.5" />
                  </label>
                  <label className="space-y-1 text-slate-600">
                    <span>Preferred fall %</span>
                    <input type="number" step={0.1} min={0.25} value={condensateSettings.preferredSlopePercent}
                      onChange={(event) => { const value = Number.parseFloat(event.target.value); if (Number.isFinite(value)) setCondensateSettings({ preferredSlopePercent: value }); }}
                      className="w-full rounded-md border border-slate-200 p-1.5" />
                  </label>
                </div>
                <label className="block space-y-1 text-slate-600">
                  <span>Pipe system</span>
                  <select value={condensateSettings.pipeSystem} onChange={(event) => setCondensateSettings({ pipeSystem: event.target.value as typeof condensateSettings.pipeSystem })} className="w-full rounded-md border border-slate-200 p-2">
                    <option value="bs-en-1329">Metric uPVC waste (BS EN 1329)</option>
                    <option value="jis-vp">JIS PVC VP</option>
                    <option value="astm-sch40">PVC Schedule 40 (ASTM)</option>
                  </select>
                </label>
              </fieldset>
              <button type="button" onClick={route} disabled={nothingTicked} className="w-full rounded-lg bg-teal-700 py-2 font-medium text-white hover:bg-teal-800 disabled:opacity-40">Auto route</button>
            </>
          ) : unified ? (
            <AutoRouteResultPanel result={unified} approved={approved} toggleHop={toggleHop} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
