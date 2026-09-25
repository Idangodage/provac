/**
 * Hardware for one transverse joint (two duct ends), per joint system.
 * Side lengths are the outside sheet dimensions the flanges wrap.
 *
 *  - TDC / TDF (T-25a/b): integral roll-formed flanges; 4 corner pieces per
 *    end, one bolt per corner pair, gasket, 152 mm cleats per the T-24 note
 *    (cleat spacing for TDC is unverified — Fig. 1-15 not read).
 *  - Ductmate (T-24 type, proprietary): slip-on flange pieces fastened to the
 *    duct per the manufacturer's screw schedule, cleats at 610 mm.
 *  - Companion angle (T-22): two welded angle frames, M8 bolts at ≤152 mm,
 *    angle-to-duct rivets at ≤305 mm including the corners.
 *  - Slip-over onto a unit collar: sheet-metal screws within 51 mm of the
 *    corners and at ≤305 mm (S1.40 by analogy, unverified).
 */
import { JOINT_HARDWARE_PROVENANCE, JOINT_HARDWARE_RULES, type JointRigidityRow } from './ductCatalog';
import type { ResolvedDuctJoint } from './ductGauge';
import type { DuctRuleProvenance } from './ductSources';

export type JointHardwareSystem = 'tdc' | 'ductmate' | 'angle-flange' | 'slip-over';

export interface JointHardware {
  system: JointHardwareSystem;
  label: string;
  /** Separate flange profile pieces (Ductmate); 0 for integral flanges. */
  flangePieces: number;
  /** Total flange run at the joint, both ends (mm). */
  flangeLengthMm: number;
  angleMember: NonNullable<JointRigidityRow['companionAngle']> | null;
  /** Total angle stock for both frames, mitred (mm). */
  angleLengthMm: number;
  cornerPieces: number;
  bolts: { size: 'M8' | 'M10'; lengthMm: number; count: number } | null;
  nuts: number;
  washers: number;
  cleats: { lengthMm: number; count: number } | null;
  ductFasteners: { kind: 'rivet' | 'screw'; spec: string; count: number } | null;
  gasketLengthMm: number;
  sealedCorners: number;
  cornerWelds: number;
  provenance: DuctRuleProvenance[];
}

export interface JointHardwareInput {
  /** Outside sheet dimensions at the joint (mm). */
  sideAMm: number;
  sideBMm: number;
  pressureClassPa: number;
  washersPerBolt: number;
}

function perimeter(input: JointHardwareInput): number {
  return 2 * (input.sideAMm + input.sideBMm);
}

function sides(input: JointHardwareInput): number[] {
  return [input.sideAMm, input.sideBMm, input.sideAMm, input.sideBMm];
}

/** T-24 clips: within 152 mm of each corner, then at ≤ spacing (per side). */
export function formedFlangeCleatsPerSide(sideMm: number, spacingMm: number): number {
  const corner = 2 * JOINT_HARDWARE_RULES.cleatFromCornerMm;
  if (sideMm <= corner) return 1;
  return 2 + Math.max(0, Math.ceil((sideMm - corner) / spacingMm) - 1);
}

/** Ductmate screws per side, ≤4″ w.g.: each corner, + centre (25–48″), + every 24″ (≥49″). */
export function ductmateScrewsPerSide(sideMm: number): number {
  if (sideMm <= 610) return 2;
  return 2 + Math.max(1, Math.floor(sideMm / 610));
}

/** Fasteners per side at ≤ spacing with one at each corner; corners shared between sides. */
function sharedCornerFasteners(sideMm: number, spacingMm: number): number {
  return Math.ceil(sideMm / spacingMm);
}

