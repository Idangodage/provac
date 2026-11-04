/**
 * A radius take-off's tee lengths: A and B on the main, C on the branch. What the sections give by themselves, joints set
 * where they are asked, one piece however long, the limits and what stops them, Auto, and what carries them along.
 */
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import { DuctResizeSolver, ductResizeEdit, ductResizeGrips } from '../move/ductResize';

import { resolveUnitAirPorts } from './ductAirPorts';
import { tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement } from './ductDraft';
import { getDuctRunPlan, layoutSections } from './ductFabricationPlanner';
import { ductRunElementWithSpec } from './ductFollow';
import { applyDuctSegmentEdit } from './ductSegmentEdits';
import { resolveDuctSettings } from './ductSettings';
import { ductTeeFigures, teeJointPoints, teeWithMainEnd } from './ductTee';
import { readDuctRunSpec, withTapStyle, type DuctLeg, type DuctTapStart, type DuctTeeLengths } from './ductTypes';

const settings = resolveDuctSettings({ showSupports: false, jointSystem: 'tdc' });
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: 1000, y: 2000 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
const SECTION: DuctLeg = { widthMm: 300, heightMm: 250 };

function mainRun(points: Point2D[] = [{ x: port.lip.x, y: port.lip.y - 8000 }]): HvacElement {
  return buildDuctRunDraftElement({ port, points, legSizes: points.map(() => ({ widthMm: 600, heightMm: 300 })) }, 'main');
}

function tee(main: HvacElement, options: { station?: number; side?: 1 | -1; ratio?: number; lengthMm?: number; id?: string; vcd?: boolean; lengths?: DuctTeeLengths } = {}): HvacElement {
  const origin = tapOrigin(main, settings, { legIndex: 0, stationMm: options.station ?? 4000, side: options.side ?? 1, style: 'radius', vcd: options.vcd ?? false }, SECTION)!;
  if (origin.kind !== 'tap') throw new Error('Expected a take-off origin');
  const length = options.lengthMm ?? 1500;
  const run = buildDuctRunDraftElement({ origin, points: [{ x: origin.point.x + origin.direction.x * length, y: origin.point.y + origin.direction.y * length }], legSizes: [SECTION] }, options.id ?? 'branch');
  const spec = readDuctRunSpec(run)!;
  const start = { ...(spec.start as DuctTapStart), ...(options.ratio !== undefined ? { radiusRatio: options.ratio } : {}), ...(options.lengths ? { tee: options.lengths } : {}) };
  return ductRunElementWithSpec(run, { ...spec, start });
}

const piecesOf = (main: HvacElement, scene: HvacElement[]) => getDuctRunPlan(main, scene, settings)!.pieces.filter((piece) => piece.kind === 'straight');
const errors = (run: HvacElement, scene: HvacElement[]) => getDuctRunPlan(run, scene, settings)!.issues.filter((issue) => issue.severity === 'error');

describe('the sections', () => {
  it('are cut as ever with no joint set', () => {
    expect(layoutSections(0, 3000, 1200, 300, [])).toEqual([1200, 1200, 600]);
    expect(layoutSections(0, 3000, 1200, 300, [{ from: 1100, to: 1500 }])).toEqual(layoutSections(0, 3000, 1200, 300, [{ from: 1100, to: 1500 }], []));
  });

  it('are cut either side of a set joint, and a window between two set joints stays one piece', () => {
    expect(layoutSections(0, 3000, 1200, 300, [], [1000])).toEqual([1000, 1200, 800]);
    const window = { from: 1000, to: 2800 };
    expect(layoutSections(0, 4000, 1200, 300, [window], [1000, 2800])).toEqual([1000, 1800, 1200]);
  });
});

