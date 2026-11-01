// The user's screenshots of 1 November: refrigerant mains below the ceiling, gas and liquid stepping apart. Auto route
// now lays the pair side by side, in the void, and ranks a layout with mains in the rooms below the ceiling last.
import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';
import { PROJECT_FALLBACK_RULE_PROFILE } from '../../../vrf/rules';
import { validateHvacElementsAsVrf } from '../hooks/useVrfLiveValidation';

import { planAutoRouteNetwork } from './autoRouteNetwork';
import { hasNewNetworkPipeClash } from './networkPipeClearance';
import { DEFAULT_PIPE_ROUTING_SETTINGS, resolvePipeRoutingSettings, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { checkRefrigerantAboveCeiling, refrigerantBelowCeiling } from './refrigerantCeilingCheck';
import { getRefrigerantPipeBundleSnapTargets } from './refrigerantPipePairModel';
import { rankServiceRouteCandidates } from './serviceRouteObjective';
import { layoutRefrigerantSupports, refrigerantSupportBomRows } from './refrigerantSupports';
import { addRefrigerantSupportMeshes } from './three3d/refrigerantSupportMeshes';
import type { UnifiedAutoRouteResult } from './unifiedAutoRoute';

beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

function cassette(id: string, x: number, y: number): HvacElement {
  return {
    id, type: 'ceiling-cassette-ac', category: 'indoor-unit', label: id, position: { x, y }, rotation: 0, width: 600, depth: 600, height: 250,
    elevation: 2400, mountType: 'ceiling', supplyZoneRatio: 0, properties: { capacityKw: 2.8, dischargeWays: 4 },
  };
}
function outdoor(): HvacElement {
  return {
    id: 'odu', type: 'outdoor-unit', category: 'outdoor-unit', label: 'ODU', position: { x: -3000, y: 4000 }, rotation: 0, width: 900, depth: 450, height: 1200,
    elevation: 0, mountType: 'floor', supplyZoneRatio: 0, properties: {},
  };
}
function pipe(id: string, nodes: Array<[number, number, number]>, extra: Record<string, unknown> = {}): HvacElement {
  return {
    id, type: 'refrigerant-pipe', position: { x: 0, y: 0 }, rotation: 0, width: 1, depth: 1, height: 60, elevation: nodes[0]![2] - 30, mountType: 'ceiling',
    label: id, supplyZoneRatio: 0,
    properties: { lineKind: 'gas', routePoints: nodes.map(([x, y]) => ({ x, y })), routeNodes3d: nodes.map(([x, y, z]) => ({ x, y, z })), pipeDiameterMm: 15.875, ...extra },
  } as HvacElement;
}
const room = { vertices: [{ x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 8000 }, { x: 0, y: 8000 }] };

describe('mains below the ceiling', () => {
  it('measures the level stretches in the rooms whose insulation hangs below the ceiling', () => {
    const main = pipe('main', [[1000, 1000, 2380], [6000, 1000, 2380], [6000, 1000, 2700], [9000, 1000, 2700]]);
    expect(refrigerantBelowCeiling([main], [room], 2400).lengthMm).toBeCloseTo(5000, 6);
    // Up in the void: nothing.
    expect(refrigerantBelowCeiling([pipe('high', [[1000, 1000, 2700], [6000, 1000, 2700]])], [room], 2400).lengthMm).toBe(0);
    // Outside every room (to the outdoor unit): not counted.
    expect(refrigerantBelowCeiling([pipe('out', [[-2000, 1000, 1200], [-500, 1000, 1200]])], [room], 2400).lengthMm).toBe(0);
  });

  it('a unit\'s own connection at its port\'s level is not a main', () => {
    const startConnection = { connectionKind: 'unit-port', elevationMm: 1500, portPoint: { x: 1000, y: 1000 }, direction: { x: 1, y: 0 }, sourceElementId: 'floor-unit' };
    const stub = pipe('stub', [[1000, 1000, 1500], [1400, 1000, 1500], [1400, 1000, 2700], [5000, 1000, 2700]], { startConnection });
    expect(refrigerantBelowCeiling([stub], [room], 2400).lengthMm).toBe(0);
  });

  it('is a warning on the run, with the ceiling the drawing says', () => {
    const scene = [cassette('c', 4000, 4000), pipe('main', [[1000, 1000, 2380], [6000, 1000, 2380]])];
    const [issue] = checkRefrigerantAboveCeiling(scene, [room]);
    expect(issue).toMatchObject({ code: 'REFRIGERANT_BELOW_CEILING', level: 'warning', entityId: 'main' });
    expect(issue!.message).toContain('5.0 m level below the 2400 mm ceiling');
  });

  it('a layout with mains below the ceiling ranks after one without, though it costs less', () => {
    const result = (key: string, belowMm: number, gasLengthMm: number) => ({
      key, result: {
        services: { gas: true, liquid: true, condensate: false }, ducts: null, condensate: null, clashes: [], issues: [], refrigerantBelowCeilingMm: belowMm,
        refrigerant: { complete: true, connectedIndoorIds: ['a'], unconnectedIndoorIds: [], metrics: { gasLengthMm, liquidLengthMm: gasLengthMm, relativeCostIndex: gasLengthMm / 1000 } },
      } as unknown as UnifiedAutoRouteResult,
    });
    const ranked = rankServiceRouteCandidates([result('low', 9000, 30000), result('high', 0, 40000)]);
    expect(ranked[0]!.key).toBe('high');
  });
});

describe('Auto route lays the pair side by side', () => {
  it('both lines at one level, in the void, every unit served, nothing touching', async () => {
    const units = [cassette('c1', 2000, 2000), cassette('c2', 7000, 2000)];
    const scene = [outdoor(), ...units];
    const result = await planAutoRouteNetwork(scene, { settings: DEFAULT_PIPE_ROUTING_SETTINGS, objective: 'balanced' });
    expect(result.complete, result.issues.join(' | ')).toBe(true);
    const plans = result.elementsToAdd.filter((element) => element.type === 'refrigerant-pipe')
      .map((element) => element.properties.networkLevelPlan as { gasElevationMm: number; liquidElevationMm: number; arrangement: string; flatPending?: boolean });
    expect(plans.every((plan) => plan.arrangement === 'side-by-side' && plan.gasElevationMm === plan.liquidElevationMm && !plan.flatPending)).toBe(true);
    // Above the cassettes' stubs, under the soffit.
    const stub = Math.max(...units.map((unit) => getRefrigerantPipeBundleSnapTargets([unit])[0]!.gasElevationMm));
    expect(plans[0]!.gasElevationMm).toBeGreaterThan(stub);
    expect(plans[0]!.gasElevationMm).toBeLessThanOrEqual(DEFAULT_PIPE_ROUTING_SETTINGS.ceilingLimitMm);
    expect(hasNewNetworkPipeClash(scene, result.elementsToAdd)).toBe(false);
  }, 120_000);

  it('stacked when asked to', async () => {
    const settings = resolvePipeRoutingSettings({ pairArrangement: 'stacked' });
    setActivePipeRoutingSettings(settings);
    const scene = [outdoor(), cassette('c1', 2000, 2000)];
    const result = await planAutoRouteNetwork(scene, { settings, objective: 'balanced' });
    expect(result.complete).toBe(true);
    const plan = result.elementsToAdd.find((element) => element.type === 'refrigerant-pipe')!.properties.networkLevelPlan as { gasElevationMm: number; liquidElevationMm: number };
    expect(plan.gasElevationMm).not.toBe(plan.liquidElevationMm);
  }, 120_000);
});

describe('the supports', () => {
  it('a clip on a rod to the soffit along a level run: 1.5 m apart, 300 mm clear of its ends', () => {
    const supports = layoutRefrigerantSupports(pipe('run', [[0, 0, 2800], [4600, 0, 2800]]), 2900);
    expect(supports.map((support) => Math.round(support.point.x))).toEqual([300, 1633, 2967, 4300]);
    // Ø15.88 in 25.4 mm of insulation: the rod from 2833 mm up to the soffit.
    expect(supports[0]!.rodLengthMm).toBeCloseTo(2900 - (2800 + 66.675 / 2), 6);
  });

  it('none on a riser or a jog too short to hold; the BOM counts clips by size, the rod and its anchors', () => {
    expect(layoutRefrigerantSupports(pipe('riser', [[0, 0, 2400], [0, 0, 2800]]), 2900)).toEqual([]);
    expect(layoutRefrigerantSupports(pipe('jog', [[0, 0, 2800], [400, 0, 2800]]), 2900)).toEqual([]);
    const rows = refrigerantSupportBomRows(layoutRefrigerantSupports(pipe('run', [[0, 0, 2800], [4600, 0, 2800]]), 2900));
    expect(rows.map((row) => `${row.size} ${row.quantity} ${row.unit}`)).toEqual(['Ø67 4 no.', 'M8 0.3 m', 'M8 4 no.']);
  });

  it('drawn in 3D: a clip and a rod at each', () => {
    const group = new THREE.Group();
    addRefrigerantSupportMeshes(group, pipe('run', [[0, 0, 2800], [4600, 0, 2800]]), 2900);
    expect(group.children.filter((child) => child.name === 'refrigerant-support-clip')).toHaveLength(4);
    const rod = group.children.find((child) => child.name === 'refrigerant-support-rod')!;
    const box = new THREE.Box3().setFromObject(rod);
    expect(box.max.z).toBeCloseTo(2900, 3);
  });
});

describe('what the checks judge', () => {
  it('the straight off a branch kit is the project\'s figure until the maker\'s is loaded', () => {
    const profile = PROJECT_FALLBACK_RULE_PROFILE;
    expect(profile.installation?.minimumBranchElbowClearanceMm?.verified).toBe(false);
    // (Exercised through the bridge: no kit here, so only that it runs with the project's settings.)
    expect(validateHvacElementsAsVrf([], profile, DEFAULT_PIPE_ROUTING_SETTINGS).issues).toEqual([]);
  });

  it('a 4-way cassette takes the maker\'s line sizes, not its drawn stubs\'', () => {
    const port = getRefrigerantPipeBundleSnapTargets([{ ...cassette('c', 0, 0), properties: { modelCode: 'FDT28KXZE1', capacityKw: 2.8 }, width: 1043, depth: 950, height: 272 }])[0]!;
    expect(port.gasOuterDiameterMm).toBe(9.52);
    expect(port.liquidOuterDiameterMm).toBe(6.35);
  });
});
