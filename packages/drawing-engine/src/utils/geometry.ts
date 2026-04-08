/**
 * Geometry Utilities
 * 
 * Core geometry functions for CAD operations.
 * Industry-standard implementations for 2D geometry.
 */

import type { Point2D, Bounds } from '../types';

// =============================================================================
// ID Generation
// =============================================================================

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

// =============================================================================
// Basic Math
// =============================================================================

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function roundToNearest(value: number, step: number): number {
  return Math.round(value / step) * step;
}

export function roundValue(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpPoint(a: Point2D, b: Point2D, t: number): Point2D {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
  };
}

// =============================================================================
// Point Operations
// =============================================================================

export function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function distanceSquared(a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dx * dx + dy * dy;
}

export function midpoint(a: Point2D, b: Point2D): Point2D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function angleBetween(from: Point2D, to: Point2D): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

export function normalOffset(a: Point2D, b: Point2D, offset: number): Point2D {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  return { x: (-dy / len) * offset, y: (dx / len) * offset };
}

export function rotatePoint(point: Point2D, center: Point2D, angleDegrees: number): Point2D {
  const radians = (angleDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

// =============================================================================
// Polygon Operations
// =============================================================================

export function calculatePolygonArea(vertices: Point2D[]): number {
  if (vertices.length < 3) return 0;
  let area = 0;
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += vertices[i].x * vertices[j].y;
    area -= vertices[j].x * vertices[i].y;
  }
  return Math.abs(area / 2);
}

export function calculateCentroid(points: Point2D[]): Point2D {
  if (points.length === 0) return { x: 0, y: 0 };
  const sum = points.reduce(
    (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
    { x: 0, y: 0 }
  );
  return {
    x: sum.x / points.length,
    y: sum.y / points.length,
  };
}

export function polygonBounds(points: Point2D[]): Bounds {
  if (points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }
  
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  points.forEach((point) => {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  });

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(maxX - minX, 0.1),
    height: Math.max(maxY - minY, 0.1),
  };
}

export function isPointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
  let inside = false;
  const n = polygon.length;
  
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    
    if (((yi > point.y) !== (yj > point.y)) &&
        (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  
  return inside;
}

// =============================================================================
// Line/Segment Operations
// =============================================================================

export function distancePointToSegment(
  point: Point2D, 
  start: Point2D, 
  end: Point2D
): { distance: number; t: number; projection: Point2D } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lenSq = dx * dx + dy * dy;
  
  if (lenSq < 0.000001) {
    return { 
      distance: distance(point, start), 
      t: 0, 
      projection: { ...start } 
    };
  }
  
  const t = clamp(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lenSq,
    0,
    1
  );
  
  const projection = {
    x: start.x + t * dx,
    y: start.y + t * dy,
  };
  
  return {
    distance: distance(point, projection),
    t,
    projection,
  };
}

export function segmentsIntersect(
  a1: Point2D, 
  a2: Point2D, 
  b1: Point2D, 
  b2: Point2D
): boolean {
  const epsilon = 1e-6;

  const orient = (p: Point2D, q: Point2D, r: Point2D): number =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);

  const onSegment = (p: Point2D, q: Point2D, r: Point2D): boolean =>
    Math.min(p.x, r.x) - epsilon <= q.x &&
    q.x <= Math.max(p.x, r.x) + epsilon &&
    Math.min(p.y, r.y) - epsilon <= q.y &&
    q.y <= Math.max(p.y, r.y) + epsilon;

  const o1 = orient(a1, a2, b1);
  const o2 = orient(a1, a2, b2);
  const o3 = orient(b1, b2, a1);
  const o4 = orient(b1, b2, a2);

  if (Math.abs(o1) < epsilon && onSegment(a1, b1, a2)) return true;
  if (Math.abs(o2) < epsilon && onSegment(a1, b2, a2)) return true;
  if (Math.abs(o3) < epsilon && onSegment(b1, a1, b2)) return true;
  if (Math.abs(o4) < epsilon && onSegment(b1, a2, b2)) return true;

  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

export function lineIntersection(
  a1: Point2D,
  a2: Point2D,
  b1: Point2D,
  b2: Point2D
): Point2D | null {
  const d1x = a2.x - a1.x;
  const d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x;
  const d2y = b2.y - b1.y;
  
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-10) return null;
  
  const dx = b1.x - a1.x;
  const dy = b1.y - a1.y;
  const t = (dx * d2y - dy * d2x) / cross;
  
  return {
    x: a1.x + t * d1x,
    y: a1.y + t * d1y,
  };
}

// =============================================================================
// Polyline Operations
// =============================================================================

export function polylineLength(points: Point2D[]): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += distance(points[i], points[i + 1]);
  }
  return total;
}

