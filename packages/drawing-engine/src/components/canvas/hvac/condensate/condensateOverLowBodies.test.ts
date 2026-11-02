// A drain may pass over a low duct where it is still high enough: the profile holds it above the duct there. Where it
// cannot (a full-height duct, or a body taller than the fall leaves room for), it goes round, and no unit is left out.
import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { resolveUnitAirPorts } from '../duct/ductAirPorts';
import { buildDuctRunDraftElement } from '../duct/ductDraft';
import { getDuctRunPlan } from '../duct/ductFabricationPlanner';
import { resolveDuctSettings, setActiveDuctSettings } from '../duct/ductSettings';
import { ductBoxesOf } from '../duct/ductVolumes';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';

import { planCondensateNetwork } from './condensateNetworkPlanner';
import { resolveCondensateSettings } from './condensateSettings';

const cassette = (id: string, x: number, y: number): HvacElement => ({
  id, type: 'ceiling-cassette-ac', category: 'indoor-unit', label: id, position: { x, y }, rotation: 0, width: 600, depth: 600, height: 250,
  elevation: 2400, mountType: 'ceiling', supplyZoneRatio: 0, properties: { capacityKw: 2.8, dischargeWays: 4, hasDrainPump: true },
});
const gully = (x: number, y: number): HvacElement => ({
  id: 'fg', type: 'condensate-gully', position: { x: x - 100, y: y - 100 }, rotation: 0, width: 200, depth: 200, height: 60,
  elevation: 0, mountType: 'floor', label: 'fg', supplyZoneRatio: 0.5, properties: { terminationKind: 'floor-gully', inletElevationMm: 50, terminalTrap: 'tundish' },
});
const ducted: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: -9000, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2450, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
  properties: { modelCode: 'FDUM22KXE6F-W', modelUrl: '/models/vrf/maco-vrf-fdum22kxe6f-w.glb' },
};
/** A long straight duct of this height across the drain's way (along y, centred on x = 2000). */
function ductAcross(heightMm: number): HvacElement {
  const port = resolveUnitAirPorts(ducted).find((candidate) => candidate.kind === 'supply')!;
  const moved = { ...port, lip: { ...port.lip, x: 2000, y: -6000 }, normal: { x: 0, y: 1, z: 0 } };
  return buildDuctRunDraftElement({ port: moved as never, points: [{ x: 2000, y: 12000 }], legSizes: [{ widthMm: 500, heightMm }] } as never, 'across');
}

const settings = resolveCondensateSettings({ soffitMm: 2900 });
const ductSettings = resolveDuctSettings({ soffitMm: 2900 });

beforeEach(() => {
  setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
  setActiveDuctSettings(ductSettings);
});

const planFor = (scene: HvacElement[]) => planCondensateNetwork(scene, { settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS });
const lengthOf = (plan: ReturnType<typeof planFor>) => plan.perUnit[0]!.lengthMm;

describe('a drain and a low duct', () => {
  const scene = (heightMm: number) => [cassette('c', 0, 3000), gully(4000, 3300), ductAcross(heightMm)];

  it('passes over a low duct, held above it, by the short way', () => {
    const duct = scene(200)[2]!;
    const plan = planFor(scene(200));
    expect(plan.perUnit[0]!.status).toBe('pumped');
    expect(lengthOf(plan)).toBeLessThan(6000);
    const crossing = plan.networks[0]!.crossings.find((entry) => entry.overBody)!;
    expect(crossing, 'it crossed the duct').toBeTruthy();
    expect(crossing.relation).toBe('above');
    const top = Math.max(...ductBoxesOf(getDuctRunPlan(duct, scene(200), ductSettings)!).map((box) => box.bounds.maxZ));
    expect(crossing.condensateZ).toBeGreaterThanOrEqual(top + crossing.requiredClearanceMm - 1);
  });

  it('goes round a duct too tall to clear, and the unit is still served', () => {
    const plan = planFor(scene(400));
    expect(plan.perUnit[0]!.status).toBe('pumped');
    expect(plan.networks[0]!.crossings.filter((entry) => entry.overBody)).toEqual([]);
    expect(lengthOf(plan)).toBeGreaterThan(6000);
  });
});
