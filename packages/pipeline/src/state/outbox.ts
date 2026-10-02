// Outbox (B 1, B 7.1): every external write (Jira, GitHub, Slack, Teams) is a row here, drained in
// order by one projector per target and workspace. This file stores, drains, defers, parks, and drops rows;
// it does not merge rows that share a `batch_key` (the projector does that) and does not choose
// retry times (the projector passes them to `deferOutbox`).
//
// A parked row is a done row with an error: `parkOutbox` sets `done_at` and `last_error`, and
// `ackOutbox` clears `last_error`, so the two never mix and no column is needed (#140).

import type { Selectable } from 'kysely';
import { OUTBOX_TARGETS, type OutboxItem, type OutboxTarget } from '../contracts/state.ts';
import type { StateContext } from './context.ts';
import type { OutboxTable } from './db.ts';

/** Ids per `ackOutbox` statement, well under SQLite's bound-parameter limit. */
const ACK_CHUNK = 500;

/**
 * See `StatePort.enqueueOutbox`. Writes the item as given (`createdAt` and `nextAttempt` come from
 * the caller, B 3 contract note), including `doneAt` when present. A duplicate `id` rejects.
 */
export async function enqueueOutbox(ctx: StateContext, item: OutboxItem): Promise<void> {
  if (!OUTBOX_TARGETS.includes(item.target)) {
    throw new TypeError(`enqueueOutbox: unknown target ${JSON.stringify(item.target)}`);
  }
  if (!Number.isInteger(item.attempts) || item.attempts < 0) {
    throw new RangeError(`enqueueOutbox: attempts must be a non-negative integer, got ${String(item.attempts)}`);
  }
  const { codec } = ctx;
  await ctx.db
    .insertInto('outbox')
    .values({
      id: item.id,
      workspace_id: item.workspaceId,
      target: item.target,
      incident_id: item.incidentId ?? null,
      op: item.op,
      payload: codec.json(item.payload),
      batch_key: item.batchKey ?? null,
      attempts: item.attempts,
      next_attempt: codec.timestamp(item.nextAttempt),
      last_error: item.lastError ?? null,
      created_at: codec.timestamp(item.createdAt),
      done_at: item.doneAt === undefined ? null : codec.timestamp(item.doneAt),
    })
    .execute();
}

/**
 * See `StatePort.drainOutbox`. Up to `limit` rows for `target` (and `workspaceId`) with `done_at`
 * null and `next_attempt <= now`, oldest `created_at` first (then `id`, so ties are stable), leaving
 * out any row behind an undone, not yet due row of the same incident. Read only.
 */
export async function drainOutbox(ctx: StateContext, target: OutboxTarget, limit: number, workspaceId?: string): Promise<OutboxItem[]> {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError(`drainOutbox: limit must be a non-negative integer, got ${String(limit)}`);
  }
  if (limit === 0) {
    return [];
  }
  const now = ctx.codec.timestamp(ctx.now());
  let query = ctx.db
    .selectFrom('outbox')
    .selectAll('outbox')
    .where('outbox.target', '=', target)
    .where('outbox.done_at', 'is', null)
    .where('outbox.next_attempt', '<=', now)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('outbox as prior')
            .select('prior.id')
            .whereRef('prior.target', '=', 'outbox.target')
            .whereRef('prior.incident_id', '=', 'outbox.incident_id')
            .where('prior.done_at', 'is', null)
            .where('prior.next_attempt', '>', now)
            .where((p) =>
              p.or([
                p('prior.created_at', '<', p.ref('outbox.created_at')),
                p.and([p('prior.created_at', '=', p.ref('outbox.created_at')), p('prior.id', '<', p.ref('outbox.id'))]),
              ]),
            ),
        ),
      ),
    );
  if (workspaceId !== undefined) {
    query = query.where('outbox.workspace_id', '=', workspaceId);
  }
  const rows = await query.orderBy('outbox.created_at', 'asc').orderBy('outbox.id', 'asc').limit(limit).execute();
  return rows.map((row) => toOutboxItem(ctx, row));
}

