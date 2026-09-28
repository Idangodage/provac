import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { findAirPort, resolveUnitAirPorts } from './ductAirPorts';
import { splitOrigin, tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraft, buildDuctRunDraftElement } from './ductDraft';
import { planDuctRun } from './ductFabricationPlanner';
import { ductRunElementWithSpec, followDuctsForUnitMove, reanchorBranches } from './ductFollow';
import { resolveDuctSettings } from './ductSettings';
import { readDuctRunSpec } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const lip = { x: supply.lip.x, y: supply.lip.y };
const path = (offsets: Point2D[], from: Point2D = lip) => {
  let cursor = from;
  return offsets.map((offset) => (cursor = { x: cursor.x + offset.x, y: cursor.y + offset.y }));
};
const main = buildDuctRunDraftElement({ port: supply, points: path([{ x: 0, y: -6000 }]) }, 'main');
const tapStart = tapOrigin(main, settings, { legIndex: 0, stationMm: 3000, side: 1, style: 'shoe-45', vcd: true }, { widthMm: 300, heightMm: 150 })!;
const tap = buildDuctRunDraftElement({ origin: tapStart, points: path([{ x: 2000, y: 0 }], (tapStart as { point: Point2D }).point), legSizes: [{ widthMm: 300, heightMm: 150 }] }, 'tap');
const issuesOf = (element: HvacElement, scene: HvacElement[]) => planDuctRun(element, { settings, scene })!.issues.map((issue) => issue.code);

describe('runs follow their unit', () => {
  it('a moved unit carries its run and the run\'s branches, with no stale links', () => {
    const moved = { ...unit, position: { x: 500, y: -300 } };
    const followed = followDuctsForUnitMove([unit, main, tap], [moved, main, tap], ['fdum'], settings);
    expect(followed.map((element) => element.id).sort()).toEqual(['main', 'tap']);
    const after = [moved, ...followed];
    const newMain = followed.find((element) => element.id === 'main')!;
    const newLip = findAirPort(after, 'fdum', 'supply')!.lip;
    expect(readDuctRunSpec(newMain)!.path[0]).toMatchObject({ x: newLip.x, y: newLip.y });
    expect(readDuctRunSpec(newMain)!.path[1]!.y).toBeCloseTo(newLip.y - 6000, 6);
    for (const element of followed) {
      expect(issuesOf(element, after).filter((code) => code === 'DU_STALE')).toEqual([]);
    }
  });

  it('a turned unit turns its run about the collar', () => {
    const turned = { ...unit, rotation: 90 };
    const followed = followDuctsForUnitMove([unit, main], [turned, main], ['fdum'], settings);
    const port = findAirPort([turned], 'fdum', 'supply')!;
    const spec = readDuctRunSpec(followed[0]!)!;
    expect(spec.path[0]!.x).toBeCloseTo(port.lip.x, 6);
    expect(spec.path[0]!.y).toBeCloseTo(port.lip.y, 6);
    // The first leg leaves along the turned collar's normal, still 6000 long.
    const dx = spec.path[1]!.x - spec.path[0]!.x;
    const dy = spec.path[1]!.y - spec.path[0]!.y;
    expect(dx / 6000).toBeCloseTo(port.normal.x, 6);
    expect(dy / 6000).toBeCloseTo(port.normal.y, 6);
  });

  it('a run from another unit is left alone', () => {
    expect(followDuctsForUnitMove([unit, main], [unit, main], ['someone-else'], settings)).toEqual([]);
  });
});

describe('branches follow their parent', () => {
  it('a wider parent pushes the take-off out to its new wall', () => {
    const spec = readDuctRunSpec(main)!;
    const wider = ductRunElementWithSpec(main, { ...spec, legs: [{ widthMm: 800, heightMm: 164 }] });
    const moved = reanchorBranches([unit, wider, tap], new Map([['main', wider]]), settings);
    expect(moved.map((element) => element.id)).toEqual(['tap']);
    const start = readDuctRunSpec(moved[0]!)!.path[0]!;
    // Out by (800 − 674) / 2 = 63 mm, plus the heavier sheet the 800 mm side needs (0.70 vs 0.60).
    const sheet = (width: number) => planDuctRun(width === 800 ? wider : main, { settings, scene: [unit] })!.constructionByLeg[0]!.sheetThicknessMm!;
    expect(start.x - readDuctRunSpec(tap)!.path[0]!.x).toBeCloseTo(63 + sheet(800) - sheet(674), 6);
    expect(issuesOf(moved[0]!, [unit, wider, moved[0]!]).filter((code) => code === 'DU_STALE')).toEqual([]);
  });

  it('cascades down the branch tree (a split under a moved trunk moves its outlets)', () => {
    const trunk0 = buildDuctRunDraftElement({ port: supply, points: path([{ x: 0, y: -3000 }]) }, 'trunk');
    const splitStart = splitOrigin(trunk0, settings, { side: 1, style: 'y', vcd: false }, { widthMm: 300, heightMm: 164 })!;
    const draft = buildDuctRunDraft({ origin: splitStart, points: path([{ x: 1500, y: 0 }], (splitStart as { point: Point2D }).point), legSizes: [{ widthMm: 300, heightMm: 164 }] }, 'leaf', [unit, trunk0]);
    const trunk = draft.changed[0]!;
    const longer = ductRunElementWithSpec(trunk, { ...readDuctRunSpec(trunk)!, path: readDuctRunSpec(trunk)!.path.map((point, index) => (index === 1 ? { ...point, y: point.y - 500 } : point)) });
    const moved = reanchorBranches([unit, longer, draft.element], new Map([['trunk', longer]]), settings);
    expect(moved.map((element) => element.id)).toEqual(['leaf']);
    expect(readDuctRunSpec(moved[0]!)!.path[0]!.y - readDuctRunSpec(draft.element)!.path[0]!.y).toBeCloseTo(-500, 6);
  });
});
