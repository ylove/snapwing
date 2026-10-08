// Rebuild (B 4: "rebuild is a command"): truncate the projections and replay the event log.
//
// `rebuild(state, { incidentId })` or `rebuild(state, { all: true })` runs in one transaction, so a
// reader sees the old rows or the new ones, never a half-built table:
// 1. Lock out appends to what is being rebuilt. Postgres: `all` takes `share` on `incident_events`
//    (conflicts with the inserts append makes, not with reads); one incident takes the advisory lock
//    append takes (events.ts). SQLite: the handle's one connection already serializes transactions.
// 2. Delete the projection rows: `claims`, `escalation_scores`, `bot_messages`, the incident-scoped `subscriptions`
//    (the only ones events write; surface and workspace subscriptions are not derived and stay),
//    then `incidents`. Child work items that point at a rebuilt incident through `parent_id` are
//    unlinked first and relinked after the replay.
// 3. Replay each incident's log in `seq` order through `upcast` (upcast.ts) and `applyProjections`
//    (projections/index.ts), `batchSize` events per call. Under `all`, incidents replay in the order
//    their logs began (first `recorded_at`, then id), with a parent always before its children.
//
// The log is read, never written: `corrected` events replay like any other event and the rows they
// correct stay as stored (B 4).
//
// The outbox is not touched. It is not a projection: it is a delivery log whose rows cause
// writes to Jira, GitHub, Slack, and Teams. Replay passes `{ outbox: false }` to `applyProjections`,
// so `outboxFor` is never consulted and the table is neither truncated nor added to. Enqueueing only
// the rows that are missing (insert, on conflict do nothing) was considered and rejected:
// - Nothing is ever missing by accident. An append writes its outbox rows in the same transaction
//   as its events (B 4), so a stored event without its row means the row was delivered and pruned.
//   "Missing" rows are exactly the ones a refill would send a second time.
// - The rows that would come back are history: a status, a comment, a field value from when the
//   event happened, delivered again after newer writes and out of order with them.
// - If `outboxFor` changes after events were recorded, replay would emit rows those events never
//   produced, turning a projection repair into an external side effect.
// Re-emitting writes on purpose (a wiped Jira project) is `<cli> jira reproject` (B 7.1), a separate
// command that decides what to send against the target's current state.
//
// `snapshotProjections(state)` is every projection row as canonical JSON (tables, then rows sorted by
// primary key in code, object keys sorted, values decoded through the codec), so two snapshots from
// either dialect compare as strings.

import { sql } from 'kysely';
import type { IncidentEvent } from '../contracts/events.ts';
import type { StatePort } from '../ports/state.ts';
import { inTransaction, type StateContext } from './context.ts';
import { APPEND_LOCK_NAMESPACE, read } from './events.ts';
import { applyProjections } from './projections/index.ts';
import { StateStore } from './store.ts';
import { upcast, upcasters, type UpcasterRegistry } from './upcast.ts';

/** Events per `applyProjections` call when `batchSize` is absent. */
export const REBUILD_DEFAULT_BATCH_SIZE = 500;

export type RebuildTarget = { incidentId: string; all?: never } | { all: true; incidentId?: never };

export interface RebuildOptions {
  /** Events per `applyProjections` call; default `REBUILD_DEFAULT_BATCH_SIZE`. */
  batchSize?: number;
  /** Upcasters to apply; default the registry in upcast.ts. */
  upcasters?: UpcasterRegistry;
}

export interface RebuildResult {
  /** Incidents whose logs were replayed. */
  incidents: number;
  /** Events replayed. */
  events: number;
}

/** A store `openState` returned (or one bound to a transaction), or a state context. */
export type RebuildState = StatePort | StateContext;

/** The projection tables `rebuild` truncates and `snapshotProjections` lists (keys sorted there). */
export const PROJECTION_TABLES = Object.freeze(['incidents', 'claims', 'subscriptions', 'escalation_scores', 'bot_messages'] as const);
export type ProjectionTable = (typeof PROJECTION_TABLES)[number];

