import type { HvacElement, Point2D } from '../../../types';

import { resolveCopperSocketElbow, resolveCopperSocketElbowMinimumRadius, usesCopperSocketElbows } from './copperSocketElbows';
import { findSampledQuarterTurns } from './pipeRiserCornerProjection';
import { generateRiserTurnAlternatives } from './pipeRiserOptimization';
import { liftPipePlanRouteTo3d, normalizePipeRouteNodes3d, type PipeRouteNode3D } from './pipeRoute3d';
import { getActivePipeRoutingSettings, type PipeRoutingSettings } from './pipeRoutingSettings';
import { buildRefrigerantBranchKitViewModel } from './refrigerantBranchKitModel';
import {
  resolveRefrigerantPipeSpec,
  type RefrigerantPipeBundleConnection,
  type RefrigerantPipeConnection,
} from './refrigerantPipePairModel';

type Service = 'gas' | 'liquid';
const EPS = 0.5;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

export interface NetworkLevelSummary {
  gasElevationMm: number;
  liquidElevationMm: number;
  clearGapMm: number;
  coordinatedRunCount: number;
  connectedIndoorCount: number;
  connectedOutdoorCount: number;
  transitionCount: number;
  verticalTravelMm: number;
  requiresCoordination: boolean;
  notes: string[];
}

export interface NetworkPipeLevelPlan extends NetworkLevelSummary {
  id: string;
  feasible: boolean;
  issues: string[];
  affectedIds: string[];
  /** Exact source snapshot for rejecting stale apply operations. */
  sourceSignatures: Record<string, string>;
  updates: HvacElement[];
  settings: PipeRoutingSettings;
  /** A checked straight-riser fallback must survive preview and reapplication. */
  preferCornerRisers?: boolean;
  /** Stable through branch preview/commit even when connection pipe IDs change. */
  cornerRisersByService?: Partial<Record<Service, boolean>>;
  /** Auto route reserves the main until all takeoffs have physical sockets. */
  deferRiserTurnOptimization?: boolean;
  lockedRoutes: Array<{ sourceIds: string[]; service: Service; nodes: PipeRouteNode3D[] }>;
}

interface PipeEntry {
  element: HvacElement;
  service: Service;
  radius: number;
  socketPipeDiameterMm?: number;
  minimumBendRadiusMm: number;
  level: number;
  nodes: PipeRouteNode3D[];
  locked: boolean;
  start: RefrigerantPipeConnection | null;
  end: RefrigerantPipeConnection | null;
  routePoints: Point2D[];
}

export function networkLevelSourceSignature(element: HvacElement): string {
  return JSON.stringify(element);
}

/** Explicit network identities only: proximity and plan crossings never join systems. */
function connectedScope(scene: HvacElement[], seeds: string[]): HvacElement[] {
  const groups = new Map<string, string[]>();
  const byId = new Map(scene.map(element => [element.id, element]));
  const add = (key: string, id: string) => groups.set(key, [...(groups.get(key) ?? []), id]);
  for (const element of scene) {
    add(`id:${element.id}`, element.id);
    for (const key of ['bundleId', 'teeId']) {
      const value = element.properties[key];
      if (typeof value === 'string' && value) {
        add(`${key}:${value}`, element.id);
        if (key === 'bundleId') add(`id:${value}`, element.id);
      }
    }
    for (const key of ['startConnection', 'endConnection', 'startBundleConnection', 'endBundleConnection']) {
      const connection = record(element.properties[key]);
      for (const sourceKey of ['sourceElementId', 'gasSourceElementId', 'liquidSourceElementId']) {
        if (typeof connection[sourceKey] === 'string') add(`id:${connection[sourceKey]}`, element.id);
      }
      for (const identity of ['nodeId', 'portId', 'gasNodeId', 'liquidNodeId', 'gasPortId', 'liquidPortId']) {
        if (typeof connection[identity] === 'string') add(`port:${connection[identity]}`, element.id);
      }
    }
  }
  const adjacency = new Map<string, Set<string>>();
  for (const group of groups.values()) {
    const first = group[0]!;
    for (const id of group) {
      if (!adjacency.has(first)) adjacency.set(first, new Set());
      if (!adjacency.has(id)) adjacency.set(id, new Set());
      adjacency.get(first)!.add(id);
      adjacency.get(id)!.add(first);
    }
  }
  const visited = new Set<string>();
  const queue = seeds.flatMap(seed => byId.has(seed) ? [seed] : groups.get(`bundleId:${seed}`) ?? []);
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const next of adjacency.get(id) ?? []) if (!visited.has(next)) queue.push(next);
  }
  return scene.filter(element => visited.has(element.id));
}

function pipeEntries(scope: HvacElement[]): PipeEntry[] {
  return scope.filter(element => element.type === 'refrigerant-pipe').map(element => {
    const spec = resolveRefrigerantPipeSpec(element.properties);
    const nodes = normalizePipeRouteNodes3d(element.properties.routeNodes3d);
    const managed = record(element.properties.networkLevelPlan).generated === true;
    const varying = nodes.length > 1 && Math.max(...nodes.map(node => node.z)) - Math.min(...nodes.map(node => node.z)) > EPS;
    const level = finite(record(element.properties.networkLevelPlan).corridorElevationMm)
      ? record(element.properties.networkLevelPlan).corridorElevationMm as number
      : nodes[Math.floor(nodes.length / 2)]?.z ?? spec.startConnection?.elevationMm ?? spec.endConnection?.elevationMm ?? element.elevation + spec.outerDiameterMm / 2;
    return { element, service: spec.lineKind, radius: spec.outerDiameterMm / 2, level, nodes,
      socketPipeDiameterMm: usesCopperSocketElbows(element.properties) ? spec.pipeDiameterMm : undefined,
      minimumBendRadiusMm: resolveCopperSocketElbowMinimumRadius(element.properties),
      start: spec.startConnection, end: spec.endConnection, routePoints: spec.routePoints,
      locked: element.properties.networkLevelLocked === true || (!managed && varying)
        || (Array.isArray(element.properties.bypasses) && element.properties.bypasses.length > 0),
    };
  });
}

