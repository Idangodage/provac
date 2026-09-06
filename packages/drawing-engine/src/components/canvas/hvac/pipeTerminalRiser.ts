import type { Point2D } from '../../../types';

import { resolveCopperSocketElbow } from './copperSocketElbows';
import { findSampledQuarterTurns } from './pipeRiserCornerProjection';
import type { PipeRoute3dConnectionOptions, PipeRouteNode3D } from './pipeRoute3d';

const EPS = 1e-6;
const distance = (a: Point2D, b: Point2D) => Math.hypot(b.x - a.x, b.y - a.y);

interface SampledTurn { startIndex: number; endIndex: number; corner: Point2D }

/** Detection-only tangent intersections for the standard 45-degree cups in
 * a port-spacing offset. Original arc samples are never replaced in the plan. */
function sampledFortyFiveTurns(plan: readonly Point2D[], quarters: SampledTurn[]): SampledTurn[] {
  const turns: SampledTurn[] = [];
  const blocked = new Set(quarters.flatMap(arc => Array.from({ length: arc.endIndex - arc.startIndex + 1 }, (_, i) => arc.startIndex + i)));
  const cross = (a: Point2D, b: Point2D) => a.x * b.y - a.y * b.x;
  const unit = (a: Point2D, b: Point2D) => {
    const length = distance(a, b);
    return length > EPS ? { x: (b.x - a.x) / length, y: (b.y - a.y) / length } : null;
  };
  for (let start = 1; start < plan.length - 3; start += 1) {
    if (blocked.has(start)) continue;
    const entry = plan[start]!; const incoming = unit(plan[start - 1]!, entry);
    if (!incoming) continue;
    for (let end = start + 2; end < Math.min(plan.length - 1, start + 129); end += 1) {
      if (blocked.has(end)) break;
      const exit = plan[end]!; const outgoing = unit(exit, plan[end + 1]!);
      if (!outgoing || Math.abs(incoming.x * outgoing.x + incoming.y * outgoing.y - Math.SQRT1_2) > EPS) continue;
      const turn = cross(incoming, outgoing); const delta = { x: exit.x - entry.x, y: exit.y - entry.y };
      const before = cross(delta, outgoing) / turn; const after = cross(incoming, delta) / turn;
      const radius = before / Math.tan(Math.PI / 8); const tolerance = Math.max(1e-5, radius * 1e-6);
      if (before <= EPS || Math.abs(before - after) > tolerance) continue;
      const sign = Math.sign(turn);
      const center = { x: entry.x - incoming.y * radius * sign, y: entry.y + incoming.x * radius * sign };
      const startRadial = { x: entry.x - center.x, y: entry.y - center.y };
      let previous = 0; let circular = true;
      for (let index = start + 1; index < end; index += 1) {
        const radial = { x: plan[index]!.x - center.x, y: plan[index]!.y - center.y };
        const angle = Math.atan2(cross(startRadial, radial) * sign, startRadial.x * radial.x + startRadial.y * radial.y);
        if (Math.abs(Math.hypot(radial.x, radial.y) - radius) > tolerance
          || angle <= previous + EPS || angle >= Math.PI / 4 - EPS) { circular = false; break; }
        previous = angle;
      }
      if (!circular) continue;
      turns.push({ startIndex: start, endIndex: end, corner: { x: entry.x + incoming.x * before, y: entry.y + incoming.y * before } });
      start = end;
      break;
    }
  }
  return turns;
}

/** Recognize the short tangent two-arc offset supplied by the paired socket
 * adapter. An arbitrary diagonal or custom curve is never skipped. Every
 * original sample remains in the route; this only locates its field end. */
