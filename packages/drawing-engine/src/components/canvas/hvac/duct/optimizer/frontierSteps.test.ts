import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Envelope, FrontierStore, type Frontier } from './frontierSteps';

/**
 * Every operation against the loop over the grid it stands for (exact: the
 * same additions on the same numbers), on random frontiers built the way the
 * sizing DP builds them, with numbers whose rounding merges steps.
 */
const SIZE = 48;
const INF = Number.POSITIVE_INFINITY;

const flat = (value: number) => new Float64Array(SIZE).fill(value);

function denseLower(out: Float64Array, F: Float64Array, raise: number, shift: number): void {
  if (!Number.isFinite(raise)) return;
  for (let i = shift; i < out.length; i += 1) {
    const value = F[i - shift]! + raise;
    if (value < out[i]!) out[i] = value;
  }
}

function denseOf(envelope: Envelope): Float64Array {
  const out = new Float64Array(SIZE);
  envelope.writeDense(out);
  return out;
}

function denseOfKept(store: FrontierStore, frontier: Frontier): Float64Array {
  return Float64Array.from({ length: SIZE }, (_, index) => store.valueAt(frontier, index));
}

const expectSame = (actual: Float64Array, expected: Float64Array) => expect([...actual]).toEqual([...expected]);

const number = fc.oneof(
  fc.integer({ min: 0, max: 3000 }),
  fc.constantFrom(0, 0.1, 0.2, 0.30000000000000004, 1e-9, 1234.5678, 1e15, 1e16, 2e16 + 2),
  fc.double({ min: 0, max: 5000, noNaN: true }),
);
/** (A loss can be NaN, or too large to be finite; a loop over the grid then does not run.) */
const shift = fc.oneof({ weight: 12, arbitrary: fc.integer({ min: 0, max: SIZE + 4 }) }, { weight: 1, arbitrary: fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY) });
const raise = fc.oneof(number, fc.double({ min: -500, max: 0, noNaN: true }));

/** Least of several flat-from-a-point frontiers: a frontier as the DP's ends and fittings make them. */
const pieces = fc.array(fc.tuple(shift, number), { maxLength: 9 });

function build(store: FrontierStore, list: ReadonlyArray<readonly [number, number]>): { envelope: Envelope; dense: Float64Array } {
  const envelope = new Envelope(SIZE);
  const dense = flat(INF);
  for (const [from, value] of list) {
    store.lowerInto(envelope, store.step(from, value), 0, 0);
    for (let i = from; i < SIZE; i += 1) if (value < dense[i]!) dense[i] = value;
  }
  return { envelope, dense };
}

