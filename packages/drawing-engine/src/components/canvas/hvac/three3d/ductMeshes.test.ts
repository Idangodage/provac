import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { resolveUnitAirPorts } from '../duct/ductAirPorts';
import { splitOrigin, tapOrigin } from '../duct/ductBranchTargets';
import { buildDuctRunDraftElement } from '../duct/ductDraft';
import { resolveDuctSettings } from '../duct/ductSettings';
import { buildDuctRunElement, readDuctRunSpec } from '../duct/ductTypes';

import { buildHvacElementMesh } from './buildHvacElementMesh';

const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 1000, y: 2000 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
  properties: { modelCode: 'FDUM22KXE6F-W' },
};
const ports = resolveUnitAirPorts(unit);
const supply = ports.find((port) => port.kind === 'supply')!;
const ret = ports.find((port) => port.kind === 'return')!;

function meshOf(run: HvacElement, settings = resolveDuctSettings({}), scene: HvacElement[] = [unit, run]): THREE.Group {
  const group = buildHvacElementMesh(run, { allElements: scene, ductSettings: settings })!;
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
    expect(group.children.map((child) => child.name).sort()).toEqual(['duct-caps', 'duct-fabric', 'duct-flanges', 'duct-metal', 'duct-supports']);
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

  it('lofts a flat-bottom reducer: full size at one end, reduced at the other, bottom level', () => {
    const run = buildDuctRunDraftElement({
      port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 1000 }, { x: supply.lip.x, y: supply.lip.y - 3000 }],
      legSizes: [{ widthMm: 674, heightMm: 164 }, { widthMm: 400, heightMm: 120 }],
    }, 'red');
    const metal = meshOf(run).getObjectByName('duct-metal') as THREE.Mesh;
    const positions = metal.geometry.getAttribute('position');
    const bottom = supply.lip.z - 164 / 2 - 0.6;
    let lowest = Infinity;
    const farEnd: number[] = [];
    for (let index = 0; index < positions.count; index += 1) {
      lowest = Math.min(lowest, positions.getZ(index));
      if (Math.abs(positions.getY(index) - (supply.lip.y - 3000)) < 1e-3) farEnd.push(positions.getX(index));
    }
    expect(lowest).toBeCloseTo(bottom, 3);
    // The far end is the reduced section: 400 clear + sheet.
    expect(Math.max(...farEnd) - Math.min(...farEnd)).toBeCloseTo(400 + 1.2, 2);
  });

  it('builds the take-off shoe, the damper blade and quadrant for a branch', () => {
    const settings = resolveDuctSettings({});
    const main = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 6000 }] }, 'main');
    const origin = tapOrigin(main, settings, { legIndex: 0, stationMm: 3000, side: 1, style: 'shoe-45', vcd: true }, { widthMm: 300, heightMm: 150 })!;
    const start = (origin as { point: { x: number; y: number } }).point;
    const branch = buildDuctRunDraftElement({ origin, points: [{ x: start.x + 2000, y: start.y }], legSizes: [{ widthMm: 300, heightMm: 150 }] }, 'branch');
    const group = meshOf(branch, settings, [unit, main, branch]);
    expect(group.getObjectByName('duct-accessories')).toBeDefined();
    const metal = box(group, 'duct-metal');
    // The shoe starts on the parent wall and its 45° lead-in widens it along the parent: 300 + 102.
    expect(metal.min.x).toBeCloseTo(start.x, 3);
    expect(metal.max.x).toBeCloseTo(start.x + 2000, 3);
    expect(metal.max.y - metal.min.y).toBeCloseTo(300 + 102 + 1.2, 1);
  });

  it('builds a Y split: branch elbows plus a plate over the side without a branch', () => {
    const settings = resolveDuctSettings({});
    const plain = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 3000 }] }, 'trunk');
    const trunk = { ...plain, properties: buildDuctRunElement({ ...readDuctRunSpec(plain)!, end: { kind: 'split', style: 'y' } }).properties! };
    const origin = splitOrigin(trunk, settings, { side: 1, style: 'y', vcd: false }, { widthMm: 300, heightMm: 164 })!;
    const start = (origin as { point: { x: number; y: number } }).point;
    const branch = buildDuctRunDraftElement({ origin, points: [{ x: start.x + 1500, y: start.y }], legSizes: [{ widthMm: 300, heightMm: 164 }] }, 'b1');
    const group = meshOf(trunk, settings, [unit, trunk, branch]);
    const metal = box(group, 'duct-metal');
    // The elbow's outlet face is where the branch run begins.
    expect(metal.max.x).toBeCloseTo(start.x, 3);
    expect(group.getObjectByName('duct-caps')).toBeDefined();
  });
});
