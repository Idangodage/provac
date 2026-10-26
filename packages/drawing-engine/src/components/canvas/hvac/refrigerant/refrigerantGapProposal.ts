/**
 * Reconnecting a gap left by deleted refrigerant pieces: the ways to join what
 * is left, each judged before it is offered.
 *
 *  - As it was: the stretch deleted put back on every line of the gap (both
 *    lines of a coordinated pair), while the parts are where they were.
 *  - Shortest / fewest bends: the gas line (or the one line) routed between
 *    its open ends by the orthogonal router round what stands at the pipes'
 *    level (equipment and ducts; pipes pass partitions), with room for the
 *    bends; a pair's other line laid beside it at the pair's spacing, so the
 *    two stay together. Offered where the two ends are at one level.
 *  - A lone end (a port's stub deleted): back to its port, as it was.
 *
 * The joined line keeps the first part's id, its connections at both ends, its
 * accessories (they re-attach by where they were placed) and the other gaps it
 * still has. A way is offered only when it clashes with nothing the parts left
 * do not already clash with (a clash a line already had elsewhere is not the
 * way's). Best first: as it was while it is about as good. Pure.
 */
import type { HvacElement, Point2D } from '../../../../types';
import { boxOf, cardinalOf, corners, frame, planObstacles } from '../duct/ductCollarReroute';
import { resolveFieldPipeBendRadiusMm } from '../fieldPipeBends';
import { findNewNetworkPipeClashes } from '../networkPipeClearance';
import { findObstacleAwareOrthogonalRoute } from '../obstacleAwareOrthogonalRoute';
import { PIPE_DESIGN_PROPERTY, readPipeRouteNodes } from '../pipeDesignModel';
import { normalizePipeRouteNodes3d, type PipeRouteNode3D } from '../pipeRoute3d';
import {
  buildRefrigerantPipeElement,
  resolveRefrigerantPipeSpec,
  type RefrigerantPipeConnection,
  type RefrigerantPipeMaterial,
} from '../refrigerantPipePairModel';

import { readRefrigerantAccessories } from './refrigerantAccessories';
import { PIPE_GAP_PROPERTY, readPipeGaps, refrigerantOpenEnds, storedPipeConnection, type PipeGapRef, type PipeOpenEndRef } from './refrigerantCut';

export interface PipeGapCandidate {
  key: 'as-before' | 'shortest' | 'fewest' | 'port';
  label: string;
  updates: HvacElement[];
  removeIds: string[];
  /** The new stretch of the gas line (or the one line): centreline, length and bends. */
  bridge: PipeRouteNode3D[];
  /** The new stretch of every line the way joins (the gas line's first). */
  bridges: PipeRouteNode3D[][];
  lengthMm: number;
  elbows: number;
}

export interface PipeGapProposals {
  gapId: string;
  candidates: PipeGapCandidate[];
  reason: string | null;
  ends: Point2D[];
}

const AS_BEFORE_TOLERANCE = 1.1;
const BEND_PENALTY_MM = 600;
/** How near a drawn line's last point must be to the other part's open end to join it (the pipe tool welds it there). */
const WELD_MM = 1;

const near = (a: Point2D, b: Point2D, tolerance = 1) => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;

/**
 * Whether a line stores a 3D route of its own (else its 3D is derived from its plan route and its ports). A part
 * that stores one only to keep the level its line had (`levelKept`) does not: put back together, the line is
 * derived again.
 */
const hasStoredNodes = (element: HvacElement, end: 'start' | 'end') => normalizePipeRouteNodes3d(element.properties.routeNodes3d).length >= 2
  && !readPipeGaps(element)[end]?.levelKept;

/** A line's route nodes (its stored 3D route, else its plan route at its level). */
const nodesOf = (element: HvacElement): PipeRouteNode3D[] => readPipeRouteNodes(element);

/** A joined line's 3D route: stored when a part stored one, else left to be derived again (risers to its ports). */
function withNodes(properties: Record<string, unknown>, nodes: PipeRouteNode3D[], stored: boolean): void {
  if (stored) properties.routeNodes3d = nodes;
  else properties.routeNodes3d = undefined;
}

