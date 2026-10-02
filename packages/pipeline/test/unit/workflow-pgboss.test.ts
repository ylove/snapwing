// PgBossWorkflow (#24): WorkflowPort on pg-boss in the state database (B 2, B 5, ADR 0012).
// Postgres only: the suite skips on the SQLite leg. pg-boss polls on a real clock, so tests poll
// for effects with `until` instead of sleeping for fixed times.

import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Job, JobName } from '../../src/contracts/jobs.ts';
import { isTimedOut, waitKeyString, waitTimeoutKey, type WaitKey } from '../../src/ports/workflow.ts';
import type { StateContext } from '../../src/state/context.ts';
import { StateStore } from '../../src/state/store.ts';
import { CronExpressionError } from '../../src/workflow/inprocess/cron.ts';
import { cronJobId, decodeEnvelope, JobNotActiveError, PgBossWorkflow, type PgBossWorkflowOptions } from '../../src/workflow/pgboss/index.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../helpers/db.ts';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

interface Row {
  id: string;
  name: string;
  state: string;
  data: unknown;
  singleton_key: string | null;
  start_after: Date;
  retry_backoff: boolean;
  retry_limit: number;
}

async function until<T>(probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('until: timed out');
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

// pg-boss backoff (retryDelay 0 -> 1 s base): the delay before retry n is 2^n/2 * (1 + random) s, so at
// most 2 s then 4 s, and each retry is picked up on the next poll (0.5 s here). Three attempts therefore
// finish within 6 s + 3 polls; the rest of the bound is slack for a loaded machine.
const RETRY_BOUND_MS = 2_000 + 4_000 + 3 * 500 + 12_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(TEST_DIALECT !== 'postgres')('PgBossWorkflow', () => {
  let tdb: TestDatabase;
  let state: StateStore;
  let ctx: StateContext;
  let bossSchema: string;
  const opened: PgBossWorkflow[] = [];

  const open = (options: PgBossWorkflowOptions = {}): PgBossWorkflow => {
    const wf = new PgBossWorkflow(state, { schema: bossSchema, pollingIntervalSeconds: 0.5, cronIntervalSeconds: 1, ...options });
    opened.push(wf);
    return wf;
  };

  /** Every pg-boss row of our queues, oldest first. */
  const rows = async (where: { name?: JobName; singletonKey?: string } = {}): Promise<Row[]> => {
    const job = sql.id(bossSchema, 'job');
    const { rows: out } = await sql<Row>`
      select id, name, state, data, singleton_key, start_after, retry_backoff, retry_limit from ${job}
      where (${where.name ?? null}::text is null or name = ${where.name ?? null})
        and (${where.singletonKey ?? null}::text is null or singleton_key = ${where.singletonKey ?? null})
      order by created_on
    `.execute(ctx.db);
    return out;
  };

  const waits = (): Promise<{ job_id: string; wait_key: string }[]> => ctx.db.selectFrom('job_waits').select(['job_id', 'wait_key']).execute();

  // One database for the file, emptied between tests: creating and dropping a schema per test races
  // with Kysely's migration introspection in parallel test files (it scans every schema).
  beforeAll(async () => {
    tdb = await createTestDatabase();
    const s = await tdb.open();
    if (!(s instanceof StateStore)) {
      throw new Error('expected a StateStore');
    }
    state = s;
    ctx = s.ctx;
    // pg-boss shares the test's schema (its table names do not clash with the state tables).
    bossSchema = tdb.name;
    const boot = new PgBossWorkflow(state, { schema: bossSchema });
    await boot.recover();
    await boot.stop();
  });

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((wf) => wf.stop(2_000)));
    await sql`delete from ${sql.id(bossSchema, 'job')}`.execute(ctx.db);
    await sql`delete from ${sql.id(bossSchema, 'schedule')}`.execute(ctx.db);
    await ctx.db.deleteFrom('job_waits').execute();
    await ctx.db.deleteFrom('workspaces').execute();
  });

  afterAll(async () => {
    await tdb.drop();
  });

  it('needs the postgres dialect', () => {
    expect(() => new PgBossWorkflow({ ...ctx, dialect: 'sqlite' })).toThrow(/postgres/);
  });

  it('delivers a started job with its logical ULID id, data, attempt 1, and singleton key', async () => {
    const wf = open();
    const seen: Job[] = [];
    wf.work('incident.process', async (job) => {
      seen.push(job);
    });
    await wf.startPolling();
    const { jobId } = await wf.start('incident.process', { incidentId: 'inc-1' }, { singletonKey: 'process:inc-1' });
    const { jobId: plain } = await wf.start('incident.process', undefined, {});
    expect(jobId).toMatch(ULID);
    await until(() => seen.length === 2);
    const byId = new Map(seen.map((j) => [j.id, j]));
    expect(byId.get(jobId)).toEqual({ id: jobId, name: 'incident.process', data: { incidentId: 'inc-1' }, attempt: 1, singletonKey: 'process:inc-1' });
    expect(byId.get(plain)).toEqual({ id: plain, name: 'incident.process', data: null, attempt: 1 });
    await until(async () => (await rows()).every((r) => r.state === 'completed'));
  });

  describe('singleton keys (B 5; same semantics as the in-process scheduler)', () => {
    it('start with a queued key returns that job and creates no second one', async () => {
      const wf = open();
      const a = await wf.start('incident.process', { n: 1 }, { singletonKey: 'k1' });
      const b = await wf.start('incident.process', { n: 2 }, { singletonKey: 'k1' });
      const c = await wf.start('merge.evaluate', { n: 3 }, { singletonKey: 'k1' });
      const d = await wf.start('incident.process', { n: 4 }, { singletonKey: 'k2' });
      expect(b.jobId).toBe(a.jobId);
      expect(c.jobId).toBe(a.jobId);
      expect(d.jobId).not.toBe(a.jobId);
      const k1 = await rows({ singletonKey: 'k1' });
      expect(k1).toHaveLength(1);
      expect(decodeEnvelope(k1[0]?.data).data).toEqual({ n: 1 });
    });

    it('a retrying job blocks a new start with its key (the pg-boss singletonKey trap)', async () => {
      const wf = open();
      let calls = 0;
      wf.work('incident.process', async () => {
        calls++;
        if (calls === 1) {
          throw new Error('first attempt fails');
        }
      });
      await wf.startPolling();
      const first = await wf.start('incident.process', {}, { singletonKey: 'trap', retryLimit: 1, retryBackoff: true });
      await until(async () => (await rows({ singletonKey: 'trap' }))[0]?.state === 'retry');
      const again = await wf.start('incident.process', {}, { singletonKey: 'trap' });
      expect(again.jobId).toBe(first.jobId);
      expect(await rows({ singletonKey: 'trap' })).toHaveLength(1);
      await until(async () => (await rows({ singletonKey: 'trap' }))[0]?.state === 'completed');
      const later = await wf.start('incident.process', {}, { singletonKey: 'trap' });
      expect(later.jobId).not.toBe(first.jobId);
    });

    it('schedule with a queued key replaces the run time, name, and data, keeping the job id', async () => {
      const wf = open();
      const key = 'stall:inc-1';
      const t1 = new Date(Date.now() + 60 * 60_000);
      const t2 = new Date(Date.now() + 2 * 60 * 60_000);
      const a = await wf.schedule('timer.stall', { n: 1 }, t1, { singletonKey: key });
      const b = await wf.schedule('timer.stall', { n: 2 }, t2, { singletonKey: key });
      expect(b.jobId).toBe(a.jobId);
      let queued = (await rows({ singletonKey: key })).filter((r) => r.state === 'created');
      expect(queued).toHaveLength(1);
      expect(queued[0]?.start_after.getTime()).toBe(t2.getTime());
      expect(decodeEnvelope(queued[0]?.data)).toMatchObject({ id: a.jobId, data: { n: 2 } });

      const c = await wf.schedule('timer.heartbeat', { n: 3 }, t1, { singletonKey: key });
      expect(c.jobId).toBe(a.jobId);
      queued = (await rows({ singletonKey: key })).filter((r) => r.state === 'created');
      expect(queued.map((r) => r.name)).toEqual(['timer.heartbeat']);
      expect(decodeEnvelope(queued[0]?.data)).toMatchObject({ id: a.jobId, data: { n: 3 } });

      // A scheduled job holds its key for start as well.
      expect((await wf.start('timer.heartbeat', {}, { singletonKey: key })).jobId).toBe(a.jobId);
    });

    it('schedule without a key adds a job each time', async () => {
      const wf = open();
      const at = new Date(Date.now() + 60_000);
      const a = await wf.schedule('timer.revert', {}, at);
      const b = await wf.schedule('timer.revert', {}, at);
      expect(a.jobId).not.toBe(b.jobId);
      expect(await rows({ name: 'timer.revert' })).toHaveLength(2);
    });

    it('cancel removes the queued job, so the next start creates a new one', async () => {
      const wf = open();
      const a = await wf.schedule('timer.claim-expiry', {}, new Date(Date.now() + 60_000), { singletonKey: 'claim:inc:u' });
      await wf.cancel('claim:inc:u');
      expect((await rows({ singletonKey: 'claim:inc:u' })).map((r) => r.state)).toEqual(['cancelled']);
      const b = await wf.start('timer.claim-expiry', {}, { singletonKey: 'claim:inc:u' });
      expect(b.jobId).not.toBe(a.jobId);
    });

    it('rejects empty and reserved keys', async () => {
      const wf = open();
      await expect(wf.start('reconcile', {}, { singletonKey: '' })).rejects.toThrow(/empty/);
      await expect(wf.schedule('reconcile', {}, new Date(), { singletonKey: 'cron:x' })).rejects.toThrow(/reserved/);
      await expect(wf.start('reconcile', {}, { retryLimit: -1 })).rejects.toThrow(RangeError);
    });
  });

  describe('park and resume (ADR 0012)', () => {
    const tap: WaitKey = { kind: 'tap', eventId: 'evt-1' };

    /** A handler that parks on `waitingOn` on its first delivery and records every delivery. */
    const parkingWorker = (wf: PgBossWorkflow, waitingOn: WaitKey, timeoutAt?: () => Date): Job[] => {
      const seen: Job[] = [];
      wf.work('incident.process', async (job) => {
        seen.push(job);
        if (job.resumed === undefined) {
          await wf.park(job.id, waitingOn, timeoutAt?.());
        }
      });
      return seen;
    };

    it('a resume and the writes it goes with commit in one transaction', async () => {
      const wf = open();
      const seen = parkingWorker(wf, tap, () => new Date(Date.now() + 60 * 60_000));
      await wf.startPolling();
      const { jobId } = await wf.start('incident.process', { incidentId: 'inc-1' }, { singletonKey: 'process:inc-1' });
      await until(async () => (await waits()).length === 1);
      expect(await waits()).toEqual([{ job_id: jobId, wait_key: waitKeyString(tap) }]);
      const timerKey = waitTimeoutKey(jobId, tap);
      expect((await rows({ singletonKey: timerKey })).map((r) => r.state)).toEqual(['created']);

      // A resume rolled back with its transaction leaves the job parked.
      await expect(
        state.transaction(async (tx) => {
          await tx.ctx.db.insertInto('workspaces').values({ id: 'ws-rolled-back', slug: 'rolled-back' }).execute();
          expect(await wf.withTransaction(tx).resume(tap, 'ticket-only')).toEqual({ resumed: 1 });
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      expect(await waits()).toHaveLength(1);
      await sleep(1_200);
      expect(seen).toHaveLength(1);

      const result = await state.transaction(async (tx) => {
        await tx.ctx.db.insertInto('workspaces').values({ id: 'ws-1', slug: 'committed' }).execute();
        return wf.withTransaction(tx).resume(tap, { choice: 'ticket-only' });
      });
      expect(result).toEqual({ resumed: 1 });
      await until(() => seen.length === 2);
      expect(seen[1]).toEqual({
        id: jobId,
        name: 'incident.process',
        data: { incidentId: 'inc-1' },
        attempt: 1,
        singletonKey: 'process:inc-1',
        resumed: { result: { choice: 'ticket-only' } },
      });
      expect(await ctx.db.selectFrom('workspaces').select('id').execute()).toEqual([{ id: 'ws-1' }]);
      expect(await waits()).toEqual([]);
      // The pending timeout was cancelled.
      expect((await rows({ singletonKey: timerKey })).map((r) => r.state)).toEqual(['cancelled']);
      // A second resume for the same key is a no-op.
      expect(await wf.resume(tap, 'again')).toEqual({ resumed: 0 });
    });

    it('a timeout re-delivers the job with { timedOut: true }, and a late resume is a no-op', async () => {
      const wf = open();
      const seen = parkingWorker(wf, { kind: 'ci', prId: 'pr-7' }, () => new Date(Date.now() + 1_000));
      await wf.startPolling();
      const { jobId } = await wf.start('incident.process', {}, {});
      await until(() => seen.length === 2);
      expect(seen[1]?.id).toBe(jobId);
      expect(isTimedOut(seen[1]?.resumed?.result)).toBe(true);
      expect(await waits()).toEqual([]);
      expect(await wf.resume({ kind: 'ci', prId: 'pr-7' }, 'green')).toEqual({ resumed: 0 });
    });

    it('a timeout after a resume is a no-op', async () => {
      const wf = open();
      const seen = parkingWorker(wf, tap, () => new Date(Date.now() + 60 * 60_000));
      await wf.startPolling();
      const { jobId } = await wf.start('incident.process', {}, {});
      await until(async () => (await waits()).length === 1);
      expect(await wf.resume(tap, 'tapped')).toEqual({ resumed: 1 });
      await until(() => seen.length === 2);
      // A stray timer for the same wait (as if the cancel had lost a race) finds no row.
      await wf.start('timer.wait-timeout', { jobId, waitKey: waitKeyString(tap) }, {});
      await until(async () => (await rows({ name: 'timer.wait-timeout' })).every((r) => r.state !== 'created' && r.state !== 'active'));
      await sleep(1_000);
      expect(seen).toHaveLength(2);
    });

    it('one resume re-delivers every job parked on the key; a parked job keeps its attempt and retries', async () => {
      const wf = open();
      const children: WaitKey = { kind: 'children', parentId: 'parent-1' };
      const seen: Job[] = [];
      let failures = 0;
      wf.work(
        'incident.process',
        async (job) => {
          seen.push(job);
          if (job.resumed === undefined && job.attempt === 1) {
            throw new Error('fail before parking');
          }
          if (job.resumed === undefined) {
            await wf.park(job.id, children);
            return;
          }
          if ((job.data as { fail?: boolean }).fail === true && failures === 0) {
            failures++;
            throw new Error('fail after resume');
          }
        },
        { concurrency: 2 },
      );
      await wf.startPolling();
      const a = await wf.start('incident.process', { fail: true }, { retryLimit: 2 });
      const b = await wf.start('incident.process', {}, { retryLimit: 1 });
      await until(async () => (await waits()).length === 2, 15_000);
      expect(await wf.resume(children, 'all done')).toEqual({ resumed: 2 });
      await until(() => seen.filter((j) => j.resumed !== undefined).length === 3, 15_000);
      const ofA = seen.filter((j) => j.id === a.jobId).map((j) => [j.attempt, j.resumed?.result ?? null]);
      const ofB = seen.filter((j) => j.id === b.jobId).map((j) => [j.attempt, j.resumed?.result ?? null]);
      expect(ofA).toEqual([
        [1, null],
        [2, null],
        [2, 'all done'],
        [3, 'all done'],
      ]);
      expect(ofB).toEqual([
        [1, null],
        [2, null],
        [2, 'all done'],
      ]);
    });

    it('park outside a running delivery rejects with JobNotActiveError', async () => {
      const wf = open();
      const { jobId } = await wf.start('incident.process', {}, {});
      await expect(wf.park(jobId, tap)).rejects.toBeInstanceOf(JobNotActiveError);
      expect(await waits()).toEqual([]);
    });

    it('cancel(key) cancels a parked job and its wait row', async () => {
      const wf = open();
      const seen = parkingWorker(wf, tap);
      await wf.startPolling();
      await wf.start('incident.process', {}, { singletonKey: 'process:inc-9' });
      const parked = await until(async () => (await waits())[0]?.job_id);
      // A parked job is not queued: a start with its key creates a job (no worker runs this one).
      const queued = await wf.start('merge.evaluate', {}, { singletonKey: 'process:inc-9' });
      expect(queued.jobId).not.toBe(parked);
      await wf.cancel('process:inc-9');
      expect(await waits()).toEqual([]);
      const states = (await rows({ singletonKey: 'process:inc-9' })).map((r) => [r.name, r.state]);
      expect(states).toEqual([
        ['incident.process', 'completed'],
        ['incident.process', 'cancelled'],
        ['merge.evaluate', 'cancelled'],
      ]);
      expect(await wf.resume(tap, 'late')).toEqual({ resumed: 0 });
      await sleep(1_000);
      expect(seen).toHaveLength(1);
    });

    it('parked jobs survive a pg-boss stop and start', async () => {
      const ci: WaitKey = { kind: 'ci', prId: 'pr-1' };
      const deploy: WaitKey = { kind: 'deploy', env: 'staging', sha: 'abc123' };
      const verify: WaitKey = { kind: 'verification', incidentId: 'inc-3' };
      const first = open();
      first.work('fixer.run', async (job) => {
        const wait = (job.data as { wait: string }).wait;
        if (wait === 'ci') await first.park(job.id, ci);
        if (wait === 'deploy') await first.park(job.id, deploy, new Date(Date.now() + 1_500));
        if (wait === 'verify') await first.park(job.id, verify, new Date(Date.now() + 60 * 60_000));
      });
      await first.startPolling();
      const ciJob = await first.start('fixer.run', { wait: 'ci' }, {});
      const deployJob = await first.start('fixer.run', { wait: 'deploy' }, {});
      const verifyJob = await first.start('fixer.run', { wait: 'verify' }, {});
      await until(async () => (await waits()).length === 3);
      // The verification timer goes missing and its deadline passes while nothing runs.
      await first.cancel(waitTimeoutKey(verifyJob.jobId, verify));
      await ctx.db.updateTable('job_waits').set({ timeout_at: '2000-01-01T00:00:00.000Z' }).where('job_id', '=', verifyJob.jobId).execute();
      await first.stop();
      await sleep(2_000);

      const second = open();
      const seen: Job[] = [];
      second.work('fixer.run', async (job) => {
        seen.push(job);
      });
      await second.startPolling();
      // The deploy timer fired late; the verification wait was timed out by recovery.
      await until(() => seen.length === 2);
      const timedOut = seen.filter((j) => isTimedOut(j.resumed?.result)).map((j) => j.id);
      expect(timedOut.sort()).toEqual([deployJob.jobId, verifyJob.jobId].sort());
      expect(await second.resume(ci, 'ci-green')).toEqual({ resumed: 1 });
      await until(() => seen.length === 3);
      expect(seen[2]).toMatchObject({ id: ciJob.jobId, data: { wait: 'ci' }, attempt: 1, resumed: { result: 'ci-green' } });
      expect(await waits()).toEqual([]);
    });
  });

  it('startPolling queues again a job a crashed process left active, keeping its attempt', async () => {
    const crashed = open();
    const { jobId } = await crashed.start('incident.process', { n: 1 }, {});
    // As if a process claimed the job and died: the row is active and nothing runs it.
    await sql`update ${sql.id(bossSchema, 'job')} set state = 'active', started_on = now() where name = 'incident.process'`.execute(ctx.db);
    await crashed.stop();

    const cautious = open({ recoverActive: false });
    expect(await cautious.recover()).toEqual({ requeued: 0, timedOut: 0 });
    await cautious.stop();

    const restarted = open();
    const seen: Job[] = [];
    restarted.work('incident.process', async (job) => {
      seen.push(job);
    });
    await restarted.startPolling();
    await until(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ id: jobId, data: { n: 1 }, attempt: 1 });
  });

  describe('retries and cron', () => {
    it('retries a failed handler with backoff up to retryLimit', async () => {
      const wf = open();
      const at: number[] = [];
      const attempts: number[] = [];
      wf.work('merge.evaluate', async (job) => {
        at.push(Date.now());
        attempts.push(job.attempt);
        if (job.attempt < 3) {
          throw new Error(`attempt ${job.attempt} fails`);
        }
      });
      await wf.startPolling();
      await wf.start('merge.evaluate', {}, { retryLimit: 2, retryBackoff: true });
      await until(() => attempts.length === 3, RETRY_BOUND_MS);
      expect(attempts).toEqual([1, 2, 3]);
      const [t1 = 0, t2 = 0, t3 = 0] = at;
      // Backoff floors: 1 s before the first retry, 2 s before the second (jitter only adds to them).
      expect(t2 - t1).toBeGreaterThanOrEqual(900);
      expect(t3 - t2).toBeGreaterThanOrEqual(1_900);
      // The handler returns before pg-boss settles the job, so the row is still 'active' for a moment.
      await until(async () => (await rows({ name: 'merge.evaluate' }))[0]?.state === 'completed', 5_000);
      const [row] = await rows({ name: 'merge.evaluate' });
      expect(row).toMatchObject({ state: 'completed', retry_backoff: true, retry_limit: 2 });
    }, 30_000);

    it('fails the job once retryLimit is spent, and reports each failure to onError', async () => {
      const errors: unknown[] = [];
      const wf = open({ onError: (e) => errors.push(e) });
      const attempts: number[] = [];
      wf.work('merge.evaluate', async (job) => {
        attempts.push(job.attempt);
        throw new Error('always fails');
      });
      await wf.startPolling();
      await wf.start('merge.evaluate', {}, { retryLimit: 1 });
      await until(async () => (await rows({ name: 'merge.evaluate' }))[0]?.state === 'failed', 15_000);
      expect(attempts).toEqual([1, 2]);
      expect(errors.filter((e) => e instanceof Error && e.message === 'always fails')).toHaveLength(2);
    }, 20_000);

    it('cron runs a job on an expression; a second call replaces the schedule', async () => {
      const wf = open();
      const seen: Job[] = [];
      wf.work('reconcile', async (job) => {
        seen.push(job);
      });
      await wf.startPolling();
      // The same expressions as the in-process scheduler: five fields, no seconds.
      await expect(wf.cron('reconcile', '* * * * * *')).rejects.toBeInstanceOf(CronExpressionError);
      await expect(wf.cron('reconcile', 'every minute')).rejects.toBeInstanceOf(CronExpressionError);
      await wf.cron('reconcile', '0 0 1 1 *', { old: true });
      await wf.cron('reconcile', '* * * * *', { sweep: 'all' });
      const schedules = await sql<{ n: number }>`select count(*)::int as n from ${sql.id(bossSchema, 'schedule')}`.execute(ctx.db);
      expect(schedules.rows[0]?.n).toBe(1);
      await until(() => seen.length >= 1, 15_000);
      expect(seen[0]).toMatchObject({ name: 'reconcile', data: { sweep: 'all' }, attempt: 1 });
      expect(seen[0]?.id).toMatch(ULID);
    }, 20_000);
  });

  describe('workers', () => {
    it('work respects concurrency', async () => {
      const wf = open();
      let running = 0;
      let peak = 0;
      let done = 0;
      wf.work(
        'fixer.run',
        async () => {
          running++;
          peak = Math.max(peak, running);
          await sleep(400);
          running--;
          done++;
        },
        { concurrency: 2 },
      );
      await wf.startPolling();
      for (let i = 0; i < 5; i++) {
        await wf.start('fixer.run', { i }, {});
      }
      await until(() => done === 5, 15_000);
      expect(peak).toBe(2);
    }, 20_000);

    it('refuses a handler for timer.wait-timeout, a second handler for a name, and a bad concurrency', () => {
      const wf = open();
      const noop = async (): Promise<void> => undefined;
      expect(() => wf.work('timer.wait-timeout', noop)).toThrow(/run by the workflow/);
      wf.work('reconcile', noop);
      expect(() => wf.work('reconcile', noop)).toThrow(/already registered/);
      expect(() => wf.work('incident.process', noop, { concurrency: 0 })).toThrow(RangeError);
    });
  });
});

describe('cronJobId', () => {
  it('is a ULID built from the row time and uuid, stable for one row', () => {
    const at = new Date('2026-10-01T12:00:00.000Z');
    const a = cronJobId('0d2b7a3e-6f1c-4c55-9a0e-1f2e3d4c5b6a', at);
    expect(a).toMatch(ULID);
    expect(a).toBe(cronJobId('0d2b7a3e-6f1c-4c55-9a0e-1f2e3d4c5b6a', at));
    expect(a).not.toBe(cronJobId('0d2b7a3e-6f1c-4c55-9a0e-1f2e3d4c5b6b', at));
    expect(() => cronJobId('not-a-uuid', at)).toThrow(TypeError);
  });
});
