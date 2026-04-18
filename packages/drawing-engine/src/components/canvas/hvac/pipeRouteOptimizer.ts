import type { Point2D } from '../../../types';

const DEFAULT_EQUIVALENT_LENGTH_PER_FITTING_MM = 300; // ~0.3 m per 90-degree elbow
const BASE_MIN_SEGMENT_MM = 30;
const EPSILON = 0.01;

export interface PipeRouteAvoidanceZone {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface PipeRouteConstraints {
  minBendRadiusMm?: number;
  pipeGapMm?: number;
  avoidanceZones?: PipeRouteAvoidanceZone[];
  equivalentLengthPerFittingMm?: number;
}

export interface PipeRouteCandidate {
  routePoints: Point2D[];
  totalLengthMm: number;
  fittingCount: number;
  score: number;
}

export interface PipeRerouteInput {
  fixedAnchor: Point2D;
  fixedDirection: Point2D;
  targetPort: Point2D;
  targetDirection: Point2D;
  existingRoutePoints?: Point2D[];
  fixedEnd?: 'start' | 'end';
  constraints?: PipeRouteConstraints;
}

export interface PipeRerouteResult {
  routePoints: Point2D[];
  totalLengthMm: number;
  fittingCount: number;
  // Backward-compatible alias.
  elbowCount: number;
}

export interface LeadSegmentRerouteResult {
  routePoints: Point2D[];
  pivotPoint: Point2D | null;
}

interface RouteSegment {
  start: Point2D;
  end: Point2D;
}

function add(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(point: Point2D, factor: number): Point2D {
  return { x: point.x * factor, y: point.y * factor };
}

function negate(point: Point2D): Point2D {
  return { x: -point.x, y: -point.y };
}

function normalize(point: Point2D): Point2D {
  const len = length(point);
  if (len < EPSILON) {
    return { x: 1, y: 0 };
  }
  return { x: point.x / len, y: point.y / len };
}

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function length(point: Point2D): number {
  return Math.hypot(point.x, point.y);
}

function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isHorizontal(dir: Point2D): boolean {
  return Math.abs(dir.x) >= Math.abs(dir.y);
}

function snapToAxis(direction: Point2D): Point2D {
  if (isHorizontal(direction)) {
    return direction.x >= 0 ? { x: 1, y: 0 } : { x: -1, y: 0 };
  }
  return direction.y >= 0 ? { x: 0, y: 1 } : { x: 0, y: -1 };
}

function segmentDirection(start: Point2D, end: Point2D): Point2D {
  const delta = subtract(end, start);
  const len = length(delta);
  if (len < EPSILON) {
    return { x: 0, y: 0 };
  }
  return { x: delta.x / len, y: delta.y / len };
}

function projectionInDirection(from: Point2D, to: Point2D, direction: Point2D): number {
  return dot(subtract(to, from), direction);
}

function dedupePoints(points: Point2D[]): Point2D[] {
  const deduped: Point2D[] = [];
  for (const point of points) {
    const previous = deduped[deduped.length - 1];
    if (!previous || distance(previous, point) > EPSILON) {
      deduped.push(point);
    }
  }
  return deduped;
}

function toSegments(points: Point2D[]): RouteSegment[] {
  const segments: RouteSegment[] = [];
  for (let i = 1; i < points.length; i++) {
    segments.push({ start: points[i - 1]!, end: points[i]! });
  }
  return segments;
}

function isAxisAlignedSegment(segment: RouteSegment): boolean {
  const dx = Math.abs(segment.end.x - segment.start.x);
  const dy = Math.abs(segment.end.y - segment.start.y);
  return (dx <= EPSILON && dy > EPSILON) || (dy <= EPSILON && dx > EPSILON);
}

function routeLength(points: Point2D[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distance(points[i - 1]!, points[i]!);
  }
  return total;
}

function countFittings(points: Point2D[]): number {
  let count = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const first = subtract(points[i]!, points[i - 1]!);
    const second = subtract(points[i + 1]!, points[i]!);
    const cross = first.x * second.y - first.y * second.x;
    if (Math.abs(cross) > EPSILON) {
      count++;
    }
  }
  return count;
}

function overlapLength(aMin: number, aMax: number, bMin: number, bMax: number): number {
  const start = Math.max(Math.min(aMin, aMax), Math.min(bMin, bMax));
  const end = Math.min(Math.max(aMin, aMax), Math.max(bMin, bMax));
  return end - start;
}

function pointOnSegment(point: Point2D, segment: RouteSegment): boolean {
  const minX = Math.min(segment.start.x, segment.end.x) - EPSILON;
  const maxX = Math.max(segment.start.x, segment.end.x) + EPSILON;
  const minY = Math.min(segment.start.y, segment.end.y) - EPSILON;
  const maxY = Math.max(segment.start.y, segment.end.y) + EPSILON;
  if (point.x < minX || point.x > maxX || point.y < minY || point.y > maxY) {
    return false;
  }
  const cross = (segment.end.x - segment.start.x) * (point.y - segment.start.y)
    - (segment.end.y - segment.start.y) * (point.x - segment.start.x);
  return Math.abs(cross) <= EPSILON;
}

function segmentsIntersect(a: RouteSegment, b: RouteSegment): boolean {
  const aVertical = Math.abs(a.start.x - a.end.x) <= EPSILON;
  const bVertical = Math.abs(b.start.x - b.end.x) <= EPSILON;

  if (aVertical && bVertical) {
    if (Math.abs(a.start.x - b.start.x) > EPSILON) {
      return false;
    }
    return overlapLength(a.start.y, a.end.y, b.start.y, b.end.y) > EPSILON;
  }

  if (!aVertical && !bVertical) {
    if (Math.abs(a.start.y - b.start.y) > EPSILON) {
      return false;
    }
    return overlapLength(a.start.x, a.end.x, b.start.x, b.end.x) > EPSILON;
  }

  const vertical = aVertical ? a : b;
  const horizontal = aVertical ? b : a;
  const intersection = { x: vertical.start.x, y: horizontal.start.y };
  return pointOnSegment(intersection, vertical) && pointOnSegment(intersection, horizontal);
}

function orientation(a: Point2D, b: Point2D, c: Point2D): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointsEqual(a: Point2D, b: Point2D): boolean {
  return distance(a, b) <= EPSILON;
}

function segmentsIntersectGeneral(a: RouteSegment, b: RouteSegment): boolean {
  const o1 = orientation(a.start, a.end, b.start);
  const o2 = orientation(a.start, a.end, b.end);
  const o3 = orientation(b.start, b.end, a.start);
  const o4 = orientation(b.start, b.end, a.end);

  const sign = (value: number): number => {
    if (Math.abs(value) <= EPSILON) return 0;
    return value > 0 ? 1 : -1;
  };

  const s1 = sign(o1);
  const s2 = sign(o2);
  const s3 = sign(o3);
  const s4 = sign(o4);

  if (s1 !== s2 && s3 !== s4) {
    return true;
  }
  if (s1 === 0 && pointOnSegment(b.start, a)) return true;
  if (s2 === 0 && pointOnSegment(b.end, a)) return true;
  if (s3 === 0 && pointOnSegment(a.start, b)) return true;
  if (s4 === 0 && pointOnSegment(a.end, b)) return true;
  return false;
}

function segmentIntersectsZone(segment: RouteSegment, zone: PipeRouteAvoidanceZone): boolean {
  const vertical = Math.abs(segment.start.x - segment.end.x) <= EPSILON;
  if (vertical) {
    const x = segment.start.x;
    if (x < zone.minX - EPSILON || x > zone.maxX + EPSILON) {
      return false;
    }
    return overlapLength(segment.start.y, segment.end.y, zone.minY, zone.maxY) > EPSILON;
  }
  const y = segment.start.y;
  if (y < zone.minY - EPSILON || y > zone.maxY + EPSILON) {
    return false;
  }
  return overlapLength(segment.start.x, segment.end.x, zone.minX, zone.maxX) > EPSILON;
}

function isRouteValid(
  points: Point2D[],
  minSegmentMm: number,
  avoidanceZones: readonly PipeRouteAvoidanceZone[],
): boolean {
  const segments = toSegments(points);
  if (segments.length === 0) {
    return false;
  }

  for (const segment of segments) {
    if (!isAxisAlignedSegment(segment)) {
      return false;
    }
    if (distance(segment.start, segment.end) + EPSILON < minSegmentMm) {
      return false;
    }
    for (const zone of avoidanceZones) {
      if (segmentIntersectsZone(segment, zone)) {
        return false;
      }
    }
  }

  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      if (Math.abs(i - j) <= 1) {
        continue;
      }
      if (segmentsIntersect(segments[i]!, segments[j]!)) {
        return false;
      }
    }
  }

  return true;
}