/** What is left of a line's gaps once `gapId` is closed at `end`. */
function remainingGaps(element: HvacElement, end: 'start' | 'end'): Record<string, PipeGapRef> | null {
  const gaps = readPipeGaps(element);
  const other = end === 'start' ? gaps.end : gaps.start;
  return other ? { [end === 'start' ? 'end' : 'start']: other } : null;
}

/**
 * A joined route without the points a cut left on a straight (or on a riser): a node goes where the way on is the
 * way in and the material is the same either side, so a straight put back is one straight again. Nothing else of
 * the route changes (a drawn route's own short steps stay), so a line put back as it was is the line it was.
 */
function tidy(nodes: readonly PipeRouteNode3D[], materials: readonly RefrigerantPipeMaterial[]): { nodes: PipeRouteNode3D[]; materials: RefrigerantPipeMaterial[] } {
  const outNodes: PipeRouteNode3D[] = [];
  const outMaterials: RefrigerantPipeMaterial[] = [];
  nodes.forEach((node, index) => {
    const last = outNodes[outNodes.length - 1];
    if (last && Math.hypot(node.x - last.x, node.y - last.y, node.z - last.z) < 1e-3) return;
    if (outNodes.length >= 2) {
      const before = outNodes[outNodes.length - 2]!;
      const u = { x: last!.x - before.x, y: last!.y - before.y, z: last!.z - before.z };
      const v = { x: node.x - last!.x, y: node.y - last!.y, z: node.z - last!.z };
      const lu = Math.hypot(u.x, u.y, u.z);
      const lv = Math.hypot(v.x, v.y, v.z);
      const material = materials[index - 1] ?? outMaterials[outMaterials.length - 1];
      if (lu > 1e-9 && lv > 1e-9 && (u.x * v.x + u.y * v.y + u.z * v.z) / (lu * lv) > 1 - 1e-7 && material === outMaterials[outMaterials.length - 1]) {
        outNodes[outNodes.length - 1] = { ...node };
        return;
      }
    }
    if (outNodes.length) outMaterials.push(materials[index - 1] ?? outMaterials[outMaterials.length - 1] ?? 'hard');
    outNodes.push({ ...node });
  });
  return { nodes: outNodes, materials: outMaterials };
}

/** One line from `a` (its end open), the stretch `via` and `b` (its start open): A's id, both ends' connections. */
function joinLines(a: HvacElement, b: HvacElement | null, via: readonly PipeRouteNode3D[], end: { connection: RefrigerantPipeConnection | null; nodes: PipeRouteNode3D[] } | null): HvacElement {
  const specA = resolveRefrigerantPipeSpec(a.properties);
  const specB = b ? resolveRefrigerantPipeSpec(b.properties) : null;
  const fill = specA.segmentMaterials[specA.segmentMaterials.length - 1] ?? 'hard';
  const nodesA = nodesOf(a);
  const tail = b ? nodesOf(b) : end?.nodes ?? [];
  const padded = (materials: readonly RefrigerantPipeMaterial[], count: number) => Array.from({ length: count }, (_, index) => materials[index] ?? fill);
  // Two parts that meet (a gap drawn by hand, its last point on the other part's open end) share that point.
  const last = nodesA[nodesA.length - 1];
  const welded = !via.length && Boolean(last && tail[0] && Math.hypot(tail[0].x - last.x, tail[0].y - last.y, tail[0].z - last.z) <= WELD_MM);
  const tidied = welded
    ? tidy([...nodesA, ...tail.slice(1)], [
      ...padded(specA.segmentMaterials, Math.max(0, nodesA.length - 1)),
      ...padded(specB?.segmentMaterials ?? [], Math.max(0, tail.length - 1)),
    ])
    : tidy([...nodesA, ...via, ...tail], [
      ...padded(specA.segmentMaterials, Math.max(0, nodesA.length - 1)),
      ...Array.from({ length: via.length + 1 }, () => fill),
      ...padded(specB?.segmentMaterials ?? [], Math.max(0, tail.length - 1)),
    ]);
  const nodes = tidied.nodes;
  const route = nodes.map(({ x, y }) => ({ x, y }));
  const materials = tidied.materials;
  const endConnection = b ? storedPipeConnection(b, 'end', specB!.endConnection) : end?.connection ?? null;
  const built = buildRefrigerantPipeElement(route, {
    lineKind: specA.lineKind, label: a.label, segmentMaterials: materials.slice(0, Math.max(0, route.length - 1)),
    pipeDiameterMm: specA.pipeDiameterMm, outerDiameterMm: specA.outerDiameterMm, insulationThicknessMm: specA.insulationThicknessMm,
    ...(specA.bundleId ? { bundleId: specA.bundleId } : {}), startConnection: storedPipeConnection(a, 'start', specA.startConnection), endConnection, elevationMm: a.elevation,
  });
  const properties: Record<string, unknown> = {
    ...a.properties, ...(built.properties ?? {}),
    ...(specA.bundleId ? { bundleId: specA.bundleId } : {}),
  };
  const bypasses = [...(Array.isArray(a.properties.bypasses) ? a.properties.bypasses : []), ...(b && Array.isArray(b.properties.bypasses) ? b.properties.bypasses : [])];
  if (bypasses.length) properties.bypasses = bypasses;
  else properties.bypasses = undefined;
  withNodes(properties, nodes, hasStoredNodes(a, 'end') && (!b || hasStoredNodes(b, 'start')));
  properties[PIPE_DESIGN_PROPERTY] = undefined;
  const accessories = [...readRefrigerantAccessories(a), ...(b ? readRefrigerantAccessories(b) : [])];
  if (accessories.length) properties.inlineAccessories = accessories;
  else properties.inlineAccessories = undefined;
  const gaps = { ...(remainingGaps(a, 'end') ?? {}), ...(b ? remainingGaps(b, 'start') ?? {} : {}) };
  if (Object.keys(gaps).length) properties[PIPE_GAP_PROPERTY] = gaps;
  else properties[PIPE_GAP_PROPERTY] = undefined;
  if (Object.prototype.hasOwnProperty.call(a.properties, 'authoredCenterlineRoute')) properties.authoredCenterlineRoute = route;
  return { ...a, ...built, id: a.id, properties } as HvacElement;
}

