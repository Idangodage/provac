import type { Point2D } from '../../../types';

import type { PipeRouteNode3D } from './pipeRoute3d';

const POSITION_EPSILON_MM = 1e-5;
const DIRECTION_EPSILON = 1e-6;
// The pipe lane builder currently emits at most 96 chords per elbow. Keeping
// recognition bounded prevents a long authored route from becoming quadratic.
const MAX_ARC_CHORDS = 128;

export interface SampledQuarterTurn {
  startIndex: number;
  endIndex: number;
  corner: Point2D;
  incoming: Point2D;
  outgoing: Point2D;
  radiusMm: number;
}

export interface RiserCornerPlanMatch extends SampledQuarterTurn {
  guideStartIndex: number;
  guideEndIndex: number;
}

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function direction(a: Point2D, b: Point2D): Point2D | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  return Number.isFinite(length) && length > POSITION_EPSILON_MM
    ? { x: dx / length, y: dy / length }
    : null;
}

function sameDirection(a: Point2D, b: Point2D): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= DIRECTION_EPSILON;
}

/**
 * Recognize only circular quarter turns with straight tangent leads. A generic
 * polyline, a chamfer, a custom port gather, or a noncircular curve is left alone.
 * No inference is made from a corner's visual resemblance to an elbow.
 */
export function findSampledQuarterTurns(points: readonly Point2D[]): SampledQuarterTurn[] {
  const result: SampledQuarterTurn[] = [];
  for (let startIndex = 1; startIndex < points.length - 3; startIndex += 1) {
    const start = points[startIndex]!;
    const incoming = direction(points[startIndex - 1]!, start);
    if (!incoming) continue;
    const maxEndIndex = Math.min(points.length - 2, startIndex + MAX_ARC_CHORDS);
    for (let endIndex = startIndex + 2; endIndex <= maxEndIndex; endIndex += 1) {
      const end = points[endIndex]!;
      const outgoing = direction(end, points[endIndex + 1]!);
      if (!outgoing || Math.abs(dot(incoming, outgoing)) > DIRECTION_EPSILON) continue;
      const chord = subtract(end, start);
      const incomingSetback = dot(chord, incoming);
      const outgoingSetback = dot(chord, outgoing);
      const tolerance = Math.max(POSITION_EPSILON_MM, Math.abs(incomingSetback) * 1e-6);
      if (incomingSetback <= POSITION_EPSILON_MM
        || Math.abs(incomingSetback - outgoingSetback) > tolerance) continue;
      const radiusMm = (incomingSetback + outgoingSetback) / 2;
      const center = { x: start.x + outgoing.x * radiusMm, y: start.y + outgoing.y * radiusMm };
      let previousAngle = 0;
      let circular = true;
      for (let index = startIndex + 1; index < endIndex; index += 1) {
        const radial = subtract(points[index]!, center);
        const cosine = -dot(radial, outgoing) / radiusMm;
        const sine = dot(radial, incoming) / radiusMm;
        const angle = Math.atan2(sine, cosine);
        if (!Number.isFinite(angle)
          || Math.abs(Math.hypot(radial.x, radial.y) - radiusMm) > tolerance
          || angle <= previousAngle + DIRECTION_EPSILON
          || angle >= Math.PI / 2 - DIRECTION_EPSILON) {
          circular = false;
          break;
        }
        previousAngle = angle;
      }
      if (!circular) continue;
      result.push({
        startIndex,
        endIndex,
        corner: { x: start.x + incoming.x * radiusMm, y: start.y + incoming.y * radiusMm },
        incoming,
        outgoing,
        radiusMm,
      });
      startIndex = endIndex;
      break;
    }
  }
  return result;
}

function findPlanQuarterTurns(points: readonly Point2D[]): SampledQuarterTurn[] {
  const rounded = findSampledQuarterTurns(points);
  const result = [...rounded];
  let roundedIndex = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    while (rounded[roundedIndex] && rounded[roundedIndex]!.endIndex < index) roundedIndex += 1;
    const arc = rounded[roundedIndex];
    if (arc && index >= arc.startIndex && index <= arc.endIndex) continue;
    const incoming = direction(points[index - 1]!, points[index]!);
    const outgoing = direction(points[index]!, points[index + 1]!);
    if (!incoming || !outgoing || Math.abs(dot(incoming, outgoing)) > DIRECTION_EPSILON) continue;
    result.push({ startIndex: index, endIndex: index, corner: points[index]!, incoming, outgoing, radiusMm: 0 });
  }
  return result.sort((a, b) => a.startIndex - b.startIndex);
}

/**
 * Match a lane corner to a true vertical stack in its elevation guide. Checking
 * both signed lateral offsets admits parallel gas/liquid lanes without matching
 * corners that have moved along the trunk. The straight leads must also overlap
 * the guide's immediately adjacent rays. Sharp corners are included so callers
 * can pin both levels to the same route station after restoring a rounded arc.
 */
