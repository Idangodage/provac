import type { HvacElement, Point2D } from '../../../types';

import { resolveCopperSocketElbow, resolveCopperSocketElbowMinimumRadius, usesCopperSocketElbows } from './copperSocketElbows';
import { findRiserCornerPlanMatches, restoreRiserCornerPlanProjection } from './pipeRiserCornerProjection';
import { getActivePipeRoutingSettings } from './pipeRoutingSettings';
import { planTerminalCornerRisers } from './pipeTerminalRiser';
import { bendRadiusFromDiameterMm } from './pipeTopology';

export interface PipeRouteNode3D extends Point2D {
  z: number;
}

export interface PipePlacementPoint extends Point2D {
  /** Absolute model-space centreline elevation in millimetres. */
  z?: number;
  /** Internal authoritative snap payload resolved in screen space by 3D input. */
  snapTarget?: unknown;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizePlanRoute(value: unknown): Point2D[] {
  if (!Array.isArray(value)) return [];
  const points: Point2D[] = [];
  const count = value.length;
  for (let index = 0; index < count; index += 1) {
    if (!(index in value)) continue;
    const candidate = value[index];
    if (!candidate || typeof candidate !== 'object') continue;
    const point = candidate as { x?: unknown; y?: unknown };
    if (finiteNumber(point.x) && finiteNumber(point.y)) points.push({ x: point.x, y: point.y });
  }
  return points;
}

export function normalizePipeRouteNodes3d(value: unknown): PipeRouteNode3D[] {
  if (!Array.isArray(value)) return [];
  const nodes: PipeRouteNode3D[] = [];
  const count = value.length;
  for (let index = 0; index < count; index += 1) {
    if (!(index in value)) continue;
    const candidate = value[index];
    if (!candidate || typeof candidate !== 'object') continue;
    const point = candidate as { x?: unknown; y?: unknown; z?: unknown };
    if (finiteNumber(point.x) && finiteNumber(point.y) && finiteNumber(point.z)) nodes.push({ x: point.x, y: point.y, z: point.z });
  }
  return nodes;
}

export function readPipeRouteNodes3d(
  element: Pick<HvacElement, 'properties'>,
): PipeRouteNode3D[] {
  return normalizePipeRouteNodes3d(element.properties.routeNodes3d);
}

export function hasExplicitPipeRoute3d(points: readonly PipePlacementPoint[]): boolean {
  return points.length >= 2 && points.every((point) => finiteNumber(point.z));
}

interface PathMetrics {
  cumulative: number[];
  total: number;
  projectionSpans?: Array<{
    x: number; y: number; dx: number; dy: number;
    lengthSquared: number; length: number;
  }>;
  projectionBlocks?: Array<{
    end: number; finite: boolean; minX: number; minY: number; maxX: number; maxY: number;
  }>;
}

function pathMetrics(points: readonly Point2D[]): PathMetrics {
  const cumulative = [0];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    total += Math.hypot(point.x - previous.x, point.y - previous.y);
    cumulative.push(total);
  }
  return { cumulative, total };
}

function vertexStations(points: readonly Point2D[], metrics: PathMetrics): number[] {
  if (points.length <= 1) return points.length === 0 ? [] : [0];
  if (metrics.total <= 1e-9) {
    // A vertical riser's plan projection is degenerate. Keep every node at the
    // same route station so equal-XY/different-Z nodes remain a vertical stack.
    return points.map(() => 0);
  }
  return metrics.cumulative.map((distance) => distance / metrics.total);
}

