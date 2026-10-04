import type { UnifiedAutoRouteResult } from './unifiedAutoRoute';

export type ServiceRouteObjective = 'balanced' | 'cost' | 'fewest-fittings';
export interface ServiceRouteObligation {
  service: 'gas' | 'liquid' | 'condensate' | 'supply-duct' | 'return-duct';
  unitId: string;
}
export interface ServiceRouteCandidate {
  /** Stable strategy name, never a random generated element ID. */
  key: string;
  result: UnifiedAutoRouteResult;
}
export interface ServiceRouteMeasures {
  refrigerantCost: number;
  refrigerantLengthM: number;
  refrigerantFittings: number;
  drainLengthM: number;
  drainFittings: number;
  drainPumps: number;
}
export interface ServiceRouteDiagnostics {
  requiredObligations: string[];
  servedObligations: string[];
  unservedObligations: string[];
  unresolvedClashCount: number;
  blockingIssueCount: number;
  /** Clear of known unresolved contacts; proposed hops still require approval. */
  physicallyFeasible: boolean;
  pendingHopCount: number;
  complete: boolean;
  costComparableToBaseline: boolean;
  refrigerantCostBasis: 'project-cost' | 'relative-material-index' | 'selected-line-length';
  measures: ServiceRouteMeasures;
  normalized: ServiceRouteMeasures;
  /** Dimensionless preference index. This is never a currency estimate. */
  preferenceScore: number;
}
export interface RankedServiceRouteCandidate extends ServiceRouteCandidate {
  diagnostics: ServiceRouteDiagnostics;
}

/**
 * Explicit selection preferences, not prices or physical loss coefficients.
 * Length/material receives unit weight; pumps carry additional maintenance
 * preference. Balanced additionally favours shorter, simpler refrigerant runs.
 */
export const SERVICE_ROUTE_PREFERENCES = {
  cost: { refrigerantCost: 1, refrigerantLengthM: 0, refrigerantFittings: 0, drainLengthM: 1, drainFittings: 0.25, drainPumps: 1 },
  balanced: { refrigerantCost: 1, refrigerantLengthM: 0.25, refrigerantFittings: 0.25, drainLengthM: 1, drainFittings: 0.25, drainPumps: 1 },
} as const;

const obligationKey = (item: ServiceRouteObligation): string => JSON.stringify([item.service, item.unitId]);
const ordered = (items: Iterable<string>): string[] => [...new Set(items)].sort();
const number = (value: number | null | undefined): number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY
);
const compare = (a: number, b: number): number => a < b ? -1 : a > b ? 1 : 0;
const textCompare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function coverage(result: UnifiedAutoRouteResult): { required: string[]; served: string[] } {
  const required = new Set<string>();
  const served = new Set<string>();
  const add = (service: ServiceRouteObligation['service'], unitId: string, connected: boolean) => {
    const key = obligationKey({ service, unitId });
    required.add(key);
    if (connected) served.add(key);
  };
  for (const service of ['gas', 'liquid'] as const) {
    if (!result.services[service]) continue;
    for (const id of result.refrigerant?.connectedIndoorIds ?? []) add(service, id, true);
    for (const id of result.refrigerant?.unconnectedIndoorIds ?? []) add(service, id, false);
  }
  if (result.services.condensate) {
    for (const unit of result.condensate?.perUnit ?? []) {
      add('condensate', unit.unitId, unit.status === 'gravity' || unit.status === 'pumped');
    }
  }
  // The duct planner exposes unit/service coverage, not every terminal ID.
  // Callers can supply additional required obligations for unassigned units.
  for (const unit of result.ducts?.units ?? []) {
    for (const service of unit.services) {
      if (!(service.service === 'supply' ? result.services.supplyDuct : result.services.returnDuct)) continue;
      add(service.service === 'supply' ? 'supply-duct' : 'return-duct', unit.unitId,
        unit.status === 'designed' && service.terminals > 0);
    }
  }
  return { required: ordered(required), served: ordered(served) };
}

function measures(result: UnifiedAutoRouteResult, basis: ServiceRouteDiagnostics['refrigerantCostBasis']): ServiceRouteMeasures {
  const routesRefrigerant = result.services.gas || result.services.liquid;
  const ref = result.refrigerant?.metrics;
  const drain = result.condensate?.metrics;
  const refrigerantLengthM = !routesRefrigerant ? 0 : (
    (result.services.gas ? number(ref?.gasLengthMm) : 0) + (result.services.liquid ? number(ref?.liquidLengthMm) : 0)
  ) / 1000;
  return {
    refrigerantCost: !routesRefrigerant ? 0 : basis === 'project-cost' ? number(ref?.estimatedCost)
      : basis === 'relative-material-index' ? number(ref?.relativeCostIndex) : refrigerantLengthM,
    refrigerantLengthM,
    // A reduced single-line proposal still carries paired fitting metrics.
    // Do not present those as measured single-line quantities.
    refrigerantFittings: result.services.gas && result.services.liquid
      ? number(ref?.bendCount) + 2 * number(ref?.branchPairCount) + number(ref?.riserCount) : 0,
    drainLengthM: result.services.condensate ? number(drain?.pipeLengthMm) / 1000 : 0,
    drainFittings: result.services.condensate ? number(drain?.fittingCount) : 0,
    drainPumps: result.services.condensate ? number(drain?.pumpedUnits) : 0,
  };
}

