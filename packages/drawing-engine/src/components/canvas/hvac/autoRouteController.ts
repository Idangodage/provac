/**
 * Auto route for every ticked service: generate off-thread → preview on the
 * board → Apply (ONE undo step for ducts + refrigerant + condensate + approved
 * refrigerant hops) or Discard. Results computed against a drawing that has
 * since changed are refused.
 */
import { useSmartDrawingStore } from '../../../store';
import type { HvacElement } from '../../../types';
import type { ManufacturerRuleProfile } from '../../../vrf/rules';

import { autoRouteSourceSignature, prepareAutoRouteCommand } from './autoRouteCommand';
import { incompleteServiceRouteRefusal, leftOutParts, partialApplyRefusal } from './autoRouteCompleteness';
import { effectiveAutoRouteSettings, type AutoRouteCostRates } from './autoRouteEvaluation';
import { autoRouteEstimator } from './autoRouteProgress';
import { condensateSourceSignature, prepareCondensateCommand, type CondensateCommandSource } from './condensate/condensateCommand';
import { useCondensatePreviewStore } from './condensate/condensatePreviewStore';
import { buildRefrigerantHopUpdates } from './condensate/refrigerantHopProposal';
import { terminalSpigotUpdates, type AutoDuctShape } from './duct/ductAutoLayout';
import { ductSourceSignature } from './duct/ductAutoRoute';
import { ductWallInputs } from './duct/ductBuilding';
import type { FanSpeed } from './duct/ductSizing';
import { stampDesignedAt } from './duct/ductSizingRecord';
import { isDuctTerminalElement } from './duct/ductTerminals';
import { useTerminalProposalStore } from './duct/terminalProposalStore';
import { applyServiceRouteCommand, serviceRouteCommitIssues } from './serviceRouteValidation';
import {
  foldRefrigerantHopUpdates,
  planUnifiedAutoRoute,
  unitTurnCommandUpdates,
  wantsDucts,
  type AutoRouteServices,
  type AutoRouteStepMemo,
  type HvacElementUpdate,
} from './unifiedAutoRoute';
import type { UnifiedAutoRouteRequest, UnifiedAutoRouteResponse } from './unifiedAutoRouteProtocol';
import { autoTurnSettingsOf } from './unitOrientation';

export interface AutoRouteRunOptions {
  services: AutoRouteServices;
  scope: 'drawing' | 'selection';
  profile?: ManufacturerRuleProfile;
  objective?: 'balanced' | 'cost' | 'fewest-fittings';
  rates?: AutoRouteCostRates;
  rebuildExisting?: boolean;
  /** Duct design: trunk shape, the units' fan speed, and whether ducts already on a collar are replaced. */
  duct?: { shape: AutoDuctShape; fanSpeed: FanSpeed; rebuildExisting: boolean };
  /** Scripted checks: no worker pool, every task in the run's own worker (the same answers, more slowly). */
  inlineTasks?: boolean;
}

let activeWorker: Worker | null = null;
/** The last run's steps: the next run takes from them whatever has not changed. */
let lastSteps: AutoRouteStepMemo | null = null;
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
  // (With whatever part of a proposal it had shown.)
  preview.setUnified(null, null);
  preview.setRunning(null);
  preview.setMessage('Auto route cancelled.');
}

export function discardAutoRoutePreview(): void {
  previewProfile = undefined;
  useCondensatePreviewStore.getState().clear();
  useTerminalProposalStore.getState().setProposal(null);
}

