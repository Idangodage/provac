// Drains at the maker's outlet (27 October 2026): a pumped unit drains from its pump's outlet — at the end of the hose
// the maker supplies, which its model already shows — a gravity one from its base outlet; the drain's first run never
// dips below the outlet, and a concealed unit's pump lifts it into the void even from an outlet below it.
import { describe, expect, it } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../../data/ac-equipment-library';
import type { HvacElement, Point2D } from '../../../../types';
import { buildRefrigerantPipeElements, getRefrigerantPipeBundleSnapTargets } from '../refrigerantPipePairModel';

import { generateCondensateNetwork } from './condensateGenerator';
import { getIndoorUnitDrainPort } from './condensatePorts';
import { resolveCondensateSettings } from './condensateSettings';
import { readCondensatePipeSpec } from './condensateTypes';
import { findCondensateRefrigerantClashes } from './condensateValidation';

const settings = resolveCondensateSettings({ soffitMm: 3300 });

function place(definitionId: string, centre: Point2D, rotation = 0, properties: Record<string, unknown> = {}): HvacElement {
  const definition = DEFAULT_AC_EQUIPMENT_LIBRARY.find((entry) => entry.id === definitionId)!;
  return {
    id: definitionId, type: definition.type, category: 'indoor-unit', rotation,
    position: { x: centre.x - definition.widthMm / 2, y: centre.y - definition.depthMm / 2 },
    width: definition.widthMm, depth: definition.depthMm, height: definition.heightMm, elevation: 2400,
    mountType: 'ceiling', label: definition.name, supplyZoneRatio: 0.5,
    properties: { ...(definition.defaultProperties ?? {}), ...properties },
  } as HvacElement;
}

function gully(x: number, y: number): HvacElement {
  return {
    id: 'gully', type: 'condensate-gully', position: { x: x - 100, y: y - 100 }, rotation: 0, width: 200, depth: 200, height: 60,
    elevation: 0, mountType: 'floor', label: 'Floor gully', supplyZoneRatio: 0,
    properties: { terminationKind: 'floor-gully', inletElevationMm: 50, terminalTrap: 'tundish' },
  };
}

function branchOf(unit: HvacElement, elements: readonly HvacElement[]) {
  const branch = elements.find((element) => readCondensatePipeSpec(element).drainStart?.unitId === unit.id);
  return branch ? readCondensatePipeSpec(branch) : null;
}

describe('drains at the maker outlet', () => {
  it('starts a pumped FDUM140 drain at the end of its supplied hose and draws no second hose', () => {
    const unit = place('vrf-fdum140kxe6f', { x: 3000, y: 3000 });
    const result = generateCondensateNetwork([unit, gully(7000, 3000)], { settings });
    const spec = branchOf(unit, result.elementsToAdd)!;
    const port = getIndoorUnitDrainPort(unit, settings)!;
    expect(port.hoseInModel).toBe(true);
    expect(spec.routeNodes3d[0]!.x).toBeCloseTo(port.point.x, 3);
    expect(spec.routeNodes3d[0]!.y).toBeCloseTo(port.point.y, 3);
    expect(spec.routeNodes3d[0]!.z).toBeCloseTo(port.z, 3);
    expect(spec.pumped).toBe(true);
    expect(spec.drainHoseLengthMm).toBe(0);
  });

  it('drains the FDT28 from its −x hose end', () => {
    const unit = place('vrf-fdt28kxze1', { x: 3000, y: 3000 });
    const result = generateCondensateNetwork([unit, gully(500, 3000)], { settings });
    const spec = branchOf(unit, result.elementsToAdd)!;
    expect(spec.routeNodes3d[0]!.x).toBeCloseTo(3000 - 521.5, 3);
    expect(spec.drainHoseLengthMm).toBe(0);
  });

  it('lifts a pumped FDU224 from its low socket into the void, its own hose drawn', () => {
    const unit = place('vrf-fdu224kxze1', { x: 3000, y: 3000 });
    const result = generateCondensateNetwork([unit, gully(7000, 3000)], { settings });
    const entry = result.perUnit.find((candidate) => candidate.unitId === unit.id)!;
    expect(entry.status, entry.reason).toBe('pumped');
    const spec = branchOf(unit, result.elementsToAdd)!;
    expect(spec.routeNodes3d[0]!.z).toBeCloseTo(2400 + 30, 3);
    expect(Math.max(...spec.routeNodes3d.map((node) => node.z))).toBeGreaterThan(2400 + 30 + 100);
    expect(spec.drainHoseLengthMm).toBeGreaterThan(0);
  });

  it('never dips a pumped drain below its outlet before it rises', () => {
    for (const id of ['vrf-fdum140kxe6f', 'vrf-fdum22kxe6f-w', 'vrf-fdu224kxze1', 'vrf-fdt28kxze1']) {
      for (const rotation of [0, 90, 180, 270]) {
        const unit = place(id, { x: 3000, y: 3000 }, rotation);
        const result = generateCondensateNetwork([unit, gully(7000, 4000)], { settings });
        const spec = branchOf(unit, result.elementsToAdd);
        if (!spec) continue;
        const port = getIndoorUnitDrainPort(unit, settings)!;
        const top = spec.routeNodes3d.findIndex((node, index) => index > 0 && node.z > port.z + 1);
        const beforeRise = spec.routeNodes3d.slice(0, top > 0 ? top : 2);
        for (const node of beforeRise) {
          // The departure may fall at the design slope; it never drops to make a trap.
          const run = Math.hypot(node.x - port.point.x, node.y - port.point.y);
          expect(node.z, `${id} ${rotation}`).toBeGreaterThanOrEqual(port.z - run * 0.02 - 1);
        }
      }
    }
  });

  it("keeps a maker unit's drain clear of its own refrigerant lines at the connection end", () => {
    for (const id of ['vrf-fdum140kxe6f', 'vrf-fdu224kxze1', 'vrf-fdt28kxze1']) {
      const unit = place(id, { x: 3000, y: 3000 });
      // Its pair, straight out of its stubs and on along them.
      const target = getRefrigerantPipeBundleSnapTargets([unit]).find((entry) => entry.connectionKind === 'unit-port')!;
      const out = (along: number) => ({ x: target.point.x + target.direction.x * along, y: target.point.y + target.direction.y * along });
      const pipes = buildRefrigerantPipeElements([out(0), out(2500)], { startBundleConnection: target })
        .map((element, index) => ({ ...element, id: `pipe-${index}`, rotation: 0 }) as HvacElement);
      const sink = gully(3000 + target.direction.x * 4000, 3000 + 1500);
      const result = generateCondensateNetwork([unit, sink, ...pipes], { settings });
      expect(result.metrics.unitsConnected, `${id} ${JSON.stringify(result.perUnit)}`).toBe(1);
      expect(findCondensateRefrigerantClashes([unit, sink, ...pipes, ...result.elementsToAdd]), id).toEqual([]);
    }
  });
});
