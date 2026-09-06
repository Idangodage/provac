import { bench, describe, expect } from 'vitest';

import type { HvacElement } from '../../../types';

import { planAutoRouteNetwork } from './autoRouteNetwork';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from './pipeRoutingSettings';

function unit(id: string, x: number, y: number, outdoor = false): HvacElement {
  return { id, type: outdoor ? 'outdoor-unit' : 'ceiling-cassette-ac', category: outdoor ? 'outdoor-unit' : 'indoor-unit',
    label: id, position: { x, y }, rotation: outdoor ? 180 : 0, width: outdoor ? 900 : 600, depth: outdoor ? 450 : 600,
    height: outdoor ? 1200 : 250, elevation: outdoor ? 1000 : 2200, mountType: outdoor ? 'floor' : 'ceiling',
    supplyZoneRatio: 0, properties: {} };
}

// Deliberately opt-in: normal test runs do not repeat these complete searches.
// Expected values were captured before the performance changes. This benchmark
// must fail if a speedup changes coverage, fitting count, or the chosen cost.
const fixtures = [
  {
    name: 'two rows / balanced', objective: 'balanced' as const,
    scene: () => [unit('outdoor', 10000, 5000, true), unit('upper-left', 500, 500), unit('upper-right', 5500, 500),
      unit('lower-left', 1500, 3000), unit('lower-right', 6000, 3000)],
    connected: ['lower-left', 'lower-right', 'upper-right', 'upper-left'], candidates: 80,
    score: 199.13051674338854, pipeLengthMm: 49656.31739910507, bendCount: 36.899708852466716, branchPairCount: 3,
  },
  {
    name: 'three units / installation cost', objective: 'cost' as const,
    scene: () => [unit('outdoor', 6900, 2600, true), unit('indoor-0', 500, 300), unit('indoor-1', 2900, 300),
      unit('indoor-2', 4700, -1800)],
    connected: ['indoor-2', 'indoor-1', 'indoor-0'], candidates: 43,
    score: 7.537463118914278, pipeLengthMm: 27825.629198510454, bendCount: 28.868976386991974, branchPairCount: 2,
  },
  {
    name: 'four orientations / fewest fittings', objective: 'fewest-fittings' as const,
    scene: () => [unit('outdoor', 14000, 6500, true), unit('east-cassette', 500, 500),
      { ...unit('south-cassette', 3500, 1800), rotation: 90 }, { ...unit('west-cassette', 6500, 500), rotation: 180 },
      { ...unit('north-cassette', 9500, 1800), rotation: 270 }],
    connected: ['south-cassette', 'north-cassette', 'west-cassette', 'east-cassette'], candidates: 91,
    score: 46.61360176353906, pipeLengthMm: 65111.57754991454, bendCount: 34.612631547788084, branchPairCount: 3,
  },
];

describe('Auto route performance with unchanged search results', () => {
  for (const fixture of fixtures) bench(fixture.name, async () => {
    const result = await planAutoRouteNetwork(fixture.scene(), {
      settings: { ...DEFAULT_PIPE_ROUTING_SETTINGS }, objective: fixture.objective,
      ...(fixture.objective === 'cost' ? { rates: { currency: 'EUR', gasPipePerMetre: 45, liquidPipePerMetre: 30,
        elbowEach: 18, branchPairEach: 350, riserEach: 75 } } : {}),
    });
    expect(result.complete).toBe(true);
    expect(result.connectedIndoorIds).toEqual(fixture.connected);
    expect(result.evaluatedCandidates).toBe(fixture.candidates);
    expect(result.evaluations[0]?.score).toBe(fixture.score);
    expect(result.metrics).toMatchObject({ pipeLengthMm: fixture.pipeLengthMm, bendCount: fixture.bendCount,
      branchPairCount: fixture.branchPairCount, connectedIndoorCount: fixture.connected.length, elevationReversalCount: 0,
      estimatedCost: fixture.objective === 'cost' ? 2638.1120916199975 : null });
  }, { iterations: 1, time: 0, warmupIterations: 0, warmupTime: 0 });
});