export function runAutoRoute(options: AutoRouteRunOptions): void {
  const preview = useCondensatePreviewStore.getState();
  if (activeWorker) return;
  const { services } = options;
  if (!services.gas && !services.liquid && !services.condensate && !wantsDucts(services)) {
    preview.setMessage('Tick ducts, gas, liquid or condensate to route.');
    return;
  }
  const state = useSmartDrawingStore.getState();
  const selected = new Set(state.selectedIds);
  const selection = options.scope === 'selection' ? state.hvacElements.filter((element) => selected.has(element.id)) : [];
  if (options.scope === 'selection' && !selection.length) {
    preview.setMessage('Select the units (and their gullies, diffusers or grilles) to route, or choose all units in the drawing.');
    return;
  }
  // End any live manual draft before a generated network is previewed; terminals proposed for the last one go.
  state.setTool('select');
  useTerminalProposalStore.getState().setProposal(null);
  const signatures = {
    refrigerant: services.gas || services.liquid ? autoRouteSourceSignature(refrigerantSource(options.profile)) : null,
    condensate: services.condensate ? condensateSourceSignature(condensateSource()) : null,
    ducts: wantsDucts(services) ? ductSourceSignature(state.hvacElements, state.ductSettings, ductWallInputs(state.walls)) : null,
  };
  const request: UnifiedAutoRouteRequest = {
    type: 'route',
    scene: [...state.hvacElements],
    ...(options.inlineTasks ? { inlineTasks: true } : {}),
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
      // Auto-turn: 4-way cassettes turned for shorter runs first (Route defaults).
      orientation: autoTurnSettingsOf(state.pipeRoutingSettings),
      ...(lastSteps ? { previous: lastSteps } : {}),
      // Always passed: every step plans duct bodies with the document's duct settings.
      duct: {
        settings: state.ductSettings,
        shape: options.duct?.shape ?? 'optimal',
        fanSpeed: options.duct?.fanSpeed ?? 'hi',
        rebuildExisting: options.duct?.rebuildExisting ?? false,
        scope: options.scope,
        walls: ductWallInputs(state.walls),
        // (With each room's design criteria: a unit designs by those of the rooms it serves.)
        rooms: state.rooms.map((room) => ({ id: room.id, vertices: room.vertices, designCriteria: room.designCriteria ?? null })),
        ...(options.scope === 'selection' ? {
          unitIds: selection.filter((element) => element.type === 'ducted-ac').map((element) => element.id),
          terminalIds: selection.filter(isDuctTerminalElement).map((element) => element.id),
        } : {}),
      },
    },
  };
  previewProfile = options.profile;
  preview.setMessage(null);
  preview.setUnified(null, null);
  preview.setRunning({ stage: 'Preparing equipment, drains and routing rules', completed: 0, total: 0 });
  const estimate = autoRouteEstimator(services, {
    terminals: request.scene.filter(isDuctTerminalElement).length,
    units: request.scene.filter((element) => element.type === 'ducted-ac' || element.type === 'ceiling-cassette-ac').length,
  });
  const finish = (response: UnifiedAutoRouteResponse) => {
    const store = useCondensatePreviewStore.getState();
    if (response.type === 'progress') { store.setRunning({ ...response.progress, ...estimate(response.progress) }); return; }
    if (response.type === 'partial') { store.setPartial(response.result); return; }
    activeWorker?.terminate();
    activeWorker = null;
    if (response.type === 'error') {
      store.setUnified(null, null);
      store.setRunning(null);
      store.setMessage(response.message);
      return;
    }
    lastSteps = response.memo ?? null;
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

/**
 * Commits the open preview as one undo step. Returns the status message shown
 * to the user. `completeOnly` ("Apply complete parts"): the parts that are
 * incomplete are left out (duct units with no layout keep the ducts they
 * have, units with no refrigerant or drain route stay unconnected) instead of
 * refusing the whole preview; the message names them.
 */
export function applyAutoRoutePreview(options: { completeOnly?: boolean } = {}): string {
  const preview = useCondensatePreviewStore.getState();
  const { unified, signatures } = preview;
  if (!unified || !signatures) return 'Run Auto route first.';
  const refuse = (message: string) => {
    preview.setMessage(message);
    return message;
  };
  const incomplete = options.completeOnly ? partialApplyRefusal(unified) : incompleteServiceRouteRefusal(unified);
  if (incomplete) return refuse(incomplete);
  const labels = new Map(useSmartDrawingStore.getState().hvacElements.map((element) => [element.id, element.label || element.id]));
  const leftOut = options.completeOnly ? leftOutParts(unified, (id) => labels.get(id) ?? id) : [];
  if (unified.condensate?.hopProposals.some((proposal) => !preview.approvedHopKeys.includes(proposal.key))) {
    return refuse('Review and approve the required refrigerant hops before applying. Nothing was changed.');
  }
  let add: HvacElement[] = [];
  const removeIds: string[] = [];
  // The cassettes Auto route turned, first: everything after is laid to them as turned.
  let updates: HvacElementUpdate[] = unitTurnCommandUpdates(unified.orientation);

  const ducts = unified.ducts;
  if (ducts && signatures.ducts && (ducts.elementsToAdd.length || ducts.removeElementIds.length || ducts.terminalUpdates?.length)) {
    const state = useSmartDrawingStore.getState();
    if (ductSourceSignature(state.hvacElements, state.ductSettings, ductWallInputs(state.walls)) !== signatures.ducts) {
      return refuse('The drawing or duct settings changed since the preview. Run Auto route again.');
    }
    add.push(...stampDesignedAt(ducts.elementsToAdd, new Date().toISOString()));
    removeIds.push(...ducts.removeElementIds);
    updates.push(...terminalSpigotUpdates(ducts.terminalUpdates ?? []));
  }

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
    const virtual = applyServiceRouteCommand(latest.scene, { add, removeIds, updates });
    const hops = buildRefrigerantHopUpdates(virtual, approved, latest.settings,
      effectiveAutoRouteSettings(previewProfile, latest.routingSettings, virtual));
    if (hops.rejected.length) return refuse(`Nothing was applied. ${hops.rejected[0]!.reason}`);
    const folded = foldRefrigerantHopUpdates(add, updates, hops.updates);
    add = folded.add;
    updates = folded.updates;
    const coordinated = applyServiceRouteCommand(latest.scene, { add, removeIds, updates });
    const prepared = prepareCondensateCommand(signatures.condensate, latest, unified.condensate, folded.existing, coordinated);
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
  const state = useSmartDrawingStore.getState();
  const issues = serviceRouteCommitIssues(state.hvacElements, { add, removeIds, updates }, {
    condensate: state.condensateSettings, routing: state.pipeRoutingSettings, ducts: state.ductSettings,
    profile: previewProfile, walls: state.walls,
  });
  if (issues.length) return refuse(`Nothing was applied. ${issues[0]}`);
  state.commitHvacElementCommand('Auto route', { add, removeIds, updates, selectedIds: [] });
  const refrigerantUnits = unified.refrigerant?.connectedIndoorIds.length ?? 0;
  const refrigerantChanged = Boolean(unified.refrigerant && (unified.refrigerant.elementsToAdd.length
    || unified.refrigerant.removeElementIds.length || unified.refrigerant.updates.length));
  const drainUnits = unified.condensate?.metrics.unitsConnected ?? 0;
  const ductRuns = unified.ducts?.elementsToAdd.length ?? 0;
  const ductUnits = unified.ducts?.units.filter((unit) => unit.status === 'designed').length ?? 0;
  const turnedUnits = unified.orientation?.turns.length ?? 0;
  const parts = [
    turnedUnits ? `${turnedUnits} cassette${turnedUnits === 1 ? '' : 's'} turned for shorter runs` : null,
    ductRuns ? `${ductRuns} duct run${ductRuns === 1 ? '' : 's'} for ${ductUnits} unit${ductUnits === 1 ? '' : 's'}` : null,
    unified.refrigerant && !refrigerantChanged ? 'refrigerant unchanged' : null,
    refrigerantChanged ? `${refrigerantUnits} unit${refrigerantUnits === 1 ? '' : 's'} on refrigerant` : null,
    unified.condensate ? `${drainUnits} drain${drainUnits === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  // The parts left out come first: the toolbar shows the start of a long message.
  const ductless = leftOut.filter((part) => part.service === 'ducts').map((part) => part.label);
  const without = leftOut.length ? ` without ${[
    ductless.length ? `${ductless.join(', ')} (no duct layout; ${ductless.length === 1 ? 'it keeps its' : 'they keep their'} ducts)` : null,
    ...leftOut.filter((part) => part.service !== 'ducts').map((part) => `${part.label} (${part.service === 'refrigerant' ? 'no refrigerant route'
      : part.service === 'drains' ? 'no drain route' : 'no duct reaches it'})`),
  ].filter(Boolean).join(', ')}` : '';
  const message = `Auto route applied${without}: ${parts.join(', ')}. One undo reverts it.${hopMessage}`;
  previewProfile = undefined;
  preview.clear();
  preview.setMessage(message);
  return message;
}