/** The start of a line put back: the stub deleted before its open start, and the connection it had. */
function prependStub(b: HvacElement, removed: readonly PipeRouteNode3D[], connection: RefrigerantPipeConnection | null): HvacElement {
  const spec = resolveRefrigerantPipeSpec(b.properties);
  const fill = spec.segmentMaterials[0] ?? 'hard';
  const nodesB = nodesOf(b);
  const tidied = tidy([...removed.slice(0, -1), ...nodesB], [
    ...Array.from({ length: Math.max(0, removed.length - 1) }, () => fill),
    ...Array.from({ length: Math.max(0, nodesB.length - 1) }, (_, index) => spec.segmentMaterials[index] ?? fill),
  ]);
  const nodes = tidied.nodes;
  const route = nodes.map(({ x, y }) => ({ x, y }));
  const built = buildRefrigerantPipeElement(route, {
    lineKind: spec.lineKind, label: b.label,
    segmentMaterials: tidied.materials.slice(0, Math.max(0, route.length - 1)),
    pipeDiameterMm: spec.pipeDiameterMm, outerDiameterMm: spec.outerDiameterMm, insulationThicknessMm: spec.insulationThicknessMm,
    ...(spec.bundleId ? { bundleId: spec.bundleId } : {}), startConnection: connection, endConnection: storedPipeConnection(b, 'end', spec.endConnection), elevationMm: b.elevation,
  });
  const properties: Record<string, unknown> = { ...b.properties, ...(built.properties ?? {}) };
  withNodes(properties, nodes, hasStoredNodes(b, 'start'));
  properties[PIPE_DESIGN_PROPERTY] = undefined;
  const gaps = remainingGaps(b, 'start');
  if (gaps) properties[PIPE_GAP_PROPERTY] = gaps;
  else properties[PIPE_GAP_PROPERTY] = undefined;
  return { ...b, ...built, id: b.id, properties } as HvacElement;
}

