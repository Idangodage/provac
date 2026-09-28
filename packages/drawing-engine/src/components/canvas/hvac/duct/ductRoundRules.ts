/**
 * Round duct rules from SMACNA 1995 chapter 3 (the scanned 2nd edition): the
 * gauge tables at the ±500 Pa columns (the engine refuses higher classes), the
 * mitred/gored elbow table and the transverse joint fastening. Transcribed in
 * docs/hvac-duct-smacna-research.md ("Chapter 3 Round duct").
 */
import type { DuctRuleProvenance } from './ductSources';

export type DuctRoundSeam = 'spiral' | 'longitudinal';
export type DuctRoundVelocityBand = 'low' | 'medium' | 'high';
export type DuctRoundJointType = 'RT-1' | 'RT-5';

const smacna = (reference: string): DuctRuleProvenance => ({ sourceId: 'smacna-1995', reference, verified: true });

export interface RoundGaugeRow {
  maxDiameterMm: number;
  spiralMm: number | null;
  longitudinalMm: number | null;
  /** Reinforcement ring the longitudinal-seam column calls for ("A1.8" = angle A at 1.8 m). */
  longitudinalReinforcement?: { angle: RoundReinforcementAngle; spacingM: number };
}

export type RoundReinforcementAngle = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

/** Table 3-2BM angle sizes (mm). */
export const ROUND_REINFORCEMENT_ANGLES: Record<RoundReinforcementAngle, string> = {
  A: '25 × 25 × 3.2', B: '32 × 32 × 4.8', C: '38 × 38 × 4.8', D: '38 × 38 × 4.8', E: '51 × 51 × 4.8', F: '51 × 51 × 6.4',
};

/** Table 3-2AM, +500 Pa column (p.3.4). */
export const SMACNA_TABLE_3_2AM_500PA: readonly RoundGaugeRow[] = [
  { maxDiameterMm: 150, spiralMm: 0.48, longitudinalMm: 0.48 },
  { maxDiameterMm: 200, spiralMm: 0.48, longitudinalMm: 0.48 },
  { maxDiameterMm: 250, spiralMm: 0.48, longitudinalMm: 0.55 },
  { maxDiameterMm: 300, spiralMm: 0.48, longitudinalMm: 0.55 },
  { maxDiameterMm: 360, spiralMm: 0.48, longitudinalMm: 0.55 },
  { maxDiameterMm: 400, spiralMm: 0.55, longitudinalMm: 0.7 },
  { maxDiameterMm: 460, spiralMm: 0.55, longitudinalMm: 0.7 },
  { maxDiameterMm: 660, spiralMm: 0.55, longitudinalMm: 0.7 },
  { maxDiameterMm: 910, spiralMm: 0.7, longitudinalMm: 0.85 },
  { maxDiameterMm: 1270, spiralMm: 0.85, longitudinalMm: 1.0 },
  { maxDiameterMm: 1520, spiralMm: 1.0, longitudinalMm: 1.31 },
  { maxDiameterMm: 2130, spiralMm: 1.31, longitudinalMm: 1.61 },
];

/** Table 3-2BM, −500 Pa column (p.3.6). */
export const SMACNA_TABLE_3_2BM_500PA: readonly RoundGaugeRow[] = [
  { maxDiameterMm: 150, spiralMm: 0.48, longitudinalMm: 0.48 },
  { maxDiameterMm: 180, spiralMm: 0.48, longitudinalMm: 0.48 },
  { maxDiameterMm: 200, spiralMm: 0.48, longitudinalMm: 0.48 },
  { maxDiameterMm: 230, spiralMm: 0.48, longitudinalMm: 0.48 },
  { maxDiameterMm: 250, spiralMm: 0.48, longitudinalMm: 0.48 },
  { maxDiameterMm: 280, spiralMm: 0.48, longitudinalMm: 0.55 },
  { maxDiameterMm: 300, spiralMm: 0.48, longitudinalMm: 0.55 },
  { maxDiameterMm: 330, spiralMm: 0.48, longitudinalMm: 0.55 },
  { maxDiameterMm: 360, spiralMm: 0.48, longitudinalMm: 0.7 },
  { maxDiameterMm: 380, spiralMm: 0.48, longitudinalMm: 0.7 },
  { maxDiameterMm: 400, spiralMm: 0.55, longitudinalMm: 0.7 },
  { maxDiameterMm: 430, spiralMm: 0.55, longitudinalMm: 0.7 },
  { maxDiameterMm: 460, spiralMm: 0.7, longitudinalMm: 0.85 },
  { maxDiameterMm: 480, spiralMm: 0.7, longitudinalMm: 0.85 },
  { maxDiameterMm: 500, spiralMm: 0.7, longitudinalMm: 0.85 },
  { maxDiameterMm: 530, spiralMm: 0.7, longitudinalMm: 1.0 },
  { maxDiameterMm: 560, spiralMm: 0.7, longitudinalMm: 1.0 },
  { maxDiameterMm: 580, spiralMm: 0.7, longitudinalMm: 1.0 },
  { maxDiameterMm: 600, spiralMm: 0.85, longitudinalMm: 1.0 },
  { maxDiameterMm: 660, spiralMm: 0.85, longitudinalMm: 1.0 },
  { maxDiameterMm: 740, spiralMm: 0.85, longitudinalMm: 1.31 },
  { maxDiameterMm: 760, spiralMm: 0.85, longitudinalMm: 1.31 },
  { maxDiameterMm: 840, spiralMm: 1.0, longitudinalMm: 1.31 },
  { maxDiameterMm: 860, spiralMm: 1.0, longitudinalMm: 1.31 },
  { maxDiameterMm: 910, spiralMm: 1.0, longitudinalMm: 1.61 },
  { maxDiameterMm: 1070, spiralMm: 1.0, longitudinalMm: 1.61 },
  { maxDiameterMm: 1220, spiralMm: 1.0, longitudinalMm: 1.31, longitudinalReinforcement: { angle: 'A', spacingM: 1.8 } },
  { maxDiameterMm: 1520, spiralMm: 1.31, longitudinalMm: 1.31, longitudinalReinforcement: { angle: 'B', spacingM: 1.2 } },
  { maxDiameterMm: 1830, spiralMm: 1.61, longitudinalMm: null },
];

