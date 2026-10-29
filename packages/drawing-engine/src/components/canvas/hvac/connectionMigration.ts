/**
 * Drawings made before units took their maker's connections (27 October 2026)
 * have pipes and drains on the old drawn ports. When such a drawing opens,
 * each unit whose connected pipes or drains start away from its ports now is
 * re-attached the way a moved unit's are: its refrigerant pairs rebuilt from
 * their drawn route onto the new stubs, its drains re-solved from the new
 * outlet. Where the maker's stubs leave the other side of the unit (the
 * FDT28's, drawn on +x, are on −x), the head of the drawn route is planned
 * again first: out along the new stubs and round the unit's body to where
 * rejoining the drawn route costs least. A unit whose re-attachment would add a design error or a new pipe
 * clash keeps its connections as they were, and is reported. Its own gas and
 * liquid may press their insulation together a little where an old route
 * climbs back to its levels (foam gives that much on site); more than that is
 * a clash.
 */
import type { HvacElement, Point2D } from '../../../types';

import { reattachCondensateDrains, type CondensateEditContext } from './condensate/condensateEditing';
import { getIndoorUnitDrainPort } from './condensate/condensatePorts';
import { isCondensatePipe, readCondensatePipeSpec } from './condensate/condensateTypes';
import { findNewNetworkPipeClashes } from './networkPipeClearance';
import { findObstacleAwareOrthogonalRoute } from './obstacleAwareOrthogonalRoute';
import { getActivePipeRoutingSettings, type PipeRoutingSettings } from './pipeRoutingSettings';
import { refrigerantChangeIssues } from './refrigerantChangeValidation';
import {
  deriveLegacyPairCenterline,
  getRefrigerantPipeBundleSnapTargets,
  resolveRefrigerantPipeSpec,
  resolveRefrigerantPipeUnitPortReconnectionUpdates,
  type RefrigerantPipeBundleConnection,
  type RefrigerantPipeConnection,
} from './refrigerantPipePairModel';
import { unitConnectionsFor } from './unitConnections';

/** A connection this far off its port has to move (mm). */
const MOVED_MM = 1;
/** How far a unit's own gas and liquid insulation may press together after a re-attachment (mm). */
const OWN_PAIR_SQUEEZE_MM = 5;

export interface ConnectionMigrationPlan {
  /** Units whose pipes and drains moved onto the maker's stubs. */
  unitIds: string[];
  /** Units whose connections stay as they were: re-attaching them would add a design error. */
  keptUnitIds: string[];
  updates: Array<{ id: string; updates: Partial<HvacElement> }>;
  add: HvacElement[];
  removeIds: string[];
  /** What could not follow, in the drain design's words. */
  messages: string[];
}

const off = (a: { x: number; y: number }, az: number, b: { x: number; y: number }, bz: number) =>
  Math.hypot(a.x - b.x, a.y - b.y) > MOVED_MM || Math.abs(az - bz) > MOVED_MM;

/** Units with maker data whose connected refrigerant lines or drains start away from their ports now. */
export function unitsWithStaleConnections(scene: readonly HvacElement[], context?: Pick<CondensateEditContext, 'settings'>): string[] {
  const units = new Map(scene.filter((element) => unitConnectionsFor(element)).map((element) => [element.id, element]));
  if (!units.size) return [];
  const ports = new Map(getRefrigerantPipeBundleSnapTargets([...units.values()])
    .filter((target) => target.connectionKind === 'unit-port' && target.sourceElementId)
    .map((target) => [target.sourceElementId!, target]));
  const stale = new Set<string>();
  for (const element of scene) {
    if (element.type === 'refrigerant-pipe') {
      // Without the scene the connections read as stored, not healed onto the current ports.
      const spec = resolveRefrigerantPipeSpec(element.properties);
      for (const connection of [spec.startConnection, spec.endConnection]) {
        if (connection?.connectionKind !== 'unit-port' || !connection.sourceElementId) continue;
        const port = ports.get(connection.sourceElementId);
        if (!port) continue;
        const gas = spec.lineKind === 'gas';
        if (off(connection.portPoint, connection.elevationMm, gas ? port.gasPoint : port.liquidPoint,
          gas ? port.gasElevationMm : port.liquidElevationMm)) stale.add(connection.sourceElementId);
      }
    } else if (isCondensatePipe(element)) {
      const start = readCondensatePipeSpec(element).drainStart;
      if (start?.kind !== 'unit-drain' || !start.unitId) continue;
      const unit = units.get(start.unitId);
      const port = unit ? getIndoorUnitDrainPort(unit, context?.settings) : null;
      if (port && off(start.point, start.z, port.point, port.z)) stale.add(start.unitId);
    }
  }
  return [...stale].sort();
}

