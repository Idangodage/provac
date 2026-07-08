import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOARD_SETTINGS,
  boardSettingsToCanvasProps,
  deriveBoardMeasurement,
  resolveBoardSettings,
} from './measurement';
import { MM_TO_PX } from './scale';

describe('resolveBoardSettings', () => {
  it('returns defaults for missing/invalid input', () => {
    expect(resolveBoardSettings(undefined)).toEqual(DEFAULT_BOARD_SETTINGS);
    expect(resolveBoardSettings(null)).toEqual(DEFAULT_BOARD_SETTINGS);
    expect(
      resolveBoardSettings({ scaleReal: -5, gridSubdivisions: 0, gridMode: 'bogus' }),
    ).toEqual(DEFAULT_BOARD_SETTINGS);
  });

  it('keeps valid partial overrides', () => {
    const resolved = resolveBoardSettings({ scaleReal: 100, gridSubdivisions: 5 });
    expect(resolved.scaleReal).toBe(100);
    expect(resolved.gridSubdivisions).toBe(5);
    expect(resolved.scaleDrawing).toBe(1);
  });
});

describe('deriveBoardMeasurement', () => {
  it('derives the snap step from the paper sub-grid at 1:50', () => {
    // 10 paper-mm major grid, 10 subdivisions, 1:50 → 1 paper-mm minor
    // = 50 real mm snap step.
    const measurement = deriveBoardMeasurement(DEFAULT_BOARD_SETTINGS, 'mm');
    expect(measurement.paperPerRealRatio).toBeCloseTo(1 / 50);
    expect(measurement.minorGridPaperMm).toBeCloseTo(1);
    expect(measurement.minorGridRealMm).toBeCloseTo(50);
    expect(measurement.snapStepMm).toBeCloseTo(50);
    expect(measurement.sceneSnapPx).toBeCloseTo(50 * MM_TO_PX);
  });

  it('rescales the snap step when the page scale changes', () => {
    const at100 = deriveBoardMeasurement(
      { ...DEFAULT_BOARD_SETTINGS, scaleReal: 100 },
      'mm',
    );
    expect(at100.snapStepMm).toBeCloseTo(100);
  });

  it('uses real-world grid sizes directly in real mode', () => {
    const measurement = deriveBoardMeasurement(
      {
        ...DEFAULT_BOARD_SETTINGS,
        gridMode: 'real',
        majorGridRealMm: 1000,
        gridSubdivisions: 4,
      },
      'mm',
    );
    expect(measurement.majorGridRealMm).toBeCloseTo(1000);
    expect(measurement.snapStepMm).toBeCloseTo(250);
    // Paper size follows the scale: 1000 real mm at 1:50 = 20 paper mm.
    expect(measurement.majorGridPaperMm).toBeCloseTo(20);
  });

  it('formats lengths in the assigned display unit', () => {
    const measurement = deriveBoardMeasurement(DEFAULT_BOARD_SETTINGS, 'm');
    expect(measurement.formatLength(2500)).toBe('2.500 m');
  });
});

describe('boardSettingsToCanvasProps', () => {
  it('round-trips paper-mode grid values through the paper unit', () => {
    const props = boardSettingsToCanvasProps(DEFAULT_BOARD_SETTINGS, 'mm');
    expect(props.majorGridSize).toBeCloseTo(10);
    expect(props.gridMode).toBe('paper');
    expect(props.paperUnit).toBe('mm');
  });

  it('expresses real-mode grid values in the display unit', () => {
    const props = boardSettingsToCanvasProps(
      { ...DEFAULT_BOARD_SETTINGS, gridMode: 'real', majorGridRealMm: 1000 },
      'm',
    );
    expect(props.majorGridSize).toBeCloseTo(1);
    expect(props.gridMode).toBe('real');
  });

  it('expresses ruler ticks in the display unit for real ruler mode', () => {
    const props = boardSettingsToCanvasProps(
      { ...DEFAULT_BOARD_SETTINGS, rulerMode: 'real', majorTickRealMm: 1000 },
      'm',
    );
    expect(props.majorTickInterval).toBeCloseTo(1);
    expect(props.rulerMode).toBe('real');
  });
});