function scoreRoute(
  points: Point2D[],
  equivalentLengthPerFittingMm: number,
): PipeRouteCandidate {
  const routePoints = dedupePoints(points);
  const totalLengthMm = routeLength(routePoints);
  const fittingCount = countFittings(routePoints);
  return {
    routePoints,
    totalLengthMm,
    fittingCount,
    score: totalLengthMm + fittingCount * equivalentLengthPerFittingMm,
  };
}

function buildDirectCandidate(
  fixedAnchor: Point2D,
  anchorDir: Point2D,
  targetPort: Point2D,
  incomingTargetDir: Point2D,
  minSegmentMm: number,
): Point2D[] | null {
  const firstProjection = projectionInDirection(fixedAnchor, targetPort, anchorDir);
  if (firstProjection + EPSILON < minSegmentMm) {
    return null;
  }
  const segmentDir = snapToAxis(segmentDirection(fixedAnchor, targetPort));
  if (Math.abs(dot(segmentDir, anchorDir) - 1) > 0.001) {
    return null;
  }
  if (Math.abs(dot(segmentDir, incomingTargetDir) - 1) > 0.001) {
    return null;
  }
  return [fixedAnchor, targetPort];
}

function buildLCandidates(
  fixedAnchor: Point2D,
  anchorDir: Point2D,
  targetPort: Point2D,
  incomingTargetDir: Point2D,
  minSegmentMm: number,
): Point2D[][] {
  const candidates: Point2D[][] = [];
  const bends: Point2D[] = [
    { x: targetPort.x, y: fixedAnchor.y },
    { x: fixedAnchor.x, y: targetPort.y },
  ];

  for (const bend of bends) {
    if (distance(fixedAnchor, bend) <= EPSILON || distance(bend, targetPort) <= EPSILON) {
      continue;
    }
    if (projectionInDirection(fixedAnchor, bend, anchorDir) + EPSILON < minSegmentMm) {
      continue;
    }
    if (projectionInDirection(bend, targetPort, incomingTargetDir) + EPSILON < minSegmentMm) {
      continue;
    }
    candidates.push([fixedAnchor, bend, targetPort]);
  }
  return candidates;
}

