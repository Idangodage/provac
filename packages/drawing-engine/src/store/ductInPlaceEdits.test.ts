import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveUnitAirPorts } from '../components/canvas/hvac/duct/ductAirPorts';
import { tapOrigin } from '../components/canvas/hvac/duct/ductBranchTargets';
import { buildDuctRunDraftElement } from '../components/canvas/hvac/duct/ductDraft';
import { commitDuctRunEdit } from '../components/canvas/hvac/duct/ductEditController';
import { applyDuctRunEdit, moveDuctLegSideways, moveDuctRiser, moveDuctRunEnd, setDuctRiserRise } from '../components/canvas/hvac/duct/ductEdits';
import { getDuctRunPlan } from '../components/canvas/hvac/duct/ductFabricationPlanner';
import { ductLegs } from '../components/canvas/hvac/duct/ductGeometry';
import { DEFAULT_DUCT_SETTINGS, resolveDuctSettings } from '../components/canvas/hvac/duct/ductSettings';
import { readDuctRunSpec } from '../components/canvas/hvac/duct/ductTypes';
import type { HvacElement, Point2D } from '../types';

import { useDrawingStore } from './index';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const L = supply.lip;
const z0 = supply.lip.z - supply.heightMm / 2;
// A Z: 3 m off the collar (−Y), 4 m across (+X), 3 m on (−Y).
const zRun = buildDuctRunDraftElement({ port: supply, points: [{ x: L.x, y: L.y - 3000 }, { x: L.x + 4000, y: L.y - 3000 }, { x: L.x + 4000, y: L.y - 6000 }] }, 'z');
// A take-off on the last leg, 1500 mm along it.
const tapStart = tapOrigin(zRun, settings, { legIndex: 2, stationMm: 1500, side: 1, style: 'shoe-45', vcd: true }, { widthMm: 300, heightMm: 150 })!;
const wall = (tapStart as { point: Point2D }).point;
const tap = buildDuctRunDraftElement({ origin: tapStart, points: [{ x: wall.x + 1500, y: wall.y }], legSizes: [{ widthMm: 300, heightMm: 150 }] }, 'tap');
// 4 m off the collar, drop 600, 3 m on.
const drop = buildDuctRunDraftElement({ port: supply, points: [{ x: L.x, y: L.y - 4000 }, { x: L.x, y: L.y - 7000, z: z0 - 600 }] }, 'drop');
const specOf = (element: HvacElement) => readDuctRunSpec(element)!;

describe('in-place duct edits (pure)', () => {
  it('a leg dragged sideways stays parallel; its neighbours stretch along their own lines', () => {
    const result = moveDuctLegSideways(specOf(zRun), 1, { x: 300, y: -500 })!;
    const legs = ductLegs(result.spec);
    expect(legs.map((leg) => Math.round(leg.lengthMm))).toEqual([3500, 4000, 2500]);
    expect(result.spec.path[0]).toEqual(specOf(zRun).path[0]);
    expect(result.spec.path[3]).toEqual(specOf(zRun).path[3]);
    // The last leg's start slid 500 along it: its take-offs keep their place.
    expect(result.stationShiftByLeg.get(2)).toBeCloseTo(-500, 6);
  });

  it('the leg off a collar cannot move; the end moves along its leg; a riser along its heading', () => {
    expect(moveDuctLegSideways(specOf(zRun), 0, { x: 500, y: 0 })).toBeNull();
    const longer = moveDuctRunEnd(specOf(zRun), { x: L.x + 4200, y: L.y - 7000 })!;
    expect(ductLegs(longer.spec).at(-1)!.lengthMm).toBeCloseTo(4000, 6);
    expect(ductLegs(moveDuctRunEnd(specOf(zRun), { x: L.x + 4000, y: L.y })!.spec).at(-1)!.lengthMm).toBe(50);
    const moved = moveDuctRiser(specOf(drop), 1, { x: 0, y: -1000 })!;
    expect(ductLegs(moved.spec).map((leg) => Math.round(leg.lengthMm))).toEqual([5000, 600, 2000]);
    expect(moved.spec.path[0]).toEqual(specOf(drop).path[0]);
  });

  it('a riser\'s rise changes, and the run after it moves with it', () => {
    const result = setDuctRiserRise(specOf(drop), 1, -400)!;
    expect(result.spec.path.map((point) => Math.round(point.z - z0))).toEqual([0, 0, -400, -400]);
    expect(setDuctRiserRise(specOf(drop), 0, -400)).toBeNull();
  });

  it('the take-off keeps its place in the world when its leg\'s start slides', () => {
    const result = moveDuctLegSideways(specOf(zRun), 1, { x: 0, y: -500 })!;
    const moved = applyDuctRunEdit([unit, zRun, tap], zRun, result, settings);
    const branch = moved.find((element) => element.id === 'tap')!;
    expect(specOf(branch).start).toMatchObject({ kind: 'tap', legIndex: 2, stationMm: 1000 });
    expect(specOf(branch).path[0]!.x).toBeCloseTo(specOf(tap).path[0]!.x, 6);
    expect(specOf(branch).path[0]!.y).toBeCloseTo(specOf(tap).path[0]!.y, 6);
    const plan = getDuctRunPlan(branch, [unit, moved[0]!, branch], settings)!;
    expect(plan.issues.map((issue) => issue.code)).not.toContain('DU_STALE');
  });
});

const state = () => useDrawingStore.getState();

describe('in-place duct edits are one undo each', () => {
  beforeEach(() => {
    useDrawingStore.setState({ hvacElements: [unit, zRun, tap], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().setDuctSettings(DEFAULT_DUCT_SETTINGS);
    state().clearHistory();
  });

  afterEach(() => {
    useDrawingStore.setState({ hvacElements: [], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().clearHistory();
  });

  it('a leg drag commits the run and its take-off together; one undo restores both', () => {
    const before = state().hvacElements;
    commitDuctRunEdit('z', moveDuctLegSideways(specOf(zRun), 1, { x: 0, y: -500 })!, 'Move duct leg');
    const after = state().hvacElements;
    expect(specOf(after.find((element) => element.id === 'z')!).path[1]!.y).toBeCloseTo(L.y - 3500, 6);
    expect(specOf(after.find((element) => element.id === 'tap')!).start).toMatchObject({ stationMm: 1000 });
    state().undo();
    expect(state().hvacElements).toEqual(before);
  });
});
