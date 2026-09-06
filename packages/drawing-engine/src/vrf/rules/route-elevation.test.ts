import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../types';
import { buildVrfDocumentFromHvacElements } from '../domain/hvac-element-adapter';

import { buildVrfValidationSnapshot } from './document-validation-adapter';
import { analyzeRouteElevation } from './route-elevation';
import { PROJECT_FALLBACK_RULE_PROFILE } from './rule-profile';
import { validateVrfNetwork, type ValidationRunInput } from './validation-engine';

const points = (...heights: number[]) => heights.map((z, index) => ({ x: index * 100, y: 0, z }));
const run = (heights: number[], properties: Partial<ValidationRunInput> = {}): ValidationRunInput => ({
  id: 'gas',
  systemType: 'refrigerant-gas',
  lineKind: 'gas',
  pipeKind: 'copper',
  diameterMm: 15.88,
  insulationSpecified: true,
  nodePositions: points(...heights),
  ...properties,
});
const report = (input: ValidationRunInput) => validateVrfNetwork(
  { ports: [], runs: [input], branches: [], pairs: [] }, PROJECT_FALLBACK_RULE_PROFILE,
);

describe('route elevation screening', () => {
  it('accepts level runs and monotonic terminal rises or drops', () => {
    for (const route of [points(2200, 2200, 2200), points(2200, 2200, 2600, 2600)]) {
      for (const ordered of [route, [...route].reverse()]) {
        expect(analyzeRouteElevation(ordered)).toMatchObject({
          elevationReversals: 0, excessVerticalTravelMm: 0, lowPockets: [],
        });
      }
    }
  });

  it('detects a flat-bottom low pocket and measures its shallower retaining side', () => {
    const analysis = analyzeRouteElevation(points(2600, 2300, 2300, 2500));
    expect(analysis).toMatchObject({
      elevationReversals: 1,
      totalVerticalTravelMm: 500,
      excessVerticalTravelMm: 400,
      lowPockets: [{ startIndex: 1, endIndex: 2, bottomElevationMm: 2300, depthMm: 200 }],
    });
  });

  it('distinguishes an overhead crest from a low pocket in either drawing direction', () => {
    const route = points(2300, 2600, 2600, 2300);
    for (const ordered of [route, [...route].reverse()]) {
      expect(analyzeRouteElevation(ordered)).toMatchObject({
        elevationReversals: 1, excessVerticalTravelMm: 600, lowPockets: [],
      });
    }
  });

  it('counts repeated reversals without losing finely sampled slopes', () => {
    const route = [...Array.from({ length: 401 }, (_, index) => index / 2), 200,
      ...Array.from({ length: 401 }, (_, index) => 200 - index / 2)];
    expect(analyzeRouteElevation(points(...route))).toMatchObject({
      elevationReversals: 1, excessVerticalTravelMm: 400,
    });
    expect(analyzeRouteElevation(points(200, 0, 100, 0, 200))).toMatchObject({
      elevationReversals: 3, excessVerticalTravelMm: 600,
      lowPockets: [{ depthMm: 100 }, { depthMm: 100 }],
    });
  });

  it('filters sub-millimetre model noise and does not mutate authored points', () => {
    const route = points(2400, 2400.2, 2399.8, 2400.1, 2400);
    const original = structuredClone(route);
    expect(analyzeRouteElevation(route)).toMatchObject({
      elevationReversals: 0, excessVerticalTravelMm: 0, lowPockets: [],
    });
    expect(route).toEqual(original);
  });

  it('reports geometric pockets for review without asserting an invalid trap or blocking commits', () => {
    const result = report(run([2600, 2300, 2300, 2600], { hasSagPocket: false }));
    const issue = result.issues.find((candidate) => candidate.code === 'ELEVATION_LOW_POCKET');
    expect(issue?.level).toBe('warning');
    expect(issue?.fix).toBeUndefined();
    expect(result.issues.some((candidate) => candidate.code === 'NO_SAG_TRAP')).toBe(false);
    expect(result.commitBlocked).toBe(false);
    expect(report(run([2300, 2600, 2600, 2300])).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ELEVATION_REVERSAL', level: 'advisory' }),
    ]));
  });

  it('keeps an explicit engineering sag flag distinct from geometric screening and excludes drains', () => {
    expect(report(run([2600, 2300, 2600], { hasSagPocket: true })).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'NO_SAG_TRAP', level: 'error' }),
    ]));
    expect(report(run([2600, 2300, 2600], { lineKind: 'drain' })).issues
      .some((issue) => issue.code.startsWith('ELEVATION_'))).toBe(false);
  });

  it('surfaces legacy display bypasses, but ignores stale bypasses after a canonical 3D route exists', () => {
    const element: HvacElement = {
      id: 'legacy', type: 'refrigerant-pipe', category: 'accessory', subtype: 'gas',
      modelLabel: 'Gas', position: { x: 0, y: 0 }, rotation: 0, width: 1000,
      depth: 40, height: 40, elevation: 2600, mountType: 'ceiling', label: 'Gas', supplyZoneRatio: 0,
      properties: {
        routePoints: [{ x: 0, y: 0 }, { x: 1000, y: 0 }], lineKind: 'gas', pipeDiameterMm: 15.88,
        bypasses: [{
          id: 'offset', baseElevationMm: 2600, bypassElevationMm: 2800,
          enterPoint: { x: 200, y: 0 }, exitPoint: { x: 800, y: 0 }, obstaclePoint: { x: 500, y: 0 },
        }],
      },
    };
    const legacy = buildVrfValidationSnapshot(buildVrfDocumentFromHvacElements([element]));
    expect(legacy.runs[0]?.legacyElevationBypassCount).toBe(1);
    expect(validateVrfNetwork(legacy, PROJECT_FALLBACK_RULE_PROFILE).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'LEGACY_ELEVATION_BYPASS', level: 'warning' }),
    ]));
    const explicit = buildVrfValidationSnapshot(buildVrfDocumentFromHvacElements([{
      ...element, properties: { ...element.properties, routeNodes3d: points(2600, 2300, 2300, 2600) },
    }]));
    expect(explicit.runs[0]?.legacyElevationBypassCount).toBeUndefined();
    expect(explicit.runs[0]?.hasSagPocket).toBeUndefined();
    expect(validateVrfNetwork(explicit, PROJECT_FALLBACK_RULE_PROFILE).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ELEVATION_LOW_POCKET', level: 'warning' }),
    ]));
  });
});
