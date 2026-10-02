// Test databases for state tests. The dialect comes from `SNAPWING_DB` (and `DATABASE_URL` on
// Postgres) through `stateOptionsFromEnv`, the one switch (CONTEXT.md 3). Each call makes a fresh,
// empty database so test files run in parallel without sharing state:
// - SQLite: a new file in its own temp directory.
// - Postgres: a new database `snapwing_test_<random>`, created through the admin connection
//   (`DATABASE_URL` itself) and dropped with `WITH (FORCE)`. Test files run in parallel, and
//   Kysely's migrator introspects every schema of the database it is connected to, so sharing one
//   database (even with a schema each) races. Requirement: the `DATABASE_URL` role must be able to
//   CREATE DATABASE (the CI service container's `snapwing` user is the superuser and owns it; a
//   local container made with POSTGRES_USER=snapwing is the same).
//
//   const tdb = await createTestDatabase();
//   const state = await tdb.open();
//   ...
//   await tdb.drop(); // closes every store it opened, then removes the file or database

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { stateOptionsFromEnv, type StateDialect, type StateOptions } from '../../src/contracts/state.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { openState, type OpenStateHooks } from '../../src/state/db.ts';
import { ulid } from '../../src/util/ulid.ts';

/** The dialect this test run uses. */
export const TEST_DIALECT: StateDialect = stateOptionsFromEnv(process.env).dialect;

export interface TestDatabase {
  readonly dialect: StateDialect;
  /** Options that open this database; pass them to `openState` for a second handle. */
  readonly options: StateOptions;
  /** The Postgres database name, or the SQLite file path. */
  readonly name: string;
  /** Opens a store on this database (runs migrations). `drop` closes it. */
  open(hooks?: OpenStateHooks): Promise<OpenedState>;
  /** Closes every store `open` returned and removes the database. */
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const base = stateOptionsFromEnv(process.env);
  const opened: OpenedState[] = [];
  const closeAll = async (): Promise<void> => {
    await Promise.all(opened.splice(0).map((s) => s.close()));
  };

  if (base.dialect === 'sqlite') {
    const dir = await mkdtemp(join(tmpdir(), 'snapwing-state-'));
    const file = join(dir, 'state.sqlite');
    const options: StateOptions = { dialect: 'sqlite', url: file };
    return {
      dialect: 'sqlite',
      options,
      name: file,
      async open(hooks) {
        const s = await openState(options, hooks);
        opened.push(s);
        return s;
      },
      async drop() {
        await closeAll();
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  const adminUrl = base.url ?? '';
  const database = `snapwing_test_${ulid().toLowerCase()}`;
  await withClient(adminUrl, (c) => c.query(`create database "${database}"`));
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  const options: StateOptions = { dialect: 'postgres', url: url.toString() };
  return {
    dialect: 'postgres',
    options,
    name: database,
    async open(hooks) {
      const s = await openState(options, hooks);
      opened.push(s);
      return s;
    },
    async drop() {
      await closeAll();
      await withClient(adminUrl, async (c) => {
        await waitForNoBackends(c, database);
        await c.query(`drop database if exists "${database}" with (force)`);
      });
    },
  };
}

/**
 * `pool.end()` resolves once the pool's client list is empty, before each client's socket has closed,
 * so `drop database ... with (force)` can terminate a backend whose client is still shutting down
 * and the FATAL 57P01 surfaces as an unhandled error (#122). Wait (about 5 s) for the other
 * backends to leave; FORCE still removes any that stay.
 */
async function waitForNoBackends(c: pg.Client, database: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await c.query<{ n: string }>(
      'select count(*)::text as n from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
      [database],
    );
    if (rows[0]?.n === '0' || Date.now() >= deadline) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function withClient<T>(connectionString: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