/** How far out from a drain outlet, and how wide either side, its hose and pumped riser need the space (mm). */
const DRAIN_KEEP_OUT_REACH_MM = 450;
const DRAIN_KEEP_OUT_HALF_WIDTH_MM = 150;

/** The space a unit's drain leaves its outlet by (its hose and pumped riser), kept for it. */
function drainKeepOut(unit: HvacElement): Array<{ id: string; minX: number; minY: number; maxX: number; maxY: number }> {
  const drain = getIndoorUnitDrainPort(unit);
  if (!drain) return [];
  const far = {
    x: drain.point.x + drain.direction.x * DRAIN_KEEP_OUT_REACH_MM,
    y: drain.point.y + drain.direction.y * DRAIN_KEEP_OUT_REACH_MM,
  };
  return [{
    id: `${unit.id}:drain`,
    minX: Math.min(drain.point.x, far.x) - DRAIN_KEEP_OUT_HALF_WIDTH_MM,
    minY: Math.min(drain.point.y, far.y) - DRAIN_KEEP_OUT_HALF_WIDTH_MM,
    maxX: Math.max(drain.point.x, far.x) + DRAIN_KEEP_OUT_HALF_WIDTH_MM,
    maxY: Math.max(drain.point.y, far.y) + DRAIN_KEEP_OUT_HALF_WIDTH_MM,
  }];
}

/** The cardinal direction nearest a plan vector. */
function cardinal(vector: Point2D): Point2D {
  return Math.abs(vector.x) >= Math.abs(vector.y)
    ? { x: Math.sign(vector.x) || 1, y: 0 }
    : { x: 0, y: Math.sign(vector.y) || 1 };
}

/** What an elbow costs, in pipe, when choosing where a new head rejoins a drawn route (the router's own default). */
const HEAD_ELBOW_COST_MM = 1000;

/**
 * A drawn route (the unit's end first) with its head planned again: out along
 * the new stubs and round the unit's body to the drawn point clear of it where
 * the whole route costs least (pipe plus elbows). The first point clear of the
 * unit is often where its old stubs were, on the far side: rejoining there
 * would wrap the pair round the unit and back along itself. `far`: the unit at
 * the route's other end, whose body the head keeps out of and whose stubs it
 * comes in along if it runs all the way there. `drawnUpTo`: the last point that
 * is the drawn route's (a re-planned far approach is not), where it may rejoin.
 */