function closestStationOnPath(
  point: Point2D,
  path: readonly Point2D[],
  metrics: PathMetrics,
  fallbackStation: number,
): number {
  if (path.length <= 1 || metrics.total <= 1e-9) {
    return Math.max(0, Math.min(1, fallbackStation));
  }
  let bestDistanceSquared = Number.POSITIVE_INFINITY;
  let bestStation = 0;
  // One projection pass is needed for every guide node. The path is unchanged
  // within this operation, so retain its scalar spans without changing scan
  // order or the distinct sqrt/hypot arithmetic used for route stations.
  const spans = metrics.projectionSpans ??= path.slice(1).map((end, index) => {
    const start = path[index]!;
    const dx = end.x - start.x; const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    return { x: start.x, y: start.y, dx, dy, lengthSquared, length: Math.sqrt(lengthSquared) };
  });
  const blocks = spans.length <= 16 ? null : metrics.projectionBlocks ??= (() => {
    const result: NonNullable<PathMetrics['projectionBlocks']> = [];
    for (let index = 0; index < spans.length; index += 16) {
      const end = Math.min(index + 16, spans.length);
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity; let finite = true;
      for (let spanIndex = index; spanIndex < end; spanIndex += 1) {
        const span = spans[spanIndex]!;
        // Bound the numeric projection formula, whose computed endpoint can
        // differ from the input endpoint after floating-point subtraction.
        const endX = span.x + span.dx; const endY = span.y + span.dy;
        finite = finite && Number.isFinite(span.x) && Number.isFinite(span.y)
          && Number.isFinite(endX) && Number.isFinite(endY) && Number.isFinite(span.lengthSquared);
        minX = Math.min(minX, span.x, endX); minY = Math.min(minY, span.y, endY);
        maxX = Math.max(maxX, span.x, endX); maxY = Math.max(maxY, span.y, endY);
      }
      result.push({ end, finite, minX, minY, maxX, maxY });
    }
    return result;
  })();
  const finitePoint = Number.isFinite(point.x) && Number.isFinite(point.y);
  let blockIndex = 0;
  for (let index = 0; index < spans.length;) {
    const block = blocks?.[blockIndex++];
    const end = block?.end ?? spans.length;
    if (finitePoint && block?.finite && Number.isFinite(bestDistanceSquared)) {
      const boundX = point.x < block.minX ? point.x - block.minX : point.x > block.maxX ? point.x - block.maxX : 0;
      const boundY = point.y < block.minY ? point.y - block.minY : point.y > block.maxY ? point.y - block.maxY : 0;
      const lowerDistanceSquared = boundX ** 2 + boundY ** 2;
      // Retain all possible ties and the original span order. Nonfinite bounds
      // fall through to the original projection arithmetic.
      if (Number.isFinite(lowerDistanceSquared) && lowerDistanceSquared - bestDistanceSquared > 1e-9) {
        index = end;
        continue;
      }
    }
    for (; index < end; index += 1) {
      const { x, y, dx, dy, lengthSquared, length } = spans[index]!;
      const t = lengthSquared <= 1e-12
        ? 0
        : Math.max(0, Math.min(1, ((point.x - x) * dx + (point.y - y) * dy) / lengthSquared));
      const projectedX = x + dx * t;
      const projectedY = y + dy * t;
      const distanceSquared = (point.x - projectedX) ** 2 + (point.y - projectedY) ** 2;
      const station = (metrics.cumulative[index]! + length * t) / metrics.total;
      if (
        distanceSquared < bestDistanceSquared - 1e-9
        || (Math.abs(distanceSquared - bestDistanceSquared) <= 1e-9 && station < bestStation)
      ) {
        bestDistanceSquared = distanceSquared;
        bestStation = station;
      }
    }
  }
  return bestStation;
}

function pointAtStation(
  path: readonly Point2D[],
  metrics: PathMetrics,
  station: number,
): Point2D {
  if (path.length === 0) return { x: 0, y: 0 };
  if (path.length === 1 || metrics.total <= 1e-9) return { ...path[0]! };
  const target = Math.max(0, Math.min(1, station)) * metrics.total;
  let firstIndex = 1;
  if (Number.isFinite(metrics.total) && Number.isFinite(target)) {
    // Find the first segment ending at or beyond the target. Choosing the
    // first equal station preserves zero-length spans and vertex tie breaks.
    let upper = path.length - 1;
    while (firstIndex < upper) {
      const middle = Math.floor((firstIndex + upper) / 2);
      if (target > metrics.cumulative[middle]!) firstIndex = middle + 1;
      else upper = middle;
    }
  }
  for (let index = firstIndex; index < path.length; index += 1) {
    const segmentStart = metrics.cumulative[index - 1]!;
    const segmentEnd = metrics.cumulative[index]!;
    if (target > segmentEnd && index < path.length - 1) continue;
    const start = path[index - 1]!;
    const end = path[index]!;
    const length = segmentEnd - segmentStart;
    const t = length <= 1e-9 ? 0 : Math.max(0, Math.min(1, (target - segmentStart) / length));
    return {
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
    };
  }
  return { ...path[path.length - 1]! };
}

