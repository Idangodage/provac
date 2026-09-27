/**
 * Fitting rules read from the SMACNA 1995 figures (the scanned 2nd edition,
 * pages cited per value). These were image-only in the text version; each is
 * transcribed in docs/hvac-duct-smacna-research.md ("Figures").
 */
import type { DuctRuleProvenance } from './ductSources';

const smacna = (reference: string, note?: string): DuctRuleProvenance => ({ sourceId: 'smacna-1995', reference, verified: true, ...(note ? { note } : {}) });

// ---- Elbows: Fig. 2-2 (p.2.3–2.4) ----

export const ELBOW_RULES = {
  /** RE1: "centerline R = 3W/2 unless otherwise specified". */
  defaultCentrelineRatio: 1.5,
  /** RE1: square throat R/W = 0.5 may be used up to 1000 fpm (5 m/s). */
  squareThroatRatio: 0.5,
  squareThroatMaxVelocityMs: 5,
  /** RE7–RE9: all 45° throats are 100 mm minimum. */
  min45ThroatMm: 100,
  provenance: smacna('Fig. 2-2, p.2.3–2.4'),
} as const;

// ---- Turning vanes: Fig. 2-3 (p.2.5) and vane support Fig. 2-4 (p.2.6) ----

export type DuctVaneType = 'single-small' | 'single-large' | 'double-small' | 'double-large';

export interface DuctVaneSpec {
  type: DuctVaneType;
  label: string;
  /** Vane radius (mm). */
  radiusMm: number;
  /** Pitch along the runner (mm). */
  spacingMm: number;
  /** Minimum vane sheet (mm). */
  thicknessMm: number;
  /** Maximum unsupported vane length (mm), Fig. 2-4. */
  maxUnsupportedMm: number;
}

export const DUCT_VANES: Record<DuctVaneType, DuctVaneSpec> = {
  'single-small': { type: 'single-small', label: 'single-wall small (R51 @ 38, 0.70 mm)', radiusMm: 51, spacingMm: 38, thicknessMm: 0.7, maxUnsupportedMm: 914 },
  'single-large': { type: 'single-large', label: 'single-wall large (R114 @ 83, 0.85 mm)', radiusMm: 114, spacingMm: 83, thicknessMm: 0.85, maxUnsupportedMm: 914 },
  'double-small': { type: 'double-small', label: 'double-wall small (R51 @ 54, 0.55 mm)', radiusMm: 51, spacingMm: 54, thicknessMm: 0.55, maxUnsupportedMm: 1219 },
  'double-large': { type: 'double-large', label: 'double-wall large (R114 @ 83, 0.70 mm)', radiusMm: 114, spacingMm: 83, thicknessMm: 0.7, maxUnsupportedMm: 1829 },
};

/** Runner: 38 mm minimum; runner type 1 is 0.85 mm (22 ga). Fig. 2-3. */
export const VANE_RUNNER = { minWidthMm: 38, thicknessMm: 0.85 } as const;
export const VANE_PROVENANCE = smacna('Fig. 2-3 (p.2.5), Fig. 2-4 (p.2.6)');

/**
 * `auto` picks the lightest vane whose unsupported length covers the duct
 * height (vanes span the height); beyond the longest, vanes go in sections.
 * The choice is project practice; the schedule itself is SMACNA.
 */
export function resolveVaneType(setting: DuctVaneType | 'auto', vaneLengthMm: number): DuctVaneSpec {
  if (setting !== 'auto') return DUCT_VANES[setting];
  if (vaneLengthMm <= DUCT_VANES['single-small'].maxUnsupportedMm) return DUCT_VANES['single-small'];
  if (vaneLengthMm <= DUCT_VANES['double-small'].maxUnsupportedMm) return DUCT_VANES['double-small'];
  return DUCT_VANES['double-large'];
}

/** Vanes sit on the runner, which runs along the elbow diagonal (W·√2 for a 90° elbow of one width). */
export function vaneCountOnDiagonal(inPlaneWidthMm: number, spec: DuctVaneSpec): number {
  const runner = inPlaneWidthMm * Math.SQRT2;
  return Math.max(1, Math.ceil(runner / spec.spacingMm) - 1);
}

/** Vane sections over the height: "install vanes in sections or use tie rods" beyond the unsupported length. */
export function vaneSectionsFor(vaneLengthMm: number, spec: DuctVaneSpec): number {
  return Math.max(1, Math.ceil(vaneLengthMm / spec.maxUnsupportedMm - 1e-9));
}

// ---- Divided flow: Fig. 2-5 (p.2.7) ----

export const DIVIDED_FLOW = {
  /** Type 4A/4B: branch width and D2/D3 102 mm minimum. */
  minBranchMm: 102,
  /** "Volume control should be by branch dampers." */
  branchDampers: true,
  provenance: smacna('Fig. 2-5, p.2.7'),
} as const;

