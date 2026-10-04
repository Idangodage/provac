/**
 * One Auto route for every ticked service — supply and return ducts, gas,
 * liquid, condensate — coordinated so the services do not clash.
 *
 * Order (and why):
 *  0. Ducts — the largest bodies, tied to fixed collars and terminals, with
 *     the least freedom to move; pipes can pass them, not the other way round.
 *     Each ducted unit gets the optimiser's best life-cycle design; the new
 *     runs are part of the scene every later step sees (the pipe clearance
 *     check treats duct bodies as obstacles).
 *  1. Refrigerant — the most constrained pipe topology (unit ports, branch kits).
 *     Its router already rejects every candidate that clashes in 3D with any
 *     other pipe, existing condensate included. Drains that THIS run will
 *     regenerate are taken out of its scene first, so refrigerant never bends
 *     around pipes that are about to be replaced.
 *     The engine always designs gas + liquid as a coordinated pair; with only
 *     one line ticked the pair is laid out and only the ticked line (and its
 *     kits) is kept — the partner's corridor stays free for later.
 *  2. Condensate — on the scene WITH the new refrigerant, with gravity
 *     priority: below a refrigerant run, else above it, else a refrigerant hop
 *     is proposed for approval.
 *  3. Audit the assembled services and actual proposed hops. If coordination
 *     fails, compare one drainage-first alternative with the same duct layout.
 *     Physical validity and coverage precede normalized installation preference.
 */
import type { HvacElement, Room, Wall } from '../../../types';

