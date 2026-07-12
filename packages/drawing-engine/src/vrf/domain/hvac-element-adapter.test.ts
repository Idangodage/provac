import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../types';

import {
  buildVrfDocumentFromHvacElements,
  hvacVrfSemanticIds,
} from './hvac-element-adapter';

function gasPipe(
  id: string,
  routePoints: Array<{ x: number; y: number }>,
  properties: Record<string, unknown> = {},
): HvacElement {
  return {
    id,
    type: 'refrigerant-pipe',
    category: 'accessory',
    subtype: 'gas',
    modelLabel: 'Gas pipe',
    position: { x: Math.min(...routePoints.map((point) => point.x)), y: 0 },
    rotation: 0,
    width: 100,
    depth: 20,
    height: 20,
    elevation: 2600,
    mountType: 'ceiling',
    label: id,
    supplyZoneRatio: 0,
    properties: {
      lineKind: 'gas',
      pipeDiameterMm: 15.88,
      routePoints,
      ...properties,
    },
  };
}

describe('HvacElement VRF graph adapter', () => {
  it('honors an explicit field-pipe node id instead of assuming the source end', () => {
    const sourceRunId = hvacVrfSemanticIds.pipeRun('source', 'gas');
    const sourceStartNodeId = hvacVrfSemanticIds.routeNode(sourceRunId, 'start');
    const sourceEndNodeId = hvacVrfSemanticIds.routeNode(sourceRunId, 'end');
    const source = gasPipe('source', [{ x: 0, y: 0 }, { x: 1000, y: 0 }]);
    const extension = gasPipe(
      'extension',
      [{ x: 0, y: 0 }, { x: -500, y: 0 }],
      {
        startConnection: {
          portPoint: { x: 0, y: 0 },
          direction: { x: -1, y: 0 },
          elevationMm: 2610,
          connectionKind: 'field-pipe',
          sourceElementId: 'source',
          nodeId: sourceStartNodeId,
        },
      },
    );

    const document = buildVrfDocumentFromHvacElements([source, extension]);
    const extensionRun = document.pipeRuns[
      hvacVrfSemanticIds.pipeRun('extension', 'gas')
    ]!;

    expect(extensionRun.nodeIds[0]).toBe(sourceStartNodeId);
    expect(extensionRun.nodeIds[0]).not.toBe(sourceEndNodeId);
    expect(document.routeNodes[sourceStartNodeId]?.connectedEdgeIds).toHaveLength(2);
  });

  it('preserves a persisted 3D branch orientation for tilt validation', () => {
    const halfAngle = Math.PI / 8;
    const branch: HvacElement = {
      id: 'branch',
      type: 'refrigerant-branch-kit',
      category: 'accessory',
      subtype: 'dis-22-1g-gas',
      modelLabel: 'DIS-22-1G Gas',
      position: { x: 100, y: 100 },
      rotation: 0,
      width: 300,
      depth: 180,
      height: 80,
      elevation: 2600,
      mountType: 'ceiling',
      label: 'Branch',
      supplyZoneRatio: 0,
      properties: {
        branchKitType: 'dis-22-1g',
        branchKitLineKind: 'gas',
        branchType: 'y-joint',
        orientationQuaternion: {
          x: 0,
          y: Math.sin(halfAngle),
          z: 0,
          w: Math.cos(halfAngle),
        },
      },
    };

    const document = buildVrfDocumentFromHvacElements([branch]);
    expect(Object.values(document.branchKits)[0]?.orientation).toEqual({
      x: 0,
      y: Math.sin(halfAngle),
      z: 0,
      w: Math.cos(halfAngle),
    });
  });
});