/**
 * Rank a bounded portfolio with the same duct proposal and requested scope.
 * Hard contacts cannot be bought off with cost savings. Coverage precedes
 * approval burden and cost. Manufacturer checks remain in the service planners;
 * this selector neither certifies a design nor turns unknown rules into passes.
 *
 * Each metric uses one fixed baseline denominator for the whole comparison.
 * A zero baseline uses the largest finite same-coverage value, or one if all
 * are zero. This keeps monetary unit changes from changing the chosen route.
 * Costs of different served sets are not compared. Duct cost is deliberately
 * excluded: the orchestrator reuses its already verified duct design.
 */
export function rankServiceRouteCandidates(
  candidates: readonly ServiceRouteCandidate[],
  options: {
    objective?: ServiceRouteObjective;
    baselineKey?: string;
    requiredObligations?: readonly ServiceRouteObligation[];
  } = {},
): RankedServiceRouteCandidate[] {
  if (!candidates.length) return [];
  const baseline = candidates.find(candidate => candidate.key === options.baselineKey) ?? candidates[0]!;
  const covered = new Map(candidates.map(candidate => [candidate, coverage(candidate.result)]));
  const required = ordered([
    ...candidates.flatMap(candidate => covered.get(candidate)!.required),
    ...(options.requiredObligations ?? []).map(obligationKey),
  ]);
  const baselineServed = JSON.stringify(covered.get(baseline)!.served);
  const sameCoverage = candidates.filter(candidate => JSON.stringify(covered.get(candidate)!.served) === baselineServed);
  const paired = candidates.every(candidate => candidate.result.services.gas && candidate.result.services.liquid);
  const currency = baseline.result.refrigerant?.metrics?.currency;
  const useMoney = paired && Boolean(currency) && sameCoverage.every(candidate => {
    const metrics = candidate.result.refrigerant?.metrics;
    return metrics?.currency === currency && Number.isFinite(number(metrics?.estimatedCost));
  });
  const basis: ServiceRouteDiagnostics['refrigerantCostBasis'] = useMoney ? 'project-cost'
    : paired ? 'relative-material-index' : 'selected-line-length';
  const raw = new Map(candidates.map(candidate => [candidate, measures(candidate.result, basis)]));
  const keys = Object.keys(raw.get(baseline)!) as Array<keyof ServiceRouteMeasures>;
  const reference = {} as ServiceRouteMeasures;
  for (const key of keys) {
    const value = raw.get(baseline)![key];
    reference[key] = Number.isFinite(value) && value > 0 ? value
      : Math.max(0, ...sameCoverage.map(candidate => raw.get(candidate)![key]).filter(Number.isFinite)) || 1;
  }
  const objective = options.objective ?? 'balanced';
  const ranked: RankedServiceRouteCandidate[] = candidates.map(candidate => {
    const result = candidate.result;
    const served = covered.get(candidate)!.served;
    const servedSet = new Set(served);
    const unserved = required.filter(key => !servedSet.has(key));
    const rawMeasures = raw.get(candidate)!;
    const normalized = {} as ServiceRouteMeasures;
    for (const key of keys) normalized[key] = rawMeasures[key] / reference[key];
    const unresolvedClashCount = result.clashes.filter(clash => !clash.resolvedByHop).length;
    const blockingIssueCount = new Set(result.blockingIssues ?? []).size;
    const costComparableToBaseline = JSON.stringify(served) === baselineServed;
    const preferenceScore = objective === 'fewest-fittings'
      ? rawMeasures.refrigerantFittings + rawMeasures.drainFittings + rawMeasures.drainPumps
      : keys.reduce((sum, key) => {
        const weight = SERVICE_ROUTE_PREFERENCES[objective][key];
        return weight ? sum + weight * normalized[key] : sum;
      }, 0);
    return { ...candidate, diagnostics: {
      requiredObligations: required, servedObligations: served, unservedObligations: unserved,
      unresolvedClashCount, blockingIssueCount, physicallyFeasible: unresolvedClashCount === 0 && blockingIssueCount === 0,
      pendingHopCount: new Set(result.condensate?.hopProposals.map(proposal => proposal.key) ?? []).size,
      complete: unserved.length === 0
        && (!(result.services.gas || result.services.liquid) || result.refrigerant?.complete === true)
        && (!result.services.condensate || Boolean(result.condensate
          && result.condensate.metrics.unitsConnected === result.condensate.metrics.unitsTotal)),
      costComparableToBaseline, refrigerantCostBasis: basis,
      measures: rawMeasures, normalized, preferenceScore,
    } };
  });
  return ranked.sort((left, right) => {
    const a = left.diagnostics; const b = right.diagnostics;
    return compare(Number(!a.physicallyFeasible), Number(!b.physicallyFeasible))
      || compare(Number(!a.complete), Number(!b.complete))
      || compare(a.unservedObligations.length, b.unservedObligations.length)
      || compare(a.pendingHopCount, b.pendingHopCount)
      || textCompare(JSON.stringify(a.servedObligations), JSON.stringify(b.servedObligations))
      || (a.costComparableToBaseline && b.costComparableToBaseline ? compare(a.preferenceScore, b.preferenceScore) : 0)
      || compare(a.unresolvedClashCount, b.unresolvedClashCount)
      || textCompare(left.key, right.key);
  });
}
