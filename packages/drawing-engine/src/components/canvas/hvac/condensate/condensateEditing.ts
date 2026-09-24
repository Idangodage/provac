/**
 * Micro-editing of condensate drain networks — "edit the plan, the physics
 * follows". Every edit changes plan routes (or a design override); the whole
 * network is then re-solved by the same planner as Auto route, along exactly
 * those routes: continuous fall, pump risers, 45° offsets, wyes from the top,
 * sizes, fittings, refrigerant crossings and hangers. A result says whether the
 * edit can be committed and why not.
 *
 * Runs keep their element ids (selection and undo stay put) — a unit branch is
 * identified by its unit, a main / drop by the units draining through it.
 */
import type { HvacElement, Point2D, Room, Wall } from '../../../../types';
import { ownedElementSignature } from '../pipeEditRetention';
import type { PipeRoutingSettings } from '../pipeRoutingSettings';

import { buildCondensateEnvironment, type CondensateEnvironment } from './condensateEnvironment';
import { generateCondensateNetwork, type CondensateGenerationResult } from './condensateGenerator';
import { pointToSegmentDistance, segmentIntersection } from './condensateGeometry';
import { condensateRunKey, type CondensateFixedRoute } from './condensateNetworkPlanner';
import { getIndoorUnitDrainPort } from './condensatePorts';
import { fixedPrefixLength, reendRoute, restartRoute, tidyRoute, type PlanRoute } from './condensateRouteOps';
import { formatFallRatio, type CondensateDesignSettings } from './condensateSettings';
import {
  getCondensateOwnership,
  isCondensatePipe,
  readCondensateGullySpec,
  readCondensatePipeSpec,
  type CondensateFitting,
  type CondensateNetworkOwnership,
  type CondensatePipeSpec,
  type Point3,
} from './condensateTypes';

export interface CondensateEditContext {
  settings: CondensateDesignSettings;
  routingSettings: PipeRoutingSettings;
  walls?: readonly Wall[];
  rooms?: readonly Room[];
}

export type CondensateEditableFittingKind = 'cleanout' | 'air-vent';

export interface CondensateFittingEdit {
  action: 'add' | 'remove';
  kind: CondensateEditableFittingKind;
  point: Point2D;
}

/** What a micro-edit changes. Overrides are persisted on the network's pipes. */
export interface CondensateEdit {
  /** New plan routes per pipe id (outlet / riser foot / joint points included). */
  routes?: ReadonlyMap<string, PlanRoute>;
  /** Unit branches deleted from the network. */
  removePipeIds?: readonly string[];
  /** Units routed again by the router onto the rest of the network. */
  rerouteUnitIds?: readonly string[];
  /** Network design fall (%) — at least the code minimum; null clears it. */
  fallPercent?: number | null;
  /** Riser height cap per pumped unit (mm); null clears it. */
  liftLimitMm?: Record<string, number | null>;
  /** Minimum outer diameter per pipe id (upsize only); null clears it. */
  minOuterDiameterMm?: Record<string, number | null>;
  /** Hand-placed / removed fittings per pipe id (replaces that pipe's list). */
  fittingEdits?: Record<string, CondensateFittingEdit[]>;
}

export type CondensateEditStatus = 'ok' | 'short' | 'clash' | 'blocked' | 'locked' | 'invalid';

export interface CondensateEditResult {
  ok: boolean;
  status: CondensateEditStatus;
  message: string;
  /** Every pipe of the network after the edit. */
  elements: HvacElement[];
  add: HvacElement[];
  updates: HvacElement[];
  removeIds: string[];
  generation: CondensateGenerationResult | null;
}

export interface CondensateNetworkModel {
  networkId: string;
  gullyId: string;
  pipes: HvacElement[];
  specs: Map<string, CondensatePipeSpec>;
  routes: Map<string, PlanRoute>;
  /** Unit id → its branch pipe id. */
  unitBranchOf: Map<string, string>;
  unitIds: string[];
}

export interface CondensateEditSession {
  model: CondensateNetworkModel;
  solve: (edit: CondensateEdit, options?: { markEdited?: boolean }) => CondensateEditResult;
}

