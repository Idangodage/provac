/**
 * Geometry Utilities
 *
 * Core geometry functions for point, polygon, and segment operations.
 */

import type { Point2D } from '../../types';

// =============================================================================
// Point Operations
// =============================================================================

export function distanceBetween(a: Point2D, b: Point2D): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
}

export function arePointsClose(a: Point2D, b: Point2D, tolerance: number): boolean {
    return distanceBetween(a, b) <= tolerance;
}

export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

// =============================================================================
// Polygon Operations
// =============================================================================

export function calculatePolygonCentroid(vertices: Point2D[]): Point2D {
    if (vertices.length === 0) return { x: 0, y: 0 };
    if (vertices.length < 3) {
        const sum = vertices.reduce(
            (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
            { x: 0, y: 0 }
        );
        return {
            x: sum.x / vertices.length,
            y: sum.y / vertices.length,
        };
    }

    let signedArea = 0;
    let cx = 0;
    let cy = 0;

    for (let i = 0; i < vertices.length; i++) {
        const current = vertices[i];
        const next = vertices[(i + 1) % vertices.length];
        if (!current || !next) continue;
        const cross = current.x * next.y - next.x * current.y;
        signedArea += cross;
        cx += (current.x + next.x) * cross;
        cy += (current.y + next.y) * cross;
    }

    if (Math.abs(signedArea) < 1e-8) {
        const sum = vertices.reduce(
            (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
            { x: 0, y: 0 }
        );
        return {
            x: sum.x / vertices.length,
            y: sum.y / vertices.length,
        };
    }

    const factor = 1 / (3 * signedArea);
    return {
        x: cx * factor,
        y: cy * factor,
    };
}

export function calculatePolygonBounds(vertices: Point2D[]): {
    left: number;
    top: number;
    right: number;
    bottom: number;
} {
    if (vertices.length === 0) {
        return { left: 0, top: 0, right: 0, bottom: 0 };
    }

    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;

    vertices.forEach((vertex) => {
        left = Math.min(left, vertex.x);
        top = Math.min(top, vertex.y);
        right = Math.max(right, vertex.x);
        bottom = Math.max(bottom, vertex.y);
    });

    return { left, top, right, bottom };
}

export function isPointInsidePolygon(point: Point2D, polygon: Point2D[]): boolean {
    if (polygon.length < 3) return false;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const pi = polygon[i];
        const pj = polygon[j];
        if (!pi || !pj) continue;

        const onSegment =
            distancePointToSegment(point, pj, pi) <= 1e-6 &&
            point.x >= Math.min(pi.x, pj.x) - 1e-6 &&
            point.x <= Math.max(pi.x, pj.x) + 1e-6 &&
            point.y >= Math.min(pi.y, pj.y) - 1e-6 &&
            point.y <= Math.max(pi.y, pj.y) + 1e-6;
        if (onSegment) return true;

        const intersects =
            (pi.y > point.y) !== (pj.y > point.y) &&
            point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y + Number.EPSILON) + pi.x;
        if (intersects) inside = !inside;
    }
    return inside;
}

// =============================================================================
// Segment Operations
// =============================================================================

export function distancePointToSegment(point: Point2D, start: Point2D, end: Point2D): number {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq <= 1e-12) return Math.hypot(point.x - start.x, point.y - start.y);

    const t = clamp(
        ((point.x - start.x) * dx + (point.y - start.y) * dy) / lenSq,
        0,
        1
    );
    const projectionX = start.x + t * dx;
    const projectionY = start.y + t * dy;
    return Math.hypot(point.x - projectionX, point.y - projectionY);
}

export function distancePointToPolygonEdges(point: Point2D, polygon: Point2D[]): number {
    if (polygon.length < 2) return Number.POSITIVE_INFINITY;
    let minDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < polygon.length; i++) {
        const start = polygon[i];
        const end = polygon[(i + 1) % polygon.length];
        if (!start || !end) continue;
        minDistance = Math.min(minDistance, distancePointToSegment(point, start, end));
    }
    return minDistance;
}

export function projectPointToSegment(
    point: Point2D,
    start: Point2D,
    end: Point2D
): { projection: Point2D; t: number; distance: number } {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq <= 1e-8) {
        return {
            projection: { ...start },
            t: 0,
            distance: distanceBetween(point, start),
        };
    }

    const rawT = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lenSq;
    const t = clamp(rawT, 0, 1);
    const projection = {
        x: start.x + dx * t,
        y: start.y + dy * t,
    };

    return {
        projection,
        t,
        distance: distanceBetween(point, projection),
    };
}