import { incompleteAutoRouteRefusal } from './autoRouteCommand';
import { incompleteServiceRouteRefusal } from './autoRouteCompleteness';
import { effectiveAutoRouteSettings, evaluateAutoRouteNetwork } from './autoRouteEvaluation';
import { aggregateAutoRouteMetrics, planAutoRouteNetwork, replaceableGeneratedRefrigerantIds, type AutoRouteNetworkOptions, type AutoRouteNetworkResult } from './autoRouteNetwork';
import { incompleteCondensateRefusal } from './condensate/condensateCommand';
import { replaceableCondensatePipeIds } from './condensate/condensateEnvironment';
import { generateCondensateNetwork, type CondensateGenerationResult } from './condensate/condensateGenerator';
import type { CondensateDesignSettings } from './condensate/condensateSettings';
import { isCondensatePipe } from './condensate/condensateTypes';
import { findCondensateRefrigerantClashes } from './condensate/condensateValidation';
import { buildRefrigerantHopUpdates } from './condensate/refrigerantHopProposal';
import { terminalSpigotUpdates } from './duct/ductAutoLayout';
import { applyDuctProposal, planAutoRouteDucts, type AutoRouteDuctOptions, type AutoRouteDuctResult } from './duct/ductAutoRoute';
import { setActiveDuctSettings } from './duct/ductSettings';
import { isDuctElement, readDuctRunSpec } from './duct/ductTypes';
import { findDuctClashes } from './duct/ductVolumes';
import { findNewNetworkPipeClashes, listNetworkPipeLanes } from './networkPipeClearance';
import { getAutoRouteOwnership, retainGeneratedPipeEdit } from './pipeEditRetention';
import { getActivePipeRoutingSettings, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { isRefrigerantBranchKitElement, resolveRefrigerantBranchKitLineSelection } from './refrigerantBranchKitModel';
import { resolveRefrigerantPipeSpec } from './refrigerantPipePairModel';
import { rankServiceRouteCandidates } from './serviceRouteObjective';
import { applyServiceRouteCommand, serviceRouteCommitDiagnostics, type ServiceRouteCommand, type ServiceRouteIssue } from './serviceRouteValidation';

export interface AutoRouteServices {
  gas: boolean;
  liquid: boolean;
  condensate: boolean;
  /** Ducts from each ducted unit's collars to its diffusers / grilles (absent = not routed). */
  supplyDuct?: boolean;
  returnDuct?: boolean;
}

export type RoutedService = 'gas' | 'liquid' | 'both' | 'condensate' | 'supply-duct' | 'return-duct' | 'other';

export function wantsDucts(services: AutoRouteServices): boolean {
  return Boolean(services.supplyDuct || services.returnDuct);
}

export interface UnifiedAutoRouteProgress {
  stage: string;
  completed: number;
  total: number;
}

export interface UnifiedAutoRouteOptions {
  services: AutoRouteServices;
  refrigerant: Omit<AutoRouteNetworkOptions, 'onProgress'>;
  condensate: {
    settings: CondensateDesignSettings;
    walls?: Wall[];
    rooms?: Room[];
    unitIds?: string[];
    gullyIds?: string[];
  };
  /** Duct design (and the duct settings every step plans duct bodies with). */
  duct?: AutoRouteDuctOptions;
  onProgress?: (progress: UnifiedAutoRouteProgress) => void;
}

export interface ServiceClash {
  elementIds: [string, string];
  services: [RoutedService, RoutedService];
  distanceMm: number | null;
  requiredMm: number | null;
  message: string;
  /** A proposed refrigerant hop resolves this contact once approved. */
  resolvedByHop: boolean;
}

export interface UnifiedAutoRouteResult {
  services: AutoRouteServices;
  /** Duct proposal (every unit's best life-cycle design). */
  ducts: AutoRouteDuctResult | null;
  /** Refrigerant proposal, already reduced to the ticked line(s). */
  refrigerant: AutoRouteNetworkResult | null;
  condensate: CondensateGenerationResult | null;
  clashes: ServiceClash[];
  issues: string[];
  /** Hard failures after auditing the assembled services and every proposed hop. */
  blockingIssues?: string[];
  /** Entity references retained for focusing conflicts from the review. */
  blockingDetails?: ServiceRouteIssue[];
  coordination?: { strategy: 'refrigerant-first' | 'drainage-first'; candidatesEvaluated: number };
}

export function routedServiceOf(element: HvacElement | undefined): RoutedService {
  if (!element) return 'other';
  if (isDuctElement(element)) return readDuctRunSpec(element)?.service === 'return' ? 'return-duct' : 'supply-duct';
  if (isCondensatePipe(element)) return 'condensate';
  if (element.type === 'refrigerant-pipe') return resolveRefrigerantPipeSpec(element.properties).lineKind;
  if (element.type === 'refrigerant-pipe-pair') return 'both';
  if (element.type === 'refrigerant-branch-kit' || isRefrigerantBranchKitElement(element)) {
    const selection = resolveRefrigerantBranchKitLineSelection(element);
    return selection === 'gas' || selection === 'liquid' ? selection : 'both';
  }
  return 'other';
}

const CONNECTION_REFERENCE_KEY = /(?:sourceElementId|hostElementId|snapSourceElementId)$/i;

function connectionReferences(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) connectionReferences(entry, into);
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (CONNECTION_REFERENCE_KEY.test(key) && typeof entry === 'string') into.push(entry);
      else connectionReferences(entry, into);
    }
  }
  return into;
}

/** Groups refrigerant elements and their equipment into circuits (one per outdoor unit) by what they connect to. */
function refrigerantCircuits(elements: readonly HvacElement[]): (id: string) => string {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };
  for (const element of elements) {
    for (const id of connectionReferences(element.properties)) union(element.id, id);
    const owner = getAutoRouteOwnership(element);
    if (owner) union(element.id, owner.outdoorUnitId);
  }
  return find;
}

/**
 * Keeps only the ticked refrigerant line from a paired proposal. The partner
 * line's existing pipes and kits are left untouched (never removed or
 * updated), so its current layout survives next to the new line.
 *
 * The engine designs, keeps or rebuilds a whole circuit (both lines). When it
 * rebuilds a circuit whose partner line stays in place, the new ticked line is
 * only kept if it does not run into that partner; otherwise the circuit is
 * left exactly as it is, because gas and liquid of an existing circuit have to
 * be rerouted together.
 */
