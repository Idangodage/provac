/**
 * Where a drag lands. What is dragged stays under the pointer; snapping is
 * magnetic, never a step:
 *
 * - A line catches only within a few screen pixels (`SNAP_CATCH_PX`), and once
 *   caught it holds until the pointer is further off (`SNAP_RELEASE_PX`), so it
 *   neither jumps from afar nor flickers at the edge (the caller passes back
 *   what each axis held last frame).
 * - Guides first: on each axis, a moving item's centre near another unit's or
 *   terminal's centre (or an edge near the same edge) aligns with it, and a
 *   thin line shows the alignment. The nearest wins per axis.
 * - Then the grid (the board's snap step): the grabbed item's centre catches a
 *   grid line, within at most an eighth of the grid's step on screen (held to a
 *   fifth), so a fine grid stays a light touch and never turns the drag into
 *   steps.
 * - Otherwise the centre lands on a tidy millimetre: the coarsest of 10, 5 and
 *   1 mm that is under a pixel on screen (too small to see as a step).
 * - Shift locks the move to its dominant axis; Alt moves freely (no guides, no
 *   grid; whole millimetres).
 *
 * Pure: boxes in, a snapped delta, the guide lines and what each axis holds out.
 */
import type { Point2D } from '../../../../types';

/** A line catches within this many screen pixels, and lets go past this many. */
export const SNAP_CATCH_PX = 4;
export const SNAP_RELEASE_PX = 6;

/** An axis-aligned plan box (mm). */
export interface MoveBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface MoveGuide {
  /** `x`: a vertical line at x = `at`; `y`: a horizontal line at y = `at`. */
  axis: 'x' | 'y';
  at: number;
  /** Its extent along the other axis (spanning both boxes it aligns). */
  from: number;
  to: number;
}

/** The line an axis is held on: a guide's or a grid line's coordinate (mm). */
export interface SnapHold {
  kind: 'guide' | 'grid';
  at: number;
}

/** What each axis held after a frame (pass it back with the next). */
export interface MoveSnapHold {
  x: SnapHold | null;
  y: SnapHold | null;
}

export interface MoveSnapInput {
  /** The raw drag (mm). */
  delta: Point2D;
  /** The grabbed item's centre where it started (the grid and the tidy rounding place it). */
  anchor: Point2D;
  /** Where the moving items started. */
  moving: readonly MoveBox[];
  /** The other units and terminals the move can align with. */
  others: readonly MoveBox[];
  /** The grid step (mm); null or 0: no grid. */
  gridMm: number | null;
  /** Shift: keep to the dominant axis. */
  axisLock: boolean;
  /** Alt: no guides, no grid. */
  free: boolean;
  /** Screen pixels per millimetre where the drag is (the catch and release distances, the grid's step on screen). */
  pxPerMm: number;
  /** What each axis held last frame (absent: nothing). */
  held?: MoveSnapHold | null;
  /** Axes the drag does not move (a 3D view's surface or axis): they stay at 0, unsnapped. */
  fixedAxes?: { x?: boolean; y?: boolean };
}

export interface MoveSnapResult {
  delta: Point2D;
  guides: MoveGuide[];
  /** What each axis snapped to (`none`: the tidy millimetre). */
  snappedBy: { x: 'guide' | 'grid' | 'none' | 'locked'; y: 'guide' | 'grid' | 'none' | 'locked' };
  /** What each axis holds now: pass it back as `held` with the next frame. */
  held: MoveSnapHold;
}

type Axis = 'x' | 'y';

const TIDY_STEPS_MM = [10, 5, 1] as const;

/** The step a free position is rounded to: the coarsest of 10, 5 and 1 mm under a pixel on screen. */
export function tidyStepMm(pxPerMm: number): number {
  for (const step of TIDY_STEPS_MM) if (step * pxPerMm <= 1) return step;
  return 1;
}

/**
 * How near a grid line catches, and how far it holds (mm): the catch and
 * release distances, but never more than an eighth and a fifth of the grid's
 * step on screen (a fine grid snaps a third of the way at most).
 */