export function jointHardware(joint: ResolvedDuctJoint, input: JointHardwareInput): JointHardware {
  const p = perimeter(input);
  const bolts4 = (size: 'M8' | 'M10') => ({ size, lengthMm: 25, count: 4 });
  if (joint.system === 'tdc') {
    const spacing = input.pressureClassPa <= 750 ? JOINT_HARDWARE_RULES.cleatSpacingLowMm : JOINT_HARDWARE_RULES.cleatSpacingHighMm;
    const cleats = sides(input).reduce((total, side) => total + formedFlangeCleatsPerSide(side, spacing), 0);
    return {
      system: 'tdc', label: 'TDC flange',
      flangePieces: 0, flangeLengthMm: 2 * p, angleMember: null, angleLengthMm: 0,
      cornerPieces: 8, bolts: bolts4('M10'), nuts: 4, washers: 4 * input.washersPerBolt,
      cleats: { lengthMm: JOINT_HARDWARE_RULES.cleatLengthMm, count: cleats },
      ductFasteners: null, gasketLengthMm: p, sealedCorners: 8, cornerWelds: 0,
      provenance: [JOINT_HARDWARE_PROVENANCE.formedFlange!, JOINT_HARDWARE_PROVENANCE.tdcCleats!],
    };
  }
  if (joint.system === 'ductmate') {
    const cleats = sides(input).reduce((total, side) => total + Math.max(1, Math.ceil(side / JOINT_HARDWARE_RULES.ductmateCleatSpacingMm)), 0);
    const screwsPerEnd = sides(input).reduce((total, side) => total + ductmateScrewsPerSide(side), 0);
    return {
      system: 'ductmate', label: `Ductmate ${joint.series.slice(2)}`,
      flangePieces: 8, flangeLengthMm: 2 * p, angleMember: null, angleLengthMm: 0,
      cornerPieces: 8, bolts: bolts4('M10'), nuts: 4, washers: 4 * input.washersPerBolt,
      cleats: { lengthMm: JOINT_HARDWARE_RULES.cleatLengthMm, count: cleats },
      ductFasteners: { kind: 'screw', spec: 'self-drilling sheet-metal screw (or spot weld)', count: 2 * screwsPerEnd },
      gasketLengthMm: p, sealedCorners: 8, cornerWelds: 0,
      provenance: [JOINT_HARDWARE_PROVENANCE.ductmate!],
    };
  }
  if (joint.system === 'angle-flange') {
    const leg = joint.member.legMm;
    const bolts = sides(input).reduce((total, side) => total + sharedCornerFasteners(side, JOINT_HARDWARE_RULES.companionAngleBoltSpacingMm), 0);
    const rivetsPerEnd = sides(input).reduce((total, side) => total + sharedCornerFasteners(side, JOINT_HARDWARE_RULES.companionAngleFastenerSpacingMm), 0);
    return {
      system: 'angle-flange', label: `Angle flange L${leg}×${joint.member.thicknessMm}`,
      flangePieces: 0, flangeLengthMm: 2 * p, angleMember: joint.member,
      angleLengthMm: 2 * (p + 8 * leg),
      cornerPieces: 0,
      bolts: { size: 'M8', lengthMm: 25, count: bolts }, nuts: bolts, washers: bolts * input.washersPerBolt,
      cleats: null,
      ductFasteners: { kind: 'rivet', spec: 'closed-end blind rivet 4.8 mm (no open mandrel hole, S1.41)', count: 2 * rivetsPerEnd },
      gasketLengthMm: p, sealedCorners: 8, cornerWelds: 8,
      provenance: [JOINT_HARDWARE_PROVENANCE.companionAngle!],
    };
  }
  throw new Error('unknown joint system');
}

/** Duct (or connector) slipped over a unit collar and screwed. */
export function slipOverHardware(input: JointHardwareInput): JointHardware {
  const screws = sides(input).reduce((total, side) => {
    const span = Math.max(0, side - 2 * JOINT_HARDWARE_RULES.fastenerFromCornerMm);
    return total + Math.ceil(span / JOINT_HARDWARE_RULES.fastenerSpacingMm) + 1;
  }, 0);
  return {
    system: 'slip-over', label: 'Slip-over on unit collar',
    flangePieces: 0, flangeLengthMm: 0, angleMember: null, angleLengthMm: 0,
    cornerPieces: 0, bolts: null, nuts: 0, washers: 0, cleats: null,
    ductFasteners: { kind: 'screw', spec: 'self-drilling sheet-metal screw', count: screws },
    gasketLengthMm: 0, sealedCorners: 4, cornerWelds: 0,
    provenance: [JOINT_HARDWARE_PROVENANCE.slipOver!],
  };
}
