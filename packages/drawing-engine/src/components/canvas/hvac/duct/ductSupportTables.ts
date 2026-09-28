/**
 * SMACNA 1995 chapter 4 (hangers and supports), as transcribed in
 * docs/hvac-duct-smacna-research.md "Hangers and supports":
 *
 *  - S4.1 (p.4.1): a support within 0.61 m of each elbow and within 1.22 m of
 *    each branch intersection of horizontal duct.
 *  - §4.2.8: hangers at 2.44 m or 3.05 m maximum spacing.
 *  - §4.2.10: riser supports at one- or two-storey intervals (3.66–7.32 m).
 *  - Table 4-1M (p.4.6): minimum rectangular hanger per pair, by half
 *    perimeter and spacing, with the single-hanger maximum loads.
 *  - Table 4-2 (p.4.7): round duct hangers, 3.7 m maximum spacing.
 *  - Table 4-3M (p.4.11): allowable trapeze loads by bar length and member.
 *
 * Metric rods are derived: the tabulated rod loads are ≈6.2 kg per mm² of
 * UNC tensile-stress area for every size, applied to ISO stress areas.
 */

export const SUPPORT_RULES = {
  /** S4.1: a support within this distance of each elbow (mm). */
  elbowMaxMm: 610,
  /** S4.1: a support within this distance of each branch intersection (mm). */
  branchMaxMm: 1220,
  /** §4.2.8 maximum hanger spacings (mm). */
  maxSpacingsMm: [2440, 3050] as const,
  /** §4.2.10 riser support interval range (mm). */
  riserIntervalMm: [3660, 7320] as const,
  /** Table 4-2: round duct, maximum spacing throughout (mm). */
  roundMaxSpacingMm: 3700,
  /** Table 4-1M note: the tables allow this much insulation (kg/m²). */
  insulationAllowanceKgPerM2: 4.89,
  /** Table 4-1M note: over this widest side, P/2 is taken as at least 1.25 × that side (mm). */
  wideSideMm: 1520,
  /** Table 4-3M note: rod no more than this from the duct side for bars ≤ 2440 mm (mm). */
  maxRodOffsetMm: 152,
} as const;

/** Table 4-1M spacing columns (mm) and rows (max P/2, per-pair strap and wire/rod ⌀ per column). */
export const SMACNA_TABLE_4_1M = {
  spacingsMm: [3000, 2400, 1500, 1200] as const,
  rows: [
    { maxHalfPerimeterMm: 760, cells: [['25.4×0.85', 3.4], ['25.4×0.85', 3.4], ['25.4×0.85', 2.7], ['25.4×0.85', 2.7]] },
    { maxHalfPerimeterMm: 1830, cells: [['25.4×1.31', 9.5], ['25.4×1.00', 6.4], ['25.4×0.85', 6.4], ['25.4×0.85', 6.4]] },
    { maxHalfPerimeterMm: 2440, cells: [['25.4×1.61', 9.5], ['25.4×1.31', 9.5], ['25.4×1.00', 9.5], ['25.4×0.85', 6.4]] },
    { maxHalfPerimeterMm: 3050, cells: [['38.1×1.61', 12.7], ['25.4×1.61', 9.5], ['25.4×1.31', 9.5], ['25.4×1.00', 6.4]] },
    { maxHalfPerimeterMm: 4270, cells: [['38.1×1.61', 12.7], ['38.1×1.61', 12.7], ['25.4×1.61', 9.5], ['25.4×1.31', 9.5]] },
    { maxHalfPerimeterMm: 4880, cells: [[null, 12.7], ['38.1×1.61', 12.7], ['25.4×1.61', 9.5], ['25.4×1.61', 9.5]] },
  ] as ReadonlyArray<{ maxHalfPerimeterMm: number; cells: ReadonlyArray<readonly [string | null, number]> }>,
} as const;

