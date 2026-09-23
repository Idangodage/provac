import { describe, expect, it, vi } from 'vitest';

import { createSceneDerivedCache } from './sceneDerivedCache';

describe('createSceneDerivedCache', () => {
  it('computes once per scene identity, however often the pointer asks', () => {
    const compute = vi.fn((scene: string[]) => scene.join(','));
    const read = createSceneDerivedCache(compute);
    const scene = ['a', 'b'];

    // One pointer gesture resolves snap targets many times per sample.
    for (let sample = 0; sample < 50; sample++) read(scene);

    expect(compute).toHaveBeenCalledOnce();
    expect(read(scene)).toBe('a,b');
  });

  it('recomputes for a new array, as a committed change produces', () => {
    const compute = vi.fn((scene: string[]) => scene.join(','));
    const read = createSceneDerivedCache(compute);

    expect(read(['a'])).toBe('a');
    expect(read(['a', 'b'])).toBe('a,b');
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('keeps separate entries alive, so alternating scenes do not thrash', () => {
    // The draw tool reads the committed scene while a solver reads a planned
    // copy; a single-entry cache would miss on every alternation.
    const compute = vi.fn((scene: string[]) => scene.join(','));
    const read = createSceneDerivedCache(compute);
    const committed = ['a'];
    const planned = ['a', 'planned'];

    read(committed); read(planned);
    read(committed); read(planned);
    read(committed); read(planned);

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('recomputes when an array is mutated in place, rather than serving a stale value', () => {
    const compute = vi.fn((scene: string[]) => scene.join(','));
    const read = createSceneDerivedCache(compute);
    const scene = ['a'];

    expect(read(scene)).toBe('a');
    scene.push('b');
    expect(read(scene)).toBe('a,b');
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('caches a falsy derivation instead of recomputing it every read', () => {
    const compute = vi.fn(() => null);
    const read = createSceneDerivedCache(compute);
    const scene = ['a'];

    expect(read(scene)).toBeNull();
    expect(read(scene)).toBeNull();
    expect(compute).toHaveBeenCalledOnce();
  });
});
