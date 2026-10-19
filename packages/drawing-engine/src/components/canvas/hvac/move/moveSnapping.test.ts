import { describe, expect, it } from 'vitest';

import { footprintBox, snapMoveDelta, type MoveBox, type MoveSnapInput } from './moveSnapping';

const box = (x: number, y: number, w = 600, d = 600): MoveBox => ({ minX: x - w / 2, minY: y - d / 2, maxX: x + w / 2, maxY: y + d / 2 });
const base: MoveSnapInput = {
  delta: { x: 0, y: 0 }, anchor: { x: 1000, y: 1000 }, moving: [box(1000, 1000)], others: [], gridMm: 50, axisLock: false, free: false, toleranceMm: 30,
};

describe('snapMoveDelta', () => {
  it('lands the grabbed centre on the grid', () => {
    const result = snapMoveDelta({ ...base, anchor: { x: 1012, y: 988 }, delta: { x: 230, y: -61 } });
    // 1012 + 230 = 1242 → 1250; 988 − 61 = 927 → 950.
    expect(result.delta).toEqual({ x: 238, y: -38 });
    expect(result.snappedBy).toEqual({ x: 'grid', y: 'grid' });
  });

  it('aligns with another item\'s centre or edge within the tolerance, and draws the guide', () => {
    // Another diffuser centred at x 2410: the moving one (centre 1000) dragged 1395 right lands 15 short, and snaps.
    const result = snapMoveDelta({ ...base, delta: { x: 1395, y: 333 }, others: [box(2410, 3000)] });
    expect(result.delta.x).toBe(1410);
    expect(result.snappedBy.x).toBe('guide');
    expect(result.guides).toEqual([{ axis: 'x', at: 2410, from: 1033, to: 3300 }]);
    // y found no guide: the grid.
    expect(result.snappedBy.y).toBe('grid');
  });

  it('prefers the nearest alignment', () => {
    const result = snapMoveDelta({ ...base, delta: { x: 0, y: 1990 }, others: [box(4000, 3000), box(5000, 2985)], toleranceMm: 40 });
    // Edges and centres: 3000 is 10 away, 2985 is 5 away.
    expect(result.delta.y).toBe(1985);
  });

  it('keeps to the dominant axis with Shift', () => {
    const result = snapMoveDelta({ ...base, axisLock: true, delta: { x: 412, y: 95 } });
    expect(result.delta).toEqual({ x: 400, y: 0 });
    expect(result.snappedBy).toEqual({ x: 'grid', y: 'locked' });
  });

  it('moves freely with Alt', () => {
    const result = snapMoveDelta({ ...base, free: true, delta: { x: 412.3, y: 95.7 }, others: [box(1400, 1100)] });
    expect(result.delta).toEqual({ x: 412.3, y: 95.7 });
    expect(result.guides).toEqual([]);
  });
});

describe('footprintBox', () => {
  it('turns with the element', () => {
    expect(footprintBox({ position: { x: 0, y: 0 }, width: 1000, depth: 400, rotation: 90 })).toEqual({ minX: 300, minY: -300, maxX: 700, maxY: 700 });
  });
});