export function gridSnapWindowMm(gridMm: number, pxPerMm: number): { catchMm: number; releaseMm: number } {
  const stepPx = gridMm * pxPerMm;
  return {
    catchMm: Math.min(SNAP_CATCH_PX, stepPx / 8) / pxPerMm,
    releaseMm: Math.min(SNAP_RELEASE_PX, stepPx / 5) / pxPerMm,
  };
}

/**
 * One magnetic value on its own (a 3D drag's height): it catches the grid's
 * multiples of `gridMm` within the window and holds them until past the
 * release; otherwise it is rounded to the tidy step. Alt: whole millimetres.
 */
export function snapMagneticValue(
  value: number,
  options: { gridMm: number | null; pxPerMm: number; held?: number | null; free?: boolean },
): { value: number; held: number | null } {
  if (options.free) return { value: Math.round(value), held: null };
  const grid = options.gridMm && options.gridMm > 0 ? options.gridMm : null;
  if (grid) {
    const { catchMm, releaseMm } = gridSnapWindowMm(grid, options.pxPerMm);
    if (options.held !== null && options.held !== undefined && Math.abs(options.held - value) <= releaseMm) return { value: options.held, held: options.held };
    const line = Math.round(value / grid) * grid;
    if (Math.abs(line - value) <= catchMm) return { value: line, held: line };
  }
  const tidy = tidyStepMm(options.pxPerMm);
  return { value: Math.round(value / tidy) * tidy, held: null };
}

/**
 * Centre, then the edges (min, max): a centre aligns with a centre and an edge
 * with the same edge (rows and columns of terminals; not an edge against the
 * far edge, which only ever touches). Centre first: where several align at
 * once (boxes of one size), the centre line is the one shown.
 */
function features(box: MoveBox, axis: Axis): number[] {
  const min = axis === 'x' ? box.minX : box.minY;
  const max = axis === 'x' ? box.maxX : box.maxY;
  return [(min + max) / 2, min, max];
}

function span(box: MoveBox, axis: Axis): [number, number] {
  // The extent along the OTHER axis.
  return axis === 'x' ? [box.minY, box.maxY] : [box.minX, box.maxX];
}

function shifted(box: MoveBox, delta: Point2D): MoveBox {
  return { minX: box.minX + delta.x, minY: box.minY + delta.y, maxX: box.maxX + delta.x, maxY: box.maxY + delta.y };
}

/** The nearest alignment on one axis within `tolerance` (onto the line at `only`, when given): how far to shift, and the line it makes. */
function nearestGuide(moving: readonly MoveBox[], others: readonly MoveBox[], axis: Axis, tolerance: number, only?: number): { shift: number; guide: MoveGuide } | null {
  let best: { shift: number; guide: MoveGuide; gap: number } | null = null;
  for (const box of moving) {
    const own = features(box, axis);
    for (const other of others) {
      const theirs = features(other, axis);
      for (let feature = 0; feature < own.length; feature += 1) {
        const value = own[feature]!;
        const target = theirs[feature]!;
        if (only !== undefined && Math.abs(target - only) > 1e-6) continue;
        const gap = Math.abs(target - value);
        if (gap > tolerance || (best && gap >= best.gap - 1e-9)) continue;
        const [a0, a1] = span(box, axis);
        const [b0, b1] = span(other, axis);
        best = { shift: target - value, gap, guide: { axis, at: target, from: Math.min(a0, b0), to: Math.max(a1, b1) } };
      }
    }
  }
  return best ? { shift: best.shift, guide: best.guide } : null;
}

