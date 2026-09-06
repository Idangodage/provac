import { afterEach, describe, expect, it, vi } from 'vitest';

import { safeSetLocalStorage, safeSetLocalStorageJson } from './safeBrowserStorage';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('safe browser storage', () => {
  it('turns quota/security failures into a non-fatal false result', () => {
    const setItem = vi.fn(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    vi.stubGlobal('window', { localStorage: { setItem } });

    expect(safeSetLocalStorage('key', 'value')).toBe(false);
    expect(setItem).toHaveBeenCalledOnce();
  });

  it('rejects oversized and unserialisable values without writing', () => {
    const setItem = vi.fn();
    vi.stubGlobal('window', { localStorage: { setItem } });
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(safeSetLocalStorage('key', '1234', 3)).toBe(false);
    expect(safeSetLocalStorageJson('key', circular)).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });
});
