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
