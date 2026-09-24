/**
 * Auto route for every ticked service: generate off-thread → preview on the
 * board → Apply (ONE undo step for refrigerant + condensate + approved
 * refrigerant hops) or Discard. Results computed against a drawing that has
 * since changed are refused.
 */
import { useSmartDrawingStore } from '../../../store';
import type { HvacElement } from '../../../types';
import type { ManufacturerRuleProfile } from '../../../vrf/rules';

import { autoRouteSourceSignature, prepareAutoRouteCommand } from './autoRouteCommand';
import type { AutoRouteCostRates } from './autoRouteEvaluation';
import { condensateSourceSignature, prepareCondensateCommand, type CondensateCommandSource } from './condensate/condensateCommand';
import { useCondensatePreviewStore } from './condensate/condensatePreviewStore';
import { buildRefrigerantHopUpdates } from './condensate/refrigerantHopProposal';
import {
  applyRefrigerantProposal,
  foldRefrigerantHopUpdates,
  planUnifiedAutoRoute,
  type AutoRouteServices,
  type HvacElementUpdate,
} from './unifiedAutoRoute';
import type { UnifiedAutoRouteRequest, UnifiedAutoRouteResponse } from './unifiedAutoRouteProtocol';

export interface AutoRouteRunOptions {
  services: AutoRouteServices;
  scope: 'drawing' | 'selection';
  profile?: ManufacturerRuleProfile;
  objective?: 'balanced' | 'cost' | 'fewest-fittings';
  rates?: AutoRouteCostRates;
  rebuildExisting?: boolean;
}

let activeWorker: Worker | null = null;
/** The rule profile the open preview was calculated with (needed again at apply). */
let previewProfile: ManufacturerRuleProfile | undefined;

function condensateSource(): CondensateCommandSource {
  const state = useSmartDrawingStore.getState();
  return {
    scene: state.hvacElements,
    settings: state.condensateSettings,
    routingSettings: state.pipeRoutingSettings,
    walls: state.walls,
    rooms: state.rooms,
  };
}

function refrigerantSource(profile: ManufacturerRuleProfile | undefined) {
  const state = useSmartDrawingStore.getState();
  return { scene: state.hvacElements, settings: state.pipeRoutingSettings, profile, walls: state.walls };
}

export function isAutoRouteRunning(): boolean {
  return activeWorker !== null || useCondensatePreviewStore.getState().running;
}

export function cancelAutoRoute(): void {
  activeWorker?.terminate();
  activeWorker = null;
  const preview = useCondensatePreviewStore.getState();
  preview.setRunning(null);
  preview.setMessage('Auto route cancelled.');
}

export function discardAutoRoutePreview(): void {
  previewProfile = undefined;
  useCondensatePreviewStore.getState().clear();
}

export function runAutoRoute(options: AutoRouteRunOptions): void {
  const preview = useCondensatePreviewStore.getState();
  if (activeWorker) return;
  const { services } = options;
  if (!services.gas && !services.liquid && !services.condensate) {
    preview.setMessage('Tick gas, liquid or condensate to route.');
    return;
  }
  const state = useSmartDrawingStore.getState();
  const selected = new Set(state.selectedIds);
  const selection = options.scope === 'selection' ? state.hvacElements.filter((element) => selected.has(element.id)) : [];
  if (options.scope === 'selection' && !selection.length) {
    preview.setMessage('Select the units (and gullies) to route, or choose all units in the drawing.');
    return;
  }
  // End any live manual draft before a generated network is previewed.
  state.setTool('select');
  const signatures = {
    refrigerant: services.gas || services.liquid ? autoRouteSourceSignature(refrigerantSource(options.profile)) : null,
    condensate: services.condensate ? condensateSourceSignature(condensateSource()) : null,
  };
  const request: UnifiedAutoRouteRequest = {
    type: 'route',
    scene: [...state.hvacElements],
    options: {
      services,
      refrigerant: {
        settings: state.pipeRoutingSettings,
        profile: options.profile,
        objective: options.objective ?? 'balanced',
        rates: options.rates,
        selectedIds: options.scope === 'selection' ? selection.map((element) => element.id) : undefined,
        walls: [...state.walls],
        rebuildExisting: options.rebuildExisting ?? true,
      },
      condensate: {
        settings: state.condensateSettings,
        walls: [...state.walls],
        rooms: [...state.rooms],
        ...(options.scope === 'selection' ? {
          unitIds: selection.filter((element) => element.type !== 'condensate-gully').map((element) => element.id),
          gullyIds: selection.filter((element) => element.type === 'condensate-gully').map((element) => element.id),
        } : {}),
      },
    },
  };
  previewProfile = options.profile;
  preview.setMessage(null);
  preview.setUnified(null, null);
  preview.setRunning({ stage: 'Preparing equipment, drains and routing rules', completed: 0, total: 0 });
  const finish = (response: UnifiedAutoRouteResponse) => {
    const store = useCondensatePreviewStore.getState();
    if (response.type === 'progress') { store.setRunning(response.progress); return; }
    activeWorker?.terminate();
    activeWorker = null;
    if (response.type === 'error') {
      store.setRunning(null);
      store.setMessage(response.message);
      return;
    }
    store.setUnified(response.result, signatures);
    store.setMessage(null);
  };
  try {
    const worker = new Worker(new URL('./unifiedAutoRoute.worker.ts', import.meta.url), { type: 'module' });
    activeWorker = worker;
    worker.onmessage = ({ data }: MessageEvent<UnifiedAutoRouteResponse>) => {
      if (activeWorker !== worker) return;
      finish(data);
    };
    worker.onerror = () => {
      if (activeWorker !== worker) return;
      finish({ type: 'error', message: 'Auto route could not finish. The drawing is unchanged; try again.' });
    };
    worker.postMessage(request);
  } catch {
    // No module-worker support (tests, older browsers): compute on the main thread.
    activeWorker = null;
    void planUnifiedAutoRoute(request.scene, {
      ...request.options,
      onProgress: (progress) => useCondensatePreviewStore.getState().setRunning(progress),
    }).then(
      (result) => finish({ type: 'result', result }),
      (error: unknown) => finish({ type: 'error', message: error instanceof Error ? error.message : 'Unable to calculate the network.' }),
    );
  }
}

