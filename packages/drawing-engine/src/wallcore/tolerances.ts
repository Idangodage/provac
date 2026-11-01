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

/** Cross product of two unit directions below which walls count as parallel. */
export const PARALLEL_CROSS_EPS = 1e-9;

/** Miter limit: corners running behind the node past 2× the thicker wall get beveled. */
export const MITER_LIMIT_FACTOR = 2;

/** A face cut back from both ends always keeps at least this much (or 1% of its length). */
export const MIN_FACE_REMAINDER = 1; // mm

/** Where a wall is cut back against another body, it stays this far inside it. */
export const CUT_OVERLAP = 0.5; // mm

/** Polygon booleans run on this integer grid: 100 per mm = 0.01 mm. */
export const CLIP_GRID_PER_MM = 100;

/** Boolean results narrower than this on average are grid debris, not geometry. */
export const MIN_CLIP_RING_WIDTH_MM = 0.05;

/** Minimum room area to keep in room detection: 0.1 m² in mm². */
export const MIN_ROOM_AREA = 0.1 * 1e6; // mm²

/** Opening clamp: min distance from opening edge to wall end / neighbor opening. */
export const OPENING_EDGE_MARGIN = 50; // mm