export function projectPointToPolyline(
  points: Point2D[], 
  target: Point2D
): { index: number; point: Point2D; distance: number } | null {
  if (points.length < 2) return null;

  let best: { index: number; point: Point2D; distance: number } | null = null;
  let bestDist = Infinity;

  for (let i = 0; i < points.length - 1; i++) {
    const result = distancePointToSegment(target, points[i], points[i + 1]);
    if (result.distance < bestDist) {
      bestDist = result.distance;
      best = { index: i, point: result.projection, distance: result.distance };
    }
  }

  return best;
}

export function simplifyPolyline(points: Point2D[], epsilon: number): Point2D[] {
  if (points.length < 3) return [...points];
  
  // Ramer-Douglas-Peucker algorithm
  const sqDist = (p: Point2D, a: Point2D, b: Point2D): number => {
    const A = b.x - a.x;
    const B = b.y - a.y;
    const num = Math.abs(B * p.x - A * p.y + b.x * a.y - b.y * a.x);
    return (num * num) / (A * A + B * B + 1e-12);
  };
  
  let index = -1;
  let maxDist = 0;
  const first = points[0];
  const last = points[points.length - 1];
  
  for (let i = 1; i < points.length - 1; i++) {
    const d = sqDist(points[i], first, last);
    if (d > maxDist) {
      index = i;
      maxDist = d;
    }
  }
  
  if (maxDist > epsilon * epsilon) {
    const left = simplifyPolyline(points.slice(0, index + 1), epsilon);
    const right = simplifyPolyline(points.slice(index), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  
  return [first, last];
}

// =============================================================================
// Bounds Operations
// =============================================================================

export function mergeBounds(boundsList: Bounds[]): Bounds {
  if (boundsList.length === 0) {
    return { minX: 0, minY: 0, maxX: 10, maxY: 10, width: 10, height: 10 };
  }
  
  const combined = boundsList.reduce(
    (acc, item) => ({
      minX: Math.min(acc.minX, item.minX),
      minY: Math.min(acc.minY, item.minY),
      maxX: Math.max(acc.maxX, item.maxX),
      maxY: Math.max(acc.maxY, item.maxY),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  );
  
  return {
    ...combined,
    width: Math.max(combined.maxX - combined.minX, 0.1),
    height: Math.max(combined.maxY - combined.minY, 0.1),
  };
}

export function expandBounds(bounds: Bounds, padding: number): Bounds {
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  };
}

// =============================================================================
// SVG Path Builders
// =============================================================================

export function buildArcPath(start: Point2D, end: Point2D, control: Point2D): string {
  return `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
}

export function buildRevisionCloudPath(start: Point2D, end: Point2D, radius: number): string {
  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);

  const width = Math.max(right - left, radius * 2);
  const height = Math.max(bottom - top, radius * 2);
  const stepsX = Math.max(4, Math.round(width / (radius * 1.5)));
  const stepsY = Math.max(4, Math.round(height / (radius * 1.5)));
  const stepX = width / stepsX;
  const stepY = height / stepsY;

  const points: Point2D[] = [];
  
  for (let i = 0; i <= stepsX; i++) {
    points.push({ x: left + i * stepX, y: top });
  }
  for (let i = 1; i <= stepsY; i++) {
    points.push({ x: right, y: top + i * stepY });
  }
  for (let i = 1; i <= stepsX; i++) {
    points.push({ x: right - i * stepX, y: bottom });
  }
  for (let i = 1; i < stepsY; i++) {
    points.push({ x: left, y: bottom - i * stepY });
  }

  if (points.length === 0) return '';

  const path: string[] = [`M ${points[0].x} ${points[0].y}`];
  for (let i = 1; i <= points.length; i++) {
    const current = points[i % points.length];
    const prev = points[i - 1];
    const mid = { x: (prev.x + current.x) / 2, y: (prev.y + current.y) / 2 };
    path.push(`Q ${prev.x} ${prev.y} ${mid.x} ${mid.y}`);
  }
  
  return path.join(' ');
}

// =============================================================================
// Catmull-Rom Sampling
// =============================================================================

export function sampleCatmullRom(points: Point2D[], samplesPerSegment = 4): Point2D[] {
  if (points.length < 2) return [...points];
  
  const out: Point2D[] = [];
  const n = points.length;
  
  for (let i = 0; i < n - 1; i++) {
    const p0 = i === 0 ? points[i] : points[i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = i + 2 < n ? points[i + 2] : p2;

    for (let s = 0; s < samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;

      const a0 = -0.5 * t3 + t2 - 0.5 * t;
      const a1 = 1.5 * t3 - 2.5 * t2 + 1.0;
      const a2 = -1.5 * t3 + 2.0 * t2 + 0.5 * t;
      const a3 = 0.5 * t3 - 0.5 * t2;

      const x = a0 * p0.x + a1 * p1.x + a2 * p2.x + a3 * p3.x;
      const y = a0 * p0.y + a1 * p1.y + a2 * p2.y + a3 * p3.y;
      out.push({ x, y });
    }
  }
  
  out.push({ x: points[n - 1].x, y: points[n - 1].y });
  return out;
}

// =============================================================================
// Utility Functions
// =============================================================================

export function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const key = keyFn(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}
