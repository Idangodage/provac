/**
 * Snapping Utilities
 *
 * Grid and wall snapping logic for the drawing canvas.
 */

import type { Point2D } from '../../types';

// Re-export geometry functions for convenience
export { distanceBetween, clamp, projectPointToSegment } from './geometry';

// =============================================================================
// Grid Snapping
// =============================================================================

export function snapPointToGrid(point: Point2D, gridSize: number): Point2D {
    return {
        x: Math.round(point.x / gridSize) * gridSize,
        y: Math.round(point.y / gridSize) * gridSize,
    };
}

export function applyOrthogonalConstraint(start: Point2D, target: Point2D): Point2D {
    const dx = target.x - start.x;
    const dy = target.y - start.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
        return { x: target.x, y: start.y };
    }
    return { x: start.x, y: target.y };
}