function uniqueNumbers(values: number[]): number[] {
  const out: number[] = [];
  for (const value of values) {
    if (out.every((existing) => Math.abs(existing - value) > EPSILON)) {
      out.push(value);
    }
  }
  return out;
}

function buildZCandidates(
  fixedAnchor: Point2D,
  anchorDir: Point2D,
  targetPort: Point2D,
  incomingTargetDir: Point2D,
  minSegmentMm: number,
): Point2D[][] {
  if (Math.abs(dot(anchorDir, incomingTargetDir)) < 0.999) {
    return [];
  }

  const candidates: Point2D[][] = [];
  const extension = Math.max(minSegmentMm * 2, 80);
  const oppositeExtension = Math.max(minSegmentMm * 3, 120);

  if (Math.abs(anchorDir.x) > 0.5) {
    const startSign = anchorDir.x >= 0 ? 1 : -1;
    const endSign = incomingTargetDir.x >= 0 ? 1 : -1;
    const splits = uniqueNumbers([
      (fixedAnchor.x + targetPort.x) / 2,
      fixedAnchor.x + startSign * extension,
      targetPort.x - endSign * extension,
      startSign > 0
        ? Math.max(fixedAnchor.x, targetPort.x) + oppositeExtension
        : Math.min(fixedAnchor.x, targetPort.x) - oppositeExtension,
    ]);
    for (const splitX of splits) {
      const bend1 = { x: splitX, y: fixedAnchor.y };
      const bend2 = { x: splitX, y: targetPort.y };
      if (projectionInDirection(fixedAnchor, bend1, anchorDir) + EPSILON < minSegmentMm) {
        continue;
      }
      if (projectionInDirection(bend2, targetPort, incomingTargetDir) + EPSILON < minSegmentMm) {
        continue;
      }
      if (distance(bend1, bend2) + EPSILON < minSegmentMm) {
        continue;
      }
      candidates.push([fixedAnchor, bend1, bend2, targetPort]);
    }
    return candidates;
  }

  const startSign = anchorDir.y >= 0 ? 1 : -1;
  const endSign = incomingTargetDir.y >= 0 ? 1 : -1;
  const splits = uniqueNumbers([
    (fixedAnchor.y + targetPort.y) / 2,
    fixedAnchor.y + startSign * extension,
    targetPort.y - endSign * extension,
    startSign > 0
      ? Math.max(fixedAnchor.y, targetPort.y) + oppositeExtension
      : Math.min(fixedAnchor.y, targetPort.y) - oppositeExtension,
  ]);
  for (const splitY of splits) {
    const bend1 = { x: fixedAnchor.x, y: splitY };
    const bend2 = { x: targetPort.x, y: splitY };
    if (projectionInDirection(fixedAnchor, bend1, anchorDir) + EPSILON < minSegmentMm) {
      continue;
    }
    if (projectionInDirection(bend2, targetPort, incomingTargetDir) + EPSILON < minSegmentMm) {
      continue;
    }
    if (distance(bend1, bend2) + EPSILON < minSegmentMm) {
      continue;
    }
    candidates.push([fixedAnchor, bend1, bend2, targetPort]);
  }
  return candidates;
}

