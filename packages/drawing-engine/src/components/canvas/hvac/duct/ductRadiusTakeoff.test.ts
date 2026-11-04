/**
 * The radius take-off, from its shape to what follows it: the planner's windows, sheet and rules, the plan outline and
 * the 3D shell (the same shape), the hole in the main, the air, the clash boxes, the record and sizing.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import { buildHvacElementMesh } from '../three3d/buildHvacElementMesh';
import { ductPiecesOuterGeometry, radiusTakeoffShell } from '../three3d/ductMeshes';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctFabricationSchedule } from './ductBom';
import { tapOrigin } from './ductBranchTargets';
import { startCollarMm, tapAttachment } from './ductBranches';
import { buildDuctRunDraftElement } from './ductDraft';
import { getDuctRunPlan } from './ductFabricationPlanner';
import { ductRunElementWithSpec } from './ductFollow';
import { buildDuctPlanPresentation } from './ductPlanPresentation';
import { TAKEOFF_A_PRIME, radiusTakeoffAPrime, takeoffBranchLossPa } from './ductPressure';
import {
  RADIUS_TAKEOFF,
  radiusTakeoffCollarMm,
  radiusTakeoffOutline,
  radiusTakeoffPlanAreaMm2,
  radiusTakeoffRatio,
  radiusTakeoffSections,
  radiusTakeoffShape,
  radiusTakeoffSheetAreaM2,
} from './ductRadiusTakeoff';
import { ductSegmentOf } from './ductSegments';
import { resolveDuctSettings } from './ductSettings';
import { velocityPressurePa } from './ductSizing';
import { defaultSizingBasis, sizeDuctSystem } from './ductSystemSizing';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, withTapStyle, type DuctLeg, type DuctSide, type DuctTapStart } from './ductTypes';
import { ductBoxesOf } from './ductVolumes';

const settings = resolveDuctSettings({ showSupports: false, jointSystem: 'tdc' });
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: 1000, y: 2000 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
const SECTION: DuctLeg = { widthMm: 300, heightMm: 250 };
const MAIN: DuctLeg = { widthMm: 600, heightMm: 300 };

function mainRun(points: Point2D[] = [{ x: port.lip.x, y: port.lip.y - 8000 }], id = 'main'): HvacElement {
  return buildDuctRunDraftElement({ port, points, legSizes: points.map(() => MAIN) }, id);
}

function radiusBranch(main: HvacElement, options: { station?: number; side?: DuctSide; ratio?: number; section?: DuctLeg; lengthMm?: number; id?: string; legIndex?: number } = {}): HvacElement {
  const section = options.section ?? SECTION;
  const origin = tapOrigin(main, settings, { legIndex: options.legIndex ?? 0, stationMm: options.station ?? 4000, side: options.side ?? 1, style: 'radius', vcd: false }, section)!;
  if (origin.kind !== 'tap') throw new Error('Expected a take-off origin');
  const length = options.lengthMm ?? 1500;
  const run = buildDuctRunDraftElement({ origin, points: [{ x: origin.point.x + origin.direction.x * length, y: origin.point.y + origin.direction.y * length }], legSizes: [section] }, options.id ?? 'branch');
  const spec = readDuctRunSpec(run)!;
  return ductRunElementWithSpec(run, { ...spec, start: { ...(spec.start as DuctTapStart), ...(options.ratio !== undefined ? { radiusRatio: options.ratio } : {}) } });
}

/** Do two segments cross, ends apart? */
function crossing(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  const side = (p: Point2D, q: Point2D, r: Point2D) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return side(a, b, c) * side(a, b, d) < -1e-6 && side(c, d, a) * side(c, d, b) < -1e-6;
}

function polygonArea(points: ReadonlyArray<{ x: number; y: number }>): number {
  return Math.abs(points.reduce((total, point, index) => {
    const next = points[(index + 1) % points.length]!;
    return total + point.x * next.y - next.x * point.y;
  }, 0)) / 2;
}

const RATIOS = [0.25, 0.5, 0.75, 1, 1.25, 1.5];
const WIDTHS = [100, 300, 1000];

