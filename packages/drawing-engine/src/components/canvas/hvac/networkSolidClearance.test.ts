import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { generateCondensateNetwork } from './condensate/condensateGenerator';
import { resolveCondensateSettings } from './condensate/condensateSettings';
import { findNewNetworkPipeClashes } from './networkPipeClearance';
import type { PipeRouteNode3D } from './pipeRoute3d';
import { getRefrigerantPipeBundleSnapTargets, type RefrigerantPipeConnection } from './refrigerantPipePairModel';

const unit: HvacElement = { id: 'outdoor', type: 'outdoor-unit', position: { x: 0, y: 0 }, rotation: 0,
  width: 1000, depth: 600, height: 300, elevation: 2600, mountType: 'floor', label: 'Outdoor', supplyZoneRatio: 0, properties: {} };
const node = (x: number, y: number, z = 2750): PipeRouteNode3D => ({ x, y, z });
function pipe(id: string, nodes: PipeRouteNode3D[], properties: Record<string, unknown> = {}): HvacElement {
  return { ...unit, id, type: 'refrigerant-pipe', properties: { lineKind: 'gas', routePoints: nodes.map(({ x, y }) => ({ x, y })),
    authoredCenterlineRoute: nodes.map(({ x, y }) => ({ x, y })), routeNodes3d: nodes, pipeDiameterMm: 20, insulationThicknessMm: 25.4,
    outerDiameterMm: 70.8, ...properties } };
}
function drain(id: string, nodes: PipeRouteNode3D[], startNode?: string, endNode?: string): HvacElement {
  const connection = (key: string | undefined, point: PipeRouteNode3D) => key ? { kind: 'junction', nodeId: key, point: { x: point.x, y: point.y }, z: point.z } : null;
  return { ...pipe(id, nodes), type: 'condensate-pipe', properties: { routeNodes3d: nodes, outerDiameterMm: 32,
    insulationThicknessMm: 9, drainStart: connection(startNode, nodes[0]!), drainEnd: connection(endNode, nodes.at(-1)!) } };
}

describe('network coordination with solid equipment', () => {
  it('rejects same-level pipes through a casing and accepts vertically separated crossings', () => {
    expect(findNewNetworkPipeClashes([unit], [pipe('through', [node(-500, 300), node(1500, 300)])]))
      .toEqual([expect.objectContaining({ elementIds: ['outdoor', 'through'] })]);
    expect(findNewNetworkPipeClashes([unit], [pipe('above', [node(-500, 300, 3000), node(1500, 300, 3000)])])).toEqual([]);
  });

  it('permits only the bounded outward adapter at the live equipment port, and detects later re-entry', () => {
    const target = getRefrigerantPipeBundleSnapTargets([unit])[0]!;
    const start = { ...target.gasPoint, z: target.gasElevationMm };
    const connection: RefrigerantPipeConnection = { connectionKind: 'unit-port', sourceElementId: unit.id,
      portPoint: target.gasPoint, elevationMm: start.z, direction: target.gasDirection ?? target.direction };
    const straight = pipe('connected', [start, node(start.x + 1000, start.y, start.z)], { startConnection: connection });
    expect(findNewNetworkPipeClashes([unit], [straight])).toEqual([]);
    const loop = pipe('loop', [start, node(start.x + 1000, start.y, start.z), node(start.x + 1000, 1300, start.z),
      node(500, 1300, start.z), node(500, 300, start.z)], { startConnection: connection });
    expect(findNewNetworkPipeClashes([unit], [loop])).toEqual([expect.objectContaining({ elementIds: ['loop', 'outdoor'] })]);
  });

  it('detects a moved body entering an unchanged pipe and an extended old body overlap', () => {
    const original = pipe('existing', [node(-500, 300), node(400, 300)]);
    const extended = pipe('existing', [node(-500, 300), node(1500, 300)]);
    expect(findNewNetworkPipeClashes([unit, original], [original])).toEqual([]);
    expect(findNewNetworkPipeClashes([unit, original], [extended])).toHaveLength(1);
    const oldUnit = { ...unit, position: { x: 0, y: 2000 } };
    expect(findNewNetworkPipeClashes([oldUnit, original], [unit])).toHaveLength(1);
  });
});

describe('declared condensate junctions', () => {
  it('accepts an intact generated two-cassette gravity network with its fittings', () => {
    const cassette = (id: string, x: number): HvacElement => ({ ...unit, id, type: 'ceiling-cassette-ac',
      position: { x, y: 0 }, width: 950, depth: 950, height: 272, elevation: 2400, properties: { capacityKw: 4 } });
    const gully: HvacElement = { ...unit, id: 'fg', type: 'condensate-gully', position: { x: 6900, y: 1400 }, width: 200,
      depth: 200, height: 60, elevation: 0, properties: { terminationKind: 'floor-gully' } };
    const scene = [cassette('c-1', 0), cassette('c-2', 3000), gully];
    const result = generateCondensateNetwork(scene, { settings: resolveCondensateSettings({}) });
    const clashes = findNewNetworkPipeClashes(scene, result.elementsToAdd);
    expect(clashes).toEqual([]);
  });
  it('allows a sloping 45 degree wye while rejecting an identical unconnected crossing', () => {
    const joint = node(0, 0);
    const main = drain('main', [joint, node(1000, 0, 2740)], 'joint');
    const branch = drain('branch', [node(700, 700, 2760), joint], undefined, 'joint');
    expect(findNewNetworkPipeClashes([], [main, branch])).toEqual([]);
    const unconnected = drain('unconnected', [node(700, 700, 2760), joint]);
    expect(findNewNetworkPipeClashes([], [main, unconnected])).toHaveLength(1);
  });

  it('keeps checking beyond the declared junction allowance', () => {
    const a = drain('a', [node(0, 0), node(1000, 0)], 'joint');
    const b = drain('b', [node(0, 0), node(1000, 0)], 'joint');
    expect(findNewNetworkPipeClashes([], [a, b])).toHaveLength(1);
  });
});