function zAtStation(
  stationedNodes: ReadonlyArray<{ station: number; node: PipeRouteNode3D }>,
  station: number,
  finiteStations = false,
): number {
  if (stationedNodes.length === 0) return 0;
  const first = stationedNodes[0]!;
  const last = stationedNodes[stationedNodes.length - 1]!;
  if (station <= first.station) return first.node.z;
  if (station >= last.station) return last.node.z;
  if (finiteStations && Number.isFinite(station)) {
    let lower = 1; let upper = stationedNodes.length - 1;
    // Vertical risers share a station. Use the last equal node on the left,
    // exactly as the linear scan, and the first strictly greater on the right.
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (stationedNodes[middle]!.station <= station) lower = middle + 1;
      else upper = middle;
    }
    const left = stationedNodes[lower - 1]!; const right = stationedNodes[lower]!;
    const span = right.station - left.station;
    if (span <= 1e-9) return right.node.z;
    const t = (station - left.station) / span;
    return left.node.z + (right.node.z - left.node.z) * t;
  }
  let left = first;
  for (let index = 1; index < stationedNodes.length; index += 1) {
    const right = stationedNodes[index]!;
    if (right.station <= station) {
      left = right;
      continue;
    }
    const span = right.station - left.station;
    if (span <= 1e-9) return right.node.z;
    const t = (station - left.station) / span;
    return left.node.z + (right.node.z - left.node.z) * t;
  }
  return last.node.z;
}

function hasNearbyStation(
  stationedNodes: ReadonlyArray<{ station: number }>, station: number, finiteStations: boolean,
): boolean {
  if (!finiteStations || !Number.isFinite(station)) {
    return stationedNodes.some(entry => Math.abs(entry.station - station) <= 1e-8);
  }
  let lower = 0; let upper = stationedNodes.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (stationedNodes[middle]!.station < station) lower = middle + 1;
    else upper = middle;
  }
  // Check the same absolute-difference predicate at the two nearest stations;
  // subtracting tolerance before the search would alter boundary rounding.
  return (lower < stationedNodes.length && Math.abs(stationedNodes[lower]!.station - station) <= 1e-8)
    || (lower > 0 && Math.abs(stationedNodes[lower - 1]!.station - station) <= 1e-8);
}

/**
 * Reprojects an authored 3D route onto an edited plan route without flattening
 * its Z profile. Equal-XY/different-Z nodes are retained, so vertical risers do
 * not disappear. When the plan topology is unchanged, node/vertex identity is
 * used directly; insert/delete edits fall back to deterministic route stations.
 */
export function projectPipeRouteNodes3dForPlanEdit(
  previousPlanRoute: readonly Point2D[],
  nextPlanRoute: readonly Point2D[],
  previousNodes: readonly PipeRouteNode3D[],
): PipeRouteNode3D[] {
  if (previousNodes.length === 0 || nextPlanRoute.length === 0) return [];

  if (
    previousNodes.length === previousPlanRoute.length
    && previousPlanRoute.length === nextPlanRoute.length
  ) {
    return previousNodes.map((node, index) => ({
      ...nextPlanRoute[index]!,
      z: node.z,
    }));
  }

  const previousMetrics = pathMetrics(previousPlanRoute);
  const nextMetrics = pathMetrics(nextPlanRoute);
  const nextVertexStations = vertexStations(nextPlanRoute, nextMetrics);
  let minimumStation = 0;
  const stationedNodes = previousNodes.map((node, index) => {
    const fallback = previousNodes.length <= 1 ? 0 : index / (previousNodes.length - 1);
    const station = Math.max(
      minimumStation,
      closestStationOnPath(node, previousPlanRoute, previousMetrics, fallback),
    );
    minimumStation = station;
    return { station, node: { ...node }, order: index };
  });
  const finiteStations = stationedNodes.every((entry, index) => Number.isFinite(entry.station)
    && (index === 0 || entry.station >= stationedNodes[index - 1]!.station));

  const projected = stationedNodes.map(({ station, node, order }) => ({
    station,
    order,
    source: 0,
    node: { ...pointAtStation(nextPlanRoute, nextMetrics, station), z: node.z },
  }));

  nextPlanRoute.forEach((point, index) => {
    const station = nextVertexStations[index] ?? 0;
    if (hasNearbyStation(stationedNodes, station, finiteStations)) {
      return;
    }
    projected.push({
      station,
      order: index,
      source: 1,
      node: { ...point, z: zAtStation(stationedNodes, station, finiteStations) },
    });
  });

  projected.sort((left, right) => (
    left.station - right.station
    || left.source - right.source
    || left.order - right.order
  ));
  return projected.reduce<PipeRouteNode3D[]>((result, entry) => {
    const previous = result[result.length - 1];
    if (
      previous
      && Math.abs(previous.x - entry.node.x) <= 1e-8
      && Math.abs(previous.y - entry.node.y) <= 1e-8
      && Math.abs(previous.z - entry.node.z) <= 1e-8
    ) {
      return result;
    }
    result.push(entry.node);
    return result;
  }, []);
}

