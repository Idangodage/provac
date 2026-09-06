import type { HvacElement } from '../../../types';

import { resolveCopperSocketElbow, resolveCopperSocketElbowMinimumRadius, usesCopperSocketElbows } from './copperSocketElbows';
import { buildNetworkLevelRoute } from './networkPipeLevels';
import { generateRiserTurnAlternatives, recoverQuarterTurnCorners3D, recoverQuarterTurnGeometry3D,
  restoreUnchangedQuarterTurns3D } from './pipeRiserOptimization';
import { normalizePipeRouteNodes3d, type PipeRouteNode3D as Node } from './pipeRoute3d';
import type { PipeRoutingSettings } from './pipeRoutingSettings';
import { resolveRefrigerantPipeSpec } from './refrigerantPipePairModel';

const EPS = 1e-5;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object'
  ? value as Record<string, unknown> : {};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const distance = (a: Node, b: Node): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function routeMetrics(nodes: readonly Node[]): { turns: number; verticalTravel: number; reversals: number } {
  let turns = 0; let verticalTravel = 0; let reversals = 0;
  let previousDirection: Node | undefined;
  let previousRise = 0;
  for (let index = 1; index < nodes.length; index += 1) {
    const a = nodes[index - 1]!; const b = nodes[index]!;
    const span = distance(a, b);
    if (span <= EPS) continue;
    const direction = { x: (b.x - a.x) / span, y: (b.y - a.y) / span, z: (b.z - a.z) / span };
    if (previousDirection) turns += Math.acos(Math.max(-1, Math.min(1,
      previousDirection.x * direction.x + previousDirection.y * direction.y + previousDirection.z * direction.z)));
    previousDirection = direction;
    verticalTravel += Math.abs(b.z - a.z);
    if (Math.abs(b.z - a.z) > EPS) {
      const rise = Math.sign(b.z - a.z);
      if (previousRise && previousRise !== rise) reversals += 1;
      previousRise = rise;
    }
  }
  return { turns, verticalTravel, reversals };
}

function rightAngleCount(nodes: readonly Node[]): number {
  const corners = recoverQuarterTurnCorners3D(nodes);
  let count = 0;
  for (let index = 1; index < corners.length - 1; index += 1) {
    const a = corners[index - 1]!; const b = corners[index]!; const c = corners[index + 1]!;
    const incoming = distance(a, b); const outgoing = distance(b, c);
    if (incoming <= EPS || outgoing <= EPS) continue;
    if (Math.abs((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)
      + (b.z - a.z) * (c.z - b.z)) <= incoming * outgoing * 1e-6) count += 1;
  }
  return count;
}

/**
 * Reconsider temporary separate-riser fallbacks only after all branch sockets
 * exist. Each pipe's physical endpoints then reserve the distribution level
 * required by its takeoffs. Returned arrays contain updates only; the caller
 * must accept them against the complete network's clearances and cost model.
 */
