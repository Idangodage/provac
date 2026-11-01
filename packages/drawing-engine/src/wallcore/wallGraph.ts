/**
 * Wall graph operations — weld, split, crossing insertion, clean-up. Port of the
 * reference `core/geometry/wallGraph.ts` onto the self-contained WallGraphDoc.
 * Pure functions over a mutable draft; geometry-free (the solver renders, this
 * module only maintains topology). All tolerances from ./tolerances.
 */
import { MAX_NORMALIZE_PASSES, MIN_TEE_ANGLE, WELD_EPS } from './tolerances';
import { cross2, dist2, dot2, eq2, norm2, perp2, pointSegment2, segSegIntersect2, sub2, type Vec2 } from './vec2';
import type {
  WallEdge2,
  WallEdgeSource,
  WallEntityId,
  WallGraphDoc,
  WallIdSource,
  WallNode2,
  WallParams,
} from './wallModel';
import { halfWidths } from './wallSolver';

export function edgesAtNode(doc: WallGraphDoc, nodeId: WallEntityId): WallEdge2[] {
  return Object.values(doc.edges).filter((e) => e.a === nodeId || e.b === nodeId);
}

export function nodePos(doc: WallGraphDoc, id: WallEntityId): Vec2 {
  const n = doc.nodes[id];
  if (!n) throw new Error(`wallNode ${id} missing`);
  return n.p;
}

