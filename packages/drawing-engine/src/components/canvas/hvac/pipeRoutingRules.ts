/**
 * Engineering rules for VRF refrigerant copper-pipe routing and clash avoidance.
 *
 * These constants encode real-world installation practice so the clash-detection
 * and Z-offset routing engine ({@link ./pipeClashRouting}) has a single source of
 * truth. All distances are in millimetres (the drawing model's native unit).
 */

/**
 * Minimum clear gap that must be maintained between the *insulated* outer
 * surfaces of any two pipes (gas, liquid, branch, main, or existing route).
 * The pipe outer diameters used throughout the engine already include the
 * insulation allowance (see `resolveInsulatedOuterDiameterMm`), so this gap is
 * measured surface-to-surface between insulation, not bare copper.
 */
export const MIN_INSULATED_CLEARANCE_MM = 75;

/**
 * Default copper fitting style for a bypass offset. 45° offsets read cleaner and
 * add less resistance than 90° elbows, matching typical shop-drawing practice.
 */
export const DEFAULT_BYPASS_FITTING_ANGLE_DEG: 45 | 90 = 45;

/**
 * Extra straight run kept between the start of the rise/return fitting and the
 * edge of the obstacle envelope, so the offset begins *before* the obstacle
 * rather than exactly at the clash point.
 */
export const BYPASS_OFFSET_MARGIN_MM = 60;

/**
 * Assumed elevation (mm from floor) of the slab soffit / highest level a pipe
 * may reach. Used to decide whether an "above" bypass physically fits before
 * recommending it; falls back to below when the raised pipe would breach this.
 */
export const DEFAULT_CEILING_LIMIT_MM = 2900;

/**
 * Assumed lowest level (mm from floor) a pipe may drop to for a "below" bypass.
 */
export const DEFAULT_FLOOR_LIMIT_MM = 150;

/**
 * Two route points closer than this are treated as coincident when rebuilding
 * a centerline from rendered segments.
 */
export const ROUTE_POINT_EPSILON_MM = 0.2;

/**
 * Clashes whose crossing points fall within this distance of each other along
 * the route are merged into a single Z-offset (e.g. the existing bundle's gas
 * and liquid lines are bypassed by one offset). Keeps fitting count minimal.
 */
export const CLASH_MERGE_WINDOW_MM = 320;

/**
 * Minimum |dot| of two unit directions for them to count as "parallel" when
 * detecting pipes that run alongside each other too closely (overlap), as
 * opposed to a clean perpendicular crossing.
 */
export const PARALLEL_DIRECTION_DOT = 0.985;

/**
 * Lower bound on the sine of the crossing angle used when projecting an
 * obstacle's envelope onto the route tangent. Prevents shallow crossings from
 * producing an unbounded along-route footprint.
 */
export const MIN_CROSSING_SINE = 0.34;

/**
 * Vertical centre-to-centre offset required to clear an obstacle: the obstacle's
 * insulated radius, the moving pipe's insulated radius, and the clearance gap.
 */
export function computeRequiredRiseMm(
  obstacleOuterDiameterMm: number,
  movingOuterDiameterMm: number,
  clearanceMm: number = MIN_INSULATED_CLEARANCE_MM,
): number {
  return obstacleOuterDiameterMm / 2 + movingOuterDiameterMm / 2 + clearanceMm;
}

/**
 * Horizontal run consumed by a single rise/return fitting for a given vertical
 * rise. A 45° offset travels horizontally by the rise amount; a 90° offset
 * rises vertically with no horizontal travel.
 */
export function computeFittingRunMm(
  riseMm: number,
  fittingAngleDeg: 45 | 90,
): number {
  return fittingAngleDeg === 45 ? Math.abs(riseMm) : 0;
}
