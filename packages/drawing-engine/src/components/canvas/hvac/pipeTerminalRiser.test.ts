import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';
import { disposeObject3DResources } from '../threeResourceLifecycle';

import { compileCopperSocketElbowRoute } from './copperSocketElbowRoute';
import { buildCircularFieldPipeSegments } from './fieldPipeBends';
import { buildNetworkLevelRoute } from './networkPipeLevels';
import { findSampledQuarterTurns } from './pipeRiserCornerProjection';
import { liftPipePlanRouteTo3d, type PipeRouteNode3D as Node } from './pipeRoute3d';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from './pipeRoutingSettings';
import { planTerminalCornerRisers } from './pipeTerminalRiser';
import { buildRefrigerantPipeElements, buildRefrigerantPipeVisual, getRefrigerantPipeBundleSnapTargets } from './refrigerantPipePairModel';
import { buildHvacElementMesh } from './three3d/buildHvacElementMesh';

const p = (x: number, y = 0, z = 2200): Node => ({ x, y, z });
const port = (elevationMm: number) => ({ elevationMm, connectionKind: 'unit-port' as const });
function elbowCount(nodes: Node[]) {
  const built = compileCopperSocketElbowRoute(nodes, 15.875, { startStraightMm: 200, endStraightMm: 200 });
  expect(built.issues).toEqual([]);
  expect(built.fittings.every(fitting => fitting.spec.angleDeg === 90)).toBe(true);
  return built.fittings.length;
}