// Persisted per-pipe design overrides.
const FALL_KEY = 'designFallPercent';
const LIFT_KEY = 'riserLiftLimitMm';
const SIZE_KEY = 'minOuterDiameterMm';
const FITTINGS_KEY = 'fittingEdits';

export function isUnitBranchSpec(spec: Pick<CondensatePipeSpec, 'drainStart'>): boolean {
  return spec.drainStart?.kind === 'unit-drain' && typeof spec.drainStart.unitId === 'string';
}

function runKeyOf(spec: CondensatePipeSpec): string {
  return isUnitBranchSpec(spec) ? `u:${spec.drainStart!.unitId}` : `${spec.segmentRole}:${condensateRunKey(spec.upstreamUnitIds)}`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readCondensateNetworkModel(scene: readonly HvacElement[], networkId: string): CondensateNetworkModel | null {
  const pipes = scene.filter((element) => isCondensatePipe(element) && getCondensateOwnership(element)?.networkId === networkId);
  if (!pipes.length) return null;
  const owner = getCondensateOwnership(pipes[0]!)!;
  const specs = new Map(pipes.map((pipe) => [pipe.id, readCondensatePipeSpec(pipe)]));
  const routes = new Map<string, PlanRoute>();
  const unitBranchOf = new Map<string, string>();
  for (const pipe of pipes) {
    const spec = specs.get(pipe.id)!;
    const branch = isUnitBranchSpec(spec);
    routes.set(pipe.id, tidyRoute(spec.routePoints, fixedPrefixLength(branch)));
    if (branch) unitBranchOf.set(spec.drainStart!.unitId!, pipe.id);
  }
  return { networkId, gullyId: owner.gullyId, pipes, specs, routes, unitBranchOf, unitIds: [...owner.unitIds] };
}

function onPolyline(point: Point2D, points: readonly Point2D[]): boolean {
  for (let index = 1; index < points.length; index += 1) {
    if (pointToSegmentDistance(point, points[index - 1]!, points[index]!) <= 1) return true;
  }
  return false;
}

/**
 * Unit routes (outlet → termination or wye) rebuilt from the network's pipes,
 * trunk first and every branch after the route it joins — the insertion order
 * the planner needs.
 */
export function unitRoutesFromPipes(
  model: CondensateNetworkModel,
  routes: ReadonlyMap<string, PlanRoute>,
  removed: ReadonlySet<string>,
  reroute: ReadonlySet<string>,
): { routes: CondensateFixedRoute[]; problems: string[] } {
  const live = model.pipes.filter((pipe) => !removed.has(pipe.id));
  const spec = (pipe: HvacElement) => model.specs.get(pipe.id)!;
  const routeOf = (pipe: HvacElement) => routes.get(pipe.id) ?? model.routes.get(pipe.id) ?? [];
  const startByNode = new Map<string, HvacElement>();
  const inflow = new Map<string, HvacElement[]>();
  for (const pipe of live) {
    const { drainStart, drainEnd } = spec(pipe);
    if (drainStart?.kind === 'junction' && drainStart.nodeId) startByNode.set(drainStart.nodeId, pipe);
    if (drainEnd?.kind === 'junction' && drainEnd.nodeId) inflow.set(drainEnd.nodeId, [...(inflow.get(drainEnd.nodeId) ?? []), pipe]);
  }
  const hasWye = (pipe: HvacElement) => spec(pipe).fittings.some((fitting) => fitting.kind === 'wye');
  const arrivesThrough = (pipe: HvacElement) => {
    const nodeId = spec(pipe).drainEnd?.nodeId;
    const list = nodeId ? inflow.get(nodeId) ?? [] : [];
    if (list.length <= 1 || !hasWye(pipe)) return true;
    // Every inflow carries a wye (should not happen): the first one is the run through.
    return list.every(hasWye) && list[0] === pipe;
  };
  const problems: string[] = [];
  const entries: Array<CondensateFixedRoute & { through: boolean }> = [];
  for (const branch of live.filter((pipe) => isUnitBranchSpec(spec(pipe)))) {
    const unitId = spec(branch).drainStart!.unitId!;
    if (reroute.has(unitId)) continue;
    let points = routeOf(branch).map((point) => ({ ...point }));
    let current = branch;
    let target: CondensateFixedRoute['target'] | null = null;
    let through = false;
    for (let guard = 0; guard <= live.length; guard += 1) {
      const end = spec(current).drainEnd;
      if (!end) break;
      if (end.kind === 'gully') { target = 'sink'; through = true; break; }
      const next = end.nodeId ? startByNode.get(end.nodeId) : undefined;
      if (!next) break;
      const role = spec(next).segmentRole;
      if (role === 'drop' || role === 'terminal') { target = 'sink'; through = arrivesThrough(current); break; }
      if (!arrivesThrough(current)) { target = { junction: { ...points[points.length - 1]! } }; break; }
      points = [...points, ...routeOf(next).slice(1).map((point) => ({ ...point }))];
      current = next;
    }
    if (!target) {
      problems.push('A drain run ends at an open joint.');
      continue;
    }
    entries.push({ unitId, points, target, through });
  }
  const ordered: CondensateFixedRoute[] = [];
  const trunkIndex = Math.max(0, entries.findIndex((entry) => entry.target === 'sink' && entry.through));
  const remaining = [...entries];
  if (remaining.length) ordered.push(remaining.splice(trunkIndex, 1)[0]!);
  let progressed = true;
  while (remaining.length && progressed) {
    progressed = false;
    for (let index = 0; index < remaining.length; index += 1) {
      const entry = remaining[index]!;
      const joins = entry.target === 'sink' || ordered.some((placed) => onPolyline((entry.target as { junction: Point2D }).junction, placed.points));
      if (!joins) continue;
      ordered.push(entry);
      remaining.splice(index, 1);
      index -= 1;
      progressed = true;
    }
  }
  if (remaining.length) problems.push('A branch joins a run that is no longer there.');
  for (const unitId of reroute) ordered.push({ unitId, points: [], target: 'sink', reroute: true });
  return { routes: ordered.map(({ unitId, points, target, reroute: again }) => ({ unitId, points, target, ...(again ? { reroute: true } : {}) })), problems };
}

function closestOnPath3(nodes: readonly Point3[], point: Point2D): { point: Point3; axis: Point3 } | null {
  let best: { gap: number; point: Point3; axis: Point3 } | null = null;
  for (let index = 1; index < nodes.length; index += 1) {
    const a = nodes[index - 1]!;
    const b = nodes[index]!;
    const plan = Math.hypot(b.x - a.x, b.y - a.y);
    if (plan < 1) continue;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / (plan * plan)));
    const at = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
    const gap = Math.hypot(at.x - point.x, at.y - point.y);
    if (best && gap >= best.gap) continue;
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    best = { gap, point: at, axis: { x: (b.x - a.x) / length, y: (b.y - a.y) / length, z: (b.z - a.z) / length } };
  }
  return best ? { point: best.point, axis: best.axis } : null;
}

