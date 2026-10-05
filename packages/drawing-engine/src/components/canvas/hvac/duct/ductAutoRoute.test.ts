import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import type { AutoRouteNetworkResult } from '../autoRouteNetwork';
import { resolveCondensateSettings } from '../condensate/condensateSettings';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from '../pipeRoutingSettings';
import { auditDuctClashes, planUnifiedAutoRoute, routedServiceOf } from '../unifiedAutoRoute';

import { resolveUnitAirPorts } from './ductAirPorts';
import { readAirSystemAssignment, servingUnits } from './ductAirSystems';
import { applyDuctProposal, ductSourceSignature, ductWallCrossings, planAutoRouteDucts, type AutoRouteDuctOptions } from './ductAutoRoute';
import { buildDuctRunDraftElement } from './ductDraft';
import { planDuctRunSpec } from './ductFabricationPlanner';
import { DEFAULT_DUCT_SETTINGS } from './ductSettings';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { isDuctElement, readDuctRunSpec } from './ductTypes';
import { findDuctClashes } from './ductVolumes';

function fdum(id: string, x: number, roomId = 'room-1'): HvacElement {
  return {
    id, type: 'ducted-ac', position: { x, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
    elevation: 2400, mountType: 'ceiling', label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId, properties: { modelCode: 'FDUM22KXE6F-W' },
  };
}

function diffuser(id: string, centre: Point2D, rotation: number, roomId = 'room-1'): HvacElement {
  const spec = typicalTerminalSpec('square-4way', 200);
  const envelope = terminalEnvelope(spec);
  return {
    id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId, properties: { terminal: spec },
  };
}

const unit = fdum('fdum', 0);
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
// Along the supply collar's normal (−Y) and across it.
const at = (along: number, across: number, lip = supply.lip): Point2D => ({ x: lip.x + across, y: lip.y - along });
const sd1 = diffuser('sd1', at(900, 1700), 270);
const sd2 = diffuser('sd2', at(900, -1700), 90);
const sd3 = diffuser('sd3', at(2600, 0), 180);
const elsewhere = diffuser('sd9', at(2600, 5000), 180, 'room-2');

const options = (extra: Partial<AutoRouteDuctOptions> = {}): AutoRouteDuctOptions => ({
  settings: DEFAULT_DUCT_SETTINGS, shape: 'rect', fanSpeed: 'hi', rebuildExisting: false, scope: 'drawing', ...extra,
});
const servedBy = (runs: readonly HvacElement[]) => new Set(runs.flatMap((run) => {
  const end = readDuctRunSpec(run)?.end;
  return end?.kind === 'terminal' ? [end.terminalId] : [];
}));

describe('Auto route: the duct step', () => {
  it('serves staggered rows of eleven default-facing diffusers in a walled room, applying the selected spigot sides', () => {
    const indoor = { ...fdum('indoor', 5458), position: { x: 5458, y: 3401.5 } };
    const terminals = [
      [1000, 1000], [3350, 1000], [5450, 1000], [7350, 1000], [9500, 1000], [10600, 1000],
      [1450, 3350], [2700, 3400], [4300, 3600], [8300, 3000], [10700, 2800],
    ].map(([x, y], index) => diffuser(`sd-${index}`, { x: x!, y: y! }, 0));
    const walls = [
      [0, 0, 11700, 0], [11700, 0, 11700, 5200], [11700, 5200, 0, 5200], [0, 5200, 0, 0],
    ].map(([x, y, endX, endY], index) => ({
      id: `wall-${index}`, startPoint: { x: x!, y: y! }, endPoint: { x: endX!, y: endY! }, thickness: 100,
    }));
    const scene = [indoor, ...terminals];
    const result = planAutoRouteDucts(scene, { supply: true, return: true }, options({ shape: 'optimal', walls }));
    expect(result.units).toHaveLength(1);
    expect(result.units[0]!.status, result.units[0]!.notes.join('\n')).toBe('designed');
    expect(servedBy(result.elementsToAdd)).toEqual(new Set(terminals.map((terminal) => terminal.id)));
    expect(result.terminalUpdates.length).toBeGreaterThan(0);
    const applied = applyDuctProposal(scene, result);
    for (const update of result.terminalUpdates) expect(applied.find((element) => element.id === update.id)).toEqual(update);
    for (const run of result.elementsToAdd) {
      const plan = planDuctRunSpec(run.id, readDuctRunSpec(run)!, { scene: applied, settings: DEFAULT_DUCT_SETTINGS });
      expect(plan.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    }
    expect(findDuctClashes(applied, DEFAULT_DUCT_SETTINGS, [])).toEqual([]);
    expect(ductWallCrossings(result.elementsToAdd, walls).size).toBe(0);
  }, 60000);

  it('designs each ducted unit for the free terminals in its room, with no errors', () => {
    const scene = [unit, sd1, sd2, sd3, elsewhere];
    const result = planAutoRouteDucts(scene, { supply: true, return: false }, options());
    expect(result.units).toHaveLength(1);
    const [designed] = result.units;
    expect(designed!.status).toBe('designed');
    expect(designed!.services[0]!.service).toBe('supply');
    expect(designed!.firstCost).toBeGreaterThan(0);
    expect(result.elementsToAdd.every(isDuctElement)).toBe(true);
    expect([...servedBy(result.elementsToAdd)].sort()).toEqual(['sd1', 'sd2', 'sd3']);
    // No unit in room 2: that diffuser is left for later, without a note in the drawing scope.
    expect(result.issues.some((issue) => issue.includes('selected terminal'))).toBe(false);
    expect(new Set(result.elementsToAdd.map((run) => run.id)).size).toBe(result.elementsToAdd.length);
  });

  it('gives each terminal to the nearest unit in its room, and the second unit designs around the first', () => {
    const other = fdum('fdum-b', 9000);
    const otherLip = resolveUnitAirPorts(other).find((port) => port.kind === 'supply')!.lip;
    const near = diffuser('sd4', at(2600, 0, otherLip), 180);
    const scene = [unit, other, sd3, near];
    const result = planAutoRouteDucts(scene, { supply: true, return: false }, options());
    expect(result.units.map((entry) => [entry.unitId, entry.status])).toEqual([['fdum', 'designed'], ['fdum-b', 'designed']]);
    const byUnit = (id: string) => result.elementsToAdd.filter((run) => {
      const start = readDuctRunSpec(run)?.start;
      return !start || start.kind !== 'unit-port' ? false : start.unitId === id;
    });
    expect(servedBy(result.elementsToAdd)).toEqual(new Set(['sd3', 'sd4']));
    expect(byUnit('fdum').length).toBeGreaterThan(0);
    expect(byUnit('fdum-b').length).toBeGreaterThan(0);
    // All run ids are unique across the two units.
    expect(new Set(result.elementsToAdd.map((run) => run.id)).size).toBe(result.elementsToAdd.length);
  });

  it('serves each unit\'s own air system: an assigned terminal stays with its unit even beside the other', () => {
    const other = fdum('fdum-b', 4500);
    const otherLip = resolveUnitAirPorts(other).find((port) => port.kind === 'supply')!.lip;
    // sd-a sits in front of fdum-b but belongs to fdum; sd-b and sd-c are in no system yet.
    const mine = diffuser('sd-a', at(2600, -700, otherLip), 180);
    const a = { ...mine, properties: { ...mine.properties, airSystem: { unitId: 'fdum' } } };
    const b = diffuser('sd-b', at(2600, 700, otherLip), 180);
    const c = diffuser('sd-c', at(2600, 0), 180);
    const scene = [unit, other, a, b, c];
    const result = planAutoRouteDucts(scene, { supply: true, return: false }, options());
    expect(result.units.map((entry) => [entry.unitId, entry.status, entry.tag, entry.supplyTerminals])).toEqual([
      // Equal airflow: the unit with more terminals goes first.
      ['fdum', 'designed', 'DU-1', 2], ['fdum-b', 'designed', 'DU-2', 1],
    ]);
    const serving = servingUnits(applyDuctProposal(scene, result));
    expect(serving.get('sd-a')?.unitId).toBe('fdum');
    expect(serving.get('sd-c')?.unitId).toBe('fdum');
    expect(serving.get('sd-b')?.unitId).toBe('fdum-b');
    // The terminals that joined a system on Apply carry it; sd-a already had it.
    const joined = new Map(result.terminalUpdates.map((element) => [element.id, readAirSystemAssignment(element)]));
    expect(joined.get('sd-b')).toBe('fdum-b');
    expect(joined.get('sd-c')).toBe('fdum');
  }, 90000);

  it('never takes another unit\'s terminal: a unit not designed keeps its terminals for later', () => {
    const other = fdum('fdum-b', 9000);
    const theirs = { ...sd3, properties: { ...sd3.properties, airSystem: { unitId: 'fdum-b' } } };
    const result = planAutoRouteDucts([unit, other, sd1, sd2, theirs], { supply: true, return: false },
      options({ scope: 'selection', unitIds: ['fdum'] }));
    expect([...servedBy(result.elementsToAdd)].sort()).toEqual(['sd1', 'sd2']);
    // Selecting that terminal brings its own unit into the run.
    const withTerminal = planAutoRouteDucts([unit, other, sd1, sd2, theirs], { supply: true, return: false },
      options({ scope: 'selection', terminalIds: ['sd3'] }));
    expect(withTerminal.units.map((entry) => entry.unitId)).toEqual(['fdum-b']);
  }, 90000);

  it('leaves a collar that already has a duct unless Rebuild is ticked, then replaces it in the same step', () => {
    const old = buildDuctRunDraftElement({ port: supply, points: [at(1500, 0)] }, 'old');
    const scene = [unit, old, sd1, sd2, sd3];
    const kept = planAutoRouteDucts(scene, { supply: true, return: false }, options());
    expect(kept.units).toHaveLength(0);
    expect(kept.elementsToAdd).toHaveLength(0);
    expect(kept.issues.join(' ')).toMatch(/already has a duct/);
    const rebuilt = planAutoRouteDucts(scene, { supply: true, return: false }, options({ rebuildExisting: true }));
    expect(rebuilt.removeElementIds).toContain('old');
    expect(rebuilt.units[0]!.status).toBe('designed');
    expect(applyDuctProposal(scene, rebuilt).some((element) => element.id === 'old')).toBe(false);
  });

  it('in the Selected scope serves only the selected terminals', () => {
    const scene = [unit, sd1, sd2, sd3];
    const result = planAutoRouteDucts(scene, { supply: true, return: false }, options({ scope: 'selection', unitIds: ['fdum'], terminalIds: ['sd3'] }));
    expect([...servedBy(result.elementsToAdd)]).toEqual(['sd3']);
    const none = planAutoRouteDucts(scene, { supply: true, return: false }, options({ scope: 'selection', unitIds: [], terminalIds: [] }));
    expect(none.units).toHaveLength(0);
  });

  it('keeps ducts clear of walls: no proposed run crosses one (it goes round, or the unit is kept with the reason)', () => {
    const scene = [unit, sd1, sd2, sd3];
    const clear = planAutoRouteDucts(scene, { supply: true, return: false }, options());
    const trunk = clear.elementsToAdd.find((run) => readDuctRunSpec(run)?.start.kind === 'unit-port')!;
    const [a, b] = readDuctRunSpec(trunk)!.path;
    const middle = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
    const along = Math.abs(b!.x - a!.x) > Math.abs(b!.y - a!.y);
    const wall = { id: 'w', startPoint: along ? { x: middle.x, y: middle.y - 3000 } : { x: middle.x - 3000, y: middle.y },
      endPoint: along ? { x: middle.x, y: middle.y + 3000 } : { x: middle.x + 3000, y: middle.y } };
    expect(ductWallCrossings(clear.elementsToAdd, [wall]).get('supply')).toBeGreaterThanOrEqual(1);
    expect(ductWallCrossings(clear.elementsToAdd, [{ id: 'far', startPoint: { x: 50000, y: 0 }, endPoint: { x: 50000, y: 1000 } }]).size).toBe(0);
    const walled = planAutoRouteDucts(scene, { supply: true, return: false }, options({ walls: [wall] }));
    expect(ductWallCrossings(walled.elementsToAdd, [wall]).size).toBe(0);
    if (walled.units[0]!.status === 'kept') expect(walled.units[0]!.notes.length).toBeGreaterThan(0);
    else expect(walled.elementsToAdd.length).toBeGreaterThan(0);
  }, 60000);

  it('fingerprints the drawing and the settings it was designed against', () => {
    const scene = [unit, sd1];
    const signature = ductSourceSignature(scene, DEFAULT_DUCT_SETTINGS);
    expect(ductSourceSignature([...scene], DEFAULT_DUCT_SETTINGS)).toBe(signature);
    expect(ductSourceSignature([unit, { ...sd1, position: { x: sd1.position.x + 1, y: sd1.position.y } }], DEFAULT_DUCT_SETTINGS)).not.toBe(signature);
    expect(ductSourceSignature(scene, { ...DEFAULT_DUCT_SETTINGS, econSheetPerKg: DEFAULT_DUCT_SETTINGS.econSheetPerKg + 1 })).not.toBe(signature);
    expect(ductSourceSignature(scene, DEFAULT_DUCT_SETTINGS, [])).toBe(signature);
    const wall = { id: 'wall', startPoint: { x: 0, y: 0 }, endPoint: { x: 1000, y: 0 }, thickness: 100 };
    const walled = ductSourceSignature(scene, DEFAULT_DUCT_SETTINGS, [wall]);
    expect(walled).not.toBe(signature);
    expect(ductSourceSignature(scene, DEFAULT_DUCT_SETTINGS, [{ ...wall, endPoint: { x: 1200, y: 0 } }])).not.toBe(walled);
    expect(ductSourceSignature(scene, DEFAULT_DUCT_SETTINGS, [{ ...wall, thickness: 150 }])).not.toBe(walled);
    expect(ductSourceSignature(scene, DEFAULT_DUCT_SETTINGS, [{ ...wall }])).toBe(walled);
  });

  it('reports explicitly selected terminals that cannot be assigned without treating other rooms as obligations', () => {
    const selected = planAutoRouteDucts([unit, elsewhere], { supply: true, return: false },
      options({ scope: 'selection', unitIds: [unit.id], terminalIds: [elsewhere.id] }));
    expect(selected.unservedTerminalIds).toEqual([elsewhere.id]);
    expect(selected.units).toEqual([]);
    expect(selected.issues.join(' ')).toMatch(/selected terminal/);
    const drawing = planAutoRouteDucts([unit, elsewhere], { supply: true, return: false }, options());
    expect(drawing.unservedTerminalIds ?? []).toEqual([]);
    expect(drawing.issues).toEqual([]);
    const noUnit = planAutoRouteDucts([elsewhere], { supply: true, return: false },
      options({ scope: 'selection', terminalIds: [elsewhere.id] }));
    expect(noUnit.unservedTerminalIds).toEqual([elsewhere.id]);
    expect(noUnit.issues.join(' ')).toMatch(/no ducted unit/);
  });

  it('retains an already-served selected terminal while identifying an unserved selection behind its occupied collar', () => {
    const port = terminalSpigotPort(sd1)!;
    const old = buildDuctRunDraftElement({ port: supply, points: [port.lip],
      end: { kind: 'terminal', terminalId: sd1.id, portId: port.portId, flex: true } }, 'old');
    const scene = [unit, old, sd1, sd2];
    const kept = planAutoRouteDucts(scene, { supply: true, return: false },
      options({ scope: 'selection', unitIds: [unit.id], terminalIds: [sd1.id] }));
    expect(kept.unservedTerminalIds ?? []).toEqual([]);
    expect(kept.elementsToAdd).toEqual([]);
    expect(kept.removeElementIds).toEqual([]);
    expect(kept.units).toEqual([]);
    const incomplete = planAutoRouteDucts(scene, { supply: true, return: false },
      options({ scope: 'selection', unitIds: [unit.id], terminalIds: [sd1.id, sd2.id] }));
    expect(incomplete.unservedTerminalIds).toEqual([sd2.id]);
    expect(incomplete.elementsToAdd).toEqual([]);
  });
});

function gasPipe(id: string, points: Point2D[], z: number): HvacElement {
  return {
    id, type: 'refrigerant-pipe', position: { x: Math.min(...points.map((p) => p.x)), y: Math.min(...points.map((p) => p.y)) },
    rotation: 0, width: 10, depth: 10, height: 40, elevation: z - 20, mountType: 'ceiling', label: id, supplyZoneRatio: 0.5,
    properties: { routePoints: points, routeNodes3d: points.map((point) => ({ ...point, z })), pipeDiameterMm: 15.88,
      insulationThicknessMm: 25.4, lineKind: 'gas', fieldBendConstruction: 'formed-tube' },
  };
}

describe('Auto route: ducts with the other services', () => {
  const services = { gas: false, liquid: false, condensate: false, supplyDuct: true, returnDuct: false };
  const unifiedOptions = {
    services,
    refrigerant: { settings: DEFAULT_PIPE_ROUTING_SETTINGS, objective: 'balanced' as const },
    condensate: { settings: resolveCondensateSettings({}) },
    duct: options(),
  };

  it('routes the ducts first and reports them in the result', async () => {
    const result = await planUnifiedAutoRoute([unit, sd1, sd2, sd3], unifiedOptions);
    expect(result.refrigerant).toBeNull();
    expect(result.condensate).toBeNull();
    expect(result.ducts!.units[0]!.status).toBe('designed');
    expect(result.ducts!.elementsToAdd.length).toBeGreaterThan(0);
    expect(result.clashes).toEqual([]);
    expect(routedServiceOf(result.ducts!.elementsToAdd[0])).toBe('supply-duct');
  });

  it('lists a new pipe that runs into a new duct as a clash between services', async () => {
    const scene = [unit, sd1, sd2, sd3];
    const ducts = planAutoRouteDucts(scene, { supply: true, return: false }, options());
    const trunk = ducts.elementsToAdd.find((run) => readDuctRunSpec(run)?.start.kind === 'unit-port')!;
    const spec = readDuctRunSpec(trunk)!;
    const a = spec.path[0]!;
    const b = spec.path[1]!;
    const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const z = a.z + spec.legs[0]!.heightMm / 2;
    // A gas pipe square across the trunk's first leg, at its mid-height.
    const across = Math.abs(b.x - a.x) > Math.abs(b.y - a.y)
      ? [{ x: middle.x, y: middle.y - 800 }, { x: middle.x, y: middle.y + 800 }]
      : [{ x: middle.x - 800, y: middle.y }, { x: middle.x + 800, y: middle.y }];
    const refrigerant = { elementsToAdd: [gasPipe('gas-new', across, z)], removeElementIds: [], updates: [], issues: [] } as unknown as AutoRouteNetworkResult;
    const clashes = auditDuctClashes(scene, ducts, refrigerant, null, { settings: DEFAULT_DUCT_SETTINGS });
    const hit = clashes.find((clash) => clash.elementIds.includes('gas-new'));
    expect(hit).toBeDefined();
    expect(hit!.services).toEqual(['supply-duct', 'gas']);
    expect(hit!.message).toMatch(/supply duct .* runs into the gas pipe/);
    // Nothing new: nothing listed.
    expect(auditDuctClashes(scene, null, null, null, { settings: DEFAULT_DUCT_SETTINGS })).toEqual([]);
  });
});
