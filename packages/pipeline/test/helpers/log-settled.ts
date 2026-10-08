// Settling helpers for tests that read the event log with `readSince`. On Postgres `readSince`
// withholds events at or above the watermark (`pgWatermark`: the oldest in-flight transaction that
// can write this database), so a test that appends and then reads has to wait for it. SQLite has no
// watermark and every helper here returns at once.

import { sql } from 'kysely';
import { expect } from 'vitest';
import { LOG_START, type IncidentEvent, type OpenedState } from '../../src/ports/state.ts';
import { pgWatermark } from '../../src/state/events.ts';
import { StateStore } from '../../src/state/store.ts';
import { TEST_DIALECT } from './db.ts';

type Reader = Pick<OpenedState, 'readSince'>;
type Page = Awaited<ReturnType<OpenedState['readSince']>>;

/**
 * Waits until `readSince` can return every committed event: the log head is below `pgWatermark`.
 * Other databases on the same server do not count. A no-op on SQLite.
 */
export async function logSettled(state: OpenedState): Promise<void> {
  if (!(state instanceof StateStore) || state.dialect !== 'postgres') {
    return;
  }
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await sql<{ settled: boolean }>`
      select coalesce(max(tx_order) < ${await pgWatermark(state.ctx)}, true) as settled from incident_events
    `.execute(state.ctx.db);
    if (rows[0]?.settled === true) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the readSince watermark to pass the log');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * `logSettled` and `readSince` each take their own watermark, and `pgWatermark` itself reads the
 * snapshot and `pg_stat_activity` separately, so on Postgres any single `readSince` can come back
 * short (a transaction of another database ending between the two reads). A later read returns
 * the rest; nothing is skipped. This reads from `cursor` until the page holds `expected` events,
 * then returns it, so the caller's assertions stay exact: a page that is too long or wrong is
 * returned and fails them. On SQLite it is a single read.
 */
export async function readSettled(state: Reader, cursor: string, limit: number, expected: number): Promise<Page> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const page = await state.readSince(cursor, limit);
    if (TEST_DIALECT !== 'postgres' || page.events.length >= expected) {
      return page;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for readSince to return ${expected} events (got ${page.events.length})`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Pages through the log from `from` with `limit` until `expected` events are collected, then reads
 * once more and asserts nothing is left. An empty or short page before the count is "not yet" on
 * Postgres (see `readSettled`), so it is retried from the same cursor until the deadline. A page
 * that moves the cursor without events, or an overshoot, fails the caller's assertions.
 */
export async function readAll(
  state: Reader,
  limit: number,
  expected: number,
  from = LOG_START,
): Promise<{ pages: IncidentEvent[][]; events: IncidentEvent[]; cursor: string }> {
  const deadline = Date.now() + 10_000;
  const pages: IncidentEvent[][] = [];
  let cursor = from;
  let count = 0;
  while (count < expected) {
    const page = await state.readSince(cursor, limit);
    if (page.events.length === 0) {
      expect(page.cursor).toBe(cursor);
      if (TEST_DIALECT !== 'postgres' || Date.now() > deadline) {
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
      continue;
    }
    expect(page.cursor).not.toBe(cursor);
    pages.push(page.events);
    count += page.events.length;
    cursor = page.cursor;
  }
  // Everything is collected, so nothing else is appended: a final read has nothing to return.
  expect((await state.readSince(cursor, limit)).events).toEqual([]);
  return { pages, events: pages.flat(), cursor };
}
