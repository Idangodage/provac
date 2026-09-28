import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { addDuctRunMeshes } from '../three3d/ductMeshes';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctBom } from './ductBom';
import { buildDuctRunDraftElement } from './ductDraft';
import { planDuctRun } from './ductFabricationPlanner';
import { ductRunElementWithSpec } from './ductFollow';
import { ductInsulationThicknessMm } from './ductInsulation';
import { buildDuctPlanPresentation } from './ductPlanPresentation';
import { resolveDuctSettings } from './ductSettings';
import { planDuctSupports } from './ductSupports';
import { readDuctRunSpec } from './ductTypes';

const settings = resolveDuctSettings({ soffitMm: 2900 });
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
  properties: { modelCode: 'FDUM22KXE6F-W', modelUrl: '/models/vrf/maco-vrf-fdum22kxe6f-w.glb' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const bare = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 3000 }] }, 'run');
const insulated = ductRunElementWithSpec(bare, { ...readDuctRunSpec(bare)!, construction: 'gi-nbr', insulationThicknessMm: 25 });
const plan = planDuctRun(insulated, { settings, scene: [unit, insulated] })!;

describe('NBR insulation', () => {
  it('thickness: the run\'s own, else the project default by service; bare carries none', () => {
    const spec = readDuctRunSpec(bare)!;
    expect(ductInsulationThicknessMm(spec, settings)).toBe(0);
    expect(ductInsulationThicknessMm({ ...spec, construction: 'gi-nbr', insulationThicknessMm: 0 }, settings)).toBe(25);
    expect(ductInsulationThicknessMm({ ...spec, construction: 'gi-nbr', insulationThicknessMm: 0, service: 'return' }, settings)).toBe(19);
    expect(ductInsulationThicknessMm({ ...spec, construction: 'gi-nbr', insulationThicknessMm: 13 }, settings)).toBe(13);
  });

  it('takes off the sheet at the mid-plane, boxes each flange, adds adhesive at 8 m²/L and 10 % waste', () => {
    expect(plan.insulationMm).toBe(25);
    const takeoff = plan.insulation!;
    const sheet = plan.pieces.find((piece) => piece.kind === 'straight')!.sheetThicknessMm!;
    const outerW = 674 + 2 * sheet;
    const outerH = 164 + 2 * sheet;
    const girth = 2 * (outerW + outerH) + 4 * 25;
    const covered = plan.pieces.filter((piece) => piece.kind !== 'connector' && piece.kind !== 'end-cap').reduce((total, piece) => total + piece.lengthMm, 0);
    const cap = (outerW + 50) * (outerH + 50);
    const bands = plan.joints.filter((joint) => joint.kind === 'flange').length;
    expect(takeoff.flangeBands).toBe(bands);
    const bandArea = bands * (2 * (outerW + outerH) + 8 * 30 + 100) * (2 * 30 + 100);
    expect(takeoff.areaM2).toBeCloseTo((girth * covered + cap + bandArea) / 1e6, 6);
    expect(takeoff.adhesiveL).toBeCloseTo(takeoff.areaM2 / 8, 9);
    expect(takeoff.areaWithWasteM2).toBeCloseTo(takeoff.areaM2 * 1.1, 9);
    expect(takeoff.tapeM).toBeGreaterThan(covered / 1000);
  });

  it('drops cross-breaking on insulated duct (SMACNA S1.15)', () => {
    const wide = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 3000 }], legSizes: [{ widthMm: 1200, heightMm: 400 }] }, 'wide');
    const barePlan = planDuctRun(wide, { settings, scene: [unit, wide] })!;
    expect(barePlan.issues.map((issue) => issue.code)).toContain('DU_CROSS_BREAK');
    const wrapped = ductRunElementWithSpec(wide, { ...readDuctRunSpec(wide)!, construction: 'gi-nbr', insulationThicknessMm: 25 });
    const wrappedPlan = planDuctRun(wrapped, { settings, scene: [unit, wrapped] })!;
    expect(wrappedPlan.issues.map((issue) => issue.code)).not.toContain('DU_CROSS_BREAK');
  });

  it('hangs the insulated duct under its insulation, with an insert on every trapeze', () => {
    const barePlan = planDuctRun(bare, { settings, scene: [unit, bare] })!;
    const bareSupports = planDuctSupports(barePlan, [unit, bare], settings, 2900);
    const supports = planDuctSupports(plan, [unit, insulated], settings, 2900);
    const a = bareSupports.hangers[0]!;
    const b = supports.hangers[0]!;
    expect(b.supportZ).toBeCloseTo(a.supportZ - 25, 9);
    expect(b.bar!.spanMm).toBeCloseTo(a.bar!.spanMm + 50, 9);
    expect(supports.hangers.every((hanger) => hanger.insert)).toBe(true);
    const bom = buildDuctBom([plan], [supports]);
    const nbr = bom.find((row) => row.description === 'NBR (elastomeric) sheet, incl. waste')!;
    expect(nbr.size).toBe('25 mm');
    expect(nbr.quantity).toBeCloseTo(Math.round(plan.insulation!.areaWithWasteM2 * 100) / 100, 9);
    expect(bom.find((row) => row.description.startsWith('Contact adhesive'))!.unit).toBe('L');
    expect(bom.find((row) => row.description.startsWith('Load-bearing insulation insert'))!.quantity).toBe(supports.hangers.length);
  });

  it('a drop on an insulated run labels the insulation\'s underside as BOD', () => {
    const z = readDuctRunSpec(bare)!.path[0]!.z;
    const drop = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 3000 }, { x: supply.lip.x, y: supply.lip.y - 6000, z: z - 800 }] }, 'drop');
    const wrapped = ductRunElementWithSpec(drop, { ...readDuctRunSpec(drop)!, construction: 'gi-nbr', insulationThicknessMm: 25 });
    const presentation = buildDuctPlanPresentation(planDuctRun(wrapped, { settings, scene: [unit, wrapped] })!);
    expect(presentation.risers[0]!.label).toBe(`▼ 800 · BOD ${Math.round(z - 800 - 0.6 - 25)}`);
  });

  it('draws the insulation dashed in plan, tags NBR, and skins the duct black in 3D', () => {
    const presentation = buildDuctPlanPresentation(plan);
    expect(presentation.insulationOutlines.length).toBeGreaterThan(0);
    expect(presentation.tags[0]!.text).toMatch(/· NBR 25 · /);
    // BOD is the insulation's underside.
    expect(presentation.tags[0]!.text).toMatch(new RegExp(`BOD ${Math.round(readDuctRunSpec(bare)!.path[0]!.z - 0.6 - 25)}$`));
    const group = new THREE.Group();
    addDuctRunMeshes(group, insulated, { allElements: [unit, insulated], ductSettings: resolveDuctSettings({ showSupports: false }) });
    const skin = group.getObjectByName('duct-insulation') as THREE.Mesh;
    expect(skin).toBeDefined();
    const skinBox = new THREE.Box3().setFromObject(skin);
    const metalBox = new THREE.Box3().setFromObject(group.getObjectByName('duct-metal')!);
    expect(skinBox.min.z).toBeCloseTo(metalBox.min.z - 25, 3);
  });
});
