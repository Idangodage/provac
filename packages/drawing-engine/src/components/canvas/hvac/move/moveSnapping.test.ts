import { describe, expect, it } from 'vitest';

import { footprintBox, snapMagneticValue, snapMoveDelta, tidyStepMm, type MoveBox, type MoveSnapInput } from './moveSnapping';

const box = (x: number, y: number, w = 600, d = 600): MoveBox => ({ minX: x - w / 2, minY: y - d / 2, maxX: x + w / 2, maxY: y + d / 2 });
// 0.2 px per mm: a line catches within 20 mm (4 px) and holds to 30 mm (6 px); the 50 mm grid is 10 px on screen, so it
// catches within 6.25 mm (an eighth of its step) and holds to 10 mm (a fifth); free positions land on 5 mm.
const base: MoveSnapInput = {
  delta: { x: 0, y: 0 }, anchor: { x: 1000, y: 1000 }, moving: [box(1000, 1000)], others: [], gridMm: 50, axisLock: false, free: false, pxPerMm: 0.2,
};

describe('snapMoveDelta', () => {
  it('follows the pointer between the lines, the grabbed centre on a tidy millimetre', () => {
    const result = snapMoveDelta({ ...base, anchor: { x: 1012, y: 988 }, delta: { x: 218, y: -61 } });
    // 1012 + 218 = 1230 (20 mm from the nearest grid line: free); 988 − 61 = 927 → 925 (the 5 mm tidy step).
    expect(result.delta).toEqual({ x: 218, y: -63 });
    expect(result.snappedBy).toEqual({ x: 'none', y: 'none' });
    expect(result.held).toEqual({ x: null, y: null });
    // Zoomed in (1 px per mm): whole millimetres, exactly as dragged.
    expect(snapMoveDelta({ ...base, pxPerMm: 1, gridMm: null, delta: { x: 237, y: -61 } }).delta).toEqual({ x: 237, y: -61 });
  });

  it('catches a grid line within an eighth of its step on screen, and holds it to a fifth', () => {
    // 1240 is 10 mm (2 px) from the 1250 line: too far for a 10 px grid; 1245 (1 px) is caught.
    expect(snapMoveDelta({ ...base, delta: { x: 240, y: 0 } }).delta.x).toBe(240);
    const caught = snapMoveDelta({ ...base, delta: { x: 245, y: 0 } });
    expect(caught.delta.x).toBe(250);
    expect(caught.snappedBy.x).toBe('grid');
    expect(caught.held.x).toEqual({ kind: 'grid', at: 1250 });
    // Held: 8 mm off still holds; 11 mm off lets go (1261: the 5 mm tidy step).
    expect(snapMoveDelta({ ...base, delta: { x: 258, y: 0 }, held: caught.held }).delta.x).toBe(250);
    const released = snapMoveDelta({ ...base, delta: { x: 261, y: 0 }, held: caught.held });
    expect(released.delta.x).toBe(260);
    expect(released.held.x).toBeNull();
  });

  it('a grid wide on screen still catches only within 4 px', () => {
    const wide = { ...base, pxPerMm: 1, gridMm: 100 };
    expect(snapMoveDelta({ ...wide, delta: { x: 195, y: 0 } }).delta.x).toBe(195);
    expect(snapMoveDelta({ ...wide, delta: { x: 197, y: 0 } }).delta.x).toBe(200);
  });

  it('aligns with another item\'s centre within 4 px, and draws the guide', () => {
    // Another diffuser centred at x 2410: the moving one (centre 1000) dragged 1395 right lands 15 mm (3 px) short, and snaps.
    const result = snapMoveDelta({ ...base, delta: { x: 1395, y: 335 }, others: [box(2410, 3000)] });
    expect(result.delta.x).toBe(1410);
    expect(result.snappedBy.x).toBe('guide');
    expect(result.held.x).toEqual({ kind: 'guide', at: 2410 });
    expect(result.guides).toEqual([{ axis: 'x', at: 2410, from: 1035, to: 3300 }]);
    // y found no guide and is 15 mm from a grid line (over an eighth of a step): free.
    expect(result.delta.y).toBe(335);
    expect(result.snappedBy.y).toBe('none');
  });

  it('holds a guide until the pointer is 6 px off, then lets go', () => {
    const start = snapMoveDelta({ ...base, gridMm: null, delta: { x: 1395, y: 0 }, others: [box(2410, 3000)] });
    const held = start.held;
    // 25 mm (5 px) off: still aligned.
    expect(snapMoveDelta({ ...base, gridMm: null, delta: { x: 1435, y: 0 }, others: [box(2410, 3000)], held }).delta.x).toBe(1410);
    // 35 mm (7 px) off: free again.
    const free = snapMoveDelta({ ...base, gridMm: null, delta: { x: 1445, y: 0 }, others: [box(2410, 3000)], held });
    expect(free.delta.x).toBe(1445);
    expect(free.guides).toEqual([]);
    expect(free.held.x).toBeNull();
  });

  it('aligns a centre with a centre and an edge with the same edge, never an edge with the far edge', () => {
    // The moving box's left edge (700 + 1795 = 2495) is 5 mm from the other's right edge (2500): not an alignment.
    const touching = snapMoveDelta({ ...base, gridMm: null, delta: { x: 1795, y: 0 }, others: [box(2200, 3000)] });
    expect(touching.snappedBy.x).toBe('none');
    // Its left edge 5 mm from the other's left edge (2195 vs 2200, boxes of different sizes): aligned.
    const edges = snapMoveDelta({ ...base, gridMm: null, delta: { x: 1495, y: 0 }, others: [box(2500, 3000, 600, 600), box(9000, 9000)].map((b, i) => (i === 0 ? { ...b, maxX: b.maxX + 400 } : b)) });
    expect(edges.delta.x).toBe(1500);
    expect(edges.guides[0]).toMatchObject({ axis: 'x', at: 2200 });
  });

  it('prefers the nearest alignment', () => {
    // 0.125 px per mm: guides catch within 32 mm.
    const result = snapMoveDelta({ ...base, pxPerMm: 0.125, delta: { x: 0, y: 1990 }, others: [box(4000, 3000), box(5000, 2985)] });
    // Edges and centres: 3000 is 10 away, 2985 is 5 away.
    expect(result.delta.y).toBe(1985);
  });

  it('keeps to the dominant axis with Shift', () => {
    const result = snapMoveDelta({ ...base, axisLock: true, delta: { x: 404, y: 95 } });
    expect(result.delta).toEqual({ x: 400, y: 0 });
    expect(result.snappedBy).toEqual({ x: 'grid', y: 'locked' });
  });

  it('moves freely with Alt: whole millimetres, no guides', () => {
    const result = snapMoveDelta({ ...base, free: true, delta: { x: 412.3, y: 95.7 }, others: [box(1400, 1100)] });
    expect(result.delta).toEqual({ x: 412, y: 96 });
    expect(result.guides).toEqual([]);
  });
});

