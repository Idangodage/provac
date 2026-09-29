/**
 * The escape grid the tree router searches, in the collar's local frame (x
 * along the collar's normal, y across; the collar lip at the origin). Grid
 * lines pass through the source axis and the fan-outlet points, every
 * terminal's runout candidates and the edges of the obstacles at duct level,
 * so an optimal rectilinear route runs along them (the Hanan-grid argument,
 * with obstacles). A node inside an obstacle is dropped; each edge keeps its
 * free corridor (the distance to the nearest obstacle beside it), so a duct
 * is only routed where its size fits.
 *
 * Directions: 0 = +x, 1 = +y, 2 = −x, 3 = −y; left of d is (d + 1) mod 4 (the
 * local frame is a rotation of the plan, so left is left in plan too).
 */
import type { Point2D } from '../../../../../types';
import { flexFit, flexOk, type ServiceCtx, type TerminalCtx } from '../ductAutoContext';

import type { SizingModel } from './sizingModel';

export const DIRECTIONS: readonly Point2D[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
export const leftOf = (d: number) => (d + 1) % 4;
export const rightOf = (d: number) => (d + 3) % 4;
export const reverseOf = (d: number) => (d + 2) % 4;

/** Kept between a duct and an obstacle (mm, practice). */
export const ROUTE_CLEARANCE_MM = 50;
/** Grid lines closer than this are merged (mm). */
const MERGE_MM = 100;
/** Grid lines per axis at most (the router's cost grows with the node count). */
const MAX_LINES = 30;
/** Runout lengths tried in front of a spigot, and sideways approaches (mm, practice). */
const FRONT_REACH_MM = [600, 800, 1000];
const SIDE_REACH_MM = [700, 1000];

export interface LeafCandidate {
  node: number;
  /** Heading the rigid branch arrives with (towards the terminal). */
  heading: number;
  flexLengthMm: number;
}

export interface RoutingGraph {
  xs: number[];
  ys: number[];
  nodeX: Float64Array;
  nodeY: Float64Array;
  nodeCount: number;
  /** Per node and direction: the neighbour (−1 none), the edge's length and its free corridor half-width (mm). */
  neighbour: Int32Array;
  edgeLength: Float64Array;
  corridor: Float64Array;
  /** Per terminal (the service's order): where its rigid branch may end. */
  leaves: LeafCandidate[][];
  /** Candidate roots on the collar's axis: the node where the fan-outlet straight ends, and its length. */
  roots: Array<{ node: number; outletMm: number }>;
}

interface Box { minX: number; maxX: number; minY: number; maxY: number }

/** Merges lines closer than MERGE_MM, keeping the more important one: `must` (the source axis, the roots), then `keep` (the runout lines). */
function mergeLines(values: number[], keep: ReadonlySet<number>, must: ReadonlySet<number>): number[] {
  const rank = (value: number) => (must.has(value) ? 2 : keep.has(value) ? 1 : 0);
  const sorted = [...new Set([...values, ...must].map((value) => Math.round(value)))].sort((a, b) => a - b);
  const out: number[] = [];
  for (const value of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && value - last < MERGE_MM) {
      if (rank(value) > rank(last)) out[out.length - 1] = value;
      continue;
    }
    out.push(value);
  }
  return out;
}

function limitLines(values: number[], keep: ReadonlySet<number>, around: readonly number[], must: ReadonlySet<number>): number[] {
  if (values.length <= MAX_LINES) return values;
  const kept = values.filter((value) => keep.has(value) || must.has(value));
  const rest = values.filter((value) => !keep.has(value) && !must.has(value))
    .sort((a, b) => Math.min(...around.map((c) => Math.abs(a - c))) - Math.min(...around.map((c) => Math.abs(b - c))));
  return [...kept, ...rest.slice(0, Math.max(0, MAX_LINES - kept.length))].sort((a, b) => a - b);
}