export function reduceRefrigerantResultToLine(
  result: AutoRouteNetworkResult,
  scene: readonly HvacElement[],
  line: 'gas' | 'liquid',
): AutoRouteNetworkResult {
  const partner = line === 'gas' ? 'liquid' : 'gas';
  const byId = new Map(scene.map((element) => [element.id, element]));
  const keeps = (element: HvacElement | undefined) => {
    const service = routedServiceOf(element);
    return service === line || service === 'both';
  };
  const add = result.elementsToAdd.filter(keeps);
  const removeIds = result.removeElementIds.filter((id) => keeps(byId.get(id)));
  const updates = result.updates.filter((element) => keeps(byId.get(element.id) ?? element));

  const isRefrigerant = (element: HvacElement) => ['gas', 'liquid', 'both'].includes(routedServiceOf(element));
  const circuitOf = refrigerantCircuits([...scene.filter(isRefrigerant), ...result.elementsToAdd, ...result.updates]);
  const proposedByCircuit = new Map<string, HvacElement[]>();
  for (const element of [...add, ...updates]) {
    const circuit = circuitOf(element.id);
    proposedByCircuit.set(circuit, [...(proposedByCircuit.get(circuit) ?? []), element]);
  }
  const dropped = new Set<string>();
  let issues = [...result.issues];
  for (const [circuit, proposed] of proposedByCircuit) {
    if (!findNewNetworkPipeClashes([...scene], proposed, removeIds).length) continue;
    dropped.add(circuit);
    const outdoorUnit = scene.find((element) => element.type === 'outdoor-unit' && circuitOf(element.id) === circuit);
    const name = outdoorUnit?.label || outdoorUnit?.id || 'Circuit';
    // The engine's notes about rebuilding this circuit no longer apply.
    if (outdoorUnit) issues = issues.filter((issue) => !issue.startsWith(`${name}:`));
    issues.push(`${name}: the new ${line} line would run into the existing ${partner} line, which stays where it is. `
      + `Gas and liquid of an existing circuit are rerouted together — tick both lines to reroute it. It was left unchanged.`);
  }
  const kept = (id: string) => !dropped.has(circuitOf(id));
  // Units of a circuit left unchanged keep whatever connections they have.
  const unconnectedIndoorIds = result.unconnectedIndoorIds.filter(kept);
  const reduced: AutoRouteNetworkResult = {
    ...result,
    elementsToAdd: add.filter((element) => kept(element.id)),
    removeElementIds: removeIds.filter(kept),
    updates: updates.filter((element) => kept(element.id)),
    connectedIndoorIds: result.connectedIndoorIds.filter(kept),
    unconnectedIndoorIds,
    complete: result.complete || (result.unconnectedIndoorIds.length > 0 && unconnectedIndoorIds.length === 0),
    issues,
  };
  if (reduced.elementsToAdd.length) {
    reduced.issues.push(`Only the ${line} line was created; the paired layout keeps room for the ${partner} line.`);
  }
  return reduced;
}

export interface HvacElementUpdate {
  id: string;
  updates: Partial<HvacElement>;
}

/**
 * Folds approved refrigerant hops into the refrigerant part of one Apply.
 * A hop on a run this Apply ADDS edits that new element; a hop on a run it
 * UPDATES merges into that update; the rest are hops on untouched existing
 * runs and are returned separately. Either way the hopped run is a deliberate
 * edit, so its generated network is kept (retain) on the next Auto route.
 */
