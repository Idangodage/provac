import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { buildBranchKitInsertion, buildBranchKitRoutePreview, proposeBranchKit } from './branchKitProposal';
import { compileCopperSocketElbowRoute } from './copperSocketElbowRoute';
import { findNewNetworkPipeClashes } from './networkPipeClearance';
import { applyNetworkPipeLevels, replanNetworkPipeRisers, type NetworkPipeLevelPlan } from './networkPipeLevels';
import { normalizePipeRouteNodes3d } from './pipeRoute3d';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from './pipeRoutingSettings';
import type { RefrigerantPipeBundleConnection } from './refrigerantPipePairModel';

const point = (x: number, y: number) => ({ x, y });

function pipe(id: string, y: number, cornerX: number): HvacElement {
  const route = [point(0, y), point(cornerX, y), point(cornerX, 2000)];
  return {
    id, type: 'refrigerant-pipe', position: point(0, y), width: cornerX, depth: 2000 - y,
    height: 66.675, elevation: 2166.6625, rotation: 0, label: id, mountType: 'ceiling', supplyZoneRatio: 0,
    properties: {
      lineKind: id, routePoints: route, authoredCenterlineRoute: route,
      pipeDiameterMm: 15.875, insulationThicknessMm: 25.4, outerDiameterMm: 66.675,
      startConnection: { portPoint: route[0], direction: point(1, 0), elevationMm: 2200,
        connectionKind: 'unit-port', sourceElementId: `unit-${id}` },
    },
  };
}

function selectedPlan(): NetworkPipeLevelPlan {
  return {
    id: 'selective-risers', feasible: true, issues: [], affectedIds: ['gas', 'liquid'],
    sourceSignatures: {}, updates: [], lockedRoutes: [], settings: DEFAULT_PIPE_ROUTING_SETTINGS,
    gasElevationMm: 2800, liquidElevationMm: 3000, clearGapMm: 133.325,
    coordinatedRunCount: 2, connectedIndoorCount: 2, connectedOutdoorCount: 0,
    transitionCount: 2, verticalTravelMm: 1400, requiresCoordination: true, notes: [],
  };
}

function fittingCount(element: HvacElement): number {
  const compiled = compileCopperSocketElbowRoute(normalizePipeRouteNodes3d(element.properties.routeNodes3d), 15.875,
    { startStraightMm: 200 });
  expect(compiled.issues).toEqual([]);
  return compiled.fittings.length;
}

