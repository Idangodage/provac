import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import type { ServiceCtx } from './ductAutoContext';
import {
  chooseRectangularDesign, generateAutoDuct, generateAutoDuctInShape, inspectAutoDuctContexts, RECTANGULAR_COST_LIMIT,
  type AutoDuctResult, type AutoDuctShape,
} from './ductAutoLayout';
import { planDuctRunSpec } from './ductFabricationPlanner';
import { DEFAULT_DUCT_SETTINGS, resolveDuctSettings } from './ductSettings';
import { withInitialSizingRecords } from './ductSizingRecord';
import { shapePhrase, systemRedesignSummary, systemRedesignTarget, unitDuctFigures, unitDuctShape, withRedesignApplied } from './ductSystemRedesign';
import { defaultSizingBasis, sizingOutcomeLine } from './ductSystemSizing';
import { terminalEnvelope, typicalTerminalSpec } from './ductTerminals';
import { appraiseDuctSystem, ductSystemFigures, turnRedesignCommand, turnRedesignTargets } from './ductTurnRedesign';
import { isRoundLeg, readDuctRunSpec, readDuctSizingRecord, type DuctRunSpec } from './ductTypes';
import { buildRoutingGraph, ROUTE_CLEARANCE_MM } from './optimizer/routingGraph';
import { endLegNeedMm, END_TRANSITION_MIN_LEG_MM } from './optimizer/sizingDp';
import { SizingModel } from './optimizer/sizingModel';

function fdum(id: string): HvacElement {
  return {
    id, type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
    elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W', airSystemTag: 'DU-1' },
  };
}
function diffuser(id: string, centre: Point2D, rotation: number): HvacElement {
  const spec = typicalTerminalSpec('square-4way', 200);
  const envelope = terminalEnvelope(spec);
  return {
    id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId: 'r', properties: { terminal: spec },
  };
}
const unit = fdum('fdum');
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
/** Ahead of the supply collar by `along`, across it by `across`. */
const at = (along: number, across: number): Point2D => ({ x: supply.lip.x + across, y: supply.lip.y - along });
/** A row of four diffusers across the collar's axis, `along` out. */
const rowAt = (along: number) => [diffuser('d1', at(along, -3600), 0), diffuser('d2', at(along, -1200), 0), diffuser('d3', at(along, 1200), 0), diffuser('d4', at(along, 3600), 0)];
const row = rowAt(2800);
const scene = [unit, ...row];
/** The same row 4,000 mm out: room for a rectangular branch's square-to-round before each runout. */
const roomy = [unit, ...rowAt(4000)];

function design(shape: AutoDuctShape, settings = DEFAULT_DUCT_SETTINGS, drawing: readonly HvacElement[] = scene, generate = generateAutoDuct) {
  return generate(drawing, {
    unitId: 'fdum', terminalIds: ['d1', 'd2', 'd3', 'd4'], fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: false },
    rebuildExisting: false, shape, sizing: { supply: defaultSizingBasis(settings, 'supply', null, 'hi') },
  }, settings);
}
const specsOf = (runs: readonly HvacElement[]) => runs.map((run) => readDuctRunSpec(run)!);
/** A design as Apply leaves it: the spigots it turned, its runs with their sizing records. */
function applied(result: AutoDuctResult, drawing: readonly HvacElement[]): HvacElement[] {
  const runs = withInitialSizingRecords({
    fanSpeed: result.fanSpeed, airflowM3h: result.airflowM3h, airflowSource: result.airflowSource, runs: result.runs,
    removeIds: result.removeIds, terminalUpdates: result.terminalUpdates, services: result.services, shape: result.shape,
  }, drawing, DEFAULT_DUCT_SETTINGS, 'auto-duct');
  const turned = new Map(result.terminalUpdates.map((element) => [element.id, element]));
  return [...drawing.map((element) => turned.get(element.id) ?? element), ...runs];
}
/** The run with its spec changed by `change`. */
const withSpec = (run: HvacElement, change: (spec: DuctRunSpec) => DuctRunSpec): HvacElement => ({
  ...run, properties: { ...run.properties, ductRun: change(readDuctRunSpec(run)!) },
});
/** A run's rigid legs (its flexible runout left out). */
const rigidLegs = (spec: DuctRunSpec) => (spec.end.kind === 'terminal' && spec.end.flex ? spec.legs.slice(0, -1) : spec.legs);

