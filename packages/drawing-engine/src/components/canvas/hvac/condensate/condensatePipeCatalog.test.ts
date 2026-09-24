import { describe, expect, it } from 'vitest';

import {
  CONDENSATE_PIPE_SYSTEMS,
  manningCapacityLitresPerHour,
  minimumInnerDiameterForCapacity,
  selectCondensatePipeSize,
} from './condensatePipeCatalog';
import { DEFAULT_CONDENSATE_SETTINGS, formatFallRatio, resolveCondensateSettings } from './condensateSettings';

const settings = DEFAULT_CONDENSATE_SETTINGS;

describe('condensate capacity sizing table', () => {
  it('maps connected capacity to the IMC/UPC minimum internal diameter', () => {
    expect(minimumInnerDiameterForCapacity(20, settings).minInnerDiameterMm).toBeCloseTo(19.05);
    expect(minimumInnerDiameterForCapacity(70.3, settings).minInnerDiameterMm).toBeCloseTo(19.05);
    expect(minimumInnerDiameterForCapacity(70.4, settings).minInnerDiameterMm).toBeCloseTo(25.4);
    expect(minimumInnerDiameterForCapacity(300, settings).minInnerDiameterMm).toBeCloseTo(31.75);
    expect(minimumInnerDiameterForCapacity(879.2, settings).minInnerDiameterMm).toBeCloseTo(50.8);
    expect(minimumInnerDiameterForCapacity(2000, settings).beyondTable).toBe(true);
  });
});

describe('selectCondensatePipeSize', () => {
  const base = { upstreamCapacityKw: 10, largestOutletOuterDiameterMm: 32, upstreamUnitCount: 1, slopePercent: 1 };

  it('never goes below the unit outlet', () => {
    const selection = selectCondensatePipeSize(base, settings);
    expect(selection.size.outerDiameterMm).toBeGreaterThanOrEqual(31);
    expect(selection.size.nominalSize).toBe('32');
  });

  it('upsizes with connected capacity', () => {
    const small = selectCondensatePipeSize({ ...base, upstreamCapacityKw: 60 }, settings);
    const large = selectCondensatePipeSize({ ...base, upstreamCapacityKw: 200 }, settings);
    expect(large.size.innerDiameterMm).toBeGreaterThan(small.size.innerDiameterMm);
    expect(large.size.innerDiameterMm).toBeGreaterThanOrEqual(31.75);
  });

  it('honours the downstream-monotone floor', () => {
    const selection = selectCondensatePipeSize({ ...base, minimumOuterDiameterMm: 40 }, settings);
    expect(selection.size.outerDiameterMm).toBeGreaterThanOrEqual(40);
  });

  it('applies the grouped-main minimum only to collective pipes', () => {
    const grouped = resolveCondensateSettings({ groupedMainMinOuterDiameterMm: 40 });
    expect(selectCondensatePipeSize({ ...base, upstreamUnitCount: 1 }, grouped).size.outerDiameterMm).toBe(32);
    expect(selectCondensatePipeSize({ ...base, upstreamUnitCount: 3 }, grouped).size.outerDiameterMm).toBe(40);
  });

  it('selects from the chosen pipe system', () => {
    const jis = resolveCondensateSettings({ pipeSystem: 'jis-vp' });
    expect(selectCondensatePipeSize(base, jis).size.nominalSize).toBe('VP25');
    const astm = resolveCondensateSettings({ pipeSystem: 'astm-sch40' });
    expect(selectCondensatePipeSize({ ...base, largestOutletOuterDiameterMm: 20 }, astm).size.nominalSize).toBe('3/4"');
  });

  it('reports a hydraulic capacity far above the design condensate flow', () => {
    const selection = selectCondensatePipeSize(base, settings);
    expect(selection.designFlowLitresPerHour).toBeCloseTo(5);
    expect(selection.capacityLitresPerHour).toBeGreaterThan(selection.designFlowLitresPerHour * 50);
  });
});

describe('Manning partial flow', () => {
  it('grows with slope and fill', () => {
    const shallow = manningCapacityLitresPerHour(28.4, 1, 0.5, 0.009);
    const steep = manningCapacityLitresPerHour(28.4, 2, 0.5, 0.009);
    const fuller = manningCapacityLitresPerHour(28.4, 1, 0.75, 0.009);
    expect(steep / shallow).toBeCloseTo(Math.SQRT2, 3);
    expect(fuller).toBeGreaterThan(shallow);
    // Half-full 28.4 mm ID PVC at 1 %: Q = (1/n)·A·R^(2/3)·√S ≈ 0.13 L/s ≈ 468 L/h.
    expect(shallow).toBeCloseTo(468, 0);
  });

  it('is zero for a level or invalid pipe', () => {
    expect(manningCapacityLitresPerHour(28.4, 0, 0.5, 0.009)).toBe(0);
    expect(manningCapacityLitresPerHour(0, 1, 0.5, 0.009)).toBe(0);
  });
});

describe('catalogue + settings hygiene', () => {
  it('every system is ordered by size', () => {
    for (const system of Object.values(CONDENSATE_PIPE_SYSTEMS)) {
      for (let index = 1; index < system.sizes.length; index += 1) {
        expect(system.sizes[index]!.innerDiameterMm).toBeGreaterThan(system.sizes[index - 1]!.innerDiameterMm);
        expect(system.sizes[index]!.innerDiameterMm).toBeLessThan(system.sizes[index]!.outerDiameterMm);
      }
    }
  });

  it('drops corrupt settings field by field', () => {
    const resolved = resolveCondensateSettings({ minSlopePercent: Number.NaN, preferredSlopePercent: 0.5, pipeSystem: 'bogus' as never });
    expect(resolved.minSlopePercent).toBe(1);
    // Preferred can never be flatter than the minimum.
    expect(resolved.preferredSlopePercent).toBe(1);
    expect(resolved.pipeSystem).toBe('bs-en-1329');
  });

  it('formats fall ratios as drafters write them', () => {
    expect(formatFallRatio(1)).toBe('1:100');
    expect(formatFallRatio(2)).toBe('1:50');
    expect(formatFallRatio(0)).toBe('level');
  });
});
