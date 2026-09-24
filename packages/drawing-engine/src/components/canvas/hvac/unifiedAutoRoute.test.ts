import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { autoRouteElementSignature, type AutoRouteNetworkResult } from './autoRouteNetwork';
import { generateCondensateNetwork, type CondensateGenerationResult } from './condensate/condensateGenerator';
import type { RefrigerantHopProposal } from './condensate/condensateNetworkPlanner';
import { resolveCondensateSettings } from './condensate/condensateSettings';
import { readCondensatePipeSpec } from './condensate/condensateTypes';
import { findCondensateRefrigerantClashes } from './condensate/condensateValidation';
import { getAutoRouteOwnership, pipeRegenerationPolicy } from './pipeEditRetention';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { getRefrigerantPipeBundleSnapTargets } from './refrigerantPipePairModel';
import {
  applyRefrigerantProposal,
  auditServiceClashes,
  foldRefrigerantHopUpdates,
  planUnifiedAutoRoute,
  reduceRefrigerantResultToLine,
  routedServiceOf,
  type AutoRouteServices,
  type UnifiedAutoRouteOptions,
} from './unifiedAutoRoute';

const condensateSettings = resolveCondensateSettings({});

function indoor(id: string, x: number, y = 300): HvacElement {
  const element: HvacElement = { id, type: 'ceiling-cassette-ac', category: 'indoor-unit',
    label: id, position: { x, y }, rotation: 0, width: 600, depth: 600, height: 250,
    elevation: 2200, mountType: 'ceiling', supplyZoneRatio: 0, properties: { capacityKw: 2.8 } };
  element.elevation += 2607 - getRefrigerantPipeBundleSnapTargets([element])[0]!.liquidElevationMm;
  return element;
}

function outdoor(id = 'outdoor', x = 6900): HvacElement {
  const element: HvacElement = { id, type: 'outdoor-unit', category: 'outdoor-unit',
    label: id, position: { x, y: 2600 }, rotation: 180, width: 900, depth: 450, height: 1200,
    elevation: 0, mountType: 'floor', supplyZoneRatio: 0, properties: {} };
  element.elevation += 1437 - getRefrigerantPipeBundleSnapTargets([element])[0]!.gasElevationMm;
  return element;
}

function gully(id: string, x: number, y: number): HvacElement {
  return { id, type: 'condensate-gully', position: { x: x - 100, y: y - 100 }, rotation: 0, width: 200, depth: 200, height: 60,
    elevation: 0, mountType: 'floor', label: id, supplyZoneRatio: 0.5,
    properties: { terminationKind: 'floor-gully', inletElevationMm: 50, terminalTrap: 'tundish' } };
}

function pipe(id: string, lineKind: 'gas' | 'liquid', points: Array<{ x: number; y: number }>, z: number, extra: Record<string, unknown> = {}): HvacElement {
  return { id, type: 'refrigerant-pipe', position: { x: Math.min(...points.map((p) => p.x)), y: Math.min(...points.map((p) => p.y)) },
    rotation: 0, width: 10, depth: 10, height: 40, elevation: z - 20, mountType: 'ceiling', label: id, supplyZoneRatio: 0.5,
    properties: { routePoints: points, routeNodes3d: points.map((point) => ({ ...point, z })), pipeDiameterMm: 15.88,
      insulationThicknessMm: 25.4, lineKind, fieldBendConstruction: 'formed-tube', ...extra } };
}

function refrigerantResult(partial: Partial<AutoRouteNetworkResult>): AutoRouteNetworkResult {
  return { elementsToAdd: [], removeElementIds: [], updates: [], issues: [], ...partial } as unknown as AutoRouteNetworkResult;
}

function options(services: AutoRouteServices, extra: Partial<UnifiedAutoRouteOptions['condensate']> = {}): UnifiedAutoRouteOptions {
  return {
    services,
    refrigerant: { settings: DEFAULT_PIPE_ROUTING_SETTINGS, objective: 'balanced' },
    condensate: { settings: condensateSettings, ...extra },
  };
}

function newRefrigerantServices(result: AutoRouteNetworkResult): Set<string> {
  return new Set(result.elementsToAdd.filter((element) => element.type === 'refrigerant-pipe').map((element) => routedServiceOf(element)));
}

beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('unified auto route — pure steps', () => {
  it('classifies every routed element by its service', () => {
    expect(routedServiceOf(pipe('g', 'gas', [{ x: 0, y: 0 }, { x: 100, y: 0 }], 2600))).toBe('gas');
    expect(routedServiceOf(pipe('l', 'liquid', [{ x: 0, y: 0 }, { x: 100, y: 0 }], 2600))).toBe('liquid');
    const drain = generateCondensateNetwork([indoor('u', 0), gully('fg', 3000, 300)], { settings: condensateSettings }).elementsToAdd[0];
    expect(routedServiceOf(drain)).toBe('condensate');
    expect(routedServiceOf(gully('fg', 0, 0))).toBe('other');
    expect(routedServiceOf(undefined)).toBe('other');
  });

  // Every run of the circuit connects to the same indoor unit, as generated runs do.
  const toUnit = { startConnection: { connectionKind: 'unit-port', sourceElementId: 'indoor-a' } };

  it('keeps only the ticked line and never touches the partner line', () => {
    const existingGas = pipe('old-gas', 'gas', [{ x: 0, y: 0 }, { x: 900, y: 0 }], 2600, toUnit);
    const existingLiquid = pipe('old-liquid', 'liquid', [{ x: 0, y: 150 }, { x: 900, y: 150 }], 2600, toUnit);
    const otherLiquid = pipe('other-liquid', 'liquid', [{ x: 0, y: 900 }, { x: 900, y: 900 }], 2600, toUnit);
    const scene = [existingGas, existingLiquid, otherLiquid];
    const paired = refrigerantResult({
      elementsToAdd: [
        pipe('new-gas', 'gas', [{ x: 0, y: 0 }, { x: 2000, y: 0 }], 2600, toUnit),
        pipe('new-liquid', 'liquid', [{ x: 0, y: 150 }, { x: 2000, y: 150 }], 2600, toUnit),
      ],
      removeElementIds: ['old-gas', 'old-liquid'],
      updates: [{ ...otherLiquid, label: 'moved' }],
      connectedIndoorIds: ['indoor-a'],
      unconnectedIndoorIds: [],
      complete: true,
    });
    const gasOnly = reduceRefrigerantResultToLine(paired, scene, 'gas');
    expect(gasOnly.elementsToAdd.map((element) => element.id)).toEqual(['new-gas']);
    expect(gasOnly.removeElementIds).toEqual(['old-gas']);
    expect(gasOnly.updates).toEqual([]);
    expect(gasOnly.complete).toBe(true);
    expect(gasOnly.issues.join(' ')).toContain('Only the gas line');
    const liquidOnly = reduceRefrigerantResultToLine(paired, scene, 'liquid');
    expect(liquidOnly.elementsToAdd.map((element) => element.id)).toEqual(['new-liquid']);
    expect(liquidOnly.removeElementIds).toEqual(['old-liquid']);
    expect(liquidOnly.updates.map((element) => element.id)).toEqual(['other-liquid']);
  });

  it('leaves an existing circuit unchanged when the new line would run into the partner line that stays', () => {
    const outdoorUnit = { ...outdoor(), properties: {} };
    const existingGas = pipe('old-gas', 'gas', [{ x: 0, y: 0 }, { x: 900, y: 0 }], 2600, toUnit);
    const existingLiquid = pipe('old-liquid', 'liquid', [{ x: 0, y: 150 }, { x: 900, y: 150 }], 2600, toUnit);
    const scene = [outdoorUnit, existingGas, existingLiquid];
    // The rebuilt pair swaps sides: its gas now runs where the kept liquid is.
    const paired = refrigerantResult({
      elementsToAdd: [
        pipe('new-gas', 'gas', [{ x: 0, y: 150 }, { x: 2000, y: 150 }], 2600,
          { ...toUnit, endConnection: { connectionKind: 'unit-port', sourceElementId: outdoorUnit.id } }),
        pipe('new-liquid', 'liquid', [{ x: 0, y: 0 }, { x: 2000, y: 0 }], 2600, toUnit),
      ],
      removeElementIds: ['old-gas', 'old-liquid'],
      connectedIndoorIds: ['indoor-a'],
      unconnectedIndoorIds: [],
      complete: true,
      issues: ['outdoor: the unlocked connected circuit was rebuilt; one undo restores its previous layout.', 'Manufacturer model rules are not verified.'],
    });
    const gasOnly = reduceRefrigerantResultToLine(paired, scene, 'gas');
    expect(gasOnly.issues.join(' ')).not.toContain('was rebuilt');
    expect(gasOnly.issues).toContain('Manufacturer model rules are not verified.');
    expect(gasOnly.elementsToAdd).toEqual([]);
    expect(gasOnly.removeElementIds).toEqual([]);
    // indoor-a keeps its existing connections; nothing about it changes.
    expect(gasOnly.connectedIndoorIds).toEqual([]);
    expect(gasOnly.unconnectedIndoorIds).toEqual([]);
    expect(gasOnly.issues.join(' ')).toContain('tick both lines to reroute it');
    expect(gasOnly.issues.join(' ')).not.toContain('Only the gas line');
  });

  it('builds the scene as it will be after a refrigerant proposal', () => {
    const a = pipe('a', 'gas', [{ x: 0, y: 0 }, { x: 100, y: 0 }], 2600);
    const b = pipe('b', 'gas', [{ x: 0, y: 100 }, { x: 100, y: 100 }], 2600);
    const c = pipe('c', 'liquid', [{ x: 0, y: 200 }, { x: 100, y: 200 }], 2600);
    const added = pipe('d', 'liquid', [{ x: 0, y: 300 }, { x: 100, y: 300 }], 2600);
    const next = applyRefrigerantProposal([a, b, c], refrigerantResult({
      elementsToAdd: [added], removeElementIds: ['a'], updates: [{ ...b, label: 'b2' }],
    }));
    expect(next.map((element) => `${element.id}:${element.label}`)).toEqual(['b:b2', 'c:c', 'd:d']);
    expect(applyRefrigerantProposal([a], null)).toEqual([a]);
  });

  it('folds hops into new runs (kept as a deliberate edit), updated runs, or existing runs', () => {
    const generated = pipe('new', 'gas', [{ x: 0, y: 0 }, { x: 4000, y: 0 }], 2600, {
      autoRouteNetwork: { version: 1, networkId: 'n', outdoorUnitId: 'outdoor', indoorUnitIds: ['indoor-a'], signature: '' },
    });
    (generated.properties.autoRouteNetwork as { signature: string }).signature = autoRouteElementSignature(generated);
    expect(pipeRegenerationPolicy(generated)).not.toBe('retain');
    const hopped = [{ x: 0, y: 0, z: 2600 }, { x: 1900, y: 0, z: 2600 }, { x: 1900, y: 0, z: 2700 }, { x: 2100, y: 0, z: 2700 },
      { x: 2100, y: 0, z: 2600 }, { x: 4000, y: 0, z: 2600 }];
    const folded = foldRefrigerantHopUpdates(
      [generated],
      [{ id: 'moved', updates: { label: 'moved', properties: { lineKind: 'liquid' } } }],
      [
        { id: 'new', updates: { properties: { ...generated.properties, routeNodes3d: hopped } } },
        { id: 'moved', updates: { properties: { lineKind: 'liquid', routeNodes3d: hopped } } },
        { id: 'untouched', updates: { properties: { routeNodes3d: hopped } } },
      ],
    );
    expect(folded.add).toHaveLength(1);
    expect(folded.add[0]!.properties.routeNodes3d).toEqual(hopped);
    expect(getAutoRouteOwnership(folded.add[0]!)).not.toBeNull();
    expect(pipeRegenerationPolicy(folded.add[0]!)).toBe('retain');
    expect(folded.updates).toEqual([{ id: 'moved', updates: { label: 'moved', properties: { lineKind: 'liquid', routeNodes3d: hopped } } }]);
    expect(folded.existing.map((entry) => entry.id)).toEqual(['untouched']);
  });

  it('reports a drain touching a refrigerant run, and marks it resolved when a hop is proposed for that run', () => {
    const scene = [indoor('u', 0), gully('fg', 5000, 300)];
    const condensate = generateCondensateNetwork(scene, { settings: condensateSettings });
    // Cross the longest horizontal leg of the generated drain at its midpoint.
    const legs = condensate.elementsToAdd.flatMap((element) => {
      const nodes = readCondensatePipeSpec(element).routeNodes3d;
      return nodes.slice(1).map((b, index) => [nodes[index]!, b] as const);
    });
    const [a, b] = legs.reduce((best, leg) => (
      Math.hypot(leg[1].x - leg[0].x, leg[1].y - leg[0].y) > Math.hypot(best[1].x - best[0].x, best[1].y - best[0].y) ? leg : best
    ));
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(400);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    const vertical = Math.abs(a.x - b.x) < 1;
    const through = pipe('gas-x', 'gas', vertical
      ? [{ x: mid.x - 2000, y: mid.y }, { x: mid.x + 2000, y: mid.y }]
      : [{ x: mid.x, y: mid.y - 2000 }, { x: mid.x, y: mid.y + 2000 }], mid.z);
    const world = [...scene, through];

    const open = auditServiceClashes(world, null, condensate);
    const clash = open.find((entry) => entry.elementIds.includes('gas-x'));
    expect(clash).toBeDefined();
    expect(clash!.services).toEqual(['condensate', 'gas']);
    expect(clash!.resolvedByHop).toBe(false);

    const withHop: CondensateGenerationResult = {
      ...condensate,
      hopProposals: [{ key: 'hop-1', refrigerantElementId: 'gas-x' } as RefrigerantHopProposal],
    };
    expect(auditServiceClashes(world, null, withHop).find((entry) => entry.elementIds.includes('gas-x'))!.resolvedByHop).toBe(true);
  });
});