export interface PipeRoute3dIntervalSplit {
  before: PipeRouteNode3D[];
  after: PipeRouteNode3D[];
  firstCutStation: number;
  secondCutStation: number;
  firstCutNode: PipeRouteNode3D;
  secondCutNode: PipeRouteNode3D;
}

/**
 * Partitions an authored 3D route around a fitting interval. Unlike the normal
 * plan-edit projector, nodes inside the replaced fitting body are deliberately
 * removed and the two retained sides never receive a copy of the full route.
 */
export function splitPipeRoute3dAtPlanInterval(
  planRoute: readonly Point2D[],
  routeNodes: readonly PipeRouteNode3D[],
  firstCut: Point2D,
  secondCut: Point2D,
  cutElevations: { first?: number; second?: number } = {},
): PipeRoute3dIntervalSplit | null {
  if (planRoute.length < 2 || routeNodes.length < 2) return null;
  const metrics = pathMetrics(planRoute);
  if (metrics.total <= 1e-9) return null;

  let minimumStation = 0;
  const stationedNodes = routeNodes.map((node, index) => {
    const fallback = routeNodes.length <= 1 ? 0 : index / (routeNodes.length - 1);
    const station = Math.max(
      minimumStation,
      closestStationOnPath(node, planRoute, metrics, fallback),
    );
    minimumStation = station;
    return { station, node: { ...node }, order: index };
  });
  const finiteStations = stationedNodes.every((entry, index) => Number.isFinite(entry.station)
    && (index === 0 || entry.station >= stationedNodes[index - 1]!.station));
  const firstCutStation = closestStationOnPath(firstCut, planRoute, metrics, 0);
  const secondCutStation = closestStationOnPath(secondCut, planRoute, metrics, 1);
  const lowerStation = Math.min(firstCutStation, secondCutStation);
  const upperStation = Math.max(firstCutStation, secondCutStation);
  const firstCutNode: PipeRouteNode3D = {
    ...pointAtStation(planRoute, metrics, firstCutStation),
    z: cutElevations.first ?? zAtStation(stationedNodes, firstCutStation, finiteStations),
  };
  const secondCutNode: PipeRouteNode3D = {
    ...pointAtStation(planRoute, metrics, secondCutStation),
    z: cutElevations.second ?? zAtStation(stationedNodes, secondCutStation, finiteStations),
  };
  const lowerNode = firstCutStation <= secondCutStation ? firstCutNode : secondCutNode;
  const upperNode = firstCutStation <= secondCutStation ? secondCutNode : firstCutNode;
  const dedupe = (nodes: PipeRouteNode3D[]): PipeRouteNode3D[] =>
    nodes.reduce<PipeRouteNode3D[]>((result, node) => {
      const previous = result[result.length - 1];
      if (
        previous
        && Math.abs(previous.x - node.x) <= 1e-8
        && Math.abs(previous.y - node.y) <= 1e-8
        && Math.abs(previous.z - node.z) <= 1e-8
      ) return result;
      result.push(node);
      return result;
    }, []);

  return {
    before: dedupe([
      ...stationedNodes
        .filter((entry) => entry.station < lowerStation - 1e-8)
        .sort((left, right) => left.station - right.station || left.order - right.order)
        .map((entry) => entry.node),
      lowerNode,
    ]),
    after: dedupe([
      upperNode,
      ...stationedNodes
        .filter((entry) => entry.station > upperStation + 1e-8)
        .sort((left, right) => left.station - right.station || left.order - right.order)
        .map((entry) => entry.node),
    ]),
    firstCutStation,
    secondCutStation,
    firstCutNode,
    secondCutNode,
  };
}

