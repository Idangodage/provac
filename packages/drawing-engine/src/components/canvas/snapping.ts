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

export function applyAngularConstraint(
    start: Point2D,
    target: Point2D,
    angleIncrementDeg: number,
): Point2D {
    const dx = target.x - start.x;
    const dy = target.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.0001) {
        return target;
    }

    const incrementRad = (angleIncrementDeg * Math.PI) / 180;
    if (!Number.isFinite(incrementRad) || incrementRad <= 0) {
        return target;
    }

    const angle = Math.atan2(dy, dx);
    const snappedAngle = Math.round(angle / incrementRad) * incrementRad;
    return {
        x: start.x + Math.cos(snappedAngle) * length,
        y: start.y + Math.sin(snappedAngle) * length,
    };
}
