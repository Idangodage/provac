import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import { buildHvacElementMesh } from '../three3d/buildHvacElementMesh';
import { roundMainCollarRings } from '../three3d/ductMeshes';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctBom } from './ductBom';
import { findBranchTarget, splitOrigin, tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement, constrainDuctLeg } from './ductDraft';
import { planDuctRun } from './ductFabricationPlanner';
import { buildDuctPlanPresentation } from './ductPlanPresentation';
import { mainPassageLossPa, takeoffBranchLossPa } from './ductPressure';
import { roundMainTapGeometry, roundReducerMinLengthMm, roundTapEdgeMm, wyeLegLengthMm } from './ductRoundFittings';
import { resolveDuctSettings } from './ductSettings';
import { velocityPressurePa } from './ductSizing';
import { squareToRoundAreaMm2 } from './ductSquareToRound';
import { readDuctRunSpec, roundLeg, type DuctRunSpec, type DuctTapStyle } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const MAIN_D = 355;

/** A round main off the supply collar: a square-to-round after the connector, then Ø355 for 6 m. */
function roundMain(end?: DuctRunSpec['end']): HvacElement {
  const element = buildDuctRunDraftElement({
    port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 6000 }], legSizes: [roundLeg(MAIN_D)],
  }, 'main');
  if (!end) return element;
  const spec = readDuctRunSpec(element)!;
  return { ...element, properties: { ...element.properties, ductRun: { ...spec, end } } };
}

function branchOff(main: HvacElement, style: DuctTapStyle, diameter: number, offsets: Point2D[], stationMm = 3000) {
  const origin = tapOrigin(main, settings, { legIndex: 0, stationMm, side: 1, style, vcd: true }, roundLeg(diameter))!;
  let cursor = (origin as { point: Point2D }).point;
  const points = offsets.map((offset) => (cursor = { x: cursor.x + offset.x, y: cursor.y + offset.y }));
  const element = buildDuctRunDraftElement({ origin, points, legSizes: [roundLeg(diameter)] }, `b-${style}`);
  return { origin, element, plan: planDuctRun(element, { settings, scene: [unit, main, element] })! };
}

const codes = (plan: { issues: Array<{ code: string; severity: string }> }) => plan.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code);

describe('square-to-round (SMACNA Fig. 2-7)', () => {
  it('its development area: between the square and its inscribed circle when flat, a frustum-like band when long', () => {
    const r = 200;
    const flat = squareToRoundAreaMm2({ rectHalfWidthMm: r, rectHalfHeightMm: r, rectCentreUpMm: 0, radiusMm: r, circleCentreUpMm: 0, lengthMm: 0, rectAtStart: true });
    // 16 segments per quarter: the circle is the inscribed 64-gon, so the flat area is exactly square − 64-gon.
    const polygon = 32 * r * r * Math.sin((2 * Math.PI) / 64);
    expect(flat).toBeCloseTo(4 * r * r - polygon, 3);
    expect(flat / ((4 - Math.PI) * r * r)).toBeCloseTo(1, 1);
    const long = 5000;
    const band = squareToRoundAreaMm2({ rectHalfWidthMm: r, rectHalfHeightMm: r, rectCentreUpMm: 0, radiusMm: r, circleCentreUpMm: 0, lengthMm: long, rectAtStart: true });
    expect(band / (((8 * r + 2 * Math.PI * r) / 2) * long)).toBeCloseTo(1, 1);
  });

  it('joins the rectangular collar to a round main: a mixed transition within the Fig. 2-7 angles, priced by its development', () => {
    const main = roundMain();
    const plan = planDuctRun(main, { settings, scene: [unit, main] })!;
    expect(codes(plan)).toEqual([]);
    const transition = plan.pieces.find((piece) => piece.kind === 'transition')!;
    expect(transition.diameterMm).toBeUndefined();
    expect(transition.endDiameterMm).toBe(MAIN_D);
    expect(transition.widthMm).toBe(supply.widthMm);
    // A rectangle-to-rectangle guess would take the mean girth over the slant; the development differs from it.
    expect(transition.sheetAreaM2).toBeGreaterThan(0.2);
    expect(buildDuctBom([plan]).some((row) => row.description.startsWith('Square-to-round transition'))).toBe(true);
    // Plan view: the fold lines of the development.
    expect(buildDuctPlanPresentation(plan).goreLines.length).toBeGreaterThanOrEqual(2);
  });

  it('builds a true square-to-round in 3D: rectangular at the collar, round at the main', () => {
    const main = roundMain();
    const group = buildHvacElementMesh(main, { allElements: [unit, main], ductSettings: settings })!;
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group.getObjectByName('duct-metal')!);
    const plan = planDuctRun(main, { settings, scene: [unit, main] })!;
    const bottom = plan.spec.path[0]!.z;
    // Flat bottom shared: nothing below the clear bottom less the sheet, the round main on top.
    expect(box.min.z).toBeGreaterThan(bottom - 2);
    expect(box.max.z).toBeCloseTo(bottom + MAIN_D + (plan.pieces.at(-2)!.sheetThicknessMm ?? 0), 0);
  });
});

