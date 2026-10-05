/**
 * Builders' work for duct wall penetrations: the BOM rows (sleeves, packing
 * and sealant or fire-stop, fire dampers with their access doors) and the
 * penetration schedule a builder sets the openings out from (CSV).
 */
import type { DuctBomRow } from './ductBom';
import type { DuctFabricationPlan } from './ductFabricationPlanner';
import type { DuctPenetration } from './ductPenetrations';

export interface DuctPenetrationScheduleRow {
  /** The builder's reference, numbered through the project in run order: WP-01, WP-02 … */
  ref: string;
  /** The run (its label) and the penetration's own mark on it (PN-01 …, as the plan shows it). */
  run: string;
  runId: string;
  mark: string;
  wallId: string;
  /** What the wall is built of (brick, concrete, partition; masonry when only its layer says). */
  wall: string;
  thicknessMm: number;
  duct: string;
  opening: string;
  /** Centre of the opening (plan, mm) and the duct's clear bottom. */
  x: number;
  y: number;
  bottomZ: number;
  angleDeg: number;
  fireDamper: boolean;
  exterior: boolean;
}

const size = (penetration: Pick<DuctPenetration, 'widthMm' | 'heightMm' | 'diameterMm'>) =>
  (penetration.diameterMm !== undefined ? `Ø${Math.round(penetration.diameterMm)}` : `${Math.round(penetration.widthMm)}×${Math.round(penetration.heightMm)}`);

const openingSize = (penetration: Pick<DuctPenetration, 'opening'>) =>
  (penetration.opening.round ? `Ø${Math.round(penetration.opening.widthMm)}` : `${Math.round(penetration.opening.widthMm)}×${Math.round(penetration.opening.heightMm)}`);

/** Every penetration of the planned runs, in run then station order. */
export function ductPenetrationSchedule(plans: readonly DuctFabricationPlan[], labels: ReadonlyMap<string, string> = new Map()): DuctPenetrationScheduleRow[] {
  let counter = 0;
  return plans.flatMap((plan) => (plan.penetrations ?? []).map((penetration) => ({
    ref: `WP-${String((counter += 1)).padStart(2, '0')}`,
    run: labels.get(plan.elementId) ?? plan.elementId, runId: plan.elementId, mark: penetration.mark,
    wallId: penetration.wallId, wall: penetration.material ?? (penetration.structural ? 'masonry' : 'partition'),
    thicknessMm: Math.round(penetration.thicknessMm), duct: size(penetration), opening: openingSize(penetration),
    x: Math.round(penetration.point.x), y: Math.round(penetration.point.y), bottomZ: Math.round(penetration.bottomZ),
    angleDeg: Math.round(penetration.angleDeg), fireDamper: penetration.fireDamper, exterior: penetration.exterior,
  })));
}

function csvCell(value: string | number | boolean): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function ductPenetrationScheduleToCsv(rows: readonly DuctPenetrationScheduleRow[]): string {
  const header = ['Ref', 'Run', 'Mark', 'Wall', 'Construction', 'Thickness (mm)', 'Duct', 'Opening', 'X (mm)', 'Y (mm)', 'Duct bottom (mm)', 'Angle (deg)', 'Fire damper', 'Exterior wall'];
  return [header, ...rows.map((row) => [row.ref, row.run, row.mark, row.wallId, row.wall, row.thicknessMm, row.duct, row.opening, row.x, row.y, row.bottomZ, row.angleDeg,
    row.fireDamper ? 'yes' : 'no', row.exterior ? 'yes' : 'no'])].map((line) => line.map(csvCell).join(',')).join('\n');
}

/**
 * BOM rows for the penetrations of fabricated runs: a sleeve per opening
 * (by opening size and wall thickness), the packing and acoustic sealant of a
 * plain penetration or the fire-stop of a fire-dampered one (by the opening's
 * perimeter), each fire damper and its access door.
 */
export function ductPenetrationBomRows(plans: readonly DuctFabricationPlan[]): DuctBomRow[] {
  const sleeves = new Map<string, number>();
  const dampers = new Map<string, number>();
  let sealantM = 0;
  let firestopM = 0;
  let doors = 0;
  for (const plan of plans) {
    for (const penetration of plan.penetrations ?? []) {
      const key = `${openingSize(penetration)}|${Math.round(penetration.thicknessMm)}`;
      sleeves.set(key, (sleeves.get(key) ?? 0) + 1);
      const perimeterM = (penetration.opening.round ? Math.PI * penetration.opening.widthMm : 2 * (penetration.opening.widthMm + penetration.opening.heightMm)) / 1000;
      if (penetration.fireDamper) {
        firestopM += perimeterM;
        doors += 1;
        dampers.set(size(penetration), (dampers.get(size(penetration)) ?? 0) + 1);
      } else {
        sealantM += perimeterM;
      }
    }
  }
  const rows: DuctBomRow[] = [];
  for (const [key, count] of [...sleeves].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    const [opening, thickness] = key.split('|') as [string, string];
    rows.push({ category: 'Wall penetrations', description: `Wall sleeve, galvanised steel, for a ${thickness} mm wall`, size: opening, quantity: count, unit: 'no.', basis: 'opening = duct outer + clearance all round (practice)' });
  }
  if (sealantM > 0) {
    rows.push({ category: 'Wall penetrations', description: 'Mineral wool packing and acoustic sealant round plain penetrations', size: '—', quantity: Math.round(sealantM * 100) / 100, unit: 'm', basis: 'opening perimeter (practice)' });
  }
  for (const [duct, count] of [...dampers].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    rows.push({ category: 'Wall penetrations', description: 'Fire damper, curtain type, in its sleeve with breakaway connections (UL 555 / EN 1366-2; rating to the wall)', size: duct, quantity: count, unit: 'no.', basis: 'project fire-damper policy or the run\'s choice' });
  }
  if (doors > 0) {
    rows.push({ category: 'Wall penetrations', description: 'Access door beside each fire damper (inspection and reset)', size: '—', quantity: doors, unit: 'no.', basis: 'NFPA 90A / local code practice' });
    rows.push({ category: 'Wall penetrations', description: 'Fire-stop sealant at the fire damper sleeves (to the damper maker\'s listing)', size: '—', quantity: Math.round(firestopM * 100) / 100, unit: 'm', basis: 'opening perimeter (practice)' });
  }
  return rows;
}
