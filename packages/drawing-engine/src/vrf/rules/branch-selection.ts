import type {
  BranchKitCatalogRule,
  ManufacturerRuleProfile,
} from './rule-profile';

export interface BranchSelectionContext {
  manufacturer: string;
  family: string;
  refrigerant: string;
  arrangement: 'heat-pump' | 'heat-recovery';
  systemRole: 'first-branch' | 'intermediate-branch' | 'terminal-header';
  branchType?: 'y-joint' | 'header' | 'outdoor-multi-kit';
  headerOutletCount?: number;
  outdoorCapacity?: number;
  downstreamCapacityIndex: number;
  downstreamBranchCount: number;
  upstreamDiametersMm: number[];
  downstreamDiametersMm: number[];
  currentModel?: string;
}

export interface BranchCandidate {
  rule: BranchKitCatalogRule;
  score: number;
  advisories: string[];
}

export interface BranchSelectionResult {
  preferred: BranchCandidate | null;
  candidates: BranchCandidate[];
  diagnostics: string[];
  /** Recommendations are never silently applied to a placed component. */
  requiresUserConfirmation: boolean;
}

const closeDiameter = (left: number, right: number) => Math.abs(left - right) <= 0.25;

function allDiametersSupported(actual: number[], allowed?: number[]): boolean {
  if (!allowed || allowed.length === 0) return true;
  return actual.every((value) => allowed.some((candidate) => closeDiameter(value, candidate)));
}

function within(value: number | undefined, min?: number, max?: number): boolean {
  if (value === undefined) return min === undefined && max === undefined;
  return (min === undefined || value >= min) && (max === undefined || value <= max);
}

export function selectBranchKit(
  profile: ManufacturerRuleProfile,
  context: BranchSelectionContext,
): BranchSelectionResult {
  const diagnostics: string[] = [];
  if (profile.manufacturer.toLowerCase() !== context.manufacturer.toLowerCase()) {
    diagnostics.push('Active manufacturer does not match the rule profile.');
  }
  if (profile.family.toLowerCase() !== context.family.toLowerCase()) {
    diagnostics.push('Active product family does not match the rule profile.');
  }

  const candidates = profile.branchKits.flatMap((rule): BranchCandidate[] => {
    if (rule.manufacturer.toLowerCase() !== context.manufacturer.toLowerCase()) return [];
    if (rule.family.toLowerCase() !== context.family.toLowerCase()) return [];
    if (!rule.refrigerants.some((value) => value.toLowerCase() === context.refrigerant.toLowerCase())) return [];
    if (!rule.arrangements.includes(context.arrangement)) return [];
    if (!rule.allowedSystemRoles.includes(context.systemRole)) return [];
    if (context.branchType && rule.branchType !== context.branchType) return [];
    if (
      context.headerOutletCount !== undefined
      && rule.headerOutletCount !== context.headerOutletCount
    ) return [];
    if (!within(
      context.downstreamCapacityIndex,
      rule.downstreamCapacityIndexMin?.value,
      rule.downstreamCapacityIndexMax?.value,
    )) return [];
    if (!within(
      context.outdoorCapacity,
      rule.outdoorCapacityMin?.value,
      rule.outdoorCapacityMax?.value,
    )) return [];
    if (!within(
      context.downstreamBranchCount,
      rule.downstreamBranchCountMin,
      rule.downstreamBranchCountMax,
    )) return [];
    if (!allDiametersSupported(context.upstreamDiametersMm, rule.upstreamDiametersMm)) return [];
    if (!allDiametersSupported(context.downstreamDiametersMm, rule.downstreamDiametersMm)) return [];

    const advisories: string[] = [];
    const unverified = [
      rule.downstreamCapacityIndexMin,
      rule.downstreamCapacityIndexMax,
      rule.outdoorCapacityMin,
      rule.outdoorCapacityMax,
      ...rule.straightZones.flatMap((zone) => [zone.upstreamMinimumMm, zone.downstreamMinimumMm]),
    ].filter((value) => value && !value.verified);
    if (unverified.length > 0) advisories.push('Candidate uses unverified project/fallback rule values.');

    let score = 0;
    if (rule.model === context.currentModel) score -= 20;
    if (rule.allowedSystemRoles.length === 1) score -= 4;
    const max = rule.downstreamCapacityIndexMax?.value;
    if (max !== undefined) score += Math.max(0, max - context.downstreamCapacityIndex) / Math.max(max, 1);
    score += advisories.length * 10;
    return [{ rule, score, advisories }];
  }).sort((left, right) => left.score - right.score || left.rule.model.localeCompare(right.rule.model));

  const preferred = candidates[0] ?? null;
  if (!preferred) diagnostics.push('No branch-kit model in the active profile satisfies the network conditions.');
  return {
    preferred,
    candidates,
    diagnostics,
    requiresUserConfirmation: Boolean(
      preferred
      && context.currentModel
      && preferred.rule.model !== context.currentModel,
    ),
  };
}
