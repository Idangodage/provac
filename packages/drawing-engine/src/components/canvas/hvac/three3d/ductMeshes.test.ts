import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { resolveUnitAirPorts } from '../duct/ductAirPorts';
import { buildDuctRunDraftElement } from '../duct/ductDraft';
import { resolveDuctSettings } from '../duct/ductSettings';

import { buildHvacElementMesh } from './buildHvacElementMesh';

const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 1000, y: 2000 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
  properties: { modelCode: 'FDUM22KXE6F-W' },
};
const ports = resolveUnitAirPorts(unit);
const supply = ports.find((port) => port.kind === 'supply')!;
const ret = ports.find((port) => port.kind === 'return')!;

function meshOf(run: HvacElement, settings = resolveDuctSettings({})): THREE.Group {
  const group = buildHvacElementMesh(run, { allElements: [unit, run], ductSettings: settings })!;
  group.updateMatrixWorld(true);
  return group;
}

/** Mesh buffers are float32: sizes compare to 0.001 mm. */
function box(group: THREE.Object3D, name: string): THREE.Box3 {
  const mesh = group.getObjectByName(name)!;
  return new THREE.Box3().setFromObject(mesh);
}

describe('duct run 3D', () => {
  it('builds merged world-space meshes: metal, flanges, connector fabric and end cap', () => {
    const run = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 3000 }, { x: supply.lip.x + 3000, y: supply.lip.y - 3000 }] }, 'r');
    const group = meshOf(run);
    expect(group.children.map((child) => child.name).sort()).toEqual(['duct-caps', 'duct-fabric', 'duct-flanges', 'duct-metal']);
    expect(group.position.toArray()).toEqual([0, 0, 0]);
  });

  it('the supply duct meets the real −Y collar: 674 × 164, same centre and height', () => {
    // A straight run 2 m out from the supply collar.
    const run = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 2000 }] }, 's');
    const metal = box(meshOf(run), 'duct-metal');
    const t = 0.6;
    expect(metal.max.y).toBeCloseTo(supply.lip.y, 6);
    expect(metal.min.y).toBeCloseTo(supply.lip.y - 2000, 6);
    expect((metal.min.x + metal.max.x) / 2).toBeCloseTo(supply.lip.x, 6);
    expect(metal.max.x - metal.min.x).toBeCloseTo(674 + 2 * t, 3);
    expect((metal.min.z + metal.max.z) / 2).toBeCloseTo(supply.lip.z, 6);
    expect(metal.max.z - metal.min.z).toBeCloseTo(164 + 2 * t, 3);
  });

  it('the return duct meets the real +Y collar: 654 × 194', () => {
    const run = buildDuctRunDraftElement({ port: ret, points: [{ x: ret.lip.x, y: ret.lip.y + 1500 }] }, 'b');
    const metal = box(meshOf(run), 'duct-metal');
    expect(metal.min.y).toBeCloseTo(ret.lip.y, 6);
    expect((metal.min.x + metal.max.x) / 2).toBeCloseTo(ret.lip.x, 6);
    expect((metal.min.z + metal.max.z) / 2).toBeCloseTo(ret.lip.z, 6);
    // Return runs are 250 Pa: 654 wide is C-0.55 at 1.2 m (Table 1-4M) → 0.60 stock.
    expect(metal.max.x - metal.min.x).toBeCloseTo(654 + 1.2, 3);
    expect(metal.max.z - metal.min.z).toBeCloseTo(194 + 1.2, 3);
  });

  it('shows an unsupported pressure class as an error-tinted run, not a fabricated one', () => {
    const run = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 2000 }] }, 'e');
    const group = meshOf(run, resolveDuctSettings({ supplyPressureClassPa: 750 }));
    expect(group.userData.ductPlanStatus).toBe('error');
    expect(group.getObjectByName('duct-flanges')).toBeUndefined();
  });
});
