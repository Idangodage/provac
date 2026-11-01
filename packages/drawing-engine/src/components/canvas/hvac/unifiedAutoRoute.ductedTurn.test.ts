// A ducted unit whose terminals are behind its collars (a duct leaves a collar forwards): Auto route turns it, as it
// does a cassette, and says so; one it may not turn, or a turn does not help, stays as placed with the advice.
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../data/ac-equipment-library';
import type { HvacElement, Point2D, Wall } from '../../../types';

import { withDuctLeftOutReasons } from './autoRouteCompleteness';
import { resolveCondensateSettings } from './condensate/condensateSettings';
import { resolveUnitAirPorts } from './duct/ductAirPorts';
import { analyseAirSystems, readDuctLeftOutReason } from './duct/ductAirSystems';
import { checkAirSystems } from './duct/ductAirSystemChecks';
import { ductLeftOutReason, type AutoRouteDuctUnit } from './duct/ductAutoRoute';
import { DEFAULT_DUCT_SETTINGS, savedDuctSettings } from './duct/ductSettings';
import { readDuctRunSpec } from './duct/ductTypes';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { applyServiceRouteCommand } from './serviceRouteValidation';
import { planUnifiedAutoRoute, unifiedRouteCommand, type UnifiedAutoRouteOptions } from './unifiedAutoRoute';
import { DEFAULT_AUTO_TURN_SETTINGS, planDuctedUnitTurns, unitTurnText } from './unitOrientation';

let serial = 0;
function place(definitionId: string, centre: Point2D, extra: Partial<HvacElement> = {}, properties: Record<string, unknown> = {}): HvacElement {
  const def = DEFAULT_AC_EQUIPMENT_LIBRARY.find((entry) => entry.id === definitionId)!;
  serial += 1;
  return {
    id: `${definitionId}-${serial}`, type: def.type, category: def.equipmentCategory, subtype: def.subtype, modelLabel: def.modelLabel,
    position: { x: centre.x - def.widthMm / 2, y: centre.y - def.depthMm / 2 }, rotation: 0,
    width: def.widthMm, depth: def.depthMm, height: def.heightMm, elevation: def.elevationMm, mountType: def.mountType,
    label: def.type === 'diffuser' ? `SAD-${serial}` : def.type === 'return-grille' ? `RAG-${serial}` : def.name, supplyZoneRatio: 0.5,
    properties: { definitionId: def.id, ...(def.defaultProperties ?? {}), ...properties }, ...extra,
  } as HvacElement;
}

/** A small unit with a diffuser behind its supply collar and a grille behind its return collar. */
function backToFront(unitProperties: Record<string, unknown> = {}): { unit: HvacElement; scene: HvacElement[] } {
  const unit = place('vrf-fdum22kxe6f-w', { x: 8000, y: 8000 }, { elevation: 2450 }, { airSystemTag: 'DU-1', ...unitProperties });
  const ports = resolveUnitAirPorts(unit).filter((port) => !port.vertical);
  const behind = (kind: 'supply' | 'return') => {
    const port = ports.find((candidate) => candidate.kind === kind)!;
    return { x: port.lip.x - port.normal.x * 3600, y: port.lip.y - port.normal.y * 3600 };
  };
  const joined = (element: HvacElement) => ({ ...element, elevation: 2400, properties: { ...element.properties, airSystem: { unitId: unit.id } } });
  return { unit, scene: [unit, joined(place('terminal-square-595-300', behind('supply'))), joined(place('terminal-return-eggcrate-595-300', behind('return')))] };
}

const options = (turn: boolean): UnifiedAutoRouteOptions => ({
  services: { gas: false, liquid: false, condensate: false, supplyDuct: true, returnDuct: true },
  refrigerant: { settings: DEFAULT_PIPE_ROUTING_SETTINGS, objective: 'balanced' },
  condensate: { settings: resolveCondensateSettings({}) },
  duct: { settings: DEFAULT_DUCT_SETTINGS, shape: 'optimal', fanSpeed: 'hi', rebuildExisting: false, scope: 'drawing' },
  ...(turn ? { orientation: DEFAULT_AUTO_TURN_SETTINGS } : {}),
});

beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('Auto route turns a ducted unit to face its terminals', () => {
  it('turns it, designs its ducts to the collars as turned, all in one command', async () => {
    const { unit, scene } = backToFront();
    const result = await planUnifiedAutoRoute(scene, options(true));
    expect(result.ducts!.units[0]!.status, result.ducts!.issues.join(' ')).toBe('designed');
    const turn = result.orientation!.turns[0]!;
    expect(turn).toMatchObject({ unitId: unit.id, angleDeg: 180, terminalsAhead: { before: 0, after: 2, total: 2 } });
    expect(unitTurnText(turn)).toContain('all 2 terminals ahead of its collars (none before)');
    const command = unifiedRouteCommand(result);
    expect(command.updates?.[0]).toMatchObject({ id: unit.id, updates: { rotation: 180 } });
    const after = applyServiceRouteCommand(scene, command);
    expect(after.find((element) => element.id === unit.id)!.properties.orientationSetBy).toBe('auto-route');
    // Each run starts at its collar as it is after the turn, and every terminal is reached.
    const turned = after.find((element) => element.id === unit.id)!;
    const ports = resolveUnitAirPorts(turned);
    const runs = result.ducts!.elementsToAdd.map((run) => readDuctRunSpec(run)!);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    for (const spec of runs.filter((run) => run.start.kind === 'unit-port')) {
      const lip = ports.find((port) => port.portId === (spec.start as { portId: string }).portId)!.lip;
      expect(Math.hypot(spec.path[0]!.x - lip.x, spec.path[0]!.y - lip.y)).toBeLessThan(1);
    }
    expect(checkAirSystems(after, DEFAULT_DUCT_SETTINGS).filter((issue) => issue.code === 'DU_TERMINAL_NOT_DUCTED')).toEqual([]);
  });

  it('leaves it as placed with the setting off, and it gets advice instead', async () => {
    const { scene } = backToFront();
    const result = await planUnifiedAutoRoute(scene, options(false));
    expect(result.orientation).toBeUndefined();
    expect(result.ducts!.units[0]!.status).toBe('kept');
    expect(result.ducts!.units[0]!.advice?.[0]).toMatchObject({ kind: 'turn-unit', angleDeg: 180 });
  });

  it('never turns one turned by hand: it says so, and keeps the advice', async () => {
    const { unit, scene } = backToFront({ orientationSetBy: 'user' });
    const result = await planUnifiedAutoRoute(scene, options(true));
    expect(result.orientation?.turns ?? []).toEqual([]);
    expect(result.orientation?.kept).toEqual([{ unitId: unit.id, label: unit.label, reason: 'turned by hand' }]);
    expect(result.ducts!.units[0]!.status).toBe('kept');
  });
});

describe('who may turn', () => {
  const advised = (unit: HvacElement, angleDeg: 90 | 180 = 180): Pick<AutoRouteDuctUnit, 'unitId' | 'status' | 'advice'> => ({
    unitId: unit.id, status: 'kept', advice: [{ kind: 'turn-unit', angleDeg, ahead: 2, aheadNow: 0, total: 2, message: 'Turn it.' }],
  });

  it('a locked unit stays', () => {
    const { unit, scene } = backToFront({ locked: true });
    expect(planDuctedUnitTurns(scene, [advised(unit)], { walls: [], replaceable: new Set() }).kept[0]!.reason).toBe('locked');
  });

  it('a unit whose run is kept stays; with that run replaced, it turns', () => {
    const { unit, scene } = backToFront();
    const drain = { id: 'cd', type: 'condensate-pipe', properties: { drainStart: { kind: 'unit-drain', unitId: unit.id, point: { x: 0, y: 0 }, z: 2600 } } } as unknown as HvacElement;
    const kept = planDuctedUnitTurns([...scene, drain], [advised(unit)], { walls: [], replaceable: new Set() });
    expect(kept.turns).toEqual([]);
    expect(kept.kept[0]!.reason).toContain('kept as they are');
    expect(planDuctedUnitTurns([...scene, drain], [advised(unit)], { walls: [], replaceable: new Set(['cd']) }).turns).toHaveLength(1);
  });

  it('a quarter turn must fit: a wall just past its short side stops it, a half turn does not need room', () => {
    const { unit, scene } = backToFront();
    const centreY = unit.position.y + unit.depth / 2;
    const y = centreY + (Math.min(unit.width, unit.depth) / 2) + 100;
    const wall = { id: 'w', startPoint: { x: 0, y }, endPoint: { x: 16000, y }, thickness: 100, properties3D: { height: 2900, baseElevation: 0 } } as unknown as Wall;
    expect(planDuctedUnitTurns(scene, [advised(unit, 90)], { walls: [wall], replaceable: new Set() }).kept[0]!.reason).toBe('its body would not fit turned');
    expect(planDuctedUnitTurns(scene, [advised(unit, 180)], { walls: [wall], replaceable: new Set() }).turns).toHaveLength(1);
  });

  it('a unit the duct step designed is left alone', () => {
    const { unit, scene } = backToFront();
    const planned = planDuctedUnitTurns(scene, [{ ...advised(unit), status: 'designed' }], { walls: [], replaceable: new Set() });
    expect(planned).toEqual({ turns: [], kept: [] });
  });
});

