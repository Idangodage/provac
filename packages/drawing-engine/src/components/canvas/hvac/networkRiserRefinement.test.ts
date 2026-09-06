import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { compileCopperSocketElbowRoute } from './copperSocketElbowRoute';
import { buildNetworkLevelRoute } from './networkPipeLevels';
import { buildNetworkRiserRefinements } from './networkRiserRefinement';
import { recoverQuarterTurnGeometry3D } from './pipeRiserOptimization';
import type { PipeRouteNode3D as Node } from './pipeRoute3d';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from './pipeRoutingSettings';
import { buildRefrigerantPipeElements, getRefrigerantPipeBundleSnapTargets, resolveRefrigerantPipeSpec } from './refrigerantPipePairModel';

const settings = { ...DEFAULT_PIPE_ROUTING_SETTINGS, bendRadiusFactor: 1,
  minimumPortStubMm: 100, defaultBranchKitClearanceMm: 100 };
const p = (x: number, y = 0, z = 2000): Node => ({ x, y, z });
function pipe(id = 'gas', bundleId = 'pair', offset = 0): HvacElement {
  const nodes = [p(0, offset), p(300, offset), p(300, offset, 2400), p(700, offset, 2400), p(700, 600 + offset, 2400)];
  return { id, type: 'refrigerant-pipe', category: 'accessory', label: id,
    position: { x: 0, y: offset }, rotation: 0, width: 700, depth: 600, height: 440,
    elevation: 1980, mountType: 'ceiling', supplyZoneRatio: 0,
    properties: { lineKind: 'gas', pipeDiameterMm: 15.875, outerDiameterMm: 40,
      insulationThicknessMm: 12.0625, bundleId, routeNodes3d: nodes,
      routePoints: [nodes[0], nodes[3], nodes[4]].map(node => ({ x: node!.x, y: node!.y })),
      startConnection: { connectionKind: 'unit-port', sourceElementId: 'unit',
        portPoint: { x: 0, y: offset }, direction: { x: 1, y: 0 }, elevationMm: 2000 },
      endConnection: { connectionKind: 'field-pipe', sourceElementId: 'kit',
        portPoint: { x: 700, y: 600 + offset }, direction: { x: 0, y: -1 }, elevationMm: 2400 },
      networkLevelPlan: { version: 2, generated: true, preferCornerRisers: false,
        corridorElevationMm: 2400, id: 'network', clearGapMm: 75 },
    },
  };
}

