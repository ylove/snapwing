// InProcessWorkflow (#23): the WorkflowPort over the jobs and job_waits tables. Runs on the dialect
// SNAPWING_DB selects; the clock is injected through openState, so nothing here sleeps.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/contracts/jobs.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { isTimedOut, waitKeyString, waitTimeoutKey, type WaitKey } from '../../src/ports/workflow.ts';
import type { StateContext } from '../../src/state/context.ts';
import { StateStore } from '../../src/state/store.ts';
import {
  CronExpressionError,
  InProcessWorkflow,
  JobNotActiveError,
  MAX_RETRY_DELAY_MS,
  parseCron,
  retryDelayMs,
} from '../../src/workflow/inprocess/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const T0 = new Date('2026-10-01T12:07:00.000Z');
const MIN = 60_000;

interface FakeClock {
  now(): Date;
  advance(ms: number): void;
}

function fakeClock(start: Date): FakeClock {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    advance(ms) {
      t += ms;
    },
  };
}

function ctxOf(state: OpenedState): StateContext {
  if (!(state instanceof StateStore)) {
    throw new Error('expected a StateStore');
  }
  return state.ctx;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let tdb: TestDatabase;
let clock: FakeClock;
let state: OpenedState;
let wf: InProcessWorkflow;

beforeEach(async () => {
  tdb = await createTestDatabase();
  clock = fakeClock(T0);
  state = await tdb.open({ now: clock.now });
  wf = new InProcessWorkflow(state);
});

afterEach(async () => {
  await wf.stop();
  await tdb.drop();
});

async function jobRows(name?: string): Promise<{ id: string; state: string; retry_count: number; singleton_key: string | null }[]> {
  let q = ctxOf(state).db.selectFrom('jobs').select(['id', 'state', 'retry_count', 'singleton_key']).orderBy('id');
  if (name !== undefined) {
    q = q.where('name', '=', name);
  }
  return q.execute();
}

async function waitRows(): Promise<{ job_id: string; wait_key: string }[]> {
  return ctxOf(state).db.selectFrom('job_waits').select(['job_id', 'wait_key']).execute();
}

function recorder(): { jobs: Job[]; handler: (job: Job) => Promise<void> } {
  const jobs: Job[] = [];
  return {
    jobs,
    handler: async (job) => {
      jobs.push(job);
    },
  };
}

describe('start and work', () => {
  it('delivers a started job once and completes it', async () => {
    const r = recorder();
    wf.work('incident.process', r.handler);
    const { jobId } = await wf.start('incident.process', { incidentId: 'inc-1' }, {});
    await wf.drain();
    expect(r.jobs).toEqual([{ id: jobId, name: 'incident.process', data: { incidentId: 'inc-1' }, attempt: 1 }]);
    expect(await jobRows()).toMatchObject([{ id: jobId, state: 'completed' }]);
    await wf.drain();
    expect(r.jobs).toHaveLength(1);
  });

  it('stores undefined input as null and passes the singleton key through', async () => {
    const r = recorder();
    wf.work('reconcile', r.handler);
    await wf.start('reconcile', undefined, { singletonKey: 'reconcile:all' });
    await wf.drain();
    expect(r.jobs[0]).toMatchObject({ data: null, singletonKey: 'reconcile:all' });
  });

  it('leaves jobs without a worker queued', async () => {
    await wf.start('fixer.run', {}, {});
    await wf.drain();
    expect(await jobRows()).toMatchObject([{ state: 'created' }]);
  });

  it('refuses a handler for timer.wait-timeout, a second handler, and bad concurrency', () => {
    expect(() => wf.work('timer.wait-timeout', async () => undefined)).toThrow(/scheduler itself/);
    wf.work('fixer.run', async () => undefined);
    expect(() => wf.work('fixer.run', async () => undefined)).toThrow(/already registered/);
    expect(() => wf.work('merge.evaluate', async () => undefined, { concurrency: 0 })).toThrow(RangeError);
  });

  it('refuses the reserved cron: key prefix', async () => {
    await expect(wf.start('reconcile', {}, { singletonKey: 'cron:reconcile' })).rejects.toThrow(/reserved/);
  });
});

describe('singleton keys (B 5: rescheduling replaces)', () => {
  it('start with a queued singleton key returns the queued job and creates no second one', async () => {
    const a = await wf.start('incident.process', { n: 1 }, { singletonKey: 'incident:inc-1' });
    const b = await wf.start('incident.process', { n: 2 }, { singletonKey: 'incident:inc-1' });
    expect(b.jobId).toBe(a.jobId);
    expect(await jobRows()).toHaveLength(1);

    const r = recorder();
    wf.work('incident.process', r.handler);
    await wf.drain();
    expect(r.jobs.map((j) => j.data)).toEqual([{ n: 1 }]);

    // Once the first has run, the key is free again.
    const c = await wf.start('incident.process', { n: 3 }, { singletonKey: 'incident:inc-1' });
    expect(c.jobId).not.toBe(a.jobId);
  });

  it('concurrent starts with one key make one job', async () => {
    const ids = await Promise.all(Array.from({ length: 5 }, (_, n) => wf.start('incident.process', { n }, { singletonKey: 'incident:inc-2' })));
    expect(new Set(ids.map((r) => r.jobId)).size).toBe(1);
    expect(await jobRows()).toHaveLength(1);
  });

  it('schedule with an existing key replaces the run time and data, keeping the id', async () => {
    const r = recorder();
    wf.work('timer.stall', r.handler);
    const first = await wf.schedule('timer.stall', { v: 1 }, new Date(T0.getTime() + 15 * MIN), { singletonKey: 'stall:inc-1' });
    const second = await wf.schedule('timer.stall', { v: 2 }, new Date(T0.getTime() + 30 * MIN), { singletonKey: 'stall:inc-1' });
    expect(second.jobId).toBe(first.jobId);
    expect(await jobRows()).toHaveLength(1);

    clock.advance(15 * MIN);
    await wf.drain();
    expect(r.jobs).toHaveLength(0);

    clock.advance(15 * MIN);
    await wf.drain();
    expect(r.jobs).toMatchObject([{ id: first.jobId, data: { v: 2 } }]);
  });

  it('a scheduled job does not run before its time', async () => {
    const r = recorder();
    wf.work('timer.revert', r.handler);
    await wf.schedule('timer.revert', {}, new Date(T0.getTime() + 72 * 60 * MIN));
    clock.advance(72 * 60 * MIN - 1);
    await wf.drain();
    expect(r.jobs).toHaveLength(0);
    clock.advance(1);
    await wf.drain();
    expect(r.jobs).toHaveLength(1);
  });

  it('cancel removes a queued job by key', async () => {
    const r = recorder();
    wf.work('timer.heartbeat', r.handler);
    await wf.schedule('timer.heartbeat', {}, new Date(T0.getTime() + 10 * MIN), { singletonKey: 'heartbeat:inc-1' });
    await wf.cancel('heartbeat:inc-1');
    clock.advance(10 * MIN);
    await wf.drain();
    expect(r.jobs).toHaveLength(0);
    expect(await jobRows()).toMatchObject([{ state: 'cancelled' }]);
  });
});

describe('park, resume, and timeout (ADR 0012)', () => {
  const TAP: WaitKey = { kind: 'tap', eventId: 'evt-1' };

  /** A handler that parks on its first delivery and records every delivery. */
  function parker(waitingOn: WaitKey, timeoutAt?: Date): { jobs: Job[]; handler: (job: Job) => Promise<void> } {
    const jobs: Job[] = [];
    return {
      jobs,
      handler: async (job) => {
        jobs.push(job);
        if (job.resumed === undefined) {
          await wf.park(job.id, waitingOn, timeoutAt);
        }
      },
    };
  }

  it('a parked job waits for resume, then is re-delivered with the result and the same id and attempt', async () => {
    const p = parker(TAP);
    wf.work('incident.process', p.handler);
    const { jobId } = await wf.start('incident.process', { incidentId: 'inc-1' }, {});
    await wf.drain();
    expect(await jobRows()).toMatchObject([{ id: jobId, state: 'parked' }]);
    expect(await waitRows()).toEqual([{ job_id: jobId, wait_key: waitKeyString(TAP) }]);

    expect(await wf.resume(TAP, { choice: 'let-agent-take' })).toEqual({ resumed: 1 });
    await wf.drain();
    expect(p.jobs).toHaveLength(2);
    expect(p.jobs[1]).toEqual({
      id: jobId,
      name: 'incident.process',
      data: { incidentId: 'inc-1' },
      attempt: 1,
      resumed: { result: { choice: 'let-agent-take' } },
    });
    expect(await jobRows()).toMatchObject([{ id: jobId, state: 'completed' }]);
    expect(await waitRows()).toEqual([]);
  });

  it('a second resume is a no-op', async () => {
    const p = parker(TAP);
    wf.work('incident.process', p.handler);
    await wf.start('incident.process', {}, {});
    await wf.drain();
    expect(await wf.resume(TAP, 'a')).toEqual({ resumed: 1 });
    expect(await wf.resume(TAP, 'b')).toEqual({ resumed: 0 });
    await wf.drain();
    expect(p.jobs.map((j) => j.resumed)).toEqual([undefined, { result: 'a' }]);
  });

  it('a resume with no parked job is not buffered', async () => {
    expect(await wf.resume(TAP, 'early')).toEqual({ resumed: 0 });
    const p = parker(TAP);
    wf.work('incident.process', p.handler);
    await wf.start('incident.process', {}, {});
    await wf.drain();
    expect(p.jobs).toHaveLength(1);
    expect(await jobRows('incident.process')).toMatchObject([{ state: 'parked' }]);
  });

  it('resumes every job waiting on one key', async () => {
    const key: WaitKey = { kind: 'ci', prId: 'acme/web#7' };
    const p = parker(key);
    wf.work('merge.evaluate', p.handler, { concurrency: 3 });
    await wf.start('merge.evaluate', { n: 1 }, {});
    await wf.start('merge.evaluate', { n: 2 }, {});
    await wf.drain();
    expect(await wf.resume(key, 'green')).toEqual({ resumed: 2 });
    await wf.drain();
    expect(p.jobs.filter((j) => j.resumed !== undefined)).toHaveLength(2);
  });

  it('a timeout re-delivers the job with { timedOut: true }, and a later resume is a no-op', async () => {
    const timeoutAt = new Date(T0.getTime() + 24 * 60 * MIN);
    const p = parker(TAP, timeoutAt);
    wf.work('incident.process', p.handler);
    const { jobId } = await wf.start('incident.process', {}, {});
    await wf.drain();
    expect(await jobRows('timer.wait-timeout')).toMatchObject([{ state: 'created', singleton_key: waitTimeoutKey(jobId, TAP) }]);

    clock.advance(24 * 60 * MIN - 1);
    await wf.drain();
    expect(p.jobs).toHaveLength(1);

    clock.advance(1);
    await wf.drain();
    expect(p.jobs).toHaveLength(2);
    expect(p.jobs[1]?.id).toBe(jobId);
    expect(isTimedOut(p.jobs[1]?.resumed?.result)).toBe(true);
    expect(await wf.resume(TAP, 'late')).toEqual({ resumed: 0 });
    await wf.drain();
    expect(p.jobs).toHaveLength(2);
  });

  it('a resume cancels the pending timeout, and a timeout that fires anyway is a no-op', async () => {
    const key: WaitKey = { kind: 'children', parentId: 'inc-parent' };
    const timeoutAt = new Date(T0.getTime() + 60 * MIN);
    const p = parker(key, timeoutAt);
    wf.work('incident.process', p.handler);
    const { jobId } = await wf.start('incident.process', {}, {});
    await wf.drain();
    expect(await wf.resume(key, 'done')).toEqual({ resumed: 1 });
    expect(await jobRows('timer.wait-timeout')).toMatchObject([{ state: 'cancelled' }]);

    // A stray timer for the same wait (as if the cancel had been lost) delivers nothing.
    await wf.schedule('timer.wait-timeout', { jobId, waitKey: waitKeyString(key) }, timeoutAt);
    clock.advance(60 * MIN);
    await wf.drain();
    expect(p.jobs.map((j) => j.resumed)).toEqual([undefined, { result: 'done' }]);
    expect(await jobRows('incident.process')).toMatchObject([{ state: 'completed' }]);
  });

  it('park refuses a job that is not running', async () => {
    const { jobId } = await wf.start('incident.process', {}, {});
    await expect(wf.park(jobId, TAP)).rejects.toBeInstanceOf(JobNotActiveError);
    expect(await waitRows()).toEqual([]);
  });

  it('cancel by key drops a parked job and its wait row', async () => {
    const p = parker(TAP);
    wf.work('incident.process', p.handler);
    await wf.start('incident.process', {}, { singletonKey: 'incident:inc-9' });
    await wf.drain();
    await wf.cancel('incident:inc-9');
    expect(await waitRows()).toEqual([]);
    expect(await wf.resume(TAP, 'x')).toEqual({ resumed: 0 });
  });
});

describe('durability across closing and reopening the database', () => {
  const TAP: WaitKey = { kind: 'tap', eventId: 'evt-durable' };

  async function parkAndClose(timeoutAt?: Date): Promise<string> {
    wf.work('incident.process', async (job) => {
      if (job.resumed === undefined) {
        await wf.park(job.id, TAP, timeoutAt);
      }
    });
    const { jobId } = await wf.start('incident.process', { incidentId: 'inc-1' }, {});
    await wf.drain();
    await wf.stop();
    await state.close();
    return jobId;
  }

  async function reopen(): Promise<{ jobs: Job[] }> {
    state = await tdb.open({ now: clock.now });
    wf = new InProcessWorkflow(state);
    const r = recorder();
    wf.work('incident.process', r.handler);
    return r;
  }

  it('a parked job survives a reopen and resumes on the new handle', async () => {
    const jobId = await parkAndClose();
    const r = await reopen();
    await wf.recover();
    await wf.drain();
    expect(r.jobs).toHaveLength(0);
    expect(await wf.resume(TAP, 'after-restart')).toEqual({ resumed: 1 });
    await wf.drain();
    expect(r.jobs).toMatchObject([{ id: jobId, data: { incidentId: 'inc-1' }, resumed: { result: 'after-restart' } }]);
  });

  it('a timeout that passes while closed fires after the reopen', async () => {
    const jobId = await parkAndClose(new Date(T0.getTime() + 30 * MIN));
    clock.advance(45 * MIN);
    const r = await reopen();
    await wf.drain();
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]?.id).toBe(jobId);
    expect(isTimedOut(r.jobs[0]?.resumed?.result)).toBe(true);
  });

  it('recover times out an overdue parked job whose timer job is gone', async () => {
    const jobId = await parkAndClose(new Date(T0.getTime() + 30 * MIN));
    clock.advance(45 * MIN);
    const r = await reopen();
    await wf.cancel(waitTimeoutKey(jobId, TAP));
    expect(await wf.recover()).toEqual({ requeued: 0, timedOut: 1 });
    await wf.drain();
    expect(isTimedOut(r.jobs[0]?.resumed?.result)).toBe(true);
  });

  it('recover queues again a job left active by a crashed process', async () => {
    const { jobId } = await wf.start('fixer.run', { n: 1 }, {});
    await ctxOf(state).db.updateTable('jobs').set({ state: 'active' }).where('id', '=', jobId).execute();
    await state.close();
    state = await tdb.open({ now: clock.now });
    wf = new InProcessWorkflow(state);
    const r = recorder();
    wf.work('fixer.run', r.handler);
    expect(await wf.recover()).toEqual({ requeued: 1, timedOut: 0 });
    await wf.drain();
    expect(r.jobs).toMatchObject([{ id: jobId, attempt: 1 }]);
  });
});

