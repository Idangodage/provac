import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctBom } from './ductBom';
import { splitOrigin, tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement, type DuctDraftOrigin } from './ductDraft';
import { layoutSections, planDuctRun, type DuctFabricationPlan } from './ductFabricationPlanner';
import { expandDuctDeletion } from './ductNetwork';
import { buildDuctPlanPresentation } from './ductPlanPresentation';
import { resolveDuctSettings } from './ductSettings';
import { buildDuctRunElement, readDuctRunSpec, type DuctLeg } from './ductTypes';

const settings = resolveDuctSettings({});

const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const ret = resolveUnitAirPorts(unit).find((port) => port.kind === 'return')!;
const lip = { x: supply.lip.x, y: supply.lip.y };

function at(offsets: Point2D[], from: Point2D = lip): Point2D[] {
  let cursor = from;
  return offsets.map((offset) => (cursor = { x: cursor.x + offset.x, y: cursor.y + offset.y }));
}

function run(id: string, points: Point2D[], legSizes?: DuctLeg[], origin?: DuctDraftOrigin, end: 'end-cap' | 'open' = 'end-cap'): HvacElement {
  return buildDuctRunDraftElement({ origin: origin ?? { kind: 'port', port: supply }, points, legSizes, end }, id);
}

function planOf(element: HvacElement, scene: HvacElement[], overrideSettings = settings): DuctFabricationPlan {
  return planDuctRun(element, { settings: overrideSettings, scene })!;
}

function withEnd(element: HvacElement, end: 'split-y' | 'split-bullhead'): HvacElement {
  const spec = readDuctRunSpec(element)!;
  return { ...element, properties: buildDuctRunElement({ ...spec, end: { kind: 'split', style: end === 'split-y' ? 'y' : 'bullhead' } }).properties! };
}

const kinds = (plan: DuctFabricationPlan) => plan.pieces.map((piece) => piece.kind);

