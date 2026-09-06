import type { HvacElement, Point2D, Wall } from '../../../types';
import { buildVrfDocumentFromHvacElements } from '../../../vrf/domain';
import { PROJECT_FALLBACK_RULE_PROFILE, type ManufacturerRuleProfile } from '../../../vrf/rules';

import { effectiveAutoRouteSettings, evaluateAutoRouteNetwork, type AutoRouteCostRates } from './autoRouteEvaluation';
import { directBranchApproachStations } from './branchApproachStations';
import { buildBranchKitInsertion, getBranchKitApproachRouteOptions, proposeBranchKit, type BranchKitProposal } from './branchKitProposal';
import { coordinatedBranchApproachStations } from './coordinatedBranchStations';
import { hasNewNetworkPipeClash } from './networkPipeClearance';
import { applyNetworkPipeLevels, hasNetworkCornerRiser, planNetworkPipeLevels } from './networkPipeLevels';
import { buildNetworkRiserRefinements } from './networkRiserRefinement';
import { findObstacleAwareOrthogonalRoute, type ObstacleAwareOrthogonalRoute,
  type ObstacleAwareOrthogonalRouteOptions, type OrthogonalRouteObstacle } from './obstacleAwareOrthogonalRoute';
import { normalizePipeRouteNodes3d } from './pipeRoute3d';
import { getActivePipeRoutingSettings, setActivePipeRoutingSettings, type PipeRoutingSettings } from './pipeRoutingSettings';
import { buildRefrigerantBranchKitViewModel } from './refrigerantBranchKitModel';
import {
  buildRefrigerantPipeElements, getBranchKitPortConnections, getRefrigerantPipeBundleSegmentTargets,
  getRefrigerantPipeBundleSnapTargets, getUnitPortApproachStraightMm, resolveRefrigerantPipeSpec,
  type RefrigerantPipeBundleConnection,
} from './refrigerantPipePairModel';
import { ALL_PIPE_PORT_TYPES } from './unitPipePortModel';

export interface AutoRouteNetworkProgress { completed: number; total: number; stage: string }
export interface AutoRouteNetworkOptions {
  settings: PipeRoutingSettings;
  profile?: ManufacturerRuleProfile;
  objective: 'balanced' | 'cost' | 'fewest-fittings';
  rates?: AutoRouteCostRates;
  selectedIds?: string[];
  walls?: Wall[];
  obstacles?: OrthogonalRouteObstacle[];
  /** Explicit scope: replace a complete, unlocked existing circuit in one undo step. */
  rebuildExisting?: boolean;
  onProgress?: (progress: AutoRouteNetworkProgress) => void;
}
type Evaluation = ReturnType<typeof evaluateAutoRouteNetwork>;
export interface AutoRouteNetworkResult {
  elementsToAdd: HvacElement[];
  removeElementIds: string[];
  updates: HvacElement[];
  complete: boolean;
  connectedIndoorIds: string[];
  unconnectedIndoorIds: string[];
  issues: string[];
  metrics: Evaluation['metrics'] | null;
  evaluations: Evaluation[];
  evaluatedCandidates: number;
}
interface Unit { element: HvacElement; port: RefrigerantPipeBundleConnection }
interface System { outdoor: Unit; indoors: Unit[] }
interface Candidate {
  scene: HvacElement[];
  connected: string[];
  evaluation: Evaluation;
  /** Search-only checkpoint. Rebuild neighboring fittings through the same
   * insertion transaction instead of translating already-connected sockets. */
  attachment?: { parent: Candidate; unit: Unit; proposal: BranchKitProposal; station: BranchStation; kitElementIds: string[] };
}
interface SearchStats { evaluatedCandidates: number; rejectedReasons: string[] }
interface Ownership { version: number; networkId: string; outdoorUnitId: string; indoorUnitIds: string[]; signature: string }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const distance = (a: Point2D, b: Point2D) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const isOutdoor = (element: HvacElement) => element.type === 'outdoor-unit' || element.category === 'outdoor-unit';
function recordRejections(stats: SearchStats, reasons: string[]): void {
  for (const reason of reasons) if (stats.rejectedReasons.length < 5 && !stats.rejectedReasons.includes(reason)) stats.rejectedReasons.push(reason);
}

export function isAutoRouteEquipment(element: HvacElement): boolean { return ALL_PIPE_PORT_TYPES.has(element.type); }