describe('retries', () => {
  it('retries with exponential backoff up to retryLimit, then fails', async () => {
    const attempts: number[] = [];
    wf.work('fixer.run', async (job) => {
      attempts.push(job.attempt);
      throw new Error(`boom ${job.attempt}`);
    });
    const { jobId } = await wf.start('fixer.run', {}, { retryLimit: 3, retryBackoff: true });
    await wf.drain();
    expect(attempts).toEqual([1]);

    for (const [delay, expected] of [
      [1_000, [1, 2]],
      [2_000, [1, 2, 3]],
      [4_000, [1, 2, 3, 4]],
    ] as const) {
      clock.advance(delay - 1);
      await wf.drain();
      expect(attempts).toHaveLength(expected.length - 1);
      clock.advance(1);
      await wf.drain();
      expect(attempts).toEqual(expected);
    }

    clock.advance(MAX_RETRY_DELAY_MS);
    await wf.drain();
    expect(attempts).toEqual([1, 2, 3, 4]);
    const row = await ctxOf(state).db.selectFrom('jobs').select(['state', 'last_error']).where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(row).toEqual({ state: 'failed', last_error: 'boom 4' });
  });

  it('retries after a fixed delay without backoff, and stops when the handler succeeds', async () => {
    const attempts: number[] = [];
    wf.work('fixer.run', async (job) => {
      attempts.push(job.attempt);
      if (job.attempt < 3) {
        throw new Error('flaky');
      }
    });
    await wf.start('fixer.run', {}, { retryLimit: 5 });
    for (let i = 0; i < 4; i++) {
      await wf.drain();
      clock.advance(1_000);
    }
    expect(attempts).toEqual([1, 2, 3]);
    expect(await jobRows()).toMatchObject([{ state: 'completed', retry_count: 2 }]);
  });

  it('does not retry by default', async () => {
    const errors: unknown[] = [];
    wf = new InProcessWorkflow(state, { onError: (e) => errors.push(e) });
    wf.work('fixer.run', async () => {
      throw new Error('once');
    });
    await wf.start('fixer.run', {}, {});
    await wf.drain();
    clock.advance(MAX_RETRY_DELAY_MS);
    await wf.drain();
    expect(errors).toHaveLength(1);
    expect(await jobRows()).toMatchObject([{ state: 'failed' }]);
  });

  it('a retried resumed delivery keeps its resume result', async () => {
    const TAP: WaitKey = { kind: 'tap', eventId: 'evt-retry' };
    const seen: Job[] = [];
    wf.work('incident.process', async (job) => {
      seen.push(job);
      if (job.resumed === undefined) {
        await wf.park(job.id, TAP);
        return;
      }
      if (job.attempt === 1) {
        throw new Error('transient');
      }
    });
    await wf.start('incident.process', {}, { retryLimit: 1 });
    await wf.drain();
    await wf.resume(TAP, 'ok');
    await wf.drain();
    clock.advance(1_000);
    await wf.drain();
    expect(seen.map((j) => [j.attempt, j.resumed])).toEqual([
      [1, undefined],
      [1, { result: 'ok' }],
      [2, { result: 'ok' }],
    ]);
  });

  it('retryDelayMs doubles from one second and caps at an hour', () => {
    expect([0, 1, 2, 3].map((n) => retryDelayMs(n, true))).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(retryDelayMs(40, true)).toBe(MAX_RETRY_DELAY_MS);
    expect(retryDelayMs(5, false)).toBe(1_000);
  });
});

