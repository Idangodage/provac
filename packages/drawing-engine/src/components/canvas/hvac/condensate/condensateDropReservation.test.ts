import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { hasNewNetworkPipeClash } from '../networkPipeClearance';

import { reservedDrainDrops } from './condensateDropReservation';
import { resolveCondensateSettings } from './condensateSettings';
import { readCondensatePipeSpec } from './condensateTypes';

const settings = resolveCondensateSettings({});

function gully(id: string, x: number, y: number): HvacElement {
  return {
    id, type: 'condensate-gully', position: { x: x - 100, y: y - 100 }, rotation: 0, width: 200, depth: 200, height: 60, elevation: 0,
    mountType: 'floor', label: id, supplyZoneRatio: 0, properties: { terminationKind: 'floor-gully', inletElevationMm: 50 },
  };
}

function gasMain(y: number, z: number): HvacElement {
  return {
    id: 'main', type: 'refrigerant-pipe', position: { x: 0, y }, width: 10000, depth: 70, height: 70, elevation: z - 35, rotation: 0,
    label: 'Gas', mountType: 'ceiling', supplyZoneRatio: 0,
    properties: { lineKind: 'gas', bundleId: 'main', routePoints: [{ x: 0, y }, { x: 10000, y }], routeNodes3d: [{ x: 0, y, z }, { x: 10000, y, z }],
      pipeDiameterMm: 19.05, outerDiameterMm: 69.85, insulationThicknessMm: 25.4 },
  };
}

describe('the drain drops reserved before the refrigerant', () => {
  it('a vertical body at the termination, from where the drain ends up to the top given', () => {
    const [drop] = reservedDrainDrops([gully('gully', 5000, 3000)], { settings, topZ: 2900 });
    const spec = readCondensatePipeSpec(drop!);
    expect(drop!.type).toBe('condensate-pipe');
    expect(spec.routeNodes3d.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 5000, y: 3000 }, { x: 5000, y: 3000 }]);
    expect(spec.routeNodes3d[0]!.z).toBe(2900);
    expect(spec.routeNodes3d[1]!.z).toBeLessThan(500);
    expect(spec.insulationThicknessMm).toBe(settings.insulationThicknessMm);
  });

  it('a main passing too close to it clashes, one with its pipes clear does not', () => {
    const drops = reservedDrainDrops([gully('gully', 5000, 3000)], { settings, topZ: 2900 });
    const radius = 69.85 / 2 + readCondensatePipeSpec(drops[0]!).outerDiameterMm / 2 + settings.insulationThicknessMm;
    expect(hasNewNetworkPipeClash(drops, [gasMain(3000 + radius - 10, 2400)])).toBe(true);
    expect(hasNewNetworkPipeClash(drops, [gasMain(3000 + radius + 10, 2400)])).toBe(false);
  });

  it('takes the gullies in scope, and nothing without one', () => {
    const scene = [gully('a', 1000, 1000), gully('b', 2000, 1000)];
    expect(reservedDrainDrops(scene, { settings, topZ: 2900 })).toHaveLength(2);
    expect(reservedDrainDrops(scene, { settings, topZ: 2900, gullyIds: ['b'] }).map((drop) => drop.id)).toEqual(['reserved-drain-drop-b']);
    expect(reservedDrainDrops([], { settings, topZ: 2900 })).toEqual([]);
  });

  it('is as large as the drain of every unit through it', () => {
    const unit = (id: string, capacityKw: number): HvacElement => ({
      id, type: 'ceiling-cassette-ac', position: { x: 0, y: 0 }, rotation: 0, width: 600, depth: 600, height: 250, elevation: 2400,
      mountType: 'ceiling', label: id, supplyZoneRatio: 0, properties: { capacityKw },
    });
    const one = reservedDrainDrops([gully('gully', 0, 0), unit('a', 2)], { settings, topZ: 2900 })[0]!;
    const many = reservedDrainDrops([gully('gully', 0, 0), ...Array.from({ length: 30 }, (_, index) => unit(`u${index}`, 28))], { settings, topZ: 2900 })[0]!;
    expect(readCondensatePipeSpec(many).outerDiameterMm).toBeGreaterThan(readCondensatePipeSpec(one).outerDiameterMm);
  });
});
