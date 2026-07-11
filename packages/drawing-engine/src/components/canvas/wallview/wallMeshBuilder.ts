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

interface Prism {
  entityId: WallEntityId;
  polygon: Vec2[]; // CCW
  z0: number;
  z1: number;
}

export function buildWallChunkGeometry(
  solve: WallSolveResult,
  levelElevation = 0,
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
    });
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const entityIndex: number[] = [];
  const indices: number[] = [];
  const entityIds: WallEntityId[] = [];
  const entityIdxOf = new Map<WallEntityId, number>();

  const vertex = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    ei: number,
  ): number => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
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
    const contour = poly.map((p) => new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);

    // top cap (+Z) and bottom cap (−Z)
    const topBase = positions.length / 3;
    for (const p of poly) vertex(p[0], p[1], prism.z1, 0, 0, 1, ei);
    for (const t of tris) indices.push(topBase + t[0], topBase + t[1], topBase + t[2]);
    const botBase = positions.length / 3;
    for (const p of poly) vertex(p[0], p[1], prism.z0, 0, 0, -1, ei);
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
      const v0 = vertex(a[0], a[1], prism.z0, nx, ny, 0, ei);
      const v1 = vertex(b[0], b[1], prism.z0, nx, ny, 0, ei);
      const v2 = vertex(b[0], b[1], prism.z1, nx, ny, 0, ei);
      const v3 = vertex(a[0], a[1], prism.z1, nx, ny, 0, ei);
      indices.push(v0, v1, v2, v0, v2, v3);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute(
    "entityIndex",
    new THREE.BufferAttribute(new Float32Array(entityIndex), 1),
  );
  geometry.setIndex(indices);
  return { geometry, entityIds, edgesGeometry: buildBoundaryEdgesGeometry(positions, indices) };
}

/**
 * Unique-edge extraction (reference `rebuildEdges` port). Edges are keyed by
 * RAW vertex indices, exactly like the reference: faces never share indices
 * (caps and side quads each own their vertices), so face-border edges survive
 * as outlines, while triangle diagonals INSIDE a face (shared indices within
 * the same cap fan / quad) appear twice and cancel. The result is the crisp
 * quad-outline wireframe of the screenshots — no triangle diagonals.
 */
export function buildBoundaryEdgesGeometry(
  positions: readonly number[],
  indices: readonly number[],
): THREE.BufferGeometry {
  const edgeCount = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k += 1) {
      const va = indices[t + k]!;
      const vb = indices[t + ((k + 1) % 3)]!;
      if (va === vb) continue;
      const key = va < vb ? `${va}_${vb}` : `${vb}_${va}`;
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
    }
  }

  const linePositions: number[] = [];
  for (const [key, count] of edgeCount) {
    if (count !== 1) continue;
    const [a, b] = key.split('_').map(Number) as [number, number];
    linePositions.push(
      positions[a * 3]!, positions[a * 3 + 1]!, positions[a * 3 + 2]!,
      positions[b * 3]!, positions[b * 3 + 1]!, positions[b * 3 + 2]!,
    );
  }
  const edges = new THREE.BufferGeometry();
  edges.setAttribute("position", new THREE.BufferAttribute(new Float32Array(linePositions), 3));
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
