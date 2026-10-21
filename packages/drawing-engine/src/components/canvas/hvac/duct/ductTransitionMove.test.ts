import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement, type DuctDraftOrigin } from './ductDraft';
import { getDuctRunPlan } from './ductFabricationPlanner';
import { applyDuctSegmentEdit, transitionStretch } from './ductSegmentEdits';
import { resolveDuctSettings } from './ductSettings';
import { readDuctRunSpec, roundLeg, type DuctRunSpec } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
/** A plan point `along` up from the supply collar (−y) and `across` to its right (+x). */
const S = (along: number, across = 0): Point2D => ({ x: port.lip.x + across, y: port.lip.y - along });
const trunk = { widthMm: 400, heightMm: 250 };
const small = { widthMm: 300, heightMm: 250 };

const byId = (list: readonly HvacElement[], id: string) => list.find((element) => element.id === id)!;
const specOf = (list: readonly HvacElement[], id: string): DuctRunSpec => readDuctRunSpec(byId(list, id))!;
const withUpdates = (before: readonly HvacElement[], updates: readonly HvacElement[]) => {
  const replaced = new Map(updates.map((element) => [element.id, element]));
  return before.map((element) => replaced.get(element.id) ?? element);
};
const near = (a: Point2D, b: Point2D, tolerance = 0.05) => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
const errors = (list: readonly HvacElement[], id: string) => getDuctRunPlan(byId(list, id), list, settings)!.issues
  .filter((issue) => issue.severity === 'error').map((issue) => issue.code);

// ---- Up 3000 from the collar, reduced at 1500 (400×250 → 300×250), then right 2000. ----
const main = buildDuctRunDraftElement({ port, points: [S(1500), S(3000), S(3000, 2000)], legSizes: [trunk, small, small] }, 'main');
// A round branch off the reduced straight, 600 mm past the reducer (its left wall).
const tap = tapOrigin(main, settings, { legIndex: 1, stationMm: 600, side: 1, style: 'spin-in', vcd: true }, roundLeg(200)) as Extract<DuctDraftOrigin, { kind: 'tap' }>;
const branch = buildDuctRunDraftElement({
  origin: tap, points: [{ x: tap.point.x + tap.direction.x * 1500, y: tap.point.y + tap.direction.y * 1500 }], legSizes: [roundLeg(200)],
}, 'branch');
const scene = [unit, main, branch];

