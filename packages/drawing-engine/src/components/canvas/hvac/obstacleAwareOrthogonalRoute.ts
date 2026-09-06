import type { Point2D } from '../../../types';

import {
  buildOrthogonalConnectionRouteCandidates,
  getOrthogonalConnectionRouteCost,
  type OrthogonalConnectionRouteOptions,
} from './orthogonalConnectionRoute';

export interface OrthogonalRouteObstacle {
  id?: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ObstacleAwareOrthogonalRouteOptions extends OrthogonalConnectionRouteOptions {
  /** Source/target equipment require their own port corridor and are excluded by the caller. */
  obstacles?: readonly OrthogonalRouteObstacle[];
  /** Bundle envelope plus the required clear space outside that envelope. */
  clearanceMm?: number;
  /** Installation-cost proxy expressed as an equivalent length per elbow. */
  bendPenaltyMm?: number;
  maxGridNodes?: number;
  maxExpandedStates?: number;
  /** Final physical geometry can reject a plan detour without blocking valid 3D crossings. */
  acceptRoute?: (points: readonly Point2D[]) => boolean;
  /** Bounds potentially expensive physical-geometry checks across alternate approaches. */
  maxCandidateChecks?: number;
}

export interface ObstacleAwareOrthogonalRoute {
  points: Point2D[];
  lengthMm: number;
  bends: number;
  objectiveMm: number;
}

const EPS = 1e-6;
const DIRECTIONS: readonly Point2D[] = [
  { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 },
];
const finitePoint = (point: Point2D) => Number.isFinite(point.x) && Number.isFinite(point.y);
const distance = (a: Point2D, b: Point2D) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function directionIndex(direction: Point2D): number {
  if (!finitePoint(direction)) return -1;
  const magnitude = Math.hypot(direction.x, direction.y);
  if (magnitude < EPS) return -1;
  return DIRECTIONS.findIndex(value => Math.abs(value.x - direction.x / magnitude) < EPS
    && Math.abs(value.y - direction.y / magnitude) < EPS);
}

function inside(point: Point2D, box: OrthogonalRouteObstacle): boolean {
  return point.x > box.minX + EPS && point.x < box.maxX - EPS
    && point.y > box.minY + EPS && point.y < box.maxY - EPS;
}

function crosses(a: Point2D, b: Point2D, box: OrthogonalRouteObstacle): boolean {
  if (Math.abs(a.y - b.y) < EPS) {
    return a.y > box.minY + EPS && a.y < box.maxY - EPS
      && Math.max(a.x, b.x) > box.minX + EPS && Math.min(a.x, b.x) < box.maxX - EPS;
  }
  return a.x > box.minX + EPS && a.x < box.maxX - EPS
    && Math.max(a.y, b.y) > box.minY + EPS && Math.min(a.y, b.y) < box.maxY - EPS;
}

function hasSelfIntersection(points: Point2D[]): boolean {
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!; const b = points[index]!;
    for (let other = index + 2; other < points.length; other += 1) {
      const c = points[other - 1]!; const d = points[other]!;
      if (Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) + EPS
        && Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) + EPS) return true;
    }
  }
  return false;
}

interface SearchEntry { state: number; cost: number; priority: number }

class SearchQueue {
  private entries: SearchEntry[] = [];

  private before(a: SearchEntry, b: SearchEntry): boolean {
    return a.priority < b.priority || (a.priority === b.priority && (a.cost < b.cost
      || (a.cost === b.cost && a.state < b.state)));
  }

  push(entry: SearchEntry): void {
    let index = this.entries.length;
    this.entries.push(entry);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.before(entry, this.entries[parent]!)) break;
      this.entries[index] = this.entries[parent]!;
      index = parent;
    }
    this.entries[index] = entry;
  }

  pop(): SearchEntry | undefined {
    const first = this.entries[0];
    const last = this.entries.pop();
    if (!last || !this.entries.length) return first;
    let index = 0;
    while (2 * index + 1 < this.entries.length) {
      let child = 2 * index + 1;
      if (child + 1 < this.entries.length && this.before(this.entries[child + 1]!, this.entries[child]!)) child += 1;
      if (!this.before(this.entries[child]!, last)) break;
      this.entries[index] = this.entries[child]!;
      index = child;
    }
    this.entries[index] = last;
    return first;
  }
}

