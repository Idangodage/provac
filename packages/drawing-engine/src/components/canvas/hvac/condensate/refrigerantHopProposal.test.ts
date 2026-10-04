import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import { findNewNetworkPipeClashes } from '../networkPipeClearance';
import { DEFAULT_PIPE_ROUTING_SETTINGS, getActivePipeRoutingSettings, setActivePipeRoutingSettings } from '../pipeRoutingSettings';

import type { RefrigerantHopProposal } from './condensateNetworkPlanner';
import { resolveCondensateSettings } from './condensateSettings';
import { buildRefrigerantHopUpdates } from './refrigerantHopProposal';

function pipe(id: string, points: Point2D[], z: number): HvacElement {
  return { id, type: 'refrigerant-pipe', position: points[0]!, rotation: 0,
    width: 4000, depth: 4000, height: 40, elevation: z - 20, mountType: 'ceiling',
    label: id, supplyZoneRatio: 0.5,
    properties: { routePoints: points, routeNodes3d: points.map((point) => ({ ...point, z })),
      pipeDiameterMm: 9.52, insulationThicknessMm: 9, lineKind: 'liquid',
      fieldBendConstruction: 'formed-tube' },
  };
}

beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('coordinated refrigerant hops', () => {
  it('uses the document port-stub setting and restores the previous geometry context', () => {
    const run = pipe('liquid', [{ x: 0, y: 0 }, { x: 4000, y: 0 }], 2500);
    run.properties.startConnection = { connectionKind: 'unit-port', sourceElementId: 'unit',
      portPoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, elevationMm: 2500 };
    const proposal: RefrigerantHopProposal = { key: 'hop', refrigerantElementId: run.id, point: { x: 800, y: 0 },
      networkId: 'drain', condensateZ: 2500, requiredCentrelineZ: 2800, halfWindowMm: 50, withinSoffit: true };
    const normal = buildRefrigerantHopUpdates([run], [proposal], resolveCondensateSettings({}),
      { ...DEFAULT_PIPE_ROUTING_SETTINGS, ceilingLimitMm: 3400 });
    expect(normal.rejected).toEqual([]);
    expect(normal.updates).toHaveLength(1);
    const reserved = buildRefrigerantHopUpdates([run], [proposal], resolveCondensateSettings({}),
      { ...DEFAULT_PIPE_ROUTING_SETTINGS, ceilingLimitMm: 3400, minimumPortStubMm: 1200 });
    expect(reserved.updates).toEqual([]);
    expect(reserved.rejected[0]?.reason).toMatch(/port stub/);
    expect(getActivePipeRoutingSettings()).toEqual(DEFAULT_PIPE_ROUTING_SETTINGS);
  });

  it('rejects a new crossing between group members whose raised spans differ', () => {
    const scene = [pipe('a', [{ x: -2000, y: 0 }, { x: 2000, y: 0 }], 2500),
      pipe('b', [{ x: 0, y: -2000 }, { x: 0, y: 2000 }], 2700)];
    expect(findNewNetworkPipeClashes([], scene)).toEqual([]);
    const proposals: RefrigerantHopProposal[] = [
      { key: 'a-hop', refrigerantElementId: 'a', point: { x: 0, y: 0 }, networkId: 'drain-a',
        condensateZ: 2600, requiredCentrelineZ: 2700, halfWindowMm: 50, withinSoffit: true },
      { key: 'b-hop', refrigerantElementId: 'b', point: { x: 0, y: 300 }, networkId: 'drain-b',
        condensateZ: 2800, requiredCentrelineZ: 2900, halfWindowMm: 50, withinSoffit: true },
    ];
    const result = buildRefrigerantHopUpdates(scene, proposals, resolveCondensateSettings({}), { ceilingLimitMm: 3400 });
    expect(result.updates).toEqual([]);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.every((entry) => entry.reason.includes('clash'))).toBe(true);
  });
});