describe('transition-move: a reducer slid along its straight', () => {
  it('knows its straight: from the collar\'s transition (it may not reach it) to the elbow', () => {
    const stretch = transitionStretch(scene, specOf(scene, 'main'), 1)!;
    expect(stretch).toMatchObject({ node: 1, lo: 0, hi: 2, boundedBelow: true });
    expect(stretch.atMm).toBeCloseTo(1500, 1);
    expect(stretch.spanMm).toBeCloseTo(3000, 1);
  });

  it('moves the change of section; the collar, the elbow and the run\'s end stay', () => {
    const result = applyDuctSegmentEdit(scene, settings, { kind: 'transition-move', runId: 'main', node: 1, alongMm: 1100 });
    expect(result.refused).toBeUndefined();
    expect(result.action).toBe('Transition moved 400 mm back along the straight');
    expect(result.refocus).toEqual({ runId: 'main', key: 'transition:1' });
    const after = withUpdates(scene, result.updates);
    const spec = specOf(after, 'main');
    const before = specOf(scene, 'main');
    expect(spec.path).toHaveLength(4);
    expect(near(spec.path[1]!, S(1100))).toBe(true);
    for (const index of [0, 2, 3]) expect(near(spec.path[index]!, before.path[index]!)).toBe(true);
    expect(spec.legs.map((leg) => `${leg.widthMm}x${leg.heightMm}`)).toEqual(['400x250', '300x250', '300x250']);
  });

  it('a take-off on the straight keeps its place (its station restated), its branch unchanged', () => {
    const result = applyDuctSegmentEdit(scene, settings, { kind: 'transition-move', runId: 'main', node: 1, alongMm: 1100 });
    const after = withUpdates(scene, result.updates);
    const start = specOf(after, 'branch').start as Extract<DuctRunSpec['start'], { kind: 'tap' }>;
    // 1500 + 600 from the collar before; the reduced straight now starts at 1100.
    expect(start.legIndex).toBe(1);
    expect(start.stationMm).toBeCloseTo(1000, 1);
    expect(errors(after, 'branch')).toEqual(errors(scene, 'branch'));
  });

  it('moved onto the take-off, the planner says the take-off overlaps it', () => {
    const result = applyDuctSegmentEdit(scene, settings, { kind: 'transition-move', runId: 'main', node: 1, alongMm: 2000 });
    expect(result.refused).toBeUndefined();
    expect(errors(withUpdates(scene, result.updates), 'main')).toContain('DU_TAP_CLASH');
  });

  it("it cannot run into the collar's transition, nor past the elbow", () => {
    expect(applyDuctSegmentEdit(scene, settings, { kind: 'transition-move', runId: 'main', node: 1, alongMm: 20 }).refused).toMatch(/fitting before it/);
    expect(applyDuctSegmentEdit(scene, settings, { kind: 'transition-move', runId: 'main', node: 1, alongMm: 2990 }).refused).toMatch(/fitting after it/);
    const locked = buildDuctRunDraftElement({ port, points: [S(1500), S(3000)], legSizes: [trunk, small] }, 'locked');
    const lockedSpec = readDuctRunSpec(locked)!;
    const frozen = { ...locked, properties: { ...locked.properties, ductRun: { ...lockedSpec, locked: true } } };
    expect(applyDuctSegmentEdit([unit, frozen], settings, { kind: 'transition-move', runId: 'locked', node: 1, alongMm: 1000 }).refused).toMatch(/locked/);
  });
});

// ---- An L whose second straight is reduced right after the elbow (the change of section at the corner). ----
const ell = buildDuctRunDraftElement({ port, points: [S(3000), S(3000, 2500)], legSizes: [trunk, small] }, 'ell');
const ellScene = [unit, { ...ell, properties: { ...ell.properties, ductRun: { ...readDuctRunSpec(ell)!, nodeOverrides: { '1': { elbowStyle: 'square-vaned' as const, taperDeg: 20 } } } } }];

describe('transition-move: off an elbow and back', () => {
  it('slides off the elbow onto the straight (a vertex added), its taper with it, the elbow keeping its own choices', () => {
    const result = applyDuctSegmentEdit(ellScene, settings, { kind: 'transition-move', runId: 'ell', node: 1, alongMm: 600 });
    expect(result.refused).toBeUndefined();
    expect(result.refocus).toEqual({ runId: 'ell', key: 'transition:2' });
    const spec = specOf(withUpdates(ellScene, result.updates), 'ell');
    expect(spec.path).toHaveLength(4);
    expect(near(spec.path[2]!, S(3000, 600))).toBe(true);
    expect(spec.legs.map((leg) => `${leg.widthMm}x${leg.heightMm}`)).toEqual(['400x250', '400x250', '300x250']);
    expect(spec.nodeOverrides).toEqual({ '1': { elbowStyle: 'square-vaned' }, '2': { taperDeg: 20 } });
  });

  it('slid back onto the elbow, the vertex goes again', () => {
    const off = withUpdates(ellScene, applyDuctSegmentEdit(ellScene, settings, { kind: 'transition-move', runId: 'ell', node: 1, alongMm: 600 }).updates);
    const result = applyDuctSegmentEdit(off, settings, { kind: 'transition-move', runId: 'ell', node: 2, alongMm: 0 });
    expect(result.refused).toBeUndefined();
    expect(result.refocus).toEqual({ runId: 'ell', key: 'transition:1' });
    const spec = specOf(withUpdates(off, result.updates), 'ell');
    expect(spec.path).toHaveLength(3);
    expect(spec.legs.map((leg) => `${leg.widthMm}x${leg.heightMm}`)).toEqual(['400x250', '300x250']);
    expect(spec.nodeOverrides).toEqual({ '1': { elbowStyle: 'square-vaned', taperDeg: 20 } });
  });
});