interface Terminal { service: Service; level: number; outdoor: boolean; id: string }

/** Both vertical elbows and protected straights must fit the complete cup
 * mouths. An uninsulated pipe's small envelope is not a fitting takeoff. */
function riserBendExtentMm(radius: number, settings: PipeRoutingSettings,
  pipeDiameterMm?: number, minimumBendRadiusMm = 0): number {
  const socket = finite(pipeDiameterMm) ? resolveCopperSocketElbow(pipeDiameterMm, 90) : null;
  return Math.max(1, radius * 2 * settings.bendRadiusFactor, settings.minimumFieldBendRadiusMm,
    minimumBendRadiusMm, socket?.centerToFaceMm ?? 0);
}

function collectTerminals(entries: PipeEntry[], scope: HvacElement[], start: RefrigerantPipeBundleConnection): Terminal[] {
  const outdoorIds = new Set(scope.filter(element => element.type === 'outdoor-unit').map(element => element.id));
  const terminals = new Map<string, Terminal>();
  for (const entry of entries) for (const connection of [entry.start, entry.end]) {
    if (connection?.connectionKind !== 'unit-port') continue;
    const id = connection.sourceElementId ?? `${entry.element.id}:${connection.portId ?? 'port'}`;
    terminals.set(`${id}:${entry.service}`, { id, service: entry.service, level: connection.elevationMm, outdoor: outdoorIds.has(id) });
  }
  if (start.connectionKind === 'unit-port') for (const service of ['gas', 'liquid'] as const) {
    const id = start.sourceElementId ?? 'proposed-unit';
    terminals.set(`${id}:${service}`, { id, service, level: service === 'gas' ? start.gasElevationMm : start.liquidElevationMm, outdoor: outdoorIds.has(id) });
  }
  return [...terminals.values()];
}

/** Lexicographic objective: low-pocket depth, reversal travel, transitions,
 * total travel, indoor distribution proximity, existing-level displacement.
 * These are geometric costs, not pressure loss. */
function levelCost(gas: number, liquid: number, services: Array<{ service: Service; ports: Terminal[]; outdoors: Terminal[] }>, entries: PipeEntry[]): number[] {
  let reversalTravel = 0;
  let lowPocketDepth = 0;
  let transitions = 0;
  let travel = 0;
  let indoorTravel = 0;
  for (const { service, ports, outdoors } of services) {
    const level = service === 'gas' ? gas : liquid;
    for (const port of ports) {
      const difference = Math.abs(level - port.level);
      travel += difference;
      if (!port.outdoor) indoorTravel += difference;
      if (difference > EPS) transitions += 1;
      if (!port.outdoor) for (const outdoor of outdoors) {
        lowPocketDepth += Math.max(0, Math.min(outdoor.level, port.level) - level);
        reversalTravel += Math.max(0, Math.abs(outdoor.level - level) + difference - Math.abs(outdoor.level - port.level));
      }
    }
  }
  const movement = entries.reduce((sum, entry) => sum + Math.abs(entry.level - (entry.service === 'gas' ? gas : liquid)), 0);
  // When transition count and total travel tie, keep distribution near the
  // served indoor zone and take the common rise near the outdoor connection.
  // This avoids favoring repeated tall indoor drops solely because the first
  // piece of main happened to be drawn from the low outdoor port.
  return [lowPocketDepth, reversalTravel, transitions, travel, indoorTravel, movement];
}

function compareCost(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (Math.abs(a[i]! - b[i]!) > EPS) return a[i]! - b[i]!;
  return 0;
}

export interface NetworkPipeLevelOptions {
  gasHostId: string;
  liquidHostId: string;
  startBundle: RefrigerantPipeBundleConnection;
  gasHostElevationMm: number;
  liquidHostElevationMm: number;
  settings?: PipeRoutingSettings;
  /** Layouts whose new branch approach failed; try the next feasible corridor. */
  excludedLevels?: Array<{ gas: number; liquid: number }>;
  deferRiserTurnOptimization?: boolean;
}

const levelPlanCache = new WeakMap<HvacElement[], Map<string, NetworkPipeLevelPlan>>();

/** Pointer movement changes the fitting station much more often than network
 * inputs. Reuse the level analysis within the immutable scene snapshot. */
export function planNetworkPipeLevels(scene: HvacElement[], options: NetworkPipeLevelOptions): NetworkPipeLevelPlan {
  const resolved = { ...options, settings: options.settings ?? getActivePipeRoutingSettings() };
  const key = JSON.stringify(resolved);
  let cache = levelPlanCache.get(scene);
  if (!cache) { cache = new Map(); levelPlanCache.set(scene, cache); }
  let plan = cache.get(key);
  if (plan && !isNetworkLevelPlanCurrent(plan, scene)) plan = undefined;
  if (!plan) {
    plan = computeNetworkPipeLevels(scene, resolved);
    if (cache.size >= 32) cache.clear();
    cache.set(key, plan);
  }
  // Proposal-specific clearance findings must not mutate the cached analysis.
  return { ...plan, issues: [...plan.issues], notes: [...plan.notes] };
}

/** Choose one service corridor for the connected component, considering both
 * vertical orders and actual terminal elevations. No per-crossing hops. */
