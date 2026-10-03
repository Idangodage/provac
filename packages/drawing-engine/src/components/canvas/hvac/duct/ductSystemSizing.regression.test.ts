import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';

import { buildDuctRunDraftElement } from './ductDraft';
import { ductRunElementWithSpec } from './ductFollow';
import { ductBranchesOf, ductParentOf } from './ductNetwork';
import { resolveDuctSettings } from './ductSettings';
import { defaultSizingBasis, ductSystemRootOfRun, sizeDuctSystem } from './ductSystemSizing';
import { typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, roundLeg, type DuctRunSpec } from './ductTypes';

const settings = resolveDuctSettings({});
const basis = { ...defaultSizingBasis(settings, 'supply', null), airflowM3h: 360 };
const terminal: HvacElement = {
  id: 'terminal', type: 'diffuser', position: { x: 2000, y: 0 }, rotation: 0,
  width: 400, depth: 400, height: 200, elevation: 2400, mountType: 'ceiling',
  label: 'Terminal', supplyZoneRatio: 0.5,
  properties: { terminal: { ...typicalTerminalSpec('square-4way', 200), designAirflowM3h: 360 } },
};

function run(id: string, overrides: Partial<DuctRunSpec> = {}): HvacElement {
  const element = buildDuctRunDraftElement({
    origin: { kind: 'free', point: { x: 0, y: 0 }, bottomZ: 2400, service: 'supply' },
    points: [{ x: 1000, y: 0 }, { x: 2000, y: 0 }],
    legSizes: [{ widthMm: 400, heightMm: 200 }, { widthMm: 200, heightMm: 200 }],
    end: { kind: 'terminal', terminalId: terminal.id, portId: 'spigot', flex: false },
  }, id);
  return ductRunElementWithSpec(element, { ...readDuctRunSpec(element)!, ...overrides });
}

describe('measurement preserves the drawing and resolves every existing size', () => {
  it.each([false, true])('reports both sides of a reducer for a %s locked run', (locked) => {
    const main = run('main', { locked });
    const result = sizeDuctSystem([terminal, main], main.id, { basis, measure: !locked, verify: false }, settings);
    expect(result.report.sections.map((section) => ({
      from: section.fromMm, to: section.toMm, width: section.section.widthMm,
      flow: section.airflowM3h, velocity: section.velocityMs, setBy: section.setBy,
    }))).toEqual([
      { from: 0, to: 1000, width: 400, flow: 360, velocity: 1.25, setBy: locked ? 'locked' : 'drawn' },
      { from: 1000, to: 2000, width: 200, flow: 360, velocity: 2.5, setBy: locked ? 'locked' : 'drawn' },
    ]);
    expect(result.report.sections[1]!.frictionPaPerM).toBeGreaterThan(result.report.sections[0]!.frictionPaPerM);
  });

  it('does not re-anchor displaced branches or apply terminal edits during measurement', () => {
    const main = run('main', { end: { kind: 'end-cap' } });
    const branch = run('branch', {
      path: [{ x: 700, y: 800, z: 2400 }, { x: 700, y: 2500, z: 2400 }],
      legs: [roundLeg(200)],
      start: { kind: 'tap', parentRunId: main.id, legIndex: 0, stationMm: 700, side: 1, style: 'spin-in', vcd: false },
    });
    const result = sizeDuctSystem([terminal, main, branch], main.id, {
      basis, measure: true, verify: false, terminalAirflows: { [terminal.id]: 600 },
    }, settings);
    expect(result.report.changedRunIds).toEqual([]);
    expect(result.runs[0]).toBe(main);
    expect(result.runs[1]).toBe(branch);
    expect(result.terminals).toEqual([]);
    expect(result.report.terminals[0]!.airflowM3h).toBe(360);
  });

  it('checks a locked main at the take-off rather than the midpoint before it', () => {
    const main = run('main', {
      locked: true, end: { kind: 'end-cap' },
      path: [{ x: 0, y: 0, z: 2400 }, { x: 1000, y: 0, z: 2400 }, { x: 1200, y: 0, z: 2400 }],
      legs: [{ widthMm: 400, heightMm: 400 }, { widthMm: 200, heightMm: 200 }],
    });
    const branch = run('branch', {
      locked: true, legs: [roundLeg(250)],
      path: [{ x: 1100, y: 100, z: 2400 }, { x: 1100, y: 2100, z: 2400 }],
      start: { kind: 'tap', parentRunId: main.id, legIndex: 1, stationMm: 100, side: 1, style: 'spin-in', vcd: false },
    });
    const result = sizeDuctSystem([terminal, main, branch], main.id, { basis, verify: false }, settings);
    expect(result.report.issues).toContainEqual(expect.objectContaining({ code: 'DU_SIZE_LOCKED', runId: main.id }));
  });

  it('conserves fractional flow down a trunk with multiple take-offs', () => {
    const main = run('main', { end: { kind: 'end-cap' } });
    const flows = [100.1, 120.2, 139.7];
    const terminals = flows.map((flow, index) => ({
      ...terminal, id: `terminal-${index}`,
      properties: { terminal: { ...typicalTerminalSpec('square-4way', 200), designAirflowM3h: flow } },
    }));
    const branches = terminals.map((element, index) => run(`branch-${index}`, {
      path: [{ x: 200 + index * 250, y: 200, z: 2400 }, { x: 200 + index * 250, y: 2200, z: 2400 }],
      legs: [roundLeg(200)],
      start: { kind: 'tap', parentRunId: main.id, legIndex: 0, stationMm: 200 + index * 250, side: 1, style: 'spin-in', vcd: false },
      end: { kind: 'terminal', terminalId: element.id, portId: 'spigot', flex: false },
    }));
    const result = sizeDuctSystem([main, ...terminals, ...branches], main.id, { basis, measure: true, verify: false }, settings);
    const mainSections = result.report.sections.filter((section) => section.runId === main.id);
    mainSections.forEach((section, index) => expect(section.airflowM3h).toBeCloseTo([360, 259.9, 139.7, 0, 0][index]!, 10));
    result.report.terminals.forEach((entry, index) => expect(entry.airflowM3h).toBe(flows[index]));
    expect(result.report.terminalsAirflowM3h).toBe(360);
  });
});

