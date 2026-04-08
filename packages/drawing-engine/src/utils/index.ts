/**
 * Utility Module Index
 *
 * Re-exports all utility functions for the smart-drawing package.
 */

// Geometry utilities
export {
  generateId,
  clamp,
  roundToNearest,
  roundValue,
  lerp,
  lerpPoint,
  distance,
  distanceSquared,
  midpoint,
  angleBetween,
  normalOffset,
  rotatePoint,
  calculatePolygonArea,
  calculateCentroid,
  polygonBounds,
  isPointInPolygon,
  distancePointToSegment,
  segmentsIntersect,
  lineIntersection,
  polylineLength,
  projectPointToPolyline,
  simplifyPolyline,
  mergeBounds,
  expandBounds,
  buildArcPath,
  buildRevisionCloudPath,
  sampleCatmullRom,
  countBy,
} from './geometry';

// Spline utilities
export {
  DEFAULT_SPLINE_SETTINGS,
  buildSplinePath,
  getSplineTypes,
  interpolateSpline,
} from './spline';

// Spatial index utilities
export {
  PackedRTree,
  boundsIntersect,
  inflateBounds,
  type RTreeBounds,
  type RTreeEntry,
} from './rtree';

// Turf-powered geometry engine
export { GeometryEngine, type RoomValidationResult } from './geometry-engine';
export {
  darkenHex,
  snapEndpointToNearest,
  prepareWallSegmentForInsertion,
  detectRoomsFromWalls,
  isPointInsideRoom,
  type RoomDetectionRunOptions,
  type RoomDetectionRunResult,
  type PreparedWallInsertionResult,
} from './roomDetection';

// Interactive editing utilities
export { GripManager } from './GripManager';
export { SnapManager, SnapType, type SnapContext, type SnapTarget } from './SnapManager';
export {
  countWallsTouchingEndpoint,
  computeCornerBevelDotsForEndpoint,
  computeDeadEndBevelDotsForEndpoint,
  projectPointToLine,
  clampBevelOffset,
  withUpdatedBevel,
  type CornerEnd,
  type CornerBevelKind,
  type CornerBevelDots,
  type EndpointBevelDots,
} from './wallBevel';

// Performance & GPU monitoring
export {
  GPUResourceMonitor,
  MaterialPool,
  GeometryOptimizer,
  RenderScheduler,
  ObjectPoolManager,
  WebGLContextGuardian,
} from './performance';
export type { QualityLevel, FrameMetrics } from './performance';
