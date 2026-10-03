// Migrations, the dialect factory, and transactions (#16; B 2, B 3, B 10; ADR 0011). Runs on the
// dialect `SNAPWING_DB` selects; CI runs it once per dialect.

import BetterSqlite3 from 'better-sqlite3';
import { Kysely, PostgresDialect, SqliteDialect, sql } from 'kysely';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOG_START, type IncidentEvent, type OpenedState } from '../../src/ports/state.ts';
import { createCodec } from '../../src/state/codec.ts';
import { STATE_TABLES, type Database } from '../../src/state/db.ts';
import { StateMigrationError } from '../../src/state/errors.ts';
import { MIGRATION_LOCK_TABLE, MIGRATION_TABLE, MIGRATIONS, migrateState, type StateMigration } from '../../src/state/migrations/index.ts';
import { createTable } from '../../src/state/migrations/schema.ts';
import { StateStore } from '../../src/state/store.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../helpers/db.ts';

const WS = '01JZ0000000000000000000001';
const INC = '01JZ0000000000000000000002';

/** Every index B 3 asks for plus the scheduler's, by ADR 0011's `{table}_{columns}_idx` names. */
const STATE_INDEXES = [
  'incident_events_workspace_id_recorded_at_idx',
  'incident_events_type_recorded_at_idx',
  'incident_events_tx_order_incident_id_seq_idx',
  'incidents_workspace_id_status_idx',
  'incidents_workspace_id_surface_id_status_idx',
  'incidents_jira_key_idx',
  'incidents_channel_id_anchor_id_idx',
  'bot_messages_incident_id_idx',
  'outbox_target_done_at_next_attempt_idx',
  'jobs_name_state_start_after_idx',
  'jobs_singleton_key_idx',
  'job_waits_wait_kind_wait_key_idx',
  'job_waits_timeout_at_idx',
].sort();

let tdb: TestDatabase;

beforeEach(async () => {
  tdb = await createTestDatabase();
});

afterEach(async () => {
  await tdb.drop();
});

function dbOf(state: OpenedState): Kysely<Database> {
  if (!(state instanceof StateStore)) {
    throw new Error('openState did not return a StateStore');
  }
  return state.ctx.db;
}

async function tableNames(db: Kysely<Database>): Promise<string[]> {
  if (tdb.dialect === 'sqlite') {
    const tables = await db.introspection.getTables();
    return tables.map((t) => t.name).sort();
  }
  // Not `introspection.getTables()` on Postgres: it scans every schema, and the lock and migration
  // tables live beside the state tables.
  const raw = db as unknown as Kysely<unknown>;
  const { rows } = await sql<{ name: string }>`select tablename as name from pg_tables where schemaname = current_schema()`.execute(raw);
  return rows.map((r) => r.name).filter((n) => n !== MIGRATION_TABLE && n !== MIGRATION_LOCK_TABLE).sort();
}

async function indexNames(db: Kysely<Database>): Promise<string[]> {
  const raw = db as unknown as Kysely<unknown>;
  const q =
    tdb.dialect === 'sqlite'
      ? sql<{ name: string }>`select name from sqlite_master where type = 'index' and name like '%\_idx' escape '\\'`
      : sql<{ name: string }>`select indexname as name from pg_indexes where schemaname = current_schema() and indexname like '%\\_idx'`;
  const { rows } = await q.execute(raw);
  return rows.map((r) => r.name).sort();
}

async function appliedMigrations(db: Kysely<Database>): Promise<string[]> {
  const raw = db as unknown as Kysely<Record<string, { name: string }>>;
  const rows = await raw.selectFrom(MIGRATION_TABLE).select('name').orderBy('name').execute();
  return rows.map((r) => r.name);
}

