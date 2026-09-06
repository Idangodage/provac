import { afterEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { findNewNetworkPipeClashes, hasNewNetworkPipeClash } from './networkPipeClearance';
import type { PipeRouteNode3D } from './pipeRoute3d';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import type { RefrigerantPipeConnection } from './refrigerantPipePairModel';

const node = (x: number, y = 0, z = 2400): PipeRouteNode3D => ({ x, y, z });
let fixture = 0;
let miss = 0;
function pipe(id: string, nodes: PipeRouteNode3D[], properties: Record<string, unknown> = {}): HvacElement {
  return { id, type: 'refrigerant-pipe', position: { x: 0, y: 0 }, width: 1000, depth: 1000,
    height: 70.8, elevation: 2400, mountType: 'ceiling', label: id, rotation: 0, supplyZoneRatio: 0,
    properties: { routePoints: nodes.map(({ x, y }) => ({ x, y })), routeNodes3d: nodes,
      authoredCenterlineRoute: nodes.map(({ x, y }) => ({ x, y })), lineKind: 'gas',
      pipeDiameterMm: 20, outerDiameterMm: 70.8, insulationThicknessMm: 25.4, ...properties } };
}
function connection(point: PipeRouteNode3D, sourceElementId: string, kind: 'field-pipe' | 'unit-port' = 'field-pipe'): RefrigerantPipeConnection {
  return { portPoint: { x: point.x, y: point.y }, elevationMm: point.z, direction: { x: 1, y: 0 }, sourceElementId, connectionKind: kind };
}
function fresh(elements: HvacElement[]): HvacElement[] {
  // The absolute authored route ignores the fallback box. Changing its width
  // forces independent physical construction, hence independent contact caches.
  return elements.map(element => ({ ...element, width: 1000000 + ++miss }));
}
function expectPredicateParity(scene: HvacElement[], proposed: HvacElement[], removed: string[] = []) {
  const expected = findNewNetworkPipeClashes(fresh(scene), fresh(proposed), removed);
  expect(hasNewNetworkPipeClash(scene, proposed, removed)).toBe(expected.length > 0);
  expect(findNewNetworkPipeClashes(scene, proposed, removed)).toEqual(expected);
  expect(hasNewNetworkPipeClash(scene, proposed, removed)).toBe(expected.length > 0);
}
afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('exact cached clearance contacts and rejection predicate', () => {
  it('does not cache a partial rejection as a complete contact report', () => {
    const x = ++fixture * 10000;
    const elements = [pipe('trunk', [node(x), node(x + 2000)]),
      pipe('left', [node(x + 500, -500), node(x + 500, 500)]),
      pipe('right', [node(x + 1500, -500), node(x + 1500, 500)])];
    expect(hasNewNetworkPipeClash([], elements)).toBe(true);
    const full = findNewNetworkPipeClashes([], elements);
    expect(full).toHaveLength(2);
    expect(full).toEqual(findNewNetworkPipeClashes([], fresh(elements)));
    full[0]!.distanceMm = -100;
    full[0]!.elementIds[0] = 'mutated-public-result';
    expectPredicateParity([], elements);
  });

  it('classifies cached geometry against the current baseline and replacement lineage', () => {
    const x = ++fixture * 10000;
    const host = pipe('host', [node(x), node(x + 1500)]);
    const crossing = pipe('crossing', [node(x + 1000, -500), node(x + 1000, 500)]);
    const replacement = pipe('replacement', [node(x + 800), node(x + 1500)]);
    expect(findNewNetworkPipeClashes([], [replacement, crossing])).toHaveLength(1);
    expectPredicateParity([host, crossing], [replacement], ['host']);
    expect(hasNewNetworkPipeClash([host, crossing], [replacement], ['host'])).toBe(false);
    expectPredicateParity([host, crossing], [replacement]);
    expect(hasNewNetworkPipeClash([host, crossing], [replacement])).toBe(true);
    expectPredicateParity([], [replacement, crossing]);
    expectPredicateParity([replacement, crossing], [replacement, crossing]);
  });

  it('recomputes endpoint trims after live field bindings change while geometry is identical', () => {
    const x = ++fixture * 10000;
    const first = pipe('first', [node(x), node(x + 1000)], { endConnection: connection(node(x + 1000), 'second') });
    const second = pipe('second', [node(x + 1000), node(x + 2000)], { startConnection: connection(node(x + 1000), 'first') });
    expectPredicateParity([], [first, second]);
    expect(hasNewNetworkPipeClash([], [first, second])).toBe(false);
    (first.properties.endConnection as RefrigerantPipeConnection).sourceElementId = 'unrelated-a';
    (second.properties.startConnection as RefrigerantPipeConnection).sourceElementId = 'unrelated-b';
    expectPredicateParity([], [first, second]);
    expect(hasNewNetworkPipeClash([], [first, second])).toBe(true);
    (first.properties.endConnection as RefrigerantPipeConnection).sourceElementId = 'second';
    (second.properties.startConnection as RefrigerantPipeConnection).sourceElementId = 'first';
    expectPredicateParity([], [first, second]);
  });

  it.each(['start', 'end'] as const)('keeps %s adapter memoization dependent on live unit relationships, directions and stub settings', end => {
    const x = ++fixture * 10000;
    const gasNodes = [node(x + 11, 0), node(x + 211, 0), node(x + 300, -15), node(x + 700, -15)];
    const liquidNodes = [node(x, 42, 2377), node(x + 200, 42, 2377), node(x + 300, 75, 2377), node(x + 700, 75, 2377)];
    const gas = pipe('gas', end === 'start' ? gasNodes : [...gasNodes].reverse(), {
      [end === 'start' ? 'startConnection' : 'endConnection']: connection(gasNodes[0]!, 'same-unit', 'unit-port'),
    });
    const liquid = pipe('liquid', end === 'start' ? liquidNodes : [...liquidNodes].reverse(), {
      lineKind: 'liquid', [end === 'start' ? 'startConnection' : 'endConnection']: connection(liquidNodes[0]!, 'same-unit', 'unit-port'),
    });
    const gasConnection = gas.properties[end === 'start' ? 'startConnection' : 'endConnection'] as RefrigerantPipeConnection;
    const liquidConnection = liquid.properties[end === 'start' ? 'startConnection' : 'endConnection'] as RefrigerantPipeConnection;
    expectPredicateParity([], [gas, liquid]);
    gasConnection.sourceElementId = 'renamed-unit'; liquidConnection.sourceElementId = 'renamed-unit';
    expectPredicateParity([], [liquid, gas]);
    liquidConnection.sourceElementId = 'different-unit';
    expectPredicateParity([], [gas, liquid]);
    expect(hasNewNetworkPipeClash([], [gas, liquid])).toBe(true);
    liquidConnection.sourceElementId = 'renamed-unit';
    liquidConnection.direction = { x: -1, y: 0 };
    expectPredicateParity([], [gas, liquid]);
    liquidConnection.direction = { x: 1, y: 0 };
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, minimumPortStubMm: 25 });
    expectPredicateParity([], [gas, liquid]);
  });

  it('matches fresh exact geometry across clearance boundaries, risers, renaming and reordered pairs', () => {
    const x = ++fixture * 10000;
    for (const gap of [0, 0.5, 35, 70.299999, 70.3, 70.300001, 71, 150]) {
      const horizontal = pipe('a', [node(x), node(x + 1000)]);
      const other = pipe('b', [node(x, gap), node(x + 1000, gap)]);
      expectPredicateParity([], [horizontal, other]);
      horizontal.id = 'z'; other.id = 'y';
      expectPredicateParity([], [other, horizontal]);
      const rising = pipe('riser', [node(x + 500, -500, 2000), node(x + 500, 0, 2400 + gap), node(x + 500, 500, 2800)]);
      expectPredicateParity([], [horizontal, rising]);
    }
  });

  it('streams dense repeated contacts without losing full results after existence queries', () => {
    const x = ++fixture * 10000;
    const first = pipe('dense-a', Array.from({ length: 80 }, (_, index) => node(x + index, index % 2 ? 100 : -100)), { fieldBendConstruction: 'formed-tube' });
    const second = pipe('dense-b', Array.from({ length: 80 }, (_, index) => node(x + index, index % 2 ? 95 : -95)), { fieldBendConstruction: 'formed-tube' });
    expectPredicateParity([], [first, second]);
    expect(findNewNetworkPipeClashes([], [first, second])).toHaveLength(1);
  });

  it('reconstructs evicted input snapshots and still observes later in-place coordinate and material edits', () => {
    const x = ++fixture * 1000000;
    const original = pipe('retained-input', [node(x), node(x + 1000)]);
    const crossing = pipe('crossing-input', [node(x + 500, -500), node(x + 500, 500)]);
    expectPredicateParity([], [original, crossing]);
    // Keep these public arrays alive while cycling through enough other inputs
    // to evict both private geometry and normalized-input snapshot records.
    const otherInputs = Array.from({ length: 400 }, (_, index) => pipe(`other-${index}`,
      [node(x + 10000 + index * 2000), node(x + 10500 + index * 2000)]));
    expect(findNewNetworkPipeClashes([], otherInputs)).toEqual([]);
    expectPredicateParity([], [original, crossing]);
    for (const point of original.properties.routeNodes3d as PipeRouteNode3D[]) point.z += 300;
    expectPredicateParity([], [original, crossing]);
    expect(hasNewNetworkPipeClash([], [original, crossing])).toBe(false);
    for (const point of original.properties.routeNodes3d as PipeRouteNode3D[]) point.z -= 300;
    original.properties.segmentMaterials = ['hard'];
    expectPredicateParity([], [original, crossing]);
    expect(hasNewNetworkPipeClash([], [original, crossing])).toBe(true);
  });

  it('falls back safely when a single normalized input exceeds the snapshot point allowance', () => {
    const x = ++fixture * 1000000;
    // Repeated authored points are a valid legacy import: they exercise the
    // input-size guard while the physical route simplifies to one straight.
    const long = pipe('large-input', Array.from({ length: 11000 }, (_, index) => node(x + (index === 10999 ? 1000 : 0))), {
      fieldBendConstruction: 'formed-tube',
    });
    const crossing = pipe('large-input-crossing', [node(x + 500, -500), node(x + 500, 500)]);
    expectPredicateParity([], [long, crossing]);
    for (const point of long.properties.routeNodes3d as PipeRouteNode3D[]) point.z += 300;
    expectPredicateParity([], [long, crossing]);
    expect(hasNewNetworkPipeClash([], [long, crossing])).toBe(false);
  });
});
