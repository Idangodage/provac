type RateLimitEntry = {
  count: number;
  resetAt: number;
};

type RateLimitState = Map<string, RateLimitEntry>;

function getStore(): RateLimitState {
  const globalForRateLimit = globalThis as unknown as {
    __provacxRateLimit?: RateLimitState;
  };

  if (!globalForRateLimit.__provacxRateLimit) {
    globalForRateLimit.__provacxRateLimit = new Map();
  }

  return globalForRateLimit.__provacxRateLimit;
}

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  resetAt: number;
};

export function consumeRateLimit(params: {
  key: string;
  windowMs: number;
  max: number;
}): RateLimitResult {
  const store = getStore();
  const now = Date.now();

  const existing = store.get(params.key);
  if (!existing || existing.resetAt <= now) {
    const resetAt = now + params.windowMs;
    store.set(params.key, { count: 1, resetAt });
    return { ok: true, remaining: Math.max(0, params.max - 1), resetAt };
  }

  if (existing.count >= params.max) {
    return { ok: false, remaining: 0, resetAt: existing.resetAt };
  }

  existing.count += 1;
  store.set(params.key, existing);
  return {
    ok: true,
    remaining: Math.max(0, params.max - existing.count),
    resetAt: existing.resetAt,
  };
}

export function resetRateLimit(key: string) {
  getStore().delete(key);
}

