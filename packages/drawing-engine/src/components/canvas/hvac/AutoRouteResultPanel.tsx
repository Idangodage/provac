'use client';

import { AlertTriangle, CheckCircle2, Circle, Droplets, Focus, Info, Network, Wind } from 'lucide-react';

import { useSmartDrawingStore } from '../../../store';

import { autoRouteDuctFeedback } from './autoRouteDuctFeedback';
import { buildAutoRouteReview, ductUnitReview } from './autoRouteReview';
import { formatCost } from './duct/ductEconomics';
import type { UnifiedAutoRouteResult } from './unifiedAutoRoute';

function inspect(ids: readonly string[]): void {
  const state = useSmartDrawingStore.getState();
  // Proposed IDs are not yet in the model. Select the existing participants
  // only, so reviewing a clash never creates a dangling model selection.
  const existing = new Set(state.hvacElements.map(element => element.id));
  const selected = ids.filter(id => existing.has(id));
  if (!selected.length) return;
  state.setSelectedIds(selected);
  window.dispatchEvent(new Event('smart-drawing:open-properties-panel'));
}

function ServiceCard({ label, value, detail, blocked, icon: Icon }: {
  label: string; value: string; detail: string; blocked: boolean; icon: typeof Wind;
}) {
  return <div className={`min-w-0 rounded-lg border p-2 ${blocked ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-slate-50'}`}>
    <div className="flex items-center gap-1 text-[11px] font-medium text-slate-600"><Icon size={13} aria-hidden="true" />{label}</div>
    <div className={`mt-1 text-lg font-semibold tabular-nums ${blocked ? 'text-amber-900' : 'text-slate-800'}`}>{value}</div>
    <p className="text-[10px] leading-4 text-slate-600">{detail}</p>
  </div>;
}

