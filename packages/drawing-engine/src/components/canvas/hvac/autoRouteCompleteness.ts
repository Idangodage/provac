import type { UnifiedAutoRouteResult } from './unifiedAutoRoute';

type ServiceProposal = Pick<UnifiedAutoRouteResult, 'services' | 'ducts' | 'refrigerant' | 'condensate'>;

const REFRIGERANT_REFUSAL = 'Some indoor units have no refrigerant route. Review their connection requirements.';
const DRAIN_REFUSAL = 'Some indoor units have no drain route. Review the available fall and outlet positions.';

/** An all-service Apply must not silently omit a requested, failed duct design. */
export function incompleteDuctRouteRefusal(result: Pick<ServiceProposal, 'services' | 'ducts'>): string | null {
  if (!result.services.supplyDuct && !result.services.returnDuct) return null;
  const failed = result.ducts?.units.filter(unit => unit.status === 'kept').length ?? 0;
  if (failed) return `No viable duct layout for ${failed} unit${failed === 1 ? '' : 's'}. Resolve duct issues, or turn off ducts and route again.`;
  const unserved = result.ducts?.unservedTerminalIds?.length ?? 0;
  return unserved ? `${unserved} selected air terminal${unserved === 1 ? ' has' : 's have'} no duct route. Review their ducted unit and terminal assignments.` : null;
}

/** A part a partial apply leaves out: a duct unit with no layout, a terminal no duct reaches, a unit off the refrigerant or with no drain route. */
export interface LeftOutPart {
  service: 'ducts' | 'terminals' | 'refrigerant' | 'drains';
  id: string;
  /** Its tag (a duct unit) or label, for the panel and the status message. */
  label: string;
}

/** What "Apply complete parts" would leave out, each requested service in turn; empty when the preview is complete. */
export function leftOutParts(result: ServiceProposal, labelOf: (id: string) => string = (id) => id): LeftOutPart[] {
  const parts: LeftOutPart[] = [];
  if (result.services.supplyDuct || result.services.returnDuct) {
    for (const unit of result.ducts?.units ?? []) if (unit.status !== 'designed') parts.push({ service: 'ducts', id: unit.unitId, label: unit.tag ?? unit.unitLabel });
    for (const id of result.ducts?.unservedTerminalIds ?? []) parts.push({ service: 'terminals', id, label: labelOf(id) });
  }
  if (result.services.gas || result.services.liquid) {
    for (const id of result.refrigerant?.unconnectedIndoorIds ?? []) parts.push({ service: 'refrigerant', id, label: labelOf(id) });
  }
  if (result.services.condensate) {
    for (const unit of result.condensate?.perUnit ?? []) if (unit.status === 'infeasible') parts.push({ service: 'drains', id: unit.unitId, label: unit.label });
  }
  return parts;
}

/**
 * "Apply complete parts": every part that is complete — the duct units with a
 * layout, the refrigerant network as far as it reaches (sealed; a partial
 * network never replaces one already there), the drains that route — and
 * none of the rest, which keeps what it has and stays flagged. Allowed while
 * something requested is incomplete and something is complete. The refusal,
 * or null.
 */
export function partialApplyRefusal(result: ServiceProposal): string | null {
  if (!leftOutParts(result).length) return 'Every part is complete: use Apply.';
  const ducts = (result.ducts?.units ?? []).some(unit => unit.status === 'designed');
  const pipes = Boolean(result.refrigerant && (result.refrigerant.elementsToAdd.length || result.refrigerant.updates.length));
  const drains = Boolean(result.condensate?.elementsToAdd.length);
  return ducts || pipes || drains ? null : 'Nothing is complete to apply yet.';
}

/** The refusals that only say a part is incomplete (a partial apply leaves those parts out instead). */
export function incompletenessRefusals(result: ServiceProposal): string[] {
  return [
    incompleteDuctRouteRefusal(result),
    (result.services.gas || result.services.liquid) && result.refrigerant?.unconnectedIndoorIds.length ? REFRIGERANT_REFUSAL : null,
    result.services.condensate && result.condensate && (result.condensate.metrics.unitsConnected < result.condensate.metrics.unitsTotal
      || result.condensate.perUnit.some(unit => unit.status === 'infeasible')) ? DRAIN_REFUSAL : null,
  ].filter((message): message is string => Boolean(message));
}

/** Shared by candidate selection, review and Apply. Requested incomplete work
 * is never silently applied as a subset of a coordinated preview. Empty target
 * sets remain legitimate: for example, a duct-only selection has no drains. */
export function incompleteServiceRouteRefusal(result: ServiceProposal): string | null {
  return incompletenessRefusals(result)[0] ?? null;
}
