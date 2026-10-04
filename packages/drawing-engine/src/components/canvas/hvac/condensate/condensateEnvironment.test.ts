import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from '../pipeRoutingSettings';

import { buildCondensateEnvironment, replaceableCondensatePipeIds } from './condensateEnvironment';
import { generateCondensateNetwork } from './condensateGenerator';
import { resolveCondensateSettings } from './condensateSettings';

const settings = resolveCondensateSettings({});
const options = { settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS };

function unit(id: string, x: number): HvacElement {
  return {
    id, type: 'ceiling-cassette-ac', position: { x, y: 0 }, rotation: 0,
    width: 950, depth: 950, height: 272, elevation: 2400, mountType: 'ceiling',
    label: id, supplyZoneRatio: 0.5, properties: { capacityKw: 4 },
  };
}

function drain(id: string, ownerId: string, overrides: Record<string, unknown> = {}): HvacElement {
  return {
    ...unit(id, 0), type: 'condensate-pipe',
    properties: {
      routeNodes3d: [{ x: 2000, y: -1000, z: 2600 }, { x: 2000, y: 4000, z: 2500 }],
      outerDiameterMm: 40, insulationThicknessMm: 9, upstreamUnitIds: [ownerId],
      condensateNetwork: { version: 1, networkId: `network-${ownerId}`, gullyId: `gully-${ownerId}`,
        unitIds: [ownerId], signature: 'test', sourceSignature: 'test', editPolicy: 'reconsider' },
      ...overrides,
    },
  };
}

describe('retained condensate service geometry', () => {
  const scene = [unit('a', 0), unit('b', 4000), drain('drain-a', 'a'), drain('drain-b', 'b')];

  it('keeps generated drains outside a selected unit scope as insulated obstacles', () => {
    const environment = buildCondensateEnvironment(scene, { ...options, unitIds: ['b'] });
    expect(environment.replaceableElementIds).toEqual(['drain-b']);
    expect(environment.services.filter((service) => service.service === 'drain')).toEqual([
      expect.objectContaining({ elementId: 'drain-a', radiusMm: 29, a: { x: 2000, y: -1000, z: 2600 }, b: { x: 2000, y: 4000, z: 2500 } }),
    ]);
  });

  it('removes only replaceable services during a drawing-wide regeneration', () => {
    const environment = buildCondensateEnvironment([...scene, drain('locked', 'c', { locked: true })], options);
    expect(environment.replaceableElementIds).toEqual(['drain-a', 'drain-b']);
    expect(environment.services.map((service) => service.elementId)).toEqual(['locked']);
  });

  it('keeps every existing network when Selected contains no indoor units', () => {
    const scope = { unitIds: [], gullyIds: ['gully-a'] };
    const before = structuredClone(scene);
    const environment = buildCondensateEnvironment(scene, { ...options, ...scope });
    expect(environment.sources).toEqual([]);
    expect(environment.replaceableElementIds).toEqual([]);
    expect(environment.services.map(service => service.elementId).sort()).toEqual(['drain-a', 'drain-b']);
    expect(replaceableCondensatePipeIds(scene, settings, scope)).toEqual([]);
    const generated = generateCondensateNetwork(scene, { ...options, ...scope });
    expect(generated.metrics.unitsTotal).toBe(0);
    expect(generated.elementsToAdd).toEqual([]);
    expect(generated.removeElementIds).toEqual([]);
    expect(scene).toEqual(before);
  });

  it('excludes a hand-edited network only when that specific network is being solved', () => {
    const retained = drain('edited', 'a', { condensateNetwork: {
      version: 1, networkId: 'editing', gullyId: 'gully-a', unitIds: ['a'],
      signature: 'test', sourceSignature: 'test', editPolicy: 'retain',
    } });
    const environment = buildCondensateEnvironment([unit('a', 0), retained], { ...options, editNetworkId: 'editing' });
    expect(environment.replaceableElementIds).toEqual(['edited']);
    expect(environment.services).toEqual([]);
    expect(environment.sources.map((source) => source.unitId)).toEqual(['a']);
  });
});
