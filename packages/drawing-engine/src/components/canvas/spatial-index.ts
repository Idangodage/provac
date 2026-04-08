/**
 * Spatial Index Utilities
 * 
 * Spatial indexing for efficient wall and room visibility queries.
 * Extracted from DrawingCanvas.tsx for better organization.
 */

// =============================================================================
// Types
// =============================================================================

export interface SceneBounds {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

// =============================================================================
// Constants
// =============================================================================

export const WALL_SPATIAL_INDEX_CELL_PX = 400;
export const WALL_VIEWPORT_MARGIN_PX = 200;

// =============================================================================
// Bounds Utilities
// =============================================================================

export function sceneBoundsIntersect(a: SceneBounds, b: SceneBounds): boolean {
    return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}