describe('indexed duct parent lookup', () => {
  it('follows parents and reflects a replacement scene snapshot', () => {
    const main = run('main', { start: { kind: 'unit-port', unitId: 'unit', portId: 'supply', connector: false } });
    const branch = run('branch', { start: { kind: 'split-branch', parentRunId: main.id, side: 1, vcd: false } });
    const scene = [main, branch];
    expect(ductParentOf(readDuctRunSpec(branch)!, scene)).toBe(main);
    expect(ductBranchesOf(main.id, scene).map((entry) => entry.element)).toEqual([branch]);
    expect(ductSystemRootOfRun(scene, branch.id)).toBe(main);
    const replaced = { ...main, label: 'Updated main' };
    expect(ductParentOf(readDuctRunSpec(branch)!, [replaced, branch])).toBe(replaced);
  });

  it('returns no root for a cycle or a non-duct parent', () => {
    const a = run('a', { start: { kind: 'split-branch', parentRunId: 'b', side: 1, vcd: false } });
    const b = run('b', { start: { kind: 'split-branch', parentRunId: 'a', side: 1, vcd: false } });
    expect(ductSystemRootOfRun([a, b], a.id)).toBeNull();
    expect(ductParentOf(readDuctRunSpec(a)!, [a, { ...terminal, id: 'b' }])).toBeNull();
  });

  it('reports cyclic networks without resizing or attempting pressure verification', () => {
    const a = run('a', { start: { kind: 'split-branch', parentRunId: 'b', side: 1, vcd: false } });
    const b = run('b', { start: { kind: 'split-branch', parentRunId: 'a', side: 1, vcd: false } });
    const result = sizeDuctSystem([a, b, terminal], a.id, { basis, measure: true }, settings);
    expect(result.runs).toEqual([]);
    expect(result.report.errors).toBe(1);
    expect(result.report.pressure).toBeNull();
    expect(result.report.issues[0]!.message).toMatch(/cyclic/);
  });
});
