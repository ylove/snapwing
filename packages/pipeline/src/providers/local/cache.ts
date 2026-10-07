// The `local` CachePort (main 14.3, B 1 last paragraph): the state store's `kv` table, so idempotency
// keys and rate limits live in the database when there is no Redis. Expiry, atomic `setIfAbsent`,
// and the TTL checks are the store's (state/kv.ts); this adapter only maps the port onto it.

import type { CachePort } from '../../ports/cache.ts';
import type { StateStore } from '../../state/store.ts';

/** The part of the state store the cache needs. `openState` returns a `StateStore`. */
export type KvStore = Pick<StateStore, 'kvGet' | 'kvSet' | 'kvSetIfAbsent' | 'kvDelete'>;

/**
 * A CachePort over `store`'s `kv` table. TTLs are seconds greater than 0 (fractions allowed);
 * anything else rejects with a RangeError, as `kvSet` does.
 */
export function createKvCache(store: KvStore): CachePort {
  return {
    async get(k) {
      return (await store.kvGet(k)) ?? null;
    },
    set(k, v, ttlSec) {
      return store.kvSet(k, v, ttlSec);
    },
    setIfAbsent(k, v, ttlSec) {
      return store.kvSetIfAbsent(k, v, ttlSec);
    },
    delete(k) {
      return store.kvDelete(k);
    },
  };
}
