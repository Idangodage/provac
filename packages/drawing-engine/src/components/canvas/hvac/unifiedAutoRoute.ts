/**
 * One Auto route for every ticked service — gas, liquid, condensate —
 * coordinated so the services do not clash with each other.
 *
 * Order (and why):
 *  1. Refrigerant — the most constrained topology (unit ports, branch kits).
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
 *  3. Audit — every new pipe is checked in 3D against everything else;
 *     remaining contacts are reported, never silently dropped.
 */
import type { HvacElement, Room, Wall } from '../../../types';

import { incompleteAutoRouteRefusal } from './autoRouteCommand';
import { planAutoRouteNetwork, type AutoRouteNetworkOptions, type AutoRouteNetworkResult } from './autoRouteNetwork';
import { replaceableCondensatePipeIds } from './condensate/condensateEnvironment';
import { generateCondensateNetwork, type CondensateGenerationResult } from './condensate/condensateGenerator';
import type { CondensateDesignSettings } from './condensate/condensateSettings';
import { isCondensatePipe } from './condensate/condensateTypes';
import { findCondensateRefrigerantClashes } from './condensate/condensateValidation';
import { findNewNetworkPipeClashes } from './networkPipeClearance';
import { getAutoRouteOwnership, retainGeneratedPipeEdit } from './pipeEditRetention';
import { isRefrigerantBranchKitElement, resolveRefrigerantBranchKitLineSelection } from './refrigerantBranchKitModel';
import { resolveRefrigerantPipeSpec } from './refrigerantPipePairModel';

export interface AutoRouteServices {
  gas: boolean;
  liquid: boolean;
  condensate: boolean;
}

export type RoutedService = 'gas' | 'liquid' | 'both' | 'condensate' | 'other';

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
  /** Refrigerant proposal, already reduced to the ticked line(s). */
  refrigerant: AutoRouteNetworkResult | null;
  condensate: CondensateGenerationResult | null;
  clashes: ServiceClash[];
  issues: string[];
}

export function routedServiceOf(element: HvacElement | undefined): RoutedService {
  if (!element) return 'other';
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

  const isRefrigerant = (element: HvacElement) => routedServiceOf(element) !== 'other' && routedServiceOf(element) !== 'condensate';
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

export async function planUnifiedAutoRoute(scene: HvacElement[], options: UnifiedAutoRouteOptions): Promise<UnifiedAutoRouteResult> {
  const { services } = options;
  const progress = options.onProgress ?? (() => undefined);
  const issues: string[] = [];
  const wantsRefrigerant = services.gas || services.liquid;
  if (!wantsRefrigerant && !services.condensate) {
    return { services, refrigerant: null, condensate: null, clashes: [], issues: ['Tick at least one service to route.'] };
  }

  // Drains this run will regenerate must not shape the refrigerant layout.
  const replacedDrains = services.condensate
    ? new Set(replaceableCondensatePipeIds(scene, options.condensate.settings, options.condensate))
    : new Set<string>();

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
  const clashes = auditServiceClashes(scene, refrigerant, condensate);
  if (clashes.some((clash) => !clash.resolvedByHop)) {
    issues.push(`${clashes.filter((clash) => !clash.resolvedByHop).length} pipe clash${clashes.length === 1 ? '' : 'es'} between services remain — see the clash list.`);
  }
  return { services, refrigerant, condensate, clashes, issues };
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
  const hopTargets = new Set((condensate?.hopProposals ?? []).map((proposal) => proposal.refrigerantElementId));
  for (const clash of findCondensateRefrigerantClashes(finalScene)) {
    const service = routedServiceOf(byId.get(clash.refrigerantId));
    clashes.push({
      elementIds: [clash.condensateId, clash.refrigerantId],
      services: ['condensate', service],
      distanceMm: null,
      requiredMm: null,
      message: `Condensate pipe touches the ${service === 'gas' || service === 'liquid' ? `${service} ` : ''}refrigerant run ${byId.get(clash.refrigerantId)?.label ?? clash.refrigerantId}.`,
      resolvedByHop: hopTargets.has(clash.refrigerantId),
    });
  }
  return clashes;
}