describe('tidyStepMm', () => {
  it('is the coarsest of 10, 5 and 1 mm under a pixel on screen', () => {
    expect(tidyStepMm(0.076)).toBe(10);
    expect(tidyStepMm(0.114)).toBe(5);
    expect(tidyStepMm(0.3)).toBe(1);
    expect(tidyStepMm(2)).toBe(1);
  });
});

describe('snapMagneticValue', () => {
  it('catches the grid within 4 px, holds it to 6 px, and is otherwise tidy', () => {
    const options = { gridMm: 50, pxPerMm: 1 };
    expect(snapMagneticValue(87, options)).toEqual({ value: 87, held: null });
    const caught = snapMagneticValue(97, options);
    expect(caught).toEqual({ value: 100, held: 100 });
    expect(snapMagneticValue(105, { ...options, held: caught.held })).toEqual({ value: 100, held: 100 });
    expect(snapMagneticValue(107, { ...options, held: caught.held })).toEqual({ value: 107, held: null });
    expect(snapMagneticValue(96.4, { ...options, free: true })).toEqual({ value: 96, held: null });
  });
});

describe('footprintBox', () => {
  it('turns with the element', () => {
    expect(footprintBox({ position: { x: 0, y: 0 }, width: 1000, depth: 400, rotation: 90 })).toEqual({ minX: 300, minY: -300, maxX: 700, maxY: 700 });
  });
});
