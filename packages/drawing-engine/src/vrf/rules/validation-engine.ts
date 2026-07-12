import {
  measureBranchOrientation,
  validateBranchOrientation,
  type BranchWorldFrame,
} from './branch-orientation';
import { selectBranchKit, type BranchSelectionContext } from './branch-selection';
import type { ManufacturerRuleProfile } from './rule-profile';

export type ValidationLevel = 'error' | 'warning' | 'advisory' | 'information';

export type VrfValidationFix =
  | { kind: 'repair-port-stub' }
  | {
      kind: 'set-pipe-diameter';
      diameterMm: number;
      lineKind?: ValidationRunInput['lineKind'];
    }
  | { kind: 'set-branch-model'; model: string }
  | { kind: 'level-branch' }
  | { kind: 'mark-insulated' };

export interface VrfValidationIssue {
  id: string;
  level: ValidationLevel;
  code: string;
  entityId?: string;
  message: string;
  suggestedFix?: string;
  fix?: VrfValidationFix;
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
  lineKind?: 'gas' | 'liquid' | 'suction' | 'discharge' | 'equalizer' | 'drain';
  pipeKind: string;
  diameterMm: number;
  expectedDiameterMm?: number;
  nodePositions: Array<{ x: number; y: number; z: number }>;
  startPort?: ValidationPortInput;
  endPort?: ValidationPortInput;
  startPortStubMm?: number;
  endPortStubMm?: number;
  bendRadiiMm?: number[];
  minimumBendRadiusMm?: number;
  equivalentLengthMm?: number;
  insulationSpecified?: boolean;
  /** Positive means the modelled fall is toward the outdoor unit. */
  slopeTowardOutdoorPercent?: number;
  hasSagPocket?: boolean;
  flowDirectionValid?: boolean;
}

export interface StraightZoneIntrusion {
  side: 'upstream' | 'downstream';
  outletIndex?: number;
  hasBend?: boolean;
  hasReducer?: boolean;
  hasOtherBranch?: boolean;
}

