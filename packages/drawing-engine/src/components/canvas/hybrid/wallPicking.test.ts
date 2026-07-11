import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { createEmptyWallGraph, DEFAULT_WALL_PARAMS, sequentialWallIds } from '../../../wallcore/wallModel';
import { addWallChain } from '../../../wallcore/wallOps';
import { solveWallGraphDoc } from '../../../wallcore/wallSolver';
import { buildWallChunkGeometry } from '../wallview/wallMeshBuilder';

import { HandleLayer3D } from './handleLayer3D';
import { entityIdAtVertex, extractEntityTriangles, resolveWallHitId } from './wallPicking';

function buildLChunk() {
  const doc = createEmptyWallGraph();
  const created = addWallChain(
    doc,
    [[0, 0], [3000, 0], [3000, 3000]],
    DEFAULT_WALL_PARAMS,
    sequentialWallIds('pk'),
  );
  return { chunk: buildWallChunkGeometry(solveWallGraphDoc(doc), 0), created, doc };
}

describe('3D wall picking helpers', () => {
  it('entityIdAtVertex round-trips ids through the entityIndex attribute', () => {
    const { chunk } = buildLChunk();
    const index = chunk.geometry.getIndex()!;
    const attr = chunk.geometry.getAttribute('entityIndex');
    for (let t = 0; t < index.count; t += 3) {
      const v = index.getX(t);
      const id = entityIdAtVertex(chunk.geometry, chunk.entityIds, v);
      expect(id).toBe(chunk.entityIds[attr.getX(v)]);
      expect(id).not.toBeNull();
    }
  });

  it('resolveWallHitId prefers wall edges and skips junction-wedge node hits', () => {
    const { chunk, created } = buildLChunk();
    const wallIds = new Set(created);
    const mesh = new THREE.Mesh(chunk.geometry);
    const index = chunk.geometry.getIndex()!;
    const attr = chunk.geometry.getAttribute('entityIndex');

    // Find one face of a wall edge and (if present) one of a non-edge entity.
    let edgeFaceVertex = -1;
    for (let t = 0; t < index.count && edgeFaceVertex < 0; t += 3) {
      const v = index.getX(t);
      if (wallIds.has(chunk.entityIds[attr.getX(v)]!)) edgeFaceVertex = v;
    }
    expect(edgeFaceVertex).toBeGreaterThanOrEqual(0);

    const hit = {
      distance: 1,
      face: { a: edgeFaceVertex, b: 0, c: 0 },
      object: mesh,
    } as unknown as THREE.Intersection;
    expect(resolveWallHitId([hit], chunk.entityIds, wallIds)).toBe(
      chunk.entityIds[attr.getX(edgeFaceVertex)],
    );
    // A hit list with no wall-edge faces resolves to null (never a node id).
    expect(resolveWallHitId([], chunk.entityIds, wallIds)).toBeNull();
  });

  it('extractEntityTriangles builds a proxy with only the target triangles', () => {
    const { chunk, created } = buildLChunk();
    const first = created[0]!;
    const proxy = extractEntityTriangles(chunk.geometry, chunk.entityIds, new Set([first]));
    expect(proxy).not.toBeNull();
    const proxyVerts = proxy!.getAttribute('position').count;
    expect(proxyVerts % 3).toBe(0);
    // Proxy is strictly smaller than the whole chunk.
    const index = chunk.geometry.getIndex()!;
    expect(proxyVerts).toBeLessThan(index.count);
    // Unknown target → null.
    expect(extractEntityTriangles(chunk.geometry, chunk.entityIds, new Set(['nope']))).toBeNull();
  });
});

describe('HandleLayer3D hit testing', () => {
  it('returns the nearest handle within the pixel radius, else null', () => {
    const layer = new HandleLayer3D();
    layer.setDefs([
      { id: 'ep:n1', kind: 'endpoint', p: [0, 0, 5], entityId: 'n1' },
      { id: 'mi:e1', kind: 'midpointInsert', p: [100, 0, 5], entityId: 'e1' },
    ]);
    // Fake projection: model x/y == screen x/y.
    const worldToScreen = (p: THREE.Vector3) => ({ x: p.x, y: -p.y });
    const modelToWorld = (p: readonly [number, number, number]) =>
      new THREE.Vector3(p[0], -p[1], p[2]);

    expect(layer.hitTest(3, 0, worldToScreen, modelToWorld)?.id).toBe('ep:n1');
    expect(layer.hitTest(97, 0, worldToScreen, modelToWorld)?.id).toBe('mi:e1');
    expect(layer.hitTest(50, 0, worldToScreen, modelToWorld)).toBeNull(); // outside 6px
    layer.dispose();
  });

  it('setState highlights exactly one handle and reports changes', () => {
    const layer = new HandleLayer3D();
    layer.setDefs([
      { id: 'a', kind: 'endpoint', p: [0, 0, 0], entityId: 'n1' },
      { id: 'b', kind: 'endpoint', p: [10, 0, 0], entityId: 'n2' },
    ]);
    expect(layer.setState('a', 'hover')).toBe(true);
    expect(layer.getDefs().find((d) => d.id === 'a')?.state).toBe('hover');
    expect(layer.getDefs().find((d) => d.id === 'b')?.state ?? 'idle').toBe('idle');
    expect(layer.setState('a', 'hover')).toBe(false); // no change
    expect(layer.setState('', 'idle')).toBe(true); // clears hover
    layer.dispose();
  });
});