describe('a tee left to the sections', () => {
  it('reads what they give, and the record stays empty', () => {
    const main = mainRun();
    const branch = tee(main);
    const scene = [unit, main, branch];
    const figures = ductTeeFigures(scene, settings, 'branch')!;
    expect(figures.start.tee).toBeUndefined();
    expect(figures.beforeMm).toBeGreaterThanOrEqual(figures.least.beforeMm - 0.5);
    expect(figures.afterMm).toBeGreaterThanOrEqual(figures.least.afterMm - 0.5);
    expect(figures.branchMm).toBeCloseTo(350, 6);
    expect(figures.least).toEqual({ beforeMm: 150 + 300 + 50, afterMm: 150 + 50, branchMm: 350 });
  });

  it('counts its damper in the branch part', () => {
    const main = mainRun();
    const branch = tee(main, { vcd: true });
    const figures = ductTeeFigures([unit, main, branch], settings, 'branch')!;
    expect(figures.least.branchMm).toBe(350 + settings.vcdLengthMm);
    expect(figures.branchMm).toBeCloseTo(350 + settings.vcdLengthMm, 6);
  });

  it('is told only of a radius take-off on a rectangular main', () => {
    const main = mainRun();
    const branch = tee(main);
    const shoe = ductRunElementWithSpec(branch, { ...readDuctRunSpec(branch)!, start: withTapStyle(readDuctRunSpec(branch)!.start as DuctTapStart, 'shoe-45') });
    expect(ductTeeFigures([unit, main, shoe], settings, 'branch')).toBeNull();
  });
});