export function foldRefrigerantHopUpdates(
  add: readonly HvacElement[],
  updates: readonly HvacElementUpdate[],
  hops: readonly HvacElementUpdate[],
): { add: HvacElement[]; updates: HvacElementUpdate[]; existing: HvacElementUpdate[] } {
  const nextAdd = [...add];
  const nextUpdates = [...updates];
  const existing: HvacElementUpdate[] = [];
  for (const hop of hops) {
    const addIndex = nextAdd.findIndex((element) => element.id === hop.id);
    const updateIndex = nextUpdates.findIndex((entry) => entry.id === hop.id);
    if (addIndex >= 0) {
      const original = nextAdd[addIndex]!;
      nextAdd[addIndex] = retainGeneratedPipeEdit(original, { ...original, ...hop.updates, id: original.id });
    } else if (updateIndex >= 0) {
      nextUpdates[updateIndex] = { id: hop.id, updates: { ...nextUpdates[updateIndex]!.updates, ...hop.updates } };
    } else {
      existing.push(hop);
    }
  }
  return { add: nextAdd, updates: nextUpdates, existing };
}

/** The scene as it will be once a refrigerant proposal is applied. */
export function applyRefrigerantProposal(scene: readonly HvacElement[], result: AutoRouteNetworkResult | null): HvacElement[] {
  if (!result) return [...scene];
  const removed = new Set(result.removeElementIds);
  const updates = new Map(result.updates.map((element) => [element.id, element]));
  return [
    ...scene.filter((element) => !removed.has(element.id)).map((element) => updates.get(element.id) ?? element),
    ...result.elementsToAdd,
  ];
}

/** Compose before checking: terminal moves and approved hops affect other services. */
export function unifiedRouteCommand(result: Pick<UnifiedAutoRouteResult, 'ducts' | 'refrigerant' | 'condensate'>): ServiceRouteCommand {
  return {
    add: [...(result.ducts?.elementsToAdd ?? []), ...(result.refrigerant?.elementsToAdd ?? []), ...(result.condensate?.elementsToAdd ?? [])],
    removeIds: [...(result.ducts?.removeElementIds ?? []), ...(result.refrigerant?.removeElementIds ?? []), ...(result.condensate?.removeElementIds ?? [])],
    updates: [...terminalSpigotUpdates(result.ducts?.terminalUpdates ?? []), ...(result.refrigerant?.updates ?? []).map((element) => ({ id: element.id, updates: element }))],
  };
}

export { incompleteDuctRouteRefusal, incompleteServiceRouteRefusal } from './autoRouteCompleteness';

function auditUnifiedCandidate(originalScene: HvacElement[], result: UnifiedAutoRouteResult, options: UnifiedAutoRouteOptions): UnifiedAutoRouteResult {
  const previous = getActivePipeRoutingSettings();
  const settings = effectiveAutoRouteSettings(options.refrigerant.profile, options.refrigerant.settings,
    applyServiceRouteCommand(originalScene, unifiedRouteCommand(result)));
  setActivePipeRoutingSettings(settings);
  try {
    return auditCandidateWithSettings(originalScene, result, { ...options, refrigerant: { ...options.refrigerant, settings } });
  } finally {
    setActivePipeRoutingSettings(previous);
  }
}

