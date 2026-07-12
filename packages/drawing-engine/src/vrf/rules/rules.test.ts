import { describe, expect, it } from 'vitest';

import { createEmptyVrfPipingDocument } from '../domain/types';

import { measureBranchOrientation, validateBranchOrientation } from './branch-orientation';
import { selectBranchKit } from './branch-selection';
import { buildVrfValidationSnapshot } from './document-validation-adapter';
import { calculateDownstreamCapacity } from './downstream-capacity';
import { loadManufacturerRuleProfile } from './manufacturer-rule-loader';
import { selectPipeSize } from './pipe-sizing';
import {
  PROJECT_FALLBACK_RULE_PROFILE,
  resolveRuleValue,
  type ManufacturerRuleProfile,
  type RuleValue,
} from './rule-profile';
import { validateVrfNetwork } from './validation-engine';

const verified = <T>(value: T): RuleValue<T> => ({
  value,
  source: 'manufacturer-model',
  verified: true,
  sourceReference: 'test-manual/table-1',
});

function profile(): ManufacturerRuleProfile {
  return {
    schemaVersion: 1,
    id: 'acme/family-a',
    manufacturer: 'ACME',
    family: 'Family A',
    refrigerants: ['R32'],
    verified: true,
    sourceReferences: ['test-manual'],
    portDefaults: {
      minimumStraightStubMm: verified(200),
      minimumBendRadiusMm: verified(80),
      serviceClearanceMm: verified(100),
    },
    pipeSizing: [{
      id: 'gas-0-100',
      systemType: 'refrigerant-gas',
      capacityIndexMin: 0,
      capacityIndexMax: 100,
      outsideDiameterMm: verified(15.9),
      minimumBendRadiusMm: verified(80),
    }],
    routeLimits: {
      maximumTotalLengthMm: verified(10_000),
      maximumEquivalentLengthMm: verified(12_000),
      maximumHeightDifferenceMm: verified(3_000),
      maximumOutdoorBelowHeightDifferenceMm: verified(1_500),
      maximumIndoorToBranchLengthMm: verified(5_000),
      maximumIndoorUnitCount: verified(8),
    },
    installation: {
      headerOutletLevelToleranceMm: verified(5),
      minimumJointSpacingMm: verified(500),
      minimumBranchElbowClearanceMm: verified(500),
      minimumSelectorBoxElbowClearanceMm: verified(1_000),
      minimumGasSlopePercent: verified(1),
      requireInsulation: true,
      prohibitUnapprovedTee: true,
    },
    branchKits: [{
      id: 'branch-a',
      manufacturer: 'ACME',
      family: 'Family A',
      model: 'BK-100',
      branchType: 'y-joint',
      allowedSystemRoles: ['first-branch', 'intermediate-branch'],
      refrigerants: ['R32'],
      arrangements: ['heat-pump'],
      downstreamCapacityIndexMin: verified(0),
      downstreamCapacityIndexMax: verified(100),
      downstreamBranchCountMin: 2,
      downstreamBranchCountMax: 8,
      upstreamDiametersMm: [22.2, 15.9],
      downstreamDiametersMm: [15.9, 9.52],
      orientation: {
        allowedModes: ['horizontal-split'],
        maximumRollDeviationDeg: verified(5),
        maximumPitchDeviationDeg: verified(5),
        autoLevelToWorldGravity: true,
      },
      straightZones: [{
        upstreamMinimumMm: verified(300),
        downstreamMinimumMm: verified(200),
        noBendAllowed: true,
        noReducerAllowed: true,
        noOtherBranchAllowed: true,
      }],
    }, {
      id: 'header-a',
      manufacturer: 'ACME',
      family: 'Family A',
      model: 'HDR-4',
      branchType: 'header',
      allowedSystemRoles: ['terminal-header'],
      refrigerants: ['R32'],
      arrangements: ['heat-pump'],
      downstreamCapacityIndexMin: verified(0),
      downstreamCapacityIndexMax: verified(100),
      downstreamBranchCountMin: 4,
      downstreamBranchCountMax: 4,
      headerOutletCount: 4,
      upstreamDiametersMm: [22.2],
      downstreamDiametersMm: [9.52],
      equivalentLengthMm: verified(500),
      orientation: {
        allowedModes: ['horizontal-header'],
        maximumRollDeviationDeg: verified(1),
        maximumPitchDeviationDeg: verified(1),
        autoLevelToWorldGravity: true,
      },
      straightZones: [],
    }],
  };
}

