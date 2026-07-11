/**
 * Wall operations — port of the reference command family (`cmds/wall.ts`).
 * Each op mutates a WallGraphDoc draft with the exact topology semantics of the
 * reference (weld/split/crossings maintained INSIDE the op so every route gets
 * identical behaviour). The host store wraps these in its own history entries.
 */
import { angleDelta, normalizeAngle } from './angle';
import { COLLINEAR_EPS, WELD_EPS } from './tolerances';
import { add2, dist2, type Vec2 } from './vec2';
import {
  addSegmentWithCrossings,
  deleteWallEdges,
  edgesAtNode,
  findEdgeNear,
  findNodeNear,
  nodePos,
  resolvePointToNode,
  splitEdgeAt,
} from './wallGraph';
import type { WallEdge2, WallEntityId, WallGraphDoc, WallIdSource, WallParams } from './wallModel';

/** Draw a wall chain: each point welds/splits, segments split crossed walls (X junctions). */
export function addWallChain(
  doc: WallGraphDoc,
  points: Vec2[],
  params: WallParams,
  ids: WallIdSource,
): WallEntityId[] {
  if (points.length < 2) return [];
  const created: WallEntityId[] = [];
  let prev = resolvePointToNode(doc, points[0]!, ids);
  for (let i = 1; i < points.length; i += 1) {
    const next = resolvePointToNode(doc, points[i]!, ids);
    created.push(...addSegmentWithCrossings(doc, prev, next, params, ids));
    prev = next;
  }
  return created;
}

/**
 * Move a shared corner (endpoint drag). With `weld`, dropping onto another
 * node merges them; dropping onto a wall body splits it and welds there —
 * zero-length leftovers are removed.
 */
export function moveWallNode(
  doc: WallGraphDoc,
  nodeId: WallEntityId,
  to: Vec2,
  options: { weld?: boolean } = {},
  ids?: WallIdSource,
): void {
  const node = doc.nodes[nodeId];
  if (!node) return;
  node.p = to;
  if (!options.weld || !ids) return;

  // weld into an existing node (excluding the moving node itself)?
  const target = findNodeNear(doc, to, WELD_EPS, node.id);
  let targetId: WallEntityId | null = null;
  if (target) {
    targetId = target.id;
  } else {
    // split a wall body under the drop point
    const onEdge = findEdgeNear(doc, to, WELD_EPS);
    if (onEdge && onEdge.edge.a !== node.id && onEdge.edge.b !== node.id) {
      targetId = splitEdgeAt(doc, onEdge.edge, onEdge.t, ids).id;
    }
  }
  if (!targetId) return;
  for (const e of edgesAtNode(doc, node.id)) {
    const other = e.a === node.id ? e.b : e.a;
    if (other === targetId) {
      delete doc.edges[e.id]; // zero-length after weld
      continue;
    }
    if (e.a === node.id) e.a = targetId;
    else e.b = targetId;
  }
  delete doc.nodes[node.id];
}

/** thickness/height/justification/… on one or more edges. */
export function setWallParams(
  doc: WallGraphDoc,
  edgeIds: WallEntityId[],
  patch: Partial<Pick<WallEdge2, 'thickness' | 'height' | 'baseOffset' | 'justification' | 'material'>>,
): void {
  for (const id of edgeIds) {
    const e = doc.edges[id];
    if (e) Object.assign(e, patch);
  }
}

/**
 * FLIP: mirror the wall body to the other side of its FIXED centerline —
 * justification left↔right ('center' is symmetric, unchanged). The centerline
 * nodes never move, so joins re-solve cleanly on the flipped side.
 */
export function flipWallJustification(doc: WallGraphDoc, edgeIds: WallEntityId[]): void {
  for (const id of edgeIds) {
    const e = doc.edges[id];
    if (!e) continue;
    if (e.justification === 'left') e.justification = 'right';
    else if (e.justification === 'right') e.justification = 'left';
  }
}

/**
 * Temp-dim numeric edit: move ONE end so the segment gets the given length;
 * the anchored end stays fixed.
 */
export function setWallLength(
  doc: WallGraphDoc,
  edgeId: WallEntityId,
  length: number,
  anchor: 'a' | 'b',
): void {
  const e = doc.edges[edgeId];
  if (!e || length <= 0) return;
  const pa = nodePos(doc, e.a);
  const pb = nodePos(doc, e.b);
  const len = dist2(pa, pb);
  if (len < 1e-9) return;
  const fixed = anchor === 'a' ? pa : pb;
  const moving = anchor === 'a' ? pb : pa;
  const dir: Vec2 = [(moving[0] - fixed[0]) / len, (moving[1] - fixed[1]) / len];
  const target = add2(fixed, [dir[0] * length, dir[1] * length]);
  const movingNode = doc.nodes[anchor === 'a' ? e.b : e.a];
  if (movingNode) movingNode.p = target;
}

/** Explicit split at parameter t (Alt+click / context action). */
export function splitWall(
  doc: WallGraphDoc,
  edgeId: WallEntityId,
  t: number,
  ids: WallIdSource,
): WallEntityId | null {
  const e = doc.edges[edgeId];
  if (!e || t <= 0 || t >= 1) return null;
  return splitEdgeAt(doc, e, t, ids).id;
}

/** Dissolve a 2-valence collinear node (merge two segments into one). */
export function mergeAtNode(doc: WallGraphDoc, nodeId: WallEntityId): boolean {
  const node = doc.nodes[nodeId];
  if (!node) return false;
  const incident = edgesAtNode(doc, nodeId);
  if (incident.length !== 2) return false;
  const [e1, e2] = incident as [WallEdge2, WallEdge2];
  const p = node.p;
  const o1 = nodePos(doc, e1.a === nodeId ? e1.b : e1.a);
  const o2 = nodePos(doc, e2.a === nodeId ? e2.b : e2.a);
  const a1 = Math.atan2(p[1] - o1[1], p[0] - o1[0]);
  const a2 = Math.atan2(o2[1] - p[1], o2[0] - p[0]);
  if (angleDelta(normalizeAngle(a1), normalizeAngle(a2)) > COLLINEAR_EPS) return false;
  if (e1.thickness !== e2.thickness || e1.justification !== e2.justification) return false;
  // extend e1 to e2's far node, drop e2 + the node
  const far2 = e2.a === nodeId ? e2.b : e2.a;
  if (e1.a === nodeId) e1.a = far2;
  else e1.b = far2;
  delete doc.edges[e2.id];
  delete doc.nodes[nodeId];
  return true;
}

/** Delete wall edges (orphaned nodes GC'd with them). */
export function deleteWalls(doc: WallGraphDoc, edgeIds: WallEntityId[]): void {
  deleteWallEdges(doc, edgeIds);
}

/**
 * Body-drag: translate edges rigidly via their nodes, DEDUPED — a node shared
 * by two selected edges moves exactly once, so connected runs never tear.
 */
export function moveWallEdges(doc: WallGraphDoc, edgeIds: WallEntityId[], delta: Vec2): void {
  const nodeIds = new Set<WallEntityId>();
  for (const id of edgeIds) {
    const e = doc.edges[id];
    if (!e) continue;
    nodeIds.add(e.a);
    nodeIds.add(e.b);
  }
  for (const nid of nodeIds) {
    const n = doc.nodes[nid];
    if (n) n.p = add2(n.p, delta);
  }
}