describe(`state migrations (${TEST_DIALECT})`, () => {
  it('apply to an empty database and create every table and index', async () => {
    const state = await tdb.open();
    expect(state.dialect).toBe(TEST_DIALECT);
    const db = dbOf(state);
    expect(await appliedMigrations(db)).toEqual(MIGRATIONS.map((m) => m.name));
    const tables = await tableNames(db);
    for (const t of STATE_TABLES) {
      expect(tables).toContain(t);
    }
    expect(await indexNames(db)).toEqual(STATE_INDEXES);
  });

  it('apply twice idempotently: reopening and re-running change nothing', async () => {
    const first = await tdb.open();
    const before = { tables: await tableNames(dbOf(first)), indexes: await indexNames(dbOf(first)) };
    await first.close();

    const second = await tdb.open();
    const db = dbOf(second);
    expect(await migrateState(db, TEST_DIALECT)).toEqual([]);
    expect(await appliedMigrations(db)).toEqual(MIGRATIONS.map((m) => m.name));
    expect({ tables: await tableNames(db), indexes: await indexNames(db) }).toEqual(before);
  });

  it('a failing migration rejects with its name and leaves no partial schema', async () => {
    const state = await tdb.open();
    const db = dbOf(state);
    const broken: StateMigration = {
      name: '9999-broken',
      async up(d, dialect) {
        await createTable(d, dialect, 'half_done', { columns: { id: { type: 'text', primaryKey: true } } });
        await sql`select * from no_such_table`.execute(d);
      },
    };
    const err: unknown = await migrateState(db, TEST_DIALECT, [...MIGRATIONS, broken]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateMigrationError);
    expect((err as StateMigrationError).migration).toBe('9999-broken');
    expect((err as Error).message).toContain('9999-broken');
    expect(await tableNames(db)).not.toContain('half_done');
    expect(await appliedMigrations(db)).toEqual(MIGRATIONS.map((m) => m.name));
  });

  it.runIf(TEST_DIALECT === 'sqlite')('SQLite runs in WAL mode with foreign keys on', async () => {
    const db = dbOf(await tdb.open()) as unknown as Kysely<unknown>;
    const { rows: mode } = await sql<{ journal_mode: string }>`pragma journal_mode`.execute(db);
    expect(mode[0]?.journal_mode).toBe('wal');
    const { rows: fk } = await sql<{ foreign_keys: number }>`pragma foreign_keys`.execute(db);
    expect(fk[0]?.foreign_keys).toBe(1);
  });

  it.runIf(TEST_DIALECT === 'postgres')('concurrent opens on Postgres serialize on the advisory lock', async () => {
    const opened = await Promise.all([tdb.open(), tdb.open(), tdb.open()]);
    for (const s of opened) {
      expect(await appliedMigrations(dbOf(s))).toEqual(MIGRATIONS.map((m) => m.name));
    }
  });
});

/** A bare handle on the test database, so a test can stop the schema at an older migration. */
function bareDb(): Kysely<Database> {
  const url = tdb.options.url ?? '';
  return tdb.dialect === 'sqlite'
    ? new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(url) }) })
    : new Kysely<Database>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }) });
}

