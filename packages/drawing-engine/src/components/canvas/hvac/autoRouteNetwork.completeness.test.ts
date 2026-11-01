import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';
import { buildVrfDocumentFromHvacElements } from '../../../vrf/domain';

import { planAutoRouteNetwork } from './autoRouteNetwork';
import { buildStraightGiDuctElement } from './giDuctModel';
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
    // The unit left out says why, in a designer's terms.
    expect(result.issues.some(issue => /^angled-cassette: not connected — .+\. Move the unit, or the ducts and pipes by its connections, or route its pipes by hand\.$/.test(issue)), result.issues.join(' | ')).toBe(true);

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

describe('a duct across the main\'s way', () => {
  // (Its connections low, as usual: a main under the ducts is then no low pocket.)
  const source = { ...equipment('outdoor', 8000, 4300, true), elevation: 0 };
  const far = equipment('far-cassette', 800, 500);
  const near = equipment('near-cassette', 6500, 1500);
  const duct = (elevationMm: number) => ({ id: 'duct', rotation: 0, supplyZoneRatio: 0,
    ...buildStraightGiDuctElement([{ x: 4000, y: -60000 }, { x: 4000, y: 60000 }], { ductKind: 'supply', outerWidthMm: 800, outerHeightMm: 700, elevationMm }) }) as HvacElement;
  // The stacked arrangement's fallback under a duct (side by side passes over this one).
  const options = { settings: { ...DEFAULT_PIPE_ROUTING_SETTINGS, pairArrangement: 'stacked' as const }, objective: 'balanced' as const };
  const levels = (element: HvacElement | undefined) => {
    const plan = element?.properties.networkLevelPlan as { gasElevationMm?: number; liquidElevationMm?: number } | undefined;
    return { gas: plan?.gasElevationMm ?? Number.NaN, liquid: plan?.liquidElevationMm ?? Number.NaN };
  };

  it('with a unit left beyond the duct, the main is laid under it and reaches every unit', async () => {
    const scene = [source, far, near, duct(1900)];
    const result = await planAutoRouteNetwork(scene, options);
    expect(result.unconnectedIndoorIds, result.issues.join('\n')).toEqual([]);
    const { gas, liquid } = levels(result.elementsToAdd.find((element) => element.type === 'refrigerant-pipe'));
    // Under the duct's underside, insulation and all, the two services a corridor apart.
    expect(Math.max(gas, liquid) + 70 / 2).toBeLessThanOrEqual(1900);
    expect(Math.abs(gas - liquid)).toBeGreaterThanOrEqual(100);
  });

  it('with no duct in the way nothing changes: the units\' own height, no second search', async () => {
    const clear = await planAutoRouteNetwork([source, far, near], options);
    const above = await planAutoRouteNetwork([source, far, near, duct(3000)], options);
    expect(clear.unconnectedIndoorIds).toEqual([]);
    expect(levels(above.elementsToAdd.find((element) => element.type === 'refrigerant-pipe'))).toEqual(levels(clear.elementsToAdd.find((element) => element.type === 'refrigerant-pipe')));
    expect(above.elementsToAdd.length).toBe(clear.elementsToAdd.length);
  });
});