function cheapestNewHead(route: readonly Point2D[], bundle: RefrigerantPipeBundleConnection, unit: HvacElement,
  spacing: number, settings: PipeRoutingSettings, far: { unit: HvacElement; bundle: RefrigerantPipeBundleConnection } | null,
  drawnUpTo = route.length - 2): Point2D[] | null {
  const body = bundle.sourceBoundsMm;
  if (!body) return null;
  const bendRadius = Math.max(spacing, 80);
  const clearance = spacing / 2 + settings.defaultPipeGapMm;
  const margin = clearance + bendRadius;
  const clear = (point: Point2D) => point.x < body.minX - margin || point.x > body.maxX + margin
    || point.y < body.minY - margin || point.y > body.maxY + margin;
  // The end of a port's straight (its stub tips sit on the casing face): from there round the bodies.
  const stubEnd = (port: RefrigerantPipeBundleConnection) => ({
    x: port.point.x + port.direction.x * (settings.minimumPortStubMm + bendRadius),
    y: port.point.y + port.direction.y * (settings.minimumPortStubMm + bendRadius),
  });
  const start = stubEnd(bundle);
  const farBody = far?.bundle.sourceBoundsMm;
  const obstacles = [{ id: unit.id, ...body }, ...drainKeepOut(unit), ...(far && farBody ? [{ id: far.unit.id, ...farBody }] : [])];
  // What the drawn route still runs beyond each of its points: its pipe and its elbows (where it turns).
  const legLength = (index: number) => Math.hypot(route[index + 1]!.x - route[index]!.x, route[index + 1]!.y - route[index]!.y);
  const turns = (index: number) => {
    const before = { x: route[index]!.x - route[index - 1]!.x, y: route[index]!.y - route[index - 1]!.y };
    const after = { x: route[index + 1]!.x - route[index]!.x, y: route[index + 1]!.y - route[index]!.y };
    return before.x * after.x + before.y * after.y < Math.cos(Math.PI / 36) * Math.hypot(before.x, before.y) * Math.hypot(after.x, after.y);
  };
  const beyond = route.map(() => 0);
  for (let index = route.length - 2; index >= 0; index -= 1) {
    beyond[index] = beyond[index + 1]! + legLength(index) + (index + 1 < route.length - 1 && turns(index + 1) ? HEAD_ELBOW_COST_MM : 0);
  }
  const rejoin = (index: number): { costMm: number; points: Point2D[] } | null => {
    const join = route[index]!;
    if (!clear(join)) return null;
    const next = route[index + 1];
    // It arrives running on along the drawn leg it joins; at a far unit, in along that unit's stubs.
    const atFarStubs = !next && far ? far.bundle : null;
    const target = atFarStubs ? stubEnd(atFarStubs) : join;
    const arrive = atFarStubs ? { x: -atFarStubs.direction.x, y: -atFarStubs.direction.y }
      : cardinal(next ? { x: next.x - join.x, y: next.y - join.y } : { x: join.x - bundle.point.x, y: join.y - bundle.point.y });
    const head = findObstacleAwareOrthogonalRoute({
      start, startDirection: bundle.direction, end: target, endDirection: { x: -arrive.x, y: -arrive.y },
      startStraightMm: 0, endStraightMm: 0, bendRadiusMm: bendRadius, clearanceMm: clearance, obstacles,
      bendPenaltyMm: HEAD_ELBOW_COST_MM,
    });
    if (!head) return null;
    return atFarStubs
      ? { costMm: head.objectiveMm, points: [{ ...bundle.point }, ...head.points, { ...atFarStubs.point }] }
      : { costMm: head.objectiveMm + beyond[index]!, points: [{ ...bundle.point }, ...head.points, ...route.slice(index + 1)] };
  };
  let best: { costMm: number; points: Point2D[] } | null = null;
  for (let index = 1; index <= Math.min(drawnUpTo, route.length - 2); index += 1) {
    const candidate = rejoin(index);
    if (candidate && (!best || candidate.costMm < best.costMm)) best = candidate;
  }
  // The drawn route is the designer's: a head runs all the way to its far end only when it can rejoin it nowhere.
  return (best ?? rejoin(route.length - 1))?.points ?? null;
}

/**
 * A derived route (the unit's end first) with its last stretch into the unit at
 * its far end planned again: from its last corner clear of that unit's ports
 * (their straight, a bend and the pair's width), round that unit's body and in
 * along its stubs. Derived from an old pair, the stretch can sit too close to
 * the ports to carry their straight (old pairs often crossed over there to meet
 * their ports). `drawnUpTo`: the last point still the drawn route's.
 */
