import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { findNewNetworkPipeClashes } from './networkPipeClearance';
import type { PipeRouteNode3D } from './pipeRoute3d';
import { getActivePipeRoutingSettings, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import type { RefrigerantPipeConnection } from './refrigerantPipePairModel';

const node = (x: number, y = 0, z = 2600): PipeRouteNode3D => ({ x, y, z });
function pipe(id: string, nodes: PipeRouteNode3D[], properties: Record<string, unknown> = {}): HvacElement {
  const xs = nodes.map(p => p.x); const ys = nodes.map(p => p.y); const zs = nodes.map(p => p.z);
  return { id, type: 'refrigerant-pipe', position: { x: Math.min(...xs), y: Math.min(...ys) },
    width: Math.max(...xs) - Math.min(...xs), depth: Math.max(...ys) - Math.min(...ys),
    height: Math.max(...zs) - Math.min(...zs) + 40, elevation: Math.min(...zs) - 20,
    mountType: 'ceiling', label: id, rotation: 0, supplyZoneRatio: 0,
    properties: { lineKind: 'gas', routePoints: nodes.map(({ x, y }) => ({ x, y })), routeNodes3d: nodes,
      authoredCenterlineRoute: nodes.map(({ x, y }) => ({ x, y })),
      pipeDiameterMm: 20, insulationThicknessMm: 10, outerDiameterMm: 40, ...properties } };
}

function connection(point: PipeRouteNode3D, sourceElementId: string, kind: 'field-pipe' | 'unit-port' = 'field-pipe'): RefrigerantPipeConnection {
  return { connectionKind: kind, sourceElementId, portPoint: { x: point.x, y: point.y }, elevationMm: point.z,
    direction: { x: 1, y: 0 }, nodeId: kind === 'field-pipe' ? 'shared-terminal' : undefined };
}

describe('new physical pipe-body interference', () => {
  it('detects same-level crossings, including gas/liquid members of one bundle', () => {
    const gas = pipe('gas', [node(0), node(1000)], { bundleId: 'pair' });
    const liquid = pipe('liquid', [node(500, -500), node(500, 500)], { lineKind: 'liquid', bundleId: 'pair' });
    const result = findNewNetworkPipeClashes([], [gas, liquid]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ elementIds: ['gas', 'liquid'], distanceMm: 0, requiredMm: 70.8 });
  });

  it('does not flag a projected crossing with clear physical service levels', () => {
    const gas = pipe('gas', [node(0), node(1000)]);
    const liquid = pipe('liquid', [node(500, -500, 2700), node(500, 500, 2700)], { lineKind: 'liquid' });
    expect(findNewNetworkPipeClashes([], [gas, liquid])).toEqual([]);
  });

  it('checks the actual rising adapter against another network', () => {
    const rising = pipe('rising', [node(0, 0, 2300), node(200, 0, 2300), node(800, 0, 2600), node(1400)], {
      startConnection: connection(node(0, 0, 2300), 'indoor', 'unit-port'),
    });
    const other = pipe('other-system', [node(600, -500, 2500), node(600, 500, 2500)], { bundleId: 'other-system' });
    const result = findNewNetworkPipeClashes([other], [rising]);
    expect(result).toHaveLength(1);
    expect(result[0]!.distanceMm).toBeCloseTo(0, 6);
  });

  it('compares moved runs with unchanged scene pipes', () => {
    const original = pipe('moving', [node(0, 0, 2800), node(1000, 0, 2800)]);
    const other = pipe('other', [node(500, -500), node(500, 500)]);
    const moved = pipe('moving', [node(0), node(1000)]);
    expect(findNewNetworkPipeClashes([original, other], [moved])).toHaveLength(1);
  });

  it('does not turn existing unchanged intersections into new warnings', () => {
    const a = pipe('a', [node(0), node(1000)]);
    const b = pipe('b', [node(500, -500), node(500, 500)]);
    expect(findNewNetworkPipeClashes([a, b], [{ ...a, properties: { ...a.properties, reviewMetadata: true } }])).toEqual([]);
    expect(findNewNetworkPipeClashes([a, b], [pipe('unrelated', [node(3000), node(4000)])])).toEqual([]);
  });

  it('reports a new intersection location even if the same two elements already crossed elsewhere', () => {
    const a = pipe('a', [node(0, 150), node(1000, 150)]);
    const b = pipe('b', [node(500, -500), node(500, 500)]);
    const moved = pipe('a', [node(0), node(1000)]);
    expect(findNewNetworkPipeClashes([a, b], [moved])).toHaveLength(1);
  });

  it('recognizes unchanged host geometry under split replacement identities', () => {
    const host = pipe('host', [node(0), node(1000)]);
    const other = pipe('other', [node(750, -500), node(750, 500)]);
    const before = pipe('host-before', [node(0), node(450)]);
    const after = pipe('host-after', [node(600), node(1000)]);
    expect(findNewNetworkPipeClashes([host, other], [before, after], ['host'])).toEqual([]);
  });

  it('does not hide an extended parallel overlap behind an existing nearest contact', () => {
    const original = pipe('a', [node(0), node(500)]);
    const other = pipe('b', [node(100, 20), node(1000, 20)]);
    expect(findNewNetworkPipeClashes([original, other], [pipe('a', [node(0), node(1000)])])).toHaveLength(1);
  });

  it('uses insulated radii rather than copper diameters', () => {
    const a = pipe('a', [node(0), node(1000)]);
    const b = pipe('b', [node(0, 30), node(1000, 30)]);
    // The physical pipe model enforces 25.4 mm insulation even when a smaller
    // legacy value was saved. Its rendered envelope is 20 + 2 * 25.4 mm.
    expect(findNewNetworkPipeClashes([], [a, b])[0]).toMatchObject({ distanceMm: 30, requiredMm: 70.8 });
  });
});

