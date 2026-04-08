/**
 * Wall Module
 *
 * Exports all wall-related components, utilities, and types.
 */

export { WallManager } from './WallManager';
export type { WallQueryResult, EndpointQuery } from './WallManager';

export { WallRenderer } from './WallRenderer';
export type { WallRenderOptions } from './WallRenderer';

export { WallPreview } from './WallPreview';

export { WallSnapIndicatorRenderer } from './WallSnapIndicatorRenderer'; // [SNAP WIRE]

export { RoomConfigPopup } from './RoomConfigPopup';
export type { RoomConfigPopupProps } from './RoomConfigPopup';

export {
  normalize,
  perpendicular,
  direction,
  scale,
  add,
  subtract,
  dot,
  cross,
  distance,
  distanceSq,
  lerp,
  midpoint,
  magnitude,
  lineIntersection,
  segmentIntersection,
  projectPointOnLine,
  computeOffsetLines,
  refreshOffsetLines,
  wallAngle,
  angleBetweenWalls,
  signedAngleBetween,
  determineJoinType,
  computeMiterJoin,
  computeWallBodyPolygon,
  computeWallPolygon,
  isPolygonSelfIntersecting,
  wallLength,
  wallCenter,
  wallBounds,
  isPointInsideWall,
  distanceToWallCenterLine,
} from './WallGeometry';
export type { MiterJoinResult } from './WallGeometry';
export {
  snapToGrid,
  snapToEndpoint,
  snapToMidpoint,
  applyAngleLock,
  snapWallPoint,
  findWallIntersections,
  // Renamed export to avoid conflict with canvas/snapping.ts
  applyOrthogonalConstraint as applyWallOrthogonalConstraint,
} from './WallSnapping';
export type { EnhancedSnapResult, SnapGuideLine } from './WallSnapping'; // [SNAP WIRE]
export {
  refreshAllWalls,
  refreshAfterPointMove,
  validateWallPolygon,
  refreshAllWallGeometry,
} from './WallUpdatePipeline'; // [PATCH APPLIED]

export {
  renderOpening,
  renderWallOpenings,
  renderOpeningPreview,
} from './OpeningRenderer';
export type { OpeningRenderResult } from './OpeningRenderer';
