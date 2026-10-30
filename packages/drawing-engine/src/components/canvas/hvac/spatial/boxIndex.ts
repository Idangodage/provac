/**
 * "Which of these can touch this?" for the routers: a static plan index
 * (R-tree, rbush) over a list of items, each with its plan box.
 *
 * It only narrows the candidates. Callers still apply their own exact test to
 * each candidate, in the list's own order, so every answer (a yes/no, a count,
 * the first hit, a sum) is exactly the one testing every item would give —
 * provided an item's box holds every point at which its test can pass. That is
 * the rule each caller states where it builds its boxes (usually the item's
 * extent padded by the clearance its test applies).
 *
 * Small lists are not indexed (a scan is cheaper than the tree); items with a
 * box that is not finite are candidates for every query.
 */
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../../../vrf/snap/rbush.d.ts" />
import RBush from 'rbush';

export interface PlanBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Entry extends PlanBox { index: number }

/** Below this many items a plain scan is used (same answers). */
const INDEX_THRESHOLD = 24;

const finiteBox = (box: PlanBox) => Number.isFinite(box.minX) && Number.isFinite(box.minY) && Number.isFinite(box.maxX) && Number.isFinite(box.maxY);

export class BoxIndex<T> {
  private readonly tree: RBush<Entry> | null;
  /** Items always tested: unindexed lists, and boxes that are not finite. */
  private readonly always: number[];
  private readonly boxes: Array<PlanBox | null>;

  /** `boxOf` null: the item can never pass a test (it is never a candidate). */
  constructor(readonly items: readonly T[], boxOf: (item: T, index: number) => PlanBox | null) {
    this.boxes = items.map(boxOf);
    this.always = [];
    if (items.length < INDEX_THRESHOLD) {
      this.tree = null;
      this.boxes.forEach((box, index) => { if (box) this.always.push(index); });
      return;
    }
    const entries: Entry[] = [];
    this.boxes.forEach((box, index) => {
      if (!box) return;
      if (finiteBox(box)) entries.push({ minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY, index });
      else this.always.push(index);
    });
    this.tree = new RBush<Entry>().load(entries);
  }

  /** The items whose box meets the query box (edges included), in list order. */
  candidates(minX: number, minY: number, maxX: number, maxY: number): number[] {
    if (!this.tree) {
      return this.always.filter((index) => {
        const box = this.boxes[index]!;
        // Not finite: always a candidate (a NaN comparison would drop it).
        return !finiteBox(box) || (box.minX <= maxX && box.maxX >= minX && box.minY <= maxY && box.maxY >= minY);
      });
    }
    const found = this.tree.search({ minX, minY, maxX, maxY }).map((entry) => entry.index);
    if (this.always.length) found.push(...this.always);
    return found.length > 1 ? found.sort((a, b) => a - b) : found;
  }

  /** Whether some candidate passes `test` (in list order; stops at the first that does). */
  some(minX: number, minY: number, maxX: number, maxY: number, test: (item: T, index: number) => boolean): boolean {
    for (const index of this.candidates(minX, minY, maxX, maxY)) if (test(this.items[index]!, index)) return true;
    return false;
  }

  /** The first candidate, in list order, that passes `test`. */
  find(minX: number, minY: number, maxX: number, maxY: number, test: (item: T, index: number) => boolean): T | undefined {
    for (const index of this.candidates(minX, minY, maxX, maxY)) if (test(this.items[index]!, index)) return this.items[index];
    return undefined;
  }
}

/**
 * One index per list, built on first use, for lists whose items are not
 * replaced once made. A list that grew or shrank since (a test fixture adding
 * an obstacle) is indexed again.
 */
export function lazyBoxIndex<T>(boxOf: (item: T, index: number) => PlanBox | null): (items: readonly T[]) => BoxIndex<T> {
  const indexes = new WeakMap<readonly T[], { length: number; index: BoxIndex<T> }>();
  return (items) => {
    const cached = indexes.get(items);
    if (cached && cached.length === items.length) return cached.index;
    const index = new BoxIndex(items, boxOf);
    indexes.set(items, { length: items.length, index });
    return index;
  };
}
