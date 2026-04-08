/**
 * Topology Module
 *
 * Barrel export for the building topology graph system.
 */

export { BuildingTopology } from './BuildingTopology';
export { useTopology, createTopology } from './TopologySync';
export {
  resolveRoomCorners,
  computeRoomBoundary,
  resyncRoomVertices,
} from './RoomBoundaryResolver';
export type { RoomCorner, RoomBoundaryResult } from './RoomBoundaryResolver';
export {
  snapWallEndpoints,
  resyncAffectedRooms,
  findAffectedRoomIds,
  validateCorners,
} from './CornerRecalculation';
export type { CornerResyncResult } from './CornerRecalculation';
export type {
  TopologyNode,
  TopologyEdge,
  TopologyFace,
  TopologySubgraph,
  TopologyValidationResult,
  TopologyIssue,
  TopologyIssueKind,
  WallEndRef,
  ElementCapabilities,
  ThicknessMode,
} from './types';