describe('take-offs off a round main (SMACNA Fig. 3-4 / 3-5)', () => {
  it('conical tap: L1 ≥ 152 + 51 spigot, mouth C + 51, centred on the main, window kept clear of joints', () => {
    const main = roundMain();
    const { origin, element, plan } = branchOff(main, 'round-conical', 200, [{ x: 1500, y: 0 }]);
    expect(codes(plan)).toEqual([]);
    const takeoff = plan.pieces[0]!;
    expect(takeoff.kind).toBe('takeoff');
    expect(takeoff.takeoff).toMatchObject({ style: 'round-conical', openingMm: 251 });
    expect(takeoff.lengthMm).toBe(203);
    const mainBottom = readDuctRunSpec(main)!.path[0]!.z;
    expect((origin as { bottomZ: number }).bottomZ).toBeCloseTo(mainBottom + (MAIN_D - 200) / 2, 6);
    // The main keeps its joints out of the tee body (C + 102) and the margin.
    // Tap at 3000 on the main's only leg: no main joint inside the tee body (C + 102) and the margin.
    const parent = planDuctRun(main, { settings, scene: [unit, main, element] })!;
    expect(codes(parent)).toEqual([]);
    const half = 251 / 2 + 51 + settings.tapWindowMarginMm;
    expect(parent.joints.filter((joint) => joint.stationMm > 3000 - half + 0.5 && joint.stationMm < 3000 + half - 0.5)).toEqual([]);
    expect(buildDuctBom([plan]).some((row) => row.description.startsWith('Conical tap into round main, mouth Ø251'))).toBe(true);
  });

  it('90° tap: a 102 mm collar, screws on 101 mm centres round the cut, sealed', () => {
    const main = roundMain();
    const { plan } = branchOff(main, 'round-tee', 200, [{ x: 1500, y: 0 }]);
    expect(codes(plan)).toEqual([]);
    expect(plan.pieces[0]!.lengthMm).toBe(102);
    const hardware = plan.joints[0]!.hardware!;
    expect(hardware).toMatchObject({ system: 'round-takeoff', label: '90° tap into round main' });
    expect(hardware.ductFasteners!.count).toBe(Math.ceil((Math.PI * 200) / 101));
    expect(hardware.sealantLengthMm).toBeCloseTo(Math.PI * 200, 6);
  });

  it('45° lateral: leaves at 45° downstream, and a 45° gored elbow brings it back square', () => {
    const main = roundMain();
    const probe = tapOrigin(main, settings, { legIndex: 0, stationMm: 3000, side: 1, style: 'round-lateral', vcd: true }, roundLeg(200))!;
    const direction = (probe as { direction: Point2D }).direction;
    const d = { x: 0, y: -1 };
    expect(direction.x * d.x + direction.y * d.y).toBeCloseTo(Math.SQRT1_2, 6);
    const out = { x: direction.x * 800, y: direction.y * 800 };
    const square = { x: Math.sign(direction.x) * 1500, y: 0 };
    const { plan } = branchOff(main, 'round-lateral', 200, [out, square]);
    expect(codes(plan)).toEqual([]);
    const elbow = plan.pieces.find((piece) => piece.kind === 'elbow')!;
    expect(elbow.elbow).toMatchObject({ style: 'gored', gores: 2 });
    expect(Math.round(elbow.elbow!.angleDeg)).toBe(45);
    expect(roundTapEdgeMm('round-lateral', 200)).toBeGreaterThan(Math.PI * 200);
  });

  it('S3.4: a branch over two thirds of the main is refused', () => {
    const main = roundMain();
    expect(codes(branchOff(main, 'round-conical', 250, [{ x: 1500, y: 0 }]).plan)).toContain('DU_TAP_TOO_BIG');
    expect(codes(branchOff(main, 'round-conical', 225, [{ x: 1500, y: 0 }]).plan)).toEqual([]);
  });

  it('the wrong fitting for the main\'s shape is refused either way', () => {
    const main = roundMain();
    expect(codes(branchOff(main, 'spin-in', 200, [{ x: 1500, y: 0 }]).plan)).toContain('DU_TAP_CLASH');
    const rect = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 6000 }], legSizes: [{ widthMm: 600, heightMm: 300 }] }, 'rect');
    expect(codes(branchOff(rect, 'round-tee', 200, [{ x: 1500, y: 0 }]).plan)).toContain('DU_TAP_CLASH');
  });

  it('round runs now offer take-off targets to the tool', () => {
    const main = roundMain();
    const spec = readDuctRunSpec(main)!;
    const point = { x: spec.path[0]!.x + MAIN_D / 2 + 10, y: supply.lip.y - 3000 };
    const target = findBranchTarget(point, [unit, main], settings, 60, { branchShape: 'round' });
    expect(target).toMatchObject({ kind: 'tap', side: expect.any(Number) });
    expect(target!.parent.id).toBe('main');
  });

  it('a lateral\'s next leg may turn 45° back square in 90° mode', () => {
    const base = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
    const leg = constrainDuctLeg({ x: 0, y: 0 }, { x: 1000, y: 0 }, base, { first: false, mode: '90', returnTurns: true });
    expect(leg.direction.x).toBeCloseTo(1, 6);
    expect(leg.direction.y).toBeCloseTo(0, 6);
  });
});

