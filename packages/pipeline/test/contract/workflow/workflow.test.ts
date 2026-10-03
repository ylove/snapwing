// Independent observable contracts: B 1, B 5, ADR 0012, and shared scheduling policy.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { timerKey, type Job } from '../../../src/contracts/jobs.ts';
import { isTimedOut, type WaitKey } from '../../../src/ports/workflow.ts';
import { cronKey, RETRY_DELAY_MS } from '../../../src/workflow/inprocess/policy.ts';
import { createHarness, type Harness } from './harness.ts';

let h: Harness;
const key = timerKey('stall', { incidentId: 'fake-incident' });
const tap: WaitKey = { kind: 'tap', eventId: 'fake-event' };
const later = (ms: number): Date => new Date(h.now().getTime() + ms);

beforeEach(async () => { h = await createHarness(); });
afterEach(async () => { if (h) await h.close(); });

// Wall-clock (or fake-clock) time of each delivery. Under load a job scheduled a few seconds out can
// legitimately be due before an assertion runs, so "not delivered before due" is checked per delivery
// against its due time instead of assuming nothing has arrived yet.
const deliveredAt = new WeakMap<Job, number>();

function record(): Job[] {
  const jobs: Job[] = [];
  h.port.work('timer.stall', async (job) => {
    deliveredAt.set(job, h.now().getTime());
    jobs.push(job);
  });
  return jobs;
}

function deliveredEarly(jobs: Job[], due: Date): Job[] {
  return jobs.filter((job) => (deliveredAt.get(job) ?? Number.NEGATIVE_INFINITY) < due.getTime());
}

async function parked(timeout = false): Promise<Job[]> {
  const jobs: Job[] = [];
  h.port.work('incident.process', async (job) => {
    if (!job.resumed) await h.port.park(job.id, tap, timeout ? later(3_000) : undefined);
    jobs.push(job);
  });
  await h.port.start('incident.process', { incidentId: 'fake-incident' }, { singletonKey: key });
  await h.until(() => jobs.length === 1);
  return jobs;
}

describe('WorkflowPort durable scheduling', () => {
  it('singleton dedupes a second start', async () => {
    const jobs = record();
    const first = await h.port.start('timer.stall', { version: 1 }, { singletonKey: key });
    expect(await h.port.start('timer.stall', { version: 2 }, { singletonKey: key })).toEqual(first);
    await h.until(() => jobs.length > 0);
    await h.quiet();
    expect(jobs.map((job) => job.data)).toEqual([{ version: 1 }]);
  }, 30_000);

  it('different singleton keys both run', async () => {
    const jobs = record();
    for (const incidentId of ['fake-a', 'fake-b']) {
      await h.port.start('timer.stall', incidentId, { singletonKey: timerKey('stall', { incidentId }) });
    }
    await h.until(() => jobs.length === 2);
    expect(jobs.map((job) => job.data).sort()).toEqual(['fake-a', 'fake-b']);
  }, 30_000);

  it('start keeps the queued schedule and its original data', async () => {
    const jobs = record();
    const due = later(3_000);
    const first = await h.port.schedule('timer.stall', 'original', due, { singletonKey: key });
    expect(await h.port.start('timer.stall', 'ignored', { singletonKey: key })).toEqual(first);
    await h.quiet();
    expect(deliveredEarly(jobs, due)).toEqual([]);
    await h.advanceTo(due);
    await h.until(() => jobs.length > 0);
    expect(jobs.map((job) => job.data)).toEqual(['original']);
  }, 30_000);

  it('schedule replaces a queued job and postpones its delivery', async () => {
    const jobs = record();
    await h.port.schedule('timer.stall', 'old', later(1_000), { singletonKey: key });
    const due = later(3_000);
    await h.port.schedule('timer.stall', 'replacement', due, { singletonKey: key });
    await h.quiet();
    expect(deliveredEarly(jobs, due)).toEqual([]);
    await h.advanceTo(due);
    await h.until(() => jobs.length > 0);
    await h.quiet();
    expect(jobs.map((job) => job.data)).toEqual(['replacement']);
  }, 30_000);

  it('schedule creates a new key and respects its due time', async () => {
    const jobs = record();
    const due = later(3_000);
    await h.port.schedule('timer.stall', 'new', due, { singletonKey: key });
    await h.quiet();
    expect(deliveredEarly(jobs, due)).toEqual([]);
    await h.advanceTo(due);
    await h.until(() => jobs.length > 0);
    expect(jobs.map((job) => job.data)).toEqual(['new']);
  }, 30_000);

  it('cancel prevents queued delivery', async () => {
    const jobs = record();
    await h.port.schedule('timer.stall', 'cancelled', later(500), { singletonKey: key });
    await h.port.cancel(key);
    await h.quiet();
    expect(jobs).toEqual([]);
  }, 30_000);

  it('cancel removes a parked wait and its timeout', async () => {
    const jobs = await parked(true);
    await h.port.cancel(key);
    expect(await h.port.resume(tap, 'late')).toEqual({ resumed: 0 });
    await h.advance(4_000);
    await h.quiet();
    expect(jobs).toHaveLength(1);
  }, 30_000);
});

