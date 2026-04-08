'use client';

export type LinearUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'ft-in';
export type PaperUnit = 'mm' | 'cm' | 'in' | 'm';

export const PX_PER_INCH = 96;
export const MM_PER_INCH = 25.4;
export const PX_TO_MM = MM_PER_INCH / PX_PER_INCH;
export const MM_TO_PX = PX_PER_INCH / MM_PER_INCH;

const DEFAULT_TARGET_MAJOR_PX = 92;
const DEFAULT_MIN_MINOR_PX = 10;

export interface AdaptiveStepResult {
  majorMultiplier: number;
  majorStepScenePx: number;
  minorStepScenePx: number;
  majorStepMm: number;
  minorStepMm: number;
  majorStepPx: number;
  minorStepPx: number;
  showMinor: boolean;
}

interface AdaptiveStepOptions {
  targetMajorPx?: number;
  minMinorPx?: number;
}

export function getNiceMultiplier(value: number): number {
  if (!Number.isFinite(value) || value <= 1) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;

  if (fraction <= 1) return base;
  if (fraction <= 2) return 2 * base;
  if (fraction <= 5) return 5 * base;
  return 10 * base;
}

export function toMillimeters(value: number, unit: LinearUnit | PaperUnit): number {
  const safeValue = Number.isFinite(value) ? value : 0;
  switch (unit) {
    case 'mm':
      return safeValue;
    case 'cm':
      return safeValue * 10;
    case 'm':
      return safeValue * 1000;
    case 'in':
      return safeValue * MM_PER_INCH;
    case 'ft':
    case 'ft-in':
      return safeValue * MM_PER_INCH * 12;
    default:
      return safeValue;
  }
}

export function fromMillimeters(mmValue: number, unit: LinearUnit | PaperUnit): number {
  const mm = Number.isFinite(mmValue) ? mmValue : 0;
  switch (unit) {
    case 'mm':
      return mm;
    case 'cm':
      return mm / 10;
    case 'm':
      return mm / 1000;
    case 'in':
      return mm / MM_PER_INCH;
    case 'ft':
    case 'ft-in':
      return mm / (MM_PER_INCH * 12);
    default:
      return mm;
  }
}

export function getUnitLabel(unit: LinearUnit | PaperUnit): string {
  switch (unit) {
    case 'ft-in':
      return 'ft';
    default:
      return unit;
  }
}

export interface AdaptiveIntervalResult {
  multiplier: number;
  stepScenePx: number;
  stepPx: number;
}

export function getAdaptiveInterval(
  baseStepScenePx: number,
  zoom: number,
  targetStepPx = DEFAULT_TARGET_MAJOR_PX
): AdaptiveIntervalResult {
  const scale = Math.max(zoom, 0.01);
  const baseStep = Math.max(baseStepScenePx, 0.5);
  const rawMultiplier = targetStepPx / Math.max(baseStep * scale, 0.0001);
  const multiplier = getNiceMultiplier(rawMultiplier);
  const stepScenePx = baseStep * multiplier;
  const stepPx = stepScenePx * scale;
  return {
    multiplier,
    stepScenePx,
    stepPx,
  };
}

export function getAdaptiveSteps(
  zoom: number,
  baseStepScenePx: number,
  options: AdaptiveStepOptions = {}
): AdaptiveStepResult {
  const scale = Math.max(zoom, 0.01);
  const baseStep = Math.max(baseStepScenePx, 0.5);
  const targetMajorPx = options.targetMajorPx ?? DEFAULT_TARGET_MAJOR_PX;
  const minMinorPx = options.minMinorPx ?? DEFAULT_MIN_MINOR_PX;

  const minorStepScenePx = baseStep;
  const minorStepPx = minorStepScenePx * scale;
  const rawMultiplier = targetMajorPx / Math.max(minorStepPx, 0.0001);
  const majorMultiplier = getNiceMultiplier(rawMultiplier);
  const majorStepScenePx = minorStepScenePx * majorMultiplier;
  const majorStepPx = majorStepScenePx * scale;

  const majorStepMm = majorStepScenePx * PX_TO_MM;
  const minorStepMm = minorStepScenePx * PX_TO_MM;
  const showMinor = majorMultiplier > 1 && minorStepPx >= minMinorPx;

  return {
    majorMultiplier,
    majorStepScenePx,
    minorStepScenePx,
    majorStepMm,
    minorStepMm,
    majorStepPx,
    minorStepPx,
    showMinor,
  };
}

export function formatRulerLabel(valueMm: number, majorStepMm: number): string {
  const cm = valueMm / 10;
  if (majorStepMm >= 10) {
    const rounded = Math.round(cm);
    return rounded === 0 ? '0' : rounded.toString();
  }
  if (Math.abs(cm) < 0.0001) return '0';
  return cm.toFixed(1).replace(/\.0$/, '');
}
