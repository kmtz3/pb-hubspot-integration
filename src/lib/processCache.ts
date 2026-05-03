// Process-level memoization with a short TTL (D27).
//
// Rationale: companies and deals scheduler jobs can fire seconds apart on the
// same warm Cloud Run instance. Without memoization, each run would re-fetch
// the HS owner directory and the PB members directory independently — wasted
// requests and extra 429-pressure on shared rate-limit pools.
//
// The cache is module-scoped (per-process). A 60s TTL is short enough that a
// permission change in HS or PB propagates to the next sync cycle, but long
// enough that the two sync flows share results when they overlap.
//
// In-flight calls are deduped — concurrent callers awaiting the same fetch
// share a single Promise so we never issue two fetches for the same TTL slot
// (matters when companies + deals jobs start within the same second).

interface CacheEntry<T> {
  expiresAt: number;
  value: Promise<T>;
}

export function memoizeWithTtl<T>(fn: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let entry: CacheEntry<T> | null = null;

  return async (): Promise<T> => {
    const now = Date.now();
    if (entry && entry.expiresAt > now) {
      return entry.value;
    }

    const value = fn().catch(err => {
      // Drop a failed entry so the next caller retries instead of inheriting
      // a poisoned promise. Without this, a transient 429/500 would freeze
      // the cache for the full TTL window.
      if (entry?.value === value) entry = null;
      throw err;
    });
    entry = { expiresAt: now + ttlMs, value };
    return value;
  };
}