function buildUCandidates(
  fixedAnchor: Point2D,
  anchorDir: Point2D,
  targetPort: Point2D,
  incomingTargetDir: Point2D,
  minSegmentMm: number,
): Point2D[][] {
  if (Math.abs(dot(anchorDir, incomingTargetDir)) > 0.001) {
    return [];
  }

  const candidates: Point2D[][] = [];
  const stubDistances = uniqueNumbers([
    minSegmentMm * 2,
    minSegmentMm * 3,
    150,
    250,
  ]);
  const offsetDistances = uniqueNumbers([
    minSegmentMm * 2,
    minSegmentMm * 4,
    150,
    250,
  ]);
  const perpendicularOptions: Point2D[] = [
    { x: -anchorDir.y, y: anchorDir.x },
    { x: anchorDir.y, y: -anchorDir.x },
  ];

  for (const stub of stubDistances) {
    const bend1 = add(fixedAnchor, scale(anchorDir, stub));
    for (const perpendicularDir of perpendicularOptions) {
      for (const offset of offsetDistances) {
        const bend2 = add(bend1, scale(perpendicularDir, offset));
        let bend3: Point2D | null = null;
        if (Math.abs(anchorDir.x) > 0.5 && Math.abs(incomingTargetDir.y) > 0.5) {
          bend3 = { x: targetPort.x, y: bend2.y };
        } else if (Math.abs(anchorDir.y) > 0.5 && Math.abs(incomingTargetDir.x) > 0.5) {
          bend3 = { x: bend2.x, y: targetPort.y };
        }
        if (!bend3) {
          continue;
        }
        if (projectionInDirection(fixedAnchor, bend1, anchorDir) + EPSILON < minSegmentMm) {
          continue;
        }
        if (distance(bend1, bend2) + EPSILON < minSegmentMm) {
          continue;
        }
        if (projectionInDirection(bend2, bend3, anchorDir) + EPSILON < minSegmentMm) {
          continue;
        }
        if (projectionInDirection(bend3, targetPort, incomingTargetDir) + EPSILON < minSegmentMm) {
          continue;
        }
        candidates.push([fixedAnchor, bend1, bend2, bend3, targetPort]);
      }
    }
  }
  return candidates;
}

function collectBaseCandidates(
  fixedAnchor: Point2D,
  anchorDir: Point2D,
  targetPort: Point2D,
  incomingTargetDir: Point2D,
  minSegmentMm: number,
): Point2D[][] {
  const candidates: Point2D[][] = [];
  const direct = buildDirectCandidate(
    fixedAnchor,
    anchorDir,
    targetPort,
    incomingTargetDir,
    minSegmentMm,
  );
  if (direct) {
    candidates.push(direct);
  }
  candidates.push(
    ...buildLCandidates(fixedAnchor, anchorDir, targetPort, incomingTargetDir, minSegmentMm),
  );
  candidates.push(
    ...buildZCandidates(fixedAnchor, anchorDir, targetPort, incomingTargetDir, minSegmentMm),
  );
  candidates.push(
    ...buildUCandidates(fixedAnchor, anchorDir, targetPort, incomingTargetDir, minSegmentMm),
  );
  return candidates;
}

function findReusablePrefix(
  existingRoute: Point2D[],
  fixedEnd: 'start' | 'end',
  targetPort: Point2D,
): Point2D[] | null {
  const ordered = fixedEnd === 'start'
    ? dedupePoints(existingRoute)
    : dedupePoints([...existingRoute].reverse());
  if (ordered.length < 2) {
    return null;
  }

  const reused: Point2D[] = [ordered[0]!];
  let previousDistance = distance(ordered[0]!, targetPort);
  for (let index = 1; index < ordered.length - 1; index++) {
    const candidate = ordered[index]!;
    const currentDistance = distance(candidate, targetPort);
    if (currentDistance > previousDistance + BASE_MIN_SEGMENT_MM * 0.25) {
      break;
    }
    reused.push(candidate);
    previousDistance = currentDistance;
  }

  return reused.length >= 2 ? reused : null;
}

