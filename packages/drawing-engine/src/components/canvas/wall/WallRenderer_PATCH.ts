/**
 * WallRenderer — KEY CHANGES ONLY
 *
 * This file shows the specific functions in WallRenderer that need to change
 * to fix the offset line and dynamic update bugs. It's not a full rewrite —
 * it's the MINIMAL changes to your existing WallRenderer.ts.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CHANGE 1: Import the pipeline
 * CHANGE 2: renderAllWalls() accepts joinsMap parameter
 * CHANGE 3: updateWall() calls refreshOffsetLines before re-rendering
 * CHANGE 4: renderWall() validates polygon before rendering
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CHANGE 1: Add these imports to the top of WallRenderer.ts
// ═══════════════════════════════════════════════════════════════════════════════

import {
  refreshOffsetLines,
  computeWallPolygon,
  computeWallBodyPolygon,
  isPolygonSelfIntersecting,
  wallLength,
} from './WallGeometry';
import {
  refreshAllWalls,
  refreshAfterPointMove,
  validateWallPolygon,
} from './WallUpdatePipeline';

import type { Point2D, Wall, JoinData } from '../../../types';

// ═══════════════════════════════════════════════════════════════════════════════
// CHANGE 2: renderAllWalls() now accepts a pre-computed joinsMap
// ═══════════════════════════════════════════════════════════════════════════════

/*
 Replace your existing renderAllWalls() signature with this:
*/

class WallRenderer_PatchedMethods {

  private canvas: any; // fabric.Canvas
  private wallData: Map<string, Wall> = new Map();
  // ... (keep all existing private fields)

  /**
   * Render all walls with proper joins.
   *
   * [KEY CHANGE] Now accepts an optional joinsMap parameter.
   * If not provided, it computes fresh joins internally.
   * This allows the drag handler to pass pre-computed joins.
   */
  renderAllWalls(walls: Wall[], precomputedJoinsMap?: Map<string, JoinData[]>): void {
    // [KEY FIX] Disable intermediate repaints during batch add
    const previousRenderOnAdd = (this.canvas as any).renderOnAddRemove;
    (this.canvas as any).renderOnAddRemove = false;

    try {
      // Clear existing objects (same as before)
      // this.clearMergedComponents();
      // this.clearSelectionComponents();
      // this.wallObjects.forEach((obj) => this.canvas.remove(obj));
      // this.wallObjects.clear();
      // this.wallData.clear();
      // this.controlPointObjects.forEach((controls) => {
      //   controls.forEach((control) => this.canvas.remove(control));
      // });
      // this.controlPointObjects.clear();

      walls.forEach((wall) => this.wallData.set(wall.id, wall));

      // ★ KEY FIX: Use pre-computed joins if available, otherwise compute fresh
      const joinsMap = precomputedJoinsMap ?? refreshAllWalls(walls);

      // Render merged components (same as before, but with fresh joins)
      // const renderData = computeWallUnionRenderData(walls);
      // ... render merged components ...

      // Render individual walls with fresh joins
      for (const wall of walls) {
        const joins = joinsMap.get(wall.id) || [];
        this.renderWall_patched(wall, joins);
      }

      // Restore selection (same as before)
      // this.setSelectedWalls([...this.selectedWallIds]);

    } finally {
      (this.canvas as any).renderOnAddRemove = previousRenderOnAdd ?? true;
      this.canvas.requestRenderAll();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CHANGE 3: updateWall() refreshes offset lines and joins
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Update a single wall's rendering after its geometry changed.
   *
   * [KEY FIX] Now refreshes offset lines BEFORE computing joins.
   * This is the fix for the "massive diagonal stripe" bug during drag.
   */
  updateWall(wall: Wall): void {
    this.wallData.set(wall.id, wall);

    // ★ CRITICAL FIX: Refresh offset lines for this wall
    refreshOffsetLines(wall);

    // ★ CRITICAL FIX: Also refresh connected walls' offset lines
    for (const connectedId of wall.connectedWalls) {
      const connected = this.wallData.get(connectedId);
      if (connected) {
        refreshOffsetLines(connected);
      }
    }

    // ★ Now compute fresh joins with the updated offset lines
    const allWalls = Array.from(this.wallData.values());
    const joinsMap = refreshAfterPointMove(wall.id, allWalls);

    // Re-render everything with fresh joins
    this.renderAllWalls(allWalls, joinsMap);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CHANGE 4: renderWall() validates the polygon
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Render a single wall with join data.
   *
   * [KEY FIX] Validates the wall polygon before rendering.
   * If the polygon is self-intersecting or has unreasonable area,
   * falls back to the basic rectangle.
   */
  renderWall_patched(wall: Wall, joins?: JoinData[]): void {
    // Compute the wall polygon with joins
    let polygon = computeWallPolygon(wall, joins);

    // ★ CRITICAL FIX: Validate the polygon
    polygon = validateWallPolygon(polygon, wall);

    // Convert to canvas coordinates
    const MM_TO_PX = 0.2; // your actual value
    const canvasVertices = polygon.map((v) => ({
      x: v.x * MM_TO_PX,
      y: v.y * MM_TO_PX,
    }));

    // ... rest of your rendering code uses canvasVertices instead of
    // computing its own polygon ...

    // The interaction polygon (for hit testing) should also use the
    // validated polygon, not a separate unvalidated one:
    const interactionVertices = canvasVertices; // same polygon
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHANGE 5: If you have a separate drag handler file, here's the pattern
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Example: How to handle wall endpoint dragging with the pipeline.
 *
 * This replaces whatever you currently do in your mouse-move handler
 * during wall point dragging.
 */
function exampleDragHandler(
  wallId: string,
  endpoint: 'start' | 'end',
  newPosition: Point2D,
  allWalls: Wall[],
  renderer: WallRenderer_PatchedMethods,
) {
  const wall = allWalls.find(w => w.id === wallId);
  if (!wall) return;

  // Step 1: Update the point
  if (endpoint === 'start') {
    wall.startPoint = { ...newPosition };
  } else {
    wall.endPoint = { ...newPosition };
  }

  // Step 2: ★ CRITICAL — refresh offset lines BEFORE computing joins
  refreshOffsetLines(wall);

  // Step 3: Refresh offset lines for ALL connected walls too
  for (const connectedId of wall.connectedWalls) {
    const connected = allWalls.find(w => w.id === connectedId);
    if (connected) {
      refreshOffsetLines(connected);
    }
  }

  // Step 4: Compute fresh joins with the updated geometry
  const joinsMap = refreshAfterPointMove(wallId, allWalls);

  // Step 5: Render with fresh data
  renderer.renderAllWalls(allWalls, joinsMap);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHANGE 6: WallUnionGeometry needs validated polygons
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * If you use WallUnionGeometry.computeWallUnionRenderData(), you need to
 * ensure it uses validated polygons. The simplest change is to add
 * validation inside that function before the polygon boolean operations.
 *
 * In WallUnionGeometry.ts, wherever you call computeWallPolygon:
 *
 *   BEFORE:
 *     const polygon = computeWallPolygon(wall, joins);
 *
 *   AFTER:
 *     let polygon = computeWallPolygon(wall, joins);
 *     polygon = validateWallPolygon(polygon, wall);
 *
 * This prevents garbage polygons from corrupting the union result.
 */

export {};
