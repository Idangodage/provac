/**
 * Frontiers as step functions, for the sizing DP (sizingDp.ts).
 *
 * A frontier F[i] (least first cost for a pressure budget of i grid steps)
 * never rises with i and takes few values, so it is kept as its steps: F[i] is
 * cost[j] for at[j] ≤ i < at[j + 1], and infinite before the first step.
 *
 * Each operation is the pointwise one (out[i] = min(out[i], F[i − k] + c), and
 * so on) done per step instead of per grid point: the same additions, in the
 * same order, on the same numbers, so every value is exactly the one the loop
 * over the grid gives. That holds because rounding is monotonic: adding to or
 * taking the minimum of functions that never rise gives one that never rises.
 *
 * A loss can be NaN (a unit with no airflow data), and with it a shift. A loop
 * over the grid from a NaN shift does not run, so such a frontier adds nothing
 * here too: the tests below are written so that NaN fails them, and they must
 * come first, because nothing past them can tell where a NaN index ends.
 */
const INF = Number.POSITIVE_INFINITY;

/** A kept frontier: where its steps are in the store, and how many (none: no design at any budget). */
export interface Frontier {
  start: number;
  count: number;
}

/** Steps in arrays, wherever they are held. */
interface StepArrays {
  at: Int32Array;
  cost: Float64Array;
}

/** A frontier being built, overwritten at will: it has room for every grid point. */
export class Envelope implements StepArrays {
  at: Int32Array;
  cost: Float64Array;
  count = 0;
  private spareAt: Int32Array;
  private spareCost: Float64Array;

  constructor(readonly size: number) {
    this.at = new Int32Array(size);
    this.cost = new Float64Array(size);
    this.spareAt = new Int32Array(size);
    this.spareCost = new Float64Array(size);
  }

  clear(): void {
    this.count = 0;
  }

  /** E[i] = value everywhere. */
  setFlat(value: number): void {
    this.at[0] = 0;
    this.cost[0] = value;
    this.count = 1;
  }

  /** E[i] = min(E[i], F[i − shift] + raise), F being `count` steps from `start` in `from`. */
  lower(from: StepArrays, start: number, count: number, raise: number, shift: number): void {
    if (!Number.isFinite(raise) || !count || !(shift < this.size)) return;
    const { size, at, cost } = this;
    const held = this.count;
    const fromAt = from.at;
    const fromCost = from.cost;
    const first = fromAt[start]! + shift;
    if (first >= size) return;
    // Nothing it holds can win: it starts no sooner, and its lowest is no lower than this one's highest.
    if (held && first >= at[0]! && fromCost[start + count - 1]! + raise >= cost[0]!) return;
    const outAt = this.spareAt;
    const outCost = this.spareCost;
    const end = start + count;
    let mine = 0;
    let theirs = start;
    let out = 0;
    let myValue = INF;
    let theirValue = INF;
    let last = INF;
    for (;;) {
      const myNext = mine < held ? at[mine]! : size;
      const theirNext = theirs < end ? fromAt[theirs]! + shift : size;
      const index = myNext < theirNext ? myNext : theirNext;
      if (index >= size) break;
      if (myNext === index) myValue = cost[mine++]!;
      if (theirNext === index) theirValue = fromCost[theirs++]! + raise;
      const value = theirValue < myValue ? theirValue : myValue;
      if (value < last) {
        outAt[out] = index;
        outCost[out] = value;
        out += 1;
        last = value;
      }
    }
    this.spareAt = at;
    this.spareCost = cost;
    this.at = outAt;
    this.cost = outCost;
    this.count = out;
  }

  /** E[i] = (F[i − shift] + raise) + other[i] + base. */
  setSum(from: StepArrays, start: number, count: number, raise: number, shift: number, other: Envelope, base: number): void {
    this.count = 0;
    if (!Number.isFinite(raise) || !count || !other.count || !(shift < this.size)) return;
    const { size, at, cost } = this;
    const fromAt = from.at;
    const fromCost = from.cost;
    const otherAt = other.at;
    const otherCost = other.cost;
    const held = other.count;
    const end = start + count;
    let theirs = start;
    let mine = 0;
    let out = 0;
    let theirValue = INF;
    let otherValue = INF;
    let last = INF;
    for (;;) {
      const theirNext = theirs < end ? fromAt[theirs]! + shift : size;
      const otherNext = mine < held ? otherAt[mine]! : size;
      const index = theirNext < otherNext ? theirNext : otherNext;
      if (index >= size) break;
      if (theirNext === index) theirValue = fromCost[theirs++]! + raise;
      if (otherNext === index) otherValue = otherCost[mine++]!;
      // (Both infinite until each has started: an infinite value is no lower than `last`.)
      const value = theirValue + otherValue + base;
      if (value < last) {
        at[out] = index;
        cost[out] = value;
        out += 1;
        last = value;
      }
    }
    this.count = out;
  }