function computeNetworkPipeLevels(scene: HvacElement[], options: NetworkPipeLevelOptions): NetworkPipeLevelPlan {
  const settings = options.settings ?? getActivePipeRoutingSettings();
  const start = options.startBundle;
  const scope = connectedScope(scene, [options.gasHostId, options.liquidHostId, start.sourceElementId ?? '', start.gasSourceElementId ?? '', start.liquidSourceElementId ?? '']);
  const entries = pipeEntries(scope);
  const preparedEntries = new Map(entries.map(entry => [entry.element.id, entry]));
  const terminals = collectTerminals(entries, scope, start);
  // Membership is invariant across level candidates. Keep source order so the
  // floating-point cost accumulation and every lexicographic tie stay identical.
  const terminalServices = (['gas', 'liquid'] as const).map(service => {
    const ports = terminals.filter(terminal => terminal.service === service);
    return { service, ports, outdoors: ports.filter(terminal => terminal.outdoor) };
  });
  const gasRadius = Math.max(1, ...entries.filter(entry => entry.service === 'gas').map(entry => entry.radius), (start.gasOuterDiameterMm ?? 0) / 2);
  const liquidRadius = Math.max(1, ...entries.filter(entry => entry.service === 'liquid').map(entry => entry.radius), (start.liquidOuterDiameterMm ?? 0) / 2);
  const serviceBendExtent = (service: Service) => Math.max(
    riserBendExtentMm(service === 'gas' ? gasRadius : liquidRadius, settings),
    ...entries.filter(entry => entry.service === service).map(entry => riserBendExtentMm(entry.radius, settings,
      entry.socketPipeDiameterMm, entry.minimumBendRadiusMm)));
  const clearGap = Math.max(0, settings.defaultPipeGapMm, settings.zOffsetClearanceMm);
  const separation = gasRadius + liquidRadius + clearGap;
  const gasBounds = [settings.floorLimitMm + gasRadius, settings.ceilingLimitMm - gasRadius];
  const liquidBounds = [settings.floorLimitMm + liquidRadius, settings.ceilingLimitMm - liquidRadius];
  const issues: string[] = [];
  const notes: string[] = [];
  const outdoorCount = new Set(terminals.filter(port => port.outdoor).map(port => port.id)).size;
  if (outdoorCount > 1) issues.push('Multiple outdoor modules require their manufacturer piping arrangement; shared-level changes are not applied automatically.');
  if (scope.some(element => element.type === 'refrigerant-pipe-pair')) issues.push('Convert legacy composite pipes to editable gas/liquid runs before coordinating network levels.');
  const levels: Record<Service, number[]> = { gas: [options.gasHostElevationMm], liquid: [options.liquidHostElevationMm] };
  for (const entry of entries) levels[entry.service].push(entry.level);
  for (const port of terminals) levels[port.service].push(port.level);
  // A plumb riser needs room for both full-radius 90-degree bends. Include
  // nearby buildable levels instead of squeezing those bends into a tiny rise
  // or stretching a small level difference into an inclined distribution run.
  for (const service of ['gas', 'liquid'] as const) {
    const minimumRise = serviceBendExtent(service) * 2;
    const terminalLevels = terminals.filter(port => port.service === service).map(port => port.level);
    levels[service].push(...terminalLevels.flatMap(level => [level - minimumRise, level + minimumRise]));
  }
  const fixed: Record<Service, number[]> = { gas: [], liquid: [] };
  for (const entry of entries) if (entry.locked) fixed[entry.service].push(entry.level);
  for (const element of scope) if (element.type === 'refrigerant-branch-kit' && element.properties.networkLevelLocked === true) {
    const model = buildRefrigerantBranchKitViewModel(element);
    const kind = element.properties.branchKitLineKind;
    for (const service of ['gas', 'liquid'] as const) if (kind === service || kind === 'both') fixed[service].push(element.elevation + model[service].centerlineZMm);
  }
  const proposedMinimumRise: Record<Service, number> = { gas: 0, liquid: 0 };
  if (start.connectionKind === 'unit-port') for (const service of ['gas', 'liquid'] as const) {
    const diameter = service === 'gas' ? start.gasOuterDiameterMm : start.liquidOuterDiameterMm;
    const ownEntries = entries.filter(entry => entry.service === service
      && [entry.start, entry.end].some(connection => connection?.connectionKind === 'unit-port'
        && connection.sourceElementId === start.sourceElementId));
    proposedMinimumRise[service] = Math.max(
      riserBendExtentMm((diameter ?? (service === 'gas' ? gasRadius : liquidRadius) * 2) / 2, settings),
      ...ownEntries.map(entry => riserBendExtentMm(entry.radius, settings, entry.socketPipeDiameterMm, entry.minimumBendRadiusMm))) * 2;
  }
  const admissible = (level: number, service: Service) => {
    const bounds = service === 'gas' ? gasBounds : liquidBounds;
    if (start.connectionKind === 'unit-port') {
      const terminalLevel = service === 'gas' ? start.gasElevationMm : start.liquidElevationMm;
      const minimumRise = proposedMinimumRise[service];
      const rise = Math.abs(level - terminalLevel);
      if (rise > 1e-6 && rise < minimumRise - 1e-6) return false;
    }
    return level >= bounds[0]! - EPS && level <= bounds[1]! + EPS && fixed[service].every(value => Math.abs(value - level) <= EPS);
  };
  const gasCandidates = new Set([...levels.gas, ...levels.liquid.flatMap(z => [z - separation, z + separation]), ...gasBounds]);
  const liquidCandidates = new Set([...levels.liquid, ...levels.gas.flatMap(z => [z - separation, z + separation]), ...liquidBounds]);
  type Candidate = { gas: number; liquid: number; cost: number[] };
  const candidates: Candidate[] = [];
  const excluded = (gas: number, liquid: number) => options.excludedLevels?.some(pair =>
    Math.abs(pair.gas - gas) <= EPS && Math.abs(pair.liquid - liquid) <= EPS) ?? false;
  for (const gas of gasCandidates) for (const liquid of liquidCandidates) {
    if (excluded(gas, liquid) || !admissible(gas, 'gas') || !admissible(liquid, 'liquid') || Math.abs(gas - liquid) < separation - EPS) continue;
    candidates.push({ gas, liquid, cost: levelCost(gas, liquid, terminalServices, entries) });
  }
  // Keep the services in one compact distribution corridor after screening
  // low points/reversals. Saving one terminal transition must not spread a
  // normal pair across an entire storey and obstruct every later takeoff.
  candidates.sort((a, b) => compareCost(a.cost.slice(0, 2), b.cost.slice(0, 2))
    || compareCost([Math.abs(a.gas - a.liquid)], [Math.abs(b.gas - b.liquid)])
    || (options.excludedLevels?.length && start.connectionKind === 'unit-port'
      ? compareCost(
        [Math.abs(a.gas - start.gasElevationMm) + Math.abs(a.liquid - start.liquidElevationMm)],
        [Math.abs(b.gas - start.gasElevationMm) + Math.abs(b.liquid - start.liquidElevationMm)],
      ) : 0)
    || compareCost(a.cost.slice(2), b.cost.slice(2))
    || a.gas - b.gas || a.liquid - b.liquid);
  const preferExisting = (gas: number, liquid: number) => {
    if (excluded(gas, liquid) || !admissible(gas, 'gas') || !admissible(liquid, 'liquid') || Math.abs(gas - liquid) < separation - EPS) return;
    const existingIndex = candidates.findIndex(candidate => Math.abs(candidate.gas - gas) <= EPS && Math.abs(candidate.liquid - liquid) <= EPS);
    if (existingIndex >= 0) candidates.splice(existingIndex, 1);
    candidates.unshift({ gas, liquid, cost: levelCost(gas, liquid, terminalServices, entries) });
  };
  const established = entries.find(entry => record(entry.element.properties.networkLevelPlan).generated === true);
  const metadata = record(established?.element.properties.networkLevelPlan);
  const managedGap = finite(metadata.gasElevationMm) && finite(metadata.liquidElevationMm)
    ? Math.abs(metadata.gasElevationMm - metadata.liquidElevationMm) : 0;
  const legacyWideCorridor = established && metadata.version !== 2 && managedGap > separation + EPS;
  // An earlier generated, excessively separated corridor is eligible for a
  // compact replacement. Actual authored/locked levels still constrain it,
  // and any geometry change is disclosed before the coordinated commit.
  if (!legacyWideCorridor) preferExisting(options.gasHostElevationMm, options.liquidHostElevationMm);
  // Keep an established managed corridor stable when it is still admissible:
  // connecting another unit must not progressively raise/lower the whole system.
  if (established && !legacyWideCorridor) {
    const gas = metadata.gasElevationMm; const liquid = metadata.liquidElevationMm;
    if (finite(gas) && finite(liquid)) preferExisting(gas, liquid);
  }
  let best = candidates[0] ?? null;
  if (!best) issues.push('The required insulated service separation does not fit the available levels and authored/locked routes. Review the network corridor instead of adding local offsets.');
  if (entries.some(entry => entry.locked)) notes.push('Authored risers, explicit offsets and locked routes retain their geometry.');
  if (!outdoorCount) notes.push('Outdoor connection is unresolved; level planning uses connected equipment only.');
  const plan: NetworkPipeLevelPlan = {
    id: `network-level:${[options.gasHostId, options.liquidHostId].sort().join(':')}`,
    feasible: issues.length === 0, issues, notes, settings,
    deferRiserTurnOptimization: options.deferRiserTurnOptimization
      ?? scope.some(element => record(element.properties.networkLevelPlan).deferRiserTurnOptimization === true),
    gasElevationMm: best?.gas ?? options.gasHostElevationMm,
    liquidElevationMm: best?.liquid ?? options.liquidHostElevationMm,
    clearGapMm: best ? Math.abs(best.gas - best.liquid) - gasRadius - liquidRadius : 0,
    coordinatedRunCount: 0,
    connectedIndoorCount: new Set(terminals.filter(port => !port.outdoor).map(port => port.id)).size,
    connectedOutdoorCount: outdoorCount,
    transitionCount: best?.cost[2] ?? 0, verticalTravelMm: best?.cost[3] ?? 0,
    requiresCoordination: false,
    affectedIds: scope.map(element => element.id),
    sourceSignatures: Object.fromEntries(scope.map(element => [element.id, networkLevelSourceSignature(element)])),
    updates: [],
    lockedRoutes: entries.filter(entry => entry.locked).map(entry => ({
      sourceIds: [entry.element.id, typeof entry.element.properties.bundleId === 'string' ? entry.element.properties.bundleId : ''].filter(Boolean),
      service: entry.service,
      nodes: entry.nodes.length >= 2 ? entry.nodes : entry.routePoints.map(point => ({ ...point, z: entry.level })),
    })),
  };
  if (plan.feasible) {
    // Evaluate only as many candidates as needed, in geometric cost order.
    // A good elevation score cannot compensate for an approach too short to
    // build: another service order may leave that short approach level.
    let firstFailure: string[] | null = null;
    let accepted = false;
    for (const candidate of candidates) {
      const trial = { ...plan, gasElevationMm: candidate.gas, liquidElevationMm: candidate.liquid,
        clearGapMm: Math.abs(candidate.gas - candidate.liquid) - gasRadius - liquidRadius,
        transitionCount: candidate.cost[2] ?? 0, verticalTravelMm: candidate.cost[3] ?? 0 };
      const result = applyPreparedNetworkPipeLevels(scope, trial, preparedEntries);
      if (result.issues.length) { firstFailure ??= result.issues; continue; }
      best = candidate;
      Object.assign(plan, trial, { updates: result.elements });
      accepted = true;
      break;
    }
    if (!accepted) {
      plan.feasible = false;
      plan.issues.push(...(firstFailure ?? ['No shared service levels fit the existing approaches.']));
    }
  }
  if (best && best.cost[0]! > EPS) notes.push('The available corridor creates a potential low pocket between equipment. Review the manufacturer arrangement before installation.');
  else if (best && best.cost[1]! > EPS) notes.push('These terminal levels require a network rise/fall reversal. Review the selected manufacturer arrangement.');
  return summarizeNetworkLevelChanges(plan, scope);
}