export function buildNetworkRiserRefinements(
  elements: readonly HvacElement[], settings: PipeRoutingSettings,
): HvacElement[][] {
  const updates: HvacElement[] = [];
  const individualVariants: HvacElement[] = [];
  for (const element of elements) {
    const properties = element.properties;
    const plan = record(properties.networkLevelPlan);
    if (element.type !== 'refrigerant-pipe' || plan.version !== 2 || plan.generated !== true
      || !finite(plan.corridorElevationMm)
      || ['networkLevelLocked', 'routeLocked', 'routingLocked', 'locked', 'isLocked', 'reviewed', 'installationReviewed']
        .some(key => properties[key] === true)
      || properties.routingMode === 'manual' || properties.routeMode === 'manual'
      || (Array.isArray(properties.bypasses) && properties.bypasses.length > 0)) continue;
    const before = normalizePipeRouteNodes3d(properties.routeNodes3d);
    if (before.length < 4 || !Array.isArray(properties.routeNodes3d)
      || before.length !== properties.routeNodes3d.length) continue;
    const beforeMetrics = routeMetrics(before);
    if (beforeMetrics.verticalTravel <= EPS || beforeMetrics.turns < 3 * Math.PI / 2 - EPS) continue;
    const spec = resolveRefrigerantPipeSpec(properties);
    if (!spec.startConnection || !spec.endConnection) continue;
    const boundStart = { ...spec.startConnection.portPoint, z: spec.startConnection.elevationMm };
    const boundEnd = { ...spec.endConnection.portPoint, z: spec.endConnection.elevationMm };
    if (distance(before[0]!, boundStart) > EPS || distance(before.at(-1)!, boundEnd) > EPS) continue;
    const radius = spec.outerDiameterMm / 2;
    const socketDiameter = usesCopperSocketElbows(properties) ? spec.pipeDiameterMm : undefined;
    const minimumRadius = resolveCopperSocketElbowMinimumRadius(properties);
    const built = buildNetworkLevelRoute(spec.routePoints, plan.corridorElevationMm, {
      start: spec.startConnection, end: spec.endConnection, radiusMm: radius,
      pipeDiameterMm: socketDiameter, minimumBendRadiusMm: minimumRadius,
      settings, preferCornerRisers: true, includeRiserAlternatives: true,
    });
    const geometries = built.issue ? [] : built.alternativeNodes ?? [built.nodes];
    // An existing interior riser may have a free corner on either side. Fresh
    // terminal planning alone can erase that choice, so retain its independent
    // moves as well, restoring every unrelated sampled fitting exactly.
    if (before.some(node => Math.abs(node.z - (plan.corridorElevationMm as number)) <= EPS)) {
      const recovered = recoverQuarterTurnGeometry3D(before);
      const takeoff = Math.max(1, radius * 2 * settings.bendRadiusFactor, settings.minimumFieldBendRadiusMm,
        minimumRadius, socketDiameter ? resolveCopperSocketElbow(socketDiameter, 90)?.centerToFaceMm ?? 0 : 0);
      const protectedStraight = (kind: string) => Math.max(takeoff,
        kind === 'unit-port' ? settings.minimumPortStubMm : settings.defaultBranchKitClearanceMm);
      for (const alternative of generateRiserTurnAlternatives(recovered.nodes, {
        bendTakeoffMm: takeoff, includeAllAlternatives: true,
        startStraightMm: protectedStraight(spec.startConnection.connectionKind),
        endStraightMm: protectedStraight(spec.endConnection.connectionKind),
      })) geometries.push(restoreUnchangedQuarterTurns3D(alternative.nodes, recovered.arcs));
    }
    const seenGeometry = new Set<string>();
    let preferred: HvacElement | undefined;
    let originalRightAngles: number | undefined;
    for (const after of geometries) {
      if (after.length < 4 || distance(before[0]!, after[0]!) > EPS || distance(before.at(-1)!, after.at(-1)!) > EPS) continue;
      const afterMetrics = routeMetrics(after);
      if (afterMetrics.verticalTravel > beforeMetrics.verticalTravel + EPS
        || afterMetrics.reversals > beforeMetrics.reversals
        || beforeMetrics.turns - afterMetrics.turns < Math.PI / 2 - EPS
        || (originalRightAngles ??= rightAngleCount(before)) <= rightAngleCount(after)) continue;
      const key = JSON.stringify(after);
      if (seenGeometry.has(key)) continue;
      seenGeometry.add(key);
      let minimum = Infinity; let maximum = -Infinity;
      for (const node of after) { minimum = Math.min(minimum, node.z); maximum = Math.max(maximum, node.z); }
      const update = { ...element, elevation: minimum - radius, height: maximum - minimum + radius * 2,
        properties: { ...properties, routeNodes3d: after,
          networkLevelPlan: { ...plan, preferCornerRisers: true } },
      };
      preferred ??= update;
      individualVariants.push(update);
    }
    if (preferred) updates.push(preferred);
  }
  if (!updates.length) return [];
  const candidates: HvacElement[][] = [];
  const seen = new Set<string>();
  const identities = new Map(individualVariants.map((update, index) => [update, index]));
  const add = (candidate: HvacElement[]) => {
    const key = candidate.map(element => identities.get(element)).join(',');
    if (!seen.has(key)) { seen.add(key); candidates.push(candidate); }
  };
  add(updates);
  const bundles = new Map<string, HvacElement[]>();
  for (const update of updates) {
    const bundle = typeof update.properties.bundleId === 'string' ? update.properties.bundleId : update.id;
    const group = bundles.get(bundle) ?? [];
    group.push(update); bundles.set(bundle, group);
  }
  // Every independent improvement gets a fallback. This grows linearly with
  // the number of pipes; an early blocked group cannot hide a later free one.
  for (const group of bundles.values()) if (group.length > 1) add(group);
  for (const update of individualVariants) add([update]);
  return candidates;
}
