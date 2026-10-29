/**
 * Drawings made before units took their maker's connections (27 October 2026)
 * have pipes and drains on the old drawn ports. When such a drawing opens,
 * each unit whose connected pipes or drains start away from its ports now is
 * re-attached the way a moved unit's are: its refrigerant pairs rebuilt from
 * their drawn route onto the new stubs, its drains re-solved from the new
 * outlet. Where the maker's stubs leave the other side of the unit (the
 * FDT28's, drawn on +x, are on −x), the head of the drawn route is planned
 * again first: out along the new stubs and round the unit's body to the
 * first drawn point clear of it. A unit whose re-attachment would add a design error or a new pipe
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
import { getActivePipeRoutingSettings } from './pipeRoutingSettings';
import { refrigerantChangeIssues } from './refrigerantChangeValidation';
import {
  getRefrigerantPipeBundleSnapTargets,
  resolveRefrigerantPipeSpec,
  resolveRefrigerantPipeUnitPortReconnectionUpdates,
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

/**
 * The unit's pairs whose drawn route left its old stubs on the side its maker
 * stubs no longer face: each pair's drawn route with its head planned again,
 * out along the new stubs and round the unit's body to the first drawn point
 * clear of it (both lines carry the same drawn route). Pairs that need no new
 * head, or for which no way round is found, are left as they are.
 */
export function replanFlippedHeads(scene: readonly HvacElement[], unit: HvacElement): HvacElement[] {
  const bundle = getRefrigerantPipeBundleSnapTargets([unit]).find((target) => target.connectionKind === 'unit-port');
  if (!bundle?.sourceBoundsMm) return [...scene];
  const settings = getActivePipeRoutingSettings();
  const replanned = new Map<string, Point2D[]>();
  const byBundle = new Map<string, HvacElement[]>();
  for (const element of scene) {
    if (element.type !== 'refrigerant-pipe') continue;
    const spec = resolveRefrigerantPipeSpec(element.properties);
    if (!spec.bundleId || spec.startConnection?.sourceElementId !== unit.id || spec.startConnection.connectionKind !== 'unit-port') continue;
    byBundle.set(spec.bundleId, [...(byBundle.get(spec.bundleId) ?? []), element]);
  }
  for (const pair of byBundle.values()) {
    const spec = resolveRefrigerantPipeSpec(pair[0]!.properties);
    const authored = pair[0]!.properties.authoredCenterlineRoute as Point2D[] | undefined;
    const oldDirection = spec.startConnection!.direction;
    if (!Array.isArray(authored) || authored.length < 2 || !oldDirection
      || oldDirection.x * bundle.direction.x + oldDirection.y * bundle.direction.y > 0) continue;
    const spacing = Number(pair[0]!.properties.pairCenterSpacingMm) || 90;
    const bendRadius = Math.max(spacing, 80);
    const margin = spacing / 2 + settings.defaultPipeGapMm + bendRadius;
    const body = bundle.sourceBoundsMm;
    const clear = (point: Point2D) => point.x < body.minX - margin || point.x > body.maxX + margin
      || point.y < body.minY - margin || point.y > body.maxY + margin;
    const index = authored.findIndex((point, at) => at > 0 && clear(point));
    if (index < 0) continue;
    const next = authored[index + 1];
    const arrive = next ? cardinal({ x: next.x - authored[index]!.x, y: next.y - authored[index]!.y })
      : cardinal({ x: authored[index]!.x - bundle.point.x, y: authored[index]!.y - bundle.point.y });
    // From the end of the stubs' straight (their tips sit on the casing face), round the body.
    const stubEnd = {
      x: bundle.point.x + bundle.direction.x * (settings.minimumPortStubMm + bendRadius),
      y: bundle.point.y + bundle.direction.y * (settings.minimumPortStubMm + bendRadius),
    };
    const route = findObstacleAwareOrthogonalRoute({
      start: stubEnd, startDirection: bundle.direction, end: authored[index]!,
      endDirection: { x: -arrive.x, y: -arrive.y },
      startStraightMm: 0, endStraightMm: 0, bendRadiusMm: bendRadius,
      clearanceMm: spacing / 2 + settings.defaultPipeGapMm,
      obstacles: [{ id: unit.id, ...body }, ...drainKeepOut(unit)],
    });
    if (!route) continue;
    const head = [{ ...bundle.point }, ...route.points];
    for (const element of pair) replanned.set(element.id, [...head, ...authored.slice(index + 1)]);
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
