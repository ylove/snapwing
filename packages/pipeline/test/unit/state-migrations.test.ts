// Migrations, the dialect factory, and transactions (#16; B 2, B 3, B 10; ADR 0011). Runs on the
// dialect `SNAPWING_DB` selects; CI runs it once per dialect.

import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OpenedState } from '../../src/ports/state.ts';
import { STATE_TABLES, type Database } from '../../src/state/db.ts';
import { NotImplementedError, StateMigrationError } from '../../src/state/errors.ts';
import { MIGRATION_TABLE, MIGRATIONS, migrateState, type StateMigration } from '../../src/state/migrations/index.ts';
import { createTable } from '../../src/state/migrations/schema.ts';
import { StateStore } from '../../src/state/store.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../helpers/db.ts';

const WS = '01JZ0000000000000000000001';
const INC = '01JZ0000000000000000000002';

/** Every index B 3 asks for plus the scheduler's, by ADR 0011's `{table}_{columns}_idx` names. */
const STATE_INDEXES = [
  'incident_events_workspace_id_recorded_at_idx',
  'incident_events_type_recorded_at_idx',
  'incidents_workspace_id_status_idx',
  'incidents_workspace_id_surface_id_status_idx',
  'incidents_jira_key_idx',
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
  const tables = await db.introspection.getTables();
  return tables.filter((t) => tdb.dialect === 'sqlite' || t.schema === tdb.name).map((t) => t.name).sort();
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

  it('every port method not yet filled delegates to a stub that throws NotImplementedError until #17, #18', async () => {
    const state = await tdb.open();
    const calls: [string, () => Promise<unknown>][] = [
      ['append', () => state.append(INC, [], 0)],
      ['read', () => state.read(INC)],
      ['readSince', () => state.readSince('', 10)],
      ['getIncident', () => state.getIncident(INC)],
      ['findIncidents', () => state.findIncidents({})],
      ['getClaims', () => state.getClaims(INC)],
      ['getSubscriptions', () => state.getSubscriptions(INC)],
      // Artifacts, inbox, outbox, config, and kv landed in #19 (test/unit/state-stores.test.ts).
    ];
    for (const [method, call] of calls) {
      const err: unknown = await call().catch((e: unknown) => e);
      expect(err, method).toBeInstanceOf(NotImplementedError);
      expect((err as NotImplementedError).method).toBe(method);
    }
    expect(calls).toHaveLength(7);
  });
});
