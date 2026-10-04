import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../data/ac-equipment-library';
import type { HvacElement } from '../../../types';

import { resolveCondensateSettings } from './condensate/condensateSettings';
import { resolveUnitAirPorts } from './duct/ductAirPorts';
import { getActiveDuctSettings, resolveDuctSettings, setActiveDuctSettings } from './duct/ductSettings';
import { terminalEnvelope, typicalTerminalSpec } from './duct/ductTerminals';
import { readDuctRunSpec } from './duct/ductTypes';
import { DEFAULT_PIPE_ROUTING_SETTINGS, getActivePipeRoutingSettings, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { serviceRouteCommitIssues } from './serviceRouteValidation';
import { planUnifiedAutoRoute, unifiedRouteCommand, type UnifiedAutoRouteOptions } from './unifiedAutoRoute';

const priorDucts = getActiveDuctSettings();
const priorRouting = getActivePipeRoutingSettings();
const ducts = resolveDuctSettings({ soffitMm: 3300 });
const condensate = resolveCondensateSettings({ soffitMm: 3300 });
const routing = { ...DEFAULT_PIPE_ROUTING_SETTINGS, ceilingLimitMm: 3300 };

function catalogUnit(id: string, definitionId: string, x: number, y: number, rotation = 0): HvacElement {
  const definition = DEFAULT_AC_EQUIPMENT_LIBRARY.find(entry => entry.id === definitionId)!;
  return { id, type: definition.type, position: { x, y }, rotation, width: definition.widthMm,
    depth: definition.depthMm, height: definition.heightMm, elevation: 2400, mountType: 'ceiling',
    label: definition.modelLabel!, supplyZoneRatio: 0.5, roomId: 'room',
    properties: structuredClone(definition.defaultProperties ?? {}) };
}

function recoveryScene(): HvacElement[] {
  const unit = catalogUnit('fdum', 'vrf-fdum22kxe6f-w', 3000, 2800);
  const port = resolveUnitAirPorts(unit).find(entry => entry.kind === 'supply')!;
  const terminals = [[900, 1700, 270], [900, -1700, 90], [2600, 0, 180]].map(([along, across, rotation], index): HvacElement => {
    const terminal = typicalTerminalSpec('square-4way', 200);
    const envelope = terminalEnvelope(terminal);
    return { id: `terminal-${index}`, type: 'diffuser', position: { x: port.lip.x + across! - envelope.widthMm / 2,
      y: port.lip.y - along! - envelope.depthMm / 2 }, rotation: rotation!, width: envelope.widthMm,
      depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
      label: `SD 595 Ø200 ${index + 1}`, supplyZoneRatio: 0.5, roomId: 'room', properties: { terminal } };
  });
  const cassettes = [[1000, 4400, 0], [3700, 4500, 90], [6000, 4300, 180], [8100, 1000, 270]]
    .map(([x, y, rotation], index) => catalogUnit(`cassette-${index}`, 'vrf-fdt28kxze1', x!, y!, rotation));
  const gully: HvacElement = { ...unit, id: 'gully', type: 'condensate-gully', position: { x: 10400, y: 5400 },
    width: 200, depth: 200, height: 60, elevation: 0, mountType: 'floor', label: 'Floor gully',
    properties: { terminationKind: 'floor-gully', inletElevationMm: 50, terminalTrap: 'tundish' } };
  const nodes = [{ x: port.lip.x - 1500, y: port.lip.y - 120, z: port.lip.z },
    { x: port.lip.x + 1500, y: port.lip.y - 120, z: port.lip.z - 60 }];
  // A previous generated drain had no duct to avoid. Its authorized replacement
  // must be reserved before the fixed supply collar is judged obstructed.
  const old: HvacElement = { ...unit, id: 'old-drain', type: 'condensate-pipe', position: nodes[0]!,
    width: 3000, depth: 0, height: 50, elevation: port.lip.z - 25, label: 'Previous CD32', properties: {
      routeNodes3d: nodes, routePoints: nodes.map(({ x, y }) => ({ x, y })), outerDiameterMm: 32, insulationThicknessMm: 9,
      upstreamUnitIds: [unit.id], condensateNetwork: { version: 1, networkId: 'previous-network', gullyId: gully.id,
        unitIds: [unit.id], signature: 'generated', sourceSignature: 'previous', editPolicy: 'reconsider' },
    } };
  const outside: HvacElement = { ...old, id: 'outside-drain', position: { x: 20000, y: 20000 },
    properties: { ...old.properties, routeNodes3d: [{ x: 20000, y: 20000, z: 2600 }, { x: 24000, y: 20000, z: 2520 }],
      routePoints: [{ x: 20000, y: 20000 }, { x: 24000, y: 20000 }], upstreamUnitIds: ['outside-unit'],
      condensateNetwork: { version: 1, networkId: 'outside-network', gullyId: 'outside-gully', unitIds: ['outside-unit'],
        signature: 'generated', sourceSignature: 'previous', editPolicy: 'reconsider' } } };
  const manual: HvacElement = { ...outside, id: 'manual-drain', properties: { ...outside.properties,
    routeNodes3d: [{ x: 20000, y: 22000, z: 2600 }, { x: 24000, y: 22000, z: 2520 }],
    routePoints: [{ x: 20000, y: 22000 }, { x: 24000, y: 22000 }] } };
  delete manual.properties.condensateNetwork;
  return [unit, ...terminals, ...cassettes, gully, old, outside, manual];
}

function options(regenerateDrain: boolean): UnifiedAutoRouteOptions {
  return { services: { gas: false, liquid: false, condensate: regenerateDrain, supplyDuct: true, returnDuct: false },
    refrigerant: { settings: routing, objective: 'balanced' },
    condensate: { settings: condensate, unitIds: ['fdum', 'cassette-0', 'cassette-1', 'cassette-2', 'cassette-3'] },
    duct: { settings: ducts, shape: 'rect', fanSpeed: 'hi', rebuildExisting: false, scope: 'drawing' } };
}

beforeEach(() => { setActiveDuctSettings(ducts); setActivePipeRoutingSettings(routing); });
afterEach(() => { setActiveDuctSettings(priorDucts); setActivePipeRoutingSettings(priorRouting); });

describe('coordinated rebuilding with real catalog equipment', () => {
  it('recovers the duct collar corridor while connecting all five units and preserving unrelated drains', async () => {
    const scene = recoveryScene();
    const before = structuredClone(scene);
    const kept = await planUnifiedAutoRoute(scene, options(false));
    expect(kept.ducts!.units[0]!.status).toBe('kept');
    expect(kept.ducts!.elementsToAdd).toEqual([]);
    expect(kept.blockingIssues).toContain('No viable duct layout for 1 unit. Resolve duct issues, or turn off ducts and route again.');

    const result = await planUnifiedAutoRoute(scene, options(true));
    expect(result.ducts!.units[0]!.status, result.issues.join('\n')).toBe('designed');
    expect(result.condensate!.metrics.unitsTotal).toBe(5);
    expect(result.condensate!.metrics.unitsConnected).toBe(5);
    expect(result.condensate!.removeElementIds).toEqual(['old-drain']);
    expect(result.ducts!.units[0]!.notes).toEqual([]);
    const terminals = result.ducts!.elementsToAdd.flatMap(element => {
      const end = readDuctRunSpec(element)?.end;
      return end?.kind === 'terminal' ? [end.terminalId] : [];
    });
    expect(new Set(terminals)).toEqual(new Set(['terminal-0', 'terminal-1', 'terminal-2']));
    expect(result.clashes).toEqual([]);
    expect(result.blockingIssues).toEqual([]);
    expect(result.blockingDetails).toEqual([]);
    expect(serviceRouteCommitIssues(scene, unifiedRouteCommand(result), { condensate, routing, ducts })).toEqual([]);
    expect(scene).toEqual(before);
  }, 30000);

  it('keeps a deliberately retained drain as a real obstruction', async () => {
    const scene = recoveryScene();
    const old = scene.find(element => element.id === 'old-drain')!;
    (old.properties.condensateNetwork as { editPolicy: string }).editPolicy = 'retain';
    const result = await planUnifiedAutoRoute(scene, options(true));
    expect(result.ducts!.units[0]!.status).toBe('kept');
    expect(result.condensate!.removeElementIds).not.toContain(old.id);
    expect(result.blockingIssues!.some(message => message.startsWith('No viable duct layout'))).toBe(true);
  }, 30000);
});