// ---- Branch connections: Fig. 2-6 (p.2.8) ----

export const SHOE_LEAD_IN = {
  /** 45° entry: L = W/4, 4″ (102 mm) minimum. */
  ratio: 0.25,
  minMm: 102,
  provenance: smacna('Fig. 2-6, p.2.8', '45 degree entry; straight tap by butt flange or clinch lock; no scoops.'),
} as const;

export function shoeLeadInMm(branchWidthMm: number): number {
  return Math.max(branchWidthMm * SHOE_LEAD_IN.ratio, SHOE_LEAD_IN.minMm);
}

// ---- Offsets and transitions: Fig. 2-7 (p.2.9) ----

export const TRANSITION_LIMITS = {
  /** Concentric: θ (included) max 45° diverging, 60° converging. */
  concentricDivergingIncludedDeg: 45,
  concentricConvergingIncludedDeg: 60,
  /** Eccentric: θ max 30° (45° only round to flat oval). */
  eccentricMaxDeg: 30,
  provenance: smacna('Fig. 2-7, p.2.9'),
} as const;

export const OFFSET_LIMITS = {
  /** Type 1 angled: 15° max. */
  angledMaxDeg: 15,
  /** Type 2 mitered: 60° max. */
  miteredMaxDeg: 60,
  /** Type 3 radiussed (ogee): 150 mm throat radius minimum. */
  ogeeMinThroatRadiusMm: 150,
  provenance: smacna('Fig. 2-7, p.2.9'),
} as const;

// ---- Volume dampers: Fig. 2-12 (p.2.16), Fig. 2-13 (p.2.17) ----

export interface DuctDamperLayout {
  kind: 'single-blade' | 'opposed-multiblade' | 'round';
  /** Assemblies side by side (multi-blade frames are 1219 mm wide at most). */
  frames: number;
  /** Blades per frame. */
  blades: number;
  bladeThicknessMm: number;
  /** Pin / shaft / rod diameter (mm). */
  shaftMm: number;
  /** Continuous rod across the duct. */
  continuousRod: boolean;
  /** Quadrant size (mm). */
  quadrantMm: number;
  /** Multi-blade channel frame (mm), else null. */
  frameChannelMm: number | null;
  /** Blade chord (along the flow when open) (mm). */
  bladeChordMm: number;
  description: string;
}

export const DAMPER_RULES = {
  singleBladeMaxHeightMm: 305,
  /** Fig. A: up to 457 wide, 0.85 blade, 10 mm pin and quadrant. */
  smallMaxWidthMm: 457,
  smallBladeMm: 0.85,
  smallPinMm: 10,
  /** Fig. B: 483–1219 wide, 1.31 blade, 13 mm continuous rod and quadrant. */
  largeMaxWidthMm: 1219,
  largeBladeMm: 1.31,
  largeRodMm: 13,
  /** Fig. 2-13: 1.31 blades 152–229 wide, 51 mm channel frame, 1219 max frame width. */
  multiBladeMm: 1.31,
  multiBladeMaxChordMm: 229,
  multiBladeMinChordMm: 152,
  multiFrameChannelMm: 51,
  multiFrameMaxWidthMm: 1219,
  multiShaftMm: 12.7,
  /** Fig. C round: blade ≥ 0.70 and two gauges heavier than the duct; rod continuous at 500 Pa or over 305 Ø. */
  roundMinBladeMm: 0.7,
  roundRodOverDiameterMm: 305,
  provenance: smacna('Fig. 2-12 (p.2.16), Fig. 2-13 (p.2.17)'),
} as const;

/** Next heavier SMACNA nominals, for "two gauges more than the duct". */
const NOMINAL_LADDER_MM = [0.48, 0.55, 0.7, 0.85, 1.0, 1.31, 1.61, 2.01] as const;

export function twoGaugesHeavier(thicknessMm: number): number {
  const index = NOMINAL_LADDER_MM.findIndex((nominal) => nominal >= thicknessMm - 1e-6);
  const base = index < 0 ? NOMINAL_LADDER_MM.length - 1 : index;
  return NOMINAL_LADDER_MM[Math.min(NOMINAL_LADDER_MM.length - 1, base + 2)]!;
}

