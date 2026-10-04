import { describe, expect, it } from 'vitest';

import { rankServiceRouteCandidates, type ServiceRouteCandidate, type ServiceRouteObjective } from './serviceRouteObjective';
import type { UnifiedAutoRouteResult } from './unifiedAutoRoute';

function result(): UnifiedAutoRouteResult {
  return {
    services: { gas: true, liquid: true, condensate: true }, ducts: null, clashes: [], issues: [],
    refrigerant: {
      elementsToAdd: [], removeElementIds: [], updates: [], complete: true,
      connectedIndoorIds: ['unit-a'], unconnectedIndoorIds: [], issues: [], evaluations: [], evaluatedCandidates: 1,
      metrics: {
        pipeLengthMm: 10000, gasLengthMm: 5000, liquidLengthMm: 5000, networkLengthMm: 5000,
        maxPathLengthMm: 5000, maxEquivalentPathLengthMm: null, bendCount: 4, branchPairCount: 1,
        riserCount: 1, verticalTravelMm: 1000, elevationReversalCount: 0, connectedIndoorCount: 1,
        estimatedCost: 100, currency: 'EUR', relativeCostIndex: 20, wallCrossingCount: 0, totalCapacityIndex: null,
      },
    },
    condensate: {
      elementsToAdd: [], removeElementIds: [], networks: [], unresolvedPaths: [], issues: [], bom: [],
      perUnit: [{ unitId: 'unit-a', label: 'A', gullyId: 'gully', status: 'gravity', lengthMm: 10000,
        fallUsedMm: 100, headMarginMm: 300, liftMm: 0 }],
      crossings: [], hopProposals: [],
      metrics: { unitsTotal: 1, unitsConnected: 1, pumpedUnits: 0, networks: 1, pipeLengthMm: 10000,
        fittingCount: 2, crossings: 0, hops: 0 },
      envelope: { ceilingPlaneMm: 3000, soffitMm: 2800, voidFloorMm: 2810, voidTopMm: 2990, derivation: 'test' },
    },
  };
}

function candidates(): ServiceRouteCandidate[] {
  return [{ key: 'refrigerant-first', result: result() }, { key: 'drainage-first', result: result() }];
}

const clash: UnifiedAutoRouteResult['clashes'][number] = {
  elementIds: ['gas', 'drain'], services: ['gas', 'condensate'], distanceMm: 0, requiredMm: 60,
  message: 'The proposed services intersect.', resolvedByHop: false,
};

