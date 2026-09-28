import { describe, expect, it } from 'vitest';

import { resolveDuctSettings } from './ductSettings';
import {
  equivalentDiameterMm,
  frictionPaPerM,
  neckForAirflow,
  neckVelocityMs,
  readUnitAirData,
  shareAirflow,
  sizeRectangular,
  sizeRound,
  sizingLimits,
  velocityMs,
} from './ductSizing';

const settings = resolveDuctSettings({});
const supplyTrunk = sizingLimits(settings, 'supply', 'trunk');
const supplyRunout = sizingLimits(settings, 'supply', 'runout');

describe('duct sizing (equal friction, practice limits)', () => {
  it('matches the handbook equivalent diameter and friction rates', () => {
    // Huebscher: 600 × 200 → about 365 mm; a square duct a little over its side.
    expect(equivalentDiameterMm({ widthMm: 600, heightMm: 200 })).toBeCloseTo(365, 0);
    expect(equivalentDiameterMm({ widthMm: 300, heightMm: 300 })).toBeCloseTo(328, 0);
    // Ø200 at 300 m³/h: 2.65 m/s and about 0.5 Pa/m on the ASHRAE friction chart.
    expect(velocityMs({ widthMm: 200, heightMm: 200, diameterMm: 200 }, 300)).toBeCloseTo(2.65, 2);
    const friction = frictionPaPerM({ widthMm: 200, heightMm: 200, diameterMm: 200 }, 300);
    expect(friction).toBeGreaterThan(0.45);
    expect(friction).toBeLessThan(0.58);
    // Flexible duct is rougher.
    expect(frictionPaPerM({ widthMm: 200, heightMm: 200, diameterMm: 200 }, 300, 'flex')).toBeGreaterThan(friction * 1.3);
  });

  it('picks the smallest standard round size within both the friction target and the velocity cap', () => {
    // 150 m³/h: Ø125 runs at 3.4 m/s (over the 3 m/s runout cap); Ø150 at 2.4 m/s and 0.6 Pa/m.
    expect(sizeRound(150, supplyRunout, settings.autoRoundSizesMm)).toBe(150);
    expect(sizeRound(150, supplyRunout, settings.autoRoundSizesMm, { minimumMm: 200 })).toBe(200);
    expect(sizeRound(600, supplyRunout, settings.autoRoundSizesMm)).toBe(300);
  });

  it('sizes a rectangular trunk at a held height, raising it past 4:1 within the void', () => {
    // 600 m³/h at 250 high, no narrower than tall: 250 × 250 (0.39 Pa/m, 2.7 m/s).
    expect(sizeRectangular(600, 250, supplyTrunk, { minWidthMm: 250 })).toEqual({ widthMm: 250, heightMm: 250, capped: false });
    // 3000 m³/h cannot fit 150 high within 4:1; the height rises until it does.
    const big = sizeRectangular(3000, 150, supplyTrunk, { minWidthMm: 150, maxHeightMm: 400 });
    expect(big.capped).toBe(false);
    expect(big.heightMm).toBeGreaterThan(150);
    expect(big.widthMm / big.heightMm).toBeLessThanOrEqual(4);
    // No room to grow: the largest tried, flagged.
    expect(sizeRectangular(3000, 150, supplyTrunk, { minWidthMm: 150, maxHeightMm: 150 }).capped).toBe(true);
  });

  it('reads the FDUM22 airflow and fan pressure from the catalog and shares it between terminals', () => {
    const air = readUnitAirData({ properties: { modelCode: 'FDUM22KXE6F-W' } });
    expect(air.airflowM3h).toEqual({ 'p-hi': 780, hi: 600, me: 540, lo: 480 });
    expect(air.maxEspPa).toBe(100);
    expect(air.source).toBe('mhi-fdum22-data');
    expect(readUnitAirData({ properties: {} }).airflowM3h).toBeNull();
    expect(shareAirflow(600, [
      { id: 'a', spec: {} }, { id: 'b', spec: { designAirflowM3h: 300 } }, { id: 'c', spec: { designAirflowM3h: null } },
    ])).toEqual([
      { terminalId: 'a', airflowM3h: 150, fixed: false },
      { terminalId: 'b', airflowM3h: 300, fixed: true },
      { terminalId: 'c', airflowM3h: 150, fixed: false },
    ]);
  });

  it('checks neck velocity and proposes the neck that keeps it within the cap', () => {
    expect(neckVelocityMs({ neckDiameterMm: 150 }, 200)).toBeCloseTo(3.14, 2);
    expect(neckForAirflow(200, 3)).toBe(200);
    expect(neckForAirflow(5000, 3)).toBeNull();
  });
});
