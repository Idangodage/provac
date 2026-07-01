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
} from './geometry/kit';
export { connectRunEnd, syncKitConnections, moveKit, openRunEnds, type OpenEnd } from './model/ops';
export { VrfBoard } from './render/VrfBoard';
export { KitShape, type PortState } from './render/KitShape';
export { Toolbar } from './ui/Toolbar';
