import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import { disposeObject3DResources } from '../../threeResourceLifecycle';
import { compileCopperSocketElbowRoute } from '../copperSocketElbowRoute';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';
import { buildRefrigerantPipePairElement, buildRefrigerantPipePairVisual, buildRefrigerantPipeVisual } from '../refrigerantPipePairModel';

import { buildHvacElementMesh } from './buildHvacElementMesh';

function single(routePoints: Point2D[]): HvacElement {
  return { id: 'socket-assembly', type: 'refrigerant-pipe', position: { x: 0, y: 0 }, width: 2000, depth: 2000,
    height: 40, elevation: 2400, rotation: 0, mountType: 'ceiling', label: 'Gas pipe', supplyZoneRatio: 0,
    properties: { routePoints, lineKind: 'gas', pipeDiameterMm: 12.7, outerDiameterMm: 40,
      segmentMaterials: routePoints.slice(1).map(() => 'flexible') } };
}
function surfaces(group: THREE.Group, role: string): THREE.Mesh[] {
  const result: THREE.Mesh[] = [];
  group.traverse(child => { if (child instanceof THREE.Mesh && child.userData.pipeSurfaceRole === role) result.push(child); });
  return result;
}
function at(point: { x: number; y: number; z: number }): number[] { return [point.x, point.y, point.z]; }
function close(a: number[], b: number[]): boolean { return Math.hypot(...a.map((value, index) => value - b[index]!)) < 1e-5; }
function expectAssemblyTerminals(group: THREE.Group): void {
  const insulation = surfaces(group, 'insulation'); const copper = surfaces(group, 'copper-tube');
  for (const fitting of surfaces(group, 'fitting')) {
    for (const side of ['start', 'end'] as const) {
      const face = at(fitting.userData.socketFaces[side]); const stop = at(fitting.userData.insertionStops[side]);
      expect(insulation.some(pipe => close(pipe.userData.pipeRouteEndpoints.start, face)
        || close(pipe.userData.pipeRouteEndpoints.end, face)), 'Insulation must finish at the cup mouth').toBe(true);
      expect(copper.some(pipe => close(pipe.userData.pipeRouteEndpoints.start, stop)
        || close(pipe.userData.pipeRouteEndpoints.end, stop)), 'Copper must reach the insertion stop').toBe(true);
    }
  }
}

afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('production C x C elbow pipe assemblies', () => {
  it.each([45, 90])('uses the same %i-degree fitting faces in plan and the actual 3D assembly', angle => {
    const radians = angle * Math.PI / 180;
    const route = [{ x: 0, y: 0 }, { x: 700, y: 0 },
      { x: 700 + Math.cos(radians) * 900, y: Math.sin(radians) * 900 }];
    const pipe = single(route); const snapshot = structuredClone(pipe);
    const visual = buildRefrigerantPipeVisual(pipe);
    const compiledPlan = compileCopperSocketElbowRoute(visual.continuousOuterPoints.map(point => ({ ...point, z: pipe.elevation + visual.localZMm })), 12.7);
    expect(compiledPlan.fittings).toHaveLength(1);
    const group = buildHvacElementMesh(pipe, { allElements: [pipe] })!;
    const fitting = surfaces(group, 'fitting');
    expect(fitting).toHaveLength(1);
    expect(fitting[0]!.userData.elbowAngleDeg).toBe(angle);
    expect(close(at(fitting[0]!.userData.socketFaces.start), at(compiledPlan.fittings[0]!.startFace))).toBe(true);
    expect(close(at(fitting[0]!.userData.socketFaces.end), at(compiledPlan.fittings[0]!.endFace))).toBe(true);
    // The plan path itself must contain the exact catalogue-radius circle;
    // recompiling an already resolved view cannot move its geometry.
    expect(compiledPlan.centerline.length).toBe(visual.continuousOuterPoints.length);
    compiledPlan.centerline.forEach((point, index) => expect(Math.hypot(point.x - visual.continuousOuterPoints[index]!.x,
      point.y - visual.continuousOuterPoints[index]!.y)).toBeLessThan(1e-5));
    expectAssemblyTerminals(group);
    expect(pipe).toEqual(snapshot);
    disposeObject3DResources(group);
  });

  it('installs both actual socket elbows on a vertical riser while keeping equipment endpoints fixed', () => {
    const pipe = single([{ x: 0, y: 0 }, { x: 1800, y: 0 }]);
    pipe.properties.routeNodes3d = [{ x: 0, y: 0, z: 1800 }, { x: 800, y: 0, z: 1800 },
      { x: 800, y: 0, z: 2400 }, { x: 1800, y: 0, z: 2400 }];
    const group = buildHvacElementMesh(pipe, { allElements: [pipe] })!;
    expect(surfaces(group, 'fitting')).toHaveLength(2);
    expect(group.userData.pipeRouteEndpoints).toEqual({ start: [0, 0, 1800], end: [1800, 0, 2400] });
    expectAssemblyTerminals(group);
    for (const fitting of surfaces(group, 'fitting')) {
      expect(fitting.userData.elbowAngleDeg).toBe(90);
      expect(fitting.userData.centerlineRadiusMm).toBe(8.5);
    }
    disposeObject3DResources(group);
  });

  it('changes only fitting cover visibility between copper and insulated display', () => {
    const pipe = single([{ x: 0, y: 0 }, { x: 700, y: 0 }, { x: 700, y: 900 }]);
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, fittingDisplay: 'copper' });
    const exposed = buildHvacElementMesh(pipe, { allElements: [pipe] })!;
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, fittingDisplay: 'insulated' });
    const insulated = buildHvacElementMesh(pipe, { allElements: [pipe] })!;
    expect(surfaces(exposed, 'fitting-insulation')).toHaveLength(0);
    expect(surfaces(insulated, 'fitting-insulation')).toHaveLength(1);
    for (const role of ['fitting', 'insulation', 'copper-tube', 'copper-bore']) {
      const first = surfaces(exposed, role); const second = surfaces(insulated, role);
      expect(second).toHaveLength(first.length);
      first.forEach((mesh, index) => {
        expect(Array.from(second[index]!.geometry.getAttribute('position').array)).toEqual(Array.from(mesh.geometry.getAttribute('position').array));
        expect(second[index]!.userData).toEqual(mesh.userData);
      });
    }
    expectAssemblyTerminals(insulated);
    disposeObject3DResources(exposed); disposeObject3DResources(insulated);
  });

  it('retains an explicitly saved formed-tube route without silently inserting socket elbows', () => {
    const pipe = single([{ x: 0, y: 0 }, { x: 700, y: 0 }, { x: 700, y: 900 }]);
    pipe.properties.fieldBendConstruction = 'formed-tube';
    const group = buildHvacElementMesh(pipe, { allElements: [pipe] })!;
    expect(surfaces(group, 'fitting')).toHaveLength(0);
    expect(surfaces(group, 'insulation')).toHaveLength(1);
    disposeObject3DResources(group);
  });

  it('renders one fitting per service bend with separate gas/liquid sockets and unchanged route endpoints', () => {
    const built = buildRefrigerantPipePairElement([{ x: 0, y: 0 }, { x: 1400, y: 0 }, { x: 1400, y: 1700 }],
      { gasPipeDiameterMm: 15.875, liquidPipeDiameterMm: 9.525, elevationMm: 2400, bendRadiusFactor: 1 });
    const pipe = { ...single([]), ...built, id: 'paired-socket-assembly' } as HvacElement;
    const visual = buildRefrigerantPipePairVisual(pipe);
    const group = buildHvacElementMesh(pipe, { allElements: [pipe] })!;
    const fittings = surfaces(group, 'fitting');
    expect(fittings).toHaveLength(2);
    expect(fittings.filter(fitting => fitting.userData.pipeLineKind === 'gas')).toHaveLength(1);
    expect(fittings.filter(fitting => fitting.userData.pipeLineKind === 'liquid')).toHaveLength(1);
    expect(group.userData.copperElbowCounts).toEqual({ ninety: 2, fortyFive: 0 });
    const bounds = fittings.map(fitting => new THREE.Box3().setFromObject(fitting));
    expect(bounds[0]!.intersectsBox(bounds[1]!)).toBe(false);
    expectAssemblyTerminals(group);
    for (const line of ['gas', 'liquid'] as const) {
      const points = line === 'gas' ? visual.gasContinuousOuterPoints : visual.liquidContinuousOuterPoints;
      const z = pipe.elevation + (line === 'gas' ? visual.gasLocalZMm : visual.liquidLocalZMm);
      const pipes = surfaces(group, 'insulation').filter(mesh => mesh.userData.pipeLineKind === line);
      expect(close(pipes[0]!.userData.pipeRouteEndpoints.start, [points[0]!.x, points[0]!.y, z])).toBe(true);
      expect(close(pipes.at(-1)!.userData.pipeRouteEndpoints.end, [points.at(-1)!.x, points.at(-1)!.y, z])).toBe(true);
    }
    disposeObject3DResources(group);
  });
});