/** Fingerprint excludes ownership only; hand edits of any persisted geometry keep the entire tree. */
export function autoRouteElementSignature(element: HvacElement): string {
  const properties = { ...element.properties };
  delete properties.autoRouteNetwork;
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)])) : value;
  const serialized = JSON.stringify(canonical({ ...element, category: element.category ?? 'accessory',
    modelLabel: element.modelLabel ?? element.label, supplyZoneRatio: element.supplyZoneRatio ?? 0.5, properties }));
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) hash = Math.imul(hash ^ serialized.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}
function ownership(element: HvacElement): Ownership | null {
  const value = record(element.properties.autoRouteNetwork);
  return value.version === 1 && typeof value.networkId === 'string' && typeof value.outdoorUnitId === 'string'
    && Array.isArray(value.indoorUnitIds) && typeof value.signature === 'string' ? value as unknown as Ownership : null;
}
function protectedRoute(element: HvacElement): boolean {
  return ['networkLevelLocked', 'routeLocked', 'routingLocked', 'locked', 'isLocked', 'reviewed', 'installationReviewed']
    .some(key => element.properties[key] === true)
    || (Array.isArray(element.properties.bypasses) && element.properties.bypasses.length > 0);
}
function occupiedUnitIds(scene: HvacElement[]): Set<string> {
  const result = new Set<string>();
  for (const pipe of scene) for (const key of ['startConnection', 'endConnection', 'startBundleConnection', 'endBundleConnection']) {
    const connection = record(pipe.properties[key]);
    if (connection.connectionKind === 'unit-port' && typeof connection.sourceElementId === 'string') result.add(connection.sourceElementId);
  }
  return result;
}
function resolveSystems(scene: HvacElement[], selectedIds: string[] | undefined, issues: string[]): { systems: System[]; requested: string[] } {
  const recognized = scene.filter(isAutoRouteEquipment);
  const ports = new Map(getRefrigerantPipeBundleSnapTargets(scene.filter(isAutoRouteEquipment))
    .filter(port => port.sourceElementId && [port.point.x, port.point.y, port.gasPoint.x, port.gasPoint.y,
      port.liquidPoint.x, port.liquidPoint.y, port.gasElevationMm, port.liquidElevationMm].every(Number.isFinite))
    .map(port => [port.sourceElementId!, port]));
  const units = scene.filter(isAutoRouteEquipment).flatMap(element => ports.has(element.id) ? [{ element, port: ports.get(element.id)! }] : []);
  const selected = new Set(selectedIds);
  if (selected.size && !recognized.some(element => selected.has(element.id))) {
    issues.push('Select indoor and outdoor equipment to route a selected group.');
    return { systems: [], requested: [] };
  }
  const selectedOutdoors = units.filter(unit => isOutdoor(unit.element) && selected.has(unit.element.id));
  const rawSelectedOutdoors = recognized.filter(element => isOutdoor(element) && selected.has(element.id));
  const rawSelectedIndoors = recognized.filter(element => !isOutdoor(element) && selected.has(element.id));
  const allIndoors = recognized.filter(element => !isOutdoor(element));
  const inferredIndoors = rawSelectedOutdoors.length && !rawSelectedIndoors.length && recognized.filter(isOutdoor).length > 1
    ? allIndoors.filter(element => {
      const assignment = element.properties.outdoorUnitId; const systemId = element.properties.systemId;
      return typeof assignment === 'string' && assignment.length > 0 ? rawSelectedOutdoors.some(outdoor => outdoor.id === assignment)
        : typeof systemId === 'string' && systemId.length > 0 && rawSelectedOutdoors.some(outdoor => outdoor.properties.systemId === systemId);
    }) : allIndoors;
  const requested = (rawSelectedIndoors.length ? rawSelectedIndoors : inferredIndoors).map(element => element.id);
  if (rawSelectedOutdoors.length && !rawSelectedIndoors.length && inferredIndoors.length === 0 && allIndoors.length) {
    issues.push('Select the unassigned indoor units together with their outdoor unit, or assign them to that system.');
  }
  for (const element of recognized.filter(element => requested.includes(element.id) && !ports.has(element.id))) {
    issues.push(`${element.label || element.id}: gas and liquid connection coordinates are missing or invalid.`);
  }
  const outdoors = rawSelectedOutdoors.length ? selectedOutdoors : units.filter(unit => isOutdoor(unit.element));
  const indoors = units.filter(unit => requested.includes(unit.element.id));
  const systems = outdoors.map(outdoor => ({ outdoor, indoors: [] as Unit[] }));
  for (const indoor of indoors) {
    const assignedId = indoor.element.properties.outdoorUnitId;
    const systemId = indoor.element.properties.systemId;
    const choices = systems.filter(system =>
      typeof assignedId === 'string' && assignedId.length > 0 ? system.outdoor.element.id === assignedId
        : typeof systemId === 'string' && systemId.length > 0
          ? system.outdoor.element.properties.systemId === systemId : outdoors.length === 1);
    if (choices.length === 1) choices[0]!.indoors.push(indoor);
    else issues.push(selectedOutdoors.length === 1 && (typeof assignedId === 'string' && assignedId.length > 0 || typeof systemId === 'string' && systemId.length > 0)
      ? `${indoor.element.label || indoor.element.id}: its assigned outdoor unit or system differs from the selected outdoor unit; update the assignment before rerouting.`
      : `${indoor.element.label || indoor.element.id}: select its outdoor unit and indoor group, or assign an outdoor unit before routing.`);
  }
  if (!outdoors.length) issues.push('Place an outdoor unit with gas and liquid ports before using Auto route.');
  if (!indoors.length) issues.push('Place or select indoor units with refrigerant ports before using Auto route.');
  return { systems: systems.filter(system => system.indoors.length), requested };
}
function replaceableNetworkIds(scene: HvacElement[], system: System): string[] {
  const intended = new Set(system.indoors.map(unit => unit.element.id));
  const groups = new Map<string, HvacElement[]>();
  for (const element of scene) {
    const owner = ownership(element);
    if (owner?.outdoorUnitId !== system.outdoor.element.id || owner.indoorUnitIds.some(id => !intended.has(id))) continue;
    groups.set(owner.networkId, [...(groups.get(owner.networkId) ?? []), element]);
  }
  const removable: string[] = [];
  for (const group of groups.values()) {
    const ids = new Set(group.map(element => element.id));
    if (group.some(element => protectedRoute(element) || ownership(element)!.signature !== autoRouteElementSignature(element))) continue;
    const externallyReferenced = scene.filter(element => !ids.has(element.id)).some(element =>
      ['startConnection', 'endConnection', 'startBundleConnection', 'endBundleConnection'].some(key =>
        ids.has(String(record(element.properties[key]).sourceElementId ?? ''))));
    if (!externallyReferenced) removable.push(...ids);
  }
  return removable;
}
function replaceableExistingCircuit(scene: HvacElement[], system: System, options: AutoRouteNetworkOptions): { ids: string[]; indoorIds: string[] } {
  const none = { ids: [], indoorIds: [] };
  if (!options.rebuildExisting) return none;
  // Screening an existing circuit for replacement uses topology, not the old
  // circuit's compliance with the newly selected manufacturer's length limits.
  const requested = system.indoors.map(unit => unit.element.id);
  const topologyOptions = { ...options, profile: undefined };
  const probe = evaluation(scene, system, requested, topologyOptions, 'existing-layout');
  const indoorIds = [...new Set(probe.paths.map(path => path.indoorUnitId))];
  if (!indoorIds.length || indoorIds.some(id => !requested.includes(id)
    || !['gas', 'liquid'].every(service => probe.paths.some(path => path.indoorUnitId === id && path.lineKind === service)))) return none;
  const existing = evaluation(scene, system, indoorIds, topologyOptions, 'existing-layout');
  if (!existing.feasible) return none;
  const document = buildVrfDocumentFromHvacElements(scene);
  const ids = new Set(existing.paths.flatMap(path => [...path.runIds.map(id => document.pipeRuns[id]?.metadata?.sourceElementId),
    ...path.branchIds.map(id => document.branchKits[id]?.metadata?.sourceElementId)]).filter((id): id is string => typeof id === 'string'));
  const members = scene.filter(element => ids.has(element.id));
  if (!members.length || members.length !== ids.size || members.some(protectedRoute)) return none;
  const references = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(references);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, entry]) => /(?:sourceElementId|hostElementId|snapSourceElementId)$/i.test(key)
      && typeof entry === 'string' && ids.has(entry) || references(entry));
  };
  if (scene.some(element => !ids.has(element.id) && references(element.properties))) return none;
  return { ids: [...ids], indoorIds };
}
function equipmentObstacles(units: Unit[], excludedIds: string[]): OrthogonalRouteObstacle[] {
  return units.flatMap(unit => !excludedIds.includes(unit.element.id) && unit.port.sourceBoundsMm
    ? [{ id: unit.element.id, ...unit.port.sourceBoundsMm }] : []);
}
function expandObstacle(obstacle: OrthogonalRouteObstacle, paddingMm: number): OrthogonalRouteObstacle {
  return { id: obstacle.id, minX: obstacle.minX - paddingMm, minY: obstacle.minY - paddingMm,
    maxX: obstacle.maxX + paddingMm, maxY: obstacle.maxY + paddingMm };
}
function findAutoEquipmentRoute(
  routeOptions: ObstacleAwareOrthogonalRouteOptions,
  explicitObstacles: readonly OrthogonalRouteObstacle[],
  equipmentKeepouts: readonly OrthogonalRouteObstacle[],
): ObstacleAwareOrthogonalRoute | null {
  const strict = findObstacleAwareOrthogonalRoute({ ...routeOptions,
    obstacles: [...explicitObstacles, ...equipmentKeepouts] });
  if (strict || equipmentKeepouts.length === 0 || (routeOptions.clearanceMm ?? 0) <= 0) return strict;
  return findObstacleAwareOrthogonalRoute({ ...routeOptions, clearanceMm: 0,
    obstacles: [...explicitObstacles.map(obstacle => expandObstacle(obstacle, routeOptions.clearanceMm ?? 0)),
      ...equipmentKeepouts] });
}