function summarizeNetworkLevelChanges(plan: NetworkPipeLevelPlan, scope: HvacElement[]): NetworkPipeLevelPlan {
  const settings = plan.settings;
  // Compare the physical centreline, ignoring redundant sample points and
  // metadata-only adoption. A change to a remote branch must be disclosed even
  // when the tapped mains keep their existing levels.
  const geometryNodes = (element: HvacElement): PipeRouteNode3D[] => {
    const spec = resolveRefrigerantPipeSpec(element.properties);
    const authored = normalizePipeRouteNodes3d(element.properties.routeNodes3d);
    const baseline = spec.startConnection?.elevationMm ?? spec.endConnection?.elevationMm ?? element.elevation + spec.outerDiameterMm / 2;
    const guide = authored.length >= 2 ? authored : spec.routePoints.map(point => ({ ...point, z: baseline }));
    const nodes = liftPipePlanRouteTo3d(spec.routePoints, guide, { startConnection: spec.startConnection, endConnection: spec.endConnection,
      minimumPortStubMm: settings.minimumPortStubMm, outerDiameterMm: spec.outerDiameterMm,
      bendRadiusMm: spec.outerDiameterMm * settings.bendRadiusFactor,
      pipeDiameterMm: usesCopperSocketElbows(element.properties) ? spec.pipeDiameterMm : undefined,
      minimumBendRadiusMm: Math.max(settings.minimumFieldBendRadiusMm, resolveCopperSocketElbowMinimumRadius(element.properties)) });
    const simplified: PipeRouteNode3D[] = [];
    for (const node of nodes) {
      simplified.push(node);
      while (simplified.length >= 3) {
        const a = simplified.at(-3)!; const b = simplified.at(-2)!; const c = simplified.at(-1)!;
        const dx = c.x - a.x; const dy = c.y - a.y; const dz = c.z - a.z;
        const squaredLength = dx * dx + dy * dy + dz * dz;
        if (squaredLength <= 1e-10) break;
        const t = ((b.x - a.x) * dx + (b.y - a.y) * dy + (b.z - a.z) * dz) / squaredLength;
        if (t < 0 || t > 1 || Math.hypot(b.x - a.x - t * dx, b.y - a.y - t * dy, b.z - a.z - t * dz) > EPS) break;
        simplified.splice(simplified.length - 2, 1);
      }
    }
    return simplified;
  };
  const originals = new Map(scope.map(element => [element.id, element]));
  const geometricallyChanged = plan.updates.filter(update => {
    const original = originals.get(update.id);
    if (!original) return true;
    if (update.type !== 'refrigerant-pipe') return Math.abs(update.elevation - original.elevation) > EPS;
    const before = geometryNodes(original); const after = geometryNodes(update);
    return before.length !== after.length || before.some((node, index) => {
      const next = after[index]!; return Math.hypot(node.x - next.x, node.y - next.y, node.z - next.z) > EPS;
    });
  });
  plan.coordinatedRunCount = geometricallyChanged.filter(element => element.type === 'refrigerant-pipe').length;
  plan.requiresCoordination = geometricallyChanged.length > 0;
  return plan;
}

