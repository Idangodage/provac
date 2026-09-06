import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import {
  buildRefrigerantPipeElements,
  getRefrigerantPipeBundleSnapTargets,
} from '../hvac/refrigerantPipePairModel';

import { validateHvacElementsAsVrf } from './useVrfLiveValidation';

function outdoorUnit(id: string): HvacElement {
  return {
    id,
    type: 'outdoor-unit',
    category: 'outdoor-unit',
    position: { x: 1000, y: 1000 },
    rotation: 0,
    width: 1350,
    depth: 764,
    height: 1650,
    elevation: 0,
    mountType: 'floor',
    label: 'VRF outdoor unit',
    supplyZoneRatio: 0.5,
    properties: {},
  };
}

function gasPipe(
  id: string,
  routePoints: Point2D[],
  extra: Record<string, unknown> = {},
): HvacElement {
  return {
    id,
    type: 'refrigerant-pipe',
    category: 'accessory',
    subtype: 'gas',
    modelLabel: 'Gas Pipe',
    position: { x: 0, y: 0 },
    rotation: 0,
    width: 200,
    depth: 20,
    height: 20,
    elevation: 0,
    mountType: 'ceiling',
    label: id,
    supplyZoneRatio: 0,
    properties: {
      routePoints,
      lineKind: 'gas',
      pipeDiameterMm: 28,
      insulationThicknessMm: 20,
      ...extra,
    },
  };
}

describe('validateHvacElementsAsVrf', () => {
  it('derives the live pipe rule facts from persisted HvacElement properties', () => {
    const element = gasPipe(
      'gas-1',
      [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }],
      {
        routeNodes3d: [
          { x: 0, y: 0, z: 100 },
          { x: 100, y: 0, z: 0 },
          { x: 200, y: 0, z: 100 },
        ],
        expectedDiameterMm: 22,
        slopeTowardOutdoorPercent: 0,
        hasSagPocket: true,
        flowDirectionValid: false,
        insulated: false,
      },
    );

    const codes = new Set(validateHvacElementsAsVrf([element]).issues.map((issue) => issue.code));
    expect(codes).toEqual(expect.objectContaining(new Set([
      'PIPE_SIZE',
      'FLOW_DIR',
      'SLOPE',
      'NO_SAG_TRAP',
      'INSULATION',
    ])));
  });

  it('detects a bare three-way refrigerant node as NO_TEE', () => {
    const trunk = gasPipe('trunk', [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    const connection = {
      portPoint: { x: 100, y: 0 },
      direction: { x: 1, y: 0 },
      elevationMm: 10,
      connectionKind: 'field-pipe',
      sourceElementId: 'trunk',
    };
    const runA = gasPipe(
      'branch-a',
      [{ x: 100, y: 0 }, { x: 200, y: 80 }],
      { startConnection: connection },
    );
    const runB = gasPipe(
      'branch-b',
      [{ x: 100, y: 0 }, { x: 200, y: -80 }],
      { startConnection: connection },
    );

    const issues = validateHvacElementsAsVrf([trunk, runA, runB]).issues;
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'NO_TEE', entityId: 'trunk' }),
    ]));
  });

  it('does not flag pair separation on a pair drawn with stock settings', () => {
    const pair = buildRefrigerantPipeElements(
      [{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 2000 }],
      { bundleId: 'bundle-1' },
    ).map((partial, index) => ({ id: `pair-pipe-${index}`, ...partial })) as HvacElement[];

    const codes = validateHvacElementsAsVrf(pair).issues.map((issue) => issue.code);
    expect(codes).not.toContain('pipe-pair-separation');
  });

  it('flags pair separation when one line drifts from the routed spacing', () => {
    const pair = buildRefrigerantPipeElements(
      [{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 2000 }],
      { bundleId: 'bundle-1' },
    ).map((partial, index) => ({ id: `pair-pipe-${index}`, ...partial })) as HvacElement[];
    const liquid = pair.find((element) => element.properties.lineKind === 'liquid')!;
    liquid.properties = {
      ...liquid.properties,
      routePoints: (liquid.properties.routePoints as Point2D[]).map((point) => ({
        x: point.x + 80,
        y: point.y + 80,
      })),
    };

    const codes = validateHvacElementsAsVrf(pair).issues.map((issue) => issue.code);
    expect(codes).toContain('pipe-pair-separation');
  });

  it('flags PORT_STUB when a route leaves a unit port perpendicular to its normal', () => {
    const unit = outdoorUnit('odu-1');
    const target = getRefrigerantPipeBundleSnapTargets([unit])
      .find((candidate) => candidate.connectionKind === 'unit-port')!;
    const start = target.gasPoint;
    const direction = target.gasDirection ?? target.direction;
    const perpendicular = { x: -direction.y, y: direction.x };
    const pipe = gasPipe(
      'gas-1',
      [start, { x: start.x + perpendicular.x * 1500, y: start.y + perpendicular.y * 1500 }],
      {
        startConnection: {
          portPoint: start,
          direction,
          elevationMm: target.gasElevationMm ?? 500,
          connectionKind: 'unit-port',
          sourceElementId: unit.id,
        },
      },
    );

    const codes = validateHvacElementsAsVrf([unit, pipe]).issues.map((issue) => issue.code);
    expect(codes).toContain('PORT_STUB');
  });

  it('stays silent on PORT_STUB when the route exits along the port normal', () => {
    const unit = outdoorUnit('odu-1');
    const target = getRefrigerantPipeBundleSnapTargets([unit])
      .find((candidate) => candidate.connectionKind === 'unit-port')!;
    const start = target.gasPoint;
    const direction = target.gasDirection ?? target.direction;
    const stubEnd = { x: start.x + direction.x * 400, y: start.y + direction.y * 400 };
    const pipe = gasPipe(
      'gas-1',
      [start, stubEnd, { x: stubEnd.x - direction.y * 1500, y: stubEnd.y + direction.x * 1500 }],
      {
        startConnection: {
          portPoint: start,
          direction,
          elevationMm: target.gasElevationMm ?? 500,
          connectionKind: 'unit-port',
          sourceElementId: unit.id,
        },
      },
    );

    const codes = validateHvacElementsAsVrf([unit, pipe]).issues.map((issue) => issue.code);
    expect(codes).not.toContain('PORT_STUB');
  });
});
