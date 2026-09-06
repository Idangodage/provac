import { describe, expect, it } from 'vitest';

import { resolveCopperSocketElbow } from './copperSocketElbows';
import { resolvePipeRoutingSettings } from './pipeRoutingSettings';

describe('copper CxC dimensional profiles', () => {
  it('uses independent published 90 and 45 body, cup and insertion dimensions', () => {
    const right = resolveCopperSocketElbow(12.7, 90)!;
    const obtuse = resolveCopperSocketElbow(12.7, 45)!;
    expect(right).toMatchObject({ centerlineRadiusMm: 8.5, centerToFaceMm: 20, insertionDepthMm: 10,
      socketInsideDiameterMm: 12.75, socketOutsideDiameterMm: 14.35, bodyOutsideDiameterMm: 12.7 });
    expect(obtuse).toMatchObject({ centerlineRadiusMm: 10.8, centerToFaceMm: 16, insertionDepthMm: 10 });
    expect(right.centerlineRadiusMm).not.toBe(right.centerToFaceMm - right.insertionDepthMm);
  });
  it.each([[9.525, 9.52], [15.875, 15.88], [22.225, 22.23]])('records the explicit imperial drawing label for %s mm without changing tube OD', (actual, label) => {
    const spec = resolveCopperSocketElbow(actual!, 45)!;
    expect(spec.tubeOutsideDiameterMm).toBe(actual);
    expect(spec.catalogueTubeSizeMm).toBe(label);
    expect(spec.sizeMatch).toBe('rounded-imperial');
    expect(spec.socketInsideDiameterMm).toBeGreaterThan(actual!);
  });
  it.each([19.05, 31.75, 34.925, 38.1, 41.275])('uses identified planning dimensions for %s mm rather than choosing the nearest nominal product', tubeOD => {
    const spec = resolveCopperSocketElbow(tubeOD, 90)!;
    expect(spec.dimensionBasis).toBe('planning');
    expect(spec.catalogueModel).toBeUndefined();
    expect(spec.tubeOutsideDiameterMm).toBe(tubeOD);
    expect(spec.socketInsideDiameterMm).toBeGreaterThan(tubeOD);
    expect(spec.centerToFaceMm - spec.centerlineRadiusMm).toBeGreaterThan(spec.insertionDepthMm);
  });
  it('does not select the inconsistent compact 15.88 row', () => {
    const spec = resolveCopperSocketElbow(15.875, 90)!;
    expect(spec.catalogueModel).toBe('LD-15.88');
    expect(spec).toMatchObject({ centerlineRadiusMm: 27, centerToFaceMm: 38, insertionDepthMm: 12 });
  });
  it('rejects unsupported angles and malformed outside diameters', () => {
    for (const diameter of [NaN, Infinity, -12.7, 0]) expect(resolveCopperSocketElbow(diameter, 90)).toBeNull();
    expect(resolveCopperSocketElbow(12.7, 30)).toBeNull();
    expect(resolveCopperSocketElbow(12.7, 180)).toBeNull();
  });
  it('restores a valid fitting presentation from saved and legacy settings', () => {
    expect(resolvePipeRoutingSettings({ fittingDisplay: 'insulated' }).fittingDisplay).toBe('insulated');
    expect(resolvePipeRoutingSettings({}).fittingDisplay).toBe('copper');
    expect(resolvePipeRoutingSettings({ fittingDisplay: 'unknown' as 'copper' }).fittingDisplay).toBe('copper');
  });
});