describe('a round-main collar sits on the curved main (cut to its saddle)', () => {
  /** A branch off the Ø355 main by `style`; a lateral turns back square after 800 mm. */
  const branch = (main: HvacElement, style: DuctTapStyle) => {
    if (style !== 'round-lateral') return branchOff(main, style, 200, [{ x: 1500, y: 0 }]);
    const probe = tapOrigin(main, settings, { legIndex: 0, stationMm: 3000, side: 1, style, vcd: true }, roundLeg(200))!;
    const direction = (probe as { direction: Point2D }).direction;
    return branchOff(main, style, 200, [{ x: direction.x * 800, y: direction.y * 800 }, { x: Math.sign(direction.x) * 1500, y: 0 }]);
  };
  // The main runs along −y from the collar: its axis is x = the path's x, at half its diameter above the clear bottom.
  const axisOf = (main: HvacElement) => {
    const start = readDuctRunSpec(main)!.path[0]!;
    return { x: start.x, z: start.z + MAIN_D / 2 };
  };
  const styles: DuctTapStyle[] = ['round-lateral', 'round-tee', 'round-conical'];

  for (const style of styles) {
    it(`${style}: the collar's start lies on the main's outside all round, bare and in its insulation skin`, () => {
      const main = roundMain();
      const { element, plan } = branch(main, style);
      expect(codes(plan)).toEqual([]);
      const takeoff = plan.pieces[0]!;
      const cylinder = takeoff.takeoff!.roundMain!;
      expect(cylinder.diameterMm).toBe(MAIN_D);
      // The cylinder is the main as drawn: its sheet is the main's own.
      const mainPlan = planDuctRun(main, { settings, scene: [unit, main, element] })!;
      expect(mainPlan.pieces.find((piece) => piece.kind === 'straight' && piece.diameterMm === MAIN_D)!.sheetThicknessMm).toBe(cylinder.sheetMm);
      const axis = axisOf(main);
      for (const growth of [0, 25]) {
        const rings = roundMainCollarRings(takeoff, (takeoff.sheetThicknessMm ?? 1) + growth)!;
        const outside = MAIN_D / 2 + cylinder.sheetMm + growth;
        for (const point of rings.start) {
          expect(Math.hypot(point.x - axis.x, point.z - axis.z)).toBeCloseTo(outside, 3);
          // On the branch's side of the main, never through to the far side.
          expect(point.x - axis.x).toBeGreaterThan(0);
        }
        // The branch end stays where the plan puts it.
        for (const point of rings.end) expect(Math.hypot(point.x - takeoff.end.x, point.y - takeoff.end.y, point.z - takeoff.centreZ)).toBeLessThan(outside);
      }
    });
  }

  it('in plan a lateral\'s sides run to the main\'s side line (no gap, no overlap), and its joint lies along it', () => {
    const main = roundMain();
    const { plan } = branch(main, 'round-lateral');
    const takeoff = plan.pieces[0]!;
    const sheet = takeoff.sheetThicknessMm ?? 1;
    const edgeX = axisOf(main).x + MAIN_D / 2 + takeoff.takeoff!.roundMain!.sheetMm;
    const presentation = buildDuctPlanPresentation(plan);
    const outline = presentation.piecePolygons.find((piece) => piece.kind === 'takeoff')!.polygon;
    expect(outline[0]!.x).toBeCloseTo(edgeX, 6);
    expect(outline[3]!.x).toBeCloseTo(edgeX, 6);
    // Both sides stay parallel to the branch: the cut is a slanted end, not a pinched one.
    const along = (a: Point2D, b: Point2D) => ((b.x - a.x) * takeoff.direction.y - (b.y - a.y) * takeoff.direction.x);
    expect(along(outline[0]!, outline[1]!)).toBeCloseTo(0, 6);
    expect(along(outline[3]!, outline[2]!)).toBeCloseTo(0, 6);
    expect(Math.hypot(outline[0]!.x - outline[3]!.x, outline[0]!.y - outline[3]!.y)).toBeCloseTo((200 + 2 * sheet) * Math.SQRT2, 3);
    const tick = presentation.jointTicks.find((joint) => joint.kind === 'tap-connection')!;
    expect(tick.a.x).toBeCloseTo(edgeX, 6);
    expect(tick.b.x).toBeCloseTo(edgeX, 6);
  });

  it('a 90° or conical tap keeps its square end in plan; a take-off off a flat wall carries no cylinder', () => {
    const main = roundMain();
    for (const style of ['round-tee', 'round-conical'] as DuctTapStyle[]) {
      const { plan } = branch(main, style);
      const takeoff = plan.pieces[0]!;
      const sheet = takeoff.sheetThicknessMm ?? 1;
      const mouth = (style === 'round-conical' ? takeoff.takeoff!.openingMm! : 200) / 2 + sheet;
      const outline = buildDuctPlanPresentation(plan).piecePolygons.find((piece) => piece.kind === 'takeoff')!.polygon;
      expect(outline[0]!.x).toBeCloseTo(takeoff.start.x, 6);
      expect(Math.abs(outline[0]!.y - takeoff.start.y)).toBeCloseTo(mouth, 6);
    }
    const rect = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 6000 }], legSizes: [{ widthMm: 600, heightMm: 300 }] }, 'rect');
    for (const style of ['spin-in', 'conical'] as DuctTapStyle[]) {
      const takeoff = branchOff(rect, style, 200, [{ x: 1500, y: 0 }]).plan.pieces[0]!;
      expect(takeoff.takeoff!.roundMain).toBeUndefined();
      expect(roundMainCollarRings(takeoff, 1)).toBeNull();
    }
  });

  it('3D: the collar is drawn from its saddle, its bead clear of the main', () => {
    const main = roundMain();
    const { element } = branch(main, 'round-lateral');
    const group = buildHvacElementMesh(element, { allElements: [unit, main, element], ductSettings: settings })!;
    group.updateMatrixWorld(true);
    const axis = axisOf(main);
    const metal = group.getObjectByName('duct-metal') as THREE.Mesh;
    const position = metal.geometry.getAttribute('position');
    let deepest = Number.POSITIVE_INFINITY;
    for (let index = 0; index < position.count; index += 1) {
      const x = position.getX(index);
      const z = position.getZ(index);
      if (position.getY(index) > supply.lip.y - 2000) continue;
      deepest = Math.min(deepest, Math.hypot(x - axis.x, z - axis.z));
    }
    // Nothing of the branch reaches inside the main's sheet.
    expect(deepest).toBeGreaterThan(MAIN_D / 2 - 0.5);
    // The spin-in bead (and the slip sleeve on the spigot) stay outside the main: the old flat
    // collar put its bead 25 mm out on the axis side, 56 mm inside the main.
    const flanges = (group.getObjectByName('duct-flanges') as THREE.Mesh).geometry.getAttribute('position');
    let closest = Number.POSITIVE_INFINITY;
    for (let index = 0; index < flanges.count; index += 1) closest = Math.min(closest, Math.hypot(flanges.getX(index) - axis.x, flanges.getZ(index) - axis.z));
    expect(closest).toBeGreaterThan(MAIN_D / 2 - 2);
  });
});

