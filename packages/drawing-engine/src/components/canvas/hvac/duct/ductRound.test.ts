import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import { buildHvacElementMesh } from '../three3d/buildHvacElementMesh';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctBom } from './ductBom';
import { findBranchTarget, tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement } from './ductDraft';
import { planDuctRun } from './ductFabricationPlanner';
import { resolveSectionConstruction } from './ductGauge';
import { goredElbowPieces, roundJointScrewsPerEnd, roundMinimumThickness } from './ductRoundRules';
import { resolveDuctSettings } from './ductSettings';
import { roundLeg, type DuctTapStyle } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const main = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 6000 }] }, 'main');

function roundBranch(style: DuctTapStyle, diameter: number, offsets: Point2D[]) {
  const origin = tapOrigin(main, settings, { legIndex: 0, stationMm: 3000, side: 1, style, vcd: true }, roundLeg(diameter))!;
  let cursor = (origin as { point: Point2D }).point;
  const points = offsets.map((offset) => (cursor = { x: cursor.x + offset.x, y: cursor.y + offset.y }));
  const element = buildDuctRunDraftElement({ origin, points, legSizes: [roundLeg(diameter)] }, 'round');
  return { element, plan: planDuctRun(element, { settings, scene: [unit, main, element] })! };
}

describe('SMACNA Tables 3-2AM / 3-2BM round gauge (±500 Pa)', () => {
  it('supply (positive) and return (negative) minimums by diameter and seam', () => {
    expect(roundMinimumThickness(150, 'spiral', false)?.minimumMm).toBe(0.48);
    expect(roundMinimumThickness(250, 'longitudinal', false)?.minimumMm).toBe(0.55);
    expect(roundMinimumThickness(400, 'spiral', false)?.minimumMm).toBe(0.55);
    expect(roundMinimumThickness(900, 'longitudinal', false)?.minimumMm).toBe(0.85);
    expect(roundMinimumThickness(460, 'spiral', true)?.minimumMm).toBe(0.7);
    expect(roundMinimumThickness(300, 'longitudinal', true)?.minimumMm).toBe(0.55);
    expect(roundMinimumThickness(1200, 'longitudinal', true)?.reinforcement).toEqual({ angle: 'A', spacingM: 1.8 });
    expect(roundMinimumThickness(1830, 'longitudinal', true)).toBeNull();
  });

  it('rounds up to the stock sheet and joins with an RT-1 sleeve (spiral)', () => {
    const construction = resolveSectionConstruction({ widthMm: 250, heightMm: 250, diameterMm: 250, service: 'supply', construction: 'gi-bare', settings });
    expect(construction).toMatchObject({ status: 'ok', table: '3-2AM', smacnaMinThicknessMm: 0.48, sheetThicknessMm: 0.5, joint: { system: 'round-slip', type: 'RT-1' } });
  });

  it('refuses above 500 Pa like the rectangular tables', () => {
    const construction = resolveSectionConstruction({ widthMm: 250, heightMm: 250, diameterMm: 250, service: 'supply', construction: 'gi-bare', settings, pressureClassPa: 750 });
    expect(construction.status).toBe('unsupported-pressure');
  });
});

describe('Table 3-1 gored elbows and Fig. 3-2 joints', () => {
  it('pieces by band and angle', () => {
    expect(goredElbowPieces('medium', 90)).toBe(4);
    expect(goredElbowPieces('high', 90)).toBe(5);
    expect(goredElbowPieces('low', 45)).toBe(2);
  });

  it('screws at ≤ 381 mm round the circumference, three minimum', () => {
    expect(roundJointScrewsPerEnd(150)).toBe(3);
    expect(roundJointScrewsPerEnd(400)).toBe(Math.ceil((Math.PI * 400) / 381));
  });
});

