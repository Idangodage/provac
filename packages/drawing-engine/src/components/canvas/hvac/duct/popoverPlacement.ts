/**
 * Where a floating card goes beside the thing it describes: on the first side
 * (by preference) where it fits whole without covering its anchor, centred on
 * the anchor along that side and shifted to stay inside the view. When no side
 * fits, the side with the most room is used and the card is kept on screen
 * (it may then cover part of the anchor). Pure; screen pixels.
 */

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type PopoverSide = 'right' | 'left' | 'bottom' | 'top';

export interface PopoverPlacement {
  x: number;
  y: number;
  side: PopoverSide;
  /** The card covers part of its anchor (no side had room). */
  overlaps: boolean;
}

export interface PopoverPlacementOptions {
  /** Space between the anchor and the card (px). */
  gap?: number;
  /** Space kept between the card and the view's edge (px). */
  margin?: number;
  sides?: readonly PopoverSide[];
}

const DEFAULT_SIDES: readonly PopoverSide[] = ['right', 'left', 'bottom', 'top'];

function clamp(value: number, low: number, high: number): number {
  return high < low ? low : Math.min(high, Math.max(low, value));
}

export function placePopover(
  anchor: ScreenRect,
  card: { width: number; height: number },
  view: { width: number; height: number },
  options: PopoverPlacementOptions = {},
): PopoverPlacement {
  const gap = options.gap ?? 12;
  const margin = options.margin ?? 8;
  const sides = options.sides ?? DEFAULT_SIDES;
  // The part of the anchor on screen (an anchor larger than the view, or partly off it, is cut to it).
  const a: ScreenRect = {
    left: clamp(anchor.left, 0, view.width), right: clamp(anchor.right, 0, view.width),
    top: clamp(anchor.top, 0, view.height), bottom: clamp(anchor.bottom, 0, view.height),
  };
  const centreX = (a.left + a.right) / 2;
  const centreY = (a.top + a.bottom) / 2;
  const room: Record<PopoverSide, number> = {
    right: view.width - margin - (a.right + gap),
    left: a.left - gap - margin,
    bottom: view.height - margin - (a.bottom + gap),
    top: a.top - gap - margin,
  };
  const need = (side: PopoverSide) => (side === 'left' || side === 'right' ? card.width : card.height);
  const across = (side: PopoverSide) => (side === 'left' || side === 'right'
    ? view.height - 2 * margin >= card.height
    : view.width - 2 * margin >= card.width);
  const place = (side: PopoverSide, overlaps: boolean): PopoverPlacement => {
    const maxX = view.width - margin - card.width;
    const maxY = view.height - margin - card.height;
    if (side === 'right' || side === 'left') {
      const x = side === 'right' ? a.right + gap : a.left - gap - card.width;
      return { x: clamp(x, margin, maxX), y: clamp(centreY - card.height / 2, margin, maxY), side, overlaps };
    }
    const y = side === 'bottom' ? a.bottom + gap : a.top - gap - card.height;
    return { x: clamp(centreX - card.width / 2, margin, maxX), y: clamp(y, margin, maxY), side, overlaps };
  };
  for (const side of sides) {
    if (room[side] >= need(side) && across(side)) return place(side, false);
  }
  const best = [...sides].sort((p, q) => room[q] - need(q) - (room[p] - need(p)))[0] ?? 'right';
  return place(best, true);
}