/** Commits the open preview as one undo step. Returns the status message shown to the user. */
export function applyAutoRoutePreview(): string {
  const preview = useCondensatePreviewStore.getState();
  const { unified, signatures } = preview;
  if (!unified || !signatures) return 'Run Auto route first.';
  const refuse = (message: string) => {
    preview.setMessage(message);
    return message;
  };
  let add: HvacElement[] = [];
  const removeIds: string[] = [];
  let updates: HvacElementUpdate[] = [];

  if (unified.refrigerant && signatures.refrigerant) {
    const prepared = prepareAutoRouteCommand(signatures.refrigerant, refrigerantSource(previewProfile), unified.refrigerant);
    if (prepared.issue) return refuse(prepared.issue);
    add.push(...(prepared.command?.add ?? []));
    removeIds.push(...(prepared.command?.removeIds ?? []));
    updates.push(...(prepared.command?.updates ?? []));
  }

  let hopMessage = '';
  if (unified.condensate && signatures.condensate) {
    const latest = condensateSource();
    const approved = unified.condensate.hopProposals.filter((proposal) => preview.approvedHopKeys.includes(proposal.key));
    // Hops land on the refrigerant as it will be after this apply (new runs included).
    const virtual = applyRefrigerantProposal(latest.scene, unified.refrigerant);
    const hops = buildRefrigerantHopUpdates(virtual, approved, latest.settings, latest.routingSettings);
    const folded = foldRefrigerantHopUpdates(add, updates, hops.updates);
    add = folded.add;
    updates = folded.updates;
    const prepared = prepareCondensateCommand(signatures.condensate, latest, unified.condensate, folded.existing);
    if (prepared.issue && (unified.condensate.elementsToAdd.length || unified.condensate.removeElementIds.length)) return refuse(prepared.issue);
    add.push(...(prepared.command?.add ?? []));
    removeIds.push(...(prepared.command?.removeIds ?? []));
    updates.push(...(prepared.command?.updates ?? []));
    if (hops.updates.length) hopMessage += ` ${hops.updates.length} refrigerant run${hops.updates.length === 1 ? '' : 's'} hopped over drains.`;
    if (hops.rejected.length) {
      hopMessage += ` ${hops.rejected.length} approved hop${hops.rejected.length === 1 ? ' was' : 's were'} not possible: ${[...new Set(hops.rejected.map((entry) => entry.reason))].join(' ')}`;
    }
  }

  if (!add.length && !removeIds.length && !updates.length) return refuse('Nothing to apply — the existing layout is already the best found.');
  useSmartDrawingStore.getState().commitHvacElementCommand('Auto route', { add, removeIds, updates, selectedIds: [] });
  const refrigerantUnits = unified.refrigerant?.connectedIndoorIds.length ?? 0;
  const refrigerantChanged = Boolean(unified.refrigerant && (unified.refrigerant.elementsToAdd.length
    || unified.refrigerant.removeElementIds.length || unified.refrigerant.updates.length));
  const drainUnits = unified.condensate?.metrics.unitsConnected ?? 0;
  const parts = [
    unified.refrigerant && !refrigerantChanged ? 'refrigerant unchanged' : null,
    refrigerantChanged ? `${refrigerantUnits} unit${refrigerantUnits === 1 ? '' : 's'} on refrigerant` : null,
    unified.condensate ? `${drainUnits} drain${drainUnits === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  const message = `Auto route applied: ${parts.join(', ')}. One undo reverts it.${hopMessage}`;
  previewProfile = undefined;
  preview.clear();
  preview.setMessage(message);
  return message;
}
