import { incompleteServiceRouteRefusal } from './autoRouteCompleteness';
import type { AutoRouteDuctUnit } from './duct/ductAutoRoute';
import type { UnifiedAutoRouteResult } from './unifiedAutoRoute';

export interface RouteReviewIssue {
  key: string;
  title: string;
  message: string;
  elementIds: string[];
}

const canonical = (message: string) => message.trim().replace(/\s+/g, ' ').replace(/[.!]$/, '').toLowerCase();
const uniqueMessages = (messages: readonly string[]) => [...new Map(messages.map(message => [canonical(message), message])).values()];

const DUCT_TITLES: Record<string, string> = {
  DU_FLEX_BEND: 'Bend radius below limit',
  DU_FLEX_LENGTH: 'Flexible connection too long',
  DU_TAP_CLASH: 'Insufficient take-off spacing',
  DU_LEG_TOO_SHORT: 'Insufficient fitting length',
  DU_CLASH: 'Equipment clearance conflict',
  DU_AUTO_ESP: 'Fan pressure limit exceeded',
  DU_AUTO_VOID: 'Insufficient ceiling space',
  DU_AUTO_WALL: 'Wall opening needs coordination',
  DU_AUTO_NO_DATA: 'Equipment data required',
};

export function ductUnitReview(unit: AutoRouteDuctUnit) {
  const diagnostics = unit.diagnostics ?? [];
  const errors = diagnostics.filter(issue => issue.severity === 'error');
  const details: RouteReviewIssue[] = errors.map((issue, index) => ({
    key: `${unit.unitId}:${issue.code}:${index}`, title: DUCT_TITLES[issue.code] ?? 'Duct layout constraint',
    message: issue.message, elementIds: [unit.unitId],
  }));
  // Older previews still carry plain notes. Keep all actionable evidence, but
  // a failed candidate's spigot rotations were never applied to the model.
  const messages = uniqueMessages(unit.notes.filter(note => !/^Its best design still has /i.test(note)
    && !(unit.status !== 'designed' && /^Spigot turned:/i.test(note))));
  const errorMessages = new Set(errors.map(issue => canonical(issue.message)));
  return { details, notes: messages.filter(message => !errorMessages.has(canonical(message))) };
}

/** Presentation derives from final checks, not just connected-unit counts. */
export function buildAutoRouteReview(result: UnifiedAutoRouteResult, approvedHopKeys: readonly string[]) {
  const issues: RouteReviewIssue[] = [];
  const seenMessages = new Set<string>();
  const seenEntities = new Set<string>();
  const add = (issue: RouteReviewIssue, physicalPair = false) => {
    const message = canonical(issue.message);
    const entities = issue.elementIds.length ? `${[...issue.elementIds].sort().join('|')}|${physicalPair ? 'contact' : message}` : null;
    if (entities ? seenEntities.has(entities) : seenMessages.has(message)) return;
    if (entities) seenEntities.add(entities);
    seenMessages.add(message);
    issues.push(issue);
  };
  for (const [index, issue] of (result.blockingDetails ?? []).entries()) {
    add({ key: `check:${index}`, title: issue.code === 'solid-clash' ? 'Physical clearance conflict'
      : issue.code === 'drainage' ? 'Drainage constraint' : 'Refrigerant constraint', ...issue }, issue.code === 'solid-clash');
  }
  const unservedTerminalIds = result.ducts?.unservedTerminalIds ?? [];
  if (unservedTerminalIds.length) add({ key: 'unserved-terminals', title: 'Air terminals need a ducted unit',
    message: `${unservedTerminalIds.length} selected air terminal${unservedTerminalIds.length === 1 ? ' has' : 's have'} no duct route. Review their ducted unit and terminal assignments.`,
    elementIds: unservedTerminalIds });
  for (const unit of result.condensate?.perUnit ?? []) {
    if (unit.status === 'infeasible') add({ key: `drain:${unit.unitId}`, title: `${unit.label}: drain route unavailable`,
      message: unit.reason ?? 'Review the available fall, drain outlet and termination positions.', elementIds: [unit.unitId] });
  }
  for (const [index, message] of (result.blockingIssues ?? []).entries()) {
    if (!seenMessages.has(canonical(message))) add({ key: `block:${index}`, title: 'Route needs correction', message, elementIds: [] });
  }
  for (const [index, clash] of result.clashes.entries()) {
    if (!clash.resolvedByHop) add({ key: `clash:${index}`, title: 'Service clearance conflict', message: clash.message, elementIds: clash.elementIds }, true);
  }
  const failedDuctUnits = result.ducts?.units.filter(unit => unit.status !== 'designed') ?? [];
  const pendingHops = result.condensate?.hopProposals.filter(hop => !approvedHopKeys.includes(hop.key)) ?? [];
  const ducts = result.ducts;
  const refrigerant = result.refrigerant;
  const condensate = result.condensate;
  const hasChanges = Boolean((ducts?.elementsToAdd.length ?? 0) + (ducts?.removeElementIds.length ?? 0)
    + (ducts?.terminalUpdates.length ?? 0) + (refrigerant?.elementsToAdd.length ?? 0)
    + (refrigerant?.removeElementIds.length ?? 0) + (refrigerant?.updates.length ?? 0)
    + (condensate?.elementsToAdd.length ?? 0) + (condensate?.removeElementIds.length ?? 0));
  const ductNotes = new Set((ducts?.issues ?? []).map(canonical));
  const resolvedMessages = new Set(result.clashes.map(clash => canonical(clash.message)));
  const advisory = uniqueMessages(result.issues).filter(message => !seenMessages.has(canonical(message))
    && !ductNotes.has(canonical(message)) && !resolvedMessages.has(canonical(message)));
  // These remain advisory: absent verified manufacturer data cannot become an
  // invented failure or a claim that the geometry is an approved installation.
  const manufacturerNotes = advisory.filter(message => /manufacturer|capacity ind(?:ex|ices)|equivalent length|component size|branch-kit sizing/i.test(message));
  const manufacturerSet = new Set(manufacturerNotes);
  const installationNotes = advisory.filter(message => !manufacturerSet.has(message));
  const applyReason = incompleteServiceRouteRefusal(result) ?? issues[0]?.message
    ?? (pendingHops.length ? `Approve ${pendingHops.length} required pipe hop${pendingHops.length === 1 ? '' : 's'} before applying.` : null);
  return { issues, failedDuctUnits, pendingHops, hasChanges, applyReason, manufacturerNotes, installationNotes,
    state: applyReason ? 'blocked' as const : hasChanges ? 'ready' as const : 'unchanged' as const };
}
