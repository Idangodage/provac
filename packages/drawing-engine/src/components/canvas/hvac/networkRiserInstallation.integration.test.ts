import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import { buildBranchKitInsertion, proposeBranchKit } from './branchKitProposal';
import { compileCopperSocketElbowRoute } from './copperSocketElbowRoute';
import { resolveCopperSocketElbow, resolveCopperSocketElbowMinimumRadius } from './copperSocketElbows';
import { applyNetworkPipeLevels, planNetworkPipeLevels } from './networkPipeLevels';
import { liftPipePlanRouteTo3d, normalizePipeRouteNodes3d, type PipeRouteNode3D } from './pipeRoute3d';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import {
  buildRefrigerantPipeElements,
  buildRefrigerantPipeVisual,
  getRefrigerantPipeBundleSnapTargets,
} from './refrigerantPipePairModel';
import { buildTubeCurve, CircularArcCurve3, simplifyTubePoints } from './three3d/pipeJointGeometry';

function indoorUnit(id: string, x: number): HvacElement {
  const unit: HvacElement = {
    id, type: 'ceiling-cassette-ac', category: 'indoor-unit', subtype: 'ceiling-cassette-ac',
    modelLabel: 'Ceiling cassette', label: id, position: { x, y: 300 }, rotation: 0,
    width: 600, depth: 600, height: 250, elevation: 2200, mountType: 'ceiling',
    supplyZoneRatio: 0, properties: {},
  };
  unit.elevation += 2607 - getRefrigerantPipeBundleSnapTargets([unit])[0]!.liquidElevationMm;
  return unit;
}

function equipmentScene() {
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
  const units = [indoorUnit('indoor-0', 500), indoorUnit('indoor-1', 2900)];
  return { scene: [outdoor, ...units, ...main], units, outdoorPort };
}

function connectBranch(scene: HvacElement[], unit: HvacElement, x: number) {
  const start = getRefrigerantPipeBundleSnapTargets([unit])[0]!;
  const authoredRoute: Point2D[] = [start.point, { x: start.point.x + 700, y: start.point.y },
    { x: start.point.x + 700, y: 1400 }];
  const proposal = proposeBranchKit(scene, start, { x, y: 2100 }, { proposalRadiusMm: 220, authoredRoute });
  expect(proposal).not.toBeNull();
  expect(proposal!.validity, proposal!.violations.join(' ')).not.toBe('invalid');
  const insertion = buildBranchKitInsertion(proposal!, start, scene, [...authoredRoute, proposal!.teePoint]);
  expect(insertion).not.toBeNull();
  const updates = new Map(insertion!.updates?.map(element => [element.id, element]));
  const removed = new Set(insertion!.removeElementIds);
  const next = [...scene.filter(element => !removed.has(element.id)).map(element => updates.get(element.id) ?? element),
    ...insertion!.elementsToAdd];
  return { proposal: proposal!, scene: next };
}

function expectLevelRunsAndVerticalRisers(nodes: PipeRouteNode3D[], label: string) {
  expect(nodes.length, label).toBeGreaterThanOrEqual(2);
  for (let index = 1; index < nodes.length; index += 1) {
    const a = nodes[index - 1]!; const b = nodes[index]!;
    const planTravel = Math.hypot(b.x - a.x, b.y - a.y);
    const verticalTravel = Math.abs(b.z - a.z);
    expect(planTravel <= 1e-6 || verticalTravel <= 1e-6,
      `${label}: diagonal straight ${JSON.stringify(a)} -> ${JSON.stringify(b)}`).toBe(true);
  }
}

