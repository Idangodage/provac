import type { HvacElement, Wall } from '../../../types';
import type { ManufacturerRuleProfile } from '../../../vrf/rules';

import { effectiveAutoRouteSettings } from './autoRouteEvaluation';
import type { CondensateDesignSettings } from './condensate/condensateSettings';
import { validateCondensateNetwork } from './condensate/condensateValidation';
import { getActiveDuctSettings, setActiveDuctSettings, type DuctDesignSettings } from './duct/ductSettings';
import { findDuctClashes } from './duct/ductVolumes';
import { findNewNetworkPipeClashes, listNetworkPipeLanes } from './networkPipeClearance';
import { getActivePipeRoutingSettings, setActivePipeRoutingSettings, type PipeRoutingSettings } from './pipeRoutingSettings';
import { refrigerantChangeIssues } from './refrigerantChangeValidation';

interface ServiceRouteValidationOptions {
  condensate: CondensateDesignSettings;
  routing: PipeRoutingSettings;
  ducts?: DuctDesignSettings;
  profile?: ManufacturerRuleProfile;
  walls?: readonly Wall[];
}

export interface ServiceRouteCommand {
  add?: readonly HvacElement[];
  removeIds?: readonly string[];
  updates?: ReadonlyArray<{ id: string; updates: Partial<HvacElement> }>;
}

export interface ServiceRouteIssue {
  code: 'solid-clash' | 'drainage' | 'refrigerant';
  message: string;
  elementIds: string[];
}

/** The exact assembly that a single undoable command would commit. */
export function applyServiceRouteCommand(scene: readonly HvacElement[], command: ServiceRouteCommand): HvacElement[] {
  const removed = new Set(command.removeIds);
  const updates = new Map(command.updates?.map((entry) => [entry.id, entry.updates]));
  return [...scene.filter((element) => !removed.has(element.id)).map((element) => {
    const update = updates.get(element.id);
    return update ? { ...element, ...update } : element;
  }), ...(command.add ?? [])];
}

/**
 * Final hard checks run after every approved modification, including pipe hops.
 * An unrelated existing problem cannot block an otherwise valid local edit.
 * Changed duct contacts are rechecked even when the same pair clashed before.
 */
export function serviceRouteCommitIssues(
  scene: readonly HvacElement[],
  command: ServiceRouteCommand,
  options: ServiceRouteValidationOptions,
): string[] {
  return [...new Set(serviceRouteCommitDiagnostics(scene, command, options).map(issue => issue.message))];
}

/** Keep entity references through the final audit so a review can locate the conflict. */
export function serviceRouteCommitDiagnostics(
  scene: readonly HvacElement[],
  command: ServiceRouteCommand,
  options: ServiceRouteValidationOptions,
): ServiceRouteIssue[] {
  const priorRouting = getActivePipeRoutingSettings();
  const priorDucts = getActiveDuctSettings();
  setActivePipeRoutingSettings(effectiveAutoRouteSettings(options.profile, options.routing, applyServiceRouteCommand(scene, command)));
  if (options.ducts) setActiveDuctSettings(options.ducts);
  try {
    return checkServiceRouteCommand(scene, command, options);
  } finally {
    setActivePipeRoutingSettings(priorRouting);
    setActiveDuctSettings(priorDucts);
  }
}

function checkServiceRouteCommand(
  scene: readonly HvacElement[],
  command: ServiceRouteCommand,
  options: ServiceRouteValidationOptions,
): ServiceRouteIssue[] {
  const finalScene = applyServiceRouteCommand(scene, command);
  const changed = new Set([...(command.add ?? []).map((element) => element.id), ...(command.updates ?? []).map((entry) => entry.id)]);
  const affected = new Set([...changed, ...(command.removeIds ?? [])]);
  if (!affected.size) return [];
  const proposed = finalScene.filter((element) => changed.has(element.id));
  const byId = new Map(finalScene.map((element) => [element.id, element]));
  const label = (id: string) => byId.get(id)?.label || byId.get(id)?.type || id;
  const issues: ServiceRouteIssue[] = [];
  const pairs = new Set<string>();
  for (const clash of findNewNetworkPipeClashes([...scene], proposed, [...(command.removeIds ?? [])])) {
    const [a, b] = clash.elementIds;
    pairs.add([a, b].sort().join('|'));
    issues.push({ code: 'solid-clash', elementIds: [a, b],
      message: `${label(a)} intersects ${label(b)}; reroute or provide clearance before applying.` });
  }
  for (const clash of findDuctClashes(finalScene, options.ducts ?? getActiveDuctSettings(), listNetworkPipeLanes(finalScene))) {
    if (!changed.has(clash.ductId) && !changed.has(clash.otherId)) continue;
    const key = [clash.ductId, clash.otherId].sort().join('|');
    if (pairs.has(key)) continue;
    pairs.add(key);
    issues.push({ code: 'solid-clash', elementIds: [clash.ductId, clash.otherId],
      message: `${label(clash.ductId)} intersects ${label(clash.otherId)}; reroute or provide clearance before applying.` });
  }
  for (const issue of validateCondensateNetwork(finalScene, { settings: options.condensate, routingSettings: options.routing }).issues) {
    if (issue.level === 'error' && issue.entityId && changed.has(issue.entityId)) {
      issues.push({ code: 'drainage', message: issue.message, elementIds: [issue.entityId] });
    }
  }
  issues.push(...refrigerantChangeIssues(scene, finalScene, affected, { profile: options.profile, walls: options.walls })
    .map(message => ({ code: 'refrigerant' as const, message, elementIds: [] })));
  return [...new Map(issues.map(issue => [`${issue.code}|${issue.elementIds.slice().sort().join('|')}|${issue.message}`, issue])).values()];
}
