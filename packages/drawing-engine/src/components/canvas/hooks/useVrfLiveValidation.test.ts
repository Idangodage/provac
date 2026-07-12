import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import { validateHvacElementsAsVrf } from './useVrfLiveValidation';

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
});
