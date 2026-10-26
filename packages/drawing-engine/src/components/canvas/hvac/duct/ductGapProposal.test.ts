import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { tapOrigin } from './ductBranchTargets';
import { cutDuctPieces, ductOpenEnds } from './ductCut';
import { buildDuctRunDraftElement } from './ductDraft';
import { planDuctRun } from './ductFabricationPlanner';
import { ductRunElementWithSpec } from './ductFollow';
import { proposeDuctGap } from './ductGapProposal';
import { ductSegments } from './ductSegments';
import { resolveDuctSettings } from './ductSettings';
import { readDuctRunSpec } from './ductTypes';

const settings = resolveDuctSettings({});
const noWalls = { walls: [], rooms: [] };
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const P = (along: number, across = 0): Point2D => ({ x: supply.lip.x + across, y: supply.lip.y - along });

/** 600×300 down 3 m, a 90° turn, 2.5 m on, a reduction to 500×300 for 2 m, an end cap. */
function rectMain(): HvacElement {
  return buildDuctRunDraftElement({
    port: supply, points: [P(3000), P(3000, 2500), P(3000, 4500)],
    legSizes: [{ widthMm: 600, heightMm: 300 }, { widthMm: 600, heightMm: 300 }, { widthMm: 500, heightMm: 300 }],
  }, 'main');
}

function branchOff(main: HvacElement, legIndex: number, stationMm: number, id = 'branch'): HvacElement {
  const section = { widthMm: 300, heightMm: 200 };
  const origin = tapOrigin(main, settings, { legIndex, stationMm, side: 1, style: 'shoe-45', vcd: true }, section)!;
  const d = (origin as { direction: Point2D }).direction;
  const start = (origin as { point: Point2D }).point;
  return buildDuctRunDraftElement({ origin, points: [{ x: start.x + d.x * 800, y: start.y + d.y * 800 }], legSizes: [section] }, id);
}

function ids() {
  let n = 0;
  return (kind: 'run' | 'gap') => `${kind}-${(n += 1)}`;
}

/** The scene after a command: updated elements in place, added appended, removed gone. */
function applied(scene: readonly HvacElement[], command: { updates?: readonly HvacElement[]; add?: readonly HvacElement[]; removeIds?: readonly string[] }): HvacElement[] {
  const replaced = new Map((command.updates ?? []).map((element) => [element.id, element]));
  const removed = new Set(command.removeIds ?? []);
  return [...scene.filter((element) => !removed.has(element.id)).map((element) => replaced.get(element.id) ?? element), ...(command.add ?? [])];
}

function cut(scene: readonly HvacElement[], key: string, runId = 'main') {
  const result = cutDuctPieces(scene, [{ runId, key }], { settings, building: noWalls, newId: ids() });
  const after = applied(scene, result);
  const gapId = ductOpenEnds(after).find((end) => end.gap?.partner || (end.runId === runId && end.gap))?.gap?.id;
  return { after, gapId: gapId! };
}

const keysOf = (element: HvacElement, scene: readonly HvacElement[]) => ductSegments(planDuctRun(element, { settings, scene, building: noWalls })!).map((segment) => segment.key);

