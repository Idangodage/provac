import type { Point2D } from '../../../types';

export interface OrthogonalConnectionRouteOptions {
  start: Point2D;
  end: Point2D;
  /** Required outward direction at an equipment or fitting socket. */
  startDirection?: Point2D;
  /** Outward socket direction; the route arrives in its opposite direction. */
  endDirection: Point2D;
  /** Clear straight pipe, excluding the adjacent elbow's tangent setback. */
  startStraightMm: number;
  endStraightMm: number;
  bendRadiusMm?: number;
  /** Travel direction into an authored waypoint, without imposing its departure. */
  incomingDirection?: Point2D;
}

const EPSILON = 1e-6;
const CARDINALS: readonly Point2D[] = [
  { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 },
];

function finitePoint(point: Point2D): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function cardinal(direction: Point2D): Point2D | null {
  if (!finitePoint(direction) || Math.hypot(direction.x, direction.y) < EPSILON) return null;
  return Math.abs(direction.x) >= Math.abs(direction.y)
    ? { x: Math.sign(direction.x), y: 0 }
    : { x: 0, y: Math.sign(direction.y) };
}

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function difference(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function distance(a: Point2D, b: Point2D): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function along(point: Point2D, direction: Point2D, amount: number): Point2D {
  return { x: point.x + direction.x * amount, y: point.y + direction.y * amount };
}

function uniqueNumbers(values: number[]): number[] {
  return values.filter((value, index) => values.findIndex((other) => Math.abs(other - value) < EPSILON) === index);
}

function simplify(points: Point2D[]): Point2D[] {
  const result: Point2D[] = [];
  for (const point of points) {
    if (result.length && distance(point, result[result.length - 1]!) < EPSILON) continue;
    while (result.length >= 2) {
      const first = difference(result[result.length - 1]!, result[result.length - 2]!);
      const second = difference(point, result[result.length - 1]!);
      if (Math.abs(first.x * second.y - first.y * second.x) > EPSILON || dot(first, second) <= 0) break;
      result.pop();
    }
    result.push({ ...point });
  }
  return result;
}

function segmentsIntersect(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  return Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) + EPSILON
    && Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) + EPSILON;
}

/** Route cost includes a turn at the preceding authored waypoint. */
export function getOrthogonalConnectionRouteCost(
  points: readonly Point2D[],
  incomingDirection?: Point2D,
): { bends: number; lengthMm: number } {
  const incoming = incomingDirection && cardinal(incomingDirection);
  const departure = points.length >= 2 && cardinal(difference(points[1]!, points[0]!));
  return {
    bends: Math.max(0, points.length - 2) + (incoming && departure && dot(incoming, departure) === 0 ? 1 : 0),
    lengthMm: points.slice(1).reduce((total, point, index) => total + distance(point, points[index]!), 0),
  };
}

/**
 * Small analytic family of zero-to-four-elbow routes. Socket constraints and
 * elbow setbacks are enforced here; scene collisions are checked by the caller.
 * Same-facing sockets share their nearest outside lane instead of each getting
 * a separate offset that introduces an S-shaped approach.
 */