/**
 * A bounded plan-space search for installable cardinal approaches. Straight
 * lengths include elbow setbacks. The objective is length plus a stated elbow
 * cost, not a refrigerant pressure-drop calculation. Grid/cap exhaustion can
 * return the best validated analytic candidate, or null; neither result proves
 * global optimality. Walls are not implicit barriers: penetrations need project
 * data. No vertical bypass, oil trap, or sloping pipe is invented by this solver.
 */
export function findObstacleAwareOrthogonalRoute(
  options: ObstacleAwareOrthogonalRouteOptions,
): ObstacleAwareOrthogonalRoute | null {
  const radius = options.bendRadiusMm ?? 0;
  const clearance = options.clearanceMm ?? 0;
  const bendPenalty = options.bendPenaltyMm ?? 1000;
  const gridCap = options.maxGridNodes ?? 6400;
  const searchCap = options.maxExpandedStates ?? 12000;
  const candidateCap = options.maxCandidateChecks ?? 48;
  const startDirection = options.startDirection ? directionIndex(options.startDirection) : -1;
  const endDirection = directionIndex(options.endDirection);
  const incomingDirection = options.incomingDirection ? directionIndex(options.incomingDirection) : -1;
  if (!finitePoint(options.start) || !finitePoint(options.end) || !Number.isFinite(distance(options.start, options.end))
    || distance(options.start, options.end) < EPS
    || ![radius, clearance, bendPenalty, options.startStraightMm, options.endStraightMm].every(value => Number.isFinite(value) && value >= 0)
    || ![gridCap, searchCap, candidateCap].every(value => Number.isFinite(value) && value >= 1)
    || endDirection < 0 || (options.startDirection && startDirection < 0)
    || (options.incomingDirection && incomingDirection < 0)) return null;

  const obstacles: OrthogonalRouteObstacle[] = [];
  for (const box of options.obstacles ?? []) {
    if (![box.minX, box.minY, box.maxX, box.maxY].every(Number.isFinite)
      || box.minX > box.maxX || box.minY > box.maxY) return null;
    // A rounded guide corner cuts inward by up to its radius. This conservative
    // envelope preserves the requested clearance after elbow rendering as well.
    const padding = clearance + radius;
    const expanded = { minX: box.minX - padding, minY: box.minY - padding,
      maxX: box.maxX + padding, maxY: box.maxY + padding };
    if (!Object.values(expanded).every(Number.isFinite)) return null;
    obstacles.push(expanded);
  }
  if (obstacles.some(box => inside(options.start, box) || inside(options.end, box))) return null;
  const freeSegment = (a: Point2D, b: Point2D) => !obstacles.some(box => crosses(a, b, box));
  const assess = (points: Point2D[]): ObstacleAwareOrthogonalRoute => {
    const cost = getOrthogonalConnectionRouteCost(points, options.incomingDirection);
    return { points, ...cost, objectiveMm: cost.lengthMm + cost.bends * bendPenalty };
  };
  const checked = new Map<string, boolean>();
  const accepted = (points: Point2D[]) => {
    if (!options.acceptRoute) return true;
    const key = JSON.stringify(points);
    const previous = checked.get(key);
    if (previous !== undefined) return previous;
    if (checked.size >= candidateCap) return false;
    const valid = options.acceptRoute(points);
    checked.set(key, valid);
    return valid;
  };
  let best: ObstacleAwareOrthogonalRoute | null = null;
  const analytic = buildOrthogonalConnectionRouteCandidates(options).map(assess)
    .sort((a, b) => a.objectiveMm - b.objectiveMm || a.bends - b.bends);
  for (const route of analytic) {
    const points = route.points;
    if (!points.slice(1).every((point, index) => freeSegment(points[index]!, point))) continue;
    if (!accepted(points)) continue;
    if (!best || route.objectiveMm < best.objectiveMm - EPS
      || (Math.abs(route.objectiveMm - best.objectiveMm) < EPS && route.bends < best.bends)) best = route;
  }
  if ((!obstacles.length && !options.acceptRoute)
    || (best && best.bends <= 1 && best.lengthMm <= distance(options.start, options.end) + EPS)) return best;

  const step = Math.max(1, 2 * radius, options.startStraightMm + radius, options.endStraightMm + radius);
  const xs = [options.start.x, options.end.x]; const ys = [options.start.y, options.end.y];
  for (const [point, straight] of [[options.start, options.startStraightMm], [options.end, options.endStraightMm]] as const) {
    for (const delta of [-step, step, -straight - radius, straight + radius]) {
      xs.push(point.x + delta); ys.push(point.y + delta);
    }
  }
  for (const box of obstacles) { xs.push(box.minX, box.maxX); ys.push(box.minY, box.maxY); }
  xs.push(Math.min(...xs) - step, Math.max(...xs) + step);
  ys.push(Math.min(...ys) - step, Math.max(...ys) + step);
  if (![...xs, ...ys].every(Number.isFinite)) return best;
  const unique = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
  const xValues = unique(xs); const yValues = unique(ys);
  const width = xValues.length; const height = yValues.length;
  if (width * height > gridCap) return best;
  const nodes = yValues.flatMap(y => xValues.map(x => ({ x, y })));
  const startNode = nodes.findIndex(point => point.x === options.start.x && point.y === options.start.y);
  const endNode = nodes.findIndex(point => point.x === options.end.x && point.y === options.end.y);
  const freeNode = nodes.map(point => !obstacles.some(box => inside(point, box)));
  const cost = new Float64Array(nodes.length * 4).fill(Infinity);
  const previous = new Int32Array(nodes.length * 4).fill(-1);
  const queue = new SearchQueue();
  const initialState = nodes.length * 4;
  queue.push({ state: initialState, cost: 0, priority: distance(options.start, options.end) });
  const endTravel = (endDirection + 2) % 4;

  for (let expanded = 0; expanded < searchCap; expanded += 1) {
    const current = queue.pop();
    if (!current) break;
    if (best && current.priority > best.objectiveMm + EPS) break;
    const initial = current.state === initialState;
    if (!initial && current.cost > cost[current.state]! + EPS) continue;
    const node = initial ? startNode : Math.floor(current.state / 4);
    const heading = initial ? incomingDirection : current.state % 4;
    const point = nodes[node]!;
    const column = node % width; const row = Math.floor(node / width);
    for (let direction = 0; direction < 4; direction += 1) {
      if ((initial && startDirection >= 0 && direction !== startDirection)
        || (heading >= 0 && (direction === (heading + 2) % 4 || (!initial && direction === heading)))) continue;
      const turn = heading >= 0 && heading !== direction;
      const delta = DIRECTIONS[direction]!;
      for (let x = column + delta.x, y = row + delta.y; x >= 0 && x < width && y >= 0 && y < height; x += delta.x, y += delta.y) {
        const targetNode = y * width + x;
        if (!freeNode[targetNode] || !freeSegment(point, nodes[targetNode]!)) break;
        const final = targetNode === endNode;
        if (final && direction !== endTravel) continue;
        const length = distance(point, nodes[targetNode]!);
        const required = initial && final ? Math.max(options.startStraightMm, options.endStraightMm) + (turn ? radius : 0)
          : (initial ? options.startStraightMm + (turn ? radius : 0) : radius)
            + (final ? options.endStraightMm : radius);
        if (length < EPS || length + EPS < required) continue;
        const nextCost = current.cost + length + (turn ? bendPenalty : 0);
        const priority = nextCost + distance(nodes[targetNode]!, options.end);
        if (best && priority > best.objectiveMm + EPS) continue;
        if (final) {
          // Keep arrivals from distinct approach lanes. A rejected cheaper goal
          // must not label the terminal state as solved and suppress a valid
          // detour on the other side of equipment or an existing pipe network.
          const points: Point2D[] = [{ ...options.end }];
          let state = initial ? -1 : current.state;
          while (state >= 0) { points.push(nodes[Math.floor(state / 4)]!); state = previous[state]!; }
          points.push({ ...options.start }); points.reverse();
          if (!hasSelfIntersection(points) && accepted(points)) {
            const candidate = assess(points);
            if (!best || candidate.objectiveMm < best.objectiveMm - EPS
              || (Math.abs(candidate.objectiveMm - best.objectiveMm) < EPS && candidate.bends < best.bends)) best = candidate;
          }
          continue;
        }
        const state = targetNode * 4 + direction;
        if (nextCost >= cost[state]! - EPS) continue;
        cost[state] = nextCost; previous[state] = initial ? -1 : current.state;
        queue.push({ state, cost: nextCost, priority });
      }
    }
  }
  return best;
}