function replanFarApproach(route: Point2D[], far: { unit: HvacElement; bundle: RefrigerantPipeBundleConnection },
  spacing: number, settings: PipeRoutingSettings): { route: Point2D[]; drawnUpTo: number } {
  const unchanged = { route, drawnUpTo: route.length - 2 };
  const body = far.bundle.sourceBoundsMm;
  if (!body || route.length < 3) return unchanged;
  const port = far.bundle.point;
  const bendRadius = Math.max(spacing, 80);
  const crowding = settings.minimumPortStubMm + bendRadius + spacing;
  const stubEnd = {
    x: port.x + far.bundle.direction.x * (settings.minimumPortStubMm + bendRadius),
    y: port.y + far.bundle.direction.y * (settings.minimumPortStubMm + bendRadius),
  };
  for (let index = route.length - 2; index > 0; index -= 1) {
    const from = route[index]!;
    if (Math.hypot(from.x - port.x, from.y - port.y) < crowding) continue;
    const tail = findObstacleAwareOrthogonalRoute({
      start: from, startDirection: cardinal({ x: from.x - route[index - 1]!.x, y: from.y - route[index - 1]!.y }),
      end: stubEnd, endDirection: far.bundle.direction, startStraightMm: 0, endStraightMm: 0, bendRadiusMm: bendRadius,
      clearanceMm: spacing / 2 + settings.defaultPipeGapMm, obstacles: [{ id: far.unit.id, ...body }],
      bendPenaltyMm: HEAD_ELBOW_COST_MM,
    });
    if (tail) return { route: [...route.slice(0, index), ...tail.points, { ...port }], drawnUpTo: index };
  }
  return unchanged;
}

/**
 * The unit's pairs whose drawn route left its old stubs on the side its maker
 * stubs no longer face: each pair's drawn route (as stored or, for a pair drawn
 * before it was stored, derived from its gas line) with its head planned again
 * (cheapestNewHead), whichever end of the pair the unit is at. Both lines carry
 * the same drawn route. Pairs that need no new head, or for which no way round
 * is found, are left as they are.
 */
export function replanFlippedHeads(scene: readonly HvacElement[], unit: HvacElement): HvacElement[] {
  const bundle = getRefrigerantPipeBundleSnapTargets([unit]).find((target) => target.connectionKind === 'unit-port');
  if (!bundle?.sourceBoundsMm) return [...scene];
  const settings = getActivePipeRoutingSettings();
  const replanned = new Map<string, Point2D[]>();
  const pairs = new Map<string, { pipes: HvacElement[]; atStart: boolean }>();
  for (const element of scene) {
    if (element.type !== 'refrigerant-pipe') continue;
    const spec = resolveRefrigerantPipeSpec(element.properties);
    const atUnit = (connection: RefrigerantPipeConnection | null | undefined) =>
      connection?.connectionKind === 'unit-port' && connection.sourceElementId === unit.id;
    if (!spec.bundleId || (!atUnit(spec.startConnection) && !atUnit(spec.endConnection))) continue;
    const pair = pairs.get(spec.bundleId) ?? { pipes: [], atStart: atUnit(spec.startConnection) };
    pair.pipes.push(element);
    pairs.set(spec.bundleId, pair);
  }
  for (const { pipes, atStart } of pairs.values()) {
    const gas = pipes.find((pipe) => resolveRefrigerantPipeSpec(pipe.properties).lineKind === 'gas');
    const liquid = pipes.find((pipe) => resolveRefrigerantPipeSpec(pipe.properties).lineKind === 'liquid');
    if (!gas || !liquid) continue;
    const spec = resolveRefrigerantPipeSpec(gas.properties);
    const oldDirection = (atStart ? spec.startConnection : spec.endConnection)?.direction;
    if (!oldDirection || oldDirection.x * bundle.direction.x + oldDirection.y * bundle.direction.y > 0) continue;
    const spacing = Number(gas.properties.pairCenterSpacingMm) || 90;
    const farConnection = atStart ? spec.endConnection : spec.startConnection;
    const farUnit = farConnection?.connectionKind === 'unit-port' && farConnection.sourceElementId !== unit.id
      ? scene.find((element) => element.id === farConnection.sourceElementId) : undefined;
    const farBundle = farUnit && getRefrigerantPipeBundleSnapTargets([farUnit]).find((target) => target.connectionKind === 'unit-port');
    const far = farUnit && farBundle ? { unit: farUnit, bundle: farBundle } : null;
    // The unit's end first.
    const oriented = (points: Point2D[]) => (atStart ? points : [...points].reverse());
    const stored = gas.properties.authoredCenterlineRoute as Point2D[] | undefined;
    let route: Point2D[];
    let drawnUpTo: number | undefined;
    if (Array.isArray(stored) && stored.length >= 2) {
      route = oriented(stored);
    } else {
      const derived = deriveLegacyPairCenterline(gas, liquid, spacing, atStart ? { end: farBundle } : { start: farBundle });
      if (!derived || derived.length < 2) continue;
      ({ route, drawnUpTo } = far ? replanFarApproach(oriented(derived), far, spacing, settings)
        : { route: oriented(derived), drawnUpTo: undefined });
    }
    const head = cheapestNewHead(route, bundle, unit, spacing, settings, far, drawnUpTo);
    if (!head) continue;
    for (const pipe of pipes) replanned.set(pipe.id, atStart ? head : [...head].reverse());
  }
  if (!replanned.size) return [...scene];
  return scene.map((element) => {
    const route = replanned.get(element.id);
    return route ? { ...element, properties: { ...element.properties, authoredCenterlineRoute: route } } as HvacElement : element;
  });
}

