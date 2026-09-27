import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctBom } from './ductBom';
import { buildDuctRunDraftElement } from './ductDraft';
import { planDuctRun, planDuctRunSpec } from './ductFabricationPlanner';
import {
  DUCT_VANES,
  rectangularDamperLayout,
  resolveVaneType,
  roundDamperLayout,
  seamAllowanceMm,
  seamsPerSection,
  shoeLeadInMm,
  twoGaugesHeavier,
  vaneCountOnDiagonal,
  vaneSectionsFor,
} from './ductFittingRules';
import { resolveDuctSettings } from './ductSettings';
import { readDuctRunSpec, type DuctLeg } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const lip = { x: supply.lip.x, y: supply.lip.y };
const at = (offsets: Point2D[]) => {
  let cursor = lip;
  return offsets.map((offset) => (cursor = { x: cursor.x + offset.x, y: cursor.y + offset.y }));
};
const run = (points: Point2D[], legSizes?: DuctLeg[]) => buildDuctRunDraftElement({ port: supply, points, legSizes }, 'r');
const planOf = (element: HvacElement, overrides = settings) => planDuctRun(element, { settings: overrides, scene: [unit, element] })!;

describe('SMACNA Fig. 2-2 elbows', () => {
  it('defaults the radius elbow to R = 3W/2', () => {
    expect(settings.elbowCentrelineRatio).toBe(1.5);
    const plan = planOf(run(at([{ x: 0, y: -4000 }, { x: 4000, y: 0 }])));
    const elbow = plan.pieces.find((piece) => piece.kind === 'elbow')!.elbow!;
    expect(elbow.style).toBe('radius');
    expect(elbow.centrelineRadiusMm).toBeCloseTo(1.5 * 674, 6);
  });

  it('refuses R/W below 0.5 and warns below 1.0 (square throat up to 5 m/s only)', () => {
    const element = run(at([{ x: 0, y: -4000 }, { x: 4000, y: 0 }]));
    const spec = readDuctRunSpec(element)!;
    const tight = planDuctRunSpec('r', { ...spec, nodeOverrides: { 1: { centrelineRatio: 0.4 } } }, { settings, scene: [unit, element] });
    expect(tight.issues.find((issue) => issue.code === 'DU_ELBOW_RADIUS')?.severity).toBe('error');
    const short = planDuctRunSpec('r', { ...spec, nodeOverrides: { 1: { centrelineRatio: 0.75 } } }, { settings, scene: [unit, element] });
    expect(short.issues.find((issue) => issue.code === 'DU_ELBOW_RADIUS')?.severity).toBe('warning');
    expect(planOf(element).issues.some((issue) => issue.code === 'DU_ELBOW_RADIUS')).toBe(false);
  });
});