function auditCandidateWithSettings(originalScene: HvacElement[], result: UnifiedAutoRouteResult, options: UnifiedAutoRouteOptions): UnifiedAutoRouteResult {
  const command = unifiedRouteCommand(result);
  const assembled = applyServiceRouteCommand(originalScene, command);
  const hops = buildRefrigerantHopUpdates(assembled, result.condensate?.hopProposals ?? [], options.condensate.settings, options.refrigerant.settings);
  const folded = foldRefrigerantHopUpdates([...(command.add ?? [])], [...(command.updates ?? [])], hops.updates);
  const withHops = { ...command, add: folded.add, updates: [...folded.updates, ...folded.existing] };
  const hoppedScene = applyServiceRouteCommand(originalScene, withHops);
  const blockingDetails = serviceRouteCommitDiagnostics(originalScene, withHops, { condensate: options.condensate.settings, routing: options.refrigerant.settings,
    ducts: options.duct?.settings, profile: options.refrigerant.profile, walls: options.refrigerant.walls });
  const blockingIssues = [...new Set([
    ...blockingDetails.map(issue => issue.message),
    ...hops.rejected.map((entry) => entry.reason),
    ...(result.condensate ? [incompleteCondensateRefusal(originalScene, result.condensate)].filter((issue): issue is string => Boolean(issue)) : []),
    ...[incompleteServiceRouteRefusal(result)].filter((issue): issue is string => Boolean(issue)),
  ])];
  const clashes = [
    ...auditServiceClashes(applyDuctProposal(originalScene, result.ducts), result.refrigerant, result.condensate, hoppedScene),
    ...(options.duct ? auditDuctClashes(originalScene, result.ducts, result.refrigerant, result.condensate, options.duct,
      { scene: hoppedScene, changedIds: hops.updates.map((entry) => entry.id) }) : []),
  ];
  let refrigerant = result.refrigerant;
  if (refrigerant && hops.updates.length) {
    // Compare the material, bends and risers of the actual proposed assembly,
    // including conditional hops; never rank their shorter pre-hop routes.
    const evaluations = refrigerant.evaluations.map((evaluation) => {
      const outdoorUnitId = evaluation.paths[0]?.outdoorUnitId;
      if (!outdoorUnitId) return evaluation;
      return evaluateAutoRouteNetwork({ elements: hoppedScene, outdoorUnitId,
        indoorUnitIds: [...new Set(evaluation.paths.map((path) => path.indoorUnitId))],
        profile: options.refrigerant.profile, rates: options.refrigerant.rates,
        objective: options.refrigerant.objective, walls: options.refrigerant.walls });
    });
    refrigerant = { ...refrigerant, evaluations, metrics: aggregateAutoRouteMetrics(evaluations) };
  }
  return { ...result, refrigerant, clashes, blockingIssues, blockingDetails, issues: [...new Set([...result.issues, ...blockingIssues])] };
}

