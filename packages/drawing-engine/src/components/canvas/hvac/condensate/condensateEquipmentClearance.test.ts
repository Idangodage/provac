import { describe, expect, it } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../../data/ac-equipment-library';
import type { HvacElement } from '../../../../types';
import { findNewNetworkPipeClashes } from '../networkPipeClearance';

import { generateCondensateNetwork } from './condensateGenerator';
import { getIndoorUnitDrainPort } from './condensatePorts';
import { resolveCondensateSettings } from './condensateSettings';
import { readCondensatePipeSpec, type Point3 } from './condensateTypes';

const catalog = DEFAULT_AC_EQUIPMENT_LIBRARY.find(item => item.id === 'vrf-fdt28kxze1')!;
function cassette(id: string, x: number, y: number, rotation = 0): HvacElement {
  return { id, type: catalog.type, subtype: catalog.subtype, label: catalog.name,
    modelLabel: catalog.modelLabel, position: { x, y }, width: catalog.widthMm, depth: catalog.depthMm,
    height: catalog.heightMm, elevation: catalog.elevationMm, rotation, mountType: catalog.mountType,
    supplyZoneRatio: catalog.supplyZoneRatio ?? 0.5, properties: { ...catalog.defaultProperties } };
}
/** The plan x of a box `width` wide starting `gap` out along a drain outlet's (±x) direction. */
function outAlong(port: { point: { x: number }; direction: { x: number } }, gap: number, width: number): number {
  return port.direction.x > 0 ? port.point.x + gap : port.point.x - gap - width;
}
function sink(x: number, y: number): HvacElement {
  return { ...cassette('sink', x - 100, y - 100), type: 'condensate-gully', label: 'Drain sink', width: 200, depth: 200,
    height: 60, elevation: 0, properties: { terminationKind: 'floor-gully' } };
}