/**
 * The only plan-route mutation boundary for persisted pipe geometry. Legacy
 * flat pipes keep using `routePoints`; 3D-authored pipes update both fields so
 * plan and hybrid renderers cannot diverge after a drag or numeric edit.
 */
export function withCanonicalPipeRoute<
  T extends { properties: Record<string, unknown> },
>(
  element: T,
  nextRoute: readonly Point2D[],
  propertyUpdates: Record<string, unknown> = {},
): T {
  const routePoints = normalizePlanRoute(nextRoute);
  const previousPlanRoute = normalizePlanRoute(element.properties.routePoints);
  const previousNodes = normalizePipeRouteNodes3d(element.properties.routeNodes3d);
  const properties: Record<string, unknown> = {
    ...element.properties,
    ...propertyUpdates,
    routePoints,
  };
  if (previousNodes.length >= 2) {
    properties.routeNodes3d = projectPipeRouteNodes3dForPlanEdit(
      previousPlanRoute,
      routePoints,
      previousNodes,
    );
  }
  return { ...element, properties };
}

export interface PipeRoute3dConnectionOptions {
  startConnection?: { elevationMm: number; connectionKind: 'unit-port' | 'field-pipe' } | null;
  endConnection?: { elevationMm: number; connectionKind: 'unit-port' | 'field-pipe' } | null;
  minimumPortStubMm?: number;
  /** Physical sleeve diameter resolves the same elbow policy at save and render time. */
  outerDiameterMm?: number;
  /** Optional explicit centreline radius for a catalog-specific connection elbow. */
  bendRadiusMm?: number;
  /** CxC tube size, when socket elbows are used instead of formed tube. */
  pipeDiameterMm?: number;
  minimumBendRadiusMm?: number;
}

/**
 * Applies authored levels to an already resolved physical pipe lane. Both the
 * plan vertices (elbows, port takeoffs, fitting approaches) and authored risers
 * survive. Projecting only guide vertices cuts across generated bends and
 * disconnects the port adapters in 3D.
 */
