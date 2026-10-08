// Postgres idle-client errors never become uncaught, and the store reconnects (B 2).
// Skipped on SQLite: there is no pool.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../helpers/db.ts';

const MISSING = '01JZ00000000000000000000ZZ';

describe.skipIf(TEST_DIALECT !== 'postgres')('postgres pool errors', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it('survives pg_terminate_backend on idle clients and reconnects on the next query', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on('uncaughtException', onUnhandled);
    process.on('unhandledRejection', onUnhandled);
    const poolErrors: Error[] = [];
    try {
      const state = await tdb.open({ onPoolError: (e) => poolErrors.push(e) });
      await state.getIncident(MISSING);
      const admin = new pg.Client({ connectionString: tdb.options.url });
      await admin.connect();
      try {
        const { rowCount } = await admin.query(
          'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
          [tdb.name],
        );
        expect(rowCount).toBeGreaterThan(0);
      } finally {
        await admin.end();
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      // The next query reconnects.
      await expect(state.getIncident(MISSING)).resolves.toBeNull();
      expect(unhandled).toEqual([]);
      expect(poolErrors.length).toBeGreaterThan(0);
    } finally {
      process.off('uncaughtException', onUnhandled);
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