/** Rebuild only riser stations at the accepted service levels. Callers must
 * check complete scene clearances before accepting the returned candidate. */
export function replanNetworkPipeRisers(scene: HvacElement[], plan: NetworkPipeLevelPlan,
  preferCornerRisers: boolean, cornerRisersByService?: NetworkPipeLevelPlan['cornerRisersByService']): NetworkPipeLevelPlan {
  const affected = new Set(plan.affectedIds);
  const scope = scene.filter(element => affected.has(element.id));
  const candidate = { ...plan, preferCornerRisers, cornerRisersByService,
    issues: [...plan.issues], notes: [...plan.notes], updates: [] as HvacElement[] };
  if (!plan.feasible) return candidate;
  const rebuilt = applyNetworkPipeLevels(scope, candidate);
  candidate.updates = rebuilt.elements;
  if (rebuilt.issues.length) { candidate.feasible = false; candidate.issues.push(...rebuilt.issues); }
  return summarizeNetworkLevelChanges(candidate, scope);
}

/** Avoid repeating clearance searches when a rejected candidate has no
 * combined rise/turn to replace. This scans persisted stations, not meshes. */
export function hasNetworkCornerRiser(elements: readonly HvacElement[]): boolean {
  return elements.some(element => {
    const nodes = normalizePipeRouteNodes3d(element.properties.routeNodes3d);
    for (let index = 1; index < nodes.length - 2; index += 1) {
      const a = nodes[index - 1]!; const b = nodes[index]!; const c = nodes[index + 1]!; const d = nodes[index + 2]!;
      if (Math.hypot(c.x - b.x, c.y - b.y) > 1e-6 || Math.abs(c.z - b.z) < 1e-6
        || Math.abs(a.z - b.z) > 1e-6 || Math.abs(d.z - c.z) > 1e-6) continue;
      const incoming = Math.hypot(b.x - a.x, b.y - a.y); const outgoing = Math.hypot(d.x - c.x, d.y - c.y);
      if (incoming > 1e-6 && outgoing > 1e-6
        && Math.abs((b.x - a.x) * (d.x - c.x) + (b.y - a.y) * (d.y - c.y)) <= incoming * outgoing * 1e-6) return true;
    }
    return false;
  });
}

