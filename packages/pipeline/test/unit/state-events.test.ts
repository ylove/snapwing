// Event log: append, read, readSince (#17; B 1, B 4, B 11 row 1). Runs on the dialect `SNAPWING_DB`
// selects; CI runs it once per dialect.

import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewEvent } from '../../src/contracts/events.ts';
import { ExpectedSeqConflictError, LOG_START, type IncidentEvent, type OpenedState } from '../../src/ports/state.ts';
import type { StateContext } from '../../src/state/context.ts';
import type { OpenStateHooks } from '../../src/state/db.ts';
import { APPEND_LOCK_NAMESPACE, read as readIn } from '../../src/state/events.ts';
import { upcasters } from '../../src/state/upcast.ts';
import { applyProjections } from '../../src/state/projections/index.ts';
import { StateStore } from '../../src/state/store.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../helpers/db.ts';
import { logSettled, readAll, readSettled } from '../helpers/log-settled.ts';

// The spy: the real (no-op until #18) applyProjections, wrapped so tests can see and override calls.
vi.mock('../../src/state/projections/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/state/projections/index.ts')>();
  return { ...actual, applyProjections: vi.fn(actual.applyProjections) };
});
const applySpy = vi.mocked(applyProjections);

const WS = '01JZ0000000000000000000001';
const INC_A = '01JZ00000000000000000000A1';
const INC_B = '01JZ00000000000000000000B1';
const INC_C = '01JZ00000000000000000000C1';
const OCCURRED = '2026-10-01T09:00:00.000Z';

// One database (SQLite file or Postgres schema) and one or two handles per file, opened once:
// `openState` runs migrations, whose Kysely introspection scans every schema and can trip over other
// test files creating or dropping theirs (journal 2026-10-01-pg-schema-drop-race). Each test sets
// the clock through `open(hooks)`, and the log is emptied between tests.
let tdb: TestDatabase;
let state1: OpenedState;
/** A second handle (its own pool) on Postgres; the same handle on SQLite (see `racers`). */
let state2: OpenedState;
let clock: () => Date = () => new Date();

beforeAll(async () => {
  tdb = await createTestDatabase();
  state1 = await tdb.open({ now: () => clock() });
  state2 = TEST_DIALECT === 'postgres' ? await tdb.open({ now: () => clock() }) : state1;
});

afterAll(async () => {
  await tdb.drop();
});

beforeEach(() => {
  clock = () => new Date();
  applySpy.mockReset();
});

afterEach(async () => {
  if (!(state1 instanceof StateStore)) {
    throw new Error('openState did not return a StateStore');
  }
  await state1.ctx.db.deleteFrom('incident_events').execute();
});

/** The test's store, with `hooks.now` as its clock. */
async function open(hooks?: OpenStateHooks): Promise<OpenedState> {
  if (hooks?.now !== undefined) {
    clock = hooks.now;
  }
  return state1;
}

function closed(incidentId: string, reason: string, extra: Partial<NewEvent<'closed'>> = {}): NewEvent<'closed'> {
  return { workspaceId: WS, incidentId, type: 'closed', v: 1, source: 'agent', occurredAt: OCCURRED, payload: { reason }, ...extra };
}

function reasons(events: readonly IncidentEvent[]): (string | undefined)[] {
  return events.map((e) => (e.type === 'closed' ? e.payload.reason : `<${e.type}>`));
}

async function settle<T>(promises: Promise<T>[]): Promise<{ won: T[]; lost: unknown[] }> {
  const results = await Promise.allSettled(promises);
  return {
    won: results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])),
    lost: results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : [])),
  };
}

/** A clock that returns each of `times` once, then keeps returning the last. */
function steppedClock(times: string[]): () => Date {
  let i = 0;
  return () => new Date(times[Math.min(i++, times.length - 1)] ?? OCCURRED);
}

