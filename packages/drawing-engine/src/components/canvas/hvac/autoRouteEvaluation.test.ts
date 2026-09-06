import { describe, expect, it } from 'vitest';

import type { Wall } from '../../../types';
import { createEmptyVrfPipingDocument, type VrfPipingDocument, type Vec3 } from '../../../vrf/domain/types';
import { PROJECT_FALLBACK_RULE_PROFILE, type ManufacturerRuleProfile, type RuleValue } from '../../../vrf/rules/rule-profile';

import { effectiveAutoRouteSettings, evaluateAutoRouteDocument, type AutoRouteCostRates } from './autoRouteEvaluation';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from './pipeRoutingSettings';

const verified = (value: number): RuleValue<number> => ({ value, verified: true, source: 'manufacturer-model', sourceReference: 'test-profile' });
const options = { outdoorUnitId: 'outdoor', indoorUnitIds: ['indoor-a', 'indoor-b'] };
const rates: AutoRouteCostRates = { currency: 'EUR', gasPipePerMetre: 10, liquidPipePerMetre: 5, elbowEach: 2, branchPairEach: 30, riserEach: 3 };

function addRun(document: VrfPipingDocument, id: string, line: 'gas' | 'liquid', nodes: string[], source?: string, target?: string) {
  const edgeIds = nodes.slice(1).map((endNodeId, index) => {
    const edgeId = `${id}:${index}`;
    const startNodeId = nodes[index]!;
    document.segmentEdges[edgeId] = { id: edgeId, kind: 'pipe-segment', runId: id, startNodeId, endNodeId,
      systemType: `refrigerant-${line}`, lineKind: line, pipeKind: 'copper', nominalDiameterMm: 15.9, outsideDiameterMm: 15.9 };
    document.routeNodes[startNodeId]!.connectedEdgeIds.push(edgeId);
    document.routeNodes[endNodeId]!.connectedEdgeIds.push(edgeId);
    return edgeId;
  });
  document.pipeRuns[id] = { id, kind: 'pipe-run', systemType: `refrigerant-${line}`, lineKind: line, pipeKind: 'copper', nodeIds: nodes,
    segmentEdgeIds: edgeIds, sourcePortId: source ? `${source}:${line}` : undefined, targetPortId: target ? `${target}:${line}` : undefined };
}

function fixture(): VrfPipingDocument {
  const document = createEmptyVrfPipingDocument();
  for (const id of ['outdoor', 'indoor-a', 'indoor-b']) {
    document.equipmentNodes[id] = { id, kind: 'equipment', equipmentType: id === 'outdoor' ? 'outdoor-unit' : 'indoor-unit',
      capacityIndex: id === 'outdoor' ? 100 : 50, manufacturer: 'Test', family: 'Heat pump',
      transform: { position: { x: 0, y: 0, z: 2600 }, orientation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }, portIds: [] };
    for (const line of ['gas', 'liquid'] as const) {
      const portId = `${id}:${line}`;
      document.equipmentNodes[id]!.portIds.push(portId);
      document.equipmentPorts[portId] = { id: portId, equipmentId: id, systemType: `refrigerant-${line}`, positionLocal: { x: 0, y: 0, z: 0 },
        directionLocal: { x: 1, y: 0, z: 0 }, connectionDiameterMm: 15.9, connectionType: 'brazed', compatiblePipeKinds: ['copper'], isConnected: true };
    }
  }
  for (const line of ['gas', 'liquid'] as const) {
    const z = line === 'gas' ? 2700 : 2600;
    const nodes: Record<string, Vec3> = {
      root: { x: 0, y: 0, z }, inlet: { x: 1000, y: 0, z },
      'out-a': { x: 1200, y: 0, z }, 'out-b': { x: 1200, y: 200, z },
      a: { x: 2200, y: 0, z }, b: { x: 1200, y: 1200, z },
    };
    for (const [key, position] of Object.entries(nodes)) document.routeNodes[`${line}:${key}`] = {
      id: `${line}:${key}`, kind: 'endpoint', position, connectedEdgeIds: [],
    };
    addRun(document, `${line}:main`, line, [`${line}:root`, `${line}:inlet`], 'outdoor');
    addRun(document, `${line}:a`, line, [`${line}:out-a`, `${line}:a`], undefined, 'indoor-a');
    addRun(document, `${line}:b`, line, [`${line}:out-b`, `${line}:b`], undefined, 'indoor-b');
    const id = `${line}:branch`;
    document.branchKits[id] = { id, kind: 'branch-kit', manufacturer: 'Test', family: 'Heat pump', model: 'Y100', branchType: 'y-joint',
      systemRole: 'first-branch', lineKind: line, inletNodeIds: [`${line}:inlet`], outletNodeIds: [`${line}:out-a`, `${line}:out-b`],
      position: { x: 1000, y: 0, z }, orientation: { x: 0, y: 0, z: 0, w: 1 }, localForward: { x: 1, y: 0, z: 0 },
      localUp: { x: 0, y: 0, z: 1 }, splitPlaneNormal: { x: 0, y: 0, z: 1 }, downstreamCapacityIndex: 100, ruleProfileId: 'test',
      metadata: { refrigerant: 'R32', arrangement: 'heat-pump', equivalentLengthMm: 500 } };
  }
  return document;
}

