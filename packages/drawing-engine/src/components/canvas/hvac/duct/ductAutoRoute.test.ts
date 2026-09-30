import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import type { AutoRouteNetworkResult } from '../autoRouteNetwork';
import { auditDuctClashes, planUnifiedAutoRoute, routedServiceOf } from '../unifiedAutoRoute';
import { resolveCondensateSettings } from '../condensate/condensateSettings';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from '../pipeRoutingSettings';

import { resolveUnitAirPorts } from './ductAirPorts';
import { applyDuctProposal, ductSourceSignature, ductWallCrossings, planAutoRouteDucts, type AutoRouteDuctOptions } from './ductAutoRoute';
import { buildDuctRunDraftElement } from './ductDraft';
import { DEFAULT_DUCT_SETTINGS } from './ductSettings';
import { terminalEnvelope, typicalTerminalSpec } from './ductTerminals';
import { isDuctElement, readDuctRunSpec } from './ductTypes';

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
