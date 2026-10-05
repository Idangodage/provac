/**
 * External NBR (elastomeric) insulation on GI duct ("gi-nbr" construction):
 * the thickness a run carries and its takeoff, read from the fabrication plan.
 *
 *  - Thickness: the run's own, else the project's default by service (typical
 *    specifications: 25 mm on supply, 19 mm on return in conditioned voids).
 *  - Area at the insulation mid-plane (the sheet is cut to it): the outside
 *    girth plus 4·t (rectangular) or π·(D + t) (round), times each piece's
 *    developed centreline length; end caps by face. Each flange is boxed with
 *    a band 2 × its projection + 100 mm wide. The flexible connector is left
 *    free so it can flex. Waste on top (practice).
 *  - Adhesive at the datasheet coverage for both faces (Armacell 520: 7–9 m²/L).
 *  - Tape (practice): the insulation's longitudinal seams (one per 1 m of
 *    girth) and both edges of every flange band.
 *
 * Cross-breaking is not required on externally insulated duct (SMACNA S1.15;
 * the gauge resolver drops it for any construction but bare GI).
 */
import type { DuctFabricationPlan, DuctJoint, DuctPiece } from './ductFabricationPlanner';
import type { JointHardware } from './ductJoints';
import type { DuctDesignSettings } from './ductSettings';
import type { DuctRunSpec } from './ductTypes';

export interface DuctInsulationTakeoff {
  thicknessMm: number;
  /** Sheet at the mid-plane, flange bands included (m²), and with the waste allowance. */
  areaM2: number;
  areaWithWasteM2: number;
  adhesiveL: number;
  tapeM: number;
  flangeBands: number;
}

/** Insulation sheet width the longitudinal seams are counted by (mm). Practice. */
const SHEET_WIDTH_MM = 1000;

export function ductInsulationThicknessMm(
  spec: Pick<DuctRunSpec, 'construction' | 'insulationThicknessMm' | 'service'>,
  settings: Pick<DuctDesignSettings, 'nbrSupplyThicknessMm' | 'nbrReturnThicknessMm'>,
): number {
  if (spec.construction !== 'gi-nbr') return 0;
  if (spec.insulationThicknessMm > 0) return spec.insulationThicknessMm;
  return spec.service === 'return' ? settings.nbrReturnThicknessMm : settings.nbrSupplyThicknessMm;
}

/** How far a joint's flange stands out of the sheet (mm), as drawn in 3D. */
export function flangeProjectionMm(hardware: JointHardware | null): number {
  if (!hardware) return 0;
  if (hardware.system === 'angle-flange' && hardware.angleMember) return hardware.angleMember.legMm;
  if (hardware.system === 'ductmate') return hardware.label.includes('45') ? 45 : hardware.label.includes('35') ? 35 : 25;
  if (hardware.system === 'tdc') return 30;
  return 0;
}

/** Outside sheet size of a piece, averaged over a transition. */
function outside(piece: DuctPiece): { w: number; h: number; round: boolean } {
  const t = piece.sheetThicknessMm ?? 1;
  if (piece.diameterMm !== undefined) {
    const d = (piece.diameterMm + (piece.endDiameterMm ?? piece.diameterMm)) / 2 + 2 * t;
    return { w: d, h: d, round: true };
  }
  return { w: (piece.widthMm + piece.endWidthMm) / 2 + 2 * t, h: (piece.heightMm + piece.endHeightMm) / 2 + 2 * t, round: false };
}

function midGirth(size: { w: number; h: number; round: boolean }, thicknessMm: number): number {
  return size.round ? Math.PI * (size.w + thicknessMm) : 2 * (size.w + size.h) + 4 * thicknessMm;
}

export function insulationTakeoff(
  plan: Pick<DuctFabricationPlan, 'pieces' | 'joints'>,
  thicknessMm: number,
  settings: Pick<DuctDesignSettings, 'nbrAdhesiveM2PerL' | 'nbrWastePercent'>,
): DuctInsulationTakeoff {
  let areaMm2 = 0;
  let tapeMm = 0;
  for (const piece of plan.pieces) {
    // The connector must flex; a runout has its own jacket; a fire damper's sleeve is fire-stopped bare.
    if (piece.kind === 'connector' || piece.kind === 'flex' || piece.kind === 'fire-damper') continue;
    const size = outside(piece);
    const girth = midGirth(size, thicknessMm);
    if (piece.kind === 'end-cap') {
      areaMm2 += size.round ? (Math.PI * (size.w + 2 * thicknessMm) ** 2) / 4 : (size.w + 2 * thicknessMm) * (size.h + 2 * thicknessMm);
      continue;
    }
    const length = piece.kind === 'split' ? (piece.split?.depthMm ?? 0) : piece.lengthMm;
    areaMm2 += girth * length;
    // A plenum box is closed: its far face and the back face round the inlet are covered too.
    if (piece.kind === 'plenum') areaMm2 += 2 * (size.w + 2 * thicknessMm) * (size.h + 2 * thicknessMm);
    tapeMm += Math.ceil(girth / SHEET_WIDTH_MM) * length;
  }
  let flangeBands = 0;
  for (const joint of plan.joints) {
    if (joint.kind !== 'flange') continue;
    const projection = flangeProjectionMm(joint.hardware);
    if (projection <= 0) continue;
    flangeBands += 1;
    const girth = bandGirth(joint, projection, thicknessMm);
    areaMm2 += girth * (2 * projection + 100);
    tapeMm += 2 * girth;
  }
  const areaM2 = areaMm2 / 1e6;
  return {
    thicknessMm,
    areaM2,
    areaWithWasteM2: areaM2 * (1 + settings.nbrWastePercent / 100),
    adhesiveL: areaM2 / settings.nbrAdhesiveM2PerL,
    tapeM: tapeMm / 1000,
    flangeBands,
  };
}

function bandGirth(joint: DuctJoint, projectionMm: number, thicknessMm: number): number {
  return joint.hardware?.system === 'round-slip'
    ? Math.PI * (joint.outerWidthMm + 2 * projectionMm + thicknessMm)
    : 2 * (joint.outerWidthMm + joint.outerHeightMm) + 8 * projectionMm + 4 * thicknessMm;
}
