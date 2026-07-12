import { describe, expect, it } from 'vitest';

import { selectBranchKit } from './branch-selection';
import { measureBranchOrientation, validateBranchOrientation } from './branch-orientation';
import { calculateDownstreamCapacity } from './downstream-capacity';
import { loadManufacturerRuleProfile } from './manufacturer-rule-loader';
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
    pipeSizing: [],
    routeLimits: {
      maximumTotalLengthMm: verified(10_000),
      maximumHeightDifferenceMm: verified(3_000),
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
});

