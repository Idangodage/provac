import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';
import { buildVrfDocumentFromHvacElements } from '../../../vrf/domain';

import { planAutoRouteNetwork } from './autoRouteNetwork';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from './pipeRoutingSettings';

function equipment(id: string, x: number, y: number, outdoor = false): HvacElement {
  return {
    id,
    type: outdoor ? 'outdoor-unit' : 'ceiling-cassette-ac',
    category: outdoor ? 'outdoor-unit' : 'indoor-unit',
    label: id,
    position: { x, y },
    rotation: outdoor ? 180 : 0,
    width: outdoor ? 900 : 600,
    depth: outdoor ? 450 : 600,
    height: outdoor ? 1200 : 250,
    elevation: outdoor ? 1000 : 2200,
    mountType: outdoor ? 'floor' : 'ceiling',
    supplyZoneRatio: 0,
    properties: {},
  };
}

describe('automatic network completeness', () => {
  it('returns a sealed additive network for the routable subset without moving unsupported units', async () => {
    const valid = equipment('valid-cassette', 800, 500);
    const unsupported = { ...equipment('angled-cassette', 3600, 1800), rotation: 45 };
    const source = equipment('outdoor', 8000, 4300, true);
    const independentlyRoutable = await planAutoRouteNetwork([source, valid], {
      settings: DEFAULT_PIPE_ROUTING_SETTINGS,
      objective: 'balanced',
    });
    expect(independentlyRoutable.complete, independentlyRoutable.issues.join('\n')).toBe(true);

    const scene = [source, valid, unsupported];
    const result = await planAutoRouteNetwork(scene, {
      settings: DEFAULT_PIPE_ROUTING_SETTINGS,
      objective: 'balanced',
    });

    expect(result.complete).toBe(false);
    expect(result.elementsToAdd.length).toBeGreaterThan(0);
    expect(result.removeElementIds).toEqual([]);
    expect(result.connectedIndoorIds).toEqual(['valid-cassette']);
    expect(result.unconnectedIndoorIds).toEqual(['angled-cassette']);
    expect(result.issues.join(' ')).toContain('best feasible sealed subset');

    const document = buildVrfDocumentFromHvacElements([...scene, ...result.elementsToAdd]);
    const validPorts = Object.values(document.equipmentPorts).filter(port => port.equipmentId === valid.id);
    expect(validPorts).toHaveLength(2);
    expect(validPorts.every(port => port.isConnected)).toBe(true);
    const unsupportedPorts = Object.values(document.equipmentPorts).filter(port => port.equipmentId === unsupported.id);
    expect(unsupportedPorts.every(port => !port.isConnected)).toBe(true);
  });

  it('connects every discovered cassette in a two-row layout before returning mutations', async () => {
    const indoors = [
      equipment('upper-left', 500, 500),
      equipment('upper-right', 5500, 500),
      equipment('lower-left', 1500, 3000),
      equipment('lower-right', 6000, 3000),
    ];
    const scene = [equipment('outdoor', 10000, 5000, true), ...indoors];
    const result = await planAutoRouteNetwork(scene, {
      settings: DEFAULT_PIPE_ROUTING_SETTINGS,
      objective: 'balanced',
    });

    expect(result.complete, result.issues.join('\n')).toBe(true);
    expect(result.unconnectedIndoorIds).toEqual([]);
    expect(result.connectedIndoorIds.sort()).toEqual(indoors.map(unit => unit.id).sort());

    const document = buildVrfDocumentFromHvacElements([...scene, ...result.elementsToAdd]);
    for (const unit of indoors) {
      const ports = Object.values(document.equipmentPorts).filter(port => port.equipmentId === unit.id);
      expect(ports).toHaveLength(2);
      expect(ports.every(port => port.isConnected), unit.id).toBe(true);
    }
  }, 180000);
});