export function AutoRouteResultPanel({ result, approved, toggleHop }: {
  result: UnifiedAutoRouteResult; approved: readonly string[]; toggleHop: (key: string) => void;
}) {
  const existingElements = useSmartDrawingStore(state => state.hvacElements);
  const existingIds = new Set(existingElements.map(element => element.id));
  const review = buildAutoRouteReview(result, approved);
  const { ducts, refrigerant, condensate } = result;
  const equipmentToReview = refrigerant?.connectedIndoorIds.find(id => existingIds.has(id));
  const feedback = autoRouteDuctFeedback(ducts);
  const activeCount = [ducts, refrigerant, condensate].filter(Boolean).length;
  const StatusIcon = review.state === 'blocked' ? AlertTriangle : review.state === 'ready' ? CheckCircle2 : Circle;
  return <div className="space-y-3 leading-4 text-slate-600" data-testid="auto-route-review">
    <div className={`flex items-start gap-2 rounded-lg border p-2.5 ${review.state === 'blocked'
      ? 'border-amber-200 bg-amber-50 text-amber-900' : review.state === 'ready'
        ? 'border-teal-200 bg-teal-50 text-teal-900' : 'border-slate-200 bg-slate-50 text-slate-700'}`} role="status">
      <StatusIcon size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div><p className="font-semibold">{review.state === 'blocked' ? 'Resolve before applying' : review.state === 'ready' ? 'Preview ready' : 'No changes proposed'}</p>
        <p className="mt-0.5 text-[11px]">{review.state === 'blocked' ? 'Review the highlighted constraints below. The drawing has not changed.'
          : review.state === 'ready' ? 'Routes checked together. Apply saves the preview as one undo step.' : 'Check the selected units and routing options.'}</p></div>
    </div>

    <div className={`grid gap-2 ${activeCount === 3 ? 'grid-cols-3' : activeCount === 2 ? 'grid-cols-2' : 'grid-cols-1'}`} aria-label="Proposed service coverage">
      {ducts && <ServiceCard label="Ducts" icon={Wind} value={`${ducts.units.filter(unit => unit.status === 'designed').length}/${ducts.units.length}`}
        detail={ducts.unservedTerminalIds?.length ? `${ducts.unservedTerminalIds.length} unserved terminals`
          : ducts.units.length ? 'unit layouts proposed' : 'no units to route'} blocked={review.failedDuctUnits.length > 0 || Boolean(ducts.unservedTerminalIds?.length)} />}
      {refrigerant && <ServiceCard label="Refrigerant" icon={Network} value={`${refrigerant.connectedIndoorIds.length}/${refrigerant.connectedIndoorIds.length + refrigerant.unconnectedIndoorIds.length}`}
        detail="connections proposed" blocked={refrigerant.unconnectedIndoorIds.length > 0} />}
      {condensate && <ServiceCard label="Drains" icon={Droplets} value={`${condensate.metrics.unitsConnected}/${condensate.metrics.unitsTotal}`}
        detail="connections proposed" blocked={condensate.metrics.unitsConnected < condensate.metrics.unitsTotal} />}
    </div>

    {review.issues.length > 0 && <section aria-label="Routing constraints" className="space-y-1.5">
      <p className="flex items-center justify-between font-semibold text-slate-800">Routing constraints <span className="rounded-full bg-amber-100 px-2 text-[11px] text-amber-900">{review.issues.length}</span></p>
      {review.issues.map(issue => <details key={issue.key} className="rounded-lg border border-amber-200 bg-amber-50/40 p-2">
        <summary className="cursor-pointer font-medium text-amber-900">{issue.title}</summary>
        <p className="mt-1.5 break-words">{issue.message}</p>
        {issue.elementIds.some(id => existingIds.has(id)) ? <button type="button" onClick={() => inspect(issue.elementIds)} className="mt-2 inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-2 py-1 text-teal-800">
          <Focus size={12} aria-hidden="true" /> Inspect objects</button>
          : issue.elementIds.length > 0 ? <p className="mt-2 text-[11px] text-slate-500">Review these proposed routes in the drawing preview.</p> : null}
      </details>)}
    </section>}

    {ducts && <section data-testid="auto-route-ducts" className="space-y-1.5" aria-label="Duct layout review">
      {feedback?.additionalIssues.length ? <div className="rounded-md bg-amber-50 p-2 text-amber-900">{feedback.additionalIssues.map(message => <p key={message}>{message}</p>)}</div> : null}
      {ducts.units.map(unit => {
        const designed = unit.status === 'designed';
        const details = ductUnitReview(unit);
        return <details key={unit.unitId} open={!designed} className={`rounded-lg border p-2 ${designed ? 'border-slate-200' : 'border-amber-200'}`}>
          <summary className="cursor-pointer text-slate-800"><span className="font-medium">{unit.unitLabel}</span>
            <span className={`ml-1.5 inline-block rounded px-1.5 text-[10px] ${designed ? 'bg-teal-50 text-teal-800' : 'bg-amber-100 text-amber-900'}`}>{designed ? 'Proposed' : 'Needs layout'}</span></summary>
          <div className="mt-2 space-y-2">
            {designed && unit.services.map(service => <div key={service.service} className="flex items-start gap-2 text-[11px]">
              <span className={`mt-1 h-2 w-3 shrink-0 rounded-sm border ${service.service === 'supply' ? 'border-blue-600 bg-blue-50' : 'border-teal-600 bg-teal-50'}`} aria-hidden="true" />
              <span><span className="font-medium capitalize">{service.service}</span> · {service.trunk} · {service.terminals} terminals<br /><span className="text-slate-500">{service.layout}</span></span>
            </div>)}
            {!designed && <p className="text-[11px] text-amber-900">No valid layout found for {unit.terminalIds?.length ?? 'the selected'} terminals. Existing ducts are retained.</p>}
            {details.details.map(issue => <details key={issue.key} className="rounded-md bg-amber-50 p-2">
              <summary className="cursor-pointer font-medium text-amber-900">{issue.title}</summary><p className="mt-1.5 break-words">{issue.message}</p>
            </details>)}
            {details.notes.length > 0 && <details className="text-[11px]"><summary className="cursor-pointer text-slate-600">{designed ? 'Design notes' : 'Layout guidance'} ({details.notes.length})</summary>
              {details.notes.map(note => <p key={note} className="mt-1.5 break-words">{note}</p>)}</details>}
            {designed && (unit.requiredEspPa !== null || unit.firstCost !== null) && <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums text-slate-500">
              {unit.requiredEspPa !== null && <span>Pressure {Math.round(unit.requiredEspPa)}{unit.maxEspPa !== null ? ` / ${unit.maxEspPa}` : ''} Pa</span>}
              {unit.firstCost !== null && <span>Installed {formatCost(unit.firstCost, unit.currency)}</span>}
              {unit.lifeCycleCost !== null && <span>Life cycle {formatCost(unit.lifeCycleCost, unit.currency)}</span>}
            </div>}
            <button type="button" onClick={() => inspect([unit.unitId])} className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-teal-800 hover:bg-teal-50">
              <Focus size={12} aria-hidden="true" /> Review unit settings</button>
          </div>
        </details>;
      })}
    </section>}

    {(refrigerant?.metrics || condensate) && <div className="rounded-lg bg-slate-50 px-2.5 py-2 text-[11px]">
      {refrigerant?.metrics && <div className="flex flex-wrap justify-between gap-x-3"><span>Refrigerant</span><span className="tabular-nums">{(refrigerant.metrics.pipeLengthMm / 1000).toFixed(1)} m · {refrigerant.metrics.branchPairCount} branch pairs</span></div>}
      {condensate && <div className="mt-1 flex flex-wrap justify-between gap-x-3"><span>Drainage</span><span className="tabular-nums">{(condensate.metrics.pipeLengthMm / 1000).toFixed(1)} m · {condensate.metrics.unitsConnected - condensate.metrics.pumpedUnits} gravity · {condensate.metrics.pumpedUnits} pumped</span></div>}
    </div>}

    {condensate?.hopProposals.length ? <section className="space-y-2 rounded-lg border border-fuchsia-200 bg-fuchsia-50 p-2 text-fuchsia-900" aria-label="Pipe hop approvals">
      <p className="font-medium">Pipe hops · {review.pendingHops.length} awaiting approval</p>
      {condensate.hopProposals.map(hop => <label key={hop.key} className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5" checked={approved.includes(hop.key)} disabled={!hop.withinSoffit} onChange={() => toggleHop(hop.key)} />
        <span>Raise pipe {hop.refrigerantElementId.slice(-6)} to ≥ {Math.round(hop.requiredCentrelineZ)} mm{hop.withinSoffit ? '' : ' — insufficient soffit clearance'}</span>
      </label>)}
    </section> : null}

    {review.manufacturerNotes.length > 0 && <details className="rounded-lg border border-sky-100 bg-sky-50/50 p-2">
      <summary className="cursor-pointer font-medium text-sky-900"><Info size={13} className="mr-1 inline" aria-hidden="true" /> Manufacturer verification ({review.manufacturerNotes.length})</summary>
      <p className="mt-1.5 text-[11px] font-medium">Preliminary sizing — model data is still required.</p>
      {review.manufacturerNotes.map(note => <p key={note} className="mt-1.5 break-words text-[11px]">{note}</p>)}
      {equipmentToReview && <button type="button" onClick={() => inspect([equipmentToReview])} className="mt-2 inline-flex items-center gap-1 rounded border border-sky-200 bg-white px-2 py-1 text-teal-800">
        <Focus size={12} aria-hidden="true" /> Review equipment data</button>}
    </details>}
    {review.installationNotes.length > 0 && <details className="rounded-lg border border-slate-200 p-2">
      <summary className="cursor-pointer font-medium text-slate-700">Installation checks ({review.installationNotes.length})</summary>
      {review.installationNotes.map(note => <p key={note} className="mt-1.5 break-words text-[11px]">{note}</p>)}
    </details>}
  </div>;
}
