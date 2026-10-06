/**
 * Equal-friction equivalents of a duct section (ASHRAE Handbook—Fundamentals
 * ch. 21, the Huebscher equivalent diameter): the round duct with the same
 * friction per metre at the same airflow as a rectangle, and the rectangles
 * with the friction of a round duct or of another rectangle. These are the
 * sizes a designer swaps between without upsetting the system's balance.
 * Rectangles run in the fabricator's 50 mm steps; round sizes are the
 * stocked list (spiral duct is bought by the size).
 */
import { equivalentDiameterMm } from './ductSizing';
import { roundLeg, type DuctLeg } from './ductTypes';

/** Width and height step of fabricated rectangular duct (mm). */
export const SECTION_STEP_MM = 50;
/** Smallest rectangular side offered (mm). */
export const MIN_RECT_SIDE_MM = 100;

const tolerance = 0.5;

/** The stocked round sizes either side of a section's equivalent diameter: the smallest at or above it, and the largest below it. */
export function roundEquivalents(section: DuctLeg, stockMm: readonly number[]): { deMm: number; atOrAbove: DuctLeg | null; below: DuctLeg | null } {
  const deMm = equivalentDiameterMm(section);
  const sizes = [...new Set(stockMm.filter((size) => Number.isFinite(size) && size > 0))].sort((a, b) => a - b);
  const above = sizes.find((size) => size >= deMm - tolerance);
  const below = [...sizes].reverse().find((size) => size < deMm - tolerance);
  return { deMm, atOrAbove: above !== undefined ? roundLeg(above) : null, below: below !== undefined ? roundLeg(below) : null };
}

/** The narrowest width, in steps, that gives a rectangle `heightMm` high an equivalent diameter of at least `deMm`; null past `maxWidthMm`. */
export function widthForEquivalent(deMm: number, heightMm: number, stepMm = SECTION_STEP_MM, maxWidthMm = 3000): number | null {
  if (!(deMm > 0) || !(heightMm > 0)) return null;
  // Equivalent diameter rises with the width, so the first step that reaches it is the narrowest.
  for (let width = Math.max(stepMm, MIN_RECT_SIDE_MM); width <= maxWidthMm + tolerance; width += stepMm) {
    if (equivalentDiameterMm({ widthMm: width, heightMm }) >= deMm - tolerance) return width;
  }
  return null;
}

export interface RectangularEquivalentOptions {
  /** Tallest section that fits (the void, in clear inside height) (mm). */
  maxHeightMm: number;
  minHeightMm?: number;
  /** Widest aspect ratio offered. */
  maxAspect: number;
  stepMm?: number;
}

/**
 * Rectangles with at least the friction-equivalent of `deMm`, one per height
 * (lowest first), each the narrowest at its height, as wide as or wider than
 * high (a ceiling duct lies flat), within the aspect limit and the void.
 */
export function rectangularEquivalents(deMm: number, options: RectangularEquivalentOptions): DuctLeg[] {
  const step = options.stepMm ?? SECTION_STEP_MM;
  const out: DuctLeg[] = [];
  const lowest = Math.max(MIN_RECT_SIDE_MM, options.minHeightMm ?? MIN_RECT_SIDE_MM);
  for (let height = Math.ceil(lowest / step) * step; height <= options.maxHeightMm + tolerance; height += step) {
    const width = widthForEquivalent(deMm, height, step);
    if (width === null) continue;
    const wide = Math.max(width, height);
    if (wide / height > options.maxAspect + 1e-9) continue;
    if (width < height) {
      // Narrower than high: the square at this height is the flattest it may lie.
      if (!out.some((leg) => leg.widthMm === height && leg.heightMm === height)) out.push({ widthMm: height, heightMm: height });
      continue;
    }
    out.push({ widthMm: width, heightMm: height });
  }
  return out;
}

/** A section's outside height with its sheet and insulation (what it needs of the void) (mm). */
export function outerHeightMm(section: DuctLeg, sheetMm: number, insulationMm: number): number {
  return (section.diameterMm ?? section.heightMm) + 2 * sheetMm + 2 * insulationMm;
}

/** Aspect ratio of a section (1 for round). */
export function aspectOf(section: DuctLeg): number {
  if (section.diameterMm !== undefined) return 1;
  return Math.max(section.widthMm, section.heightMm) / Math.max(1, Math.min(section.widthMm, section.heightMm));
}

export function sameSectionSize(a: DuctLeg, b: DuctLeg): boolean {
  return (a.diameterMm !== undefined) === (b.diameterMm !== undefined)
    && Math.abs(a.widthMm - b.widthMm) < tolerance && Math.abs(a.heightMm - b.heightMm) < tolerance;
}
