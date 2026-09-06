import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import {
  applyNetworkPipeLevels,
  buildNetworkLevelRoute,
  isNetworkLevelPlanCurrent,
  planNetworkPipeLevels,
} from './networkPipeLevels';
import { normalizePipeRouteNodes3d, type PipeRouteNode3D } from './pipeRoute3d';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from './pipeRoutingSettings';
import {
  getRefrigerantPipeBundleSnapTargets,
  type RefrigerantPipeBundleConnection,
  type RefrigerantPipeConnection,
} from './refrigerantPipePairModel';

const settings = { ...DEFAULT_PIPE_ROUTING_SETTINGS };
const point = (x: number, y = 0): Point2D => ({ x, y });
const bundle: RefrigerantPipeBundleConnection = {
  point: point(0, 40), gasPoint: point(0), liquidPoint: point(0, 80),
  gasFieldPoint: point(0), liquidFieldPoint: point(0, 80), direction: point(1),
  gasDirection: point(1), liquidDirection: point(1), gasOuterDiameterMm: 40, liquidOuterDiameterMm: 30,
  connectionKind: 'field-pipe', elevationMm: 2625, gasElevationMm: 2700, liquidElevationMm: 2550,
  sourceElementId: 'gas', gasSourceElementId: 'gas', liquidSourceElementId: 'liquid',
};

function pipe(id: string, service: 'gas' | 'liquid', level: number, properties: Record<string, unknown> = {}): HvacElement {
  const outer = service === 'gas' ? 80 : 70;
  const y = service === 'gas' ? 0 : 80;
  return {
    id, type: 'refrigerant-pipe', position: point(0, y), width: 10000, depth: outer,
    height: outer, elevation: level - outer / 2, rotation: 0, label: id, mountType: 'ceiling', supplyZoneRatio: 0,
    properties: { lineKind: service, bundleId: 'main', routePoints: [point(0, y), point(10000, y)],
      pipeDiameterMm: outer - 50.8, outerDiameterMm: outer, insulationThicknessMm: 25.4, ...properties },
  };
}

function equipment(id: string, type: 'outdoor-unit' | 'wall-mounted-ac', elevation: number, rotation = 0): HvacElement {
  return { id, type, position: point(type === 'outdoor-unit' ? 0 : 10000, 1000),
    width: 900, depth: 350, height: 700, rotation, elevation, mountType: type === 'outdoor-unit' ? 'floor' : 'wall',
    supplyZoneRatio: 0, label: id, properties: {} };
}

function sideConnection(target: RefrigerantPipeBundleConnection, service: 'gas' | 'liquid'): RefrigerantPipeConnection {
  return {
    portPoint: service === 'gas' ? target.gasPoint : target.liquidPoint,
    direction: (service === 'gas' ? target.gasDirection : target.liquidDirection) ?? target.direction,
    elevationMm: service === 'gas' ? target.gasElevationMm : target.liquidElevationMm,
    sourceElementId: target.sourceElementId, connectionKind: target.connectionKind,
    ...(target.terminalRole ? { terminalRole: target.terminalRole } : {}),
  };
}

function plan(scene: HvacElement[], startBundle = bundle) {
  return planNetworkPipeLevels(scene, { gasHostId: 'gas', liquidHostId: 'liquid', startBundle,
    gasHostElevationMm: 2700, liquidHostElevationMm: 2550, settings });
}

function withUpdates(scene: HvacElement[], updates: HvacElement[]): HvacElement[] {
  const byId = new Map(updates.map(element => [element.id, element]));
  return scene.map(element => byId.get(element.id) ?? element);
}

function elevationDirections(nodes: PipeRouteNode3D[]): number[] {
  return nodes.slice(1).map((node, index) => Math.sign(node.z - nodes[index]!.z)).filter(Boolean);
}

