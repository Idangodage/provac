/**
 * VRF refrigerant-piping board — a geometry-first CAD surface on Konva.
 *
 * Layout: geometry/ (pure, tested), model/ (types + store), render/ (Konva),
 * ui/ (toolbar). Clean-room from the app's Fabric/SVG pipe editor.
 */

export * from './model/types';
export { useBoardStore, type BoardState } from './model/store';
export * from './geometry/transform';
export { VrfBoard } from './render/VrfBoard';
