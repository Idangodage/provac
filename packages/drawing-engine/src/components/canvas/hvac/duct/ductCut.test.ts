import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { tapOrigin } from './ductBranchTargets';
import type { DuctWall } from './ductBuilding';
import { cutDuctPieces, ductOpenEnds } from './ductCut';
import { buildDuctRunDraftElement } from './ductDraft';
import { planDuctRun, planDuctRunSpec } from './ductFabricationPlanner';
import { ductSegmentOf, ductSegments } from './ductSegments';
import { resolveDuctSettings } from './ductSettings';
import { readDuctRunSpec, type DuctRunSpec } from './ductTypes';

const settings = resolveDuctSettings({});
const noWalls = { walls: [], rooms: [] };
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
/** A point `along` the collar's outward normal (−y) and `across` it (+x). */
const P = (along: number, across = 0): Point2D => ({ x: supply.lip.x + across, y: supply.lip.y - along });

/** 600×300 down 3 m, a 90° turn, 2.5 m on, a reduction to 500×300 for 2 m, an end cap. */
function rectMain(patch: Partial<DuctRunSpec> = {}): HvacElement {
  const element = buildDuctRunDraftElement({
    port: supply, points: [P(3000), P(3000, 2500), P(3000, 4500)],
    legSizes: [{ widthMm: 600, heightMm: 300 }, { widthMm: 600, heightMm: 300 }, { widthMm: 500, heightMm: 300 }],
  }, 'main');
  if (!Object.keys(patch).length) return element;
  return { ...element, properties: { ...element.properties, ductRun: { ...readDuctRunSpec(element)!, ...patch } } };
}

/** A 300×200 take-off off the main's second leg, 1.2 m from its start, 800 mm out. */
function branchOff(main: HvacElement, stationMm = 1200): HvacElement {
  const origin = tapOrigin(main, settings, { legIndex: 1, stationMm, side: 1, style: 'shoe-45', vcd: true }, { widthMm: 300, heightMm: 200 })!;
  const d = (origin as { direction: Point2D }).direction;
  const start = (origin as { point: Point2D }).point;
  return buildDuctRunDraftElement({ origin, points: [{ x: start.x + d.x * 800, y: start.y + d.y * 800 }], legSizes: [{ widthMm: 300, heightMm: 200 }] }, 'branch');
}

function ids() {
  let n = 0;
  return (kind: 'run' | 'gap') => `${kind}-${(n += 1)}`;
}

const specOf = (elements: readonly HvacElement[], id: string) => readDuctRunSpec(elements.find((element) => element.id === id)!)!;
const keysOf = (element: HvacElement, scene: readonly HvacElement[]) => ductSegments(planDuctRun(element, { settings, scene, building: noWalls })!).map((segment) => segment.key);

