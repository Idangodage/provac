/**
 * The duct sizes a design is made of: the metric series (rectangular sides
 * on the fabricator's step, 25 / 50 / 100 mm; round sizes from the project's
 * stock, the EN 1506 series) or the inch series (rectangular sides in 2 in
 * steps; round 4–10 in by the inch, then by 2 in), chosen with the project's
 * units. Sizes stay in mm; an inch size is its exact equivalent (24 in =
 * 609.6 mm). Every sizing path reads its step and its round sizes here.
 */
import type { DuctDesignSettings } from './ductSettings';

export type DuctSizeSeries = 'metric' | 'imperial';

const INCH_MM = 25.4;

/** Round spiral and flexible duct in inches (practice: the usual stocked sizes). */
export const IMPERIAL_ROUND_SIZES_IN: readonly number[] = [4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40];

/** Rectangular sides in even inches. */
export const IMPERIAL_RECT_STEP_MM = 2 * INCH_MM;

/** The k-th multiple of a step, free of floating-point noise (50.8 × 7 = 355.6, not 355.59999…). */
export function onStep(k: number, stepMm: number): number {
  return Math.round(k * stepMm * 1000) / 1000;
}

/** The smallest multiple of the step at or above a length. */
export function stepAtOrAbove(lengthMm: number, stepMm: number): number {
  return onStep(Math.ceil(lengthMm / stepMm - 1e-9), stepMm);
}

/** The nearest multiple of the step. */
export function nearestStep(lengthMm: number, stepMm: number): number {
  return onStep(Math.round(lengthMm / stepMm), stepMm);
}

/** Whether a length is on the step. */
export function isOnStep(lengthMm: number, stepMm: number): boolean {
  return Math.abs(lengthMm - nearestStep(lengthMm, stepMm)) < 1e-6;
}

/** The step rectangular sides are sized in (mm). */
export function ductRectStepMm(settings: Pick<DuctDesignSettings, 'rectStepMm' | 'sizeSeries'>): number {
  return settings.sizeSeries === 'imperial' ? IMPERIAL_RECT_STEP_MM : settings.rectStepMm;
}

/** The round sizes a design chooses from (mm), ascending. */
export function ductRoundSizesMm(settings: Pick<DuctDesignSettings, 'autoRoundSizesMm' | 'sizeSeries'>): number[] {
  return settings.sizeSeries === 'imperial' ? IMPERIAL_ROUND_SIZES_IN.map((inches) => onStep(inches, INCH_MM)) : [...settings.autoRoundSizesMm];
}