describe('cron', () => {
  it('runs a job on the expression, once per fire, with a fake clock', async () => {
    const r = recorder();
    wf.work('reconcile', r.handler);
    await wf.cron('reconcile', '*/15 * * * *', { scope: 'all' });
    await wf.drain();
    expect(r.jobs).toHaveLength(0);

    clock.advance(8 * MIN - 1); // 12:14:59.999
    await wf.drain();
    expect(r.jobs).toHaveLength(0);
    clock.advance(1); // 12:15
    await wf.drain();
    expect(r.jobs).toMatchObject([{ name: 'reconcile', data: { scope: 'all' }, attempt: 1 }]);
    await wf.drain();
    expect(r.jobs).toHaveLength(1);

    clock.advance(15 * MIN); // 12:30
    await wf.drain();
    expect(r.jobs).toHaveLength(2);

    // Missed fires while nothing polled collapse into one.
    clock.advance(3 * 60 * MIN);
    await wf.drain();
    expect(r.jobs).toHaveLength(3);
  });

  it('calling cron again replaces the expression and input', async () => {
    const r = recorder();
    wf.work('reconcile', r.handler);
    await wf.cron('reconcile', '0 * * * *', { v: 1 });
    await wf.cron('reconcile', '30 12 * * *', { v: 2 });
    clock.advance(23 * MIN); // 12:30
    await wf.drain();
    expect(r.jobs.map((j) => j.data)).toEqual([{ v: 2 }]);
    clock.advance(30 * MIN); // 13:00, the old hourly expression would fire here
    await wf.drain();
    expect(r.jobs).toHaveLength(1);
  });

  it('enqueues even with no worker registered, and the schedule survives a reopen', async () => {
    await wf.cron('reconcile', '@hourly');
    await state.close();
    state = await tdb.open({ now: clock.now });
    wf = new InProcessWorkflow(state);
    clock.advance(53 * MIN); // 13:00
    await wf.drain();
    expect(await jobRows('reconcile')).toMatchObject([{ state: 'created' }]);
    const r = recorder();
    wf.work('reconcile', r.handler);
    await wf.drain();
    expect(r.jobs).toMatchObject([{ data: null }]);
  });

  it('rejects a bad expression', async () => {
    await expect(wf.cron('reconcile', 'every minute')).rejects.toBeInstanceOf(CronExpressionError);
  });
});

