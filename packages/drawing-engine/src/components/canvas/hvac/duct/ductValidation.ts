/**
 * Duct design checks in the one design-check list: every issue the
 * fabrication planner and the support planner raise for each run (DU_*), in
 * the VRF report shape so they merge with the refrigerant and condensate
 * checks, plus the clashes between ducts and other services.
 */
import type { HvacElement } from '../../../../types';
import type { VrfValidationIssue, VrfValidationReport } from '../../../../vrf/rules';
import { listNetworkPipeLanes } from '../networkPipeClearance';

import { getDuctRunPlan, type DuctIssue } from './ductFabricationPlanner';
import type { DuctDesignSettings } from './ductSettings';
import { getDuctSupportPlan } from './ductSupports';
import { isDuctElement } from './ductTypes';
import { findDuctClashes } from './ductVolumes';

const SERVICE_NAMES: Record<string, string> = { gas: 'refrigerant gas pipe', liquid: 'refrigerant liquid pipe', drain: 'condensate drain' };

const LEVEL: Record<DuctIssue['severity'], VrfValidationIssue['level']> = {
  error: 'error',
  warning: 'warning',
  info: 'information',
};

export function countIssues(issues: readonly VrfValidationIssue[]): VrfValidationReport['counts'] {
  const counts = { error: 0, warning: 0, advisory: 0, information: 0 };
  for (const issue of issues) counts[issue.level] += 1;
  return counts;
}

export function validateDuctRuns(
  elements: readonly HvacElement[],
  settings: DuctDesignSettings,
  extra: readonly VrfValidationIssue[] = [],
): VrfValidationReport {
  const issues: VrfValidationIssue[] = [];
  for (const element of elements) {
    if (!isDuctElement(element)) continue;
    const plan = getDuctRunPlan(element, elements, settings);
    if (!plan) continue;
    const supports = getDuctSupportPlan(plan, elements, settings);
    const label = element.label || 'Duct run';
    const seen = new Set<string>();
    for (const found of [...plan.issues, ...supports.issues]) {
      // One entry per code and message on a run (a rule can fire on several pieces).
      const key = `${found.code}|${found.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        id: `${found.code}:${element.id}:${seen.size}`,
        level: LEVEL[found.severity],
        code: found.code,
        entityId: element.id,
        message: `${label}: ${found.message}`,
      });
    }
  }
  // Clashes: duct bodies against the insulated pipe tubes and against other runs.
  const byId = new Map(elements.map((element) => [element.id, element]));
  for (const clash of findDuctClashes(elements, settings, listNetworkPipeLanes([...elements]))) {
    const duct = byId.get(clash.ductId);
    const other = byId.get(clash.otherId);
    const otherName = clash.kind === 'duct' ? `duct run ${other?.label || clash.otherId}`
      : clash.kind === 'terminal' ? `air terminal ${other?.label || clash.otherId}`
        : clash.kind === 'equipment' ? `equipment ${other?.label || clash.otherId}`
        : `${SERVICE_NAMES[clash.service ?? ''] ?? 'pipe'} ${other?.label || clash.otherId}`;
    const subject = duct && !isDuctElement(duct) ? duct.label || 'Air terminal' : duct?.label || 'Duct run';
    issues.push({
      id: `DU_CLASH:${clash.ductId}:${clash.otherId}`,
      level: 'error',
      code: 'DU_CLASH',
      entityId: clash.ductId,
      message: `${subject}: ${clash.mark} clashes with the ${otherName} at (${Math.round(clash.point.x)}, ${Math.round(clash.point.y)}, z ${Math.round(clash.point.z)}).`,
      suggestedFix: clash.kind === 'pipe' ? 'Re-route the pipe over or under the duct, or change the duct level.'
        : clash.kind === 'equipment' ? 'Route the duct clear of the equipment casing and preserve access to its connections.'
        : clash.kind === 'terminal' ? 'Move the terminal or re-route the run round its box.' : 'Change one run\'s level or route.',
    });
  }
  issues.push(...extra);
  return { issues, commitBlocked: false, counts: countIssues(issues) };
}
