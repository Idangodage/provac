import { describe, expect, it } from 'vitest';

import { BoxIndex, lazyBoxIndex, type PlanBox } from './boxIndex';

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boxes(count: number, next: () => number): Array<PlanBox | null> {
  return Array.from({ length: count }, () => {
    const roll = next();
    if (roll < 0.03) return null;
    if (roll < 0.05) return { minX: Number.NEGATIVE_INFINITY, minY: 0, maxX: Number.NaN, maxY: 10 };
    const x = next() * 20000 - 5000; const y = next() * 20000 - 5000;
    // Degenerate (zero-width) boxes too: segments along an axis.
    const w = roll < 0.2 ? 0 : next() * 3000; const h = roll > 0.9 ? 0 : next() * 3000;
    return { minX: x, minY: y, maxX: x + w, maxY: y + h };
  });
}

const meets = (box: PlanBox, q: PlanBox) => box.minX <= q.maxX && box.maxX >= q.minX && box.minY <= q.maxY && box.maxY >= q.minY;
const finite = (box: PlanBox) => [box.minX, box.minY, box.maxX, box.maxY].every(Number.isFinite);

describe('BoxIndex', () => {
  for (const count of [0, 5, 23, 24, 200, 2000]) {
    it(`answers exactly as a scan of every item, in list order (${count} items)`, () => {
      const next = random(count + 7);
      const items = boxes(count, next);
      const index = new BoxIndex(items, (item) => item);
      for (let query = 0; query < 300; query += 1) {
        const x = next() * 24000 - 7000; const y = next() * 24000 - 7000;
        const q = { minX: x, minY: y, maxX: x + next() * 4000, maxY: y + (query % 7 === 0 ? 0 : next() * 4000) };
        const expected = items.flatMap((box, i) => (box && (!finite(box) || meets(box, q)) ? [i] : []));
        expect(index.candidates(q.minX, q.minY, q.maxX, q.maxY)).toEqual(expected);
        const target = expected[Math.floor(expected.length / 2)];
        expect(index.some(q.minX, q.minY, q.maxX, q.maxY, (_, i) => i === target)).toBe(target !== undefined);
        expect(index.find(q.minX, q.minY, q.maxX, q.maxY, (_, i) => i >= (target ?? Infinity))).toBe(target === undefined ? undefined : items[target]);
      }
    });
  }

  it('indexes a list again once it has grown', () => {
    const indexOf = lazyBoxIndex<PlanBox>((box) => box);
    const list: PlanBox[] = Array.from({ length: 30 }, (_, i) => ({ minX: i * 10, minY: 0, maxX: i * 10 + 5, maxY: 5 }));
    expect(indexOf(list)).toBe(indexOf(list));
    expect(indexOf(list).candidates(1000, 0, 1010, 5)).toEqual([]);
    list.push({ minX: 1000, minY: 0, maxX: 1005, maxY: 5 });
    expect(indexOf(list).candidates(1000, 0, 1010, 5)).toEqual([30]);
  });
});