/** Applies hand-placed / removed rodding eyes and vents on top of the derived fittings. */
export function applyCondensateFittingEdits(element: HvacElement, edits: readonly CondensateFittingEdit[]): HvacElement {
  if (!edits.length) {
    if (!(FITTINGS_KEY in element.properties)) return element;
    const { [FITTINGS_KEY]: _dropped, ...properties } = element.properties;
    return { ...element, properties };
  }
  const spec = readCondensatePipeSpec(element);
  let fittings: CondensateFitting[] = [...spec.fittings];
  for (const edit of edits) {
    if (edit.action === 'remove') {
      fittings = fittings.filter((fitting) => fitting.kind !== edit.kind || Math.hypot(fitting.point.x - edit.point.x, fitting.point.y - edit.point.y) > 150);
      continue;
    }
    const at = closestOnPath3(spec.routeNodes3d, edit.point);
    if (!at) continue;
    fittings.push({
      id: `user-${edit.kind}-${Math.round(at.point.x)}-${Math.round(at.point.y)}`,
      kind: edit.kind,
      point: edit.kind === 'air-vent' ? { ...at.point, z: at.point.z + spec.outerDiameterMm / 2 } : at.point,
      nominalSize: spec.nominalSize,
      outerDiameterMm: spec.outerDiameterMm,
      axis: edit.kind === 'air-vent' ? { x: 0, y: 0, z: 1 } : at.axis,
      note: 'placed by hand',
    });
  }
  return { ...element, properties: { ...element.properties, fittings, [FITTINGS_KEY]: edits.map((edit) => ({ ...edit, point: { ...edit.point } })) } };
}

