import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../../types';
import { resolveUnitAirPorts } from '../ductAirPorts';
import { type ServiceCtx, type TerminalCtx } from '../ductAutoContext';
import { buildDuctRunDraftElement } from '../ductDraft';
import { planDuctRunSpec } from '../ductFabricationPlanner';
import { resolveDuctSettings } from '../ductSettings';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from '../ductTerminals';
import { readDuctRunSpec, roundLeg } from '../ductTypes';

import { extendTerminalApproach } from './realiseDesign';
import { SizingModel } from './sizingModel';

function fixture() {
  const unit: HvacElement = { id: 'fdum', type: 'ducted-ac', position: { x: -890.5, y: -231.5 }, rotation: 90,
    width: 1084, depth: 697, height: 300, elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
    properties: { modelCode: 'FDUM22KXE6F-W' } };
  const port = resolveUnitAirPorts(unit).find(candidate => candidate.kind === 'supply')!;
  const spec = typicalTerminalSpec('square-4way', 200);
  const envelope = terminalEnvelope(spec);
  const element: HvacElement = { id: 'terminal', type: 'diffuser', position: { x: 2000 - envelope.widthMm / 2, y: 1000 - envelope.depthMm / 2 },
    rotation: 0, width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
    elevation: 2400, mountType: 'ceiling', label: 'SD595 Ø200', supplyZoneRatio: 0.5, properties: { terminal: spec } };
  const terminalPort = terminalSpigotPort(element)!;
  const terminal: TerminalCtx = { element, spec, port: terminalPort, lip: terminalPort.lip, normal: terminalPort.normal,
    neck: 200, branch: 200, airflowM3h: 100, fixed: false };
  const ctx: ServiceCtx = { service: 'supply', unitId: unit.id, frame: { origin: { x: 0, y: 0 }, n: { x: 1, y: 0 }, t: { x: 0, y: 1 } },
    port, bottomZ: 2470, terminals: [terminal], airflowM3h: 100, baseScene: [unit, element],
    settings: resolveDuctSettings({ soffitMm: 3000 }), maxHeightMm: 500, obstacles: [], construction: 'gi-bare', ids: () => 'duct' };
  const points = [{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 200 }];
  const model = new SizingModel(ctx, 'rect', 100);
  const plan = () => {
    const run = buildDuctRunDraftElement({ port, points: [...points.slice(1).map(point => ({ ...point, z: ctx.bottomZ })),
      { x: terminalPort.lip.x, y: terminalPort.lip.y, z: terminalPort.lip.z - 100 }],
    legSizes: [roundLeg(200), roundLeg(200), roundLeg(200)],
    end: { kind: 'terminal', terminalId: element.id, portId: terminalPort.portId, flex: true } }, 'duct');
    return planDuctRunSpec(run.id, readDuctRunSpec(run)!, { settings: ctx.settings, scene: [...ctx.baseScene, run] });
  };
  return { ctx, model, points, terminal, plan };
}

describe('terminal approach realization', () => {
  it('uses spare flexible length to fit the last rigid elbow without moving its terminal or elbow', () => {
    const f = fixture();
    expect(f.plan().issues.some(issue => issue.code === 'DU_LEG_TOO_SHORT')).toBe(true);
    extendTerminalApproach(f.ctx, f.model, f.points, f.terminal, roundLeg(200), f.ctx.bottomZ);
    expect(f.points).toEqual([{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 275 }]);
    const plan = f.plan();
    expect(plan.issues.filter(issue => issue.severity === 'error')).toEqual([]);
    const flex = plan.pieces.find(piece => piece.kind === 'flex')!;
    expect(flex.flex!.minBendRadiusMm).toBeGreaterThanOrEqual(200);
    expect(flex.lengthMm).toBeLessThanOrEqual(f.ctx.settings.flexMaxLengthMm);
  });

  it('keeps the failure when the extension envelope meets another piece of equipment', () => {
    const f = fixture();
    f.ctx.obstacles.push({ id: 'equipment', minX: 2075, maxX: 2200, minY: 270, maxY: 500, zMin: 2400, zMax: 2700 });
    extendTerminalApproach(f.ctx, f.model, f.points, f.terminal, roundLeg(200), f.ctx.bottomZ);
    expect(f.points[2]!.y).toBe(200);
    expect(f.plan().issues.some(issue => issue.code === 'DU_LEG_TOO_SHORT')).toBe(true);
  });

  it('does not consume the terminal connection clearance to force an elbow to fit', () => {
    const f = fixture();
    f.terminal.lip = { x: 2000, y: 450 };
    f.terminal.port = { ...f.terminal.port, lip: { ...f.terminal.port.lip, y: 450 } };
    extendTerminalApproach(f.ctx, f.model, f.points, f.terminal, roundLeg(200), f.ctx.bottomZ);
    expect(f.points[2]!.y).toBe(200);
  });

  it('does not trade an elbow setback failure for an undersized flexible bend', () => {
    const f = fixture();
    f.terminal.lip = { ...f.terminal.lip, x: 2400 };
    f.terminal.port = { ...f.terminal.port, lip: { ...f.terminal.port.lip, x: 2400 } };
    const proposed = f.model.flexRunoutCurve({ x: 2000, y: 275 }, { x: 0, y: 1 }, f.terminal, f.ctx.bottomZ);
    expect(proposed.radiusMm).toBeLessThan(f.terminal.neck);
    extendTerminalApproach(f.ctx, f.model, f.points, f.terminal, roundLeg(200), f.ctx.bottomZ);
    expect(f.points[2]!.y).toBe(200);
  });
});
