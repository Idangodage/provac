export interface ElevationPoint {
  x: number;
  y: number;
  z: number;
}

export interface RouteLowPocket {
  /** Indices in the supplied route, including a flat bottom where present. */
  startIndex: number;
  endIndex: number;
  bottomElevationMm: number;
  depthMm: number;
}

export interface RouteElevationAnalysis {
  elevationReversals: number;
  /** Travel beyond the absolute difference between the two endpoint levels. */
  excessVerticalTravelMm: number;
  totalVerticalTravelMm: number;
  centerlineLengthMm: number;
  lowPockets: RouteLowPocket[];
}

interface ElevationExtremum {
  z: number;
  startIndex: number;
  endIndex: number;
}

/**
 * Geometric screening only. A level reversal does not establish oil retention,
 * pressure loss or installation compliance; those depend on the selected
 * equipment, refrigerant, operating mode and manufacturer piping requirements.
 *
 * Hysteresis suppresses model noise while retaining gradual, finely sampled
 * rises. Horizontal plateaus do not hide a U-shaped low pocket. The default
 * tolerance is a numerical modelling tolerance, not an installation allowance.
 */
export function analyzeRouteElevation(
  points: readonly ElevationPoint[],
  options: { toleranceMm?: number } = {},
): RouteElevationAnalysis {
  const requestedTolerance = options.toleranceMm ?? 1;
  const tolerance = Number.isFinite(requestedTolerance)
    ? Math.max(1e-6, requestedTolerance)
    : 1;
  const result: RouteElevationAnalysis = {
    elevationReversals: 0,
    excessVerticalTravelMm: 0,
    totalVerticalTravelMm: 0,
    centerlineLengthMm: 0,
    lowPockets: [],
  };
  if (points.length < 2 || points.some((point) => (
    !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)
  ))) return result;

  points.slice(1).forEach((point, index) => {
    const previous = points[index]!;
    result.centerlineLengthMm += Math.hypot(
      point.x - previous.x, point.y - previous.y, point.z - previous.z,
    );
  });

  const first = points[0]!;
  const extrema: ElevationExtremum[] = [{ z: first.z, startIndex: 0, endIndex: 0 }];
  let direction: -1 | 0 | 1 = 0;
  let candidate = { ...extrema[0]! };

  for (let index = 1; index < points.length; index += 1) {
    const z = points[index]!.z;
    if (direction === 0) {
      if (Math.abs(z - first.z) <= tolerance) continue;
      direction = z > first.z ? 1 : -1;
      candidate = { z, startIndex: index, endIndex: index };
      continue;
    }
    const advance = (z - candidate.z) * direction;
    if (advance > 1e-8) {
      candidate = { z, startIndex: index, endIndex: index };
    } else if (Math.abs(advance) <= 1e-8) {
      candidate.endIndex = index;
    } else if (advance < -tolerance) {
      extrema.push(candidate);
      direction = direction === 1 ? -1 : 1;
      candidate = { z, startIndex: index, endIndex: index };
    }
  }
  const lastIndex = points.length - 1;
  // End at the actual endpoint, even after a sub-tolerance final fluctuation.
  if (direction !== 0) extrema.push({
    z: points[lastIndex]!.z,
    startIndex: lastIndex,
    endIndex: lastIndex,
  });

  for (let index = 1; index < extrema.length; index += 1) {
    result.totalVerticalTravelMm += Math.abs(extrema[index]!.z - extrema[index - 1]!.z);
  }
  result.elevationReversals = Math.max(0, extrema.length - 2);
  result.excessVerticalTravelMm = Math.max(
    0,
    result.totalVerticalTravelMm - Math.abs(points[lastIndex]!.z - first.z),
  );
  for (let index = 1; index < extrema.length - 1; index += 1) {
    const previous = extrema[index - 1]!;
    const current = extrema[index]!;
    const next = extrema[index + 1]!;
    const depth = Math.min(previous.z, next.z) - current.z;
    if (depth <= tolerance) continue;
    result.lowPockets.push({
      startIndex: current.startIndex,
      endIndex: current.endIndex,
      bottomElevationMm: current.z,
      depthMm: depth,
    });
  }
  return result;
}