/** Screen the built service lanes in 3D, including unit bodies that the plan search could route above. */
function crossesEquipment(pipes: HvacElement[], units: Unit[]): boolean {
  for (const kit of pipes.filter(element => element.type === 'refrigerant-branch-kit')) {
    const model = buildRefrigerantBranchKitViewModel(kit);
    const selected = kit.properties.branchKitLineKind;
    const lines = selected === 'gas' ? [model.gas] : selected === 'liquid' ? [model.liquid] : [model.gas, model.liquid];
    const angle = kit.rotation * Math.PI / 180; const cos = Math.cos(angle); const sin = Math.sin(angle);
    for (const line of lines) {
      const tubes = [line.inletTube, line.inletRunTube, line.mainTube, line.branchTube];
      const radius = Math.max(...tubes.map(tube => tube.outerDiameterMm / 2), line.splitNode.outerDiameterMm / 2,
        ...line.bands.map(band => band.outerDiameterMm / 2));
      const points = tubes.flatMap(tube => tube.points).map(point => ({
        x: kit.position.x + kit.width / 2 + point.x * cos - point.y * sin,
        y: kit.position.y + kit.depth / 2 + point.x * sin + point.y * cos,
      }));
      const bounds = { minX: Math.min(...points.map(point => point.x)) - radius, maxX: Math.max(...points.map(point => point.x)) + radius,
        minY: Math.min(...points.map(point => point.y)) - radius, maxY: Math.max(...points.map(point => point.y)) + radius,
        minZ: kit.elevation + line.centerlineZMm - radius, maxZ: kit.elevation + line.centerlineZMm + radius };
      if (units.some(unit => unit.port.sourceBoundsMm && bounds.minX < unit.port.sourceBoundsMm.maxX && bounds.maxX > unit.port.sourceBoundsMm.minX
        && bounds.minY < unit.port.sourceBoundsMm.maxY && bounds.maxY > unit.port.sourceBoundsMm.minY
        && bounds.minZ < unit.element.elevation + unit.element.height && bounds.maxZ > unit.element.elevation)) return true;
    }
  }
  for (const pipe of pipes.filter(element => element.type === 'refrigerant-pipe')) {
    const spec = resolveRefrigerantPipeSpec(pipe.properties);
    const radius = spec.outerDiameterMm / 2;
    const stored = normalizePipeRouteNodes3d(pipe.properties.routeNodes3d);
    const nodes = stored.length ? stored : spec.routePoints.map(point => ({ ...point, z: pipe.elevation + radius }));
    for (const unit of units) {
      const box = unit.port.sourceBoundsMm;
      if (!box) continue;
      const bounds = [
        [box.minX - radius, box.maxX + radius], [box.minY - radius, box.maxY + radius],
        [unit.element.elevation - radius, unit.element.elevation + unit.element.height + radius],
      ];
      for (let index = 1; index < nodes.length; index += 1) {
        const a = nodes[index - 1]!; const b = nodes[index]!;
        let lo = 0; let hi = 1;
        for (const [axisIndex, axis] of (['x', 'y', 'z'] as const).entries()) {
          const min = bounds[axisIndex]![0]!; const max = bounds[axisIndex]![1]!;
          const delta = b[axis] - a[axis];
          if (Math.abs(delta) < 1e-6) { if (a[axis] <= min || a[axis] >= max) { hi = -1; break; } }
          else { const t0 = (min - a[axis]) / delta; const t1 = (max - a[axis]) / delta;
            lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1)); }
        }
        if (hi > lo + 1e-6 && hi > 0 && lo < 1) {
          // Port necks occupy their manufacturer's reserved casing connection area.
          const ownStart = record(pipe.properties.startConnection).sourceElementId === unit.element.id;
          const ownEnd = record(pipe.properties.endConnection).sourceElementId === unit.element.id;
          if ((ownStart && index === 1 && lo <= 1e-6) || (ownEnd && index === nodes.length - 1 && hi >= 1 - 1e-6)) continue;
          return true;
        }
      }
    }
  }
  return false;
}
function applyInsertion(scene: HvacElement[], insertion: NonNullable<ReturnType<typeof buildBranchKitInsertion>>): HvacElement[] {
  const removed = new Set(insertion.removeElementIds);
  const updates = new Map(insertion.updates?.map(element => [element.id, element]));
  return [...scene.filter(element => !removed.has(element.id)).map(element => updates.get(element.id) ?? element), ...insertion.elementsToAdd];
}
function stampInsertionSettings(insertion: ReturnType<typeof buildBranchKitInsertion>, settings: PipeRoutingSettings): ReturnType<typeof buildBranchKitInsertion> {
  if (!insertion) return null;
  const stamp = (element: HvacElement) => element.type === 'refrigerant-pipe'
    ? { ...element, properties: { ...element.properties, bendRadiusFactor: settings.bendRadiusFactor } } : element;
  return { ...insertion, elementsToAdd: insertion.elementsToAdd.map(stamp), updates: insertion.updates?.map(stamp) };
}
function evaluation(scene: HvacElement[], system: System, connected: string[], options: AutoRouteNetworkOptions,
  elevationPolicy: 'new-layout' | 'existing-layout' = 'new-layout'): Evaluation {
  return evaluateAutoRouteNetwork({ elements: scene, outdoorUnitId: system.outdoor.element.id, indoorUnitIds: connected,
    profile: options.profile, objective: options.objective, rates: options.rates, walls: options.walls, elevationPolicy });
}
function reportPreservedNetwork(scene: HvacElement[], system: System, options: AutoRouteNetworkOptions, result: AutoRouteNetworkResult): number {
  const topologyOptions = { ...options, profile: undefined };
  const probe = evaluation(scene, system, system.indoors.map(unit => unit.element.id), topologyOptions, 'existing-layout');
  const connected = system.indoors.map(unit => unit.element.id).filter(id => ['gas', 'liquid'].every(service =>
    probe.paths.some(path => path.indoorUnitId === id && path.lineKind === service)));
  if (!connected.length || !evaluation(scene, system, connected, topologyOptions, 'existing-layout').feasible) return 0;
  const preserved = evaluation(scene, system, connected, options, 'existing-layout');
  result.connectedIndoorIds.push(...connected.filter(id => !result.connectedIndoorIds.includes(id)));
  result.evaluations.push(preserved);
  result.issues.push(...preserved.hardIssues, ...preserved.advisoryIssues);
  return connected.length;
}
function better(left: Candidate, right: Candidate | null): boolean {
  return !right || left.connected.length > right.connected.length
    || (left.connected.length === right.connected.length && left.evaluation.score < right.evaluation.score);
}
/** Once all branch sockets have fixed the topology, reconsider any risers
 * kept separate while reserving the main for subsequent takeoffs. A local
 * elbow saving must improve the complete network's chosen objective too. */
function refineCandidateRisers(candidate: Candidate, baselineIds: Set<string>, system: System,
  allUnits: Unit[], options: AutoRouteNetworkOptions, stats: SearchStats): Candidate {
  const baseline = candidate.scene.filter(element => baselineIds.has(element.id));
  let best = candidate;
  // A move can clear space for a previously rejected neighbouring riser.
  // Reconsider only after a strict bend-count reduction; this terminates at a
  // fixed point and never repeats a search over an unchanged network.
  for (;;) {
    const alternatives = buildNetworkRiserRefinements(best.scene.filter(element => !baselineIds.has(element.id)), options.settings);
    const initialBendCount = best.evaluation.metrics.bendCount;
    const currentById = new Map(best.scene.map(element => [element.id, element]));
    let improved = false;
    for (const updates of alternatives) {
      if (updates.every(element => JSON.stringify(element.properties.routeNodes3d)
        === JSON.stringify(currentById.get(element.id)?.properties.routeNodes3d)) || crossesEquipment(updates, allUnits)) continue;
      const byId = new Map(updates.map(element => [element.id, element]));
      const nextScene = best.scene.map(element => byId.get(element.id) ?? element);
      if (hasNewNetworkPipeClash(baseline, nextScene.filter(element => !baselineIds.has(element.id)))) continue;
      const rated = evaluation(nextScene, system, best.connected, options);
      stats.evaluatedCandidates += 1;
      if (!rated.feasible || rated.score >= best.evaluation.score - 1e-6
        || rated.metrics.bendCount > best.evaluation.metrics.bendCount
        || rated.metrics.bendCount >= initialBendCount
        || rated.metrics.verticalTravelMm > best.evaluation.metrics.verticalTravelMm + 1e-5
        || rated.metrics.elevationReversalCount > best.evaluation.metrics.elevationReversalCount) continue;
      best = { ...best, scene: nextScene, evaluation: rated };
      improved = true;
      for (const element of updates) currentById.set(element.id, element);
    }
    if (!improved) return best;
  }
}
/** Conservative incumbent screen: saved intent must be orthogonal and actual
 * terminals/plumb legs must still match the current equipment and fittings. */
