/**
 * A routing session: one Auto route run.
 *
 * While a session is active, the elements the planners work with are never
 * edited in place: every change makes a new element (the planners' rule).
 * What is worked out from an element can then be kept and reused for the rest
 * of the run, keyed by that element and by exactly what else it depends on
 * (the `variant`, e.g. the units its ports read and the routing settings).
 * Outside a session nothing is kept: every function behaves as it always has
 * (the clash check's contract that an element edited in place is checked
 * again, for one, only holds outside Auto route).
 *
 * Checked mode proves the rule on a run instead of assuming it. Every key and
 * every kept value is frozen (an in-place edit of either throws), and every
 * reuse is computed afresh
 * and compared with what was kept (a dependency missing from a variant throws
 * instead of giving a different answer). Turn it on with
 * ROUTING_SESSION_CHECKS=1 (tests), or `setRoutingSessionChecks(true)`.
 */

export interface MemoTable<K extends object, V> {
  readonly name: string;
  /** Phantom fields carrying the key and value types. */
  readonly _key?: K;
  readonly _value?: V;
}

/** A named memo table (one per kind of derived value). */
export function memoTable<K extends object, V>(name: string): MemoTable<K, V> {
  return { name };
}

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
let forcedChecks: boolean | null = null;

/** Tests: force checked mode on or off (null: from ROUTING_SESSION_CHECKS). */
export function setRoutingSessionChecks(enabled: boolean | null): void {
  forcedChecks = enabled;
}

const checksWanted = () => forcedChecks ?? env?.ROUTING_SESSION_CHECKS === '1';

export class RoutingSession {
  readonly checked: boolean;
  private readonly tables = new Map<MemoTable<object, unknown>, WeakMap<object, Map<string, unknown>>>();
  private readonly identities = new WeakMap<object, number>();
  private readonly contentKeys = new WeakMap<object, string>();
  private readonly idIndexes = new WeakMap<object, Map<string, unknown>>();
  private nextIdentity = 0;
  /** Reuses and fresh computations, per table (for the benchmark notes). */
  readonly stats = new Map<string, { hits: number; misses: number }>();

  constructor(checked: boolean) {
    this.checked = checked;
  }

  /** The value of `table` for `key` and `variant`: kept from earlier in the run, else computed now and kept. */
  memo<K extends object, V>(table: MemoTable<K, V>, key: K, variant: string, compute: () => V): V {
    let byKey = this.tables.get(table as MemoTable<object, unknown>);
    if (!byKey) {
      byKey = new WeakMap();
      this.tables.set(table as MemoTable<object, unknown>, byKey);
    }
    let variants = byKey.get(key);
    if (!variants) {
      variants = new Map();
      byKey.set(key, variants);
    }
    const stats = this.stats.get(table.name) ?? { hits: 0, misses: 0 };
    this.stats.set(table.name, stats);
    if (variants.has(variant)) {
      stats.hits += 1;
      const kept = variants.get(variant) as V;
      if (this.checked) {
        const fresh = compute();
        if (!sameValue(kept, fresh)) {
          throw new Error(`Routing session: "${table.name}" kept a value that differs from a fresh one (variant ${variant}); a dependency is missing from its variant.`);
        }
      }
      return kept;
    }
    stats.misses += 1;
    if (this.checked) deepFreeze(key);
    const value = compute();
    // A kept value is handed out again: nobody may edit it either.
    if (this.checked) deepFreeze(value);
    variants.set(variant, value);
    return value;
  }

  /** A number naming this object for the rest of the run (for variants that depend on another element). */
  identity(value: object | null | undefined): number {
    if (!value) return 0;
    let identity = this.identities.get(value);
    if (identity === undefined) {
      identity = ++this.nextIdentity;
      this.identities.set(value, identity);
      if (this.checked) deepFreeze(value);
    }
    return identity;
  }

