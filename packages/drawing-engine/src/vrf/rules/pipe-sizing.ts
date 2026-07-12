import type { ManufacturerRuleProfile, PipeSizingRule } from './rule-profile';

export interface PipeSizingContext {
  systemType: PipeSizingRule['systemType'];
  downstreamCapacityIndex: number;
  currentOutsideDiameterMm?: number;
}

export interface PipeSizingCandidate {
  rule: PipeSizingRule;
  score: number;
  advisories: string[];
}

export interface PipeSizingResult {
  preferred: PipeSizingCandidate | null;
  candidates: PipeSizingCandidate[];
  diagnostics: string[];
  requiresUserConfirmation: boolean;
}

/**
 * Select a pipe size from the active manufacturer's capacity table. The
 * result is a recommendation only; callers decide whether to apply it through
 * an undoable command.
 */
export function selectPipeSize(
  profile: ManufacturerRuleProfile,
  context: PipeSizingContext,
): PipeSizingResult {
  const diagnostics: string[] = [];
  if (!Number.isFinite(context.downstreamCapacityIndex) || context.downstreamCapacityIndex < 0) {
    return {
      preferred: null,
      candidates: [],
      diagnostics: ['Downstream capacity index must be a finite non-negative value.'],
      requiresUserConfirmation: false,
    };
  }

  const candidates = profile.pipeSizing
    .flatMap((rule): PipeSizingCandidate[] => {
      if (rule.systemType !== context.systemType) return [];
      if (
        context.downstreamCapacityIndex < rule.capacityIndexMin
        || context.downstreamCapacityIndex > rule.capacityIndexMax
      ) return [];
      const advisories: string[] = [];
      if (!rule.outsideDiameterMm.verified || !rule.minimumBendRadiusMm.verified) {
        advisories.push('Sizing row contains unverified project/fallback values.');
      }
      const rangeWidth = rule.capacityIndexMax - rule.capacityIndexMin;
      const currentPenalty = context.currentOutsideDiameterMm === undefined
        ? 0
        : Math.abs(rule.outsideDiameterMm.value - context.currentOutsideDiameterMm) / 100;
      return [{
        rule,
        score: rangeWidth + currentPenalty + advisories.length * 1_000,
        advisories,
      }];
    })
    .sort((left, right) => (
      left.score - right.score
      || left.rule.outsideDiameterMm.value - right.rule.outsideDiameterMm.value
      || left.rule.id.localeCompare(right.rule.id)
    ));

  const preferred = candidates[0] ?? null;
  if (!preferred) {
    diagnostics.push('No pipe-sizing row in the active profile covers this downstream capacity.');
  }
  const current = context.currentOutsideDiameterMm;
  return {
    preferred,
    candidates,
    diagnostics,
    requiresUserConfirmation: Boolean(
      preferred
      && current !== undefined
      && Math.abs(preferred.rule.outsideDiameterMm.value - current) > 0.25,
    ),
  };
}
