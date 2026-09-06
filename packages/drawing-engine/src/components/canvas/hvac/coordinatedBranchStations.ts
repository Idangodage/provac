import type { Point2D } from '../../../types';

import { directBranchApproachStations } from './branchApproachStations';
import { defaultMinBranchKitSpacingMm, getBranchKitApproachRouteOptions, type BranchKitProposal } from './branchKitProposal';
import { buildOrthogonalConnectionRouteCandidates, getOrthogonalConnectionRouteCost, type OrthogonalConnectionRouteOptions } from './orthogonalConnectionRoute';
import type { PipeRoutingSettings } from './pipeRoutingSettings';
import type { RefrigerantPipeBundleConnection } from './refrigerantPipePairModel';

export interface CoordinatedBranchStations {
  previousStation: Point2D;
  nextStation: Point2D;
}

const EPSILON = 1e-6;
const subtract = (a: Point2D, b: Point2D): Point2D => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Point2D, b: Point2D): number => a.x * b.x + a.y * b.y;
const finite = (point: Point2D): boolean => Number.isFinite(point.x) && Number.isFinite(point.y);

/**
 * Reserve a direct takeoff for the next unit by moving the preceding pair
 * toward its inlet on the original, unsplit straight. These are bounded
 * search candidates: callers must replay both insertions and validate the
 * complete tree, physical sockets, obstacles and equipment clearances.
 */
