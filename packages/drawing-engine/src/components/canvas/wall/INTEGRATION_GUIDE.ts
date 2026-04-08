/**
 * INTEGRATION GUIDE
 *
 * This file shows exactly WHERE in your existing code you need to call
 * the WallUpdatePipeline functions to fix the two bugs:
 *
 * BUG 1: Interior/exterior lines rendering on centerline (stale offset lines)
 * BUG 2: Wall fill becoming massive diagonal stripe during drag (stale joins)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

// =============================================================================
// INTEGRATION POINT 1: Wall Creation
// =============================================================================
// When you create a new wall, call refreshOffsetLines to set up the initial
// offset lines correctly.

import { refreshOffsetLines } from './WallGeometry';
import { refreshAllWalls, refreshAfterPointMove, validateWallPolygon } from './WallUpdatePipeline';
import { computeWallPolygon } from './WallGeometry';

/*
// In your wall creation function (wherever you do `new Wall(...)` or create a wall object):

function createWall(startPoint, endPoint, thickness, ...): Wall {
  const wall: Wall = {
    id: generateId(),
    startPoint,
    endPoint,
    thickness,
    interiorLine: { start: {x:0,y:0}, end: {x:0,y:0} }, // placeholder
    exteriorLine: { start: {x:0,y:0}, end: {x:0,y:0} }, // placeholder
    // ... other properties
  };

  // ★ CRITICAL: compute offset lines from the centerline
  refreshOffsetLines(wall);

  return wall;
}
*/

// =============================================================================
// INTEGRATION POINT 2: Wall Point Dragging (THE MAIN FIX)
// =============================================================================
// This is where the bug was. When you drag a wall endpoint, you were updating
// startPoint/endPoint but NOT recomputing the offset lines before rendering.

/*
// In your drag handler (e.g., mouse move during wall endpoint drag):

function onWallEndpointDrag(wallId: string, newPosition: Point2D, endpoint: 'start' | 'end') {
  const wall = getWallById(wallId);

  // Update the centerline point
  if (endpoint === 'start') {
    wall.startPoint = newPosition;
  } else {
    wall.endPoint = newPosition;
  }

  // ★ CRITICAL FIX: Recompute offset lines + joins for this wall AND neighbors
  const allWalls = getAllWalls();
  const joinsMap = refreshAfterPointMove(wallId, allWalls);

  // Now render with the fresh joins
  renderer.renderAllWalls(allWalls, joinsMap);
}
*/

// =============================================================================
// INTEGRATION POINT 3: Wall Thickness Change
// =============================================================================

/*
function onWallThicknessChanged(wallId: string, newThickness: number) {
  const wall = getWallById(wallId);
  wall.thickness = newThickness;

  // ★ CRITICAL: thickness changed → offset lines changed
  const allWalls = getAllWalls();
  const joinsMap = refreshAfterPointMove(wallId, allWalls);
  renderer.renderAllWalls(allWalls, joinsMap);
}
*/

// =============================================================================
// INTEGRATION POINT 4: Full Redraw (Initial Load, Undo/Redo)
// =============================================================================

/*
function fullRedraw() {
  const allWalls = getAllWalls();

  // ★ Refresh ALL walls' offset lines and recompute ALL joins
  const joinsMap = refreshAllWalls(allWalls);

  renderer.renderAllWalls(allWalls, joinsMap);
}
*/

// =============================================================================
// INTEGRATION POINT 5: Wall Polygon Computation (in WallRenderer)
// =============================================================================
// Wherever you compute the wall polygon for rendering, validate it.

/*
// In WallRenderer.renderWall():

function renderWall(wall: Wall, joins?: JoinData[]) {
  // Compute polygon with joins
  let polygon = computeWallPolygon(wall, joins);

  // ★ CRITICAL: Validate the polygon — reject self-intersecting / oversized
  polygon = validateWallPolygon(polygon, wall);

  // Now render the polygon (hatched fill, outline, etc.)
  const canvasVertices = polygon.map(v => toCanvasPoint(v));
  // ... fabric.js rendering code ...
}
*/

// =============================================================================
// INTEGRATION POINT 6: Wall Union / Merged Rendering
// =============================================================================
// If you use WallUnionGeometry to merge connected walls into a single path,
// make sure the individual wall polygons are validated BEFORE the union.

/*
// In WallUnionGeometry.computeWallUnionRenderData():

function computeWallUnionRenderData(walls: Wall[]) {
  for (const wall of walls) {
    // ★ Ensure offset lines are fresh
    refreshOffsetLines(wall);

    // Compute and validate polygon
    let polygon = computeWallPolygon(wall, joins);
    polygon = validateWallPolygon(polygon, wall);

    // Use validated polygon in the union computation
    // ...
  }
}
*/

// =============================================================================
// INTEGRATION POINT 7: Room Area Recalculation During Drag
// =============================================================================
// The room area (shown as "13.8 m²" in the screenshots) should update
// in real-time during drag. After refreshing wall geometry, recalculate
// room areas from the wall interior lines.

/*
function updateRoomAreasDuringDrag() {
  const allWalls = getAllWalls();
  const allRooms = getAllRooms();

  // ★ Offset lines are already fresh from the drag handler
  // Now recalculate room vertices from wall interior lines
  for (const room of allRooms) {
    const roomWalls = room.wallIds.map(id => getWallById(id));
    room.vertices = computeRoomVerticesFromWalls(roomWalls);
    room.area = computePolygonArea(room.vertices);
  }
}
*/

// =============================================================================
// SUMMARY OF CHANGES NEEDED
// =============================================================================
/*
The fix boils down to ONE key change:

  BEFORE (buggy):
    wall.startPoint = newPosition;
    renderer.renderAllWalls(walls);  // offset lines are STALE

  AFTER (fixed):
    wall.startPoint = newPosition;
    refreshOffsetLines(wall);         // ★ recompute from current centerline
    const joins = refreshAfterPointMove(wall.id, walls);  // ★ fresh joins
    renderer.renderAllWalls(walls, joins);  // now correct

The WallUpdatePipeline handles the cascading updates:
  1. Refresh offset lines for the changed wall
  2. Refresh offset lines for all connected walls
  3. Recompute joins for all walls
  4. Validate each wall polygon
*/

export {};
