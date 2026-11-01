import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { resolveCondensateSettings } from './condensate/condensateSettings';
import { resolveUnitAirPorts } from './duct/ductAirPorts';
import { getActiveDuctSettings, resolveDuctSettings, setActiveDuctSettings } from './duct/ductSettings';
import { terminalEnvelope, typicalTerminalSpec } from './duct/ductTerminals';
import { readDuctRunSpec } from './duct/ductTypes';
import { DEFAULT_PIPE_ROUTING_SETTINGS, getActivePipeRoutingSettings, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { getRefrigerantPipeBundleSnapTargets } from './refrigerantPipePairModel';
import { serviceRouteCommitIssues } from './serviceRouteValidation';
import { planUnifiedAutoRoute, unifiedRouteCommand } from './unifiedAutoRoute';

const originalRouting = getActivePipeRoutingSettings();
const originalDucts = getActiveDuctSettings();
const ducts = resolveDuctSettings({ soffitMm: 3300 });
const routing = { ...DEFAULT_PIPE_ROUTING_SETTINGS, ceilingLimitMm: 3300 };
// The unit hangs 100 mm above the ceiling tiles: its gravity outlet (30 mm above its underside) falls in the void.
const condensate = resolveCondensateSettings({ soffitMm: 3300, ceilingPlaneMm: 2300 });

/** A constrained unit connection area: gravity reserves its corridor before refrigerant (the unit set to gravity). */
function mixedServiceScene(): HvacElement[] {
  const indoor: HvacElement = {
    id: 'indoor', type: 'ducted-ac', category: 'indoor-unit', position: { x: 3000, y: 2800 },
    rotation: 0, width: 1084, depth: 697, height: 300, elevation: 2400, mountType: 'ceiling',
    label: 'Ducted indoor', supplyZoneRatio: 0.5, roomId: 'room', properties: { modelCode: 'FDUM22KXE6F-W', capacityKw: 2.2, hasDrainPump: false, drainPumpSetBy: 'user' },
  };
  const outdoor: HvacElement = {
    id: 'outdoor', type: 'outdoor-unit', category: 'outdoor-unit', position: { x: 8800, y: 4500 },
    rotation: 180, width: 900, depth: 450, height: 1200, elevation: 0, mountType: 'floor',
    label: 'Outdoor unit', supplyZoneRatio: 0, properties: {},
  };
  outdoor.elevation += 1437 - getRefrigerantPipeBundleSnapTargets([outdoor])[0]!.gasElevationMm;
  const supply = resolveUnitAirPorts(indoor).find((port) => port.kind === 'supply')!;
  const terminals = [[900, 1700, 270], [900, -1700, 90], [2600, 0, 180]].map(([along, across, rotation], index): HvacElement => {
    const terminal = typicalTerminalSpec('square-4way', 200);
    const envelope = terminalEnvelope(terminal);
    return {
      id: `diffuser-${index}`, type: 'diffuser',
      position: { x: supply.lip.x + across! - envelope.widthMm / 2, y: supply.lip.y - along! - envelope.depthMm / 2 },
      rotation: rotation!, width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
      elevation: 2400, mountType: 'ceiling', label: `Supply diffuser ${index + 1}`, roomId: 'room', supplyZoneRatio: 0.5,
      properties: { terminal },
    };
  });
  const returnSpec = typicalTerminalSpec('return-egg-crate', 250);
  const returnEnvelope = terminalEnvelope(returnSpec);
  const returnPort = resolveUnitAirPorts(indoor).find((port) => port.kind === 'return')!;
  const grille: HvacElement = {
    id: 'return-grille', type: 'return-grille',
    position: { x: returnPort.lip.x - 1700 - returnEnvelope.widthMm / 2, y: returnPort.lip.y + 900 - returnEnvelope.depthMm / 2 },
    rotation: 90, width: returnEnvelope.widthMm, depth: returnEnvelope.depthMm, height: returnEnvelope.heightMm,
    elevation: 2400, mountType: 'ceiling', label: 'Return grille', roomId: 'room', supplyZoneRatio: 0,
    properties: { terminal: returnSpec },
  };
  const sink: HvacElement = {
    id: 'gully', type: 'condensate-gully', position: { x: 8400, y: 2800 }, rotation: 0,
    width: 200, depth: 200, height: 60, elevation: 0, mountType: 'floor', label: 'Drain receptor', supplyZoneRatio: 0,
    properties: { terminationKind: 'floor-gully', inletElevationMm: 50, terminalTrap: 'tundish' },
  };
  return [indoor, outdoor, ...terminals, grille, sink];
}

beforeEach(() => { setActivePipeRoutingSettings(routing); setActiveDuctSettings(ducts); });
afterEach(() => { setActivePipeRoutingSettings(originalRouting); setActiveDuctSettings(originalDucts); });

describe('mixed-service routing portfolio', () => {
  it('finds a complete clear assembly by reserving gravity drainage before refrigerant', async () => {
    const scene = mixedServiceScene();
    const original = structuredClone(scene);
    const result = await planUnifiedAutoRoute(scene, {
      services: { gas: true, liquid: true, condensate: true, supplyDuct: true, returnDuct: true },
      refrigerant: { settings: routing, objective: 'balanced' }, condensate: { settings: condensate },
      duct: { settings: ducts, shape: 'rect', fanSpeed: 'hi', rebuildExisting: false, scope: 'drawing' },
    });
    expect(result.coordination).toEqual({ strategy: 'drainage-first', candidatesEvaluated: 2 });
    expect(result.refrigerant?.complete, result.issues.join('\n')).toBe(true);
    expect(result.refrigerant?.connectedIndoorIds).toEqual(['indoor']);
    expect(result.condensate?.metrics.unitsTotal).toBe(1);
    expect(result.condensate?.metrics.unitsConnected).toBe(1);
    expect(result.condensate?.metrics.pumpedUnits).toBe(0);
    expect(result.condensate?.hopProposals).toEqual([]);
    expect(result.ducts?.units[0]?.status).toBe('designed');
    const servedTerminals = new Set(result.ducts?.elementsToAdd.flatMap((element) => {
      const end = readDuctRunSpec(element)?.end;
      return end?.kind === 'terminal' ? [end.terminalId] : [];
    }));
    expect(servedTerminals).toEqual(new Set(['diffuser-0', 'diffuser-1', 'diffuser-2', 'return-grille']));
    expect(result.clashes).toEqual([]);
    expect(result.blockingIssues).toEqual([]);
    expect(serviceRouteCommitIssues(scene, unifiedRouteCommand(result), { condensate, routing, ducts })).toEqual([]);
    expect(scene).toEqual(original);
  }, 30000);
});

describe('the drain drop and the refrigerant main', () => {
  it('keeps the main off the drop into a gully on its way, and proposes no reserved body', async () => {
    const indoor: HvacElement = {
      id: 'indoor', type: 'ceiling-cassette-ac', category: 'indoor-unit', position: { x: 1000, y: 3000 }, rotation: 0, width: 600, depth: 600, height: 250,
      elevation: 2400, mountType: 'ceiling', label: 'Cassette', supplyZoneRatio: 0, properties: { capacityKw: 2.8 },
    };
    const outdoor: HvacElement = {
      id: 'outdoor', type: 'outdoor-unit', category: 'outdoor-unit', position: { x: 9000, y: 3000 }, rotation: 180, width: 900, depth: 450, height: 1200, elevation: 0,
      mountType: 'floor', label: 'Outdoor', supplyZoneRatio: 0, properties: {},
    };
    const clear = await planUnifiedAutoRoute([indoor, outdoor], { services: { gas: true, liquid: true, condensate: false },
      refrigerant: { settings: routing, objective: 'balanced' }, condensate: { settings: condensate } });
    // Where the main runs with no gully: a floor gully right there, on its longest straight.
    const gas = clear.refrigerant!.elementsToAdd.find((element) => element.type === 'refrigerant-pipe' && element.properties.lineKind === 'gas')!;
    const nodes = gas.properties.routeNodes3d as Array<{ x: number; y: number; z: number }>;
    const spans = nodes.slice(1).map((node, index) => ({ a: nodes[index]!, b: node, length: Math.hypot(node.x - nodes[index]!.x, node.y - nodes[index]!.y) }));
    const longest = spans.reduce((best, span) => (span.length > best.length ? span : best));
    const at = { x: (longest.a.x + longest.b.x) / 2, y: (longest.a.y + longest.b.y) / 2 };
    const sink: HvacElement = {
      id: 'gully', type: 'condensate-gully', position: { x: at.x - 100, y: at.y - 100 }, rotation: 0, width: 200, depth: 200, height: 60, elevation: 0,
      mountType: 'floor', label: 'Gully', supplyZoneRatio: 0, properties: { terminationKind: 'floor-gully', inletElevationMm: 50 },
    };
    const result = await planUnifiedAutoRoute([indoor, outdoor, sink], { services: { gas: true, liquid: true, condensate: true },
      refrigerant: { settings: routing, objective: 'balanced' }, condensate: { settings: condensate } });
    expect(result.refrigerant!.unconnectedIndoorIds).toEqual([]);
    expect(result.clashes.filter((clash) => !clash.resolvedByHop)).toEqual([]);
    expect(result.condensate!.perUnit.map((unit) => unit.status)).not.toContain('infeasible');
    expect(result.refrigerant!.elementsToAdd.some((element) => element.id.startsWith('reserved-drain-drop'))).toBe(false);
    expect(unifiedRouteCommand(result).add?.some((element) => element.id.startsWith('reserved-drain-drop'))).toBe(false);
  }, 240_000);
});