describe('round branch off a rectangular run', () => {
  it('spin-in collar, round damper, spiral sections, a gored elbow and a cap', () => {
    const { plan } = roundBranch('spin-in', 150, [{ x: 4000, y: 0 }, { x: 0, y: -2000 }]);
    expect(plan.status).toBe('ok');
    const kinds = plan.pieces.map((piece) => piece.kind);
    expect(kinds.slice(0, 3)).toEqual(['takeoff', 'damper', 'straight']);
    const elbow = plan.pieces.find((piece) => piece.kind === 'elbow')!;
    // 5.1–7.6 m/s band: R/D 1.0 and 4 pieces (Table 3-1).
    expect(elbow.elbow).toMatchObject({ style: 'gored', gores: 4, centrelineRadiusMm: 150 });
    expect(plan.pieces.at(-1)!.kind).toBe('end-cap');
    // Round damper: 150 mm, 0.48 duct → blade two gauges heavier (0.70), not continuous below 500 Pa… the supply is 500 Pa.
    expect(plan.pieces[1]!.damper).toMatchObject({ kind: 'round' });
    // Straights up to the 3 m spiral length.
    expect(Math.max(...plan.pieces.filter((piece) => piece.kind === 'straight').map((piece) => piece.lengthMm))).toBeLessThanOrEqual(3000);
    const hardware = plan.joints.find((joint) => joint.hardware?.system === 'round-slip')!.hardware!;
    expect(hardware).toMatchObject({ sleeves: 1, ductFasteners: { count: 2 * 3 } });
    expect(plan.joints[0]!.hardware?.system).toBe('round-takeoff');
  });

  it('a conical collar opens a wider window in the parent (D1 ≥ D2)', () => {
    const { element, plan } = roundBranch('conical', 150, [{ x: 2000, y: 0 }]);
    expect(plan.pieces[0]!.takeoff).toMatchObject({ style: 'conical', openingMm: 200 });
    const parent = planDuctRun(main, { settings, scene: [unit, main, element] })!;
    // Window 3000 ± 100 (+ 50 margin): no parent joint inside it.
    expect(parent.joints.filter((joint) => joint.stationMm > 2850.5 && joint.stationMm < 3149.5)).toEqual([]);
  });

  it('a branch wider than the parent is tall is flagged', () => {
    const { plan } = roundBranch('spin-in', 250, [{ x: 2000, y: 0 }]);
    expect(plan.issues.some((issue) => issue.code === 'DU_TAP_TOO_BIG')).toBe(true);
  });

  it('round runs offer no take-off targets (rectangular trunks only)', () => {
    const { element } = roundBranch('spin-in', 150, [{ x: 4000, y: 0 }]);
    const along = { x: (element.position.x + element.width / 2), y: supply.lip.y - 3000 };
    const target = findBranchTarget(along, [unit, main, element], settings, 60);
    expect(target?.parent.id ?? null).not.toBe('round');
  });

  it('schedules spiral duct, the gored elbow, the collar, sleeves and sealant', () => {
    const { plan } = roundBranch('spin-in', 150, [{ x: 4000, y: 0 }, { x: 0, y: -2000 }]);
    const rows = buildDuctBom([plan]).map((row) => row.description);
    expect(rows.some((row) => row.startsWith('Spiral round duct'))).toBe(true);
    expect(rows.some((row) => row.startsWith('90° gored elbow, 4 pieces'))).toBe(true);
    expect(rows).toContain('Spin-in collar with bead (SMACNA Fig. 2-6)');
    expect(rows).toContain('RT-1 beaded sleeve coupling');
    expect(rows).toContain('Duct sealant (round joints and collars)');
  });

  it('builds round 3D: a cylinder of the branch diameter', () => {
    const { element } = roundBranch('spin-in', 150, [{ x: 4000, y: 0 }]);
    const group = buildHvacElementMesh(element, { allElements: [unit, main, element], ductSettings: settings })!;
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group.getObjectByName('duct-metal')!);
    expect(box.max.z - box.min.z).toBeCloseTo(150 + 2 * 0.5, 1);
  });
});