describe('SMACNA Fig. 2-3 / 2-4 turning vanes', () => {
  it('transcribes the vane schedule', () => {
    expect(DUCT_VANES['single-small']).toMatchObject({ radiusMm: 51, spacingMm: 38, thicknessMm: 0.7, maxUnsupportedMm: 914 });
    expect(DUCT_VANES['single-large']).toMatchObject({ radiusMm: 114, spacingMm: 83, thicknessMm: 0.85, maxUnsupportedMm: 914 });
    expect(DUCT_VANES['double-small']).toMatchObject({ spacingMm: 54, thicknessMm: 0.55, maxUnsupportedMm: 1219 });
    expect(DUCT_VANES['double-large']).toMatchObject({ spacingMm: 83, thicknessMm: 0.7, maxUnsupportedMm: 1829 });
  });

  it('auto picks the lightest vane that spans the height, then splits into sections', () => {
    expect(resolveVaneType('auto', 164).type).toBe('single-small');
    expect(resolveVaneType('auto', 1000).type).toBe('double-small');
    expect(resolveVaneType('auto', 1500).type).toBe('double-large');
    expect(vaneSectionsFor(2000, DUCT_VANES['double-large'])).toBe(2);
    expect(vaneSectionsFor(914, DUCT_VANES['single-small'])).toBe(1);
  });

  it('counts vanes along the diagonal runner', () => {
    // 600·√2 = 848.5 mm of runner at a 38 mm pitch → 23 gaps, 22 vanes.
    expect(vaneCountOnDiagonal(600, DUCT_VANES['single-small'])).toBe(22);
  });

  it('a tall square elbow flags the vane span and adds intermediate runners', () => {
    const element = run(at([{ x: 0, y: -4000 }, { x: 4000, y: 0 }]), [{ widthMm: 674, heightMm: 164 }, { widthMm: 674, heightMm: 164 }]);
    const spec = readDuctRunSpec(element)!;
    const tall = { ...spec, legs: [{ widthMm: 600, heightMm: 1000 }, { widthMm: 600, heightMm: 1000 }], nodeOverrides: { 1: { elbowStyle: 'square-vaned' as const, vaneType: 'single-small' as const } } };
    const plan = planDuctRunSpec('r', tall, { settings, scene: [unit] });
    const elbow = plan.pieces.find((piece) => piece.kind === 'elbow')!.elbow!;
    expect(elbow.vanes).toMatchObject({ lengthMm: 1000, sections: 2 });
    expect(plan.issues.find((issue) => issue.code === 'DU_VANE_SPAN')?.severity).toBe('info');
  });
});

describe('SMACNA Fig. 2-6 / 2-7 branch entries and transitions', () => {
  it('45° entry lead-in is W/4 with a 102 mm minimum', () => {
    expect(shoeLeadInMm(300)).toBe(102);
    expect(shoeLeadInMm(600)).toBe(150);
  });

  it('judges the plan width as concentric (included angle) and the height as eccentric (flat bottom)', () => {
    // A 164 → 400 high step over a short leg: the top rises steeply while the bottom stays flat.
    const element = run(at([{ x: 0, y: -3000 }, { x: 0, y: -300 }]), [{ widthMm: 674, heightMm: 164 }, { widthMm: 674, heightMm: 400 }]);
    const plan = planOf(element);
    expect(plan.issues.find((issue) => issue.code === 'DU_TRANSITION_ANGLE')?.message).toMatch(/Eccentric transition .* exceeds 30°/);
    // The designed 14° taper sits well inside both limits.
    const easy = planOf(run(at([{ x: 0, y: -3000 }, { x: 0, y: -3000 }]), [{ widthMm: 674, heightMm: 164 }, { widthMm: 500, heightMm: 164 }]));
    const transition = easy.pieces.find((piece) => piece.kind === 'transition')!.transition!;
    expect(2 * transition.angleWidthDeg).toBeLessThan(60);
    expect(easy.issues.some((issue) => issue.code === 'DU_TRANSITION_ANGLE')).toBe(false);
  });

  it('settings may be stricter than SMACNA but never looser', () => {
    const loose = resolveDuctSettings({ transitionMaxDivergingIncludedDeg: 90, transitionMaxConvergingIncludedDeg: 90, transitionMaxEccentricDeg: 60 });
    expect([loose.transitionMaxDivergingIncludedDeg, loose.transitionMaxConvergingIncludedDeg, loose.transitionMaxEccentricDeg]).toEqual([45, 60, 30]);
    expect(resolveDuctSettings({ transitionMaxEccentricDeg: 20 }).transitionMaxEccentricDeg).toBe(20);
  });
});

