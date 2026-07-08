'use client';

/**
 * Board measurement service — the single source of truth binding the drawing
 * sheet (unit, page scale, grid, rulers) to the drawing tools.
 *
 * Every consumer (grid overlay, rulers, snapping, previews, labels, HUD)
 * derives its steps and formatting from `deriveBoardMeasurement` so the board
 * and the drawn objects always agree. Canonical storage is millimetres; unit
 * conversion happens only at UI boundaries.
 */

import type { DisplayUnit } from '../../types';

import { formatDistance } from './formatting';
import {
  MM_TO_PX,
  type PaperUnit,
  fromMillimeters,
  toMillimeters,
} from './scale';

export type BoardMeasurementMode = 'paper' | 'real';

export interface BoardSettings {
  /** Paper side of the scale ratio (the `1` in 1:50). */
  scaleDrawing: number;
  /** Real side of the scale ratio (the `50` in 1:50). */
  scaleReal: number;
  /** Unit used for paper-mode grid/ruler values. */
  paperUnit: PaperUnit;
  /** Whether the grid is specified on the paper sheet or in real-world size. */
  gridMode: BoardMeasurementMode;
  /** Whether rulers read paper distances or real-world distances. */
  rulerMode: BoardMeasurementMode;
  /** Major grid step in paper millimetres (used when gridMode = 'paper'). */
  majorGridPaperMm: number;
  /** Major grid step in real millimetres (used when gridMode = 'real'). */
  majorGridRealMm: number;
  /** Sub-grid lines per major cell; the sub-grid is the snap step. */
  gridSubdivisions: number;
  /** Ruler major tick in paper millimetres (rulerMode = 'paper'). */
  majorTickPaperMm: number;
  /** Ruler major tick in real millimetres (rulerMode = 'real'). */
  majorTickRealMm: number;
  /** Minor ticks per ruler major tick. */
  tickSubdivisions: number;
  showRulerLabels: boolean;
}

export const DEFAULT_BOARD_SETTINGS: BoardSettings = {
  scaleDrawing: 1,
  scaleReal: 50,
  paperUnit: 'mm',
  gridMode: 'paper',
  // Rulers default to real-world readings so the assigned unit and page scale
  // are visible while drawing (paper mode remains available).
  rulerMode: 'real',
  majorGridPaperMm: 10,
  majorGridRealMm: 1000,
  gridSubdivisions: 10,
  majorTickPaperMm: 10,
  majorTickRealMm: 1000,
  tickSubdivisions: 10,
  showRulerLabels: true,
};

const clampPositive = (value: unknown, fallback: number, min = 0.000001): number => {
  const parsed = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(parsed, min) : fallback;
};

const clampSubdivisions = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? Math.max(1, Math.floor(parsed)) : fallback;
};

const resolveMode = (value: unknown, fallback: BoardMeasurementMode): BoardMeasurementMode =>
  value === 'paper' || value === 'real' ? value : fallback;

const PAPER_UNITS: PaperUnit[] = ['mm', 'cm', 'in', 'm'];

/**
 * Tolerant resolver used for persistence (import of old/partial documents)
 * and for store updates. Always returns a fully valid BoardSettings.
 */
export function resolveBoardSettings(raw?: unknown): BoardSettings {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<BoardSettings>;
  return {
    scaleDrawing: clampPositive(source.scaleDrawing, DEFAULT_BOARD_SETTINGS.scaleDrawing),
    scaleReal: clampPositive(source.scaleReal, DEFAULT_BOARD_SETTINGS.scaleReal),
    paperUnit: PAPER_UNITS.includes(source.paperUnit as PaperUnit)
      ? (source.paperUnit as PaperUnit)
      : DEFAULT_BOARD_SETTINGS.paperUnit,
    gridMode: resolveMode(source.gridMode, DEFAULT_BOARD_SETTINGS.gridMode),
    rulerMode: resolveMode(source.rulerMode, DEFAULT_BOARD_SETTINGS.rulerMode),
    majorGridPaperMm: clampPositive(source.majorGridPaperMm, DEFAULT_BOARD_SETTINGS.majorGridPaperMm, 0.1),
    majorGridRealMm: clampPositive(source.majorGridRealMm, DEFAULT_BOARD_SETTINGS.majorGridRealMm, 0.1),
    gridSubdivisions: clampSubdivisions(source.gridSubdivisions, DEFAULT_BOARD_SETTINGS.gridSubdivisions),
    majorTickPaperMm: clampPositive(source.majorTickPaperMm, DEFAULT_BOARD_SETTINGS.majorTickPaperMm, 0.1),
    majorTickRealMm: clampPositive(source.majorTickRealMm, DEFAULT_BOARD_SETTINGS.majorTickRealMm, 0.1),
    tickSubdivisions: clampSubdivisions(source.tickSubdivisions, DEFAULT_BOARD_SETTINGS.tickSubdivisions),
    showRulerLabels: typeof source.showRulerLabels === 'boolean'
      ? source.showRulerLabels
      : DEFAULT_BOARD_SETTINGS.showRulerLabels,
  };
}

