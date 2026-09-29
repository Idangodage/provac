'use client';

/**
 * One Auto route for supply and return ducts, gas, liquid and condensate. The
 * ticks choose the services (and double as the colour legend: duct swatches,
 * pipe dots); one run routes them in coordinated order (ducts, refrigerant,
 * condensate), previews the result with a cross-service clash list, and Apply
 * commits everything as a single undo step.
 */
import { Check, Loader2, SlidersHorizontal, Wand2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useSmartDrawingStore } from '../../../store';
import type { ManufacturerRuleProfile } from '../../../vrf/rules';

import { applyAutoRoutePreview, cancelAutoRoute, discardAutoRoutePreview, runAutoRoute } from './autoRouteController';
import type { AutoRouteCostRates } from './autoRouteEvaluation';
import {
  readStoredAutoRouteServices,
  storeAutoRouteServices,
  useCondensatePreviewStore,
} from './condensate/condensatePreviewStore';
import { formatFallRatio } from './condensate/condensateSettings';
import { AUTO_DUCT_SHAPE_OPTIONS } from './duct/DuctAutoCard';
import type { AutoDuctShape } from './duct/ductAutoLayout';
import { formatCost } from './duct/ductEconomics';
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
  { key: 'supplyDuct', label: 'Supply', aria: 'Route supply ducts', hint: 'Supply ducts from each ducted unit to its diffusers — the optimiser\'s best life-cycle design', swatch: 'border-blue-700 bg-blue-500/15' },
  { key: 'returnDuct', label: 'Return', aria: 'Route return ducts', hint: 'Return ducts from each ducted unit to its return grilles', swatch: 'border-teal-700 bg-teal-500/15' },
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
  const openClashes = unified?.clashes.filter((clash) => !clash.resolvedByHop) ?? [];
  const hopClashes = unified?.clashes.filter((clash) => clash.resolvedByHop) ?? [];
  const refrigerantChanges = refrigerant ? refrigerant.elementsToAdd.length + refrigerant.removeElementIds.length + refrigerant.updates.length : 0;
  const condensateChanges = condensate ? condensate.elementsToAdd.length + condensate.removeElementIds.length : 0;
  const ductChanges = ducts ? ducts.elementsToAdd.length + ducts.removeElementIds.length : 0;
  const ductUnits = ducts?.units ?? [];
  const designedUnits = ductUnits.filter((unit) => unit.status === 'designed');
  const hasChanges = ductChanges + refrigerantChanges + condensateChanges > 0;
  const summary = unified ? [
    ducts && ductUnits.length ? `ducts ${designedUnits.length}/${ductUnits.length}` : null,
    ducts && !ductUnits.length && !ducts.issues.length ? 'no ducts to route' : null,
    refrigerant && !refrigerantChanges ? 'refrigerant unchanged' : null,
    refrigerant && refrigerantChanges ? `refrigerant ${refrigerant.connectedIndoorIds.length}/${refrigerant.connectedIndoorIds.length + refrigerant.unconnectedIndoorIds.length}` : null,
    condensate ? `drains ${condensate.metrics.unitsConnected}/${condensate.metrics.unitsTotal}${condensate.networks.length ? ` · ${formatFallRatio(Math.min(...condensate.networks.map((network) => network.mainSlopePercent)))}` : ''}` : null,
    openClashes.length ? `${openClashes.length} clash${openClashes.length === 1 ? '' : 'es'}` : 'no clashes',
    condensate?.hopProposals.length ? `${condensate.hopProposals.length} hop${condensate.hopProposals.length === 1 ? '' : 's'} to approve` : null,
  ].filter(Boolean).join(' · ') : null;
  // A message (e.g. why Apply was refused) outranks the preview summary until the next run.
  const status = running ? progress?.stage ?? 'Calculating…' : message ?? summary;

  return (
    <div ref={anchorRef} className="relative flex flex-wrap items-center gap-1.5" data-testid="auto-route-action"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        if (running) cancelAutoRoute();
        else { setShowOptions(false); setShowDetails(false); }
      }}>
      <span className="flex items-center gap-1" role="group" aria-label="Services to route">
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
          <button type="button" onClick={() => applyAutoRoutePreview()} disabled={!hasChanges}
            title={hasChanges ? 'Commit every ticked service (and the approved hops) as one undo step' : 'Nothing to apply — open the status for the reason'}
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
        <button type="button" onClick={() => unified && setShowDetails(!showDetails)} aria-expanded={showDetails}
          className={`max-w-[24rem] truncate px-1 text-left text-xs ${openClashes.length ? 'text-amber-800' : 'text-slate-600'} ${unified ? 'hover:underline' : ''}`} title={status}>
          {status}
        </button>
      ) : null}

      {showOptions || showDetails ? (
        <div ref={panelRef} style={{ left: panelLeft }}
          className="absolute top-full z-30 mt-2 max-h-[min(65vh,540px)] w-[360px] max-w-[calc(100vw-48px)] space-y-3 overflow-auto rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-lg">
          <div className="flex items-center justify-between font-semibold text-slate-800">
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
            <div className="space-y-2 leading-4 text-slate-600">
              {ducts ? (
                <div data-testid="auto-route-ducts">
                  <p className="font-medium text-slate-800">Ducts</p>
                  {!ductUnits.length ? <p>No ducted unit with free terminals to serve.</p> : null}
                  <ul className="mt-1 space-y-1">
                    {ductUnits.map((unit) => (
                      <li key={unit.unitId} className={`rounded-md border px-2 py-1.5 ${unit.status === 'designed' ? 'border-slate-200' : 'border-amber-200 bg-amber-50/60'}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-slate-800">{unit.unitLabel}</span>
                          <button type="button" className="text-[11px] text-teal-700 hover:underline" title="Select the unit: the Auto duct card shows every design, the frontier and the cost breakdown"
                            onClick={() => useSmartDrawingStore.getState().setSelectedIds([unit.unitId])}>
                            Study
                          </button>
                        </div>
                        {unit.status === 'designed' ? (
                          <>
                            {unit.services.map((service) => (
                              <p key={service.service} className="flex items-center gap-1.5">
                                <span className={`inline-block h-2 w-3 shrink-0 rounded-[2px] border-[1.5px] ${service.service === 'supply' ? 'border-blue-700 bg-blue-500/15' : 'border-teal-700 bg-teal-500/15'}`} aria-hidden="true" />
                                <span>{service.layout} · {service.trunk} · {service.terminals} terminal{service.terminals === 1 ? '' : 's'}</span>
                              </p>
                            ))}
                            <p className="text-slate-500">
                              {unit.requiredEspPa !== null ? `${Math.round(unit.requiredEspPa)}${unit.maxEspPa !== null ? ` / ${unit.maxEspPa}` : ''} Pa` : ''}
                              {unit.firstCost !== null ? ` · ${formatCost(unit.firstCost, unit.currency)} first` : ''}
                              {unit.lifeCycleCost !== null ? ` · ${formatCost(unit.lifeCycleCost, unit.currency)} life-cycle` : ''}
                              {unit.exact === false ? ' · heuristic' : ''}
                            </p>
                            {unit.notes.map((note) => <p key={note} className="text-amber-800">⚠ {note}</p>)}
                          </>
                        ) : (
                          <p className="text-amber-800">Kept as it is — {unit.notes[0] ?? 'no layout could be built.'}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {refrigerant ? (
                <div>
                  <p className="font-medium text-slate-800">Refrigerant{unified.services.gas && unified.services.liquid ? '' : unified.services.gas ? ' (gas line)' : ' (liquid line)'}</p>
                  {refrigerantChanges ? (
                    <p>{refrigerant.connectedIndoorIds.length} unit{refrigerant.connectedIndoorIds.length === 1 ? '' : 's'} connected{refrigerant.unconnectedIndoorIds.length ? `, ${refrigerant.unconnectedIndoorIds.length} not connected` : ''}{refrigerant.metrics ? ` · ${(refrigerant.metrics.pipeLengthMm / 1000).toFixed(1)} m · ${refrigerant.metrics.branchPairCount} branch pairs` : ''}</p>
                  ) : (
                    <p>Kept as it is — the notes say why.</p>
                  )}
                </div>
              ) : null}
              {condensate ? (
                <div>
                  <p className="font-medium text-slate-800">Condensate</p>
                  <p>{condensate.metrics.unitsConnected} of {condensate.metrics.unitsTotal} drains · {(condensate.metrics.pipeLengthMm / 1000).toFixed(1)} m{condensate.metrics.pumpedUnits ? ` · ${condensate.metrics.pumpedUnits} pumped` : ''} · {condensate.crossings.length} refrigerant crossing{condensate.crossings.length === 1 ? '' : 's'}</p>
                </div>
              ) : null}
              <div>
                <p className="font-medium text-slate-800">Clashes between services</p>
                {openClashes.length === 0 && hopClashes.length === 0 ? <p className="text-teal-800">None — everything new clears the rest.</p> : null}
                {openClashes.map((clash, index) => <p key={`o${index}`} className="text-amber-800">⚠ {clash.message}</p>)}
                {hopClashes.map((clash, index) => <p key={`h${index}`}>↑ {clash.message} Resolved when the proposed hop is approved.</p>)}
              </div>
              {condensate?.hopProposals.length ? (
                <div className="space-y-1 rounded-md border border-fuchsia-200 bg-fuchsia-50 p-2 text-fuchsia-900">
                  <p className="font-medium">Refrigerant hops (gravity drainage has priority)</p>
                  {condensate.hopProposals.map((hop) => (
                    <label key={hop.key} className="flex items-center gap-2">
                      <input type="checkbox" checked={approved.includes(hop.key)} disabled={!hop.withinSoffit} onChange={() => toggleHop(hop.key)} />
                      <span>Raise {hop.refrigerantElementId.slice(-6)} to ≥ {Math.round(hop.requiredCentrelineZ)} mm{hop.withinSoffit ? '' : ' (no room below soffit)'}</span>
                    </label>
                  ))}
                </div>
              ) : null}
              {unified.issues.length ? (
                <details><summary className="cursor-pointer text-teal-700">Notes ({unified.issues.length})</summary>
                  {unified.issues.map((issue) => <p key={issue} className="mt-1">{issue}</p>)}
                </details>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