describe('a tee with its lengths set', () => {
  it('puts the main\'s joints where they are asked: one piece from A to B, the rest cut as before', () => {
    const main = mainRun();
    const branch = tee(main, { lengths: { beforeMm: 700, afterMm: 650 } });
    const scene = [unit, main, branch];
    expect(errors(main, scene)).toEqual([]);
    const figures = ductTeeFigures(scene, settings, 'branch')!;
    expect(figures.beforeMm).toBeCloseTo(700, 6);
    expect(figures.afterMm).toBeCloseTo(650, 6);
    const stations = piecesOf(main, scene).map((piece) => Math.round(piece.lengthMm));
    expect(stations).toContain(1350);
  });

  it('runs its branch part out to the joint, the damper at its end', () => {
    const main = mainRun();
    const branch = tee(main, { vcd: true, lengths: { branchMm: 800 } });
    const scene = [unit, main, branch];
    const plan = getDuctRunPlan(branch, scene, settings)!;
    const collar = plan.pieces.find((piece) => piece.kind === 'takeoff')!;
    expect(collar.lengthMm).toBeCloseTo(800 - settings.vcdLengthMm, 6);
    expect(plan.pieces[plan.pieces.indexOf(collar) + 1]!.kind).toBe('damper');
    expect(plan.joints.find((joint) => joint.kind === 'flange')!.stationMm).toBeCloseTo(800, 6);
    const bare = getDuctRunPlan(tee(main, { vcd: true }), scene, settings)!.pieces.find((piece) => piece.kind === 'takeoff')!;
    expect(collar.sheetAreaM2).toBeGreaterThan(bare.sheetAreaM2);
  });

  it('warns past a stock length, and still makes it one piece', () => {
    const main = mainRun();
    const branch = tee(main, { lengths: { beforeMm: 900, afterMm: 900 } });
    const scene = [unit, main, branch];
    expect(errors(main, scene)).toEqual([]);
    expect(piecesOf(main, scene).map((piece) => Math.round(piece.lengthMm))).toContain(1800);
    const warning = getDuctRunPlan(main, scene, settings)!.issues.find((issue) => issue.code === 'DU_TEE_LONG');
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toMatch(/1800 mm, longer than a stock section \(1200 mm\)/);
    expect(getDuctRunPlan(main, [unit, main, tee(main, { lengths: { beforeMm: 600, afterMm: 600 } })], settings)!.issues.some((issue) => issue.code === 'DU_TEE_LONG')).toBe(false);
  });

  it('stops at a fitting, a neighbour and a sliver, saying so', () => {
    const main = mainRun([{ x: port.lip.x, y: port.lip.y - 3000 }, { x: port.lip.x + 6000, y: port.lip.y - 3000 }]);
    const onLeg = (lengths: DuctTeeLengths) => {
      const origin = tapOrigin(main, settings, { legIndex: 1, stationMm: 1500, side: 1, style: 'radius', vcd: false }, SECTION)!;
      if (origin.kind !== 'tap') throw new Error('Expected a take-off origin');
      const run = buildDuctRunDraftElement({ origin, points: [{ x: origin.point.x + origin.direction.x * 1500, y: origin.point.y + origin.direction.y * 1500 }], legSizes: [SECTION] }, 'branch');
      const spec = readDuctRunSpec(run)!;
      return ductRunElementWithSpec(run, { ...spec, start: { ...(spec.start as DuctTapStart), radiusRatio: 0.5, tee: lengths } });
    };
    const reach = (lengths: DuctTeeLengths) => { const run = onLeg(lengths); return errors(main, [unit, main, run]).map((issue) => issue.message); };
    expect(reach({ beforeMm: 1490 }).join()).toMatch(/tee's main part reaches an elbow/);
    // Up to the main's end: a joint nearer it than the shortest piece runs the tee right up to it.
    const straightEnd = 6000;
    expect(reach({ afterMm: straightEnd - 1500 - 100 })).toEqual([]);
    const upToEnd = onLeg({ afterMm: straightEnd - 1500 - 100 });
    expect(ductTeeFigures([unit, main, upToEnd], settings, 'branch')!.afterMm).toBeCloseTo(straightEnd - 1500, 3);
    expect(reach({ afterMm: straightEnd - 1500 - 400 })).toEqual([]);
    expect(ductTeeFigures([unit, main, onLeg({ afterMm: straightEnd - 1500 - 400 })], settings, 'branch')!.afterMm).toBeCloseTo(straightEnd - 1500 - 400, 3);
    expect(reach({ afterMm: straightEnd - 1500 + 50 }).join()).toMatch(/tee's main part reaches/);
    const straight = mainRun();
    const near = tee(straight, { station: 5000, id: 'near', side: -1 });
    const far = tee(straight, { station: 4000, lengths: { afterMm: 800 } });
    expect(errors(straight, [unit, straight, near, far]).map((issue) => issue.message).join()).toMatch(/Two take-offs overlap/);
    // Between two tees' joints: a sliver is an error; one joint shared is none.
    const first = tee(straight, { station: 3000, id: 'first', lengths: { afterMm: 800 } });
    const second = (beforeMm: number) => tee(straight, { station: 5000, id: 'second', side: -1, lengths: { beforeMm } });
    expect(errors(straight, [unit, straight, first, second(1100)]).map((issue) => issue.message).join()).toMatch(/leaves 100 mm of main beside it, less than the shortest piece \(300 mm\)/);
    expect(errors(straight, [unit, straight, first, second(1200)])).toEqual([]);
  });

  it('never goes below what its sweep needs, in the planner or by the edit', () => {
    const main = mainRun();
    const branch = tee(main, { lengths: { beforeMm: 100, afterMm: 100, branchMm: 100 } });
    const scene = [unit, main, branch];
    const figures = ductTeeFigures(scene, settings, 'branch')!;
    expect(figures.beforeMm).toBeGreaterThanOrEqual(500 - 0.5);
    expect(figures.afterMm).toBeGreaterThanOrEqual(200 - 0.5);
    expect(figures.branchMm).toBeCloseTo(350, 6);
    expect(applyDuctSegmentEdit(scene, settings, { kind: 'tap-tee', runId: 'branch', tee: { beforeMm: 400 } }).refused).toMatch(/at least 500 mm on this side/);
    expect(applyDuctSegmentEdit(scene, settings, { kind: 'tap-tee', runId: 'branch', tee: { afterMm: 150 } }).refused).toMatch(/at least 200 mm on this side/);
    expect(applyDuctSegmentEdit(scene, settings, { kind: 'tap-tee', runId: 'branch', tee: { branchMm: 300 } }).refused).toMatch(/branch part is at least 350 mm/);
  });
});

describe('the edit', () => {
  it('names the main with the branch, so a preview moves its joints; Auto takes the lengths away', () => {
    const main = mainRun();
    const branch = tee(main);
    const scene = [unit, main, branch];
    const made = applyDuctSegmentEdit(scene, settings, { kind: 'tap-tee', runId: 'branch', tee: { beforeMm: 700, afterMm: 650, branchMm: 500 } });
    expect(made.refused).toBeUndefined();
    expect(made.updates.map((element) => element.id).sort()).toEqual(['branch', 'main']);
    const next = scene.map((element) => made.updates.find((update) => update.id === element.id) ?? element);
    expect((readDuctRunSpec(next[2]!)!.start as DuctTapStart).tee).toEqual({ beforeMm: 700, afterMm: 650, branchMm: 500 });
    const back = applyDuctSegmentEdit(next, settings, { kind: 'tap-tee', runId: 'branch', tee: null });
    expect((readDuctRunSpec(back.updates.find((element) => element.id === 'branch')!)!.start as DuctTapStart).tee).toBeUndefined();
    expect(back.action).toBe('Tee size back to automatic');
  });

  it('is refused on anything but a radius take-off', () => {
    const main = mainRun();
    const branch = tee(main);
    const shoe = ductRunElementWithSpec(branch, { ...readDuctRunSpec(branch)!, start: withTapStyle(readDuctRunSpec(branch)!.start as DuctTapStart, 'shoe-45') });
    expect(applyDuctSegmentEdit([unit, main, shoe], settings, { kind: 'tap-tee', runId: 'branch', tee: { branchMm: 500 } }).refused).toMatch(/Only a radius take-off/);
  });

  it('holds the other main end where it is when one is set', () => {
    const main = mainRun();
    const branch = tee(main);
    const figures = ductTeeFigures([unit, main, branch], settings, 'branch')!;
    expect(teeWithMainEnd(figures, 'beforeMm', 800)).toEqual({ beforeMm: 800, afterMm: figures.afterMm });
  });
});

describe('its grips', () => {
  it('a radius take-off has its slide and its three tee ends, on its joints, each its length', () => {
    const main = mainRun();
    const branch = tee(main, { vcd: true, lengths: { beforeMm: 700, afterMm: 650, branchMm: 800 } });
    const scene = [unit, main, branch];
    const grips = ductResizeGrips(scene, settings, 'branch', 'start:takeoff');
    expect(grips.map((grip) => grip.kind)).toEqual(['slide', 'tee-before', 'tee-after', 'tee-branch']);
    const figures = ductTeeFigures(scene, settings, 'branch')!;
    const [, before, after, branchEnd] = grips;
    const along = (point: { x: number; y: number }) => (point.x - figures.centre.x) * figures.leg.direction.x + (point.y - figures.centre.y) * figures.leg.direction.y;
    expect(along(before!.point)).toBeCloseTo(-700, 3);
    expect(along(after!.point)).toBeCloseTo(650, 3);
    expect(before!.value).toBeCloseTo(700, 3);
    expect(before!.axis.x * figures.leg.direction.x + before!.axis.y * figures.leg.direction.y).toBeCloseTo(-1, 6);
    expect(after!.axis.x * figures.leg.direction.x + after!.axis.y * figures.leg.direction.y).toBeCloseTo(1, 6);
    const out = (branchEnd!.point.x - figures.wallPoint.x) * figures.direction.x + (branchEnd!.point.y - figures.wallPoint.y) * figures.direction.y;
    expect(out).toBeCloseTo(800, 3);
    expect(branchEnd!.value).toBeCloseTo(800, 3);
    // A shoe has its slide alone.
    const shoe = ductRunElementWithSpec(branch, { ...readDuctRunSpec(branch)!, start: withTapStyle(readDuctRunSpec(branch)!.start as DuctTapStart, 'shoe-45') });
    expect(ductResizeGrips([unit, main, shoe], settings, 'branch', 'start:takeoff').map((grip) => grip.kind)).toEqual(['slide']);
  });

  it('each end asks its own length, the main\'s other end held where it is', () => {
    const main = mainRun();
    const branch = tee(main);
    const scene = [unit, main, branch];
    const figures = ductTeeFigures(scene, settings, 'branch')!;
    const grips = ductResizeGrips(scene, settings, 'branch', 'start:takeoff');
    const of = (kind: string) => grips.find((grip) => grip.kind === kind)!;
    expect(ductResizeEdit(scene, of('tee-before'), 900)).toEqual({ kind: 'tap-tee', runId: 'branch', tee: { beforeMm: 900, afterMm: figures.afterMm } });
    expect(ductResizeEdit(scene, of('tee-after'), 900)).toEqual({ kind: 'tap-tee', runId: 'branch', tee: { beforeMm: figures.beforeMm, afterMm: 900 } });
    expect(ductResizeEdit(scene, of('tee-branch'), 600)).toEqual({ kind: 'tap-tee', runId: 'branch', tee: { branchMm: 600 } });
  });

  it('dragged, an end goes where it is asked; past a fitting it stops there and says why; under its least, at it', () => {
    const main = mainRun([{ x: port.lip.x, y: port.lip.y - 3000 }, { x: port.lip.x + 6000, y: port.lip.y - 3000 }]);
    const origin = tapOrigin(main, settings, { legIndex: 1, stationMm: 3000, side: 1, style: 'radius', vcd: false }, SECTION)!;
    if (origin.kind !== 'tap') throw new Error('Expected a take-off origin');
    const run = buildDuctRunDraftElement({ origin, points: [{ x: origin.point.x + origin.direction.x * 1500, y: origin.point.y + origin.direction.y * 1500 }], legSizes: [SECTION] }, 'branch');
    const branch = ductRunElementWithSpec(run, { ...readDuctRunSpec(run)!, start: { ...(readDuctRunSpec(run)!.start as DuctTapStart), radiusRatio: 0.5 } });
    const scene = [unit, main, branch];
    const grips = ductResizeGrips(scene, settings, 'branch', 'start:takeoff');
    const before = new DuctResizeSolver(scene, settings, grips.find((grip) => grip.kind === 'tee-before')!);
    const asked = before.plan(900);
    expect(asked.limitedBy).toBeNull();
    expect(asked.resize.made).toBeCloseTo(900, 3);
    expect(asked.updated.map((element) => element.id).sort()).toEqual(['branch', 'main']);
    expect(asked.label).toBe('Tee length A 900 mm');
    // Toward the elbow at the leg's start: it runs up to it, and no further.
    const far = before.plan(2990);
    expect(far.limitedBy?.reason).toMatch(/^Tee length A stops at [\d,]+ mm: the tee's main part reaches an elbow/);
    const figures = ductTeeFigures(scene.map((element) => far.updated.find((update) => update.id === element.id) ?? element), settings, 'branch')!;
    expect(figures.beforeMm).toBeCloseTo(far.resize.made, 3);
    const parent = getDuctRunPlan(main, scene, settings)!;
    // Leg 2 starts 3000 mm along the run (the first leg's length); its straight, after the elbow.
    const legStart = 3000;
    const straightFrom = Math.min(...parent.pieces.filter((piece) => piece.legIndex === 1 && piece.kind === 'straight').map((piece) => piece.stationStartMm)) - legStart;
    expect(figures.beforeMm).toBeCloseTo(3000 - straightFrom, 3);
    const tight = before.plan(300);
    expect(tight.limitedBy?.reason).toMatch(/at least 350 mm on this side/);
    expect(tight.resize.made).toBeGreaterThanOrEqual(350);
    expect(tight.resize.made).toBeLessThan(360);
  });
  it('a drag far past its stop answers from the stop it found; nearer values are still tried', () => {
    const main = mainRun([{ x: port.lip.x, y: port.lip.y - 3000 }, { x: port.lip.x + 6000, y: port.lip.y - 3000 }]);
    const origin = tapOrigin(main, settings, { legIndex: 1, stationMm: 3000, side: 1, style: 'radius', vcd: false }, SECTION)!;
    if (origin.kind !== 'tap') throw new Error('Expected a take-off origin');
    const branch = buildDuctRunDraftElement({ origin, points: [{ x: origin.point.x + origin.direction.x * 1500, y: origin.point.y + origin.direction.y * 1500 }], legSizes: [SECTION] }, 'branch');
    const scene = [unit, main, branch];
    const solver = new DuctResizeSolver(scene, settings, ductResizeGrips(scene, settings, 'branch', 'start:takeoff').find((grip) => grip.kind === 'tee-before')!);
    const first = solver.plan(2990);
    const further = solver.plan(5000);
    expect(further.resize.made).toBe(first.resize.made);
    expect(further.limitedBy?.reason).toBe(first.limitedBy?.reason);
    expect(further.updated).toBe(first.updated);
    const nearer = solver.plan(1200);
    expect(nearer.limitedBy).toBeNull();
    expect(nearer.resize.made).toBeCloseTo(1200, 3);
  });

  it("gives the card the tee's joints to keep clear of, ends at its bottom and top", () => {
    const main = mainRun();
    const branch = tee(main, { lengths: { beforeMm: 700, afterMm: 650, branchMm: 800 } });
    const figures = ductTeeFigures([unit, main, branch], settings, 'branch')!;
    const points = teeJointPoints(figures);
    expect(points).toHaveLength(12);
    const along = (point: Point2D) => (point.x - figures.centre.x) * figures.leg.direction.x + (point.y - figures.centre.y) * figures.leg.direction.y;
    expect(Math.min(...points.map(along))).toBeCloseTo(-700, 3);
    expect(Math.max(...points.map(along))).toBeCloseTo(650, 3);
    const out = Math.max(...points.map((point) => (point.x - figures.wallPoint.x) * figures.direction.x + (point.y - figures.wallPoint.y) * figures.direction.y));
    expect(out).toBeCloseTo(800, 3);
  });
});

describe('what carries it', () => {
  it('is kept in the record, an unsound one read away, and another style drops it', () => {
    const main = mainRun();
    const start = readDuctRunSpec(tee(main, { lengths: { beforeMm: 700, branchMm: 500 } }))!.start as DuctTapStart;
    expect(start.tee).toEqual({ beforeMm: 700, branchMm: 500 });
    expect(withTapStyle(start, 'shoe-45').tee).toBeUndefined();
    expect(withTapStyle(start, 'radius', 0.5).tee).toEqual({ beforeMm: 700, branchMm: 500 });
    const stored = tee(main);
    const spec = stored.properties.ductRun as { start: Record<string, unknown> };
    const corrupt = { ...stored, properties: { ...stored.properties, ductRun: { ...spec, start: { ...spec.start, tee: { beforeMm: 'x', afterMm: -5, branchMm: 600 } } } } };
    expect((readDuctRunSpec(corrupt)!.start as DuctTapStart).tee).toEqual({ branchMm: 600 });
  });

  it('slides with its take-off: the joints stay where they are on the tee', () => {
    const main = mainRun();
    const branch = tee(main, { lengths: { beforeMm: 700, afterMm: 650 } });
    const scene = [unit, main, branch];
    const made = applyDuctSegmentEdit(scene, settings, { kind: 'tap-station', runId: 'branch', stationMm: 4300 });
    expect(made.refused).toBeUndefined();
    const next = scene.map((element) => made.updates.find((update) => update.id === element.id) ?? element);
    const figures = ductTeeFigures(next, settings, 'branch')!;
    expect(figures.start.stationMm).toBe(4300);
    expect(figures.beforeMm).toBeCloseTo(700, 6);
    expect(figures.afterMm).toBeCloseTo(650, 6);
  });
});
