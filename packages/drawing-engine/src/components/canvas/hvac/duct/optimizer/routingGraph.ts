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
 * A system spanning rooms may pass through the interior walls between them:
 * an edge blocked by nothing but one such wall, square to it, crosses it. It
 * keeps the straight it has either side of the wall (the router keeps the
 * fittings that far off it), and the crossing's price (its sleeve, and a fire
 * damper where the policy puts one). Nodes inside walls stay dropped, so no
 * elbow, take-off or split sits in a wall.
 *
 * Directions: 0 = +x, 1 = +y, 2 = −x, 3 = −y; left of d is (d + 1) mod 4 (the
 * local frame is a rotation of the plan, so left is left in plan too).
 */
import type { Point2D } from '../../../../../types';
import { flexClear, flexOk, toWorld, type ServiceCtx, type TerminalCtx } from '../ductAutoContext';
import type { DuctWall } from '../ductBuilding';
import { flexBendLossPa } from '../ductPressure';

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
  /** Additional curved-flex loss when geometry is known; absent on legacy/synthetic graphs. */
  flexBendLossPa?: number;
  /** Which of the terminal's spigot sides it serves (index into `terminalVariants`). */
  variant: number;
}

/** The spigot sides the router may use for a terminal (its placed side when it has no alternatives). */
export function terminalVariants(terminal: TerminalCtx): TerminalCtx[] {
  return terminal.variants?.length ? terminal.variants : [terminal];
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
  /** Per node: the distance to the nearest obstacle in any direction (the room a corner or a split there has, mm). */
  nodeClear: Float64Array;
  /** Per terminal (the service's order): where its rigid branch may end. */
  leaves: LeafCandidate[][];
  /** Candidate roots on the collar's axis: the node where the fan-outlet straight ends, and its length. */
  roots: Array<{ node: number; outletMm: number }>;
  /**
   * Per node and direction, an edge through a wall: the wall (index into
   * `crossWalls`; −1 none), the crossing's price, and the straight the edge
   * keeps before and after the wall (a fire damper's sleeve taken off; mm).
   * Absent: no edge passes through a wall.
   */
  cross?: Int32Array;
  crossCost?: Float64Array;
  crossBefore?: Float64Array;
  crossAfter?: Float64Array;
  crossWalls?: string[];
}