export interface BoardMeasurement {
  /** Paper millimetres per real millimetre (1:50 → 0.02). */
  paperPerRealRatio: number;
  majorGridPaperMm: number;
  minorGridPaperMm: number;
  majorGridRealMm: number;
  minorGridRealMm: number;
  /** Snap step for tools working in real millimetres (walls, rooms, HVAC…). */
  snapStepMm: number;
  /** Snap step in fabric scene pixels (scene px = real mm × MM_TO_PX). */
  sceneSnapPx: number;
  /** Format a real-mm length in the assigned display unit. */
  formatLength: (mm: number) => string;
}

export function deriveBoardMeasurement(
  settings: BoardSettings,
  displayUnit: DisplayUnit,
): BoardMeasurement {
  const resolved = resolveBoardSettings(settings);
  const paperPerRealRatio = resolved.scaleDrawing / resolved.scaleReal;

  const majorGridPaperMm = resolved.gridMode === 'real'
    ? resolved.majorGridRealMm * paperPerRealRatio
    : resolved.majorGridPaperMm;
  const majorGridRealMm = resolved.gridMode === 'real'
    ? resolved.majorGridRealMm
    : resolved.majorGridPaperMm / paperPerRealRatio;

  const minorGridPaperMm = majorGridPaperMm / resolved.gridSubdivisions;
  const minorGridRealMm = majorGridRealMm / resolved.gridSubdivisions;

  const snapStepMm = Math.max(minorGridRealMm, 0.01);

  return {
    paperPerRealRatio,
    majorGridPaperMm,
    minorGridPaperMm,
    majorGridRealMm,
    minorGridRealMm,
    snapStepMm,
    sceneSnapPx: Math.max(snapStepMm * MM_TO_PX, 0.5),
    formatLength: (mm: number) => formatDistance(mm, displayUnit),
  };
}

/**
 * Grid/ruler prop values for `DrawingCanvas`, expressed in the unit each mode
 * expects (paper unit for paper mode, display unit for real mode) so the
 * canvas's own `toMillimeters` conversion round-trips the canonical mm value.
 */
export function boardSettingsToCanvasProps(
  settings: BoardSettings,
  displayUnit: DisplayUnit,
): {
  majorGridSize: number;
  majorTickInterval: number;
  gridMode: BoardMeasurementMode;
  rulerMode: BoardMeasurementMode;
  gridSubdivisions: number;
  tickSubdivisions: number;
  paperUnit: PaperUnit;
  scaleDrawing: number;
  scaleReal: number;
  showRulerLabels: boolean;
} {
  const resolved = resolveBoardSettings(settings);
  const majorGridSize = resolved.gridMode === 'real'
    ? fromMillimeters(resolved.majorGridRealMm, displayUnit)
    : fromMillimeters(resolved.majorGridPaperMm, resolved.paperUnit);
  const majorTickInterval = resolved.rulerMode === 'real'
    ? fromMillimeters(resolved.majorTickRealMm, displayUnit)
    : fromMillimeters(resolved.majorTickPaperMm, resolved.paperUnit);
  return {
    majorGridSize,
    majorTickInterval,
    gridMode: resolved.gridMode,
    rulerMode: resolved.rulerMode,
    gridSubdivisions: resolved.gridSubdivisions,
    tickSubdivisions: resolved.tickSubdivisions,
    paperUnit: resolved.paperUnit,
    scaleDrawing: resolved.scaleDrawing,
    scaleReal: resolved.scaleReal,
    showRulerLabels: resolved.showRulerLabels,
  };
}

/** Convert a value entered in the given unit into canonical millimetres. */
export function boardValueToMm(value: number, unit: DisplayUnit | PaperUnit): number {
  return toMillimeters(value, unit);
}

/** Convert canonical millimetres into the given unit for display/editing. */
export function boardValueFromMm(mm: number, unit: DisplayUnit | PaperUnit): number {
  return fromMillimeters(mm, unit);
}
