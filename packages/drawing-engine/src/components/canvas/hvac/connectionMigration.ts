/**
 * Drawings made before units took their maker's connections (27 October 2026)
 * have pipes and drains on the old drawn ports. When such a drawing opens,
 * each unit whose connected pipes or drains start away from its ports now is
 * re-attached the way a moved unit's are: its refrigerant pairs rebuilt from
 * their drawn route onto the new stubs, its drains re-solved from the new
 * outlet. A unit whose re-attachment would add a design error keeps its
 * connections as they were, and is reported.
 */
import type { HvacElement } from '../../../types';

import { reattachCondensateDrains, type CondensateEditContext } from './condensate/condensateEditing';
import { getIndoorUnitDrainPort } from './condensate/condensatePorts';
import { isCondensatePipe, readCondensatePipeSpec } from './condensate/condensateTypes';
import { refrigerantChangeIssues } from './refrigerantChangeValidation';
import {
  getRefrigerantPipeBundleSnapTargets,
  resolveRefrigerantPipeSpec,
  resolveRefrigerantPipeUnitPortReconnectionUpdates,
} from './refrigerantPipePairModel';
import { unitConnectionsFor } from './unitConnections';

/** A connection this far off its port has to move (mm). */
const MOVED_MM = 1;

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
    // The unit's refrigerant lines re-attach as a moved unit's do.
    const pipeUpdates = resolveRefrigerantPipeUnitPortReconnectionUpdates(working, unit);
    const next = applied(working, pipeUpdates);
    if (pipeUpdates.length && refrigerantChangeIssues(working, next, pipeUpdates.map((entry) => entry.id), { walls: context.walls }).length) {
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
