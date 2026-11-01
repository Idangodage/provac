/**
 * Wall operations — port of the reference command family (`cmds/wall.ts`).
 * Each op mutates a WallGraphDoc draft with the exact topology semantics of the
 * reference (weld/split/crossings maintained INSIDE the op so every route gets
 * identical behaviour). The host store wraps these in its own history entries.
 */
import { COLLINEAR_EPS, WELD_EPS } from './tolerances';
import { add2, dist2, type Vec2 } from './vec2';
import {
  addSegmentWithCrossings,
  createNode,
  deleteWallEdges,
  edgesAtNode,
  findEdgeNear,
  findNodeNear,
  mergeNodeInto,
  mergeStraightWallsAt,
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
  mergeNodeInto(doc, node.id, targetId);
}

/**
 * Move one wall's end without taking its neighbours along (trim, extend): the
 * end leaves a node it shares and gets its own. Normalizing then welds or tees it
 * at wherever it lands.
 */
export function moveWallEnd(
  doc: WallGraphDoc,
  edgeId: WallEntityId,
  end: 'a' | 'b',
  to: Vec2,
  ids: WallIdSource,
): void {
  const edge = doc.edges[edgeId];
  if (!edge) return;
  const nodeId = end === 'a' ? edge.a : edge.b;
  const node = doc.nodes[nodeId];
  if (!node) return;
  if (edgesAtNode(doc, nodeId).length === 1) {
    node.p = to;
    return;
  }
  const own = createNode(doc, to, ids);
  if (end === 'a') edge.a = own.id;
  else edge.b = own.id;
}

/** thickness/height/justification/… on one or more edges. */
export function setWallParams(
  doc: WallGraphDoc,
  edgeIds: WallEntityId[],
  patch: Partial<Pick<WallEdge2, 'thickness' | 'height' | 'baseOffset' | 'justification' | 'material' | 'materialId'>>,
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
  return mergeStraightWallsAt(doc, nodeId, COLLINEAR_EPS) !== null;
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
