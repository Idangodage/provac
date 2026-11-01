/**
 * Refrigerant mains belong in the ceiling void. A level stretch of a line whose
 * insulation hangs below the ceiling plane, in a room, is a main in the room:
 * Auto route lays one only as a last resort, and the checks flag it.
 *
 *  - Not counted: a unit's own connection at its port's level (a floor-standing
 *    unit's pipes start low), risers, and, where the drawing has rooms, piping
 *    outside every room (to an outdoor unit).
 * Pure.
 */
import type { HvacElement, Point2D } from '../../../types';
import { isPointInPolygon } from '../../../utils/geometry';
import type { VrfValidationIssue } from '../../../vrf/rules';

import { buildingCeiling } from './buildingSection';
import { normalizePipeRouteNodes3d } from './pipeRoute3d';
import { resolveRefrigerantPipeSpec } from './refrigerantPipePairModel';

type RoomOutline = { vertices: readonly Point2D[]; properties3D?: { ceilingHeight?: number } | null };

/** How much of each refrigerant line runs level below the ceiling, in the rooms (mm of plan length). */
export function refrigerantBelowCeiling(
  elements: readonly HvacElement[],
  rooms: readonly RoomOutline[] = [],
  ceilingMm = buildingCeiling(elements, rooms).ceilingMm,
): { lengthMm: number; byRun: Map<string, number> } {
  const byRun = new Map<string, number>();
  const inRoom = (point: Point2D) => !rooms.length || rooms.some((room) => room.vertices.length >= 3 && isPointInPolygon(point, [...room.vertices]));
  for (const element of elements) {
    if (element.type !== 'refrigerant-pipe') continue;
    const spec = resolveRefrigerantPipeSpec(element.properties);
    const radius = spec.outerDiameterMm / 2;
    const stored = normalizePipeRouteNodes3d(element.properties.routeNodes3d);
    const nodes = stored.length >= 2 ? stored : spec.routePoints.map((point) => ({ ...point, z: element.elevation + radius }));
    const portLevels = [spec.startConnection, spec.endConnection]
      .filter((connection) => connection?.connectionKind === 'unit-port').map((connection) => connection!.elevationMm);
    let length = 0;
    for (let index = 1; index < nodes.length; index += 1) {
      const a = nodes[index - 1]!;
      const b = nodes[index]!;
      const plan = Math.hypot(b.x - a.x, b.y - a.y);
      if (plan < 1 || Math.abs(b.z - a.z) > 1) continue;
      if (a.z - radius >= ceilingMm - 0.5) continue;
      if (portLevels.some((level) => Math.abs(level - a.z) < 1)) continue;
      if (!inRoom({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })) continue;
      length += plan;
    }
    if (length > 0.5) byRun.set(element.id, length);
  }
  return { lengthMm: [...byRun.values()].reduce((sum, value) => sum + value, 0), byRun };
}

/** A warning on each refrigerant line that runs level below the ceiling in a room. */
export function checkRefrigerantAboveCeiling(elements: readonly HvacElement[], rooms: readonly RoomOutline[] = []): VrfValidationIssue[] {
  const { ceilingMm } = buildingCeiling(elements, rooms);
  const { byRun } = refrigerantBelowCeiling(elements, rooms, ceilingMm);
  const labels = new Map(elements.map((element) => [element.id, element.label]));
  return [...byRun].map(([id, lengthMm]) => ({
    id: `REFRIGERANT_BELOW_CEILING:${id}`, level: 'warning', code: 'REFRIGERANT_BELOW_CEILING', entityId: id,
    message: `${labels.get(id) || 'This refrigerant line'} runs ${(lengthMm / 1000).toFixed(1)} m level below the ${Math.round(ceilingMm)} mm ceiling, in the room.`,
    suggestedFix: 'Raise it into the ceiling void, over or round what is there (Auto route lays the mains above the ceiling where it can), or box it in.',
  }));
}
