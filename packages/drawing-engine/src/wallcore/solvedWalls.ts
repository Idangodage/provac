/**
 * One solve per wall list, shared by everything that needs a wall's real shape:
 * the 2D body, selection and click areas, rooms and the 3D prisms. Shapes are
 * derived, never stored on the walls (the wall model's own rule), so no view can
 * hold a stale copy of a corner another view has moved on from.
 */
import { wallGraphFromLegacyWalls, type LegacyWallLike } from './legacyBridge';
import type { WallEntityId, WallGraphDoc } from './wallModel';
import { solveWallGraphDoc, type EdgeFootprint, type WallSolveResult } from './wallSolver';

export interface SolvedWalls {
  doc: WallGraphDoc;
  solve: WallSolveResult;
  footprints: ReadonlyMap<WallEntityId, EdgeFootprint>;
}

const solvedByWallList = new WeakMap<readonly LegacyWallLike[], SolvedWalls>();

/** Wall lists are replaced, never edited in place, so the list itself is the cache key. */
export function solveWallList(walls: readonly LegacyWallLike[]): SolvedWalls {
  const cached = solvedByWallList.get(walls);
  if (cached) return cached;
  // Only walls outside the graph need these node ids, and they live as long as this solve.
  let bareNode = 0;
  const doc = wallGraphFromLegacyWalls(walls, { newId: () => `bare-node-${(bareNode += 1)}` });
  const solve = solveWallGraphDoc(doc);
  const solved: SolvedWalls = {
    doc,
    solve,
    footprints: new Map(solve.footprints.map((footprint) => [footprint.edgeId, footprint])),
  };
  solvedByWallList.set(walls, solved);
  return solved;
}
