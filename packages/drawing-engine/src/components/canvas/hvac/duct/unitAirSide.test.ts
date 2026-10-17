/**
 * A unit's air side as one system: terminal necks that grow with their
 * airflow (their runouts with them), the resize as one set of changes, drift
 * from the basis, the basis a system continues from, the fan's ESP setting,
 * and the record of how a system was first sized.
 */
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement } from './ductDraft';
import { ductRunElementWithSpec } from './ductFollow';
import { resolveDuctSettings } from './ductSettings';
import { stampDesignedAt, withInitialSizingRecords } from './ductSizingRecord';
import { defaultSizingBasis, linkSizingBasis } from './ductSystemSizing';
import { readDuctTerminalSpec, terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, type DuctLeg, type DuctSizingRecord, type DuctSystemSizing } from './ductTypes';
import { withReplaced } from './optimizer/designTree';
import { continueBasis, necksToGrow, sizeUnitService, systemDrift, unitEspCheck } from './unitAirSide';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
const S = (along: number, across = 0): Point2D => ({ x: port.lip.x + across, y: port.lip.y - along });

function diffuser(id: string, centre: Point2D): HvacElement {
  const spec = { ...typicalTerminalSpec('square-4way', 200), designAirflowM3h: null };
  const envelope = terminalEnvelope(spec);
  return {
    id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation: 270,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId: 'r', properties: { terminal: spec },
  };
}

/** FDUM22 supply: a 250×250 main with four spin-in take-offs, each a Ø200 branch and a flexible runout to its diffuser. */
function system(): { scene: HvacElement[]; runs: HvacElement[]; terminals: HvacElement[] } {
  const terminals = [0, 1, 2, 3].map((k) => diffuser(`d${k}`, S(2500 + k * 1800, 2000)));
  const root = buildDuctRunDraftElement({ port, points: [S(9000)], legSizes: [{ widthMm: 250, heightMm: 250 }] }, 'main');
  const branchSection: DuctLeg = { widthMm: 200, heightMm: 200, diameterMm: 200 };
  const branches = terminals.map((terminal, index) => {
    const origin = tapOrigin(root, settings, { legIndex: 0, stationMm: 2500 + index * 1800, side: 1, style: 'spin-in', vcd: true }, branchSection)!;
    if (origin.kind !== 'tap') throw new Error('Expected a take-off origin');
    const terminalPort = terminalSpigotPort(terminal)!;
    return buildDuctRunDraftElement({
      origin,
      points: [
        { x: origin.point.x + origin.direction.x * 400, y: origin.point.y + origin.direction.y * 400 },
        { x: terminalPort.lip.x, y: terminalPort.lip.y, z: terminalPort.lip.z - terminalPort.heightMm / 2 },
      ],
      legSizes: [branchSection, branchSection],
      end: { kind: 'terminal', terminalId: terminal.id, portId: terminalPort.portId, flex: true },
    }, `branch-${terminal.id}`);
  });
  const runs = [root, ...branches];
  return { scene: [unit, ...terminals, ...runs], runs, terminals };
}

/** 1500 m³/h over four Ø200 diffusers: 375 each, 3.3 m/s in the necks (over the 3 m/s supply cap). */
const basis: DuctSystemSizing = linkSizingBasis({ ...defaultSizingBasis(settings, 'supply', null), airflowM3h: 1500 }, 1500);
const neckOf = (scene: readonly HvacElement[], id: string) => readDuctTerminalSpec(scene.find((element) => element.id === id)!)!.neckDiameterMm;