/** Find an existing node within WELD_EPS of p (weld target). */
export function findNodeNear(
  doc: WallGraphDoc,
  p: Vec2,
  eps = WELD_EPS,
  excludeId?: WallEntityId,
): WallNode2 | null {
  let best: WallNode2 | null = null;
  let bestD = eps;
  for (const n of Object.values(doc.nodes)) {
    if (n.id === excludeId) continue;
    const d = dist2(n.p, p);
    if (d <= bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/** Find an edge whose body passes within eps of p (split target). Excludes endpoints. */
export function findEdgeNear(
  doc: WallGraphDoc,
  p: Vec2,
  eps = WELD_EPS,
): { edge: WallEdge2; t: number; point: Vec2 } | null {
  let best: { edge: WallEdge2; t: number; point: Vec2; d: number } | null = null;
  for (const e of Object.values(doc.edges)) {
    const a = nodePos(doc, e.a);
    const b = nodePos(doc, e.b);
    const { dist, t, closest } = pointSegment2(p, a, b);
    if (dist <= eps && t > 1e-6 && t < 1 - 1e-6) {
      // interior only — endpoints weld instead
      if (eq2(closest, a, WELD_EPS) || eq2(closest, b, WELD_EPS)) continue;
      if (!best || dist < best.d) best = { edge: e, t, point: closest, d: dist };
    }
  }
  return best ? { edge: best.edge, t: best.t, point: best.point } : null;
}

export function createNode(doc: WallGraphDoc, p: Vec2, ids: WallIdSource): WallNode2 {
  const node: WallNode2 = { id: ids.newId(), p };
  doc.nodes[node.id] = node;
  return node;
}

export function createEdge(
  doc: WallGraphDoc,
  a: WallEntityId,
  b: WallEntityId,
  params: WallParams,
  ids: WallIdSource,
): WallEdge2 {
  const edge: WallEdge2 = {
    id: ids.newId(),
    a,
    b,
    thickness: params.thickness,
    height: params.height,
    baseOffset: params.baseOffset,
    justification: params.justification,
    material: params.material,
    materialId: params.materialId,
  };
  doc.edges[edge.id] = edge;
  return edge;
}

function edgeLength(doc: WallGraphDoc, edge: WallEdge2): number {
  return dist2(nodePos(doc, edge.a), nodePos(doc, edge.b));
}

/** What an edge carries: recorded sources, or simply all of the wall of the same id. */
export function edgeSources(doc: WallGraphDoc, edge: WallEdge2): WallEdgeSource[] {
  return (
    doc.sources?.[edge.id] ?? [
      { wallId: edge.id, fromMm: 0, toMm: edgeLength(doc, edge), offsetMm: 0, reversed: false },
    ]
  );
}

function setEdgeSources(doc: WallGraphDoc, edgeId: WallEntityId, sources: WallEdgeSource[]): void {
  (doc.sources ??= {})[edgeId] = sources;
}

/** The part of these sources on the stretch [lo, hi] of their edge, measured from lo. */
function sourcesOnStretch(sources: readonly WallEdgeSource[], lo: number, hi: number): WallEdgeSource[] {
  return sources.flatMap((source) => {
    const fromMm = Math.max(source.fromMm, source.reversed ? source.offsetMm - hi : lo - source.offsetMm);
    const toMm = Math.min(source.toMm, source.reversed ? source.offsetMm - lo : hi - source.offsetMm);
    return toMm > fromMm ? [{ ...source, fromMm, toMm, offsetMm: source.offsetMm - lo }] : [];
  });
}

/** The same sources after their edge is re-measured: position p becomes shift ± p. */
function sourcesRemeasured(sources: readonly WallEdgeSource[], shift: number, flip: boolean): WallEdgeSource[] {
  return sources.map((source) => ({
    ...source,
    offsetMm: flip ? shift - source.offsetMm : shift + source.offsetMm,
    reversed: flip ? !source.reversed : source.reversed,
  }));
}

/**
 * Split an edge at parameter t, at a new node or one given to weld there. The
 * longer piece stays the same wall, so whatever refers to it by id stays with
 * most of it; both pieces inherit its params. Returns the node.
 */
export function splitEdgeAt(
  doc: WallGraphDoc,
  edge: WallEdge2,
  t: number,
  ids: WallIdSource,
  at?: WallNode2,
): WallNode2 {
  const a = nodePos(doc, edge.a);
  const b = nodePos(doc, edge.b);
  const length = dist2(a, b);
  const sources = edgeSources(doc, edge);
  const node = at ?? createNode(doc, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], ids);
  const params: WallParams = {
    thickness: edge.thickness,
    height: edge.height,
    baseOffset: edge.baseOffset,
    justification: edge.justification,
    material: edge.material,
    materialId: edge.materialId,
  };
  const keepsFirstPart = t >= 0.5;
  const other = keepsFirstPart
    ? createEdge(doc, node.id, edge.b, params, ids)
    : createEdge(doc, edge.a, node.id, params, ids);
  if (keepsFirstPart) edge.b = node.id;
  else edge.a = node.id;
  setEdgeSources(doc, (keepsFirstPart ? edge : other).id, sourcesOnStretch(sources, 0, length * t));
  setEdgeSources(doc, (keepsFirstPart ? other : edge).id, sourcesOnStretch(sources, length * t, length));
  return node;
}

/** Everything at `fromId` moves to `intoId`; walls that would collapse to nothing go. */
export function mergeNodeInto(doc: WallGraphDoc, fromId: WallEntityId, intoId: WallEntityId): void {
  for (const e of edgesAtNode(doc, fromId)) {
    const other = e.a === fromId ? e.b : e.a;
    if (other === intoId) {
      delete doc.edges[e.id];
      continue;
    }
    if (e.a === fromId) e.a = intoId;
    else e.b = intoId;
  }
  delete doc.nodes[fromId];
}

/** Resolve a chain point to a node id: weld to node / split edge / create node. */
export function resolvePointToNode(doc: WallGraphDoc, p: Vec2, ids: WallIdSource): WallEntityId {
  const existing = findNodeNear(doc, p);
  if (existing) return existing.id;
  const onEdge = findEdgeNear(doc, p);
  if (onEdge) return splitEdgeAt(doc, onEdge.edge, onEdge.t, ids).id;
  return createNode(doc, p, ids).id;
}

/**
 * Add one wall segment between two resolved nodes, splitting any crossed walls
 * at the intersections (X junctions on both) — auto split/weld while drawing.
 * Returns the ids of the resulting collinear pieces of the new segment.
 */
export function addSegmentWithCrossings(
  doc: WallGraphDoc,
  aId: WallEntityId,
  bId: WallEntityId,
  params: WallParams,
  ids: WallIdSource,
): WallEntityId[] {
  if (aId === bId) return [];
  const pa = nodePos(doc, aId);
  const pb = nodePos(doc, bId);

  // collect interior crossings against existing edges (before inserting the new one)
  const crossings: Array<{ tNew: number; nodeId: WallEntityId }> = [];
  for (const e of Object.values(doc.edges)) {
    const ea = nodePos(doc, e.a);
    const eb = nodePos(doc, e.b);
    const hit = segSegIntersect2(pa, pb, ea, eb);
    if (!hit) continue;
    const interiorNew = hit.ta > 1e-6 && hit.ta < 1 - 1e-6;
    const interiorOld = hit.tb > 1e-6 && hit.tb < 1 - 1e-6;
    if (!interiorNew) continue; // endpoint weld handled by resolvePointToNode
    let nodeId: WallEntityId;
    if (interiorOld) {
      nodeId = splitEdgeAt(doc, e, hit.tb, ids).id;
    } else {
      // crossing lands on an existing node
      nodeId = dist2(hit.p, ea) <= dist2(hit.p, eb) ? e.a : e.b;
    }
    crossings.push({ tNew: hit.ta, nodeId });
  }
  crossings.sort((x, y) => x.tNew - y.tNew);

  const pieces: WallEntityId[] = [];
  let prev = aId;
  const seen = new Set<WallEntityId>([aId]);
  for (const c of crossings) {
    if (seen.has(c.nodeId)) continue;
    seen.add(c.nodeId);
    pieces.push(createEdge(doc, prev, c.nodeId, params, ids).id);
    prev = c.nodeId;
  }
  if (prev !== bId) pieces.push(createEdge(doc, prev, bId, params, ids).id);
  return pieces;
}

/** Delete wall edges; orphaned nodes are removed with them. */
export function deleteWallEdges(doc: WallGraphDoc, edgeIds: WallEntityId[]): void {
  const touchedNodes = new Set<WallEntityId>();
  for (const id of edgeIds) {
    const e = doc.edges[id];
    if (!e) continue;
    touchedNodes.add(e.a);
    touchedNodes.add(e.b);
    delete doc.edges[id];
  }
  for (const nid of touchedNodes) {
    if (edgesAtNode(doc, nid).length === 0) delete doc.nodes[nid];
  }
}

const byId = <T extends { id: WallEntityId }>(x: T, y: T): number => (x.id < y.id ? -1 : 1);

const sharesNode = (x: WallEdge2, y: WallEdge2): boolean =>
  x.a === y.a || x.a === y.b || x.b === y.a || x.b === y.b;

function edgeDirection(doc: WallGraphDoc, edge: WallEdge2): Vec2 {
  return norm2(sub2(nodePos(doc, edge.b), nodePos(doc, edge.a)));
}

function weldCoincidentNodes(doc: WallGraphDoc, dirty: Set<WallEntityId>): boolean {
  let changed = false;
  for (const edge of Object.values(doc.edges).sort(byId)) {
    if (!dirty.has(edge.id)) continue;
    for (const nodeId of [edge.a, edge.b]) {
      const node = doc.nodes[nodeId];
      if (!node) continue;
      const near = findNodeNear(doc, node.p, WELD_EPS, nodeId);
      if (!near) continue;
      mergeNodeInto(doc, nodeId, near.id);
      for (const e of edgesAtNode(doc, near.id)) dirty.add(e.id);
      changed = true;
    }
  }
  return changed;
}

/**
 * Where a node sitting inside this wall's body should join it: at one of its end
 * nodes when within half a thickness of that end, otherwise on its centerline.
 */
function bodyJoinOf(
  doc: WallGraphDoc,
  node: WallNode2,
  wall: WallEdge2,
  incident: readonly WallEdge2[],
): { kind: 'end'; nodeId: WallEntityId; rank: number } | { kind: 'body'; t: number; rank: number } | null {
  if (incident.some((e) => e.id === wall.id)) return null;
  const a = nodePos(doc, wall.a);
  const u = edgeDirection(doc, wall);
  const length = edgeLength(doc, wall);
  const d = sub2(node.p, a);
  const along = dot2(d, u);
  const across = dot2(d, perp2(u));
  const { hl, hr } = halfWidths(wall);
  if (along < 0 || along > length || across > hl + WELD_EPS || across < -hr - WELD_EPS) return null;
  if (Math.abs(across) > WELD_EPS) {
    // Already joined to this wall at its other end: a short wall leaving it, not a second junction.
    if (incident.some((e) => sharesNode(e, wall))) return null;
    // Lying along the wall without being on its line: two walls side by side, not a junction.
    const sinTee = Math.sin(MIN_TEE_ANGLE);
    if (incident.some((e) => Math.abs(cross2(edgeDirection(doc, e), u)) < sinTee)) return null;
  }
  const reach = wall.thickness / 2;
  if (along <= reach) return { kind: 'end', nodeId: wall.a, rank: Math.hypot(along, across) };
  if (length - along <= reach) return { kind: 'end', nodeId: wall.b, rank: Math.hypot(length - along, across) };
  return { kind: 'body', t: along / length, rank: Math.abs(across) + length };
}

/** A wall ending inside another wall's body joins it for real. */
function joinNodesToBodies(doc: WallGraphDoc, ids: WallIdSource, dirty: Set<WallEntityId>): boolean {
  let changed = false;
  for (const node of Object.values(doc.nodes).sort(byId)) {
    if (!doc.nodes[node.id]) continue;
    const incident = edgesAtNode(doc, node.id);
    if (incident.length === 0) continue;
    const nodeDirty = incident.some((e) => dirty.has(e.id));

    let best: { wall: WallEdge2; join: NonNullable<ReturnType<typeof bodyJoinOf>> } | null = null;
    for (const wall of Object.values(doc.edges).sort(byId)) {
      if (!nodeDirty && !dirty.has(wall.id)) continue;
      const join = bodyJoinOf(doc, node, wall, incident);
      if (join && (!best || join.rank < best.join.rank)) best = { wall, join };
    }
    if (!best) continue;
    changed = true;

    if (best.join.kind === 'end') {
      const target = best.join.nodeId;
      mergeNodeInto(doc, node.id, target);
      for (const e of edgesAtNode(doc, target)) dirty.add(e.id);
      continue;
    }
    const a = nodePos(doc, best.wall.a);
    const b = nodePos(doc, best.wall.b);
    const { t } = best.join;
    node.p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    splitEdgeAt(doc, best.wall, t, ids, node);
    for (const e of edgesAtNode(doc, node.id)) dirty.add(e.id);
  }
  return changed;
}

/** Walls crossing without a shared node get one: both split, an X junction. */
function splitCrossings(doc: WallGraphDoc, ids: WallIdSource, dirty: Set<WallEntityId>): boolean {
  let changed = false;
  const queue = [...dirty].sort();
  while (queue.length > 0) {
    const edge = doc.edges[queue.pop()!];
    if (!edge) continue;
    for (const other of Object.values(doc.edges).sort(byId)) {
      if (other.id === edge.id || sharesNode(edge, other)) continue;
      const ea = nodePos(doc, edge.a);
      const eb = nodePos(doc, edge.b);
      const hit = segSegIntersect2(ea, eb, nodePos(doc, other.a), nodePos(doc, other.b));
      if (!hit) continue;
      const clearOfEnds = (x: Vec2, y: Vec2) => dist2(hit.p, x) > WELD_EPS && dist2(hit.p, y) > WELD_EPS;
      if (!clearOfEnds(ea, eb) || !clearOfEnds(nodePos(doc, other.a), nodePos(doc, other.b))) continue;
      const node = splitEdgeAt(doc, other, hit.tb, ids);
      splitEdgeAt(doc, edge, hit.ta, ids, node);
      for (const piece of edgesAtNode(doc, node.id)) {
        dirty.add(piece.id);
        queue.push(piece.id);
      }
      changed = true;
      break;
    }
  }
  return changed;
}

/** Two walls between the same two nodes are one wall. The one already there stays, and takes any doors. */
function removeDuplicateWalls(
  doc: WallGraphDoc,
  dirty: ReadonlySet<WallEntityId>,
  replaced: Map<WallEntityId, WallEntityId>,
): boolean {
  let changed = false;
  const kept = new Map<string, WallEdge2>();
  const oldestFirst = Object.values(doc.edges).sort(
    (x, y) => Number(dirty.has(x.id)) - Number(dirty.has(y.id)) || byId(x, y),
  );
  for (const edge of oldestFirst) {
    const key = edge.a < edge.b ? `${edge.a}|${edge.b}` : `${edge.b}|${edge.a}`;
    const stays = kept.get(key);
    if (!stays) {
      kept.set(key, edge);
      continue;
    }
    const carried = edge.a === stays.a
      ? edgeSources(doc, edge)
      : sourcesRemeasured(edgeSources(doc, edge), edgeLength(doc, edge), true);
    setEdgeSources(doc, stays.id, [...edgeSources(doc, stays), ...carried]);
    delete doc.edges[edge.id];
    replaced.set(edge.id, stays.id);
    changed = true;
  }
  return changed;
}

/**
 * Make the graph say what the drawing shows, for the walls an edit touched (all
 * of them when opening a drawing): coincident nodes weld, a wall ending inside
 * another joins it, crossing walls become an X, and a wall lying exactly on
 * another merges into it. One join can bring a node inside another wall, so this
 * repeats until the graph settles. Returns walls absorbed → the wall they became.
 */
export function normalizeWallGraph(
  doc: WallGraphDoc,
  ids: WallIdSource,
  dirtyEdges?: ReadonlySet<WallEntityId>,
): Map<WallEntityId, WallEntityId> {
  const dirty = new Set(dirtyEdges ?? Object.keys(doc.edges));
  const replaced = new Map<WallEntityId, WallEntityId>();
  for (let pass = 0; pass < MAX_NORMALIZE_PASSES; pass += 1) {
    const welded = weldCoincidentNodes(doc, dirty);
    const joined = joinNodesToBodies(doc, ids, dirty);
    const crossed = splitCrossings(doc, ids, dirty);
    const merged = removeDuplicateWalls(doc, dirty, replaced);
    if (!welded && !joined && !crossed && !merged) break;
  }
  return replaced;
}

/**
 * Dissolve a 2-valence straight node (two matching segments become one wall).
 * The longer stays the same wall; the other's doors and windows move onto it.
 */
export function mergeStraightWallsAt(
  doc: WallGraphDoc,
  nodeId: WallEntityId,
  maxAngle: number,
): { stays: WallEntityId; goes: WallEntityId } | null {
  const node = doc.nodes[nodeId];
  if (!node) return null;
  const incident = edgesAtNode(doc, nodeId);
  if (incident.length !== 2) return null;
  const [first, second] = incident as [WallEdge2, WallEdge2];
  const stays = edgeLength(doc, first) >= edgeLength(doc, second) ? first : second;
  const goes = stays === first ? second : first;
  const staysOut = stays.a === nodeId ? edgeDirection(doc, stays) : sub2([0, 0], edgeDirection(doc, stays));
  const goesOut = goes.a === nodeId ? edgeDirection(doc, goes) : sub2([0, 0], edgeDirection(doc, goes));
  if (dot2(staysOut, goesOut) >= 0 || Math.abs(cross2(staysOut, goesOut)) > Math.sin(maxAngle)) return null;
  // Run the same way, or against each other: a one-sided wall must still lie on the same side.
  const sameWay = (stays.a === nodeId) !== (goes.a === nodeId);
  const mirrored = { left: 'right', right: 'left', center: 'center' } as const;
  const sameBody =
    stays.thickness === goes.thickness &&
    stays.height === goes.height &&
    stays.baseOffset === goes.baseOffset &&
    stays.material === goes.material &&
    stays.materialId === goes.materialId &&
    stays.justification === (sameWay ? goes.justification : mirrored[goes.justification]);
  if (!sameBody) return null;
  const staysLength = edgeLength(doc, stays);
  const goesLength = edgeLength(doc, goes);
  const far = goes.a === nodeId ? goes.b : goes.a;
  // `stays` keeps its direction: whichever end was at the node now reaches goes' far node.
  const merged = stays.b === nodeId
    ? [
        ...edgeSources(doc, stays),
        ...sourcesRemeasured(edgeSources(doc, goes), goes.a === nodeId ? staysLength : staysLength + goesLength, goes.b === nodeId),
      ]
    : [
        ...sourcesRemeasured(edgeSources(doc, stays), goesLength, false),
        ...sourcesRemeasured(edgeSources(doc, goes), goes.b === nodeId ? 0 : goesLength, goes.a === nodeId),
      ];
  if (stays.b === nodeId) stays.b = far;
  else stays.a = far;
  setEdgeSources(doc, stays.id, merged);
  delete doc.edges[goes.id];
  delete doc.nodes[nodeId];
  return { stays: stays.id, goes: goes.id };
}
