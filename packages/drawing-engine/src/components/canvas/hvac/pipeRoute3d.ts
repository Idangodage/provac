import type { HvacElement, Point2D } from '../../../types';

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
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const point = candidate as { x?: unknown; y?: unknown };
    return finiteNumber(point.x) && finiteNumber(point.y)
      ? [{ x: point.x, y: point.y }]
      : [];
  });
}

export function normalizePipeRouteNodes3d(value: unknown): PipeRouteNode3D[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const point = candidate as { x?: unknown; y?: unknown; z?: unknown };
    return finiteNumber(point.x) && finiteNumber(point.y) && finiteNumber(point.z)
      ? [{ x: point.x, y: point.y, z: point.z }]
      : [];
  });
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
  for (let index = 1; index < path.length; index += 1) {
    const start = path[index - 1]!;
    const end = path[index]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared <= 1e-12
      ? 0
      : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
    const projectedX = start.x + dx * t;
    const projectedY = start.y + dy * t;
    const distanceSquared = (point.x - projectedX) ** 2 + (point.y - projectedY) ** 2;
    const segmentLength = Math.sqrt(lengthSquared);
    const station = (metrics.cumulative[index - 1]! + segmentLength * t) / metrics.total;
    if (
      distanceSquared < bestDistanceSquared - 1e-9
      || (Math.abs(distanceSquared - bestDistanceSquared) <= 1e-9 && station < bestStation)
    ) {
      bestDistanceSquared = distanceSquared;
      bestStation = station;
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
  for (let index = 1; index < path.length; index += 1) {
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
): number {
  if (stationedNodes.length === 0) return 0;
  const first = stationedNodes[0]!;
  const last = stationedNodes[stationedNodes.length - 1]!;
  if (station <= first.station) return first.node.z;
  if (station >= last.station) return last.node.z;
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

  const projected = stationedNodes.map(({ station, node, order }) => ({
    station,
    order,
    source: 0,
    node: { ...pointAtStation(nextPlanRoute, nextMetrics, station), z: node.z },
  }));

  nextPlanRoute.forEach((point, index) => {
    const station = nextVertexStations[index] ?? 0;
    if (stationedNodes.some((candidate) => Math.abs(candidate.station - station) <= 1e-8)) {
      return;
    }
    projected.push({
      station,
      order: index,
      source: 1,
      node: { ...point, z: zAtStation(stationedNodes, station) },
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
  const firstCutStation = closestStationOnPath(firstCut, planRoute, metrics, 0);
  const secondCutStation = closestStationOnPath(secondCut, planRoute, metrics, 1);
  const lowerStation = Math.min(firstCutStation, secondCutStation);
  const upperStation = Math.max(firstCutStation, secondCutStation);
  const firstCutNode: PipeRouteNode3D = {
    ...pointAtStation(planRoute, metrics, firstCutStation),
    z: cutElevations.first ?? zAtStation(stationedNodes, firstCutStation),
  };
  const secondCutNode: PipeRouteNode3D = {
    ...pointAtStation(planRoute, metrics, secondCutStation),
    z: cutElevations.second ?? zAtStation(stationedNodes, secondCutStation),
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

function routeNodesForPlanRoute(
  planRoute: readonly Point2D[],
  guide: readonly PipeRouteNode3D[],
): PipeRouteNode3D[] {
  if (planRoute.length === 0) return guide.map((node) => ({ ...node }));
  const closestOnPlanRoute = (point: Point2D): Point2D => {
    if (planRoute.length === 1) return { ...planRoute[0]! };
    let best = { ...planRoute[0]! };
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 1; index < planRoute.length; index += 1) {
      const start = planRoute[index - 1]!;
      const end = planRoute[index]!;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared <= 1e-12
        ? 0
        : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
      const candidate = { x: start.x + dx * t, y: start.y + dy * t };
      const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  };
  // Preserve every authored Z node (including equal-XY vertical risers). For a
  // gas/liquid pair, project each guide node onto that line's already-resolved
  // plan route so lateral spacing and port takeoffs remain intact.
  return guide.map((node) => ({ ...closestOnPlanRoute(node), z: node.z }));
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
    // A true vertical riser has a degenerate XY projection. The legacy 2D
    // builder may collapse that projection to one point; retain the original
    // world nodes for the 3D-native renderer instead of dropping the segment.
    const nodes = routeNodesForPlanRoute(planRoute, guide);
    if (nodes.length < 2) return element;
    const outerDiameter = finiteNumber(properties.outerDiameterMm)
      ? Math.max(properties.outerDiameterMm, 1)
      : Math.max(element.height, 1);
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
    const spacing = readOuterRadius(stamped[0]!) + readOuterRadius(stamped[1]!) + 10;
    return stamped.map((element, index) => {
      const properties = (element.properties ?? {}) as Record<string, unknown>;
      const nodes = normalizePipeRouteNodes3d(properties.routeNodes3d);
      const offsetX = index === 0 ? -spacing / 2 : spacing / 2;
      return {
        ...element,
        properties: {
          ...properties,
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
