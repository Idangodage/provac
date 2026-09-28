import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { generateAutoDuct, type AutoDuctRequest, type AutoDuctResult } from './ductAutoLayout';
import { legNormal } from './ductBranches';
import { buildDuctRunDraftElement } from './ductDraft';
import { resolveDuctSettings } from './ductSettings';
import { terminalEnvelope, typicalTerminalSpec, type DuctTerminalKind } from './ductTerminals';
import { readDuctRunSpec } from './ductTypes';

const settings = resolveDuctSettings({ soffitMm: 3000 });

function fdum(rotation = 0, properties: Record<string, unknown> = {}): HvacElement {
  return {
    id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation, width: 1084, depth: 697, height: 300,
    elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
    properties: { modelCode: 'FDUM22KXE6F-W', modelUrl: '/models/vrf/maco-vrf-fdum22kxe6f-w.glb', ...properties },
  };
}

type Frame = { n: Point2D; t: Point2D; lip: Point2D };
function frames(unit: HvacElement): { supply: Frame; ret: Frame } {
  const ports = resolveUnitAirPorts(unit);
  const of = (kind: 'supply' | 'return') => {
    const port = ports.find((candidate) => candidate.kind === kind)!;
    return { n: port.normal, t: legNormal(port.normal), lip: { x: port.lip.x, y: port.lip.y } };
  };
  return { supply: of('supply'), ret: of('return') };
}
const at = (frame: Frame, along: number, across: number): Point2D => ({
  x: frame.lip.x + frame.n.x * along + frame.t.x * across,
  y: frame.lip.y + frame.n.y * along + frame.t.y * across,
});
const minus = (v: Point2D): Point2D => ({ x: -v.x, y: -v.y });

/** A terminal centred at `centre`, its spigot facing `facing` (world). */
function terminal(id: string, centre: Point2D, facing: Point2D, kind: DuctTerminalKind = 'square-4way', neck = 200): HvacElement {
  const spec = typicalTerminalSpec(kind, neck);
  const envelope = terminalEnvelope(spec);
  const rotation = (((Math.atan2(facing.x, -facing.y) * 180) / Math.PI) + 360) % 360;
  return {
    id, type: spec.service === 'return' ? 'return-grille' : 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 },
    rotation, width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { terminal: spec },
  };
}

const request = (terminalIds: string[], overrides: Partial<AutoDuctRequest> = {}): AutoDuctRequest => ({
  unitId: 'fdum', terminalIds, fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: true }, rebuildExisting: false, ...overrides,
});

const errorsOf = (result: AutoDuctResult) => [...result.issues, ...result.services.flatMap((service) => service.issues)].filter((issue) => issue.severity === 'error');

/** Every terminal served by a run ending on it in a flexible runout of at most 1.5 m. */
function expectServed(result: AutoDuctResult, ids: string[]): void {
  const plans = result.services.flatMap((service) => service.plans);
  for (const id of ids) {
    const plan = plans.find((candidate) => candidate.spec.end.kind === 'terminal' && candidate.spec.end.terminalId === id);
    expect(plan, id).toBeDefined();
    const flex = plan!.pieces.find((piece) => piece.kind === 'flex');
    expect(flex, id).toBeDefined();
    expect(flex!.lengthMm).toBeLessThanOrEqual(settings.flexMaxLengthMm);
    expect(plan!.pieces.map((piece) => piece.kind).slice(0, 2)).toEqual(['takeoff', 'damper']);
  }
}

