import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import { compileCopperSocketElbowRoute } from './copperSocketElbowRoute';
import { hasNewNetworkPipeClash } from './networkPipeClearance';
import { applyNetworkPipeLevels, buildNetworkLevelRoute, networkLevelSourceSignature, replanNetworkPipeRisers,
  type NetworkPipeLevelPlan } from './networkPipeLevels';
import { findSampledQuarterTurns } from './pipeRiserCornerProjection';
import type { PipeRouteNode3D } from './pipeRoute3d';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from './pipeRoutingSettings';
import { buildRefrigerantPipeElement, buildRefrigerantPipeElements, resolveRefrigerantPipeSpec, type RefrigerantPipeConnection } from './refrigerantPipePairModel';

const settings = { ...DEFAULT_PIPE_ROUTING_SETTINGS, minimumPortStubMm: 100,
  defaultBranchKitClearanceMm: 300, bendRadiusFactor: 1 };
const point = (x: number, y = 0): Point2D => ({ x, y });
const connection = (portPoint: Point2D, elevationMm: number,
  connectionKind: RefrigerantPipeConnection['connectionKind'] = 'unit-port'): RefrigerantPipeConnection => ({
  portPoint, elevationMm, direction: point(1), connectionKind,
});
const rises = (nodes: PipeRouteNode3D[]) => nodes.slice(1).flatMap((node, index) =>
  Math.abs(node.z - nodes[index]!.z) > 1e-6 ? [{ start: nodes[index]!, end: node }] : []);

function expectOrthogonal(nodes: PipeRouteNode3D[]): void {
  for (let index = 1; index < nodes.length; index += 1) {
    const a = nodes[index - 1]!; const b = nodes[index]!;
    expect([Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z)]
      .filter(length => length > 1e-6)).toHaveLength(1);
  }
}

