// `kv` table: the cache-port fallback when Redis is absent (B 1, last paragraph; B 3): idempotency
// keys and rate limits live in the database on small installs. Not part of StatePort; StateStore
// exposes it as kvGet, kvSet, kvSetIfAbsent, kvDelete.
//
// A row with `expires_at <= now` is expired: reads treat it as absent and `kvSetIfAbsent` may take
// it over. Expired rows are not deleted here; a later set overwrites them, and `kvDelete` removes one
// whose value should not outlive its use.

import type { StateContext } from './context.ts';

/**
 * The encoded expiry `ttlSec` seconds after `ctx.now()`. `ttlSec` must be a finite number greater
 * than 0 (fractions allowed); anything else throws a RangeError naming `what`.
 */
export function expiryAfter(ctx: StateContext, ttlSec: number, what: string): string {
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
    throw new RangeError(`${what}: ttlSec must be a finite number of seconds greater than 0, got ${String(ttlSec)}`);
  }
  return ctx.codec.timestamp(new Date(ctx.now().getTime() + ttlSec * 1000));
}

/** The value under `k`, or `undefined` when absent or expired. */
export async function kvGet(ctx: StateContext, k: string): Promise<string | undefined> {
  const row = await ctx.db.selectFrom('kv').select(['v', 'expires_at']).where('k', '=', k).executeTakeFirst();
  if (row === undefined) {
    return undefined;
  }
  const expiresAt = ctx.codec.fromTimestampOpt(row.expires_at);
  if (expiresAt !== undefined && expiresAt <= ctx.codec.timestamp(ctx.now())) {
    return undefined;
  }
  return row.v;
}

/** Sets `k` to `v`, expiring after `ttlSec` seconds when given, never when omitted. Overwrites. */
export async function kvSet(ctx: StateContext, k: string, v: string, ttlSec?: number): Promise<void> {
  const expiresAt = ttlSec === undefined ? null : expiryAfter(ctx, ttlSec, 'kvSet');
  await ctx.db
    .insertInto('kv')
    .values({ k, v, expires_at: expiresAt })
    .onConflict((oc) => oc.column('k').doUpdateSet({ v, expires_at: expiresAt }))
    .execute();
}

/**
 * Sets `k` only when it is absent or expired; true if this call set it. One statement (an upsert
 * whose update applies only to an expired row), so of two concurrent calls exactly one wins.
 */
export async function kvSetIfAbsent(ctx: StateContext, k: string, v: string, ttlSec?: number): Promise<boolean> {
  const expiresAt = ttlSec === undefined ? null : expiryAfter(ctx, ttlSec, 'kvSetIfAbsent');
  const now = ctx.codec.timestamp(ctx.now());
  const result = await ctx.db
    .insertInto('kv')
    .values({ k, v, expires_at: expiresAt })
    .onConflict((oc) =>
      oc
        .column('k')
        .doUpdateSet({ v, expires_at: expiresAt })
        .where('kv.expires_at', 'is not', null)
        .where('kv.expires_at', '<=', now),
    )
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0n) > 0;
}

/** Removes `k`, expired or not. Absent is fine. */
export async function kvDelete(ctx: StateContext, k: string): Promise<void> {
  await ctx.db.deleteFrom('kv').where('k', '=', k).execute();
}

/** Rows `kvSweepExpired` deletes per statement. */
export const KV_SWEEP_BATCH = 500;

/**
 * Deletes rows whose `expires_at` has passed, `batch` per statement so a large backlog never holds a
 * long lock, until a statement deletes fewer than `batch`. Rows without an expiry are never touched.
 * Returns how many were deleted. The same SQL on both dialects (no `DELETE ... LIMIT`).
 */
export async function kvSweepExpired(ctx: StateContext, batch: number = KV_SWEEP_BATCH): Promise<number> {
  if (!Number.isInteger(batch) || batch < 1) {
    throw new RangeError(`kvSweepExpired: batch must be a positive integer, got ${String(batch)}`);
  }
  let total = 0;
  for (;;) {
    const now = ctx.codec.timestamp(ctx.now());
    const result = await ctx.db
      .deleteFrom('kv')
      .where('k', 'in', (eb) =>
        eb.selectFrom('kv').select('k').where('expires_at', 'is not', null).where('expires_at', '<=', now).orderBy('expires_at').limit(batch),
      )
      .where('expires_at', 'is not', null)
      .where('expires_at', '<=', now)
      .executeTakeFirst();
    const deleted = Number(result.numDeletedRows);
    total += deleted;
    if (deleted < batch) return total;
  }
}
