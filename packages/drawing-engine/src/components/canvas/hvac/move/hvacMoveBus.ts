/**
 * A move asked for outside the canvas (the Properties panel's "Move by"): the
 * canvas registers the handler that runs it through the move model with its
 * placement rules, exactly as the arrow keys do.
 */
import type { Vec3 } from './ductElasticMove';

type HvacMoveHandler = (delta: Vec3) => boolean;

let handler: HvacMoveHandler | null = null;

/** The canvas takes (or, with null, gives up) the moves asked for elsewhere. */
export function setHvacMoveHandler(next: HvacMoveHandler | null): void {
  handler = next;
}

/** Move the selection by `delta` (mm); false when no canvas took it or nothing moved. */
export function requestHvacMove(delta: Vec3): boolean {
  return handler ? handler(delta) : false;
}