/** Truncates the projection rows for `target` and replays the log into them. See the file header. */
export async function rebuild(state: RebuildState, target: RebuildTarget, options: RebuildOptions = {}): Promise<RebuildResult> {
  const ctx = contextOf(state, 'rebuild');
  const batchSize = options.batchSize ?? REBUILD_DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new TypeError(`rebuild: batchSize must be a positive integer, got ${String(options.batchSize)}`);
  }
  const registry = options.upcasters ?? upcasters;
  const all = 'all' in target && target.all === true;
  const incidentId = 'incidentId' in target ? target.incidentId : undefined;
  if (all === (incidentId !== undefined) || (incidentId !== undefined && (typeof incidentId !== 'string' || incidentId === ''))) {
    throw new TypeError('rebuild: target must be { incidentId } or { all: true }');
  }

  return inTransaction(ctx, async (tx) => {
    const replay = async (log: readonly IncidentEvent[]): Promise<number> => {
      for (let i = 0; i < log.length; i += batchSize) {
        await applyProjections(
          tx,
          log.slice(i, i + batchSize).map((e) => upcast(e, registry)),
          { outbox: false },
        );
      }
      return log.length;
    };

    if (incidentId !== undefined) {
      if (tx.dialect === 'postgres') {
        await sql`select pg_advisory_xact_lock(${sql.lit(APPEND_LOCK_NAMESPACE)}, hashtext(${incidentId}))`.execute(tx.db);
      }
      const children = await unlinkChildren(tx, [incidentId]);
      await truncateIncident(tx, incidentId);
      const log = await read(tx, incidentId);
      await replay(log);
      await relinkChildren(tx, children);
      return { incidents: log.length > 0 ? 1 : 0, events: log.length };
    }

    if (tx.dialect === 'postgres') {
      await sql`lock table ${sql.table('incident_events')} in share mode`.execute(tx.db);
    }
    await truncateAll(tx);
    const order = await incidentOrder(tx);
    // A parent replays before its children: a child's `captured` names its parent, and the
    // `incidents.parent_id` reference needs the parent's row to exist. `started` guards a cycle.
    const started = new Set<string>();
    let events = 0;
    const visit = async (id: string): Promise<void> => {
      if (started.has(id)) {
        return;
      }
      started.add(id);
      const log = await read(tx, id);
      const capturedEvent = log.find((e) => e.type === 'captured');
      const opened = capturedEvent === undefined ? undefined : upcast(capturedEvent, registry);
      const parentId = opened?.type === 'captured' ? opened.payload.parentId : undefined;
      if (parentId !== undefined && order.has(parentId)) {
        await visit(parentId);
      }
      events += await replay(log);
    };
    for (const id of order) {
      await visit(id);
    }
    return { incidents: order.size, events };
  });
}

/** Every projection row as canonical JSON. See the file header. */
export async function snapshotProjections(state: RebuildState): Promise<string> {
  const ctx = contextOf(state, 'snapshotProjections');
  const snapshot: Record<string, unknown[]> = {};
  for (const table of PROJECTION_TABLES) {
    const rows = await ctx.db.selectFrom(table).selectAll().execute();
    const decoded = rows.map((r) => decodeRow(ctx, table, r as Record<string, unknown>));
    const pk = PRIMARY_KEYS[table];
    decoded.sort((a, b) => {
      for (const col of pk) {
        const c = compareCode(String(a[col]), String(b[col]));
        if (c !== 0) {
          return c;
        }
      }
      return 0;
    });
    snapshot[table] = decoded;
  }
  return canonicalJson(snapshot);
}

// Truncation --------------------------------------------------------------------------------------

async function truncateAll(tx: StateContext): Promise<void> {
  await tx.db.deleteFrom('claims').execute();
  await tx.db.deleteFrom('escalation_scores').execute();
  await tx.db.deleteFrom('bot_messages').execute();
  await tx.db.deleteFrom('subscriptions').where('scope_kind', '=', 'incident').execute();
  // One statement removes parents and children together, so `parent_id` never dangles.
  await tx.db.deleteFrom('incidents').execute();
}

async function truncateIncident(tx: StateContext, incidentId: string): Promise<void> {
  await tx.db.deleteFrom('claims').where('incident_id', '=', incidentId).execute();
  await tx.db.deleteFrom('escalation_scores').where('incident_id', '=', incidentId).execute();
  await tx.db.deleteFrom('bot_messages').where('incident_id', '=', incidentId).execute();
  await tx.db.deleteFrom('subscriptions').where('scope_kind', '=', 'incident').where('scope_id', '=', incidentId).execute();
  await tx.db.deleteFrom('incidents').where('id', '=', incidentId).execute();
}

interface ChildLink {
  id: string;
  parentId: string;
}

/** Clears `parent_id` on the rows that point at `parentIds`, and returns the links to restore. */
async function unlinkChildren(tx: StateContext, parentIds: readonly string[]): Promise<ChildLink[]> {
  const rows = await tx.db.selectFrom('incidents').select(['id', 'parent_id']).where('parent_id', 'in', [...parentIds]).execute();
  const links = rows.flatMap((r) => (r.parent_id === null ? [] : [{ id: r.id, parentId: r.parent_id }]));
  if (links.length > 0) {
    await tx.db.updateTable('incidents').set({ parent_id: null }).where('parent_id', 'in', [...parentIds]).execute();
  }
  return links;
}