describe('WorkflowPort waits (ADR 0012)', () => {
  it('park then resume delivers data with unchanged logical identity and attempt', async () => {
    const jobs = await parked();
    expect(await h.port.resume(tap, { choice: 'ticket-only' })).toEqual({ resumed: 1 });
    await h.until(() => jobs.length === 2);
    expect(jobs[1]).toEqual({ ...jobs[0], resumed: { result: { choice: 'ticket-only' } } });
  }, 30_000);

  it('timeout delivers the timedOut result', async () => {
    const jobs = await parked(true);
    await h.advance(3_100);
    await h.until(() => jobs.length === 2);
    expect(isTimedOut(jobs[1]?.resumed?.result)).toBe(true);
    expect(jobs[1]).toEqual({ ...jobs[0], resumed: { result: { timedOut: true } } });
  }, 30_000);

  it('resume wins and the later timeout does nothing', async () => {
    const jobs = await parked(true);
    expect(await h.port.resume(tap, 'winner')).toEqual({ resumed: 1 });
    await h.until(() => jobs.length === 2);
    await h.advance(4_000);
    await h.quiet();
    expect(jobs.map((job) => job.resumed)).toEqual([undefined, { result: 'winner' }]);
  }, 30_000);

  it('timeout wins and a late resume returns zero', async () => {
    const jobs = await parked(true);
    await h.advance(3_100);
    await h.until(() => jobs.length === 2);
    expect(await h.port.resume(tap, 'late')).toEqual({ resumed: 0 });
    await h.quiet();
    expect(jobs).toHaveLength(2);
    expect(isTimedOut(jobs[1]?.resumed?.result)).toBe(true);
  }, 30_000);

  it('double resume claims the wait only once', async () => {
    const jobs = await parked();
    expect(await h.port.resume(tap, 'first')).toEqual({ resumed: 1 });
    expect(await h.port.resume(tap, 'second')).toEqual({ resumed: 0 });
    await h.until(() => jobs.length === 2);
    await h.quiet();
    expect(jobs.map((job) => job.resumed)).toEqual([undefined, { result: 'first' }]);
  }, 30_000);

  it('resume before park is not buffered', async () => {
    expect(await h.port.resume(tap, 'early')).toEqual({ resumed: 0 });
    const jobs = await parked();
    await h.quiet();
    expect(jobs).toHaveLength(1);
    expect(await h.port.resume(tap, 'after-park')).toEqual({ resumed: 1 });
    await h.until(() => jobs.length === 2);
    expect(jobs[1]?.resumed?.result).toBe('after-park');
  }, 30_000);

  it('restart while parked preserves the wait for resume', async () => {
    const jobs = await parked(true);
    await h.reopen();
    h.port.work('incident.process', async (job) => { jobs.push(job); });
    expect(await h.port.resume(tap, 'after-restart')).toEqual({ resumed: 1 });
    await h.until(() => jobs.length === 2);
    expect(jobs[1]).toEqual({ ...jobs[0], resumed: { result: 'after-restart' } });
    await h.advance(4_000);
    await h.quiet();
    expect(jobs).toHaveLength(2);
  }, 30_000);

  it('restart while parked preserves the pending timeout', async () => {
    const jobs = await parked(true);
    await h.reopen();
    h.port.work('incident.process', async (job) => { jobs.push(job); });
    await h.advance(3_100);
    await h.until(() => jobs.length === 2);
    expect(jobs[1]).toEqual({ ...jobs[0], resumed: { result: { timedOut: true } } });
    expect(await h.port.resume(tap, 'late')).toEqual({ resumed: 0 });
  }, 30_000);
});