describe('terminal necks follow their airflow', () => {
  it('finds each neck over its cap and the catalogue neck it takes (grows only)', () => {
    const { scene } = system();
    const growth = necksToGrow(scene, 'main', basis, undefined, settings);
    expect(growth.map((entry) => [entry.terminalId, entry.fromMm, entry.toMm])).toEqual([['d0', 200, 250], ['d1', 200, 250], ['d2', 200, 250], ['d3', 200, 250]]);
    expect(growth[0]!.velocityMs).toBeGreaterThan(3);
    expect(growth.every((entry) => !entry.stillOver)).toBe(true);
    // Less air: nothing grows (and nothing shrinks).
    expect(necksToGrow(scene, 'main', { ...basis, airflowM3h: 1000 }, undefined, settings)).toEqual([]);
    // 900 m³/h on one diffuser needs more than the largest neck.
    const heavy = necksToGrow(scene, 'main', basis, { d0: 900 }, settings).find((entry) => entry.terminalId === 'd0')!;
    expect(heavy.toMm).toBe(300);
    expect(heavy.stillOver).toBe(true);
  });

  it('sizes the system with the grown necks as one set of changes: terminals, runouts and runs together', () => {
    const { scene } = system();
    const sized = sizeUnitService(scene, 'u', 'supply', basis, undefined, settings, { necks: true })!;
    const after = withReplaced(scene, sized.updates);
    for (const id of ['d0', 'd1', 'd2', 'd3']) expect(neckOf(after, id)).toBe(250);
    for (const id of ['d0', 'd1', 'd2', 'd3']) {
      const runout = readDuctRunSpec(after.find((element) => element.id === `branch-${id}`)!)!;
      expect(runout.legs.at(-1)!.diameterMm).toBe(250);
      const port = terminalSpigotPort(after.find((element) => element.id === id)!)!;
      expect(Math.hypot(runout.path.at(-1)!.x - port.lip.x, runout.path.at(-1)!.y - port.lip.y)).toBeLessThan(0.5);
    }
    expect(sized.necks).toHaveLength(4);
    expect(sized.report.issues.filter((issue) => issue.code === 'DU_SIZE_NECK_GROWN')).toHaveLength(4);
    expect(sized.report.issues.some((issue) => issue.code === 'DU_TERMINAL_VELOCITY')).toBe(false);
    expect(sized.report.errors).toBe(0);
    // Without: the necks stay and say so.
    const kept = sizeUnitService(scene, 'u', 'supply', basis, undefined, settings, { necks: false })!;
    expect(withReplaced(scene, kept.updates).every((element) => element.type !== 'diffuser' || neckOf([element], element.id) === 200)).toBe(true);
    expect(kept.report.issues.filter((issue) => issue.code === 'DU_TERMINAL_VELOCITY')).toHaveLength(4);
  });
});

describe('drift from the basis', () => {
  it('finds nothing right after sizing, and the run a hand edit changed', () => {
    const { scene } = system();
    const sized = withReplaced(scene, sizeUnitService(scene, 'u', 'supply', basis, undefined, settings)!.updates);
    const stored = readDuctRunSpec(sized.find((element) => element.id === 'main')!)!.sizing!;
    expect(systemDrift(sized, 'main', stored, settings)).toEqual([]);
    const branch = sized.find((element) => element.id === 'branch-d1')!;
    const spec = readDuctRunSpec(branch)!;
    const edited = withReplaced(sized, [ductRunElementWithSpec(branch, { ...spec, legs: [{ widthMm: 315, heightMm: 315, diameterMm: 315 }, ...spec.legs.slice(1)] })]);
    expect(systemDrift(edited, 'main', stored, settings)).toContain('branch-d1');
  });
});

describe('the basis a system continues from', () => {
  const record = (overrides: Partial<DuctSizingRecord>): DuctSizingRecord => ({
    method: 'life-cycle', origin: 'auto-duct', label: null, fanSpeed: 'p-hi', airflowM3h: 780, airflowSource: 'manufacturer',
    mainVelocityMs: 2.4, mainFrictionPaPerM: 0.437, maxVelocity: { trunk: 5.5, branch: 4, runout: 3 }, basis: null, terminals: [], ...overrides,
  });
  const withRoot = (change: (spec: ReturnType<typeof readDuctRunSpec> & object) => object) => {
    const { scene } = system();
    const root = scene.find((element) => element.id === 'main')!;
    return withReplaced(scene, [ductRunElementWithSpec(root, { ...readDuctRunSpec(root)!, ...change(readDuctRunSpec(root)!) })]);
  };

  it('takes the stored basis first, then the first sizing, then the main as drawn, then the defaults', () => {
    const stored = { ...basis, frictionPaPerM: 1.1 };
    expect(continueBasis(withRoot(() => ({ sizing: stored })), 'u', 'supply', settings)).toEqual({ basis: stored, from: 'stored' });
    const initialCf = { ...basis, frictionPaPerM: 0.9 };
    expect(continueBasis(withRoot(() => ({ initialSizing: record({ method: 'constant-friction', basis: initialCf }) })), 'u', 'supply', settings))
      .toEqual({ basis: initialCf, from: 'initial' });
    // A life-cycle design continues at its main's own friction rate, at the fan speed it was designed for.
    const lifeCycle = continueBasis(withRoot(() => ({ initialSizing: record({}) })), 'u', 'supply', settings);
    expect(lifeCycle.from).toBe('initial');
    expect(lifeCycle.basis).toMatchObject({ drive: 'friction', frictionPaPerM: 0.44, fanSpeed: 'p-hi', airflowM3h: null, maxVelocity: { trunk: 5.5, branch: 4, runout: 3 } });
    const entered = continueBasis(withRoot(() => ({ initialSizing: record({ airflowSource: 'entered', airflowM3h: 1500 }) })), 'u', 'supply', settings);
    expect(entered.basis.airflowM3h).toBe(1500);
    const drawn = continueBasis(system().scene, 'u', 'supply', settings);
    expect(drawn.from).toBe('drawn');
    expect(drawn.basis.drive).toBe('friction');
    expect(drawn.basis.fanSpeed).toBe('hi');
    expect(continueBasis([unit], 'u', 'supply', settings).from).toBe('defaults');
  });
});

