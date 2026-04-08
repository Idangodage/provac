/**
 * Precision drafting tools.
 *
 * Includes coordinate input parsing (absolute/relative/polar) and measurement
 * utilities (distance, angle, area, perimeter).
 */

import type { Point2D } from '../types';
import { calculatePolygonArea, distance, polylineLength } from '../utils/geometry';

// =============================================================================
// Coordinate Input
// =============================================================================

export type CoordinateInputMode = 'absolute' | 'relative' | 'polar';

export interface CoordinateInputContext {
    lastPoint: Point2D;
    globalOrigin?: Point2D;
    angleUnit?: 'deg' | 'rad';
}

export interface CoordinateInputResult {
    mode: CoordinateInputMode;
    point: Point2D;
    raw: string;
}

/**
 * Supported syntax:
 * - absolute: `10,20` or `#10,20`
 * - relative: `@10,20`
 * - polar: `@10<45` (distance<angle)
 */
export function parseCoordinateInput(
    input: string,
    context: CoordinateInputContext
): CoordinateInputResult | null {
    const raw = input.trim();
    if (!raw) return null;

    const globalOrigin = context.globalOrigin ?? { x: 0, y: 0 };
    const angleUnit = context.angleUnit ?? 'deg';

    if (raw.startsWith('@') && raw.includes('<')) {
        const parsed = parsePolar(raw.slice(1), context.lastPoint, angleUnit);
        return parsed
            ? { mode: 'polar', point: parsed, raw }
            : null;
    }

    if (raw.startsWith('@')) {
        const parsed = parsePair(raw.slice(1));
        if (!parsed) return null;
        return {
            mode: 'relative',
            point: {
                x: context.lastPoint.x + parsed.x,
                y: context.lastPoint.y + parsed.y,
            },
            raw,
        };
    }

    if (raw.startsWith('#')) {
        const parsed = parsePair(raw.slice(1));
        if (!parsed) return null;
        return {
            mode: 'absolute',
            point: {
                x: globalOrigin.x + parsed.x,
                y: globalOrigin.y + parsed.y,
            },
            raw,
        };
    }

    if (raw.includes('<')) {
        const parsed = parsePolar(raw, context.lastPoint, angleUnit);
        return parsed
            ? { mode: 'polar', point: parsed, raw }
            : null;
    }

    const parsed = parsePair(raw);
    if (!parsed) return null;
    return {
        mode: 'absolute',
        point: parsed,
        raw,
    };
}

export function formatCoordinate(point: Point2D, precision = 3): string {
    return `${point.x.toFixed(precision)},${point.y.toFixed(precision)}`;
}

function parsePair(value: string): Point2D | null {
    const parts = value.split(',').map((part) => Number.parseFloat(part.trim()));
    if (parts.length !== 2) return null;
    if (!Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
    return { x: parts[0], y: parts[1] };
}

function parsePolar(value: string, anchor: Point2D, angleUnit: 'deg' | 'rad'): Point2D | null {
    const parts = value.split('<').map((part) => Number.parseFloat(part.trim()));
    if (parts.length !== 2) return null;
    if (!Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
    const distanceValue = parts[0];
    const angleRad = angleUnit === 'deg' ? (parts[1] * Math.PI) / 180 : parts[1];
    return {
        x: anchor.x + Math.cos(angleRad) * distanceValue,
        y: anchor.y + Math.sin(angleRad) * distanceValue,
    };
}

// =============================================================================
// Measurement Tools
// =============================================================================

export interface DistanceMeasurement {
    distance: number;
    start: Point2D;
    end: Point2D;
}

export interface AngleMeasurement {
    angleDeg: number;
    angleRad: number;
    a: Point2D;
    vertex: Point2D;
    b: Point2D;
}

export interface AreaMeasurement {
    area: number;
    perimeter: number;
    vertices: Point2D[];
}

export function measureDistance(start: Point2D, end: Point2D): DistanceMeasurement {
    return {
        distance: distance(start, end),
        start,
        end,
    };
}

export function measureAngle(a: Point2D, vertex: Point2D, b: Point2D): AngleMeasurement {
    const va = { x: a.x - vertex.x, y: a.y - vertex.y };
    const vb = { x: b.x - vertex.x, y: b.y - vertex.y };
    const na = Math.hypot(va.x, va.y);
    const nb = Math.hypot(vb.x, vb.y);
    if (na < 1e-9 || nb < 1e-9) {
        return {
            angleDeg: 0,
            angleRad: 0,
            a,
            vertex,
            b,
        };
    }
    const cosine = clamp((va.x * vb.x + va.y * vb.y) / (na * nb), -1, 1);
    const angleRad = Math.acos(cosine);
    return {
        angleDeg: (angleRad * 180) / Math.PI,
        angleRad,
        a,
        vertex,
        b,
    };
}

export function measureArea(vertices: Point2D[]): AreaMeasurement {
    return {
        area: calculatePolygonArea(vertices),
        perimeter: polylineLength([...vertices, vertices[0]].filter(Boolean)),
        vertices,
    };
}

export class PrecisionToolkit {
    parse(input: string, context: CoordinateInputContext): CoordinateInputResult | null {
        return parseCoordinateInput(input, context);
    }

    distance(start: Point2D, end: Point2D): DistanceMeasurement {
        return measureDistance(start, end);
    }

    angle(a: Point2D, vertex: Point2D, b: Point2D): AngleMeasurement {
        return measureAngle(a, vertex, b);
    }

    area(vertices: Point2D[]): AreaMeasurement {
        return measureArea(vertices);
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}