describe('collective service route preference', () => {
  it('never trades known physical violations for lower cost or more connected equipment', () => {
    const choices = candidates();
    const invalid = choices[1]!.result;
    invalid.refrigerant!.metrics!.estimatedCost = 0;
    invalid.condensate!.metrics.pipeLengthMm = 0;
    invalid.refrigerant!.connectedIndoorIds.push('extra');
    invalid.clashes = [clash];
    const ranked = rankServiceRouteCandidates(choices, { objective: 'cost' });
    expect(ranked[0]!.key).toBe('refrigerant-first');
    expect(ranked[0]!.diagnostics.unservedObligations).toHaveLength(2);
    expect(ranked[1]!.diagnostics.physicallyFeasible).toBe(false);
    invalid.clashes = [];
    invalid.blockingIssues = ['The proposed drain rises against gravity.'];
    expect(rankServiceRouteCandidates(choices)[0]!.key).toBe('refrigerant-first');
  });

  it('counts distinct requested service/unit obligations and favours complete coverage before price', () => {
    const choices = candidates();
    const partial = choices[0]!.result;
    partial.refrigerant!.connectedIndoorIds.push('unit-a');
    partial.condensate!.perUnit[0]!.status = 'infeasible';
    partial.condensate!.metrics.unitsConnected = 0;
    partial.condensate!.metrics.pipeLengthMm = 0;
    const ranked = rankServiceRouteCandidates(choices, { objective: 'cost' });
    expect(ranked[0]!.key).toBe('drainage-first');
    expect(ranked[0]!.diagnostics.requiredObligations).toHaveLength(3);
    expect(ranked[0]!.diagnostics.servedObligations).toHaveLength(3);
    expect(ranked[1]!.diagnostics.unservedObligations).toEqual(['["condensate","unit-a"]']);
    expect(ranked[0]!.diagnostics.costComparableToBaseline).toBe(false);
  });

  it('preserves missing explicit obligations even when a failed planner omits a unit', () => {
    const ranked = rankServiceRouteCandidates(candidates(), {
      requiredObligations: [{ service: 'condensate', unitId: 'missing' }],
    });
    expect(ranked.every(candidate => !candidate.diagnostics.complete)).toBe(true);
    expect(ranked[0]!.diagnostics.unservedObligations).toContain('["condensate","missing"]');
  });

  it('prefers an approval-free route to cheaper routes dependent on refrigerant hops', () => {
    const choices = candidates();
    const pending = choices[0]!.result;
    pending.refrigerant!.metrics!.estimatedCost = 1;
    pending.clashes = [{ ...clash, resolvedByHop: true }];
    const hop = { key: 'hop-a', refrigerantElementId: 'gas', point: { x: 0, y: 0 }, networkId: 'drain-network',
      condensateZ: 2800, requiredCentrelineZ: 2900, halfWindowMm: 60, withinSoffit: true };
    pending.condensate!.hopProposals = [hop, hop];
    const ranked = rankServiceRouteCandidates(choices, { objective: 'cost' });
    expect(ranked[0]!.key).toBe('drainage-first');
    expect(ranked[1]!.diagnostics.pendingHopCount).toBe(1);
    expect(ranked[1]!.diagnostics.physicallyFeasible).toBe(true);
  });

  it.each(['balanced', 'cost'] as ServiceRouteObjective[])('balances both services for the %s objective using one fixed baseline', (objective) => {
    const choices = candidates();
    const alternative = choices[1]!.result;
    alternative.refrigerant!.metrics!.estimatedCost = 150;
    alternative.refrigerant!.metrics!.gasLengthMm = 7500;
    alternative.refrigerant!.metrics!.liquidLengthMm = 7500;
    alternative.condensate!.metrics.pipeLengthMm = 2000;
    const ranked = rankServiceRouteCandidates(choices, { objective });
    expect(ranked[0]!.key).toBe('drainage-first');
    expect(ranked[0]!.diagnostics.normalized).toMatchObject({ refrigerantCost: 1.5, refrigerantLengthM: 1.5, drainLengthM: 0.2 });
    expect(ranked[0]!.diagnostics.refrigerantCostBasis).toBe('project-cost');
    expect(ranked[0]!.diagnostics.preferenceScore).toBeLessThan(ranked[1]!.diagnostics.preferenceScore);
  });

  it.each(['balanced', 'cost', 'fewest-fittings'] as ServiceRouteObjective[])('is invariant to currency units and candidate order for %s', (objective) => {
    const choices = candidates();
    choices[1]!.result.refrigerant!.metrics!.estimatedCost = 150;
    choices[1]!.result.condensate!.metrics.pipeLengthMm = 2000;
    const options = { objective, baselineKey: 'refrigerant-first' };
    const euros = rankServiceRouteCandidates(choices, options);
    const scaled = structuredClone(choices).reverse();
    for (const candidate of scaled) {
      candidate.result.refrigerant!.metrics!.estimatedCost! *= 100;
      candidate.result.refrigerant!.metrics!.currency = 'EUR cents';
    }
    const cents = rankServiceRouteCandidates(scaled, options);
    expect(cents.map(candidate => candidate.key)).toEqual(euros.map(candidate => candidate.key));
    expect(cents.map(candidate => candidate.diagnostics.preferenceScore)).toEqual(euros.map(candidate => candidate.diagnostics.preferenceScore));
  });

  it('uses relative indices consistently when project costs cannot be compared', () => {
    const choices = candidates();
    choices[0]!.result.refrigerant!.metrics!.estimatedCost = null;
    choices[1]!.result.refrigerant!.metrics!.relativeCostIndex = 10;
    const ranked = rankServiceRouteCandidates(choices, { objective: 'cost' });
    expect(ranked[0]!.key).toBe('drainage-first');
    expect(ranked.every(candidate => candidate.diagnostics.refrigerantCostBasis === 'relative-material-index')).toBe(true);
  });

  it('does not use paired monetary or fitting totals as single-line quantities', () => {
    const choices = candidates();
    for (const candidate of choices) candidate.result.services.liquid = false;
    choices[1]!.result.refrigerant!.metrics!.estimatedCost = 1;
    choices[1]!.result.refrigerant!.metrics!.gasLengthMm = 6000;
    const ranked = rankServiceRouteCandidates(choices, { objective: 'cost' });
    expect(ranked[0]!.key).toBe('refrigerant-first');
    expect(ranked[0]!.diagnostics.refrigerantCostBasis).toBe('selected-line-length');
    expect(ranked[0]!.diagnostics.measures).toMatchObject({ refrigerantLengthM: 5, refrigerantFittings: 0 });
    expect(ranked[0]!.diagnostics.requiredObligations).toHaveLength(2);
  });

  it('prioritises fewer fittings over lower material cost when requested', () => {
    const choices = candidates();
    choices[1]!.result.refrigerant!.metrics!.estimatedCost = 1;
    choices[1]!.result.condensate!.metrics.fittingCount += 1;
    expect(rankServiceRouteCandidates(choices, { objective: 'cost' })[0]!.key).toBe('drainage-first');
    expect(rankServiceRouteCandidates(choices, { objective: 'fewest-fittings' })[0]!.key).toBe('refrigerant-first');
  });

  it('keeps all-zero baseline normalization finite and does not reward missing measurements', () => {
    const choices = candidates();
    for (const candidate of choices) {
      candidate.result.refrigerant!.metrics!.estimatedCost = 0;
      candidate.result.refrigerant!.metrics!.bendCount = 0;
      candidate.result.refrigerant!.metrics!.branchPairCount = 0;
      candidate.result.refrigerant!.metrics!.riserCount = 0;
      candidate.result.condensate!.metrics.fittingCount = 0;
    }
    expect(rankServiceRouteCandidates(choices).every(candidate => Number.isFinite(candidate.diagnostics.preferenceScore))).toBe(true);
    choices[1]!.result.condensate!.metrics.pipeLengthMm = Number.NaN;
    const ranked = rankServiceRouteCandidates(choices);
    expect(ranked[0]!.key).toBe('refrigerant-first');
    expect(ranked[1]!.diagnostics.preferenceScore).toBe(Number.POSITIVE_INFINITY);
  });
});
