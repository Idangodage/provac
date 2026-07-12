import { selectBranchKit, type BranchSelectionContext } from './branch-selection';
import {
  validateBranchOrientation,
  type BranchWorldFrame,
} from './branch-orientation';
import type { ManufacturerRuleProfile } from './rule-profile';

export type ValidationLevel = 'error' | 'warning' | 'advisory' | 'information';

export interface VrfValidationIssue {
  id: string;
  level: ValidationLevel;
  code: string;
  entityId?: string;
  message: string;
  suggestedFix?: string;
}

export interface ValidationPortInput {
  id: string;
  equipmentId: string;
  systemType: string;
  connectionDiameterMm: number;
  compatiblePipeKinds: string[];
  connectedEdgeIds: string[];
  allowsMultipleConnections?: boolean;
}

export interface ValidationRunInput {
  id: string;
  systemType: string;
  pipeKind: string;
  diameterMm: number;
  nodePositions: Array<{ x: number; y: number; z: number }>;
  startPort?: ValidationPortInput;
  endPort?: ValidationPortInput;
  bendRadiiMm?: number[];
  minimumBendRadiusMm?: number;
  equivalentLengthMm?: number;
  insulationSpecified?: boolean;
}

export interface ValidationBranchInput {
  id: string;
  model: string;
  selection: BranchSelectionContext;
  frame: BranchWorldFrame;
  upstreamStraightMm?: number;
  downstreamStraightMm?: number[];
}

export interface ValidationPairInput {
  id: string;
  gasRunId: string;
  liquidRunId: string;
  directionAlignmentDot: number;
  separationMm: number;
  requiredSeparationMm: number;
}

export interface VrfValidationSnapshot {
  ports: ValidationPortInput[];
  runs: ValidationRunInput[];
  branches: ValidationBranchInput[];
  pairs: ValidationPairInput[];
  cycleEntityIds?: string[];
  disconnectedEntityIds?: string[];
  clashPairs?: Array<{ a: string; b: string; clearanceMm: number }>;
}

export interface VrfValidationReport {
  issues: VrfValidationIssue[];
  commitBlocked: boolean;
  counts: Record<ValidationLevel, number>;
}

const distance3 = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function routeLength(points: ValidationRunInput['nodePositions']): number {
  return points.slice(1).reduce((sum, point, index) => sum + distance3(points[index]!, point), 0);
}

function makeIssue(
  code: string,
  level: ValidationLevel,
  message: string,
  entityId?: string,
  suggestedFix?: string,
): VrfValidationIssue {
  return {
    id: `${code}:${entityId ?? 'network'}`,
    code,
    level,
    entityId,
    message,
    suggestedFix,
  };
}

function validatePort(port: ValidationPortInput): VrfValidationIssue[] {
  const issues: VrfValidationIssue[] = [];
  if (!port.allowsMultipleConnections && port.connectedEdgeIds.length > 1) {
    issues.push(makeIssue(
      'duplicate-port-connection',
      'error',
      'Equipment port has more than one pipe connection.',
      port.id,
      'Disconnect the duplicate edge or use a manufacturer-approved multi-connection component.',
    ));
  }
  if (port.connectedEdgeIds.length === 0) {
    issues.push(makeIssue('open-equipment-port', 'warning', 'Equipment port is not connected.', port.id));
  }
  return issues;
}

function validateRun(run: ValidationRunInput, profile: ManufacturerRuleProfile): VrfValidationIssue[] {
  const issues: VrfValidationIssue[] = [];
  if (run.nodePositions.length < 2) {
    return [makeIssue('degenerate-run', 'error', 'Pipe run has fewer than two route nodes.', run.id)];
  }
  if (run.nodePositions.slice(1).some((point, index) => distance3(run.nodePositions[index]!, point) <= 1e-6)) {
    issues.push(makeIssue('zero-length-segment', 'error', 'Pipe run contains a zero-length segment.', run.id));
  }
  for (const [side, port] of [['start', run.startPort], ['end', run.endPort]] as const) {
    if (!port) continue;
    if (port.systemType !== run.systemType) {
      issues.push(makeIssue('port-system-mismatch', 'error', `${side} port system does not match the pipe.`, run.id));
    }
    if (!port.compatiblePipeKinds.includes(run.pipeKind)) {
      issues.push(makeIssue('pipe-kind-incompatible', 'error', `${side} port does not accept this pipe kind.`, run.id));
    }
    if (Math.abs(port.connectionDiameterMm - run.diameterMm) > 0.25) {
      issues.push(makeIssue(
        'diameter-mismatch',
        'warning',
        `${side} connection requires a reducer or compatible adapter.`,
        run.id,
        'Insert a reducer permitted by the active manufacturer profile.',
      ));
    }
  }
  const minimumRadius = run.minimumBendRadiusMm;
  if (minimumRadius !== undefined && (run.bendRadiiMm ?? []).some((radius) => radius + 1e-6 < minimumRadius)) {
    issues.push(makeIssue('bend-radius', 'error', 'One or more bends are below the required radius.', run.id));
  }
  const totalLength = routeLength(run.nodePositions);
  const maxTotal = profile.routeLimits.maximumTotalLengthMm;
  if (maxTotal && totalLength > maxTotal.value) {
    issues.push(makeIssue(
      'maximum-total-length',
      'error',
      `Pipe length ${totalLength.toFixed(0)} mm exceeds ${maxTotal.value.toFixed(0)} mm.`,
      run.id,
    ));
  }
  const maxEquivalent = profile.routeLimits.maximumEquivalentLengthMm;
  if (maxEquivalent && (run.equivalentLengthMm ?? totalLength) > maxEquivalent.value) {
    issues.push(makeIssue('maximum-equivalent-length', 'error', 'Equivalent pipe length exceeds the active rule profile.', run.id));
  }
  const heights = run.nodePositions.map((point) => point.z);
  const heightDifference = Math.max(...heights) - Math.min(...heights);
  const maxHeight = profile.routeLimits.maximumHeightDifferenceMm;
  if (maxHeight && heightDifference > maxHeight.value) {
    issues.push(makeIssue('height-difference', 'error', 'Pipe height difference exceeds the active rule profile.', run.id));
  }
  if (run.insulationSpecified === false) {
    issues.push(makeIssue('missing-insulation', 'warning', 'Pipe insulation information is missing.', run.id));
  }
  issues.push(makeIssue('calculated-length', 'information', `Calculated centerline length: ${totalLength.toFixed(0)} mm.`, run.id));
  return issues;
}

