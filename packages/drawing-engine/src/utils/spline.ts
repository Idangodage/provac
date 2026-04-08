/**
 * Spline Utilities
 * 
 * AutoCAD-compatible spline path builders for CAD applications.
 * Supports multiple spline types: Catmull-Rom, Bezier, B-spline, NURBS.
 */

import type { Point2D, SplineSettings, SplineType } from '../types';

// =============================================================================
// Default Settings
// =============================================================================

export const DEFAULT_SPLINE_SETTINGS: SplineSettings = {
  type: 'catmullRom',
  method: 'catmull-rom',
  fitMethod: 'fit-points',
  tension: 0.5,
  continuity: 1,
  bias: 0,
  closed: false,
  degree: 3,
  fitTolerance: 0.01,
  knotParameterization: 'chord',
  showControlPoints: true,
  showControlPolygon: false,
  showFitPoints: false,
  showTangentHandles: false,
  samplesPerSegment: 10,
};

// =============================================================================
// Helper Functions
// =============================================================================

function factorialCache(): (n: number) => number {
  const cache = new Map<number, number>();
  return (n: number): number => {
    if (n <= 1) return 1;
    if (cache.has(n)) return cache.get(n)!;
    const result = n * factorialCache()(n - 1);
    cache.set(n, result);
    return result;
  };
}

const factorial = factorialCache();

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  return factorial(n) / (factorial(k) * factorial(n - k));
}

// =============================================================================
// Catmull-Rom Spline
// =============================================================================

function catmullRomPoint(
  p0: Point2D,
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  t: number,
  tension: number
): Point2D {
  const t2 = t * t;
  const t3 = t2 * t;

  // Catmull-Rom matrix coefficients with tension
  const tau = tension;
  const b0 = -tau * t + 2 * tau * t2 - tau * t3;
  const b1 = 1 + (tau - 3) * t2 + (2 - tau) * t3;
  const b2 = tau * t + (3 - 2 * tau) * t2 + (tau - 2) * t3;
  const b3 = -tau * t2 + tau * t3;

  return {
    x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
    y: b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y,
  };
}

function buildCatmullRomPath(
  points: Point2D[],
  settings: SplineSettings
): string {
  if (points.length < 2) return '';
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }

  const { tension = 0.5, closed = false, samplesPerSegment = 10 } = settings;
  const curvePoints: Point2D[] = [];
  const n = points.length;

  // Create extended points array for closed curves
  const pts: Point2D[] = closed
    ? [points[n - 1], ...points, points[0], points[1]]
    : [points[0], ...points, points[n - 1]];

  const startIndex = 1;
  const endIndex = closed ? n + 1 : n;

  for (let i = startIndex; i < endIndex; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;

    for (let s = 0; s < samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      curvePoints.push(catmullRomPoint(p0, p1, p2, p3, t, tension));
    }
  }

  if (!closed) {
    curvePoints.push(points[n - 1]);
  } else {
    curvePoints.push(curvePoints[0]);
  }

  return pointsToPath(curvePoints, closed);
}

// =============================================================================
// Bezier Spline
// =============================================================================

function bezierPoint(points: Point2D[], t: number): Point2D {
  const n = points.length - 1;
  let x = 0;
  let y = 0;

  for (let i = 0; i <= n; i++) {
    const b = binomial(n, i) * Math.pow(1 - t, n - i) * Math.pow(t, i);
    x += b * points[i].x;
    y += b * points[i].y;
  }

  return { x, y };
}

function buildBezierPath(
  points: Point2D[],
  settings: SplineSettings
): string {
  if (points.length < 2) return '';
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }

  const { samplesPerSegment = 10 } = settings;
  const curvePoints: Point2D[] = [];
  const totalSamples = points.length * samplesPerSegment;

  for (let i = 0; i <= totalSamples; i++) {
    const t = i / totalSamples;
    curvePoints.push(bezierPoint(points, t));
  }

  return pointsToPath(curvePoints, settings.closed);
}

// =============================================================================
// B-Spline
// =============================================================================

function bsplineBasis(i: number, p: number, t: number, knots: number[]): number {
  if (p === 0) {
    return knots[i] <= t && t < knots[i + 1] ? 1 : 0;
  }

  const denom1 = knots[i + p] - knots[i];
  const denom2 = knots[i + p + 1] - knots[i + 1];

  let term1 = 0;
  let term2 = 0;

  if (denom1 !== 0) {
    term1 = ((t - knots[i]) / denom1) * bsplineBasis(i, p - 1, t, knots);
  }
  if (denom2 !== 0) {
    term2 = ((knots[i + p + 1] - t) / denom2) * bsplineBasis(i + 1, p - 1, t, knots);
  }

  return term1 + term2;
}

function generateUniformKnots(n: number, degree: number, closed: boolean): number[] {
  const numKnots = n + degree + 1;
  const knots: number[] = [];

  if (closed) {
    for (let i = 0; i < numKnots; i++) {
      knots.push(i);
    }
  } else {
    // Clamped knot vector
    for (let i = 0; i < numKnots; i++) {
      if (i <= degree) {
        knots.push(0);
      } else if (i >= n) {
        knots.push(n - degree);
      } else {
        knots.push(i - degree);
      }
    }
  }

  return knots;
}

