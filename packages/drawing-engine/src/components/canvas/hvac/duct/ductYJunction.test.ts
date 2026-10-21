import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctBom } from './ductBom';
import { errorCodes } from './ductBranchReaim';
import { splitOrigin } from './ductBranchTargets';
import { buildDuctRunDraft, buildDuctRunDraftElement } from './ductDraft';
import { getDuctRunPlan } from './ductFabricationPlanner';
import { ductRunElementWithSpec } from './ductFollow';
import { splitOutletLossPa } from './ductPressure';
import { ductSegmentOptions, evaluateDuctSegmentOption } from './ductSegmentOptions';
import { ductSegmentOf } from './ductSegments';
import { resolveDuctSettings } from './ductSettings';
import { getDuctSupportPlan } from './ductSupports';
import { readDuctRunSpec, splitEnd, type DuctLeg, type DuctRunSpec } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
/** A point `along` the collar's outward normal (−y) and `across` it (+x). */
const S = (along: number, across = 0): Point2D => ({ x: port.lip.x + across, y: port.lip.y - along });
const byId = (list: readonly HvacElement[], id: string) => list.find((element) => element.id === id)!;
const specOf = (list: readonly HvacElement[], id: string) => readDuctRunSpec(byId(list, id))!;
const withUpdates = (before: readonly HvacElement[], updates: readonly HvacElement[]) => {
  const replaced = new Map(updates.map((element) => [element.id, element]));
  return before.map((element) => replaced.get(element.id) ?? element);
};
const planOf = (list: readonly HvacElement[], id: string) => getDuctRunPlan(byId(list, id), list, settings)!;
const MAIN: DuctLeg = { widthMm: 600, heightMm: 300 };
const OUT: DuctLeg = { widthMm: 250, heightMm: 300 };
/** A run's heading from its start. */
const heading = (spec: DuctRunSpec): Point2D => {
  const [a, b] = [spec.path[0]!, spec.path[1]!];
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
};

/** A rectangular main 3 m to a Y leaving at `angle`, two outlets running `outMm` from it and turning on along the run. */
function yScene(angle: 45 | 90, outMm = 1800): HvacElement[] {
  const main = buildDuctRunDraftElement({ port, points: [S(3000)], legSizes: [MAIN] }, 'main');
  const withSplit = ductRunElementWithSpec(main, { ...readDuctRunSpec(main)!, end: splitEnd('y', angle) });
  const branch = (id: string, side: 1 | -1) => {
    const origin = splitOrigin(withSplit, settings, { side, style: 'y', vcd: false }, OUT)!;
    if (origin.kind !== 'split') throw new Error('Expected a split origin');
    const out = { x: origin.point.x + origin.direction.x * outMm, y: origin.point.y + origin.direction.y * outMm };
    return buildDuctRunDraftElement({ origin, points: [out, { x: out.x, y: out.y - 1500 }], legSizes: [OUT] }, id);
  };
  return [unit, withSplit, branch('l', 1), branch('r', -1)];
}

