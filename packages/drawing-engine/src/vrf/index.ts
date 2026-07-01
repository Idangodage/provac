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
export { VrfBoard } from './render/VrfBoard';
export { Toolbar } from './ui/Toolbar';