function supportedIncumbentGeometry(members: HvacElement[], scene: HvacElement[], settings: PipeRoutingSettings): boolean {
  const byId = new Map(scene.map(element => [element.id, element]));
  for (const pipe of members.filter(element => element.type === 'refrigerant-pipe')) {
    const spec = resolveRefrigerantPipeSpec(pipe.properties);
    const guide = pipe.properties.authoredCenterlineRoute;
    if (!Array.isArray(guide) || guide.length < 2) return false;
    for (let index = 1; index < guide.length; index += 1) {
      const a = record(guide[index - 1]); const b = record(guide[index]);
      if (![a.x, a.y, b.x, b.y].every(value => typeof value === 'number' && Number.isFinite(value))
        || Math.abs(Number(a.x) - Number(b.x)) > 0.5 && Math.abs(Number(a.y) - Number(b.y)) > 0.5) return false;
    }
    const nodes = normalizePipeRouteNodes3d(pipe.properties.routeNodes3d);
    if (nodes.length < 2) return false;
    for (let index = 1; index < nodes.length; index += 1) {
      const a = nodes[index - 1]!; const b = nodes[index]!;
      if (Math.hypot(a.x - b.x, a.y - b.y) > 0.5 && Math.abs(a.z - b.z) > 0.5) return false;
    }
    for (const [connection, node] of [[spec.startConnection, nodes[0]!], [spec.endConnection, nodes.at(-1)!]] as const) {
      const source = connection?.sourceElementId ? byId.get(connection.sourceElementId) : undefined;
      if (!source || !connection) return false;
      const target = source.type === 'refrigerant-branch-kit'
        ? getBranchKitPortConnections(source).find(port => port.terminalRole === connection.terminalRole)
        : getRefrigerantPipeBundleSnapTargets([source])[0];
      if (!target) return false;
      const point = spec.lineKind === 'gas' ? target.gasPoint : target.liquidPoint;
      const z = spec.lineKind === 'gas' ? target.gasElevationMm : target.liquidElevationMm;
      if (Math.hypot(node.x - point.x, node.y - point.y, node.z - z) > 0.5) return false;
    }
    const points = spec.routePoints;
    const segments = points.slice(1).map((point, index) => {
      const a = points[index]!; const length = Math.hypot(point.x - a.x, point.y - a.y);
      return { x: (point.x - a.x) / Math.max(length, 1e-9), y: (point.y - a.y) / Math.max(length, 1e-9), length };
    });
    const total = segments.reduce((sum, segment) => sum + segment.length, 0);
    const adapterLength = settings.minimumPortStubMm + spec.outerDiameterMm * 4;
    let station = 0;
    for (const [index, segment] of segments.entries()) {
      const before = station; station += segment.length;
      if (Math.abs(segment.x) < 1e-6 || Math.abs(segment.y) < 1e-6 || segment.length < 0.5) continue;
      if (spec.startConnection?.connectionKind === 'unit-port' && station <= adapterLength
        || spec.endConnection?.connectionKind === 'unit-port' && total - before <= adapterLength) continue;
      const circular = [index - 2, index - 1, index].some(start => {
        const triple = segments.slice(Math.max(0, start), start + 3);
        if (start < 0 || triple.length !== 3 || Math.max(...triple.map(item => item.length)) > 1.1 * Math.min(...triple.map(item => item.length))) return false;
        const turns = [0, 1].map(i => Math.atan2(triple[i]!.x * triple[i + 1]!.y - triple[i]!.y * triple[i + 1]!.x,
          triple[i]!.x * triple[i + 1]!.x + triple[i]!.y * triple[i + 1]!.y));
        return turns.every(turn => Math.abs(turn) > 1e-5 && Math.abs(turn) <= Math.PI / 6)
          && turns[0]! * turns[1]! > 0 && Math.abs(turns[0]! - turns[1]!) < 0.01;
      });
      if (!circular) return false;
    }
  }
  return members.every(element => element.type === 'refrigerant-pipe' || element.type === 'refrigerant-branch-kit');
}
function aggregateMetrics(evaluations: Evaluation[]): Evaluation['metrics'] | null {
  if (!evaluations.length) return null;
  const values = evaluations.map(item => item.metrics);
  const sum = (key: keyof Evaluation['metrics']) => values.reduce((total, value) => total + Number(value[key] ?? 0), 0);
  return { ...values[0]!, pipeLengthMm: sum('pipeLengthMm'), gasLengthMm: sum('gasLengthMm'), liquidLengthMm: sum('liquidLengthMm'),
    networkLengthMm: sum('networkLengthMm'), maxPathLengthMm: Math.max(...values.map(value => value.maxPathLengthMm)),
    maxEquivalentPathLengthMm: values.some(value => value.maxEquivalentPathLengthMm === null) ? null
      : Math.max(...values.map(value => value.maxEquivalentPathLengthMm!)),
    bendCount: sum('bendCount'), branchPairCount: sum('branchPairCount'), riserCount: sum('riserCount'),
    verticalTravelMm: sum('verticalTravelMm'), elevationReversalCount: sum('elevationReversalCount'),
    connectedIndoorCount: sum('connectedIndoorCount'), relativeCostIndex: sum('relativeCostIndex'), wallCrossingCount: sum('wallCrossingCount'),
    estimatedCost: values.some(value => value.estimatedCost === null) ? null : sum('estimatedCost'),
    totalCapacityIndex: values.some(value => value.totalCapacityIndex === null) ? null : sum('totalCapacityIndex') };
}
function seedNetwork(scene: HvacElement[], system: System, indoor: Unit, allUnits: Unit[], options: AutoRouteNetworkOptions, seedIndex: number,
  stats: SearchStats): HvacElement[] | null {
  const gasDiameter = Math.max(system.outdoor.port.gasOuterDiameterMm ?? 15.875, indoor.port.gasOuterDiameterMm ?? 15.875);
  const liquidDiameter = Math.max(system.outdoor.port.liquidOuterDiameterMm ?? 9.525, indoor.port.liquidOuterDiameterMm ?? 9.525);
  const physicalRadius = (Math.max(gasDiameter, liquidDiameter) + 50.8) * options.settings.bendRadiusFactor;
  const pairSpacing = (gasDiameter + liquidDiameter + 101.6) / 2 + options.settings.defaultPipeGapMm;
  const radius = physicalRadius + pairSpacing / 2;
  const acceptedSeeds = new Map<string, HvacElement[]>();
  const buildSeed = (points: readonly Point2D[]): HvacElement[] | null => {
    const pipes = buildRefrigerantPipeElements(points.map(point => ({ ...point })), {
      startBundleConnection: system.outdoor.port, endBundleConnection: indoor.port,
      gasPipeDiameterMm: gasDiameter, liquidPipeDiameterMm: liquidDiameter,
      bendRadiusFactor: options.settings.bendRadiusFactor,
      segmentMaterialMode: 'hard', bundleId: `auto-seed-${system.outdoor.element.id}-${seedIndex}`,
    }).map((element, index) => ({ ...element, rotation: 0, id: `auto-seed-${system.outdoor.element.id}-${seedIndex}-${index}`,
      properties: { ...element.properties, bendRadiusFactor: options.settings.bendRadiusFactor } } as HvacElement));
    if (pipes.length !== 2) return null;
    const plan = planNetworkPipeLevels([...scene, ...pipes], { gasHostId: pipes[0]!.id, liquidHostId: pipes[1]!.id,
      gasHostElevationMm: indoor.port.gasElevationMm, liquidHostElevationMm: indoor.port.liquidElevationMm,
      startBundle: indoor.port, settings: options.settings, deferRiserTurnOptimization: true });
    if (!plan.feasible) { recordRejections(stats, plan.issues); return null; }
    let leveled = applyNetworkPipeLevels(pipes, plan);
    recordRejections(stats, leveled.issues);
    if (leveled.issues.length || leveled.elements.length !== 2) return null;
    if (crossesEquipment(leveled.elements, allUnits) || hasNewNetworkPipeClash(scene, leveled.elements)) {
      if (!hasNetworkCornerRiser(leveled.elements)) return null;
      // A clearance problem on one service must not add an elbow to its clear
      // partner. Compare service-specific and paired fallbacks at the same
      // levels using the selected technical/economic objective.
      let fallback: typeof leveled | null = null;
      let fallbackScore = Infinity;
      for (const cornerRisersByService of [{ gas: false, liquid: true }, { gas: true, liquid: false }, { gas: false, liquid: false }]) {
        const trial = applyNetworkPipeLevels(pipes, { ...plan, cornerRisersByService });
        if (trial.issues.length || trial.elements.length !== 2 || crossesEquipment(trial.elements, allUnits)
          || hasNewNetworkPipeClash(scene, trial.elements)) continue;
        const rated = evaluation([...scene, ...trial.elements], system, [indoor.element.id], options);
        if (!rated.feasible) continue;
        if (!fallback || rated.score < fallbackScore) { fallback = trial; fallbackScore = rated.score; }
      }
      if (!fallback) return null;
      leveled = fallback;
    }
    return leveled.elements;
  };
  const route = findAutoEquipmentRoute({ start: system.outdoor.port.point, end: indoor.port.point,
    startDirection: system.outdoor.port.direction, endDirection: indoor.port.direction,
    startStraightMm: Math.max(options.settings.minimumPortStubMm + radius * 2,
      getUnitPortApproachStraightMm(system.outdoor.port, pairSpacing, physicalRadius, options.settings.minimumPortStubMm)),
    endStraightMm: Math.max(options.settings.minimumPortStubMm + radius * 2,
      getUnitPortApproachStraightMm(indoor.port, pairSpacing, physicalRadius, options.settings.minimumPortStubMm)), bendRadiusMm: radius,
    clearanceMm: Math.max(options.settings.defaultUnitClearanceMm, options.settings.defaultPipeGapMm + radius),
    bendPenaltyMm: options.objective === 'fewest-fittings' ? 5000 : 1000,
    maxCandidateChecks: 32,
    acceptRoute: points => {
      const seed = buildSeed(points);
      if (!seed) return false;
      acceptedSeeds.set(JSON.stringify(points), seed);
      return true;
    } }, options.obstacles ?? [], equipmentObstacles(allUnits, [system.outdoor.element.id, indoor.element.id]));
  if (!route) return null;
  const seed = acceptedSeeds.get(JSON.stringify(route.points)) ?? buildSeed(route.points);
  return seed ? [...scene, ...seed] : null;
}
interface BranchStation {
  point: Point2D;
  target: ReturnType<typeof getRefrigerantPipeBundleSegmentTargets>[number];
  primary?: boolean;
}
function branchStations(scene: HvacElement[], generatedIds: Set<string>, port: RefrigerantPipeBundleConnection, settings: PipeRoutingSettings): BranchStation[] {
  const spans = getRefrigerantPipeBundleSegmentTargets(scene, { minSegmentLengthMm: 2 * settings.defaultBranchKitClearanceMm + 500 }).filter(span =>
    generatedIds.has(span.gasSourceElementId ?? '') && generatedIds.has(span.liquidSourceElementId ?? ''));
  const localAlong = (point: Point2D) => (point.x - port.point.x) * port.direction.x + (point.y - port.point.y) * port.direction.y;
  const localAcross = (point: Point2D) => -(point.x - port.point.x) * port.direction.y + (point.y - port.point.y) * port.direction.x;
  const groups = spans.map(span => {
    const a = span.segmentStart; const b = span.segmentEnd; const dx = b.x - a.x; const dy = b.y - a.y;
    const t = Math.max(0.15, Math.min(0.85, ((port.point.x - a.x) * dx + (port.point.y - a.y) * dy) / Math.max(1, dx * dx + dy * dy)));
    return [t, 0.5, 0.25, 0.75].map((fraction, index) => ({ target: span, primary: index === 0,
      point: { x: a.x + dx * fraction, y: a.y + dy * fraction } }));
  }).sort((a, b) => distance(a[0]!.point, port.point) - distance(b[0]!.point, port.point)
    || localAlong(a[0]!.point) - localAlong(b[0]!.point) || localAcross(a[0]!.point) - localAcross(b[0]!.point)).slice(0, 6);
  // Give each nearby straight a first chance before spending the budget on
  // several percentages of one host. Socket-derived stations are added below.
  return [0, 1, 2, 3].flatMap(index => groups.map(group => group[index]!)).slice(0, 16);
}
function attachUnit(candidate: Candidate, baselineIds: Set<string>, system: System, unit: Unit, allUnits: Unit[], options: AutoRouteNetworkOptions,
  stats: SearchStats, exactStations?: BranchStation[]): Candidate | null {
  const generatedIds = new Set(candidate.scene.filter(element => !baselineIds.has(element.id)).map(element => element.id));
  const originalScene = candidate.scene.filter(element => baselineIds.has(element.id));
  const insertionFits = (insertion: ReturnType<typeof buildBranchKitInsertion>): insertion is NonNullable<typeof insertion> => {
    if (!insertion || insertion.updates?.some(element => baselineIds.has(element.id))
      || insertion.removeElementIds.some(id => baselineIds.has(id))) return false;
    if (crossesEquipment([...(insertion.updates ?? []), ...insertion.elementsToAdd], allUnits)) return false;
    // A delta check can retain pre-existing contact on a split host. Every new
    // automatic tree must also pass against the original, untouched scene.
    const next = applyInsertion(candidate.scene, insertion);
    return !hasNewNetworkPipeClash(originalScene, next.filter(element => !baselineIds.has(element.id)));
  };
  let best: Candidate | null = null;
  const stations = exactStations ?? branchStations(candidate.scene, generatedIds, unit.port, options.settings);
  const primary = stations.filter(station => station.primary);
  const fallback = stations.filter(station => !station.primary);
  const directGroups: BranchStation[][] = [];
  const visited = new Set<string>();
  const expanded = new Set<string>();
  // Reserve a first probe per straight, then interleave the socket-derived
  // positions so one host cannot consume the budget before another is tried.
  // Two buildable but folded approaches are not a stopping rule.
  const nextStation = (): BranchStation | undefined => {
    if (primary.length) return primary.shift();
    while (directGroups.length) {
      const group = directGroups.shift()!;
      const next = group.shift();
      if (group.length) directGroups.push(group);
      if (next) return next;
    }
    return fallback.shift();
  };
  for (let attempt = 0; attempt < (exactStations ? exactStations.length : 24);) {
    const station = nextStation();
    if (!station) break;
    const hostKey = `${station.target.gasSourceElementId}:${station.target.liquidSourceElementId}`;
    const pointKey = `${hostKey}:${station.point.x.toFixed(2)}:${station.point.y.toFixed(2)}`;
    if (visited.has(pointKey)) continue;
    visited.add(pointKey);
    attempt += 1;
    const proposal = proposeBranchKit(candidate.scene, unit.port, station.point, { settings: options.settings,
      bendRadiusFactor: options.settings.bendRadiusFactor,
      proposalRadiusMm: 100, maxRecoveryStations: exactStations ? 0 : 1,
      excludeSourceIds: candidate.scene.filter(element => baselineIds.has(element.id)
        || element.id !== station.target.gasSourceElementId && element.id !== station.target.liquidSourceElementId).map(element => element.id) });
    if (!proposal) continue;
    if (exactStations && distance(proposal.teePoint, station.point) > 1) continue;
    // Invalid previews may use a display-only footprint without the requested
    // radius policy. Derive candidates using the same policy as reconstruction,
    // and reconsider the span if its actual outlet orientation changes.
    const approach = getBranchKitApproachRouteOptions({ ...proposal, bendRadiusFactor: options.settings.bendRadiusFactor }, unit.port);
    const spanKey = `${hostKey}:${JSON.stringify([proposal.target.segmentStart, proposal.target.segmentEnd,
      approach.endDirection, approach.bendRadiusMm,
      (approach.end.x - proposal.teePoint.x).toFixed(3), (approach.end.y - proposal.teePoint.y).toFixed(3)])}`;
    if (!exactStations && !expanded.has(spanKey)) {
      expanded.add(spanKey);
      const directStations = directBranchApproachStations({ route: approach,
        station: proposal.teePoint, segmentStart: proposal.target.segmentStart, segmentEnd: proposal.target.segmentEnd });
      if (directStations.length) directGroups.push(directStations.map(point => ({ point, target: station.target })));
    }
    if (proposal.validity === 'invalid') continue;
    const radius = Math.max(proposal.target.gasOuterDiameterMm, proposal.target.liquidOuterDiameterMm) * options.settings.bendRadiusFactor
      + Math.hypot(proposal.gasGhost.branchOutletPoint.x - proposal.liquidGhost.branchOutletPoint.x,
        proposal.gasGhost.branchOutletPoint.y - proposal.liquidGhost.branchOutletPoint.y) / 2;
    const end = { x: (proposal.gasGhost.branchOutletPoint.x + proposal.liquidGhost.branchOutletPoint.x) / 2,
      y: (proposal.gasGhost.branchOutletPoint.y + proposal.liquidGhost.branchOutletPoint.y) / 2 };
    let insertion = stampInsertionSettings(buildBranchKitInsertion(proposal, unit.port, candidate.scene), options.settings);
    if (!insertionFits(insertion) || options.obstacles?.length) {
      insertion = null;
      const acceptedInsertions = new Map<string, NonNullable<ReturnType<typeof buildBranchKitInsertion>>>();
      const routed = findAutoEquipmentRoute({ start: unit.port.point, end, startDirection: unit.port.direction,
        endDirection: proposal.gasGhost.branchOutletDirection,
        startStraightMm: Math.max(options.settings.minimumPortStubMm + radius * 2, approach.startStraightMm),
        endStraightMm: options.settings.defaultBranchKitClearanceMm, bendRadiusMm: radius,
        clearanceMm: options.settings.defaultUnitClearanceMm, bendPenaltyMm: options.objective === 'fewest-fittings' ? 5000 : 1000,
        maxCandidateChecks: 16,
        acceptRoute: points => {
          const trial = stampInsertionSettings(buildBranchKitInsertion({ ...proposal, connectionRoute: points.map(point => ({ ...point })) }, unit.port, candidate.scene), options.settings);
          if (!insertionFits(trial)) return false;
          acceptedInsertions.set(JSON.stringify(points), trial);
          return true;
        } }, options.obstacles ?? [], equipmentObstacles(allUnits, [unit.element.id]));
      if (!routed) continue;
      insertion = acceptedInsertions.get(JSON.stringify(routed.points)) ?? null;
    }
    if (!insertion) continue;
    const nextScene = applyInsertion(candidate.scene, insertion);
    const connected = [...candidate.connected, unit.element.id];
    const rated = evaluation(nextScene, system, connected, options);
    stats.evaluatedCandidates += 1;
    if (!rated.feasible) { recordRejections(stats, rated.hardIssues); continue; }
    const next: Candidate = { scene: nextScene, connected, evaluation: rated,
      attachment: { parent: candidate, unit, proposal, station, kitElementIds: insertion.kitElementIds } };
    if (better(next, best)) best = next;
  }
  return best;
}