describe('the fan: both services against its ESP', () => {
  const esp = { maxPa: 200, settingsPa: [10, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200], factoryRangePa: [80, 150] as const, extendedBy: 'SW8-4 ON' };

  it('adds supply and return, and picks the setting to make', () => {
    const check = unitEspCheck(64, 48, esp);
    expect(check.requiredPa).toBe(112);
    expect(check.withinFan).toBe(true);
    expect(check.setting).toEqual({ pa: 120, inFactoryRange: true, note: null });
    const low = unitEspCheck(22, null, esp);
    expect(low.setting!.pa).toBe(40);
    expect(low.setting!.note).toMatch(/80–150 Pa \(SW8-4 ON\)/);
    expect(unitEspCheck(150, 70, esp).withinFan).toBe(false);
    expect(unitEspCheck(64, 48, { maxPa: 100 }).setting).toBeNull();
  });
});

describe('the record of how a system was first sized', () => {
  it('measures the main on the design as it will be drawn and keeps the airflow it was designed for', () => {
    const { runs, terminals } = system();
    const stamped = withInitialSizingRecords({
      fanSpeed: 'p-hi', airflowM3h: 780, airflowSource: 'manufacturer', runs,
      services: [{ service: 'supply', label: 'Straight trunk + branches', runs }],
    }, [unit, ...terminals], settings, 'auto-duct');
    const record = readDuctRunSpec(stamped.find((element) => element.id === 'main')!)!.initialSizing!;
    expect(record.method).toBe('life-cycle');
    expect(record.fanSpeed).toBe('p-hi');
    expect(record.airflowM3h).toBe(780);
    expect(record.mainFrictionPaPerM).toBeGreaterThan(0);
    expect(record.terminals.map((terminal) => terminal.airflowM3h)).toEqual([195, 195, 195, 195]);
    expect(record.designedAt).toBeUndefined();
    // Only the run off the collar carries it.
    expect(stamped.filter((element) => readDuctRunSpec(element)!.initialSizing)).toHaveLength(1);
    const dated = stampDesignedAt(stamped, '2026-10-17T12:00:00.000Z');
    expect(readDuctRunSpec(dated.find((element) => element.id === 'main')!)!.initialSizing!.designedAt).toBe('2026-10-17T12:00:00.000Z');
    expect(stampDesignedAt(dated, '2027-01-01T00:00:00.000Z')).toEqual(dated);
  });

  it('keeps the basis of a design sized by constant friction', () => {
    const { runs, terminals } = system();
    const root = runs[0]!;
    const sizedRoot = ductRunElementWithSpec(root, { ...readDuctRunSpec(root)!, sizing: basis });
    const stamped = withInitialSizingRecords({
      fanSpeed: 'hi', airflowM3h: 1500, airflowSource: 'entered', runs: [sizedRoot, ...runs.slice(1)],
      services: [{ service: 'supply', label: 'Trunk · constant friction', runs: [sizedRoot, ...runs.slice(1)] }],
    }, [unit, ...terminals], settings, 'auto-route');
    const record = readDuctRunSpec(stamped[0]!)!.initialSizing!;
    expect(record).toMatchObject({ method: 'constant-friction', origin: 'auto-route', basis, airflowSource: 'entered' });
  });
});