export async function planUnifiedAutoRoute(originalScene: HvacElement[], options: UnifiedAutoRouteOptions): Promise<UnifiedAutoRouteResult> {
  const { services } = options;
  const progress = options.onProgress ?? (() => undefined);
  const issues: string[] = [];
  const wantsRefrigerant = services.gas || services.liquid;
  const routeDucts = wantsDucts(services) && Boolean(options.duct);
  if (!wantsRefrigerant && !services.condensate && !routeDucts) {
    return { services, ducts: null, refrigerant: null, condensate: null, clashes: [], issues: ['Tick at least one service to route.'] };
  }
  // Pipes are clash-checked against duct bodies planned with the document's duct settings (also in the worker).
  if (options.duct) setActiveDuctSettings(options.duct.settings);

  // Reserve only routes this operation is explicitly allowed to replace.
  // Otherwise an obsolete generated pipe can block the fixed duct collar before
  // the pipe planners get a chance to coordinate its replacement. Manual,
  // retained, locked and out-of-scope services remain real obstacles.
  const replacedDrains = services.condensate
    ? new Set(replaceableCondensatePipeIds(originalScene, options.condensate.settings, options.condensate))
    : new Set<string>();
  const replaceableRefrigerant = services.gas && services.liquid
    ? new Set(replaceableGeneratedRefrigerantIds(originalScene, options.refrigerant))
    : new Set<string>();
  const ductScene = originalScene.filter(element => !replacedDrains.has(element.id) && !replaceableRefrigerant.has(element.id));

  let ducts: AutoRouteDuctResult | null = null;
  if (routeDucts) {
    progress({ stage: 'Designing ducts', completed: 0, total: 0 });
    ducts = planAutoRouteDucts(ductScene, { supply: Boolean(services.supplyDuct), return: Boolean(services.returnDuct) }, options.duct!,
      (step) => progress({ stage: `Ducts: ${step.stage}`, completed: step.completed, total: step.total }));
    issues.push(...ducts.issues);
  }
  // Every later step sees the new ducts as part of the drawing.
  const scene = applyDuctProposal(originalScene, ducts);

  let refrigerant: AutoRouteNetworkResult | null = null;
  if (wantsRefrigerant) {
    progress({ stage: 'Routing refrigerant', completed: 0, total: 0 });
    const refrigerantScene = scene.filter((element) => !replacedDrains.has(element.id));
    const paired = await planAutoRouteNetwork(refrigerantScene, {
      ...options.refrigerant,
      onProgress: (step) => progress({ stage: `Refrigerant: ${step.stage}`, completed: step.completed, total: step.total }),
    });
    refrigerant = services.gas && services.liquid
      ? paired
      : reduceRefrigerantResultToLine(paired, scene, services.gas ? 'gas' : 'liquid');
    // Never preview a refrigerant change that Apply would refuse: keep the
    // existing refrigerant, and design the drains around what is really there.
    const refusal = incompleteAutoRouteRefusal(refrigerant);
    if (refusal) {
      const names = refrigerant.unconnectedIndoorIds.map((id) => scene.find((element) => element.id === id)?.label || id);
      refrigerant = {
        ...refrigerant,
        elementsToAdd: [],
        removeElementIds: [],
        updates: [],
        issues: [
          `Refrigerant kept as it is: the best layout found connects ${refrigerant.connectedIndoorIds.length} of `
            + `${refrigerant.connectedIndoorIds.length + refrigerant.unconnectedIndoorIds.length} units and would replace the existing network`
            + `${names.length ? ` (not connected: ${names.join(', ')})` : ''}. ${refusal}`,
          // The engine's notes describe that layout; its claim of a rebuild no longer holds.
          ...refrigerant.issues.filter((issue) => !/circuit was rebuilt/i.test(issue)),
        ],
      };
    }
    issues.push(...refrigerant.issues);
  }

  let condensate: CondensateGenerationResult | null = null;
  if (services.condensate) {
    progress({ stage: 'Routing condensate around the refrigerant', completed: 0, total: 0 });
    condensate = generateCondensateNetwork(applyRefrigerantProposal(scene, refrigerant), {
      settings: options.condensate.settings,
      routingSettings: options.refrigerant.settings,
      walls: options.condensate.walls,
      rooms: options.condensate.rooms,
      unitIds: options.condensate.unitIds,
      gullyIds: options.condensate.gullyIds,
      onProgress: (step) => progress({ stage: `Condensate: ${step.stage}`, completed: step.completed, total: step.total }),
    });
    issues.push(...condensate.issues);
  }

  progress({ stage: 'Checking clashes between services', completed: 0, total: 0 });
  const baseline = auditUnifiedCandidate(originalScene, { services, ducts, refrigerant, condensate, clashes: [], issues }, options);
  const candidates = [{ key: 'refrigerant-first', result: baseline }];
  // A second, bounded order reserves the less flexible gravity route first.
  // Ducts are held fixed; compare complete final assemblies, never independently
  // optimized service scores that ignore each other's physical space.
  const retry = wantsRefrigerant && condensate && (baseline.blockingIssues?.length
    || baseline.clashes.some(clash => !clash.resolvedByHop)
    || condensate.hopProposals.length || condensate.metrics.unitsConnected < condensate.metrics.unitsTotal
    || (refrigerant && !refrigerant.complete) || options.refrigerant.objective === 'cost');
  if (retry) {
    progress({ stage: 'Comparing a drainage-first layout', completed: 0, total: 1 });
    const replacedRefrigerant = new Set([...replaceableRefrigerant, ...(refrigerant?.removeElementIds ?? [])]);
    const drainBase = scene.filter((element) => !replacedDrains.has(element.id) && !replacedRefrigerant.has(element.id));
    const alternateDrains = generateCondensateNetwork(drainBase, {
      ...options.condensate, routingSettings: options.refrigerant.settings,
      onProgress: (step) => progress({ ...step, stage: `Drainage-first: ${step.stage}` }),
    });
    // Preserve the original drain removal scope even though replaced drains
    // were excluded from the routing scene above.
    alternateDrains.removeElementIds = [...replacedDrains];
    const reservedScene = [...scene.filter((element) => !replacedDrains.has(element.id)), ...alternateDrains.elementsToAdd];
    const paired = await planAutoRouteNetwork(reservedScene, {
      ...options.refrigerant,
      onProgress: (step) => progress({ ...step, stage: `Drainage-first refrigerant: ${step.stage}` }),
    });
    const alternateRefrigerant = services.gas && services.liquid ? paired
      : reduceRefrigerantResultToLine(paired, reservedScene, services.gas ? 'gas' : 'liquid');
    // Incomplete destructive rebuilds remain diagnostics; they cannot win or
    // replace the protected baseline network.
    if (!incompleteAutoRouteRefusal(alternateRefrigerant)) {
      candidates.push({ key: 'drainage-first', result: auditUnifiedCandidate(originalScene, {
        services, ducts, refrigerant: alternateRefrigerant, condensate: alternateDrains, clashes: [],
        issues: [...(ducts?.issues ?? []), ...alternateRefrigerant.issues, ...alternateDrains.issues],
      }, options) });
    }
  }
  const selected = rankServiceRouteCandidates(candidates, { objective: options.refrigerant.objective, baselineKey: 'refrigerant-first' })[0]!;
  return { ...selected.result, coordination: { strategy: selected.key as 'refrigerant-first' | 'drainage-first', candidatesEvaluated: candidates.length } };
}

