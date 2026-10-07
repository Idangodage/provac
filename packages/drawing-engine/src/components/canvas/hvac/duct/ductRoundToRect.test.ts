import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { errorCodes } from './ductBranchReaim';
import { splitOrigin, tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement } from './ductDraft';
import { getDuctRunPlan } from './ductFabricationPlanner';
import { branchAnchor, ductRunElementWithSpec } from './ductFollow';
import { applyDuctSegmentEdit } from './ductSegmentEdits';
import { ductSegmentOptions, evaluateDuctSegmentOption } from './ductSegmentOptions';
import { resolveDuctSettings } from './ductSettings';
import { isRoundLeg, readDuctRunSpec, roundLeg, type DuctLeg } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
const S = (along: number, across = 0): Point2D => ({ x: port.lip.x + across, y: port.lip.y - along });
const byId = (list: readonly HvacElement[], id: string) => list.find((element) => element.id === id)!;
const specOf = (list: readonly HvacElement[], id: string) => readDuctRunSpec(byId(list, id))!;
const withUpdates = (before: readonly HvacElement[], updates: readonly HvacElement[]) => {
  const replaced = new Map(updates.map((element) => [element.id, element]));
  return before.map((element) => replaced.get(element.id) ?? element);
};
const errors = (list: readonly HvacElement[], id: string) => errorCodes(getDuctRunPlan(byId(list, id), list, settings));
const noErrors = (list: readonly HvacElement[]) => ['main', 'l', 'r'].every((id) => errors(list, id).size === 0);
const RECT: DuctLeg = { widthMm: 650, heightMm: 350 };

/**
 * The user's layout: the unit's collar, a square-to-round cone, a round main 3 m to a wye whose two outlets run
 * `outMm` and turn (round, then square further on). Built as a rectangular Y and made round, as a designer would.
 */
function wyeScene(outMm: number, extra: (main: HvacElement) => HvacElement[] = () => []): HvacElement[] {
  const main = buildDuctRunDraftElement({ port, points: [S(3000)], legSizes: [{ widthMm: 600, heightMm: 300 }] }, 'main');
  const withSplit = ductRunElementWithSpec(main, { ...readDuctRunSpec(main)!, end: { kind: 'split', style: 'y' } });
  const branch = (id: string, side: 1 | -1) => {
    const origin = splitOrigin(withSplit, settings, { side, style: 'y', vcd: false }, { widthMm: 300, heightMm: 300 })!;
    if (origin.kind !== 'split') throw new Error('Expected a split origin');
    const out = { x: origin.point.x + origin.direction.x * outMm, y: origin.point.y + origin.direction.y * outMm };
    return buildDuctRunDraftElement({ origin, points: [out, { x: out.x, y: out.y - 1500 }], legSizes: [{ widthMm: 300, heightMm: 300 }] }, id);
  };
  const y = [unit, withSplit, branch('l', 1), branch('r', -1), ...extra(withSplit)];
  const round = applyDuctSegmentEdit(y, settings, { kind: 'leg-section', runId: 'main', sections: [{ leg: 0, section: roundLeg(500) }] });
  if (round.refused) throw new Error(round.refused);
  return withUpdates(y, round.updates);
}