export function coordinatedBranchApproachStations(options: {
  previous: BranchKitProposal;
  previousPort: RefrigerantPipeBundleConnection;
  next: BranchKitProposal;
  nextPort: RefrigerantPipeBundleConnection;
  settings: PipeRoutingSettings;
}): CoordinatedBranchStations[] {
  const { previous, previousPort, next, nextPort, settings } = options;
  const first = previous.target.segmentStart;
  const last = previous.target.segmentEnd;
  if (![first, last, previous.teePoint, next.teePoint].every(finite)) return [];
  const span = subtract(last, first);
  const spanLength = Math.hypot(span.x, span.y);
  if (spanLength < 1 || (Math.abs(span.x) > EPSILON && Math.abs(span.y) > EPSILON)) return [];
  const spanAxis = { x: span.x / spanLength, y: span.y / spanLength };
  const previousGhosts = [previous.gasGhost, previous.liquidGhost];
  const nextGhosts = [next.gasGhost, next.liquidGhost];
  // The actual inlet fixes the upstream side even when the drawing direction
  // is reversed. Euclidean proximity to an outdoor unit cannot establish flow.
  const inletVector = subtract(previous.gasGhost.inletPoint, previous.gasGhost.runOutletPoint);
  const inletSign = Math.sign(dot(inletVector, spanAxis));
  if (!inletSign) return [];
  const axis = { x: spanAxis.x * inletSign, y: spanAxis.y * inletSign };
  const across = { x: -axis.y, y: axis.x };
  for (const ghost of [...previousGhosts, ...nextGhosts]) {
    const through = subtract(ghost.inletPoint, ghost.runOutletPoint);
    if (![ghost.center, ghost.stationPoint, ghost.inletPoint, ghost.runOutletPoint, ghost.branchOutletPoint].every(finite)
      || dot(through, axis) <= 0 || Math.abs(dot(through, across)) > 0.5) return [];
  }
  if (Math.abs(dot(subtract(next.teePoint, previous.teePoint), across)) > 0.5) return [];
  for (const service of ['gasGhost', 'liquidGhost'] as const) {
    const oldSource = previous[service].element.properties.branchKitSnapSourceElementId;
    const nextSource = next[service].element.properties.branchKitSnapSourceElementId;
    if (oldSource && nextSource && oldSource !== nextSource) return [];
  }

  const project = (point: Point2D): number => dot(subtract(point, first), axis);
  const pointAt = (station: number): Point2D => ({ x: first.x + axis.x * station, y: first.y + axis.y * station });
  const spanMinimum = Math.min(0, project(last));
  const spanMaximum = Math.max(0, project(last));
  const clear = Math.max(0, settings.defaultBranchKitClearanceMm);
  const minimumSpacing = settings.minBranchKitSpacingMm > 0
    ? settings.minBranchKitSpacingMm : defaultMinBranchKitSpacingMm(settings);
  const previousScalar = project(previous.teePoint);
  const nextScalar = project(next.teePoint);
  const offsets = (proposal: BranchKitProposal) => [proposal.gasGhost, proposal.liquidGhost]
    .flatMap(ghost => [ghost.inletPoint, ghost.runOutletPoint])
    .map(point => dot(subtract(point, proposal.teePoint), axis));
  const previousOffsets = offsets(previous);
  const nextOffsets = offsets(next);
  // Match the placement solver's symmetric terminal margin on both services.
  const previousHalfReach = Math.max(...previousOffsets.map(Math.abs));
  const nextHalfReach = Math.max(...nextOffsets.map(Math.abs));
  const previousMinimum = spanMinimum + previousHalfReach + clear;
  const previousMaximum = spanMaximum - previousHalfReach - clear;
  const nextMinimum = spanMinimum + nextHalfReach + clear;
  const nextMaximum = spanMaximum - nextHalfReach - clear;
  if (previousMaximum < previousMinimum || nextMaximum < nextMinimum) return [];

  // After replay, the next host terminates at the preceding downstream
  // socket. It must still contain the complete next kit plus its clear pipe.
  let separation = -Math.min(...previousOffsets) + nextHalfReach + clear;
  for (const ghost of previousGhosts) {
    const previousCenter = subtract(ghost.center, previous.teePoint);
    // Include the existing proposal check (old center vs new tee station),
    // as well as true center spacing for each new service fitting.
    for (const nextCenter of [{ x: 0, y: 0 }, ...nextGhosts.map(item => subtract(item.center, next.teePoint))]) {
      const offset = subtract(previousCenter, nextCenter);
      const lateral = dot(offset, across);
      const requiredAlong = Math.sqrt(Math.max(0, minimumSpacing ** 2 - lateral ** 2));
      separation = Math.max(separation, requiredAlong - dot(offset, axis));
    }
  }

  // Invalid previews may omit the explicit pair-radius policy. Reconstruct
  // candidate approaches with the same physical policy as automatic insertion.
  const previousRoute = getBranchKitApproachRouteOptions({ ...previous,
    bendRadiusFactor: previous.bendRadiusFactor ?? settings.bendRadiusFactor }, previousPort, settings);
  const nextRoute = getBranchKitApproachRouteOptions({ ...next,
    bendRadiusFactor: next.bendRadiusFactor ?? settings.bendRadiusFactor }, nextPort, settings);
  const atStation = (route: OrthogonalConnectionRouteOptions, current: number, station: number): OrthogonalConnectionRouteOptions => ({
    ...route,
    end: { x: route.end.x + axis.x * (station - current), y: route.end.y + axis.y * (station - current) },
  });
  const directCost = (route: OrthogonalConnectionRouteOptions) => {
    const points = buildOrthogonalConnectionRouteCandidates(route)[0];
    if (!points) return null;
    const cost = getOrthogonalConnectionRouteCost(points);
    return cost.bends <= 2 ? cost : null;
  };
  const nextStations = [next.teePoint, ...directBranchApproachStations({
    route: nextRoute, station: next.teePoint,
    segmentStart: pointAt(nextMinimum), segmentEnd: pointAt(nextMaximum),
  })];
  const candidates = new Map<string, CoordinatedBranchStations & { bends: number; lengthMm: number; movementMm: number }>();
  for (const nextPoint of nextStations) {
    const reservedNext = project(nextPoint);
    if (reservedNext < nextMinimum - EPSILON || reservedNext > nextMaximum + EPSILON) continue;
    const nextCost = directCost(atStation(nextRoute, nextScalar, reservedNext));
    if (!nextCost) continue;
    const earliestPrevious = Math.max(previousMinimum, previousScalar + 1, reservedNext + separation);
    if (earliestPrevious > previousMaximum + EPSILON) continue;
    const previousStations = [
      pointAt(earliestPrevious),
      pointAt(earliestPrevious + 2 * (previousRoute.bendRadiusMm ?? 0)),
      ...directBranchApproachStations({ route: previousRoute, station: previous.teePoint,
        segmentStart: pointAt(earliestPrevious), segmentEnd: pointAt(previousMaximum) }),
    ];
    for (const previousPoint of previousStations) {
      const proposedPrevious = project(previousPoint);
      if (proposedPrevious < earliestPrevious - EPSILON || proposedPrevious > previousMaximum + EPSILON) continue;
      const previousCost = directCost(atStation(previousRoute, previousScalar, proposedPrevious));
      if (!previousCost) continue;
      const key = `${proposedPrevious.toFixed(3)}:${reservedNext.toFixed(3)}`;
      candidates.set(key, { previousStation: previousPoint, nextStation: nextPoint,
        bends: previousCost.bends + nextCost.bends, lengthMm: previousCost.lengthMm + nextCost.lengthMm,
        movementMm: proposedPrevious - previousScalar + Math.abs(reservedNext - nextScalar) });
    }
  }
  return [...candidates.values()]
    .sort((left, right) => left.bends - right.bends || left.lengthMm - right.lengthMm
      || left.movementMm - right.movementMm
      || project(left.previousStation) - project(right.previousStation)
      || project(left.nextStation) - project(right.nextStation))
    .slice(0, 4).map(({ previousStation, nextStation }) => ({ previousStation, nextStation }));
}
