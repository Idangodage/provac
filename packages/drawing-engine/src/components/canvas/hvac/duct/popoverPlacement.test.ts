import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { placePopover, type ScreenRect } from './popoverPlacement';

const view = { width: 1200, height: 800 };
const card = { width: 300, height: 200 };
const overlapsRect = (x: number, y: number, rect: ScreenRect) => x < rect.right && x + card.width > rect.left && y < rect.bottom && y + card.height > rect.top;

describe('placing a card beside what it describes', () => {
  it('goes to the right of its anchor, centred on it, when there is room', () => {
    const anchor = { left: 300, top: 350, right: 400, bottom: 450 };
    expect(placePopover(anchor, card, view)).toEqual({ x: 412, y: 300, side: 'right', overlaps: false });
  });

  it('flips to the left near the right edge, and below when neither side has room', () => {
    expect(placePopover({ left: 900, top: 350, right: 1000, bottom: 450 }, card, view).side).toBe('left');
    const wide = { left: 200, top: 100, right: 1000, bottom: 200 };
    const placed = placePopover(wide, card, view);
    expect(placed.side).toBe('bottom');
    expect(placed.y).toBe(212);
    expect(placed.x).toBe(450);
  });

  it('stays inside the view when its anchor is at a corner', () => {
    const placed = placePopover({ left: 1150, top: 760, right: 1190, bottom: 790 }, card, view);
    expect(placed.x).toBeGreaterThanOrEqual(8);
    expect(placed.x + card.width).toBeLessThanOrEqual(view.width - 8);
    expect(placed.y + card.height).toBeLessThanOrEqual(view.height - 8);
    expect(placed.overlaps).toBe(false);
  });

  it('never leaves the view and covers its anchor only when no side has room', () => {
    fc.assert(fc.property(
      fc.integer({ min: -400, max: 1600 }), fc.integer({ min: -400, max: 1200 }), fc.integer({ min: 1, max: 1400 }), fc.integer({ min: 1, max: 1000 }),
      (left, top, width, height) => {
        const anchor = { left, top, right: left + width, bottom: top + height };
        const placed = placePopover(anchor, card, view);
        expect(placed.x).toBeGreaterThanOrEqual(8);
        expect(placed.y).toBeGreaterThanOrEqual(8);
        expect(placed.x + card.width).toBeLessThanOrEqual(view.width - 8 + 1e-9);
        expect(placed.y + card.height).toBeLessThanOrEqual(view.height - 8 + 1e-9);
        const visible = {
          left: Math.max(0, Math.min(view.width, anchor.left)), right: Math.max(0, Math.min(view.width, anchor.right)),
          top: Math.max(0, Math.min(view.height, anchor.top)), bottom: Math.max(0, Math.min(view.height, anchor.bottom)),
        };
        if (!placed.overlaps) expect(overlapsRect(placed.x, placed.y, visible)).toBe(false);
      },
    ));
  });
});