function expectInstalledNetwork(scene: HvacElement[]) {
  for (const pipe of scene.filter(element => element.type === 'refrigerant-pipe')) {
    const nodes = normalizePipeRouteNodes3d(pipe.properties.routeNodes3d);
    expectLevelRunsAndVerticalRisers(nodes, pipe.id);
    // The renderer and clash screen lift the physical gas/liquid lane onto the
    // saved guide. The resulting unswept straight sections must agree too.
    const visual = buildRefrigerantPipeVisual(pipe, scene);
    const rendered = liftPipePlanRouteTo3d(visual.continuousOuterPoints, nodes, {
      startConnection: visual.startConnection, endConnection: visual.endConnection,
      outerDiameterMm: visual.outerDiameterMm,
    });
    expectLevelRunsAndVerticalRisers(rendered, `${pipe.id} rendered`);
    const radius = visual.outerDiameterMm * DEFAULT_PIPE_ROUTING_SETTINGS.bendRadiusFactor;
    // Factory elbows have their own published radius, independent of the
    // insulated tube diameter. Check the actual assembly's fittings and the
    // remaining formed-tube sweeps separately, as the renderer now builds them.
    const installed = compileCopperSocketElbowRoute(rendered, visual.pipeDiameterMm, {
      minimumBendRadiusMm: resolveCopperSocketElbowMinimumRadius(pipe.properties),
      startStraightMm: visual.startConnection?.connectionKind === 'unit-port' ? DEFAULT_PIPE_ROUTING_SETTINGS.minimumPortStubMm : 0,
      endStraightMm: visual.endConnection?.connectionKind === 'unit-port' ? DEFAULT_PIPE_ROUTING_SETTINGS.minimumPortStubMm : 0,
    });
    expect(installed.centerline[0]).toEqual(rendered[0]);
    expect(installed.centerline.at(-1)).toEqual(rendered.at(-1));
    for (const fitting of installed.fittings) {
      const part = resolveCopperSocketElbow(visual.pipeDiameterMm, fitting.spec.angleDeg)!;
      expect(part).not.toBeNull();
      expect(fitting.spec.centerlineRadiusMm, `${pipe.id}: catalogue elbow radius`).toBe(part.centerlineRadiusMm);
      const entry = fitting.path.findIndex(point => point === fitting.entry || Math.hypot(point.x - fitting.entry.x,
        point.y - fitting.entry.y, point.z - fitting.entry.z) < 1e-6);
      const exit = fitting.path.findIndex(point => Math.hypot(point.x - fitting.exit.x,
        point.y - fitting.exit.y, point.z - fitting.exit.z) < 1e-6);
      expect(entry).toBeGreaterThanOrEqual(0); expect(exit).toBeGreaterThan(entry);
      for (const point of fitting.path.slice(entry, exit + 1)) {
        expect(Math.hypot(point.x - fitting.center.x, point.y - fitting.center.y, point.z - fitting.center.z),
          `${pipe.id}: actual factory arc`).toBeCloseTo(part.centerlineRadiusMm, 6);
      }
    }
    for (const run of installed.pipeRuns) {
      expectLevelRunsAndVerticalRisers(run, `${pipe.id}: straight tube between socket fittings`);
      const curve = buildTubeCurve(simplifyTubePoints(run.map(node => new THREE.Vector3(node.x, node.y, node.z))),
        radius, Boolean(visual.bundleId));
      for (const arc of curve?.curves.filter((part): part is CircularArcCurve3 => part instanceof CircularArcCurve3) ?? []) {
        expect(arc.radius, `${pipe.id}: remaining formed bend radius`).toBeCloseTo(radius, 6);
      }
    }
    const directions = nodes.slice(1).map((node, index) => Math.sign(node.z - nodes[index]!.z))
      .filter(direction => direction !== 0);
    expect(new Set(directions).size, `${pipe.id}: no automatic rise and return`).toBeLessThanOrEqual(1);
    const installedDirections = installed.centerline.slice(1).map((node, index) => node.z - installed.centerline[index]!.z)
      .filter(delta => Math.abs(delta) > 1e-6).map(Math.sign);
    expect(new Set(installedDirections).size, `${pipe.id}: no fitting-induced rise and return`).toBeLessThanOrEqual(1);
  }
}

function legacyRampScene() {
  const fixture = equipmentScene();
  const first = connectBranch(fixture.scene, fixture.units[0]!, 1400);
  const host = first.scene.find(element => element.type === 'refrigerant-pipe'
    && (element.properties.startConnection as { sourceElementId?: string } | undefined)?.sourceElementId === 'outdoor'
    && normalizePipeRouteNodes3d(element.properties.routeNodes3d).some((node, index, nodes) =>
      index > 0 && Math.abs(node.z - nodes[index - 1]!.z) > 1))!;
  expect(host).toBeDefined();
  const nodes = normalizePipeRouteNodes3d(host.properties.routeNodes3d);
  const rise = nodes.findIndex((node, index) => index > 0 && Math.abs(node.z - nodes[index - 1]!.z) > 1);
  expect(rise).toBeGreaterThan(1);
  const before = nodes[rise - 2]!;
  const lower = nodes[rise - 1]!;
  // Recreate a saved version1 sloping adapter without changing either port or
  // its corridor. Adoption must be a disclosed geometry change even though
  // the service elevations themselves are unchanged.
  nodes[rise - 1] = { x: (before.x + lower.x) / 2, y: (before.y + lower.y) / 2, z: lower.z };
  const legacy: HvacElement = { ...host, properties: { ...host.properties, routeNodes3d: nodes,
    networkLevelPlan: { ...(host.properties.networkLevelPlan as Record<string, unknown>), version: 1 } } };
  const scene = first.scene.map(element => element.id === legacy.id ? legacy : element);
  const other = scene.find(element => element.type === 'refrigerant-pipe'
    && element.properties.lineKind !== legacy.properties.lineKind
    && (element.properties.startConnection as { sourceElementId?: string } | undefined)?.sourceElementId === 'outdoor')!;
  const start = getRefrigerantPipeBundleSnapTargets([fixture.units[1]!])[0]!;
  return { scene, legacy, other, start, levels: first.proposal.levelPlan! };
}

