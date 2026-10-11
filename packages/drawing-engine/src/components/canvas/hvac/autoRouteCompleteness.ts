import type { UnifiedAutoRouteResult } from './unifiedAutoRoute';

type ServiceProposal = Pick<UnifiedAutoRouteResult, 'services' | 'ducts' | 'refrigerant' | 'condensate'>;

/** An all-service Apply must not silently omit a requested, failed duct design. */
export function incompleteDuctRouteRefusal(result: Pick<ServiceProposal, 'services' | 'ducts'>): string | null {
  if (!result.services.supplyDuct && !result.services.returnDuct) return null;
  const failed = result.ducts?.units.filter(unit => unit.status === 'kept').length ?? 0;
  if (failed) return `No viable duct layout for ${failed} unit${failed === 1 ? '' : 's'}. Resolve duct issues, or turn off ducts and route again.`;
  const unserved = result.ducts?.unservedTerminalIds?.length ?? 0;
  return unserved ? `${unserved} selected air terminal${unserved === 1 ? ' has' : 's have'} no duct route. Review their ducted unit and terminal assignments.` : null;
}

/**
 * "Apply N designed units": the duct units that have a layout, without the
 * ones that have none (they keep the ducts they have), when the designer asks
 * for exactly that. Allowed while some requested unit has no layout, at least
 * one has, and every other requested service is complete. The refusal, or null.
 */
export function partialDuctApplyRefusal(result: ServiceProposal): string | null {
  if (!result.services.supplyDuct && !result.services.returnDuct) return 'No ducts were routed.';
  const units = result.ducts?.units ?? [];
  const designed = units.filter(unit => unit.status === 'designed');
  if (!designed.length) return 'No unit has a duct layout to apply.';
  if (designed.length === units.length) return 'Every unit has a layout: use Apply.';
  return incompleteServiceRouteRefusal({ ...result, ducts: { ...result.ducts!, units: designed, unservedTerminalIds: [] } });
}

/** Shared by candidate selection, review and Apply. Requested incomplete work
 * is never silently applied as a subset of a coordinated preview. Empty target
 * sets remain legitimate: for example, a duct-only selection has no drains. */
export function incompleteServiceRouteRefusal(result: ServiceProposal): string | null {
  const duct = incompleteDuctRouteRefusal(result);
  if (duct) return duct;
  if ((result.services.gas || result.services.liquid) && result.refrigerant?.unconnectedIndoorIds.length) {
    return 'Some indoor units have no refrigerant route. Review their connection requirements.';
  }
  if (result.services.condensate && result.condensate
    && (result.condensate.metrics.unitsConnected < result.condensate.metrics.unitsTotal
      || result.condensate.perUnit.some(unit => unit.status === 'infeasible'))) {
    return 'Some indoor units have no drain route. Review the available fall and outlet positions.';
  }
  return null;
}