describe('physical endpoint exceptions', () => {
  it('keeps repeated multi-contact checks and endpoint trims independent of element order', () => {
    const a = pipe('a', [node(0), node(1000)], { endConnection: connection(node(1000), 'b') });
    const b = pipe('b', [node(1000), node(500)], { startConnection: connection(node(1000), 'a') });
    const c = pipe('c', [node(800, -500), node(800, 500)]);
    const snapshot = structuredClone([a, b, c]);
    const expected = [
      { elementIds: ['a', 'b'], distanceMm: 0, requiredMm: 70.8 },
      { elementIds: ['a', 'c'], distanceMm: 0, requiredMm: 70.8 },
      { elementIds: ['b', 'c'], distanceMm: 0, requiredMm: 70.8 },
    ];
    expect(findNewNetworkPipeClashes([], [a, b, c])).toEqual(expected);
    expect(findNewNetworkPipeClashes([], [c, a, b])).toEqual(expected);
    expect(findNewNetworkPipeClashes([c], [b, a])).toEqual(expected);
    expect([a, b, c]).toEqual(snapshot);
  });

  it('allows an explicitly bound same-service terminal contact', () => {
    const a = pipe('a', [node(0), node(1000)], { endConnection: connection(node(1000), 'b') });
    const b = pipe('b', [node(1000), node(2000)], { startConnection: connection(node(1000), 'a') });
    expect(findNewNetworkPipeClashes([], [a, b])).toEqual([]);
  });

  it('does not infer binding from two coincident unconnected pipe endpoints', () => {
    const a = pipe('a', [node(0), node(1000)]);
    const b = pipe('b', [node(1000), node(2000)]);
    expect(findNewNetworkPipeClashes([], [a, b])).toHaveLength(1);
  });

  it('does not exempt the rest of two routes just because their terminals are bound', () => {
    const a = pipe('a', [node(0), node(1000)], { endConnection: connection(node(1000), 'b') });
    const b = pipe('b', [node(1000), node(500)], { startConnection: connection(node(1000), 'a') });
    expect(findNewNetworkPipeClashes([], [a, b])).toHaveLength(1);
  });

  it('protects the immutable paired adapters of one equipment only inside the port-stub zones', () => {
    const gas = pipe('gas', [node(0), node(150)], { startConnection: connection(node(0), 'indoor', 'unit-port') });
    const liquid = pipe('liquid', [node(0, 10), node(150, 10)], { lineKind: 'liquid', startConnection: connection(node(0, 10), 'indoor', 'unit-port') });
    expect(findNewNetworkPipeClashes([], [gas, liquid])).toEqual([]);
    const longGas = pipe('gas', [node(0), node(1000)], { startConnection: connection(node(0), 'indoor', 'unit-port') });
    const longLiquid = pipe('liquid', [node(0, 10), node(1000, 10)], { lineKind: 'liquid', startConnection: connection(node(0, 10), 'indoor', 'unit-port') });
    expect(findNewNetworkPipeClashes([], [longGas, longLiquid])).toHaveLength(1);
  });

  it('still detects an unrelated pipe crossing inside an equipment adapter zone', () => {
    const gas = pipe('gas', [node(0), node(150)], { startConnection: connection(node(0), 'indoor', 'unit-port') });
    const other = pipe('other', [node(100, -150), node(100, 150)]);
    expect(findNewNetworkPipeClashes([other], [gas])).toHaveLength(1);
  });

  it.each(['start', 'end'] as const)('includes the complete short fan-out after the %s port straight', end => {
    const gasNodes = [node(1116.607924, 627, 2413.88), node(1316.607924, 627, 2413.88), node(1400, 615, 2413.88), node(1800, 615, 2413.88)];
    const liquidNodes = [node(1105.96, 669, 2390.48), node(1305.96, 669, 2390.48), node(1400, 700, 2390.48), node(1800, 700, 2390.48)];
    const gas = pipe('gas', end === 'start' ? gasNodes : [...gasNodes].reverse(), {
      pipeDiameterMm: 15.875, insulationThicknessMm: 25.4,
      [`${end}Connection`]: connection(gasNodes[0]!, 'indoor', 'unit-port'),
    });
    const liquid = pipe('liquid', end === 'start' ? liquidNodes : [...liquidNodes].reverse(), {
      lineKind: 'liquid', pipeDiameterMm: 9.525, insulationThicknessMm: 25.4,
      [`${end}Connection`]: connection(liquidNodes[0]!, 'indoor', 'unit-port'),
    });
    expect(findNewNetworkPipeClashes([], [gas, liquid])).toEqual([]);
    const unrelated = pipe('unrelated', [node(1330, 500, 2413.88), node(1330, 800, 2413.88)]);
    const conflicts = findNewNetworkPipeClashes([unrelated], [gas, liquid]);
    expect(conflicts.some(clash => clash.elementIds.includes('unrelated'))).toBe(true);
  });
});

