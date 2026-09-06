import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import { buildBranchKitInsertion, proposeBranchKit } from './branchKitProposal';
import { applyNetworkPipeLevels, planNetworkPipeLevels } from './networkPipeLevels';
import { normalizePipeRouteNodes3d } from './pipeRoute3d';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import {
  buildRefrigerantPipeElements,
  getRefrigerantPipeBundleSnapTargets,
  type RefrigerantPipeBundleConnection,
} from './refrigerantPipePairModel';

function cassette(id: string, x: number): HvacElement {
  const unit: HvacElement = {
    id, type: 'ceiling-cassette-ac', category: 'indoor-unit', subtype: 'ceiling-cassette-ac',
    modelLabel: 'Ceiling cassette', label: id, position: { x, y: 300 }, rotation: 0,
    width: 600, depth: 600, height: 250, elevation: 2200, mountType: 'ceiling',
    supplyZoneRatio: 0, properties: {},
  };
  // Use the actual model port transforms, including the gas/liquid Z difference.
  unit.elevation += 2607 - getRefrigerantPipeBundleSnapTargets([unit])[0]!.liquidElevationMm;
  return unit;
}

function mixedEquipmentScene() {
  const outdoor: HvacElement = {
    id: 'outdoor', type: 'outdoor-unit', category: 'outdoor-unit', subtype: 'outdoor-unit',
    modelLabel: 'Outdoor unit', label: 'Outdoor unit', position: { x: 6900, y: 2600 }, rotation: 180,
    width: 900, depth: 450, height: 1200, elevation: 0, mountType: 'floor',
    supplyZoneRatio: 0, properties: {},
  };
  outdoor.elevation += 1437 - getRefrigerantPipeBundleSnapTargets([outdoor])[0]!.gasElevationMm;
  const outdoorPort = getRefrigerantPipeBundleSnapTargets([outdoor])[0]!;
  const lead = { x: outdoorPort.point.x + outdoorPort.direction.x * 800,
    y: outdoorPort.point.y + outdoorPort.direction.y * 800 };
  const main = buildRefrigerantPipeElements([
    outdoorPort.point, lead, { x: lead.x, y: 2100 }, { x: 100, y: 2100 },
  ], { startBundleConnection: outdoorPort, bundleId: 'distribution-main' })
    .map((element, index) => ({ ...element, id: `main-${index}`, rotation: 0 } as HvacElement));
  const units = [cassette('indoor-0', 500), cassette('indoor-1', 2900)];
  return { scene: [outdoor, ...units, ...main], units, outdoorPort };
}

function approach(start: RefrigerantPipeBundleConnection): Point2D[] {
  // The unit has a 700 mm exit leg and a short aisle approach. A compact
  // corridor can be reached here; a 1.17 m rise to the ODU level cannot fit.
  return [start.point, { x: start.point.x + 700, y: start.point.y },
    { x: start.point.x + 700, y: 1400 }];
}

function addBranch(scene: HvacElement[], unit: HvacElement, x: number) {
  const start = getRefrigerantPipeBundleSnapTargets([unit])[0]!;
  const authoredRoute = approach(start);
  const proposal = proposeBranchKit(scene, start, { x, y: 2100 }, { proposalRadiusMm: 220, authoredRoute });
  expect(proposal).not.toBeNull();
  expect(proposal!.validity, proposal!.violations.join(' ')).not.toBe('invalid');
  const insertion = buildBranchKitInsertion(proposal!, start, scene, [...authoredRoute, proposal!.teePoint]);
  expect(insertion).not.toBeNull();
  const updates = new Map(insertion!.updates?.map(element => [element.id, element]));
  const removed = new Set(insertion!.removeElementIds);
  const next = [...scene.filter(element => !removed.has(element.id)).map(element => updates.get(element.id) ?? element),
    ...insertion!.elementsToAdd];
  return { proposal: proposal!, insertion: insertion!, scene: next, start };
}

