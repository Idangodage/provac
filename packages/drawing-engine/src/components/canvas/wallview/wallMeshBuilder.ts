/**
 * Wall mesh builder — port of the reference `engine/scene/builders/wallMesh.ts`:
 * solver footprints + node wedges → prisms → ONE merged BufferGeometry with a
 * per-vertex `entityIndex` attribute for picking. Earcut-style triangulated
 * caps (THREE.ShapeUtils, no extra dependency) + side quads, flat normals.
 *
 * Geometry is in canonical MODEL space (mm, y down, z = elevation up); the
 * hybrid scene renders it through the permanent mirror view basis exactly like
 * every other model mesh — never mutate it for view reasons.
 */
import * as THREE from "three";

import type { Vec2 } from "../../../wallcore/vec2";
import type { WallEntityId } from "../../../wallcore/wallModel";
import { polygonArea, type WallSolveResult } from "../../../wallcore/wallSolver";

export interface WallChunkData {
  geometry: THREE.BufferGeometry;
  /** entityIndex attribute value → entity id */
  entityIds: WallEntityId[];
  /**
   * Boundary edge lines (reference `rebuildEdges` port): every triangle edge
   * that appears exactly ONCE across the chunk — interior shared edges cancel
   * out — so walls read with crisp outlines in every view style.
   */
  edgesGeometry: THREE.BufferGeometry;
}

export interface WallChunkBuildOptions {
  /** Entity id -> Three.js material slot; preserves one merged/pickable chunk. */
  materialIndexByEntityId?: ReadonlyMap<WallEntityId, number>;
}

interface Prism {
  entityId: WallEntityId;
  polygon: Vec2[]; // CCW
  z0: number;
  z1: number;
  materialIndex: number;
}

export function buildWallChunkGeometry(
  solve: WallSolveResult,
  levelElevation = 0,
  options: WallChunkBuildOptions = {},
): WallChunkData {
  const prisms: Prism[] = [];
  for (const f of solve.footprints) {
    const poly = normalizeCcw(f.corners as unknown as Vec2[]);
    if (poly.length < 3) continue;
    prisms.push({
      entityId: f.edgeId,
      polygon: poly,
      z0: levelElevation + f.baseOffset,
      z1: levelElevation + f.baseOffset + f.height,
      materialIndex: options.materialIndexByEntityId?.get(f.edgeId) ?? 0,
    });
  }
  for (const w of solve.wedges) {
    const poly = normalizeCcw(w.polygon);
    if (poly.length < 3) continue;
    prisms.push({
      entityId: w.nodeId,
      polygon: poly,
      z0: levelElevation + w.baseOffset,
      z1: levelElevation + w.baseOffset + w.height,
      materialIndex: options.materialIndexByEntityId?.get(w.nodeId) ?? 0,
    });
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const entityIndex: number[] = [];
  const indices: number[] = [];
  const entityIds: WallEntityId[] = [];
  const entityIdxOf = new Map<WallEntityId, number>();
  const groups: Array<{ start: number; count: number; materialIndex: number }> = [];

  const vertex = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    ei: number,
    u: number,
    v: number,
  ): number => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    uvs.push(u, v);
    entityIndex.push(ei);
    return positions.length / 3 - 1;
  };

  for (const prism of prisms) {
    let ei = entityIdxOf.get(prism.entityId);
    if (ei === undefined) {
      ei = entityIds.length;
      entityIds.push(prism.entityId);
      entityIdxOf.set(prism.entityId, ei);
    }
    const poly = prism.polygon;
    const groupStart = indices.length;
    const contour = poly.map((p) => new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);

    // top cap (+Z) and bottom cap (−Z)
    const topBase = positions.length / 3;
    for (const p of poly) vertex(p[0], p[1], prism.z1, 0, 0, 1, ei, p[0], p[1]);
    for (const t of tris) indices.push(topBase + t[0], topBase + t[1], topBase + t[2]);
    const botBase = positions.length / 3;
    for (const p of poly) vertex(p[0], p[1], prism.z0, 0, 0, -1, ei, p[0], p[1]);
    for (const t of tris) indices.push(botBase + t[2], botBase + t[1], botBase + t[0]);

    // side quads
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const len = Math.hypot(ex, ey);
      if (len < 1e-9) continue;
      // CCW polygon → outward normal = (edge dir) rotated -90° = (ey, -ex)
      const nx = ey / len;
      const ny = -ex / len;
      const v0 = vertex(a[0], a[1], prism.z0, nx, ny, 0, ei, 0, prism.z0);
      const v1 = vertex(b[0], b[1], prism.z0, nx, ny, 0, ei, len, prism.z0);
      const v2 = vertex(b[0], b[1], prism.z1, nx, ny, 0, ei, len, prism.z1);
      const v3 = vertex(a[0], a[1], prism.z1, nx, ny, 0, ei, 0, prism.z1);
      indices.push(v0, v1, v2, v0, v2, v3);
    }
    groups.push({
      start: groupStart,
      count: indices.length - groupStart,
      materialIndex: prism.materialIndex,
    });
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.setAttribute(
    "entityIndex",
    new THREE.BufferAttribute(new Float32Array(entityIndex), 1),
  );
  geometry.setIndex(indices);
  groups.forEach((group) => geometry.addGroup(group.start, group.count, group.materialIndex));
  return { geometry, entityIds, edgesGeometry: buildBoundaryEdgesGeometry(positions, indices) };
}

/**
 * Feature-edge extraction for crisp CAD silhouettes. Geometry positions are
 * hashed so separately-owned cap/side vertices still resolve as one physical
 * edge; coplanar triangulation edges are suppressed by the crease threshold.
 */
export function buildBoundaryEdgesGeometry(
  positions: readonly number[],
  indices: readonly number[],
): THREE.BufferGeometry {
  const source = new THREE.BufferGeometry();
  source.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  source.setIndex([...indices]);
  // Position-hashed crease extraction suppresses coincident cap/side borders
  // and coplanar tessellation seams while retaining silhouettes and openings.
  const edges = new THREE.EdgesGeometry(source, 32);
  source.dispose();
  return edges;
}

function normalizeCcw(poly: Vec2[]): Vec2[] {
  const cleaned = poly.filter(
    (p, i) =>
      Math.hypot(
        p[0] - poly[(i + 1) % poly.length]![0],
        p[1] - poly[(i + 1) % poly.length]![1],
      ) > 1e-9,
  );
  if (cleaned.length < 3) return [];
  return polygonArea(cleaned) < 0 ? [...cleaned].reverse() : cleaned;
}
