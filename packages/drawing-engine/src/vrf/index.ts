/**
 * VRF refrigerant-piping board — a geometry-first CAD surface on Konva.
 *
 * Layout: geometry/ (pure, tested), model/ (types + store), render/ (Konva),
 * ui/ (toolbar). Clean-room from the app's Fabric/SVG pipe editor.
 */

export * from './model/types';
export { useBoardStore, type BoardState } from './model/store';
export * from './geometry/transform';
export { filletSpine, type FilletResult, type FilletWarning } from './geometry/fillet';
export { buildPairedGeometry, buildRunGeometry, offsetPath, type PairedGeometry } from './geometry/offset';
export {
  clampBendRadius,
  minSpineBendRadiusMm,
  innerLineRadiusMm,
  outerLineRadiusMm,
  type BendClamp,
} from './geometry/bend';
export {
  createRefnetKit,
  refnetPorts,
  kitToWorld,
  kitDirToWorld,
  worldToKitLocal,
  portWorld,
  portPairCenterWorld,
  portPairDirWorld,
  canConnect,
  hitKit,
  snapKitToRunEnd,
  kitGapMm,
  kitChannels,
  buildKitBodyGeometry,
  kitRotationDeg,
  KIT_FITTING_RADIUS_MM,
  type KitBodyGeometry,
} from './geometry/kit';
export {
  connectRunEnd,
  syncKitConnections,
  moveKit,
  openRunEnds,
  insertBranchAt,
  type OpenEnd,
  type SpineAt,
} from './model/ops';
export {
  SnapIndex,
  snap,
  buildSnapEntries,
  worldTolerance,
  nearestGrid,
  projectOntoGuide,
  snapMemoKey,
  SNAP_TIER,
  type SnapKind,
  type SnapRef,
  type SnapCandidate,
  type SnapResult,
  type SnapIndexOptions,
} from './snap';
export { VrfBoard } from './render/VrfBoard';
export { KitBody, KitPorts, cachePixelRatio, type PortState } from './render/KitShape';
export { makeRunGeometryCache, makeKitBodyCache, type RunGeometryCache, type KitBodyCache } from './render/geometryCache';
export { Toolbar } from './ui/Toolbar';
export * from './interaction';
