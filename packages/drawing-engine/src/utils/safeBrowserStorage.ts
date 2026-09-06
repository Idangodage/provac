const DEFAULT_MAX_STORAGE_CHARS = 1_000_000;

/** Best-effort preference persistence. Browser storage must never unmount the editor. */
export function safeSetLocalStorage(
  key: string,
  value: string,
  maxChars = DEFAULT_MAX_STORAGE_CHARS,
): boolean {
  if (typeof window === 'undefined' || value.length > maxChars) return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    // SecurityError and QuotaExceededError are expected deployment conditions.
    return false;
  }
}

export function safeSetLocalStorageJson(
  key: string,
  value: unknown,
  maxChars = DEFAULT_MAX_STORAGE_CHARS,
): boolean {
  try {
    return safeSetLocalStorage(key, JSON.stringify(value), maxChars);
  } catch {
    return false;
  }
}