function fallbackRoute(
  fixedAnchor: Point2D,
  anchorDir: Point2D,
  targetPort: Point2D,
): Point2D[] {
  if (Math.abs(anchorDir.x) > 0.5) {
    return [
      fixedAnchor,
      { x: targetPort.x, y: fixedAnchor.y },
      targetPort,
    ];
  }
  return [
    fixedAnchor,
    { x: fixedAnchor.x, y: targetPort.y },
    targetPort,
  ];
}

function routeHasSelfIntersection(points: Point2D[]): boolean {
  const segments = toSegments(points);
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      if (Math.abs(i - j) <= 1) {
        continue;
      }
      const a = segments[i]!;
      const b = segments[j]!;
      const sharesEndpoint =
        pointsEqual(a.start, b.start)
        || pointsEqual(a.start, b.end)
        || pointsEqual(a.end, b.start)
        || pointsEqual(a.end, b.end);
      if (sharesEndpoint && (j === i + 1 || (i === 0 && j === segments.length - 1))) {
        continue;
      }
      if (segmentsIntersectGeneral(a, b)) {
        return true;
      }
    }
  }
  return false;
}

function pruneTinyLeadSegments(
  routePoints: Point2D[],
  fixedEnd: 'start' | 'end',
  pivotPoint: Point2D | null,
  minLeadSegmentMm: number,
): Point2D[] {
  if (routePoints.length < 3 || !pivotPoint) {
    return dedupePoints(routePoints);
  }

  const ordered = fixedEnd === 'end'
    ? dedupePoints(routePoints)
    : dedupePoints([...routePoints].reverse());
  const pivotIndex = ordered.findIndex((point) => pointsEqual(point, pivotPoint));
  if (pivotIndex <= 1) {
    return routePoints;
  }

  const cleaned: Point2D[] = [ordered[0]!];
  for (let index = 1; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    const previous = cleaned[cleaned.length - 1]!;
    const isPivot = index === pivotIndex;
    const isTail = index >= pivotIndex;
    if (
      !isPivot
      && !isTail
      && distance(previous, current) < minLeadSegmentMm
      && index < ordered.length - 1
    ) {
      continue;
    }
    cleaned.push(current);
  }

  const resolved = dedupePoints(cleaned);
  return fixedEnd === 'end'
    ? resolved
    : dedupePoints([...resolved].reverse());
}

function rerouteBundleByMovingLeadSegment(
  existingRoutePoints: Point2D[],
  movedPoint: Point2D,
  movedDirection: Point2D,
  fixedEnd: 'start' | 'end',
  lockedPivotPoint?: Point2D | null,
  constraints?: PipeRouteConstraints,
): LeadSegmentRerouteResult | null {
  const strengthenedConstraints: PipeRouteConstraints = {
    ...constraints,
    // Keep enough lead length to avoid tiny 2D kinks at the unit port.
    minBendRadiusMm: Math.max(constraints?.minBendRadiusMm ?? 0, 22),
  };
  const rerouted = rerouteByMovingLeadSegment(
    existingRoutePoints,
    movedPoint,
    movedDirection,
    fixedEnd,
    lockedPivotPoint,
    strengthenedConstraints,
  );
  if (!rerouted || rerouted.routePoints.length < 2) {
    return null;
  }
  const minLeadSegmentMm = Math.max(
    8,
    (strengthenedConstraints.minBendRadiusMm ?? 0) * 0.35,
  );
  const routePoints = pruneTinyLeadSegments(
    rerouted.routePoints,
    fixedEnd,
    rerouted.pivotPoint,
    minLeadSegmentMm,
  );
  return {
    routePoints,
    pivotPoint: rerouted.pivotPoint,
  };
}

