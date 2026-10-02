// In-process WorkflowPort over the state database's `jobs` and `job_waits` tables (B 2 `local`
// provider, B 3 last paragraph, B 5 durable timers, ADR 0012 parking). Every timer, retry, parked
// job, and cron schedule is a row; the only in-memory state is the handler registry and the count of
// handlers running in this process, so closing and reopening the database loses nothing. One poll
// loop (`startPolling`) drives it; tests call `tick` or `drain` instead and move an injected clock.
//
// Semantics another WorkflowPort implementation mirrors:
// - Singleton keys are global (`cancel` takes only a key). A key is "queued" while a job holding it
//   is `created` or `retry`. `start` with a queued key returns that job and writes nothing;
//   `schedule` with a queued key moves that job to the new run time, name, and data, keeping its id.
// - `cancel(key)` cancels the queued and parked jobs holding the key (a parked job's wait row goes
//   with it). A running handler is not interrupted.
// - A handler that rejects is retried after `retryDelayMs` (policy.ts) while `attempt <= retryLimit`,
//   then the job is `failed`. A retry of a resumed delivery carries the same `job.resumed`.
// - Park, resume, and timeout follow ADR 0012: the `job_waits` delete is the claim.
// - `cron(name, expression, input)` keeps one schedule row per name (`cron:{name}`); each fire
//   enqueues a plain `name` job, whether or not a worker is registered. Missed fires collapse into
//   one. Calling `cron` again replaces the expression and input.
// - `startPolling` first runs `recover`: jobs left `active` by a crashed process are queued again
//   (this provider is single node, B 2), and parked jobs whose timeout passed with no pending
//   `timer.wait-timeout` job are timed out (ADR 0012, restart).
// - `undefined` input is stored and delivered as `null`.

import { sql, type Selectable } from 'kysely';
import type { Job, JobName } from '../../contracts/jobs.ts';
import type { StatePort } from '../../ports/state.ts';
import type { WaitKey, WorkflowPort } from '../../ports/workflow.ts';
import { parseWaitKey, TIMED_OUT, waitKeyString, waitTimeoutKey } from '../../ports/workflow.ts';
import { inTransaction, type StateContext } from '../../state/context.ts';
import type { JobsTable, JobState } from '../../state/db.ts';
import { StateStore } from '../../state/store.ts';
import { ulid } from '../../util/ulid.ts';
import { parseCron } from './cron.ts';
import {
  CRON_KEY_PREFIX,
  cronKey,
  DEFAULT_CONCURRENCY,
  DEFAULT_RETRY_LIMIT,
  isWaitTimeoutData,
  retryDelayMs,
  WAIT_TIMEOUT_CONCURRENCY,
  WAIT_TIMEOUT_JOB,
  type CronRowData,
  type WaitTimeoutData,
} from './policy.ts';

export { CronExpressionError, parseCron, type CronSchedule } from './cron.ts';
export * from './policy.ts';

/** `park` was called for a job that is not running (not `active`). */
export class JobNotActiveError extends Error {
  constructor(readonly jobId: string) {
    super(`park: job ${jobId} is not active`);
    this.name = 'JobNotActiveError';
  }
}

export interface InProcessWorkflowOptions {
  /** Delay between poll passes in `startPolling`; default 1000 ms. Timers fire on the first pass at or after their run time. */
  pollIntervalMs?: number;
  /** Called when a handler rejects; default writes nothing (the error is kept in `jobs.last_error`). */
  onError?: (error: unknown, job: Job) => void;
}

type Handler = (job: Job) => Promise<void>;

interface Worker {
  readonly handler: Handler;
  readonly concurrency: number;
  running: number;
}

type JobRow = Selectable<JobsTable>;

const QUEUED: readonly JobState[] = ['created', 'retry'];

/** The most passes `drain` runs before it gives up on reaching a quiet state. */
const DRAIN_LIMIT = 1_000;

