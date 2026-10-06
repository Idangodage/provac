import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { resolveUnitAirPorts } from '../duct/ductAirPorts';
import { spigotOrigin, splitOrigin, tapOrigin } from '../duct/ductBranchTargets';
import { buildDuctRunDraftElement } from '../duct/ductDraft';
import { getDuctRunPlan } from '../duct/ductFabricationPlanner';
import { FLEX_RULES } from '../duct/ductFlex';
import { ductSegmentOf, segmentBounds3D } from '../duct/ductSegments';
import { resolveDuctSettings } from '../duct/ductSettings';
import { DUCT_BAND_RADIAL_OFFSET_MM, planDuctSupports } from '../duct/ductSupports';
import { buildDuctRunElement, readDuctRunSpec, roundLeg } from '../duct/ductTypes';

import { buildHvacElementMesh } from './buildHvacElementMesh';
import { addDuctSupportMeshes, ductPiecesOuterGeometry } from './ductMeshes';

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
  it("outlines a segment by its pieces' outer surface: the insulation's face, inside the segment's 3D box", () => {
    const settings = resolveDuctSettings({ showSupports: false });
    const run = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 3000 }, { x: supply.lip.x + 2500, y: supply.lip.y - 3000 }],
      legSizes: [{ widthMm: 600, heightMm: 300 }, { widthMm: 600, heightMm: 300 }] }, 'outlined');
    const scene = [unit, run];
    const plan = getDuctRunPlan(run, scene, settings)!;
    for (const key of ['leg:0', 'node:1']) {
      const geometry = ductPiecesOuterGeometry(plan, ductSegmentOf(plan, key)!.pieceIndices)!;
      expect(Object.keys(geometry.attributes)).toEqual(['position']);
      geometry.computeBoundingBox();
      const drawn = geometry.boundingBox!;
      const bounds = segmentBounds3D(plan, key)!;
      // The skin stands the sheet plus the insulation off the clear section (NBR on a supply duct).
      const skin = 1 + plan.insulationMm;
      expect(drawn.min.z).toBeCloseTo(bounds.min.z - skin, 0);
      expect(drawn.max.z).toBeCloseTo(bounds.max.z + skin, 0);
      expect(drawn.min.x).toBeGreaterThan(bounds.min.x - skin - 2);
      expect(drawn.max.x).toBeLessThan(bounds.max.x + skin + 2);
      geometry.dispose();
    }
  });

  it('cuts round and shoe takeoffs into opposite main walls while keeping the roof and neighbouring sheet closed', () => {
    const settings = resolveDuctSettings({ showSupports: false });
    const main = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 8000 }],
      legSizes: [{ widthMm: 600, heightMm: 300 }] }, 'opened-main');
    const branches = ([{ side: 1, station: 2200, style: 'spin-in', section: roundLeg(200) },
      { side: -1, station: 4200, style: 'shoe-45', section: { widthMm: 250, heightMm: 150 } },
      { side: 1, station: 6200, style: 'conical', section: roundLeg(200) }] as const).map((request, index) => {
      const origin = tapOrigin(main, settings, { legIndex: 0, stationMm: request.station, side: request.side, style: request.style, vcd: false }, request.section)!;
      if (origin.kind !== 'tap') throw new Error('Expected tap');
      return buildDuctRunDraftElement({ origin, points: [{ x: origin.point.x + origin.direction.x * 1000, y: origin.point.y + origin.direction.y * 1000 }],
        legSizes: [request.section] }, `opened-branch-${index}`);
    });
    const scene = [unit, main, ...branches];
    const group = meshOf(main, settings, scene);
    const metal = group.getObjectByName('duct-metal')!;
    for (const branch of branches) {
      const plan = getDuctRunPlan(branch, scene, settings)!;
      const tap = plan.tap!;
      const d = new THREE.Vector3(tap.direction.x, tap.direction.y, 0);
      const p = new THREE.Vector3(tap.wallPoint.x, tap.wallPoint.y,
        tap.bottomZ + (tap.openingDiameterMm ?? plan.spec.legs[0]!.heightMm) / 2);
      const ray = new THREE.Raycaster(p.clone().addScaledVector(d, 40), d.clone().negate(), 0, 80);
      expect(ray.intersectObject(metal)).toHaveLength(0);
      // Sheet next to the opening remains closed; no entire side is omitted.
      ray.ray.origin.add(new THREE.Vector3(tap.parentDirection.x * 300, tap.parentDirection.y * 300, 0));
      expect(ray.intersectObject(metal).length).toBeGreaterThan(0);
      const roof = new THREE.Vector3(tap.wallPoint.x - d.x * 150, tap.wallPoint.y - d.y * 150, tap.bottomZ + 350);
      expect(new THREE.Raycaster(roof, new THREE.Vector3(0, 0, -1), 0, 100).intersectObject(metal).length).toBeGreaterThan(0);
    }
    // A removed branch closes its parent's sheet again on the next rebuild.
    const closed = meshOf(main, settings, [unit, main]);
    const tap = getDuctRunPlan(branches[0]!, scene, settings)!.tap!;
    const direction = new THREE.Vector3(tap.direction.x, tap.direction.y, 0);
    const ray = new THREE.Raycaster(new THREE.Vector3(tap.wallPoint.x, tap.wallPoint.y, tap.bottomZ + 100).addScaledVector(direction, 40), direction.negate(), 0, 80);
    expect(ray.intersectObject(closed.getObjectByName('duct-metal')!).length).toBeGreaterThan(0);
  });

  it.each(['left', 'right', 'end'] as const)('opens the %s plenum spigot through the parent sheet', (face) => {
    const settings = resolveDuctSettings({ showSupports: false });
    const main = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 1500 }],
      end: { kind: 'plenum', widthMm: 900, heightMm: 350, lengthMm: 600 } }, 'plenum-open');
    const origin = spigotOrigin(main, settings, { face, alongMm: 300, acrossMm: 0, style: 'spin-in', vcd: false }, roundLeg(200))!;
    if (origin.kind !== 'spigot') throw new Error('Expected spigot');
    const branch = buildDuctRunDraftElement({ origin,
      points: [{ x: origin.point.x + origin.direction.x * 1000, y: origin.point.y + origin.direction.y * 1000 }], legSizes: [roundLeg(200)] }, 'plenum-out');
    const group = meshOf(main, settings, [unit, main, branch]);
    const direction = new THREE.Vector3(origin.direction.x, origin.direction.y, 0);
    const point = new THREE.Vector3(origin.point.x, origin.point.y, origin.bottomZ + 100);
    const ray = new THREE.Raycaster(point.addScaledVector(direction, 40), direction.negate(), 0, 80);
    expect(ray.intersectObject(group, true)).toHaveLength(0);
  });

  it('renders a flexible support strap at its specified width without blocking the airway', () => {
    const group = new THREE.Group();
    addDuctSupportMeshes({ elementId: 'flex', spacingMm: 1200, soffitZ: 3000, risers: [], terminalWires: [], issues: [], hangers: [{
      id: 'strap', kind: 'strap', stationMm: 500, legIndex: 0, point: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, reasons: ['spacing'],
      outerWidthMm: 250, outerHeightMm: 250, supportZ: 2375, soffitZ: 3000, rods: [], rod: null, bar: null,
      loadKg: 0, smacnaMinimum: 'project', insert: false,
    }] }, (name, material, geometry) => {
      if (geometry) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = name;
        group.add(mesh);
      }
    });
    group.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(FLEX_RULES.minStrapWidthMm, 6);
    expect(bounds.min.z).toBeLessThan(2375);
    const ray = new THREE.Raycaster(new THREE.Vector3(-100, 0, 2500), new THREE.Vector3(1, 0, 0), 0, 200);
    expect(ray.intersectObject(group, true)).toHaveLength(0);
  });

  it.each([
    { name: 'horizontal', x: 1, y: 0, z: 0 },
    { name: 'sloped', x: 0.36, y: 0.48, z: 0.8 },
    { name: 'vertical up', x: 0, y: 0, z: 1 },
    { name: 'vertical down', x: 0, y: 0, z: -1 },
  ])('orients the strap and its wire outside a $name flex core', ({ x, y, z }) => {
    const settings = resolveDuctSettings({ soffitMm: 7000 });
    const run = buildDuctRunDraftElement({ origin: { kind: 'free', point: { x: 0, y: 0 }, bottomZ: 2900, service: 'supply' },
      points: [{ x: 1600, y: 0 }], legSizes: [roundLeg(200)] }, 'strap-frame');
    const base = getDuctRunPlan(run, [run], settings)!;
    const template = base.pieces.find((piece) => piece.kind === 'straight')!;
    const start = { x: 0, y: 0, z: 3000 };
    const end = { x: 1600 * x, y: 1600 * y, z: 3000 + 1600 * z };
    // Isolate the local runout segment: attachment fittings do not change the
    // support frame at its midpoint, including the vertical limiting case.
    const supports = planDuctSupports({ ...base, pieces: [{ ...template, kind: 'flex', start, end,
      lengthMm: 1600, stationStartMm: 0, stationEndMm: 1600,
      flex: { points: [start, end], stations: [0, 1600], minBendRadiusMm: Infinity, terminalId: 'terminal', type: 'nm-il', jacketMm: 25 },
    }] }, [run], settings, 7000);
    const strap = supports.hangers.find((hanger) => hanger.kind === 'strap')!;
    expect(strap.strapFrame).toBeDefined();
    const axis = new THREE.Vector3(x, y, z);
    const centre = new THREE.Vector3(strap.strapFrame!.centre.x, strap.strapFrame!.centre.y, strap.strapFrame!.centre.z);
    const wire = strap.rods[0]!;
    const attachment = new THREE.Vector3(wire.point.x, wire.point.y, wire.bottomZ).sub(centre);
    const radius = strap.outerWidthMm / 2 + DUCT_BAND_RADIAL_OFFSET_MM;
    expect(attachment.dot(axis)).toBeCloseTo(0, 6);
    expect(attachment.length()).toBeCloseTo(radius, 6);
    // Every point above the attachment remains outside the cylindrical core.
    for (const rise of [0, 100, wire.lengthMm]) {
      const offset = attachment.clone().add(new THREE.Vector3(0, 0, rise));
      const radial = offset.clone().addScaledVector(axis, -offset.dot(axis));
      expect(radial.length()).toBeGreaterThanOrEqual(radius - 1e-6);
    }
    const parts: THREE.BufferGeometry[] = [];
    addDuctSupportMeshes({ ...supports, hangers: [strap] }, (_name, _material, geometry) => { if (geometry) parts.push(geometry); });
    const band = parts.at(-1)!;
    const positions = band.getAttribute('position');
    const along: number[] = [];
    for (let index = 0; index < positions.count; index += 1) {
      const offset = new THREE.Vector3().fromBufferAttribute(positions, index).sub(centre);
      const station = offset.dot(axis);
      along.push(station);
      expect(offset.addScaledVector(axis, -station).length()).toBeCloseTo(radius, 3);
    }
    expect(Math.max(...along) - Math.min(...along)).toBeCloseTo(FLEX_RULES.minStrapWidthMm, 3);
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(band, material);
    mesh.updateMatrixWorld(true);
    expect(new THREE.Raycaster(centre.clone().addScaledVector(axis, -100), axis, 0, 200).intersectObject(mesh)).toHaveLength(0);
    parts.forEach((part) => part.dispose());
    material.dispose();
  });

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
