import { describe, expect, it } from 'vitest';

import { planDuctRunSpec, type DuctFabricationPlan, type DuctPiece } from './ductFabricationPlanner';
import { FITTING_LOSS_COEFFICIENTS, splitOutletLossPa, systemPressure, transitionCoefficient } from './ductPressure';
import { resolveDuctSettings } from './ductSettings';
import { frictionPaPerM, velocityMs, velocityPressurePa } from './ductSizing';
import type { DuctEnd, DuctLeg, DuctService } from './ductTypes';

const settings = { autoDiffuserDropPa: 15, autoGrilleDropPa: 10 };
const rectangular: DuctLeg = { widthMm: 200, heightMm: 200 };
const round: DuctLeg = { ...rectangular, diameterMm: 200 };
const terminal = (id: string): DuctEnd => ({ kind: 'terminal', terminalId: id, portId: 'spigot', flex: false });

function piece(overrides: Partial<DuctPiece> = {}): DuctPiece {
  return {
    mark: 'S1', kind: 'straight', legIndex: 0,
    start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, direction: { x: 1, y: 0 },
    stationStartMm: 0, stationEndMm: 1000, lengthMm: 1000,
    ...rectangular, endWidthMm: 200, endHeightMm: 200,
    bottomZ: 0, centreZ: 100, endCentreZ: 100,
    seamLengthMm: 0, sheetThicknessMm: 1, sheetAreaM2: 0, fabricAreaM2: 0, massKg: 0,
    ...overrides,
  };
}

function plan(id: string, pieces: DuctPiece[], options: {
  start?: DuctEnd; end?: DuctEnd; section?: DuctLeg; service?: DuctService;
} = {}): DuctFabricationPlan {
  const length = Math.max(0, ...pieces.map((entry) => entry.stationEndMm));
  return {
    elementId: id,
    spec: {
      version: 1, service: options.service ?? 'supply', construction: 'gi-bare',
      path: [{ x: 0, y: 0, z: 0 }, { x: length, y: 0, z: 0 }], legs: [options.section ?? rectangular],
      insulationThicknessMm: 0, pressureClassPa: null, jointSystem: null,
      start: options.start ?? { kind: 'open' }, end: options.end ?? terminal(id), nodeOverrides: {}, locked: false,
    },
    status: 'ok', constructionByLeg: [], startPort: null, tap: null, pieces, joints: [], issues: [],
    polylineLengthMm: length, totals: { sheetAreaM2: 0, fabricAreaM2: 0, massKg: 0 },
    unverifiedRules: [], practiceRules: [], seamType: 'pittsburgh', seamRound: 'spiral',
    insulationMm: 0, insulation: null,
  };
}

const tap = (parentRunId: string, stationMm: number): DuctEnd => ({
  kind: 'tap', parentRunId, stationMm, legIndex: 0, side: 1, style: 'straight', vcd: false,
});