describe(`0002 event tx_order (${TEST_DIALECT})`, () => {
  it('numbers existing events in their old readSince order, before every later append', async () => {
    const codec = createCodec(tdb.dialect);
    const db = bareDb();
    try {
      expect(await migrateState(db, TEST_DIALECT, MIGRATIONS.slice(0, 1))).toEqual(['0001-initial']);
      const row = (incident: string, seq: number, recordedAt: string) => ({
        workspace_id: WS,
        incident_id: incident,
        seq,
        type: 'closed',
        source: 'agent',
        payload: codec.json({ reason: `${incident.slice(-2, -1)}${seq}` }),
        occurred_at: recordedAt,
        recorded_at: recordedAt,
      });
      const legacy = db as unknown as Kysely<Record<'incident_events', ReturnType<typeof row>>>;
      await legacy
        .insertInto('incident_events')
        .values([
          row('01JZ00000000000000000000B1', 1, '2026-10-01T10:00:01.000Z'),
          row('01JZ00000000000000000000A1', 1, '2026-10-01T10:00:01.000Z'),
          row('01JZ00000000000000000000A1', 2, '2026-10-01T10:00:02.000Z'),
          row('01JZ00000000000000000000C1', 1, '2026-10-01T10:00:00.000Z'),
        ])
        .execute();
      expect(await migrateState(db, TEST_DIALECT, MIGRATIONS.slice(0, 2))).toEqual(['0002-event-tx-order']);
      const rows = await db.selectFrom('incident_events').select(['incident_id', 'seq', 'tx_order']).orderBy('tx_order').execute();
      expect(rows.map((r) => [r.incident_id.slice(-2), r.seq, codec.fromNumber(r.tx_order)])).toEqual([
        ['C1', 1, -4],
        ['A1', 1, -3],
        ['B1', 1, -2],
        ['A1', 2, -1],
      ]);
    } finally {
      await db.destroy();
    }

    const state = await tdb.open();
    await state.append('01JZ00000000000000000000A1', [{ workspaceId: WS, incidentId: '01JZ00000000000000000000A1', type: 'closed', v: 1, source: 'agent', occurredAt: '2026-10-01T09:00:00.000Z', payload: { reason: 'new' } }], 2);
    // On Postgres the new event is withheld while any older transaction in the cluster is open.
    let events: IncidentEvent[] = [];
    for (const deadline = Date.now() + 10_000; events.length < 5 && Date.now() < deadline; ) {
      events = (await state.readSince(LOG_START, 10)).events;
    }
    expect(events.map((e) => (e.type === 'closed' ? e.payload.reason : e.type))).toEqual(['C1', 'A1', 'B1', 'A2', 'new']);
  });
});

describe(`0004 incident owner_ref (${TEST_DIALECT})`, () => {
  it('backfills each projected row from its latest resolved event', async () => {
    const codec = createCodec(tdb.dialect);
    const db = bareDb();
    try {
      expect(await migrateState(db, TEST_DIALECT, MIGRATIONS.slice(0, 3))).toEqual(['0001-initial', '0002-event-tx-order', '0003-linked-identities']);
      const at = '2026-10-01T10:00:00.000Z';
      const incident = (id: string) => ({ id, workspace_id: WS, kind: 'incident', status: 'filed', source: 'slack', opened_at: at, updated_at: at });
      const event = (incidentId: string, seq: number, type: string, payload: Record<string, unknown>) => ({
        workspace_id: WS,
        incident_id: incidentId,
        seq,
        type,
        source: 'agent',
        payload: codec.json(payload),
        occurred_at: at,
        recorded_at: at,
      });
      const legacy = db as unknown as Kysely<Record<'incidents', ReturnType<typeof incident>> & Record<'incident_events', ReturnType<typeof event>>>;
      await legacy.insertInto('incidents').values([incident('01JZ00000000000000000000A1'), incident('01JZ00000000000000000000B1'), incident('01JZ00000000000000000000C1')]).execute();
      await legacy
        .insertInto('incident_events')
        .values([
          event('01JZ00000000000000000000A1', 3, 'resolved', { surfaceId: 'web', ownerId: 'first', resolvedBy: 'vocabulary', confidence: 0.9 }),
          event('01JZ00000000000000000000A1', 7, 'resolved', { surfaceId: 'web', ownerId: 'webDev1', resolvedBy: 'clarify', confidence: 0.9 }),
          event('01JZ00000000000000000000A1', 8, 'planned', { ownerId: 'not-a-resolution' }),
          event('01JZ00000000000000000000B1', 3, 'resolved', { surfaceId: 'web', resolvedBy: 'channel-inferred', confidence: 0.6 }),
        ])
        .execute();
      expect(await migrateState(db, TEST_DIALECT, MIGRATIONS.slice(0, 4))).toEqual(['0004-incident-owner-ref']);
      const rows = await db.selectFrom('incidents').select(['id', 'owner_ref']).orderBy('id').execute();
      expect(rows.map((r) => [r.id.slice(-2), r.owner_ref])).toEqual([
        ['A1', 'webDev1'],
        ['B1', null],
        ['C1', null],
      ]);
    } finally {
      await db.destroy();
    }
  });
});