const SERVICE_NAMES: Record<RoutedService, string> = {
  gas: 'gas pipe', liquid: 'liquid pipe', both: 'refrigerant pair', condensate: 'condensate pipe',
  'supply-duct': 'supply duct', 'return-duct': 'return duct', other: 'equipment',
};

/**
 * New duct contacts once everything is applied: new ducts against anything,
 * and new or changed pipes against any duct. Unchanged existing pairs are
 * ignored; changing either body requires checking the pair again.
 */
export function auditDuctClashes(
  originalScene: readonly HvacElement[],
  ducts: AutoRouteDuctResult | null,
  refrigerant: AutoRouteNetworkResult | null,
  condensate: CondensateGenerationResult | null,
  options: Pick<AutoRouteDuctOptions, 'settings'>,
  resolved?: { scene: readonly HvacElement[]; changedIds: readonly string[] },
): ServiceClash[] {
  const changed = new Set([
    ...(ducts?.elementsToAdd ?? []).map((element) => element.id),
    ...(ducts?.terminalUpdates ?? []).map((element) => element.id),
    ...(refrigerant ? [...refrigerant.elementsToAdd, ...refrigerant.updates].map((element) => element.id) : []),
    ...(condensate?.elementsToAdd ?? []).map((element) => element.id),
    ...(resolved?.changedIds ?? []),
  ]);
  if (!changed.size) return [];
  const afterDucts = applyDuctProposal(originalScene, ducts);
  const afterRefrigerant = applyRefrigerantProposal(afterDucts, refrigerant);
  const removedDrains = new Set(condensate?.removeElementIds ?? []);
  const finalScene = resolved ? [...resolved.scene] : [...afterRefrigerant.filter((element) => !removedDrains.has(element.id)), ...(condensate?.elementsToAdd ?? [])];
  const byId = new Map(finalScene.map((element) => [element.id, element]));
  const key = (clash: { ductId: string; otherId: string }) => [clash.ductId, clash.otherId].sort().join('|');
  const clashes: ServiceClash[] = [];
  const seen = new Set<string>();
  for (const clash of findDuctClashes(finalScene, options.settings, listNetworkPipeLanes(finalScene))) {
    const pair = key(clash);
    if (seen.has(pair) || (!changed.has(clash.ductId) && !changed.has(clash.otherId))) continue;
    seen.add(pair);
    const duct = byId.get(clash.ductId);
    const other = byId.get(clash.otherId);
    const services: [RoutedService, RoutedService] = [routedServiceOf(duct), routedServiceOf(other)];
    const name = (element: HvacElement | undefined, service: RoutedService) => `${SERVICE_NAMES[service]}${element?.label ? ` ${element.label}` : ''}`;
    clashes.push({
      elementIds: [clash.ductId, clash.otherId],
      services,
      distanceMm: null,
      requiredMm: null,
      message: clash.kind === 'terminal'
        ? `The ${name(duct, services[0])} passes through ${other?.label || 'an air terminal'}.`
        : `The ${name(duct, services[0])} (${clash.mark}) runs into the ${name(other, services[1])}.`,
      resolvedByHop: false,
    });
  }
  return clashes;
}

