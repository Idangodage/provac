import type { HvacElementCommand } from '../../../store';
import type { HvacElement, Wall } from '../../../types';
import type { ManufacturerRuleProfile } from '../../../vrf/rules';

import type { AutoRouteNetworkResult } from './autoRouteWorkerProtocol';
import { protectedPipeNetworkElementIds } from './pipeEditRetention';
import type { PipeRoutingSettings } from './pipeRoutingSettings';

export interface AutoRouteSource {
  scene: HvacElement[];
  settings: PipeRoutingSettings;
  profile?: ManufacturerRuleProfile;
  walls: Wall[];
}

/** Store a value snapshot: in-place edits must also invalidate a worker result. */
export function autoRouteSourceSignature(source: AutoRouteSource): string {
  // Inspection covers do not change the physical network being calculated.
  const { fittingDisplay: _presentation, ...routingSettings } = source.settings;
  return JSON.stringify([source.scene, routingSettings, source.profile ?? null, source.walls]);
}

export function prepareAutoRouteCommand(
  sourceSignature: string,
  source: AutoRouteSource,
  result: Pick<AutoRouteNetworkResult, 'elementsToAdd' | 'removeElementIds' | 'updates' | 'complete' | 'unconnectedIndoorIds'>,
): { command?: HvacElementCommand; issue?: string; issueKind?: 'incomplete-network' } {
  if (sourceSignature !== autoRouteSourceSignature(source)) {
    return { issue: 'The drawing or routing rules changed while calculating. Run Auto route again.' };
  }
  if (!result.elementsToAdd.length && !result.updates?.length && !result.removeElementIds.length) return {};
  const incomplete = !result.complete || result.unconnectedIndoorIds.length > 0;
  const additivePartial = incomplete && result.elementsToAdd.length > 0
    && result.removeElementIds.length === 0 && !result.updates?.length;
  if (incomplete && !additivePartial) {
    const remaining = new Set(result.unconnectedIndoorIds).size;
    return {
      issue: remaining > 0
        ? `${remaining} indoor ${remaining === 1 ? 'unit remains' : 'units remain'} unconnected. The drawing was preserved.`
        : 'The automatic network could not be completed. The drawing was preserved.',
      issueKind: 'incomplete-network',
    };
  }
  if (!result.elementsToAdd.length && !result.updates?.length) return {};
  const existing = new Map(source.scene.map(element => [element.id, element]));
  const removed = new Set(result.removeElementIds);
  const protectedIds = protectedPipeNetworkElementIds(source.scene);
  if ([...removed, ...(result.updates ?? []).map(element => element.id)].some(id => protectedIds.has(id))) {
    return { issue: 'Manual edits or route locks protect this network. Allow auto rerouting for retained edits before calculating a replacement; locked routes remain protected.' };
  }
  const generatedIds = new Set<string>();
  const isNetworkPart = (element: HvacElement) =>
    element.type === 'refrigerant-pipe' || element.type === 'refrigerant-branch-kit';
  for (const id of removed) {
    const element = existing.get(id);
    if (!element || !isNetworkPart(element)) return { issue: 'The network to replace is no longer available.' };
  }
  for (const element of result.elementsToAdd) {
    if (!element.id || !isNetworkPart(element) || generatedIds.has(element.id)
      || (existing.has(element.id) && !removed.has(element.id))) {
      return { issue: 'The generated network contains a conflicting component. Run Auto route again.' };
    }
    generatedIds.add(element.id);
  }
  for (const element of result.updates ?? []) {
    const current = existing.get(element.id);
    if (!current || !isNetworkPart(current) || !isNetworkPart(element) || removed.has(element.id)) {
      return { issue: 'An existing network component changed while calculating.' };
    }
  }
  return { command: {
    add: result.elementsToAdd,
    removeIds: result.removeElementIds,
    updates: result.updates?.map(element => ({ id: element.id, updates: element })),
    selectedIds: [],
  } };
}
