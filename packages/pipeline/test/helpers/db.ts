// Test databases for state tests. The dialect comes from `SNAPWING_DB` (and `DATABASE_URL` on
// Postgres) through `stateOptionsFromEnv`, the one switch (CONTEXT.md 3). Each call makes a fresh,
// empty database so test files run in parallel without sharing state:
// - SQLite: a new file in its own temp directory.
// - Postgres: a new schema in the `DATABASE_URL` database, selected through the connection's
//   `search_path`, so every pooled connection lands in it.
//
//   const tdb = await createTestDatabase();
//   const state = await tdb.open();
//   ...
//   await tdb.drop(); // closes every store it opened, then removes the file or schema

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
  /** The Postgres schema, or the SQLite file path. */
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

  const baseUrl = base.url ?? '';
  const schema = `test_${ulid().toLowerCase()}`;
  await withClient(baseUrl, (c) => c.query(`create schema "${schema}"`));
  const url = new URL(baseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const options: StateOptions = { dialect: 'postgres', url: url.toString() };
  return {
    dialect: 'postgres',
    options,
    name: schema,
    async open(hooks) {
      const s = await openState(options, hooks);
      opened.push(s);
      return s;
    },
    async drop() {
      await closeAll();
      await withClient(baseUrl, (c) => c.query(`drop schema if exists "${schema}" cascade`));
    },
  };
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