/** An orthogonal plan polyline offset sideways by `distance` (+: left of its way). */
function offsetPolyline(points: readonly Point2D[], distance: number): Point2D[] | null {
  const segments: Array<{ a: Point2D; b: Point2D; n: Point2D }> = [];
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 0.5) continue;
    const n = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
    segments.push({ a: { x: a.x + n.x * distance, y: a.y + n.y * distance }, b: { x: b.x + n.x * distance, y: b.y + n.y * distance }, n });
  }
  if (!segments.length) return null;
  const out: Point2D[] = [segments[0]!.a];
  for (let index = 1; index < segments.length; index += 1) {
    const p = segments[index - 1]!;
    const q = segments[index]!;
    const d1 = { x: p.b.x - p.a.x, y: p.b.y - p.a.y };
    const d2 = { x: q.b.x - q.a.x, y: q.b.y - q.a.y };
    const cross = d1.x * d2.y - d1.y * d2.x;
    if (Math.abs(cross) < 1e-9) { out.push(q.a); continue; }
    const t = ((q.a.x - p.a.x) * d2.y - (q.a.y - p.a.y) * d2.x) / cross;
    out.push({ x: p.a.x + d1.x * t, y: p.a.y + d1.y * t });
  }
  out.push(segments[segments.length - 1]!.b);
  return out;
}

/** Where `point` lies on the line from `a` through `b`: how far along it from `a`, how far off it, and `a`–`b`. */
function along(a: Point2D, b: Point2D, point: Point2D): { t: number; off: number; length: number } {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const u = length > 1e-9 ? { x: (b.x - a.x) / length, y: (b.y - a.y) / length } : { x: 1, y: 0 };
  const d = { x: point.x - a.x, y: point.y - a.y };
  return { t: d.x * u.x + d.y * u.y, off: Math.abs(d.x * -u.y + d.y * u.x), length };
}

/**
 * The corners of a pair's other line laid beside the lead's new stretch (`beside`, the stretch offset by the pair's
 * spacing), between that line's open end `from` and open start `to`: they need not be level with the lead's ends (a
 * bend's inner line is cut further along), only on the first and the last offset straights, each short of its corner
 * by a bend. Null when they are not.
 */
function besideCorners(beside: readonly Point2D[], from: Point2D, to: Point2D, bendMm: number): Point2D[] | null {
  const TOLERANCE = 6;
  if (beside.length < 2) return null;
  const n = beside.length;
  const head = along(beside[0]!, beside[1]!, from);
  if (head.off > TOLERANCE) return null;
  const tail = along(beside[n - 1]!, beside[n - 2]!, to);
  if (tail.off > TOLERANCE) return null;
  if (n === 2) return head.t < head.length - tail.t - TOLERANCE ? [] : null;
  if (head.t > head.length - bendMm + TOLERANCE || tail.t > tail.length - bendMm + TOLERANCE) return null;
  return beside.slice(1, -1).map((point) => ({ ...point }));
}

function measure(points: readonly PipeRouteNode3D[]): { lengthMm: number; elbows: number } {
  let lengthMm = 0;
  let elbows = 0;
  let heading: Point2D | null = null;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const plan = Math.hypot(b.x - a.x, b.y - a.y);
    lengthMm += Math.hypot(plan, b.z - a.z);
    if (plan < 0.5) continue;
    const direction = { x: (b.x - a.x) / plan, y: (b.y - a.y) / plan };
    if (heading && heading.x * direction.x + heading.y * direction.y < 1 - 1e-6) elbows += 1;
    heading = direction;
  }
  return { lengthMm, elbows };
}

