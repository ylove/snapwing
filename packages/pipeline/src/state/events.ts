// Event log (B 1, B 4): append, read, readSince over `incident_events` (B 3).
//
// Append is optimistic concurrency (B 4): the log must be at `expectedSeq` or nothing is written.
// Within one transaction it reads the incident's last seq, rejects with `ExpectedSeqConflictError`
// on a mismatch, inserts seqs `expectedSeq + 1 ..`, and calls `applyProjections` so the projections
// commit or roll back with the events.
//
// How the race is closed, per dialect:
// - Postgres: the transaction first takes a transaction-scoped advisory lock on the incident
//   (`pg_advisory_xact_lock(APPEND_LOCK_NAMESPACE, hashtext(incident_id))`), so concurrent appends
//   to one incident run the check one after another and the loser sees the winner's seq (read
//   committed takes a fresh snapshot per statement). Appends to different incidents do not wait on
//   each other. The `(incident_id, seq)` primary key is the backstop for any writer that skips the
//   lock: its unique violation also becomes `ExpectedSeqConflictError`.
// - SQLite: Kysely's SQLite driver runs one transaction at a time on its one connection, so the
//   check and insert never interleave within a handle. The local provider opens one handle per
//   database file; two handles on one file in one process are not supported (better-sqlite3 blocks
//   the event loop while it waits for the other handle's write lock).
//
// `read` and `readSince` return events upcast to the current version (B 4); the stored row is untouched.
//
// Every jsonb and timestamptz value goes through `ctx.codec`; `recorded_at` comes from `ctx.now()`
// (ADR 0011), one value per append. `readSince` does not page on it (ADR 0013): a clock is not
// commit order, and an append that commits after a reader passed its `recorded_at` would be skipped.
// It pages on `tx_order`, the writing transaction, which append sets per dialect:
// - Postgres: the column default, `pg_current_xact_id()` (one value per transaction, assigned at its
//   first write). `readSince` returns only rows whose `tx_order` is below a watermark taken from its
//   own snapshot (`pgWatermark`): the oldest transaction that snapshot sees in flight and that
//   could write this database's log. Every transaction below it has committed or rolled back or
//   belongs to another database on the server, and every row that commits later has a `tx_order` at
//   or above it, so a cursor never passes a row that is not yet visible.
// - SQLite: one writer at a time, so a reader only ever sees committed transactions in commit order.
//   The first append in a transaction writes `max(tx_order) + 1` and later appends in the same
//   transaction reuse it, matching Postgres's one value per transaction.

import { sql, type RawBuilder, type Selectable } from 'kysely';
import { isEventType, type EventActorRole, type EventSource } from '../contracts/events.ts';
import { ExpectedSeqConflictError, type IncidentEvent, type NewEvent } from '../contracts/state.ts';
import type { StateContext } from './context.ts';
import { inTransaction } from './context.ts';
import type { IncidentEventsTable } from './db.ts';
import { applyProjections } from './projections/index.ts';
import { upcast } from './upcast.ts';

/** First key of the two-key advisory lock append takes on Postgres ("SNAP" in ASCII). */
export const APPEND_LOCK_NAMESPACE = 0x534e4150;

type EventRow = Selectable<IncidentEventsTable>;

/** See `StatePort.append`. Runs in one transaction with `applyProjections` (projections/index.ts). */
export async function append(ctx: StateContext, incidentId: string, events: NewEvent[], expectedSeq: number): Promise<{ seq: number }> {
  if (!Number.isSafeInteger(expectedSeq) || expectedSeq < 0) {
    throw new TypeError(`append: expectedSeq must be a non-negative integer, got ${String(expectedSeq)}`);
  }
  if (events.length === 0) {
    throw new TypeError('append: at least one event is required');
  }
  for (const [i, e] of events.entries()) {
    if (e.incidentId !== incidentId) {
      throw new TypeError(`append: events[${i}].incidentId is ${JSON.stringify(e.incidentId)}, expected ${JSON.stringify(incidentId)}`);
    }
  }

  const joined = ctx.db.isTransaction;
  try {
    return await inTransaction(ctx, (tx) => appendInTransaction(tx, incidentId, events, expectedSeq));
  } catch (e) {
    if (!(e instanceof SeqTaken)) {
      throw e;
    }
    // Another writer inserted one of our seqs after the check. Our transaction is gone if we opened
    // it, so the root handle reads where the log is now. Inside a caller's transaction, Postgres has
    // aborted it and nothing can be read; the log is at least one past `expectedSeq` then.
    const actualSeq = !joined || ctx.dialect === 'sqlite' ? await lastSeq(ctx, incidentId) : expectedSeq + 1;
    throw new ExpectedSeqConflictError(incidentId, expectedSeq, actualSeq, { cause: e.cause });
  }
}