describe(`codec round trip through the schema (${TEST_DIALECT})`, () => {
  it('jsonb, timestamptz, boolean, and numeric read back the same on both dialects', async () => {
    const state = await tdb.open();
    if (!(state instanceof StateStore)) {
      throw new Error('openState did not return a StateStore');
    }
    const { db, codec } = state.ctx;
    const at = '2026-10-01T12:34:56.789Z';
    await db.insertInto('workspaces').values({ id: WS, slug: 'acme', created_at: at }).execute();
    await db
      .insertInto('incidents')
      .values({
        id: INC,
        workspace_id: WS,
        kind: 'incident',
        status: 'open',
        source: 'slack',
        waiting_on: codec.json({ kind: 'ci', since: at }),
        monitored: codec.bool(true),
        opened_at: codec.timestamp(new Date(at)),
        updated_at: at,
      })
      .execute();
    await db
      .insertInto('escalation_scores')
      .values({ incident_id: INC, intent: 'urgent', reactor_ids: codec.json(['U1', 'U2']), score: 2.5, window_ends: at })
      .execute();

    const inc = await db.selectFrom('incidents').selectAll().where('id', '=', INC).executeTakeFirstOrThrow();
    expect(codec.fromJsonOpt(inc.waiting_on)).toEqual({ kind: 'ci', since: at });
    expect(codec.fromBool(inc.monitored)).toBe(true);
    expect(codec.fromTimestamp(inc.opened_at)).toBe(at);
    expect(codec.fromTimestampOpt(inc.closed_at)).toBeUndefined();
    expect(inc.last_seq).toBe(0);

    const score = await db.selectFrom('escalation_scores').selectAll().executeTakeFirstOrThrow();
    expect(codec.fromJson(score.reactor_ids)).toEqual(['U1', 'U2']);
    expect(codec.fromNumber(score.score)).toBe(2.5);

    // `default now()` writes the same 24-character ISO form on both dialects.
    await db.insertInto('workspaces').values({ id: `${WS.slice(0, -1)}9`, slug: 'other' }).execute();
    const other = await db.selectFrom('workspaces').select('created_at').where('slug', '=', 'other').executeTakeFirstOrThrow();
    expect(codec.fromTimestamp(other.created_at)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });
});

describe(`StateStore (${TEST_DIALECT})`, () => {
  async function kvRows(state: OpenedState): Promise<string[]> {
    const rows = await dbOf(state).selectFrom('kv').select('k').orderBy('k').execute();
    return rows.map((r) => r.k);
  }

  it('transaction commits when fn resolves', async () => {
    const state = await tdb.open();
    const out = await state.transaction(async (tx) => {
      await dbOf(tx as OpenedState).insertInto('kv').values({ k: 'a', v: '1' }).execute();
      return 'done';
    });
    expect(out).toBe('done');
    expect(await kvRows(state)).toEqual(['a']);
  });

  it('transaction rolls back and rejects when fn throws, including writes from a joined inner transaction', async () => {
    const state = await tdb.open();
    const boom = new Error('boom');
    await expect(
      state.transaction(async (tx) => {
        await dbOf(tx as OpenedState).insertInto('kv').values({ k: 'a', v: '1' }).execute();
        await tx.transaction(async (inner) => {
          expect(inner).toBe(tx);
          await dbOf(inner as OpenedState).insertInto('kv').values({ k: 'b', v: '2' }).execute();
        });
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await kvRows(state)).toEqual([]);
  });
});