function segmentHitsBox(a: Point2D, b: Point2D, box: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
  const inside = (p: Point2D) => p.x > box.minX && p.x < box.maxX && p.y > box.minY && p.y < box.maxY;
  if (inside(a) || inside(b)) return true;
  const corners = [
    { x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY },
  ];
  return corners.some((corner, index) => segmentIntersection(a, b, corner, corners[(index + 1) % 4]!) !== null);
}

function storedOverrides(model: CondensateNetworkModel) {
  let fall: number | null = null;
  const lift: Record<string, number> = {};
  const size: Record<string, number> = {};
  const fittings: Record<string, CondensateFittingEdit[]> = {};
  for (const pipe of model.pipes) {
    const spec = model.specs.get(pipe.id)!;
    fall = fall ?? finiteNumber(pipe.properties[FALL_KEY]);
    const cap = finiteNumber(pipe.properties[LIFT_KEY]);
    if (cap !== null && isUnitBranchSpec(spec)) lift[spec.drainStart!.unitId!] = cap;
    const floor = finiteNumber(pipe.properties[SIZE_KEY]);
    if (floor !== null) size[pipe.id] = floor;
    const edits = pipe.properties[FITTINGS_KEY];
    if (Array.isArray(edits)) fittings[pipe.id] = edits as CondensateFittingEdit[];
  }
  return { fall, lift, size, fittings };
}

function merge<T>(base: Record<string, T>, edits: Record<string, T | null> | undefined): Record<string, T> {
  const result = { ...base };
  for (const [key, value] of Object.entries(edits ?? {})) {
    if (value === null) delete result[key];
    else result[key] = value;
  }
  return result;
}

function sameNodes(a: readonly Point3[], b: readonly Point3[]): boolean {
  return a.length === b.length && a.every((point, index) => Math.hypot(point.x - b[index]!.x, point.y - b[index]!.y, point.z - b[index]!.z) <= 0.5);
}

