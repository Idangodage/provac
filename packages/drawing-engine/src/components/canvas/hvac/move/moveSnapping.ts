/**
 * Where a drag lands: smart alignment guides first, then the grid.
 *
 * - Shift locks the move to its dominant axis.
 * - Alt moves freely (no guides, no grid).
 * - Guides: on each axis, a moving item's centre or edge within a few pixels of
 *   another unit's or terminal's centre or edge snaps onto it, and a thin line
 *   shows the alignment. The nearest match wins per axis.
 * - Otherwise the grabbed item's centre lands on the grid (the board's snap step).
 *
 * Pure: boxes in, a snapped delta and the guide lines out.
 */
import type { Point2D } from '../../../../types';

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

export interface MoveSnapInput {
  /** The raw drag (mm). */
  delta: Point2D;
  /** The grabbed item's centre where it started (the grid snaps it). */
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
  /** How near counts as aligned (mm: a few screen pixels at the current zoom). */
  toleranceMm: number;
  /** Axes the drag does not move (a 3D view's surface or axis): they stay at 0, unsnapped. */
  fixedAxes?: { x?: boolean; y?: boolean };
}

export interface MoveSnapResult {
  delta: Point2D;
  guides: MoveGuide[];
  /** What each axis snapped to. */
  snappedBy: { x: 'guide' | 'grid' | 'none' | 'locked'; y: 'guide' | 'grid' | 'none' | 'locked' };
}

type Axis = 'x' | 'y';

/** Centre first: where several features align at once (boxes of one size), the centre line is the one shown. */
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

/** The nearest alignment on one axis: how far to shift, and the line it makes. */
function nearestGuide(moving: readonly MoveBox[], others: readonly MoveBox[], axis: Axis, tolerance: number): { shift: number; guide: MoveGuide } | null {
  let best: { shift: number; guide: MoveGuide; gap: number } | null = null;
  for (const box of moving) {
    const own = features(box, axis);
    for (const other of others) {
      const theirs = features(other, axis);
      for (const value of own) {
        for (const target of theirs) {
          const gap = Math.abs(target - value);
          if (gap > tolerance || (best && gap >= best.gap - 1e-9)) continue;
          const [a0, a1] = span(box, axis);
          const [b0, b1] = span(other, axis);
          best = { shift: target - value, gap, guide: { axis, at: target, from: Math.min(a0, b0), to: Math.max(a1, b1) } };
        }
      }
    }
  }
  return best ? { shift: best.shift, guide: best.guide } : null;
}

export function snapMoveDelta(input: MoveSnapInput): MoveSnapResult {
  let { x, y } = input.delta;
  const locked = { x: Boolean(input.fixedAxes?.x), y: Boolean(input.fixedAxes?.y) };
  if (locked.x) x = 0;
  if (locked.y) y = 0;
  if (input.axisLock && !locked.x && !locked.y) {
    if (Math.abs(x) >= Math.abs(y)) { y = 0; locked.y = true; } else { x = 0; locked.x = true; }
  }
  const snappedBy: MoveSnapResult['snappedBy'] = { x: locked.x ? 'locked' : 'none', y: locked.y ? 'locked' : 'none' };
  if (input.free) return { delta: { x, y }, guides: [], snappedBy };
  const guides: MoveGuide[] = [];
  const grid = input.gridMm && input.gridMm > 0 ? input.gridMm : null;
  for (const axis of ['x', 'y'] as const) {
    if (locked[axis]) continue;
    const current = { x, y };
    const moved = input.moving.map((box) => shifted(box, current));
    const guide = input.others.length ? nearestGuide(moved, input.others, axis, input.toleranceMm) : null;
    if (guide) {
      if (axis === 'x') x += guide.shift; else y += guide.shift;
      guides.push(guide.guide);
      snappedBy[axis] = 'guide';
    } else if (grid) {
      const start = axis === 'x' ? input.anchor.x : input.anchor.y;
      const value = axis === 'x' ? x : y;
      const snapped = Math.round((start + value) / grid) * grid - start;
      if (axis === 'x') x = snapped; else y = snapped;
      snappedBy[axis] = 'grid';
    }
  }
  // A guide's line spans the moved item where it finally lands.
  const final = input.moving.map((box) => shifted(box, { x, y }));
  const finished = guides.map((guide) => {
    const extents = final.map((box) => span(box, guide.axis));
    return { ...guide, from: Math.min(guide.from, ...extents.map((e) => e[0])), to: Math.max(guide.to, ...extents.map((e) => e[1])) };
  });
  return { delta: { x: x || 0, y: y || 0 }, guides: finished, snappedBy };
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