describe('a round main made rectangular with a wye at its end', () => {
  it('where the outlets turn soon after the wye (as drawn): the wye stays, behind a square-to-round on a round neck', () => {
    const before = wyeScene(500);
    expect(specOf(before, 'main').end).toEqual({ kind: 'split', style: 'wye' });
    expect(noErrors(before)).toBe(true);
    const result = applyDuctSegmentEdit(before, settings, { kind: 'leg-section', runId: 'main', sections: [{ leg: 0, section: RECT }] });
    expect(result.refused).toBeUndefined();
    const after = withUpdates(before, result.updates);
    const main = specOf(after, 'main');
    expect(main.end).toEqual({ kind: 'split', style: 'wye' });
    // The leg cut in two: rectangular up to a straight-through vertex, then the old Ø500 neck into the wye.
    expect(main.path).toHaveLength(specOf(before, 'main').path.length + 1);
    expect(main.legs).toEqual([RECT, roundLeg(500)]);
    expect(result.notes.join(' ')).toMatch(/wye stays as it is.*square-to-round \d+ mm before it/);
    // The outlets and their branches as they were.
    for (const id of ['l', 'r']) expect(specOf(after, id)).toEqual(specOf(before, id));
    const plan = getDuctRunPlan(byId(after, 'main'), after, settings)!;
    expect(plan.pieces.some((piece) => piece.kind === 'transition' && piece.legIndex === 1)).toBe(true);
    expect(noErrors(after)).toBe(true);
    // With 800 mm before they turn, the outlets can leave a rectangular split: the wye becomes one.
    const roomier = wyeScene(800);
    const made = withUpdates(roomier, applyDuctSegmentEdit(roomier, settings, { kind: 'leg-section', runId: 'main', sections: [{ leg: 0, section: RECT }] }).updates);
    expect(specOf(made, 'main').legs).toEqual([RECT]);
    expect((specOf(made, 'main').end as { style: string }).style).not.toBe('wye');
    expect(noErrors(made)).toBe(true);
  });

  it('where the outlets can turn, the wye becomes a rectangular split; "wye kept" keeps it anyway', () => {
    const before = wyeScene(1200);
    const converted = withUpdates(before, applyDuctSegmentEdit(before, settings, { kind: 'leg-section', runId: 'main', sections: [{ leg: 0, section: RECT }] }).updates);
    expect(specOf(converted, 'main').end).toMatchObject({ kind: 'split' });
    expect((specOf(converted, 'main').end as { style: string }).style).not.toBe('wye');
    expect(specOf(converted, 'main').legs).toEqual([RECT]);
    // The split's card: the same rectangle with the wye kept.
    const row = ductSegmentOptions(before, settings, 'main', 'end:split').find((option) => option.id.startsWith('split:keep:'))!;
    expect(row.title).toMatch(/wye kept/);
    const evaluation = evaluateDuctSegmentOption(before, settings, 'main', 'end:split', row);
    expect(evaluation.refused).toBeUndefined();
    expect(evaluation.newIssues.filter((issue) => issue.severity === 'error')).toEqual([]);
    const kept = withUpdates(before, evaluation.updates);
    expect(specOf(kept, 'main').end).toEqual({ kind: 'split', style: 'wye' });
    expect(specOf(kept, 'main').legs.at(-1)).toEqual(roundLeg(500));
    expect(noErrors(kept)).toBe(true);
  });

  it('a rectangular Y made round can keep its Y behind a round-to-square', () => {
    const main = buildDuctRunDraftElement({ port, points: [S(3000)], legSizes: [{ widthMm: 600, heightMm: 300 }] }, 'main');
    const withSplit = ductRunElementWithSpec(main, { ...readDuctRunSpec(main)!, end: { kind: 'split', style: 'y' } });
    const branch = (id: string, side: 1 | -1) => {
      const origin = splitOrigin(withSplit, settings, { side, style: 'y', vcd: false }, { widthMm: 300, heightMm: 300 })!;
      if (origin.kind !== 'split') throw new Error('Expected a split origin');
      const out = { x: origin.point.x + origin.direction.x * 1800, y: origin.point.y + origin.direction.y * 1800 };
      return buildDuctRunDraftElement({ origin, points: [out, { x: out.x, y: out.y - 1500 }], legSizes: [{ widthMm: 300, heightMm: 300 }] }, id);
    };
    const before = [unit, withSplit, branch('l', 1), branch('r', -1)];
    const result = applyDuctSegmentEdit(before, settings, { kind: 'leg-section', runId: 'main', sections: [{ leg: 0, section: roundLeg(500) }], keepSplit: true });
    expect(result.refused).toBeUndefined();
    const after = withUpdates(before, result.updates);
    expect(specOf(after, 'main').end).toEqual({ kind: 'split', style: 'y' });
    expect(specOf(after, 'main').legs).toEqual([roundLeg(500), { widthMm: 600, heightMm: 300 }]);
    expect(result.notes.join(' ')).toMatch(/Y split stays as it is.*round-to-square/);
    expect(noErrors(after)).toBe(true);
  });

  it('take-offs and accessories on the neck move onto it, where they were', () => {
    const extra = (main: HvacElement) => {
      const origin = tapOrigin(main, settings, { legIndex: 0, stationMm: 2600, side: 1, style: 'spin-in', vcd: true }, roundLeg(150))!;
      if (origin.kind !== 'tap') throw new Error('Expected a take-off origin');
      return [buildDuctRunDraftElement({ origin, points: [{ x: origin.point.x + origin.direction.x * 900, y: origin.point.y + origin.direction.y * 900 }], legSizes: [roundLeg(150)] }, 't')];
    };
    const before = wyeScene(500, extra);
    const tapBefore = branchAnchor(specOf(before, 'main'), specOf(before, 't'), settings)!;
    const result = applyDuctSegmentEdit(before, settings, { kind: 'leg-section', runId: 'main', sections: [{ leg: 0, section: RECT }], keepSplit: true });
    expect(result.refused).toBeUndefined();
    const after = withUpdates(before, result.updates);
    const main = specOf(after, 'main');
    const tap = specOf(after, 't');
    expect(tap.start.kind).toBe('tap');
    const start = tap.start as Extract<typeof tap.start, { kind: 'tap' }>;
    const cut = Math.hypot(main.path[1]!.x - main.path[0]!.x, main.path[1]!.y - main.path[0]!.y);
    // The neck reaches back past it (a transition between it and the wye would leave the neck no room): it stays a
    // round tee, on the neck, re-based — not moved.
    expect(start.legIndex).toBe(1);
    expect(start.style).toBe('round-tee');
    expect(start.stationMm).toBeCloseTo(2600 - cut, 6);
    const tapAfter = branchAnchor(main, tap, settings)!;
    expect(Math.hypot(tapAfter.point.x - tapBefore.point.x, tapAfter.point.y - tapBefore.point.y)).toBeLessThan(25);
    expect(['main', 't'].flatMap((id) => [...errors(after, id).keys()])).toEqual([]);
  });

  it('the cone at the unit keeps the duct rectangular: the first leg, or the whole run', () => {
    const before = wyeScene(1200);
    const rows = ductSegmentOptions(before, settings, 'main', 'transition:0');
    const first = rows.find((option) => option.id.startsWith('rect-first:'))!;
    expect(first.title).toMatch(/^Rectangular duct \d+×\d+$/);
    const evaluation = evaluateDuctSegmentOption(before, settings, 'main', 'transition:0', first);
    expect(evaluation.refused).toBeUndefined();
    expect(evaluation.newIssues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(isRoundLeg(specOf(withUpdates(before, evaluation.updates), 'main').legs[0]!)).toBe(false);
    // A run of two round legs: "Rectangular run" makes both rectangular.
    const bent = buildDuctRunDraftElement({ port, points: [S(3000), S(3000, 2500)], legSizes: [roundLeg(400), roundLeg(400)] }, 'bent');
    const scene = [unit, bent];
    const run = ductSegmentOptions(scene, settings, 'bent', 'transition:0').find((option) => option.id === 'rect-run')!;
    const made = evaluateDuctSegmentOption(scene, settings, 'bent', 'transition:0', run);
    expect(made.refused).toBeUndefined();
    expect(made.newIssues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(specOf(withUpdates(scene, made.updates), 'bent').legs.every((leg) => !isRoundLeg(leg))).toBe(true);
  });

  it('a round outlet elbow made rectangular takes a radius its legs fit', () => {
    const before = wyeScene(1200);
    const row = ductSegmentOptions(before, settings, 'l', 'node:1').find((option) => option.id === 'rect-elbow')!;
    const evaluation = evaluateDuctSegmentOption(before, settings, 'l', 'node:1', row);
    expect(evaluation.refused).toBeUndefined();
    expect(evaluation.newIssues.filter((issue) => issue.severity === 'error').map((issue) => issue.code)).toEqual([]);
    expect(evaluation.notes.join(' ')).toMatch(/to fit its legs/);
  });
});
