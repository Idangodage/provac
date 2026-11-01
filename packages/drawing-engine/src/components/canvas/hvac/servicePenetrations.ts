/**
 * Where refrigerant lines and drains pass through walls (derived, never stored,
 * as a duct's are): one row each on the builder's penetration schedule, and for
 * refrigerant, which has no list of its own, the sleeves and seal in the BOM. A
 * drain's sleeves are in its own BOM (condensateBom.ts).
 */
import type { HvacElement } from '../../../types';

import { pipeSleeveBoreMm, pipeWallCrossings, type PipeWallCrossing } from './buildingSection';
import type { DuctBomRow } from './duct/ductBom';
import type { DuctBuilding } from './duct/ductBuilding';
import type { DuctPenetrationScheduleRow } from './duct/ductPenetrationSchedule';
import { listNetworkPipeLanes } from './networkPipeClearance';

export interface ServicePenetration extends PipeWallCrossing {
  elementId: string;
  service: string;
  /** The insulated pipe's outside diameter, and the bore of its sleeve (mm). */
  pipeOuterMm: number;
  sleeveBoreMm: number;
}

/** Every refrigerant line's and drain's wall crossings, by run. */
export function servicePenetrations(scene: readonly HvacElement[], building: Pick<DuctBuilding, 'walls' | 'rooms'>): ServicePenetration[] {
  if (!building.walls.length) return [];
  return listNetworkPipeLanes([...scene]).flatMap((lane) => pipeWallCrossings(lane.segments, lane.radiusMm, building.walls, building.rooms).map((crossing) => ({
    ...crossing, elementId: lane.elementId, service: lane.service, pipeOuterMm: 2 * lane.radiusMm, sleeveBoreMm: pipeSleeveBoreMm(lane.radiusMm),
  })));
}

const SERVICE_NAMES: Record<string, string> = { gas: 'Gas line', liquid: 'Liquid line', drain: 'Drain' };

/** Their rows on the penetration schedule, numbered on from the ducts'. */
export function servicePenetrationScheduleRows(
  penetrations: readonly ServicePenetration[], labels: ReadonlyMap<string, string> = new Map(), rowsBefore = 0,
): DuctPenetrationScheduleRow[] {
  return penetrations.map((penetration, index) => ({
    ref: `WP-${String(rowsBefore + index + 1).padStart(2, '0')}`,
    run: labels.get(penetration.elementId) ?? penetration.elementId, runId: penetration.elementId, mark: `PS-${String(index + 1).padStart(2, '0')}`,
    wallId: penetration.wallId, wall: penetration.material ?? (penetration.structural ? 'masonry' : 'partition'),
    thicknessMm: Math.round(penetration.thicknessMm), duct: `${SERVICE_NAMES[penetration.service] ?? penetration.service} Ø${Math.round(penetration.pipeOuterMm)}`,
    opening: `Ø${penetration.sleeveBoreMm}`, x: Math.round(penetration.point.x), y: Math.round(penetration.point.y),
    bottomZ: Math.round(penetration.z - penetration.pipeOuterMm / 2), angleDeg: Math.round(penetration.angleDeg), fireDamper: false, exterior: penetration.exterior,
  }));
}

/** The BOM rows of the refrigerant lines' penetrations: a sleeve per crossing, the packing and seal round them. */
export function refrigerantPenetrationBomRows(penetrations: readonly ServicePenetration[]): DuctBomRow[] {
  const refrigerant = penetrations.filter((penetration) => penetration.service === 'gas' || penetration.service === 'liquid');
  const sleeves = new Map<string, number>();
  let sealM = 0;
  for (const penetration of refrigerant) {
    const key = `${penetration.sleeveBoreMm}|${Math.round(penetration.thicknessMm)}`;
    sleeves.set(key, (sleeves.get(key) ?? 0) + 1);
    sealM += (Math.PI * penetration.sleeveBoreMm) / 1000;
  }
  const rows: DuctBomRow[] = [...sleeves].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([key, count]) => {
    const [bore, thickness] = key.split('|') as [string, string];
    return { category: 'Wall penetrations', description: `Wall sleeve for an insulated refrigerant line, for a ${thickness} mm wall`, size: `Ø${bore}`, quantity: count, unit: 'no.', basis: 'One per line, per wall crossing' };
  });
  if (sealM > 0) {
    rows.push({ category: 'Wall penetrations', description: 'Packing and sealant round refrigerant sleeves (fire-stop where the wall is rated)', size: '—', quantity: Math.round(sealM * 10) / 10, unit: 'm', basis: 'Sleeve perimeters' });
  }
  return rows;
}