/** The ways to reconnect the pipe gap `gapId` (see the module comment), best first. */
export function proposeRefrigerantGap(scene: readonly HvacElement[], gapId: string): PipeGapProposals {
  const ends = refrigerantOpenEnds(scene).filter((end) => end.gap.id === gapId);
  const points = ends.map((end) => ({ x: end.point.x, y: end.point.y }));
  const none = (reason: string): PipeGapProposals => ({ gapId, candidates: [], reason, ends: points });
  if (!ends.length) return none('This gap is no longer open.');
  const byId = new Map(scene.map((element) => [element.id, element]));
  // The gap's lines: each with its first part (end open) and second part (start open), or one lone end.
  const lines = (['gas', 'liquid'] as const).flatMap((kind) => {
    const own = ends.filter((end) => end.lineKind === kind);
    if (!own.length) return [];
    const upstream = own.find((end) => end.end === 'end');
    const downstream = own.find((end) => end.end === 'start');
    return [{ kind, upstream, downstream, a: upstream ? byId.get(upstream.runId) ?? null : null, b: downstream ? byId.get(downstream.runId) ?? null : null }];
  });
  const removedIds = lines.flatMap((line) => (line.a && line.b ? [line.b.id] : []));
  // A way is judged by what it clashes with that the parts left do not already clash with: the drawing round the
  // gap without its lines, and each clash keyed by the joined line it would belong to (a second part's, the first's).
  const partIds = new Set(lines.flatMap((line) => [line.a?.id, line.b?.id].filter((id): id is string => Boolean(id))));
  const around = scene.filter((element) => !partIds.has(element.id));
  const joinedId = new Map(lines.flatMap((line) => (line.a && line.b ? [[line.b.id, line.a.id] as const] : [])));
  const pairOf = (ids: readonly string[]) => ids.map((id) => joinedId.get(id) ?? id).sort().join('|');
  let already: Set<string> | null = null;
  const clashesAlready = () => (already ??= new Set(findNewNetworkPipeClashes(around, scene.filter((element) => partIds.has(element.id)))
    .map((clash) => pairOf(clash.elementIds))));
  const candidates: PipeGapCandidate[] = [];
  const offer = (key: PipeGapCandidate['key'], label: string, updates: HvacElement[], bridges: PipeRouteNode3D[][]) => {
    const remove = updates.length ? removedIds.filter((id) => updates.every((element) => element.id !== id)) : [];
    if (findNewNetworkPipeClashes(around, updates).some((clash) => !clashesAlready().has(pairOf(clash.elementIds)))) return;
    const bridge = bridges[0] ?? [];
    candidates.push({ key, label, updates, removeIds: remove, bridge, bridges, ...measure(bridge) });
  };

  // ---- As it was. ----
  const asBefore: HvacElement[] = [];
  const asBeforeBridges: PipeRouteNode3D[][] = [];
  let restorable = true;
  for (const line of lines) {
    let stretch: PipeRouteNode3D[] | null = null;
    if (line.a && line.b && line.upstream && line.downstream) {
      const removed = line.upstream.gap.removed;
      if (!removed || removed.length < 2 || !near(removed[0]!, line.upstream.point) || !near(removed[removed.length - 1]!, line.downstream.point)) { restorable = false; continue; }
      asBefore.push(joinLines(line.a, line.b, removed.slice(1, -1), null));
      stretch = removed;
    } else if (line.b && line.downstream && line.downstream.gap.was && line.downstream.gap.removed) {
      asBefore.push(prependStub(line.b, line.downstream.gap.removed, line.downstream.gap.was));
      stretch = line.downstream.gap.removed;
    } else if (line.a && line.upstream && line.upstream.gap.was && line.upstream.gap.removed) {
      asBefore.push(joinLines(line.a, null, line.upstream.gap.removed.slice(1, -1), { connection: line.upstream.gap.was, nodes: [line.upstream.gap.removed[line.upstream.gap.removed.length - 1]!] }));
      stretch = line.upstream.gap.removed;
    } else restorable = false;
    // The gas line's stretch first: its figures are the ones the chip gives.
    if (stretch) asBeforeBridges[line.kind === 'gas' ? 'unshift' : 'push'](stretch);
  }
  if (restorable && asBefore.length) {
    const lone = lines.every((line) => !(line.a && line.b));
    offer(lone ? 'port' : 'as-before', lone ? 'Back to its port' : 'As it was', asBefore, asBeforeBridges);
  }

  // ---- Routed: the gas line (or the one line) round what stands there; a pair's other line beside it. ----
  const lead = lines.find((line) => line.kind === 'gas' && line.a && line.b) ?? lines.find((line) => line.a && line.b);
  const other = lines.find((line) => line !== lead && line.a && line.b) ?? null;
  if (lead?.upstream && lead.downstream && lead.a && lead.b && Math.abs(lead.upstream.point.z - lead.downstream.point.z) <= 1) {
    const pA = lead.upstream.point;
    const pB = lead.downstream.point;
    const dA = lead.upstream.outward;
    const dB = { x: -lead.downstream.outward.x, y: -lead.downstream.outward.y };
    // The pair's spacing, and on which side the other line runs (the same at both ends, or no routed way).
    const side = (end: PipeOpenEndRef | undefined, at: PipeRouteNode3D, way: Point2D) => (end ? (end.point.x - at.x) * -way.y + (end.point.y - at.y) * way.x : 0);
    const offsetA = other ? side(other.upstream, pA, dA) : 0;
    const offsetB = other ? side(other.downstream, pB, dB) : 0;
    const paired = !other || Math.abs(offsetA - offsetB) <= 5;
    const f = frame(pA, dA);
    const arrive = cardinalOf(f.dirToLocal({ x: -dB.x, y: -dB.y }));
    if (paired && arrive && cardinalOf(f.dirToLocal(dA))) {
      const spec = resolveRefrigerantPipeSpec(lead.a.properties);
      const radius = resolveFieldPipeBendRadiusMm(spec.outerDiameterMm, lead.a.properties.bendRadiusFactor) + Math.abs(offsetA) + 20;
      const half = spec.outerDiameterMm / 2 + Math.abs(offsetA) / 2 + 25;
      const exclude = new Set(lines.flatMap((line) => [line.a?.id, line.b?.id].filter((id): id is string => Boolean(id))));
      const obstacles = planObstacles(scene, exclude, [])
        .filter((obstacle) => obstacle.zMin < pA.z + half && obstacle.zMax > pA.z - half)
        .map((obstacle) => (obstacle.shape.kind === 'leg'
          ? boxOf([obstacle.shape.a, obstacle.shape.b].map(f.toLocal), obstacle.shape.halfWidthMm)
          : boxOf(obstacle.shape.corners.map(f.toLocal))));
      for (const route of [{ key: 'shortest' as const, label: 'Shortest', penalty: BEND_PENALTY_MM }, { key: 'fewest' as const, label: 'Fewest bends', penalty: 20000 }]) {
        const found = findObstacleAwareOrthogonalRoute({
          start: { x: 0, y: 0 }, startDirection: { x: 1, y: 0 }, end: f.toLocal(pB), endDirection: arrive,
          startStraightMm: 0, endStraightMm: 0, bendRadiusMm: radius, obstacles, clearanceMm: Math.max(0, half - radius), bendPenaltyMm: route.penalty,
        });
        if (!found) continue;
        const plan = corners([pA, ...found.points.map(f.toWorld), pB]);
        const via = plan.slice(1, -1).map((point) => ({ ...point, z: pA.z }));
        const bridge = [pA, ...via, pB];
        // A way already offered (as it was, when nothing moved; the shortest, when it has the fewest bends too) once.
        if (candidates.some((candidate) => candidate.bridge.length === bridge.length && candidate.bridge.every((point, index) => near(point, bridge[index]!)))) continue;
        const updates = [joinLines(lead.a, lead.b, via, null)];
        const bridges = [bridge];
        if (other?.a && other.b && other.upstream && other.downstream) {
          if (Math.abs(other.upstream.point.z - other.downstream.point.z) > 1) continue;
          const otherSpec = resolveRefrigerantPipeSpec(other.a.properties);
          const bendMm = resolveFieldPipeBendRadiusMm(otherSpec.outerDiameterMm, other.a.properties.bendRadiusFactor);
          const beside = offsetPolyline(plan, offsetA);
          const besideVia = beside ? besideCorners(beside, other.upstream.point, other.downstream.point, bendMm) : null;
          if (!besideVia) continue;
          const z = other.upstream.point.z;
          updates.push(joinLines(other.a, other.b, besideVia.map((point) => ({ ...point, z })), null));
          bridges.push([other.upstream.point, ...besideVia.map((point) => ({ ...point, z })), other.downstream.point]);
        }
        offer(route.key, route.label, updates, bridges);
      }
    }
  }

  const cost = (candidate: PipeGapCandidate) => candidate.lengthMm + candidate.elbows * BEND_PENALTY_MM;
  const first = candidates.find((candidate) => candidate.key === 'as-before' || candidate.key === 'port');
  const rest = candidates.filter((candidate) => candidate !== first).sort((p, q) => cost(p) - cost(q));
  const ordered = first && (!rest.length || cost(first) <= cost(rest[0]!) * AS_BEFORE_TOLERANCE) ? [first, ...rest] : first ? [...rest, first] : rest;
  return { gapId, candidates: ordered, ends: points, reason: ordered.length ? null : 'No clear way found: draw it with the pipe tool from its open end.' };
}

