import { beforeEach, expect, it } from 'vitest';
import { isParkedOutbox } from '../../../src/contracts/state.ts';
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
it('drains one workspace when asked', async () => {
  const other = id();
  const mine = outbox();
  const theirs = outbox({ workspaceId: other });
  await f.state().enqueueOutbox(mine);
  await f.state().enqueueOutbox(theirs);
  expect(await f.state().drainOutbox('jira', 10, other)).toEqual([theirs]);
  expect(await f.state().drainOutbox('jira', 10)).toEqual([mine, theirs]);
});
it('defers with an error: counts an attempt, records it, and holds the row until due', async () => {
  const row = outbox();
  await f.state().enqueueOutbox(row);
  await f.state().deferOutbox(row.id, '2026-10-02T12:00:10.000Z', 'jira answered 503');
  expect(await f.state().drainOutbox('jira', 10)).toEqual([]);
  f.setTime(10000);
  expect(await f.state().drainOutbox('jira', 10)).toEqual([{ ...row, attempts: 1, lastError: 'jira answered 503', nextAttempt: '2026-10-02T12:00:10.000Z' }]);
});
it('holds without an error: no attempt counted, no error recorded', async () => {
  const row = outbox();
  await f.state().enqueueOutbox(row);
  await f.state().deferOutbox(row.id, '2026-10-02T12:01:00.000Z');
  expect(await f.state().drainOutbox('jira', 10)).toEqual([]);
  f.setTime(60000);
  expect(await f.state().drainOutbox('jira', 10)).toEqual([{ ...row, nextAttempt: '2026-10-02T12:01:00.000Z' }]);
});
it('keeps order per incident: a deferred row holds back its incident only', async () => {
  const incident = id();
  const first = outbox({ incidentId: incident });
  const second = outbox({ incidentId: incident, createdAt: '2026-10-02T12:00:00.001Z', nextAttempt: '2026-10-02T12:00:00.001Z' });
  const unrelated = outbox({ incidentId: id(), createdAt: '2026-10-02T12:00:00.002Z', nextAttempt: '2026-10-02T12:00:00.002Z' });
  const loose = outbox({ createdAt: '2026-10-02T12:00:00.003Z', nextAttempt: '2026-10-02T12:00:00.003Z' });
  for (const row of [first, second, unrelated, loose]) await f.state().enqueueOutbox(row);
  f.setTime(5);
  await f.state().deferOutbox(first.id, '2026-10-02T12:00:30.000Z', 'jira answered 502');
  expect((await f.state().drainOutbox('jira', 10)).map((r) => r.id)).toEqual([unrelated.id, loose.id]);
  f.setTime(30000);
  expect((await f.state().drainOutbox('jira', 10)).map((r) => r.id)).toEqual([first.id, second.id, unrelated.id, loose.id]);
});
it('parks a row: done with its error, out of the drain, no longer holding back its incident, listed', async () => {
  const incident = id();
  const first = outbox({ incidentId: incident, target: 'teams' });
  const second = outbox({ incidentId: incident, target: 'teams', createdAt: '2026-10-02T12:00:00.001Z', nextAttempt: '2026-10-02T12:00:00.001Z' });
  await f.state().enqueueOutbox(first);
  await f.state().enqueueOutbox(second);
  f.setTime(1);
  await f.state().deferOutbox(first.id, '2026-10-02T12:05:00.000Z', 'jira answered 500');
  expect(await f.state().drainOutbox('teams', 10)).toEqual([]);
  f.setTime(2000);
  await f.state().parkOutbox(first.id, 'gave up after 2 attempts: jira answered 500');
  await f.state().parkOutbox(first.id, 'a second park is ignored');
  expect((await f.state().drainOutbox('teams', 10)).map((r) => r.id)).toEqual([second.id]);
  const parked = await f.state().listParkedOutbox('teams', 10);
  expect(parked).toEqual([
    { ...first, attempts: 2, nextAttempt: '2026-10-02T12:05:00.000Z', lastError: 'gave up after 2 attempts: jira answered 500', doneAt: '2026-10-02T12:00:02.000Z' },
  ]);
  expect(parked.every(isParkedOutbox)).toBe(true);
});
it('ack clears a deferred error, so a sent row is never listed as parked', async () => {
  const row = outbox({ target: 'github' });
  await f.state().enqueueOutbox(row);
  await f.state().deferOutbox(row.id, epoch, 'jira answered 503');
  await f.state().ackOutbox([row.id]);
  await f.state().deferOutbox(row.id, epoch, 'ignored once done');
  expect(await f.state().listParkedOutbox('github', 10)).toEqual([]);
  expect(await f.state().drainOutbox('github', 10)).toEqual([]);
});
it('drops the undone rows of one batch key and target, a deferred one too, without parking them', async () => {
  const incident = id();
  const key = `field:${incident}:priority`;
  const first = outbox({ incidentId: incident, op: 'update-fields', batchKey: key });
  const deferred = outbox({ incidentId: incident, op: 'update-fields', batchKey: key, createdAt: '2026-10-02T12:00:00.001Z', nextAttempt: '2026-10-02T12:00:00.001Z' });
  const sent = outbox({ incidentId: incident, op: 'update-fields', batchKey: key, createdAt: '2026-10-02T11:59:00.000Z' });
  const otherField = outbox({ incidentId: incident, op: 'update-fields', batchKey: `field:${incident}:status`, createdAt: '2026-10-02T12:00:00.002Z', nextAttempt: '2026-10-02T12:00:00.002Z' });
  const otherTarget = outbox({ incidentId: incident, target: 'github', batchKey: key });
  for (const row of [first, deferred, sent, otherField, otherTarget]) await f.state().enqueueOutbox(row);
  await f.state().ackOutbox([sent.id]);
  f.setTime(5);
  await f.state().deferOutbox(deferred.id, '2026-10-02T12:05:00.000Z', 'jira answered 503');
  expect((await f.state().drainOutbox('jira', 10)).map((r) => r.id)).toEqual([first.id]);
  expect(await f.state().dropOutbox('jira', key)).toEqual([first.id, deferred.id]);
  expect(await f.state().dropOutbox('jira', key)).toEqual([]);
  expect((await f.state().drainOutbox('jira', 10)).map((r) => r.id)).toEqual([otherField.id]);
  expect((await f.state().drainOutbox('github', 10)).map((r) => r.id)).toEqual([otherTarget.id]);
  expect(await f.state().listParkedOutbox('jira', 10)).toEqual([]);
  await expect(f.state().dropOutbox('jira', '')).rejects.toThrow(RangeError);
});
