import type { HvacElement } from '../../../types';

/**
 * Memoize a pure derivation of the scene on the element array's identity.
 *
 * Snap and extension targets are functions of the stored model alone — pointer
 * movement never changes them — yet the pointer path rebuilds them on every
 * event, once per resolver. On a 154-element scene that measured ~25 ms per
 * mouse move for the extension search alone.
 *
 * Store state is immutable: a committed change produces a new array, so array
 * identity is a sound cache key. The length guard is defensive only, matching
 * the check the draw tool's own snap cache already performs — an in-place
 * mutation would otherwise be served a stale derivation.
 *
 * Keyed by a WeakMap, so a transient array built inside a solver (a planned
 * scene, a preview overlay) caches for its own lifetime and is then collected.
 */
export function createSceneDerivedCache<Source extends { length: number }, Value>(
  compute: (source: Source) => Value,
): (source: Source) => Value {
  const entries = new WeakMap<object, { size: number; value: Value }>();
  return (source: Source): Value => {
    const key = source as unknown as object;
    const cached = entries.get(key);
    if (cached && cached.size === source.length) return cached.value;
    const value = compute(source);
    entries.set(key, { size: source.length, value });
    return value;
  };
}

/** Narrower alias for the common case, kept for call-site readability. */
export type ElementScene = readonly HvacElement[];
