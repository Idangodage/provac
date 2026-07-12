import { describe, expect, it } from 'vitest';

import { sequentialWallIds, createEmptyWallGraph, DEFAULT_WALL_PARAMS } from '../../../wallcore/wallModel';
import { addWallChain } from '../../../wallcore/wallOps';
import { solveWallGraphDoc } from '../../../wallcore/wallSolver';

import { buildWallChunkGeometry } from './wallMeshBuilder';

describe('wall chunk geometry (reference wallMesh port)', () => {
  it('builds one merged prism chunk with per-vertex entityIndex picking data', () => {
    const doc = createEmptyWallGraph();
    addWallChain(
      doc,
      [[0, 0], [5000, 0], [5000, 3000], [0, 3000], [0, 0]],
      DEFAULT_WALL_PARAMS,
      sequentialWallIds('m'),
    );
    const solve = solveWallGraphDoc(doc);
    const chunk = buildWallChunkGeometry(solve, 0);

    // 4 footprints; rectangle corners are valence-2 miters → no wedges
    expect(solve.footprints).toHaveLength(4);
    expect(solve.wedges).toHaveLength(0);
    expect(chunk.entityIds).toHaveLength(4);

    const pos = chunk.geometry.getAttribute('position');
    const ent = chunk.geometry.getAttribute('entityIndex');
    const uv = chunk.geometry.getAttribute('uv');
    expect(pos.count).toBeGreaterThan(0);
    expect(ent.count).toBe(pos.count);
    expect(uv.count).toBe(pos.count);
    expect(chunk.geometry.groups).toHaveLength(chunk.entityIds.length);
    expect(chunk.geometry.getIndex()!.count % 3).toBe(0);

    // every z is either the base (0) or the top (wall height)
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      expect(z === 0 || z === DEFAULT_WALL_PARAMS.height).toBe(true);
    }

    // entityIndex values map into entityIds
    for (let i = 0; i < ent.count; i++) {
      const idx = ent.getX(i);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(chunk.entityIds.length);
    }
  });

  it('emits every physical box edge once (single wall box = 12 segments)', () => {
    const doc = createEmptyWallGraph();
    addWallChain(doc, [[0, 0], [4000, 0]], DEFAULT_WALL_PARAMS, sequentialWallIds('e'));
    const chunk = buildWallChunkGeometry(solveWallGraphDoc(doc), 0);
    // One prism: top cap 4 border edges + bottom 4 + four side quads × 4 —
    // triangle diagonals (shared indices within a face) cancel out.
    const positions = chunk.edgesGeometry.getAttribute('position');
    expect(positions.count).toBe(12 * 2);
  });

  it('T-junction wedge becomes a prism too (junction core is solid)', () => {
    const doc = createEmptyWallGraph();
    const ids = sequentialWallIds('t');
    addWallChain(doc, [[-3000, 0], [3000, 0]], DEFAULT_WALL_PARAMS, ids);
    addWallChain(doc, [[0, 0], [0, 3000]], DEFAULT_WALL_PARAMS, ids);
    const solve = solveWallGraphDoc(doc);
    expect(solve.wedges).toHaveLength(1);
    const chunk = buildWallChunkGeometry(solve, 0);
    // 3 edges (host split in two + stem) + 1 wedge
    expect(chunk.entityIds).toHaveLength(4);
  });

  it('assigns deterministic material groups without splitting the pick chunk', () => {
    const doc = createEmptyWallGraph();
    addWallChain(doc, [[0, 0], [4000, 0]], DEFAULT_WALL_PARAMS, sequentialWallIds('g'));
    const solve = solveWallGraphDoc(doc);
    const edgeId = solve.footprints[0]!.edgeId;
    const chunk = buildWallChunkGeometry(solve, 0, {
      materialIndexByEntityId: new Map([[edgeId, 3]]),
    });

    expect(chunk.geometry.groups).toHaveLength(1);
    expect(chunk.geometry.groups[0]!.materialIndex).toBe(3);
    expect(chunk.entityIds).toEqual([edgeId]);
  });
});
