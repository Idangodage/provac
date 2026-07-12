/**
 * ALL wall model/geometry tolerances live here and only here (reference LAW 4).
 * Units: millimetres and radians unless suffixed otherwise.
 */

/** Node weld distance: endpoints closer than this share a WallNode. */
export const WELD_EPS = 0.5; // mm

/** Angular tolerance for classifying directions (collinearity checks). */
export const ANGLE_EPS = (0.05 * Math.PI) / 180; // 0.05°

/** Collinearity tolerance for merging wall edges across a 2-valence node. */
export const COLLINEAR_EPS = (0.5 * Math.PI) / 180; // 0.5°

/** Generic float comparison epsilon for geometry predicates (mm-scale doubles). */
export const GEOM_EPS = 1e-6;

/** Miter limit: joins whose miter length exceeds 2× max thickness get beveled. */
export const MITER_LIMIT_FACTOR = 2;

/** Minimum room area to keep in room detection: 0.1 m² in mm². */
export const MIN_ROOM_AREA = 0.1 * 1e6; // mm²

/** Opening clamp: min distance from opening edge to wall end / neighbor opening. */
export const OPENING_EDGE_MARGIN = 50; // mm