/** Table 4-1M single-hanger maximum loads (kg). */
export const SMACNA_SINGLE_HANGER_LOADS_KG = {
  straps: { '25.4×0.85': 118, '25.4×1.00': 145, '25.4×1.31': 191, '25.4×1.61': 318, '38.1×1.61': 500 } as Record<string, number>,
  rods: { 2.7: 36, 3.4: 54, 4.1: 73, 6.4: 122, 9.5: 308, 12.7: 567, 15.9: 907, 19.1: 1360 } as Record<number, number>,
};

export interface MetricRod {
  label: 'M8' | 'M10' | 'M12' | 'M16';
  diameterMm: number;
  stressAreaMm2: number;
  /** Allowable load (kg): SMACNA's ≈6.2 kg/mm² applied to the ISO stress area (derived). */
  allowableKg: number;
}

export const METRIC_RODS: readonly MetricRod[] = [
  { label: 'M8', diameterMm: 8, stressAreaMm2: 36.6, allowableKg: 227 },
  { label: 'M10', diameterMm: 10, stressAreaMm2: 58.0, allowableKg: 360 },
  { label: 'M12', diameterMm: 12, stressAreaMm2: 84.3, allowableKg: 523 },
  { label: 'M16', diameterMm: 16, stressAreaMm2: 157, allowableKg: 973 },
];

/** Table 4-2: round hangers by diameter (single rod ⌀, or two). */
export const SMACNA_TABLE_4_2: ReadonlyArray<{ maxDiameterMm: number; rodMm: number; rods: 1 | 2; strap: string }> = [
  { maxDiameterMm: 250, rodMm: 6.4, rods: 1, strap: '25.4×0.85' },
  { maxDiameterMm: 460, rodMm: 6.4, rods: 1, strap: '25.4×0.85' },
  { maxDiameterMm: 610, rodMm: 6.4, rods: 1, strap: '25.4×0.85' },
  { maxDiameterMm: 900, rodMm: 9.5, rods: 1, strap: '25.4×1.00' },
  { maxDiameterMm: 1270, rodMm: 9.5, rods: 2, strap: '25.4×1.00' },
  { maxDiameterMm: 1520, rodMm: 9.5, rods: 2, strap: '25.4×1.31' },
  { maxDiameterMm: 2130, rodMm: 9.5, rods: 2, strap: '25.4×1.61' },
];

/** A trapeze member of Table 4-3M: an equal angle, leg × thickness (mm). */
export interface TrapezeMember {
  label: string;
  legMm: number;
  thicknessMm: number;
  /** Steel mass per metre of an equal angle, (2·leg − t)·t·7.85 kg/m per mm² (derived). */
  massKgPerM: number;
}

function angle(legMm: number, thicknessMm: number, label = `L${legMm}×${thicknessMm}`): TrapezeMember {
  return { label, legMm, thicknessMm, massKgPerM: Math.round((2 * legMm - thicknessMm) * thicknessMm * 0.00785 * 100) / 100 };
}

/** Table 4-3M columns, lightest first (the 38.1×6.4 and 51×3.2 column is one; the engine uses 51×3.2). */
export const TABLE_4_3M_MEMBERS: readonly TrapezeMember[] = [
  angle(25.4, 1.61), angle(25.4, 3.2), angle(38.1, 1.61), angle(38.1, 3.2), angle(38.1, 4.8),
  angle(51, 3.2, 'L51×3.2 (or L38.1×6.4)'), angle(51, 4.8), angle(51, 6.4), angle(63.5, 4.8), angle(63.5, 6.4),
  angle(76, 6.4), angle(102, 6.4),
];