function bsplinePoint(
  points: Point2D[],
  t: number,
  degree: number,
  knots: number[]
): Point2D {
  const n = points.length;
  let x = 0;
  let y = 0;

  for (let i = 0; i < n; i++) {
    const basis = bsplineBasis(i, degree, t, knots);
    x += basis * points[i].x;
    y += basis * points[i].y;
  }

  return { x, y };
}

function buildBSplinePath(
  points: Point2D[],
  settings: SplineSettings
): string {
  if (points.length < 2) return '';

  const { degree = 3, closed = false, samplesPerSegment = 10 } = settings;
  const actualDegree = Math.min(degree, points.length - 1);
  const n = points.length;

  const controlPoints = closed
    ? [...points, ...points.slice(0, actualDegree)]
    : points;

  const knots = generateUniformKnots(controlPoints.length, actualDegree, closed);
  const curvePoints: Point2D[] = [];
  const tMax = knots[knots.length - 1 - actualDegree] - 0.0001;
  const tMin = knots[actualDegree];
  const totalSamples = (n - 1) * samplesPerSegment;

  for (let i = 0; i <= totalSamples; i++) {
    const t = tMin + (i / totalSamples) * (tMax - tMin);
    curvePoints.push(bsplinePoint(controlPoints, t, actualDegree, knots));
  }

  return pointsToPath(curvePoints, closed);
}

// =============================================================================
// NURBS (Non-Uniform Rational B-Spline)
// =============================================================================

interface WeightedPoint extends Point2D {
  weight?: number;
}

function nurbsPoint(
  points: WeightedPoint[],
  t: number,
  degree: number,
  knots: number[]
): Point2D {
  const n = points.length;
  let x = 0;
  let y = 0;
  let totalWeight = 0;

  for (let i = 0; i < n; i++) {
    const weight = points[i].weight ?? 1;
    const basis = bsplineBasis(i, degree, t, knots) * weight;
    x += basis * points[i].x;
    y += basis * points[i].y;
    totalWeight += basis;
  }

  if (totalWeight === 0) {
    return points[0];
  }

  return { x: x / totalWeight, y: y / totalWeight };
}

function buildNURBSPath(
  points: Point2D[],
  settings: SplineSettings
): string {
  if (points.length < 2) return '';

  const { degree = 3, closed = false, samplesPerSegment = 10 } = settings;
  const actualDegree = Math.min(degree, points.length - 1);
  const n = points.length;

  // Add default weights if not present
  const weightedPoints: WeightedPoint[] = points.map((p) => ({
    ...p,
    weight: (p as WeightedPoint).weight ?? 1,
  }));

  const controlPoints = closed
    ? [...weightedPoints, ...weightedPoints.slice(0, actualDegree)]
    : weightedPoints;

  const knots = generateUniformKnots(controlPoints.length, actualDegree, closed);
  const curvePoints: Point2D[] = [];
  const tMax = knots[knots.length - 1 - actualDegree] - 0.0001;
  const tMin = knots[actualDegree];
  const totalSamples = (n - 1) * samplesPerSegment;

  for (let i = 0; i <= totalSamples; i++) {
    const t = tMin + (i / totalSamples) * (tMax - tMin);
    curvePoints.push(nurbsPoint(controlPoints, t, actualDegree, knots));
  }

  return pointsToPath(curvePoints, closed);
}

// =============================================================================
// Path Building
// =============================================================================

function pointsToPath(points: Point2D[], closed = false): string {
  if (points.length === 0) return '';

  const path = points.map((p, i) => {
    const cmd = i === 0 ? 'M' : 'L';
    return `${cmd} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  });

  if (closed) {
    path.push('Z');
  }

  return path.join(' ');
}

// =============================================================================
// Main Export
// =============================================================================

export function buildSplinePath(
  points: Point2D[],
  settings: Partial<SplineSettings> = {}
): string {
  const fullSettings: SplineSettings = {
    ...DEFAULT_SPLINE_SETTINGS,
    ...settings,
  };

  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  switch (fullSettings.type) {
    case 'catmullRom':
      return buildCatmullRomPath(points, fullSettings);
    case 'bezier':
      return buildBezierPath(points, fullSettings);
    case 'bspline':
      return buildBSplinePath(points, fullSettings);
    case 'nurbs':
      return buildNURBSPath(points, fullSettings);
    default:
      return buildCatmullRomPath(points, fullSettings);
  }
}

// =============================================================================
// Utility Exports
// =============================================================================

export function getSplineTypes(): { value: SplineType; label: string }[] {
  return [
    { value: 'catmullRom', label: 'Catmull-Rom' },
    { value: 'bezier', label: 'Bezier' },
    { value: 'bspline', label: 'B-Spline' },
    { value: 'nurbs', label: 'NURBS' },
  ];
}

export function interpolateSpline(
  points: Point2D[],
  settings: Partial<SplineSettings> = {}
): Point2D[] {
  const fullSettings: SplineSettings = {
    ...DEFAULT_SPLINE_SETTINGS,
    ...settings,
  };

  if (points.length < 2) return [...points];

  const { samplesPerSegment = 10 } = fullSettings;
  const n = points.length;
  const result: Point2D[] = [];

  // Using Catmull-Rom for interpolation
  const pts: Point2D[] = [points[0], ...points, points[n - 1]];

  for (let i = 1; i < pts.length - 2; i++) {
    for (let s = 0; s < samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      result.push(
        catmullRomPoint(pts[i - 1], pts[i], pts[i + 1], pts[i + 2], t, fullSettings.tension ?? 0.5)
      );
    }
  }

  result.push(points[n - 1]);
  return result;
}