  /** The first element with each id in a list (what Array.find by id returns), indexed once per list. */
  firstById<T extends { id: string }>(elements: readonly T[]): ReadonlyMap<string, T> {
    let index = this.idIndexes.get(elements) as Map<string, T> | undefined;
    if (!index) {
      index = new Map();
      for (const element of elements) if (!index.has(element.id)) index.set(element.id, element);
      this.idIndexes.set(elements, index);
      if (this.checked) Object.freeze(elements);
    }
    return index;
  }

  /** The content of a settings-like object, as text, worked out once per object. */
  contentKey(value: object): string {
    let key = this.contentKeys.get(value);
    if (key === undefined) {
      key = JSON.stringify(value);
      this.contentKeys.set(value, key);
      if (this.checked) deepFreeze(value);
    }
    return key;
  }
}

let active: RoutingSession | null = null;

export interface RoutingSessionReport {
  checked: boolean;
  /** Per memo table: values reused and values worked out. */
  tables: Record<string, { hits: number; misses: number }>;
}
let lastReport: RoutingSessionReport | null = null;

/** The session of the Auto route run in progress, if any. */
export function activeRoutingSession(): RoutingSession | null {
  return active;
}

/** What the last finished session reused (tests and the benchmark notes). */
export function lastRoutingSessionReport(): RoutingSessionReport | null {
  return lastReport;
}

function end(session: RoutingSession): void {
  if (active !== session) return;
  active = null;
  lastReport = { checked: session.checked, tables: Object.fromEntries(session.stats) };
}

/**
 * Runs `plan` inside a routing session: the active one if a run is already in
 * progress (a step of Auto route), else a new one for its duration.
 */
export async function inRoutingSession<T>(plan: () => Promise<T>): Promise<T> {
  if (active) return plan();
  const session = new RoutingSession(checksWanted());
  active = session;
  try {
    return await plan();
  } finally {
    end(session);
  }
}

/** `inRoutingSession` for a synchronous step. */
export function inRoutingSessionSync<T>(plan: () => T): T {
  if (active) return plan();
  const session = new RoutingSession(checksWanted());
  active = session;
  try {
    return plan();
  } finally {
    end(session);
  }
}

/** Freezes a value and everything it holds (typed arrays cannot be frozen and are left as they are). */
function deepFreeze(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value) || ArrayBuffer.isView(value)) return;
  seen.add(value);
  if (value instanceof Map) {
    for (const [key, entry] of value) { deepFreeze(key, seen); deepFreeze(entry, seen); }
  } else if (value instanceof Set) {
    for (const entry of value) deepFreeze(entry, seen);
  } else {
    for (const entry of Object.values(value)) deepFreeze(entry, seen);
  }
  Object.freeze(value);
}

/** Structural equality of two derived values (numbers exactly; functions are not compared). */
function sameValue(a: unknown, b: unknown, seen = new Map<object, object>()): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a === 'function' && typeof b === 'function') return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  if (Array.isArray(a) !== Array.isArray(b) || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (ArrayBuffer.isView(a)) {
    const x = a as unknown as ArrayLike<number>; const y = b as unknown as ArrayLike<number>;
    if (x.length !== y.length) return false;
    for (let index = 0; index < x.length; index += 1) if (!sameValue(x[index], y[index], seen)) return false;
    return true;
  }
  if (a instanceof Map) {
    const other = b as Map<unknown, unknown>;
    if (a.size !== other.size) return false;
    for (const [key, entry] of a) if (!other.has(key) || !sameValue(entry, other.get(key), seen)) return false;
    return true;
  }
  if (a instanceof Set) {
    const other = b as Set<unknown>;
    if (a.size !== other.size) return false;
    for (const entry of a) if (!other.has(entry)) return false;
    return true;
  }
  const keysA = Object.keys(a).filter((key) => (a as Record<string, unknown>)[key] !== undefined);
  const keysB = Object.keys(b).filter((key) => (b as Record<string, unknown>)[key] !== undefined);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) if (!sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], seen)) return false;
  return true;
}