describe('catalog cassette drain coordination', () => {
  it.each(['always', 'when-needed', 'never'] as const)('clears its FDT cassette with %s lift policy', pumpPolicy => {
    const unit = cassette('cassette', 0, 0);
    const scene = [unit, sink(6000, 400)];
    const settings = resolveCondensateSettings({ pumpPolicy });
    const result = generateCondensateNetwork(scene, { settings });
    const clashes = findNewNetworkPipeClashes(scene, result.elementsToAdd, result.removeElementIds);
    expect(result.metrics.unitsConnected).toBe(1);
    expect(clashes).toEqual([]);
  });

  it.each([0, 45, 90, 180, 270])('keeps a falling source departure clear at %s degrees', rotation => {
    const unit = cassette('cassette', 0, 0, rotation);
    const port = getIndoorUnitDrainPort(unit)!;
    const scene = [unit, sink(port.point.x + port.direction.x * 5000, port.point.y + port.direction.y * 5000)];
    const result = generateCondensateNetwork(scene, { settings: resolveCondensateSettings({ pumpPolicy: 'never' }) });
    expect(result.metrics.unitsConnected).toBe(1);
    expect(findNewNetworkPipeClashes(scene, result.elementsToAdd)).toEqual([]);
    for (const element of result.elementsToAdd) {
      const nodes = readCondensatePipeSpec(element).routeNodes3d;
      for (let index = 1; index < nodes.length; index++) {
        const a = nodes[index - 1]!; const b = nodes[index]!;
        expect(a.z - b.z).toBeGreaterThanOrEqual(Math.hypot(b.x - a.x, b.y - a.y) * 0.01 - 0.01);
      }
    }
  });

  it('routes five FDT units with four pump lifts and one gravity connection', () => {
    const units = [[500, 500], [3500, 500], [6500, 500], [500, 3000], [8500, 3000]]
      .map(([x, y], index) => cassette(`cassette-${index}`, x!, y!));
    units[4]!.properties.hasDrainPump = false;
    const scene = [...units, sink(11000, 5000)];
    const settings = resolveCondensateSettings({ soffitMm: 3000 });
    const result = generateCondensateNetwork(scene, { settings });
    expect(result.metrics.unitsConnected, JSON.stringify(result.perUnit)).toBe(5);
    expect(result.metrics.pumpedUnits).toBe(4);
    expect(findNewNetworkPipeClashes(scene, result.elementsToAdd)).toEqual([]);
  });

  it('moves the hose and riser together around a solid near the real outlet', () => {
    const unit = cassette('cassette', 0, 0);
    const port = getIndoorUnitDrainPort(unit)!;
    // 110–130 mm out along the outlet (the FDT28's leaves its −x side).
    const obstruction: HvacElement = { ...unit, id: 'bracket', type: 'accessory', label: 'Bracket',
      position: { x: outAlong(port, 110, 20), y: port.point.y - 10 }, width: 20, depth: 20,
      elevation: port.z - 30, height: 60, properties: {} };
    const scene = [unit, obstruction, sink(6000, 400)];
    // Check physical solids separately from the project's optional access gap.
    const result = generateCondensateNetwork(scene, { settings: resolveCondensateSettings({ equipmentClearanceMm: 0 }) });
    expect(result.metrics.unitsConnected, JSON.stringify(result.perUnit)).toBe(1);
    const branch = result.elementsToAdd.find(element => readCondensatePipeSpec(element).drainStart?.unitId === unit.id)!;
    const foot = readCondensatePipeSpec(branch).routeNodes3d[1]!;
    expect(Math.abs(foot.y - port.point.y)).toBeGreaterThan(25);
    expect(findNewNetworkPipeClashes(scene, result.elementsToAdd)).toEqual([]);
  });

  it('reports a blocked outlet instead of drawing a hose through a solid', () => {
    const unit = cassette('cassette', 0, 0);
    const port = getIndoorUnitDrainPort(unit)!;
    const obstruction: HvacElement = { ...unit, id: 'panel', type: 'control-panel', label: 'Panel',
      position: { x: outAlong(port, 45, 20), y: port.point.y - 300 }, width: 20, depth: 600,
      elevation: port.z - 150, height: 300, properties: {} };
    const scene = [unit, obstruction, sink(6000, 400)];
    const result = generateCondensateNetwork(scene, { settings: resolveCondensateSettings({}) });
    expect(result.metrics.unitsConnected).toBe(0);
    expect(result.elementsToAdd).toEqual([]);
    expect(result.perUnit).toEqual([expect.objectContaining({ status: 'infeasible',
      reason: 'no unobstructed connection from the drain outlet' })]);
  });

  it('continues rejecting upward, sideways and returning routes through a cassette casing', () => {
    const unit = cassette('cassette', 0, 0);
    const port = getIndoorUnitDrainPort(unit)!;
    const scene = [unit, sink(6000, 400)];
    const result = generateCondensateNetwork(scene, { settings: resolveCondensateSettings({ pumpPolicy: 'never' }) });
    const branch = result.elementsToAdd.find(element => readCondensatePipeSpec(element).drainStart?.unitId === unit.id)!;
    const start = { ...port.point, z: port.z };
    // `inward` runs from the outlet back towards the casing (the FDT28's outlet leaves its −x side).
    const inward = (distance: number) => start.x - port.direction.x * distance;
    const routes: Point3[][] = [
      [start, { ...start, x: inward(250) }, { ...start, x: inward(250), z: start.z + 200 }],
      [start, { ...start, y: start.y - 300 }, { ...start, x: inward(500), y: start.y - 300 }],
      [start, { ...start, x: inward(-500), z: start.z - 10 },
        { ...start, x: inward(-500), y: start.y - 300, z: start.z - 20 },
        { ...start, x: inward(250), y: start.y - 300, z: start.z - 30 }],
    ];
    for (const nodes of routes) {
      const changed = { ...branch, properties: { ...branch.properties, routeNodes3d: nodes } };
      expect(findNewNetworkPipeClashes(scene, [changed])).toEqual([
        expect.objectContaining({ elementIds: [unit.id, branch.id].sort() }),
      ]);
    }
  });
});