export function liftPipePlanRouteTo3d(
  planRoute: readonly Point2D[],
  guide: readonly PipeRouteNode3D[],
  options: PipeRoute3dConnectionOptions = {},
): PipeRouteNode3D[] {
  if (guide.length === 0) return [];
  if (planRoute.length === 0) return guide.map((node) => ({ ...node }));
  const routingSettings = getActivePipeRoutingSettings();
  const minimumStraightMm = Math.max(0, options.minimumPortStubMm ?? routingSettings.minimumPortStubMm);
  const bendRadiusMm = finiteNumber(options.bendRadiusMm)
    ? Math.max(0, options.bendRadiusMm)
    : finiteNumber(options.outerDiameterMm)
      ? bendRadiusFromDiameterMm(options.outerDiameterMm, routingSettings.bendRadiusFactor)
      : 0;
  const elbow = options.pipeDiameterMm ? resolveCopperSocketElbow(options.pipeDiameterMm, 90) : null;
  const fittingExtent = Math.max(bendRadiusMm, routingSettings.minimumFieldBendRadiusMm,
    options.minimumBendRadiusMm ?? 0, elbow?.centerToFaceMm ?? 0);
  const prepared = planTerminalCornerRisers(planRoute, guide, options,
    fittingExtent, minimumStraightMm,
    routingSettings.defaultBranchKitClearanceMm);
  guide = prepared.guide;
  planRoute = restoreRiserCornerPlanProjection(prepared.plan, guide);
  const metrics = pathMetrics(planRoute);
  if (metrics.total <= 1e-9) {
    return guide.map((node, index) => ({
      ...planRoute[0]!,
      z: index === 0 && options.startConnection
        ? options.startConnection.elevationMm
        : index === guide.length - 1 && options.endConnection
          ? options.endConnection.elevationMm
          : node.z,
    }));
  }
  // Offset gas/liquid lanes have different corner XYs. Nearest projection
  // alone can put the rise beside that corner and recreate the third elbow.
  const cornerStations = new Map<number, number>();
  for (const match of findRiserCornerPlanMatches(planRoute, guide)) {
    const station = closestStationOnPath(match.corner, planRoute, metrics, 0);
    for (let index = match.guideStartIndex; index <= match.guideEndIndex; index += 1) cornerStations.set(index, station);
  }
  let previousStation = 0;
  const stationed = guide.map((node, index) => {
    const station = index === 0 ? 0 : index === guide.length - 1 ? 1 : Math.max(
      previousStation,
      cornerStations.get(index) ?? closestStationOnPath(node, planRoute, metrics, index / Math.max(1, guide.length - 1)),
    );
    previousStation = station;
    return { station, node };
  });
  const finiteStations = stationed.every((entry, index) => Number.isFinite(entry.station)
    && (index === 0 || entry.station >= stationed[index - 1]!.station));
  const entries = stationed.map(({ station, node }, index) => ({
    station,
    order: index,
    node: { ...pointAtStation(planRoute, metrics, station), z: node.z },
  }));
  for (let index = 0; index < planRoute.length; index += 1) {
    const station = metrics.cumulative[index]! / metrics.total;
    if (hasNearbyStation(stationed, station, finiteStations)) continue;
    entries.push({
      station,
      order: guide.length + index,
      node: { ...planRoute[index]!, z: zAtStation(stationed, station, finiteStations) },
    });
  }
  entries.sort((left, right) => left.station - right.station || left.order - right.order);
  let nodes = entries.map((entry) => entry.node);
  // A generated 90-degree level adapter consumes one radius on its horizontal
  // leg. Reserve that setback in addition to the mandatory straight, so the
  // rounded surface still leaves the required service length at the socket.
  const stubMm = minimumStraightMm + fittingExtent;
  const pinStart = (
    source: PipeRouteNode3D[],
    connection: PipeRoute3dConnectionOptions['startConnection'],
  ): PipeRouteNode3D[] => {
    if (!connection || source.length < 2 || !finiteNumber(connection.elevationMm)) return source;
    if (connection.connectionKind !== 'unit-port' || stubMm <= 0) {
      return source.map((node, index) => index === 0 ? { ...node, z: connection.elevationMm } : node);
    }
    const first = source[0]!;
    // Keep a true vertical authored rise intact; it has no horizontal takeoff.
    if (Math.hypot(source[1]!.x - first.x, source[1]!.y - first.y) <= 1e-8) {
      return [{ ...first, z: connection.elevationMm }, ...source.slice(1)];
    }
    const result: PipeRouteNode3D[] = [{ ...first, z: connection.elevationMm }];
    let distance = 0;
    for (let index = 1; index < source.length; index += 1) {
      const previous = source[index - 1]!;
      const node = source[index]!;
      const length = Math.hypot(node.x - previous.x, node.y - previous.y);
      if (distance + length < stubMm - 1e-8) {
        result.push({ ...node, z: connection.elevationMm });
        distance += length;
        continue;
      }
      const t = length <= 1e-9 ? 0 : Math.max(0, Math.min(1, (stubMm - distance) / length));
      const transition = {
        x: previous.x + (node.x - previous.x) * t,
        y: previous.y + (node.y - previous.y) * t,
        z: previous.z + (node.z - previous.z) * t,
      };
      result.push({ ...transition, z: connection.elevationMm });
      if (Math.abs(transition.z - connection.elevationMm) > 1e-8) result.push(transition);
      if (t < 1 - 1e-8) result.push(node);
      result.push(...source.slice(index + 1));
      return result;
    }
    return result;
  };
  nodes = pinStart(nodes, options.startConnection);
  nodes = pinStart([...nodes].reverse(), options.endConnection).reverse();
  return nodes.filter((node, index) => {
    const previous = nodes[index - 1];
    return !previous || Math.hypot(node.x - previous.x, node.y - previous.y, node.z - previous.z) > 1e-8;
  });
}

/**
 * Stamp an absolute 3D centreline onto the exact gas/liquid elements produced
 * by the normal routing builder. Their plan x/y (including pair spacing and
 * port takeoffs) stays authoritative; elevation is sampled from the drawn 3D
 * guide by normalized route distance.
 */
export function attachPipeRoute3dToElements<
  T extends Pick<HvacElement, 'type' | 'position' | 'width' | 'depth' | 'height' | 'elevation' | 'mountType' | 'label'>
    & Partial<HvacElement>,