export function snapMoveDelta(input: MoveSnapInput): MoveSnapResult {
  const delta = { x: input.delta.x, y: input.delta.y };
  const locked = { x: Boolean(input.fixedAxes?.x), y: Boolean(input.fixedAxes?.y) };
  if (locked.x) delta.x = 0;
  if (locked.y) delta.y = 0;
  if (input.axisLock && !locked.x && !locked.y) {
    if (Math.abs(delta.x) >= Math.abs(delta.y)) { delta.y = 0; locked.y = true; } else { delta.x = 0; locked.x = true; }
  }
  const snappedBy: MoveSnapResult['snappedBy'] = { x: locked.x ? 'locked' : 'none', y: locked.y ? 'locked' : 'none' };
  const held: MoveSnapHold = { x: null, y: null };
  const pxPerMm = input.pxPerMm > 0 && Number.isFinite(input.pxPerMm) ? input.pxPerMm : 1;
  if (input.free) {
    // Whole millimetres for the grabbed centre; nothing else.
    for (const axis of ['x', 'y'] as const) {
      if (!locked[axis]) delta[axis] = Math.round(input.anchor[axis] + delta[axis]) - input.anchor[axis];
    }
    return { delta: { x: delta.x || 0, y: delta.y || 0 }, guides: [], snappedBy, held };
  }
  const guides: MoveGuide[] = [];
  const grid = input.gridMm && input.gridMm > 0 ? input.gridMm : null;
  const catchMm = SNAP_CATCH_PX / pxPerMm;
  const releaseMm = SNAP_RELEASE_PX / pxPerMm;
  const gridWindow = grid ? gridSnapWindowMm(grid, pxPerMm) : null;
  const tidy = tidyStepMm(pxPerMm);
  for (const axis of ['x', 'y'] as const) {
    if (locked[axis]) continue;
    const moved = input.moving.map((box) => shifted(box, delta));
    const start = input.anchor[axis];
    const hold = input.held?.[axis] ?? null;
    // The line held last frame, while the pointer is within its release distance.
    if (hold?.kind === 'guide' && input.others.length) {
      const guide = nearestGuide(moved, input.others, axis, releaseMm, hold.at);
      if (guide) {
        delta[axis] += guide.shift;
        guides.push(guide.guide);
        snappedBy[axis] = 'guide';
        held[axis] = hold;
        continue;
      }
    } else if (hold?.kind === 'grid' && gridWindow && Math.abs(hold.at - (start + delta[axis])) <= gridWindow.releaseMm) {
      delta[axis] = hold.at - start;
      snappedBy[axis] = 'grid';
      held[axis] = hold;
      continue;
    }
    // A line within its catch distance: an alignment first, then the grid.
    const guide = input.others.length ? nearestGuide(moved, input.others, axis, catchMm) : null;
    if (guide) {
      delta[axis] += guide.shift;
      guides.push(guide.guide);
      snappedBy[axis] = 'guide';
      held[axis] = { kind: 'guide', at: guide.guide.at };
      continue;
    }
    if (grid && gridWindow) {
      const line = Math.round((start + delta[axis]) / grid) * grid;
      if (Math.abs(line - (start + delta[axis])) <= gridWindow.catchMm) {
        delta[axis] = line - start;
        snappedBy[axis] = 'grid';
        held[axis] = { kind: 'grid', at: line };
        continue;
      }
    }
    // Free: the grabbed centre on a tidy millimetre.
    delta[axis] = Math.round((start + delta[axis]) / tidy) * tidy - start;
  }
  // A guide's line spans the moved item where it finally lands.
  const final = input.moving.map((box) => shifted(box, delta));
  const finished = guides.map((guide) => {
    const extents = final.map((box) => span(box, guide.axis));
    return { ...guide, from: Math.min(guide.from, ...extents.map((e) => e[0])), to: Math.max(guide.to, ...extents.map((e) => e[1])) };
  });
  return { delta: { x: delta.x || 0, y: delta.y || 0 }, guides: finished, snappedBy, held };
}

/** The plan box of an element's footprint, turned by its rotation. */
export function footprintBox(element: { position: Point2D; width: number; depth: number; rotation?: number }): MoveBox {
  const cx = element.position.x + element.width / 2;
  const cy = element.position.y + element.depth / 2;
  const angle = ((element.rotation ?? 0) * Math.PI) / 180;
  const hx = (Math.abs(Math.cos(angle)) * element.width + Math.abs(Math.sin(angle)) * element.depth) / 2;
  const hy = (Math.abs(Math.sin(angle)) * element.width + Math.abs(Math.cos(angle)) * element.depth) / 2;
  return { minX: cx - hx, minY: cy - hy, maxX: cx + hx, maxY: cy + hy };
}