describe('append', () => {
  it('writes gapless per-incident seqs from 1 and returns the last seq', async () => {
    const state = await open();
    expect(await state.append(INC_A, [closed(INC_A, 'a1'), closed(INC_A, 'a2'), closed(INC_A, 'a3')], 0)).toEqual({ seq: 3 });
    expect(await state.append(INC_B, [closed(INC_B, 'b1')], 0)).toEqual({ seq: 1 });
    expect(await state.append(INC_A, [closed(INC_A, 'a4'), closed(INC_A, 'a5')], 3)).toEqual({ seq: 5 });
    expect(await state.append(INC_A, [closed(INC_A, 'a6')], 5)).toEqual({ seq: 6 });

    const a = await state.read(INC_A);
    expect(a.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(reasons(a)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
    expect((await state.read(INC_B)).map((e) => e.seq)).toEqual([1]);
  });

  it('stamps recordedAt from the application clock, one value per append', async () => {
    const state = await open({ now: steppedClock(['2026-10-01T10:00:00.123Z', '2026-10-01T10:00:01.000Z']) });
    await state.append(INC_A, [closed(INC_A, 'a1'), closed(INC_A, 'a2')], 0);
    await state.append(INC_A, [closed(INC_A, 'a3')], 2);
    expect((await state.read(INC_A)).map((e) => e.recordedAt)).toEqual([
      '2026-10-01T10:00:00.123Z',
      '2026-10-01T10:00:00.123Z',
      '2026-10-01T10:00:01.000Z',
    ]);
  });

  it.each([
    { name: 'stale', expectedSeq: 1, actualSeq: 2 },
    { name: 'ahead of the log', expectedSeq: 5, actualSeq: 2 },
    { name: 'zero on an existing incident', expectedSeq: 0, actualSeq: 2 },
  ])('rejects an expectedSeq that is $name and writes nothing', async ({ expectedSeq, actualSeq }) => {
    const state = await open();
    await state.append(INC_A, [closed(INC_A, 'a1'), closed(INC_A, 'a2')], 0);
    applySpy.mockClear();

    const err: unknown = await state.append(INC_A, [closed(INC_A, 'late')], expectedSeq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExpectedSeqConflictError);
    expect(err).toMatchObject({ incidentId: INC_A, expectedSeq, actualSeq, code: 'EXPECTED_SEQ_CONFLICT' });
    expect(reasons(await state.read(INC_A))).toEqual(['a1', 'a2']);
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('rejects malformed calls before touching the log', async () => {
    const state = await open();
    await expect(state.append(INC_A, [], 0)).rejects.toThrow(TypeError);
    await expect(state.append(INC_A, [closed(INC_A, 'a1'), closed(INC_B, 'b1')], 0)).rejects.toThrow('events[1].incidentId');
    await expect(state.append(INC_A, [closed(INC_A, 'a1')], -1)).rejects.toThrow('expectedSeq');
    await expect(state.append(INC_A, [closed(INC_A, 'a1')], 1.5)).rejects.toThrow('expectedSeq');
    expect(await state.read(INC_A)).toEqual([]);
    expect(await state.read(INC_B)).toEqual([]);
  });

  it('joins a caller transaction and rolls back with it', async () => {
    const state = await open();
    const boom = new Error('caller failed');
    await expect(
      state.transaction(async (tx) => {
        expect(await tx.append(INC_A, [closed(INC_A, 'a1')], 0)).toEqual({ seq: 1 });
        expect(await tx.append(INC_A, [closed(INC_A, 'a2')], 1)).toEqual({ seq: 2 });
        expect((await tx.read(INC_A)).map((e) => e.seq)).toEqual([1, 2]);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await state.read(INC_A)).toEqual([]);
  });
});

describe('concurrent appends with the same expectedSeq (B 11 row 1)', () => {
  // SQLite: one handle per file (state/events.ts); its driver serializes the two transactions.
  // Postgres: two handles, two pools, two backends racing for real.
  async function racers(): Promise<[OpenedState, OpenedState]> {
    return [await open(), state2];
  }

  it('exactly one succeeds; the other rejects with ExpectedSeqConflictError', async () => {
    const [s1, s2] = await racers();
    await s1.append(INC_A, [closed(INC_A, 'base')], 0);

    const { won, lost } = await settle([s1.append(INC_A, [closed(INC_A, 'one')], 1), s2.append(INC_A, [closed(INC_A, 'two')], 1)]);
    expect(won).toEqual([{ seq: 2 }]);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toBeInstanceOf(ExpectedSeqConflictError);
    expect(lost[0]).toMatchObject({ incidentId: INC_A, expectedSeq: 1, actualSeq: 2 });

    const log = await s1.read(INC_A);
    expect(log.map((e) => e.seq)).toEqual([1, 2]);
    expect(['one', 'two']).toContain(reasons(log)[1]);
  });

  it('of eight racers on a new incident, one wins and seven conflict', async () => {
    const [s1, s2] = await racers();
    const { won, lost } = await settle(
      Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? s1 : s2).append(INC_A, [closed(INC_A, `r${i}`), closed(INC_A, `r${i}b`)], 0)),
    );
    expect(won).toEqual([{ seq: 2 }]);
    expect(lost).toHaveLength(7);
    for (const e of lost) {
      expect(e).toBeInstanceOf(ExpectedSeqConflictError);
      expect(e).toMatchObject({ expectedSeq: 0, actualSeq: 2 });
    }
    expect((await s1.read(INC_A)).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('appends to different incidents do not conflict', async () => {
    const [s1, s2] = await racers();
    const { won, lost } = await settle([s1.append(INC_A, [closed(INC_A, 'a')], 0), s2.append(INC_B, [closed(INC_B, 'b')], 0)]);
    expect(lost).toEqual([]);
    expect(won).toEqual([{ seq: 1 }, { seq: 1 }]);
  });

  describe.runIf(TEST_DIALECT === 'postgres')('on Postgres', { timeout: 30_000 }, () => {
    async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
      const c = new pg.Client({ connectionString: tdb.options.url });
      await c.connect();
      try {
        return await fn(c);
      } finally {
        await c.end();
      }
    }

    async function waitFor(c: pg.Client, query: string, params: unknown[]): Promise<void> {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const { rows } = await c.query<{ n: string }>(query, params);
        if (Number(rows[0]?.n) > 0) {
          return;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for: ${query}`);
    }

    it('the loser waits on the winner mid-transaction, then sees its seq', async () => {
      const [s1, s2] = await racers();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      // The first append to reach projections holds its transaction (and the incident lock) open.
      applySpy.mockImplementationOnce(() => gate);

      await withClient(async (observer) => {
        const racing = settle([s1.append(INC_A, [closed(INC_A, 'one')], 0), s2.append(INC_A, [closed(INC_A, 'two')], 0)]);
        try {
          // Proof of overlap: the second backend is blocked on the first one's advisory lock.
          await waitFor(
            observer,
            `select count(*) as n from pg_locks
              where locktype = 'advisory' and not granted and classid = $1::int::oid
                and objid = hashtext($2)::oid and objsubid = 2`,
            [APPEND_LOCK_NAMESPACE, INC_A],
          );
        } finally {
          release();
        }
        const { won, lost } = await racing;
        expect(won).toEqual([{ seq: 1 }]);
        expect(lost).toHaveLength(1);
        expect(lost[0]).toMatchObject({ name: 'ExpectedSeqConflictError', expectedSeq: 0, actualSeq: 1 });
      });
      expect((await s1.read(INC_A)).map((e) => e.seq)).toEqual([1]);
    });

    it('a writer that skips the lock still loses to the primary key, as a conflict', async () => {
      const state = await open();
      await withClient(async (rogue) => {
        await withClient(async (observer) => {
          await rogue.query('begin');
          await rogue.query(
            `insert into incident_events (workspace_id, incident_id, seq, type, v, source, payload, occurred_at, recorded_at)
             values ($1, $2, 1, 'closed', 1, 'agent', '{}', $3, $3)`,
            [WS, INC_A, OCCURRED],
          );
          const appending = state.append(INC_A, [closed(INC_A, 'mine')], 0).catch((e: unknown) => e);
          try {
            // The append passed its check (the rogue row is uncommitted) and now waits on the key.
            await waitFor(
              observer,
              `select count(*) as n from pg_stat_activity
                where datname = current_database() and wait_event_type = 'Lock' and query like 'insert into "incident_events"%'`,
              [],
            );
          } finally {
            await rogue.query('commit');
          }
          const err = await appending;
          expect(err).toBeInstanceOf(ExpectedSeqConflictError);
          expect(err).toMatchObject({ incidentId: INC_A, expectedSeq: 0, actualSeq: 1 });
          expect((err as Error).cause).toMatchObject({ code: '23505' });
        });
      });
      expect((await state.read(INC_A)).map((e) => e.seq)).toEqual([1]);
    });
  });
});

describe('append applies projections in the same transaction', () => {
  it('calls applyProjections once with the transaction and the events as read returns them', async () => {
    const state = await open({ now: () => new Date('2026-10-01T10:00:00.000Z') });
    let seenInside: IncidentEvent[] = [];
    applySpy.mockImplementationOnce(async (tx: StateContext) => {
      expect(tx.db.isTransaction).toBe(true);
      // The rows are visible inside the transaction that projections run in.
      seenInside = await readIn(tx, INC_A);
    });

    await state.append(INC_A, [closed(INC_A, 'a1'), closed(INC_A, 'a2')], 0);
    expect(applySpy).toHaveBeenCalledTimes(1);
    const [, passed] = applySpy.mock.calls[0] ?? [];
    const stored = await state.read(INC_A);
    expect(passed).toEqual(stored);
    expect(seenInside).toEqual(stored);
  });

  it('a throw in applyProjections rolls the append back', async () => {
    const state = await open();
    await state.append(INC_A, [closed(INC_A, 'a1')], 0);
    const boom = new Error('projection failed');
    applySpy.mockImplementationOnce(async () => {
      throw boom;
    });

    await expect(state.append(INC_A, [closed(INC_A, 'a2'), closed(INC_A, 'a3')], 1)).rejects.toBe(boom);
    expect(reasons(await state.read(INC_A))).toEqual(['a1']);
    // The log is still at seq 1, so the retry with the same expectedSeq goes through.
    expect(await state.append(INC_A, [closed(INC_A, 'a2')], 1)).toEqual({ seq: 2 });
  });

  it('a key violation raised by projections is not reported as a seq conflict', async () => {
    const state = await open();
    const dup = Object.assign(new Error('duplicate key in a projection table'), { code: TEST_DIALECT === 'postgres' ? '23505' : 'SQLITE_CONSTRAINT_PRIMARYKEY' });
    applySpy.mockImplementationOnce(async () => {
      throw dup;
    });
    await expect(state.append(INC_A, [closed(INC_A, 'a1')], 0)).rejects.toBe(dup);
    expect(await state.read(INC_A)).toEqual([]);
  });
});

describe('read', () => {
  it('returns events in seq order from fromSeq, and nothing for an unknown incident', async () => {
    const state = await open();
    await state.append(INC_A, [closed(INC_A, 'a1'), closed(INC_A, 'a2'), closed(INC_A, 'a3'), closed(INC_A, 'a4')], 0);
    expect(reasons(await state.read(INC_A, 3))).toEqual(['a3', 'a4']);
    expect(reasons(await state.read(INC_A, 0))).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(await state.read(INC_A, 5)).toEqual([]);
    expect(await state.read(INC_C)).toEqual([]);
  });
});

describe('readSince', () => {
  const T1 = '2026-10-01T10:00:00.000Z';
  const T2 = '2026-10-01T10:00:00.001Z';
  const T3 = '2026-10-01T10:00:05.000Z';

  /** Nine events over three incidents, in five appends, with recordedAt ties across incidents. */
  async function seed(): Promise<OpenedState> {
    const state = await open({ now: steppedClock([T1, T1, T2, T3, T3]) });
    await state.append(INC_C, [closed(INC_C, 'c1'), closed(INC_C, 'c2')], 0); // T1
    await state.append(INC_A, [closed(INC_A, 'a1')], 0); // T1
    await state.append(INC_B, [closed(INC_B, 'b1'), closed(INC_B, 'b2'), closed(INC_B, 'b3')], 0); // T2
    await state.append(INC_A, [closed(INC_A, 'a2')], 1); // T3
    await state.append(INC_C, [closed(INC_C, 'c3'), closed(INC_C, 'c4')], 2); // T3
    await logSettled(state1);
    return state;
  }

  // By the appending transaction (here, one per append), then incidentId, then seq.
  const ORDER = ['c1', 'c2', 'a1', 'b1', 'b2', 'b3', 'a2', 'c3', 'c4'];

  it('pages across incidents in append order with no gaps or repeats (3 pages)', async () => {
    const state = await seed();
    const { pages } = await readAll(state, 3, ORDER.length);
    if (TEST_DIALECT !== 'postgres') {
      expect(pages.map(reasons)).toEqual([ORDER.slice(0, 3), ORDER.slice(3, 6), ORDER.slice(6, 9)]);
    } else {
      // A short read can split a page differently on Postgres; the order and the limit still hold.
      expect(reasons(pages.flat())).toEqual(ORDER);
      expect(Math.max(...pages.map((p) => p.length))).toBeLessThanOrEqual(3);
    }
    const keys = pages.flat().map((e) => `${e.incidentId}#${e.seq}`);
    expect(new Set(keys).size).toBe(9);
    expect(pages.flat().map((e) => e.recordedAt)).toEqual([T1, T1, T1, T2, T2, T2, T3, T3, T3]);
  });

  it('one large page equals the pages, and odd page sizes split appends cleanly', async () => {
    const state = await seed();
    const all = await readAll(state, 100, ORDER.length);
    expect(reasons(all.events)).toEqual(ORDER);

    for (const size of [1, 2, 4]) {
      expect((await readAll(state, size, ORDER.length)).events, `page size ${size}`).toEqual(all.events);
    }
  });

  it('returns events appended after the last page on the next call', async () => {
    const state = await open({ now: steppedClock([T1, T2, T3]) });
    await state.append(INC_A, [closed(INC_A, 'a1')], 0);
    await logSettled(state1);
    const first = await readSettled(state, LOG_START, 10, 1);
    expect(reasons(first.events)).toEqual(['a1']);
    await state.append(INC_B, [closed(INC_B, 'b1')], 0);
    await state.append(INC_A, [closed(INC_A, 'a2')], 1);
    await logSettled(state1);
    const second = await readSettled(state, first.cursor, 10, 2);
    expect(reasons(second.events)).toEqual(['b1', 'a2']);
  });

  it('orders by append, not by recordedAt, so a clock that steps back skips nothing', async () => {
    const state = await open({ now: steppedClock([T3, T1]) });
    await state.append(INC_B, [closed(INC_B, 'b1')], 0); // T3
    await logSettled(state1);
    const first = await readSettled(state, LOG_START, 10, 1);
    expect(reasons(first.events)).toEqual(['b1']);
    await state.append(INC_A, [closed(INC_A, 'a1')], 0); // T1, earlier than the cursor's event
    await logSettled(state1);
    expect(reasons((await readSettled(state, first.cursor, 10, 1)).events)).toEqual(['a1']);
  });

  it('appends sharing one transaction come together, by incidentId then seq', async () => {
    const state = await open();
    await state.append(INC_B, [closed(INC_B, 'b1')], 0);
    await state.transaction(async (tx) => {
      await tx.append(INC_C, [closed(INC_C, 'c1')], 0);
      await tx.append(INC_A, [closed(INC_A, 'a1'), closed(INC_A, 'a2')], 0);
      await tx.append(INC_C, [closed(INC_C, 'c2')], 1);
    });
    await state.append(INC_B, [closed(INC_B, 'b2')], 1);
    await logSettled(state1);
    expect(reasons((await readSettled(state, LOG_START, 10, 6)).events)).toEqual(['b1', 'a1', 'a2', 'c1', 'c2', 'b2']);
  });

  it('a reader racing concurrent appenders sees every event exactly once', { timeout: 30_000 }, async () => {
    const [s1, s2] = [await open(), state2];
    const incidents = [INC_A, INC_B, INC_C];
    const seen: IncidentEvent[] = [];
    let cursor = LOG_START;
    let writing = true;

    const reader = (async () => {
      while (writing) {
        const page = await s1.readSince(cursor, 3);
        seen.push(...page.events);
        cursor = page.cursor;
        await new Promise((r) => setImmediate(r));
      }
    })();
    /** Appends `n` single-event batches to one incident, retrying conflicts from a fresh read. */
    const writer = async (s: OpenedState, id: string, tag: string, n: number): Promise<void> => {
      for (let i = 0; i < n; ) {
        const at = (await s.read(id)).length;
        try {
          await s.append(id, [closed(id, `${tag}${i}`)], at);
          i += 1;
        } catch (e) {
          if (!(e instanceof ExpectedSeqConflictError)) throw e;
        }
      }
    };
    await Promise.all(incidents.flatMap((id, k) => [writer(s1, id, `w${k}x`, 15), writer(s2, id, `w${k}y`, 15)]));
    writing = false;
    await reader;

    await logSettled(state1);
    // A short read on Postgres is not the end: keep reading until all 90 are in (or the deadline).
    seen.push(...(await readAll(s1, 50, 90 - seen.length, cursor)).events);
    const keys = seen.map((e) => `${e.incidentId}#${e.seq}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(90);
    for (const id of incidents) {
      expect(seen.filter((e) => e.incidentId === id).map((e) => e.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    }
  });

  it('returns the given cursor for an empty log and rejects cursors it did not issue', async () => {
    const state = await open();
    expect(await state.readSince(LOG_START, 5)).toEqual({ events: [], cursor: LOG_START });
    await expect(state.readSince('not-a-cursor', 5)).rejects.toThrow('not a cursor');
    await expect(state.readSince(Buffer.from('[1,2,3]').toString('base64url'), 5)).rejects.toThrow('not a cursor');
    // The form issued before migration 0002, keyed on recordedAt.
    await expect(state.readSince(Buffer.from(JSON.stringify([T1, INC_A, 1])).toString('base64url'), 5)).rejects.toThrow('not a cursor');
    await expect(state.readSince(LOG_START, 0)).rejects.toThrow('limit');
  });

  // #84: a cursor must never pass an event whose transaction commits after the read.
  describe.runIf(TEST_DIALECT === 'postgres')('on Postgres, with a transaction still open', { timeout: 30_000 }, () => {
    /** A promise that resolves when `open()` is called, and `open()` itself. */
    function latch(): { wait: Promise<void>; open: () => void } {
      let open!: () => void;
      const wait = new Promise<void>((r) => (open = r));
      return { wait, open };
    }

    it('an append that commits after a later one is returned on the next page', async () => {
      const state = await open();
      await state.append(INC_C, [closed(INC_C, 'base')], 0);
      await logSettled(state1);

      // The next append to reach projections waits there: inserted, not committed.
      const reached = latch();
      const gate = latch();
      applySpy.mockImplementationOnce(() => {
        reached.open();
        return gate.wait;
      });
      const first = state.append(INC_A, [closed(INC_A, 'first')], 0);
      try {
        await reached.wait;
        await state2.append(INC_B, [closed(INC_B, 'later')], 0); // committed
        const during = await state.readSince(LOG_START, 10);
        // The read passes `base` but stops before the open transaction, so `later` is withheld.
        expect(reasons(during.events)).toEqual(['base']);
        expect(reasons((await state.readSince(during.cursor, 10)).events)).toEqual([]);

        gate.open();
        expect(await first).toEqual({ seq: 1 });
        await logSettled(state1);
        const next = await readSettled(state, during.cursor, 10, 2);
        expect(reasons(next.events)).toEqual(['first', 'later']);
      } finally {
        gate.open();
        await first.catch(() => undefined);
      }
    });

    it('inside a caller transaction, readSince returns what committed before and withholds its own appends', async () => {
      const state = await open();
      await state.append(INC_C, [closed(INC_C, 'base')], 0);
      await logSettled(state1);
      await state.transaction(async (tx) => {
        expect(reasons((await readSettled(tx, LOG_START, 10, 1)).events)).toEqual(['base']);
        await tx.append(INC_A, [closed(INC_A, 'mine')], 0);
        // A later transaction commits, so the snapshot's xmax passes this one's id. Postgres leaves
        // the transaction's own id out of the snapshot's in-flight list; the bound still stops below
        // it, so an append that may yet roll back is never passed.
        await state2.append(INC_B, [closed(INC_B, 'later')], 0);
        expect(reasons((await tx.readSince(LOG_START, 10)).events)).toEqual(['base']);
        expect(reasons(await tx.read(INC_A))).toEqual(['mine']);
      });
      await logSettled(state1);
      expect(reasons((await readSettled(state, LOG_START, 10, 3)).events)).toEqual(['base', 'mine', 'later']);
    });

    it('a transaction that wrote before a later append sorts first even though it appends after', async () => {
      const state = await open();
      if (!(state instanceof StateStore)) {
        throw new Error('openState did not return a StateStore');
      }
      const reached = latch();
      const gate = latch();
      const caller = state.transaction(async (tx) => {
        await (tx as StateStore).kvSet('84-early-write', 'x'); // the transaction's id is assigned here
        reached.open();
        await gate.wait;
        await tx.append(INC_A, [closed(INC_A, 'early')], 0);
      });
      try {
        await reached.wait;
        await state2.append(INC_B, [closed(INC_B, 'later')], 0);
        const during = await state.readSince(LOG_START, 10);
        expect(during.events).toEqual([]);

        gate.open();
        await caller;
        await logSettled(state1);
        expect(reasons((await readSettled(state, during.cursor, 10, 2)).events)).toEqual(['early', 'later']);
      } finally {
        gate.open();
        await caller.catch(() => undefined);
        await state.ctx.db.deleteFrom('kv').execute();
      }
    });
  });
});

describe('stored values round-trip', () => {
  it('keeps v, source, actor, occurredAt, and a rich JSON payload on both dialects', async () => {
    const state = await open({ now: () => new Date('2026-10-01T10:00:00.000Z') });
    const captured: NewEvent<'captured'> = {
      workspaceId: WS,
      incidentId: INC_A,
      type: 'captured',
      v: 3,
      source: 'slack',
      actor: { id: 'U-FAKE-REPORTER', role: 'reporter' },
      occurredAt: '2026-10-01T08:59:59Z',
      payload: {
        kind: 'incident',
        idempotencyKey: 'slack:T-FAKE:C-FAKE:1727773199.000100',
        source: 'slack',
        reporter: { id: 'U-FAKE-REPORTER', name: 'Test Reporter', role: 'reporter' },
        anchorText: 'Checkout says "500" – café \u{1F41B} <b>&amp;</b>\nsecond line',
        channelId: 'C-FAKE',
        rawPayloadSnapshot: {
          nested: { list: [1, 2.5, -3e-7, true, false, null, 'x', [], {}], empty: '' },
          big: 9007199254740991,
          blocks: [{ type: 'rich_text', elements: [{ text: 'hi' }] }],
        },
      },
    };
    const agentEvent = closed(INC_A, 'done', { v: 1 });
    await state.append(INC_A, [captured, agentEvent], 0);

    const [first, second] = await state.read(INC_A);
    expect(first).toEqual({ ...captured, occurredAt: '2026-10-01T08:59:59.000Z', seq: 1, recordedAt: '2026-10-01T10:00:00.000Z' });
    expect(first?.v).toBe(3);
    // No actor columns means no `actor` property, not an undefined one.
    expect(second).toEqual({ ...agentEvent, seq: 2, recordedAt: '2026-10-01T10:00:00.000Z' });
    expect(second && 'actor' in second).toBe(false);
    await logSettled(state1);
    expect((await readSettled(state, LOG_START, 10, 2)).events).toEqual([first, second]);
  });

  it('stores v in its column', async () => {
    const state = await open();
    await state.append(INC_A, [closed(INC_A, 'a', { v: 2 })], 0);
    if (!(state instanceof StateStore)) {
      throw new Error('openState did not return a StateStore');
    }
    const row = await state.ctx.db.selectFrom('incident_events').select(['v', 'seq']).where('incident_id', '=', INC_A).executeTakeFirstOrThrow();
    expect(row).toEqual({ v: 2, seq: 1 });
  });
});

describe('read and readSince upcast (B 4)', () => {
  it('return the registered v1 to v2 upcast, and the stored row stays v1', async () => {
    const state = await open();
    // A v1 `closed` event from before `why` was renamed to `reason`.
    const v1 = { ...closed(INC_A, 'unused'), payload: { why: 'old shape' } } as unknown as NewEvent;
    await state.append(INC_A, [v1], 0);
    await logSettled(state1);

    const unregister = upcasters.register('closed', 1, (payload) => ({ reason: (payload as { why: string }).why }));
    try {
      const viaRead = await state.read(INC_A);
      expect(viaRead).toHaveLength(1);
      expect(viaRead[0]).toMatchObject({ type: 'closed', v: 2, payload: { reason: 'old shape' } });
      const viaSince = await readSettled(state, LOG_START, 10, 1);
      expect(viaSince.events).toHaveLength(1);
      expect(viaSince.events[0]).toMatchObject({ type: 'closed', v: 2, payload: { reason: 'old shape' } });
    } finally {
      unregister();
    }
    const stored = await state.read(INC_A);
    expect(stored[0]).toMatchObject({ v: 1, payload: { why: 'old shape' } });
  });
});