describe('deleting pieces of a duct run', () => {
  it('a straight between an elbow and a reduction: two runs, the elbow kept on one and the reduction on the other, the gap between them', () => {
    const main = rectMain();
    const scene = [unit, main];
    const result = cutDuctPieces(scene, [{ runId: 'main', key: 'leg:1' }], { settings, building: noWalls, newId: ids() });
    expect(result.pieces).toBe(1);
    expect(result.gaps).toBe(1);
    expect(result.add.map((element) => element.id)).toEqual(['run-1']);
    const first = specOf(result.updates, 'main');
    const second = specOf(result.add, 'run-1');
    // The first part keeps the collar and the elbow, ending at the elbow's open socket (its neck is all that is left of
    // the deleted leg); the second starts at the reduction.
    const after = [unit, ...result.updates, ...result.add];
    expect(keysOf(result.updates[0]!, after)).toEqual(['start:connector', 'transition:0', 'leg:0', 'node:1']);
    expect(keysOf(result.add[0]!, after)).toEqual(['transition:0', 'leg:0', 'end:cap']);
    expect(first.end).toMatchObject({ kind: 'open', gap: { id: 'gap-2', partner: { runId: 'run-1', end: 'start' } } });
    expect(second.start).toMatchObject({ kind: 'open', gap: { id: 'gap-2', partner: { runId: 'main', end: 'end' } }, socket: { widthMm: 600, heightMm: 300 } });
    // The reduction is 600×300 → 500×300 still, its inlet open.
    const plan = planDuctRunSpec('run-1', second, { settings, scene: after, building: noWalls });
    expect(ductSegmentOf(plan, 'transition:0')!.size).toBe('600×300 → 500×300');
    // The stretch deleted runs from the elbow's socket to the reduction, on the old line.
    const removed = first.end.kind === 'open' ? first.end.gap!.removed! : null;
    expect(removed!.path[0]!.y).toBeCloseTo(P(3000).y);
    expect(removed!.path.at(-1)).toMatchObject({ x: P(3000, 2500).x, y: P(3000, 2500).y });
    expect(removed!.legs).toEqual([{ widthMm: 600, heightMm: 300 }]);
    // Both open ends are found, facing each other.
    const ends = ductOpenEnds(after).filter((end) => end.gap?.id === 'gap-2');
    expect(ends.map((end) => end.end).sort()).toEqual(['end', 'start']);
  });

  it('an elbow: the straights either side stay where they were, and a take-off moves to the part it is on', () => {
    const main = rectMain();
    const branch = branchOff(main);
    const scene = [unit, main, branch];
    const plan = planDuctRun(main, { settings, scene, building: noWalls })!;
    const elbow = plan.pieces.find((piece) => piece.kind === 'elbow')!;
    const result = cutDuctPieces(scene, [{ runId: 'main', key: 'node:1' }], { settings, building: noWalls, newId: ids() });
    const first = specOf(result.updates, 'main');
    const second = specOf(result.add, 'run-1');
    // The first leg runs −y from the collar: it now ends where the elbow began.
    expect(first.path.at(-1)!.y).toBeCloseTo(supply.lip.y - elbow.stationStartMm, 0);
    expect(first.legs).toHaveLength(1);
    expect(second.legs).toHaveLength(2);
    expect(second.path[0]!.x).toBeCloseTo(P(3000).x + (elbow.stationEndMm - 3000), 0);
    // The take-off was 1200 mm along the old second leg: on the new run's first leg, measured from the cut.
    const moved = specOf(result.updates, 'branch');
    expect(moved.start).toMatchObject({ kind: 'tap', parentRunId: 'run-1', legIndex: 0 });
    expect(moved.start.kind === 'tap' && moved.start.stationMm).toBeCloseTo(1200 - (elbow.stationEndMm - 3000), 0);
  });

  it('a take-off inside the stretch deleted: the branch starts open, remembering its parent', () => {
    const main = rectMain();
    const branch = branchOff(main);
    const result = cutDuctPieces([unit, main, branch], [{ runId: 'main', key: 'leg:1' }], { settings, building: noWalls, newId: ids() });
    const orphan = specOf(result.updates, 'branch');
    expect(orphan.start).toMatchObject({ kind: 'open', orphaned: true, gap: { partner: null, was: { kind: 'tap', parentRunId: 'main', legIndex: 1, stationMm: 1200 } } });
    // One gap in the run, and the branch counted apart.
    expect(result.gaps).toBe(1);
    expect(result.orphaned).toBe(1);
  });

  it('the canvas connector at the collar: the run starts open after it, its transition keeping the collar size', () => {
    const main = rectMain();
    const scene = [unit, main];
    const result = cutDuctPieces(scene, [{ runId: 'main', key: 'start:connector' }], { settings, building: noWalls, newId: ids() });
    expect(result.add).toHaveLength(0);
    const spec = specOf(result.updates, 'main');
    expect(spec.start).toMatchObject({ kind: 'open', gap: { partner: null, was: { kind: 'unit-port', unitId: 'fdum', portId: 'supply' } } });
    const after = [unit, ...result.updates];
    const plan = planDuctRunSpec('main', spec, { settings, scene: after, building: noWalls });
    expect(ductSegments(plan)[0]!.key).toBe('transition:0');
    expect(ductSegmentOf(plan, 'transition:0')!.size).toContain('→ 600×300');
    expect(spec.path[0]!.y).toBeLessThan(supply.lip.y - 1);
  });

  it('the end cap: the end is open and the run stays whole', () => {
    const result = cutDuctPieces([unit, rectMain()], [{ runId: 'main', key: 'end:cap' }], { settings, building: noWalls, newId: ids() });
    expect(result.add).toHaveLength(0);
    expect(specOf(result.updates, 'main').end).toEqual({ kind: 'open' });
    expect(specOf(result.updates, 'main').path).toHaveLength(4);
    expect(result.gaps).toBe(0);
  });

  it('two cuts in one run: three runs, two gaps, the take-off on the middle one', () => {
    const main = rectMain();
    const branch = branchOff(main);
    const result = cutDuctPieces([unit, main, branch], [{ runId: 'main', key: 'node:1' }, { runId: 'main', key: 'transition:2' }], { settings, building: noWalls, newId: ids() });
    expect(result.add.map((element) => element.id)).toEqual(['run-1', 'run-2']);
    expect(result.gaps).toBe(2);
    const middle = specOf(result.add, 'run-1');
    expect(middle.start).toMatchObject({ kind: 'open', gap: { partner: { runId: 'main', end: 'end' } } });
    expect(middle.end).toMatchObject({ kind: 'open', gap: { partner: { runId: 'run-2', end: 'start' } } });
    // The reduction itself was deleted: the last run starts at 500×300, with no socket.
    const last = specOf(result.add, 'run-2');
    expect(last.start.kind === 'open' && last.start.socket).toBeFalsy();
    expect(last.legs).toEqual([{ widthMm: 500, heightMm: 300 }]);
    expect(specOf(result.updates, 'branch').start).toMatchObject({ kind: 'tap', parentRunId: 'run-1' });
  });

  it('an accessory: the run stays whole without it', () => {
    const main = rectMain({ inline: [{ id: 'i1', kind: 'damper', legIndex: 1, stationMm: 1800 }] });
    const result = cutDuctPieces([unit, main], [{ runId: 'main', key: 'inline:i1' }], { settings, building: noWalls, newId: ids() });
    expect(result.add).toHaveLength(0);
    expect(result.pieces).toBe(1);
    expect(specOf(result.updates, 'main').inline).toBeUndefined();
    expect(specOf(result.updates, 'main').path).toHaveLength(4);
  });

  it("an elbow's choice and an accessory go with the part they are on", () => {
    const main = rectMain({ nodeOverrides: { 1: { elbowStyle: 'square-vaned' } }, inline: [{ id: 'i1', kind: 'damper', legIndex: 2, stationMm: 1200 }] });
    const result = cutDuctPieces([unit, main], [{ runId: 'main', key: 'leg:1' }], { settings, building: noWalls, newId: ids() });
    expect(specOf(result.updates, 'main').nodeOverrides).toEqual({ 1: { elbowStyle: 'square-vaned' } });
    const second = specOf(result.add, 'run-1');
    expect(second.nodeOverrides).toEqual({});
    expect(second.inline).toEqual([{ id: 'i1', kind: 'damper', legIndex: 0, stationMm: 1200 }]);
  });

  it('every piece deleted: the run goes and its branch is orphaned', () => {
    const main = rectMain();
    const branch = branchOff(main);
    const keys = keysOf(main, [unit, main, branch]);
    const result = cutDuctPieces([unit, main, branch], keys.map((key) => ({ runId: 'main', key })), { settings, building: noWalls, newId: ids() });
    expect(result.removeIds).toEqual(['main']);
    expect(specOf(result.updates, 'branch').start).toMatchObject({ kind: 'open', orphaned: true });
  });

  it('a locked run is refused, and says why', () => {
    const result = cutDuctPieces([unit, rectMain({ locked: true })], [{ runId: 'main', key: 'leg:1' }], { settings, building: noWalls, newId: ids() });
    expect(result.updates).toHaveLength(0);
    expect(result.refused[0]!.reason).toMatch(/locked/);
  });

  it("the branch's take-off: the branch starts open past its damper, remembering where it was taken off", () => {
    const main = rectMain();
    const branch = branchOff(main);
    const scene = [unit, main, branch];
    const before = planDuctRun(branch, { settings, scene, building: noWalls })!;
    const damperEnd = Math.max(...before.pieces.filter((piece) => piece.kind === 'damper' || piece.kind === 'takeoff').map((piece) => piece.stationEndMm));
    const result = cutDuctPieces(scene, [{ runId: 'branch', key: 'start:takeoff' }], { settings, building: noWalls, newId: ids() });
    const spec = specOf(result.updates, 'branch');
    expect(spec.start).toMatchObject({ kind: 'open', gap: { was: { kind: 'tap', parentRunId: 'main' } } });
    const original = readDuctRunSpec(branch)!;
    expect(Math.hypot(spec.path[0]!.x - original.path[0]!.x, spec.path[0]!.y - original.path[0]!.y)).toBeCloseTo(damperEnd, 0);
  });

  it('fire-damper choices follow their crossing, re-counted on the part they are now on', () => {
    // A wall crossing the first leg and the last: keys w:0 and w:1 on the whole run.
    const wall: DuctWall = { id: 'w', a: P(1000, -500), b: P(3500, 5000), thicknessMm: 100, baseZ: 0, topZ: 3500, structural: true };
    const building = { walls: [wall], rooms: [] };
    const main = rectMain({ penetrations: { 'w:1': { fireDamper: false } } });
    const result = cutDuctPieces([unit, main], [{ runId: 'main', key: 'node:1' }], { settings, building, newId: ids() });
    expect(specOf(result.updates, 'main').penetrations).toBeUndefined();
    // On the second part the crossing on the old last leg is its first one.
    expect(specOf(result.add, 'run-1').penetrations).toEqual({ 'w:0': { fireDamper: false } });
  });
});