describe('planUnifiedAutoRoute', () => {
  it('asks for a service when nothing is ticked', async () => {
    const result = await planUnifiedAutoRoute([outdoor(), indoor('indoor-a', 500)], options({ gas: false, liquid: false, condensate: false }));
    expect(result.refrigerant).toBeNull();
    expect(result.condensate).toBeNull();
    expect(result.issues.join(' ')).toContain('Tick at least one service');
  });

  it('routes condensate only, leaving refrigerant alone', async () => {
    const scene = [outdoor(), indoor('indoor-a', 500), gully('fg', 2500, -1200)];
    const result = await planUnifiedAutoRoute(scene, options({ gas: false, liquid: false, condensate: true }));
    expect(result.refrigerant).toBeNull();
    expect(result.condensate!.metrics.unitsConnected).toBe(1);
    expect(result.condensate!.elementsToAdd.every((element) => routedServiceOf(element) === 'condensate' || element.type === 'condensate-gully')).toBe(true);
  }, 120000);

  it.each(['gas', 'liquid'] as const)('routes only the %s line when it is the only line ticked', async (line) => {
    const scene = [outdoor(), indoor('indoor-a', 500)];
    const result = await planUnifiedAutoRoute(scene, options({ gas: line === 'gas', liquid: line === 'liquid', condensate: false }));
    expect(result.condensate).toBeNull();
    expect(result.refrigerant!.elementsToAdd.length).toBeGreaterThan(0);
    expect([...newRefrigerantServices(result.refrigerant!)]).toEqual([line]);
    expect(result.issues.join(' ')).toContain(`Only the ${line} line`);
  }, 120000);

  it('routes gas, liquid and condensate together without clashes between the services', async () => {
    const scene = [outdoor(), indoor('indoor-a', 500), gully('fg', 2500, -1200)];
    const result = await planUnifiedAutoRoute(scene, options({ gas: true, liquid: true, condensate: true }));
    const refrigerant = result.refrigerant!;
    expect(refrigerant.complete, refrigerant.issues.join(' ')).toBe(true);
    expect([...newRefrigerantServices(refrigerant)].sort()).toEqual(['gas', 'liquid']);
    expect(result.condensate!.metrics.unitsConnected).toBe(1);
    // The condensate was designed on the scene WITH the new refrigerant.
    const finalScene = [...applyRefrigerantProposal(scene, refrigerant), ...result.condensate!.elementsToAdd];
    const hopTargets = new Set(result.condensate!.hopProposals.map((proposal) => proposal.refrigerantElementId));
    expect(findCondensateRefrigerantClashes(finalScene).filter((clash) => !hopTargets.has(clash.refrigerantId))).toEqual([]);
    expect(result.clashes.filter((clash) => !clash.resolvedByHop), result.clashes.map((clash) => clash.message).join(' ')).toEqual([]);
  }, 120000);

  it('does not let drains that are about to be regenerated shape the new layout', async () => {
    const base = [outdoor(), indoor('indoor-a', 500), gully('fg', 2500, -1200)];
    const previous = generateCondensateNetwork(base, { settings: condensateSettings }).elementsToAdd;
    const oldDrainIds = previous.filter((element) => element.type === 'condensate-pipe').map((element) => element.id);
    expect(oldDrainIds.length).toBeGreaterThan(0);
    const result = await planUnifiedAutoRoute([...base, ...previous], options({ gas: true, liquid: true, condensate: true }));
    expect(result.condensate!.removeElementIds.sort()).toEqual([...oldDrainIds].sort());
    const reported = new Set(result.clashes.flatMap((clash) => clash.elementIds));
    expect(oldDrainIds.some((id) => reported.has(id))).toBe(false);
    expect(result.refrigerant!.complete, result.refrigerant!.issues.join(' ')).toBe(true);
  }, 120000);
});