export function rectangularDamperLayout(widthMm: number, heightMm: number): DuctDamperLayout {
  const r = DAMPER_RULES;
  if (heightMm <= r.singleBladeMaxHeightMm && widthMm <= r.largeMaxWidthMm) {
    const small = widthMm <= r.smallMaxWidthMm;
    return {
      kind: 'single-blade', frames: 1, blades: 1,
      bladeThicknessMm: small ? r.smallBladeMm : r.largeBladeMm,
      shaftMm: small ? r.smallPinMm : r.largeRodMm,
      continuousRod: !small,
      quadrantMm: small ? r.smallPinMm : r.largeRodMm,
      frameChannelMm: null,
      bladeChordMm: heightMm,
      description: small
        ? `Single-blade VCD, ${r.smallBladeMm} mm blade, ${r.smallPinMm} mm pins, locking quadrant`
        : `Single-blade VCD, ${r.largeBladeMm} mm blade, ${r.largeRodMm} mm continuous rod, locking quadrant`,
    };
  }
  const frames = Math.max(1, Math.ceil(widthMm / r.multiFrameMaxWidthMm));
  const blades = Math.max(2, Math.ceil(heightMm / r.multiBladeMaxChordMm));
  const chord = heightMm / blades;
  return {
    kind: 'opposed-multiblade', frames, blades,
    bladeThicknessMm: r.multiBladeMm,
    shaftMm: r.multiShaftMm,
    continuousRod: false,
    quadrantMm: r.largeRodMm,
    frameChannelMm: r.multiFrameChannelMm,
    bladeChordMm: chord,
    description: `Opposed multi-blade VCD, ${blades} × ${r.multiBladeMm} mm blades${frames > 1 ? ` in ${frames} frames` : ''}, ${r.multiFrameChannelMm} mm channel frame`,
  };
}

export function roundDamperLayout(diameterMm: number, ductThicknessMm: number, pressureClassPa: number): DuctDamperLayout {
  const r = DAMPER_RULES;
  const blade = Math.max(r.roundMinBladeMm, twoGaugesHeavier(ductThicknessMm));
  const continuousRod = pressureClassPa >= 500 || diameterMm > r.roundRodOverDiameterMm;
  return {
    kind: 'round', frames: 1, blades: 1, bladeThicknessMm: blade,
    shaftMm: continuousRod ? r.largeRodMm : r.smallPinMm,
    continuousRod,
    quadrantMm: continuousRod ? r.largeRodMm : r.smallPinMm,
    frameChannelMm: null,
    bladeChordMm: diameterMm,
    description: `Round VCD Ø${Math.round(diameterMm)}, ${blade} mm blade${continuousRod ? ', continuous rod' : ''}, locking quadrant`,
  };
}

// ---- Longitudinal seams: Fig. 1-5 notes (p.1.66–1.67) ----

export type DuctSeamType = 'pittsburgh' | 'snaplock';

export const SEAM_RULES = {
  /** L-1 Pittsburgh: pocket 6.4–16 mm, typically 8–9.5 mm. */
  pittsburghPocketMm: 9.5,
  /** L-2 snaplock: 12.7 mm pocket for 0.55–0.70 mm, 16 mm for 0.70–1.00 mm; allowed to 1000 Pa. */
  snaplockPocketSmallMm: 12.7,
  snaplockPocketLargeMm: 16,
  snaplockMaxPressurePa: 1000,
  provenance: smacna('Fig. 1-5 notes', 'Pockets per SMACNA; the girth each lock consumes is practice (≈3 pockets for a Pittsburgh, 2 for a snaplock).'),
} as const;

/** Sheet girth one longitudinal seam consumes (mm): pockets per SMACNA, the fold count is practice. */
export function seamAllowanceMm(type: DuctSeamType, sheetMm: number): number {
  if (type === 'pittsburgh') return Math.round(3 * SEAM_RULES.pittsburghPocketMm);
  return Math.round(2 * (sheetMm > 0.7 + 1e-9 ? SEAM_RULES.snaplockPocketLargeMm : SEAM_RULES.snaplockPocketSmallMm));
}

/**
 * Longitudinal seams per straight section: two L-shaped halves while half the
 * girth fits the coil, four panels beyond (practice; coil width is a setting).
 */
export function seamsPerSection(outerWidthMm: number, outerHeightMm: number, coilWidthMm: number): number {
  return outerWidthMm + outerHeightMm <= coilWidthMm ? 2 : 4;
}

// ---- Flexible connection at the fan: Fig. 2-17 (p.2.21) ----

export const FAN_CONNECTOR = {
  /** Fabric between the metal edges: 76 or 102 mm, 254 mm maximum. */
  fabricOptionsMm: [76, 102] as const,
  maxFabricMm: 254,
  /** Metal edge each side: 3″ (76 mm). */
  metalEdgeMm: 76,
  provenance: smacna('Fig. 2-17, p.2.21'),
} as const;

// ---- TDC / TDF clips: Fig. 1-15 (p.1.81) ----

export const TEE_FLANGE_CLIPS = {
  clipLengthMm: 152,
  firstClipFromCornerMm: 152,
  maxSpacingMm: 381,
  maxSpacingAbove750PaMm: 305,
  minClipThicknessMm: 0.85,
  cornerPieceThicknessMm: 1.61,
  minBoltMm: 9.5,
  provenance: smacna('Fig. 1-15, p.1.81', 'Lists T-24a, T-24, T-25a and T-25b tee flanges.'),
} as const;
