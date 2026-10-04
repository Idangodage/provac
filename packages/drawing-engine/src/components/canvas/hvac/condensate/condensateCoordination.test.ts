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

describe('coordination between drainage networks', () => {
  it('routes below an elevated solid without the detour needed when that body intersects the gravity band', () => {
    const settings = resolveCondensateSettings({ pumpPolicy: 'never', ceilingPlaneMm: 2400, mainBelowPortsMm: 0 });
    const base = [unit('source'), sink('sink', 6000, 0, 10)];
    const obstacle: HvacElement = { ...unit('body'), type: 'accessory',
      position: { x: 2500, y: -500 }, width: 1000, depth: 1000, height: 100, elevation: 2800 };
    const solve = (body: HvacElement | null) => {
      const scene = body ? [...base, body] : base;
      const environment = buildCondensateEnvironment(scene, { settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS });
      environment.sources = environment.sources.map((source) => ({ ...source,
        point: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, z: 2600, hasDrainPump: false,
      }));
      return planCondensateNetwork(scene, { settings, environment }).perUnit[0]!;
    };
    const clear = solve(null);
    const above = solve(obstacle);
    const blocking = solve({ ...obstacle, elevation: 2520 });
    expect(above.status).toBe('gravity');
    expect(above.lengthMm).toBeCloseTo(clear.lengthMm, 5);
    expect(blocking.status).toBe('gravity');
    expect(blocking.lengthMm).toBeGreaterThan(above.lengthMm + 500);
  });

  it('coordinates a second sink network against the first without mutating a cached environment', () => {
    const settings = resolveCondensateSettings({ pumpPolicy: 'never', ceilingPlaneMm: 2400,
      preferredSlopePercent: 1, minSlopePercent: 1, refrigerantCrossingPenaltyMm: 0,
      corridorBonusRatio: 0, mainBelowPortsMm: 0 });
    const scene = [unit('a'), unit('b'), sink('first', 10000, 0, 8), sink('second', 5000, 3000, 2)];
    const environment = buildCondensateEnvironment(scene, { settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS });
    environment.sources = environment.sources.map((source) => ({ ...source,
      point: source.unitId === 'a' ? { x: 0, y: 0 } : { x: 5000, y: -3000 },
      direction: source.unitId === 'a' ? { x: 1, y: 0 } : { x: 0, y: 1 },
      z: 2700, hasDrainPump: false, capacityKw: source.unitId === 'a' ? 8 : 2,
    }));
    let next = 0;
    const plan = planCondensateNetwork(scene, { settings, environment, idFactory: (prefix) => `${prefix}-${next++}` });
    expect(plan.networks).toHaveLength(2);
    expect(plan.networks[1]!.crossings.some((crossing) => crossing.serviceElementId.startsWith(plan.networks[0]!.networkId))).toBe(true);
    expect(plan.networks.every((network) => network.feasible)).toBe(true);
    expect(plan.networks[1]!.crossings.every((crossing) => crossing.relation === 'above' || crossing.relation === 'below')).toBe(true);
    expect(environment.services).toEqual([]);
  });

  it.each([false, true])('marks an obstructed drain crossing infeasible, including a merged refrigerant window (%s)', (withRefrigerant) => {
    const settings = resolveCondensateSettings({ pumpPolicy: 'never', ceilingPlaneMm: 2400,
      refrigerantCrossingPenaltyMm: 0, corridorBonusRatio: 0, mainBelowPortsMm: 0 });
    const scene = [unit('source'), sink('sink', 6000, 0, 10)];
    const environment = buildCondensateEnvironment(scene, { settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS });
    environment.sources = environment.sources.map((source) => ({ ...source,
      point: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, z: 2600, hasDrainPump: false,
    }));
    environment.services.push({ elementId: 'retained-drain', service: 'drain',
      a: { x: 3000, y: -100000, z: 2550 }, b: { x: 3000, y: 100000, z: 2550 },
      radiusMm: 200, connectedUnitIds: [],
    });
    if (withRefrigerant) environment.services.push({ elementId: 'retained-gas', service: 'gas',
      a: { x: 3010, y: -100000, z: 2550 }, b: { x: 3010, y: 100000, z: 2550 },
      radiusMm: 20, connectedUnitIds: [],
    });
    const plan = planCondensateNetwork(scene, { settings, environment });
    expect(plan.networks).toHaveLength(1);
    expect(plan.networks[0]!.crossings.some((crossing) => crossing.relation === 'unresolved')).toBe(true);
    expect(plan.networks[0]!.feasible).toBe(false);
    expect(plan.perUnit[0]!.status).toBe('infeasible');
    expect(plan.hopProposals).toEqual([]);
    expect(plan.issues.some((issue) => issue.includes('no feasible clearance'))).toBe(true);
  });
});