export interface DrawnGapClosure {
  /** Every line the drawing changed, as it now is (the lines drawn on, joined ones under the upstream part's id). */
  updates: HvacElement[];
  /** The parts taken into a joined line. */
  removeIds: string[];
  /** How many lines were joined across their gap (a pair's two count two). */
  joined: number;
}

function withGapRecord(element: HvacElement, gaps: { start: PipeGapRef | null; end: PipeGapRef | null }): HvacElement {
  const properties = { ...element.properties };
  const record = { ...(gaps.start ? { start: gaps.start } : {}), ...(gaps.end ? { end: gaps.end } : {}) };
  if (Object.keys(record).length) properties[PIPE_GAP_PROPERTY] = record;
  else properties[PIPE_GAP_PROPERTY] = undefined;
  return { ...element, properties };
}

/**
 * A gap drawn by hand with the pipe tool, once the tool has merged what was drawn into the line it continued
 * (`merged`: those lines as the merge left them, from `scene`). A line that reached its gap's other part (its open
 * start, or, drawn back from it, its open end) becomes one line with that part: the upstream part's id, its start and
 * the other part's end, the gap closed. A line drawn on to anything else (a port, another pipe) closes that end's gap,
 * the other part's end left open, no longer a gap. One that stops short keeps the gap open, the stretch it remembered
 * dropped (it no longer starts where the line ends). Null when the drawing touched no gap.
 */
