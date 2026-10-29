/**
 * How a unit's field pipes meet its maker stubs, in world terms: where each
 * stub ends, how far each connected refrigerant line and drain starts from
 * it, and the least gap between its gas and liquid insulation near the unit.
 * For the dev verification handle and its canvas drivers.
 */
import type { HvacElement } from '../../../types';

import { getIndoorUnitDrainPort } from './condensate/condensatePorts';
import { isCondensatePipe, readCondensatePipeSpec } from './condensate/condensateTypes';
import { insulatedLineFromUnit, insulationGapNearUnit } from './refrigerantInsulationClearance';
import { resolveRefrigerantPipeSpec } from './refrigerantPipePairModel';
import { unitConnectionsFor } from './unitConnections';

interface Point3 { x: number; y: number; z: number }

export interface UnitConnectionReport {
  unitId: string;
  stubs: Array<{ kind: string; joint: string; tip: Point3; direction: { x: number; y: number }; inModel: boolean }>;
  /** Each connected refrigerant line: how far its end at the unit lies from its stub's tip (mm). */
  lines: Array<{ id: string; lineKind: string; offStubMm: number }>;
  /** The unit's drain: how far it starts from the outlet it should, and the hose drawn over it (mm). */
  drain: { id: string; offOutletMm: number; hoseMm: number } | null;
  /** The least gas-to-liquid insulation gap over the lines' first 1.5 m (mm), when both are connected. */
  insulationGapMm: number | null;
}

const distance3 = (a: Point3, b: Point3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function unitConnectionReport(scene: readonly HvacElement[], unitId: string): UnitConnectionReport | null {
  const unit = scene.find((element) => element.id === unitId);
  const set = unit ? unitConnectionsFor(unit) : null;
  if (!unit || !set) return null;
  const angle = ((unit.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle); const sin = Math.sin(angle);
  const centre = { x: unit.position.x + unit.width / 2, y: unit.position.y + unit.depth / 2 };
  const world = (x: number, y: number) => ({ x: centre.x + x * cos - y * sin, y: centre.y + x * sin + y * cos });
  const stubs = set.connections.map((connection) => ({
    kind: connection.kind,
    joint: connection.joint,
    tip: { ...world(connection.tipX, connection.y), z: unit.elevation + connection.z },
    direction: { x: connection.axis * cos, y: connection.axis * sin },
    inModel: connection.inModel,
  }));
  const tipOf = (kind: string) => stubs.find((stub) => stub.kind === kind)?.tip ?? null;
  const lines: UnitConnectionReport['lines'] = [];
  const insulated: Record<string, ReturnType<typeof insulatedLineFromUnit>> = {};
  for (const element of scene) {
    if (element.type !== 'refrigerant-pipe') continue;
    const line = insulatedLineFromUnit(element, unitId, scene);
    if (!line) continue;
    const lineKind = resolveRefrigerantPipeSpec(element.properties).lineKind;
    const tip = tipOf(lineKind);
    if (tip) lines.push({ id: element.id, lineKind, offStubMm: distance3(line.nodes[0]!, tip) });
    insulated[lineKind] ??= line;
  }
  const drainPipe = scene.find((element) => isCondensatePipe(element) && readCondensatePipeSpec(element).drainStart?.unitId === unitId);
  const port = getIndoorUnitDrainPort(unit);
  const drainSpec = drainPipe ? readCondensatePipeSpec(drainPipe) : null;
  const first = drainSpec?.routeNodes3d[0];
  return {
    unitId,
    stubs,
    lines,
    drain: drainPipe && drainSpec && first && port
      ? { id: drainPipe.id, offOutletMm: distance3(first, { ...port.point, z: port.z }), hoseMm: drainSpec.drainHoseLengthMm }
      : null,
    insulationGapMm: insulated.gas && insulated.liquid ? insulationGapNearUnit(insulated.gas, insulated.liquid).gapMm : null,
  };
}
