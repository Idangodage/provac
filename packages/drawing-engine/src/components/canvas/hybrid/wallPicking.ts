/**
 * Wall picking + outline-proxy helpers for the hybrid 3D scene — port of the
 * reference app's picking practice (`engine/picking/raycast.ts` +
 * `chunks.extractEntityGeometry`): the merged wall chunk carries a per-vertex
 * `entityIndex` attribute; a raycast hit resolves to an entity id by reading
 * that attribute at the hit face's first vertex, and outline proxies are
 * position-only geometries holding just one entity's triangles.
 */
import * as THREE from "three";

import type { WallEntityId } from "../../../wallcore/wallModel";

/** Entity id at a face vertex (all 3 verts of a triangle share one entity). */
export function entityIdAtVertex(
  geometry: THREE.BufferGeometry,
  entityIds: readonly WallEntityId[],
  vertexIndex: number,
): WallEntityId | null {
  const attr = geometry.getAttribute("entityIndex");
  if (!attr) return null;
  return entityIds[attr.getX(vertexIndex)] ?? null;
}

/**
 * Resolve a raycast hit list to the nearest WALL EDGE id. Node-wedge hits
 * (junction cores) resolve to their wall via `preferIds` membership — wedges
 * are keyed by node ids which are never in `walls`, so they are skipped in
 * favour of the next-nearest edge hit.
 */
export function resolveWallHitId(
  hits: readonly THREE.Intersection[],
  entityIds: readonly WallEntityId[],
  wallEdgeIds: ReadonlySet<string>,
): string | null {
  for (const hit of hits) {
    if (!hit.face) continue;
    const object = hit.object as THREE.Mesh;
    const geometry = object.geometry as THREE.BufferGeometry;
    const id = entityIdAtVertex(geometry, entityIds, hit.face.a);
    if (id && wallEdgeIds.has(id)) return id;
  }
  return null;
}

/**
 * Position-only geometry containing ONLY the triangles of `targetIds` —
 * the outline proxy for one wall (pass the edge id PLUS its two node ids so
 * the mitered junction corners outline as part of the wall, reference
 * `setProxies` behaviour). Returns null when no triangles match.
 */
export function extractEntityTriangles(
  geometry: THREE.BufferGeometry,
  entityIds: readonly WallEntityId[],
  targetIds: ReadonlySet<string>,
): THREE.BufferGeometry | null {
  const index = geometry.getIndex();
  const position = geometry.getAttribute("position");
  const entityAttr = geometry.getAttribute("entityIndex");
  if (!index || !position || !entityAttr) return null;

  const targetIndexes = new Set<number>();
  entityIds.forEach((id, i) => {
    if (targetIds.has(id)) targetIndexes.add(i);
  });
  if (targetIndexes.size === 0) return null;

  const out: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const va = index.getX(t);
    if (!targetIndexes.has(entityAttr.getX(va))) continue;
    for (let k = 0; k < 3; k += 1) {
      const v = index.getX(t + k);
      out.push(position.getX(v), position.getY(v), position.getZ(v));
    }
  }
  if (out.length === 0) return null;

  const proxy = new THREE.BufferGeometry();
  proxy.setAttribute("position", new THREE.BufferAttribute(new Float32Array(out), 3));
  return proxy;
}