function rerouteByMovingLeadSegment(
  existingRoutePoints: Point2D[],
  movedPoint: Point2D,
  movedDirection: Point2D,
  fixedEnd: 'start' | 'end',
  lockedPivotPoint?: Point2D | null,
  constraints?: PipeRouteConstraints,
): LeadSegmentRerouteResult | null {
  const route = dedupePoints(existingRoutePoints);
  if (route.length < 2) {
    return null;
  }
  const estimateLeadTakeoffDistance = (ordered: Point2D[]): number => {
    if (ordered.length < 2) {
      return 54;
    }
    const firstSegmentLength = distance(ordered[0]!, ordered[1]!);
    if (!Number.isFinite(firstSegmentLength) || firstSegmentLength < 8) {
      return 54;
    }
    return Math.max(24, Math.min(96, firstSegmentLength));
  };

  const findLeadPivotIndex = (ordered: Point2D[]): number => {
    if (ordered.length < 3) {
      return ordered.length - 1;
    }
    const cumulativeDistance: number[] = [0];
    for (let index = 1; index < ordered.length; index += 1) {
      cumulativeDistance.push(
        (cumulativeDistance[index - 1] ?? 0) + distance(ordered[index - 1]!, ordered[index]!),
      );
    }
    const leadTakeoffDistance = estimateLeadTakeoffDistance(ordered);
    const minPivotDistanceMm = Math.max(leadTakeoffDistance * 1.75, 72);
    const minDownstreamLengthMm = Math.max(leadTakeoffDistance, 48);
    let fallbackBendIndex: number | null = null;

    for (let index = 1; index < ordered.length - 1; index += 1) {
      const incomingLength = distance(ordered[index - 1]!, ordered[index]!);
      const outgoingLength = distance(ordered[index]!, ordered[index + 1]!);
      if (incomingLength <= 2 || outgoingLength <= 2) {
        continue;
      }
      const prevDir = snapToAxis(segmentDirection(ordered[index - 1]!, ordered[index]!));
      const nextDir = snapToAxis(segmentDirection(ordered[index]!, ordered[index + 1]!));
      if (Math.abs(dot(prevDir, nextDir)) >= 0.999) {
        continue;
      }
      if (fallbackBendIndex === null) {
        fallbackBendIndex = index;
      }
      const leadingDistance = cumulativeDistance[index] ?? 0;
      const downstreamLength =
        (cumulativeDistance[cumulativeDistance.length - 1] ?? 0) - leadingDistance;
      if (
        leadingDistance >= minPivotDistanceMm
        && downstreamLength >= minDownstreamLengthMm
      ) {
        return index;
      }
    }

    if (fallbackBendIndex !== null) {
      return fallbackBendIndex;
    }
    return Math.min(1, ordered.length - 1);
  };

  const findLockedPivotIndex = (ordered: Point2D[]): number | null => {
    if (!lockedPivotPoint) {
      return null;
    }
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 1; index < ordered.length - 1; index += 1) {
      const candidateDistance = distance(ordered[index]!, lockedPivotPoint);
      if (candidateDistance < bestDistance) {
        bestDistance = candidateDistance;
        bestIndex = index;
      }
    }
    return bestIndex >= 1 && bestIndex < ordered.length - 1 && bestDistance <= 4
      ? bestIndex
      : null;
  };

  const buildOrthogonalBendPoint = (
    takeoffPoint: Point2D,
    pivotPoint: Point2D,
    preferredIncomingDirection: Point2D,
  ): Point2D | null => {
    const preferredAxis = snapToAxis(preferredIncomingDirection);
    if (Math.abs(preferredAxis.x) > 0.5) {
      const bend = { x: takeoffPoint.x, y: pivotPoint.y };
      return distance(bend, pivotPoint) > EPSILON && distance(bend, takeoffPoint) > EPSILON
        ? bend
        : null;
    }
    const bend = { x: pivotPoint.x, y: takeoffPoint.y };
    return distance(bend, pivotPoint) > EPSILON && distance(bend, takeoffPoint) > EPSILON
      ? bend
      : null;
  };

  const leadCandidateScore = (
    candidate: Point2D[],
    pivotPoint: Point2D,
    preferredIncomingDirection: Point2D,
  ): number => {
    const route = dedupePoints(candidate);
    if (route.length < 2 || routeHasSelfIntersection(route)) {
      return Number.POSITIVE_INFINITY;
    }

    const minSegmentMm = Math.max(4, (constraints?.minBendRadiusMm ?? 0) * 0.35);
    for (let index = 1; index < route.length; index += 1) {
      if (distance(route[index - 1]!, route[index]!) < minSegmentMm) {
        return Number.POSITIVE_INFINITY;
      }
    }

    const pivotIndex = route.findIndex((point) => pointsEqual(point, pivotPoint));
    let approachPenalty = 0;
    if (pivotIndex > 0) {
      const approachDir = snapToAxis(segmentDirection(route[pivotIndex - 1]!, pivotPoint));
      const preferredDir = snapToAxis(preferredIncomingDirection);
      if (Math.abs(dot(approachDir, preferredDir)) < 0.999) {
        approachPenalty += (constraints?.equivalentLengthPerFittingMm ?? DEFAULT_EQUIVALENT_LENGTH_PER_FITTING_MM) * 2;
      }
    }

    return routeLength(route)
      + countFittings(route) * (constraints?.equivalentLengthPerFittingMm ?? DEFAULT_EQUIVALENT_LENGTH_PER_FITTING_MM)
      + approachPenalty;
  };

  const rerouteOrdered = (ordered: Point2D[]): LeadSegmentRerouteResult => {
    const pivotIndex = findLockedPivotIndex(ordered) ?? findLeadPivotIndex(ordered);
    const pivotPoint = ordered[pivotIndex]!;
    const fixedTail = ordered.slice(pivotIndex + 1);
    const previousPivotPoint = ordered[Math.max(0, pivotIndex - 1)] ?? movedPoint;
    const preferredIncomingDirection = segmentDirection(previousPivotPoint, pivotPoint);
    const safeMoveDirection =
      length(movedDirection) > EPSILON
        ? normalize(movedDirection)
        : normalize(subtract(pivotPoint, movedPoint));
    const takeoffDistance = Math.min(
      estimateLeadTakeoffDistance(ordered),
      Math.max(16, distance(movedPoint, pivotPoint) - 8),
    );
    const takeoffPoint = add(movedPoint, scale(safeMoveDirection, takeoffDistance));
    const orthogonalBendPoint = buildOrthogonalBendPoint(
      takeoffPoint,
      pivotPoint,
      preferredIncomingDirection,
    );

    const candidates: Point2D[][] = [
      dedupePoints([movedPoint, takeoffPoint, pivotPoint, ...fixedTail]),
    ];
    if (orthogonalBendPoint) {
      candidates.push(
        dedupePoints([movedPoint, takeoffPoint, orthogonalBendPoint, pivotPoint, ...fixedTail]),
      );
    }

    const best = candidates.reduce<{
      score: number;
      route: Point2D[] | null;
    }>((acc, candidate) => {
      const score = leadCandidateScore(candidate, pivotPoint, preferredIncomingDirection);
      if (score < acc.score) {
        return { score, route: candidate };
      }
      return acc;
    }, {
      score: Number.POSITIVE_INFINITY,
      route: null,
    });

    return {
      routePoints:
        best.route ?? dedupePoints([movedPoint, takeoffPoint, pivotPoint, ...fixedTail]),
      pivotPoint,
    };
  };

  if (fixedEnd === 'end') {
    // Route order is already moving(start) -> fixed(end).
    return rerouteOrdered(route);
  }
  // fixedEnd === 'start': reverse so ordered path is moving(end) -> fixed(start).
  const reversed = rerouteOrdered([...route].reverse());
  return {
    routePoints: dedupePoints([...reversed.routePoints].reverse()),
    pivotPoint: reversed.pivotPoint,
  };
}

