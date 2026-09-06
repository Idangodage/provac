import { afterEach, describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import { buildBranchKitInsertion, getBranchKitApproachRouteOptions, proposeBranchKit } from './branchKitProposal';
import { findNewNetworkPipeClashes } from './networkPipeClearance';
import { buildOrthogonalConnectionRouteCandidates } from './orthogonalConnectionRoute';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { buildRefrigerantPipeElements, getRefrigerantPipeBundleSnapTargets, resolveRefrigerantPipeSpec } from './refrigerantPipePairModel';

function equipment(id: string, x: number, y: number, outdoor = false): HvacElement {
  return {
    id, type: outdoor ? 'outdoor-unit' : 'ceiling-cassette-ac', category: outdoor ? 'outdoor-unit' : 'indoor-unit',
    position: { x, y }, rotation: 0, width: outdoor ? 900 : 600, depth: outdoor ? 450 : 600,
    height: outdoor ? 1200 : 250, elevation: outdoor ? 1000 : 2200,
    mountType: outdoor ? 'floor' : 'ceiling', label: id, supplyZoneRatio: 0, properties: {},
  };
}

afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('real copper branch approach geometry', () => {
  it.each([false, true])('preserves the two-elbow route to a right-facing cassette with outdoor flow reversed=%s', reversed => {
    setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
    const outdoor = { ...equipment('outdoor', reversed ? 14000 : 0, 0, true), rotation: reversed ? 180 : 0 };
    const indoor = equipment('cassette', 6000, 3000);
    const source = getRefrigerantPipeBundleSnapTargets([outdoor])[0]!;
    const terminal = getRefrigerantPipeBundleSnapTargets([indoor])[0]!;
    const host = buildRefrigerantPipeElements([source.point, { x: reversed ? 0 : 14000, y: source.point.y }], {
      startBundleConnection: source, bendRadiusFactor: 1, bundleId: 'main',
    }).map((element, index) => ({ ...element, id: `main-${index}`, rotation: 0 } as HvacElement));
    const scene = [outdoor, indoor, ...host];
    if (reversed) {
      const nearby = proposeBranchKit(scene, terminal, { x: 6800, y: source.point.y }, {
        settings: DEFAULT_PIPE_ROUTING_SETTINGS, bendRadiusFactor: 1, proposalRadiusMm: 100, maxRecoveryStations: 1,
      })!;
      expect(nearby.validity, nearby.violations.join('\n')).toBe('valid');
      expect(nearby.teePoint.x).toBeCloseTo(6800, 5);
      expect(nearby.connectionRoute).toHaveLength(6);
      expect(buildBranchKitInsertion(nearby, terminal, scene)).not.toBeNull();
    }
    // Facing sockets need a station beyond both protected approaches. Choosing
    // directly above the cassette would force a four-elbow fold when flow is
    // reversed; the existing long main can accommodate the simpler station.
    const proposal = proposeBranchKit(scene, terminal, { x: reversed ? 8000 : 6000, y: source.point.y }, {
      settings: DEFAULT_PIPE_ROUTING_SETTINGS, bendRadiusFactor: 1, proposalRadiusMm: 100, maxRecoveryStations: 1,
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.validity, proposal!.violations.join('\n')).not.toBe('invalid');
    expect(proposal!.orientationLocked).toBe(true);
    const routeOptions = getBranchKitApproachRouteOptions(proposal!, terminal);
    expect(routeOptions.start).toEqual(terminal.point);
    expect(routeOptions.end.x).toBeCloseTo((proposal!.gasGhost.branchOutletPoint.x + proposal!.liquidGhost.branchOutletPoint.x) / 2, 8);
    expect(routeOptions.end.y).toBeCloseTo((proposal!.gasGhost.branchOutletPoint.y + proposal!.liquidGhost.branchOutletPoint.y) / 2, 8);
    expect(buildOrthogonalConnectionRouteCandidates(routeOptions)[0]).toHaveLength(4);
    const insertion = buildBranchKitInsertion(proposal!, terminal, scene);
    expect(insertion).not.toBeNull();
    expect(findNewNetworkPipeClashes(scene,
      [...(insertion!.updates ?? []), ...insertion!.elementsToAdd], insertion!.removeElementIds)).toEqual([]);
    const branches = insertion!.elementsToAdd.filter(element => element.properties.routeClass === 'indoor-connection');
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      const guide = branch.properties.authoredCenterlineRoute as Point2D[];
      expect(guide).toEqual(proposal!.connectionRoute);
      expect(guide).toHaveLength(4);
      expect(guide[1]!.x).toBeGreaterThan(guide[0]!.x);
      expect(guide[1]!.y).toBe(guide[0]!.y);
      expect(guide[2]!.x).toBe(guide[1]!.x);
      expect(guide[2]!.y).toBeLessThan(guide[1]!.y);
      expect(guide[3]!.y).toBe(guide[2]!.y);
      const spec = resolveRefrigerantPipeSpec(branch.properties);
      expect(spec.routePoints[0]).toEqual(spec.startConnection!.portPoint);
      expect(spec.routePoints.at(-1)).toEqual(spec.endConnection!.portPoint);
      expect(spec.endConnection!.terminalRole).toBe('branch-outlet');
    }
  });
});
