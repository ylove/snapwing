import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExpectedSeqConflictError, LOG_START, stateOptionsFromEnv, type IncidentEvent } from '../../../src/contracts/state.ts';
import type { OpenedState, StatePort } from '../../../src/ports/state.ts';
import { openState } from '../../../src/state/db.ts';
import { ulid } from '../../../src/util/ulid.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../../helpers/db.ts';
import { event, fixture, id } from './helpers.ts';

const f = fixture();
it('starts a new incident at expectedSeq zero', async () => {
  const key = id();
  expect(await f.state().append(key, [event(key)], 0)).toEqual({ seq: 1 });
});
it('reports all conflict fields and writes nothing on stale append', async () => {
  const key = id();
  await f.state().append(key, [event(key)], 0);
  const before = await f.state().read(key);
  const error: unknown = await f.state().append(key, [event(key), event(key)], 0).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ExpectedSeqConflictError);
  expect(error).toMatchObject({ incidentId: key, expectedSeq: 0, actualSeq: 1 });
  expect(await f.state().read(key)).toEqual(before);
});
it('rejects a nonzero expectedSeq for an unknown incident', async () => {
  const key = id();
  await expect(f.state().append(key, [event(key)], 3)).rejects.toMatchObject({ incidentId: key, expectedSeq: 3, actualSeq: 0 });
  expect(await f.state().read(key)).toEqual([]);
});
it('allows exactly one of two racing appends', async () => {
  const key = id();
  const results = await Promise.allSettled([f.state().append(key, [event(key)], 0), f.state().append(key, [event(key)], 0)]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const failure = results.find((r) => r.status === 'rejected');
  expect(failure?.status === 'rejected' ? failure.reason : undefined).toMatchObject({ incidentId: key, expectedSeq: 0, actualSeq: 1 });
  expect(await f.state().read(key)).toHaveLength(1);
});
it('assigns gapless sequences across batches and a rejected append', async () => {
  const key = id();
  await f.state().append(key, [event(key), event(key)], 0);
  await expect(f.state().append(key, [event(key)], 1)).rejects.toBeInstanceOf(ExpectedSeqConflictError);
  await f.state().append(key, [event(key), event(key)], 2);
  expect(await f.state().append(key, [event(key)], 4)).toEqual({ seq: 5 });
  expect((await f.state().read(key)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
});
it('keeps incident sequences independent', async () => {
  const a = id(), b = id();
  await f.state().append(a, [event(a), event(a)], 0);
  await f.state().append(b, [event(b)], 0);
  expect((await f.state().read(a)).map((e) => e.seq)).toEqual([1, 2]);
  expect((await f.state().read(b)).map((e) => e.seq)).toEqual([1]);
});
it('reads from an inclusive sequence and returns an empty tail', async () => {
  const key = id();
  await f.state().append(key, [event(key), event(key), event(key)], 0);
  expect((await f.state().read(key, 2)).map((e) => e.seq)).toEqual([2, 3]);
  expect(await f.state().read(key, 4)).toEqual([]);
  expect(await f.state().read(id())).toEqual([]);
});
it('round trips event data and stamps the injected clock', async () => {
  const key = id();
  f.setTime(1234);
  const input = event(key);
  await f.state().append(key, [input], 0);
  expect(await f.state().read(key)).toEqual([{ ...input, seq: 1, recordedAt: '2026-10-02T12:00:01.234Z' }]);
});
it('pages the global log in append order without gaps (ADR 0013)', async () => {
  f.setTime(3000);
  const a = id(), b = id();
  await f.state().append(b, [event(b)], 0);
  await f.state().append(a, [event(a), event(a)], 0);
  f.setTime(2000); // readSince does not order by recordedAt
  await f.state().append(b, [event(b)], 1);
  // On Postgres an event is withheld while an older transaction that can write this database is open.
  let all: Awaited<ReturnType<StatePort['readSince']>>['events'] = [];
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
    all = (await f.state().readSince(LOG_START, 1000)).events;
    if (all.some((e) => e.incidentId === b && e.seq === 2)) break;
  }
  const keys = all.map((e) => `${e.incidentId}#${e.seq}`);
  expect(new Set(keys).size).toBe(keys.length);
  for (const incident of new Set(all.map((e) => e.incidentId))) {
    const seqs = all.filter((e) => e.incidentId === incident).map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  }
  expect(all.filter((e) => e.incidentId === a || e.incidentId === b).map((e) => [e.incidentId, e.seq])).toEqual([[b, 1], [a, 1], [a, 2], [b, 2]]);
  const collected: typeof all = [];
  let cursor = LOG_START;
  for (let pageNumber = 0; pageNumber <= all.length; pageNumber++) {
    const page = await f.state().readSince(cursor, 2);
    expect(page.events.length).toBeLessThanOrEqual(2);
    if (page.events.length === 0) {
      expect(page.cursor).toBe(cursor);
      break;
    }
    expect(page.cursor).not.toBe(cursor);
    collected.push(...page.events);
    cursor = page.cursor;
  }
  expect(collected).toEqual(all);
  expect(await f.state().readSince(cursor, 2)).toEqual({ events: [], cursor });
});

// On Postgres the watermark counts only transactions that can write this database's log. Two
// databases on one server, like the shared test container or a managed server hosting several.
describe.runIf(TEST_DIALECT === 'postgres')('readSince beside other databases on one Postgres server', () => {
  let home: TestDatabase | undefined;
  let other: TestDatabase | undefined;
  let state: OpenedState;
  const role = `snapwing_t${ulid().toLowerCase()}`;
  beforeAll(async () => {
    home = await createTestDatabase();
    other = await createTestDatabase();
    state = await home.open();
  });
  afterAll(async () => {
    try {
      await home?.drop();
      await other?.drop();
    } finally {
      await withClient(stateOptionsFromEnv(process.env).url ?? '', (c) => c.query(`drop role if exists "${role}"`));
    }
  });
  const url = (db: TestDatabase | undefined): string => db?.options.url ?? '';

  it('a transaction open in another database does not hold back the log', async () => {
    const elsewhere = await holdOpen(url(other));
    try {
      const key = id();
      await state.append(key, [event(key)], 0);
      await withClient(url(home), async (c) => {
        // The event sorts after the open transaction, and the server's oldest in-flight transaction
        // is at or before it, so a cluster-wide watermark would withhold the event until it ends.
        const { rows } = await c.query<{ tx_order: string; xmin: string }>(
          'select tx_order::text, pg_snapshot_xmin(pg_current_snapshot())::text as xmin from incident_events where incident_id = $1',
          [key],
        );
        const [row] = rows;
        if (row === undefined) throw new Error(`no row for ${key}`);
        expect(BigInt(row.tx_order)).toBeGreaterThan(elsewhere.xid);
        expect(BigInt(row.xmin)).toBeLessThanOrEqual(elsewhere.xid);
      });
      expect(await readUntil(state, key)).toBe(true);
      expect(await elsewhere.stillOpen()).toBe(true);
    } finally {
      await elsewhere.release();
    }
  });

  it('a transaction open in the same database still withholds every row at or above it', async () => {
    const here = await holdOpen(url(home));
    let open = true;
    try {
      const key = id();
      await state.append(key, [event(key)], 0);
      const page = await state.readSince(LOG_START, 1000);
      expect(page.events.map((e) => e.incidentId)).not.toContain(key);
      await here.release();
      open = false;
      expect(await readUntil(state, key, page.cursor)).toBe(true);
    } finally {
      if (open) await here.release();
    }
  });

  it('falls back to the server-wide watermark for a role that cannot read pg_stat_activity', async () => {
    await withClient(url(home), async (c) => {
      await c.query(`create role "${role}" login password 'fake-test-password'`);
      await c.query(`grant all on schema public to "${role}"`);
      await c.query(`grant all on all tables in schema public to "${role}"`);
      await c.query(`grant all on all sequences in schema public to "${role}"`);
      await c.query('revoke select on pg_catalog.pg_stat_activity from public');
    });
    const limited = new URL(url(home));
    limited.username = role;
    limited.password = 'fake-test-password';
    const restricted = await openState({ dialect: 'postgres', url: limited.toString() });
    const elsewhere = await holdOpen(url(other));
    try {
      const key = id();
      await restricted.append(key, [event(key)], 0);
      // The read works, and the transaction in the other database now holds the event back.
      expect((await restricted.readSince(LOG_START, 1000)).events.map((e) => e.incidentId)).not.toContain(key);
      expect(await readUntil(state, key)).toBe(true);
    } finally {
      await elsewhere.release();
      await restricted.close();
    }
  });
});

async function withClient<T>(connectionString: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** A transaction left open on `url` with its id assigned, as a long or idle writer would be. */
async function holdOpen(url: string): Promise<{ xid: bigint; stillOpen: () => Promise<boolean>; release: () => Promise<void> }> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('begin');
  const { rows } = await c.query<{ xid: string }>('select pg_current_xact_id()::text as xid');
  const xid = BigInt(rows[0]?.xid ?? 0);
  return {
    xid,
    stillOpen: async () => (await c.query<{ open: boolean }>('select pg_current_xact_id_if_assigned()::text = $1 as open', [String(xid)])).rows[0]?.open === true,
    release: async () => {
      try {
        await c.query('rollback');
      } finally {
        await c.end();
      }
    },
  };
}

/**
 * Pages `readSince` from `cursor` until it returns an event of `incidentId` (true) or `ms` passes
 * (false). A short wait is normal: a transaction of this database (autovacuum's analyze, say) may
 * be in flight.
 */
async function readUntil(state: StatePort, incidentId: string, cursor = LOG_START, ms = 10_000): Promise<boolean> {
  let at = cursor;
  for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
    const page: { events: IncidentEvent[]; cursor: string } = await state.readSince(at, 1000);
    if (page.events.some((e) => e.incidentId === incidentId)) return true;
    at = page.cursor;
    if (page.events.length === 0) await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}