describe('network level scope and service corridors', () => {
  it('uses only connected equipment and keeps an admissible existing main level', () => {
    const main = [pipe('gas', 'gas', 2700), pipe('liquid', 'liquid', 2550)];
    const baseline = plan(main);
    const unrelated = [equipment('nearby-outdoor', 'outdoor-unit', 200), equipment('nearby-indoor', 'wall-mounted-ac', 1200)];
    const surrounded = plan([...main, ...unrelated]);
    expect(baseline.feasible).toBe(true);
    expect(surrounded.affectedIds.sort()).toEqual(['gas', 'liquid']);
    expect(surrounded.connectedIndoorCount).toBe(0);
    expect(surrounded.connectedOutdoorCount).toBe(0);
    expect([surrounded.gasElevationMm, surrounded.liquidElevationMm]).toEqual([2700, 2550]);
    expect(surrounded.updates).toEqual(baseline.updates);
  });

  it('provides a constant service corridor with separation measured outside the insulation', () => {
    const result = plan([pipe('gas', 'gas', 2600), pipe('liquid', 'liquid', 2600)]);
    expect(result.feasible).toBe(true);
    expect(Math.abs(result.gasElevationMm - result.liquidElevationMm) - 40 - 35)
      .toBeCloseTo(result.clearGapMm, 6);
    expect(result.clearGapMm).toBeGreaterThanOrEqual(Math.max(settings.defaultPipeGapMm, settings.zOffsetClearanceMm));
    for (const update of result.updates) {
      const nodes = normalizePipeRouteNodes3d(update.properties.routeNodes3d);
      expect(nodes.length).toBeGreaterThanOrEqual(2);
      expect(new Set(nodes.map(node => node.z)).size).toBe(1);
      expect(update.properties.bypasses).toBeUndefined();
    }
  });

  it('preserves the real elevations and orientations of rotated indoor and outdoor ports', () => {
    const outdoor = equipment('outdoor', 'outdoor-unit', 100, 90);
    const indoor = equipment('indoor', 'wall-mounted-ac', 1700, 270);
    const outdoorBundle = getRefrigerantPipeBundleSnapTargets([outdoor])[0]!;
    const indoorBundle = getRefrigerantPipeBundleSnapTargets([indoor])[0]!;
    expect(outdoorBundle).toBeDefined();
    expect(indoorBundle).toBeDefined();
    const main = (['gas', 'liquid'] as const).map(service => {
      const start = sideConnection(outdoorBundle, service);
      const end = sideConnection(indoorBundle, service);
      const offset = (connection: RefrigerantPipeConnection) => ({
        x: connection.portPoint.x + connection.direction.x * 5000,
        y: connection.portPoint.y + connection.direction.y * 5000,
      });
      return pipe(service, service, service === 'gas' ? 2700 : 2550, {
        startConnection: start, endConnection: end,
        routePoints: [start.portPoint, offset(start), offset(end), end.portPoint],
      });
    });
    const scene = [outdoor, indoor, ...main];
    const result = plan(scene, indoorBundle);
    expect(result.feasible, result.issues.join(' ')).toBe(true);
    expect(result.connectedIndoorCount).toBe(1);
    expect(result.connectedOutdoorCount).toBe(1);
    for (const update of result.updates.filter(element => element.type === 'refrigerant-pipe')) {
      const original = main.find(element => element.id === update.id)!;
      const start = original.properties.startConnection as RefrigerantPipeConnection;
      const end = original.properties.endConnection as RefrigerantPipeConnection;
      const nodes = normalizePipeRouteNodes3d(update.properties.routeNodes3d);
      expect(update.properties.startConnection).toMatchObject(start);
      expect(update.properties.endConnection).toMatchObject(end);
      expect(nodes[0]!.x).toBeCloseTo(start.portPoint.x, 6);
      expect(nodes[0]!.y).toBeCloseTo(start.portPoint.y, 6);
      expect(nodes[0]!.z).toBeCloseTo(start.elevationMm, 6);
      expect(nodes.at(-1)!.x).toBeCloseTo(end.portPoint.x, 6);
      expect(nodes.at(-1)!.y).toBeCloseTo(end.portPoint.y, 6);
      expect(nodes.at(-1)!.z).toBeCloseTo(end.elevationMm, 6);
      const first = nodes[1]!;
      expect((first.x - nodes[0]!.x) * start.direction.y - (first.y - nodes[0]!.y) * start.direction.x).toBeCloseTo(0, 6);
    }
    expect(result.updates.some(element => element.id === indoor.id || element.id === outdoor.id)).toBe(false);
  });

  it('reapplying generated levels is idempotent and creates no local rise-and-return', () => {
    const scene = [pipe('gas', 'gas', 2600), pipe('liquid', 'liquid', 2600)];
    const first = plan(scene);
    const updated = withUpdates(scene, first.updates);
    const second = plan(updated);
    expect(second.feasible).toBe(true);
    expect(second.updates).toEqual(first.updates);
    for (const element of second.updates) {
      const directions = elevationDirections(normalizePipeRouteNodes3d(element.properties.routeNodes3d));
      expect(new Set(directions).size).toBeLessThanOrEqual(1);
    }
    expect(applyNetworkPipeLevels(updated, second).elements).toEqual(second.updates);
  });

  it('prefers a higher service tier over an equally feasible low pocket between level terminals', () => {
    const outdoor = equipment('outdoor-level', 'outdoor-unit', 2000);
    const indoor = equipment('indoor-level', 'wall-mounted-ac', 2000);
    const terminal = (sourceElementId: string, x: number, y: number): RefrigerantPipeConnection => ({
      sourceElementId, connectionKind: 'unit-port', portPoint: point(x, y),
      direction: point(x ? -1 : 1), elevationMm: 2600,
    });
    const scene = [outdoor, indoor, ...(['gas', 'liquid'] as const).map(service => {
      const y = service === 'gas' ? 0 : 80;
      return pipe(service, service, 2600, {
        startConnection: terminal(outdoor.id, 0, y), endConnection: terminal(indoor.id, 10000, y),
      });
    })];
    const result = planNetworkPipeLevels(scene, {
      gasHostId: 'gas', liquidHostId: 'liquid',
      gasHostElevationMm: 2600, liquidHostElevationMm: 2600,
      startBundle: { ...bundle, connectionKind: 'unit-port', sourceElementId: indoor.id,
        gasElevationMm: 2600, liquidElevationMm: 2600, elevationMm: 2600 }, settings,
    });
    expect(result.feasible, result.issues.join(' ')).toBe(true);
    expect(result.connectedOutdoorCount).toBe(1);
    expect(result.connectedIndoorCount).toBe(1);
    expect(Math.min(result.gasElevationMm, result.liquidElevationMm)).toBeGreaterThanOrEqual(2600);
    expect(Math.max(result.gasElevationMm, result.liquidElevationMm)).toBeGreaterThan(2600);
    expect(Math.abs(result.gasElevationMm - result.liquidElevationMm)).toBeGreaterThanOrEqual(150);
    for (const update of result.updates) {
      const nodes = normalizePipeRouteNodes3d(update.properties.routeNodes3d);
      expect(nodes[0]!.z).toBe(2600);
      expect(nodes.at(-1)!.z).toBe(2600);
      expect(nodes.every(node => node.z >= 2600)).toBe(true);
    }
  });

  it('does not automatically coordinate a connected system with multiple rotated outdoor modules', () => {
    const outdoors = [equipment('module-a', 'outdoor-unit', 2000, 90), equipment('module-b', 'outdoor-unit', 2000, 270)];
    const mains = (['gas', 'liquid'] as const).map(service => pipe(service, service, 2600, {
      startConnection: { connectionKind: 'unit-port', sourceElementId: outdoors[0]!.id,
        portPoint: point(0), direction: point(0, 1), elevationMm: 2600 },
      endConnection: { connectionKind: 'unit-port', sourceElementId: outdoors[1]!.id,
        portPoint: point(10000), direction: point(0, -1), elevationMm: 2600 },
    }));
    const scene = [...outdoors, ...mains];
    const original = JSON.stringify(scene);
    const result = plan(scene);
    expect(result.connectedOutdoorCount).toBe(2);
    expect(result.feasible).toBe(false);
    expect(result.issues.join(' ')).toContain('Multiple outdoor modules');
    expect(result.updates).toHaveLength(0);
    expect(JSON.stringify(scene)).toBe(original);
  });
});