async function appendInTransaction(tx: StateContext, incidentId: string, events: NewEvent[], expectedSeq: number): Promise<{ seq: number }> {
  if (tx.dialect === 'postgres') {
    await sql`select pg_advisory_xact_lock(${sql.lit(APPEND_LOCK_NAMESPACE)}, hashtext(${incidentId}))`.execute(tx.db);
  }
  const actualSeq = await lastSeq(tx, incidentId);
  if (actualSeq !== expectedSeq) {
    throw new ExpectedSeqConflictError(incidentId, expectedSeq, actualSeq);
  }

  const recordedAt = tx.codec.timestamp(tx.now());
  const txOrder = tx.dialect === 'sqlite' ? { tx_order: await sqliteTxOrder(tx) } : {};
  const rows = events.map((e, i) => ({
    workspace_id: e.workspaceId,
    incident_id: incidentId,
    seq: expectedSeq + 1 + i,
    type: e.type,
    v: e.v,
    source: e.source,
    actor_id: e.actor?.id ?? null,
    actor_role: e.actor?.role ?? null,
    payload: tx.codec.json(e.payload),
    occurred_at: tx.codec.timestamp(e.occurredAt),
    recorded_at: recordedAt,
  }));
  const insert = rows.map((r) => ({ ...r, ...txOrder }));
  try {
    await tx.db.insertInto('incident_events').values(insert).execute();
  } catch (e) {
    // Only the insert's key violation is a lost race; one raised by projections is their own bug.
    throw isUniqueViolation(e) ? new SeqTaken(e) : e;
  }

  // Hand projections exactly what `read` will return for these rows (upcast included).
  await applyProjections(
    tx,
    rows.map((r) => toEvent(tx, { ...r, payload: JSON.parse(r.payload) as unknown })),
  );
  return { seq: expectedSeq + events.length };
}

/** See `StatePort.read`. */
export async function read(ctx: StateContext, incidentId: string, fromSeq = 1): Promise<IncidentEvent[]> {
  if (!Number.isSafeInteger(fromSeq)) {
    throw new TypeError(`read: fromSeq must be an integer, got ${String(fromSeq)}`);
  }
  const rows = await ctx.db
    .selectFrom('incident_events')
    .selectAll()
    .where('incident_id', '=', incidentId)
    .where('seq', '>=', fromSeq)
    .orderBy('seq')
    .execute();
  return rows.map((r) => toEvent(ctx, { ...r, payload: ctx.codec.fromJson(r.payload) }));
}

/**
 * See `StatePort.readSince`. Keyset pagination on `(tx_order, incident_id, seq)`, which is unique (the
 * primary key is `(incident_id, seq)`). On Postgres only rows below `pgWatermark` are returned
 * (header, ADR 0013), so a page may stop short of rows that are already committed; they come on a
 * later call. The cursor is the last row's key, base64url-encoded JSON.
 */