async function relinkChildren(tx: StateContext, links: readonly ChildLink[]): Promise<void> {
  for (const link of links) {
    const parent = await tx.db.selectFrom('incidents').select('id').where('id', '=', link.parentId).executeTakeFirst();
    if (parent === undefined) {
      throw new Error(`rebuild: incident ${link.parentId} no longer folds to a row, but work item ${link.id} names it as its parent`);
    }
    await tx.db.updateTable('incidents').set({ parent_id: link.parentId }).where('id', '=', link.id).execute();
  }
}

/** Every incident with events, ordered by its first `recorded_at`, then id (sorted in code). */
async function incidentOrder(tx: StateContext): Promise<Set<string>> {
  const rows = await tx.db
    .selectFrom('incident_events')
    .select((eb) => ['incident_id', eb.fn.min('recorded_at').as('first')])
    .groupBy('incident_id')
    .execute();
  const keyed = rows.map((r) => ({ id: r.incident_id, first: tx.codec.fromTimestamp(r.first) }));
  keyed.sort((a, b) => compareCode(a.first, b.first) || compareCode(a.id, b.id));
  return new Set(keyed.map((r) => r.id));
}

// Snapshot ----------------------------------------------------------------------------------------

type ColumnKind = 'json' | 'timestamp' | 'bool' | 'number';

/** Columns whose stored form differs by dialect; every other column is compared as stored. */
const COLUMN_KINDS: Readonly<Record<ProjectionTable, Readonly<Record<string, ColumnKind>>>> = {
  incidents: {
    last_seq: 'number',
    pr_number: 'number',
    autonomy_level: 'number',
    waiting_on: 'json',
    monitored: 'bool',
    opened_at: 'timestamp',
    closed_at: 'timestamp',
    updated_at: 'timestamp',
  },
  claims: { since: 'timestamp', last_activity: 'timestamp', expires_at: 'timestamp', hold_expires_at: 'timestamp' },
  subscriptions: { created_at: 'timestamp' },
  escalation_scores: { reactor_ids: 'json', score: 'number', step_reached: 'number', window_ends: 'timestamp' },
  bot_messages: { seq: 'number', posted_at: 'timestamp' },
};

const PRIMARY_KEYS: Readonly<Record<ProjectionTable, readonly string[]>> = {
  incidents: ['id'],
  claims: ['incident_id', 'claimer_id'],
  subscriptions: ['workspace_id', 'user_id', 'scope_kind', 'scope_id'],
  escalation_scores: ['incident_id', 'intent'],
  bot_messages: ['platform', 'channel', 'message_id'],
};

function decodeRow(ctx: StateContext, table: ProjectionTable, row: Record<string, unknown>): Record<string, unknown> {
  const kinds = COLUMN_KINDS[table];
  const out: Record<string, unknown> = {};
  for (const [col, raw] of Object.entries(row)) {
    out[col] = decodeValue(ctx, kinds[col], raw);
  }
  return out;
}

function decodeValue(ctx: StateContext, kind: ColumnKind | undefined, raw: unknown): unknown {
  if (raw === null || raw === undefined) {
    return null;
  }
  switch (kind) {
    case 'json':
      return ctx.codec.fromJson(raw);
    case 'timestamp':
      return ctx.codec.fromTimestamp(raw);
    case 'bool':
      return ctx.codec.fromBool(raw);
    case 'number':
      return ctx.codec.fromNumber(raw);
    case undefined:
      // A column added after this map: compare it as stored, with a Date in its ISO form.
      return raw instanceof Date ? raw.toISOString() : raw;
  }
}

/** Code-unit order, the same on every dialect and locale (journal 2026-10-02-projection-order). */
function compareCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** JSON with object keys sorted at every depth and two-space indentation. */
function canonicalJson(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(sortKeys);
    }
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => compareCode(a, b));
      return Object.fromEntries(entries.map(([k, x]) => [k, sortKeys(x)]));
    }
    return v;
  };
  return JSON.stringify(sortKeys(value), null, 2);
}

// Helpers -----------------------------------------------------------------------------------------

function contextOf(state: RebuildState, fn: string): StateContext {
  if (state instanceof StateStore) {
    return state.ctx;
  }
  if ('db' in state && 'codec' in state && 'now' in state) {
    return state;
  }
  throw new TypeError(`${fn}: state must be a store openState returned, or a StateContext`);
}
