import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveUnitAirPorts } from '../components/canvas/hvac/duct/ductAirPorts';
import { findReattachTarget, tapOrigin } from '../components/canvas/hvac/duct/ductBranchTargets';
import { buildDuctRunDraftElement } from '../components/canvas/hvac/duct/ductDraft';
import { commitDuctRunMove, commitDuctRunSpec, reattachDuctRun } from '../components/canvas/hvac/duct/ductEditController';
import { getDuctRunPlan } from '../components/canvas/hvac/duct/ductFabricationPlanner';
import { moveDuctRuns } from '../components/canvas/hvac/duct/ductFollow';
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
const main = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 6000 }] }, 'main');
const tapStart = tapOrigin(main, settings, { legIndex: 0, stationMm: 3000, side: 1, style: 'shoe-45', vcd: true }, { widthMm: 300, heightMm: 150 })!;
const wall = (tapStart as { point: Point2D }).point;
const tap = buildDuctRunDraftElement({ origin: tapStart, points: [{ x: wall.x + 2000, y: wall.y }], legSizes: [{ widthMm: 300, heightMm: 150 }] }, 'tap');
const state = () => useDrawingStore.getState();
const spec = (id: string) => readDuctRunSpec(state().hvacElements.find((element) => element.id === id)!)!;

describe('duct edits are one undo each, and branches follow', () => {
  beforeEach(() => {
    useDrawingStore.setState({ hvacElements: [unit, main, tap], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().setDuctSettings(DEFAULT_DUCT_SETTINGS);
    state().clearHistory();
  });

  afterEach(() => {
    useDrawingStore.setState({ hvacElements: [], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().clearHistory();
  });

  it('a leg size edit re-anchors the take-off in the same command', () => {
    const before = state().hvacElements;
    commitDuctRunSpec(main, { ...readDuctRunSpec(main)!, legs: [{ widthMm: 800, heightMm: 164 }] }, 'Duct leg 1 size');
    expect(spec('main').legs[0]!.widthMm).toBe(800);
    expect(spec('tap').path[0]!.x).toBeGreaterThan(readDuctRunSpec(tap)!.path[0]!.x + 60);
    state().undo();
    expect(state().hvacElements).toEqual(before);
  });

  it('a take-off slides along its parent when moved; a unit-collar run refuses', () => {
    const slid = moveDuctRuns([unit, main, tap], ['tap'], { x: 500, y: -400 }, settings);
    expect(slid.refused).toBeNull();
    const moved = readDuctRunSpec(slid.moved[0]!)!;
    // The main runs −Y, so only the −400 along it counts: station 3000 → 3400, still on the wall.
    expect(moved.start).toMatchObject({ kind: 'tap', stationMm: 3400 });
    expect(moved.path[0]!.x).toBeCloseTo(readDuctRunSpec(tap)!.path[0]!.x, 6);
    expect(moved.path[0]!.y).toBeCloseTo(readDuctRunSpec(tap)!.path[0]!.y - 400, 6);
    const refused = moveDuctRuns([unit, main, tap], ['main'], { x: 100, y: 0 }, settings);
    expect(refused.moved).toEqual([]);
    expect(refused.refused).toMatch(/unit collar/);
  });

  it('commits a run move as one undo', () => {
    const before = state().hvacElements;
    commitDuctRunMove(['tap'], { x: 0, y: -400 });
    expect(spec('tap').start).toMatchObject({ stationMm: 3400 });
    state().undo();
    expect(state().hvacElements).toEqual(before);
  });

  it('an orphan re-attaches as a take-off on the run wall behind its start', () => {
    // Delete the main, redraw it, then re-attach the orphan to the new main.
    useDrawingStore.setState({ selectedElementIds: ['main'], selectedIds: ['main'] });
    state().deleteSelectedElements();
    const orphan = state().hvacElements.find((element) => element.id === 'tap')!;
    expect(readDuctRunSpec(orphan)!.start).toEqual({ kind: 'open', orphaned: true });
    state().commitHvacElementCommand('Draw duct run', { add: [buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 6000 }] }, 'main2')] });
    const target = findReattachTarget(orphan, state().hvacElements, settings, { style: 'shoe-45', vcd: true });
    expect(target?.parent.id).toBe('main2');
    const historyBefore = state().hvacElements;
    expect(reattachDuctRun(orphan, { style: 'shoe-45', vcd: true })).toBe(true);
    expect(spec('tap').start).toMatchObject({ kind: 'tap', parentRunId: 'main2', stationMm: 3000, side: 1 });
    const plan = getDuctRunPlan(state().hvacElements.find((element) => element.id === 'tap')!, state().hvacElements, settings)!;
    expect(plan.issues.filter((issue) => issue.code === 'DU_STALE' || issue.code === 'DU_OPEN_END')).toEqual([]);
    state().undo();
    expect(state().hvacElements).toEqual(historyBefore);
  });

  it('a sheet override must be stocked and at least the SMACNA minimum', () => {
    const heavier = getDuctRunPlan({ ...main, properties: { ...main.properties, ductRun: { ...readDuctRunSpec(main)!, gaugeOverrideMm: 1.0 } } }, [unit], settings)!;
    expect(heavier.constructionByLeg[0]!.sheetThicknessMm).toBe(1.0);
    const light = getDuctRunPlan({ ...main, properties: { ...main.properties, ductRun: { ...readDuctRunSpec(main)!, gaugeOverrideMm: 0.5 } } }, [unit], settings)!;
    expect(light.issues.find((issue) => issue.code === 'DU_GAUGE_OVERRIDE')?.severity).toBe('error');
    const unstocked = getDuctRunPlan({ ...main, properties: { ...main.properties, ductRun: { ...readDuctRunSpec(main)!, gaugeOverrideMm: 0.9 } } }, [unit], settings)!;
    expect(unstocked.issues.find((issue) => issue.code === 'DU_GAUGE_OVERRIDE')?.message).toMatch(/not in the stock list/);
  });
});