interface Box { minX: number; maxX: number; minY: number; maxY: number; id?: string }

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
    .map((box) => ({ minX: box.minX, maxX: box.maxX, minY: box.minY, maxY: box.maxY, ...(box.id ? { id: box.id } : {}) }));
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
  const leafPoints: Array<Array<{ point: Point2D; heading: number; variant: number }>> = terminals.map((terminal: TerminalCtx) => {
    const out: Array<{ point: Point2D; heading: number; variant: number }> = [];
    terminalVariants(terminal).forEach((spigot, variant) => {
      const n = spigot.normal;
      const t = { x: -n.y, y: n.x };
      for (const reach of FRONT_REACH_MM) out.push({ point: { x: spigot.lip.x + n.x * reach, y: spigot.lip.y + n.y * reach }, heading: headingOf({ x: -n.x, y: -n.y }), variant });
      for (const side of [1, -1]) {
        for (const reach of SIDE_REACH_MM) {
          out.push({
            point: { x: spigot.lip.x + n.x * (spigot.neck + 250) + t.x * side * reach, y: spigot.lip.y + n.y * (spigot.neck + 250) + t.y * side * reach },
            heading: headingOf({ x: -side * t.x, y: -side * t.y }), variant,
          });
        }
      }
    });
    return out;
  });

  // Roots: the full fan-outlet straight, a shortened one, and longer ones that leave room for a collar transition.
  const floor = Math.ceil(minOutletMm / 50) * 50;
  const turnAt = Math.ceil(turnOutletMm / 50) * 50;
  const rootXs = [...new Set([600, fanOutletMm, fanOutletMm + 600, fanOutletMm + 1200, floor, turnAt].map((x) => Math.round(Math.max(x, floor))))];
  // Turning first at the collar's own section (an obstacle on the axis close ahead): a root just short of it,
  // the collar elbow's half and the clearance off its face, and long enough for the connector and that elbow.
  const collarHalf = ctx.port.widthMm / 2 + model.costContext.insulationMm;
  const connectorMm = ctx.settings.flexibleConnectorAtUnit ? ctx.settings.connectorFabricMm + 2 * ctx.settings.connectorMetalMm : 0;
  const turnFloor = connectorMm + model.elbowSetbackMm({ widthMm: ctx.port.widthMm, heightMm: ctx.port.heightMm }) + ctx.settings.elbowNeckMm + 25;
  const turnXs = boxes
    .filter((box) => box.minX > 0 && box.minY < collarHalf + ROUTE_CLEARANCE_MM && box.maxY > -(collarHalf + ROUTE_CLEARANCE_MM))
    .map((box) => Math.floor((box.minX - collarHalf - ROUTE_CLEARANCE_MM) / 10) * 10)
    .filter((x) => x >= turnFloor && x < floor);
  const xsRaw: number[] = [0, ...rootXs, ...turnXs];
  // Turning first, the trunk runs on a line the turn's straight reaches (either side of the axis).
  const turnReach = turnXs.length ? Math.ceil(model.turnFirstReachMm(ctx.airflowM3h, Math.max(...terminals.map((terminal) => terminal.neck))) / 50) * 50 : 0;
  const ysRaw: number[] = [0, ...(turnReach ? [turnReach, -turnReach] : [])];
  for (const points of leafPoints) {
    for (const { point } of points) {
      xsRaw.push(point.x);
      ysRaw.push(point.y);
    }
  }
  const keepX = new Set(leafPoints.flatMap((points) => points.map((entry) => Math.round(entry.point.x))));
  const keepY = new Set(leafPoints.flatMap((points) => points.map((entry) => Math.round(entry.point.y))));
  const mustX = new Set([0, ...rootXs, ...turnXs]);
  const mustY = new Set([0, ...(turnReach ? [turnReach, -turnReach] : [])]);
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
  // A corner or a split occupies the section's half-width round its node in every direction.
  const nodeClear = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
  for (let node = 0; node < count; node += 1) {
    for (const box of boxes) {
      const dx = Math.max(box.minX - nodeXs[node]!, 0, nodeXs[node]! - box.maxX);
      const dy = Math.max(box.minY - nodeYs[node]!, 0, nodeYs[node]! - box.maxY);
      nodeClear[node] = Math.min(nodeClear[node]!, Math.max(dx, dy));
    }
  }
  const neighbour = new Int32Array(count * 4).fill(-1);
  const edgeLength = new Float64Array(count * 4);
  const corridor = new Float64Array(count * 4);
  // The walls a system spanning rooms may pass through, and the edges that do.
  const crossable = new Map<string, DuctWall>();
  if (ctx.crossing) for (const wall of ctx.walls ?? []) crossable.set(wall.id, wall);
  const cross = crossable.size ? new Int32Array(count * 4).fill(-1) : null;
  const crossCost = cross ? new Float64Array(count * 4) : null;
  const crossBefore = cross ? new Float64Array(count * 4) : null;
  const crossAfter = cross ? new Float64Array(count * 4) : null;
  const crossWalls: string[] = [];
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
        let crossed: { box: Box; wall: DuctWall } | null = null;
        const horizontal = a.y === b.y;
        const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
        const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
        for (const box of boxes) {
          const from = horizontal ? box.minX : box.minY;
          const to = horizontal ? box.maxX : box.maxY;
          if (hi <= from || lo >= to) continue;
          const at = horizontal ? a.y : a.x;
          const low = horizontal ? box.minY : box.minX;
          const high = horizontal ? box.maxY : box.maxX;
          const gap = at < low ? low - at : at > high ? at - high : 0;
          if (gap < ROUTE_CLEARANCE_MM) {
            // Through a wall it may pass: square to it (the edge spans its thickness), and only one.
            const wall = box.id ? crossable.get(box.id) : undefined;
            if (wall && !crossed && Math.abs(to - from - wall.thicknessMm) < 1 && lo < from && hi > to) {
              crossed = { box, wall };
              continue;
            }
            blocked = true;
            break;
          }
          free = Math.min(free, gap);
        }
        if (blocked) continue;
        if (crossed) {
          const { box, wall } = crossed;
          const half = wall.thicknessMm / 2;
          const at = horizontal ? a.y : a.x;
          // Through the wall, not past its end: the duct's half and clearance stay inside its length.
          const endGap = horizontal ? Math.min(at - (box.minY + half), box.maxY - half - at) : Math.min(at - (box.minX + half), box.maxX - half - at);
          const point = horizontal ? { x: (box.minX + box.maxX) / 2, y: at } : { x: at, y: (box.minY + box.maxY) / 2 };
          if (endGap <= ROUTE_CLEARANCE_MM || !ctx.crossing!.allows(wall, toWorld(ctx.frame, point))) continue;
          free = Math.min(free, endGap);
          const forward = d === 0 || d === 1;
          const [near, far] = horizontal ? (forward ? [box.minX, box.maxX] : [box.maxX, box.minX]) : (forward ? [box.minY, box.maxY] : [box.maxY, box.minY]);
          const start = horizontal ? a.x : a.y;
          const end = horizontal ? b.x : b.y;
          // A fire damper's sleeve stands out of each face: the straight either side is that much shorter.
          const sleeve = ctx.crossing!.fireDamper(wall) ? ctx.settings.fireDamperSleeveExtensionMm : 0;
          let index = crossWalls.indexOf(wall.id);
          if (index < 0) index = crossWalls.push(wall.id) - 1;
          cross![node * 4 + d] = index;
          crossCost![node * 4 + d] = ctx.crossing!.price(wall);
          crossBefore![node * 4 + d] = Math.max(0, Math.abs(near - start) - sleeve);
          crossAfter![node * 4 + d] = Math.max(0, Math.abs(end - far) - sleeve);
        }
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
  // Leaves whose runout fits (bend radius and length) as the planner will curve it, clear of other equipment.
  const leaves: LeafCandidate[][] = terminals.map((terminal, index) => {
    const out: LeafCandidate[] = [];
    const variants = terminalVariants(terminal);
    for (const { point, heading, variant } of leafPoints[index]!) {
      const node = nodeOf(point);
      if (node < 0 || heading < 0) continue;
      const spigot = variants[variant]!;
      const end = { x: nodeXs[node]!, y: nodeYs[node]! };
      const fit = model.flexRunoutCurve(end, DIRECTIONS[heading]!, spigot);
      if (!flexOk(fit, spigot, ctx.settings) || !flexClear(ctx, end, DIRECTIONS[heading]!, ctx.bottomZ, spigot)) continue;
      if (!out.some((leaf) => leaf.node === node && leaf.heading === heading && leaf.variant === variant)) out.push({
        node, heading, flexLengthMm: fit.lengthMm, flexBendLossPa: flexBendLossPa(fit.points, spigot.neck, spigot.airflowM3h), variant,
      });
    }
    return out;
  });
  // Roots: every axis line the straight off the collar reaches without touching an obstacle — the
  // collar's width over its connector and transition, the narrowest trunk after that — and no
  // shorter than the floor. (A diffuser on the axis ends the straight before it.)
  const narrowest = model.trunkOptions(ctx.airflowM3h).reduce((least, leg) => Math.min(least, leg.widthMm), ctx.port.widthMm);
  const trunkHalf = narrowest / 2 + model.costContext.insulationMm;
  const transitionReach = Math.max(floor, 800);
  const straightClear = (x: number) => boxes.every((box) => {
    if (box.maxX <= 0 || box.minX >= x) return true;
    const near = box.minX < transitionReach ? collarHalf : trunkHalf;
    const half = Math.max(near, trunkHalf) + ROUTE_CLEARANCE_MM;
    return box.minY >= half || box.maxY <= -half;
  });
  const roots: Array<{ node: number; outletMm: number }> = [];
  for (const candidate of [...rootXs, ...turnXs, ...xs.filter((x) => x >= floor - 1)]) {
    const node = nodeOf({ x: candidate, y: 0 });
    if (node < 0 || roots.some((root) => root.node === node)) continue;
    const outletMm = Math.round(nodeXs[node]!);
    const least = turnXs.includes(outletMm) ? turnFloor : floor;
    if (outletMm >= least - 1 && straightClear(outletMm)) roots.push({ node, outletMm });
  }
  return {
    xs, ys, nodeX: Float64Array.from(nodeXs), nodeY: Float64Array.from(nodeYs), nodeCount: count,
    neighbour, edgeLength, corridor, nodeClear, leaves, roots,
    ...(cross && crossWalls.length ? { cross, crossCost: crossCost!, crossBefore: crossBefore!, crossAfter: crossAfter!, crossWalls } : {}),
  };
}