/** Obstacles at the duct's level, in the local frame, unpadded (the unit itself is behind the collar). */
function levelObstacles(ctx: ServiceCtx, bandMm: number): Box[] {
  const zMin = ctx.bottomZ;
  const zMax = ctx.bottomZ + bandMm;
  return ctx.obstacles
    .filter((box) => box.id !== ctx.unitId && box.zMax > zMin && box.zMin < zMax)
    .map((box) => ({ minX: box.minX, maxX: box.maxX, minY: box.minY, maxY: box.maxY }));
}

/**
 * `minOutletMm`: the shortest straight off the collar that holds the flexible
 * connector, the collar transition and a take-off window; no root is shorter.
 */
export function buildRoutingGraph(ctx: ServiceCtx, model: SizingModel, fanOutletMm: number, minOutletMm = 0, turnOutletMm = 0): RoutingGraph {
  const terminals = ctx.terminals;
  const boxes = levelObstacles(ctx, Math.min(model.maxHeightMm, 350));
  const inside = (x: number, y: number, pad: number) => boxes.some((box) => x > box.minX - pad && x < box.maxX + pad && y > box.minY - pad && y < box.maxY + pad);

  // Leaf candidates: in front of each spigot (arriving along its axis) and to either side (the flex turns in).
  const headingOf = (v: Point2D) => DIRECTIONS.findIndex((d) => d.x === Math.round(v.x) && d.y === Math.round(v.y));
  const leafPoints: Array<Array<{ point: Point2D; heading: number }>> = terminals.map((terminal: TerminalCtx) => {
    const n = terminal.normal;
    const t = { x: -n.y, y: n.x };
    const out: Array<{ point: Point2D; heading: number }> = [];
    for (const reach of FRONT_REACH_MM) out.push({ point: { x: terminal.lip.x + n.x * reach, y: terminal.lip.y + n.y * reach }, heading: headingOf({ x: -n.x, y: -n.y }) });
    for (const side of [1, -1]) {
      for (const reach of SIDE_REACH_MM) {
        out.push({
          point: { x: terminal.lip.x + n.x * (terminal.neck + 250) + t.x * side * reach, y: terminal.lip.y + n.y * (terminal.neck + 250) + t.y * side * reach },
          heading: headingOf({ x: -side * t.x, y: -side * t.y }),
        });
      }
    }
    return out;
  });

  // Roots: the full fan-outlet straight, a shortened one, and longer ones that leave room for a collar transition.
  const floor = Math.ceil(minOutletMm / 50) * 50;
  const turnAt = Math.ceil(turnOutletMm / 50) * 50;
  const rootXs = [...new Set([600, fanOutletMm, fanOutletMm + 600, fanOutletMm + 1200, floor, turnAt].map((x) => Math.round(Math.max(x, floor))))];
  const xsRaw: number[] = [0, ...rootXs];
  const ysRaw: number[] = [0];
  for (const points of leafPoints) {
    for (const { point } of points) {
      xsRaw.push(point.x);
      ysRaw.push(point.y);
    }
  }
  const keepX = new Set(leafPoints.flatMap((points) => points.map((entry) => Math.round(entry.point.x))));
  const keepY = new Set(leafPoints.flatMap((points) => points.map((entry) => Math.round(entry.point.y))));
  const mustX = new Set([0, ...rootXs]);
  const mustY = new Set([0]);
  const span = {
    minX: 0, maxX: Math.max(fanOutletMm, ...xsRaw) + 1000,
    minY: Math.min(0, ...ysRaw) - 1000, maxY: Math.max(0, ...ysRaw) + 1000,
  };
  // Lines beside the obstacles: a duct's half width plus the clearance off their faces.
  for (const box of boxes) {
    if (box.maxX < span.minX || box.minX > span.maxX || box.maxY < span.minY || box.minY > span.maxY) continue;
    const off = ROUTE_CLEARANCE_MM + 200;
    xsRaw.push(box.minX - off, box.maxX + off);
    ysRaw.push(box.minY - off, box.maxY + off);
  }
  const leafXs = leafPoints.flat().map((entry) => entry.point.x);
  const leafYs = leafPoints.flat().map((entry) => entry.point.y);
  const xs = limitLines(mergeLines(xsRaw.filter((x) => x >= 0 && x <= span.maxX), keepX, mustX), keepX, [0, ...leafXs], mustX);
  const ys = limitLines(mergeLines(ysRaw.filter((y) => y >= span.minY && y <= span.maxY), keepY, mustY), keepY, [0, ...leafYs], mustY);

  const nodeAt = new Int32Array(xs.length * ys.length).fill(-1);
  const nodeXs: number[] = [];
  const nodeYs: number[] = [];
  for (let i = 0; i < xs.length; i += 1) {
    for (let j = 0; j < ys.length; j += 1) {
      if (inside(xs[i]!, ys[j]!, ROUTE_CLEARANCE_MM)) continue;
      nodeAt[i * ys.length + j] = nodeXs.length;
      nodeXs.push(xs[i]!);
      nodeYs.push(ys[j]!);
    }
  }
  const count = nodeXs.length;
  const neighbour = new Int32Array(count * 4).fill(-1);
  const edgeLength = new Float64Array(count * 4);
  const corridor = new Float64Array(count * 4);
  for (let i = 0; i < xs.length; i += 1) {
    for (let j = 0; j < ys.length; j += 1) {
      const node = nodeAt[i * ys.length + j]!;
      if (node < 0) continue;
      const links: Array<[number, number, number]> = [[0, i + 1, j], [1, i, j + 1], [2, i - 1, j], [3, i, j - 1]];
      for (const [d, ni, nj] of links) {
        if (ni < 0 || nj < 0 || ni >= xs.length || nj >= ys.length) continue;
        const other = nodeAt[ni * ys.length + nj]!;
        if (other < 0) continue;
        const a = { x: xs[i]!, y: ys[j]! };
        const b = { x: xs[ni]!, y: ys[nj]! };
        // The edge must not cross an obstacle; its corridor is the gap to the nearest one beside it.
        let free = Number.POSITIVE_INFINITY;
        let blocked = false;
        const horizontal = a.y === b.y;
        for (const box of boxes) {
          const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
          const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
          if (hi <= (horizontal ? box.minX : box.minY) || lo >= (horizontal ? box.maxX : box.maxY)) continue;
          const at = horizontal ? a.y : a.x;
          const low = horizontal ? box.minY : box.minX;
          const high = horizontal ? box.maxY : box.maxX;
          const gap = at < low ? low - at : at > high ? at - high : 0;
          if (gap < ROUTE_CLEARANCE_MM) { blocked = true; break; }
          free = Math.min(free, gap);
        }
        if (blocked) continue;
        neighbour[node * 4 + d] = other;
        edgeLength[node * 4 + d] = Math.hypot(b.x - a.x, b.y - a.y);
        corridor[node * 4 + d] = free;
      }
    }
  }
  const nodeOf = (point: Point2D) => {
    const i = xs.findIndex((x) => Math.abs(x - point.x) < MERGE_MM / 2);
    const j = ys.findIndex((y) => Math.abs(y - point.y) < MERGE_MM / 2);
    return i < 0 || j < 0 ? -1 : nodeAt[i * ys.length + j]!;
  };
  // Leaves whose runout fits (bend radius and length) as the planner will curve it.
  const leaves: LeafCandidate[][] = terminals.map((terminal, index) => {
    const out: LeafCandidate[] = [];
    for (const { point, heading } of leafPoints[index]!) {
      const node = nodeOf(point);
      if (node < 0 || heading < 0) continue;
      const fit = flexFit(ctx, { x: nodeXs[node]!, y: nodeYs[node]! }, DIRECTIONS[heading]!, ctx.bottomZ, terminal);
      if (!flexOk(fit, terminal, ctx.settings)) continue;
      if (!out.some((leaf) => leaf.node === node && leaf.heading === heading)) out.push({ node, heading, flexLengthMm: fit.lengthMm });
    }
    return out;
  });
  const roots = rootXs
    .map((outletMm) => ({ node: nodeOf({ x: outletMm, y: 0 }), outletMm }))
    .filter((root) => root.node >= 0);
  return {
    xs, ys, nodeX: Float64Array.from(nodeXs), nodeY: Float64Array.from(nodeYs), nodeCount: count,
    neighbour, edgeLength, corridor, leaves, roots,
  };
}