  /** The frontier over the whole grid. */
  writeDense(into: Float64Array): void {
    into.fill(INF);
    const { at, cost, count } = this;
    for (let step = 0; step < count; step += 1) into.fill(cost[step]!, at[step]!, step + 1 < count ? at[step + 1]! : into.length);
  }
}

/** The frontiers of one solve, kept in shared arrays (a tree has many thousands, each of few steps). */
export class FrontierStore implements StepArrays {
  at = new Int32Array(1 << 12);
  cost = new Float64Array(1 << 12);
  private top = 0;

  constructor(readonly size: number) {}

  private reserve(count: number): void {
    const needed = this.top + count;
    if (needed <= this.at.length) return;
    let capacity = this.at.length;
    while (capacity < needed) capacity *= 2;
    const at = new Int32Array(capacity);
    const cost = new Float64Array(capacity);
    at.set(this.at.subarray(0, this.top));
    cost.set(this.cost.subarray(0, this.top));
    this.at = at;
    this.cost = cost;
  }

  /** `value` from grid point `from` on (never, when that is off the grid or the value is not finite). */
  step(from: number, value: number): Frontier {
    if (!(from < this.size) || !Number.isFinite(value)) return { start: this.top, count: 0 };
    this.reserve(1);
    this.at[this.top] = from;
    this.cost[this.top] = value;
    this.top += 1;
    return { start: this.top - 1, count: 1 };
  }

  /** F[i] = E[i]. */
  keep(envelope: Envelope): Frontier {
    this.reserve(envelope.count);
    this.at.set(envelope.at.subarray(0, envelope.count), this.top);
    this.cost.set(envelope.cost.subarray(0, envelope.count), this.top);
    const start = this.top;
    this.top += envelope.count;
    return { start, count: envelope.count };
  }

  /** F[i] = E[i − shift] + raise. */
  keepRaised(envelope: Envelope, raise: number, shift: number): Frontier {
    const start = this.top;
    if (!Number.isFinite(raise) || !(shift < this.size)) return { start, count: 0 };
    this.reserve(envelope.count);
    const { size, at, cost } = this;
    const fromAt = envelope.at;
    const fromCost = envelope.cost;
    let out = start;
    let last = INF;
    for (let step = 0; step < envelope.count; step += 1) {
      const index = fromAt[step]! + shift;
      if (index >= size) break;
      const value = fromCost[step]! + raise;
      if (value < last) {
        at[out] = index;
        cost[out] = value;
        out += 1;
        last = value;
      }
    }
    this.top = out;
    return { start, count: out - start };
  }

  /** F[i] = (A[i − shift] + B[i − shift]) + raise. */
  keepSum(a: Envelope, b: Envelope, raise: number, shift: number): Frontier {
    const start = this.top;
    if (!Number.isFinite(raise) || !a.count || !b.count || !(shift < this.size)) return { start, count: 0 };
    this.reserve(a.count + b.count);
    const { size, at, cost } = this;
    const aAt = a.at;
    const aCost = a.cost;
    const bAt = b.at;
    const bCost = b.cost;
    let inA = 0;
    let inB = 0;
    let aValue = INF;
    let bValue = INF;
    let out = start;
    let last = INF;
    for (;;) {
      const aNext = inA < a.count ? aAt[inA]! : size;
      const bNext = inB < b.count ? bAt[inB]! : size;
      const index = aNext < bNext ? aNext : bNext;
      if (index + shift >= size) break;
      if (aNext === index) aValue = aCost[inA++]!;
      if (bNext === index) bValue = bCost[inB++]!;
      const value = aValue + bValue + raise;
      if (value < last) {
        at[out] = index + shift;
        cost[out] = value;
        out += 1;
        last = value;
      }
    }
    this.top = out;
    return { start, count: out - start };
  }

  /** E[i] = min(E[i], F[i − shift] + raise). */
  lowerInto(envelope: Envelope, frontier: Frontier, raise: number, shift: number): void {
    envelope.lower(this, frontier.start, frontier.count, raise, shift);
  }

  /** F[i] at one grid point. */
  valueAt(frontier: Frontier, index: number): number {
    const { at, cost } = this;
    let low = frontier.start;
    let high = frontier.start + frontier.count;
    if (low === high || index < at[low]!) return INF;
    // The last step at or before `index`.
    while (high - low > 1) {
      const middle = (low + high) >>> 1;
      if (at[middle]! <= index) low = middle;
      else high = middle;
    }
    return cost[low]!;
  }
}
