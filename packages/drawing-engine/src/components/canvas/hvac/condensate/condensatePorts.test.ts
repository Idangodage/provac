import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { buildCeilingCassetteModel, getCeilingCassettePipePortEndpointLocal } from '../ceilingCassetteModel';
import { buildDuctedIndoorUnitModel } from '../ductedIndoorUnitModel';

import { getIndoorUnitDrainPort } from './condensatePorts';

function unit(type: HvacElement['type'], overrides: Partial<HvacElement> = {}): HvacElement {
  return {
    id: `${type}-1`,
    type,
    position: { x: 1000, y: 2000 },
    rotation: 0,
    width: 950,
    depth: 950,
    height: 272,
    elevation: 2400,
    mountType: 'ceiling',
    label: type,
    supplyZoneRatio: 0.5,
    properties: { capacityKw: 2.8 },
    ...overrides,
  };
}

describe('getIndoorUnitDrainPort', () => {
  it('puts a cassette drain at the rendered port tip', () => {
    const cassette = unit('ceiling-cassette-ac');
    const drain = buildCeilingCassetteModel(cassette).pipePorts.find((port) => port.kind === 'drain')!;
    const tip = getCeilingCassettePipePortEndpointLocal(drain);
    const port = getIndoorUnitDrainPort(cassette)!;
    expect(port.point.x).toBeCloseTo(1000 + 475 + tip.x, 6);
    expect(port.point.y).toBeCloseTo(2000 + 475 + tip.y, 6);
    expect(port.z).toBeCloseTo(2400 + drain.z, 6);
    expect(port.direction).toEqual({ x: 1, y: 0 });
    expect(port.hasDrainPump).toBe(true);
    expect(port.pumpMaxLiftMm).toBe(600);
    expect(port.negativePressure).toBe(false);
    expect(port.capacityKw).toBe(2.8);
    expect(port.synthesized).toBe(false);
  });

  it('rotates the port about the unit centre', () => {
    const base = getIndoorUnitDrainPort(unit('ceiling-cassette-ac'))!;
    const rotated = getIndoorUnitDrainPort(unit('ceiling-cassette-ac', { rotation: 90 }))!;
    const center = { x: 1475, y: 2475 };
    const local = { x: base.point.x - center.x, y: base.point.y - center.y };
    expect(rotated.point.x).toBeCloseTo(center.x - local.y, 6);
    expect(rotated.point.y).toBeCloseTo(center.y + local.x, 6);
    expect(rotated.direction.x).toBeCloseTo(0, 9);
    expect(rotated.direction.y).toBeCloseTo(1, 9);
    expect(rotated.z).toBeCloseTo(base.z, 9);
  });

  it('handles ducted units: gravity by default, negative-pressure pan', () => {
    const ducted = unit('ducted-ac', { width: 1084, depth: 697, height: 300 });
    const drain = buildDuctedIndoorUnitModel(ducted).pipePorts.find((port) => port.kind === 'drain')!;
    const port = getIndoorUnitDrainPort(ducted)!;
    expect(port.point.x).toBeCloseTo(1000 + 542 + drain.x + drain.collarLength + drain.length - drain.flangeThickness * 0.15, 6);
    expect(port.z).toBeCloseTo(2400 + drain.z, 6);
    expect(port.hasDrainPump).toBe(false);
    expect(port.pumpMaxLiftMm).toBe(0);
    expect(port.negativePressure).toBe(true);
  });

  it('honours per-unit drain overrides', () => {
    const port = getIndoorUnitDrainPort(unit('ducted-ac', {
      properties: { hasDrainPump: true, drainPumpMaxLiftMm: 700, drainOutletDiameterMm: 26 },
    }))!;
    expect(port.hasDrainPump).toBe(true);
    expect(port.pumpMaxLiftMm).toBe(700);
    expect(port.outletOuterDiameterMm).toBe(26);
    // A pumped unit no longer needs a negative-pressure trap by default.
    expect(port.negativePressure).toBe(false);
  });

  it('synthesises ports for unit types without a drawn drain', () => {
    const wall = getIndoorUnitDrainPort(unit('wall-mounted-ac', { width: 900, depth: 250, height: 320, elevation: 2100 }))!;
    expect(wall.synthesized).toBe(true);
    expect(wall.z).toBeLessThan(2100 + 100);
    expect(getIndoorUnitDrainPort(unit('outdoor-unit'))).toBeNull();
    expect(getIndoorUnitDrainPort(unit('condensate-gully'))).toBeNull();
  });
});