describe('concurrency', () => {
  it('work(name, handler, { concurrency }) never runs more than that many at once', async () => {
    let running = 0;
    let peak = 0;
    let open = false;
    const gates: Deferred[] = [];
    wf.work(
      'fixer.run',
      async () => {
        running++;
        peak = Math.max(peak, running);
        if (!open) {
          const gate = deferred();
          gates.push(gate);
          await gate.promise;
        }
        running--;
      },
      { concurrency: 2 },
    );
    for (let n = 0; n < 5; n++) {
      await wf.start('fixer.run', { n }, {});
    }
    expect(await wf.tick()).toBe(2);
    expect(await wf.tick()).toBe(0);
    expect(running).toBe(2);

    // Finishing one frees exactly one slot.
    gates.shift()?.resolve();
    let started = 0;
    for (let i = 0; i < 100 && started === 0; i++) {
      await new Promise((r) => setImmediate(r));
      started = await wf.tick();
    }
    expect(started).toBe(1);
    expect(running).toBe(2);

    open = true;
    gates.splice(0).forEach((g) => g.resolve());
    await wf.drain();
    expect(peak).toBe(2);
    expect((await jobRows()).map((j) => j.state)).toEqual(Array(5).fill('completed'));
  });

  it('defaults to one at a time', async () => {
    let running = 0;
    let peak = 0;
    wf.work('merge.evaluate', async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setImmediate(r));
      running--;
    });
    for (let n = 0; n < 3; n++) {
      await wf.start('merge.evaluate', { n }, {});
    }
    expect(await wf.tick()).toBe(1);
    await wf.drain();
    expect(peak).toBe(1);
    expect((await jobRows()).map((j) => j.state)).toEqual(['completed', 'completed', 'completed']);
  });
});