describe('frontier steps', () => {
  it('a least-of, built step by step, is the loop over the grid; it never rises', () => {
    fc.assert(fc.property(pieces, pieces, raise, shift, (first, second, up, along) => {
      const store = new FrontierStore(SIZE);
      const { envelope, dense } = build(store, first);
      expectSame(denseOf(envelope), dense);
      const other = build(store, second);
      const kept = store.keep(other.envelope);
      store.lowerInto(envelope, kept, up, along);
      denseLower(dense, other.dense, up, along);
      const result = denseOf(envelope);
      expectSame(result, dense);
      for (let i = 1; i < SIZE; i += 1) expect(result[i]!).toBeLessThanOrEqual(result[i - 1]!);
      for (let step = 1; step < envelope.count; step += 1) {
        expect(envelope.at[step]!).toBeGreaterThan(envelope.at[step - 1]!);
        expect(envelope.cost[step]!).toBeLessThan(envelope.cost[step - 1]!);
      }
    }), { numRuns: 400 });
  });

  it('what a store keeps reads back at every point, raised and moved along', () => {
    fc.assert(fc.property(pieces, raise, shift, (list, up, along) => {
      const store = new FrontierStore(SIZE);
      const { envelope, dense } = build(store, list);
      expectSame(denseOfKept(store, store.keep(envelope)), dense);
      const raised = store.keepRaised(envelope, up, along);
      const expected = flat(INF);
      denseLower(expected, dense, up, along);
      expectSame(denseOfKept(store, raised), expected);
    }), { numRuns: 400 });
  });

  it('two frontiers in parallel add up, raised and moved along', () => {
    fc.assert(fc.property(pieces, pieces, raise, shift, (a, b, up, along) => {
      const store = new FrontierStore(SIZE);
      const first = build(store, a);
      const second = build(store, b);
      const sum = store.keepSum(first.envelope, second.envelope, up, along);
      const combined = Float64Array.from(first.dense, (value, index) => value + second.dense[index]!);
      const expected = flat(INF);
      denseLower(expected, combined, up, along);
      expectSame(denseOfKept(store, sum), expected);
    }), { numRuns: 400 });
  });

  it('an outlet, raised and moved along, plus the best other outlet and a base', () => {
    fc.assert(fc.property(pieces, pieces, raise, shift, number, (a, b, up, along, base) => {
      const store = new FrontierStore(SIZE);
      const first = build(store, a);
      const other = build(store, b);
      const kept = store.keep(first.envelope);
      const sum = new Envelope(SIZE);
      sum.setSum(store, kept.start, kept.count, up, along, other.envelope, base);
      const shifted = flat(INF);
      denseLower(shifted, first.dense, up, along);
      expectSame(denseOf(sum), Float64Array.from(shifted, (value, index) => {
        const total = value + other.dense[index]! + base;
        return total < INF ? total : INF;
      }));
    }), { numRuns: 400 });
  });

  it('a cost that is not finite adds nothing; off the grid is nowhere', () => {
    const store = new FrontierStore(SIZE);
    const { envelope, dense } = build(store, [[3, 10], [9, 4]]);
    const kept = store.keep(envelope);
    for (const bad of [INF, Number.NaN]) {
      store.lowerInto(envelope, kept, bad, 0);
      expectSame(denseOf(envelope), dense);
      expect(store.keepRaised(envelope, bad, 0).count).toBe(0);
      expect(store.keepSum(envelope, envelope, bad, 0).count).toBe(0);
      const sum = new Envelope(SIZE);
      sum.setSum(store, kept.start, kept.count, bad, 0, envelope, 0);
      expect(sum.count).toBe(0);
      expect(store.step(0, bad).count).toBe(0);
    }
    expect(store.step(SIZE, 1).count).toBe(0);
    expect(store.keepRaised(envelope, 1, SIZE).count).toBe(0);
    expect(store.keepSum(envelope, envelope, 1, SIZE).count).toBe(0);
    expect(store.valueAt({ start: 0, count: 0 }, 5)).toBe(INF);
  });

  it('a loss that is not a number adds nothing, and ends: a loop over the grid from there does not run', () => {
    const store = new FrontierStore(SIZE);
    const { envelope, dense } = build(store, [[3, 10], [9, 4]]);
    const kept = store.keep(envelope);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      store.lowerInto(envelope, kept, 1, bad);
      expectSame(denseOf(envelope), dense);
      expect(store.keepRaised(envelope, 1, bad).count).toBe(0);
      expect(store.keepSum(envelope, envelope, 1, bad).count).toBe(0);
      const sum = new Envelope(SIZE);
      sum.setSum(store, kept.start, kept.count, 1, bad, envelope, 0);
      expect(sum.count).toBe(0);
      expect(store.step(bad, 1).count).toBe(0);
    }
  });

  it('the store grows as it must, and what it kept stays', () => {
    const store = new FrontierStore(8);
    const frontiers: Frontier[] = [];
    for (let index = 0; index < 20_000; index += 1) frontiers.push(store.step(index % 8, index));
    frontiers.forEach((frontier, index) => {
      expect(store.valueAt(frontier, 7)).toBe(index);
      if (index % 8) expect(store.valueAt(frontier, (index % 8) - 1)).toBe(INF);
    });
  });
});
