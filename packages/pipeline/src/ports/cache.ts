// src/ports/cache.ts (main 14.3, B 1): the cache runtime port, for idempotency keys and rate limits.
// Optional (B 1, last paragraph): on small installs it is the state store's `kv` table
// (providers/local/cache.ts); on the cloud providers Redis is the faster option.

export interface CachePort {
  /** The value under `k`, or null when absent or expired. */
  get(k: string): Promise<string | null>;
  /** Sets `k` to `v`, overwriting; expires after `ttlSec` seconds when given, never when omitted. */
  set(k: string, v: string, ttlSec?: number): Promise<void>;
  /** Sets `k` only when absent or expired; true if this call set it. Atomic across callers. */
  setIfAbsent(k: string, v: string, ttlSec: number): Promise<boolean>;
  /** Removes `k`, for a value that must not outlive its use (a TTL only hides it). Absent is fine. */
  delete(k: string): Promise<void>;
}