describe('WorkflowPort execution policy', () => {
  it('default retry limit zero delivers a failing handler only once', async () => {
    const jobs: Job[] = [];
    h.port.work('fixer.run', async (job) => { jobs.push(job); throw new Error('fake failure'); });
    await h.port.start('fixer.run', {}, {});
    await h.until(() => jobs.length > 0);
    await h.advance(3 * RETRY_DELAY_MS);
    await h.quiet();
    expect(jobs.map((job) => job.attempt)).toEqual([1]);
  }, 30_000);

  it('retryLimit counts retries after the original delivery and then stops', async () => {
    const jobs: Job[] = [];
    h.port.work('fixer.run', async (job) => { jobs.push(job); throw new Error('fake failure'); });
    const { jobId } = await h.port.start('fixer.run', { fake: true }, { retryLimit: 2 });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await h.deliveryWithin(() => jobs.length >= attempt, RETRY_DELAY_MS);
    }
    await h.advance(2 * RETRY_DELAY_MS);
    await h.quiet();
    expect(jobs.map((job) => [job.id, job.attempt, job.data])).toEqual(
      [1, 2, 3].map((attempt) => [jobId, attempt, { fake: true }]),
    );
  }, 30_000);

  it('retry backoff respects doubling minimum delays', async () => {
    const times: number[] = [];
    h.port.work('fixer.run', async () => { times.push(h.now().getTime()); throw new Error('fake failure'); });
    await h.port.start('fixer.run', {}, { retryLimit: 2, retryBackoff: true });
    await h.until(() => times.length === 1);
    for (const [count, delay] of [[2, RETRY_DELAY_MS], [3, 2 * RETRY_DELAY_MS]] as const) {
      await h.deliveryWithin(() => times.length >= count, delay);
      expect((times[count - 1] ?? 0) - (times[count - 2] ?? 0)).toBeGreaterThanOrEqual(delay);
    }
    await h.advance(8 * RETRY_DELAY_MS);
    expect(times).toHaveLength(3);
  }, 30_000);

  it('concurrency one serializes asynchronous handlers', async () => {
    let active = 0;
    let peak = 0;
    let completed = 0;
    h.port.work('fixer.run', async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active--;
      completed++;
    }, { concurrency: 1 });
    for (let i = 0; i < 3; i++) await h.port.start('fixer.run', { i }, {});
    await h.until(() => completed === 3);
    expect(peak).toBe(1);
  }, 30_000);

  it('cron key is reserved for both start and schedule', async () => {
    const singletonKey = cronKey('reconcile');
    await expect(h.port.start('reconcile', {}, { singletonKey })).rejects.toThrow();
    await expect(h.port.schedule('reconcile', {}, later(1_000), { singletonKey })).rejects.toThrow();
  }, 30_000);

  it('cron registration is unique and repeats on schedule', async () => {
    const jobs: Job[] = [];
    h.port.work('reconcile', async (job) => { jobs.push(job); });
    await h.port.cron('reconcile', '* * * * *', { version: 1 });
    await h.port.cron('reconcile', '* * * * *', { version: 2 });
    await h.pump();
    for (let count = 1; count <= 2; count++) {
      const untilNextMinute = 60_000 - h.now().getTime() % 60_000;
      await h.deliveryWithin(() => jobs.length >= count, untilNextMinute);
    }
    // Cron keeps running on wall time. Additional fires are valid, including ones
    // observed during polling; registration replacement must apply to every fire.
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    expect(jobs.map((job) => job.data)).toEqual(jobs.map(() => ({ version: 2 })));
    expect(new Set(jobs.map((job) => job.id)).size).toBe(jobs.length);
  }, 180_000);
});