describe('duct auto layout', () => {
  it('a compact group gets a plenum on the collar with a spigot, damper and runout per diffuser', () => {
    const unit = fdum();
    const { supply } = frames(unit);
    const scene = [unit,
      terminal('sd1', at(supply, 900, 1700), minus(supply.t)),
      terminal('sd2', at(supply, 900, -1700), supply.t),
      terminal('sd3', at(supply, 2600, 0), minus(supply.n))];
    const result = generateAutoDuct(scene, request(['sd1', 'sd2', 'sd3']), settings);
    expect(errorsOf(result)).toEqual([]);
    const service = result.services[0]!;
    expect(service.layout).toBe('plenum');
    expect(service.airflowM3h).toBe(600);
    expect(service.terminals.map((entry) => entry.airflowM3h)).toEqual([200, 200, 200]);
    const plenum = service.plans.find((plan) => plan.spec.end.kind === 'plenum')!;
    expect(plenum.pieces.at(-1)!.plenum!.spigots).toHaveLength(3);
    expectServed(result, ['sd1', 'sd2', 'sd3']);
  });

  it('a row across the room gets a Y split along it: the main carries both halves, trunks at least a branch + 50 high', () => {
    const unit = fdum();
    const { supply } = frames(unit);
    const row = [-3750, -2250, -750, 750, 2250, 3750].map((across, index) => terminal(`r${index + 1}`, at(supply, 3000, across), minus(supply.n)));
    const result = generateAutoDuct([unit, ...row], request(row.map((element) => element.id)), settings);
    expect(errorsOf(result)).toEqual([]);
    const service = result.services[0]!;
    expect(service.layout).toBe('trunk-split');
    const [main, left, right] = service.trunkSections;
    expect(main!.widthMm).toBeGreaterThanOrEqual(left!.widthMm + right!.widthMm);
    expect(service.trunkSections.every((section) => section.heightMm >= 250)).toBe(true);
    expectServed(result, row.map((element) => element.id));
  });

  it('a row close to the unit still gets clean runouts, with the fan outlet straight shortened and noted', () => {
    const unit = fdum();
    const { supply } = frames(unit);
    const row = [-2500, -1500, -500, 500, 1500, 2500].map((across, index) => terminal(`c${index + 1}`, at(supply, 2300, across), minus(supply.n)));
    const result = generateAutoDuct([unit, ...row], request(row.map((element) => element.id)), resolveDuctSettings({ soffitMm: 2900 }));
    expect(errorsOf(result)).toEqual([]);
    const service = result.services[0]!;
    expect(service.layout).toBe('trunk-split');
    expect(service.issues.map((issue) => issue.code)).toContain('DU_AUTO_FAN_OUTLET');
    for (const plan of service.plans) {
      for (const piece of plan.pieces.filter((candidate) => candidate.kind === 'flex')) expect(piece.flex!.minBendRadiusMm).toBeGreaterThanOrEqual(200);
    }
    expectServed(result, row.map((element) => element.id));
  });

  it('terminals along both sides of the axis get a straight trunk that reduces between take-offs', () => {
    const unit = fdum();
    const { supply } = frames(unit);
    const scene = [unit,
      terminal('a1', at(supply, 1800, 1500), minus(supply.t), 'square-4way', 250),
      terminal('a2', at(supply, 1800, -1500), supply.t, 'square-4way', 250),
      terminal('a3', at(supply, 3600, 1500), minus(supply.t), 'square-4way', 250),
      terminal('a4', at(supply, 3600, -1500), supply.t, 'square-4way', 250)];
    const result = generateAutoDuct(scene, request(['a1', 'a2', 'a3', 'a4'], { airflowM3h: 2000, layout: 'trunk' }), settings);
    expect(errorsOf(result)).toEqual([]);
    const service = result.services[0]!;
    expect(service.layout).toBe('trunk-straight');
    expect(service.trunkSections.map((section) => section.widthMm)).toEqual([400, 300]);
    const trunk = service.plans.find((plan) => plan.spec.start.kind === 'unit-port')!;
    // Collar transition, then the reducer between the pairs of take-offs.
    expect(trunk.pieces.filter((piece) => piece.kind === 'transition')).toHaveLength(2);
    expectServed(result, ['a1', 'a2', 'a3', 'a4']);
  });

  it('ducts the return from its collar to the grille', () => {
    const unit = fdum();
    const { ret } = frames(unit);
    const result = generateAutoDuct([unit, terminal('rg1', at(ret, 2800, 0), minus(ret.n), 'return-egg-crate', 250)], request(['rg1']), settings);
    expect(errorsOf(result)).toEqual([]);
    expect(result.services.map((service) => service.service)).toEqual(['return']);
    expectServed(result, ['rg1']);
  });

  it('works in the collar\'s own frame whatever the unit\'s rotation', () => {
    const unit = fdum(90);
    const { supply } = frames(unit);
    const scene = [unit,
      terminal('sd1', at(supply, 900, 1700), minus(supply.t)),
      terminal('sd2', at(supply, 900, -1700), supply.t),
      terminal('sd3', at(supply, 2600, 0), minus(supply.n))];
    const result = generateAutoDuct(scene, request(['sd1', 'sd2', 'sd3']), settings);
    expect(errorsOf(result)).toEqual([]);
    expectServed(result, ['sd1', 'sd2', 'sd3']);
  });

  it('leaves an occupied collar alone unless asked to rebuild it', () => {
    const unit = fdum();
    const { supply } = frames(unit);
    const port = resolveUnitAirPorts(unit).find((candidate) => candidate.kind === 'supply')!;
    const old = buildDuctRunDraftElement({ port, points: [{ ...at(supply, 1500, 0) }] }, 'old-run');
    const scene = [unit, old, terminal('sd3', at(supply, 2600, 0), minus(supply.n))];
    const refused = generateAutoDuct(scene, request(['sd3']), settings);
    expect(errorsOf(refused).map((issue) => issue.code)).toContain('DU_AUTO_OCCUPIED');
    expect(refused.runs).toEqual([]);
    const rebuilt = generateAutoDuct(scene, request(['sd3'], { rebuildExisting: true }), settings);
    expect(rebuilt.removeIds).toEqual(['old-run']);
    expect(errorsOf(rebuilt)).toEqual([]);
  });

  it('sums each terminal path to find the index run and what each damper throttles', () => {
    const unit = fdum();
    const { supply } = frames(unit);
    const row = [-3750, -2250, -750, 750, 2250, 3750].map((across, index) => terminal(`r${index + 1}`, at(supply, 3000, across), minus(supply.n)));
    const result = generateAutoDuct([unit, ...row], request(row.map((element) => element.id)), settings);
    const pressure = result.services[0]!.pressure!;
    expect(pressure.terminals).toHaveLength(6);
    const index = pressure.terminals.find((entry) => entry.terminalId === pressure.indexTerminalId)!;
    expect(index.totalPa).toBe(Math.max(...pressure.terminals.map((entry) => entry.totalPa)));
    expect(pressure.throttlePa[index.terminalId]).toBe(0);
    for (const entry of pressure.terminals) {
      expect(entry.terminalPa).toBe(settings.autoDiffuserDropPa);
      expect(entry.frictionPa).toBeGreaterThan(0);
      expect(entry.fittingsPa).toBeGreaterThan(0);
      expect(pressure.throttlePa[entry.terminalId]).toBeGreaterThanOrEqual(0);
    }
    // Slow air: the take-off losses dominate, and the tees nearest the split see the fastest
    // main air (Idelchik form), so the inner branches lose most and one of them is the index.
    const byId = (id: string) => pressure.terminals.find((entry) => entry.terminalId === id)!;
    expect(byId('r3').fittingsPa).toBeGreaterThan(byId('r1').fittingsPa);
    expect(byId('r4').fittingsPa).toBeGreaterThan(byId('r6').fittingsPa);
    expect(['r3', 'r4']).toContain(pressure.indexTerminalId);
    expect(result.requiredEspPa).toBeCloseTo(pressure.indexPa, 6);
    // 600 m³/h over six runouts is slow air (about 1 m/s): the diffuser's own drop dominates.
    expect(result.requiredEspPa!).toBeGreaterThan(settings.autoDiffuserDropPa);
    expect(result.requiredEspPa!).toBeLessThan(result.maxEspPa!);
    // More air, more pressure.
    const faster = generateAutoDuct([unit, ...row], request(row.map((element) => element.id), { fanSpeed: 'p-hi' }), settings);
    expect(faster.requiredEspPa!).toBeGreaterThan(result.requiredEspPa!);
  });

  it('warns when the ducts need more static pressure than the fan gives', () => {
    const unit = fdum();
    const { supply } = frames(unit);
    const far = [4000, 6000].map((along, index) => terminal(`f${index + 1}`, at(supply, along, 0), minus(supply.n)));
    const result = generateAutoDuct([unit, ...far], request(far.map((element) => element.id), { airflowM3h: 3000, layout: 'trunk' }), settings);
    expect(result.requiredEspPa!).toBeGreaterThan(100);
    expect(result.issues.map((issue) => issue.code)).toContain('DU_AUTO_ESP');
  });

  it('asks for an airflow when the unit has no data, and warns of a noisy neck', () => {
    const bare = { ...fdum(), properties: {} };
    const { supply } = frames(bare);
    const scene = [bare, terminal('sd3', at(supply, 2600, 0), minus(supply.n), 'square-4way', 150)];
    expect(errorsOf(generateAutoDuct(scene, request(['sd3']), settings)).map((issue) => issue.code)).toEqual(['DU_AUTO_NO_DATA']);
    const loud = generateAutoDuct(scene, request(['sd3'], { airflowM3h: 600 }), settings);
    const velocity = loud.services[0]!.issues.find((issue) => issue.code === 'DU_TERMINAL_VELOCITY');
    expect(velocity?.message).toMatch(/9\.4 m\/s in its Ø150 neck.*Ø300/);
    void readDuctRunSpec;
  });
});
