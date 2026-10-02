import { beforeEach, expect, it } from 'vitest';
import { epoch, fixture, id, outbox } from './helpers.ts';
const f = fixture();
beforeEach(async () => {
  f.setTime(1000000);
  for (const target of ['jira', 'github', 'slack', 'teams'] as const) {
    await f.state().ackOutbox((await f.state().drainOutbox(target, 1000)).map((row) => row.id));
  }
  f.setTime(0);
});
it('records first webhook sight and detects a duplicate', async () => {
  const key = id();
  expect(await f.state().seenWebhook('github', key, 60)).toBe(false);
  expect(await f.state().seenWebhook('github', key, 60)).toBe(true);
});
it('keeps a webhook live before its TTL and expires it at the boundary', async () => {
  const key = id();
  expect(await f.state().seenWebhook('github', key, 60)).toBe(false);
  f.setTime(59999);
  expect(await f.state().seenWebhook('github', key, 60)).toBe(true);
  f.setTime(60000);
  expect(await f.state().seenWebhook('github', key, 60)).toBe(false);
  expect(await f.state().seenWebhook('github', key, 60)).toBe(true);
});
it('keeps webhook sources and delivery IDs independent', async () => {
  const key = id();
  expect(await f.state().seenWebhook('github', key, 60)).toBe(false);
  expect(await f.state().seenWebhook('slack', key, 60)).toBe(false);
  expect(await f.state().seenWebhook('github', id(), 60)).toBe(false);
  expect(await f.state().seenWebhook('github', key, 60)).toBe(true);
});
it('atomically deduplicates simultaneous deliveries', async () => {
  const key = id();
  const results = await Promise.all([f.state().seenWebhook('github', key, 60), f.state().seenWebhook('github', key, 60)]);
  expect(results.sort()).toEqual([false, true]);
});
it('drains FIFO by createdAt with a page limit', async () => {
  const early = outbox({ createdAt: '2026-10-02T11:59:58.000Z' });
  const middle = outbox({ createdAt: '2026-10-02T11:59:59.000Z' });
  const late = outbox();
  for (const row of [late, early, middle]) await f.state().enqueueOutbox(row);
  expect(await f.state().drainOutbox('jira', 2)).toEqual([early, middle]);
  expect(await f.state().drainOutbox('jira', 10)).toEqual([early, middle, late]);
});
it('re-drains unacknowledged rows immediately without claiming them', async () => {
  const row = outbox();
  await f.state().enqueueOutbox(row);
  expect(await f.state().drainOutbox('jira', 10)).toEqual([row]);
  expect(await f.state().drainOutbox('jira', 10)).toEqual([row]);
});
it('honors nextAttempt for a failed row and re-drains when due', async () => {
  const row = outbox({ attempts: 2, lastError: 'fake retryable error', nextAttempt: '2026-10-02T12:00:30.000Z' });
  await f.state().enqueueOutbox(row);
  f.setTime(29999);
  expect(await f.state().drainOutbox('jira', 10)).toEqual([]);
  f.setTime(30000);
  expect(await f.state().drainOutbox('jira', 10)).toEqual([row]);
  expect(await f.state().drainOutbox('jira', 10)).toEqual([row]);
});
it('acknowledges selected rows and ignores unknown IDs', async () => {
  const a = outbox(), b = outbox();
  await f.state().enqueueOutbox(a);
  await f.state().enqueueOutbox(b);
  await f.state().ackOutbox([a.id, id()]);
  await f.state().ackOutbox([a.id]);
  expect(await f.state().drainOutbox('jira', 10)).toEqual([b]);
});
it('isolates outbox targets', async () => {
  const row = outbox({ target: 'slack' });
  await f.state().enqueueOutbox(row);
  expect(await f.state().drainOutbox('jira', 10)).toEqual([]);
  expect(await f.state().drainOutbox('slack', 10)).toEqual([row]);
});
it('preserves caller idempotency data without merging batch keys', async () => {
  const key = 'fake-idempotency-key';
  const a = outbox({ batchKey: key, payload: { idempotencyKey: key } });
  const b = outbox({ batchKey: key, createdAt: '2026-10-02T12:00:00.001Z' });
  await f.state().enqueueOutbox(a);
  await f.state().enqueueOutbox(b);
  expect(await f.state().drainOutbox('jira', 10)).toEqual([a, b]);
});
it('does not drain rows already marked done', async () => {
  await f.state().enqueueOutbox(outbox({ doneAt: epoch }));
  expect(await f.state().drainOutbox('jira', 10)).toEqual([]);
});