export function createCondensateEditSession(
  scene: HvacElement[],
  networkId: string,
  context: CondensateEditContext,
): CondensateEditSession | null {
  const model = readCondensateNetworkModel(scene, networkId);
  if (!model) return null;
  const environments = new Map<string, CondensateEnvironment>();
  const labels = new Map(scene.map((element) => [element.id, element.label || element.id]));
  let baselineConflicts: number | null = null;
  let counter = 0;
  const idFactory = (prefix: string) => `${prefix}-${networkId.slice(-6)}e${Date.now().toString(36)}${(counter++).toString(36)}`;

  const solve = (edit: CondensateEdit, options: { markEdited?: boolean } = {}): CondensateEditResult => {
    const markEdited = options.markEdited ?? true;
    const failure = (status: CondensateEditStatus, message: string, generation: CondensateGenerationResult | null = null): CondensateEditResult => ({
      ok: false, status, message, elements: model.pipes, add: [], updates: [], removeIds: [], generation,
    });
    const routes = new Map(model.routes);
    edit.routes?.forEach((route, id) => routes.set(id, route));
    const removed = new Set(edit.removePipeIds ?? []);
    const reroute = new Set(edit.rerouteUnitIds ?? []);
    for (const unitId of reroute) {
      const branchId = model.unitBranchOf.get(unitId);
      if (branchId) removed.add(branchId);
    }
    const removedUnits = new Set([...removed].map((id) => model.specs.get(id)).filter((spec) => spec && isUnitBranchSpec(spec))
      .map((spec) => spec!.drainStart!.unitId!).filter((unitId) => !reroute.has(unitId)));
    const { routes: fixedRoutes, problems } = unitRoutesFromPipes(model, routes, removed, reroute);
    if (problems.length) return failure('invalid', problems[0]!);
    if (!fixedRoutes.length) return failure('invalid', 'Nothing would drain into this network any more — delete it from the drawing instead.');

    const stored = storedOverrides(model);
    const fall = edit.fallPercent !== undefined ? edit.fallPercent : stored.fall;
    const settings: CondensateDesignSettings = fall !== null && fall > 0
      ? {
        ...context.settings,
        minSlopePercent: Math.max(context.settings.minSlopePercent, fall),
        preferredSlopePercent: Math.max(context.settings.preferredSlopePercent, fall),
      }
      : context.settings;
    const liftLimits = merge(stored.lift, edit.liftLimitMm);
    const sizeByPipe = merge(stored.size, edit.minOuterDiameterMm);
    const sizeFloorsMm: Record<string, number> = {};
    for (const [pipeId, od] of Object.entries(sizeByPipe)) {
      const spec = model.specs.get(pipeId);
      if (spec) sizeFloorsMm[condensateRunKey(spec.upstreamUnitIds)] = od;
    }
    const fittingEdits = { ...stored.fittings, ...(edit.fittingEdits ?? {}) };

    const environmentKey = `${settings.minSlopePercent}`;
    const envOptions = {
      settings,
      routingSettings: context.routingSettings,
      walls: context.walls ? [...context.walls] : undefined,
      rooms: context.rooms ? [...context.rooms] : undefined,
      unitIds: model.unitIds,
      gullyIds: [model.gullyId],
      editNetworkId: networkId,
    };
    let environment = environments.get(environmentKey);
    if (!environment) {
      environment = buildCondensateEnvironment(scene, envOptions);
      environments.set(environmentKey, environment);
    }
    const generation = generateCondensateNetwork(scene, {
      ...envOptions,
      environment,
      idFactory,
      fixedNetwork: { networkId, gullyId: model.gullyId, routes: fixedRoutes, liftLimitMm: liftLimits, sizeFloorsMm },
    });

    // ---- verdict ----------------------------------------------------------
    const conflicts = generation.crossings.filter((crossing) => crossing.relation === 'hop' || crossing.relation === 'unresolved').length;
    const expected = model.unitIds.filter((unitId) => !removedUnits.has(unitId));
    const failed = generation.perUnit.find((unit) => expected.includes(unit.unitId) && unit.status === 'infeasible');
    if (failed) {
      return failure('short', `${failed.label}: ${failed.reason ?? 'cannot drain along this route'}.`, generation);
    }
    for (const route of fixedRoutes) {
      if (route.reroute) continue;
      const unitId = route.unitId;
      for (let index = 2; index < route.points.length; index += 1) {
        const a = route.points[index - 1]!;
        const b = route.points[index]!;
        // Any equipment body (other units included) except the run's own unit and its termination.
        const box = environment.obstacles.find((candidate) => candidate.id !== unitId
          && candidate.id !== model.gullyId && segmentHitsBox(a, b, candidate));
        if (box) return failure('blocked', `Runs through ${labels.get(box.id) ?? 'equipment'} — move the run clear of it.`, generation);
      }
    }
    if (baselineConflicts !== null && conflicts > baselineConflicts) {
      const crossing = generation.crossings.find((candidate) => candidate.relation === 'hop' || candidate.relation === 'unresolved');
      return failure('clash', `Runs into ${crossing ? labels.get(crossing.serviceElementId) ?? 'a refrigerant run' : 'a refrigerant run'} with no room to pass — move the run or re-route it.`, generation);
    }

    // ---- ids, overrides, ownership -----------------------------------------
    const oldByKey = new Map<string, HvacElement>();
    for (const pipe of model.pipes) {
      if (removed.has(pipe.id)) continue;
      const key = runKeyOf(model.specs.get(pipe.id)!);
      if (!oldByKey.has(key)) oldByKey.set(key, pipe);
    }
    const used = new Set<string>();
    const elements = generation.elementsToAdd.map((fresh) => {
      const spec = readCondensatePipeSpec(fresh);
      const previous = oldByKey.get(runKeyOf(spec));
      const id = previous && !used.has(previous.id) ? previous.id : fresh.id;
      if (previous) used.add(previous.id);
      const unitId = isUnitBranchSpec(spec) ? spec.drainStart!.unitId! : null;
      const properties: Record<string, unknown> = { ...fresh.properties };
      if (previous?.properties.locked === true) properties.locked = true;
      if (fall !== null && fall > 0) properties[FALL_KEY] = fall;
      if (unitId && liftLimits[unitId] !== undefined) properties[LIFT_KEY] = liftLimits[unitId];
      if (previous && sizeByPipe[previous.id] !== undefined) properties[SIZE_KEY] = sizeByPipe[previous.id];
      const oldOwner = previous ? getCondensateOwnership(previous) : null;
      const owner: CondensateNetworkOwnership = {
        ...(fresh.properties.condensateNetwork as CondensateNetworkOwnership),
        ...(markEdited ? { editPolicy: 'retain' as const } : oldOwner?.editPolicy ? { editPolicy: oldOwner.editPolicy } : {}),
      };
      let element: HvacElement = { ...fresh, id, properties: { ...properties, condensateNetwork: owner } };
      const edits = previous ? fittingEdits[previous.id] : undefined;
      if (edits) element = applyCondensateFittingEdits(element, edits);
      owner.signature = ownedElementSignature(element, 'condensateNetwork');
      return element;
    });

    // A locked run keeps its exact geometry.
    for (const pipe of model.pipes) {
      if (pipe.properties.locked !== true) continue;
      const after = elements.find((element) => element.id === pipe.id);
      if (!after || !sameNodes(readCondensatePipeSpec(after).routeNodes3d, model.specs.get(pipe.id)!.routeNodes3d)) {
        return failure('locked', `${pipe.label || 'A drain run'} is locked — unlock it to change this network.`, generation);
      }
    }

    const oldIds = new Set(model.pipes.map((pipe) => pipe.id));
    const add = elements.filter((element) => !oldIds.has(element.id));
    const updates = elements.filter((element) => oldIds.has(element.id));
    const kept = new Set(elements.map((element) => element.id));
    const removeIds = model.pipes.filter((pipe) => !kept.has(pipe.id)).map((pipe) => pipe.id);
    const network = generation.networks[0];
    const units = generation.perUnit.filter((unit) => expected.includes(unit.unitId));
    const margin = units.length ? Math.min(...units.map((unit) => unit.headMarginMm)) : 0;
    const message = [
      network ? `Fall ${formatFallRatio(network.mainSlopePercent)}` : null,
      `margin ${Math.round(margin)} mm`,
      conflicts ? `${conflicts} hop${conflicts === 1 ? '' : 's'} pending` : null,
    ].filter(Boolean).join(' · ');
    return { ok: true, status: 'ok', message, elements, add, updates, removeIds, generation };
  };

  // The network as it stands: the reference for new conflicts.
  const baseline = solve({}, { markEdited: false });
  baselineConflicts = baseline.generation
    ? baseline.generation.crossings.filter((crossing) => crossing.relation === 'hop' || crossing.relation === 'unresolved').length
    : 0;
  return { model, solve };
}

