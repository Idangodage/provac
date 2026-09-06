'use client';

import { useMemo, useState } from 'react';

import { useSmartDrawingStore } from '../../../store';

import { prepareNetworkRiserUpgrade, proposeNetworkRiserUpgrade, type NetworkRiserUpgrade } from './networkRiserUpgrade';

/** A contextual repair for saved generated ramps, never a drawing alert. */
export function NetworkRiserUpgradeAction({ selectedId }: { selectedId: string }) {
  const scene = useSmartDrawingStore(state => state.hvacElements);
  const settings = useSmartDrawingStore(state => state.pipeRoutingSettings);
  const proposal = useMemo(() => proposeNetworkRiserUpgrade(scene, selectedId, settings), [scene, selectedId, settings]);
  const [failure, setFailure] = useState<{ proposal: NetworkRiserUpgrade; issue: string } | null>(null);
  if (!proposal) return null;
  const issue = failure?.proposal === proposal ? failure.issue : proposal.issue;
  const plan = proposal.plan;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs text-slate-600"
      onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
      {plan?.feasible ? (
        <>
          <p>Gas {(plan.gasElevationMm / 1000).toFixed(3)} m · Liquid {(plan.liquidElevationMm / 1000).toFixed(3)} m</p>
          <p className="mt-1">Updates {plan.coordinatedRunCount} existing {plan.coordinatedRunCount === 1 ? 'run' : 'runs'}. One undo restores all.</p>
        </>
      ) : null}
      {issue ? <p role="status" className="mt-1 leading-4">{issue}</p> : (
        <button type="button" className="mt-2 rounded-md border border-teal-200 bg-white px-2.5 py-1.5 font-medium text-teal-800 hover:bg-teal-50 focus:outline-none focus:ring-2 focus:ring-teal-400"
          onClick={() => {
            const current = useSmartDrawingStore.getState();
            const result = prepareNetworkRiserUpgrade(proposal, current.hvacElements, current.pipeRoutingSettings);
            if (!result.command) { setFailure({ proposal, issue: result.issue ?? 'Review the riser approach.' }); return; }
            current.commitHvacElementCommand('Use vertical refrigerant risers', result.command);
          }}>
          Use vertical risers
        </button>
      )}
    </div>
  );
}