function replan(fixture: ReturnType<typeof legacyRampScene>, scene = fixture.scene) {
  const gas = fixture.legacy.properties.lineKind === 'gas' ? fixture.legacy : fixture.other;
  const liquid = fixture.legacy.properties.lineKind === 'liquid' ? fixture.legacy : fixture.other;
  return planNetworkPipeLevels(scene, {
    gasHostId: gas.id, liquidHostId: liquid.id, startBundle: fixture.start,
    gasHostElevationMm: fixture.levels.gasElevationMm, liquidHostElevationMm: fixture.levels.liquidElevationMm,
  });
}

describe('site-style network riser installation', () => {
  beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

  it('uses level distribution and monotone vertical risers between real outdoor and indoor ports', () => {
    const fixture = equipmentScene();
    const first = connectBranch(fixture.scene, fixture.units[0]!, 1400);
    expectInstalledNetwork(first.scene);
    expect(first.proposal.levelPlan!.clearGapMm).toBeGreaterThanOrEqual(DEFAULT_PIPE_ROUTING_SETTINGS.zOffsetClearanceMm - 1e-6);
    const indoorPort = getRefrigerantPipeBundleSnapTargets([fixture.units[0]!])[0]!;
    const gasLevel = first.proposal.levelPlan!.gasElevationMm;
    // Equal-cost initial layouts should put the common tall rise at the
    // outdoor connection and retain short takeoffs in the served indoor zone.
    expect(Math.abs(gasLevel - indoorPort.gasElevationMm))
      .toBeLessThan(Math.abs(gasLevel - fixture.outdoorPort.gasElevationMm));
    const longRisers = first.scene.filter(element => element.type === 'refrigerant-pipe'
      && (element.properties.startConnection as { sourceElementId?: string } | undefined)?.sourceElementId === 'outdoor')
      .flatMap(element => normalizePipeRouteNodes3d(element.properties.routeNodes3d)
        .map((node, index, nodes) => index > 0 && node.x === nodes[index - 1]!.x && node.y === nodes[index - 1]!.y
          ? Math.abs(node.z - nodes[index - 1]!.z) : 0));
    expect(Math.max(...longRisers)).toBeGreaterThan(900);
    const originalPorts = getRefrigerantPipeBundleSnapTargets(fixture.scene.filter(element => element.type !== 'refrigerant-pipe'));
    const savedPorts = getRefrigerantPipeBundleSnapTargets(first.scene.filter(element => element.type !== 'refrigerant-pipe'
      && element.type !== 'refrigerant-branch-kit'));
    expect(savedPorts).toEqual(originalPorts);
  });

  it('keeps established levels and vertical risers when another indoor unit connects', () => {
    const fixture = equipmentScene();
    const first = connectBranch(fixture.scene, fixture.units[0]!, 1400);
    const second = connectBranch(first.scene, fixture.units[1]!, 3000);
    expect(second.proposal.levelPlan!.gasElevationMm).toBeCloseTo(first.proposal.levelPlan!.gasElevationMm, 6);
    expect(second.proposal.levelPlan!.liquidElevationMm).toBeCloseTo(first.proposal.levelPlan!.liquidElevationMm, 6);
    expectInstalledNetwork(second.scene);
  });

  it('previews and atomically adopts saved generated ramps as risers with a disclosed coordination', () => {
    const fixture = legacyRampScene();
    const before = JSON.stringify(fixture.scene);
    const plan = replan(fixture);
    expect(plan.feasible, plan.issues.join(' ')).toBe(true);
    expect(plan.requiresCoordination).toBe(true);
    expect(plan.coordinatedRunCount).toBeGreaterThan(0);
    const preview = plan.updates.find(element => element.id === fixture.legacy.id)!;
    expect(preview).toBeDefined();
    expectLevelRunsAndVerticalRisers(normalizePipeRouteNodes3d(preview.properties.routeNodes3d), 'preview');
    const applied = applyNetworkPipeLevels(fixture.scene, plan);
    expect(applied.issues).toEqual([]);
    expect(applied.elements.find(element => element.id === fixture.legacy.id)).toEqual(preview);
    expect(JSON.stringify(fixture.scene)).toBe(before);
  });

  it.each(['locked', 'authored'] as const)('preserves an existing %s elevation route during coordination', mode => {
    const fixture = legacyRampScene();
    const properties = { ...fixture.legacy.properties };
    if (mode === 'locked') properties.networkLevelLocked = true;
    else delete properties.networkLevelPlan;
    const protectedRoute = { ...fixture.legacy, properties };
    const scene = fixture.scene.map(element => element.id === protectedRoute.id ? protectedRoute : element);
    const before = JSON.stringify(protectedRoute);
    const plan = replan(fixture, scene);
    expect(plan.feasible, plan.issues.join(' ')).toBe(true);
    expect(plan.lockedRoutes.some(route => route.sourceIds.includes(protectedRoute.id))).toBe(true);
    expect(plan.updates.some(element => element.id === protectedRoute.id)).toBe(false);
    const applied = applyNetworkPipeLevels(scene, plan);
    expect(applied.issues).toEqual([]);
    expect(applied.elements.some(element => element.id === protectedRoute.id)).toBe(false);
    expect(JSON.stringify(scene.find(element => element.id === protectedRoute.id))).toBe(before);
  });
});