export class InProcessWorkflow implements WorkflowPort {
  readonly #ctx: StateContext;
  readonly #pollIntervalMs: number;
  readonly #onError: (error: unknown, job: Job) => void;
  readonly #workers = new Map<string, Worker>();
  readonly #inFlight = new Set<Promise<void>>();
  #tickChain: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #polling = false;

  /**
   * `source` is the store `openState` returned (the scheduler shares its connection) or a
   * StateContext. The context's clock is the scheduler's clock.
   */
  constructor(source: StatePort | StateContext, options: InProcessWorkflowOptions = {}) {
    this.#ctx = contextOf(source);
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#onError = options.onError ?? (() => undefined);
    this.#workers.set(WAIT_TIMEOUT_JOB, {
      handler: (job) => this.#fireWaitTimeout(job),
      concurrency: WAIT_TIMEOUT_CONCURRENCY,
      running: 0,
    });
  }

  // WorkflowPort -----------------------------------------------------------------------------------

  async start(
    name: JobName,
    input: unknown,
    opts: { singletonKey?: string; retryLimit?: number; retryBackoff?: boolean },
  ): Promise<{ jobId: string }> {
    assertUserKey(opts.singletonKey);
    const retryLimit = opts.retryLimit ?? DEFAULT_RETRY_LIMIT;
    if (!Number.isInteger(retryLimit) || retryLimit < 0) {
      throw new RangeError(`start: retryLimit must be a non-negative integer, got ${retryLimit}`);
    }
    return inTransaction(this.#ctx, async (tx) => {
      if (opts.singletonKey !== undefined) {
        const queued = await this.#lockQueued(tx, opts.singletonKey);
        if (queued !== undefined) {
          return { jobId: queued };
        }
      }
      const jobId = await this.#insert(tx, name, input, tx.now(), opts.singletonKey, retryLimit, opts.retryBackoff ?? false);
      return { jobId };
    });
  }

  async schedule(name: JobName, input: unknown, runAt: Date, opts: { singletonKey?: string } = {}): Promise<{ jobId: string }> {
    assertUserKey(opts.singletonKey);
    return inTransaction(this.#ctx, (tx) => this.#schedule(tx, name, input, runAt, opts.singletonKey));
  }

  async cancel(singletonKey: string): Promise<void> {
    await inTransaction(this.#ctx, async (tx) => {
      const now = tx.codec.timestamp(tx.now());
      await tx.db
        .deleteFrom('job_waits')
        .where('job_id', 'in', tx.db.selectFrom('jobs').select('id').where('singleton_key', '=', singletonKey).where('state', '=', 'parked'))
        .execute();
      await tx.db
        .updateTable('jobs')
        .set({ state: 'cancelled', completed_at: now })
        .where('singleton_key', '=', singletonKey)
        .where('state', 'in', [...QUEUED, 'parked'])
        .execute();
    });
  }

  work(name: JobName, handler: (job: Job) => Promise<void>, opts: { concurrency?: number } = {}): void {
    if (name === WAIT_TIMEOUT_JOB) {
      throw new Error(`work: ${WAIT_TIMEOUT_JOB} is run by the scheduler itself (ADR 0012)`);
    }
    if (this.#workers.has(name)) {
      throw new Error(`work: a handler for ${name} is already registered`);
    }
    const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError(`work: concurrency must be a positive integer, got ${concurrency}`);
    }
    this.#workers.set(name, { handler, concurrency, running: 0 });
  }

  async park(jobId: string, waitingOn: WaitKey, timeoutAt?: Date): Promise<void> {
    const waitKey = waitKeyString(waitingOn);
    await inTransaction(this.#ctx, async (tx) => {
      const parked = await tx.db
        .updateTable('jobs')
        .set({ state: 'parked', resumed: null })
        .where('id', '=', jobId)
        .where('state', '=', 'active')
        .executeTakeFirst();
      if (parked.numUpdatedRows === 0n) {
        throw new JobNotActiveError(jobId);
      }
      await tx.db
        .insertInto('job_waits')
        .values({
          job_id: jobId,
          wait_kind: waitingOn.kind,
          wait_key: waitKey,
          timeout_at: timeoutAt === undefined ? null : tx.codec.timestamp(timeoutAt),
          created_at: tx.codec.timestamp(tx.now()),
        })
        .execute();
      if (timeoutAt !== undefined) {
        const data: WaitTimeoutData = { jobId, waitKey };
        await this.#schedule(tx, WAIT_TIMEOUT_JOB, data, timeoutAt, waitTimeoutKey(jobId, waitingOn));
      }
    });
  }

  async resume(waitingOn: WaitKey, result: unknown): Promise<{ resumed: number }> {
    return inTransaction(this.#ctx, async (tx) => {
      const deleted = await tx.db
        .deleteFrom('job_waits')
        .where('wait_kind', '=', waitingOn.kind)
        .where('wait_key', '=', waitKeyString(waitingOn))
        .returning('job_id')
        .execute();
      const jobIds = deleted.map((r) => r.job_id);
      if (jobIds.length === 0) {
        return { resumed: 0 };
      }
      await this.#requeueParked(tx, jobIds, result);
      // Correctness does not depend on this cancel (the timer finds no row), it only tidies up.
      const timerKeys = [...new Set(jobIds.map((id) => waitTimeoutKey(id, waitingOn)))];
      await tx.db
        .updateTable('jobs')
        .set({ state: 'cancelled', completed_at: tx.codec.timestamp(tx.now()) })
        .where('name', '=', WAIT_TIMEOUT_JOB)
        .where('singleton_key', 'in', timerKeys)
        .where('state', 'in', QUEUED)
        .execute();
      return { resumed: jobIds.length };
    });
  }

  async cron(name: JobName, expression: string, input?: unknown): Promise<void> {
    const schedule = parseCron(expression);
    const key = cronKey(name);
    const data: CronRowData = { expression, input: input ?? null };
    await inTransaction(this.#ctx, async (tx) => {
      await lockKey(tx, key);
      const now = tx.now();
      const nextRun = tx.codec.timestamp(schedule.next(now));
      const existing = await tx.db.selectFrom('jobs').select('id').where('name', '=', key).where('singleton_key', '=', key).executeTakeFirst();
      if (existing !== undefined) {
        await tx.db
          .updateTable('jobs')
          .set({ data: tx.codec.json(data), start_after: nextRun, state: 'created', completed_at: null })
          .where('id', '=', existing.id)
          .execute();
        return;
      }
      await tx.db
        .insertInto('jobs')
        .values({
          id: ulid(now.getTime()),
          name: key,
          data: tx.codec.json(data),
          state: 'created',
          start_after: nextRun,
          singleton_key: key,
          created_at: tx.codec.timestamp(now),
        })
        .execute();
    });
  }

  // Driving the scheduler --------------------------------------------------------------------------

  /** Runs `recover`, then a poll pass every `pollIntervalMs` until `stop`. */
  async startPolling(): Promise<void> {
    if (this.#polling) {
      return;
    }
    this.#polling = true;
    await this.recover();
    const loop = (): void => {
      if (!this.#polling) {
        return;
      }
      this.tick()
        .catch(() => undefined)
        .finally(() => {
          if (this.#polling) {
            this.#timer = setTimeout(loop, this.#pollIntervalMs);
          }
        });
    };
    loop();
  }

  /** Stops the poll loop and waits for running handlers to settle. */
  async stop(): Promise<void> {
    this.#polling = false;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#tickChain.catch(() => undefined);
    await this.idle();
  }

  /**
   * One poll pass at the clock's current time: fires due cron schedules, then hands due jobs to
   * registered handlers up to each one's free concurrency. Resolves to the number of deliveries it
   * started (handlers keep running after it resolves; see `idle`). Passes never overlap.
   */
  tick(): Promise<number> {
    const run = this.#tickChain.catch(() => undefined).then(() => this.#tick());
    this.#tickChain = run;
    return run;
  }

  /** Resolves when no handler is running in this process. */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
  }

  /**
   * Ticks and waits for handlers until a pass starts nothing while no handler runs: everything due
   * at the current clock time has run.
   */
  async drain(): Promise<void> {
    for (let i = 0; i < DRAIN_LIMIT; i++) {
      const started = await this.tick();
      const busy = this.#inFlight.size > 0;
      await this.idle();
      if (started === 0 && !busy) {
        return;
      }
    }
    throw new Error(`drain: still starting jobs after ${DRAIN_LIMIT} passes`);
  }

  /**
   * Restart recovery (ADR 0012): queues again every job left `active` (no handler runs it now that
   * this process has just started), and times out every parked job whose `timeout_at` has passed and
   * has no pending `timer.wait-timeout` job. Returns how many jobs it touched.
   */
  async recover(): Promise<{ requeued: number; timedOut: number }> {
    return inTransaction(this.#ctx, async (tx) => {
      const now = tx.codec.timestamp(tx.now());
      const requeued = await tx.db
        .updateTable('jobs')
        .set({ state: 'created', start_after: now, started_at: null })
        .where('state', '=', 'active')
        .executeTakeFirst();
      const overdue = await tx.db.selectFrom('job_waits').selectAll().where('timeout_at', 'is not', null).where('timeout_at', '<=', now).execute();
      let timedOut = 0;
      for (const row of overdue) {
        const timer = waitTimeoutKey(row.job_id, parseWaitKey(row.wait_key));
        const pending = await tx.db
          .selectFrom('jobs')
          .select('id')
          .where('name', '=', WAIT_TIMEOUT_JOB)
          .where('singleton_key', '=', timer)
          .where('state', 'in', [...QUEUED, 'active'])
          .executeTakeFirst();
        if (pending === undefined && (await this.#timeOut(tx, { jobId: row.job_id, waitKey: row.wait_key }))) {
          timedOut++;
        }
      }
      return { requeued: Number(requeued.numUpdatedRows), timedOut };
    });
  }

  // Internals --------------------------------------------------------------------------------------

  async #tick(): Promise<number> {
    await this.#fireCrons();
    let started = 0;
    for (const [name, worker] of this.#workers) {
      const free = worker.concurrency - worker.running;
      if (free <= 0) {
        continue;
      }
      const jobs = await this.#claim(name, free);
      for (const job of jobs) {
        started++;
        this.#deliver(worker, job);
      }
    }
    return started;
  }

  #deliver(worker: Worker, job: Job): void {
    worker.running++;
    const run = (async () => {
      try {
        await worker.handler(job);
        await this.#complete(job.id);
      } catch (error) {
        this.#onError(error, job);
        await this.#fail(job.id, error);
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        worker.running--;
        this.#inFlight.delete(run);
      });
    this.#inFlight.add(run);
  }

  /** Moves up to `limit` due jobs named `name` to `active` and returns their deliveries. */
  async #claim(name: string, limit: number): Promise<Job[]> {
    return inTransaction(this.#ctx, async (tx) => {
      const now = tx.codec.timestamp(tx.now());
      const rows = await tx.db
        .selectFrom('jobs')
        .selectAll()
        .where('name', '=', name)
        .where('state', 'in', QUEUED)
        .where('start_after', '<=', now)
        .orderBy('start_after')
        .orderBy('id')
        .limit(limit)
        .execute();
      const jobs: Job[] = [];
      for (const row of rows) {
        const claimed = await tx.db
          .updateTable('jobs')
          .set({ state: 'active', started_at: now })
          .where('id', '=', row.id)
          .where('state', 'in', QUEUED)
          .executeTakeFirst();
        if (claimed.numUpdatedRows > 0n) {
          jobs.push(this.#toJob(tx, row));
        }
      }
      return jobs;
    });
  }

  #toJob(tx: StateContext, row: JobRow): Job {
    const job: Job = {
      id: row.id,
      name: row.name as JobName,
      data: tx.codec.fromJson(row.data),
      attempt: tx.codec.fromNumber(row.retry_count) + 1,
    };
    if (row.singleton_key !== null) {
      job.singletonKey = row.singleton_key;
    }
    const resumed = tx.codec.fromJsonOpt(row.resumed);
    if (resumed !== undefined) {
      job.resumed = resumed as NonNullable<Job['resumed']>;
    }
    return job;
  }

  /** Completes a job whose handler resolved, unless it parked (or was resumed) meanwhile. */
  async #complete(jobId: string): Promise<void> {
    await this.#ctx.db
      .updateTable('jobs')
      .set({ state: 'completed', resumed: null, completed_at: this.#ctx.codec.timestamp(this.#ctx.now()) })
      .where('id', '=', jobId)
      .where('state', '=', 'active')
      .execute();
  }

  /** Schedules a retry or marks the job failed, unless it parked meanwhile. */
  async #fail(jobId: string, error: unknown): Promise<void> {
    await inTransaction(this.#ctx, async (tx) => {
      const row = await tx.db
        .selectFrom('jobs')
        .select(['retry_count', 'retry_limit', 'retry_backoff'])
        .where('id', '=', jobId)
        .where('state', '=', 'active')
        .executeTakeFirst();
      if (row === undefined) {
        return;
      }
      const now = tx.now();
      const retries = tx.codec.fromNumber(row.retry_count);
      const lastError = errorMessage(error);
      if (retries < tx.codec.fromNumber(row.retry_limit)) {
        const runAt = new Date(now.getTime() + retryDelayMs(retries, tx.codec.fromBool(row.retry_backoff)));
        await tx.db
          .updateTable('jobs')
          .set({ state: 'retry', retry_count: retries + 1, start_after: tx.codec.timestamp(runAt), last_error: lastError })
          .where('id', '=', jobId)
          .execute();
        return;
      }
      await tx.db
        .updateTable('jobs')
        .set({ state: 'failed', last_error: lastError, completed_at: tx.codec.timestamp(now) })
        .where('id', '=', jobId)
        .execute();
    });
  }

  /** The built-in `timer.wait-timeout` handler (ADR 0012, timeout). */
  async #fireWaitTimeout(job: Job): Promise<void> {
    if (!isWaitTimeoutData(job.data)) {
      throw new TypeError(`${WAIT_TIMEOUT_JOB}: bad job data ${JSON.stringify(job.data)}`);
    }
    const data = job.data;
    await inTransaction(this.#ctx, (tx) => this.#timeOut(tx, data));
  }

  /** Deletes the job's wait row and, if this call deleted it, re-delivers the job as timed out. */
  async #timeOut(tx: StateContext, data: WaitTimeoutData): Promise<boolean> {
    const deleted = await tx.db
      .deleteFrom('job_waits')
      .where('job_id', '=', data.jobId)
      .where('wait_key', '=', data.waitKey)
      .returning('job_id')
      .execute();
    if (deleted.length === 0) {
      return false;
    }
    await this.#requeueParked(tx, [data.jobId], TIMED_OUT);
    return true;
  }

  async #requeueParked(tx: StateContext, jobIds: readonly string[], result: unknown): Promise<void> {
    await tx.db
      .updateTable('jobs')
      .set({ state: 'created', start_after: tx.codec.timestamp(tx.now()), resumed: tx.codec.json({ result: result ?? null }) })
      .where('id', 'in', jobIds)
      .where('state', '=', 'parked')
      .execute();
  }

  /** Enqueues one job for every due cron schedule and moves each schedule to its next run. */
  async #fireCrons(): Promise<void> {
    await inTransaction(this.#ctx, async (tx) => {
      const now = tx.now();
      const nowIso = tx.codec.timestamp(now);
      const due = await tx.db
        .selectFrom('jobs')
        .select(['id', 'name', 'data', 'start_after'])
        .where('name', 'like', `${CRON_KEY_PREFIX}%`)
        .where('state', '=', 'created')
        .where('start_after', '<=', nowIso)
        .execute();
      for (const row of due) {
        const data = tx.codec.fromJson(row.data) as CronRowData;
        const advanced = await tx.db
          .updateTable('jobs')
          .set({ start_after: tx.codec.timestamp(parseCron(data.expression).next(now)) })
          .where('id', '=', row.id)
          .where('start_after', '=', tx.codec.fromTimestamp(row.start_after))
          .executeTakeFirst();
        if (advanced.numUpdatedRows > 0n) {
          const name = decodeURIComponent(row.name.slice(CRON_KEY_PREFIX.length)) as JobName;
          await this.#insert(tx, name, data.input, now, undefined, DEFAULT_RETRY_LIMIT, false);
        }
      }
    });
  }

  async #schedule(tx: StateContext, name: JobName, input: unknown, runAt: Date, singletonKey: string | undefined): Promise<{ jobId: string }> {
    if (singletonKey !== undefined) {
      const queued = await this.#lockQueued(tx, singletonKey);
      if (queued !== undefined) {
        await tx.db
          .updateTable('jobs')
          .set({ name, data: tx.codec.json(input ?? null), start_after: tx.codec.timestamp(runAt) })
          .where('id', '=', queued)
          .execute();
        return { jobId: queued };
      }
    }
    const jobId = await this.#insert(tx, name, input, runAt, singletonKey, DEFAULT_RETRY_LIMIT, false);
    return { jobId };
  }

  /** Serializes writers of `key` (Postgres) and returns the id of the queued job holding it, if any. */
  async #lockQueued(tx: StateContext, key: string): Promise<string | undefined> {
    await lockKey(tx, key);
    const row = await tx.db
      .selectFrom('jobs')
      .select('id')
      .where('singleton_key', '=', key)
      .where('state', 'in', QUEUED)
      .orderBy('start_after')
      .executeTakeFirst();
    return row?.id;
  }

  async #insert(
    tx: StateContext,
    name: string,
    input: unknown,
    runAt: Date,
    singletonKey: string | undefined,
    retryLimit: number,
    retryBackoff: boolean,
  ): Promise<string> {
    const now = tx.now();
    const id = ulid(now.getTime());
    await tx.db
      .insertInto('jobs')
      .values({
        id,
        name,
        data: tx.codec.json(input ?? null),
        state: 'created',
        start_after: tx.codec.timestamp(runAt),
        singleton_key: singletonKey ?? null,
        retry_limit: retryLimit,
        retry_backoff: tx.codec.bool(retryBackoff),
        created_at: tx.codec.timestamp(now),
      })
      .execute();
    return id;
  }
}

function contextOf(source: StatePort | StateContext): StateContext {
  if (source instanceof StateStore) {
    return source.ctx;
  }
  if ('db' in source && 'codec' in source && 'now' in source) {
    return source;
  }
  throw new TypeError('InProcessWorkflow needs the store openState returned, or a StateContext');
}

/** Postgres: a transaction-scoped advisory lock on the key. SQLite has one writer already. */
async function lockKey(tx: StateContext, key: string): Promise<void> {
  if (tx.dialect === 'postgres') {
    await sql`select pg_advisory_xact_lock(hashtext(${'snapwing.jobs:' + key}))`.execute(tx.db);
  }
}

function assertUserKey(key: string | undefined): void {
  if (key === undefined) {
    return;
  }
  if (key === '') {
    throw new Error('singletonKey must not be empty');
  }
  if (key.startsWith(CRON_KEY_PREFIX)) {
    throw new Error(`singletonKey ${JSON.stringify(key)} uses the reserved prefix ${CRON_KEY_PREFIX}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