describe('SMACNA Fig. 2-12 / 2-13 volume dampers', () => {
  it('single blade up to 305 high: 0.85 blade to 457 wide, 1.31 with a continuous rod to 1219', () => {
    expect(rectangularDamperLayout(300, 150)).toMatchObject({ kind: 'single-blade', bladeThicknessMm: 0.85, shaftMm: 10, continuousRod: false });
    expect(rectangularDamperLayout(600, 250)).toMatchObject({ kind: 'single-blade', bladeThicknessMm: 1.31, shaftMm: 13, continuousRod: true });
  });

  it('opposed multi-blade above 305 high, 1219 mm per frame', () => {
    expect(rectangularDamperLayout(600, 400)).toMatchObject({ kind: 'opposed-multiblade', blades: 2, frames: 1, bladeThicknessMm: 1.31, frameChannelMm: 51 });
    expect(rectangularDamperLayout(1500, 400).frames).toBe(2);
    expect(rectangularDamperLayout(600, 700).bladeChordMm).toBeLessThanOrEqual(229);
  });

  it('round blade is two gauges over the duct and at least 0.70', () => {
    expect(twoGaugesHeavier(0.55)).toBe(0.85);
    expect(roundDamperLayout(200, 0.48, 250)).toMatchObject({ bladeThicknessMm: 0.7, continuousRod: false });
    expect(roundDamperLayout(400, 0.55, 500)).toMatchObject({ bladeThicknessMm: 0.85, continuousRod: true });
  });
});

describe('SMACNA Fig. 2-17 connector and rule provenance', () => {
  it('fabric 102 + 76 metal each side, 254 mm fabric maximum', () => {
    expect([settings.connectorFabricMm, settings.connectorMetalMm]).toEqual([102, 76]);
    expect(resolveDuctSettings({ connectorFabricMm: 400 }).connectorFabricMm).toBe(254);
    const plan = planOf(run(at([{ x: 0, y: -3000 }])));
    expect(plan.pieces[0]).toMatchObject({ kind: 'connector', lengthMm: 254 });
  });

  it('a plain run uses no unverified SMACNA value; practice values are listed as such', () => {
    const plan = planOf(run(at([{ x: 0, y: -3000 }, { x: 3000, y: 0 }])));
    expect(plan.unverifiedRules).toEqual([]);
    expect(plan.practiceRules.length).toBeGreaterThan(0);
  });

  it('flags a flat section as an aspect-ratio advisory (practice, info)', () => {
    const plan = planOf(run(at([{ x: 0, y: -3000 }]), [{ widthMm: 1000, heightMm: 200 }]));
    expect(plan.issues.find((issue) => issue.code === 'DU_ASPECT_RATIO')?.severity).toBe('info');
  });
});

describe('SMACNA Fig. 1-5 longitudinal seams', () => {
  it('allowance from the pockets: Pittsburgh 3 × 9.5, snaplock 2 × 12.7 (≤ 0.70) or 2 × 16', () => {
    expect(seamAllowanceMm('pittsburgh', 0.6)).toBe(29);
    expect(seamAllowanceMm('snaplock', 0.6)).toBe(25);
    expect(seamAllowanceMm('snaplock', 1.0)).toBe(32);
  });

  it('two L-shaped halves while half the girth fits the coil, four panels beyond', () => {
    expect(seamsPerSection(676, 166, 1250)).toBe(2);
    expect(seamsPerSection(1202, 402, 1250)).toBe(4);
  });

  it('schedules the seam length by type', () => {
    const plan = planOf(run(at([{ x: 0, y: -3000 }])));
    const straights = plan.pieces.filter((piece) => piece.kind === 'straight');
    expect(straights[0]!.seamLengthMm).toBeCloseTo(2 * straights[0]!.lengthMm, 6);
    const row = buildDuctBom([plan]).find((entry) => entry.description.startsWith('Longitudinal seam'))!;
    expect(row.description).toBe('Longitudinal seam, Pittsburgh lock (L-1)');
    const snap = planOf(run(at([{ x: 0, y: -3000 }])), resolveDuctSettings({ longitudinalSeam: 'snaplock' }));
    expect(buildDuctBom([snap]).some((entry) => entry.description === 'Longitudinal seam, button-punch snaplock (L-2)')).toBe(true);
  });
});