describe('rule profiles', () => {
  it('keeps fallback values explicitly unverified and resolves precedence', () => {
    expect(PROJECT_FALLBACK_RULE_PROFILE.verified).toBe(false);
    expect(PROJECT_FALLBACK_RULE_PROFILE.portDefaults.minimumStraightStubMm.source).toBe('fallback');
    expect(PROJECT_FALLBACK_RULE_PROFILE.portDefaults.minimumStraightStubMm.verified).toBe(false);
    expect(resolveRuleValue([
      PROJECT_FALLBACK_RULE_PROFILE.portDefaults.minimumStraightStubMm,
      verified(275),
    ])?.value).toBe(275);
  });

  it('validates external profiles before registration', () => {
    expect(loadManufacturerRuleProfile(profile()).profile?.id).toBe('acme/family-a');
    const invalid = loadManufacturerRuleProfile({ ...profile(), schemaVersion: 2 });
    expect(invalid.profile).toBeNull();
    expect(invalid.errors.length).toBeGreaterThan(0);
  });
});

describe('topology-derived live sizing', () => {
  it('derives the downstream indoor capacity without trusting route authoring direction', () => {
    const document = createEmptyVrfPipingDocument('capacity-network');
    document.equipmentNodes.odu = {
      id: 'odu',
      kind: 'equipment',
      equipmentType: 'outdoor-unit',
      transform: {
        position: { x: 0, y: 0, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
      portIds: ['odu:gas'],
    };
    document.equipmentNodes.idu = {
      id: 'idu',
      kind: 'equipment',
      equipmentType: 'indoor-unit',
      capacityIndex: 42,
      transform: {
        position: { x: 1000, y: 0, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
      portIds: ['idu:gas'],
    };
    for (const [id, equipmentId] of [['odu:gas', 'odu'], ['idu:gas', 'idu']] as const) {
      document.equipmentPorts[id] = {
        id,
        equipmentId,
        systemType: 'refrigerant-gas',
        positionLocal: { x: 0, y: 0, z: 0 },
        directionLocal: { x: 1, y: 0, z: 0 },
        connectionDiameterMm: 12.7,
        connectionType: 'brazed',
        compatiblePipeKinds: ['copper'],
        isConnected: true,
      };
    }
    document.routeNodes.nearOdu = {
      id: 'nearOdu',
      kind: 'endpoint',
      position: { x: 0, y: 0, z: 0 },
      connectedEdgeIds: ['edge'],
    };
    document.routeNodes.nearIdu = {
      id: 'nearIdu',
      kind: 'endpoint',
      position: { x: 1000, y: 0, z: 0 },
      connectedEdgeIds: ['edge'],
    };
    // Intentionally store the run from IDU to ODU. Rooted graph traversal must
    // still identify the IDU side as downstream.
    document.segmentEdges.edge = {
      id: 'edge',
      kind: 'pipe-segment',
      runId: 'run',
      startNodeId: 'nearIdu',
      endNodeId: 'nearOdu',
      systemType: 'refrigerant-gas',
      lineKind: 'gas',
      pipeKind: 'copper',
      nominalDiameterMm: 12.7,
      outsideDiameterMm: 12.7,
    };
    document.pipeRuns.run = {
      id: 'run',
      kind: 'pipe-run',
      systemType: 'refrigerant-gas',
      lineKind: 'gas',
      pipeKind: 'copper',
      nodeIds: ['nearIdu', 'nearOdu'],
      segmentEdgeIds: ['edge'],
      sourcePortId: 'idu:gas',
      targetPortId: 'odu:gas',
    };

    const baseProfile = profile();
    const sizingProfile: ManufacturerRuleProfile = {
      ...baseProfile,
      pipeSizing: [{
        ...baseProfile.pipeSizing[0]!,
        capacityIndexMax: 50,
      }, {
        ...baseProfile.pipeSizing[0]!,
        id: 'gas-51-100',
        capacityIndexMin: 51,
        outsideDiameterMm: verified(22.2),
      }],
    };
    const snapshot = buildVrfValidationSnapshot(document, sizingProfile);
    expect(snapshot.runs[0]?.expectedDiameterMm).toBe(15.9);

    document.equipmentNodes.idu!.capacityIndex = undefined;
    document.pipeRuns.run!.metadata = { downstreamCapacityIndex: 75 };
    const explicitFallback = buildVrfValidationSnapshot(document, sizingProfile);
    expect(explicitFallback.runs[0]?.expectedDiameterMm).toBe(22.2);
  });

  it('measures joint spacing through connected pipe topology, not plan proximity', () => {
    const document = createEmptyVrfPipingDocument('joint-spacing-network');
    document.routeNodes = {
      'b1:out': {
        id: 'b1:out',
        kind: 'component-port',
        position: { x: 0, y: 0, z: 2500 },
        connectedEdgeIds: ['between'],
        componentId: 'b1',
      },
      'b2:in': {
        id: 'b2:in',
        kind: 'component-port',
        position: { x: 400, y: 0, z: 2500 },
        connectedEdgeIds: ['between'],
        componentId: 'b2',
      },
      'b3:in': {
        id: 'b3:in',
        kind: 'component-port',
        position: { x: 1, y: 0, z: 2500 },
        connectedEdgeIds: [],
        componentId: 'b3',
      },
    };
    document.segmentEdges.between = {
      id: 'between',
      kind: 'pipe-segment',
      runId: 'between-run',
      startNodeId: 'b1:out',
      endNodeId: 'b2:in',
      systemType: 'refrigerant-gas',
      lineKind: 'gas',
      pipeKind: 'copper',
      nominalDiameterMm: 15.9,
      outsideDiameterMm: 15.9,
    };
    const branch = (id: string, inletNodeIds: string[], outletNodeIds: string[]) => ({
      id,
      kind: 'branch-kit' as const,
      manufacturer: 'ACME',
      family: 'Family A',
      model: 'BK-100',
      branchType: 'y-joint' as const,
      systemRole: 'intermediate-branch' as const,
      lineKind: 'gas' as const,
      inletNodeIds,
      outletNodeIds,
      position: document.routeNodes[inletNodeIds[0] ?? outletNodeIds[0]!]!.position,
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      localForward: { x: 1, y: 0, z: 0 },
      localUp: { x: 0, y: 0, z: 1 },
      splitPlaneNormal: { x: 0, y: 0, z: 1 },
      downstreamCapacityIndex: 0,
      ruleProfileId: 'acme/family-a',
    });
    document.branchKits.b1 = branch('b1', [], ['b1:out']);
    document.branchKits.b2 = branch('b2', ['b2:in'], []);
    document.branchKits.b3 = branch('b3', ['b3:in'], []);

    const snapshot = buildVrfValidationSnapshot(document, profile());
    expect(snapshot.branches.find((item) => item.id === 'b1')?.distanceToAdjacentJointMm)
      .toBe(400);
    expect(snapshot.branches.find((item) => item.id === 'b3')?.distanceToAdjacentJointMm)
      .toBeUndefined();
  });
});

describe('downstream capacity', () => {
  it('traverses downstream only and does not double-count converging equipment', () => {
    const result = calculateDownstreamCapacity({
      systemRootNodeId: 'root',
      nodes: {
        root: { id: 'root', kind: 'equipment', equipmentId: 'odu', capacityIndex: 0 },
        branch: { id: 'branch', kind: 'branch' },
        alternate: { id: 'alternate', kind: 'route' },
        indoor: { id: 'indoor', kind: 'equipment', equipmentId: 'idu-1', capacityIndex: 25 },
      },
      arcs: {
        a: { id: 'a', fromNodeId: 'root', toNodeId: 'branch' },
        b: { id: 'b', fromNodeId: 'branch', toNodeId: 'indoor' },
        c: { id: 'c', fromNodeId: 'branch', toNodeId: 'alternate' },
        d: { id: 'd', fromNodeId: 'alternate', toNodeId: 'indoor' },
      },
    }, 'branch');
    expect(result.totalCapacityIndex).toBe(25);
    expect(result.equipmentIds).toEqual(['idu-1']);
    expect(result.valid).toBe(true);
  });

  it('reports loops, missing targets and disconnected subgraphs', () => {
    const result = calculateDownstreamCapacity({
      systemRootNodeId: 'a',
      nodes: {
        a: { id: 'a', kind: 'route' },
        b: { id: 'b', kind: 'branch' },
        isolated: { id: 'isolated', kind: 'equipment', equipmentId: 'idu-x', capacityIndex: 10 },
      },
      arcs: {
        ab: { id: 'ab', fromNodeId: 'a', toNodeId: 'b' },
        ba: { id: 'ba', fromNodeId: 'b', toNodeId: 'a' },
        missing: { id: 'missing', fromNodeId: 'b', toNodeId: 'not-there' },
      },
    }, 'a');
    expect(result.valid).toBe(false);
    expect(result.cycleNodeIds).toEqual(expect.arrayContaining(['a', 'b']));
    expect(result.missingNodeIds).toContain('not-there');
    expect(result.disconnectedNodeIds).toContain('isolated');
  });
});

describe('branch selection and gravity orientation', () => {
  const selection = {
    manufacturer: 'ACME',
    family: 'Family A',
    refrigerant: 'R32',
    arrangement: 'heat-pump' as const,
    systemRole: 'first-branch' as const,
    outdoorCapacity: 80,
    downstreamCapacityIndex: 50,
    downstreamBranchCount: 3,
    upstreamDiametersMm: [22.2],
    downstreamDiametersMm: [15.9],
  };

  it('selects by engineering inputs and requires confirmation before replacement', () => {
    const result = selectBranchKit(profile(), { ...selection, currentModel: 'OLD-1' });
    expect(result.preferred?.rule.model).toBe('BK-100');
    expect(result.requiresUserConfirmation).toBe(true);
  });

  it('measures against world gravity with no camera input', () => {
    const frame = {
      forward: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      splitPlaneNormal: { x: 0, y: 0, z: 1 },
    };
    expect(measureBranchOrientation(frame)).toMatchObject({
      mode: 'horizontal-split',
      rollDeg: 0,
      pitchDeg: 0,
    });
    expect(validateBranchOrientation(frame, profile().branchKits[0]!.orientation).valid).toBe(true);
  });

  it('distinguishes a horizontal header and filters by outlet count', () => {
    const frame = {
      fittingType: 'header' as const,
      forward: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      splitPlaneNormal: { x: 0, y: 0, z: 1 },
    };
    expect(measureBranchOrientation(frame).mode).toBe('horizontal-header');
    const result = selectBranchKit(profile(), {
      ...selection,
      systemRole: 'terminal-header',
      branchType: 'header',
      headerOutletCount: 4,
      downstreamBranchCount: 4,
      downstreamDiametersMm: [9.52],
    });
    expect(result.preferred?.rule.model).toBe('HDR-4');
  });
});

describe('pipe sizing', () => {
  it('selects the manufacturer row from downstream capacity and flags a size change', () => {
    const result = selectPipeSize(profile(), {
      systemType: 'refrigerant-gas',
      downstreamCapacityIndex: 50,
      currentOutsideDiameterMm: 12.7,
    });
    expect(result.preferred?.rule.id).toBe('gas-0-100');
    expect(result.preferred?.rule.outsideDiameterMm.value).toBe(15.9);
    expect(result.requiresUserConfirmation).toBe(true);
  });
});

describe('validation engine', () => {
  it('blocks structurally invalid commits and keeps recommendations non-destructive', () => {
    const report = validateVrfNetwork({
      ports: [{
        id: 'port-1',
        equipmentId: 'idu-1',
        systemType: 'refrigerant-gas',
        connectionDiameterMm: 15.9,
        compatiblePipeKinds: ['copper'],
        connectedEdgeIds: ['edge-1', 'edge-2'],
      }],
      runs: [{
        id: 'run-1',
        systemType: 'refrigerant-gas',
        pipeKind: 'copper',
        diameterMm: 15.9,
        nodePositions: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }],
        minimumBendRadiusMm: 80,
        bendRadiiMm: [40],
        insulationSpecified: false,
      }],
      branches: [],
      pairs: [{
        id: 'pair-1',
        gasRunId: 'gas',
        liquidRunId: 'liquid',
        directionAlignmentDot: 0,
        separationMm: 30,
        requiredSeparationMm: 42,
      }],
      cycleEntityIds: ['branch-loop'],
    }, profile());
    expect(report.commitBlocked).toBe(true);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'duplicate-port-connection',
      'zero-length-segment',
      'bend-radius',
      'pipe-pair-direction',
      'invalid-network-cycle',
    ]));
  });

  it('emits the machine-readable installation rule ids', () => {
    const branchSelection = {
      manufacturer: 'ACME',
      family: 'Family A',
      refrigerant: 'R32',
      arrangement: 'heat-pump' as const,
      systemRole: 'first-branch' as const,
      branchType: 'y-joint' as const,
      outdoorCapacity: 80,
      downstreamCapacityIndex: 50,
      downstreamBranchCount: 3,
      upstreamDiametersMm: [22.2],
      downstreamDiametersMm: [15.9],
    };
    const report = validateVrfNetwork({
      ports: [],
      runs: [{
        id: 'gas-run',
        systemType: 'refrigerant-gas',
        lineKind: 'gas',
        pipeKind: 'copper',
        diameterMm: 12.7,
        expectedDiameterMm: 15.9,
        nodePositions: [{ x: 0, y: 0, z: 0 }, { x: 11_000, y: 0, z: 100 }],
        startPort: {
          id: 'odu-gas',
          equipmentId: 'odu',
          systemType: 'refrigerant-gas',
          connectionDiameterMm: 12.7,
          compatiblePipeKinds: ['copper'],
          connectedEdgeIds: ['gas-run'],
        },
        startPortStubMm: 100,
        slopeTowardOutdoorPercent: 0.25,
        hasSagPocket: true,
        flowDirectionValid: false,
        insulationSpecified: false,
      }],
      branches: [{
        id: 'branch-1',
        model: 'BK-100',
        branchType: 'y-joint',
        selection: branchSelection,
        frame: {
          forward: { x: 0.9, y: 0, z: 0.4 },
          up: { x: 0, y: 0, z: 1 },
          splitPlaneNormal: { x: 0, y: 0, z: 1 },
        },
        upstreamStraightMm: 100,
        downstreamStraightMm: [100],
        distanceToAdjacentJointMm: 300,
        firstElbowDistancesMm: [200],
        inletFacesUpstream: false,
        insulationSpecified: false,
      }, {
        id: 'header-1',
        model: 'HDR-4',
        branchType: 'header',
        selection: {
          ...branchSelection,
          systemRole: 'terminal-header',
          branchType: 'header',
          headerOutletCount: 4,
          downstreamBranchCount: 4,
          downstreamDiametersMm: [9.52],
        },
        frame: {
          fittingType: 'header',
          forward: { x: 1, y: 0, z: 0 },
          up: { x: 0, y: 0, z: 1 },
          splitPlaneNormal: { x: 0, y: 0, z: 1 },
        },
        outletElevationsMm: [2_600, 2_600, 2_610, 2_600],
        inletFacesUpstream: true,
        insulationSpecified: true,
      }],
      pairs: [],
      unapprovedTeeEntityIds: ['bare-tee'],
      totalEquivalentLengthMm: 13_000,
      indoorUnitCount: 9,
      indoorToBranchDistances: [{ entityId: 'idu-1', distanceMm: 6_000 }],
      outdoorIndoorVerticalSeparations: [{
        entityId: 'idu-1',
        separationMm: 2_000,
        outdoorBelowIndoor: true,
      }],
    }, profile());
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'PORT_STUB',
      'PIPE_SIZE',
      'FLOW_DIR',
      'SLOPE',
      'NO_SAG_TRAP',
      'BRANCH_TILT',
      'HEADER_LEVEL',
      'STRAIGHT_BEFORE',
      'STRAIGHT_AFTER',
      'JOINT_SPACING',
      'ELBOW_CLEARANCE',
      'NO_TEE',
      'EQ_LENGTH',
      'VERT_SEP',
      'INSULATION',
    ]));
    expect(new Set(report.issues.map((issue) => issue.id)).size).toBe(report.issues.length);
    expect(report.issues.find((issue) => issue.code === 'PIPE_SIZE')?.fix).toEqual({
      kind: 'set-pipe-diameter',
      diameterMm: 15.9,
      lineKind: 'gas',
    });
    expect(report.issues.find((issue) => issue.code === 'PORT_STUB')?.fix).toEqual({
      kind: 'repair-port-stub',
    });
    expect(report.issues.find((issue) => issue.code === 'BRANCH_TILT')?.fix).toEqual({
      kind: 'level-branch',
    });
    expect(report.issues.find((issue) => issue.code === 'HEADER_LEVEL')?.fix).toEqual({
      kind: 'level-branch',
    });
    expect(report.commitBlocked).toBe(true);
  });
});