describe('a terminal no duct reaches', () => {
  it('is a warning on the terminal, in the checks', () => {
    const { scene } = backToFront();
    const found = checkAirSystems(scene, DEFAULT_DUCT_SETTINGS).filter((issue) => issue.code === 'DU_TERMINAL_NOT_DUCTED');
    expect(found.map((issue) => issue.level)).toEqual(['warning', 'warning']);
    expect(found.map((issue) => issue.entityId).sort()).toEqual(scene.slice(1).map((element) => element.id).sort());
    expect(found[0]!.message).toContain('has no duct');
  });

  it('keeps the reason when Auto route left its unit out, and loses it once designed', () => {
    const { unit, scene } = backToFront();
    const left: AutoRouteDuctUnit = {
      unitId: unit.id, unitLabel: 'DU-1', status: 'kept', services: [], requiredEspPa: null, maxEspPa: null, firstCost: null, lifeCycleCost: null, currency: 'USD',
      runIds: [], exact: null, notes: ['Turn it.', 'No layout fits.'], advice: [{ kind: 'turn-unit', angleDeg: 180, ahead: 2, aheadNow: 0, total: 2, message: 'Turn it.' }],
    };
    expect(ductLeftOutReason(left)).toBe('No layout fits.');
    const ducts = { elementsToAdd: [], removeElementIds: [], terminalUpdates: [], units: [left], issues: [] };
    // Folded into a turn already in the command: the store takes one update per element.
    const updates = withDuctLeftOutReasons([{ id: unit.id, updates: { rotation: 180 } as Partial<HvacElement> }], scene, ducts);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.updates.rotation).toBe(180);
    const after = scene.map((element) => (element.id === unit.id ? { ...element, ...updates[0]!.updates, properties: { ...element.properties, ...updates[0]!.updates.properties } } : element));
    expect(readDuctLeftOutReason(after[0]!)).toBe('No layout fits.');
    expect(checkAirSystems(after, DEFAULT_DUCT_SETTINGS).find((issue) => issue.code === 'DU_TERMINAL_NOT_DUCTED')!.message).toContain('left DU-1 out: No layout fits.');
    // Designed on a later run: the reason goes.
    const cleared = withDuctLeftOutReasons([], after, { ...ducts, units: [{ ...left, status: 'designed' }] });
    expect(cleared[0]!.updates.properties).toEqual({ ductLeftOutReason: undefined });
    // Nothing to say, nothing to change.
    expect(withDuctLeftOutReasons([], scene, { ...ducts, units: [{ ...left, status: 'designed' }] })).toEqual([]);
    expect(analyseAirSystems(after).unassigned).toEqual([]);
  });
});

describe('the design taper', () => {
  it('is just inside the SMACNA limit, for a drawing saved with the former default too', () => {
    expect(DEFAULT_DUCT_SETTINGS.transitionTaperDeg).toBe(22);
    expect(savedDuctSettings({ transitionTaperDeg: 14 }).transitionTaperDeg).toBe(22);
    expect(savedDuctSettings({ transitionTaperDeg: 18 }).transitionTaperDeg).toBe(18);
    expect(savedDuctSettings({}).transitionTaperDeg).toBe(22);
  });
});