export function computeOptimalPipeRoute(input: PipeRerouteInput): PipeRerouteResult {
  const {
    fixedAnchor,
    fixedDirection,
    targetPort,
    targetDirection,
    existingRoutePoints = [],
    fixedEnd,
    constraints,
  } = input;

  const anchorDir = snapToAxis(fixedDirection);
  const incomingTargetDir = negate(snapToAxis(targetDirection));
  const minSegmentMm = Math.max(BASE_MIN_SEGMENT_MM, constraints?.minBendRadiusMm ?? 0);
  const equivalentLengthPerFittingMm =
    constraints?.equivalentLengthPerFittingMm
    ?? DEFAULT_EQUIVALENT_LENGTH_PER_FITTING_MM;
  const avoidanceZones = constraints?.avoidanceZones ?? [];

  if (distance(fixedAnchor, targetPort) < minSegmentMm) {
    return {
      routePoints: [fixedAnchor, targetPort],
      totalLengthMm: distance(fixedAnchor, targetPort),
      fittingCount: 0,
      elbowCount: 0,
    };
  }

  const candidateScores: PipeRouteCandidate[] = [];
  const pushCandidate = (candidatePoints: Point2D[]) => {
    const scored = scoreRoute(candidatePoints, equivalentLengthPerFittingMm);
    if (!isRouteValid(scored.routePoints, minSegmentMm, avoidanceZones)) {
      return;
    }
    candidateScores.push(scored);
  };

  const baseCandidates = collectBaseCandidates(
    fixedAnchor,
    anchorDir,
    targetPort,
    incomingTargetDir,
    minSegmentMm,
  );
  for (const candidate of baseCandidates) {
    pushCandidate(candidate);
  }

  if (existingRoutePoints.length >= 2 && fixedEnd) {
    const reusedPrefix = findReusablePrefix(existingRoutePoints, fixedEnd, targetPort);
    if (reusedPrefix && reusedPrefix.length >= 2) {
      const continueFrom = reusedPrefix[reusedPrefix.length - 1]!;
      const previousPoint = reusedPrefix[reusedPrefix.length - 2]!;
      const subAnchorDir = snapToAxis(segmentDirection(previousPoint, continueFrom));
      const subCandidates = collectBaseCandidates(
        continueFrom,
        subAnchorDir,
        targetPort,
        incomingTargetDir,
        minSegmentMm,
      );
      for (const subCandidate of subCandidates) {
        const combined = dedupePoints([
          ...reusedPrefix,
          ...subCandidate.slice(1),
        ]);
        pushCandidate(combined);
      }
    }
  }

  if (candidateScores.length === 0) {
    const fallback = dedupePoints(fallbackRoute(fixedAnchor, anchorDir, targetPort));
    if (isRouteValid(fallback, Math.max(1, minSegmentMm * 0.5), [])) {
      const scoredFallback = scoreRoute(fallback, equivalentLengthPerFittingMm);
      return {
        routePoints: scoredFallback.routePoints,
        totalLengthMm: scoredFallback.totalLengthMm,
        fittingCount: scoredFallback.fittingCount,
        elbowCount: scoredFallback.fittingCount,
      };
    }
    const direct = scoreRoute([fixedAnchor, targetPort], equivalentLengthPerFittingMm);
    return {
      routePoints: direct.routePoints,
      totalLengthMm: direct.totalLengthMm,
      fittingCount: direct.fittingCount,
      elbowCount: direct.fittingCount,
    };
  }

  candidateScores.sort((a, b) => a.score - b.score);
  const best = candidateScores[0]!;
  return {
    routePoints: best.routePoints,
    totalLengthMm: best.totalLengthMm,
    fittingCount: best.fittingCount,
    elbowCount: best.fittingCount,
  };
}