describe('poll loop', () => {
  it('startPolling runs due jobs without manual ticks, and stop waits for handlers', async () => {
    wf = new InProcessWorkflow(state, { pollIntervalMs: 5 });
    const done = deferred();
    wf.work('reconcile', async () => {
      done.resolve();
    });
    await wf.start('reconcile', {}, {});
    await wf.startPolling();
    await done.promise;
    await wf.stop();
    expect(await jobRows()).toMatchObject([{ state: 'completed' }]);
  });
});

describe('parseCron', () => {
  const at = (iso: string): Date => new Date(iso);
  const next = (expr: string, after: string): string => parseCron(expr).next(at(after)).toISOString();

  it.each([
    ['* * * * *', '2026-10-01T12:07:30.000Z', '2026-10-01T12:08:00.000Z'],
    ['*/15 * * * *', '2026-10-01T12:15:00.000Z', '2026-10-01T12:30:00.000Z'],
    ['0 9 * * MON-FRI', '2026-10-02T09:00:00.000Z', '2026-10-05T09:00:00.000Z'],
    ['0 0 1 jan *', '2026-10-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
    ['30 2 * * 7', '2026-10-01T00:00:00.000Z', '2026-10-04T02:30:00.000Z'],
    ['0 0 29 2 *', '2026-10-01T00:00:00.000Z', '2028-02-29T00:00:00.000Z'],
    ['5,10-12 3 * * *', '2026-10-01T03:10:00.000Z', '2026-10-01T03:11:00.000Z'],
    ['0 12 13 * 5', '2026-10-01T00:00:00.000Z', '2026-10-02T12:00:00.000Z'],
    ['@daily', '2026-10-01T12:07:00.000Z', '2026-10-02T00:00:00.000Z'],
    ['@weekly', '2026-10-01T12:07:00.000Z', '2026-10-04T00:00:00.000Z'],
    ['0 0 * 12 *', '2026-12-31T23:59:00.000Z', '2027-12-01T00:00:00.000Z'],
  ])('%s after %s is %s', (expr, after, expected) => {
    expect(next(expr, after)).toBe(expected);
  });

  it.each(['', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '5-1 * * * *', '*/0 * * * *', 'a * * * *', '0 0 31 2 *'])(
    'rejects %j',
    (expr) => {
      expect(() => parseCron(expr)).toThrow(CronExpressionError);
    },
  );
});
