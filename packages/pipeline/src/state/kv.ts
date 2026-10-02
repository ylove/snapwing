// `kv` table: the cache-port fallback when Redis is absent (B 1, last paragraph; B 3). Not part of
// StatePort; StateStore exposes it as kvGet, kvSet, kvSetIfAbsent. Stubs until #19.

import type { StateContext } from './context.ts';
import { NotImplementedError } from './errors.ts';

/** The value under `k`, or `undefined` when absent or expired. */
export async function kvGet(_ctx: StateContext, _k: string): Promise<string | undefined> {
  throw new NotImplementedError('kvGet');
}

/** Sets `k` to `v`, expiring after `ttlSec` seconds when given. */
export async function kvSet(_ctx: StateContext, _k: string, _v: string, _ttlSec?: number): Promise<void> {
  throw new NotImplementedError('kvSet');
}

/** Sets `k` only when it is absent or expired; true if this call set it. Atomic. */
export async function kvSetIfAbsent(_ctx: StateContext, _k: string, _v: string, _ttlSec?: number): Promise<boolean> {
  throw new NotImplementedError('kvSetIfAbsent');
}