describe('the project\'s sizing and fabrication settings', () => {
  it('sizes by constant friction by default, on 50 mm rectangular steps (25 or 100 to choose)', () => {
    expect(DEFAULT_DUCT_SETTINGS.autoSizingMethod).toBe('constant-friction');
    expect(DEFAULT_DUCT_SETTINGS.rectStepMm).toBe(50);
    expect(resolveDuctSettings({ rectStepMm: 100 }).rectStepMm).toBe(100);
    expect(resolveDuctSettings({ rectStepMm: 25 }).rectStepMm).toBe(25);
    expect(resolveDuctSettings({ rectStepMm: 30 as never }).rectStepMm).toBe(50);
    expect(resolveDuctSettings({ autoSizingMethod: 'life-cycle' }).autoSizingMethod).toBe('life-cycle');
  });

  it('every rectangle a design is sized to sits on the step', () => {
    const settings = resolveDuctSettings({ rectStepMm: 100 });
    const result = design('rect', settings);
    expect(result.runs.length).toBeGreaterThan(0);
    for (const spec of specsOf(result.runs)) {
      for (const leg of rigidLegs(spec)) {
        if (isRoundLeg(leg)) continue;
        // (A section carried from the collar keeps the collar's own size.)
        if (leg.widthMm === supply.widthMm && leg.heightMm === supply.heightMm) continue;
        expect(leg.widthMm % 100, JSON.stringify(leg)).toBe(0);
        expect(leg.heightMm % 100, JSON.stringify(leg)).toBe(0);
      }
    }
  }, 120000);
});

describe('a system rectangular throughout', () => {
  it('rectangular branches off shoe take-offs or Y splits; at each terminal a square-to-round to its neck, then its flexible runout', () => {
    const result = design('rectangular', DEFAULT_DUCT_SETTINGS, roomy);
    expect(result.shape).toBe('rectangular');
    expect(result.runs.length).toBeGreaterThan(0);
    expect(result.designs[result.selected]!.errors).toBe(0);
    // The drawing as the design leaves it: the spigots it turned, its runs.
    const turned = new Map(result.terminalUpdates.map((element) => [element.id, element]));
    const all = [...roomy.map((element) => turned.get(element.id) ?? element), ...result.runs];
    const specs = specsOf(result.runs);
    const served = new Set(specs.flatMap((spec) => (spec.end.kind === 'terminal' ? [spec.end.terminalId] : [])));
    expect([...served].sort()).toEqual(['d1', 'd2', 'd3', 'd4']);
    for (const [index, spec] of specs.entries()) {
      const legs = rigidLegs(spec);
      if (spec.start.kind === 'tap') expect(spec.start.style).toBe('shoe-45');
      if (spec.end.kind === 'terminal') {
        // Rectangular, then (the square-to-round) the neck's round, then the flexible runout.
        expect(legs.length).toBeGreaterThanOrEqual(2);
        expect(isRoundLeg(legs[legs.length - 1]!)).toBe(true);
        expect(legs.slice(0, -1).every((leg) => !isRoundLeg(leg))).toBe(true);
      } else {
        expect(legs.every((leg) => !isRoundLeg(leg))).toBe(true);
      }
      const plan = planDuctRunSpec(result.runs[index]!.id, spec, { settings: DEFAULT_DUCT_SETTINGS, scene: all });
      expect(plan.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code)).toEqual([]);
    }
  }, 120000);

  it('where the terminals leave no room for its branches\' square-to-rounds, a rectangular main with round branches instead, and it says so', () => {
    const result = design('rectangular', DEFAULT_DUCT_SETTINGS, scene, generateAutoDuctInShape);
    expect(result.shape).toBe('rect');
    expect(result.designs[result.selected]!.errors).toBe(0);
    expect(result.issues[0]).toMatchObject({ code: 'DU_AUTO_SHAPE', severity: 'info' });
    expect(result.issues[0]!.message).toMatch(/^No clean layout rectangular throughout fits these terminals/);
  }, 240000);

  it('kept where it is clean at a sensible cost; past RECTANGULAR_COST_LIMIT times a rectangular main with round branches, that instead, with the figures', () => {
    const shown = (shape: AutoDuctShape, firstCost: number, errors = 0) => ({
      shape, runs: [unit], selected: 0, designs: [{ firstCost, errors }], issues: [], baseIssues: [], currency: 'USD',
    }) as unknown as AutoDuctResult;
    const alternative = shown('rect', 600);
    expect(chooseRectangularDesign(shown('rectangular', 700), alternative).shape).toBe('rectangular');
    expect(chooseRectangularDesign(shown('rectangular', 600 * RECTANGULAR_COST_LIMIT), alternative).shape).toBe('rectangular');
    const wound = chooseRectangularDesign(shown('rectangular', 1140), alternative);
    expect(wound.shape).toBe('rect');
    expect(wound.issues[0]).toEqual({
      code: 'DU_AUTO_SHAPE', severity: 'info',
      message: 'Rectangular throughout would cost USD 1,140 here, 1.9 times a rectangular main with round branches (USD 600): its branches would wind round to reach the terminals\' spigots straight. Designed with a rectangular main and round branches instead.',
    });
    // Kept with the result's own issues: still said when another of its designs is shown.
    expect(wound.baseIssues[0]).toEqual(wound.issues[0]);
    expect(chooseRectangularDesign(shown('rectangular', 700, 2), alternative).issues[0]!.message).toMatch(/^No clean layout rectangular throughout/);
    // Neither clean: the rectangular attempt, with its own issues.
    expect(chooseRectangularDesign(shown('rectangular', 700, 2), shown('rect', 600, 1)).shape).toBe('rectangular');
  });
});