describe('a rectangular Y junction (outlets at 45°)', () => {
  it("leaves at 45°, each half flush with the run's wall on a 45° radius elbow; a Y split still leaves at 90°", () => {
    const scene = yScene(45);
    const split = planOf(scene, 'main').pieces.find((piece) => piece.kind === 'split')!.split!;
    expect(split.angleDeg).toBe(45);
    expect(split.branches).toHaveLength(2);
    for (const branch of split.branches) {
      const along = branch.outlet.direction.x * split.direction.x + branch.outlet.direction.y * split.direction.y;
      const across = branch.outlet.direction.x * split.normal.x + branch.outlet.direction.y * split.normal.y;
      expect(along).toBeCloseTo(Math.SQRT1_2, 9);
      expect(Math.sign(across)).toBe(branch.side);
      expect(branch.elbow!.angleDeg).toBeCloseTo(45, 6);
      // The elbow starts at the run's end, its half of the width flush with the run's wall.
      const offset = (branch.elbow!.startPoint.x - split.origin.x) * split.normal.x + (branch.elbow!.startPoint.y - split.origin.y) * split.normal.y;
      expect(offset).toBeCloseTo(branch.side * (MAIN.widthMm / 2 - OUT.widthMm / 2), 6);
    }
    expect(split.depthMm).toBeGreaterThan(settings.elbowNeckMm);
    for (const id of ['main', 'l', 'r']) expect([...errorCodes(planOf(scene, id)).keys()]).toEqual([]);
    // 90°: as before, the outlets square to the run.
    const square = yScene(90);
    const split90 = planOf(square, 'main').pieces.find((piece) => piece.kind === 'split')!.split!;
    expect(split90.angleDeg).toBe(90);
    for (const branch of split90.branches) {
      expect(Math.abs(branch.outlet.direction.x * split90.direction.x + branch.outlet.direction.y * split90.direction.y)).toBeLessThan(1e-9);
    }
  });

  it('reads an old drawing as a 90° Y split; only a Y stores 45°', () => {
    const main = buildDuctRunDraftElement({ port, points: [S(3000)], legSizes: [MAIN] }, 'main');
    const endOf = (end: unknown) => readDuctRunSpec({ ...main, properties: { ...main.properties, ductRun: { ...readDuctRunSpec(main)!, end } } })!.end;
    expect(endOf({ kind: 'split', style: 'y' })).toEqual({ kind: 'split', style: 'y' });
    expect(endOf({ kind: 'split', style: 'y', angleDeg: 45 })).toEqual({ kind: 'split', style: 'y', angleDeg: 45 });
    expect(endOf({ kind: 'split', style: 'bullhead', angleDeg: 45 })).toEqual({ kind: 'split', style: 'bullhead' });
    expect(endOf({ kind: 'split', style: 'y', angleDeg: 30 })).toEqual({ kind: 'split', style: 'y' });
  });

  it('the duct tool draws one: the outlet at 45°, and the run it splits ends in a Y junction', () => {
    const main = buildDuctRunDraftElement({ port, points: [S(3000)], legSizes: [MAIN] }, 'main');
    const origin = splitOrigin(main, settings, { side: 1, style: 'y', vcd: false, angleDeg: 45 }, OUT)!;
    expect(origin).toMatchObject({ kind: 'split', style: 'y', angleDeg: 45 });
    const { point, direction } = origin as { point: Point2D; direction: Point2D };
    // The run heads along −y: 45° off it, toward the outlet's side.
    expect(-direction.y).toBeCloseTo(Math.SQRT1_2, 9);
    expect(direction.x).toBeCloseTo(Math.SQRT1_2, 9);
    const draft = buildDuctRunDraft({ origin, points: [{ x: point.x + direction.x * 1500, y: point.y + direction.y * 1500 }], legSizes: [OUT] }, 'b', [unit, main]);
    expect(draft.changed.map((element) => readDuctRunSpec(element)!.end)).toEqual([{ kind: 'split', style: 'y', angleDeg: 45 }]);
  });

  it("a Y split made a Y junction from its card: the outlets turn to 45°, keeping their ends; its name and BOM row say so", () => {
    const before = yScene(90);
    const rows = ductSegmentOptions(before, settings, 'main', 'end:split');
    expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining(['split:y45', 'split:y', 'split:bullhead']));
    expect(rows.find((row) => row.id === 'split:y')?.current).toBe(true);
    const row = rows.find((candidate) => candidate.id === 'split:y45')!;
    expect(row.title).toBe('Y junction 45°');
    const evaluation = evaluateDuctSegmentOption(before, settings, 'main', 'end:split', row);
    expect(evaluation.refused).toBeUndefined();
    expect(evaluation.newIssues.filter((issue) => issue.severity === 'error')).toEqual([]);
    const after = withUpdates(before, evaluation.updates);
    // It divides the flow: the Y split drawn before the splitter takes its outlets' share (by their sizes here).
    expect(specOf(after, 'main').end).toMatchObject({ kind: 'split', style: 'y', angleDeg: 45, share: 0.5 });
    for (const id of ['l', 'r']) {
      const now = specOf(after, id);
      const was = specOf(before, id);
      expect(-heading(now).y).toBeCloseTo(Math.SQRT1_2, 6);
      expect(now.path.at(-1)!.x).toBeCloseTo(was.path.at(-1)!.x, 6);
      expect(now.path.at(-1)!.y).toBeCloseTo(was.path.at(-1)!.y, 6);
    }
    const plan = planOf(after, 'main');
    expect(ductSegmentOf(plan, 'end:split')!.title).toBe('Y junction 45°');
    const bom = buildDuctBom([plan], [getDuctSupportPlan(plan, after, settings)]);
    expect(bom.some((line) => /^Y junction 45°, divided 50 \/ 50 %: legs \d+×\d+ \+ \d+×\d+ on radius elbows/.test(line.description))).toBe(true);
    // And back: the Y split again.
    const back = evaluateDuctSegmentOption(after, settings, 'main', 'end:split', ductSegmentOptions(after, settings, 'main', 'end:split').find((candidate) => candidate.id === 'split:y')!);
    expect(back.refused).toBeUndefined();
    // Its splitter kept.
    expect(specOf(withUpdates(after, back.updates), 'main').end).toEqual({ kind: 'split', style: 'y', share: 0.5 });
  });

  it('loses less than a Y split, as a 45° elbow does a 90°: 0.6 of it (practice)', () => {
    expect(splitOutletLossPa('y', 5, 6, 45)).toBeCloseTo(splitOutletLossPa('y', 5, 6, 90) * 0.6, 9);
    expect(splitOutletLossPa('y', 5, 6)).toBeCloseTo(splitOutletLossPa('y', 5, 6, 90), 12);
    expect(splitOutletLossPa('bullhead', 5, 6, 45)).toBeCloseTo(splitOutletLossPa('bullhead', 5, 6), 12);
  });
});
