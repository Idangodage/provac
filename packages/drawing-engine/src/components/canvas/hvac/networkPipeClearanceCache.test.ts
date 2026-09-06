import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HvacElement } from '../../../types';

import { findNewNetworkPipeClashes } from './networkPipeClearance';
import type { PipeRouteNode3D } from './pipeRoute3d';
import { DEFAULT_PIPE_ROUTING_SETTINGS, getActivePipeRoutingSettings, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { buildRefrigerantPipePhysicalPath, getRefrigerantPipeBundleSnapTargets, type RefrigerantPipeConnection } from './refrigerantPipePairModel';
import type * as PipeModel from './refrigerantPipePairModel';

vi.mock('./refrigerantPipePairModel', async importOriginal => {
  const actual = await importOriginal<typeof PipeModel>();
  return { ...actual, buildRefrigerantPipePhysicalPath: vi.fn(actual.buildRefrigerantPipePhysicalPath) };
});

let fixtureIndex = 0;
let forcedMiss = 0;
const node = (x: number, y = 0, z = 2400): PipeRouteNode3D => ({ x, y, z });
function pipe(id: string, nodes: PipeRouteNode3D[], properties: Record<string, unknown> = {}): HvacElement {
  return { id, type: 'refrigerant-pipe', category: 'accessory', position: { x: 0, y: 0 }, width: 1000, depth: 1000,
    height: 70.8, elevation: 2400, mountType: 'ceiling', label: id, rotation: 0, supplyZoneRatio: 0,
    properties: { routePoints: nodes.map(({ x, y }) => ({ x, y })), routeNodes3d: nodes,
      authoredCenterlineRoute: nodes.map(({ x, y }) => ({ x, y })), lineKind: 'gas',
      pipeDiameterMm: 20, outerDiameterMm: 70.8, insulationThicknessMm: 25.4, ...properties } };
}
function connection(point: PipeRouteNode3D, sourceElementId?: string, kind: 'field-pipe' | 'unit-port' = 'field-pipe'): RefrigerantPipeConnection {
  return { portPoint: { x: point.x, y: point.y }, elevationMm: point.z, direction: { x: 1, y: 0 },
    sourceElementId, connectionKind: kind };
}
function crossingFixture() {
  const x = ++fixtureIndex * 10000;
  return [pipe('a', [node(x), node(x + 1000)]), pipe('b', [node(x + 500, -500), node(x + 500, 500)])];
}
function check(elements: HvacElement[]) { return findNewNetworkPipeClashes([], elements); }
function freshCheck(elements: HvacElement[]) {
  // A nonempty absolute route does not use the fallback box for its geometry.
  // A unique box width intentionally misses the private cache, exercising the
  // real visual/lift/compiler construction as an independent result oracle.
  return check(elements.map(element => element.type === 'refrigerant-pipe'
    ? { ...element, width: 1000000 + ++forcedMiss } : element));
}

beforeEach(() => { vi.mocked(buildRefrigerantPipePhysicalPath).mockClear(); });
afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('private physical lane geometry reuse', () => {
  it('reuses immutable geometry while returning new independent clash records', () => {
    const elements = crossingFixture();
    const snapshot = structuredClone(elements);
    const first = check(elements);
    expect(first).toHaveLength(1);
    expect(buildRefrigerantPipePhysicalPath).toHaveBeenCalledTimes(2);
    vi.mocked(buildRefrigerantPipePhysicalPath).mockClear();
    first[0]!.distanceMm = -123;
    first[0]!.elementIds[0] = 'altered-result';
    const cached = check(elements);
    expect(buildRefrigerantPipePhysicalPath).not.toHaveBeenCalled();
    expect(cached).toEqual(freshCheck(elements));
    expect(buildRefrigerantPipePhysicalPath).toHaveBeenCalledTimes(2);
    expect(cached[0]).toEqual({ elementIds: ['a', 'b'], distanceMm: 0, requiredMm: 70.8 });
    expect(elements).toEqual(snapshot);
  });

  it('rebinds renamed source, node, port and bundle identities on every cache hit', () => {
    const x = ++fixtureIndex * 10000;
    const elements = [pipe('a', [node(x), node(x + 1000)], { bundleId: 'bundle-a', endConnection: connection(node(x + 1000), 'b') }),
      pipe('b', [node(x + 1000), node(x + 2000)], { bundleId: 'bundle-b', startConnection: connection(node(x + 1000), 'a') })];
    expect(check(elements)).toEqual([]);
    vi.mocked(buildRefrigerantPipePhysicalPath).mockClear();
    const renamed = structuredClone(elements);
    renamed[0]!.id = 'renamed-a'; renamed[1]!.id = 'renamed-b';
    renamed[0]!.properties.bundleId = 'renamed-bundle-a'; renamed[1]!.properties.bundleId = 'renamed-bundle-b';
    Object.assign(renamed[0]!.properties.endConnection as RefrigerantPipeConnection,
      { sourceElementId: 'renamed-bundle-b', nodeId: 'new-node-a', portId: 'new-port-a' });
    Object.assign(renamed[1]!.properties.startConnection as RefrigerantPipeConnection,
      { sourceElementId: 'renamed-bundle-a', nodeId: 'new-node-b', portId: 'new-port-b' });
    expect(check(renamed)).toEqual([]);
    expect(buildRefrigerantPipePhysicalPath).not.toHaveBeenCalled();
    (renamed[0]!.properties.endConnection as RefrigerantPipeConnection).sourceElementId = 'unrelated-a';
    (renamed[1]!.properties.startConnection as RefrigerantPipeConnection).sourceElementId = 'unrelated-b';
    const unbound = check(renamed);
    expect(buildRefrigerantPipePhysicalPath).not.toHaveBeenCalled();
    expect(unbound).toHaveLength(1);
    expect(unbound[0]!.elementIds).toEqual(['renamed-a', 'renamed-b']);
    expect(unbound).toEqual(freshCheck(renamed));
  });

  it('does not reuse one unit adapter exception for different equipment identities', () => {
    const x = ++fixtureIndex * 10000;
    const elements = [pipe('gas', [node(x), node(x + 150)], { startConnection: connection(node(x), 'unit-a', 'unit-port') }),
      pipe('liquid', [node(x, 10), node(x + 150, 10)], { lineKind: 'liquid', startConnection: connection(node(x, 10), 'unit-a', 'unit-port') })];
    expect(check(elements)).toEqual([]);
    vi.mocked(buildRefrigerantPipePhysicalPath).mockClear();
    (elements[1]!.properties.startConnection as RefrigerantPipeConnection).sourceElementId = 'unit-b';
    const separateUnits = check(elements);
    expect(buildRefrigerantPipePhysicalPath).not.toHaveBeenCalled();
    expect(separateUnits).toHaveLength(1);
    expect(separateUnits).toEqual(freshCheck(elements));
    vi.mocked(buildRefrigerantPipePhysicalPath).mockClear();
    delete (elements[1]!.properties.startConnection as RefrigerantPipeConnection).sourceElementId;
    expect(check(elements)).toEqual(freshCheck(elements));
    expect(buildRefrigerantPipePhysicalPath).toHaveBeenCalledTimes(3);
  });

  it('resolves moved, rotated and elevated equipment before looking up geometry', () => {
    const x = ++fixtureIndex * 10000;
    const unit: HvacElement = { id: 'live-cassette', type: 'ceiling-cassette-ac', category: 'indoor-unit',
      position: { x, y: 0 }, width: 600, depth: 600, height: 250, elevation: 2300,
      rotation: 0, mountType: 'ceiling', label: 'Cassette', supplyZoneRatio: 0, properties: {} };
    const target = getRefrigerantPipeBundleSnapTargets([unit])[0]!;
    const port = { ...target.gasPoint, z: target.gasElevationMm };
    const run = pipe('attached', [port, node(port.x + 1800, port.y, port.z)], {
      startConnection: { ...connection(port, unit.id, 'unit-port'), direction: target.gasDirection ?? target.direction, portId: target.gasPortId },
    });
    const elements = [unit, run];
    check(elements);
    for (const update of [() => { unit.position.x += 120; }, () => { unit.rotation = 90; }, () => { unit.elevation += 200; }]) {
      vi.mocked(buildRefrigerantPipePhysicalPath).mockClear();
      update();
      expect(check(elements)).toEqual(freshCheck(elements));
      expect(buildRefrigerantPipePhysicalPath).toHaveBeenCalledTimes(2);
      const healed = vi.mocked(buildRefrigerantPipePhysicalPath).mock.results[0]!.value.startConnection as RefrigerantPipeConnection;
      const live = getRefrigerantPipeBundleSnapTargets([unit])[0]!;
      expect(healed.portPoint).toEqual(live.gasPoint);
      expect(healed.elevationMm).toBe(live.gasElevationMm);
    }
  });

  it('observes in-place authored level and plan edits instead of retaining stale crossings', () => {
    const elements = crossingFixture();
    expect(check(elements)).toHaveLength(1);
    vi.mocked(buildRefrigerantPipePhysicalPath).mockClear();
    for (const point of elements[0]!.properties.routeNodes3d as PipeRouteNode3D[]) point.z += 300;
    expect(check(elements)).toEqual([]);
    expect(buildRefrigerantPipePhysicalPath).toHaveBeenCalledTimes(1);
    expect(check(elements)).toEqual(freshCheck(elements));
    vi.mocked(buildRefrigerantPipePhysicalPath).mockClear();
    const route = elements[1]!.properties.routePoints as PipeRouteNode3D[];
    route[0]!.x += 2000; route[1]!.x += 2000;
    expect(check(elements)).toEqual(freshCheck(elements));
    expect(buildRefrigerantPipePhysicalPath).toHaveBeenCalledTimes(3);
  });

  it('preserves compiled circular socket elbows and lifted risers across repeated checks', () => {
    const x = ++fixtureIndex * 10000;
    const curved = pipe('curved', [node(x), node(x + 1000), node(x + 1000, 1000)], {
      pipeDiameterMm: 12.7, routeNodes3d: [node(x), node(x + 500), node(x + 500, 0, 2800),
        node(x + 1000, 0, 2800), node(x + 1000, 1000, 2800)],
    });
    delete curved.properties.authoredCenterlineRoute;
    const crossing = pipe('crossing', [node(x + 850, 500, 2800), node(x + 1150, 500, 2800)]);
    const elements = [curved, crossing];
    const expected = freshCheck(elements);
    expect(expected).toHaveLength(1);
    expect(check(elements)).toEqual(expected);
    vi.mocked(buildRefrigerantPipePhysicalPath).mockClear();
    expect(check(elements)).toEqual(expected);
    expect(check([...elements].reverse())).toEqual(expected);
    expect(buildRefrigerantPipePhysicalPath).not.toHaveBeenCalled();
  });

  it.each([
    ['stored radius', (element: HvacElement) => { element.properties.bendRadiusFactor = 3; }],
    ['construction', (element: HvacElement) => { element.properties.fieldBendConstruction = 'formed-tube'; }],
    ['minimum catalogue radius', (element: HvacElement) => { element.properties.minimumFieldBendRadiusMm = 150; }],
    ['diameter', (element: HvacElement) => { element.properties.pipeDiameterMm = 25; }],
    ['insulation', (element: HvacElement) => { element.properties.insulationThicknessMm = 40; }],
    ['authored geometry policy', (element: HvacElement) => { delete element.properties.authoredCenterlineRoute; }],
    ['box', (element: HvacElement) => { element.position.x += 100; element.depth += 10; }],
    ['legacy elevation', (element: HvacElement) => { element.elevation += 150; delete element.properties.routeNodes3d; }],
    ['material', (element: HvacElement) => { element.properties.segmentMaterials = ['hard']; }],
    ['legacy bypass', (element: HvacElement) => {
      delete element.properties.routeNodes3d;
      const points = element.properties.routePoints as PipeRouteNode3D[];
      element.properties.bypasses = [{ id: 'bypass', enterPoint: points[0], exitPoint: points[1], obstaclePoint: points[0],
        baseElevationMm: 2400, bypassElevationMm: 2700, fittingAngleDeg: 45, direction: 'above',
        obstacleElementIds: [], clearanceMm: 75, riseMm: 300, auto: false, resolved: true }];
    }],
  ] as const)('invalidates %s changes and agrees with fresh physical construction', (_name, update) => {
    const elements = crossingFixture();
    check(elements);
    vi.mocked(buildRefrigerantPipePhysicalPath).mockClear();
    update(elements[0]!);
    const changed = check(elements);
    expect(buildRefrigerantPipePhysicalPath).toHaveBeenCalledTimes(1);
    expect(changed).toEqual(freshCheck(elements));
    expect(buildRefrigerantPipePhysicalPath).toHaveBeenCalledTimes(3);
  });

  it.each(['minimumPortStubMm', 'bendRadiusFactor', 'defaultPipeGapMm', 'minimumFieldBendRadiusMm'] as const)(
    'invalidates live %s settings without relying on scene identity', setting => {
      const elements = crossingFixture();
      check(elements);
      vi.mocked(buildRefrigerantPipePhysicalPath).mockClear();
      const settings = getActivePipeRoutingSettings();
      setActivePipeRoutingSettings({ ...settings, [setting]: settings[setting] + 100 });
      const changed = check(elements);
      expect(buildRefrigerantPipePhysicalPath).toHaveBeenCalledTimes(2);
      expect(changed).toEqual(freshCheck(elements));
    },
  );

  it('evicts old geometry after the private entry budget is exhausted', () => {
    const x = ++fixtureIndex * 10000000;
    const elements = Array.from({ length: 400 }, (_, index) => pipe(`bounded-${index}`, [node(x + index * 2000), node(x + index * 2000 + 500)]));
    expect(check(elements)).toEqual([]);
    vi.mocked(buildRefrigerantPipePhysicalPath).mockClear();
    expect(check([elements[0]!])).toEqual([]);
    expect(buildRefrigerantPipePhysicalPath).toHaveBeenCalledTimes(1);
  });
});