/** Construct level approaches and plumb terminal risers. A riser at the first
 * eligible plan corner turns in two vertical planes, consuming that existing
 * direction change with its two elbows instead of adding a third elbow.
 * The trunk stays on its corridor between units. */
export function buildNetworkLevelRoute(inputRoute: Point2D[], corridor: number, options: {
  start?: RefrigerantPipeConnection | null;
  end?: RefrigerantPipeConnection | null;
  radiusMm: number;
  /** Supply only for CxC construction; formed tube retains its bend policy. */
  pipeDiameterMm?: number;
  minimumBendRadiusMm?: number;
  preferCornerRisers?: boolean;
  deferRiserTurnOptimization?: boolean;
  /** Final complete-network checks may compare every independent riser move. */
  includeRiserAlternatives?: boolean;
  settings: PipeRoutingSettings;
}): { nodes: PipeRouteNode3D[]; issue?: string; alternativeNodes?: PipeRouteNode3D[][] } {
  // Paired physical lanes already contain sampled circular elbows. Recover
  // their exact tangent intersections for station planning; otherwise each
  // little arc chord hides the existing 90-degree corner from the optimizer.
  // Only the elevation guide uses these intersections. Saved plan lanes stay
  // immutable, and the shared lift preserves their other rounded elbows.
  const needsTransition = [options.start, options.end].some(connection => connection
    && Math.abs(connection.elevationMm - corridor) > 1e-6);
  const sampledCorners = needsTransition && options.preferCornerRisers !== false ? new Map(findSampledQuarterTurns(inputRoute)
    .map(corner => [corner.startIndex, corner])) : null;
  const engineeringRoute: Point2D[] = [];
  for (let index = 0; index < inputRoute.length; index += 1) {
    const corner = sampledCorners?.get(index);
    engineeringRoute.push(corner?.corner ?? inputRoute[index]!);
    if (corner) index = corner.endIndex;
  }
  // Multiple clicks along one straight do not divide its usable approach.
  // Keep true corners and reversals; only remove duplicate/collinear stations.
  const route: Point2D[] = [];
  for (const point of engineeringRoute) {
    const last = route.at(-1);
    if (last && Math.hypot(point.x - last.x, point.y - last.y) <= 1e-6) continue;
    route.push(point);
    while (route.length >= 3) {
      const a = route.at(-3)!; const b = route.at(-2)!; const c = route.at(-1)!;
      const dx = c.x - a.x; const dy = c.y - a.y;
      const lengthSquared = dx * dx + dy * dy;
      if (lengthSquared <= 1e-12) break;
      const t = ((b.x - a.x) * dx + (b.y - a.y) * dy) / lengthSquared;
      if (t < 0 || t > 1 || Math.hypot(b.x - a.x - t * dx, b.y - a.y - t * dy) > 1e-6) break;
      route.splice(route.length - 2, 1);
    }
  }
  if (route.length < 2) return { nodes: [], issue: 'A level route needs two distinct plan points.' };
  const lengths = [0];
  for (let i = 1; i < route.length; i += 1) lengths.push(lengths[i - 1]! + Math.hypot(route[i]!.x - route[i - 1]!.x, route[i]!.y - route[i - 1]!.y));
  const total = lengths.at(-1)!;
  const z0 = options.start?.elevationMm ?? corridor;
  const z1 = options.end?.elevationMm ?? corridor;
  const radius = riserBendExtentMm(options.radiusMm, options.settings, options.pipeDiameterMm, options.minimumBendRadiusMm);
  const straight = (connection?: RefrigerantPipeConnection | null) => Math.max(radius * 2, !connection ? 0 :
    (connection.connectionKind === 'unit-port' ? options.settings.minimumPortStubMm : options.settings.defaultBranchKitClearanceMm) + radius);
  const startProtected = straight(options.start);
  const endProtected = straight(options.end);
  const needsStart = Math.abs(z0 - corridor) > 1e-6;
  const needsEnd = Math.abs(z1 - corridor) > 1e-6;
  if ((needsStart && Math.abs(z0 - corridor) < radius * 2 - 1e-6)
    || (needsEnd && Math.abs(z1 - corridor) < radius * 2 - 1e-6)) {
    return { nodes: [], issue: 'The level difference is too small for two full-radius 90-degree bends. Keep the approach level or choose another corridor level.' };
  }
  // A corner can host the vertical stack itself: incoming horizontal -> Z ->
  // outgoing horizontal. Only the nearest actual corner at each terminal is
  // eligible; moving past other corners would spread a terminal level through
  // the distribution route merely to save a fitting at a remote location.
  const cornerStation = (fromEnd: boolean): number | null => {
    if (route.length < 3) return null;
    const index = fromEnd ? route.length - 2 : 1;
    const a = route[index - 1]!; const b = route[index]!; const c = route[index + 1]!;
    const incoming = Math.hypot(b.x - a.x, b.y - a.y);
    const outgoing = Math.hypot(c.x - b.x, c.y - b.y);
    const cosine = ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (incoming * outgoing);
    if (Math.abs(cosine) > 1e-6) return null;
    const station = lengths[index]!;
    const terminalLead = fromEnd ? outgoing : incoming;
    const corridorLead = fromEnd ? incoming : outgoing;
    if (terminalLead < (fromEnd ? endProtected : startProtected) - 1e-6
      || corridorLead < radius * 2 - 1e-6
      || station < startProtected - 1e-6 || station > total - endProtected + 1e-6) return null;
    return station;
  };
  // Retain the straight-span solution when a corner cannot host both elbows.
  // Reserve both bend setbacks next to plan corners and between risers. Height
  // does not consume horizontal run: a tall outdoor rise stays localized.
  const findRiser = (fromEnd: boolean, minimum: number, maximum: number): number | null => {
    const candidates: number[] = [];
    for (let i = 1; i < lengths.length; i += 1) {
      const lo = Math.max(minimum, lengths[i - 1]! + radius * 2);
      const hi = Math.min(maximum, lengths[i]! - radius * 2);
      if (hi >= lo - 1e-6) candidates.push(fromEnd ? hi : lo);
    }
    return candidates.length ? (fromEnd ? candidates.at(-1)! : candidates[0]!) : null;
  };
  const startCorner = needsStart && options.preferCornerRisers !== false ? cornerStation(false) : null;
  const endCorner = needsEnd && options.preferCornerRisers !== false ? cornerStation(true) : null;
  let bestStations: { start: number; end: number; corners: number; terminalTravel: number } | null = null;
  // Jointly choose the two terminal stations. Independent corner selection can
  // put both risers at the same corner or consume the straight between them.
  for (const useStartCorner of startCorner === null ? [false] : [true, false]) {
    for (const useEndCorner of endCorner === null ? [false] : [true, false]) {
      const start = !needsStart ? 0 : useStartCorner ? startCorner! : findRiser(false, startProtected,
        Math.min(total - endProtected, useEndCorner ? endCorner! - radius * 2 : total));
      if (start === null) continue;
      const end = !needsEnd ? total : useEndCorner ? endCorner! : findRiser(true,
        Math.max(startProtected, needsStart ? start + radius * 2 : 0), total - endProtected);
      if (end === null || (needsStart && needsEnd && end - start < radius * 2 - 1e-6)) continue;
      const candidate = { start, end, corners: Number(useStartCorner) + Number(useEndCorner),
        terminalTravel: (needsStart ? start : 0) + (needsEnd ? total - end : 0) };
      if (!bestStations || candidate.corners > bestStations.corners
        || (candidate.corners === bestStations.corners && candidate.terminalTravel < bestStations.terminalTravel - 1e-6)) {
        bestStations = candidate;
      }
    }
  }
  if (!bestStations) {
    return { nodes: [], issue: 'No straight approach can fit the socket clearances and vertical riser bends. Extend the approach.' };
  }
  const startStation = bestStations.start; const endStation = bestStations.end;
  const stationValues = new Set([...lengths, ...(needsStart ? [startStation] : []), ...(needsEnd ? [endStation] : [])]);
  const pointAt = (s: number) => {
    let i = 1; while (i < lengths.length - 1 && lengths[i]! < s) i += 1;
    const t = (s - lengths[i - 1]!) / Math.max(lengths[i]! - lengths[i - 1]!, 1e-9);
    return { x: route[i - 1]!.x + (route[i]!.x - route[i - 1]!.x) * t, y: route[i - 1]!.y + (route[i]!.y - route[i - 1]!.y) * t };
  };
  let nodes: PipeRouteNode3D[] = [];
  for (const s of [...stationValues].sort((a, b) => a - b)) {
    const point = pointAt(s);
    if (needsStart && s === startStation) nodes.push({ ...point, z: z0 }, { ...point, z: corridor });
    else if (needsEnd && s === endStation) nodes.push({ ...point, z: corridor }, { ...point, z: z1 });
    else nodes.push({ ...point, z: needsStart && s < startStation ? z0 : needsEnd && s > endStation ? z1 : corridor });
  }
  // Port-spacing gathers can hide the first field corner from terminal-only
  // station selection. Examine the completed rise/turn sequence in either
  // direction: move its plumb leg to the adjacent perpendicular intersection
  // and resize both horizontal legs together. This preserves endpoints, plan
  // footprint and vertical travel while removing one unnecessary elbow.
  // The enclosing proposal still screens the resulting physical service pair
  // against equipment and pipe clearances, and can retain the straight fallback.
  let riserAlternatives: PipeRouteNode3D[][] | undefined;
  if (options.preferCornerRisers !== false && !options.deferRiserTurnOptimization) {
    const alternatives = generateRiserTurnAlternatives(nodes, {
      bendTakeoffMm: radius,
      startStraightMm: Math.max(0, startProtected - radius),
      endStraightMm: Math.max(0, endProtected - radius),
      includeAllAlternatives: options.includeRiserAlternatives,
    });
    if (alternatives.length) {
      nodes = alternatives[0]!.nodes;
      if (options.includeRiserAlternatives) riserAlternatives = alternatives.map(alternative => alternative.nodes);
    }
  }
  // Tangent intersections are useful for station planning, but ordinary plan
  // elbows must retain their actual sampled radius in the saved 3D guide too.
  // The evaluator reads that guide directly; replacing an unrelated circular
  // elbow with a sharp node would erase its verified geometric radius.
  const retainedArcs = [...(sampledCorners?.values() ?? [])];
  const expand = (candidate: PipeRouteNode3D[]) => !retainedArcs.length ? candidate : candidate.flatMap((node, index) => {
    const before = candidate[index - 1]; const after = candidate[index + 1];
    if (!before || !after || Math.abs(before.z - node.z) > 1e-6 || Math.abs(after.z - node.z) > 1e-6) return [node];
    const arc = retainedArcs.find(candidate => Math.hypot(candidate.corner.x - node.x, candidate.corner.y - node.y) <= 1e-6);
    return arc ? inputRoute.slice(arc.startIndex, arc.endIndex + 1).map(point => ({ ...point, z: node.z })) : [node];
  });
  if (riserAlternatives) {
    const alternativeNodes = riserAlternatives.map(expand);
    return { nodes: alternativeNodes[0]!, alternativeNodes };
  }
  return { nodes: expand(nodes) };
}