export function reroutePipeBundleCenterline(params: {
  fixedBundlePoint: Point2D;
  fixedDirection: Point2D;
  movedBundlePoint: Point2D;
  movedDirection: Point2D;
  existingRoutePoints: Point2D[];
  fixedEnd: 'start' | 'end';
  lockedPivotPoint?: Point2D | null;
  constraints?: PipeRouteConstraints;
}): LeadSegmentRerouteResult {
  const leadOnlyRoute = rerouteBundleByMovingLeadSegment(
    params.existingRoutePoints,
    params.movedBundlePoint,
    params.movedDirection,
    params.fixedEnd,
    params.lockedPivotPoint,
    params.constraints,
  );
  if (leadOnlyRoute && leadOnlyRoute.routePoints.length >= 2) {
    return leadOnlyRoute;
  }

  const routePoints = computeOptimalPipeRoute({
    fixedAnchor: params.fixedBundlePoint,
    fixedDirection: params.fixedDirection,
    targetPort: params.movedBundlePoint,
    targetDirection: params.movedDirection,
    existingRoutePoints: params.existingRoutePoints,
    fixedEnd: params.fixedEnd,
    constraints: params.constraints,
  }).routePoints;
  return {
    routePoints: params.fixedEnd === 'start'
      ? routePoints
      : [...routePoints].reverse(),
    pivotPoint: params.lockedPivotPoint ?? null,
  };
}

export function reroutePipeCenterline(params: {
  fixedPoint: Point2D;
  fixedDirection: Point2D;
  movedPoint: Point2D;
  movedDirection: Point2D;
  existingRoutePoints: Point2D[];
  fixedEnd: 'start' | 'end';
  lockedPivotPoint?: Point2D | null;
  constraints?: PipeRouteConstraints;
}): LeadSegmentRerouteResult {
  const leadOnlyRoute = rerouteByMovingLeadSegment(
    params.existingRoutePoints,
    params.movedPoint,
    params.movedDirection,
    params.fixedEnd,
    params.lockedPivotPoint,
    params.constraints,
  );
  if (leadOnlyRoute && leadOnlyRoute.routePoints.length >= 2) {
    return leadOnlyRoute;
  }

  const routePoints = computeOptimalPipeRoute({
    fixedAnchor: params.fixedPoint,
    fixedDirection: params.fixedDirection,
    targetPort: params.movedPoint,
    targetDirection: params.movedDirection,
    existingRoutePoints: params.existingRoutePoints,
    fixedEnd: params.fixedEnd,
    constraints: params.constraints,
  }).routePoints;
  return {
    routePoints: params.fixedEnd === 'start'
      ? routePoints
      : [...routePoints].reverse(),
    pivotPoint: params.lockedPivotPoint ?? null,
  };
}