describe('combined terminal rise and direction change', () => {
  it.each([false, true])('uses two real socket elbows at a rounded terminal corner (reverse %s)', reverse => {
    const route = [p(0), p(900), p(900, 1500)];
    const plan = buildCircularFieldPipeSegments(route, 80).flatMap((segment, index) => index ? segment.points.slice(1) : segment.points);
    if (reverse) { plan.reverse(); route.reverse(); }
    const options = { minimumPortStubMm: 200, outerDiameterMm: 60, pipeDiameterMm: 15.875,
      ...(reverse ? { endConnection: port(1600) } : { startConnection: port(1600) }) };
    const nodes = liftPipePlanRouteTo3d(plan, route, options);
    expect(nodes).toContainEqual(p(900, 0, 1600));
    expect(nodes).toContainEqual(p(900, 0, 2200));
    expect(elbowCount(nodes)).toBe(2);
    expect(nodes[0]!.z).toBe(reverse ? 2200 : 1600);
    expect(nodes.at(-1)!.z).toBe(reverse ? 1600 : 2200);
  });

  it('uses independent corner risers at both unit ends without adding another bend', () => {
    const plan = [p(0), p(900), p(900, 1500), p(1800, 1500)];
    const nodes = liftPipePlanRouteTo3d(plan, plan, {
      startConnection: port(1600), endConnection: port(2800), outerDiameterMm: 60, pipeDiameterMm: 15.875,
    });
    expect(elbowCount(nodes)).toBe(4);
    const changes = nodes.slice(1).filter((node, index) => node.z !== nodes[index]!.z);
    expect(changes).toHaveLength(2);
    expect(changes.every((node, index) => node.z === (index ? 2800 : 2200))).toBe(true);
  });

  it('preserves an authored separate riser and corner', () => {
    const plan = [p(0), p(900), p(900, 1500)];
    const guide = [p(0, 0, 1600), p(400, 0, 1600), p(400), p(900), p(900, 1500)];
    const nodes = liftPipePlanRouteTo3d(plan, guide, { startConnection: port(1600), outerDiameterMm: 60 });
    expect(nodes).toContainEqual(p(400, 0, 1600));
    expect(nodes).toContainEqual(p(400));
    expect(elbowCount(nodes)).toBe(3);
  });

  it('preserves custom terminal gathers and the opposite socket clearance', () => {
    const plan = [p(0), p(300), p(350, 50), p(900, 50), p(900, 100)];
    const nodes = liftPipePlanRouteTo3d(plan, plan, {
      startConnection: port(1600), endConnection: port(2200), outerDiameterMm: 60,
    });
    expect(nodes).toContainEqual(p(350, 50));
    expect(nodes).toContainEqual(p(900, 50));
    expect(nodes.at(-1)).toEqual(plan.at(-1));
  });

  it.each([0, 90, 180, 270].flatMap(rotation => [false, true].map(reverse => ({ rotation, reverse }))))(
    'uses two field elbows after the real cassette gather (rotation $rotation, reverse $reverse)', ({ rotation, reverse }) => {
      const unit: HvacElement = { id: 'real-cassette', type: 'ceiling-cassette-ac', category: 'indoor-unit',
        position: { x: 1200, y: 1800 }, width: 600, depth: 600, height: 250, elevation: 2200,
        rotation, mountType: 'ceiling', label: 'Cassette', supplyZoneRatio: 0, properties: {} };
      const bundle = getRefrigerantPipeBundleSnapTargets([unit])[0]!;
      const direction = bundle.direction;
      const corner = { x: bundle.point.x + direction.x * 900, y: bundle.point.y + direction.y * 900 };
      const end = { x: corner.x - direction.y * 1500, y: corner.y + direction.x * 1500 };
      const built = buildRefrigerantPipeElements([bundle.point, corner, end], { startBundleConnection: bundle });
      let recognizedGatherCount = 0;
      for (const element of built) {
        const visual = buildRefrigerantPipeVisual({ ...element, properties: element.properties ?? {} }, [unit]);
        const socketLevel = visual.startConnection!.elevationMm;
        const corridor = socketLevel + 600;
        const originalPlan = visual.continuousOuterPoints;
        const quarter = findSampledQuarterTurns(originalPlan)[0]!;
        expect(quarter).toBeDefined();
        const gather = originalPlan.slice(0, quarter.startIndex);
        if (gather.length > 5) recognizedGatherCount += 1;
        const plan = reverse ? [...originalPlan].reverse() : [...originalPlan];
        const guide = plan.map(point => ({ ...point, z: corridor }));
        const original = structuredClone({ plan, guide });
        const nodes = liftPipePlanRouteTo3d(plan, guide, {
          outerDiameterMm: visual.outerDiameterMm, pipeDiameterMm: visual.pipeDiameterMm,
          ...(reverse ? { endConnection: port(socketLevel) } : { startConnection: port(socketLevel) }),
        });
        const compiled = compileCopperSocketElbowRoute(nodes, visual.pipeDiameterMm,
          reverse ? { endStraightMm: 200 } : { startStraightMm: 200 });
        const existingGather = compileCopperSocketElbowRoute(plan.map(point => ({ ...point, z: socketLevel })), visual.pipeDiameterMm,
          reverse ? { endStraightMm: 200 } : { startStraightMm: 200 });
        expect(compiled.issues).toEqual(existingGather.issues);
        expect(compiled.fittings.filter(fitting => fitting.spec.angleDeg === 90)).toHaveLength(2);
        for (const point of gather) expect(nodes.some(node => Math.hypot(node.x - point.x, node.y - point.y,
          node.z - socketLevel) < 1e-5)).toBe(true);
        expect(nodes[reverse ? nodes.length - 1 : 0]!.z).toBe(socketLevel);
        expect(nodes[reverse ? 0 : nodes.length - 1]!.z).toBe(corridor);
        expect({ plan, guide }).toEqual(original);
      }
      expect(recognizedGatherCount).toBeGreaterThan(0);
    },
  );

  it('does not treat an arbitrary sampled offset as the generated port gather', () => {
    const plan = [p(0), p(200), p(220, 2), p(240, 7), p(260, 9), p(280, 17), p(300, 20),
      p(900, 20), p(900, 1200)];
    const result = planTerminalCornerRisers(plan, plan, { startConnection: port(1600) }, 60, 200, 300);
    expect(result.plan).toBe(plan);
    expect(result.guide).toBe(plan);
  });

  it('reserves both the 45-degree gather cup and the following field elbow', () => {
    const compact = [p(0), p(300), p(350, 50), p(405, 50), p(405, 1200)];
    const options = { startConnection: port(1600), pipeDiameterMm: 15.88 };
    expect(planTerminalCornerRisers(compact, compact, options, 38, 200, 300).guide).toBe(compact);
    const clear = [p(0), p(300), p(350, 50), p(410, 50), p(410, 1200)];
    const planned = planTerminalCornerRisers(clear, clear, options, 38, 200, 300);
    expect(planned.guide).toContainEqual(p(410, 50, 1600));
    expect(planned.guide).toContainEqual(p(410, 50, 2200));
    const compiled = compileCopperSocketElbowRoute(planned.guide, 15.88, { startStraightMm: 200 });
    expect(compiled.issues).toEqual([]);
    expect(compiled.fittings.map(fitting => fitting.spec.angleDeg)).toEqual([45, 45, 90, 90]);
  });

  it('retains every tangent two-arc socket-adapter sample before the field riser', () => {
    const radius = 60; const angle = Math.PI / 6;
    const gather = [p(0), p(200)];
    for (let index = 1; index <= 8; index += 1) {
      const theta = angle * index / 8;
      gather.push(p(200 + radius * Math.sin(theta), radius * (1 - Math.cos(theta))));
    }
    for (let index = 1; index <= 8; index += 1) {
      const theta = angle * (1 - index / 8);
      gather.push(p(200 + radius * (2 * Math.sin(angle) - Math.sin(theta)),
        radius * (1 - 2 * Math.cos(angle) + Math.cos(theta))));
    }
    const corner = p(900, gather.at(-1)!.y);
    const plan = [...gather, corner, p(900, 1200)];
    const planned = planTerminalCornerRisers(plan, plan, { startConnection: port(1600) }, radius, 200, 300);
    expect(planned.guide).toContainEqual({ ...corner, z: 1600 });
    expect(planned.guide).toContainEqual(corner);
    for (const node of gather) expect(planned.guide).toContainEqual({ ...node, z: 1600 });
  });

  it('does not substitute a corner when the catalogue socket would consume its protected straight', () => {
    const plan = [p(0), p(225), p(225, 1000)];
    const nodes = liftPipePlanRouteTo3d(plan, plan, {
      startConnection: port(1600), outerDiameterMm: 16, pipeDiameterMm: 15.875, minimumPortStubMm: 200,
    });
    expect(nodes).not.toContainEqual(p(225, 0, 2200));
  });

  it('keeps a parallel lane rise at its own sharp corner through lifting', () => {
    const plan = [p(0, -40), p(940, -40), p(940, 1500)];
    const guide = [p(0, 0, 1600), p(900, 0, 1600), p(900), p(900, 1500)];
    const nodes = liftPipePlanRouteTo3d(plan, guide, { outerDiameterMm: 60 });
    expect(nodes).toContainEqual(p(940, -40, 1600));
    expect(nodes).toContainEqual(p(940, -40));
    expect(elbowCount(nodes)).toBe(2);
  });

  it('renders two complete standard elbows from the saved network planner route', () => {
    const plan = [p(0), p(900), p(900, 1500)];
    const start = { ...port(1600), portPoint: p(0), direction: { x: 1, y: 0 } };
    const planned = buildNetworkLevelRoute(plan, 2200, { start, radiusMm: 30, settings: DEFAULT_PIPE_ROUTING_SETTINGS });
    expect(planned.issue).toBeUndefined();
    const pipe: HvacElement = { id: 'corner-rise', type: 'refrigerant-pipe', position: { x: 450, y: 750 },
      width: 900, depth: 1500, elevation: 1570, height: 660, rotation: 0, mountType: 'ceiling', label: 'Gas pipe',
      supplyZoneRatio: 0, properties: { routePoints: plan, routeNodes3d: planned.nodes,
        startConnection: start, pipeDiameterMm: 15.875, outerDiameterMm: 60, insulationThicknessMm: 22.0625,
        lineKind: 'gas', segmentMaterials: ['flexible', 'flexible'] } };
    const original = structuredClone(pipe);
    const visual = buildRefrigerantPipeVisual(pipe);
    const lifted = liftPipePlanRouteTo3d(visual.continuousOuterPoints, planned.nodes, {
      startConnection: visual.startConnection, outerDiameterMm: 60, pipeDiameterMm: 15.875,
    });
    expect(elbowCount(lifted)).toBe(2);
    const group = buildHvacElementMesh(pipe, { allElements: [pipe] })!;
    const fittings: THREE.Mesh[] = [];
    group.traverse(object => { if (object instanceof THREE.Mesh && object.userData.pipeSurfaceRole === 'fitting') fittings.push(object); });
    expect(fittings).toHaveLength(2);
    expect(group.userData.copperElbowIssues).toEqual([]);
    expect(group.userData.pipeRouteEndpoints).toEqual({ start: [0, 0, 1600], end: [900, 1500, 2200] });
    expect(fittings.every(fitting => fitting.userData.elbowAngleDeg === 90)).toBe(true);
    expect(pipe).toEqual(original);
    disposeObject3DResources(group);
  });
});
