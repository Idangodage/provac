'use client';

/**
 * Board grid scale — the single source of truth for the adaptive 1-2-5 grid
 * ladder shared by the {@link BoardGrid} shader-plane and the {@link BoardRulers}
 * tick strips (HVAC-Studio SPEC §11). Everything derives from the canonical
 * world-mm↔screen transform: screen = (worldMm * MM_TO_PX - panOffset) * viewportZoom,
 * so grid, rulers and the pipe overlay never drift.
 */

import { MM_TO_PX } from '../scale';

export type BoardUnit = 'mm' | 'cm' | 'm';
export const BOARD_UNIT_CYCLE: BoardUnit[] = ['mm', 'cm', 'm'];

/** Minor grid lines never render tighter than this on screen. */
export const MIN_MINOR_PX = 9;
/** Sub-grid lines only appear once they are at least this far apart. */
export const MIN_SUB_PX = 7;

export interface BoardGridSteps {
  /** Sub-grid step (mm) — one ladder rung below minor. */
  subMm: number;
  /** Minor grid step (mm). */
  minorMm: number;
  /** Major (labelled) grid step (mm). */
  majorMm: number;
  subPx: number;
  minorPx: number;
  majorPx: number;
  showSub: boolean;
  showMinor: boolean;
  /** Screen pixels per world millimetre at the current zoom. */
  pxPerMm: number;
}

/** Smallest `{1,2,5}·10^k` value ≥ `v` (for `v > 0`). */
export function niceCeilPow(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  const fraction = v / base; // [1, 10)
  const nice = fraction <= 1 + 1e-9 ? 1 : fraction <= 2 + 1e-9 ? 2 : fraction <= 5 + 1e-9 ? 5 : 10;
  return nice * base;
}

/** Previous `{1,2,5}` ladder rung below `v` (e.g. 5→2, 2→1, 1→0.5). */
export function prevLadder(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 0.5;
  const exp = Math.floor(Math.log10(v) + 1e-9);
  const base = 10 ** exp;
  const fraction = Math.round(v / base); // 1, 2, 5, 10
  if (fraction <= 1) return 0.5 * base;
  if (fraction <= 2) return 1 * base;
  if (fraction <= 5) return 2 * base;
  return 5 * base;
}

function leadingDigit(v: number): number {
  const exp = Math.floor(Math.log10(v) + 1e-9);
  return Math.round(v / 10 ** exp);
}

/**
 * Choose sub/minor/major steps so the minor spacing stays in a comfortable
 * on-screen band and the major step lands on a clean decade (or half-decade).
 */
export function computeBoardGridSteps(viewportZoom: number): BoardGridSteps {
  const pxPerMm = MM_TO_PX * Math.max(viewportZoom, 1e-6);
  const minorMm = niceCeilPow(MIN_MINOR_PX / pxPerMm);
  const lead = leadingDigit(minorMm);
  // major = the next ladder step that is 5× or 10× minor (SPEC §11).
  const majorMm = minorMm * (lead === 2 ? 5 : 10);
  const subMm = prevLadder(minorMm);

  const subPx = subMm * pxPerMm;
  const minorPx = minorMm * pxPerMm;
  const majorPx = majorMm * pxPerMm;

  return {
    subMm,
    minorMm,
    majorMm,
    subPx,
    minorPx,
    majorPx,
    showSub: subPx >= MIN_SUB_PX,
    showMinor: minorPx >= MIN_MINOR_PX - 2,
    pxPerMm,
  };
}

/** Format a world-mm value in the ruler's display unit, trimming zeros. */
export function formatBoardLabel(valueMm: number, unit: BoardUnit): string {
  const scaled = unit === 'm' ? valueMm / 1000 : unit === 'cm' ? valueMm / 10 : valueMm;
  if (Math.abs(scaled) < 1e-6) return '0';
  // Up to 3 decimals, trailing zeros trimmed.
  return Number(scaled.toFixed(3)).toString();
}

export function cycleBoardUnit(unit: BoardUnit): BoardUnit {
  const index = BOARD_UNIT_CYCLE.indexOf(unit);
  return BOARD_UNIT_CYCLE[(index + 1) % BOARD_UNIT_CYCLE.length];
}

export function unitLabel(unit: BoardUnit): string {
  return unit;
}
