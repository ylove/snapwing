// Observability of the store itself (B 10): what `/metrics` reports about the outbox and parked
// jobs. Read only; `app/src/server/ops.ts` renders it as Prometheus text.
//
// Parked jobs are counted from `job_waits`, which both WorkflowPort implementations write when a
// job parks (ADR 0012), so the count is the same on the in-process scheduler and on pg-boss.

import { sql } from 'kysely';
import { OUTBOX_TARGETS, type OutboxTarget } from '../contracts/state.ts';
import type { OpenedState, StatePort } from '../ports/state.ts';
import type { StateContext } from './context.ts';
import { StateStore } from './store.ts';

export interface OutboxTargetMetrics {
  /** Rows with `done_at` null, due or not. */
  readonly depth: number;
  /** Seconds since the oldest undrained row's `created_at`; 0 when there is none. */
  readonly oldestAgeSeconds: number;
}

export interface StoreMetrics {
  /** One entry per `OUTBOX_TARGETS` member, zero when the target has no undrained rows. */
  readonly outbox: Readonly<Record<OutboxTarget, OutboxTargetMetrics>>;
  /** Jobs parked on a wait (`job_waits` rows). */
  readonly parkedJobs: number;
}

/** Reads the B 10 store metrics at the store's clock. */
export async function readStoreMetrics(state: StatePort | OpenedState): Promise<StoreMetrics> {
  const ctx = contextOf(state);
  const now = ctx.now().getTime();
  const rows = await ctx.db
    .selectFrom('outbox')
    .select(['target', sql<number | string>`count(*)`.as('depth'), sql<unknown>`min(created_at)`.as('oldest')])
    .where('done_at', 'is', null)
    .groupBy('target')
    .execute();
  const outbox = Object.fromEntries(OUTBOX_TARGETS.map((t) => [t, { depth: 0, oldestAgeSeconds: 0 }])) as Record<OutboxTarget, OutboxTargetMetrics>;
  for (const row of rows) {
    if (!(OUTBOX_TARGETS as readonly string[]).includes(row.target)) {
      continue;
    }
    const oldest = ctx.codec.fromTimestampOpt(row.oldest);
    const age = oldest === undefined ? 0 : Math.max(0, (now - Date.parse(oldest)) / 1000);
    outbox[row.target as OutboxTarget] = { depth: Number(row.depth), oldestAgeSeconds: age };
  }
  const parked = await ctx.db.selectFrom('job_waits').select(sql<number | string>`count(*)`.as('n')).executeTakeFirst();
  return { outbox, parkedJobs: Number(parked?.n ?? 0) };
}

/** Resolves when the store answers a trivial query; rejects with the driver's error otherwise. */
export async function pingState(state: StatePort | OpenedState): Promise<void> {
  const ctx = contextOf(state);
  await sql`select 1`.execute(ctx.db);
}

function contextOf(state: StatePort | OpenedState): StateContext {
  if (state instanceof StateStore) {
    return state.ctx;
  }
  throw new TypeError('store metrics need the store openState returned');
}