describe('the shape', () => {
  it('is an RE1 elbow on the wall at r/W 1.0: the throat tangent to the wall, the heel concentric, cut by the wall', () => {
    const shape = radiusTakeoffShape(300, 1);
    expect(shape.throatMm).toBe(300);
    expect(shape.heelMm).toBe(600);
    expect(shape.centre).toEqual({ a: 300, b: -450 });
    expect(shape.heelInMm).toBeCloseTo(150 - (Math.sqrt(600 ** 2 - 300 ** 2) - 450), 6);
    expect(shape.heelInMm / 300).toBeCloseTo(0.268, 3);
    // Centreline R = r + W/2 = 3W/2, SMACNA RE1.
    expect((shape.throatMm + 150) / 300).toBe(1.5);
  });

  it('defaults to r/W 1.0 and keeps a ratio within what is made', () => {
    expect(radiusTakeoffRatio()).toBe(1);
    expect(radiusTakeoffRatio(Number.NaN)).toBe(1);
    expect(radiusTakeoffRatio(0.1)).toBe(RADIUS_TAKEOFF.minRatio);
    expect(radiusTakeoffRatio(9)).toBe(RADIUS_TAKEOFF.maxRatio);
    expect(radiusTakeoffRatio(0.6)).toBe(0.6);
  });

  it.each(RATIOS)('runs its sections from the tangent point to the branch at r/W %s, skinned either side', (ratio) => {
    for (const width of WIDTHS) {
      for (const skin of [0, 1, 26]) {
        const shape = radiusTakeoffShape(width, ratio);
        const sections = radiusTakeoffSections(shape, skin);
        const first = sections[0]!;
        const last = sections[sections.length - 1]!;
        expect(first.outer.a).toBeCloseTo(0, 6);
        expect(first.inner.b).toBeCloseTo(shape.centre.b, 6);
        expect(last.inner.a).toBeCloseTo(shape.throatMm, 6);
        expect(last.inner.b).toBeCloseTo(-width / 2 - Math.min(skin, shape.throatMm), 6);
        expect(last.outer.b).toBeCloseTo(width / 2 + skin, 6);
        expect(sections.filter((section) => section.onHeel).length).toBeGreaterThan(1);
        for (const section of sections) {
          expect(section.outer.a).toBeGreaterThanOrEqual(-1e-6);
          expect(Math.hypot(section.inner.a - shape.centre.a, section.inner.b - shape.centre.b)).toBeCloseTo(Math.max(0, shape.throatMm - skin), 6);
          if (section.onHeel) expect(Math.hypot(section.outer.a - shape.centre.a, section.outer.b - shape.centre.b)).toBeCloseTo(shape.heelMm + skin, 6);
        }
      }
    }
  });

  it.each(RATIOS)('has a simple outline of the area the sheet is priced on at r/W %s', (ratio) => {
    for (const width of WIDTHS) {
      const shape = radiusTakeoffShape(width, ratio);
      const length = radiusTakeoffCollarMm(shape, 100);
      const outline = radiusTakeoffOutline(shape, length, 0, 240).map(({ a, b }) => ({ x: a, y: b }));
      for (let i = 0; i < outline.length; i += 1) {
        for (let j = i + 2; j < outline.length; j += 1) {
          if ((j + 1) % outline.length === i) continue;
          expect(crossing(outline[i]!, outline[(i + 1) % outline.length]!, outline[j]!, outline[(j + 1) % outline.length]!)).toBe(false);
        }
      }
      expect(polygonArea(outline) / radiusTakeoffPlanAreaMm2(shape, length)).toBeCloseTo(1, 3);
    }
  });

  it('prices both flat faces, both cheeks and the neck', () => {
    const shape = radiusTakeoffShape(300, 1);
    const sections = radiusTakeoffSections(shape, 0, 720);
    const path = (points: Array<{ a: number; b: number }>) => points.slice(1).reduce((total, point, index) => total + Math.hypot(point.a - points[index]!.a, point.b - points[index]!.b), 0);
    const cheeks = path(sections.map((section) => section.inner)) + path(sections.filter((section) => section.onHeel).map((section) => section.outer)) + 2 * 50;
    expect(radiusTakeoffSheetAreaM2(shape, 350, 250)).toBeCloseTo((2 * radiusTakeoffPlanAreaMm2(shape, 350) + 250 * cheeks) / 1e6, 4);
  });
});