function profile(): ManufacturerRuleProfile {
  return { ...PROJECT_FALLBACK_RULE_PROFILE, id: 'test', manufacturer: 'Test', family: 'Heat pump', refrigerants: ['R32'], verified: true,
    routeLimits: { maximumTotalLengthMm: verified(3500), maximumEquivalentLengthMm: verified(2750), maximumIndoorToBranchLengthMm: verified(1500) },
    branchKits: [{ id: 'Y100', manufacturer: 'Test', family: 'Heat pump', model: 'Y100', branchType: 'y-joint', allowedSystemRoles: ['first-branch', 'intermediate-branch'],
      refrigerants: ['R32'], arrangements: ['heat-pump'], downstreamCapacityIndexMin: verified(1), downstreamCapacityIndexMax: verified(100),
      outdoorCapacityMin: verified(1), outdoorCapacityMax: verified(100), orientation: { allowedModes: ['horizontal-split'] }, straightZones: [], equivalentLengthMm: verified(500) }],
    pipeSizing: [{ id: 'gas-50', systemType: 'refrigerant-gas', capacityIndexMin: 1, capacityIndexMax: 50,
      outsideDiameterMm: verified(19.1), minimumBendRadiusMm: verified(80) }] };
}

describe('complete automatic route engineering evaluation', () => {
  it('accounts for both physical tubes while checking one-way totals and individual equivalent paths', () => {
    const result = evaluateAutoRouteDocument(fixture(), { ...options, profile: profile(), rates });
    expect(result.feasible).toBe(true);
    expect(result.metrics.pipeLengthMm).toBe(6000);
    expect(result.metrics.networkLengthMm).toBe(3000);
    expect(result.metrics.maxPathLengthMm).toBe(2000);
    expect(result.metrics.maxEquivalentPathLengthMm).toBe(2500);
    expect(result.metrics.totalCapacityIndex).toBe(100);
    expect(result.metrics.branchPairCount).toBe(1);
    expect(result.metrics.estimatedCost).toBe(75);
    expect(result.paths).toHaveLength(4);
    expect(result.recommendations.filter((item) => item.kind === 'branch-kit').every((item) => item.status === 'matches')).toBe(true);
  });

  it('applies verified limits to the offending source-to-indoor path', () => {
    const ruleProfile = profile();
    ruleProfile.routeLimits.maximumEquivalentLengthMm = verified(2400);
    const result = evaluateAutoRouteDocument(fixture(), { ...options, profile: ruleProfile });
    expect(result.feasible).toBe(false);
    expect(result.hardIssues.some((issue) => issue.includes('indoor-a') && issue.includes('equivalent-length'))).toBe(true);
  });

  it('keeps unverified limits and missing model tables advisory', () => {
    const ruleProfile = { ...PROJECT_FALLBACK_RULE_PROFILE, routeLimits: { maximumTotalLengthMm: { value: 500, verified: false, source: 'fallback' as const } } };
    const result = evaluateAutoRouteDocument(fixture(), { ...options, profile: ruleProfile });
    expect(result.feasible).toBe(true);
    expect(result.metrics.estimatedCost).toBeNull();
    expect(result.manufacturerQualification).toBe('preliminary');
    expect(result.advisoryIssues.some((issue) => issue.includes('one-way'))).toBe(true);
  });

  it('does not treat absent capacity indices as zero or convert kW into indices', () => {
    const document = fixture();
    delete document.equipmentNodes['indoor-b']!.capacityIndex;
    document.equipmentNodes['indoor-b']!.metadata = { capacityKw: 5.6 };
    const result = evaluateAutoRouteDocument(document, { ...options, profile: profile() });
    expect(result.feasible).toBe(true);
    expect(result.metrics.totalCapacityIndex).toBeNull();
    expect(result.recommendations.filter((item) => item.kind === 'branch-kit').every((item) => item.status === 'missing-data')).toBe(true);
  });

  it('detects a missing service connection even when the other service reaches the unit', () => {
    const document = fixture();
    delete document.pipeRuns['liquid:b']!.targetPortId;
    const result = evaluateAutoRouteDocument(document, options);
    expect(result.feasible).toBe(false);
    expect(result.hardIssues.some((issue) => issue.includes('indoor-b') && issue.includes('liquid'))).toBe(true);
    expect(result.hardIssues.some((issue) => issue.includes('open pipe'))).toBe(true);
  });

  it('detects a loop and duplicate terminal connections', () => {
    const document = fixture();
    addRun(document, 'illegal-link', 'gas', ['gas:a', 'gas:b']);
    const result = evaluateAutoRouteDocument(document, options);
    expect(result.feasible).toBe(false);
    expect(result.hardIssues.some((issue) => issue.includes('cycle'))).toBe(true);
    expect(result.hardIssues.some((issue) => issue.includes('multiple gas'))).toBe(true);
  });

  it('detects a branch whose inlet is connected on the indoor side', () => {
    const document = fixture();
    document.branchKits['gas:branch']!.inletNodeIds = ['gas:out-a'];
    document.branchKits['gas:branch']!.outletNodeIds = ['gas:inlet', 'gas:out-b'];
    expect(evaluateAutoRouteDocument(document, options).hardIssues.some((issue) => issue.includes('inlet facing away'))).toBe(true);
  });

  it('ignores independent circuits outside the selected source component', () => {
    const document = fixture();
    document.routeNodes.orphanA = { id: 'orphanA', kind: 'endpoint', position: { x: 3000, y: 3000, z: 0 }, connectedEdgeIds: [] };
    document.routeNodes.orphanB = { id: 'orphanB', kind: 'endpoint', position: { x: 8000, y: 3000, z: 0 }, connectedEdgeIds: [] };
    addRun(document, 'unrelated', 'gas', ['orphanA', 'orphanB']);
    const result = evaluateAutoRouteDocument(document, options);
    expect(result.feasible).toBe(true);
    expect(result.metrics.pipeLengthMm).toBe(6000);
  });

  it('reports unknown equivalent length instead of assuming unknown fittings contribute zero', () => {
    const document = fixture();
    delete document.branchKits['gas:branch']!.metadata!.equivalentLengthMm;
    expect(evaluateAutoRouteDocument(document, options).metrics.maxEquivalentPathLengthMm).toBeNull();
  });

  it('rejects invalid cost rates without producing a fabricated monetary estimate', () => {
    const result = evaluateAutoRouteDocument(fixture(), { ...options, rates: { ...rates, gasPipePerMetre: -1 } });
    expect(result.feasible).toBe(true);
    expect(result.metrics.estimatedCost).toBeNull();
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.advisoryIssues.some((issue) => issue.includes('Cost rates'))).toBe(true);
  });

  it.each(['balanced', 'cost', 'fewest-fittings'] as const)('keeps %s ranking invariant when monetary units are rescaled', (objective) => {
    const cents = { ...rates, currency: 'EUR cents', gasPipePerMetre: rates.gasPipePerMetre * 100, liquidPipePerMetre: rates.liquidPipePerMetre * 100,
      elbowEach: rates.elbowEach * 100, branchPairEach: rates.branchPairEach * 100, riserEach: rates.riserEach * 100 };
    const eurosResult = evaluateAutoRouteDocument(fixture(), { ...options, rates, objective });
    const centsResult = evaluateAutoRouteDocument(fixture(), { ...options, rates: cents, objective });
    expect(centsResult.metrics.estimatedCost).toBe(eurosResult.metrics.estimatedCost! * 100);
    expect(centsResult.score).toBeCloseTo(eurosResult.score, 10);
  });

  it('recommends capacity-table sizes on intermediate runs without mutating geometry', () => {
    const document = fixture();
    document.routeNodes['gas:mid'] = { id: 'gas:mid', kind: 'route', position: { x: 1700, y: 0, z: 2700 }, connectedEdgeIds: [] };
    document.pipeRuns['gas:a']!.nodeIds[0] = 'gas:mid';
    document.segmentEdges['gas:a:0']!.startNodeId = 'gas:mid';
    document.routeNodes['gas:out-a']!.connectedEdgeIds = [];
    document.routeNodes['gas:mid']!.connectedEdgeIds = ['gas:a:0'];
    addRun(document, 'gas:intermediate', 'gas', ['gas:out-a', 'gas:mid']);
    const before = JSON.stringify(document);
    const result = evaluateAutoRouteDocument(document, { ...options, profile: profile() });
    expect(result.feasible).toBe(true);
    expect(result.recommendations.find((item) => item.entityId === 'gas:intermediate')).toMatchObject({
      downstreamCapacityIndex: 50, status: 'change-recommended', recommendedDiameterMm: 19.1,
    });
    expect(JSON.stringify(document)).toBe(before);
  });

  it.each(['balanced', 'cost', 'fewest-fittings'] as const)('rejects a new gas low pocket for the %s objective while preserving existing reviewed geometry', (objective) => {
    const document = fixture();
    document.routeNodes['gas:inlet']!.position.z = 2400;
    document.routeNodes['gas:out-a']!.position.z = 2400;
    document.routeNodes['gas:out-b']!.position.z = 2400;
    const generated = evaluateAutoRouteDocument(document, { ...options, objective });
    expect(generated.feasible).toBe(false);
    expect(generated.hardIssues.some((issue) => issue.includes('gas low pocket'))).toBe(true);
    const preserved = evaluateAutoRouteDocument(document, { ...options, objective, elevationPolicy: 'existing-layout' });
    expect(preserved.feasible).toBe(true);
    expect(preserved.advisoryIssues.some((issue) => issue.includes('oil-return'))).toBe(true);
  });

  it('counts one paired plan penetration and identifies opening coordination', () => {
    const wall = { id: 'wall', startPoint: { x: 500, y: -500 }, endPoint: { x: 500, y: 500 } } as Wall;
    const result = evaluateAutoRouteDocument(fixture(), { ...options, walls: [wall] });
    expect(result.metrics.wallCrossingCount).toBe(1);
    expect(result.advisoryIssues.some((issue) => issue.includes('opening coordination'))).toBe(true);
  });

  it('does not count a faceted curved elbow as many separate bends', () => {
    const evaluateArc = (samples: number) => {
      const document = fixture();
      const oldRun = document.pipeRuns['gas:a']!;
      for (const id of oldRun.segmentEdgeIds) delete document.segmentEdges[id];
      document.routeNodes['gas:out-a']!.connectedEdgeIds = [];
      document.routeNodes['gas:a']!.connectedEdgeIds = [];
      document.routeNodes['gas:a']!.position = { x: 2200, y: 1000, z: 2700 };
      const points = [{ x: 1400, y: 0, z: 2700 }, ...Array.from({ length: samples + 1 }, (_, index) => {
        const angle = -Math.PI / 2 + (Math.PI / 2) * index / samples;
        return { x: 1600 + 200 * Math.cos(angle), y: 200 + 200 * Math.sin(angle), z: 2700 };
      }), { x: 1800, y: 1000, z: 2700 }];
      const ids = points.map((position, index) => {
        const id = `arc:${index}`;
        document.routeNodes[id] = { id, kind: 'bend', position, connectedEdgeIds: [] };
        return id;
      });
      addRun(document, 'gas:a', 'gas', ['gas:out-a', ...ids, 'gas:a'], undefined, 'indoor-a');
      return evaluateAutoRouteDocument(document, options);
    };
    expect(evaluateArc(4).metrics.bendCount).toBeCloseTo(2, 6);
    expect(evaluateArc(32).metrics.bendCount).toBeCloseTo(2, 6);
  });

  it('rejects a catalog-disallowed branch split plane', () => {
    const selected = profile();
    selected.branchKits[0]!.orientation.allowedModes = ['vertical-split'];
    const result = evaluateAutoRouteDocument(fixture(), { ...options, profile: selected });
    expect(result.feasible).toBe(false);
    expect(result.hardIssues.some(issue => issue.includes('horizontal-split'))).toBe(true);
  });

  it('rejects insufficient straight length on every catalog outlet', () => {
    const selected = profile();
    selected.branchKits[0]!.straightZones = [{ downstreamMinimumMm: verified(1200), noBendAllowed: true, noReducerAllowed: true, noOtherBranchAllowed: true }];
    const result = evaluateAutoRouteDocument(fixture(), { ...options, profile: selected });
    expect(result.feasible).toBe(false);
    expect(result.hardIssues.some(issue => issue.includes('outlet 1 straight'))).toBe(true);
    expect(result.hardIssues.some(issue => issue.includes('outlet 2 straight'))).toBe(true);
  });

  it('honors verified branch-only values even when the whole profile is not yet verified', () => {
    const selected = profile(); selected.verified = false;
    selected.branchKits[0]!.orientation.maximumRollDeviationDeg = verified(5);
    const document = fixture();
    document.branchKits['gas:branch']!.orientation = { x: Math.sin(Math.PI / 8), y: 0, z: 0, w: Math.cos(Math.PI / 8) };
    const result = evaluateAutoRouteDocument(document, { ...options, profile: selected });
    expect(result.feasible).toBe(false);
    expect(result.hardIssues.some(issue => issue.includes('Roll'))).toBe(true);
  });

  it('does not apply an unrelated catalog models geometry limits', () => {
    const selected = profile();
    selected.branchKits[0]!.model = 'Another-model';
    selected.branchKits[0]!.orientation.allowedModes = ['vertical-split'];
    selected.branchKits[0]!.straightZones = [{ downstreamMinimumMm: verified(1200), noBendAllowed: true, noReducerAllowed: true, noOtherBranchAllowed: true }];
    const result = evaluateAutoRouteDocument(fixture(), { ...options, profile: selected });
    expect(result.feasible).toBe(true);
    expect(result.manufacturerQualification).toBe('preliminary');
  });

  it('rejects a later sharp corner even after measuring an earlier valid circular elbow', () => {
    const document = fixture();
    const previous = document.pipeRuns['gas:a']!;
    for (const id of previous.segmentEdgeIds) delete document.segmentEdges[id];
    document.routeNodes['gas:out-a']!.connectedEdgeIds = [];
    document.routeNodes['gas:a']!.connectedEdgeIds = [];
    document.routeNodes['gas:a']!.position = { x: 2200, y: 1000, z: 2700 };
    const points = [...Array.from({ length: 9 }, (_, index) => {
      const angle = -Math.PI / 2 + Math.PI / 2 * index / 8;
      return { x: 1600 + 200 * Math.cos(angle), y: 200 + 200 * Math.sin(angle), z: 2700 };
    }), { x: 1800, y: 1000, z: 2700 }];
    const ids = points.map((position, index) => {
      const id = `radius:${index}`; document.routeNodes[id] = { id, kind: 'bend', position, connectedEdgeIds: [] }; return id;
    });
    addRun(document, 'gas:a', 'gas', ['gas:out-a', ...ids, 'gas:a'], undefined, 'indoor-a');
    const selected = profile();
    selected.pipeSizing[0]!.outsideDiameterMm = verified(15.9);
    selected.pipeSizing[0]!.minimumBendRadiusMm = verified(100);
    const result = evaluateAutoRouteDocument(document, { ...options, profile: selected });
    expect(result.feasible).toBe(false);
    expect(result.hardIssues.some(issue => issue.includes('measured bend radius'))).toBe(true);
  });

  it('reserves known profile allowances without reducing project defaults or unrelated kit rules', () => {
    const selected = profile();
    selected.portDefaults.minimumBendRadiusMm = verified(150);
    selected.portDefaults.minimumStraightStubMm = verified(450);
    selected.branchKits[0]!.model = 'DIS-22-1G Gas';
    selected.branchKits[0]!.straightZones = [{ downstreamMinimumMm: verified(1100), noBendAllowed: true, noReducerAllowed: true, noOtherBranchAllowed: true }];
    selected.branchKits.push({ ...selected.branchKits[0]!, id: 'unrelated', model: 'Other large header',
      straightZones: [{ downstreamMinimumMm: verified(9000), noBendAllowed: true, noReducerAllowed: true, noOtherBranchAllowed: true }] });
    const settings = { ...DEFAULT_PIPE_ROUTING_SETTINGS, defaultUnitClearanceMm: 250 };
    const original = structuredClone(settings);
    const effective = effectiveAutoRouteSettings(selected, settings, []);
    expect(effective.minimumPortStubMm).toBe(450);
    expect(effective.defaultBranchKitClearanceMm).toBe(1100);
    expect(effective.defaultUnitClearanceMm).toBe(250);
    expect(effective.bendRadiusFactor).toBeGreaterThanOrEqual(150 / 60.325);
    expect(settings).toEqual(original);
  });
});