describe('reconnecting a gap left by deleted duct pieces', () => {
  it('a straight deleted: "As it was" puts it back, one run again planned as before, its branch taken off again', () => {
    const main = rectMain();
    const branch = branchOff(main, 1, 1200);
    const scene = [unit, main, branch];
    const before = keysOf(main, scene);
    const { after, gapId } = cut(scene, 'leg:1');
    const proposals = proposeDuctGap(after, gapId, settings, noWalls);
    expect(proposals.reason).toBeNull();
    const best = proposals.candidates[0]!;
    expect(best.key).toBe('as-before');
    expect(best.elbows).toBe(0);
    const restored = applied(after, best);
    expect(restored.filter((element) => element.type === 'duct')).toHaveLength(2);
    const joined = restored.find((element) => element.id === 'main')!;
    expect(readDuctRunSpec(joined)!.path).toHaveLength(readDuctRunSpec(main)!.path.length);
    expect(keysOf(joined, restored)).toEqual(before);
    // The branch whose take-off was on the straight hangs from it again, where it was.
    expect(readDuctRunSpec(restored.find((element) => element.id === 'branch')!)!.start).toMatchObject({ kind: 'tap', parentRunId: 'main', legIndex: 1 });
    expect(ductOpenEnds(restored)).toHaveLength(0);
  });

  it('something now standing where the stretch was: it is routed round, square to the parts', () => {
    // A longer second leg (6 m), so a detour round a body in its middle has room for its four elbows.
    const main = buildDuctRunDraftElement({
      port: supply, points: [P(3000), P(3000, 6000), P(3000, 8000)],
      legSizes: [{ widthMm: 600, heightMm: 300 }, { widthMm: 600, heightMm: 300 }, { widthMm: 500, heightMm: 300 }],
    }, 'main');
    const { after, gapId } = cut([unit, main], 'leg:1');
    // A unit body placed on the old line, at the duct's level.
    const block: HvacElement = { ...unit, id: 'block', position: { x: P(3000, 2800).x, y: P(3000).y - 400 }, width: 500, depth: 800, elevation: 2400, height: 600 };
    const proposals = proposeDuctGap([...after, block], gapId, settings, noWalls);
    expect(proposals.candidates.map((candidate) => candidate.key)).not.toContain('as-before');
    expect(proposals.candidates.length).toBeGreaterThan(0);
    const best = proposals.candidates[0]!;
    expect(best.elbows).toBeGreaterThanOrEqual(2);
    // The new stretch keeps clear of the block.
    const xs = best.bridge.map((point) => point.y);
    expect(Math.min(...xs) < block.position.y - 300 || Math.max(...xs) > block.position.y + block.depth + 300).toBe(true);
  });

  it('the part after the gap a level up: the new stretch rises on its way (a riser, straight on)', () => {
    const main = rectMain();
    const { after, gapId } = cut([unit, main], 'leg:1');
    // The second part raised 300 mm (its ends open).
    const second = after.find((element) => element.id === 'run-1')!;
    const spec = readDuctRunSpec(second)!;
    const raised = ductRunElementWithSpec(second, { ...spec, path: spec.path.map((point) => ({ ...point, z: point.z + 300 })) });
    const scene = after.map((element) => (element.id === 'run-1' ? raised : element));
    const proposals = proposeDuctGap(scene, gapId, settings, noWalls);
    expect(proposals.candidates.length).toBeGreaterThan(0);
    const best = proposals.candidates[0]!;
    const zs = best.bridge.map((point) => point.z);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(300, 0);
    // The rise is vertical: two points one above the other.
    expect(best.bridge.some((point, index) => index > 0 && Math.hypot(point.x - best.bridge[index - 1]!.x, point.y - best.bridge[index - 1]!.y) < 0.5 && Math.abs(point.z - best.bridge[index - 1]!.z) > 1)).toBe(true);
  });

  it('an elbow deleted: put back as it was', () => {
    const main = rectMain();
    const scene = [unit, main];
    const before = keysOf(main, scene);
    const { after, gapId } = cut(scene, 'node:1');
    const best = proposeDuctGap(after, gapId, settings, noWalls).candidates[0]!;
    expect(best.key).toBe('as-before');
    const restored = applied(after, best);
    expect(keysOf(restored.find((element) => element.id === 'main')!, restored)).toEqual(before);
  });

  it("the collar's connector deleted: back to the unit's collar as it was", () => {
    const main = rectMain();
    const scene = [unit, main];
    const before = keysOf(main, scene);
    const { after, gapId } = cut(scene, 'start:connector');
    const proposals = proposeDuctGap(after, gapId, settings, noWalls);
    expect(proposals.candidates.map((candidate) => candidate.key)).toEqual(['collar']);
    const restored = applied(after, proposals.candidates[0]!);
    const spec = readDuctRunSpec(restored.find((element) => element.id === 'main')!)!;
    expect(spec.start).toMatchObject({ kind: 'unit-port', unitId: 'fdum', portId: 'supply' });
    expect(keysOf(restored.find((element) => element.id === 'main')!, restored)).toEqual(before);
  });

  it("the part after the gap carries a branch: it hangs from the joined run, on the same place", () => {
    const main = rectMain();
    const branch = branchOff(main, 2, 1200);
    const { after, gapId } = cut([unit, main, branch], 'leg:1');
    expect(readDuctRunSpec(after.find((element) => element.id === 'branch')!)!.start).toMatchObject({ kind: 'tap', parentRunId: 'run-1' });
    const restored = applied(after, proposeDuctGap(after, gapId, settings, noWalls).candidates[0]!);
    expect(readDuctRunSpec(restored.find((element) => element.id === 'branch')!)!.start).toMatchObject({ kind: 'tap', parentRunId: 'main', legIndex: 2, stationMm: 1200 });
  });

  it('a gap no longer open says so', () => {
    expect(proposeDuctGap([unit, rectMain()], 'gap-x', settings, noWalls).reason).toMatch(/no longer open/);
  });
});