export const ROUND_GAUGE_PROVENANCE = smacna('Table 3-2AM (p.3.4), Table 3-2BM (p.3.6)');

export interface RoundGaugeResult {
  minimumMm: number;
  table: '3-2AM' | '3-2BM';
  reinforcement: RoundGaugeRow['longitudinalReinforcement'] | null;
}

/** SMACNA minimum for a round duct (positive = supply, negative = return), or null when not designed. */
export function roundMinimumThickness(diameterMm: number, seam: DuctRoundSeam, negative: boolean): RoundGaugeResult | null {
  const table = negative ? SMACNA_TABLE_3_2BM_500PA : SMACNA_TABLE_3_2AM_500PA;
  const row = table.find((candidate) => diameterMm <= candidate.maxDiameterMm + 1e-9);
  if (!row) return null;
  const minimumMm = seam === 'spiral' ? row.spiralMm : row.longitudinalMm;
  if (minimumMm === null) return null;
  return { minimumMm, table: negative ? '3-2BM' : '3-2AM', reinforcement: seam === 'longitudinal' ? row.longitudinalReinforcement ?? null : null };
}

/** Table 3-1 mitred (gored) elbows by duct velocity (p.3.1). */
export const SMACNA_TABLE_3_1: Record<DuctRoundVelocityBand, { label: string; ratio: number; pieces: { 90: number; 60: number; 45: number } }> = {
  low: { label: 'up to 5.1 m/s (1000 fpm)', ratio: 0.6, pieces: { 90: 3, 60: 2, 45: 2 } },
  medium: { label: '5.1–7.6 m/s (1001–1500 fpm)', ratio: 1.0, pieces: { 90: 4, 60: 3, 45: 2 } },
  high: { label: 'above 7.6 m/s (1500 fpm)', ratio: 1.5, pieces: { 90: 5, 60: 4, 45: 3 } },
};
export const ROUND_ELBOW_PROVENANCE = smacna('Table 3-1, p.3.1');

/** Pieces of a gored elbow: the table column at or above the turn. */
export function goredElbowPieces(band: DuctRoundVelocityBand, angleDeg: number): number {
  const pieces = SMACNA_TABLE_3_1[band].pieces;
  if (angleDeg <= 45 + 1e-6) return pieces[45];
  if (angleDeg <= 60 + 1e-6) return pieces[60];
  return pieces[90];
}

/** Fig. 3-2 transverse joints (p.3.9). */
export const ROUND_JOINT_RULES = {
  /** RT-1 beaded sleeve, 102 mm minimum, at least duct gauge. */
  sleeveLengthMm: 102,
  /** RT-5 crimp joint, 51 mm minimum lap. */
  crimpLapMm: 51,
  /** Screws at 381 mm maximum along the circumference, three minimum up to 356 mm diameter. */
  screwSpacingMm: 381,
  minScrews: 3,
  provenance: smacna('Fig. 3-2, p.3.9'),
} as const;

/** Screws fastening one duct end at a round slip joint. */
export function roundJointScrewsPerEnd(diameterMm: number): number {
  return Math.max(ROUND_JOINT_RULES.minScrews, Math.ceil((Math.PI * diameterMm) / ROUND_JOINT_RULES.screwSpacingMm));
}

/** S3.4: a round branch into a round main is at most two thirds of the main's diameter. */
export const ROUND_BRANCH_MAX_RATIO = 2 / 3;
