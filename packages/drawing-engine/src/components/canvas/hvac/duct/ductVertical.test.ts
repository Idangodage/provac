import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { addDuctRunMeshes } from '../three3d/ductMeshes';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctBom } from './ductBom';
import { buildDuctRunDraftElement, levelledPath, type DuctDraftPoint } from './ductDraft';
import { planDuctRun, type DuctFabricationPlan } from './ductFabricationPlanner';
import { ductRunElementWithSpec } from './ductFollow';
import { ductLegs } from './ductGeometry';
import { buildDuctPlanPresentation } from './ductPlanPresentation';
import { resolveDuctSettings } from './ductSettings';
import { readDuctRunSpec, type DuctLeg } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
  properties: { modelCode: 'FDUM22KXE6F-W', modelUrl: '/models/vrf/maco-vrf-fdum22kxe6f-w.glb' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const z0 = supply.lip.z - supply.heightMm / 2;
const collar: DuctLeg = { widthMm: 674, heightMm: 164 };
const P1 = { x: supply.lip.x, y: supply.lip.y - 2000 };

function run(points: DuctDraftPoint[], legSizes: DuctLeg[] = [collar], overrideSettings = settings): { element: HvacElement; plan: DuctFabricationPlan } {
  const element = buildDuctRunDraftElement({ port: supply, points, legSizes }, 'run');
  return { element, plan: planDuctRun(element, { settings: overrideSettings, scene: [unit, element] })! };
}

/** Largest 3D gap between one piece's end and the next piece's start. */
function largestGap(plan: DuctFabricationPlan): number {
  const pieces = plan.pieces.filter((piece) => piece.kind !== 'end-cap' && piece.kind !== 'split');
  let worst = 0;
  for (let index = 1; index < pieces.length; index += 1) {
    const a = pieces[index - 1]!;
    const b = pieces[index]!;
    worst = Math.max(worst, Math.hypot(a.end.x - b.start.x, a.end.y - b.start.y, a.endCentreZ - b.centreZ));
  }
  return worst;
}

describe('vertical legs: risers and drops', () => {
  // 2 m off the collar, drop 800, then 3 m on at the lower level reduced to 400 × 164.
  const drop = run([P1, { x: P1.x, y: P1.y - 3000, z: z0 - 800 }], [collar, { widthMm: 400, heightMm: 164 }]);

  it('the draft inserts the drop at the point where the level changes, keeping the arriving section', () => {
    const spec = readDuctRunSpec(drop.element)!;
    expect(spec.path.map((point) => Math.round(point.z - z0))).toEqual([0, 0, -800, -800]);
    expect(spec.legs).toEqual([collar, collar, { widthMm: 400, heightMm: 164 }]);
    const legs = ductLegs(spec);
    expect(legs.map((leg) => leg.vertical)).toEqual([0, -1, 0]);
    expect(legs[1]!.direction.x).toBeCloseTo(0, 9);
    expect(legs[1]!.direction.y).toBeCloseTo(-1, 9);
    expect(legs[1]!.lengthMm).toBeCloseTo(800, 9);
  });

  it('fabricates the drop: two easy-way vertical elbows on H, a riser section, then the reducer', () => {
    expect(drop.plan.status).toBe('ok');
    expect(drop.plan.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    const elbows = drop.plan.pieces.filter((piece) => piece.kind === 'elbow');
    expect(elbows).toHaveLength(2);
    for (const elbow of elbows) {
      expect(elbow.elbow!.plane).toBe('vertical');
      expect(elbow.elbow!.inPlaneMm).toBe(164);
      // SMACNA Fig. 2-2 RE1 R = 1.5 × the in-plane size (H for the easy way).
      expect(elbow.elbow!.centrelineRadiusMm).toBeCloseTo(246, 9);
    }
    // Drop: centreline 800; each elbow takes R + neck = 296 of it.
    const riser = drop.plan.pieces.filter((piece) => piece.vertical && piece.kind === 'straight');
    expect(riser.map((piece) => Math.round(piece.lengthMm))).toEqual([208]);
    expect(riser[0]!.vertical).toBe(-1);
    expect(riser[0]!.centreZ).toBeCloseTo(supply.lip.z - 296, 6);
    expect(riser[0]!.endCentreZ).toBeCloseTo(supply.lip.z - 504, 6);
    const reducer = drop.plan.pieces.find((piece) => piece.kind === 'transition')!;
    expect(reducer.vertical).toBeUndefined();
    expect(reducer.bottomZ).toBeCloseTo(z0 - 800, 9);
  });

  it('every piece meets the next in 3D, and the riser joints lie flat', () => {
    expect(largestGap(drop.plan)).toBeLessThan(0.5);
    const flat = drop.plan.joints.filter((joint) => joint.vertical);
    expect(flat).toHaveLength(2);
    for (const joint of flat) {
      expect(joint.point.x).toBeCloseTo(P1.x, 6);
      expect(joint.point.y).toBeCloseTo(P1.y, 6);
    }
  });

  it('draws the drop symbol and tags each level; the BOM names the vertical elbows', () => {
    const presentation = buildDuctPlanPresentation(drop.plan);
    expect(presentation.risers).toHaveLength(1);
    expect(presentation.risers[0]!.up).toBe(false);
    expect(presentation.risers[0]!.diagonals).toHaveLength(2);
    expect(presentation.risers[0]!.label).toMatch(/^▼ 800 · BOD /);
    const levels = presentation.tags.map((tag) => /BOD (\d+)/.exec(tag.text)?.[1]);
    expect(new Set(levels).size).toBe(2);
    const bom = buildDuctBom([drop.plan]);
    expect(bom.some((row) => row.description === '90° radius elbow (vertical, easy way) R/H 1.5')).toBe(true);
    expect(bom.some((row) => row.description.startsWith('Straight section (drop)'))).toBe(true);
  });

  it('builds 3D down the drop', () => {
    const group = new THREE.Group();
    // The duct itself (its hangers reach below it).
    addDuctRunMeshes(group, drop.element, { allElements: [unit, drop.element], ductSettings: resolveDuctSettings({ showSupports: false }) });
    const box = new THREE.Box3().setFromObject(group);
    expect(box.max.z).toBeGreaterThan(supply.lip.z + 60);
    expect(box.min.z).toBeLessThan(z0 - 800 + 1);
    // The lowest metal is the TDC flange frame, 30 mm proud of the sheet.
    expect(box.min.z).toBeGreaterThan(z0 - 800 - 40);
  });

  it('a remainder too short for a section goes into the elbow neck (600 drop: 8 mm left)', () => {
    const tight = run([P1, { x: P1.x, y: P1.y - 3000, z: z0 - 600 }]);
    expect(tight.plan.pieces.filter((piece) => piece.vertical && piece.kind === 'straight')).toEqual([]);
    const lower = tight.plan.pieces.filter((piece) => piece.kind === 'elbow')[1]!;
    expect(lower.elbow!.extraNeckInMm).toBeCloseTo(8, 6);
    expect(lower.lengthMm).toBeCloseTo((246 * Math.PI) / 2 + 100 + 8, 6);
    expect(tight.plan.practiceRules.some((rule) => /elbow neck/.test(rule))).toBe(true);
    expect(largestGap(tight.plan)).toBeLessThan(0.5);
  });

  it('a short drop between level legs becomes one vertical ogee offset', () => {
    const short = run([P1, { x: P1.x, y: P1.y - 2000, z: z0 - 200 }]);
    expect(short.plan.status).toBe('ok');
    const offset = short.plan.pieces.find((piece) => piece.kind === 'offset')!;
    expect(offset.offset!.type).toBe('ogee');
    expect(offset.frame).toBeDefined();
    expect(offset.centreZ - offset.endCentreZ).toBeCloseTo(200, 6);
    expect(short.plan.pieces.filter((piece) => piece.vertical)).toEqual([]);
    expect(largestGap(short.plan)).toBeLessThan(0.5);
  });

  it('square vaned vertical elbows carry vanes spanning W, counted on the H diagonal', () => {
    const square = run([P1, { x: P1.x, y: P1.y - 3000, z: z0 - 800 }], [collar], resolveDuctSettings({ elbowStyle: 'square-vaned' }));
    const elbow = square.plan.pieces.find((piece) => piece.kind === 'elbow')!.elbow!;
    expect(elbow.style).toBe('square-vaned');
    expect(elbow.vanes!.lengthMm).toBe(674);
    expect(elbow.setbackMm).toBe(82);
    expect(largestGap(square.plan)).toBeLessThan(0.5);
  });

  it('a riser with its own section gets a concentric transition and ends in a flat cap', () => {
    const up = run([P1, { x: P1.x, y: P1.y, z: z0 + 1500 }], [collar, { widthMm: 500, heightMm: 164 }]);
    const reducer = up.plan.pieces.find((piece) => piece.kind === 'transition')!;
    expect(reducer.vertical).toBe(1);
    expect(reducer.endCentreZ).toBeGreaterThan(reducer.centreZ);
    const cap = up.plan.pieces.at(-1)!;
    expect(cap.kind).toBe('end-cap');
    expect(cap.vertical).toBe(1);
    expect(largestGap(up.plan)).toBeLessThan(0.5);
    expect(up.plan.status).toBe('ok');
  });

  it('refuses a plan turn at a riser (a hard-way bend)', () => {
    const twisted = run([P1, { x: P1.x + 3000, y: P1.y, z: z0 - 800 }]);
    expect(twisted.plan.issues.map((issue) => issue.code)).toContain('DU_HARD_WAY_ELBOW');
    expect(twisted.plan.status).toBe('error');
  });

  it('refuses a sloped leg and a riser straight off a collar', () => {
    const spec = readDuctRunSpec(drop.element)!;
    const sloped = ductRunElementWithSpec(drop.element, { ...spec, path: spec.path.map((point, index) => (index === 3 ? { ...point, z: point.z + 300 } : point)) });
    const slopedPlan = planDuctRun(sloped, { settings, scene: [unit, sloped] })!;
    expect(slopedPlan.issues.map((issue) => issue.code)).toContain('DU_SLOPED_LEG');
    const straightUp = run([{ x: supply.lip.x, y: supply.lip.y, z: z0 + 600 }]);
    expect(straightUp.plan.issues.find((issue) => issue.code === 'DU_SLOPED_LEG')?.message).toMatch(/leave its collar or parent level/);
    expect(slopedPlan.issues.map((issue) => issue.code)).not.toContain('DU_VERTICAL_PENDING');
  });
});

describe('levelled draft path', () => {
  const a: DuctLeg = { widthMm: 600, heightMm: 300 };
  const b: DuctLeg = { widthMm: 400, heightMm: 300 };

  it('rises at the previous point, keeping the section arriving there', () => {
    const { path, legs } = levelledPath({ x: 0, y: 0, z: 2700 }, [{ x: 1000, y: 0 }, { x: 2000, y: 0, z: 3300 }], (index) => (index === 0 ? a : b));
    expect(path).toEqual([{ x: 1000, y: 0, z: 2700 }, { x: 1000, y: 0, z: 3300 }, { x: 2000, y: 0, z: 3300 }]);
    expect(legs).toEqual([a, a, b]);
  });

  it('a click on the previous point is a vertical leg of its own section; a free start may rise first', () => {
    const drop = levelledPath({ x: 0, y: 0, z: 2700 }, [{ x: 1000, y: 0 }, { x: 1000, y: 0, z: 2200 }], (index) => (index === 0 ? a : b));
    expect(drop.legs).toEqual([a, b]);
    const risingStart = levelledPath({ x: 0, y: 0, z: 2700 }, [{ x: 0, y: 1500, z: 3000 }], () => b, a);
    expect(risingStart.path).toEqual([{ x: 0, y: 0, z: 3000 }, { x: 0, y: 1500, z: 3000 }]);
    expect(risingStart.legs).toEqual([a, b]);
  });
});