/**
 * 3D clash audit of everything this run adds or changes:
 *  - refrigerant ↔ refrigerant / other services: the network clearance check
 *    (only NEW contacts; existing ones are preserved, as everywhere else);
 *  - condensate ↔ refrigerant: the condensate validator's CD_CLASH, which
 *    applies the unit connection zone the generator also uses.
 */
export function auditServiceClashes(
  scene: readonly HvacElement[],
  refrigerant: AutoRouteNetworkResult | null,
  condensate: CondensateGenerationResult | null,
  hoppedScene?: readonly HvacElement[],
): ServiceClash[] {
  const clashes: ServiceClash[] = [];
  const afterRefrigerant = applyRefrigerantProposal(scene, refrigerant);
  const removedDrains = new Set(condensate?.removeElementIds ?? []);
  const finalScene = [
    ...afterRefrigerant.filter((element) => !removedDrains.has(element.id)),
    ...(condensate?.elementsToAdd ?? []),
  ];
  const byId = new Map(finalScene.map((element) => [element.id, element]));
  if (refrigerant && (refrigerant.elementsToAdd.length || refrigerant.updates.length)) {
    const proposed = [...refrigerant.elementsToAdd, ...refrigerant.updates];
    const removed = [...refrigerant.removeElementIds, ...removedDrains];
    for (const clash of findNewNetworkPipeClashes([...scene], proposed, removed)) {
      const [a, b] = clash.elementIds;
      const services: [RoutedService, RoutedService] = [routedServiceOf(byId.get(a)), routedServiceOf(byId.get(b))];
      // Drain contacts are judged by the condensate rules below (connection zone).
      if (services.includes('condensate')) continue;
      clashes.push({
        elementIds: clash.elementIds,
        services,
        distanceMm: clash.distanceMm,
        requiredMm: clash.requiredMm,
        message: `${services[0]} and ${services[1]} runs are ${Math.round(clash.distanceMm)} mm apart (need ${Math.round(clash.requiredMm)} mm).`,
        resolvedByHop: false,
      });
    }
  }
  const remaining = hoppedScene ? new Set(findCondensateRefrigerantClashes(hoppedScene).map((clash) => `${clash.condensateId}|${clash.refrigerantId}`)) : null;
  const changed = new Set([
    ...(refrigerant?.elementsToAdd ?? []).map((element) => element.id), ...(refrigerant?.updates ?? []).map((element) => element.id),
    ...(condensate?.elementsToAdd ?? []).map((element) => element.id),
  ]);
  for (const clash of findCondensateRefrigerantClashes(finalScene)) {
    if (!changed.has(clash.condensateId) && !changed.has(clash.refrigerantId)) continue;
    const service = routedServiceOf(byId.get(clash.refrigerantId));
    clashes.push({
      elementIds: [clash.condensateId, clash.refrigerantId],
      services: ['condensate', service],
      distanceMm: null,
      requiredMm: null,
      message: `Condensate pipe touches the ${service === 'gas' || service === 'liquid' ? `${service} ` : ''}refrigerant run ${byId.get(clash.refrigerantId)?.label ?? clash.refrigerantId}.`,
      resolvedByHop: remaining !== null && !remaining.has(`${clash.condensateId}|${clash.refrigerantId}`),
    });
  }
  return clashes;
}