export async function readSince(ctx: StateContext, cursor: string, limit: number): Promise<{ events: IncidentEvent[]; cursor: string }> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError(`readSince: limit must be a positive integer, got ${String(limit)}`);
  }
  const after = decodeCursor(cursor);

  let q = ctx.db.selectFrom('incident_events').selectAll();
  if (ctx.dialect === 'postgres') {
    // Evaluated in this statement, so against the same snapshot that decides which rows it sees.
    q = q.where('tx_order', '<', await pgWatermark(ctx));
  }
  if (after !== undefined) {
    q = q.where((eb) =>
      eb.or([
        eb('tx_order', '>', after.txOrder),
        eb.and([
          eb('tx_order', '=', after.txOrder),
          eb.or([eb('incident_id', '>', after.incidentId), eb.and([eb('incident_id', '=', after.incidentId), eb('seq', '>', after.seq)])]),
        ]),
      ]),
    );
  }
  const rows = await q.orderBy('tx_order').orderBy('incident_id').orderBy('seq').limit(limit).execute();
  const events = rows.map((r) => toEvent(ctx, { ...r, payload: ctx.codec.fromJson(r.payload) }));
  const last = rows.at(-1);
  return {
    events,
    cursor: last === undefined ? cursor : encodeCursor({ txOrder: ctx.codec.fromNumber(last.tx_order), incidentId: last.incident_id, seq: ctx.codec.fromNumber(last.seq) }),
  };
}

/**
 * The Postgres `readSince` bound (ADR 0013, amended later), as an expression to evaluate in the
 * statement that reads the log, so it comes from the snapshot that decides which rows are visible.
 * It is the least of:
 * - the snapshot's xmax: every transaction at or above it started after the snapshot;
 * - each transaction the snapshot sees in flight (`pg_snapshot_xip`), unless `pg_stat_activity`
 *   shows it running in another database on the server: only sessions connected to this database
 *   can write its log, and a transaction's database never changes, so a long transaction elsewhere
 *   (an analytics query, an idle session in another database) no longer holds the log back;
 * - this transaction's own id, when it has one (Postgres leaves it out of `xip`).
 * An in-flight id that cannot be placed (a prepared transaction, a backend whose row hides its
 * database, a session that ended before the view was read) counts as this database's, which only
 * withholds more. Rows below the result are final: committed and visible, rolled back, or never in
 * this database.
 *
 * The activity view is read after the snapshot is taken, so a transaction it misses that is still in
 * the snapshot's `xip` stays withheld. Inside a caller's transaction Postgres serves the view from a
 * copy taken at its first read, so the copy is dropped first (`pg_stat_clear_snapshot`). When the
 * role cannot read the view, the bound is the snapshot's xmin, the oldest transaction in flight
 * anywhere on the server (the original rule). `xid` is 32 bits and `xid8` is 64; every id in one
 * snapshot is within 2^31 of the others, so comparing the low 32 bits is exact.
 */
export async function pgWatermark(ctx: StateContext): Promise<RawBuilder<number>> {
  if (!(await activityReadable(ctx))) {
    return sql<number>`pg_snapshot_xmin(pg_current_snapshot())::text::bigint`;
  }
  if (ctx.db.isTransaction) {
    await sql`select pg_stat_clear_snapshot()`.execute(ctx.db);
  }
  return sql<number>`(
    select least(
      pg_snapshot_xmax(s.snap)::text::bigint,
      pg_current_xact_id_if_assigned()::text::bigint,
      (select min(x::text::bigint) from pg_snapshot_xip(s.snap) as x
        where not exists (
          select 1 from pg_catalog.pg_stat_activity a
           where a.datname <> current_database()
             and a.backend_xid::text::bigint = x::text::bigint % 4294967296)))
    from (select pg_current_snapshot() as snap) as s)`;
}

/** Per store (each store has its own codec): whether this role can read `pg_stat_activity`. */
const activityReadableByStore = new WeakMap<object, boolean>();

async function activityReadable(ctx: StateContext): Promise<boolean> {
  const known = activityReadableByStore.get(ctx.codec);
  if (known !== undefined) {
    return known;
  }
  // The privilege functions never raise, so this is safe inside a caller's transaction. The view
  // calls `pg_stat_get_activity` with the caller's rights, so both grants are needed.
  const { rows } = await sql<{ readable: boolean }>`
    select has_table_privilege('pg_catalog.pg_stat_activity', 'select')
       and has_function_privilege('pg_catalog.pg_stat_get_activity(integer)', 'execute')
       and has_function_privilege('pg_catalog.pg_stat_clear_snapshot()', 'execute') as readable
  `.execute(ctx.db);
  const readable = rows[0]?.readable === true;
  activityReadableByStore.set(ctx.codec, readable);
  return readable;
}

