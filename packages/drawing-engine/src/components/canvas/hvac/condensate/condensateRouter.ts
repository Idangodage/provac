/**
 * Plan router for condensate branches: a heading-aware, multi-target A* on a
 * Hanan grid.
 *
 * Unlike the refrigerant router (point-to-point, uniform costs), a drain
 * branch may end at the termination OR at any admissible station on the
 * network already built, and its costs are those of a drainage installer:
 * length, fittings (bends), wall penetrations, crossings of refrigerant runs,
 * running directly over/under a refrigerant run (discouraged — it hides the
 * drain in plan and complicates hangers) versus running tidily in a parallel
 * corridor lane beside it (encouraged). A target is only accepted when the
 * branch can still fall to it (`acceptTarget`), so the search never commits
 * to a junction the gravity profile cannot reach.
 *
 * Deterministic: grid coordinates are rounded, ties break on insertion order,
 * and the search is bounded by grid and expansion caps.
 */
import type { Point2D } from '../../../../types';

import { distance, EPS, pointToSegmentDistance as pointToSegmentPlanDistance, segmentIntersection, simplifyPolyline } from './condensateGeometry';

export interface RouterBox {
  id: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RouterWall {
  id: string;
  a: Point2D;
  b: Point2D;
}

/** Plan projection of a refrigerant (or other service) run with its clash half-width. */
export interface RouterServiceLine {
  id: string;
  a: Point2D;
  b: Point2D;
  halfWidthMm: number;
}

export interface RouterTreeSegment {
  edgeId: string;
  a: Point2D;
  b: Point2D;
  /** Admissible attach interval measured from `a` (junction spacing already applied). */
  minStation: number;
  maxStation: number;
}

export type RouteTarget =
  | { kind: 'sink'; point: Point2D }
  | { kind: 'tree'; edgeId: string; point: Point2D; station: number };

export interface CondensateRouteCosts {
  bendPenaltyMm: number;
  wallPenaltyMm: number;
  crossingPenaltyMm: number;
  /** Fraction of length discounted on a corridor lane beside a service run. */
  corridorBonusRatio: number;
  /** Extra cost per mm of running inside a service run's plan footprint. */
  overlapPenaltyRatio: number;
  junctionPenaltyMm: number;
}

export interface CondensateRouteRequest {
  start: Point2D;
  /** Initial heading (unit vector); snapped to the nearest axis. */
  startHeading: Point2D;
  sink: Point2D | null;
  treeSegments: readonly RouterTreeSegment[];
  obstacles: readonly RouterBox[];
  walls: readonly RouterWall[];
  services: readonly RouterServiceLine[];
  costs: CondensateRouteCosts;
  /** Gravity check at a candidate target given the branch plan length so far. */
  acceptTarget?: (target: RouteTarget, pathLengthMm: number) => boolean;
  marginMm?: number;
  maxGridNodes?: number;
  maxExpandedStates?: number;
}

export interface CondensateRoute {
  points: Point2D[];
  lengthMm: number;
  bends: number;
  cost: number;
  target: RouteTarget;
  wallCrossings: Array<{ wallId: string; point: Point2D }>;
  serviceCrossings: Array<{ serviceId: string; point: Point2D }>;
  /** False when no target passed `acceptTarget`; the cheapest rejected route is returned for diagnostics. */
  accepted: boolean;
}

const DIRECTIONS: Point2D[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
const ROUND = (value: number) => Math.round(value * 2) / 2;

function snapHeading(direction: Point2D): number {
  let best = 0;
  let bestDot = Number.NEGATIVE_INFINITY;
  DIRECTIONS.forEach((candidate, index) => {
    const value = candidate.x * direction.x + candidate.y * direction.y;
    if (value > bestDot + 1e-9) {
      bestDot = value;
      best = index;
    }
  });
  return best;
}

class MinHeap<T> {
  private items: Array<{ key: number; order: number; value: T }> = [];
  private counter = 0;
  get size(): number { return this.items.length; }
  push(key: number, value: T): void {
    const item = { key, order: this.counter++, value };
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.less(this.items[parent]!, item)) break;
      this.items[index] = this.items[parent]!;
      index = parent;
    }
    this.items[index] = item;
  }
  pop(): T | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (!top || !last) return undefined;
    if (this.items.length) {
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = last;
        let smallestIndex = -1;
        if (left < this.items.length && this.less(this.items[left]!, smallest)) { smallest = this.items[left]!; smallestIndex = left; }
        if (right < this.items.length && this.less(this.items[right]!, smallest)) { smallest = this.items[right]!; smallestIndex = right; }
        if (smallestIndex < 0) break;
        this.items[index] = smallest;
        index = smallestIndex;
      }
      this.items[index] = last;
    }
    return top.value;
  }
  private less(a: { key: number; order: number }, b: { key: number; order: number }): boolean {
    return a.key < b.key - 1e-9 || (Math.abs(a.key - b.key) <= 1e-9 && a.order < b.order);
  }
}