describe('transitions', () => {
  it('fabricates a flat-bottom reducer where the size changes on a straight run', () => {
    const element = run('r', at([{ x: 0, y: -3000 }, { x: 0, y: -3000 }]), [{ widthMm: 674, heightMm: 164 }, { widthMm: 500, heightMm: 164 }]);
    const plan = planOf(element, [unit, element]);
    const transition = plan.pieces.find((piece) => piece.kind === 'transition')!;
    // Half-width change 87 mm at 14° → slope ceil(348.9 / 10) × 10 = 350, plus two 50 mm necks.
    expect(transition.transition!.slopeMm).toBe(350);
    expect(transition.lengthMm).toBe(450);
    expect(`${transition.widthMm}×${transition.heightMm} → ${transition.endWidthMm}×${transition.endHeightMm}`).toBe('674×164 → 500×164');
    expect(transition.stationStartMm).toBeCloseTo(3000, 6);
    expect(transition.transition!.widthSense).toBe('contracting');
    expect(plan.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    // Flat bottom: every piece sits on the same clear bottom.
    expect(new Set(plan.pieces.map((piece) => piece.bottomZ)).size).toBe(1);
    const consumed = plan.pieces.reduce((total, piece) => total + (piece.stationEndMm - piece.stationStartMm), 0);
    expect(consumed).toBeCloseTo(plan.polylineLengthMm, 6);
  });

  it('puts the reducer right after an elbow when the run turns', () => {
    const element = run('r', at([{ x: 0, y: -3000 }, { x: 3000, y: 0 }]), [{ widthMm: 674, heightMm: 164 }, { widthMm: 500, heightMm: 164 }]);
    const order = kinds(planOf(element, [unit, element])).filter((kind) => kind === 'elbow' || kind === 'transition');
    expect(order).toEqual(['elbow', 'transition']);
  });

  it('reduces from the collar right after the connector (no mouth mismatch left)', () => {
    const element = run('r', at([{ x: 0, y: -3000 }]), [{ widthMm: 500, heightMm: 150 }]);
    const plan = planOf(element, [unit, element]);
    expect(kinds(plan).slice(0, 2)).toEqual(['connector', 'transition']);
    const [connector, transition] = plan.pieces;
    expect(connector!.widthMm).toBe(674);
    expect(transition!.endWidthMm).toBe(500);
    expect(transition!.endHeightMm).toBe(150);
    // The connector stays centred on the collar; the reduced duct keeps the collar's bottom.
    expect(connector!.centreZ).toBeCloseTo(supply.lip.z, 9);
    expect(plan.pieces.at(-2)!.centreZ).toBeCloseTo(supply.lip.z - 164 / 2 + 150 / 2, 9);
  });

  it('refuses a transition squeezed past the SMACNA Fig. 2-7 limit', () => {
    const element = run('r', at([{ x: 0, y: -3000 }, { x: 0, y: -400 }]), [{ widthMm: 674, heightMm: 164 }, { widthMm: 250, heightMm: 164 }]);
    const plan = planOf(element, [unit, element]);
    const issue = plan.issues.find((entry) => entry.code === 'DU_TRANSITION_ANGLE');
    expect(issue?.severity).toBe('error');
    // 674 → 250 over a 400 mm leg: the plan width converges at ~70° included, over the 60° concentric limit.
    expect(issue?.message).toMatch(/Converging transition at \d+° included exceeds 60°/);
  });

  it('judges expanding / contracting in the flow direction (return flows toward the unit)', () => {
    const element = buildDuctRunDraftElement({
      origin: { kind: 'port', port: ret }, points: at([{ x: 0, y: 3000 }, { x: 0, y: 3000 }], { x: ret.lip.x, y: ret.lip.y }),
      legSizes: [{ widthMm: 654, heightMm: 194 }, { widthMm: 800, heightMm: 194 }],
    }, 'back');
    const transition = planOf(element, [unit, element]).pieces.find((piece) => piece.kind === 'transition')!;
    // Wider along the path, but return air flows the other way: contracting.
    expect(transition.transition!.widthSense).toBe('contracting');
  });
});

describe('side take-offs', () => {
  const main = run('main', at([{ x: 0, y: -6000 }]));
  const origin = tapOrigin(main, settings, { legIndex: 0, stationMm: 3000, side: 1, style: 'shoe-45', vcd: true }, { widthMm: 300, heightMm: 150 })!;
  const branch = run('branch', at([{ x: origin.kind === 'tap' ? (origin.direction.x * 2000) : 0, y: origin.kind === 'tap' ? origin.direction.y * 2000 : 0 }], (origin as { point: Point2D }).point),
    [{ widthMm: 300, heightMm: 150 }], origin);
  const scene = [unit, main, branch];

  it('starts on the parent wall, square to it, level with its bottom', () => {
    const spec = readDuctRunSpec(branch)!;
    const parent = readDuctRunSpec(main)!;
    expect(spec.start).toMatchObject({ kind: 'tap', parentRunId: 'main', legIndex: 0, stationMm: 3000, side: 1 });
    expect(spec.path[0]!.z).toBe(parent.path[0]!.z);
    // Wall point: 3000 mm along the leg, half the parent width (+ sheet) out to the side.
    const along = { x: lip.x, y: lip.y - 3000 };
    expect(Math.hypot(spec.path[0]!.x - along.x, spec.path[0]!.y - along.y)).toBeCloseTo(674 / 2 + 0.6, 6);
  });

  it('lays shoe collar, damper, then sections; fastened to the parent round the opening', () => {
    const plan = planOf(branch, scene);
    expect(kinds(plan).slice(0, 3)).toEqual(['takeoff', 'damper', 'straight']);
    const shoe = plan.pieces[0]!;
    // Lead-in max(300 / 4, 102) = 102 (SMACNA Fig. 2-6); collar max(100, 102 + 50) = 152.
    expect(shoe.takeoff).toMatchObject({ style: 'shoe-45', leadInMm: 102 });
    expect(shoe.lengthMm).toBe(152);
    expect(plan.pieces[1]!.lengthMm).toBe(settings.vcdLengthMm);
    expect(plan.joints[0]).toMatchObject({ kind: 'tap-connection' });
    expect(plan.joints[0]!.hardware?.system).toBe('takeoff');
    expect(plan.status).toBe('ok');
  });

  it('moves parent joints out of the take-off window', () => {
    // Untouched, the 1200 grid after the 254 connector puts a joint at 1454.
    expect(planOf(main, [unit, main]).joints.some((joint) => Math.abs(joint.stationMm - 1454) < 0.5)).toBe(true);
    const near = tapOrigin(main, settings, { legIndex: 0, stationMm: 1500, side: -1, style: 'shoe-45', vcd: true }, { widthMm: 300, heightMm: 150 })!;
    const tap = run('tap', at([{ x: -2000, y: 0 }], (near as { point: Point2D }).point), [{ widthMm: 300, heightMm: 150 }], near);
    const plan = planOf(main, [unit, main, branch, tap]);
    // Windows: 1500 − 150 − 102 − 50 … 1500 + 150 + 50, and the same round 3000.
    const windows = [[1198, 1700], [2698, 3200]] as const;
    expect(plan.joints.filter((joint) => windows.some(([from, to]) => joint.stationMm > from + 0.5 && joint.stationMm < to - 0.5))).toEqual([]);
    expect(plan.issues.filter((issue) => issue.code === 'DU_TAP_CLASH')).toEqual([]);
    const consumed = plan.pieces.reduce((total, piece) => total + (piece.stationEndMm - piece.stationStartMm), 0);
    expect(consumed).toBeCloseTo(plan.polylineLengthMm, 6);
  });

  it('flags a branch taller than its parent and a take-off on top of the connector', () => {
    const tall = run('tall', at([{ x: 2000, y: 0 }], (origin as { point: Point2D }).point), [{ widthMm: 300, heightMm: 200 }], origin);
    expect(planOf(tall, [unit, main, tall]).issues.some((issue) => issue.code === 'DU_TAP_TOO_BIG')).toBe(true);
    const near = tapOrigin(main, settings, { legIndex: 0, stationMm: 150, side: 1, style: 'straight', vcd: false }, { widthMm: 300, heightMm: 150 })!;
    const clash = run('near', at([{ x: 2000, y: 0 }], (near as { point: Point2D }).point), [{ widthMm: 300, heightMm: 150 }], near);
    expect(planOf(main, [unit, main, clash]).issues.some((issue) => issue.code === 'DU_TAP_CLASH')).toBe(true);
  });

  it('refuses a branch whose first leg does not leave the parent square to the wall', () => {
    const inward = run('inward', at([{ x: -2000, y: 0 }], (origin as { point: Point2D }).point), [{ widthMm: 300, heightMm: 150 }], origin);
    const plan = planOf(inward, [unit, main, inward]);
    expect(plan.issues.find((issue) => issue.code === 'DU_BRANCH_DIRECTION')?.severity).toBe('error');
    expect(planOf(branch, scene).issues.some((issue) => issue.code === 'DU_BRANCH_DIRECTION')).toBe(false);
  });

  it('schedules the take-off, the damper and the collar screws', () => {
    const rows = buildDuctBom([planOf(main, scene), planOf(branch, scene)]);
    expect(rows.some((row) => row.description === 'Shoe take-off, 45° lead-in 102 mm')).toBe(true);
    // 300 × 150: single blade (≤ 305 high), ≤ 457 wide → 0.85 mm blade, 10 mm pins (SMACNA Fig. 2-12 A).
    expect(rows.some((row) => row.description === 'Single-blade VCD, 0.85 mm blade, 10 mm pins, locking quadrant')).toBe(true);
    expect(rows.some((row) => row.category === 'Connections' && row.description === 'Take-off collar on parent: joints')).toBe(true);
  });
});

describe('end splits', () => {
  const trunk = withEnd(run('trunk', at([{ x: 0, y: -4000 }])), 'split-y');
  const branchTo = (id: string, side: 1 | -1, width: number, parent = trunk) => {
    const origin = splitOrigin(parent, settings, { side, style: 'y', vcd: false }, { widthMm: width, heightMm: 164 })!;
    const point = (origin as { point: Point2D }).point;
    const direction = (origin as { direction: Point2D }).direction;
    return run(id, [{ x: point.x + direction.x * 1500, y: point.y + direction.y * 1500 }], [{ widthMm: width, heightMm: 164 }], origin);
  };

  it('a Y splits the run into two radius elbows, each outlet independent of the other branch', () => {
    const left = branchTo('left', -1, 300);
    const right = branchTo('right', 1, 300);
    const both = planOf(trunk, [unit, trunk, left, right]);
    const split = both.pieces.find((piece) => piece.kind === 'split')!;
    expect(split.split!.branches.map((branch) => branch.side).sort()).toEqual([-1, 1]);
    expect(both.issues.filter((issue) => issue.code === 'DU_SPLIT_INCOMPLETE')).toEqual([]);
    // Each branch starts exactly at its elbow's outlet.
    for (const branch of split.split!.branches) {
      const child = branch.side === 1 ? right : left;
      const start = readDuctRunSpec(child)!.path[0]!;
      expect(Math.hypot(start.x - branch.outlet.point.x, start.y - branch.outlet.point.y)).toBeLessThan(1e-6);
      expect(planOf(child, [unit, trunk, left, right]).issues.filter((issue) => issue.code === 'DU_STALE')).toEqual([]);
    }
    // The right outlet does not move when the left branch is added.
    const alone = planOf(trunk, [unit, trunk, right]).pieces.find((piece) => piece.kind === 'split')!;
    expect(alone.split!.branches[0]!.outlet.point).toEqual(split.split!.branches.find((branch) => branch.side === 1)!.outlet.point);
    expect(planOf(trunk, [unit, trunk, right]).issues.map((issue) => issue.code)).toContain('DU_SPLIT_INCOMPLETE');
  });

  it('refuses Y branches wider together than the run', () => {
    const plan = planOf(trunk, [unit, trunk, branchTo('a', -1, 400), branchTo('b', 1, 400)]);
    expect(plan.issues.find((issue) => issue.code === 'DU_SPLIT_SIZE')?.severity).toBe('error');
  });

  it('a bullhead tee carries turning vanes for each outlet', () => {
    const bull = withEnd(run('bull', at([{ x: 0, y: -4000 }])), 'split-bullhead');
    const origin = splitOrigin(bull, settings, { side: 1, style: 'bullhead', vcd: false }, { widthMm: 400, heightMm: 164 })!;
    const point = (origin as { point: Point2D }).point;
    const child = run('c', [{ x: point.x + 1500, y: point.y }], [{ widthMm: 400, heightMm: 164 }], origin);
    const split = planOf(bull, [unit, bull, child]).pieces.find((piece) => piece.kind === 'split')!;
    expect(split.split!.style).toBe('bullhead');
    expect(split.split!.branches[0]!.vaneCount).toBe(Math.ceil((400 * Math.SQRT2) / 38) - 1);
    expect(split.split!.branches[0]!.vanes!.spec.type).toBe('single-small');
    expect(split.split!.depthMm).toBe(settings.elbowNeckMm + 400);
  });
});

describe('delete cascade', () => {
  const main = run('main', at([{ x: 0, y: -6000 }]));
  const origin = tapOrigin(main, settings, { legIndex: 0, stationMm: 3000, side: 1, style: 'straight', vcd: false }, { widthMm: 300, heightMm: 150 })!;
  const point = (origin as { point: Point2D }).point;
  const branch = run('branch', [{ x: point.x + 2000, y: point.y }], [{ widthMm: 300, heightMm: 150 }], origin);

  it('orphans the branches of a deleted run (open, flagged) and keeps their geometry', () => {
    const next = expandDuctDeletion([unit, main, branch], new Set(['main']));
    const orphan = next.find((element) => element.id === 'branch')!;
    const spec = readDuctRunSpec(orphan)!;
    expect(spec.start).toEqual({ kind: 'open', orphaned: true });
    expect(spec.path).toEqual(readDuctRunSpec(branch)!.path);
    const orphanPlan = planOf(orphan, next);
    expect(orphanPlan.issues.find((issue) => issue.code === 'DU_OPEN_END')?.severity).toBe('warning');
    // …and it is marked on the plan at its open start.
    expect(buildDuctPlanPresentation(orphanPlan).warningPoints).toEqual([spec.path[0]]);
  });

  it('caps a split whose branches are all deleted', () => {
    const trunk = withEnd(run('trunk', at([{ x: 0, y: -4000 }])), 'split-y');
    const splitStart = splitOrigin(trunk, settings, { side: 1, style: 'y', vcd: false }, { widthMm: 300, heightMm: 164 })!;
    const child = run('child', [{ x: (splitStart as { point: Point2D }).point.x + 1500, y: (splitStart as { point: Point2D }).point.y }], [{ widthMm: 300, heightMm: 164 }], splitStart);
    const next = expandDuctDeletion([unit, trunk, child], new Set(['child']));
    expect(readDuctRunSpec(next.find((element) => element.id === 'trunk')!)!.end).toEqual({ kind: 'end-cap' });
  });
});

describe('section layout around take-off windows', () => {
  it('property: no joint inside a window, lengths add up', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1500, max: 12000 }),
      fc.array(fc.record({ at: fc.integer({ min: 300, max: 11000 }), width: fc.integer({ min: 200, max: 700 }) }), { maxLength: 3 }),
      (span, raw) => {
        const windows = raw
          .map((window) => ({ from: window.at, to: window.at + window.width }))
          .filter((window) => window.to < span - 300)
          .sort((a, b) => a.from - b.from)
          .filter((window, index, all) => index === 0 || window.from > all[index - 1]!.to + 50);
        const lengths = layoutSections(0, span, 1200, 200, windows);
        expect(lengths.reduce((total, length) => total + length, 0)).toBeCloseTo(span, 6);
        let joint = 0;
        for (const length of lengths.slice(0, -1)) {
          joint += length;
          expect(windows.some((window) => joint > window.from + 0.5 && joint < window.to - 0.5)).toBe(false);
        }
      },
    ), { numRuns: 200 });
  });
});
