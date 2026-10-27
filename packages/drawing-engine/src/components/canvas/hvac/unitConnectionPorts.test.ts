import { describe, expect, it } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../data/ac-equipment-library';
import type { HvacElement } from '../../../types';

import { buildCeilingCassetteModel } from './ceilingCassetteModel';
import { getIndoorUnitDrainPort } from './condensate/condensatePorts';
import { equipmentBoxOf } from './duct/ductVolumes';
import { buildDuctedIndoorUnitModel } from './ductedIndoorUnitModel';
import { getRefrigerantPipeBundleSnapTargets } from './refrigerantPipePairModel';
import { drainConnectionOf, unitConnectionOf, unitConnectionsFor } from './unitConnections';

/** A library unit placed with its centre at (5000, 3000), turned `rotation`. */
function place(definitionId: string, rotation = 0, properties: Record<string, unknown> = {}): HvacElement {
  const definition = DEFAULT_AC_EQUIPMENT_LIBRARY.find((entry) => entry.id === definitionId)!;
  return {
    id: definitionId, type: definition.type, position: { x: 5000 - definition.widthMm / 2, y: 3000 - definition.depthMm / 2 },
    rotation, width: definition.widthMm, depth: definition.depthMm, height: definition.heightMm, elevation: 2600,
    mountType: 'ceiling', label: definition.name, supplyZoneRatio: 0.5,
    properties: { ...(definition.defaultProperties ?? {}), ...properties },
  } as HvacElement;
}

/** A unit-frame point in world plan coordinates for the unit placed by `place`. */
function world(local: { x: number; y: number }, rotation: number) {
  const angle = (rotation * Math.PI) / 180;
  return { x: 5000 + local.x * Math.cos(angle) - local.y * Math.sin(angle), y: 3000 + local.x * Math.sin(angle) + local.y * Math.cos(angle) };
}

const MAKER_UNITS = ['vrf-fdt28kxze1', 'vrf-fdum22kxe6f-w', 'vrf-fdum140kxe6f', 'vrf-fdum160kxe6f', 'vrf-fdu224kxze1', 'vrf-fdu280kxze1'];

