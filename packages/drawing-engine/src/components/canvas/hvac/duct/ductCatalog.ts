/**
 * Duct construction catalog: galvanised sheet, joint rigidity (SMACNA 1995
 * Table 1-12M), companion-angle members, Ductmate series and the joint
 * hardware rules. Every row carries its provenance; values that come only
 * from figures or secondary sources are `verified: false` and are never
 * presented as authoritative.
 */
import type { DuctRuleProvenance } from './ductSources';
import type { SmacnaRigidityClass } from './smacnaRectangularTables';

export const SMACNA_RIGIDITY_CLASSES: readonly SmacnaRigidityClass[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

export function rigidityIndex(cls: SmacnaRigidityClass): number {
  return SMACNA_RIGIDITY_CLASSES.indexOf(cls);
}

export function maxRigidityClass(
  a: SmacnaRigidityClass | null,
  b: SmacnaRigidityClass | null,
): SmacnaRigidityClass | null {
  if (a === null) return b;
  if (b === null) return a;
  return rigidityIndex(a) >= rigidityIndex(b) ? a : b;
}

/** SMACNA metric thicknesses and the galvanised gauge each one stands for. */
export const SMACNA_NOMINAL_SHEETS: ReadonlyArray<{ thicknessMm: number; gauge: number }> = [
  { thicknessMm: 0.55, gauge: 26 },
  { thicknessMm: 0.7, gauge: 24 },
  { thicknessMm: 0.85, gauge: 22 },
  { thicknessMm: 1.0, gauge: 20 },
  { thicknessMm: 1.31, gauge: 18 },
  { thicknessMm: 1.61, gauge: 16 },
];

const THICKNESS_EPSILON_MM = 1e-6;

/**
 * The SMACNA nominal thickness a stock sheet may be credited with: the highest
 * nominal it equals or exceeds. Joint ratings are tabulated only at nominal
 * thicknesses, so a 1.25 mm sheet is rated as 1.00 mm (never interpolated).
 */
export function creditedNominalThicknessMm(sheetMm: number): number | null {
  let credited: number | null = null;
  for (const sheet of SMACNA_NOMINAL_SHEETS) {
    if (sheetMm + THICKNESS_EPSILON_MM >= sheet.thicknessMm) credited = sheet.thicknessMm;
  }
  return credited;
}

/** Gauge label for a sheet: the SMACNA gauge it is credited as. */
export function gaugeLabelForSheet(sheetMm: number): string {
  const credited = creditedNominalThicknessMm(sheetMm);
  const gauge = SMACNA_NOMINAL_SHEETS.find((sheet) => sheet.thicknessMm === credited)?.gauge;
  return gauge ? `${gauge} ga` : 'below 26 ga';
}

export const GI_SHEET_MASS_PROVENANCE: DuctRuleProvenance = {
  sourceId: 'astm-a653',
  verified: true,
  note: 'Computed; SMACNA appendix A.7 (sheet weights) is an image and was not read.',
};

/** Mass of galvanised sheet (kg/m²): steel at 7850 kg/m³ plus G-60 coating. */
export function galvanisedSheetMassKgPerM2(thicknessMm: number): number {
  return thicknessMm * 7.85 + 0.183;
}

/**
 * Table 1-12M (p.1.37): how each transverse joint family reaches a rigidity
 * class. T-24 / T-25 flanges are formed from the duct wall, so their rating is
 * a minimum duct thickness; T-22 uses a separate angle member.
 */
export interface JointRigidityRow {
  cls: SmacnaRigidityClass;
  /** Minimum duct thickness for T-24 / T-25a/b, positive pressure, no tie rod (mm; null = not rated). */
  formedFlangePositiveMm: number | null;
  /** Same, negative pressure. */
  formedFlangeNegativeMm: number | null;
  /** T-22 companion angle (leg × thickness, mm). */
  companionAngle: { legMm: number; thicknessMm: number; hotRolled?: boolean; positiveOnly?: boolean } | null;
}

/** Classes A–C are satisfied by the D (formed) or E (angle) member ("use D" / "use E"). */
export const SMACNA_JOINT_RIGIDITY_1_12M: readonly JointRigidityRow[] = [
  { cls: 'D', formedFlangePositiveMm: 0.55, formedFlangeNegativeMm: 0.55, companionAngle: { legMm: 25, thicknessMm: 3.2 } },
  { cls: 'E', formedFlangePositiveMm: 0.7, formedFlangeNegativeMm: 0.7, companionAngle: { legMm: 25, thicknessMm: 3.2 } },
  { cls: 'F', formedFlangePositiveMm: 0.85, formedFlangeNegativeMm: 0.85, companionAngle: { legMm: 25, thicknessMm: 3.2, hotRolled: true } },
  { cls: 'G', formedFlangePositiveMm: 1.0, formedFlangeNegativeMm: 1.0, companionAngle: { legMm: 31.8, thicknessMm: 3.2 } },
  // H: formed flanges are rated for positive pressure only (+1.31); the angle is
  // cold-formed (+) or hot-rolled (±) 38.1 × 3.2.
  { cls: 'H', formedFlangePositiveMm: 1.31, formedFlangeNegativeMm: null, companionAngle: { legMm: 38.1, thicknessMm: 3.2, hotRolled: true } },
  // I–L formed flanges require tie rods (R), which this engine does not add.
  { cls: 'I', formedFlangePositiveMm: null, formedFlangeNegativeMm: null, companionAngle: { legMm: 38.1, thicknessMm: 6.4 } },
  { cls: 'J', formedFlangePositiveMm: null, formedFlangeNegativeMm: null, companionAngle: { legMm: 51, thicknessMm: 3.2 } },
  { cls: 'K', formedFlangePositiveMm: null, formedFlangeNegativeMm: null, companionAngle: { legMm: 51, thicknessMm: 4.8 } },
  { cls: 'L', formedFlangePositiveMm: null, formedFlangeNegativeMm: null, companionAngle: { legMm: 51, thicknessMm: 6.4 } },
];

export const JOINT_RIGIDITY_PROVENANCE: DuctRuleProvenance = {
  sourceId: 'smacna-1995', reference: 'Table 1-12M, p.1.37', verified: true,
};

export type PressureMode = 'positive' | 'negative';

/** Highest class a formed (T-24/T-25) flange reaches on a sheet, without tie rods. */
export function formedFlangeRatingForSheet(sheetMm: number, mode: PressureMode): SmacnaRigidityClass | null {
  const credited = creditedNominalThicknessMm(sheetMm);
  if (credited === null) return null;
  let rating: SmacnaRigidityClass | null = null;
  for (const row of SMACNA_JOINT_RIGIDITY_1_12M) {
    const required = mode === 'positive' ? row.formedFlangePositiveMm : row.formedFlangeNegativeMm;
    if (required !== null && credited + THICKNESS_EPSILON_MM >= required) rating = row.cls;
  }
  return rating;
}

/** T-22 companion angle for a class (A–D use the E member). */
export function companionAngleForClass(cls: SmacnaRigidityClass | null): NonNullable<JointRigidityRow['companionAngle']> {
  const effective = cls === null || rigidityIndex(cls) < rigidityIndex('E') ? 'E' : cls;
  return SMACNA_JOINT_RIGIDITY_1_12M.find((row) => row.cls === effective)!.companionAngle!;
}

/** Ductmate formed-flange series (manufacturer ratings; SMACNA does not grade proprietary joints). */
export interface DuctmateSeries {
  id: 'DM25' | 'DM35' | 'DM45';
  minSheetMm: number;
  maxSheetMm: number;
  ratedClass: SmacnaRigidityClass;
  flangeHeightMm: number;
}

export const DUCTMATE_SERIES: readonly DuctmateSeries[] = [
  { id: 'DM25', minSheetMm: 0.55, maxSheetMm: 1.0, ratedClass: 'F', flangeHeightMm: 25 },
  { id: 'DM35', minSheetMm: 0.55, maxSheetMm: 1.61, ratedClass: 'J', flangeHeightMm: 35 },
  { id: 'DM45', minSheetMm: 0.85, maxSheetMm: 3.5, ratedClass: 'K', flangeHeightMm: 45 },
];

export const DUCTMATE_PROVENANCE: DuctRuleProvenance = {
  sourceId: 'ductmate-spec', verified: true,
  note: 'DM25 ≈ Class F, DM35 ≈ Class J, DM45 ≈ Class K per the manufacturer; flange heights are the series designations.',
};

/**
 * Pick a Ductmate series for a sheet and class. The sheet must be inside the
 * series' gauge range (checked at its credited nominal, with the raw stock
 * thickness for the upper bound).
 */
export function selectDuctmateSeries(sheetMm: number, required: SmacnaRigidityClass | null): DuctmateSeries | null {
  for (const series of DUCTMATE_SERIES) {
    if (sheetMm + THICKNESS_EPSILON_MM < series.minSheetMm) continue;
    if (sheetMm - THICKNESS_EPSILON_MM > series.maxSheetMm) continue;
    if (required !== null && rigidityIndex(series.ratedClass) < rigidityIndex(required)) continue;
    return series;
  }
  return null;
}

/**
 * The alternative "longest side" gauge table many specifications use (low
 * pressure). No joint class is derived in this mode.
 */
export const COMMON_LONGEST_SIDE_TABLE: ReadonlyArray<{ maxSideMm: number; thicknessMm: number }> = [
  { maxSideMm: 300, thicknessMm: 0.55 },
  { maxSideMm: 750, thicknessMm: 0.7 },
  { maxSideMm: 1350, thicknessMm: 0.85 },
  { maxSideMm: 2100, thicknessMm: 1.0 },
  { maxSideMm: Number.POSITIVE_INFINITY, thicknessMm: 1.31 },
];

export const COMMON_LONGEST_SIDE_PROVENANCE: DuctRuleProvenance = {
  sourceId: 'institutional-specs', reference: 'Texas State 23 31 00 low-pressure gauge table', verified: true,
  note: 'Not SMACNA-derived: no reinforcement or joint class is checked in this mode.',
};

/** Transverse joint hardware rules (per joint = two duct ends). */
export const JOINT_HARDWARE_RULES = {
  /** T-24 notes: ≥16 ga corner pieces closed by ≥3/8″ bolts (M10 is the next metric size up). */
  formedFlangeCornerBolt: 'M10',
  /** T-24 notes: 152 mm clips within 152 mm of each corner. */
  cleatLengthMm: 152,
  cleatFromCornerMm: 152,
  /** T-24 notes: clips at ≤381 mm (≤750 Pa) or ≤305 mm (1000–2500 Pa). Applied to TDC too. */
  cleatSpacingLowMm: 381,
  cleatSpacingHighMm: 305,
  /** Ductmate: 6″ cleats at 24″ centres with 440 gasket. */
  ductmateCleatSpacingMm: 610,
  /** T-22 notes: bolts ≥5/16″ (M8) at ≤152 mm (≤1000 Pa). */
  companionAngleBolt: 'M8',
  companionAngleBoltSpacingMm: 152,
  /** T-22 notes: angle fastened to the duct at ≤305 mm, including the corners. */
  companionAngleFastenerSpacingMm: 305,
  /** S1.40: fasteners within 51 mm of corners and at ≤305 mm (used for slip-over connections). */
  fastenerFromCornerMm: 51,
  fastenerSpacingMm: 305,
} as const;

export const JOINT_HARDWARE_PROVENANCE: Record<string, DuctRuleProvenance> = {
  formedFlange: { sourceId: 'smacna-1995', reference: 'Fig. 1-4 notes, T-24 (p.1.63)', verified: true },
  tdcCleats: {
    sourceId: 'smacna-1995', reference: 'T-24 clip rule applied to T-25a/b', verified: false,
    note: 'TDC/TDF assembly is specified in Fig. 1-15, an image not yet read.',
  },
  ductmate: { sourceId: 'ductmate-spec', reference: 'screw and cleat schedules', verified: true },
  companionAngle: { sourceId: 'smacna-1995', reference: 'Fig. 1-4 notes, T-22 (p.1.62)', verified: true },
  slipOver: { sourceId: 'smacna-1995', reference: 'S1.40 fastener spacing', verified: false, note: 'Applied to the unit collar slip-over by analogy.' },
};
