import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { getActivePipeRoutingSettings, setActivePipeRoutingSettings } from '../pipeRoutingSettings';
import {
  buildRefrigerantPipeElement,
  buildRefrigerantPipePairElement,
  buildRefrigerantPipePairVisual,
} from '../refrigerantPipePairModel';

import { buildHvacElementMesh, REFRIGERANT_PIPE_3D_COLORS } from './buildHvacElementMesh';

function materialize(element: Partial<HvacElement>): HvacElement {
  return { id: 'pipe-render-test', rotation: 0, supplyZoneRatio: 0, properties: {}, ...element } as HvacElement;
}

function insulationMeshes(element: HvacElement): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[] {
  const result: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[] = [];
  buildHvacElementMesh(element, { allElements: [element] })!.traverse((object) => {
    if (object instanceof THREE.Mesh && object.userData.pipeSurfaceRole === 'insulation') result.push(object);
  });
  return result;
}

describe('pipe rendering connection and service contract', () => {
  it('preserves a saved formed-tube bend radius when document routing defaults change', () => {
    const previous = getActivePipeRoutingSettings();
    const base = materialize(buildRefrigerantPipeElement([
      { x: 0, y: 0 }, { x: 2500, y: 0 },
    ], { lineKind: 'gas', pipeDiameterMm: 15.88, outerDiameterMm: 40, elevationMm: 1800 }));
    const saved: HvacElement = { ...base, properties: { ...base.properties, fieldBendConstruction: 'formed-tube', bendRadiusFactor: 4, routeNodes3d: [
      { x: 0, y: 0, z: 1800 }, { x: 1250, y: 0, z: 1800 },
      { x: 1250, y: 0, z: 2600 }, { x: 2500, y: 0, z: 2600 },
    ] } };
    const vertices = (element: HvacElement) => {
      const meshes = insulationMeshes(element);
      const result = meshes.map(mesh => Array.from(mesh.geometry.getAttribute('position').array));
      meshes.forEach(mesh => { mesh.geometry.dispose(); mesh.material.dispose(); });
      return result;
    };
    try {
      setActivePipeRoutingSettings({ ...previous, bendRadiusFactor: 1 });
      const first = vertices(saved);
      setActivePipeRoutingSettings({ ...previous, bendRadiusFactor: 6 });
      expect(vertices(saved)).toEqual(first);
      expect(vertices({ ...saved, properties: { ...saved.properties, bendRadiusFactor: 1 } })).not.toEqual(first);
    } finally { setActivePipeRoutingSettings(previous); }
  });

  it('keeps gas and liquid distinguishable for both legacy and 3D-authored pairs', () => {
    const base = materialize(buildRefrigerantPipePairElement([
      { x: 0, y: 0 }, { x: 1500, y: 0 }, { x: 1500, y: 1200 },
    ], { elevationMm: 2400 }));
    for (const authored of [false, true]) {
      const element = authored ? {
        ...base,
        properties: { ...base.properties, routeNodes3d: [
          { x: 0, y: 0, z: 2420 }, { x: 1500, y: 0, z: 2420 }, { x: 1500, y: 1200, z: 2420 },
        ] },
      } : base;
      const meshes = insulationMeshes(element);
      for (const lineKind of ['gas', 'liquid'] as const) {
        const serviceMeshes = meshes.filter(candidate => candidate.userData.pipeLineKind === lineKind);
        expect(serviceMeshes.length).toBeGreaterThan(0);
        for (const mesh of serviceMeshes) {
          expect(mesh.material.color.getHexString()).toBe(REFRIGERANT_PIPE_3D_COLORS[lineKind].slice(1));
        }
        const visual = buildRefrigerantPipePairVisual(element);
        const points = lineKind === 'gas' ? visual.gasContinuousOuterPoints : visual.liquidContinuousOuterPoints;
        expect(serviceMeshes[0]!.userData.pipeRouteEndpoints.start.slice(0, 2)).toEqual([points[0]!.x, points[0]!.y]);
        expect(serviceMeshes.at(-1)!.userData.pipeRouteEndpoints.end.slice(0, 2)).toEqual([points[points.length - 1]!.x, points[points.length - 1]!.y]);
      }
      const gas = meshes.find(mesh => mesh.userData.pipeLineKind === 'gas')!;
      const liquid = meshes.find(mesh => mesh.userData.pipeLineKind === 'liquid')!;
      expect(gas.material.color.equals(liquid.material.color)).toBe(false);
    }
  });

  it('finishes a pipe at each connected socket elevation without showing an exposed end', () => {
    const base = materialize(buildRefrigerantPipeElement([
      { x: 0, y: 0 }, { x: 1200, y: 0 },
    ], {
      lineKind: 'gas', pipeDiameterMm: 15.88, outerDiameterMm: 36,
      elevationMm: 2482,
      startConnection: {
        portPoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, elevationMm: 2200,
        connectionKind: 'field-pipe', terminalRole: 'run-outlet',
      },
      endConnection: {
        portPoint: { x: 1200, y: 0 }, direction: { x: -1, y: 0 }, elevationMm: 2300,
        connectionKind: 'unit-port',
      },
    }));
    const element = { ...base, properties: { ...base.properties, routeNodes3d: [
      { x: 0, y: 0, z: 2500 }, { x: 1200, y: 0, z: 2500 },
    ] } };
    const group = buildHvacElementMesh(element, { allElements: [element] })!;
    const roles: string[] = [];
    const tubes: THREE.Mesh[] = [];
    group.traverse((object) => {
      if (object.userData.pipeSurfaceRole) roles.push(object.userData.pipeSurfaceRole);
      if (object instanceof THREE.Mesh && object.userData.pipeSurfaceRole === 'insulation') tubes.push(object);
    });
    expect(roles).not.toContain('exposed-core');
    expect(roles).toContain('fitting');
    expect(tubes.length).toBeGreaterThan(0);
    expect(tubes[0]!.userData.pipeRouteEndpoints.start).toEqual([0, 0, 2200]);
    expect(tubes.at(-1)!.userData.pipeRouteEndpoints.end).toEqual([1200, 0, 2300]);
    const positions = tubes[0]!.geometry.getAttribute('position');
    const startCenter = new THREE.Vector3();
    for (let index = 0; index < 24; index += 1) startCenter.add(new THREE.Vector3().fromBufferAttribute(positions, index));
    startCenter.multiplyScalar(1 / 24);
    expect(startCenter.distanceTo(new THREE.Vector3(0, 0, 2200))).toBeLessThan(0.001);
    const lastPositions = tubes.at(-1)!.geometry.getAttribute('position');
    const endCenter = new THREE.Vector3();
    for (let index = lastPositions.count - 25; index < lastPositions.count - 1; index += 1) {
      endCenter.add(new THREE.Vector3().fromBufferAttribute(lastPositions, index));
    }
    endCenter.multiplyScalar(1 / 24);
    expect(endCenter.distanceTo(new THREE.Vector3(1200, 0, 2300))).toBeLessThan(0.001);
  });

  it('renders one opaque shell and only loose-end copper cross sections for a legacy single pipe', () => {
    const element = materialize(buildRefrigerantPipeElement([
      { x: 0, y: 0 }, { x: 800, y: 0 },
    ], { lineKind: 'liquid', pipeDiameterMm: 9.52, outerDiameterMm: 30, elevationMm: 2400 }));
    const roles: string[] = [];
    buildHvacElementMesh(element, { allElements: [element] })!.traverse((object) => {
      if (object.userData.pipeSurfaceRole) roles.push(object.userData.pipeSurfaceRole);
    });
    expect(roles.sort()).toEqual(['exposed-core', 'exposed-core', 'insulation']);
    expect(insulationMeshes(element)[0]!.userData.pipeLineKind).toBe('liquid');
  });

  it('keeps the copper branch body metallic and identifies each inlet by service', () => {
    for (const lineKind of ['gas', 'liquid']) {
      const element = materialize({
        type: 'refrigerant-branch-kit', position: { x: 0, y: 0 },
        width: 450, depth: 250, height: 100, elevation: 2400,
        properties: { branchKitLineKind: lineKind },
      });
      const group = buildHvacElementMesh(element, { allElements: [element] })!;
      const fittings: THREE.Mesh[] = [];
      group.traverse((object) => {
        if (object instanceof THREE.Mesh && object.userData.pipeSurfaceRole === 'fitting') fittings.push(object);
      });
      expect(fittings.map((fitting) => fitting.userData.pipeLineKind)).toEqual([lineKind]);
      expect(fittings.every((fitting) => (fitting.material as THREE.MeshStandardMaterial).metalness > 0.5)).toBe(true);
      expect(insulationMeshes(element).map((mesh) => mesh.userData.pipeLineKind)).toEqual([lineKind]);
    }
  });
});