describe('maker connections drive the ports', () => {
  it('starts the refrigerant pair on the maker stubs, along them, at every turn', () => {
    for (const id of MAKER_UNITS) {
      for (const rotation of [0, 90, 180, 270]) {
        const unit = place(id, rotation);
        const set = unitConnectionsFor(unit)!;
        const gas = unitConnectionOf(set, 'gas')!;
        const liquid = unitConnectionOf(set, 'liquid')!;
        const target = getRefrigerantPipeBundleSnapTargets([unit]).find((entry) => entry.connectionKind === 'unit-port')!;
        const label = `${id} at ${rotation}°`;
        const gasAt = world({ x: gas.tipX, y: gas.y }, rotation);
        const liquidAt = world({ x: liquid.tipX, y: liquid.y }, rotation);
        expect(target.gasPoint.x, label).toBeCloseTo(gasAt.x, 6);
        expect(target.gasPoint.y, label).toBeCloseTo(gasAt.y, 6);
        expect(target.liquidPoint.x, label).toBeCloseTo(liquidAt.x, 6);
        expect(target.liquidPoint.y, label).toBeCloseTo(liquidAt.y, 6);
        expect(target.gasElevationMm, label).toBeCloseTo(2600 + gas.z, 6);
        expect(target.liquidElevationMm, label).toBeCloseTo(2600 + liquid.z, 6);
        const out = world({ x: gas.axis, y: 0 }, rotation);
        expect(target.direction.x, label).toBeCloseTo(out.x - 5000, 9);
        expect(target.direction.y, label).toBeCloseTo(out.y - 3000, 9);
      }
    }
  });

  it('leaves the FDT28 from its −x side, not the drawn +x one', () => {
    const target = getRefrigerantPipeBundleSnapTargets([place('vrf-fdt28kxze1')]).find((entry) => entry.connectionKind === 'unit-port')!;
    expect(target.direction).toEqual({ x: -1, y: 0 });
    expect(target.gasPoint.x).toBeCloseTo(5000 - 373.5, 6);
    const port = getIndoorUnitDrainPort(place('vrf-fdt28kxze1'))!;
    expect(port.direction.x).toBeCloseTo(-1, 9);
    expect(port.point.x).toBeCloseTo(5000 - 521.5, 6);
    expect(port.hoseInModel).toBe(true);
  });

  it('drains from the pump outlet (end of the maker hose) when pumped, from the base outlet on gravity', () => {
    for (const rotation of [0, 90, 180, 270]) {
      const pumped = getIndoorUnitDrainPort(place('vrf-fdum140kxe6f', rotation))!;
      const set = unitConnectionsFor(place('vrf-fdum140kxe6f'))!;
      const outlet = drainConnectionOf(set, true)!;
      const at = world({ x: outlet.tipX, y: outlet.y }, rotation);
      expect(pumped.point.x).toBeCloseTo(at.x, 6);
      expect(pumped.point.y).toBeCloseTo(at.y, 6);
      expect(pumped.z).toBeCloseTo(2600 + outlet.z, 6);
      expect(pumped.hasDrainPump).toBe(true);
      expect(pumped.hoseInModel).toBe(true);
      // The field drain is VP25 through the hose's socket.
      expect(pumped.outletOuterDiameterMm).toBe(32);
    }
    const gravity = getIndoorUnitDrainPort(place('vrf-fdum140kxe6f', 0, { hasDrainPump: false, drainPumpSetBy: 'user' }))!;
    expect(gravity.z).toBeCloseTo(2600 + 30, 6);
    expect(gravity.point.x).toBeCloseTo(5000 + 583, 6);
    expect(gravity.hoseInModel).toBe(false);
    const fdu = getIndoorUnitDrainPort(place('vrf-fdu224kxze1'))!;
    expect(fdu.point.x).toBeCloseTo(5000 + 837, 6);
    expect(fdu.z).toBeCloseTo(2600 + 30, 6);
    expect(fdu.hasDrainPump).toBe(true);
  });

  it('keeps generic units on their drawn ports', () => {
    const generic = { ...place('vrf-fdum140kxe6f'), properties: { capacityKw: 14 } } as HvacElement;
    const target = getRefrigerantPipeBundleSnapTargets([generic]).find((entry) => entry.connectionKind === 'unit-port')!;
    expect(target.direction).toEqual({ x: 1, y: 0 });
    expect(buildDuctedIndoorUnitModel(generic).pipePorts.every((port) => port.axis === undefined)).toBe(true);
  });
});

describe('the maker body', () => {
  it('draws the FDT28 panel at its true centre, and its stubs as the model has them', () => {
    const model = buildCeilingCassetteModel(place('vrf-fdt28kxze1'));
    expect(model.panelCentre).toEqual({ x: 47, y: 0 });
    expect(model.panelSize).toBe(950);
    expect(model.facePanel.x).toBeCloseTo(47, 9);
    expect(model.pipePorts.map((port) => [port.kind, port.axis, port.inModel])).toEqual([
      ['gas', -1, true], ['liquid', -1, true], ['drain', -1, true]]);
  });

  it('fits the drawn ducted body to the maker casing, and its casing is what pipes keep out of', () => {
    const unit = place('vrf-fdum140kxe6f');
    const model = buildDuctedIndoorUnitModel(unit);
    expect(model.casingInset.x).toBeCloseTo(-58, 6);
    expect(model.casingInset.width).toBeCloseTo(1370, 6);
    expect(model.baseWidth).toBe(1684);
    // The model's own flare stubs are missing: drawn from the maker's data.
    expect(model.pipePorts.filter((port) => port.inModel === false).map((port) => port.kind)).toEqual(['gas', 'liquid']);
    const body = equipmentBoxOf(unit)!;
    expect(body.halfLength).toBeCloseTo(685, 6);
    expect(body.halfWidth).toBeCloseTo(370, 6);
    expect(body.centre.x).toBeCloseTo(5000 - 58, 6);
  });
});
