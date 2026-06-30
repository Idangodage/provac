/**
 * Pipe drag session — the commit-once boundary (T1 / §4.6).
 *
 * The thrash that makes pipe editing feel bad comes from the live-edit path
 * being the commit path: every ~10ms drag tick calls `updateHvacElement(...,
 * {skipHistory:true})`, which in the store does a full `hvacElements.map` + a
 * `JSON.stringify` diff + `regenerateElevations`, then fans a whole-document
 * re-sync across two render loops — ~100x/sec for one gesture.
 *
 * A drag session decouples the live preview from the commit: during the drag the
 * caller updates an in-memory GHOST (no store writes at all); on release it
 * `commit`s exactly once — a single `updateHvacElement` + a single
 * `saveToHistory`. `regenerateElevations` therefore never runs mid-drag.
 *
 * Pure and engine-free: the store actions are injected, so the invariant
 * ("zero writes until release, one commit on release") is unit-tested with spies
 * — no React, no Konva, no store.
 */

import type { Point2D } from '../../../types';

import type { PipeSegmentMaterial } from './pipeInteractionCore';

/** The store actions a commit needs, injected so the session stays testable. */
export interface PipeCommitActions {
  updateHvacElement: (
    id: string,
    updates: Record<string, unknown>,
    options?: { skipHistory?: boolean },
  ) => void;
  saveToHistory: (label: string) => void;
}

/** Live, un-committed pipe geometry during a drag. Never written to the store. */
export interface PipeDragGhost {
  route: Point2D[];
  materials: PipeSegmentMaterial[];
}

export interface PipeDragSession {
  readonly elementId: string;
  /** Current ghost geometry (updated live; never written to the store). */
  readonly ghost: PipeDragGhost;
  /** True once at least one `update` has changed the ghost. */
  readonly dirty: boolean;
  /** True once `commit` (or `abort`) has run — further calls are no-ops. */
  readonly closed: boolean;
  /** Replaces the live ghost. Does NOT touch the store. */
  update(next: PipeDragGhost): void;
  /**
   * Commits exactly once. Runs `buildUpdates(ghost)`; if it returns a payload
   * and the session is dirty, performs ONE `updateHvacElement` (skipHistory) +
   * ONE `saveToHistory(label)`. Returns whether a commit was performed.
   */
  commit(
    actions: PipeCommitActions,
    buildUpdates: (ghost: PipeDragGhost) => Record<string, unknown> | null,
    label: string,
  ): boolean;
  /** Closes the session without committing (e.g. an invalid/cancelled drag). */
  abort(): void;
}

/**
 * Starts a drag session for `elementId` seeded with the baseline geometry.
 * The caller updates the ghost on each drag tick and commits once on release.
 */
export function beginPipeDrag(elementId: string, baseline: PipeDragGhost): PipeDragSession {
  let ghost: PipeDragGhost = baseline;
  let dirty = false;
  let closed = false;

  return {
    elementId,
    get ghost() {
      return ghost;
    },
    get dirty() {
      return dirty;
    },
    get closed() {
      return closed;
    },
    update(next: PipeDragGhost): void {
      if (closed) return;
      ghost = next;
      dirty = true;
    },
    commit(actions, buildUpdates, label): boolean {
      if (closed) return false;
      closed = true;
      if (!dirty) return false;
      const updates = buildUpdates(ghost);
      if (!updates) return false;
      actions.updateHvacElement(elementId, updates, { skipHistory: true });
      actions.saveToHistory(label);
      return true;
    },
    abort(): void {
      closed = true;
    },
  };
}