describe('selective straight-riser fallback clearance fixtures', () => {
  it.each(['gas', 'liquid'])('keeps the other service at two elbows when only %s is obstructed', obstructed => {
    const pair = [pipe('gas', 0, 1000), pipe('liquid', 300, 1300)];
    const obstacleY = obstructed === 'gas' ? 0 : 300;
    const obstacleX = obstructed === 'gas' ? 1000 : 1300;
    const obstruction = {
      ...pipe('obstacle', obstacleY - 100, obstacleX),
      properties: { lineKind: 'gas', pipeDiameterMm: 15.875, insulationThicknessMm: 25.4, outerDiameterMm: 66.675,
        routePoints: [point(obstacleX - 100, obstacleY), point(obstacleX + 100, obstacleY)],
        routeNodes3d: [{ x: obstacleX - 100, y: obstacleY, z: 2500 }, { x: obstacleX + 100, y: obstacleY, z: 2500 }],
      },
    } as HvacElement;
    const plan = selectedPlan();
    const corners = applyNetworkPipeLevels(pair, plan);
    const straights = applyNetworkPipeLevels(pair, { ...plan, preferCornerRisers: false });
    expect(corners.issues).toEqual([]);
    expect(straights.issues).toEqual([]);
    expect(corners.elements.map(fittingCount)).toEqual([2, 2]);
    expect(straights.elements.map(fittingCount)).toEqual([3, 3]);
    const clashes = findNewNetworkPipeClashes([obstruction], corners.elements);
    expect(clashes).toHaveLength(1);
    expect(clashes[0]!.elementIds).toContain(obstructed);

    const preferences = { gas: obstructed !== 'gas', liquid: obstructed !== 'liquid' };
    const selected = { ...plan, preferCornerRisers: true, cornerRisersByService: preferences };
    const mixed = applyNetworkPipeLevels(pair, selected).elements;
    expect(findNewNetworkPipeClashes([obstruction], mixed)).toEqual([]);
    expect(findNewNetworkPipeClashes([obstruction], straights.elements)).toEqual([]);
    expect(mixed.map(fittingCount)).toEqual(obstructed === 'gas' ? [3, 2] : [2, 3]);

    // Persisting the checked fallback on its own run survives application,
    // whereas a global false preference would erase the other valid corner.
    const reapplication = applyNetworkPipeLevels(mixed, plan);
    expect(reapplication.issues).toEqual([]);
    expect(reapplication.elements.map(fittingCount)).toEqual(mixed.map(fittingCount));
    expect(findNewNetworkPipeClashes([obstruction], reapplication.elements)).toEqual([]);

    // Preview and commit regenerate IDs. The selected service policy must also
    // apply to new unstamped runs, overriding the global corner preference.
    const regenerated = applyNetworkPipeLevels(pair.map(element => ({ ...element, id: `committed-${element.id}` })), selected);
    expect(regenerated.issues).toEqual([]);
    expect(regenerated.elements.map(fittingCount)).toEqual(mixed.map(fittingCount));
    expect(findNewNetworkPipeClashes([obstruction], regenerated.elements)).toEqual([]);
  });

  it.each(['gas', 'liquid'])('keeps a selected %s fallback identical in branch preview and committed pipes', obstructed => {
    const hosts = [pipe('gas', 0, 6000), pipe('liquid', 80, 6000)].map(element => {
      const level = element.id === 'gas' ? 2600 : 2800;
      const route = [point(0, element.position.y), point(6000, element.position.y)];
      return { ...element, elevation: level - 66.675 / 2, properties: {
        ...element.properties, bundleId: 'host-pair', routePoints: route, authoredCenterlineRoute: route,
        routeNodes3d: route.map(node => ({ ...node, z: level })), startConnection: null,
        networkLevelLocked: true,
      } };
    });
    const start: RefrigerantPipeBundleConnection = {
      point: point(2000, 2000), gasPoint: point(1960, 2000), liquidPoint: point(2040, 2000),
      gasFieldPoint: point(1960, 2000), liquidFieldPoint: point(2040, 2000),
      direction: point(0, -1), gasDirection: point(0, -1), liquidDirection: point(0, -1),
      gasOuterDiameterMm: 66.675, liquidOuterDiameterMm: 60.325,
      connectionKind: 'unit-port', sourceElementId: 'branch-unit',
      elevationMm: 2200, gasElevationMm: 2200, liquidElevationMm: 2200,
    };
    const proposal = proposeBranchKit(hosts, start, point(4000, 40), { maxRecoveryStations: 0 });
    expect(proposal).not.toBeNull();
    expect(proposal!.validity, proposal!.violations.join(' ')).not.toBe('invalid');
    const preferences = { gas: obstructed !== 'gas', liquid: obstructed !== 'liquid' };
    proposal!.levelPlan = replanNetworkPipeRisers(hosts, proposal!.levelPlan!, true, preferences);
    const preview = buildBranchKitRoutePreview(proposal!, start);
    const insertion = buildBranchKitInsertion(proposal!, start, hosts);
    expect(preview).toHaveLength(2);
    expect(insertion).not.toBeNull();
    const committed = insertion!.elementsToAdd.filter(element => element.properties.routeClass === 'indoor-connection');
    expect(committed).toHaveLength(2);
    for (const service of ['gas', 'liquid'] as const) {
      const before = preview.find(element => element.properties.lineKind === service)!;
      const after = committed.find(element => element.properties.lineKind === service)!;
      expect(after.id).not.toBe(before.id);
      expect(after.properties.networkLevelPlan).toMatchObject({ preferCornerRisers: preferences[service] });
      expect(normalizePipeRouteNodes3d(after.properties.routeNodes3d))
        .toEqual(normalizePipeRouteNodes3d(before.properties.routeNodes3d));
    }
  });
});
