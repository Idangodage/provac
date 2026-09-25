/**
 * Bill of materials and fabrication schedule, read from the fabrication plans
 * (so they always match what the canvas shows). A run whose construction could
 * not be resolved — e.g. an unsupported pressure class — is not counted; it is
 * listed under Issues instead of being silently priced.
 */
import { gaugeLabelForSheet } from './ductCatalog';
import type { DuctFabricationPlan, DuctPiece } from './ductFabricationPlanner';
import { describeJoint } from './ductGauge';

export type DuctBomCategory = 'Sheet metal' | 'Fabricated pieces' | 'Joints' | 'Connections' | 'Issues';

export interface DuctBomRow {
  category: DuctBomCategory;
  description: string;
  size: string;
  quantity: number;
  unit: 'm²' | 'kg' | 'no.' | 'm';
  basis: string;
}

export interface DuctScheduleRow {
  run: string;
  mark: string;
  kind: string;
  size: string;
  lengthMm: number;
  sheetMm: number | null;
  gauge: string;
  joint: string;
  requiredClass: string;
  crossBreak: boolean;
  areaM2: number;
  massKg: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

function sizeLabel(piece: Pick<DuctPiece, 'widthMm' | 'heightMm'>): string {
  return `${Math.round(piece.widthMm)}×${Math.round(piece.heightMm)}`;
}

function pieceDescription(piece: DuctPiece): string {
  if (piece.kind === 'straight') return `Straight section ${Math.round(piece.lengthMm)} mm`;
  if (piece.kind === 'connector') return 'Flexible connector (fabric + GI edges)';
  if (piece.kind === 'end-cap') return 'End cap (blank flange)';
  const elbow = piece.elbow!;
  const angle = Math.round(elbow.angleDeg);
  return elbow.style === 'radius'
    ? `${angle}° radius elbow R/W ${round2(elbow.centrelineRadiusMm / piece.widthMm)}`
    : `${angle}° square elbow with ${elbow.vaneCount} turning vanes`;
}

function increment(map: Map<string, number>, key: string, by: number): void {
  if (by <= 0) return;
  map.set(key, (map.get(key) ?? 0) + by);
}

export function buildDuctBom(plans: readonly DuctFabricationPlan[]): DuctBomRow[] {
  const rows: DuctBomRow[] = [];
  const good = plans.filter((plan) => plan.status === 'ok');
  for (const plan of plans) {
    if (plan.status === 'ok') continue;
    const reason = plan.issues.find((issue) => issue.severity === 'error')?.message ?? 'construction unresolved';
    rows.push({ category: 'Issues', description: `Not fabricated: ${reason}`, size: plan.elementId, quantity: 1, unit: 'no.', basis: 'validation' });
  }

  const sheetArea = new Map<number, number>();
  const sheetMass = new Map<number, number>();
  let fabric = 0;
  const pieces = new Map<string, number>();
  for (const plan of good) {
    for (const piece of plan.pieces) {
      if (piece.sheetThicknessMm !== null) {
        sheetArea.set(piece.sheetThicknessMm, (sheetArea.get(piece.sheetThicknessMm) ?? 0) + piece.sheetAreaM2);
        sheetMass.set(piece.sheetThicknessMm, (sheetMass.get(piece.sheetThicknessMm) ?? 0) + piece.massKg);
      }
      fabric += piece.fabricAreaM2;
      increment(pieces, `${pieceDescription(piece)}|${sizeLabel(piece)}|${piece.sheetThicknessMm ?? '-'}`, 1);
    }
  }
  for (const [thickness, area] of [...sheetArea].sort((a, b) => a[0] - b[0])) {
    const label = `${thickness.toFixed(2)} mm (${gaugeLabelForSheet(thickness)})`;
    rows.push({ category: 'Sheet metal', description: 'Galvanised sheet G-60, incl. seam/flange allowance', size: label, quantity: round2(area), unit: 'm²', basis: 'SMACNA 1995 table → stock sheet' });
    rows.push({ category: 'Sheet metal', description: 'Galvanised sheet mass', size: label, quantity: round2(sheetMass.get(thickness) ?? 0), unit: 'kg', basis: '7850 kg/m³ + G-60 coating' });
  }
  if (fabric > 0) {
    rows.push({ category: 'Sheet metal', description: 'Flexible connector fabric', size: '—', quantity: round2(fabric), unit: 'm²', basis: 'connector width × girth' });
  }
  for (const [key, count] of [...pieces].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    const [description, size, sheet] = key.split('|') as [string, string, string];
    rows.push({ category: 'Fabricated pieces', description, size: `${size} · ${sheet} mm`, quantity: count, unit: 'no.', basis: 'fabrication plan' });
  }

  // Joint hardware, per system.
  const hardware = new Map<string, { unit: DuctBomRow['unit']; quantity: number; basis: string }>();
  const add = (key: string, quantity: number, unit: DuctBomRow['unit'], basis: string) => {
    if (quantity <= 0) return;
    const entry = hardware.get(key) ?? { unit, quantity: 0, basis };
    entry.quantity += quantity;
    hardware.set(key, entry);
  };
  for (const plan of good) {
    for (const joint of plan.joints) {
      const h = joint.hardware;
      if (!h) continue;
      const category = joint.kind === 'unit-connection' ? 'Connections' : 'Joints';
      const system = h.label;
      add(`${category}|${system}: joints|—`, 1, 'no.', 'fabrication plan');
      if (h.flangePieces > 0) add(`${category}|${system}: flange profile|—`, h.flangeLengthMm / 1000, 'm', 'both duct ends');
      if (h.angleMember) add(`${category}|Angle L${h.angleMember.legMm}×${h.angleMember.thicknessMm}${h.angleMember.hotRolled ? ' hot-rolled' : ''} (mitred frames)|—`, h.angleLengthMm / 1000, 'm', 'SMACNA T-22 / Table 1-12M');
      add(`${category}|${system}: corner pieces|—`, h.cornerPieces, 'no.', 'SMACNA T-24 (16 ga)');
      if (h.bolts) {
        add(`${category}|Bolt ${h.bolts.size}×${h.bolts.lengthMm}|${h.bolts.size}`, h.bolts.count, 'no.', system);
        add(`${category}|Nut ${h.bolts.size}|${h.bolts.size}`, h.nuts, 'no.', system);
        add(`${category}|Washer ${h.bolts.size}|${h.bolts.size}`, h.washers, 'no.', system);
      }
      if (h.cleats) add(`${category}|Cleat ${h.cleats.lengthMm} mm|—`, h.cleats.count, 'no.', system);
      if (h.ductFasteners) add(`${category}|${h.ductFasteners.kind === 'rivet' ? 'Rivet' : 'Screw'}: ${h.ductFasteners.spec}|—`, h.ductFasteners.count, 'no.', system);
      add(`${category}|Gasket tape|—`, h.gasketLengthMm / 1000, 'm', system);
      add(`${category}|Corner sealant points|—`, h.sealedCorners, 'no.', 'seal class');
      add(`${category}|Angle frame corner welds|—`, h.cornerWelds, 'no.', 'SMACNA T-22');
    }
  }
  for (const [key, entry] of [...hardware].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [category, description, size] = key.split('|') as [DuctBomCategory, string, string];
    rows.push({
      category, description, size,
      quantity: entry.unit === 'm' ? round2(entry.quantity) : Math.round(entry.quantity),
      unit: entry.unit, basis: entry.basis,
    });
  }
  return rows;
}

export function buildDuctFabricationSchedule(plans: readonly DuctFabricationPlan[]): DuctScheduleRow[] {
  return plans.flatMap((plan) => plan.pieces.map((piece): DuctScheduleRow => {
    const construction = plan.constructionByLeg[piece.legIndex];
    return {
      run: plan.elementId,
      mark: piece.mark,
      kind: pieceDescription(piece),
      size: sizeLabel(piece),
      lengthMm: Math.round(piece.lengthMm),
      sheetMm: piece.sheetThicknessMm,
      gauge: piece.sheetThicknessMm === null ? '—' : gaugeLabelForSheet(piece.sheetThicknessMm),
      joint: describeJoint(construction?.joint ?? null),
      requiredClass: construction?.requiredClass ?? '—',
      crossBreak: Boolean(construction && piece.kind === 'straight' && (construction.crossBreak.width || construction.crossBreak.height)),
      areaM2: round2(piece.sheetAreaM2),
      massKg: round2(piece.massKg),
    };
  }));
}

function csv(rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>): string {
  const escape = (value: string | number | boolean | null) => {
    const text = value === null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => row.map(escape).join(',')).join('\n');
}

export function ductBomToCsv(rows: readonly DuctBomRow[]): string {
  return csv([
    ['Category', 'Description', 'Size', 'Quantity', 'Unit', 'Basis'],
    ...rows.map((row) => [row.category, row.description, row.size, row.quantity, row.unit, row.basis]),
  ]);
}

export function ductScheduleToCsv(rows: readonly DuctScheduleRow[]): string {
  return csv([
    ['Run', 'Mark', 'Piece', 'Size (clear)', 'Length mm', 'Sheet mm', 'Gauge', 'Joint', 'Class', 'Cross-break', 'Area m²', 'Mass kg'],
    ...rows.map((row) => [row.run, row.mark, row.kind, row.size, row.lengthMm, row.sheetMm, row.gauge, row.joint, row.requiredClass, row.crossBreak, row.areaM2, row.massKg]),
  ]);
}
