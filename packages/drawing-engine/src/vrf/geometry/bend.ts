/**
 * Invariants C & D — bend-radius limits for a PAIRED run.
 *
 * D (min bend radius): a bend may not be tighter than the pipe size allows.
 * C (inner vs outer radius): on a bend of SPINE radius r the two copper lines sit at
 *   r ± gap/2. The INNER line (r − gap/2) is the tightest and is the one that must
 *   still clear `size.minBendRadiusMm`. Checking only the spine (or the outer line)
 *   would let the inner line bend below the minimum. So the smallest legal spine
 *   radius is `minBendRadiusMm + gap/2`.
 */

import type { PipeSize } from '../model/types';

/** Radius of the inner copper line at a spine bend of radius r. */
export const innerLineRadiusMm = (spineRadiusMm: number, gapMm: number): number =>
  spineRadiusMm - gapMm / 2;

/** Radius of the outer copper line at a spine bend of radius r. */
export const outerLineRadiusMm = (spineRadiusMm: number, gapMm: number): number =>
  spineRadiusMm + gapMm / 2;

/** Smallest SPINE bend radius whose INNER line still clears the size minimum (C+D). */
export function minSpineBendRadiusMm(size: PipeSize, gapMm: number): number {
  return size.minBendRadiusMm + gapMm / 2;
}

export interface BendClamp {
  /** The legal spine radius to actually use. */
  value: number;
  requested: number;
  /** minSpineBendRadiusMm — the floor `value` was clamped up to (if clamped). */
  floor: number;
  clamped: boolean;
  /** Human message when clamped; undefined when the request was already legal. */
  warning?: string;
}

/**
 * Clamp a requested spine bend radius up to the smallest value whose inner line
 * clears the size minimum, warning when it had to move (invariants C + D).
 */
export function clampBendRadius(requestedMm: number, size: PipeSize, gapMm: number): BendClamp {
  const floor = minSpineBendRadiusMm(size, gapMm);
  if (requestedMm >= floor - 1e-9) {
    return { value: requestedMm, requested: requestedMm, floor, clamped: false };
  }
  return {
    value: floor,
    requested: requestedMm,
    floor,
    clamped: true,
    warning:
      `Bend radius ${Math.round(requestedMm)} mm is too tight for ${size.label}: the inner line ` +
      `would be ${Math.round(innerLineRadiusMm(requestedMm, gapMm))} mm < ${size.minBendRadiusMm} mm ` +
      `minimum. Clamped to ${Math.round(floor)} mm.`,
  };
}