function applied(scene: readonly HvacElement[], updates: ReadonlyArray<{ id: string; updates: Partial<HvacElement> }>): HvacElement[] {
  const byId = new Map(updates.map((entry) => [entry.id, entry.updates]));
  return scene.map((element) => {
    const update = byId.get(element.id);
    return update ? { ...element, ...update, properties: { ...element.properties, ...(update.properties ?? {}) } } as HvacElement : element;
  });
}

/** The re-attachment of every unit with stale connections, or null when there is none. */
export function planConnectionMigration(scene: readonly HvacElement[], context: CondensateEditContext): ConnectionMigrationPlan | null {
  const staleIds = unitsWithStaleConnections(scene, context);
  if (!staleIds.length) return null;
  const plan: ConnectionMigrationPlan = { unitIds: [], keptUnitIds: [], updates: [], add: [], removeIds: [], messages: [] };
  let working: HvacElement[] = [...scene];
  const moved: string[] = [];
  for (const unitId of staleIds) {
    const unit = working.find((element) => element.id === unitId);
    if (!unit) continue;
    // The unit's refrigerant lines re-attach as a moved unit's do (a head that left the other side planned again).
    const pipeUpdates = resolveRefrigerantPipeUnitPortReconnectionUpdates(replanFlippedHeads(working, unit), unit);
    const next = applied(working, pipeUpdates);
    const changedIds = pipeUpdates.map((entry) => entry.id);
    const changed = next.filter((element) => changedIds.includes(element.id));
    const clashes = pipeUpdates.length ? findNewNetworkPipeClashes(working, changed, changedIds) : [];
    const ownPair = (ids: readonly string[]) => ids.every((id) => changedIds.includes(id));
    const disqualifying = clashes.filter((clash) => !ownPair(clash.elementIds)
      || clash.distanceMm < clash.requiredMm - OWN_PAIR_SQUEEZE_MM);
    if (pipeUpdates.length && (refrigerantChangeIssues(working, next, changedIds, { walls: context.walls }).length
      || disqualifying.length)) {
      plan.keptUnitIds.push(unitId);
      continue;
    }
    working = next;
    plan.updates.push(...pipeUpdates);
    moved.push(unitId);
  }
  if (moved.length) {
    // Their drains re-solve together: units can share a network.
    const drains = reattachCondensateDrains(working, moved, context);
    plan.updates.push(...drains.updates.map((element) => ({ id: element.id, updates: element })));
    plan.add.push(...drains.add);
    plan.removeIds.push(...drains.removeIds);
    plan.messages.push(...drains.messages);
  }
  plan.unitIds = moved;
  // One entry per element: a later update of the same element extends the earlier one.
  const merged = new Map<string, Partial<HvacElement>>();
  for (const entry of plan.updates) {
    const previous = merged.get(entry.id);
    merged.set(entry.id, previous
      ? { ...previous, ...entry.updates, properties: { ...(previous.properties ?? {}), ...(entry.updates.properties ?? {}) } }
      : entry.updates);
  }
  plan.updates = [...merged].map(([id, updates]) => ({ id, updates }));
  return plan.unitIds.length || plan.keptUnitIds.length ? plan : null;
}