describe('legacy physical elevation profiles', () => {
  it('honors an existing stored bypass when an unrelated new pipe passes below it', () => {
    const raised = pipe('raised', [node(0, 0, 2400), node(1000, 0, 2400)]);
    delete raised.properties.routeNodes3d;
    raised.properties.bypasses = [{ id: 'bypass', enterPoint: { x: 200, y: 0 }, exitPoint: { x: 800, y: 0 },
      obstaclePoint: { x: 500, y: 0 }, baseElevationMm: 2400, bypassElevationMm: 2700,
      fittingAngleDeg: 45, direction: 'above', obstacleElementIds: [], clearanceMm: 75, riseMm: 300, auto: false, resolved: true }];
    const crossing = pipe('crossing', [node(500, -500, 2400), node(500, 500, 2400)]);
    expect(findNewNetworkPipeClashes([raised], [crossing])).toEqual([]);
  });
});

describe('baseline cache invalidation', () => {
  it('rechecks an in-place changed scene before classifying an existing conflict', () => {
    const a = pipe('a', [node(0, 0, 2800), node(1000, 0, 2800)]);
    const b = pipe('b', [node(500, -500), node(500, 500)]);
    const scene = [a, b];
    findNewNetworkPipeClashes(scene, [pipe('unrelated', [node(3000), node(4000)])]);
    Object.assign(a, pipe('a', [node(0), node(1000)]));
    expect(findNewNetworkPipeClashes(scene, [{ ...a, label: 'Metadata update' }])).toEqual([]);
  });

  it('rechecks physical adapter geometry after routing settings change', () => {
    const initial = getActivePipeRoutingSettings();
    try {
      setActivePipeRoutingSettings({ ...initial, minimumPortStubMm: 400 });
      const a = pipe('a', [node(0), node(1000)], { startConnection: connection(node(0, 0, 2200), 'indoor', 'unit-port') });
      const b = pipe('b', [node(350, -500), node(350, 500)]);
      const scene = [a, b];
      findNewNetworkPipeClashes(scene, [pipe('unrelated', [node(3000), node(4000)])]);
      setActivePipeRoutingSettings({ ...initial, minimumPortStubMm: 200 });
      expect(findNewNetworkPipeClashes(scene, [{ ...a, label: 'Metadata update' }])).toEqual([]);
    } finally {
      setActivePipeRoutingSettings(initial);
    }
  });
});
