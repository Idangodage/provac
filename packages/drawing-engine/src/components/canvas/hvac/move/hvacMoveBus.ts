/**
 * Moves and turns asked for outside the canvas (the Properties panel's "Move
 * by" and "Rotate"): the canvas registers the handlers that run them through
 * the move model with its placement rules, exactly as the arrow keys and `R` do.
 */
import type { Vec3 } from './ductElasticMove';
import type { HvacRotation } from './hvacMoveModel';

type HvacMoveHandler = (delta: Vec3) => boolean;
type HvacRotateHandler = (rotation: HvacRotation) => boolean;

let handler: HvacMoveHandler | null = null;
let rotateHandler: HvacRotateHandler | null = null;

/** The canvas takes (or, with null, gives up) the moves asked for elsewhere. */
export function setHvacMoveHandler(next: HvacMoveHandler | null): void {
  handler = next;
}

/** Move the selection by `delta` (mm); false when no canvas took it or nothing moved. */
export function requestHvacMove(delta: Vec3): boolean {
  return handler ? handler(delta) : false;
}

/** The canvas takes (or, with null, gives up) the turns asked for elsewhere. */
export function setHvacRotateHandler(next: HvacRotateHandler | null): void {
  rotateHandler = next;
}

/** Turn the selected units and terminals; false when no canvas took it or nothing turned. */
export function requestHvacRotate(rotation: HvacRotation): boolean {
  return rotateHandler ? rotateHandler(rotation) : false;
}