describe('round reducer and wye (SMACNA Fig. 3-5)', () => {
  it('a reducer cone is at least A − B and 102 mm long', () => {
    expect(roundReducerMinLengthMm(355, 200)).toBe(155);
    expect(roundReducerMinLengthMm(200, 160)).toBe(102);
    const element = buildDuctRunDraftElement({
      port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 3000 }, { x: supply.lip.x, y: supply.lip.y - 6000 }],
      legSizes: [roundLeg(MAIN_D), roundLeg(200)],
    }, 'reduced');
    const plan = planDuctRun(element, { settings, scene: [unit, element] })!;
    const reducer = plan.pieces.filter((piece) => piece.kind === 'transition').find((piece) => piece.diameterMm === MAIN_D)!;
    expect(reducer.endDiameterMm).toBe(200);
    expect(reducer.transition!.slopeMm).toBeGreaterThanOrEqual(155);
  });

  it('a wye splits a round main: 45° legs 3A/2 to round outlets, each branch turning back square', () => {
    const main = roundMain({ kind: 'split', style: 'wye' });
    const scene: HvacElement[] = [unit, main];
    const branches = ([1, -1] as const).map((side) => {
      const origin = splitOrigin(main, settings, { side, style: 'y', vcd: true }, roundLeg(200))!;
      expect(origin).toMatchObject({ kind: 'split', style: 'wye' });
      const point = (origin as { point: Point2D }).point;
      const direction = (origin as { direction: Point2D }).direction;
      const bend = { x: point.x + direction.x * 400, y: point.y + direction.y * 400 };
      const element = buildDuctRunDraftElement({ origin, points: [bend, { x: bend.x + Math.sign(direction.x) * 1500, y: bend.y }], legSizes: [roundLeg(200)] }, `w${side}`);
      scene.push(element);
      return { origin, element };
    });
    const parent = planDuctRun(main, { settings, scene })!;
    expect(codes(parent)).toEqual([]);
    const split = parent.pieces.find((piece) => piece.kind === 'split')!;
    expect(split.split!.style).toBe('wye');
    expect(split.split!.cappedSides).toEqual([]);
    const end = readDuctRunSpec(main)!.path.at(-1)!;
    const outlet = (branches[0]!.origin as { point: Point2D }).point;
    expect(Math.hypot(outlet.x - end.x, outlet.y - end.y)).toBeCloseTo(wyeLegLengthMm(MAIN_D), 6);
    for (const { element } of branches) expect(codes(planDuctRun(element, { settings, scene })!)).toEqual([]);
    expect(buildDuctBom([parent]).some((row) => row.description.startsWith('Wye fitting'))).toBe(true);
    // 3D: the wye's cones build.
    const group = buildHvacElementMesh(main, { allElements: scene, ductSettings: settings })!;
    expect(group.getObjectByName('duct-metal')).toBeTruthy();
  });

  it('a Y or bullhead on a round main is refused, and a wye on a rectangular run', () => {
    const wrongY = roundMain({ kind: 'split', style: 'y' });
    expect(codes(planDuctRun(wrongY, { settings, scene: [unit, wrongY] })!)).toContain('DU_SPLIT_SIZE');
    const rect = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 6000 }], legSizes: [{ widthMm: 600, heightMm: 300 }] }, 'rect');
    const rectSpec = readDuctRunSpec(rect)!;
    const wrongWye = { ...rect, properties: { ...rect.properties, ductRun: { ...rectSpec, end: { kind: 'split', style: 'wye' } } } };
    expect(codes(planDuctRun(wrongWye, { settings, scene: [unit, wrongWye] })!)).toContain('DU_SPLIT_SIZE');
  });
});

