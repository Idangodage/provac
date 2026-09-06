import { describe, expect, it } from 'vitest';

import {
  buildSmartDraftingFeedback,
  measureSmartDraftingVector,
} from './smartDraftingFeedback';

describe('measureSmartDraftingVector', () => {
  it('measures a horizontal 3D vector using its true length', () => {
    const metrics = measureSmartDraftingVector(
      { x: 0, y: 0, z: 1000 },
      { x: 3000, y: 4000, z: 1000 },
    );

    expect(metrics).toEqual({
      deltaXmm: 3000,
      deltaYmm: 4000,
      deltaZmm: 0,
      planLengthMm: 5000,
      lengthMm: 5000,
      slopePercent: 0,
      slopeKind: 'horizontal',
    });
  });

  it('reports signed slope from rise over plan length', () => {
    const ascending = measureSmartDraftingVector(
      { x: 0, y: 0, z: 0 },
      { x: 1000, y: 0, z: 100 },
    );
    const descending = measureSmartDraftingVector(
      { x: 0, y: 0, z: 100 },
      { x: 1200, y: 1600, z: 50 },
    );

    expect(ascending.lengthMm).toBeCloseTo(1004.987562);
    expect(ascending.slopePercent).toBeCloseTo(10);
    expect(ascending.slopeKind).toBe('sloped');
    expect(descending.planLengthMm).toBe(2000);
    expect(descending.slopePercent).toBeCloseTo(-2.5);
    expect(descending.slopeKind).toBe('sloped');
  });

  it('distinguishes a vertical vector from a zero-length point', () => {
    const vertical = measureSmartDraftingVector(
      { x: 100, y: 200, z: 0 },
      { x: 100, y: 200, z: 800 },
    );
    const point = measureSmartDraftingVector(
      { x: 10, y: 20, z: 30 },
      { x: 10, y: 20, z: 30 },
    );

    expect(vertical).toMatchObject({
      planLengthMm: 0,
      lengthMm: 800,
      slopePercent: null,
      slopeKind: 'vertical',
    });
    expect(point).toMatchObject({
      lengthMm: 0,
      slopePercent: null,
      slopeKind: 'point',
    });
  });

  it('rejects non-finite coordinates and overflowing vectors', () => {
    expect(() => measureSmartDraftingVector(
      { x: Number.NaN, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
    )).toThrowError('anchor.x must be a finite number');

    expect(() => measureSmartDraftingVector(
      { x: -Number.MAX_VALUE, y: 0, z: 0 },
      { x: Number.MAX_VALUE, y: 0, z: 0 },
    )).toThrowError('deltaXmm is outside the supported numeric range');
  });
});

describe('buildSmartDraftingFeedback', () => {
  it('formats quiet horizontal drafting feedback for cursor and HUD use', () => {
    const feedback = buildSmartDraftingFeedback({
      anchor: { x: 0, y: 0, z: 1000 },
      current: { x: 3000, y: 4000, z: 1000 },
      workplaneKind: 'floor',
    });

    expect(feedback.lengthText).toBe('5.00 m');
    expect(feedback.deltaZText).toBe('0 mm');
    expect(feedback.slopeText).toBe('Slope 0.0%');
    expect(feedback.metricsText).toBe('L 5.00 m · ΔZ 0 mm · Slope 0.0%');
    expect(feedback.label).toBe('Floor');
    expect(feedback.keyboardHint).toBe('Shift axis · Enter accept · Esc cancel');
    expect(feedback.nearCursor).toEqual({
      label: 'Floor',
      metrics: 'L 5.00 m · ΔZ 0 mm · Slope 0.0%',
      hint: 'Shift axis · Enter accept · Esc cancel',
    });
    expect(feedback.hudRows).toEqual([
      { key: 'length', label: 'Length', value: '5.00 m' },
      { key: 'delta-z', label: 'ΔZ', value: '0 mm' },
      { key: 'slope', label: 'Slope', value: '0.0%' },
    ]);
  });

  it('combines workplane, constraint, semantic snap and ambiguity cues', () => {
    const feedback = buildSmartDraftingFeedback({
      anchor: { x: 0, y: 0, z: 0 },
      current: { x: 1000, y: 0, z: 100 },
      workplaneKind: 'floor',
      axisConstraint: 'world-x',
      snap: {
        kind: 'equipment-port',
        message: 'Gas port AHU-2',
      },
      ambiguityCount: 3,
    });

    expect(feedback.metricsText).toBe('L 1.00 m · ΔZ +100 mm · Slope 10.0%');
    expect(feedback.label).toBe('Floor · X lock · Gas port AHU-2');
    expect(feedback.keyboardHint).toBe(
      'Tab cycle 3 · Alt free · Enter accept · Esc cancel',
    );
    expect(feedback.ariaLabel).toBe(
      'Floor · X lock · Gas port AHU-2. '
      + 'L 1.00 m · ΔZ +100 mm · Slope 10.0%. '
      + 'Tab cycle 3 · Alt free · Enter accept · Esc cancel',
    );
  });

  it('uses semantic fallbacks and handles vertical and zero-length states', () => {
    const vertical = buildSmartDraftingFeedback({
      anchor: { x: 0, y: 0, z: 0 },
      current: { x: 0, y: 0, z: 800 },
      workplaneKind: 'equipment-face',
      axisConstraint: 'local-y',
      snap: { kind: 'pipe-endpoint' },
    });
    const point = buildSmartDraftingFeedback({
      anchor: { x: 10, y: 20, z: 30 },
      current: { x: 10, y: 20, z: 30 },
      workplaneKind: 'wall',
    });

    expect(vertical.label).toBe(
      'Equipment face · Local Y lock · Pipe endpoint',
    );
    expect(vertical.metricsText).toBe('L 800 mm · ΔZ +800 mm · Vertical');
    expect(vertical.hudRows[2]).toEqual({
      key: 'slope',
      label: 'Slope',
      value: 'Vertical',
    });
    expect(point.metricsText).toBe('L 0 mm · ΔZ 0 mm · Slope —');
  });

  it('bounds and sanitizes untrusted semantic messages and candidate counts', () => {
    const feedback = buildSmartDraftingFeedback({
      anchor: { x: 0, y: 0, z: 0 },
      current: { x: 100, y: 0, z: 0 },
      workplaneKind: 'camera-facing',
      axisConstraint: 'local-x',
      snap: {
        kind: 'guide',
        message: `  Supply\nport\u0000${'x'.repeat(100)}  `,
      },
      ambiguityCount: 1000,
    });

    expect(feedback.label.length).toBeLessThanOrEqual(80);
    expect(feedback.label).not.toContain('\n');
    expect(feedback.label).not.toContain('\u0000');
    expect(feedback.label).toContain('Supply port');
    expect(feedback.label.endsWith('…')).toBe(true);
    expect(feedback.keyboardHint).toBe(
      'Tab cycle 99+ · Alt free · Enter accept · Esc cancel',
    );
  });
});
