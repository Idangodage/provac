import type { HvacElementCommand } from '../../../store';
import type { HvacElement } from '../../../types';

import { findNewNetworkPipeClashes } from './networkPipeClearance';
import { isNetworkLevelPlanCurrent, planNetworkPipeLevels, type NetworkPipeLevelPlan } from './networkPipeLevels';
import { normalizePipeRouteNodes3d } from './pipeRoute3d';
import { getActivePipeRoutingSettings, type PipeRoutingSettings } from './pipeRoutingSettings';
import { resolveRefrigerantPipeSpec } from './refrigerantPipePairModel';

export interface NetworkRiserUpgrade {
  selectedId: string;
  plan: NetworkPipeLevelPlan | null;
  issue?: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {};

/** Saved automatic ramps can be adopted deliberately; authored risers and
 * explicit bypasses remain under the user's control. */
export function isLegacyGeneratedRamp(element: HvacElement): boolean {
  const metadata = record(element.properties.networkLevelPlan);
  if (element.type !== 'refrigerant-pipe' || element.properties.networkLevelLocked === true
    || metadata.generated !== true || metadata.version !== 1
    || (Array.isArray(element.properties.bypasses) && element.properties.bypasses.length > 0)) return false;
  const nodes = normalizePipeRouteNodes3d(element.properties.routeNodes3d);
  return nodes.some((node, index) => index > 0
    && Math.abs(node.z - nodes[index - 1]!.z) > 0.5
    && Math.hypot(node.x - nodes[index - 1]!.x, node.y - nodes[index - 1]!.y) > 0.5);
}

/** Planning is pure. Selection never changes saved geometry. */
export function proposeNetworkRiserUpgrade(
  scene: HvacElement[], selectedId: string, settings = getActivePipeRoutingSettings(),
): NetworkRiserUpgrade | null {
  const selected = scene.find(element => element.id === selectedId);
  if (!selected || !isLegacyGeneratedRamp(selected)) return null;
  const bundleId = resolveRefrigerantPipeSpec(selected.properties).bundleId;
  const hosts = bundleId ? scene.filter(element => element.type === 'refrigerant-pipe'
    && element.properties.bundleId === bundleId) : [];
  const gases = hosts.filter(element => element.properties.lineKind === 'gas');
  const liquids = hosts.filter(element => element.properties.lineKind === 'liquid');
  if (gases.length !== 1 || liquids.length !== 1) {
    return { selectedId, plan: null, issue: 'Select a run with one identified gas and liquid pair to coordinate its risers.' };
  }
  const gas = gases[0]!; const liquid = liquids[0]!;
  const gasSpec = resolveRefrigerantPipeSpec(gas.properties);
  const liquidSpec = resolveRefrigerantPipeSpec(liquid.properties);
  const level = (element: HvacElement, outer: number) => {
    const corridor = record(element.properties.networkLevelPlan).corridorElevationMm;
    return typeof corridor === 'number' && Number.isFinite(corridor) ? corridor : element.elevation + outer / 2;
  };
  const gasLevel = level(gas, gasSpec.outerDiameterMm);
  const liquidLevel = level(liquid, liquidSpec.outerDiameterMm);
  const gasPoint = gasSpec.routePoints[0]; const liquidPoint = liquidSpec.routePoints[0];
  if (!gasPoint || !liquidPoint) return { selectedId, plan: null, issue: 'The selected pair needs a complete route before its risers can be coordinated.' };
  const next = gasSpec.routePoints[1] ?? gasPoint;
  const length = Math.hypot(next.x - gasPoint.x, next.y - gasPoint.y) || 1;
  const direction = { x: (next.x - gasPoint.x) / length, y: (next.y - gasPoint.y) / length };
  // Field identity only: all equipment elevations come from actual saved
  // connections in the network. No proposed indoor unit is added to the cost.
  const plan = planNetworkPipeLevels(scene, {
    gasHostId: gas.id, liquidHostId: liquid.id, gasHostElevationMm: gasLevel, liquidHostElevationMm: liquidLevel, settings,
    startBundle: {
      point: { x: (gasPoint.x + liquidPoint.x) / 2, y: (gasPoint.y + liquidPoint.y) / 2 },
      gasPoint, liquidPoint, gasFieldPoint: gasPoint, liquidFieldPoint: liquidPoint,
      direction, gasDirection: direction, liquidDirection: direction,
      gasOuterDiameterMm: gasSpec.outerDiameterMm, liquidOuterDiameterMm: liquidSpec.outerDiameterMm,
      elevationMm: (gasLevel + liquidLevel) / 2, gasElevationMm: gasLevel, liquidElevationMm: liquidLevel,
      connectionKind: 'field-pipe', sourceElementId: gas.id, gasSourceElementId: gas.id, liquidSourceElementId: liquid.id,
    },
  });
  const proposal: NetworkRiserUpgrade = { selectedId, plan };
  const prepared = prepareNetworkRiserUpgrade(proposal, scene, settings);
  if (prepared.issue) proposal.issue = prepared.issue;
  return proposal;
}

/** Revalidate the displayed plan against the complete current scene before
 * emitting one history command, including newly introduced unrelated clashes. */
export function prepareNetworkRiserUpgrade(
  proposal: NetworkRiserUpgrade, scene: HvacElement[], settings: PipeRoutingSettings = getActivePipeRoutingSettings(),
): { command?: HvacElementCommand; issue?: string } {
  const plan = proposal.plan;
  if (!plan || !plan.feasible) return { issue: proposal.issue ?? plan?.issues[0] ?? 'These risers need an adjusted approach.' };
  if (JSON.stringify(settings) !== JSON.stringify(plan.settings) || !isNetworkLevelPlanCurrent(plan, scene)) {
    return { issue: 'The network or route defaults changed. Review the refreshed riser proposal.' };
  }
  const selected = scene.find(element => element.id === proposal.selectedId);
  if (!selected || !isLegacyGeneratedRamp(selected)) return { issue: 'This route no longer needs an automatic riser upgrade.' };
  if (!plan.requiresCoordination) return { issue: 'No buildable change was found for this route.' };
  if (findNewNetworkPipeClashes(scene, plan.updates).length) {
    return { issue: 'A vertical riser would meet another insulated pipe. Adjust the approach before applying.' };
  }
  return { command: { updates: plan.updates.map(element => ({ id: element.id, updates: element })) } };
}