export function buildOrthogonalConnectionRouteCandidates(
  options: OrthogonalConnectionRouteOptions,
): Point2D[][] {
  const { start, end, startStraightMm, endStraightMm, bendRadiusMm = 0 } = options;
  if (!finitePoint(start) || !finitePoint(end)
    || ![startStraightMm, endStraightMm, bendRadiusMm].every((value) => Number.isFinite(value) && value >= 0)
    || distance(start, end) < EPSILON) return [];
  const startDirection = options.startDirection && cardinal(options.startDirection);
  const endDirection = cardinal(options.endDirection);
  const incoming = options.incomingDirection && cardinal(options.incomingDirection);
  if (!endDirection || (options.startDirection && !startDirection) || (options.incomingDirection && !incoming)) return [];
  const endTravel = { x: -endDirection.x, y: -endDirection.y };
  const startClear = startStraightMm + bendRadiusMm;
  const endClear = endStraightMm + bendRadiusMm;
  const laneStep = Math.max(startClear, endClear, 2 * bendRadiusMm, 1);
  const routes = new Map<string, Point2D[]>();

  const add = (raw: Point2D[]) => {
    const route = simplify(raw);
    if (route.length < 2) return;
    const directions: Point2D[] = [];
    for (let index = 1; index < route.length; index += 1) {
      const delta = difference(route[index]!, route[index - 1]!);
      if (Math.abs(delta.x) > EPSILON && Math.abs(delta.y) > EPSILON) return;
      const direction = cardinal(delta);
      if (!direction || (directions.length && dot(direction, directions[directions.length - 1]!) < 0)) return;
      directions.push(direction);
    }
    if ((startDirection && dot(directions[0]!, startDirection) < 1)
      || dot(directions[directions.length - 1]!, endTravel) < 1
      || (incoming && dot(directions[0]!, incoming) < 0)) return;
    const incomingTurn = !!incoming && dot(directions[0]!, incoming) === 0;
    for (let index = 0; index < directions.length; index += 1) {
      const first = index === 0;
      const last = index === directions.length - 1;
      const setbacks = ((!first || incomingTurn) ? bendRadiusMm : 0) + (!last ? bendRadiusMm : 0);
      const straight = first && last ? Math.max(startStraightMm, endStraightMm)
        : first ? startStraightMm : last ? endStraightMm : 0;
      if (distance(route[index]!, route[index + 1]!) + EPSILON < setbacks + straight) return;
      for (let other = index + 2; other < directions.length; other += 1) {
        if (segmentsIntersect(route[index]!, route[index + 1]!, route[other]!, route[other + 1]!)) return;
      }
    }
    const key = route.map((point) => `${point.x.toFixed(6)},${point.y.toFixed(6)}`).join(';');
    if (!routes.has(key)) routes.set(key, route);
  };

  // Direct and single-elbow paths must be considered before any offset lanes.
  add([start, end]);
  add([start, { x: end.x, y: start.y }, end]);
  add([start, { x: start.x, y: end.y }, end]);

  for (const departure of startDirection ? [startDirection] : CARDINALS) {
    if (incoming && dot(departure, incoming) < 0) continue;
    const departureClear = Math.max(startClear, incoming && dot(departure, incoming) === 0 ? 2 * bendRadiusMm : 0);
    const horizontal = departure.x !== 0;
    const sameAxis = horizontal === (endDirection.x !== 0);
    const startAxis = horizontal ? start.x : start.y;
    const endAxis = horizontal ? end.x : end.y;
    if (sameAxis) {
      const startSign = horizontal ? departure.x : departure.y;
      const endSign = horizontal ? endDirection.x : endDirection.y;
      const startLimit = startAxis + startSign * departureClear;
      const endLimit = endAxis + endSign * endClear;
      const lanes = uniqueNumbers([
        startLimit, endLimit, (startLimit + endLimit) / 2,
        Math.min(startLimit, endLimit) - laneStep,
        Math.max(startLimit, endLimit) + laneStep,
      ]);
      for (const lane of lanes) {
        add(horizontal
          ? [start, { x: lane, y: start.y }, { x: lane, y: end.y }, end]
          : [start, { x: start.x, y: lane }, { x: end.x, y: lane }, end]);
      }
    }

    // A few analytically useful anchor distances provide alternate approaches
    // around an occupied direct lane without enumerating a variable-size grid.
    const anchorDistances = (origin: Point2D, direction: Point2D, target: Point2D, clearance: number) => {
      const projected = dot(difference(target, origin), direction);
      return uniqueNumbers([clearance, Math.max(clearance, projected + laneStep), Math.max(clearance, projected) + 2 * laneStep]);
    };
    const startAnchors = anchorDistances(start, departure, end, departureClear).map((length) => along(start, departure, length));
    const endAnchors = anchorDistances(end, endDirection, start, endClear).map((length) => along(end, endDirection, length));
    for (const first of startAnchors) {
      for (const last of endAnchors) {
        if (!sameAxis) {
          add([start, first, horizontal ? { x: first.x, y: last.y } : { x: last.x, y: first.y }, last, end]);
        } else {
          const firstCross = horizontal ? start.y : start.x;
          const lastCross = horizontal ? end.y : end.x;
          const crossLanes = uniqueNumbers([
            (firstCross + lastCross) / 2,
            Math.min(firstCross, lastCross) - laneStep,
            Math.max(firstCross, lastCross) + laneStep,
          ]);
          for (const lane of crossLanes) {
            add(horizontal
              ? [start, first, { x: first.x, y: lane }, { x: last.x, y: lane }, last, end]
              : [start, first, { x: lane, y: first.y }, { x: lane, y: last.y }, last, end]);
          }
        }
      }
    }
  }

  return [...routes.entries()]
    .map(([key, route]) => ({ key, route, ...getOrthogonalConnectionRouteCost(route, options.incomingDirection) }))
    .sort((a, b) => a.bends - b.bends || a.lengthMm - b.lengthMm || a.key.localeCompare(b.key))
    .slice(0, 12)
    .map(({ route }) => route);
}
