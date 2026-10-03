import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../../types';
import type { ServiceCtx, TerminalCtx } from '../ductAutoContext';
import { planDuctRunSpec } from '../ductFabricationPlanner';
import { systemPressure } from '../ductPressure';
import { resolveDuctSettings } from '../ductSettings';
import { readDuctTerminalSpec, terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from '../ductTerminals';
import { roundLeg, type DuctRunSpec } from '../ductTypes';

import type { ServiceDesign } from './designTree';
import { buildRoutingGraph } from './routingGraph';
import { frontierPoints, sizeDesign } from './sizingDp';
import { SizingModel } from './sizingModel';

function fixture() {
  const spec = typicalTerminalSpec('square-4way', 200);
  const envelope = terminalEnvelope(spec);
  const element: HvacElement = {
    id: 'terminal', type: 'diffuser', rotation: 270,
    position: { x: 2500 - envelope.widthMm / 2, y: 400 - envelope.depthMm / 2 },
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
    elevation: 2400, mountType: 'ceiling', label: 'Diffuser', supplyZoneRatio: 0.5,
    properties: { terminal: spec },
  };
  const port = terminalSpigotPort(element)!;
  const terminal: TerminalCtx = {
    element, spec: readDuctTerminalSpec(element)!, port, lip: port.lip, normal: port.normal,
    airflowM3h: 300, fixed: true, neck: 200, branch: 200,
  };
  const ctx: ServiceCtx = {
    service: 'supply', unitId: 'unit', frame: { origin: { x: 0, y: 0 }, n: { x: 1, y: 0 }, t: { x: 0, y: 1 } },
    port: { ...port, unitId: 'unit', portId: 'supply', lip: { x: 0, y: 0, z: port.lip.z }, normal: { x: 1, y: 0 } },
    bottomZ: port.lip.z - 100, terminals: [terminal], airflowM3h: 300, baseScene: [element],
    settings: resolveDuctSettings({ soffitMm: 3200, autoRoundSizesMm: [200], flexibleConnectorAtUnit: false }),
    obstacles: [], maxHeightMm: 600, construction: 'gi-bare', ids: () => 'run',
  };
  return { ctx, terminal, model: new SizingModel(ctx, 'round', 300), end: { x: 1200, y: 0 }, out: { x: 1, y: 0 } };
}

describe('curved flex pressure in candidate sizing', () => {
  it('agrees with the fabricated curve and distinguishes bends from straight flex of the same length', () => {
    const { ctx, terminal, model, end, out } = fixture();
    const fit = model.flexRunout(end, out, terminal);
    const curved = model.flex(200, 300, fit.lengthMm, fit.bendLossPa);
    const straight = model.flex(200, 300, fit.lengthMm);
    expect(curved.cost).toBe(straight.cost);
    expect(curved.loss).toBeGreaterThan(straight.loss + 0.5);

    const run: DuctRunSpec = {
      version: 1, service: 'supply', construction: 'gi-bare',
      path: [{ x: 0, y: 0, z: ctx.bottomZ }, { ...end, z: ctx.bottomZ }, { ...terminal.lip, z: ctx.bottomZ }],
      legs: [roundLeg(200), roundLeg(200)], insulationThicknessMm: 0, pressureClassPa: null, jointSystem: null,
      start: { kind: 'open' }, end: { kind: 'terminal', terminalId: terminal.element.id, portId: 'spigot', flex: true },
      nodeOverrides: {}, locked: false,
    };
    const plan = planDuctRunSpec('run', run, { settings: ctx.settings, scene: ctx.baseScene });
    expect(plan.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    const verified = systemPressure([plan], new Map([[terminal.element.id, 300]]), ctx.settings, 'supply');
    expect(verified.indexPa).toBeCloseTo(model.friction(roundLeg(200), 300, 1200) + curved.loss + model.terminalDropPa, 8);
    const reduced = model.flexRunout(end, out, terminal, 180);
    const reducedPressure = systemPressure([plan], new Map([[terminal.element.id, 180]]), ctx.settings, 'supply');
    expect(reducedPressure.indexPa).toBeCloseTo(model.friction(roundLeg(200), 180, 1200)
      + model.flex(200, 180, reduced.lengthMm, reduced.bendLossPa).loss + model.terminalDropPa, 8);
  });

  it('includes the known bend loss in the sizing frontier pressure budget', () => {
    const { ctx, terminal, model, end, out } = fixture();
    const design: ServiceDesign = {
      label: 'Curved terminal runout', source: 'seed', fanOutletMm: 1200, penalty: 0, notes: [],
      root: { key: 'root', start: { kind: 'unit' }, vertices: [{ x: 0, y: 0 }, end], taps: [],
        end: { kind: 'terminal', terminal }, airflowM3h: 300, allFlex: false },
    };
    const straightModel = new SizingModel(ctx, 'round', 300);
    straightModel.flexRunout = (...args) => ({ ...model.flexRunout(...args), bendLossPa: 0 });
    const grid = { stepPa: 0.01, size: 8000 };
    const curved = sizeDesign(design, model, grid)!;
    const straight = sizeDesign(design, straightModel, grid)!;
    expect(curved).not.toBeNull();
    expect(straight).not.toBeNull();
    const difference = (frontierPoints(curved.cost)[0]!.index - frontierPoints(straight.cost)[0]!.index) * grid.stepPa;
    expect(difference).toBeGreaterThan(0.5);
    expect(Math.abs(difference - model.flexRunout(end, out, terminal).bendLossPa)).toBeLessThan(grid.stepPa * 2);
  });

  it('retains curved runout pressure on routing graph leaves', () => {
    const { ctx, model } = fixture();
    const graph = buildRoutingGraph(ctx, model, 900);
    const leaves = graph.leaves.flat();
    expect(leaves.length).toBeGreaterThan(0);
    expect(leaves.every((leaf) => Number.isFinite(leaf.flexBendLossPa))).toBe(true);
    expect(leaves.some((leaf) => leaf.flexBendLossPa! > 0.5)).toBe(true);
  });
});