describe('terminal transitions and protected routing', () => {
  const field = (elevationMm: number, x: number): RefrigerantPipeConnection => ({
    connectionKind: 'field-pipe', terminalRole: 'branch-outlet', sourceElementId: 'kit',
    portPoint: point(x), direction: point(x ? -1 : 1), elevationMm,
  });

  it('uses one monotonic transition and preserves a level straight at the REFNET socket', () => {
    const result = buildNetworkLevelRoute([point(0), point(5000)], 2700, {
      start: field(2400, 0), end: field(2700, 5000), radiusMm: 20, settings,
    });
    expect(result.issue).toBeUndefined();
    expect(result.nodes[0]).toEqual({ x: 0, y: 0, z: 2400 });
    expect(result.nodes.at(-1)).toEqual({ x: 5000, y: 0, z: 2700 });
    expect(new Set(elevationDirections(result.nodes))).toEqual(new Set([1]));
    const firstRise = result.nodes.findIndex((node, index) => index > 0 && node.z !== result.nodes[index - 1]!.z);
    expect(result.nodes[firstRise - 1]!.x).toBeGreaterThanOrEqual(settings.defaultBranchKitClearanceMm);
  });

  it('combines the rise and direction change at a corner with enough socket straight', () => {
    const result = buildNetworkLevelRoute([point(0), point(350), point(350, 3000)], 2700, {
      start: field(2400, 0), radiusMm: 20, settings,
    });
    expect(result.issue).toBeUndefined();
    {
      const varying = result.nodes.slice(1).flatMap((node, index) => node.z !== result.nodes[index]!.z
        ? [{ start: result.nodes[index]!, end: node }] : []);
      expect(varying.length).toBeGreaterThan(0);
      expect(varying).toHaveLength(1);
      expect(varying[0]!.start.x).toBeCloseTo(varying[0]!.end.x, 6);
      expect(varying[0]!.start.y).toBeCloseTo(varying[0]!.end.y, 6);
      // 300 mm socket straight + 40 mm elbow setback fit before this corner.
      // The second vertical-plane elbow turns directly into the outgoing leg.
      expect(varying[0]!.start).toEqual({ x: 350, y: 0, z: 2400 });
      expect(varying[0]!.end).toEqual({ x: 350, y: 0, z: 2700 });
    }
  });

  it('rejects an approach too short for the socket straight and level transition', () => {
    const result = buildNetworkLevelRoute([point(0), point(400)], 2800, {
      start: field(2400, 0), radiusMm: 20, settings,
    });
    expect(result.issue).toBeTruthy();
    expect(result.nodes).toHaveLength(0);
  });

  it('uses the whole straight approach when it contains several authored waypoints', () => {
    const options = { start: field(2400, 0), radiusMm: 20, settings };
    const simple = buildNetworkLevelRoute([point(0), point(2000)], 2800, options);
    const sampled = buildNetworkLevelRoute(Array.from({ length: 21 }, (_, index) => point(index * 100)), 2800, options);
    expect(simple.issue).toBeUndefined();
    expect(sampled.issue).toBeUndefined();
    expect(sampled.nodes).toEqual(simple.nodes);
  });

  it.each([1000, 2800])('localizes a tall rise/drop from %s without an inclined straight', level => {
    const result = buildNetworkLevelRoute([point(0), point(1200)], 2200, {
      start: field(level, 0), radiusMm: 30, settings,
    });
    expect(result.issue).toBeUndefined();
    const vertical = result.nodes.slice(1).filter((node, index) => node.z !== result.nodes[index]!.z);
    expect(vertical).toHaveLength(1);
    for (let i = 1; i < result.nodes.length; i += 1) {
      const a = result.nodes[i - 1]!; const b = result.nodes[i]!;
      expect(Math.abs(b.z - a.z) < 1e-6 || Math.hypot(b.x - a.x, b.y - a.y) < 1e-6).toBe(true);
    }
    expect(vertical[0]!.x).toBe(360);
    expect(result.nodes.at(-1)!.z).toBe(2200);
  });

  it('does not squeeze two full-radius bends into a smaller level difference', () => {
    const result = buildNetworkLevelRoute([point(0), point(5000)], 2700, {
      start: field(2650, 0), radiusMm: 30, settings,
    });
    expect(result.nodes).toEqual([]);
    expect(result.issue).toContain('two full-radius 90-degree bends');
  });

  it('leaves elbow setbacks between both terminal risers', () => {
    const result = buildNetworkLevelRoute([point(0), point(1000)], 2600, {
      start: field(2000, 0), end: field(2800, 1000), radiusMm: 30, settings,
    });
    expect(result.issue).toBeUndefined();
    const vertical = result.nodes.slice(1).filter((node, index) => node.z !== result.nodes[index]!.z);
    expect(vertical).toHaveLength(2);
    expect(vertical[1]!.x - vertical[0]!.x).toBeGreaterThanOrEqual(120);
    expect(new Set(elevationDirections(result.nodes))).toEqual(new Set([1]));
  });

  it.each(['networkLevelLocked', 'authored', 'bypass'] as const)('preserves %s geometry and rejects incompatible fixed separation', mode => {
    const nodes = mode === 'authored' ? [
      { x: 0, y: 0, z: 2500 }, { x: 500, y: 0, z: 2500 },
      { x: 1000, y: 0, z: 2700 }, { x: 10000, y: 0, z: 2700 },
    ] : [{ x: 0, y: 0, z: 2700 }, { x: 10000, y: 0, z: 2700 }];
    const protectedProperties = mode === 'networkLevelLocked' ? { networkLevelLocked: true, routeNodes3d: nodes }
      : mode === 'authored' ? { routeNodes3d: nodes }
        : { bypasses: [{ id: 'existing-offset', enterPoint: point(1000), exitPoint: point(1800), obstaclePoint: point(1400) }] };
    const gas = pipe('gas', 'gas', 2700, protectedProperties);
    const scene = [gas, pipe('liquid', 'liquid', 2550)];
    const snapshot = JSON.stringify(gas);
    const result = plan(scene);
    expect(result.feasible, result.issues.join(' ')).toBe(true);
    expect(result.updates.some(update => update.id === gas.id)).toBe(false);
    expect(JSON.stringify(gas)).toBe(snapshot);
    const conflict = plan([gas, pipe('liquid', 'liquid', 2670, { networkLevelLocked: true })]);
    expect(conflict.feasible).toBe(false);
    expect(conflict.issues.length).toBeGreaterThan(0);
  });

  it('preserves a locked route boundary level while the neighbor makes one monotonic transition to its corridor', () => {
    const locked = pipe('locked-gas', 'gas', 2700, {
      networkLevelLocked: true, routeNodes3d: [
        { x: 0, y: 0, z: 2500 }, { x: 1000, y: 0, z: 2500 },
        { x: 2000, y: 0, z: 2700 }, { x: 10000, y: 0, z: 2700 },
      ],
    });
    const boundary: RefrigerantPipeConnection = {
      sourceElementId: locked.id, connectionKind: 'field-pipe',
      portPoint: point(0), direction: point(-1), elevationMm: 2500,
    };
    const neighbor = pipe('gas', 'gas', 2700, {
      routePoints: [point(0), point(-10000)], startConnection: boundary,
    });
    const scene = [locked, neighbor, pipe('liquid', 'liquid', 2550)];
    const snapshot = JSON.stringify(locked);
    const result = plan(scene);
    expect(result.feasible, result.issues.join(' ')).toBe(true);
    expect(result.gasElevationMm).toBe(2700);
    const applied = applyNetworkPipeLevels(scene, result);
    expect(applied.issues).toEqual([]);
    expect(applied.elements.some(element => element.id === locked.id)).toBe(false);
    expect(JSON.stringify(locked)).toBe(snapshot);
    const updated = applied.elements.find(element => element.id === neighbor.id)!;
    expect(updated.properties.startConnection).toMatchObject(boundary);
    const nodes = normalizePipeRouteNodes3d(updated.properties.routeNodes3d);
    expect(nodes[0]).toEqual({ x: 0, y: 0, z: 2500 });
    expect(nodes.at(-1)!.z).toBe(2700);
    expect(new Set(elevationDirections(nodes))).toEqual(new Set([1]));
    const firstRise = nodes.findIndex((node, index) => index > 0 && node.z !== nodes[index - 1]!.z);
    expect(Math.abs(nodes[firstRise - 1]!.x)).toBeGreaterThanOrEqual(settings.defaultBranchKitClearanceMm);
  });
});

describe('network level source snapshots', () => {
  const scene = [pipe('gas', 'gas', 2700), pipe('liquid', 'liquid', 2550)];
  it('rejects a moved, resized or removed member while unrelated additions remain harmless', () => {
    const result = plan(scene);
    expect(isNetworkLevelPlanCurrent(result, scene)).toBe(true);
    expect(isNetworkLevelPlanCurrent(result, [scene[0]!])).toBe(false);
    expect(isNetworkLevelPlanCurrent(result, scene.map(element => element.id === 'gas'
      ? { ...element, elevation: element.elevation + 100 } : element))).toBe(false);
    expect(isNetworkLevelPlanCurrent(result, scene.map(element => element.id === 'gas'
      ? { ...element, height: element.height + 100 } : element))).toBe(false);
    expect(isNetworkLevelPlanCurrent(result, [...scene, equipment('unrelated', 'wall-mounted-ac', 1000)])).toBe(true);
  });

  it('rejects newly connected members whose equipment loads were absent from the preview', () => {
    const result = plan(scene);
    expect(isNetworkLevelPlanCurrent(result, [...scene, pipe('new-connected-line', 'gas', 2700)])).toBe(false);
  });
});