describe('on a main', () => {
  it('keeps its sweep clear on the main: its collar past the throat, its hole short of the far cheek', () => {
    const main = mainRun();
    const tap = tapAttachment(readDuctRunSpec(main)!, { legIndex: 0, stationMm: 4000, side: 1, style: 'radius' }, SECTION, 1, settings)!;
    expect(tap.leadInMm).toBe(300);
    expect(tap.collarLengthMm).toBe(350);
    expect(tap.openingFromMm).toBe(4000 - 150 - 300);
    expect(tap.openingToMm).toBe(4000 + 150);
    expect(tap.heelInMm).toBeCloseTo(radiusTakeoffShape(300, 1).heelInMm, 6);
    const tight = tapAttachment(readDuctRunSpec(main)!, { legIndex: 0, stationMm: 4000, side: 1, style: 'radius', radiusRatio: 0.25 }, { widthMm: 100, heightMm: 100 }, 1, settings)!;
    expect(tight.collarLengthMm).toBe(settings.tapCollarMm);
  });

  it('asks no more of the main than a shoe at its tightest', () => {
    for (const width of WIDTHS) {
      const shoe = Math.max(102, width / 4);
      expect(radiusTakeoffShape(width, RADIUS_TAKEOFF.minRatio).throatMm).toBeLessThanOrEqual(shoe);
    }
  });

  it('plans clean on a plain main, on either side and at every ratio: the piece, its sheet, its BOM line, the joint on the wall', () => {
    const main = mainRun();
    for (const side of [1, -1] as const) {
      for (const ratio of RATIOS) {
        const branch = radiusBranch(main, { side, ratio });
        const scene = [unit, main, branch];
        const plan = getDuctRunPlan(branch, scene, settings)!;
        const parent = getDuctRunPlan(main, scene, settings)!;
        expect(plan.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
        expect(parent.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
        const shape = radiusTakeoffShape(300, ratio);
        const piece = plan.pieces.find((candidate) => candidate.kind === 'takeoff')!;
        expect(piece.lengthMm).toBeCloseTo(radiusTakeoffCollarMm(shape, settings.tapCollarMm), 6);
        expect(piece.takeoff).toMatchObject({ style: 'radius', radiusRatio: ratio });
        expect(piece.sheetAreaM2).toBeCloseTo(radiusTakeoffSheetAreaM2(shape, piece.lengthMm, 250), 6);
        expect(piece.massKg).toBeGreaterThan(0);
        expect(buildDuctFabricationSchedule([plan]).some((row) => row.kind.includes(`Radius take-off, r/W ${ratio}`))).toBe(true);
        expect(plan.joints.find((joint) => joint.kind === 'tap-connection')?.hardware).toBeTruthy();
      }
    }
  });

  it('warns under r/W 0.5, the tight throat of an elbow', () => {
    const main = mainRun();
    const tight = getDuctRunPlan(radiusBranch(main, { ratio: 0.4 }), [unit, main], settings)!;
    expect(tight.issues.some((issue) => issue.code === 'DU_ELBOW_RADIUS' && issue.severity === 'warning' && /r\/W 0\.4/.test(issue.message))).toBe(true);
    const fine = getDuctRunPlan(radiusBranch(main, { ratio: 0.5 }), [unit, main], settings)!;
    expect(fine.issues.some((issue) => issue.code === 'DU_ELBOW_RADIUS')).toBe(false);
  });

  it('clashes when its sweep reaches a fitting on the main, where a tighter one does not', () => {
    const main = mainRun([{ x: port.lip.x, y: port.lip.y - 3000 }, { x: port.lip.x + 4000, y: port.lip.y - 3000 }]);
    const near = (ratio: number) => {
      const branch = radiusBranch(main, { legIndex: 1, station: 1400, ratio, side: 1 });
      return getDuctRunPlan(main, [unit, main, branch], settings)!.issues.filter((issue) => issue.code === 'DU_TAP_CLASH');
    };
    expect(near(1.5).length).toBeGreaterThan(0);
    expect(near(1.5)[0]!.message).toMatch(/elbow, transition or connector/);
    expect(near(0.25)).toEqual([]);
  });

  it('clashes with the take-off upstream of it when its sweep reaches it', () => {
    const main = mainRun();
    const other = radiusBranch(main, { station: 4000, ratio: 0.5, id: 'other', side: -1 });
    const overlap = (station: number, ratio: number) => getDuctRunPlan(main, [unit, main, other, radiusBranch(main, { station, ratio })], settings)!
      .issues.filter((issue) => issue.code === 'DU_TAP_CLASH');
    expect(overlap(4700, 1.5)[0]?.message).toMatch(/Two take-offs overlap/);
    expect(overlap(4700, 0.25)).toEqual([]);
  });

  it('says so when its branch is too short for the sweep', () => {
    const main = mainRun();
    const branch = radiusBranch(main, { ratio: 1, lengthMm: 300 });
    expect(getDuctRunPlan(branch, [unit, main, branch], settings)!.issues.some((issue) => issue.code === 'DU_LEG_TOO_SHORT' && issue.severity === 'error')).toBe(true);
  });

  it('is refused on a round branch and on a round main, as a shoe is', () => {
    const main = mainRun();
    const round = { widthMm: 300, heightMm: 300, diameterMm: 300 };
    const branch = radiusBranch(main, { section: round });
    expect(getDuctRunPlan(branch, [unit, main, branch], settings)!.issues.some((issue) => issue.code === 'DU_TAP_CLASH')).toBe(true);
  });
});

describe('in the views', () => {
  const heading: Array<[string, Point2D[]]> = [
    ['up the page', [{ x: port.lip.x, y: port.lip.y - 8000 }]],
    ['along a turned leg', [{ x: port.lip.x, y: port.lip.y - 1500 }, { x: port.lip.x + 8000, y: port.lip.y - 1500 }]],
  ];

  it.each(heading)('draws the same shape in plan and in 3D, %s, on either side', (_name, points) => {
    const main = mainRun(points);
    const legIndex = points.length - 1;
    for (const side of [1, -1] as const) {
      const branch = radiusBranch(main, { side, legIndex, station: legIndex ? 4000 : 4000 });
      const scene = [unit, main, branch];
      const plan = getDuctRunPlan(branch, scene, settings)!;
      const piece = plan.pieces.find((candidate) => candidate.kind === 'takeoff')!;
      const outline = buildDuctPlanPresentation(plan).piecePolygons.find((polygon) => polygon.mark === piece.mark)!.polygon;
      // On the air side of the wall: the sweep toward the main's start.
      const tap = plan.tap!;
      const toward = outline.map((point) => (point.x - tap.wallPoint.x) * tap.parentDirection.x + (point.y - tap.wallPoint.y) * tap.parentDirection.y);
      expect(Math.min(...toward)).toBeCloseTo(-450, 0);
      expect(Math.max(...toward)).toBeCloseTo(151, 0);
      const out = outline.map((point) => (point.x - tap.wallPoint.x) * tap.direction.x + (point.y - tap.wallPoint.y) * tap.direction.y);
      expect(Math.min(...out)).toBeCloseTo(0, 3);
      expect(Math.max(...out)).toBeCloseTo(350, 3);
      // Every 3D point on the plan's outline, and the top face's area the outline's.
      const shell = radiusTakeoffShell(piece, piece.sheetThicknessMm ?? 1);
      const position = shell.getAttribute('position');
      const near = (point: Point2D) => {
        let best = Number.POSITIVE_INFINITY;
        for (let index = 0; index < position.count; index += 1) best = Math.min(best, Math.hypot(position.getX(index) - point.x, position.getY(index) - point.y));
        return best;
      };
      for (const point of outline.slice(1)) expect(near(point)).toBeLessThan(1);
      const box = new THREE.Box3().setFromBufferAttribute(position as THREE.BufferAttribute);
      const skin = piece.sheetThicknessMm ?? 1;
      expect(box.min.z).toBeCloseTo(piece.centreZ - 125 - skin, 3);
      expect(box.max.z).toBeCloseTo(piece.centreZ + 125 + skin, 3);
      shell.dispose();
    }
  });

  it('winds every face of its shell to face its normals, and leaves its foot open', () => {
    const main = mainRun();
    const branch = radiusBranch(main, { side: -1 });
    const piece = getDuctRunPlan(branch, [unit, main, branch], settings)!.pieces.find((candidate) => candidate.kind === 'takeoff')!;
    const shell = radiusTakeoffShell(piece, 1);
    const position = shell.getAttribute('position');
    const normal = shell.getAttribute('normal');
    const at = (attribute: typeof position, index: number) => new THREE.Vector3().fromBufferAttribute(attribute as THREE.BufferAttribute, index);
    for (let index = 0; index < position.count; index += 3) {
      const a = at(position, index);
      const facing = new THREE.Vector3().crossVectors(at(position, index + 1).sub(a), at(position, index + 2).sub(a));
      if (facing.length() < 1e-6) continue;
      expect(facing.dot(at(normal, index))).toBeGreaterThan(0);
    }
    shell.dispose();
  });

  it('cuts the true hole in the main: the throat toe to the heel foot, the sheet kept beyond them', () => {
    const main = mainRun();
    const branch = radiusBranch(main);
    const scene = [unit, main, branch];
    const group = buildHvacElementMesh(main, { allElements: scene, ductSettings: settings })!;
    group.updateMatrixWorld(true);
    const metal = group.getObjectByName('duct-metal')!;
    const tap = getDuctRunPlan(branch, scene, settings)!.tap!;
    const d = new THREE.Vector3(tap.direction.x, tap.direction.y, 0);
    const along = new THREE.Vector3(tap.parentDirection.x, tap.parentDirection.y, 0);
    const hits = (offset: number) => {
      const origin = new THREE.Vector3(tap.wallPoint.x, tap.wallPoint.y, tap.bottomZ + 125).addScaledVector(along, offset).addScaledVector(d, 40);
      return new THREE.Raycaster(origin, d.clone().negate(), 0, 80).intersectObject(metal).length;
    };
    const heelFoot = 150 - radiusTakeoffShape(300, 1).heelInMm;
    expect(hits(0)).toBe(0);
    expect(hits(-440)).toBe(0);
    expect(hits(heelFoot - 10)).toBe(0);
    expect(hits(heelFoot + 10)).toBeGreaterThan(0);
    expect(hits(-460)).toBeGreaterThan(0);
  });

  it('carries its insulation and its 3D outline over the whole sweep', () => {
    const main = mainRun();
    const branch = radiusBranch(main);
    const scene = [unit, main, branch];
    const plan = getDuctRunPlan(branch, scene, settings)!;
    const insulated = { ...plan, insulationMm: 25 };
    const segment = ductSegmentOf(plan, 'start:takeoff')!;
    const geometry = ductPiecesOuterGeometry(insulated, segment.pieceIndices)!;
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const tap = plan.tap!;
    const reach = [box.min, box.max].map((corner) => (corner.x - tap.wallPoint.x) * tap.parentDirection.x + (corner.y - tap.wallPoint.y) * tap.parentDirection.y);
    expect(Math.min(...reach)).toBeCloseTo(-450, 0);
    expect(Math.max(...reach)).toBeCloseTo(150 + 26, 0);
    expect(buildDuctPlanPresentation(insulated).insulationOutlines.length).toBeGreaterThan(0);
    geometry.dispose();
  });
});

describe('the air', () => {
  const C = (style: 'radius' | 'shoe-45' | 'straight', ratio: number, radiusRatio?: number) => takeoffBranchLossPa(style, 4 * ratio, 4, radiusRatio) / velocityPressurePa(4);

  it('loses less than a shoe, and a shoe less than a straight tap, at every velocity ratio', () => {
    for (let ratio = 0.3; ratio <= 2; ratio += 0.1) {
      expect(C('radius', ratio)).toBeLessThan(C('shoe-45', ratio));
      expect(C('shoe-45', ratio)).toBeLessThan(C('straight', ratio));
    }
  });

  it('reads ASHRAE 5-22 at r/W 1.0 (Ab/As = Ab/Ac = 0.5)', () => {
    const table: Array<[number, number]> = [[0.3, 0.4], [0.4, 0.4], [0.5, 0.48], [0.6, 0.6], [0.7, 0.78], [0.8, 1.1]];
    for (const [flow, published] of table) expect(Math.abs(C('radius', flow / 0.5) - published)).toBeLessThanOrEqual(0.22);
    expect(C('radius', 1)).toBeCloseTo(0.5, 6);
  });

  it('loses more as the radius tightens, up to a shoe at its tightest', () => {
    expect(radiusTakeoffAPrime()).toBe(TAKEOFF_A_PRIME.radius);
    expect(radiusTakeoffAPrime(RADIUS_TAKEOFF.minRatio)).toBeCloseTo(TAKEOFF_A_PRIME['shoe-45'], 6);
    const values = RATIOS.map((ratio) => radiusTakeoffAPrime(ratio));
    values.slice(1).forEach((value, index) => expect(value).toBeLessThan(values[index]!));
  });
});

describe('around it', () => {
  it('blocks what crosses its swept wing, not the corner past its heel', () => {
    const main = mainRun();
    const branch = radiusBranch(main);
    const plan = getDuctRunPlan(branch, [unit, main, branch], settings)!;
    const tap = plan.tap!;
    const boxes = ductBoxesOf(plan);
    const inside = (a: number, b: number) => {
      const x = tap.wallPoint.x + tap.direction.x * a + tap.parentDirection.x * b;
      const y = tap.wallPoint.y + tap.direction.y * a + tap.parentDirection.y * b;
      const z = tap.bottomZ + 125;
      return boxes.some((box) => {
        const offset = { x: x - box.centre.x, y: y - box.centre.y, z: z - box.centre.z };
        const dot = (axis: { x: number; y: number; z: number }) => offset.x * axis.x + offset.y * axis.y + offset.z * axis.z;
        return Math.abs(dot(box.axisT)) <= box.halfLength + 1 && Math.abs(dot(box.axisN)) <= box.halfWidth + 1 && Math.abs(dot(box.axisU)) <= box.halfHeight + 1;
      });
    };
    expect(inside(40, -300)).toBe(true);
    expect(inside(150, -200)).toBe(true);
    expect(inside(330, 0)).toBe(true);
    expect(inside(250, -400)).toBe(false);
  });

  it('is kept in the record; an old record reads as the default, and another style drops the ratio', () => {
    const main = mainRun();
    const start = readDuctRunSpec(radiusBranch(main, { ratio: 0.75 }))!.start as DuctTapStart;
    expect(start).toMatchObject({ style: 'radius', radiusRatio: 0.75 });
    expect(radiusTakeoffRatio((readDuctRunSpec(radiusBranch(main))!.start as DuctTapStart).radiusRatio)).toBe(1);
    expect(withTapStyle(start, 'shoe-45').radiusRatio).toBeUndefined();
    expect(withTapStyle(start, 'radius').radiusRatio).toBe(0.75);
    expect(withTapStyle(withTapStyle(start, 'shoe-45'), 'radius', 1.25).radiusRatio).toBe(1.25);
  });

  it('reserves its real collar on the first leg', () => {
    const main = mainRun();
    const spec = readDuctRunSpec(radiusBranch(main))!;
    expect(startCollarMm(spec.start, spec.legs[0], settings)).toBe(350);
    expect(startCollarMm({ ...(spec.start as DuctTapStart), style: 'shoe-45' }, spec.legs[0], settings)).toBe(settings.tapCollarMm);
  });

  it('stays through sizing, its radius following the width', () => {
    const terminalSpec = { ...typicalTerminalSpec('square-4way', 200), designAirflowM3h: 500 };
    const envelope = terminalEnvelope(terminalSpec);
    const main = mainRun();
    const origin = tapOrigin(main, settings, { legIndex: 0, stationMm: 4000, side: 1, style: 'radius', vcd: true }, SECTION)!;
    if (origin.kind !== 'tap') throw new Error('Expected a take-off origin');
    const centre = { x: origin.point.x + origin.direction.x * 2500, y: origin.point.y + origin.direction.y * 2500 };
    const terminal: HvacElement = {
      id: 'd', type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation: 0,
      width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling', label: 'D', supplyZoneRatio: 0.5, properties: { terminal: terminalSpec },
    };
    const lip = terminalSpigotPort(terminal)!;
    const run = buildDuctRunDraftElement({
      origin, points: [{ x: origin.point.x + origin.direction.x * 1200, y: origin.point.y + origin.direction.y * 1200 }, { x: lip.lip.x, y: lip.lip.y, z: lip.lip.z - lip.heightMm / 2 }],
      legSizes: [SECTION, { widthMm: 200, heightMm: 200, diameterMm: 200 }], end: { kind: 'terminal', terminalId: terminal.id, portId: lip.portId, flex: true },
    }, 'branch');
    const branch = ductRunElementWithSpec(run, { ...readDuctRunSpec(run)!, start: { ...(readDuctRunSpec(run)!.start as DuctTapStart), radiusRatio: 0.75 } });
    const scene = [unit, terminal, main, branch];
    const sized = sizeDuctSystem(scene, 'main', { basis: { ...defaultSizingBasis(settings, 'supply', null), frictionPaPerM: 0.8, airflowM3h: 500 } }, settings);
    const after = readDuctRunSpec(sized.runs.find((element) => element.id === 'branch') ?? branch)!;
    expect(after.start).toMatchObject({ kind: 'tap', style: 'radius', radiusRatio: 0.75 });
    const replaced = new Map(sized.runs.map((element) => [element.id, element]));
    const plan = getDuctRunPlan(replaced.get('branch') ?? branch, scene.map((element) => replaced.get(element.id) ?? element), settings)!;
    const piece = plan.pieces.find((candidate) => candidate.kind === 'takeoff')!;
    expect(piece.takeoff!.leadInMm).toBeCloseTo(0.75 * piece.widthMm, 6);
  });
});