/** Networks a set of elements belong to or drain (units, gullies, pipes). */
export function condensateNetworkIdsTouching(scene: readonly HvacElement[], elementIds: readonly string[]): string[] {
  const ids = new Set(elementIds);
  const networks = new Set<string>();
  for (const element of scene) {
    if (!isCondensatePipe(element)) continue;
    const owner = getCondensateOwnership(element);
    if (!owner) continue;
    if (ids.has(element.id) || ids.has(owner.gullyId) || owner.unitIds.some((unitId) => ids.has(unitId))) networks.add(owner.networkId);
  }
  return [...networks].sort();
}

function rotate(vector: Point2D, degrees: number): Point2D {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: vector.x * cos - vector.y * sin, y: vector.x * sin + vector.y * cos };
}

export interface CondensateFollowResult {
  add: HvacElement[];
  updates: HvacElement[];
  removeIds: string[];
  messages: string[];
}

/**
 * Drains follow moved indoor units and gullies (like refrigerant pipes follow
 * units): the unit connection moves with its unit, the run reconnects square,
 * and the network re-solves. A network that cannot follow is left as it is
 * (the design check then reports it as stale).
 */
export function followCondensateDrains(
  before: readonly HvacElement[],
  after: HvacElement[],
  movedIds: readonly string[],
  context: CondensateEditContext,
): CondensateFollowResult {
  const result: CondensateFollowResult = { add: [], updates: [], removeIds: [], messages: [] };
  const beforeById = new Map(before.map((element) => [element.id, element]));
  const afterById = new Map(after.map((element) => [element.id, element]));
  const moved = movedIds.filter((id) => {
    const a = beforeById.get(id);
    const b = afterById.get(id);
    return a && b && (Math.abs(a.position.x - b.position.x) > 0.01 || Math.abs(a.position.y - b.position.y) > 0.01
      || Math.abs((a.rotation ?? 0) - (b.rotation ?? 0)) > 0.01 || Math.abs(a.elevation - b.elevation) > 0.01);
  });
  if (!moved.length) return result;
  for (const networkId of condensateNetworkIdsTouching(after, moved)) {
    const model = readCondensateNetworkModel(after, networkId);
    if (!model) continue;
    const locked = model.pipes.find((pipe) => pipe.properties.locked === true);
    if (locked) {
      result.messages.push(`Drains of network ${networkId.slice(-6)} did not follow: ${locked.label || 'a run'} is locked.`);
      continue;
    }
    const routes = new Map<string, PlanRoute>();
    for (const unitId of model.unitIds.filter((id) => moved.includes(id))) {
      const branchId = model.unitBranchOf.get(unitId);
      const unitBefore = beforeById.get(unitId);
      const unitAfter = afterById.get(unitId);
      if (!branchId || !unitBefore || !unitAfter) continue;
      const port = getIndoorUnitDrainPort(unitAfter, context.settings);
      const route = model.routes.get(branchId)!;
      if (!port || route.length < 2) continue;
      const offset = rotate({ x: route[1]!.x - route[0]!.x, y: route[1]!.y - route[0]!.y }, (unitAfter.rotation ?? 0) - (unitBefore.rotation ?? 0));
      routes.set(branchId, restartRoute(route, port.point, { x: port.point.x + offset.x, y: port.point.y + offset.y }));
    }
    if (moved.includes(model.gullyId)) {
      const gullyBefore = beforeById.get(model.gullyId);
      const gullyAfter = afterById.get(model.gullyId);
      if (gullyBefore && gullyAfter) {
        const from = readCondensateGullySpec(gullyBefore).connectionPoint;
        const to = readCondensateGullySpec(gullyAfter).connectionPoint;
        const delta = { x: to.x - from.x, y: to.y - from.y };
        // Runs that end on the termination: at the top of its drop, or on the gully itself.
        const dropTops = new Set(model.pipes.map((pipe) => model.specs.get(pipe.id)!)
          .filter((spec) => spec.segmentRole === 'drop' || spec.segmentRole === 'terminal')
          .map((spec) => spec.drainStart?.nodeId).filter((nodeId): nodeId is string => Boolean(nodeId)));
        for (const pipe of model.pipes) {
          const spec = model.specs.get(pipe.id)!;
          const route = routes.get(pipe.id) ?? model.routes.get(pipe.id)!;
          if (spec.segmentRole === 'drop' || spec.segmentRole === 'terminal' || route.length < 2) continue;
          const endsOnTermination = spec.drainEnd?.kind === 'gully' || (spec.drainEnd?.nodeId !== undefined && dropTops.has(spec.drainEnd.nodeId));
          if (!endsOnTermination) continue;
          const end = route[route.length - 1]!;
          routes.set(pipe.id, reendRoute(route, { x: end.x + delta.x, y: end.y + delta.y }));
        }
      }
    }
    const session = createCondensateEditSession(after, networkId, context);
    if (!session) continue;
    const solved = session.solve({ routes }, { markEdited: false });
    if (!solved.ok) {
      result.messages.push(`Drains could not follow: ${solved.message} They are marked stale — use Re-fit or Regenerate.`);
      continue;
    }
    result.add.push(...solved.add);
    result.updates.push(...solved.updates);
    result.removeIds.push(...solved.removeIds);
  }
  return result;
}