describe('in a 6.5 × 4.7 m room (the walls round it)', () => {
  // The project's room: the unit 2.8 m from the wall its collar faces.
  const roomUnit: HvacElement = { ...unit, position: { x: 5053.94, y: 4242.02 } };
  const lip = resolveUnitAirPorts(roomUnit).find((port) => port.kind === 'supply')!.lip;
  const walls = [
    { id: 'w1', startPoint: { x: 2300, y: 1350 }, endPoint: { x: 8900, y: 1350 }, thickness: 150 },
    { id: 'w2', startPoint: { x: 8900, y: 1350 }, endPoint: { x: 8900, y: 6150 }, thickness: 150 },
    { id: 'w3', startPoint: { x: 8900, y: 6150 }, endPoint: { x: 2300, y: 6150 }, thickness: 150 },
    { id: 'w4', startPoint: { x: 2300, y: 6150 }, endPoint: { x: 2300, y: 1350 }, thickness: 150 },
  ];
  const rooms = [{ id: 'r', vertices: [{ x: 2375, y: 1425 }, { x: 8825, y: 1425 }, { x: 8825, y: 6075 }, { x: 2375, y: 6075 }] }];
  const roomDesign = (spots: Array<[number, number]>) => {
    const terminals = spots.map(([along, across], index) => diffuser(`d${index + 1}`, { x: lip.x + across, y: lip.y - along }, 0));
    const drawing = [roomUnit, ...terminals];
    const result = generateAutoDuctInShape(drawing, {
      unitId: 'fdum', terminalIds: terminals.map((terminal) => terminal.id), fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: false },
      rebuildExisting: false, shape: 'rectangular', sizing: { supply: defaultSizingBasis(DEFAULT_DUCT_SETTINGS, 'supply', null, 'hi') }, walls, rooms,
    }, DEFAULT_DUCT_SETTINGS);
    return { result, drawing };
  };

  it('two diffusers either side: rectangular throughout, a shoe take-off and a straight branch, clean', () => {
    const { result } = roomDesign([[2300, -2600], [2300, 2600]]);
    expect(result.shape).toBe('rectangular');
    expect(result.designs[result.selected]!.errors).toBe(0);
    const specs = specsOf(result.runs);
    expect(specs.filter((spec) => spec.start.kind === 'tap').every((spec) => spec.start.kind === 'tap' && spec.start.style === 'shoe-45')).toBe(true);
    // Nothing runs back past the unit's face.
    for (const spec of specs) for (const point of spec.path) expect(lip.y - point.y).toBeGreaterThan(-1);
  }, 240000);

  it('four in a row 2.2 m out: no room for four square-to-rounds, so a rectangular main with round branches, and it says so', () => {
    const { result } = roomDesign([[2200, -2400], [2200, -800], [2200, 800], [2200, 2400]]);
    expect(result.shape).toBe('rect');
    expect(result.designs[result.selected]!.errors).toBe(0);
    expect(result.issues[0]).toMatchObject({ code: 'DU_AUTO_SHAPE' });
  }, 240000);
});