describe('terminal rise and direction change with two standard elbows', () => {
  it.each([0, 90, 180, 270].flatMap(rotation => [false, true].map(mirrored => ({ rotation, mirrored }))))(
    'uses two 90-degree elbows for rotation $rotation, mirrored $mirrored', ({ rotation, mirrored }) => {
      const radians = rotation * Math.PI / 180;
      const transform = ({ x, y }: Point2D) => ({
        x: 1300 + x * Math.cos(radians) - y * (mirrored ? -1 : 1) * Math.sin(radians),
        y: -700 + x * Math.sin(radians) + y * (mirrored ? -1 : 1) * Math.cos(radians),
      });
      const route = [point(0), point(500), point(500, 1200)].map(transform);
      const result = buildNetworkLevelRoute(route, 2400, {
        start: connection(route[0]!, 1800), radiusMm: 20, settings,
      });
      expect(result.issue).toBeUndefined();
      expect(result.nodes).toHaveLength(4);
      expect(result.nodes[1]).toEqual({ ...route[1]!, z: 1800 });
      expect(result.nodes[2]).toEqual({ ...route[1]!, z: 2400 });
      expectOrthogonal(result.nodes);
      const assembly = compileCopperSocketElbowRoute(result.nodes, 15.88);
      expect(assembly.issues).toEqual([]);
      expect(assembly.fittings).toHaveLength(2);
      expect(assembly.fittings.map(fitting => fitting.spec.angleDeg)).toEqual([90, 90]);
    },
  );

  it.each([1600, 2800])('uses the same corner for a terminal at the end at %i mm', level => {
    const route = [point(500, 1200), point(500), point(0)];
    const result = buildNetworkLevelRoute(route, 2200, {
      end: connection(route.at(-1)!, level), radiusMm: 20, settings,
    });
    expect(result.issue).toBeUndefined();
    expect(result.nodes).toEqual([{ ...route[0]!, z: 2200 }, { ...route[1]!, z: 2200 },
      { ...route[1]!, z: level }, { ...route[2]!, z: level }]);
    expectOrthogonal(result.nodes);
    expect(compileCopperSocketElbowRoute(result.nodes, 15.88).fittings).toHaveLength(2);
  });

  it('recognizes the already sampled circular bends of both production pipe lanes', () => {
    const elements = buildRefrigerantPipeElements([point(0), point(600), point(600, 1200)], {
      gasPipeDiameterMm: 15.88, liquidPipeDiameterMm: 9.52, bendRadiusFactor: 1,
    });
    for (const element of elements) {
      const spec = resolveRefrigerantPipeSpec(element.properties ?? {});
      const original = structuredClone(spec.routePoints);
      expect(spec.routePoints.length).toBeGreaterThan(5);
      const result = buildNetworkLevelRoute(spec.routePoints, 2400, {
        start: connection(spec.routePoints[0]!, 1800), radiusMm: spec.outerDiameterMm / 2,
        pipeDiameterMm: spec.pipeDiameterMm, settings,
      });
      expect(result.issue).toBeUndefined();
      expect(result.nodes).toHaveLength(4);
      expect(spec.routePoints).toEqual(original);
      expectOrthogonal(result.nodes);
      const assembly = compileCopperSocketElbowRoute(result.nodes, spec.pipeDiameterMm,
        { startStraightMm: settings.minimumPortStubMm });
      expect(assembly.issues).toEqual([]);
      expect(assembly.fittings).toHaveLength(2);
    }
  });

  it('retains an unrelated sampled elbow and its actual radius after combining the terminal corner', () => {
    const elements = buildRefrigerantPipeElements([point(0), point(1200), point(1200, 1800), point(3000, 1800)], {
      gasPipeDiameterMm: 15.88, liquidPipeDiameterMm: 9.52, bendRadiusFactor: 3, minimumFieldBendRadiusMm: 150,
    });
    for (const element of elements) {
      const spec = resolveRefrigerantPipeSpec(element.properties ?? {});
      const original = structuredClone(spec.routePoints);
      const originalArcs = findSampledQuarterTurns(spec.routePoints);
      expect(originalArcs).toHaveLength(2);
      const retained = originalArcs[1]!;
      const result = buildNetworkLevelRoute(spec.routePoints, 2400, {
        start: connection(spec.routePoints[0]!, 1800), radiusMm: spec.outerDiameterMm / 2,
        pipeDiameterMm: spec.pipeDiameterMm, minimumBendRadiusMm: 150,
        settings: { ...settings, bendRadiusFactor: 3, minimumFieldBendRadiusMm: 150 },
      });
      expect(result.issue).toBeUndefined();
      expect(rises(result.nodes)).toHaveLength(1);
      const remainingArcs = findSampledQuarterTurns(result.nodes);
      expect(remainingArcs).toHaveLength(1);
      expect(remainingArcs[0]!.radiusMm).toBeCloseTo(retained.radiusMm, 6);
      expect(remainingArcs[0]!.radiusMm).toBeGreaterThanOrEqual(150);
      expect(result.nodes.slice(remainingArcs[0]!.startIndex, remainingArcs[0]!.endIndex + 1))
        .toEqual(original.slice(retained.startIndex, retained.endIndex + 1).map(point => ({ ...point, z: 2400 })));
      expect(spec.routePoints).toEqual(original);
    }
  });

  it('reserves the REFNET socket straight before consuming the first corner', () => {
    const route = [point(0), point(340), point(340, 1200)];
    const result = buildNetworkLevelRoute(route, 2400, {
      start: connection(route[0]!, 1800, 'field-pipe'), radiusMm: 20, settings,
    });
    expect(result.issue).toBeUndefined();
    expect(rises(result.nodes)[0]!.start).toEqual({ x: 340, y: 0, z: 1800 });
    // The centerline setback leaves the full 300 mm before the first elbow.
    expect(result.nodes[1]!.x - 40).toBe(settings.defaultBranchKitClearanceMm);
  });

  it('keeps the straight-span fallback when the first corner lacks socket clearance', () => {
    const route = [point(0), point(320), point(320, 2000)];
    const result = buildNetworkLevelRoute(route, 2400, {
      start: connection(route[0]!, 1800, 'field-pipe'), radiusMm: 20, settings,
    });
    expect(result.issue).toBeUndefined();
    const rise = rises(result.nodes)[0]!;
    expect(rise.start.x).toBe(320);
    expect(rise.start.y).toBeGreaterThanOrEqual(80);
    expectOrthogonal(result.nodes);
  });

  it('does not consume a corner next to a span too short for both neighbouring elbows', () => {
    const route = [point(0), point(500), point(500, 60), point(2000, 60)];
    const result = buildNetworkLevelRoute(route, 2400, {
      start: connection(route[0]!, 1800), radiusMm: 20, settings,
    });
    expect(result.issue).toBeUndefined();
    expect(rises(result.nodes)[0]!.start).toEqual({ x: 140, y: 0, z: 1800 });
    expectOrthogonal(result.nodes);
  });

  it('combines a straight fallback riser with its adjacent turn beyond the terminal corner', () => {
    const route = [point(0), point(100), point(100, 1200), point(2000, 1200)];
    const result = buildNetworkLevelRoute(route, 2400, {
      start: connection(route[0]!, 1800), radiusMm: 20, settings,
    });
    expect(result.issue).toBeUndefined();
    expect(rises(result.nodes)[0]!.start).toEqual({ x: 100, y: 1200, z: 1800 });
    expect(rises(result.nodes)).toHaveLength(1);
    expect(result.nodes[0]).toEqual({ ...route[0]!, z: 1800 });
    expect(result.nodes[1]).toEqual({ ...route[1]!, z: 1800 });
    expect(result.nodes.at(-1)).toEqual({ ...route.at(-1)!, z: 2400 });
    expectOrthogonal(result.nodes);
  });

  it('jointly reserves a corridor straight when both terminals could consume the same corner', () => {
    const route = [point(0), point(600), point(600, 600)];
    const result = buildNetworkLevelRoute(route, 2200, {
      start: connection(route[0]!, 1800), end: connection(route.at(-1)!, 2600), radiusMm: 20, settings,
    });
    expect(result.issue).toBeUndefined();
    const transitions = rises(result.nodes);
    expect(transitions).toHaveLength(2);
    expect(Math.hypot(transitions[1]!.start.x - transitions[0]!.end.x,
      transitions[1]!.start.y - transitions[0]!.end.y)).toBeGreaterThanOrEqual(80);
    expect(transitions.every(rise => rise.end.z > rise.start.z)).toBe(true);
    expectOrthogonal(result.nodes);
    expect(compileCopperSocketElbowRoute(result.nodes, 15.88).fittings).toHaveLength(4);
  });

  it('uses separate terminal corners for both services without changing their corridor levels', () => {
    const route = [point(0), point(600), point(600, 600), point(1200, 600)];
    for (const offset of [0, 100]) {
      const serviceRoute = route.map(p => ({ x: p.x, y: p.y + offset }));
      const result = buildNetworkLevelRoute(serviceRoute, 2200 + offset, {
        start: connection(serviceRoute[0]!, 1800 + offset),
        end: connection(serviceRoute.at(-1)!, 2600 + offset), radiusMm: 20, settings,
      });
      expect(result.issue).toBeUndefined();
      const transitions = rises(result.nodes);
      expect(transitions).toHaveLength(2);
      expect(transitions[0]!.end).toEqual({ ...serviceRoute[1]!, z: 2200 + offset });
      expect(transitions[1]!.start).toEqual({ ...serviceRoute[2]!, z: 2200 + offset });
      expectOrthogonal(result.nodes);
      expect(compileCopperSocketElbowRoute(result.nodes, 15.88).fittings).toHaveLength(4);
    }
  });

  it('still rejects a rise too short to install both full-radius elbows', () => {
    const route = [point(0), point(500), point(500, 1200)];
    const result = buildNetworkLevelRoute(route, 2400, {
      start: connection(route[0]!, 2350), radiusMm: 20, settings,
    });
    expect(result.nodes).toEqual([]);
    expect(result.issue).toContain('two full-radius 90-degree bends');
  });

  it('reserves the complete catalogue cup mouths for an uninsulated gas pipe', () => {
    const route = [point(0), point(140), point(140, 600)];
    const result = buildNetworkLevelRoute(route, 2400, {
      start: connection(route[0]!, 2300), radiusMm: 15.88 / 2, pipeDiameterMm: 15.88, settings,
    });
    expect(result.issue).toBeUndefined();
    const assembly = compileCopperSocketElbowRoute(result.nodes, 15.88, { startStraightMm: settings.minimumPortStubMm });
    expect(assembly.issues).toEqual([]);
    expect(assembly.fittings).toHaveLength(2);
    expect(assembly.fittings[0]!.startFace.x).toBeGreaterThanOrEqual(settings.minimumPortStubMm);
  });

  it('rejects a rise that fits two radii but cannot fit two socket faces', () => {
    const route = [point(0), point(400), point(400, 800)];
    const result = buildNetworkLevelRoute(route, 2400, {
      start: connection(route[0]!, 2340), radiusMm: 15.88 / 2, pipeDiameterMm: 15.88, settings,
    });
    expect(result.nodes).toEqual([]);
    expect(result.issue).toContain('two full-radius 90-degree bends');
    // A deliberately formed tube has no cup mouths consuming the rise.
    const formed = buildNetworkLevelRoute(route, 2400, {
      start: connection(route[0]!, 2340), radiusMm: 15.88 / 2, settings,
    });
    expect(formed.issue).toBeUndefined();
    expect(formed.nodes).toHaveLength(4);
  });

  it('does not let a socket fitting consume the required equipment straight', () => {
    const route = [point(0), point(137), point(137, 800)];
    const result = buildNetworkLevelRoute(route, 2400, {
      start: connection(route[0]!, 2200), radiusMm: 15.88 / 2, pipeDiameterMm: 15.88, settings,
    });
    expect(result.issue).toBeUndefined();
    expect(rises(result.nodes)[0]!.start.y).toBeGreaterThanOrEqual(76);
  });

  it.each(['stored', 'active'] as const)('respects a larger %s bend requirement', source => {
    const route = [point(0), point(400), point(400, 800)];
    const result = buildNetworkLevelRoute(route, 2400, {
      start: connection(route[0]!, 2280), radiusMm: 15.88 / 2, pipeDiameterMm: 15.88,
      minimumBendRadiusMm: source === 'stored' ? 80 : undefined,
      settings: { ...settings, minimumFieldBendRadiusMm: source === 'active' ? 80 : 0 },
    });
    expect(result.nodes).toEqual([]);
    expect(result.issue).toContain('two full-radius 90-degree bends');
  });

  it('keeps the same complete network at its levels when a corner riser meets another pipe', () => {
    const gasRoute = [point(0), point(600), point(600, 1600)];
    const liquidRoute = gasRoute.map(p => ({ x: p.x, y: p.y + 200 }));
    const gas = { ...buildRefrigerantPipeElement(gasRoute, { lineKind: 'gas', pipeDiameterMm: 15.88,
      outerDiameterMm: 40, startConnection: connection(gasRoute[0]!, 1800) }), id: 'gas', rotation: 0 } as HvacElement;
    const liquid = { ...buildRefrigerantPipeElement(liquidRoute, { lineKind: 'liquid', pipeDiameterMm: 9.52,
      outerDiameterMm: 30, startConnection: connection(liquidRoute[0]!, 1700) }), id: 'liquid', rotation: 0 } as HvacElement;
    const obstacle = { ...buildRefrigerantPipeElement([point(600, -100), point(600, 100)], {
      lineKind: 'liquid', pipeDiameterMm: 9.52, outerDiameterMm: 30, elevationMm: 2085,
    }), id: 'obstacle', rotation: 0 } as HvacElement;
    const scene = [gas, liquid, obstacle]; const original = structuredClone(scene);
    const initial: NetworkPipeLevelPlan = {
      id: 'checked-risers', feasible: true, issues: [], notes: [], affectedIds: ['gas', 'liquid'],
      sourceSignatures: Object.fromEntries([gas, liquid].map(element => [element.id, networkLevelSourceSignature(element)])),
      updates: [], lockedRoutes: [], settings, gasElevationMm: 2400, liquidElevationMm: 2300,
      clearGapMm: 65, coordinatedRunCount: 0, connectedIndoorCount: 1, connectedOutdoorCount: 1,
      transitionCount: 2, verticalTravelMm: 1200, requiresCoordination: false,
    };
    const preferred = replanNetworkPipeRisers(scene, initial, true);
    expect(preferred.feasible).toBe(true);
    expect(hasNewNetworkPipeClash(scene, preferred.updates)).toBe(true);
    const fallback = replanNetworkPipeRisers(scene, preferred, false);
    expect(fallback.feasible).toBe(true);
    expect(fallback.updates).toHaveLength(2);
    expect(hasNewNetworkPipeClash(scene, fallback.updates)).toBe(false);
    expect(fallback.gasElevationMm).toBe(preferred.gasElevationMm);
    expect(fallback.liquidElevationMm).toBe(preferred.liquidElevationMm);
    expect(fallback.coordinatedRunCount).toBe(2);
    expect(fallback.requiresCoordination).toBe(true);
    expect(fallback.sourceSignatures).toEqual(preferred.sourceSignatures);
    for (const pipe of fallback.updates) {
      expect(pipe.properties.networkLevelPlan).toMatchObject({ preferCornerRisers: false });
    }
    // Both the displayed plan and a later ordinary application keep the
    // collision-checked preference instead of restoring the unsafe corner.
    expect(applyNetworkPipeLevels([gas, liquid], fallback).elements).toEqual(fallback.updates);
    expect(applyNetworkPipeLevels(fallback.updates, { ...fallback, preferCornerRisers: undefined }).elements)
      .toEqual(fallback.updates);
    expect(scene).toEqual(original);
    expect(initial.updates).toEqual([]);
    expect(preferred.preferCornerRisers).toBe(true);
  });
});