/** Table 4-3M allowable loads (kg) by bar length; null = not permitted at that length. */
export const SMACNA_TABLE_4_3M: ReadonlyArray<{ lengthMm: number; loadsKg: ReadonlyArray<number | null> }> = [
  { lengthMm: 450, loadsKg: [36, 68, 81, 159, 231, 295, 426, 558, 680, 889, null, null] },
  { lengthMm: 600, loadsKg: [34, 68, 81, 159, 231, 295, 426, 558, 680, 889, null, null] },
  { lengthMm: 760, loadsKg: [32, 68, 81, 159, 231, 295, 426, 558, 680, 889, null, null] },
  { lengthMm: 900, loadsKg: [27, 59, 72, 154, 227, 281, 417, 549, 671, 880, null, null] },
  { lengthMm: 1060, loadsKg: [18, 50, 63, 145, 218, 277, 408, 540, 667, 875, null, null] },
  { lengthMm: 1220, loadsKg: [null, 36, 50, 132, 204, 263, 395, 526, 653, 862, null, null] },
  { lengthMm: 1370, loadsKg: [null, null, null, 113, 181, 245, 381, 508, 635, 844, null, null] },
  { lengthMm: 1520, loadsKg: [null, null, null, 86, 159, 222, 354, 480, 608, 818, null, null] },
  { lengthMm: 1670, loadsKg: [null, null, null, 45, 86, 181, 318, 444, 571, 780, null, null] },
  { lengthMm: 1830, loadsKg: [null, null, null, null, null, 145, 281, 408, 535, 744, null, null] },
  { lengthMm: 2010, loadsKg: [null, null, null, null, null, 95, 227, 358, 485, 694, null, null] },
  // 2130: the 454 kg printed for 51×4.8 contradicts its neighbours and section modulus; not used.
  { lengthMm: 2130, loadsKg: [null, null, null, null, null, null, null, 299, 426, 635, 1048, 2123] },
  { lengthMm: 2440, loadsKg: [null, null, null, null, null, null, null, 145, 272, 480, 894, 1969] },
];

/** Table 4-1M minimum per pair for this half perimeter and spacing (the next column at or above the spacing). */
export function table41Minimum(halfPerimeterMm: number, spacingMm: number): { strap: string | null; rodMm: number } | null {
  const row = SMACNA_TABLE_4_1M.rows.find((candidate) => halfPerimeterMm <= candidate.maxHalfPerimeterMm + 1e-6);
  if (!row) return null;
  const columns = SMACNA_TABLE_4_1M.spacingsMm;
  // Columns run 3.0 → 1.2 m: take the tightest column that still covers the spacing.
  let column = 0;
  for (let index = 0; index < columns.length; index += 1) if (spacingMm <= columns[index]! + 1e-6) column = index;
  const [strap, rodMm] = row.cells[column]!;
  return { strap, rodMm };
}

/** The lightest metric rod carrying `loadKg`, not smaller than `minimum`. */
export function metricRodFor(loadKg: number, minimum: MetricRod['label'] = 'M8'): MetricRod | null {
  const floor = METRIC_RODS.findIndex((rod) => rod.label === minimum);
  return METRIC_RODS.slice(Math.max(0, floor)).find((rod) => rod.allowableKg + 1e-9 >= loadKg) ?? null;
}

/** The lightest Table 4-3M member for a bar of `lengthMm` carrying `loadKg` (null: special analysis). */
export function trapezeMemberFor(lengthMm: number, loadKg: number): { member: TrapezeMember; allowableKg: number; rowLengthMm: number } | null {
  const row = SMACNA_TABLE_4_3M.find((candidate) => lengthMm <= candidate.lengthMm + 1e-6);
  if (!row) return null;
  for (let index = 0; index < TABLE_4_3M_MEMBERS.length; index += 1) {
    const allowable = row.loadsKg[index];
    if (allowable !== null && allowable !== undefined && allowable + 1e-9 >= loadKg) {
      return { member: TABLE_4_3M_MEMBERS[index]!, allowableKg: allowable, rowLengthMm: row.lengthMm };
    }
  }
  return null;
}

/** Table 4-2 row for a round duct. */
export function table42For(diameterMm: number) {
  return SMACNA_TABLE_4_2.find((row) => diameterMm <= row.maxDiameterMm + 1e-6) ?? null;
}