function portGatherExit(plan: readonly Point2D[], fromEnd: boolean, radius: number, portStraight: number): number | null {
  const points = fromEnd ? [...plan].reverse() : plan;
  if (points.length < 7) return null;
  const first = points[0]!; const initialLength = distance(first, points[1]!);
  if (initialLength <= EPS) return null;
  const direction = { x: (points[1]!.x - first.x) / initialLength, y: (points[1]!.y - first.y) / initialLength };
  const project = (point: Point2D, origin: Point2D) => ({
    x: (point.x - origin.x) * direction.x + (point.y - origin.y) * direction.y,
    y: -(point.x - origin.x) * direction.y + (point.y - origin.y) * direction.x,
  });
  let entry = 1;
  while (entry + 1 < points.length && Math.abs(project(points[entry + 1]!, first).y) <= EPS
    && project(points[entry + 1]!, points[entry]!).x > EPS) entry += 1;
  if (project(points[entry]!, first).x < portStraight - EPS) return null;
  for (let end = entry + 4; end < Math.min(points.length - 1, entry + 129); end += 1) {
    const delta = project(points[end]!, points[entry]!);
    const next = project(points[end + 1]!, points[end]!);
    if (next.x <= EPS || Math.abs(next.y) > EPS * next.x || Math.abs(delta.y) <= EPS
      || delta.x < Math.abs(delta.y) - EPS || delta.x > radius * 2 + EPS || Math.abs(delta.y) > radius * 2 + EPS) continue;
    const arcRadius = (delta.x * delta.x + delta.y * delta.y) / (4 * Math.abs(delta.y));
    const signedRadius = Math.sign(delta.y) * arcRadius;
    const tolerance = Math.max(1e-5, arcRadius * 1e-6);
    let previousX = -Infinity; let previousY = -Infinity; let firstArcSamples = 0; let secondArcSamples = 0;
    let matched = true;
    for (let index = entry; index <= end; index += 1) {
      const sample = project(points[index]!, points[entry]!);
      const onFirstArc = sample.x <= delta.x / 2;
      const cx = onFirstArc ? 0 : delta.x; const cy = onFirstArc ? signedRadius : delta.y - signedRadius;
      if (sample.x < previousX - tolerance || sample.y * Math.sign(delta.y) < previousY - tolerance
        || Math.abs(Math.hypot(sample.x - cx, sample.y - cy) - arcRadius) > tolerance) { matched = false; break; }
      if (index > entry && index < end) {
        if (onFirstArc) firstArcSamples += 1; else secondArcSamples += 1;
      }
      previousX = sample.x; previousY = sample.y * Math.sign(delta.y);
    }
    if (matched && firstArcSamples >= 2 && secondArcSamples >= 2) return fromEnd ? plan.length - 1 - end : end;
  }
  return null;
}

/** Combine an automatically supplied terminal level adapter with the first
 * direction change. Explicit elevation guides remain authoritative. Only an
 * exact quarter turn qualifies; arbitrary gathers are never straightened. */