describe('pressure along duct paths', () => {
  it('integrates flow either side of a take-off independently of fabrication joints', () => {
    const main = plan('main', [piece()]);
    const branch = plan('branch', [piece()], { start: tap('main', 250) });
    const flows = new Map([['main', 100], ['branch', 200]]);
    const pressure = systemPressure([main, branch], flows, settings, 'supply');
    const firstRate = frictionPaPerM(rectangular, 300);
    const mainRate = frictionPaPerM(rectangular, 100);
    expect(pressure.terminals.find((entry) => entry.terminalId === 'main')!.frictionPa).toBeCloseTo(firstRate * 0.25 + mainRate * 0.75, 10);
    expect(pressure.terminals.find((entry) => entry.terminalId === 'branch')!.frictionPa).toBeCloseTo(firstRate * 0.25 + frictionPaPerM(rectangular, 200), 10);
    const jointed = plan('main', [
      piece({ stationEndMm: 250, lengthMm: 250 }),
      piece({ stationStartMm: 250, stationEndMm: 1000, lengthMm: 750 }),
    ]);
    const splitPressure = systemPressure([jointed, branch], flows, settings, 'supply');
    splitPressure.terminals.forEach((entry, index) => expect(entry.totalPa).toBeCloseTo(pressure.terminals[index]!.totalPa, 10));
  });

  it('uses developed fitting length instead of the polyline station span', () => {
    const elbow = plan('terminal', [piece({ kind: 'elbow', lengthMm: 850 })]);
    const pressure = systemPressure([elbow], new Map([['terminal', 300]]), settings, 'supply');
    expect(pressure.terminals[0]!.frictionPa).toBeCloseTo(frictionPaPerM(rectangular, 300) * 0.85, 10);
  });

  it.each(['y', 'bullhead', 'wye'] as const)('includes the zero-length %s split on each outlet path', (style) => {
    const main = plan('main', [
      piece({ ...round, endDiameterMm: 200 }),
      piece({ kind: 'split', stationStartMm: 1000, stationEndMm: 1000, lengthMm: 0 }),
    ], { section: round, end: { kind: 'split', style } });
    const left = plan('left', [piece({ ...round, endDiameterMm: 200 })], {
      section: round, start: { kind: 'split-branch', parentRunId: 'main', side: 1, vcd: false },
    });
    const right = plan('right', [piece({ ...round, endDiameterMm: 200 })], {
      section: round, start: { kind: 'split-branch', parentRunId: 'main', side: -1, vcd: false },
    });
    const pressure = systemPressure([main, left, right], new Map([['left', 100], ['right', 200]]), settings, 'supply');
    for (const [index, flow] of [100, 200].entries()) {
      const expected = splitOutletLossPa(style, velocityMs(round, flow), velocityMs(round, 300));
      expect(pressure.terminals[index]!.fittingsPa).toBeCloseTo(expected, 10);
      expect(expected).toBeGreaterThan(0);
    }
    expect(pressure.throttlePa[pressure.indexTerminalId!]).toBe(0);
  });

  it.each(['supply', 'return'] as const)('uses the true downstream shape for %s transitions', (service) => {
    const rectangularEnd = { widthMm: 400, heightMm: 300 };
    for (const startsRound of [true, false]) {
      const transition = piece({
        kind: 'transition',
        ...(startsRound ? { ...round, endWidthMm: 400, endHeightMm: 300 }
          : { ...rectangularEnd, endWidthMm: 200, endHeightMm: 200, endDiameterMm: 200 }),
      });
      const run = plan('terminal', [transition], { service });
      const pressure = systemPressure([run], new Map([['terminal', 300]]), settings, service);
      const downstream = (service === 'supply') === startsRound ? rectangularEnd : round;
      expect(pressure.terminals[0]!.fittingsPa).toBeCloseTo(
        (FITTING_LOSS_COEFFICIENTS.transition + FITTING_LOSS_COEFFICIENTS.shapeChange)
        * velocityPressurePa(velocityMs(downstream, 300)), 10,
      );
    }
  });

  it('uses the full top divergence angle for a flat-bottom transition', () => {
    const transition = piece({
      kind: 'transition', endHeightMm: 300,
      transition: { neckMm: 50, slopeMm: 900, angleWidthDeg: 0, angleHeightDeg: 10, widthSense: 'none', heightSense: 'expanding', compressed: false },
    });
    const pressure = systemPressure([plan('terminal', [transition])], new Map([['terminal', 300]]), settings, 'supply');
    expect(pressure.terminals[0]!.fittingsPa).toBeCloseTo(
      transitionCoefficient(10, true) * velocityPressurePa(velocityMs({ widthMm: 200, heightMm: 300 }, 300)), 10,
    );
  });

  it('preserves the planner\'s flow-aware expansion sense on a return transition', () => {
    const main = { widthMm: 400, heightMm: 300 };
    const run = plan('terminal', [], { service: 'return' });
    run.spec.path = [{ x: 0, y: 0, z: 0 }, { x: 1500, y: 0, z: 0 }, { x: 3000, y: 0, z: 0 }];
    run.spec.legs = [main, rectangular];
    const fabricated = planDuctRunSpec('terminal', run.spec, { settings: resolveDuctSettings({}), scene: [] });
    const transition = fabricated.pieces.find((entry) => entry.kind === 'transition')!;
    expect(transition.transition!.widthSense).toBe('expanding');
    expect(transition.transition!.heightSense).toBe('expanding');
    const pressure = systemPressure([fabricated], new Map([['terminal', 300]]), settings, 'return');
    const info = transition.transition!;
    const expected = transitionCoefficient(Math.max(2 * info.angleWidthDeg, info.angleHeightDeg), true)
      * velocityPressurePa(velocityMs(main, 300));
    expect(pressure.terminals[0]!.fittingsPa).toBeCloseTo(expected, 10);
  });

  it('references plenum entry loss to the inlet duct velocity', () => {
    const inlet = { widthMm: 100, heightMm: 100 };
    const main = plan('main', [piece({ kind: 'plenum', widthMm: 500, heightMm: 400, endWidthMm: 500, endHeightMm: 400 })], {
      section: inlet, end: { kind: 'plenum', widthMm: 500, heightMm: 400, lengthMm: 1000 },
    });
    const branch = plan('terminal', [piece()], {
      start: { kind: 'spigot', parentRunId: 'main', face: 'end', alongMm: 0, acrossMm: 0, style: 'spin-in', vcd: false },
    });
    const pressure = systemPressure([main, branch], new Map([['terminal', 300]]), settings, 'supply');
    expect(pressure.terminals[0]!.fittingsPa).toBeCloseTo(velocityPressurePa(velocityMs(inlet, 300)), 10);
  });

  it('rejects cyclic parent connections instead of hanging or reporting partial pressure', () => {
    const first = plan('first', [piece()], { start: tap('second', 500) });
    const second = plan('second', [piece()], { start: tap('first', 500) });
    expect(() => systemPressure([first, second], new Map([['first', 100]]), settings, 'supply')).toThrow(/cyclic/i);
  });

  it('handles a deeply connected network without recursive airflow accumulation', () => {
    const count = 5000;
    const runs = Array.from({ length: count }, (_, index) => plan(`run-${index}`, [piece()], {
      start: index === 0 ? { kind: 'open' } : tap(`run-${index - 1}`, 1000),
      end: index === count - 1 ? terminal('terminal') : { kind: 'open' },
    }));
    const pressure = systemPressure(runs, new Map([['terminal', 300]]), settings, 'supply');
    expect(pressure.terminals[0]!.frictionPa).toBeCloseTo(count * frictionPaPerM(rectangular, 300), 7);
  });
});
