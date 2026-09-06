import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { planNetworkPipeLevels } from './networkPipeLevels';
import { normalizePipeRouteNodes3d } from './pipeRoute3d';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from './pipeRoutingSettings';
import type { RefrigerantPipeBundleConnection, RefrigerantPipeConnection } from './refrigerantPipePairModel';

const settings = { ...DEFAULT_PIPE_ROUTING_SETTINGS };
const bundle: RefrigerantPipeBundleConnection = {
  point: { x: 0, y: 100 }, gasPoint: { x: 0, y: 0 }, liquidPoint: { x: 0, y: 200 },
  gasFieldPoint: { x: 0, y: 0 }, liquidFieldPoint: { x: 0, y: 200 }, direction: { x: 1, y: 0 },
  gasOuterDiameterMm: 80, liquidOuterDiameterMm: 70,
  connectionKind: 'field-pipe', elevationMm: 2600, gasElevationMm: 2600, liquidElevationMm: 2600,
  sourceElementId: 'gas', gasSourceElementId: 'gas', liquidSourceElementId: 'liquid',
};

function pipe(id: string, service: 'gas' | 'liquid', level: number, length = 5000, properties: Record<string, unknown> = {}): HvacElement {
  const outer = service === 'gas' ? 80 : 70;
  const y = service === 'gas' ? 0 : 200;
  return {
    id, type: 'refrigerant-pipe', position: { x: 0, y }, width: length, depth: outer,
    height: outer, elevation: level - outer / 2, rotation: 0, label: id, mountType: 'ceiling', supplyZoneRatio: 0,
    properties: { lineKind: service, bundleId: 'main', routePoints: [{ x: 0, y }, { x: length, y }],
      pipeDiameterMm: outer - 50.8, outerDiameterMm: outer, insulationThicknessMm: 25.4, ...properties },
  };
}

function port(id: string, x: number, y: number): RefrigerantPipeConnection {
  return { connectionKind: 'unit-port', sourceElementId: id, portId: `${id}:gas`,
    portPoint: { x, y }, direction: { x: x ? -1 : 1, y: 0 }, elevationMm: 2600 };
}

function plan(scene: HvacElement[], gas = 2600, liquid = 2600) {
  return planNetworkPipeLevels(scene, { gasHostId: 'gas', liquidHostId: 'liquid', startBundle: bundle,
    gasHostElevationMm: gas, liquidHostElevationMm: liquid, settings });
}

describe('feasible network level selection', () => {
  it('tries the other service order when the cheapest terminal transition cannot fit', () => {
    // Moving liquid would need just one terminal transition, so its geometric
    // cost is better. Its 350 mm approach cannot fit the socket and two
    // full-radius riser bends; moving
    // gas instead fits both ends of the long gas route.
    const gas = pipe('gas', 'gas', 2600, 5000, {
      startConnection: port('gas-unit-a', 0, 0), endConnection: port('gas-unit-b', 5000, 0),
    });
    const liquid = pipe('liquid', 'liquid', 2600, 350, { startConnection: port('liquid-unit', 0, 200) });
    const result = plan([gas, liquid]);
    expect(result.feasible, result.issues.join(' ')).toBe(true);
    expect(result.liquidElevationMm).toBe(2600);
    expect(Math.abs(result.gasElevationMm - 2600)).toBeGreaterThan(100);
    expect(result.transitionCount).toBe(2);
    expect(result.coordinatedRunCount).toBe(1);
    for (const update of result.updates) {
      const nodes = normalizePipeRouteNodes3d(update.properties.routeNodes3d);
      expect(nodes[0]!.z).toBe(2600);
      if (update.id === 'gas') expect(nodes.at(-1)!.z).toBe(2600);
    }
  });

  it('returns a route feasibility issue when every admissible alternative fails', () => {
    const gas = pipe('gas', 'gas', 2600, 350, { startConnection: port('gas-unit', 0, 0) });
    const liquid = pipe('liquid', 'liquid', 2600, 350, { startConnection: port('liquid-unit', 0, 200) });
    const result = plan([gas, liquid]);
    expect(result.feasible).toBe(false);
    expect(result.issues.some(issue => /straight approach|full-radius/.test(issue))).toBe(true);
    expect(result.updates).toEqual([]);
    expect(result.requiresCoordination).toBe(false);
  });

  it('keeps a feasible established corridor when another unit would favor different levels', () => {
    const initial = plan([pipe('gas', 'gas', 2800), pipe('liquid', 'liquid', 2650)], 2800, 2650);
    expect(initial.feasible).toBe(true);
    const newBranch = pipe('new-branch', 'gas', 2600, 5000, { startConnection: port('new-unit', 0, 0) });
    const result = plan([...initial.updates, newBranch], 2600, 2400);
    expect(result.feasible, result.issues.join(' ')).toBe(true);
    expect([result.gasElevationMm, result.liquidElevationMm]).toEqual([2800, 2650]);
  });
});

describe('network change disclosure', () => {
  it('discloses a remote branch change even when both tapped mains retain their levels', () => {
    const result = plan([pipe('gas', 'gas', 2700), pipe('liquid', 'liquid', 2500), pipe('remote', 'gas', 2400)], 2700, 2500);
    expect(result.feasible).toBe(true);
    expect([result.gasElevationMm, result.liquidElevationMm]).toEqual([2700, 2500]);
    expect(result.requiresCoordination).toBe(true);
    expect(result.coordinatedRunCount).toBe(1);
  });

  it('does not count metadata adoption or redundant level stations as moved runs', () => {
    const gas = pipe('gas', 'gas', 2700, 5000, { routeNodes3d: [
      { x: 0, y: 0, z: 2700 }, { x: 800, y: 0, z: 2700 }, { x: 5000, y: 0, z: 2700 },
    ] });
    const first = plan([gas, pipe('liquid', 'liquid', 2500)], 2700, 2500);
    expect(first.feasible).toBe(true);
    expect(first.updates.length).toBe(2);
    expect(first.coordinatedRunCount).toBe(0);
    expect(first.requiresCoordination).toBe(false);
    const second = plan(first.updates, 2700, 2500);
    expect(second.feasible).toBe(true);
    expect(second.coordinatedRunCount).toBe(0);
    expect(second.requiresCoordination).toBe(false);
  });
});