function validateBranch(branch: ValidationBranchInput, profile: ManufacturerRuleProfile): VrfValidationIssue[] {
  const issues: VrfValidationIssue[] = [];
  const selection = selectBranchKit(profile, { ...branch.selection, currentModel: branch.model });
  if (!selection.preferred) {
    issues.push(makeIssue('branch-model-invalid', 'error', selection.diagnostics[0] ?? 'Branch model is invalid.', branch.id));
  } else if (selection.preferred.rule.model !== branch.model) {
    issues.push(makeIssue(
      'branch-model-recommendation',
      'warning',
      `Active rules recommend ${selection.preferred.rule.model} instead of ${branch.model}.`,
      branch.id,
      'Review and apply the reversible branch replacement command.',
    ));
  }
  const modelRule = profile.branchKits.find((candidate) => candidate.model === branch.model);
  if (!modelRule) return issues;
  const orientation = validateBranchOrientation(branch.frame, modelRule.orientation);
  for (const violation of orientation.violations) {
    issues.push(makeIssue('branch-orientation', 'error', violation, branch.id, 'Rotate to the nearest permitted orientation.'));
  }
  for (const zone of modelRule.straightZones) {
    if (zone.upstreamMinimumMm && (branch.upstreamStraightMm ?? 0) < zone.upstreamMinimumMm.value) {
      issues.push(makeIssue('branch-upstream-straight', 'error', 'Insufficient straight pipe upstream of branch.', branch.id));
    }
    if (zone.downstreamMinimumMm) {
      const index = zone.appliesToOutletIndex ?? 0;
      if ((branch.downstreamStraightMm?.[index] ?? 0) < zone.downstreamMinimumMm.value) {
        issues.push(makeIssue('branch-downstream-straight', 'error', `Insufficient straight pipe at branch outlet ${index + 1}.`, branch.id));
      }
    }
  }
  return issues;
}

/** Fast or full validation share issue semantics; callers choose which inputs to populate. */
export function validateVrfNetwork(
  snapshot: VrfValidationSnapshot,
  profile: ManufacturerRuleProfile,
): VrfValidationReport {
  const issues = [
    ...snapshot.ports.flatMap(validatePort),
    ...snapshot.runs.flatMap((run) => validateRun(run, profile)),
    ...snapshot.branches.flatMap((branch) => validateBranch(branch, profile)),
  ];
  for (const pair of snapshot.pairs) {
    if (pair.directionAlignmentDot < 0.95) {
      issues.push(makeIssue('pipe-pair-direction', 'error', 'Gas and liquid pair directions are not coordinated.', pair.id));
    }
    if (Math.abs(pair.separationMm - pair.requiredSeparationMm) > 1) {
      issues.push(makeIssue('pipe-pair-separation', 'warning', 'Gas/liquid pair separation differs from its assembly setting.', pair.id));
    }
  }
  for (const id of snapshot.cycleEntityIds ?? []) {
    issues.push(makeIssue('invalid-network-cycle', 'error', 'Invalid refrigerant-network cycle detected.', id));
  }
  for (const id of snapshot.disconnectedEntityIds ?? []) {
    issues.push(makeIssue('disconnected-subgraph', 'error', 'Disconnected refrigerant subgraph detected.', id));
  }
  for (const clash of snapshot.clashPairs ?? []) {
    issues.push(makeIssue(
      'pipe-clash',
      clash.clearanceMm < 0 ? 'error' : 'warning',
      `Clearance issue between ${clash.a} and ${clash.b}.`,
      clash.a,
      'Reroute or apply a validated elevation bypass.',
    ));
  }
  const counts: Record<ValidationLevel, number> = {
    error: 0,
    warning: 0,
    advisory: 0,
    information: 0,
  };
  for (const issue of issues) counts[issue.level] += 1;
  return { issues, counts, commitBlocked: counts.error > 0 };
}