export function findRiserCornerPlanMatches(
  plan: readonly Point2D[],
  guide: readonly PipeRouteNode3D[],
): RiserCornerPlanMatch[] {
  if (guide.length < 4 || plan.length < 3) return [];
  // Most routes have one level or a rise on a straight leg. Inspect their tiny
  // guide first and avoid inspecting every sampled elbow unless a corner riser
  // actually needs correspondence with this physical lane.
  let candidates: SampledQuarterTurn[] | undefined;
  const matches: RiserCornerPlanMatch[] = [];
  const used = new Set<number>();
  for (let startIndex = 1; startIndex < guide.length - 2; startIndex += 1) {
    const first = guide[startIndex]!;
    let endIndex = startIndex;
    while (endIndex + 1 < guide.length
      && Math.hypot(guide[endIndex + 1]!.x - first.x, guide[endIndex + 1]!.y - first.y) <= POSITION_EPSILON_MM) {
      endIndex += 1;
    }
    if (endIndex === startIndex || endIndex >= guide.length - 1) continue;
    const last = guide[endIndex]!;
    const before = guide[startIndex - 1]!;
    const after = guide[endIndex + 1]!;
    if (!Number.isFinite(first.z) || !Number.isFinite(last.z)
      || Math.abs(last.z - first.z) <= POSITION_EPSILON_MM
      || Math.abs(before.z - first.z) > POSITION_EPSILON_MM
      || Math.abs(after.z - last.z) > POSITION_EPSILON_MM) continue;
    const incoming = direction(before, first);
    const outgoing = direction(last, after);
    if (!incoming || !outgoing || Math.abs(dot(incoming, outgoing)) > DIRECTION_EPSILON) continue;
    const incomingLength = Math.hypot(first.x - before.x, first.y - before.y);
    const outgoingLength = Math.hypot(after.x - last.x, after.y - last.y);
    let best: SampledQuarterTurn | undefined;
    let bestOffset = Infinity;
    for (const candidate of candidates ??= findPlanQuarterTurns(plan)) {
      if (used.has(candidate.startIndex)
        || !sameDirection(candidate.incoming, incoming)
        || !sameDirection(candidate.outgoing, outgoing)) continue;
      const delta = subtract(candidate.corner, first);
      const incomingOffset = -incoming.y * delta.x + incoming.x * delta.y;
      const outgoingOffset = -outgoing.y * delta.x + outgoing.x * delta.y;
      const tolerance = Math.max(POSITION_EPSILON_MM, Math.abs(incomingOffset) * 1e-6);
      if (Math.abs(incomingOffset - outgoingOffset) > tolerance) continue;
      // Socket cups add collinear points immediately outside the circular body.
      // On an offset lane those points can both lie past the guide corner even
      // though the full straight leads overlap it. Measure the whole tangent
      // segment, without crossing any authored change of direction.
      let leadStartIndex = candidate.startIndex - 1;
      while (leadStartIndex > 0) {
        const preceding = direction(plan[leadStartIndex - 1]!, plan[leadStartIndex]!);
        if (!preceding || !sameDirection(preceding, incoming)) break;
        leadStartIndex -= 1;
      }
      let leadEndIndex = candidate.endIndex + 1;
      while (leadEndIndex < plan.length - 1) {
        const following = direction(plan[leadEndIndex]!, plan[leadEndIndex + 1]!);
        if (!following || !sameDirection(following, outgoing)) break;
        leadEndIndex += 1;
      }
      const leadStart = dot(subtract(plan[leadStartIndex]!, first), incoming);
      const leadEnd = dot(subtract(plan[leadEndIndex]!, first), outgoing);
      const tangentStart = dot(subtract(plan[candidate.startIndex]!, first), incoming);
      const tangentEnd = dot(subtract(plan[candidate.endIndex]!, first), outgoing);
      if (leadStart > tolerance || tangentStart < -incomingLength - tolerance
        || leadEnd < -tolerance || tangentEnd > outgoingLength + tolerance) continue;
      if (Math.abs(incomingOffset) < bestOffset) {
        best = candidate;
        bestOffset = Math.abs(incomingOffset);
      }
    }
    if (best) {
      matches.push({ ...best, guideStartIndex: startIndex, guideEndIndex: endIndex });
      used.add(best.startIndex);
    }
    startIndex = endIndex;
  }
  return matches;
}

/**
 * A rise at a plan corner uses two elbows in perpendicular vertical planes.
 * Remove only that corner's pre-rounded plan elbow before lifting to 3D;
 * otherwise its sampled XY arc introduces a redundant third elbow.
 */
export function restoreRiserCornerPlanProjection<T extends readonly Point2D[]>(
  plan: T,
  guide: readonly PipeRouteNode3D[],
): T | Point2D[] {
  const matches = findRiserCornerPlanMatches(plan, guide)
    .filter((match) => match.endIndex > match.startIndex)
    .sort((a, b) => a.startIndex - b.startIndex);
  if (matches.length === 0) return plan;
  const result: Point2D[] = [];
  let nextIndex = 0;
  for (const match of matches) {
    result.push(...plan.slice(nextIndex, match.startIndex), match.corner);
    nextIndex = match.endIndex + 1;
  }
  result.push(...plan.slice(nextIndex));
  return result;
}