describe('final topology riser refinement', () => {
  it('restores two full 90° fittings after a temporary straight-riser fallback', () => {
    const original = pipe();
    const snapshot = structuredClone(original);
    const candidates = buildNetworkRiserRefinements([original], settings);
    expect(candidates).toHaveLength(1);
    const update = candidates[0]![0]!;
    expect(update.properties.routeNodes3d).toEqual([p(0), p(700), p(700, 0, 2400), p(700, 600, 2400)]);
    expect(update.properties.networkLevelPlan).toMatchObject({ preferCornerRisers: true, corridorElevationMm: 2400, id: 'network', clearGapMm: 75 });
    expect(update.properties.startConnection).toBe(original.properties.startConnection);
    expect(update.properties.endConnection).toBe(original.properties.endConnection);
    expect(update.properties.routePoints).toBe(original.properties.routePoints);
    const before = compileCopperSocketElbowRoute(original.properties.routeNodes3d as Node[], 15.875);
    const after = compileCopperSocketElbowRoute(update.properties.routeNodes3d as Node[], 15.875);
    expect(before.fittings).toHaveLength(3);
    expect(after.fittings).toHaveLength(2);
    expect(after.issues).toEqual([]);
    expect(original).toEqual(snapshot);
    expect(buildNetworkRiserRefinements([update], settings)).toEqual([]);
  });

  it('retains an outdoor riser required before the first branch socket while improving an indoor connection', () => {
    const trunk = pipe('outdoor-main');
    trunk.properties.routePoints = [{ x: 0, y: 0 }, { x: 3000, y: 0 }];
    trunk.properties.routeNodes3d = [p(0), p(300), p(300, 0, 2400), p(3000, 0, 2400)];
    trunk.properties.endConnection = { ...(trunk.properties.endConnection as object),
      portPoint: { x: 3000, y: 0 }, direction: { x: -1, y: 0 } };
    const snapshot = structuredClone(trunk);
    const indoor = pipe('indoor');
    const candidates = buildNetworkRiserRefinements([trunk, indoor], settings);
    expect(candidates[0]!.map(element => element.id)).toEqual(['indoor']);
    expect(trunk).toEqual(snapshot);
    expect((candidates[0]![0]!.properties.routeNodes3d as Node[]).at(-1)).toEqual(p(700, 600, 2400));
  });

  it('returns combined, bundle, and individual collision alternatives without duplicates', () => {
    const source = [pipe('gas-a', 'a'), pipe('liquid-a', 'a', 100), pipe('gas-b', 'b', 200), pipe('liquid-b', 'b', 300)];
    const candidates = buildNetworkRiserRefinements(source, settings);
    expect(candidates.map(group => group.map(element => element.id))).toEqual([
      ['gas-a', 'liquid-a', 'gas-b', 'liquid-b'], ['gas-a', 'liquid-a'], ['gas-b', 'liquid-b'],
      ['gas-a'], ['liquid-a'], ['gas-b'], ['liquid-b'],
    ]);
    expect(buildNetworkRiserRefinements(source, settings)).toEqual(candidates);
  });

  it.each(['networkLevelLocked', 'routeLocked', 'routingLocked', 'locked', 'isLocked', 'reviewed', 'installationReviewed'])(
    'preserves %s installations', key => {
      const source = pipe(); source.properties[key] = true;
      expect(buildNetworkRiserRefinements([source], settings)).toEqual([]);
    },
  );

  it('preserves bypasses, manual routes, unbound sockets and unmanaged guides', () => {
    for (const patch of [{ bypasses: [{}] }, { routingMode: 'manual' }, { routeMode: 'manual' },
      { startConnection: null }, { endConnection: null },
      { networkLevelPlan: { version: 2, generated: false, corridorElevationMm: 2400 } },
      { networkLevelPlan: { version: 1, generated: true, corridorElevationMm: 2400 } }]) {
      const source = pipe(); Object.assign(source.properties, patch);
      expect(buildNetworkRiserRefinements([source], settings)).toEqual([]);
    }
  });

  it('rejects changed sockets, additional vertical travel and a larger protected fitting radius', () => {
    const detached = pipe();
    (detached.properties.routeNodes3d as Node[])[0]!.x += 1;
    expect(buildNetworkRiserRefinements([detached], settings)).toEqual([]);
    const reversal = pipe();
    (reversal.properties.networkLevelPlan as Record<string, unknown>).corridorElevationMm = 1600;
    expect(buildNetworkRiserRefinements([reversal], settings)).toEqual([]);
    const largeFitting = pipe(); largeFitting.properties.minimumFieldBendRadiusMm = 250;
    expect(buildNetworkRiserRefinements([largeFitting], settings)).toEqual([]);
  });

  it('recognizes persisted sampled copper elbows without creating meshes', () => {
    const source = pipe();
    source.properties.routeNodes3d = compileCopperSocketElbowRoute(source.properties.routeNodes3d as Node[], 15.875).centerline;
    const candidates = buildNetworkRiserRefinements([source], settings);
    expect(candidates).toHaveLength(1);
    expect(compileCopperSocketElbowRoute(candidates[0]![0]!.properties.routeNodes3d as Node[], 15.875).fittings).toHaveLength(2);
  });

  it('defers the real cassette gather during topology search and then removes its third elbow at fixed branch sockets', () => {
    const cassette: HvacElement = { id: 'real-cassette', type: 'ceiling-cassette-ac', category: 'indoor-unit',
      position: { x: 1200, y: 1800 }, width: 600, depth: 600, height: 250, elevation: 2200,
      rotation: 0, mountType: 'ceiling', label: 'Cassette', supplyZoneRatio: 0, properties: {} };
    const bundle = getRefrigerantPipeBundleSnapTargets([cassette])[0]!;
    const direction = bundle.direction;
    const corner = { x: bundle.point.x + direction.x * 900, y: bundle.point.y + direction.y * 900 };
    const endpoint = { x: corner.x - direction.y * 1500, y: corner.y + direction.x * 1500 };
    const source = buildRefrigerantPipeElements([bundle.point, corner, endpoint], {
      startBundleConnection: bundle, bendRadiusFactor: 1,
    }).map((element, index): HvacElement => {
      const properties = element.properties ?? {};
      const spec = resolveRefrigerantPipeSpec(properties);
      const corridor = spec.startConnection!.elevationMm + 400;
      const endConnection = { connectionKind: 'field-pipe' as const, sourceElementId: `fixed-branch-${index}`,
        portPoint: spec.routePoints.at(-1)!, direction: { x: direction.y, y: -direction.x }, elevationMm: corridor };
      const deferred = buildNetworkLevelRoute(spec.routePoints, corridor, {
        start: spec.startConnection, end: endConnection, radiusMm: spec.outerDiameterMm / 2,
        pipeDiameterMm: spec.pipeDiameterMm, settings, preferCornerRisers: true, deferRiserTurnOptimization: true,
      });
      expect(deferred.issue).toBeUndefined();
      expect(compileCopperSocketElbowRoute(deferred.nodes, spec.pipeDiameterMm).fittings
        .filter(fitting => fitting.spec.angleDeg === 90)).toHaveLength(3);
      return { ...element, id: `cassette-connection-${index}`, properties: {
        ...properties, endConnection, routeNodes3d: deferred.nodes,
        networkLevelPlan: { version: 2, generated: true, corridorElevationMm: corridor,
          preferCornerRisers: true, deferRiserTurnOptimization: true },
      } } as HvacElement;
    });
    const snapshot = structuredClone(source);
    const candidates = buildNetworkRiserRefinements(source, settings);
    expect(candidates[0]).toHaveLength(2);
    for (const update of candidates[0]!) {
      const original = source.find(element => element.id === update.id)!;
      const before = original.properties.routeNodes3d as Node[];
      const after = update.properties.routeNodes3d as Node[];
      expect(after[0]).toEqual(before[0]);
      expect(after.at(-1)).toEqual(before.at(-1));
      expect(update.properties.endConnection).toBe(original.properties.endConnection);
      expect(compileCopperSocketElbowRoute(after, resolveRefrigerantPipeSpec(update.properties).pipeDiameterMm).fittings
        .filter(fitting => fitting.spec.angleDeg === 90)).toHaveLength(2);
    }
    expect(source).toEqual(snapshot);
    expect(source.every(element => (element.properties.networkLevelPlan as Record<string, unknown>).deferRiserTurnOptimization === true)).toBe(true);
  });

  it('keeps every independent fallback with a linear number of alternatives', () => {
    const source = Array.from({ length: 80 }, (_, index) => pipe(`pipe-${index}`, `pair-${Math.floor(index / 2)}`, index * 100));
    const candidates = buildNetworkRiserRefinements(source, settings);
    expect(candidates).toHaveLength(1 + 40 + source.length);
    expect(candidates[0]).toHaveLength(80);
    expect(candidates.filter(candidate => candidate.length === 1).map(candidate => candidate[0]!.id))
      .toEqual(source.map(element => element.id));
  });

  it('offers the other corner of an interior riser when the preferred corner is obstructed', () => {
    const source = pipe('interior');
    const sharp = [p(0, -600), ...(source.properties.routeNodes3d as Node[]), p(1300, 600, 2400)];
    source.properties.routeNodes3d = compileCopperSocketElbowRoute(sharp, 15.875).centerline;
    source.properties.routePoints = [p(0, -600), p(0), p(700), p(700, 600), p(1300, 600)]
      .map(node => ({ x: node.x, y: node.y }));
    source.properties.startConnection = { ...(source.properties.startConnection as object),
      portPoint: { x: 0, y: -600 }, direction: { x: 0, y: 1 } };
    source.properties.endConnection = { ...(source.properties.endConnection as object),
      portPoint: { x: 1300, y: 600 }, direction: { x: -1, y: 0 } };
    const snapshot = structuredClone(source);
    const candidates = buildNetworkRiserRefinements([source], settings);
    const riserX = (element: HvacElement) => {
      const nodes = element.properties.routeNodes3d as Node[];
      return nodes.find((node, index) => index > 0 && Math.abs(node.z - nodes[index - 1]!.z) > 1)!.x;
    };
    expect(candidates.some(candidate => riserX(candidate[0]!) === 0)).toBe(true);
    const clear = candidates.find(candidate => riserX(candidate[0]!) === 700)![0]!;
    expect(clear).toBeDefined();
    expect(compileCopperSocketElbowRoute(clear.properties.routeNodes3d as Node[], 15.875).fittings).toHaveLength(4);
    // A separate plan elbow must keep its exact sampled radius and shape.
    const retained = recoverQuarterTurnGeometry3D(source.properties.routeNodes3d as Node[]).arcs
      .find(arc => arc.corner.x === 700 && arc.corner.y === 600)!;
    expect(retained).toBeDefined();
    for (const sample of retained.samples) expect(clear.properties.routeNodes3d).toContainEqual(sample);
    expect(source).toEqual(snapshot);
  });
});
