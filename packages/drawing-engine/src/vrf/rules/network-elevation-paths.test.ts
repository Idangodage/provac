import { describe, expect, it } from 'vitest';

import { createEmptyVrfPipingDocument, type VrfPipingDocument } from '../domain/types';

import { buildNetworkElevationPaths } from './network-elevation-paths';
import { PROJECT_FALLBACK_RULE_PROFILE } from './rule-profile';
import { validateVrfNetwork } from './validation-engine';

function addEquipment(document: VrfPipingDocument, id: string, outdoor: boolean): string {
  const portId = `${id}:gas`;
  document.equipmentNodes[id] = {
    id, kind: 'equipment', equipmentType: outdoor ? 'outdoor-unit' : 'indoor-unit',
    transform: {
      position: { x: 0, y: 0, z: 2600 }, orientation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
    portIds: [portId],
  };
  document.equipmentPorts[portId] = {
    id: portId, equipmentId: id, systemType: 'refrigerant-gas',
    positionLocal: { x: 0, y: 0, z: 0 }, directionLocal: { x: 1, y: 0, z: 0 },
    connectionDiameterMm: 15.88, connectionType: 'brazed', compatiblePipeKinds: ['copper'], isConnected: true,
  };
  return portId;
}

function addRun(document: VrfPipingDocument, id: string, from: string, to: string) {
  const edgeId = `${id}:edge`;
  document.pipeRuns[id] = {
    id, kind: 'pipe-run', systemType: 'refrigerant-gas', lineKind: 'gas', pipeKind: 'copper',
    nodeIds: [from, to], segmentEdgeIds: [edgeId],
  };
  document.segmentEdges[edgeId] = {
    id: edgeId, kind: 'pipe-segment', runId: id, startNodeId: from, endNodeId: to,
    systemType: 'refrigerant-gas', lineKind: 'gas', pipeKind: 'copper',
    nominalDiameterMm: 15.88, outsideDiameterMm: 15.88, insulationThicknessMm: 10,
  };
}

function network() {
  const document = createEmptyVrfPipingDocument('elevation');
  [2600, 2300, 2300, 2600].forEach((z, index) => {
    document.routeNodes[`n${index}`] = {
      id: `n${index}`, kind: 'route', position: { x: index * 1000, y: 0, z }, connectedEdgeIds: [],
    };
  });
  addRun(document, 'outdoor-leg', 'n0', 'n1');
  // Opposite authoring direction must not change the connected path.
  addRun(document, 'trunk', 'n2', 'n1');
  addRun(document, 'indoor-leg', 'n2', 'n3');
  document.pipeRuns['outdoor-leg']!.sourcePortId = addEquipment(document, 'outdoor', true);
  document.pipeRuns['indoor-leg']!.targetPortId = addEquipment(document, 'indoor', false);
  return document;
}

describe('connected equipment elevation profiles', () => {
  it('finds a low pocket spanning individually monotonic runs in either authoring direction', () => {
    const document = network();
    const paths = buildNetworkElevationPaths(document);
    expect(paths).toHaveLength(1);
    expect(paths[0]?.nodePositions.map((point) => point.z)).toEqual([2600, 2300, 2300, 2600]);
    const report = validateVrfNetwork({
      ports: [], branches: [], pairs: [], elevationPaths: paths,
      runs: Object.values(document.pipeRuns).map((run) => ({
        id: run.id, systemType: run.systemType, lineKind: run.lineKind, pipeKind: run.pipeKind,
        diameterMm: 15.88, insulationSpecified: true,
        nodePositions: run.nodeIds.map((id) => document.routeNodes[id]!.position),
      })),
    }, PROJECT_FALLBACK_RULE_PROFILE);
    expect(report.issues.filter((issue) => issue.code.includes('LOW_POCKET'))).toEqual([
      expect.objectContaining({ code: 'NETWORK_ELEVATION_LOW_POCKET', entityId: 'indoor', level: 'warning' }),
    ]);
    expect(report.commitBlocked).toBe(false);
  });

  it('does not join disconnected or different-service lines by visual proximity', () => {
    const document = network();
    document.routeNodes.disconnected = { ...document.routeNodes.n1!, id: 'disconnected' };
    document.segmentEdges['trunk:edge']!.endNodeId = 'disconnected';
    expect(buildNetworkElevationPaths(document)).toEqual([]);
    const differentService = network();
    differentService.segmentEdges['trunk:edge']!.lineKind = 'liquid';
    expect(buildNetworkElevationPaths(differentService)).toEqual([]);
  });

  it('does not guess a path through cycles or more than one outdoor source', () => {
    const cyclic = network();
    addRun(cyclic, 'cycle', 'n0', 'n3');
    expect(buildNetworkElevationPaths(cyclic)).toEqual([]);
    const multiple = network();
    multiple.pipeRuns.trunk!.sourcePortId = addEquipment(multiple, 'other-outdoor', true);
    expect(buildNetworkElevationPaths(multiple)).toEqual([]);
  });

  it('follows physical fitting sockets across a branch', () => {
    const document = network();
    document.routeNodes.inlet = { ...document.routeNodes.n1!, id: 'inlet' };
    document.segmentEdges['outdoor-leg:edge']!.endNodeId = 'inlet';
    document.pipeRuns['outdoor-leg']!.nodeIds[1] = 'inlet';
    document.branchKits.branch = {
      id: 'branch', kind: 'branch-kit', manufacturer: 'Unspecified', family: 'test', model: 'test',
      branchType: 'y-joint', systemRole: 'first-branch', lineKind: 'gas', inletNodeIds: ['inlet'],
      ruleProfileId: PROJECT_FALLBACK_RULE_PROFILE.id,
      outletNodeIds: ['n1'], position: { x: 1000, y: 0, z: 2300 },
      orientation: { x: 0, y: 0, z: 0, w: 1 }, localForward: { x: 1, y: 0, z: 0 },
      localUp: { x: 0, y: 0, z: 1 }, splitPlaneNormal: { x: 0, y: 0, z: 1 }, downstreamCapacityIndex: 0,
    };
    expect(buildNetworkElevationPaths(document)[0]?.nodePositions.map((point) => point.z))
      .toEqual([2600, 2300, 2300, 2300, 2600]);
  });
});
