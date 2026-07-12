/**
 * Wall graph operations — weld, split, crossing insertion. Port of the
 * reference `core/geometry/wallGraph.ts` onto the self-contained WallGraphDoc.
 * Pure functions over a mutable draft; geometry-free (the solver renders, this
 * module only maintains topology). All tolerances from ./tolerances.
 */
import { WELD_EPS } from './tolerances';
import { dist2, eq2, pointSegment2, segSegIntersect2, type Vec2 } from './vec2';
import type {
  WallEdge2,
  WallEntityId,
  WallGraphDoc,
  WallIdSource,
  WallNode2,
  WallParams,
} from './wallModel';

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

/** Split an edge at parameter t: insert node, two child edges inherit params. Returns the new node. */
export function splitEdgeAt(
  doc: WallGraphDoc,
  edge: WallEdge2,
  t: number,
  ids: WallIdSource,
): WallNode2 {
  const a = nodePos(doc, edge.a);
  const b = nodePos(doc, edge.b);
  const p: Vec2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const node = createNode(doc, p, ids);
  const params: WallParams = {
    thickness: edge.thickness,
    height: edge.height,
    baseOffset: edge.baseOffset,
    justification: edge.justification,
    material: edge.material,
    materialId: edge.materialId,
  };
  createEdge(doc, edge.a, node.id, params, ids);
  createEdge(doc, node.id, edge.b, params, ids);
  delete doc.edges[edge.id];
  return node;
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