export function planTerminalCornerRisers(
  plan: readonly Point2D[], guide: readonly PipeRouteNode3D[],
  options: PipeRoute3dConnectionOptions,
  radius: number, portStraight: number, branchStraight: number,
): { plan: readonly Point2D[]; guide: readonly PipeRouteNode3D[] } {
  const unchanged = { plan, guide };
  const level = guide[0]?.z;
  if (level === undefined || !Number.isFinite(level) || plan.length < 3 || radius <= EPS
    || !guide.every(node => Math.abs(node.z - level) <= EPS)) return unchanged;
  if (![options.startConnection, options.endConnection].some(connection =>
    connection?.connectionKind === 'unit-port' && Number.isFinite(connection.elevationMm)
    && Math.abs(connection.elevationMm - level) >= 2 * radius - EPS)) return unchanged;
  const quarters = findSampledQuarterTurns(plan);
  const arcs = new Map([...quarters, ...sampledFortyFiveTurns(plan, quarters)].map(arc => [arc.startIndex, arc]));
  const vertices: Array<{ point: Point2D; from: number; to: number }> = [];
  for (let index = 0; index < plan.length; index += 1) {
    const arc = arcs.get(index);
    vertices.push(arc ? { point: arc.corner, from: arc.startIndex, to: arc.endIndex }
      : { point: plan[index]!, from: index, to: index });
    if (arc) index = arc.endIndex;
    while (vertices.length >= 3) {
      const a = vertices.at(-3)!.point; const b = vertices.at(-2)!.point; const c = vertices.at(-1)!.point;
      const ab = distance(a, b); const bc = distance(b, c);
      if (ab < EPS || bc < EPS) { vertices.splice(vertices.length - 2, 1); continue; }
      if (Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) > EPS * ab * bc
        || (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) <= 0) break;
      vertices.splice(vertices.length - 2, 1);
    }
  }
  if (vertices.length < 3) return unchanged;
  const terminalCorner = (fromEnd: boolean): { index: number; precedingTakeoffMm: number } => {
    const ordinary = fromEnd ? vertices.length - 2 : 1;
    // A standard 45 + 45 port offset can contain sharp or sampled cup bends.
    // It advances diagonally once and returns to the original socket axis.
    const ordered = fromEnd ? [...vertices].reverse() : vertices;
    if (ordered.length >= 5) {
      const a = ordered[0]!.point; const b = ordered[1]!.point; const c = ordered[2]!.point; const d = ordered[3]!.point;
      const first = distance(a, b); const diagonal = distance(b, c); const field = distance(c, d);
      if (first >= portStraight - EPS && diagonal > EPS && diagonal <= radius * 2 * Math.SQRT2 + EPS && field > EPS) {
        const u = { x: (b.x - a.x) / first, y: (b.y - a.y) / first };
        const v = { x: (c.x - b.x) / diagonal, y: (c.y - b.y) / diagonal };
        const w = { x: (d.x - c.x) / field, y: (d.y - c.y) / field };
        if (Math.abs(u.x * v.x + u.y * v.y - Math.SQRT1_2) <= EPS
          && Math.hypot(u.x - w.x, u.y - w.y) <= EPS) {
          const preceding = ordered[2]!;
          const tangent = plan[fromEnd ? preceding.from : preceding.to]!;
          const socket = options.pipeDiameterMm === undefined ? null : resolveCopperSocketElbow(options.pipeDiameterMm, 45);
          return { index: fromEnd ? vertices.length - 4 : 3,
            precedingTakeoffMm: Math.max(distance(c, tangent), socket?.centerToFaceMm ?? radius * Math.tan(Math.PI / 8)) };
        }
      }
    }
    const exit = portGatherExit(plan, fromEnd, radius, portStraight);
    if (exit === null) return { index: ordinary, precedingTakeoffMm: portStraight };
    let index = vertices.findIndex(vertex => vertex.from > exit);
    if (fromEnd) {
      index = vertices.length - 1;
      while (index >= 0 && vertices[index]!.to >= exit) index -= 1;
    }
    return index > 0 && index < vertices.length - 1 ? { index, precedingTakeoffMm: 0 }
      : { index: ordinary, precedingTakeoffMm: portStraight };
  };
  const selected = new Map<number, { level: number; fromEnd: boolean }>();
  const terminalStraight = (connection: PipeRoute3dConnectionOptions['startConnection']) => !connection ? 0
    : connection.connectionKind === 'unit-port' ? portStraight : branchStraight;
  for (const fromEnd of [false, true]) {
    const connection = fromEnd ? options.endConnection : options.startConnection;
    const other = fromEnd ? options.startConnection : options.endConnection;
    if (connection?.connectionKind !== 'unit-port' || !Number.isFinite(connection.elevationMm)
      || Math.abs(connection.elevationMm - level) < 2 * radius - EPS) continue;
    const { index, precedingTakeoffMm } = terminalCorner(fromEnd);
    if (selected.has(index)) continue;
    const corner = vertices[index]!.point;
    const terminal = vertices[fromEnd ? index + 1 : index - 1]!.point;
    const departure = vertices[fromEnd ? index - 1 : index + 1]!.point;
    const before = distance(terminal, corner); const after = distance(corner, departure);
    // A recognized gather already reserved the port straight. Keep its exit
    // cup/tangent clear of the field elbow rather than adding another stub.
    if (before < precedingTakeoffMm + radius - EPS || after <= EPS
      || Math.abs((corner.x - terminal.x) * (departure.x - corner.x)
        + (corner.y - terminal.y) * (departure.y - corner.y)) > EPS * before * after) continue;
    const endsAfterCorner = fromEnd ? index === 1 : index === vertices.length - 2;
    // Keep the opposite socket's straight and any separate adapter outside
    // this fitting. Adjacent corners need both full bend takeoffs.
    const otherNeedsRise = other?.connectionKind === 'unit-port'
      && Math.abs(other.elevationMm - level) > EPS;
    const afterRequired = endsAfterCorner
      ? radius + terminalStraight(other) + (otherNeedsRise ? 2 * radius : 0)
      : 2 * radius;
    if (after < afterRequired - EPS) continue;
    selected.set(index, { level: connection.elevationMm, fromEnd });
  }
  if (!selected.size) return unchanged;
  const replacements = [...selected].map(([index, value]) => ({ ...vertices[index]!, ...value }));
  const nextPlan: Point2D[] = [];
  const nextGuide: PipeRouteNode3D[] = [];
  const startLevel = replacements.find(value => !value.fromEnd)?.level ?? level;
  let z = startLevel;
  for (let index = 0; index < plan.length; index += 1) {
    const replacement = replacements.find(value => value.from === index);
    const point = replacement?.point ?? plan[index]!;
    nextPlan.push(point);
    nextGuide.push({ ...point, z });
    if (replacement) {
      z = replacement.fromEnd ? replacement.level : level;
      nextGuide.push({ ...point, z });
      index = replacement.to;
    }
  }
  return { plan: nextPlan, guide: nextGuide };
}
