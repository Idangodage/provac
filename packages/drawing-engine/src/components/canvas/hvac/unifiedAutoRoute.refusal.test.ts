import { describe, expect, it, vi } from 'vitest';

import type { HvacElement } from '../../../types';

import type { AutoRouteNetworkResult } from './autoRouteNetwork';
import { resolveCondensateSettings } from './condensate/condensateSettings';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from './pipeRoutingSettings';
import { planUnifiedAutoRoute } from './unifiedAutoRoute';

function cassette(id: string, x: number, y: number): HvacElement {
  return { id, type: 'ceiling-cassette-ac', position: { x, y }, rotation: 0, width: 950, depth: 950, height: 272, elevation: 2400,
    mountType: 'ceiling', label: id, supplyZoneRatio: 0.5, properties: { capacityKw: 2.8 } };
}
const gully: HvacElement = { id: 'fg', type: 'condensate-gully', position: { x: 4900, y: 300 }, rotation: 0, width: 200, depth: 200, height: 60,
  elevation: 0, mountType: 'floor', label: 'FG', supplyZoneRatio: 0.5, properties: { terminationKind: 'floor-gully' } };
const existing: HvacElement = { id: 'old-gas', type: 'refrigerant-pipe', position: { x: 0, y: -3000 }, rotation: 0, width: 10, depth: 10, height: 40,
  elevation: 2580, mountType: 'ceiling', label: 'old', supplyZoneRatio: 0.5,
  properties: { routePoints: [{ x: 0, y: -3000 }, { x: 900, y: -3000 }], routeNodes3d: [{ x: 0, y: -3000, z: 2600 }, { x: 900, y: -3000, z: 2600 }],
    pipeDiameterMm: 15.88, insulationThicknessMm: 25.4, lineKind: 'gas' } };
// A proposed run straight through where the drain would go.
const blocking: HvacElement = { ...existing, id: 'new-gas', position: { x: 2500, y: -3000 },
  properties: { ...existing.properties, routePoints: [{ x: 2500, y: -3000 }, { x: 2500, y: 3000 }],
    routeNodes3d: [{ x: 2500, y: -3000, z: 2550 }, { x: 2500, y: 3000, z: 2550 }] } };

vi.mock('./autoRouteNetwork', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // An incomplete rebuild: it would replace the existing run but leaves a unit unconnected.
  planAutoRouteNetwork: vi.fn(async (): Promise<AutoRouteNetworkResult> => ({
    elementsToAdd: [blocking], removeElementIds: ['old-gas'], updates: [], complete: false,
    connectedIndoorIds: ['c-1'], unconnectedIndoorIds: ['c-2'],
    issues: ['ODU: the unlocked connected circuit was rebuilt; one undo restores its previous layout.', 'ODU: routed 1 of 2 indoor units.'], metrics: null, evaluations: [], evaluatedCandidates: 1,
  })),
}));

describe('planUnifiedAutoRoute — refrigerant that Apply would refuse', () => {
  it('keeps the existing refrigerant and designs the drains around it', async () => {
    const scene = [cassette('c-1', 0, 0), cassette('c-2', 3000, 0), gully, existing];
    const result = await planUnifiedAutoRoute(scene, {
      services: { gas: true, liquid: true, condensate: true },
      refrigerant: { settings: DEFAULT_PIPE_ROUTING_SETTINGS, objective: 'balanced' },
      condensate: { settings: resolveCondensateSettings({}) },
    });
    expect(result.refrigerant!.elementsToAdd).toEqual([]);
    expect(result.refrigerant!.removeElementIds).toEqual([]);
    expect(result.issues.join(' ')).toContain('Refrigerant kept as it is: the best layout found connects 1 of 2 units');
    expect(result.issues.join(' ')).toContain('(not connected: c-2)');
    expect(result.issues.join(' ')).not.toContain('was rebuilt');
    expect(result.issues).toContain('ODU: routed 1 of 2 indoor units.');
    // The drains never saw the refused run.
    expect(result.condensate!.crossings.some((crossing) => crossing.serviceElementIds.includes('new-gas'))).toBe(false);
    expect(result.clashes.some((clash) => clash.elementIds.includes('new-gas'))).toBe(false);
    expect(result.condensate!.metrics.unitsConnected).toBe(2);
  });
});