describe('the router and the sizing build what the realiser builds', () => {
  /** The service's context for a drawing (the design stopped once it is made). */
  function contextOf(drawing: readonly HvacElement[], terminalIds: string[]): ServiceCtx {
    let captured: ServiceCtx | null = null;
    inspectAutoDuctContexts((ctx) => { captured = ctx; throw new Error('captured'); });
    try {
      generateAutoDuct(drawing, {
        unitId: 'fdum', terminalIds, fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: false }, rebuildExisting: false, shape: 'rectangular',
      }, DEFAULT_DUCT_SETTINGS);
    } catch {
      // Stopped on purpose: only the context is wanted.
    } finally {
      inspectAutoDuctContexts(null);
    }
    return captured!;
  }

  it('no route runs along the unit\'s face or through its casing', () => {
    const ctx = contextOf(scene, ['d1', 'd2', 'd3', 'd4']);
    const model = new SizingModel(ctx, 'rectangular', ctx.airflowM3h);
    const graph = buildRoutingGraph(ctx, model, 1000, 600);
    const casing = ctx.obstacles.find((box) => box.id === 'fdum')!;
    expect(graph.roots.length).toBeGreaterThan(0);
    for (let node = 0; node < graph.nodeCount; node += 1) {
      const x = graph.nodeX[node]!;
      const y = graph.nodeY[node]!;
      const inCasing = x > casing.minX - ROUTE_CLEARANCE_MM && x < Math.min(casing.maxX, -1) + ROUTE_CLEARANCE_MM && y > casing.minY - ROUTE_CLEARANCE_MM && y < casing.maxY + ROUTE_CLEARANCE_MM;
      expect(inCasing, `node at ${Math.round(x)}, ${Math.round(y)}`).toBe(false);
    }
  });

  it('a rectangular branch\'s last leg holds exactly what the realiser lays: the shoe\'s collar and damper, or the last bend, then the square-to-round and its lead', () => {
    const ctx = contextOf(scene, ['d1', 'd2', 'd3', 'd4']);
    const rectangular = new SizingModel(ctx, 'rectangular', ctx.airflowM3h);
    const rect = new SizingModel(ctx, 'rect', ctx.airflowM3h);
    const leg = { widthMm: 150, heightMm: 150 };
    const s = DEFAULT_DUCT_SETTINGS;
    const straight = { start: { kind: 'tap' as const }, vertices: [{ x: 0, y: 0 }, { x: 0, y: 900 }] };
    const fromTap = rectangular.collarLengthMm('shoe-45', leg) + s.vcdLengthMm + 100 + rectangular.endStraightMm(leg, 200);
    expect(endLegNeedMm(straight, leg, 200, rectangular)).toBeCloseTo(fromTap, 6);
    // After a bend: its setback, neck and margin.
    const bent = { start: { kind: 'tap' as const }, vertices: [{ x: 0, y: 0 }, { x: 0, y: 900 }, { x: 600, y: 900 }] };
    expect(endLegNeedMm(bent, leg, 200, rectangular)).toBeCloseTo(rectangular.elbowRadiusMm(leg) + s.elbowNeckMm + 25 + rectangular.endStraightMm(leg, 200), 6);
    // A split outlet's branch: its collar, no damper, and no floor. (The other shapes keep the rule their designs were tuned to.)
    const outlet = { ...straight, start: { kind: 'split' as const, side: 1 as const } };
    const fromOutlet = rectangular.collarLengthMm('spin-in', leg) + 100 + rectangular.endStraightMm(leg, 200);
    expect(fromOutlet).toBeLessThan(END_TRANSITION_MIN_LEG_MM);
    expect(endLegNeedMm(outlet, leg, 200, rectangular)).toBeCloseTo(fromOutlet, 6);
    expect(endLegNeedMm(outlet, leg, 200, rect)).toBe(Math.max(END_TRANSITION_MIN_LEG_MM, s.tapCollarMm + s.vcdLengthMm + 100 + rect.endStraightMm(leg, 200)));
    // At the neck's own size: no fitting, nothing to hold.
    expect(endLegNeedMm(straight, { widthMm: 200, heightMm: 200, diameterMm: 200 }, 200, rectangular)).toBe(0);
  });
});

