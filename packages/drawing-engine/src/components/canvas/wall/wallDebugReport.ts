/**
 * Dev-only summary of the walls for the debug handle: what the plan draws, what
 * the 3D view extrudes and what selection uses, so a canvas driver can compare
 * them with what it sees on screen.
 */
import type { Point2D, Wall } from '../../../types';
import { solveWallList } from '../../../wallcore/solvedWalls';

import { computeSelectableWallPolygon } from './WallSelectionGeometry';
import { computeWallUnionRenderData } from './WallUnionGeometry';

export function wallDebugReport(walls: Wall[], rooms: number, selectedIds: readonly string[]) {
  const render = computeWallUnionRenderData(walls);
  const { doc: graph, solve } = solveWallList(walls);
  const selection: Record<string, Point2D[]> = {};
  walls.forEach((wall) => {
    selection[wall.id] = computeSelectableWallPolygon(wall, render.joinsMap, walls);
  });
  return {
    rooms,
    selectedIds,
    /** True when the plan comes from the same solve as the 3D prisms. */
    solverPath: walls.length === 0 || walls.every((wall) => wall.graph),
    walls: walls.map((wall) => ({
      id: wall.id,
      startPoint: wall.startPoint,
      endPoint: wall.endPoint,
      thickness: wall.thickness,
      height: wall.properties3D.height,
      baseElevation: wall.properties3D.baseElevation,
      openings: wall.openings,
      graph: wall.graph ?? null,
      material: wall.material,
      layer: wall.layer,
    })),
    bodies: render.components.map((component) => ({
      id: component.id,
      wallIds: component.wallIds,
      polygons: component.polygons.length,
      holes: component.polygons.reduce((count, polygon) => count + polygon.length - 1, 0),
    })),
    core: solve.wedges.map((wedge) => {
      const node = graph.nodes[wedge.nodeId]?.p ?? [0, 0];
      return {
        node: { x: node[0], y: node[1] },
        polygon: wedge.polygon.map(([x, y]) => ({ x, y })),
        height: wedge.height,
        baseOffset: wedge.baseOffset,
      };
    }),
    selection,
  };
}
