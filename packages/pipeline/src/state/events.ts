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
// Every jsonb and timestamptz value goes through `ctx.codec`; `recorded_at` comes from `ctx.now()`
// (ADR 0011), one value per append, so a batch shares one `recordedAt` and `readSince` orders it
// by `incidentId` and `seq`.

import { sql, type Selectable } from 'kysely';
import { isEventType, type EventActorRole, type EventSource } from '../contracts/events.ts';
import { ExpectedSeqConflictError, type IncidentEvent, type NewEvent } from '../contracts/state.ts';
import type { StateContext } from './context.ts';
import { inTransaction } from './context.ts';
import type { IncidentEventsTable } from './db.ts';
import { applyProjections } from './projections/index.ts';

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
  try {
    await tx.db.insertInto('incident_events').values(rows).execute();
  } catch (e) {
    // Only the insert's key violation is a lost race; one raised by projections is their own bug.
    throw isUniqueViolation(e) ? new SeqTaken(e) : e;
  }

  // Hand projections exactly what `read` will return for these rows.
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
 * See `StatePort.readSince`. Keyset pagination on `(recorded_at, incident_id, seq)`, which is unique
 * (the primary key is `(incident_id, seq)`), so pages never overlap or skip a row that was committed
 * before the page was read. The cursor is the last row's key, base64url-encoded JSON.
 */
export async function readSince(ctx: StateContext, cursor: string, limit: number): Promise<{ events: IncidentEvent[]; cursor: string }> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError(`readSince: limit must be a positive integer, got ${String(limit)}`);
  }
  const after = decodeCursor(cursor);

  let q = ctx.db.selectFrom('incident_events').selectAll();
  if (after !== undefined) {
    const recordedAt = ctx.codec.timestamp(after.recordedAt);
    q = q.where((eb) =>
      eb.or([
        eb('recorded_at', '>', recordedAt),
        eb.and([
          eb('recorded_at', '=', recordedAt),
          eb.or([eb('incident_id', '>', after.incidentId), eb.and([eb('incident_id', '=', after.incidentId), eb('seq', '>', after.seq)])]),
        ]),
      ]),
    );
  }
  const rows = await q.orderBy('recorded_at').orderBy('incident_id').orderBy('seq').limit(limit).execute();
  const events = rows.map((r) => toEvent(ctx, { ...r, payload: ctx.codec.fromJson(r.payload) }));
  const last = events.at(-1);
  return { events, cursor: last === undefined ? cursor : encodeCursor(last) };
}

// Helpers -----------------------------------------------------------------------------------------

async function lastSeq(ctx: StateContext, incidentId: string): Promise<number> {
  const row = await ctx.db
    .selectFrom('incident_events')
    .select((eb) => eb.fn.max('seq').as('last'))
    .where('incident_id', '=', incidentId)
    .executeTakeFirst();
  const raw: unknown = row?.last;
  return raw === null || raw === undefined ? 0 : ctx.codec.fromNumber(raw);
}

/** A row with `payload` already decoded to its JSON value. */
type DecodedRow = Omit<EventRow, 'payload'> & { payload: unknown };

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
  // here. Upcasting old `v` values lands in state/upcast.ts (B 4) when the first v2 event exists.
  return event as IncidentEvent;
}

interface CursorKey {
  recordedAt: string;
  incidentId: string;
  seq: number;
}

function encodeCursor(e: IncidentEvent): string {
  return Buffer.from(JSON.stringify([e.recordedAt, e.incidentId, e.seq]), 'utf8').toString('base64url');
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
    const [recordedAt, incidentId, seq] = parsed as unknown[];
    if (typeof recordedAt === 'string' && !Number.isNaN(Date.parse(recordedAt)) && typeof incidentId === 'string' && Number.isSafeInteger(seq)) {
      return { recordedAt, incidentId, seq: seq as number };
    }
  }
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