/** Pure atomic-update builder, used by proposal preview and acceptance. */
export function networkFieldConnectionLevel(connection: RefrigerantPipeConnection, service: Service, plan: NetworkPipeLevelPlan): number {
  const corridor = service === 'gas' ? plan.gasElevationMm : plan.liquidElevationMm;
  let level = corridor;
  let bestDistance = Infinity;
  for (const locked of plan.lockedRoutes) {
    if (locked.service !== service || !connection.sourceElementId || !locked.sourceIds.includes(connection.sourceElementId)) continue;
    for (let i = 1; i < locked.nodes.length; i += 1) {
      const a = locked.nodes[i - 1]!; const b = locked.nodes[i]!;
      const dx = b.x - a.x; const dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((connection.portPoint.x - a.x) * dx + (connection.portPoint.y - a.y) * dy) / Math.max(dx * dx + dy * dy, 1e-9)));
      const distance = Math.hypot(connection.portPoint.x - a.x - t * dx, connection.portPoint.y - a.y - t * dy);
      const z = a.z + t * (b.z - a.z);
      if (distance <= EPS && (distance < bestDistance - 1e-6 || (Math.abs(distance - bestDistance) <= 1e-6 && Math.abs(z - connection.elevationMm) < Math.abs(level - connection.elevationMm)))) {
        level = z; bestDistance = distance;
      }
    }
  }
  return level;
}