describe('fitting losses respond to flow (Idelchik form, practice)', () => {
  const pv = velocityPressurePa;
  it('a 90° branch at equal velocities loses 2A′ of the velocity pressure; a lateral less; a conical less than a 90° tap', () => {
    expect(takeoffBranchLossPa('spin-in', 4, 4)).toBeCloseTo(2 * 0.5 * pv(4), 6);
    expect(takeoffBranchLossPa('round-lateral', 4, 4)).toBeLessThan(takeoffBranchLossPa('round-tee', 4, 4));
    expect(takeoffBranchLossPa('round-conical', 4, 4)).toBeLessThan(takeoffBranchLossPa('round-tee', 4, 4));
    // A slower main costs the branch less; the straight-through loss vanishes when nothing leaves.
    expect(takeoffBranchLossPa('round-tee', 4, 3)).toBeLessThan(takeoffBranchLossPa('round-tee', 4, 5));
    expect(mainPassageLossPa(5, 5)).toBe(0);
    expect(mainPassageLossPa(3, 5)).toBeCloseTo(0.4 * 0.16 * pv(5), 6);
  });

  it('collar lengths by fitting', () => {
    expect(roundMainTapGeometry('round-conical', 200, settings)).toMatchObject({ openingMm: 251, collarLengthMm: 203, angleDeg: 90 });
    expect(roundMainTapGeometry('round-tee', 200, settings)).toMatchObject({ openingMm: 200, collarLengthMm: 102, angleDeg: 90 });
    expect(roundMainTapGeometry('round-lateral', 200, settings)).toMatchObject({ openingMm: 200, collarLengthMm: 151, angleDeg: 45 });
  });
});