/** See `StatePort.ackOutbox`. Sets `done_at = now` and clears `last_error` on each row not already done; unknown ids are ignored. */
export async function ackOutbox(ctx: StateContext, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return;
  }
  const doneAt = ctx.codec.timestamp(ctx.now());
  for (let i = 0; i < unique.length; i += ACK_CHUNK) {
    await ctx.db
      .updateTable('outbox')
      .set({ done_at: doneAt, last_error: null })
      .where('id', 'in', unique.slice(i, i + ACK_CHUNK))
      .where('done_at', 'is', null)
      .execute();
  }
}

/**
 * See `StatePort.dropOutbox`. Marks every undone row of `target` with `batch_key = batchKey` done,
 * as `ackOutbox` does, without sending it, and returns their ids (oldest first). B 7.3: a human's
 * edit of a Jira field drops the agent's pending write to it.
 */
export async function dropOutbox(ctx: StateContext, target: OutboxTarget, batchKey: string): Promise<string[]> {
  if (batchKey === '') {
    throw new RangeError('dropOutbox: batchKey must be non-empty');
  }
  const rows = await ctx.db
    .selectFrom('outbox')
    .select('id')
    .where('target', '=', target)
    .where('batch_key', '=', batchKey)
    .where('done_at', 'is', null)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  const ids = rows.map((row) => row.id);
  await ackOutbox(ctx, ids);
  return ids;
}

/** See `StatePort.deferOutbox`. */
export async function deferOutbox(ctx: StateContext, id: string, nextAttempt: string, error?: string): Promise<void> {
  const at = ctx.codec.timestamp(nextAttempt);
  const update = ctx.db.updateTable('outbox').where('id', '=', id).where('done_at', 'is', null);
  if (error === undefined) {
    await update.set({ next_attempt: at }).execute();
    return;
  }
  await update.set((eb) => ({ next_attempt: at, last_error: error, attempts: eb('attempts', '+', 1) })).execute();
}

/** See `StatePort.parkOutbox`. */
export async function parkOutbox(ctx: StateContext, id: string, error: string): Promise<void> {
  const doneAt = ctx.codec.timestamp(ctx.now());
  await ctx.db
    .updateTable('outbox')
    .set((eb) => ({ done_at: doneAt, last_error: error, attempts: eb('attempts', '+', 1) }))
    .where('id', '=', id)
    .where('done_at', 'is', null)
    .execute();
}

/** See `StatePort.listParkedOutbox`. */
export async function listParkedOutbox(ctx: StateContext, target: OutboxTarget, limit: number): Promise<OutboxItem[]> {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError(`listParkedOutbox: limit must be a non-negative integer, got ${String(limit)}`);
  }
  if (limit === 0) {
    return [];
  }
  const rows = await ctx.db
    .selectFrom('outbox')
    .selectAll()
    .where('target', '=', target)
    .where('done_at', 'is not', null)
    .where('last_error', 'is not', null)
    .orderBy('done_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  return rows.map((row) => toOutboxItem(ctx, row));
}

function toOutboxItem(ctx: StateContext, row: Selectable<OutboxTable>): OutboxItem {
  const { codec } = ctx;
  const target = OUTBOX_TARGETS.find((t) => t === row.target);
  if (target === undefined) {
    throw new TypeError(`outbox.target holds unknown value ${JSON.stringify(row.target)}`);
  }
  const payload = codec.fromJson(row.payload);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new TypeError(`outbox.payload for ${row.id} is not a JSON object`);
  }
  const item: OutboxItem = {
    id: row.id,
    workspaceId: row.workspace_id,
    target,
    op: row.op,
    payload: payload as Record<string, unknown>,
    attempts: codec.fromNumber(row.attempts),
    nextAttempt: codec.fromTimestamp(row.next_attempt),
    createdAt: codec.fromTimestamp(row.created_at),
  };
  if (row.incident_id !== null) {
    item.incidentId = row.incident_id;
  }
  if (row.batch_key !== null) {
    item.batchKey = row.batch_key;
  }
  if (row.last_error !== null) {
    item.lastError = row.last_error;
  }
  const doneAt = codec.fromTimestampOpt(row.done_at);
  if (doneAt !== undefined) {
    item.doneAt = doneAt;
  }
  return item;
}
