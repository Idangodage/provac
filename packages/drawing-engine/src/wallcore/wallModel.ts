/**
 * Wall document model — the reference app's semantic graph (LAW 2), adapted to
 * a self-contained, JSON-serializable doc: walls are NOT independent shapes;
 * they are edges between SHARED nodes, so joins, junctions, drags and welds are
 * topology-true by construction. Rooms/footprints/meshes are derived, never stored.
 *
 * Coordinates: canonical ProvacX model space — mm, X right, Y down on the board
 * (see components/canvas/modelSpace.ts).
 */
import type { Vec2 } from './vec2';

export type WallEntityId = string;

export type WallJustification = 'center' | 'left' | 'right';

export interface WallNode2 {
  id: WallEntityId;
  /** Shared corner position (mm, model space). */
  p: Vec2;
}

export interface WallEdge2 {
  id: WallEntityId;
  /** Node ids — the centerline runs a → b. */
  a: WallEntityId;
  b: WallEntityId;
  thickness: number; // mm
  height: number; // mm
  baseOffset: number; // mm above the level plane
  /**
   * Which side of the centerline the body occupies. 'left' = the centerline is
   * the LEFT face w.r.t. the a→b direction (+90° CCW in model space), body
   * extends right; mirrored for 'right'. Flip = swap left↔right.
   */
  justification: WallJustification;
  material: string;
}

/** The persisted wall graph — plain records, order-independent semantics. */
export interface WallGraphDoc {
  nodes: Record<WallEntityId, WallNode2>;
  edges: Record<WallEntityId, WallEdge2>;
}

export interface WallParams {
  thickness: number;
  height: number;
  baseOffset: number;
  justification: WallJustification;
  material: string;
}

export const DEFAULT_WALL_PARAMS: WallParams = Object.freeze({
  thickness: 200,
  height: 2700,
  baseOffset: 0,
  justification: 'center',
  material: 'generic',
});

export function createEmptyWallGraph(): WallGraphDoc {
  return { nodes: {}, edges: {} };
}

/** Deterministic id factory the ops accept (store injects its own ids/nanoid). */
export interface WallIdSource {
  newId(): WallEntityId;
}

let fallbackCounter = 0;
/** Test/default id source — monotonic, readable. */
export function sequentialWallIds(prefix = 'w'): WallIdSource {
  return {
    newId: () => {
      fallbackCounter += 1;
      return `${prefix}${fallbackCounter.toString(36)}`;
    },
  };
}