// Helpers -----------------------------------------------------------------------------------------

/** SQLite `tx_order` per transaction handle; a joined transaction reuses its handle (context.ts). */
const sqliteTxOrders = new WeakMap<object, number>();

async function sqliteTxOrder(tx: StateContext): Promise<number> {
  const known = sqliteTxOrders.get(tx.db);
  if (known !== undefined) {
    return known;
  }
  const row = await tx.db
    .selectFrom('incident_events')
    .select((eb) => eb.fn.max('tx_order').as('last'))
    .executeTakeFirst();
  const raw: unknown = row?.last;
  const next = (raw === null || raw === undefined ? 0 : tx.codec.fromNumber(raw)) + 1;
  sqliteTxOrders.set(tx.db, next);
  return next;
}

async function lastSeq(ctx: StateContext, incidentId: string): Promise<number> {
  const row = await ctx.db
    .selectFrom('incident_events')
    .select((eb) => eb.fn.max('seq').as('last'))
    .where('incident_id', '=', incidentId)
    .executeTakeFirst();
  const raw: unknown = row?.last;
  return raw === null || raw === undefined ? 0 : ctx.codec.fromNumber(raw);
}

/** A row with `payload` already decoded to its JSON value. `tx_order` is not part of the event. */
type DecodedRow = Omit<EventRow, 'payload' | 'tx_order'> & { payload: unknown };

function toEvent(ctx: StateContext, r: DecodedRow): IncidentEvent {
  if (!isEventType(r.type)) {
    throw new TypeError(`incident_events ${r.incident_id}#${r.seq}: unknown event type ${JSON.stringify(r.type)}`);
  }
  const event = {
    workspaceId: r.workspace_id,
    incidentId: r.incident_id,
    seq: ctx.codec.fromNumber(r.seq),
    type: r.type,
    v: ctx.codec.fromNumber(r.v),
    source: r.source as EventSource,
    ...(r.actor_id !== null && r.actor_role !== null ? { actor: { id: r.actor_id, role: r.actor_role as EventActorRole } } : {}),
    payload: r.payload,
    occurredAt: ctx.codec.fromTimestamp(r.occurred_at),
    recordedAt: ctx.codec.fromTimestamp(r.recorded_at),
  };
  // The row's `type` and `payload` are paired by the writer; the union cannot be checked statically
  // here. Every reader gets the current version (B 4): `upcast` (state/upcast.ts, the registry
  // rebuild uses) is the one place old versions change, and it is a no-op for an event that is
  // already current, so a caller that upcasts again (rebuild, the correction refold) is harmless.
  return upcast(event as IncidentEvent);
}

interface CursorKey {
  txOrder: number;
  incidentId: string;
  seq: number;
}

function encodeCursor(k: CursorKey): string {
  return Buffer.from(JSON.stringify([k.txOrder, k.incidentId, k.seq]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): CursorKey | undefined {
  if (cursor === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    parsed = undefined;
  }
  if (Array.isArray(parsed) && parsed.length === 3) {
    const [txOrder, incidentId, seq] = parsed as unknown[];
    if (Number.isSafeInteger(txOrder) && typeof incidentId === 'string' && Number.isSafeInteger(seq)) {
      return { txOrder: txOrder as number, incidentId, seq: seq as number };
    }
  }
  // Includes cursors from before migration 0002, which keyed on `recorded_at`.
  throw new TypeError(`readSince: not a cursor this store issued: ${JSON.stringify(cursor)}`);
}

/** The event insert hit the `(incident_id, seq)` key: a writer that skipped the check got there first. */
class SeqTaken extends Error {
  constructor(cause: unknown) {
    super('incident_events seq already taken', { cause });
  }
}

/** Primary-key or unique violation, from either driver. */
function isUniqueViolation(e: unknown): boolean {
  if (!(e instanceof Error)) {
    return false;
  }
  const code = (e as { code?: unknown }).code;
  return code === '23505' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE';
}
