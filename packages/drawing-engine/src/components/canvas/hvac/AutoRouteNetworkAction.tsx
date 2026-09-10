'use client';

import { Loader2, SlidersHorizontal, Wand2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useSmartDrawingStore } from '../../../store';
import type { ManufacturerRuleProfile } from '../../../vrf/rules';

import { autoRouteSourceSignature, prepareAutoRouteCommand } from './autoRouteCommand';
import type { AutoRouteCostRates } from './autoRouteEvaluation';
import type { AutoRouteNetworkProgress } from './autoRouteNetwork';
import type { AutoRouteNetworkResult, AutoRouteWorkerRequest, AutoRouteWorkerResponse } from './autoRouteWorkerProtocol';

const RATE_FIELDS = [
  ['gasPipePerMetre', 'Gas pipe + insulation / m'],
  ['liquidPipePerMetre', 'Liquid pipe + insulation / m'],
  ['elbowEach', 'Installed bends / 90° equivalent'],
  ['branchPairEach', 'Installed branch kit pair'],
  ['riserEach', 'Extra installation / riser'],
] as const;

type Objective = 'balanced' | 'cost' | 'fewest-fittings';
type RateDraft = Record<(typeof RATE_FIELDS)[number][0] | 'currency', string>;
const EMPTY_RATES: RateDraft = {
  currency: '', gasPipePerMetre: '', liquidPipePerMetre: '', elbowEach: '', branchPairEach: '', riserEach: '',
};