function hasFoldedUnitApproach(scene: HvacElement[], unitId: string): boolean {
  return scene.some(element => {
    if (element.type !== 'refrigerant-pipe'
      || !['startConnection', 'endConnection'].some(key => record(element.properties[key]).sourceElementId === unitId)) return false;
    const guide = element.properties.authoredCenterlineRoute as Point2D[] | undefined;
    if (!Array.isArray(guide)) return false;
    let previous: Point2D | undefined;
    let bends = 0;
    for (let index = 1; index < guide.length; index += 1) {
      const a = guide[index - 1]!; const b = guide[index]!;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length < 0.5) continue;
      const direction = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
      if (previous && previous.x * direction.x + previous.y * direction.y < 1 - 1e-6) bends += 1;
      previous = direction;
    }
    return bends > 2;
  });
}

/** Find the rebuilt half of the SAME straight at a reserved station. A crossing
 * or a nearby parallel network is never used as a substitute host. */
function rebuiltBranchStations(scene: HvacElement[], baselineIds: Set<string>, point: Point2D,
  original: BranchStation['target'], kitElementIds?: string[]): BranchStation[] {
  const dx = original.segmentEnd.x - original.segmentStart.x;
  const dy = original.segmentEnd.y - original.segmentStart.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return [];
  const axis = { x: dx / length, y: dy / length };
  const across = (p: Point2D) => Math.abs((p.x - original.segmentStart.x) * axis.y - (p.y - original.segmentStart.y) * axis.x);
  const throughHostIds = kitElementIds && new Set(scene.filter(element => ['startConnection', 'endConnection'].some(key => {
    const connection = record(element.properties[key]);
    return kitElementIds.includes(String(connection.sourceElementId))
      && (connection.terminalRole === 'inlet' || connection.terminalRole === 'run-outlet');
  })).map(element => element.id));
  return getRefrigerantPipeBundleSegmentTargets(scene, { minSegmentLengthMm: 1 }).filter(span => {
    if (baselineIds.has(span.gasSourceElementId ?? '') || baselineIds.has(span.liquidSourceElementId ?? '')
      || throughHostIds && (!throughHostIds.has(span.gasSourceElementId ?? '') || !throughHostIds.has(span.liquidSourceElementId ?? ''))
      || across(span.segmentStart) > 0.5 || across(span.segmentEnd) > 0.5) return false;
    const a = (span.segmentStart.x - point.x) * axis.x + (span.segmentStart.y - point.y) * axis.y;
    const b = (span.segmentEnd.x - point.x) * axis.x + (span.segmentEnd.y - point.y) * axis.y;
    return Math.min(a, b) <= 0.5 && Math.max(a, b) >= -0.5;
  }).sort((a, b) => Number(b.gasSourceElementId === original.gasSourceElementId)
    - Number(a.gasSourceElementId === original.gasSourceElementId)).map(target => ({ point, target }));
}