describe('the system remembers its shape', () => {
  let drawnOnce: HvacElement[] | null = null;
  /** The roomy row designed rectangular throughout, applied (once: the tests share it). */
  const drawn = () => drawnOnce ??= applied(design('rectangular', DEFAULT_DUCT_SETTINGS, roomy), roomy);
  const rootOf = (elements: readonly HvacElement[]) => elements.find((element) => readDuctRunSpec(element)?.start.kind === 'unit-port')!;

  it('its record keeps the shape it was designed in; a re-design (after a turn) asks for the same', () => {
    const record = readDuctRunSpec(rootOf(drawn()))!.initialSizing!;
    expect(record.shape).toBe('rectangular');
    // Stored and read back.
    expect(readDuctSizingRecord(JSON.parse(JSON.stringify(record)))?.shape).toBe('rectangular');
    const { targets } = turnRedesignTargets(drawn(), drawn(), new Set(['fdum']), new Set(), DEFAULT_DUCT_SETTINGS);
    expect(targets[0]!.request.shape).toBe('rectangular');
  }, 120000);

  it('the unit\'s card reads the shape off the system: as designed, else off its trunk; none without ducts', () => {
    expect(unitDuctShape(drawn(), 'fdum')).toBe('rectangular');
    // A system designed before the shape was kept.
    const unrecorded = drawn().map((element) => (readDuctRunSpec(element)?.initialSizing
      ? withSpec(element, (spec) => ({ ...spec, initialSizing: { ...spec.initialSizing!, shape: undefined } })) : element));
    expect(unitDuctShape(unrecorded, 'fdum')).toBe('rect');
    expect(unitDuctShape(roomy, 'fdum')).toBeNull();
  }, 120000);

  it('"Re-design as" asks for the system as it was set, in the shape chosen; it says why when it cannot', () => {
    const asked = systemRedesignTarget(drawn(), 'fdum', 'round', DEFAULT_DUCT_SETTINGS);
    if (!('target' in asked)) throw new Error(asked.reason);
    const runIds = drawn().filter((element) => readDuctRunSpec(element)).map((element) => element.id);
    expect(asked.target.unitName).toBe('DU-1');
    expect([...asked.target.runIds].sort()).toEqual([...runIds].sort());
    expect(asked.target.request).toMatchObject({ unitId: 'fdum', shape: 'round', rebuildExisting: true, services: { supply: true, return: false } });
    expect([...asked.target.request.terminalIds].sort()).toEqual(['d1', 'd2', 'd3', 'd4']);
    // Its own basis comes along (constant friction, as it was sized).
    expect(asked.target.request.sizing?.supply).toBeDefined();
    expect(systemRedesignTarget(roomy, 'fdum', 'round', DEFAULT_DUCT_SETTINGS)).toEqual({ reason: 'It has no ducts serving terminals to re-design' });
    const locked = drawn().map((element) => (element.id === runIds[0] ? withSpec(element, (spec) => ({ ...spec, locked: true })) : element));
    expect(systemRedesignTarget(locked, 'fdum', 'round', DEFAULT_DUCT_SETTINGS)).toEqual({ reason: 'DU-1\'s ducts include a locked run: unlock it to re-design them' });
  }, 120000);

  it('re-designed as round: one command replaces its runs, the new system keeps its shape, and a sentence says what changed', () => {
    const scene = drawn();
    const asked = systemRedesignTarget(scene, 'fdum', 'round', DEFAULT_DUCT_SETTINGS);
    if (!('target' in asked)) throw new Error(asked.reason);
    const { target } = asked;
    const result = generateAutoDuctInShape(scene, target.request, DEFAULT_DUCT_SETTINGS);
    expect(result.shape).toBe('round');
    expect(result.designs[result.selected]!.errors).toBe(0);
    const command = turnRedesignCommand(scene, result, target, DEFAULT_DUCT_SETTINGS, '2026-10-21T09:00:00.000Z');
    expect(command.removeIds).toEqual(expect.arrayContaining(target.runIds));
    const next = withRedesignApplied(scene, command);
    expect(next.some((element) => target.runIds.includes(element.id) && !command.add.some((added) => added.id === element.id))).toBe(false);
    expect(unitDuctShape(next, 'fdum')).toBe('round');
    expect(isRoundLeg(readDuctRunSpec(rootOf(next))!.legs[0])).toBe(true);
    const settings = DEFAULT_DUCT_SETTINGS;
    const before = appraiseDuctSystem(scene, target.runIds, settings, result.pricePerPa);
    const after = appraiseDuctSystem(next, command.add.map((element) => element.id), settings, result.pricePerPa);
    expect(after.errors).toEqual([]);
    const summary = systemRedesignSummary(target.unitName, result.shape,
      { figures: unitDuctFigures(scene, target.runIds, settings), appraisal: before },
      { figures: ductSystemFigures(next, command.add, settings), appraisal: after }, result.currency);
    expect(summary).toMatch(/^DU-1's ducts re-designed as round: \d+\.\d m of duct \(was \d+\.\d m\), \d+ elbows? \(was \d+\), \d+ Pa for the fan \(was \d+ Pa\), first cost [A-Z]{3} [\d,]+ \(was [A-Z]{3} [\d,]+\)\.$/);
  }, 240000);
});

describe('what the cards and the status say', () => {
  it('a re-design\'s command applied as the store applies it: removed, added, updates merged into the properties', () => {
    const a: HvacElement = { ...unit, id: 'a', properties: { keep: 1, change: 1 } };
    const b: HvacElement = { ...unit, id: 'b' };
    const c: HvacElement = { ...unit, id: 'c' };
    const next = withRedesignApplied([a, b], {
      add: [c], removeIds: ['b'], updates: [{ id: 'a', updates: { rotation: 90, properties: { change: 2 } } }], notes: [], after: { lengthMm: 0, elbows: 0 },
    });
    expect(next.map((element) => element.id)).toEqual(['a', 'c']);
    expect(next[0]).toMatchObject({ rotation: 90, properties: { keep: 1, change: 2 } });
  });

  it('names each shape as the status does', () => {
    expect(shapePhrase('rectangular')).toBe('as rectangular');
    expect(shapePhrase('round')).toBe('as round');
    expect(shapePhrase('rect')).toBe('with a rectangular main and round branches');
    expect(shapePhrase('optimal')).toBe('in the optimiser\'s mix of shapes');
  });

  it('what a re-design changed, each figure against what it was', () => {
    const appraisal = (firstCost: number, espPa: number) => ({ errors: [], firstCost, espPa, lifeCycleCost: firstCost });
    expect(systemRedesignSummary('DU-1', 'rectangular',
      { figures: { lengthMm: 12_840, elbows: 7 }, appraisal: appraisal(1180.4, 91.6) },
      { figures: { lengthMm: 14_210, elbows: 1 }, appraisal: appraisal(1240, 86.2) }, 'USD'))
      .toBe('DU-1\'s ducts re-designed as rectangular: 14.2 m of duct (was 12.8 m), 1 elbow (was 7), 86 Pa for the fan (was 92 Pa), first cost USD 1,240 (was USD 1,180).');
  });

  it('a sized system in a line: its basis, airflow, trunk from collar to end, its reducers and the fastest air', () => {
    const section = (runId: string, fromMm: number, leg: { widthMm: number; heightMm: number; diameterMm?: number }, velocityMs: number) => ({
      runId, runLabel: runId, fromMm, toMm: fromMm + 1000, airflowM3h: 600, part: 'trunk' as const, section: leg, velocityMs, frictionPaPerM: 0.8, setBy: 'friction' as const,
    });
    const report = {
      rootRunId: 'main', basis: { ...defaultSizingBasis(DEFAULT_DUCT_SETTINGS, 'supply', 600, 'hi'), frictionPaPerM: 0.8 }, airflowM3h: 600, terminalsAirflowM3h: 600,
      sections: [
        section('main', 0, { widthMm: 400, heightMm: 250 }, 3.6), section('main', 1000, { widthMm: 400, heightMm: 250 }, 3.1),
        section('main', 2000, { widthMm: 350, heightMm: 250 }, 2.9), section('main', 3000, { widthMm: 300, heightMm: 250 }, 2.4),
        section('branch', 0, { widthMm: 200, heightMm: 200, diameterMm: 200 }, 4.2),
      ],
    };
    expect(sizingOutcomeLine(report)).toBe('Constant friction 0.80 Pa/m · 600 m³/h · trunk 400×250 → 300×250 · 2 reducers · max 4.2 m/s');
    // The run on to the last terminal (carrying one) is not the trunk.
    const onToLast = { ...section('main', 4000, { widthMm: 200, heightMm: 200, diameterMm: 200 }, 2.1), part: 'branch' as const };
    expect(sizingOutcomeLine({ ...report, sections: [...report.sections, onToLast] }))
      .toBe('Constant friction 0.80 Pa/m · 600 m³/h · trunk 400×250 → 300×250 · 2 reducers · max 4.2 m/s');
    // One section through it; the airflow the terminals add up to when the system has none of its own.
    expect(sizingOutcomeLine({ ...report, airflowM3h: null, sections: report.sections.slice(0, 2) }))
      .toBe('Constant friction 0.80 Pa/m · 600 m³/h · trunk 400×250 · 0 reducers · max 3.6 m/s');
  });
});