describe('compact distribution levels with different outdoor and indoor heights', () => {
  beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

  it('fits a short indoor approach without spreading the service pair across the equipment height difference', () => {
    const fixture = mixedEquipmentScene();
    expect(fixture.outdoorPort.gasElevationMm).toBeCloseTo(1437, 6);
    expect(getRefrigerantPipeBundleSnapTargets([fixture.units[0]!])[0]!.liquidElevationMm).toBeCloseTo(2607, 6);

    const first = addBranch(fixture.scene, fixture.units[0]!, 1400);
    const plan = first.proposal.levelPlan!;
    expect(plan.feasible).toBe(true);
    expect(plan.clearGapMm).toBeCloseTo(DEFAULT_PIPE_ROUTING_SETTINGS.zOffsetClearanceMm, 6);
    expect(Math.abs(plan.gasElevationMm - plan.liquidElevationMm)).toBeLessThan(200);
    const branches = first.insertion.elementsToAdd.filter(element => element.properties.routeClass === 'indoor-connection');
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      const gas = branch.properties.lineKind === 'gas';
      const nodes = normalizePipeRouteNodes3d(branch.properties.routeNodes3d);
      expect(nodes[0]!.z).toBeCloseTo(gas ? first.start.gasElevationMm : first.start.liquidElevationMm, 6);
      expect(nodes.at(-1)!.z).toBeCloseTo(gas ? plan.gasElevationMm : plan.liquidElevationMm, 6);
      const changes = nodes.slice(1).map((node, index) => Math.sign(node.z - nodes[index]!.z)).filter(Boolean);
      expect(new Set(changes).size).toBeLessThanOrEqual(1);
      expect(branch.properties.bypasses ?? []).toEqual([]);
    }
  });

  it('keeps the compact levels and existing branch joints unchanged when a second real indoor unit connects', () => {
    const fixture = mixedEquipmentScene();
    const first = addBranch(fixture.scene, fixture.units[0]!, 1400);
    const previousKits = first.scene.filter(element => element.type === 'refrigerant-branch-kit');
    const second = addBranch(first.scene, fixture.units[1]!, 3000);
    expect(second.proposal.target.gasElevationMm).toBeCloseTo(first.proposal.target.gasElevationMm, 6);
    expect(second.proposal.target.liquidElevationMm).toBeCloseTo(first.proposal.target.liquidElevationMm, 6);
    for (const kit of previousKits) expect(second.scene.find(element => element.id === kit.id)!.elevation).toBeCloseTo(kit.elevation, 6);
  });

  it('recovers an earlier generated corridor with the old 1107 mm gap', () => {
    const fixture = mixedEquipmentScene();
    const start = getRefrigerantPipeBundleSnapTargets([fixture.units[0]!])[0]!;
    const current = planNetworkPipeLevels(fixture.scene, {
      gasHostId: 'main-0', liquidHostId: 'main-1', startBundle: start,
      gasHostElevationMm: fixture.outdoorPort.gasElevationMm,
      liquidHostElevationMm: fixture.outdoorPort.liquidElevationMm,
    });
    // Recreate the earlier wide corridor, marked with its actual schema
    // version. New risers no longer need a rise-height-sized plan approach,
    // but the legacy storey-height service gap still deserves coordination.
    const legacy = applyNetworkPipeLevels(fixture.scene, {
      ...current, gasElevationMm: 1437, liquidElevationMm: 2607, clearGapMm: 1106.5,
    });
    expect(legacy.issues).toEqual([]);
    const updates = new Map(legacy.elements.map(element => [element.id, { ...element, properties: {
      ...element.properties, networkLevelPlan: { ...element.properties.networkLevelPlan as object, version: 1 },
    } }]));
    const oldScene = fixture.scene.map(element => updates.get(element.id) ?? element);
    expect(oldScene.find(element => element.id === 'main-0')!.properties.networkLevelPlan).toMatchObject({
      generated: true, gasElevationMm: 1437, liquidElevationMm: 2607,
    });

    const branch = addBranch(oldScene, fixture.units[0]!, 1400);
    expect(branch.proposal.levelPlan!.clearGapMm).toBeCloseTo(DEFAULT_PIPE_ROUTING_SETTINGS.zOffsetClearanceMm, 6);
    expect(branch.proposal.levelPlan!.requiresCoordination).toBe(true);
    expect(branch.proposal.levelPlan!.coordinatedRunCount).toBeGreaterThan(0);
  });
});
