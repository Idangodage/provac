/**
 * A ducted unit drawn to its maker's dimension drawing (no 3D file): its body
 * carries its real duct collars — where the ducts meet them — and its control
 * box, not the placeholder openings of an unknown unit.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../../data/ac-equipment-library';
import type { HvacElement } from '../../../../types';
import { resolveLocalAirPorts } from '../duct/ductAirPorts';

import { buildHvacElementMesh } from './buildHvacElementMesh';

function placed(definitionId: string): HvacElement {
  const definition = DEFAULT_AC_EQUIPMENT_LIBRARY.find((entry) => entry.id === definitionId)!;
  return {
    id: `${definitionId}-test`, type: definition.type, position: { x: 0, y: 0 }, rotation: 0,
    width: definition.widthMm, depth: definition.depthMm, height: definition.heightMm, elevation: 2400,
    mountType: definition.mountType, label: definition.modelLabel, supplyZoneRatio: 0.5,
    properties: { ...(definition.defaultProperties ?? {}) },
  };
}

/** Local-frame boxes of the group's meshes (centre and size), the group's own transform taken out. */
function boxes(group: THREE.Group): Array<{ centre: THREE.Vector3; size: THREE.Vector3 }> {
  const out: Array<{ centre: THREE.Vector3; size: THREE.Vector3 }> = [];
  group.updateMatrixWorld(true);
  const inverse = group.matrixWorld.clone().invert();
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const box = new THREE.Box3().setFromObject(mesh).applyMatrix4(inverse);
    out.push({ centre: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()) });
  });
  return out;
}

describe('FDU280KXZE1 drawn to MHI drawing PJG000Z287', () => {
  it('has its 1450 × 250 collars where its ports are, and the control box on its connection end', () => {
    const element = placed('vrf-fdu280kxze1');
    const group = buildHvacElementMesh(element, { allElements: [element] })!;
    expect(group).not.toBeNull();
    const meshes = boxes(group);
    const { ports, source } = resolveLocalAirPorts(element);
    expect(source).toBe('measured');
    for (const port of ports) {
      // The collar's top plate spans the opening's width (plus the sheet) at the collar's middle.
      const centreY = port.lip.y - port.normal.y * port.collarDepthMm / 2;
      const top = meshes.find((mesh) => Math.abs(mesh.centre.y - centreY) < 0.5
        && Math.abs(mesh.centre.z - (port.lip.z + port.heightMm / 2 + 3)) < 0.5);
      expect(top, `${port.kind} collar`).toBeDefined();
      expect(top!.size.x).toBeCloseTo(port.widthMm + 12, 3);
      expect(top!.size.y).toBeCloseTo(port.collarDepthMm, 3);
      // The opening panel, flush with the casing face.
      const mouth = meshes.find((mesh) => Math.abs(mesh.size.x - port.widthMm) < 0.5 && Math.abs(mesh.size.z - port.heightMm) < 0.5 && mesh.size.y < 3);
      expect(mouth, `${port.kind} opening`).toBeDefined();
    }
    // The control box stands 85 mm out of the +X end.
    const controlBox = meshes.find((mesh) => Math.abs(mesh.size.x - 85) < 0.5 && Math.abs(mesh.size.y - 265) < 0.5);
    expect(controlBox).toBeDefined();
    expect(controlBox!.centre.x).toBeCloseTo(800 + 42.5, 3);
  });
});
