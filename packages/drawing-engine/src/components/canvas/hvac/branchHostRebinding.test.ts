import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import { buildBranchKitInsertion, proposeBranchKit } from './branchKitProposal';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import {
  buildRefrigerantPipeElement,
  buildRefrigerantPipeElements,
  getRefrigerantPipeBundleSnapTargets,
  type RefrigerantPipeBundleConnection,
  type RefrigerantPipeConnection,
} from './refrigerantPipePairModel';

// Isolate source-identity remapping from the separate tube-clearance contract.
// The geometry integration suites exercise the real collision screen.
vi.mock('./networkPipeClearance', () => ({ findNewNetworkPipeClashes: () => [], hasNewNetworkPipeClash: () => false }));

function fixture(alias: 'id' | 'bundle', reverse: boolean) {
  const outdoor: HvacElement = {
    id: 'outdoor', type: 'outdoor-unit', position: { x: -900, y: 0 }, width: 900, depth: 400,
    height: 1000, elevation: 1800, rotation: 0, mountType: 'floor', label: 'Outdoor', supplyZoneRatio: 0, properties: {},
  };
  const outdoorBundle = getRefrigerantPipeBundleSnapTargets([outdoor])[0]!;
  const mains = buildRefrigerantPipeElements([outdoorBundle.point, { x: 12000, y: outdoorBundle.point.y }], {
    startBundleConnection: outdoorBundle, bundleId: 'original-main',
  }).map(element => ({ ...element, id: `main-${element.properties!.lineKind}` }) as HvacElement);
  const tails = mains.map(main => {
    const service = main.properties.lineKind as 'gas' | 'liquid';
    const end = (main.properties.routePoints as Point2D[]).at(-1)!;
    const z = service === 'gas' ? outdoorBundle.gasElevationMm : outdoorBundle.liquidElevationMm;
    const connection: RefrigerantPipeConnection = {
      connectionKind: 'field-pipe', sourceElementId: alias === 'id' ? main.id : 'original-main',
      portPoint: end, direction: { x: 1, y: 0 }, elevationMm: z,
    };
    const built = buildRefrigerantPipeElement([end, { x: 18000, y: end.y }], {
      lineKind: service, pipeDiameterMm: main.properties.pipeDiameterMm as number,
      outerDiameterMm: main.properties.outerDiameterMm as number,
      insulationThicknessMm: main.properties.insulationThicknessMm as number,
      bundleId: 'tail-pair', startConnection: connection,
    });
    return { ...built, id: `tail-${service}`, properties: { ...built.properties,
      ...(service === 'gas' ? { networkLevelLocked: true,
        routeNodes3d: [end, { x: 18000, y: end.y }].map(point => ({ ...point, z })) } : {}),
    } } as HvacElement;
  });
  if (reverse) for (const main of mains) main.properties = {
    ...main.properties, routePoints: [...main.properties.routePoints as Point2D[]].reverse(),
    endConnection: main.properties.startConnection, startConnection: null,
  };
  const start: RefrigerantPipeBundleConnection = {
    point: { x: 4500, y: 5000 }, gasPoint: { x: 4460, y: 5000 }, liquidPoint: { x: 4540, y: 5000 },
    gasFieldPoint: { x: 4460, y: 5000 }, liquidFieldPoint: { x: 4540, y: 5000 },
    direction: { x: 0, y: -1 }, gasDirection: { x: 0, y: -1 }, liquidDirection: { x: 0, y: -1 },
    connectionKind: 'unit-port', sourceElementId: 'new-indoor',
    elevationMm: outdoorBundle.gasElevationMm, gasElevationMm: outdoorBundle.gasElevationMm, liquidElevationMm: outdoorBundle.gasElevationMm,
  };
  return { scene: [outdoor, ...mains, ...tails], start, cursor: { x: 4500, y: outdoorBundle.point.y } };
}

describe('branch host replacement keeps source-only continuations connected', () => {
  beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

  it.each([
    { alias: 'id' as const, reverse: false }, { alias: 'bundle' as const, reverse: false },
    { alias: 'id' as const, reverse: true }, { alias: 'bundle' as const, reverse: true },
  ])('rebinds $alias references for reverse-authored=$reverse without modifying locked geometry', ({ alias, reverse }) => {
    const { scene, start, cursor } = fixture(alias, reverse);
    const originalLocked = scene.find(element => element.id === 'tail-gas')!;
    const proposal = proposeBranchKit(scene, start, cursor)!;
    expect(proposal).not.toBeNull();
    expect(proposal.validity, proposal.violations.join(' ')).not.toBe('invalid');
    const insertion = buildBranchKitInsertion(proposal, start, scene)!;
    expect(insertion).not.toBeNull();
    const updates = new Map(insertion.updates!.map(element => [element.id, element]));
    for (const service of ['gas', 'liquid']) {
      const tail = updates.get(`tail-${service}`)!;
      expect(tail).toBeDefined();
      const connection = tail.properties.startConnection as RefrigerantPipeConnection;
      expect(connection.sourceElementId).not.toBe(`main-${service}`);
      expect(connection.sourceElementId).not.toBe('original-main');
      const replacement = insertion.elementsToAdd.find(element => element.id === connection.sourceElementId)!;
      expect(replacement).toBeDefined();
      expect(replacement.properties.lineKind).toBe(service);
      expect(replacement.properties.teeRole).toBe('run-out');
      expect((replacement.properties.routePoints as Point2D[]).some(point =>
        Math.hypot(point.x - connection.portPoint.x, point.y - connection.portPoint.y) < 0.5)).toBe(true);
    }
    const locked = updates.get('tail-gas')!;
    expect(locked.properties.networkLevelLocked).toBe(true);
    expect(locked.properties.routePoints).toEqual(originalLocked.properties.routePoints);
    expect(locked.properties.routeNodes3d).toEqual(originalLocked.properties.routeNodes3d);
    expect(locked.elevation).toBe(originalLocked.elevation);

    const removed = new Set(insertion.removeElementIds);
    const applied = [...scene.filter(element => !removed.has(element.id)).map(element => updates.get(element.id) ?? element), ...insertion.elementsToAdd];
    const second = proposeBranchKit(applied, { ...start, sourceElementId: 'another-indoor' }, { x: 14500, y: cursor.y });
    expect(second).not.toBeNull();
    expect(second!.orientationLocked).toBe(true);
    expect(second!.levelPlan?.connectedOutdoorCount).toBe(1);
    expect(second!.levelPlan?.affectedIds).toContain('outdoor');
    expect(second!.gasGhost.inletPoint.x).toBeLessThan(second!.gasGhost.runOutletPoint.x);
  });
});