function insideBox(point: Point2D, box: RouterBox): boolean {
  return point.x > box.minX + EPS && point.x < box.maxX - EPS && point.y > box.minY + EPS && point.y < box.maxY - EPS;
}

/** True when the open axis-aligned segment passes through a box interior. */
function segmentHitsBox(a: Point2D, b: Point2D, box: RouterBox): boolean {
  if (Math.abs(a.y - b.y) <= EPS) {
    const y = a.y;
    if (y <= box.minY + EPS || y >= box.maxY - EPS) return false;
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    return hi > box.minX + EPS && lo < box.maxX - EPS;
  }
  if (Math.abs(a.x - b.x) <= EPS) {
    const x = a.x;
    if (x <= box.minX + EPS || x >= box.maxX - EPS) return false;
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    return hi > box.minY + EPS && lo < box.maxY - EPS;
  }
  return insideBox({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, box);
}

function projectStation(point: Point2D, a: Point2D, b: Point2D): { station: number; offset: number } {
  const length = distance(a, b);
  if (length <= EPS) return { station: 0, offset: distance(point, a) };
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  const dx = point.x - a.x;
  const dy = point.y - a.y;
  return { station: dx * ux + dy * uy, offset: Math.abs(-dx * uy + dy * ux) };
}

function manhattanToSegment(point: Point2D, a: Point2D, b: Point2D): number {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const dx = point.x < minX ? minX - point.x : point.x > maxX ? point.x - maxX : 0;
  const dy = point.y < minY ? minY - point.y : point.y > maxY ? point.y - maxY : 0;
  return dx + dy;
}

interface EdgeInfo {
  blocked: boolean;
  cost: number;
  walls: Array<{ wallId: string; point: Point2D }>;
  crossings: Array<{ serviceId: string; point: Point2D }>;
}

export function routeCondensateBranch(request: CondensateRouteRequest): CondensateRoute | null {
  const margin = request.marginMm ?? 1500;
  const maxGridNodes = request.maxGridNodes ?? 40000;
  const maxExpanded = request.maxExpandedStates ?? 120000;
  const costs = request.costs;
  const start = { x: ROUND(request.start.x), y: ROUND(request.start.y) };
  const sink = request.sink ? { x: ROUND(request.sink.x), y: ROUND(request.sink.y) } : null;
  const tree = request.treeSegments.filter((segment) => segment.maxStation - segment.minStation > -EPS);
  if (!sink && !tree.length) return null;

  // --- Grid ---------------------------------------------------------------
  const xs = new Set<number>([start.x]);
  const ys = new Set<number>([start.y]);
  if (sink) { xs.add(sink.x); ys.add(sink.y); }
  const boundsPoints: Point2D[] = [start, ...(sink ? [sink] : [])];
  for (const segment of tree) {
    for (const p of [segment.a, segment.b]) { xs.add(ROUND(p.x)); ys.add(ROUND(p.y)); boundsPoints.push(p); }
  }
  for (const box of request.obstacles) {
    xs.add(ROUND(box.minX)); xs.add(ROUND(box.maxX));
    ys.add(ROUND(box.minY)); ys.add(ROUND(box.maxY));
  }
  const corridorXs = new Set<number>();
  const corridorYs = new Set<number>();
  for (const service of request.services) {
    const horizontal = Math.abs(service.a.y - service.b.y) <= 1;
    const vertical = Math.abs(service.a.x - service.b.x) <= 1;
    const lane = service.halfWidthMm + 5;
    if (horizontal) { corridorYs.add(ROUND(service.a.y - lane)); corridorYs.add(ROUND(service.a.y + lane)); }
    if (vertical) { corridorXs.add(ROUND(service.a.x - lane)); corridorXs.add(ROUND(service.a.x + lane)); }
  }
  const minX = Math.min(...boundsPoints.map((p) => p.x)) - margin;
  const maxX = Math.max(...boundsPoints.map((p) => p.x)) + margin;
  const minY = Math.min(...boundsPoints.map((p) => p.y)) - margin;
  const maxY = Math.max(...boundsPoints.map((p) => p.y)) + margin;
  xs.add(ROUND(minX)); xs.add(ROUND(maxX)); ys.add(ROUND(minY)); ys.add(ROUND(maxY));
  const within = (value: number, lo: number, hi: number) => value >= lo - EPS && value <= hi + EPS;
  let gridX = [...xs].filter((x) => within(x, minX, maxX));
  let gridY = [...ys].filter((y) => within(y, minY, maxY));
  const withCorridorX = [...new Set([...gridX, ...[...corridorXs].filter((x) => within(x, minX, maxX))])];
  const withCorridorY = [...new Set([...gridY, ...[...corridorYs].filter((y) => within(y, minY, maxY))])];
  if (withCorridorX.length * withCorridorY.length <= maxGridNodes) {
    gridX = withCorridorX;
    gridY = withCorridorY;
  }
  gridX.sort((a, b) => a - b);
  gridY.sort((a, b) => a - b);
  // Keep at most maxGridNodes by thinning lines far from any terminal.
  while (gridX.length * gridY.length > maxGridNodes && (gridX.length > 8 || gridY.length > 8)) {
    const thin = (values: number[], keep: Set<number>) => values.filter((value, index) => keep.has(value) || index % 2 === 0 || index === values.length - 1);
    const keepX = new Set([start.x, ...(sink ? [sink.x] : [])]);
    const keepY = new Set([start.y, ...(sink ? [sink.y] : [])]);
    if (gridX.length >= gridY.length) gridX = thin(gridX, keepX); else gridY = thin(gridY, keepY);
  }
  const nx = gridX.length;
  const ny = gridY.length;
  const xIndex = new Map(gridX.map((x, index) => [x, index]));
  const yIndex = new Map(gridY.map((y, index) => [y, index]));
  const nodePoint = (node: number): Point2D => ({ x: gridX[Math.floor(node / ny)]!, y: gridY[node % ny]! });
  const startNode = (xIndex.get(start.x) ?? 0) * ny + (yIndex.get(start.y) ?? 0);
  const sinkNode = sink ? (xIndex.get(sink.x)! * ny + yIndex.get(sink.y)!) : -1;
  const corridorXSet = corridorXs;
  const corridorYSet = corridorYs;

  // --- Tree targets ------------------------------------------------------
  const targetCache = new Map<number, RouteTarget | null>();
  const onTree = (point: Point2D): { segment: RouterTreeSegment; station: number } | null => {
    for (const segment of tree) {
      const { station, offset } = projectStation(point, segment.a, segment.b);
      const length = distance(segment.a, segment.b);
      if (offset <= 0.6 && station >= -0.6 && station <= length + 0.6) return { segment, station };
    }
    return null;
  };
  const treeTargetAt = (node: number): RouteTarget | null => {
    if (targetCache.has(node)) return targetCache.get(node)!;
    const point = nodePoint(node);
    const hit = onTree(point);
    // A branch drops vertically into the crown of the main at the junction, so a
    // junction inside another service's plan footprint would pass through it.
    const underService = request.services.some((service) => distance(service.a, service.b) > EPS
      && pointToSegmentPlanDistance(point, service.a, service.b) < service.halfWidthMm);
    const target = hit && !underService && hit.station >= hit.segment.minStation - 0.6 && hit.station <= hit.segment.maxStation + 0.6
      ? { kind: 'tree' as const, edgeId: hit.segment.edgeId, point, station: hit.station }
      : null;
    targetCache.set(node, target);
    return target;
  };

  // --- Edge evaluation ---------------------------------------------------
  const edgeCache = new Map<string, EdgeInfo>();
  const evaluateEdge = (from: number, to: number): EdgeInfo => {
    const key = from < to ? `${from}:${to}` : `${to}:${from}`;
    const cached = edgeCache.get(key);
    if (cached) return cached;
    const a = nodePoint(from);
    const b = nodePoint(to);
    const length = distance(a, b);
    let blocked = request.obstacles.some((box) => segmentHitsBox(a, b, box));
    const horizontal = Math.abs(a.y - b.y) <= EPS;
    // Never run along or through the network already built (only arrive on it).
    if (!blocked) {
      for (const segment of tree) {
        const segHorizontal = Math.abs(segment.a.y - segment.b.y) <= 0.6;
        const segVertical = Math.abs(segment.a.x - segment.b.x) <= 0.6;
        if (horizontal && segHorizontal && Math.abs(a.y - segment.a.y) <= 0.6) {
          const lo = Math.max(Math.min(a.x, b.x), Math.min(segment.a.x, segment.b.x));
          const hi = Math.min(Math.max(a.x, b.x), Math.max(segment.a.x, segment.b.x));
          if (hi - lo > 0.6) { blocked = true; break; }
        } else if (!horizontal && segVertical && Math.abs(a.x - segment.a.x) <= 0.6) {
          const lo = Math.max(Math.min(a.y, b.y), Math.min(segment.a.y, segment.b.y));
          const hi = Math.min(Math.max(a.y, b.y), Math.max(segment.a.y, segment.b.y));
          if (hi - lo > 0.6) { blocked = true; break; }
        } else {
          const hit = segmentIntersection(a, b, segment.a, segment.b, false);
          if (hit && distance(hit.point, b) > 0.6 && distance(hit.point, a) > 0.6) { blocked = true; break; }
        }
      }
    }
    const walls: EdgeInfo['walls'] = [];
    const crossings: EdgeInfo['crossings'] = [];
    let cost = length;
    if (!blocked) {
      for (const wall of request.walls) {
        const hit = segmentIntersection(a, b, wall.a, wall.b, false);
        if (hit) walls.push({ wallId: wall.id, point: hit.point });
      }
      let overlap = 0;
      for (const service of request.services) {
        const hit = segmentIntersection(a, b, service.a, service.b, false);
        const serviceLength = distance(service.a, service.b);
        if (hit && serviceLength > EPS) {
          // Parallel runs never intersect properly; a proper hit is a crossing.
          crossings.push({ serviceId: service.id, point: hit.point });
          continue;
        }
        if (serviceLength <= EPS) continue;
        const sa = projectStation(a, service.a, service.b);
        const sb = projectStation(b, service.a, service.b);
        const parallel = Math.abs(sa.offset - sb.offset) <= 1 && Math.abs(Math.abs(sa.station - sb.station) - length) <= 1;
        if (parallel && sa.offset < service.halfWidthMm) {
          const lo = Math.max(0, Math.min(sa.station, sb.station));
          const hi = Math.min(serviceLength, Math.max(sa.station, sb.station));
          if (hi > lo) overlap += hi - lo;
        }
      }
      const onCorridor = horizontal ? corridorYSet.has(a.y) : corridorXSet.has(a.x);
      cost = length * (onCorridor ? 1 - costs.corridorBonusRatio : 1)
        + overlap * costs.overlapPenaltyRatio
        + walls.length * costs.wallPenaltyMm
        + crossings.length * costs.crossingPenaltyMm;
    }
    const info = { blocked, cost, walls, crossings };
    edgeCache.set(key, info);
    return info;
  };

  // --- A* ----------------------------------------------------------------
  const heuristicScale = 1 - costs.corridorBonusRatio;
  const heuristicCache = new Map<number, number>();
  const heuristic = (node: number): number => {
    const cached = heuristicCache.get(node);
    if (cached !== undefined) return cached;
    const point = nodePoint(node);
    let best = sink ? Math.abs(point.x - sink.x) + Math.abs(point.y - sink.y) : Number.POSITIVE_INFINITY;
    for (const segment of tree) best = Math.min(best, manhattanToSegment(point, segment.a, segment.b) + costs.junctionPenaltyMm);
    const value = best * heuristicScale;
    heuristicCache.set(node, value);
    return value;
  };

  interface State { node: number; heading: number; g: number; length: number; bends: number; parent: State | null; terminal: RouteTarget | null }
  const heap = new MinHeap<State>();
  const bestG = new Map<number, number>();
  const startHeading = snapHeading(request.startHeading);
  const startState: State = { node: startNode, heading: startHeading, g: 0, length: 0, bends: 0, parent: null, terminal: null };
  heap.push(heuristic(startNode), startState);
  bestG.set(startNode * 4 + startHeading, 0);
  let rejected: State | null = null;
  let expanded = 0;

  const tryTerminal = (state: State, target: RouteTarget, extraCost: number): void => {
    const accepted = request.acceptTarget ? request.acceptTarget(target, state.length) : true;
    const terminal: State = { ...state, g: state.g + extraCost, terminal: target };
    if (accepted) heap.push(terminal.g, terminal);
    else if (!rejected || terminal.g < rejected.g) rejected = terminal;
  };

  if (sink && startNode === sinkNode) tryTerminal(startState, { kind: 'sink', point: sink }, 0);

  while (heap.size && expanded < maxExpanded) {
    const state = heap.pop()!;
    if (state.terminal) return buildRoute(state, true);
    const key = state.node * 4 + state.heading;
    if ((bestG.get(key) ?? Number.POSITIVE_INFINITY) < state.g - 1e-9) continue;
    expanded += 1;
    const ix = Math.floor(state.node / ny);
    const iy = state.node % ny;
    for (let heading = 0; heading < 4; heading += 1) {
      if (state.parent && (heading + 2) % 4 === state.heading) continue; // no U-turn
      const direction = DIRECTIONS[heading]!;
      const jx = ix + direction.x;
      const jy = iy + direction.y;
      if (jx < 0 || jx >= nx || jy < 0 || jy >= ny) continue;
      const next = jx * ny + jy;
      const edge = evaluateEdge(state.node, next);
      if (edge.blocked) continue;
      const turned = state.parent !== null || heading !== startHeading ? heading !== state.heading : false;
      const g = state.g + edge.cost + (turned ? costs.bendPenaltyMm : 0);
      const length = state.length + distance(nodePoint(state.node), nodePoint(next));
      const nextState: State = { node: next, heading, g, length, bends: state.bends + (turned ? 1 : 0), parent: state, terminal: null };
      if (next === sinkNode) {
        tryTerminal(nextState, { kind: 'sink', point: sink! }, 0);
        continue;
      }
      const target = tree.length ? treeTargetAt(next) : null;
      if (target) {
        // Arrive square to the main; a branch may not run along it.
        tryTerminal(nextState, target, costs.junctionPenaltyMm);
        continue;
      }
      if (tree.length && onTree(nodePoint(next))) continue; // on the network but not admissible
      const nextKey = next * 4 + heading;
      if (g < (bestG.get(nextKey) ?? Number.POSITIVE_INFINITY) - 1e-9) {
        bestG.set(nextKey, g);
        heap.push(g + heuristic(next), nextState);
      }
    }
  }
  return rejected ? buildRoute(rejected, false) : null;

  function buildRoute(terminal: State, accepted: boolean): CondensateRoute {
    const states: State[] = [];
    for (let cursor: State | null = terminal; cursor; cursor = cursor.parent) states.push(cursor);
    states.reverse();
    const raw = states.map((state) => nodePoint(state.node));
    const walls: CondensateRoute['wallCrossings'] = [];
    const crossings: CondensateRoute['serviceCrossings'] = [];
    for (let index = 1; index < states.length; index += 1) {
      const edge = evaluateEdge(states[index - 1]!.node, states[index]!.node);
      walls.push(...edge.walls);
      crossings.push(...edge.crossings);
    }
    const points = simplifyPolyline(raw);
    return {
      points,
      lengthMm: terminal.length,
      bends: Math.max(0, points.length - 2),
      cost: terminal.g,
      target: terminal.terminal!,
      wallCrossings: walls,
      serviceCrossings: crossings,
      accepted,
    };
  }
}
