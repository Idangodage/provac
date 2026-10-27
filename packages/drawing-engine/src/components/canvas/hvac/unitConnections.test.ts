import { describe, expect, it } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../data/ac-equipment-library';

import { drainConnectionOf, unitConnectionOf, unitConnectionsFor } from './unitConnections';

/** A library unit as placed: its size and default properties. */
function placed(definitionId: string) {
  const definition = DEFAULT_AC_EQUIPMENT_LIBRARY.find((entry) => entry.id === definitionId)!;
  return { width: definition.widthMm, depth: definition.depthMm, height: definition.heightMm, properties: { ...(definition.defaultProperties ?? {}) } };
}

const MAKER_UNITS = ['vrf-fdt28kxze1', 'vrf-fdum22kxe6f-w', 'vrf-fdum140kxe6f', 'vrf-fdum160kxe6f', 'vrf-fdu224kxze1', 'vrf-fdu280kxze1'];

describe('unitConnectionsFor', () => {
  it('finds the maker connections of every library indoor unit with maker data', () => {
    for (const id of MAKER_UNITS) expect(unitConnectionsFor(placed(id)), id).not.toBeNull();
    expect(unitConnectionsFor({ width: 1000, depth: 600, height: 300, properties: {} })).toBeNull();
  });

  it('keeps the drawn ports of a unit drawn at another size', () => {
    expect(unitConnectionsFor({ ...placed('vrf-fdum140kxe6f'), width: 1500 })).toBeNull();
  });

  it('holds the measured stubs (the FDT28 on its −x side, the FDUM140 stubs off its casing face, the FDU 80 mm out)', () => {
    const fdt = unitConnectionsFor(placed('vrf-fdt28kxze1'))!;
    expect(unitConnectionOf(fdt, 'gas')).toMatchObject({ y: -303, z: 208.9, axis: -1, tipX: -373.5, inModel: true });
    expect(unitConnectionOf(fdt, 'drain')).toMatchObject({ y: 333, axis: -1, tipX: -521.5, joint: 'hose' });
    expect(fdt.panel).toEqual({ sizeMm: 950, centre: { x: 47, y: 0 } });
    const fdum = unitConnectionsFor(placed('vrf-fdum160kxe6f'))!;
    expect(unitConnectionOf(fdum, 'gas')).toMatchObject({ y: -97, z: 145.5, axis: 1, rootX: 627, tipX: 696, inModel: false });
    expect(unitConnectionOf(fdum, 'liquid')).toMatchObject({ y: -35, z: 95.5, tipX: 686 });
    const fdu280 = unitConnectionsFor(placed('vrf-fdu280kxze1'))!;
    expect(unitConnectionOf(fdu280, 'gas')).toMatchObject({ y: 39.5, z: 214, tipX: 880, outerDiameterMm: 22.22, joint: 'brazed' });
    expect(unitConnectionOf(unitConnectionsFor(placed('vrf-fdu224kxze1'))!, 'gas')?.outerDiameterMm).toBe(19.05);
  });

  it('puts every stub on its unit: across within the depth, its tip within 100 mm of the end', () => {
    for (const id of MAKER_UNITS) {
      const unit = placed(id);
      for (const connection of unitConnectionsFor(unit)!.connections) {
        expect(Math.abs(connection.y), `${id} ${connection.kind}`).toBeLessThan(unit.depth / 2);
        expect(connection.z).toBeGreaterThan(0);
        expect(connection.z).toBeLessThan(unit.height);
        expect(Math.abs(connection.tipX)).toBeLessThanOrEqual(unit.width / 2 + 100);
        // The tip is out along the stub's axis from where it leaves the casing.
        expect((connection.tipX - connection.rootX) * connection.axis).toBeGreaterThan(0);
      }
    }
  });

  it('spaces gas and liquid so their insulated tubes clear at the stubs (25.4 mm insulation)', () => {
    // The field sizes: the FDT28 and FDUM22 run 1/2″ or 3/8″ gas with 1/4″ liquid; the others carry their own.
    const sizes: Record<string, [number, number]> = { 'vrf-fdt28kxze1': [12.7, 6.35], 'vrf-fdum22kxe6f-w': [9.52, 6.35] };
    for (const id of MAKER_UNITS) {
      const unit = placed(id);
      const set = unitConnectionsFor(unit)!;
      const gas = unitConnectionOf(set, 'gas')!;
      const liquid = unitConnectionOf(set, 'liquid')!;
      const [gasMm, liquidMm] = sizes[id] ?? [unit.properties.refrigerantGasPipeDiameterMm as number, unit.properties.refrigerantLiquidPipeDiameterMm as number];
      const needed = gasMm / 2 + 25.4 + liquidMm / 2 + 25.4;
      expect(Math.hypot(gas.y - liquid.y, gas.z - liquid.z), id).toBeGreaterThan(needed);
    }
  });

  it('drains a pumped FDUM from its pump outlet and a gravity one from its base; the FDU from its only socket', () => {
    const fdum = unitConnectionsFor(placed('vrf-fdum140kxe6f'))!;
    expect(drainConnectionOf(fdum, true)).toMatchObject({ kind: 'drain', z: 187.6, tipX: 842 });
    expect(drainConnectionOf(fdum, false)).toMatchObject({ kind: 'drain-gravity', z: 30, tipX: 583 });
    const fdu = unitConnectionsFor(placed('vrf-fdu224kxze1'))!;
    expect(drainConnectionOf(fdu, true)).toBe(drainConnectionOf(fdu, false));
    expect(drainConnectionOf(fdu, true)).toMatchObject({ z: 30, tipX: 837 });
  });
});