export interface ValidationBranchInput {
  id: string;
  model: string;
  branchType?: 'y-joint' | 'header' | 'outdoor-multi-kit';
  selection: BranchSelectionContext;
  frame: BranchWorldFrame;
  upstreamStraightMm?: number;
  downstreamStraightMm?: number[];
  outletElevationsMm?: number[];
  distanceToAdjacentJointMm?: number;
  firstElbowDistancesMm?: number[];
  connectedToSelectorBox?: boolean;
  inletFacesUpstream?: boolean;
  insulationSpecified?: boolean;
  equivalentLengthMm?: number;
  straightZoneIntrusions?: StraightZoneIntrusion[];
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
  /** A three-valent topology node without an approved Y/header fitting. */
  unapprovedTeeEntityIds?: string[];
  totalEquivalentLengthMm?: number;
  indoorUnitCount?: number;
  indoorToBranchDistances?: Array<{ entityId: string; distanceMm: number }>;
  outdoorIndoorVerticalSeparations?: Array<{
    entityId: string;
    separationMm: number;
    outdoorBelowIndoor: boolean;
  }>;
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
  fix?: VrfValidationFix,
): VrfValidationIssue {
  return {
    id: `${code}:${entityId ?? 'network'}`,
    code,
    level,
    entityId,
    message,
    suggestedFix,
    fix,
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
  const requiredStub = profile.portDefaults.minimumStraightStubMm.value;
  for (const [side, port, actual] of [
    ['start', run.startPort, run.startPortStubMm],
    ['end', run.endPort, run.endPortStubMm],
  ] as const) {
    if (port && actual !== undefined && actual + 1e-6 < requiredStub) {
      issues.push(makeIssue(
        'PORT_STUB',
        'error',
        `${side} port straight stub ${actual.toFixed(0)} mm is below ${requiredStub.toFixed(0)} mm.`,
        run.id,
        'Extend the port-normal straight segment before the first bend.',
        { kind: 'repair-port-stub' },
      ));
    }
  }
  if (
    run.expectedDiameterMm !== undefined
    && Math.abs(run.diameterMm - run.expectedDiameterMm) > 0.25
  ) {
    issues.push(makeIssue(
      'PIPE_SIZE',
      'error',
      `Pipe diameter ${run.diameterMm.toFixed(2)} mm does not match the required ${run.expectedDiameterMm.toFixed(2)} mm.`,
      run.id,
      'Resize the run from the active manufacturer capacity table.',
      {
        kind: 'set-pipe-diameter',
        diameterMm: run.expectedDiameterMm,
        lineKind: run.lineKind,
      },
    ));
  }
  if (run.flowDirectionValid === false) {
    issues.push(makeIssue(
      'FLOW_DIR',
      'error',
      'Pipe or fitting flow direction is reversed.',
      run.id,
      'Flip the run so flow proceeds from the outdoor source toward downstream loads.',
    ));
  }
  const lineKind = run.lineKind ?? (
    run.systemType.includes('gas') || run.systemType.includes('suction')
      ? 'gas'
      : undefined
  );
  const minimumSlope = profile.installation?.minimumGasSlopePercent?.value;
  if (
    minimumSlope !== undefined
    && (lineKind === 'gas' || lineKind === 'suction')
    && run.slopeTowardOutdoorPercent !== undefined
    && run.slopeTowardOutdoorPercent + 1e-6 < minimumSlope
  ) {
    issues.push(makeIssue(
      'SLOPE',
      'warning',
      `Gas-line slope ${run.slopeTowardOutdoorPercent.toFixed(2)}% is below ${minimumSlope.toFixed(2)}% toward the outdoor unit.`,
      run.id,
      'Reflow the run to maintain the profile slope toward the outdoor unit.',
    ));
  }
  if (run.hasSagPocket) {
    issues.push(makeIssue(
      'NO_SAG_TRAP',
      'error',
      'The run contains a sag pocket or non-approved U-trap.',
      run.id,
      'Level or re-route the run; use only manufacturer-approved inverted traps.',
    ));
  }
  const totalLength = routeLength(run.nodePositions);
  const heights = run.nodePositions.map((point) => point.z);
  const heightDifference = Math.max(...heights) - Math.min(...heights);
  const maxHeight = profile.routeLimits.maximumHeightDifferenceMm;
  if (maxHeight && heightDifference > maxHeight.value) {
    issues.push(makeIssue('VERT_SEP', 'error', 'Pipe height difference exceeds the active rule profile.', run.id));
  }
  if (profile.installation?.requireInsulation !== false && run.insulationSpecified !== true) {
    issues.push(makeIssue(
      'INSULATION',
      'warning',
      'Pipe insulation is missing or unspecified.',
      run.id,
      'Specify closed-cell insulation and thickness for the complete run.',
      { kind: 'mark-insulated' },
    ));
  }
  issues.push(makeIssue('calculated-length', 'information', `Calculated centerline length: ${totalLength.toFixed(0)} mm.`, run.id));
  return issues;
}

function validateBranch(branch: ValidationBranchInput, profile: ManufacturerRuleProfile): VrfValidationIssue[] {
  const issues: VrfValidationIssue[] = [];
  const selection = selectBranchKit(profile, { ...branch.selection, currentModel: branch.model });
  if (profile.branchKits.length === 0) {
    issues.push(makeIssue(
      'BRANCH_PROFILE',
      'advisory',
      'No verified branch-kit catalogue is loaded for the active profile.',
      branch.id,
      'Load the selected manufacturer engineering profile before final sizing.',
    ));
  } else if (!selection.preferred) {
    issues.push(makeIssue('branch-model-invalid', 'error', selection.diagnostics[0] ?? 'Branch model is invalid.', branch.id));
  } else if (selection.preferred.rule.model !== branch.model) {
    issues.push(makeIssue(
      'branch-model-recommendation',
      'warning',
      `Active rules recommend ${selection.preferred.rule.model} instead of ${branch.model}.`,
      branch.id,
      'Review and apply the reversible branch replacement command.',
      { kind: 'set-branch-model', model: selection.preferred.rule.model },
    ));
  }
  const modelRule = profile.branchKits.find((candidate) => candidate.model === branch.model);
  if (modelRule) {
    const orientation = validateBranchOrientation(
      { ...branch.frame, fittingType: branch.branchType ?? modelRule.branchType },
      modelRule.orientation,
    );
    for (const violation of orientation.violations) {
      issues.push(makeIssue(
        'BRANCH_TILT',
        'error',
        violation,
        branch.id,
        'Level the fitting to the nearest manufacturer-permitted orientation.',
        { kind: 'level-branch' },
      ));
    }
    for (const zone of modelRule.straightZones) {
      if (zone.upstreamMinimumMm && (branch.upstreamStraightMm ?? 0) < zone.upstreamMinimumMm.value) {
        issues.push(makeIssue(
          'STRAIGHT_BEFORE',
          'error',
          'Insufficient straight pipe upstream of branch.',
          branch.id,
          'Insert or extend the reserved upstream straight stub.',
        ));
      }
      if (zone.downstreamMinimumMm) {
        const index = zone.appliesToOutletIndex ?? 0;
        if ((branch.downstreamStraightMm?.[index] ?? 0) < zone.downstreamMinimumMm.value) {
          issues.push(makeIssue(
            'STRAIGHT_AFTER',
            'error',
            `Insufficient straight pipe at branch outlet ${index + 1}.`,
            branch.id,
            'Insert or extend the reserved outlet straight stub.',
          ));
        }
      }
      const intrusions = (branch.straightZoneIntrusions ?? []).filter((intrusion) => (
        zone.appliesToOutletIndex === undefined
        || intrusion.side === 'upstream'
        || intrusion.outletIndex === zone.appliesToOutletIndex
      ));
      if (zone.noBendAllowed && intrusions.some((intrusion) => intrusion.hasBend)) {
        issues.push(makeIssue(
          intrusions.some((intrusion) => intrusion.side === 'upstream') ? 'STRAIGHT_BEFORE' : 'STRAIGHT_AFTER',
          'error',
          'A bend intrudes into the fitting straight zone.',
          branch.id,
          'Move the first elbow outside the reserved straight zone.',
        ));
      }
      if (zone.noReducerAllowed && intrusions.some((intrusion) => intrusion.hasReducer)) {
        issues.push(makeIssue(
          intrusions.some((intrusion) => intrusion.side === 'upstream') ? 'STRAIGHT_BEFORE' : 'STRAIGHT_AFTER',
          'error',
          'A reducer intrudes into the fitting straight zone.',
          branch.id,
          'Move the reducer outside the reserved straight zone.',
        ));
      }
      if (zone.noOtherBranchAllowed && intrusions.some((intrusion) => intrusion.hasOtherBranch)) {
        issues.push(makeIssue(
          'JOINT_SPACING',
          'error',
          'Another branch intrudes into the fitting straight zone.',
          branch.id,
          'Increase the straight spacing between adjacent branch kits.',
        ));
      }
    }
  }
  if (!modelRule) {
    const orientation = measureBranchOrientation({
      ...branch.frame,
      fittingType: branch.branchType,
    });
    const tolerance = branch.selection.systemRole === 'first-branch'
      ? profile.installation?.outdoorBranchTiltToleranceDeg?.value
      : profile.installation?.indoorBranchTiltToleranceDeg?.value;
    if (
      tolerance !== undefined
      && (Math.abs(orientation.rollDeg) > tolerance + 1e-6
        || Math.abs(orientation.pitchDeg) > tolerance + 1e-6)
    ) {
      issues.push(makeIssue(
        'BRANCH_TILT',
        'error',
        `Branch tilt exceeds the ${tolerance.toFixed(1)}Â° fallback/profile tolerance.`,
        branch.id,
        'Level the fitting while preserving its horizontal yaw.',
        { kind: 'level-branch' },
      ));
    }
  }
  const genericUpstreamMinimum = profile.installation?.minimumBranchStraightBeforeMm?.value;
  if (
    genericUpstreamMinimum !== undefined
    && (branch.upstreamStraightMm ?? 0) + 1e-6 < genericUpstreamMinimum
    && !issues.some((issue) => issue.code === 'STRAIGHT_BEFORE')
  ) {
    issues.push(makeIssue(
      'STRAIGHT_BEFORE',
      'error',
      `Straight pipe before the fitting is below ${genericUpstreamMinimum.toFixed(0)} mm.`,
      branch.id,
      'Extend the reserved inlet straight zone.',
    ));
  }
  const genericDownstreamMinimum = profile.installation?.minimumBranchStraightAfterMm?.value;
  if (genericDownstreamMinimum !== undefined) {
    (branch.downstreamStraightMm ?? []).forEach((actual, index) => {
      if (actual + 1e-6 >= genericDownstreamMinimum) return;
      if (issues.some((issue) => (
        issue.code === 'STRAIGHT_AFTER'
        && issue.message.includes(`outlet ${index + 1}`)
      ))) return;
      issues.push(makeIssue(
        'STRAIGHT_AFTER',
        'error',
        `Straight pipe at branch outlet ${index + 1} is below ${genericDownstreamMinimum.toFixed(0)} mm.`,
        branch.id,
        'Extend the reserved outlet straight zone.',
      ));
    });
  }
  const outletElevations = branch.outletElevationsMm ?? [];
  const headerTolerance = profile.installation?.headerOutletLevelToleranceMm?.value;
  if (
    (branch.branchType === 'header' || modelRule?.branchType === 'header')
    && headerTolerance !== undefined
    && outletElevations.length > 1
    && Math.max(...outletElevations) - Math.min(...outletElevations) > headerTolerance + 1e-6
  ) {
    issues.push(makeIssue(
      'HEADER_LEVEL',
      'error',
      `Header outlets are not level within ${headerTolerance.toFixed(1)} mm.`,
      branch.id,
      'Level all header outlets to one elevation.',
      { kind: 'level-branch' },
    ));
  }
  const minimumJointSpacing = profile.installation?.minimumJointSpacingMm?.value;
  if (
    minimumJointSpacing !== undefined
    && branch.distanceToAdjacentJointMm !== undefined
    && branch.distanceToAdjacentJointMm + 1e-6 < minimumJointSpacing
  ) {
    issues.push(makeIssue(
      'JOINT_SPACING',
      'error',
      `Adjacent joint spacing ${branch.distanceToAdjacentJointMm.toFixed(0)} mm is below ${minimumJointSpacing.toFixed(0)} mm.`,
      branch.id,
      'Move the fitting to restore the required straight spacing.',
    ));
  }
  const elbowClearance = branch.connectedToSelectorBox
    ? profile.installation?.minimumSelectorBoxElbowClearanceMm?.value
    : profile.installation?.minimumBranchElbowClearanceMm?.value;
  if (
    elbowClearance !== undefined
    && (branch.firstElbowDistancesMm ?? []).some((distance) => distance + 1e-6 < elbowClearance)
  ) {
    issues.push(makeIssue(
      'ELBOW_CLEARANCE',
      'warning',
      `The first elbow is closer than ${elbowClearance.toFixed(0)} mm to the fitting.`,
      branch.id,
      'Move the first elbow beyond the profile clearance.',
    ));
  }
  if (branch.inletFacesUpstream === false) {
    issues.push(makeIssue(
      'FLOW_DIR',
      'error',
      'Branch-kit inlet does not face the upstream outdoor source.',
      branch.id,
      'Flip the fitting flow direction.',
    ));
  }
  if (profile.installation?.requireInsulation !== false && branch.insulationSpecified !== true) {
    issues.push(makeIssue(
      'INSULATION',
      'warning',
      'Branch-kit insulation is missing or unspecified.',
      branch.id,
      'Specify sealed closed-cell insulation for the complete fitting.',
      { kind: 'mark-insulated' },
    ));
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
  const totalActualLengthMm = snapshot.runs.reduce(
    (sum, run) => sum + routeLength(run.nodePositions),
    0,
  );
  const maximumTotalLength = profile.routeLimits.maximumTotalLengthMm;
  if (maximumTotalLength && totalActualLengthMm > maximumTotalLength.value) {
    issues.push(makeIssue(
      'EQ_LENGTH',
      'error',
      `Total routed length ${totalActualLengthMm.toFixed(0)} mm exceeds ${maximumTotalLength.value.toFixed(0)} mm.`,
      undefined,
      'Shorten or re-balance the refrigerant network.',
    ));
  }
  const calculatedEquivalentLengthMm = snapshot.runs.reduce(
    (sum, run) => sum + (run.equivalentLengthMm ?? routeLength(run.nodePositions)),
    0,
  ) + snapshot.branches.reduce((sum, branch) => {
    const catalogValue = profile.branchKits.find((rule) => rule.model === branch.model)
      ?.equivalentLengthMm?.value;
    return sum + (branch.equivalentLengthMm ?? catalogValue ?? 0);
  }, 0);
  const equivalentLengthMm = snapshot.totalEquivalentLengthMm ?? calculatedEquivalentLengthMm;
  const maximumEquivalentLength = profile.routeLimits.maximumEquivalentLengthMm;
  if (maximumEquivalentLength && equivalentLengthMm > maximumEquivalentLength.value) {
    issues.push(makeIssue(
      'EQ_LENGTH',
      'error',
      `Equivalent length ${equivalentLengthMm.toFixed(0)} mm exceeds ${maximumEquivalentLength.value.toFixed(0)} mm.`,
      undefined,
      'Reduce routed length or fitting count.',
    ));
  }
  const maximumIndoorUnitCount = profile.routeLimits.maximumIndoorUnitCount;
  if (
    maximumIndoorUnitCount
    && snapshot.indoorUnitCount !== undefined
    && snapshot.indoorUnitCount > maximumIndoorUnitCount.value
  ) {
    issues.push(makeIssue(
      'INDOOR_UNIT_COUNT',
      'error',
      `Connected indoor-unit count ${snapshot.indoorUnitCount} exceeds ${maximumIndoorUnitCount.value}.`,
    ));
  }
  const maximumIndoorToBranchLength = profile.routeLimits.maximumIndoorToBranchLengthMm;
  if (maximumIndoorToBranchLength) {
    for (const distance of snapshot.indoorToBranchDistances ?? []) {
      if (distance.distanceMm <= maximumIndoorToBranchLength.value) continue;
      issues.push(makeIssue(
        'INDOOR_BRANCH_LENGTH',
        'error',
        `Indoor-to-branch length ${distance.distanceMm.toFixed(0)} mm exceeds ${maximumIndoorToBranchLength.value.toFixed(0)} mm.`,
        distance.entityId,
      ));
    }
  }
  for (const separation of snapshot.outdoorIndoorVerticalSeparations ?? []) {
    const limit = separation.outdoorBelowIndoor
      ? profile.routeLimits.maximumOutdoorBelowHeightDifferenceMm
        ?? profile.routeLimits.maximumHeightDifferenceMm
      : profile.routeLimits.maximumHeightDifferenceMm;
    if (!limit || separation.separationMm <= limit.value) continue;
    issues.push(makeIssue(
      'VERT_SEP',
      'error',
      `Outdoor-to-indoor separation ${separation.separationMm.toFixed(0)} mm exceeds ${limit.value.toFixed(0)} mm.`,
      separation.entityId,
      'Reposition equipment or use a manufacturer-approved system arrangement.',
    ));
  }
  if (profile.installation?.prohibitUnapprovedTee !== false) {
    for (const id of snapshot.unapprovedTeeEntityIds ?? []) {
      issues.push(makeIssue(
        'NO_TEE',
        'error',
        'A plumbing tee or bare three-way node is not permitted in the refrigerant network.',
        id,
        'Replace it with an approved directional Y-joint or header.',
      ));
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
  const issueIdOccurrences = new Map<string, number>();
  const uniquelyKeyedIssues = issues.map((issue) => {
    const occurrence = (issueIdOccurrences.get(issue.id) ?? 0) + 1;
    issueIdOccurrences.set(issue.id, occurrence);
    return occurrence === 1
      ? issue
      : { ...issue, id: `${issue.id}:${occurrence}` };
  });
  const counts: Record<ValidationLevel, number> = {
    error: 0,
    warning: 0,
    advisory: 0,
    information: 0,
  };
  for (const issue of uniquelyKeyedIssues) counts[issue.level] += 1;
  return { issues: uniquelyKeyedIssues, counts, commitBlocked: counts.error > 0 };
}