export function applyNetworkPipeLevels(elements: HvacElement[], plan: NetworkPipeLevelPlan): { elements: HvacElement[]; issues: string[] } {
  return applyPreparedNetworkPipeLevels(elements, plan, new Map(pipeEntries(elements).map(entry => [entry.element.id, entry])));
}

/** Only reused inside one synchronous level search over an unchanged scope. */
function applyPreparedNetworkPipeLevels(elements: HvacElement[], plan: NetworkPipeLevelPlan, entries: Map<string, PipeEntry>): { elements: HvacElement[]; issues: string[] } {
  const result: HvacElement[] = [];
  const issues: string[] = [];
  for (const element of elements) {
    const entry = entries.get(element.id);
    if (entry?.locked) continue;
    if (entry) {
      const corridor = entry.service === 'gas' ? plan.gasElevationMm : plan.liquidElevationMm;
      const resolveConnection = (connection: RefrigerantPipeConnection | null) => connection?.connectionKind === 'field-pipe'
        ? { ...connection, elevationMm: networkFieldConnectionLevel(connection, entry.service, plan) } : connection;
      const start = resolveConnection(entry.start); const end = resolveConnection(entry.end);
      const preferCornerRisers = plan.cornerRisersByService?.[entry.service]
        ?? plan.preferCornerRisers ?? record(element.properties.networkLevelPlan).preferCornerRisers !== false;
      const built = buildNetworkLevelRoute(entry.routePoints, corridor, { start, end, radiusMm: entry.radius, settings: plan.settings,
        pipeDiameterMm: entry.socketPipeDiameterMm, minimumBendRadiusMm: entry.minimumBendRadiusMm, preferCornerRisers,
        deferRiserTurnOptimization: plan.deferRiserTurnOptimization });
      if (built.issue) { issues.push(`${element.label || entry.service}: ${built.issue}`); continue; }
      const min = Math.min(...built.nodes.map(node => node.z)); const max = Math.max(...built.nodes.map(node => node.z));
      result.push({ ...element, elevation: min - entry.radius, height: max - min + entry.radius * 2,
        properties: { ...element.properties, startConnection: start, endConnection: end, routeNodes3d: built.nodes,
          networkLevelPlan: { version: 2, generated: true, transitionStyle: 'vertical-riser', preferCornerRisers, id: plan.id, corridorElevationMm: corridor,
            ...(plan.deferRiserTurnOptimization ? { deferRiserTurnOptimization: true } : {}),
            gasElevationMm: plan.gasElevationMm, liquidElevationMm: plan.liquidElevationMm,
            clearGapMm: plan.clearGapMm, arrangement: plan.gasElevationMm >= plan.liquidElevationMm ? 'gas-above' : 'liquid-above' },
        } });
    } else if (element.type === 'refrigerant-branch-kit' && element.properties.networkLevelLocked !== true) {
      const kind = element.properties.branchKitLineKind;
      if (kind !== 'gas' && kind !== 'liquid') { issues.push('A combined or unclassified branch fitting needs separate service-level placement.'); continue; }
      const model = buildRefrigerantBranchKitViewModel(element);
      const corridor = kind === 'gas' ? plan.gasElevationMm : plan.liquidElevationMm;
      result.push({ ...element, elevation: corridor - model[kind].centerlineZMm });
    }
  }
  return { elements: result, issues };
}

export function isNetworkLevelPlanCurrent(plan: NetworkPipeLevelPlan, scene: HvacElement[]): boolean {
  const byId = new Map(scene.map(element => [element.id, element]));
  const scope = connectedScope(scene, plan.affectedIds);
  if (scope.length !== plan.affectedIds.length || scope.some(element => !plan.affectedIds.includes(element.id))) return false;
  return Object.entries(plan.sourceSignatures).every(([id, signature]) => {
    const element = byId.get(id); return !!element && networkLevelSourceSignature(element) === signature;
  });
}