/** A locally cheapest fitting must not permanently consume the next fitting's
 * direct approach. Reopen at most two adjacent insertions only when the greedy
 * result folds or fails; every trial still passes full geometry/tree/cost checks. */
function attachUnitWithCoordination(candidate: Candidate, baselineIds: Set<string>, system: System, unit: Unit,
  allUnits: Unit[], options: AutoRouteNetworkOptions, stats: SearchStats): Candidate | null {
  let best = attachUnit(candidate, baselineIds, system, unit, allUnits, options, stats);
  if (best && !hasFoldedUnitApproach(best.scene, unit.element.id)) return best;
  const generatedIds = new Set(candidate.scene.filter(element => !baselineIds.has(element.id)).map(element => element.id));
  // A failed insertion may have NO eligible host: include short spans here,
  // because moving their upstream fitting is precisely what can make room.
  const crowdedHosts = best?.attachment ? [best.attachment.station]
    : getRefrigerantPipeBundleSegmentTargets(candidate.scene, { minSegmentLengthMm: 1 })
      .filter(span => generatedIds.has(span.gasSourceElementId ?? '') && generatedIds.has(span.liquidSourceElementId ?? ''))
      .map(target => {
        const a = target.segmentStart; const b = target.segmentEnd;
        const dx = b.x - a.x; const dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((unit.port.point.x - a.x) * dx + (unit.port.point.y - a.y) * dy) / Math.max(1, dx * dx + dy * dy)));
        return { target, point: { x: a.x + dx * t, y: a.y + dy * t } };
      }).sort((a, b) => distance(a.point, unit.port.point) - distance(b.point, unit.port.point)).slice(0, 6);
  const hostIds = new Set(crowdedHosts.flatMap(({ target }) => [target.gasSourceElementId, target.liquidSourceElementId]));
  const neighborIds = new Set(candidate.scene.filter(element => hostIds.has(element.id)).flatMap(element =>
    ['startConnection', 'endConnection'].map(key => String(record(element.properties[key]).sourceElementId ?? ''))));
  let checkpoint = candidate;
  const later: NonNullable<Candidate['attachment']>[] = [];
  const groups: { attachment: NonNullable<Candidate['attachment']>; later: NonNullable<Candidate['attachment']>[];
    positions: ReturnType<typeof coordinatedBranchApproachStations> }[] = [];
  // Find physical neighbors through socket identities, irrespective of the
  // order in which units elsewhere in the building happened to be connected.
  while (checkpoint.attachment && groups.length < 2) {
    const attachment = checkpoint.attachment;
    const { parent, unit: previousUnit, proposal: previous, station } = attachment;
    if (!attachment.kitElementIds.some(id => neighborIds.has(id))) {
      later.unshift(attachment); checkpoint = parent; continue;
    }
    const next = proposeBranchKit(parent.scene, unit.port, previous.teePoint, { settings: options.settings,
      bendRadiusFactor: options.settings.bendRadiusFactor, proposalRadiusMm: 100, maxRecoveryStations: 0,
      excludeSourceIds: parent.scene.filter(element => baselineIds.has(element.id)
        || element.id !== station.target.gasSourceElementId && element.id !== station.target.liquidSourceElementId).map(element => element.id) });
    const positions = next ? coordinatedBranchApproachStations({ previous, previousPort: previousUnit.port,
      next, nextPort: unit.port, settings: options.settings }) : [];
    if (positions.length) groups.push({ attachment, later: [...later], positions });
    later.unshift(attachment);
    checkpoint = parent;
  }
  // Interleave the neighbors' analytical positions so one cannot spend the
  // entire replay budget before the other gets its first trial.
  for (let attempt = 0; attempt < 4 && groups.length; attempt += 1) {
    const group = groups.shift()!;
    const position = group.positions.shift()!;
    if (group.positions.length) groups.push(group);
    const { parent, unit: previousUnit, station } = group.attachment;
    const moved = attachUnit(parent, baselineIds, system, previousUnit, allUnits, options, stats,
      [{ ...station, point: position.previousStation }]);
    if (!moved) continue;
    const hosts = rebuiltBranchStations(moved.scene, baselineIds, position.nextStation, station.target, moved.attachment!.kitElementIds);
    if (!hosts.length) continue;
    let trial = attachUnit(moved, baselineIds, system, unit, allUnits, options, stats, hosts);
    for (const saved of group.later) {
      if (!trial) break;
      const savedHosts = rebuiltBranchStations(trial.scene, baselineIds, saved.proposal.teePoint, saved.station.target);
      const replayed = savedHosts.length ? attachUnit(trial, baselineIds, system, saved.unit, allUnits, options, stats, savedHosts) : null;
      trial = replayed ?? attachUnit(trial, baselineIds, system, saved.unit, allUnits, options, stats);
    }
    if (trial && candidate.connected.every(id => trial!.connected.includes(id)) && better(trial, best)) best = trial;
  }
  return best;
}
function finalizeGenerated(scene: HvacElement[], baselineIds: Set<string>, system: System, connected: string[],
  options: AutoRouteNetworkOptions, score: number): HvacElement[] {
  const generated = scene.filter(element => !baselineIds.has(element.id));
  const networkId = `auto-network-${system.outdoor.element.id}`;
  const replacements = new Map(generated.map((element, index) => [element.id, `${networkId}-${index + 1}`]));
  // Terminal/node/bundle strings contain component IDs. Replace their exact substrings, longest first.
  const entries = [...replacements].sort(([left], [right]) => right.length - left.length);
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') { let result = value; for (const [from, to] of entries) result = result.split(from).join(to); return result; }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry)]));
    return value;
  };
  // Non-element grouping IDs are randomized by the insertion builder too.
  const groupIds = new Map<string, string>();
  for (const element of generated) for (const key of ['bundleId', 'teeId', 'branchKitPairId']) {
    const id = element.properties[key];
    if (typeof id === 'string' && !groupIds.has(id)) groupIds.set(id, `${networkId}-group-${groupIds.size + 1}`);
  }
  entries.push(...[...groupIds].sort(([a], [b]) => b.length - a.length));
  return generated.map(element => {
    const next = rewrite(element) as HvacElement;
    delete next.properties.autoRouteNetwork;
    // Transient planner signatures are replaced by persisted geometry and need not retain random UUIDs.
    const level = record(next.properties.networkLevelPlan);
    delete level.deferRiserTurnOptimization;
    if (Object.keys(level).length) next.properties.networkLevelPlan = { ...level, id: networkId };
    next.properties.autoRouteNetwork = { version: 1, networkId, outdoorUnitId: system.outdoor.element.id,
      indoorUnitIds: [...connected].sort(), signature: autoRouteElementSignature(next), objective: options.objective,
      profileId: options.profile?.id ?? PROJECT_FALLBACK_RULE_PROFILE.id, rates: options.rates ? { ...options.rates } : undefined,
      rebuildExisting: options.rebuildExisting === true, score };
    return next;
  });
}

