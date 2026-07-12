import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';
import type { VrfValidationIssue } from '../../../vrf/rules';

import { buildVrfValidationFixCommand } from './vrfValidationFixes';

function pipe(): HvacElement {
  return {
    id: 'pipe',
    type: 'refrigerant-pipe',
    category: 'accessory',
    subtype: 'gas',
    modelLabel: 'Gas pipe',
    position: { x: 0, y: 0 },
    rotation: 0,
    width: 800,
    depth: 200,
    height: 30,
    elevation: 2600,
    mountType: 'ceiling',
    label: 'Pipe',
    supplyZoneRatio: 0,
    properties: {
      lineKind: 'gas',
      pipeDiameterMm: 12.7,
      routePoints: [{ x: 0, y: 0 }, { x: 40, y: 120 }, { x: 800, y: 120 }],
      startConnection: {
        portPoint: { x: 0, y: 0 },
        direction: { x: 1, y: 0 },
        elevationMm: 2600,
        connectionKind: 'unit-port',
        sourceElementId: 'idu',
      },
    },
  };
}

function issue(
  fix: NonNullable<VrfValidationIssue['fix']>,
  entityId = 'pipe',
): VrfValidationIssue {
  return {
    id: `issue:${fix.kind}`,
    code: 'TEST',
    level: 'error',
    entityId,
    message: 'test',
    fix,
  };
}

describe('VRF validation auto-fixes', () => {
  it('repairs a persisted unit-port route through one command payload', () => {
    const command = buildVrfValidationFixCommand(
      issue({ kind: 'repair-port-stub' }),
      [pipe()],
    );
    const route = command?.updates[0]?.updates.properties?.routePoints;
    expect(route).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 800, y: 120 },
    ]);
  });

  it('applies the recommended manufacturer diameter', () => {
    const command = buildVrfValidationFixCommand(
      issue({ kind: 'set-pipe-diameter', diameterMm: 15.88, lineKind: 'gas' }),
      [pipe()],
    );
    expect(command?.updates[0]?.updates.properties).toMatchObject({
      pipeDiameterMm: 15.88,
    });
  });

  it('levels branch pitch and roll while preserving horizontal yaw', () => {
    const branch: HvacElement = {
      ...pipe(),
      id: 'branch',
      type: 'refrigerant-branch-kit',
      rotation: 0,
      properties: {
        orientationQuaternion: { x: 0.1, y: 0.2, z: 0.3, w: 0.9 },
      },
    };
    const command = buildVrfValidationFixCommand(
      issue({ kind: 'level-branch' }, 'branch'),
      [branch],
    );
    const update = command?.updates[0]?.updates;
    expect(update?.properties?.orientationQuaternion).toMatchObject({ x: 0, y: 0 });
    expect(update?.properties?.orientation3d).toEqual(
      update?.properties?.orientationQuaternion,
    );
    expect(update?.rotation).toBeCloseTo(40.0497, 3);
  });
});
