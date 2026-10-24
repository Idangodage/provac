import { describe, expect, it } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../data/ac-equipment-library';
import type { HvacElement } from '../../../types';
import { validateHvacElementsAsVrf } from '../hooks/useVrfLiveValidation';

import { buildAutoRouteReview } from './autoRouteReview';
import { connectionRatioMessage, connectionRatioProblems, connectionRatios } from './connectionRatio';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from './pipeRoutingSettings';
import type { UnifiedAutoRouteResult } from './unifiedAutoRoute';

let serial = 0;
function place(definitionId: string, x: number, properties: Record<string, unknown> = {}): HvacElement {
  const def = DEFAULT_AC_EQUIPMENT_LIBRARY.find((entry) => entry.id === definitionId)!;
  serial += 1;
  return {
    id: `${definitionId}-${serial}`, type: def.type, category: def.equipmentCategory, subtype: def.subtype, modelLabel: def.modelLabel,
    position: { x, y: 0 }, rotation: 0, width: def.widthMm, depth: def.depthMm, height: def.heightMm, elevation: def.elevationMm,
    mountType: def.mountType, label: def.name, supplyZoneRatio: 0.5, properties: { definitionId: def.id, ...(def.defaultProperties ?? {}), ...properties },
  } as HvacElement;
}

// The user's building (23 October 2026): 22.4 + 2 × 14 + 4 × 2.8 = 61.6 kW of indoor units on one 28 kW FDC280.
const outdoor = place('vrf-fdc280kxze1', 20000);
const indoors = [
  place('vrf-fdu224kxze1', 0), place('vrf-fdum140kxe6f', 2000), place('vrf-fdum140kxe6f', 4000),
  ...[6000, 8000, 10000, 12000].map((x) => place('vrf-fdt28kxze1', x)),
];
const range = DEFAULT_PIPE_ROUTING_SETTINGS;

describe('connection ratio: the indoor units over the outdoor unit', () => {
  it("the user's building: 61.6 kW on 28 kW is 220 %, far over 130 %", () => {
    const [ratio] = connectionRatioProblems([outdoor, ...indoors], range);
    expect(ratio).toMatchObject({ outdoorId: outdoor.id, outdoorKw: 28, minPercent: 50, maxPercent: 130, unrated: 0 });
    expect(ratio!.indoorKw).toBeCloseTo(61.6, 9);
    expect(ratio!.percent).toBeCloseTo(220, 6);
    expect(connectionRatioMessage(ratio!)).toBe('MHI Outdoor VRF — FDC280KXZE1 (3D) is too small for its system: its 7 indoor units total 61.6 kW: '
      + '220 % of its 28.0 kW (allowed 50–130 %). Use a larger outdoor unit, or split the indoor units over two systems.');
  });

  it('within the range: nothing to say; under it: too large', () => {
    expect(connectionRatioProblems([outdoor, indoors[0]!], range)).toEqual([]); // 22.4 of 28 kW: 80 %
    const [small] = connectionRatioProblems([outdoor, indoors[3]!, indoors[4]!], range); // 5.6 of 28 kW: 20 %
    expect(connectionRatioMessage(small!)).toMatch(/is too large for its system: its 2 indoor units total 5\.6 kW: 20 % of its 28\.0 kW/);
  });

  it('two outdoor units: each counts the units assigned to it', () => {
    const second = place('vrf-fdc280kxze1', 30000);
    const assigned = indoors.map((indoor, index) => ({ ...indoor, properties: { ...indoor.properties, outdoorUnitId: index < 2 ? outdoor.id : second.id } }));
    const ratios = connectionRatios([outdoor, second, ...assigned], range);
    expect(ratios.map((ratio) => [ratio.outdoorId, Math.round(ratio.percent)])).toEqual([[outdoor.id, 130], [second.id, 90]]);
    expect(connectionRatioProblems([outdoor, second, ...assigned], range)).toEqual([]);
  });

  it('the range is the project setting', () => {
    expect(connectionRatioProblems([outdoor, ...indoors], { connectionRatioMinPercent: 50, connectionRatioMaxPercent: 250 })).toEqual([]);
  });

  it('a warning on the outdoor unit in the live checks', () => {
    const issue = validateHvacElementsAsVrf([outdoor, ...indoors]).issues.find((entry) => entry.code === 'CONNECTION_RATIO');
    expect(issue).toMatchObject({ level: 'warning', entityId: outdoor.id });
    expect(validateHvacElementsAsVrf([outdoor, ...indoors], undefined, { connectionRatioMinPercent: 50, connectionRatioMaxPercent: 250 }).issues
      .some((entry) => entry.code === 'CONNECTION_RATIO')).toBe(false);
  });

  it('the Auto route panel shows it on its own, without blocking Apply', () => {
    const ratio = connectionRatioProblems([outdoor, ...indoors], range)[0]!;
    const refrigerant = { elementsToAdd: [], removeElementIds: [], updates: [], complete: true, connectedIndoorIds: indoors.map((indoor) => indoor.id),
      unconnectedIndoorIds: [], issues: [connectionRatioMessage(ratio)], metrics: null, evaluations: [], evaluatedCandidates: 1, connectionRatios: [ratio] };
    const review = buildAutoRouteReview({ services: { gas: true, liquid: true, condensate: false }, ducts: null, refrigerant, condensate: null,
      clashes: [], issues: [connectionRatioMessage(ratio)] } as unknown as UnifiedAutoRouteResult, []);
    expect(review.capacityWarnings).toEqual([connectionRatioMessage(ratio)]);
    expect(review.installationNotes).toEqual([]);
    expect(review.applyReason).toBeNull();
  });
});