export function closeDrawnRefrigerantGaps(scene: readonly HvacElement[], merged: readonly HvacElement[]): DrawnGapClosure | null {
  const byId = new Map(scene.map((element) => [element.id, element]));
  const updates = new Map(merged.map((element) => [element.id, element]));
  const removeIds = new Set<string>();
  let joined = 0;
  let touched = false;
  const current = (element: HvacElement) => updates.get(element.id) ?? element;
  for (const line of merged) {
    const before = byId.get(line.id);
    if (!before) continue;
    const routeBefore = resolveRefrigerantPipeSpec(before.properties).routePoints;
    const spec = resolveRefrigerantPipeSpec(line.properties);
    const routeNow = spec.routePoints;
    if (routeBefore.length < 2 || routeNow.length < 2) continue;
    // The end drawn on: the line's start is where it was when it was drawn on from its end.
    const end: 'start' | 'end' = near(routeBefore[0]!, routeNow[0]!) ? 'end' : 'start';
    const gap = readPipeGaps(before)[end];
    if (!gap) continue;
    touched = true;
    const tip = end === 'end' ? routeNow[routeNow.length - 1]! : routeNow[0]!;
    const partner = gap.partner ? byId.get(gap.partner.runId) ?? null : null;
    const partnerSide = gap.partner?.end ?? 'start';
    const partnerRoute = partner ? resolveRefrigerantPipeSpec(partner.properties).routePoints : [];
    const partnerPoint = partnerSide === 'start' ? partnerRoute[0] : partnerRoute[partnerRoute.length - 1];
    if (partner && partnerPoint && near(tip, partnerPoint, WELD_MM) && !removeIds.has(partner.id)) {
      // It reached the other part: one line again, under the upstream part's id.
      const [upstream, downstream] = end === 'end' ? [line, current(partner)] : [current(partner), line];
      const one = joinLines(upstream, downstream, [], null);
      updates.delete(downstream.id);
      updates.set(upstream.id, one);
      removeIds.add(downstream.id);
      joined += 1;
      continue;
    }
    const connected = end === 'end' ? spec.endConnection : spec.startConnection;
    const gaps = readPipeGaps(line);
    if (connected) {
      // Drawn on to something else: this end is no longer open; the other part's end stays open, no longer a gap.
      updates.set(line.id, withGapRecord(current(line), { ...gaps, [end]: null }));
    } else {
      // Stopped short: still a gap, its remembered stretch no longer where the line ends.
      updates.set(line.id, withGapRecord(current(line), { ...gaps, [end]: { ...gap, removed: null } }));
    }
    if (partner) {
      const other = current(partner);
      const record = readPipeGaps(other);
      const side = record[partnerSide];
      if (side) {
        updates.set(other.id, withGapRecord(other, {
          ...record, [partnerSide]: connected ? { ...side, partner: null, removed: null, was: null } : { ...side, removed: null },
        }));
      }
    }
  }
  return touched ? { updates: [...updates.values()].filter((element) => !removeIds.has(element.id)), removeIds: [...removeIds], joined } : null;
}
