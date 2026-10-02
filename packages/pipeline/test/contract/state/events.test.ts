import { expect, it } from 'vitest';
import { ExpectedSeqConflictError, LOG_START } from '../../../src/contracts/state.ts';
import type { StatePort } from '../../../src/ports/state.ts';
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
  // On Postgres an event is withheld while an older transaction anywhere in the cluster is open.
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
