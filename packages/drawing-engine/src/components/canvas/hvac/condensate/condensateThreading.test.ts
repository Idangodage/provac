import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';

import { buildCondensateEnvironment } from './condensateEnvironment';
import { planCondensateNetwork } from './condensateNetworkPlanner';
import { resolveCondensateSettings } from './condensateSettings';

function unit(id: string): HvacElement {
  return { id, type: 'ducted-ac', position: { x: -10000, y: -10000 }, rotation: 0,
    width: 1084, depth: 697, height: 300, elevation: 2600, mountType: 'ceiling',
    label: id, supplyZoneRatio: 0.5, properties: { capacityKw: 4 } };
}

function sink(id: string, x: number, y: number, capacity: number): HvacElement {
  return { ...unit(id), type: 'condensate-gully', position: { x: x - 100, y: y - 100 },
    width: 200, depth: 200, height: 60, elevation: 0, mountType: 'floor',
    properties: { terminationKind: 'floor-gully', maxConnectedCapacityKw: capacity } };
}

beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('a drain crossing lines at two levels in one window', () => {
  it('threads between them, over the lower and under the upper, with no hop', () => {
    const settings = resolveCondensateSettings({ pumpPolicy: 'never', ceilingPlaneMm: 2400,
      refrigerantCrossingPenaltyMm: 0, corridorBonusRatio: 0, mainBelowPortsMm: 0 });
    const scene = [unit('source'), sink('sink', 6000, 0, 10)];
    const environment = buildCondensateEnvironment(scene, { settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS });
    environment.sources = environment.sources.map((source) => ({ ...source,
      point: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, z: 2600, hasDrainPump: false,
    }));
    // A main's liquid low in the void and a unit's gas connection at its port's level, 90 mm apart in plan.
    environment.services.push({ elementId: 'liquid-main', service: 'liquid',
      a: { x: 3000, y: -100000, z: 2300 }, b: { x: 3000, y: 100000, z: 2300 }, radiusMm: 15, connectedUnitIds: [] });
    environment.services.push({ elementId: 'gas-connection', service: 'gas',
      a: { x: 3090, y: -100000, z: 2750 }, b: { x: 3090, y: 100000, z: 2750 }, radiusMm: 20, connectedUnitIds: [] });
    const plan = planCondensateNetwork(scene, { settings, environment });
    expect(plan.perUnit[0]!.status).toBe('gravity');
    expect(plan.hopProposals).toEqual([]);
    const crossings = plan.networks[0]!.crossings;
    expect(crossings.find((crossing) => crossing.serviceElementIds.includes('liquid-main'))?.relation).toBe('above');
    expect(crossings.find((crossing) => crossing.serviceElementIds.includes('gas-connection'))?.relation).toBe('below');
    for (const crossing of crossings) {
      const gap = crossing.relation === 'above' ? crossing.condensateZ - crossing.serviceZMax : crossing.serviceZMin - crossing.condensateZ;
      expect(gap).toBeGreaterThanOrEqual(crossing.requiredClearanceMm - 1e-6);
    }
  });
});