>(elements: T[], route: readonly PipePlacementPoint[]): T[] {
  if (!hasExplicitPipeRoute3d(route)) return elements;
  const guide = route.map((point) => ({ x: point.x, y: point.y, z: point.z! }));
  const stamped = elements.map((element) => {
    const properties = (element.properties ?? {}) as Record<string, unknown>;
    const planRoute = Array.isArray(properties.routePoints)
      ? (properties.routePoints as Point2D[])
      : [];
    const outerDiameter = finiteNumber(properties.outerDiameterMm)
      ? Math.max(properties.outerDiameterMm, 1)
      : Math.max(element.height, 1);
    // A true vertical riser has a degenerate XY projection. The legacy 2D
    // builder may collapse that projection to one point; retain the original
    // world nodes for the 3D-native renderer instead of dropping the segment.
    const nodes = liftPipePlanRouteTo3d(planRoute, guide, {
      startConnection: properties.startConnection as PipeRoute3dConnectionOptions['startConnection'],
      endConnection: properties.endConnection as PipeRoute3dConnectionOptions['endConnection'],
      outerDiameterMm: outerDiameter,
      pipeDiameterMm: usesCopperSocketElbows(properties) && finiteNumber(properties.pipeDiameterMm) ? properties.pipeDiameterMm : undefined,
      minimumBendRadiusMm: resolveCopperSocketElbowMinimumRadius(properties),
    });
    if (nodes.length < 2) return element;
    const minZ = Math.min(...nodes.map((node) => node.z));
    const maxZ = Math.max(...nodes.map((node) => node.z));
    return {
      ...element,
      elevation: minZ - outerDiameter / 2,
      height: Math.max(outerDiameter, maxZ - minZ + outerDiameter),
      properties: {
        ...properties,
        routeNodes3d: nodes,
        coordinateSpace: 'model-world-mm',
      },
    };
  });
  // A vertical pair has no plan tangent from which the legacy pair builder can
  // derive its lateral normal. Give it a deterministic model-X separation so
  // gas and liquid remain distinct risers instead of occupying one tube.
  const guidePlanLength = guide.slice(1).reduce((length, node, index) => {
    const previous = guide[index]!;
    return length + Math.hypot(node.x - previous.x, node.y - previous.y);
  }, 0);
  if (stamped.length === 2 && guidePlanLength <= 1e-6) {
    const readOuterRadius = (element: T): number => {
      const value = (element.properties as Record<string, unknown> | undefined)?.outerDiameterMm;
      return finiteNumber(value) ? Math.max(value / 2, 0.5) : Math.max(element.height / 2, 0.5);
    };
    const firstProperties = (stamped[0]!.properties ?? {}) as Record<string, unknown>;
    const spacing = finiteNumber(firstProperties.pairCenterSpacingMm)
      ? Math.max(0, firstProperties.pairCenterSpacingMm)
      : readOuterRadius(stamped[0]!) + readOuterRadius(stamped[1]!)
        + (finiteNumber(firstProperties.pipeGapMm)
          ? Math.max(0, firstProperties.pipeGapMm)
          : getActivePipeRoutingSettings().defaultPipeGapMm);
    const firstNodes = normalizePipeRouteNodes3d(firstProperties.routeNodes3d);
    const secondNodes = normalizePipeRouteNodes3d(stamped[1]!.properties?.routeNodes3d);
    if (firstNodes[0] && secondNodes[0]
      && Math.hypot(firstNodes[0].x - secondNodes[0].x, firstNodes[0].y - secondNodes[0].y) > 1e-6) {
      return stamped;
    }
    return stamped.map((element, index) => {
      const properties = (element.properties ?? {}) as Record<string, unknown>;
      const nodes = normalizePipeRouteNodes3d(properties.routeNodes3d);
      const offsetX = index === 0 ? -spacing / 2 : spacing / 2;
      return {
        ...element,
        position: { ...element.position, x: element.position.x + offsetX },
        properties: {
          ...properties,
          routePoints: normalizePlanRoute(properties.routePoints).map((point) => ({ ...point, x: point.x + offsetX })),
          routeNodes3d: nodes.map((node) => ({ ...node, x: node.x + offsetX })),
        },
      };
    });
  }
  return stamped;
}

export function translatePipeRouteNodes3d(
  value: unknown,
  delta: Point2D,
): unknown {
  const nodes = normalizePipeRouteNodes3d(value);
  if (nodes.length === 0) return value;
  return nodes.map((node) => ({ ...node, x: node.x + delta.x, y: node.y + delta.y }));
}
