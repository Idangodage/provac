/**
 * Bill of materials and fabrication schedule, read from the fabrication plans
 * (so they always match what the canvas shows). A run whose construction could
 * not be resolved — e.g. an unsupported pressure class — is not counted; it is
 * listed under Issues instead of being silently priced.
 */
import type { HvacElement } from '../../../../types';

import { gaugeLabelForSheet } from './ductCatalog';
import type { DuctFabricationPlan, DuctPiece } from './ductFabricationPlanner';
import { VANE_RUNNER, type DuctVaneSpec } from './ductFittingRules';
import { FLEX_HANGER_WIRE_DIAMETER_MM, FLEX_RULES } from './ductFlex';
import { describeJoint } from './ductGauge';
import type { DuctSupportPlan } from './ductSupports';
import { readDuctTerminalSpec, TERMINAL_FILTER_LABELS, TERMINAL_FILTER_THICKNESS_MM, terminalLabel } from './ductTerminals';

export type DuctBomCategory = 'Sheet metal' | 'Fabricated pieces' | 'Accessories' | 'Joints' | 'Connections' | 'Insulation' | 'Air terminals' | 'Flexible duct' | 'Supports' | 'Issues';

export interface DuctBomRow {
  category: DuctBomCategory;
  description: string;
  size: string;
  quantity: number;
  unit: 'm²' | 'kg' | 'no.' | 'm' | 'L';
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

function sizeLabel(piece: Pick<DuctPiece, 'widthMm' | 'heightMm' | 'endWidthMm' | 'endHeightMm' | 'diameterMm' | 'endDiameterMm'>): string {
  const start = piece.diameterMm !== undefined ? `Ø${Math.round(piece.diameterMm)}` : `${Math.round(piece.widthMm)}×${Math.round(piece.heightMm)}`;
  const endDiameter = piece.endDiameterMm ?? piece.diameterMm;
  const end = endDiameter !== undefined ? `Ø${Math.round(endDiameter)}` : `${Math.round(piece.endWidthMm)}×${Math.round(piece.endHeightMm)}`;
  return start === end ? start : `${start} → ${end}`;
}

/** A transition between a rectangular and a round end (SMACNA Fig. 2-7). */
function shapeChangeDescription(piece: DuctPiece): string | null {
  if (piece.kind !== 'transition' || (piece.diameterMm === undefined) === (piece.endDiameterMm === undefined)) return null;
  const form = piece.diameterMm === undefined ? 'Square-to-round' : 'Round-to-square';
  return `${form} transition (${piece.vertical ? 'concentric, riser' : 'flat bottom'}; SMACNA Fig. 2-7), ${Math.round(piece.lengthMm)} mm`;
}

const ROUND_TAKEOFF_DESCRIPTIONS = {
  'round-tee': '90° tap into round main, 51 mm spigot (SMACNA Fig. 3-4)',
  'round-lateral': '45° lateral tap into round main, 51 mm spigot (SMACNA Fig. 3-4)',
} as const;

/** Round pieces (SMACNA chapter 3). */
function roundPieceDescription(piece: DuctPiece, plan: DuctFabricationPlan): string | null {
  if (piece.diameterMm === undefined) return null;
  if (piece.kind === 'straight') return `${plan.seamRound === 'spiral' ? 'Spiral' : 'Longitudinal-seam'} round duct${riserWord(piece)} ${Math.round(piece.lengthMm)} mm`;
  if (piece.kind === 'elbow' && piece.elbow) {
    return `${Math.round(piece.elbow.angleDeg)}° gored elbow${piece.elbow.plane === 'vertical' ? ' (vertical)' : ''}, ${piece.elbow.gores ?? '—'} pieces, R/D ${round2(piece.elbow.centrelineRadiusMm / piece.diameterMm)} (SMACNA Table 3-1)`;
  }
  if (piece.kind === 'transition') return `Round reducer (${piece.vertical ? 'concentric, riser' : 'flat bottom'}), ${Math.round(piece.lengthMm)} mm`;
  if (piece.kind === 'end-cap') return 'Round end cap';
  if (piece.kind === 'takeoff') {
    const style = piece.takeoff?.style;
    if (style === 'round-conical') return `Conical tap into round main, mouth Ø${Math.round(piece.takeoff!.openingMm ?? piece.diameterMm)} (SMACNA Fig. 3-5)`;
    if (style === 'round-tee' || style === 'round-lateral') return ROUND_TAKEOFF_DESCRIPTIONS[style];
    return style === 'conical'
      ? `Conical take-off, mouth Ø${Math.round(piece.takeoff!.openingMm ?? piece.diameterMm)} (SMACNA Fig. 2-6)`
      : 'Spin-in collar with bead (SMACNA Fig. 2-6)';
  }
  if (piece.kind === 'offset' && piece.offset) return `Round offset, ${Math.round(piece.offset.lateralOffsetMm)} mm`;
  return null;
}

/** " (riser)" / " (drop)" for a piece on a vertical leg. */
function riserWord(piece: DuctPiece): string {
  return piece.vertical && !piece.frame ? (piece.vertical > 0 ? ' (riser)' : ' (drop)') : '';
}

function pieceDescription(piece: DuctPiece, plan: DuctFabricationPlan): string {
  const shapeChange = shapeChangeDescription(piece);
  if (shapeChange) return shapeChange;
  const round = roundPieceDescription(piece, plan);
  if (round) return round;
  if (piece.kind === 'straight') return `Straight section${riserWord(piece)} ${Math.round(piece.lengthMm)} mm`;
  if (piece.kind === 'connector') return 'Flexible connector (fabric + GI edges)';
  if (piece.kind === 'flex') return `Flexible runout ${(piece.lengthMm / 1000).toFixed(2)} m`;
  if (piece.kind === 'plenum' && piece.plenum) {
    const spigots = piece.plenum.spigots.length;
    return `Plenum box ${Math.round(piece.plenum.widthMm)}×${Math.round(piece.plenum.heightMm)}×${Math.round(piece.plenum.lengthMm)}${spigots ? `, ${spigots} spigot opening${spigots === 1 ? '' : 's'}` : ''}`;
  }
  if (piece.kind === 'end-cap') return 'End cap (blank flange)';
  if (piece.kind === 'transition') return `Transition (${piece.vertical ? 'concentric, riser' : 'flat bottom'}), ${Math.round(piece.lengthMm)} mm`;
  if (piece.kind === 'offset' && piece.offset) {
    const offset = piece.offset;
    const plane = piece.frame ? ' vertical' : '';
    return offset.type === 'mitered'
      ? `Offset,${plane} mitred ${Math.round(offset.angleDeg)}° (SMACNA Type 2), ${Math.round(offset.lateralOffsetMm)} mm`
      : `Offset,${plane} ogee R${Math.round(offset.throatRadiusMm ?? 0)} throat (SMACNA Type 3), ${Math.round(offset.lateralOffsetMm)} mm`;
  }
  if (piece.kind === 'damper') return piece.damper?.description ?? 'Volume control damper, locking quadrant';
  if (piece.kind === 'takeoff') {
    return piece.takeoff && piece.takeoff.leadInMm > 0
      ? `Shoe take-off, 45° lead-in ${Math.round(piece.takeoff.leadInMm)} mm`
      : 'Straight take-off collar';
  }
  if (piece.kind === 'split') {
    const split = piece.split!;
    if (split.style === 'wye') return `Wye fitting, 45° legs 3A/2${split.cappedSides.length ? ', one leg capped' : ''} (SMACNA Fig. 3-5)`;
    return split.style === 'bullhead'
      ? `Bullhead tee, ${split.branches.reduce((total, branch) => total + branch.vaneCount, 0)} turning vanes`
      : `Divided-flow Y split (${split.branches.length} radius elbow${split.branches.length === 1 ? '' : 's'})`;
  }
  const elbow = piece.elbow!;
  const angle = Math.round(elbow.angleDeg);
  // A vertical elbow bends the easy way: its radius is on H.
  const vertical = elbow.plane === 'vertical';
  return elbow.style === 'radius'
    ? `${angle}° radius elbow${vertical ? ' (vertical, easy way)' : ''} R/${vertical ? 'H' : 'W'} ${round2(elbow.centrelineRadiusMm / (elbow.inPlaneMm ?? piece.widthMm))}`
    : `${angle}° square elbow${vertical ? ' (vertical)' : ''} with ${elbow.vaneCount} turning vanes`;
}

function increment(map: Map<string, number>, key: string, by: number): void {
  if (by <= 0) return;
  map.set(key, (map.get(key) ?? 0) + by);
}

/**
 * Supports (SMACNA chapter 4): rods by size (metres, plus the cut count),
 * trapeze angles by member and cut length, round bands, nuts and washers at
 * the bar, one soffit anchor per rod, riser angles and their screws.
 */
function supportRows(supports: readonly DuctSupportPlan[]): DuctBomRow[] {
  const rows: DuctBomRow[] = [];
  const counted = new Map<string, { quantity: number; unit: DuctBomRow['unit']; basis: string }>();
  const add = (description: string, size: string, quantity: number, unit: DuctBomRow['unit'], basis: string) => {
    if (quantity <= 0) return;
    const key = `${description}|${size}`;
    const entry = counted.get(key) ?? { quantity: 0, unit, basis };
    entry.quantity += quantity;
    counted.set(key, entry);
  };
  for (const plan of supports) {
    for (const hanger of plan.hangers) {
      if (hanger.kind === 'strap') {
        // The saddle width and quantity agree with the current flex support plan.
        add(`Flex duct strap ${FLEX_RULES.minStrapWidthMm} mm`, `Ø${Math.round(hanger.outerWidthMm)}`, 1, 'no.', 'ASHRAE 2024 ch. 19 / ADC: support width ≥ 1.5 in and horizontal spacing ≤ 4 ft');
        add(`Hanger wire Ø${FLEX_HANGER_WIRE_DIAMETER_MM} mm, galvanised`, '—', hanger.rods.reduce((total, piece) => total + piece.lengthMm, 0) / 1000, 'm', 'project practice');
        add('Soffit anchor (wire)', '—', 1, 'no.', 'project practice');
        continue;
      }
      const rod = hanger.rod?.label ?? 'special';
      for (const piece of hanger.rods) {
        add(`Threaded rod ${rod}, galvanised`, rod, piece.lengthMm / 1000, 'm', 'rods by load at SMACNA stress (derived metric)');
        add(`Threaded rod ${rod}, cut lengths`, `${Math.ceil(piece.lengthMm / 50) * 50} mm`, 1, 'no.', 'rod to the soffit');
        add(`Soffit anchor ${rod}`, rod, 1, 'no.', 'one per rod (upper attachment, S4.1: ≤ ¼ of proof load)');
      }
      if (hanger.bar) {
        add(`Trapeze angle ${hanger.bar.member.label}`, `${Math.ceil(hanger.bar.lengthMm / 10) * 10} mm`, 1, 'no.', `SMACNA Table 4-3M (${hanger.bar.allowableKg} kg at ${Math.round(hanger.bar.spanMm)} mm)`);
        add(`Nut ${rod} (above and below the bar)`, rod, 2 * hanger.rods.length, 'no.', 'project practice');
        add(`Washer ${rod}`, rod, 2 * hanger.rods.length, 'no.', 'project practice');
      } else if (hanger.kind === 'band') {
        add('Hanger band 25.4×0.85 with bolt', `Ø${Math.round(hanger.outerWidthMm)}`, 1, 'no.', 'SMACNA Table 4-2');
        add(`Nut ${rod} (band)`, rod, 2, 'no.', 'project practice');
      }
      if (hanger.insert) add('Load-bearing insulation insert (under the bar)', `${Math.round(hanger.outerWidthMm)} mm`, 1, 'no.', 'insulation stays continuous at supports');
    }
    for (const wires of plan.terminalWires) {
      add(`Terminal hanger wire Ø${FLEX_HANGER_WIRE_DIAMETER_MM} mm, galvanised`, '—', (wires.count * wires.lengthMm) / 1000, 'm', 'SMACNA S3.40 (terminal hung on its own)');
      add('Soffit anchor (wire)', '—', wires.count, 'no.', 'project practice');
    }
    for (const riser of plan.risers) {
      add(`Riser support angle ${riser.member}`, `${Math.ceil(riser.lengthMm / 10) * 10} mm`, 2, 'no.', 'SMACNA §4.2.10 (member: project practice)');
      add('Screw: self-drilling sheet-metal screw (riser angles)', '—', 8, 'no.', 'project practice');
    }
  }
  for (const [key, entry] of [...counted].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    const [description, size] = key.split('|') as [string, string];
    rows.push({ category: 'Supports', description, size, quantity: entry.unit === 'm' ? round2(entry.quantity) : Math.round(entry.quantity), unit: entry.unit, basis: entry.basis });
  }
  return rows;
}

/**
 * The air terminals the runs serve, and each flexible runout: its length by
 * form and diameter, the draw bands on the core and the jacket at both ends
 * (S3.33 / S3.34), or the screws of a metallic form (S3.32: ≥ 3, ≥ 5 over Ø305).
 */
function terminalAndFlexRows(plans: readonly DuctFabricationPlan[], terminals: readonly HvacElement[]): DuctBomRow[] {
  const rows: DuctBomRow[] = [];
  const served = new Set(plans.flatMap((plan) => (plan.spec.end.kind === 'terminal' ? [plan.spec.end.terminalId] : [])));
  const byKind = new Map<string, number>();
  const filters = new Map<string, number>();
  for (const terminal of terminals) {
    if (!served.has(terminal.id)) continue;
    const spec = readDuctTerminalSpec(terminal);
    if (!spec) continue;
    const face = `${Math.round(spec.faceWidthMm)}${spec.kind === 'round' ? '' : `×${Math.round(spec.faceDepthMm)}`}`;
    const key = `${terminalLabel(spec)} ${face}, ${spec.mount}, with plenum box ${Math.round(spec.plenumWidthMm)}×${Math.round(spec.plenumDepthMm)}×${Math.round(spec.plenumHeightMm)}|Ø${Math.round(spec.neckDiameterMm)} side spigot`;
    byKind.set(key, (byKind.get(key) ?? 0) + 1);
    if (spec.filter) {
      const filter = TERMINAL_FILTER_LABELS[spec.filter];
      const filterKey = `Filter panel ${filter.label} (${filter.equivalent}), behind a hinged face|${face}×${TERMINAL_FILTER_THICKNESS_MM}`;
      filters.set(filterKey, (filters.get(filterKey) ?? 0) + 1);
    }
  }
  for (const [key, count] of [...byKind].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [description, size] = key.split('|') as [string, string];
    rows.push({ category: 'Air terminals', description, size, quantity: count, unit: 'no.', basis: 'typical catalog size (practice)' });
  }
  for (const [key, count] of [...filters].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [description, size] = key.split('|') as [string, string];
    rows.push({ category: 'Air terminals', description, size, quantity: count, unit: 'no.', basis: 'one panel per filter grille; spare sets by the maintenance contract (practice)' });
  }
  const flex = new Map<string, { quantity: number; unit: DuctBomRow['unit']; basis: string }>();
  const add = (description: string, size: string, quantity: number, unit: DuctBomRow['unit'], basis: string) => {
    const key = `${description}|${size}`;
    const entry = flex.get(key) ?? { quantity: 0, unit, basis };
    entry.quantity += quantity;
    flex.set(key, entry);
  };
  const FORM: Record<string, string> = { 'nm-il': 'non-metallic, insulated (NM-IL)', 'nm-un': 'non-metallic (NM-UN)', 'm-un': 'metallic (M-UN)' };
  for (const plan of plans) {
    for (const piece of plan.pieces) {
      if (piece.kind !== 'flex' || !piece.flex) continue;
      const diameter = Math.round(piece.widthMm);
      add(`Flexible duct, ${FORM[piece.flex.type]}`, `Ø${diameter}`, piece.lengthMm / 1000, 'm', 'SMACNA §3.5–3.7; runout length along its curve');
      if (piece.flex.type === 'm-un') {
        add('Screw #8, sheet-metal (flex ends)', '—', 2 * (diameter > 305 ? 5 : 3), 'no.', 'SMACNA S3.32');
      } else {
        add('Draw band (flex core)', `Ø${diameter}`, 2, 'no.', 'SMACNA S3.33');
        if (piece.flex.jacketMm > 0) add('Draw band (flex jacket)', `Ø${Math.round(diameter + 2 * piece.flex.jacketMm)}`, 2, 'no.', 'SMACNA S3.34');
      }
      add('Duct sealant / foil tape at flex collars', '—', 2, 'no.', 'SMACNA S3.28 (per connection)');
    }
  }
  for (const [key, entry] of [...flex].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    const [description, size] = key.split('|') as [string, string];
    rows.push({ category: 'Flexible duct', description, size, quantity: entry.unit === 'm' ? round2(entry.quantity) : Math.round(entry.quantity), unit: entry.unit, basis: entry.basis });
  }
  return rows;
}

export function buildDuctBom(
  plans: readonly DuctFabricationPlan[],
  supports: readonly DuctSupportPlan[] = [],
  terminals: readonly HvacElement[] = [],
): DuctBomRow[] {
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
      increment(pieces, `${pieceDescription(piece, plan)}|${sizeLabel(piece)}|${piece.sheetThicknessMm ?? '-'}`, 1);
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

  // Longitudinal seams (SMACNA Fig. 1-5), by seam type.
  const seamLength = good.reduce((total, plan) => total + plan.pieces.reduce((sum, piece) => sum + (piece.seamLengthMm ?? 0), 0), 0);
  if (seamLength > 0) {
    const seamType = good[0]!.seamType;
    rows.push({
      category: 'Fabricated pieces',
      description: seamType === 'snaplock' ? 'Longitudinal seam, button-punch snaplock (L-2)' : 'Longitudinal seam, Pittsburgh lock (L-1)',
      size: '—', quantity: round2(seamLength / 1000), unit: 'm', basis: 'SMACNA Fig. 1-5; seams per section by coil width',
    });
  }

  // Turning vanes and runners (SMACNA Fig. 2-3 / 2-4): vanes span the height, runners run the diagonal.
  const accessories = new Map<string, number>();
  const addVanes = (vanes: { spec: DuctVaneSpec; lengthMm: number; sections: number }, count: number, inPlaneWidthMm: number) => {
    const piece = Math.round(vanes.lengthMm / vanes.sections);
    increment(accessories, `Turning vane, ${vanes.spec.label}|${piece} mm long`, count * vanes.sections);
    increment(accessories, `Vane runner ${VANE_RUNNER.thicknessMm} mm, ${VANE_RUNNER.minWidthMm} mm min|${Math.round(inPlaneWidthMm * Math.SQRT2)} mm long`, vanes.sections + 1);
  };
  for (const plan of good) {
    for (const piece of plan.pieces) {
      if (piece.elbow?.vanes) addVanes(piece.elbow.vanes, piece.elbow.vaneCount, piece.elbow.inPlaneMm ?? piece.widthMm);
      for (const branch of piece.split?.branches ?? []) {
        if (branch.vanes) addVanes(branch.vanes, branch.vaneCount, branch.section.widthMm);
      }
    }
  }
  for (const [key, count] of [...accessories].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [description, size] = key.split('|') as [string, string];
    rows.push({ category: 'Accessories', description, size, quantity: count, unit: 'no.', basis: 'SMACNA Fig. 2-3 / 2-4' });
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
      const category = joint.kind === 'unit-connection' || joint.kind === 'tap-connection' ? 'Connections' : 'Joints';
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
      if (h.sleeves) add(`${category}|RT-1 beaded sleeve coupling|—`, h.sleeves, 'no.', 'SMACNA Fig. 3-2');
      if (h.sealantLengthMm) add(`${category}|Duct sealant (round joints and collars)|—`, h.sealantLengthMm / 1000, 'm', 'SMACNA Fig. 3-2 / seal class');
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
  // NBR insulation (mid-plane takeoff with flange bands), by thickness.
  const insulation = new Map<number, { area: number; withWaste: number; adhesive: number; tape: number }>();
  for (const plan of good) {
    if (!plan.insulation) continue;
    const entry = insulation.get(plan.insulation.thicknessMm) ?? { area: 0, withWaste: 0, adhesive: 0, tape: 0 };
    entry.area += plan.insulation.areaM2;
    entry.withWaste += plan.insulation.areaWithWasteM2;
    entry.adhesive += plan.insulation.adhesiveL;
    entry.tape += plan.insulation.tapeM;
    insulation.set(plan.insulation.thicknessMm, entry);
  }
  for (const [thickness, entry] of [...insulation].sort((a, b) => a[0] - b[0])) {
    const size = `${Math.round(thickness)} mm`;
    rows.push({ category: 'Insulation', description: 'NBR (elastomeric) sheet, incl. waste', size, quantity: round2(entry.withWaste), unit: 'm²', basis: `mid-plane area ${round2(entry.area)} m² incl. flange bands + waste (practice)` });
    rows.push({ category: 'Insulation', description: 'Contact adhesive (ArmaFlex 520 type)', size, quantity: round2(entry.adhesive), unit: 'L', basis: 'both faces glued, Armacell 520 coverage' });
    rows.push({ category: 'Insulation', description: 'NBR tape 50 mm (seams and flange bands)', size, quantity: round2(entry.tape), unit: 'm', basis: 'project practice' });
  }
  rows.push(...terminalAndFlexRows(good, terminals));
  // Supports of the runs that are fabricated.
  const fabricated = new Set(good.map((plan) => plan.elementId));
  rows.push(...supportRows(supports.filter((plan) => fabricated.has(plan.elementId))));
  return rows;
}

export function buildDuctFabricationSchedule(plans: readonly DuctFabricationPlan[]): DuctScheduleRow[] {
  return plans.flatMap((plan) => plan.pieces.map((piece): DuctScheduleRow => {
    const construction = plan.constructionByLeg[piece.legIndex];
    return {
      run: plan.elementId,
      mark: piece.mark,
      kind: pieceDescription(piece, plan),
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