/** Bounded multi-start insertion search. Every accepted state is a complete rooted service tree. */
export async function planAutoRouteNetwork(inputScene: HvacElement[], inputOptions: AutoRouteNetworkOptions): Promise<AutoRouteNetworkResult> {
  const options = { ...inputOptions, settings: effectiveAutoRouteSettings(inputOptions.profile, inputOptions.settings, inputScene) };
  const previousSettings = getActivePipeRoutingSettings();
  setActivePipeRoutingSettings(options.settings);
  try {
  const issues: string[] = [];
  const { systems, requested } = resolveSystems(inputScene, options.selectedIds, issues);
  const result: AutoRouteNetworkResult = { elementsToAdd: [], removeElementIds: [], updates: [], complete: false,
    connectedIndoorIds: [], unconnectedIndoorIds: requested, issues, metrics: null, evaluations: [], evaluatedCandidates: 0 };
  const searchStats: SearchStats = { evaluatedCandidates: 0, rejectedReasons: [] };
  let workingScene = inputScene;
    const allUnits = inputScene.filter(isAutoRouteEquipment).flatMap(element => {
      const port = getRefrigerantPipeBundleSnapTargets([element])[0];
      return port && [port.point.x, port.point.y, port.gasElevationMm, port.liquidElevationMm].every(Number.isFinite) ? [{ element, port }] : [];
    });
    for (const system of systems) {
      const properties = system.outdoor.element.properties;
      const arrangement = ['arrangement', 'refrigerantArrangement', 'systemArrangement', 'systemType', 'refrigerantSystemType', 'pipingArrangement']
        .map(key => String(properties[key] ?? '').toLowerCase().replace(/[ _]/g, '-'));
      if (properties.refrigerantPipeCount === 3 || arrangement.some(value => ['heat-recovery', 'three-pipe', '3-pipe'].includes(value))) {
        issues.push(`${system.outdoor.element.label || system.outdoor.element.id}: this heat-recovery or three-pipe system needs its manufacturer branch-selector arrangement; the two-pipe planner did not modify it.`);
        continue;
      }
      const existingCircuit = replaceableExistingCircuit(workingScene, system, options);
      const removable = [...new Set([...replaceableNetworkIds(workingScene, system), ...existingCircuit.ids])];
      const removableSet = new Set(removable);
      const baseline = workingScene.filter(element => !removableSet.has(element.id));
      const occupied = occupiedUnitIds(baseline);
      if (occupied.has(system.outdoor.element.id)) {
        const preservedIndoorCount = reportPreservedNetwork(baseline, system, options, result);
        issues.push(preservedIndoorCount === system.indoors.length
          ? `${system.outdoor.element.label || system.outdoor.element.id}: its existing connected network was preserved.`
          : `${system.outdoor.element.label || system.outdoor.element.id}: its existing or edited network was preserved. New connections need an extension of that network or a free outdoor connection.`);
        continue;
      }
      const available = system.indoors.filter(unit => !occupied.has(unit.element.id));
      for (const unit of system.indoors.filter(unit => occupied.has(unit.element.id))) issues.push(`${unit.element.label || unit.element.id}: existing pipe connections were preserved.`);
      if (!available.length) continue;
      const ordered = [...available].sort((a, b) => distance(b.port.point, system.outdoor.port.point) - distance(a.port.point, system.outdoor.port.point) || a.element.id.localeCompare(b.element.id));
      const seeds = [...new Map([ordered[0]!, ordered[1] ?? ordered[0]!, ordered.at(-1)!].map(unit => [unit.element.id, unit])).values()];
      const baselineIds = new Set(baseline.map(element => element.id));
      let best: Candidate | null = null;
      for (const [seedIndex, seed] of seeds.entries()) {
        options.onProgress?.({ completed: result.connectedIndoorIds.length, total: requested.length,
          stage: `Comparing network ${seedIndex + 1}/${seeds.length} for ${system.outdoor.element.label || 'outdoor unit'}` });
        const seeded = seedNetwork(baseline, system, seed, allUnits, options, seedIndex, searchStats);
        if (!seeded) continue;
        const seedEvaluation = evaluation(seeded, system, [seed.element.id], options);
        searchStats.evaluatedCandidates += 1;
        if (!seedEvaluation.feasible) { recordRejections(searchStats, seedEvaluation.hardIssues); continue; }
        let candidate: Candidate = { scene: seeded, connected: [seed.element.id], evaluation: seedEvaluation };
        // Farthest-first and nearest-first insertion orders explore different shared-trunk trees.
        // A unit that cannot use the current tree may become feasible after a later
        // insertion creates or splits a nearby straight. Defer it, then retry only
        // after the topology has grown. This reaches a fixed point without looping
        // on an unchanged network or weakening any fitting/clearance rule.
        let pending = ordered.filter(unit => unit.element.id !== seed.element.id);
        if (seedIndex % 2) pending.reverse();
        while (pending.length) {
          const deferred: Unit[] = [];
          let topologyGrew = false;
          for (const unit of pending) {
            options.onProgress?.({ completed: result.connectedIndoorIds.length + candidate.connected.length,
              total: requested.length, stage: `Connecting ${unit.element.label || unit.element.id}` });
            const attached = attachUnitWithCoordination(candidate, baselineIds, system, unit, allUnits, options, searchStats);
            if (attached) { candidate = attached; topologyGrew = true; }
            else deferred.push(unit);
          }
          if (!topologyGrew) break;
          pending = deferred;
        }
        candidate = refineCandidateRisers(candidate, baselineIds, system, allUnits, options, searchStats);
        if (better(candidate, best)) best = candidate;
      }
      const previousIndoorIds = new Set([...existingCircuit.indoorIds,
        ...workingScene.filter(element => removableSet.has(element.id)).flatMap(element => ownership(element)?.indoorUnitIds ?? [])]);
      const incumbentMembers = workingScene.filter(element => removableSet.has(element.id));
      if (best && incumbentMembers.length && supportedIncumbentGeometry(incumbentMembers, workingScene, options.settings)
        && !crossesEquipment(incumbentMembers, allUnits) && !hasNewNetworkPipeClash(baseline, incumbentMembers)) {
        const incumbent = evaluation(workingScene, system, system.indoors.map(unit => unit.element.id), options);
        if (incumbent.feasible && incumbent.score <= best.evaluation.score + 1e-6) {
          reportPreservedNetwork(workingScene, system, options, result);
          issues.push(`${system.outdoor.element.label || system.outdoor.element.id}: existing layout retained; no better feasible alternative was found for the selected objective.`);
          continue;
        }
      }
      const requiredIndoorIds = system.indoors.map(unit => unit.element.id);
      const missingIndoorIds = requiredIndoorIds.filter(id => !best?.connected.includes(id));
      const dropsPreviousIndoor = [...previousIndoorIds].some(id => !best?.connected.includes(id));
      if (!best || dropsPreviousIndoor) {
        reportPreservedNetwork(workingScene, system, options, result);
        const missingLabels = system.indoors.filter(unit => missingIndoorIds.includes(unit.element.id))
          .map(unit => unit.element.label || unit.element.id);
        issues.push(`${system.outdoor.element.label || system.outdoor.element.id}: no complete replacement with clear ports and buildable branch approaches was found${missingLabels.length ? ` for ${missingLabels.join(', ')}` : ''}; existing elements were preserved.`);
        continue;
      }
      const added = finalizeGenerated(best.scene, baselineIds, system, best.connected, options, best.evaluation.score);
      const evaluationIndoorIds = missingIndoorIds.length ? best.connected : requiredIndoorIds;
      const committedEvaluation = evaluation([...baseline, ...added], system, evaluationIndoorIds, options);
      if (!committedEvaluation.feasible || hasNewNetworkPipeClash(baseline, added)) {
        reportPreservedNetwork(workingScene, system, options, result);
        issues.push('The final connected network did not pass geometry validation; no elements were changed for this outdoor unit.');
        continue;
      }
      result.elementsToAdd.push(...added);
      result.removeElementIds.push(...removable);
      result.connectedIndoorIds.push(...best.connected);
      result.evaluations.push(committedEvaluation);
      if (existingCircuit.ids.length) issues.push(`${system.outdoor.element.label || system.outdoor.element.id}: the unlocked connected circuit was rebuilt; one undo restores its previous layout.`);
      if (missingIndoorIds.length) issues.push(`${system.outdoor.element.label || system.outdoor.element.id}: routed the best feasible sealed subset (${best.connected.length} of ${requiredIndoorIds.length} indoor units). Remaining units need more clear port or branch approach space.`);
      issues.push(...committedEvaluation.advisoryIssues);
      workingScene = [...baseline, ...added];
    }
    result.unconnectedIndoorIds = requested.filter(id => !result.connectedIndoorIds.includes(id));
    result.complete = requested.length > 0 && result.unconnectedIndoorIds.length === 0;
    result.evaluatedCandidates = searchStats.evaluatedCandidates;
    result.metrics = aggregateMetrics(result.evaluations);
    if (result.unconnectedIndoorIds.length && result.connectedIndoorIds.length) issues.push(`${result.unconnectedIndoorIds.length} indoor unit(s) could not be connected within the available fitting and clearance constraints. The connected network has no open branch ends.`);
    if (!result.complete) issues.push(...searchStats.rejectedReasons);
    result.issues = [...new Set(issues)];
    options.onProgress?.({ completed: result.connectedIndoorIds.length, total: requested.length, stage: 'Network evaluated' });
    return result;
  } finally { setActivePipeRoutingSettings(previousSettings); }
}