/** One click calculates off-thread and commits one undoable network command. */
export function AutoRouteNetworkAction({ profile, disabled = false }: {
  profile?: ManufacturerRuleProfile;
  disabled?: boolean;
}) {
  const [objective, setObjective] = useState<Objective>('balanced');
  const [scope, setScope] = useState<'drawing' | 'selection'>('drawing');
  const [rebuildExisting, setRebuildExisting] = useState(true);
  const [showOptions, setShowOptions] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [useRates, setUseRates] = useState(false);
  const [rateDraft, setRateDraft] = useState<RateDraft>(EMPTY_RATES);
  const [progress, setProgress] = useState<AutoRouteNetworkProgress | null>(null);
  const [result, setResult] = useState<AutoRouteNetworkResult | null>(null);
  const [resultNotApplied, setResultNotApplied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelLeft, setPanelLeft] = useState(0);
  const profileRef = useRef(profile);
  profileRef.current = profile;
  useEffect(() => () => { workerRef.current?.terminate(); workerRef.current = null; }, []);
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
  }, [showOptions, progress, result, message]);

  const cancel = () => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setProgress(null);
    setMessage('Routing cancelled.');
  };

  const route = () => {
    if (workerRef.current || disabled) return;
    let rates: AutoRouteCostRates | undefined;
    if (useRates) {
      const values = RATE_FIELDS.map(([key]) => rateDraft[key].trim() ? Number(rateDraft[key]) : NaN);
      if (!/^[A-Za-z]{3}$/.test(rateDraft.currency.trim())
        || values.some(value => !Number.isFinite(value) || value < 0 || value > 1e9)) {
        setMessage('Enter a three-letter currency and all five rates, or turn off project rates.');
        setShowOptions(true);
        return;
      }
      rates = {
        currency: rateDraft.currency.trim().toUpperCase(),
        gasPipePerMetre: values[0]!, liquidPipePerMetre: values[1]!, elbowEach: values[2]!,
        branchPairEach: values[3]!, riserEach: values[4]!,
      };
    }
    const current = useSmartDrawingStore.getState();
    const selectedIds = scope === 'selection' ? [...current.selectedIds] : undefined;
    if (scope === 'selection' && !selectedIds?.length) {
      setMessage('Select the outdoor and indoor units to route, or choose All units in drawing.');
      return;
    }
    const source = { scene: current.hvacElements, settings: current.pipeRoutingSettings,
      profile: profileRef.current, walls: current.walls };
    const signature = autoRouteSourceSignature(source);
    setResult(null);
    setResultNotApplied(false);
    setMessage(null);
    setShowOptions(false);
    setShowDetails(false);
    setProgress({ completed: 0, total: 0, stage: 'Preparing equipment and routing rules' });
    // End any live manual draft before the generated network is applied.
    current.setTool('select');
    try {
      const worker = new Worker(new URL('./autoRouteNetwork.worker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;
      const stop = () => {
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
        setProgress(null);
      };
      worker.onerror = () => {
        if (workerRef.current !== worker) return;
        stop();
        setMessage('Auto route could not finish. The drawing has been preserved; try again.');
      };
      worker.onmessage = ({ data }: MessageEvent<AutoRouteWorkerResponse>) => {
        if (workerRef.current !== worker) return;
        if (data.type === 'progress') { setProgress(data.progress); return; }
        stop();
        if (data.type === 'error') { setMessage(data.message); return; }
        const latest = useSmartDrawingStore.getState();
        const prepared = prepareAutoRouteCommand(signature, {
          scene: latest.hvacElements, settings: latest.pipeRoutingSettings,
          profile: profileRef.current, walls: latest.walls,
        }, data.result);
        if (prepared.issue) {
          setMessage(prepared.issue);
          if (prepared.issueKind === 'incomplete-network') {
            setResult(data.result);
            setResultNotApplied(true);
          }
          return;
        }
        if (prepared.command) latest.commitHvacElementCommand('Auto route refrigerant network', prepared.command);
        setResult(data.result);
      };
      const request: AutoRouteWorkerRequest = {
        type: 'route', scene: source.scene,
        options: { settings: source.settings, profile: source.profile, objective, rates, selectedIds, walls: source.walls, rebuildExisting },
      };
      worker.postMessage(request);
    } catch {
      workerRef.current?.terminate();
      workerRef.current = null;
      setProgress(null);
      setMessage('Auto route is unavailable in this browser session. Reload and try again.');
    }
  };

  const connected = result?.connectedIndoorIds.length ?? 0;
  const total = connected + (result?.unconnectedIndoorIds.length ?? 0);
  const metrics = resultNotApplied ? null : result?.metrics;
  const remainingUnitLabels = resultNotApplied && result
    ? result.unconnectedIndoorIds.map(id => useSmartDrawingStore.getState().hvacElements.find(element => element.id === id)?.label || id)
    : [];
  const recommendations = result?.evaluations.flatMap(evaluation => evaluation.recommendations) ?? [];
  const preliminary = result?.evaluations.some(evaluation => evaluation.manufacturerQualification === 'preliminary');
  const needsReview = result?.evaluations.some(evaluation => evaluation.hardIssues.length > 0);
  const hasAppliedMutation = Boolean(result && !resultNotApplied
    && (result.elementsToAdd.length || result.removeElementIds.length || result.updates.length));
  const status = message ?? (result
    ? total === 0 ? result.issues[0] ?? 'Place outdoor and indoor units before routing.'
      : `${connected} of ${total} indoor units connected${needsReview ? ' · engineering review required' : result.complete ? (preliminary ? ' · preliminary sizing' : '') : ' · review remaining units'}`
    : null);

  return (
    <div ref={anchorRef} className="relative flex items-center gap-1" data-testid="auto-route-network"
      onKeyDown={event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        if (workerRef.current) cancel();
        else { setShowOptions(false); setResult(null); setMessage(null); }
      }}>
      <button type="button" onClick={progress ? cancel : route} disabled={disabled && !progress}
        title={progress ? 'Cancel network calculation' : 'Calculate paired pipes and copper branch kits; replace eligible layouts in one undoable step'}
        className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-teal-800 disabled:opacity-40">
        {progress ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
        {progress ? 'Cancel routing' : 'Auto route'}
      </button>
      <button type="button" aria-label="Auto route options" aria-expanded={showOptions}
        disabled={Boolean(progress) || disabled} onClick={() => { setShowOptions(!showOptions); setShowDetails(false); }}
        className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40">
        <SlidersHorizontal size={14} />
      </button>
      {(showOptions || progress || status) ? (
        <div ref={panelRef} style={{ left: panelLeft }} className="absolute top-full mt-3 max-h-[min(65vh,520px)] w-[340px] max-w-[calc(100vw-48px)] overflow-auto rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-lg">
          {showOptions ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between font-semibold text-slate-800">
                Auto route options
                <button type="button" aria-label="Close auto route options" onClick={() => setShowOptions(false)} className="p-1 text-slate-400"><X size={14} /></button>
              </div>
              {message ? <p role="status" className="rounded-md bg-amber-50 p-2 leading-4 text-amber-800">{message}</p> : null}
              <label className="block space-y-1 text-slate-600">
                <span>Optimize for</span>
                <select value={objective} onChange={event => setObjective(event.target.value as Objective)} className="w-full rounded-md border border-slate-200 p-2">
                  <option value="balanced">Balanced cost and routing</option>
                  <option value="cost">Lowest estimated installation cost</option>
                  <option value="fewest-fittings">Fewest fittings, then shortest runs</option>
                </select>
              </label>
              <label className="block space-y-1 text-slate-600">
                <span>Equipment</span>
                <select value={scope} onChange={event => setScope(event.target.value as 'drawing' | 'selection')} className="w-full rounded-md border border-slate-200 p-2">
                  <option value="drawing">All units in drawing</option>
                  <option value="selection">Selected outdoor and indoor units</option>
                </select>
              </label>
              <label className="flex items-start gap-2 text-slate-600">
                <input type="checkbox" checked={rebuildExisting} onChange={event => setRebuildExisting(event.target.checked)} className="mt-0.5" />
                <span>Optimize eligible complete layouts<span className="mt-1 block text-[11px] leading-4 text-slate-400">Equipment positions stay fixed. Manual edits to generated routes and route locks are retained. Use Allow auto rerouting in the pipe editor to reconsider retained edits. One undo restores the previous layout.</span></span>
              </label>
              <p className="leading-4 text-slate-500">Rules: {profile?.family ?? 'Current project defaults'}. Multiple outdoor systems use assigned units.</p>
              <label className="flex items-center gap-2 text-slate-600">
                <input type="checkbox" checked={useRates} onChange={event => setUseRates(event.target.checked)} /> Use project installation rates
              </label>
              {useRates ? (
                <div className="space-y-2 rounded-lg bg-slate-50 p-2">
                  <label className="flex items-center justify-between gap-3 text-slate-600">Currency
                    <input aria-label="Cost currency" value={rateDraft.currency} maxLength={3} placeholder="e.g. EUR"
                      onChange={event => setRateDraft({ ...rateDraft, currency: event.target.value.toUpperCase() })}
                      className="w-24 rounded border border-slate-200 px-2 py-1" />
                  </label>
                  {RATE_FIELDS.map(([key, label]) => (
                    <label key={key} className="flex items-center justify-between gap-3 text-slate-600">{label}
                      <input aria-label={label} type="number" min={0} step="any" value={rateDraft[key]}
                        onChange={event => setRateDraft({ ...rateDraft, [key]: event.target.value })}
                        className="w-24 rounded border border-slate-200 px-2 py-1 text-right" />
                    </label>
                  ))}
                  <p className="leading-4 text-slate-500">Blended installed rates for this project. Equipment cost is unchanged.</p>
                </div>
              ) : <p className="leading-4 text-slate-500">Without rates, alternatives use a relative material and fitting cost index.</p>}
              <button type="button" onClick={route} className="w-full rounded-lg bg-teal-700 py-2 font-medium text-white hover:bg-teal-800">Auto route</button>
            </div>
          ) : progress ? (
            <div role="status" aria-live="polite" className="space-y-2 text-slate-600">
              <p>{progress.stage}</p>
              <progress aria-label="Network optimization progress" className="h-1.5 w-full accent-teal-700"
                {...(progress.total > 0 ? { value: progress.completed, max: progress.total } : {})} />
              <p className="text-[11px] text-slate-400">Comparing complete routes. You can keep viewing the drawing.</p>
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <p role="status" className={`leading-5 ${needsReview ? 'text-amber-800' : result?.complete ? 'text-teal-800' : 'text-slate-700'}`}>{status}</p>
                <button type="button" aria-label="Dismiss auto route result" onClick={() => { setResult(null); setMessage(null); }} className="p-1 text-slate-400"><X size={14} /></button>
              </div>
              {metrics ? <p className="mt-1 leading-5 text-slate-500">{(metrics.pipeLengthMm / 1000).toFixed(1)} m of pipe · {metrics.branchPairCount} branch pairs</p> : null}
              {metrics?.estimatedCost != null ? <p className="mt-1 text-slate-600">Estimated installation {metrics.estimatedCost.toLocaleString(undefined, { maximumFractionDigits: 2 })} {metrics.currency}</p> : null}
              {result ? (
                <>
                  <button type="button" aria-expanded={showDetails} onClick={() => setShowDetails(!showDetails)} className="mt-2 text-teal-700 hover:underline">
                    {showDetails ? 'Hide details' : `Details${result.issues.length ? ` · ${result.issues.length} review items` : ''}`}
                  </button>
                  {showDetails ? <div className="mt-2 space-y-2 border-t border-slate-100 pt-2 leading-4 text-slate-500">
                    <p>Compared {result.evaluatedCandidates} candidate networks. {resultNotApplied
                      ? 'The partial proposal was not applied; the existing drawing is unchanged.'
                      : result.complete
                        ? 'Existing valid layouts are kept when no better route is found. Pipe length includes both services. One undo restores the previous network.'
                        : hasAppliedMutation
                          ? 'The best feasible sealed network was applied. Remaining units are unchanged and can be routed after port or branch approach space is available.'
                          : 'Existing valid layouts are kept when no better route is found. Pipe length includes both services. One undo restores the previous network.'}</p>
                    {remainingUnitLabels.length ? <p>Remaining indoor units: {remainingUnitLabels.join(', ')}.</p> : null}
                    {metrics ? <p>{metrics.bendCount.toFixed(1)} bend equivalents (90°) · {metrics.riserCount} service risers. {metrics.estimatedCost == null ? 'Cost comparison uses relative quantities; project prices have not been supplied.' : 'Cost uses the project rates supplied for this run.'}</p> : null}
                    {result.issues.map((issue, index) => <p key={`${index}:${issue}`}>{issue}</p>)}
                    {recommendations.length ? <details>
                      <summary className="cursor-pointer py-1 text-teal-700">{resultNotApplied ? 'Proposed component sizing' : 'Component sizing'} ({recommendations.length})</summary>
                      <div className="mt-2 space-y-2">
                        {recommendations.map((item, index) => <div key={`${item.entityId}:${index}`} className="rounded-md bg-slate-50 p-2">
                          <p className="font-medium text-slate-700">{item.kind === 'pipe' ? 'Pipe' : 'Branch kit'} {index + 1}
                            {item.recommendedDiameterMm != null ? ` · Ø ${item.recommendedDiameterMm} mm` : ''}
                            {item.recommendedModel ? ` · ${item.recommendedModel}` : ''}</p>
                          <p>{item.downstreamCapacityIndex == null ? 'Capacity index needed' : `Downstream capacity index ${item.downstreamCapacityIndex}`}</p>
                          <p>{item.note}</p>
                        </div>)}
                      </div>
                    </details> : null}
                  </div> : null}
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
