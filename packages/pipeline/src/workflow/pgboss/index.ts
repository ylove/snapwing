// WorkflowPort on pg-boss in the state database (B 2 `docker`, `aws`, and `gcp` providers; B 5
// durable timers; ADR 0012 parking). pg-boss keeps its own tables in its own schema (default
// `pgboss`) and runs every statement through the state store's Kysely handle (`fromKysely`), so a
// job write, a `job_waits` write, and the caller's events commit in one transaction.
//
// Semantics, matching the in-process scheduler:
// - Singleton keys are global (`cancel` takes only a key). A key is "queued" while a pg-boss row
//   holding it is `created` or `retry` and not parked. pg-boss's own `singletonKey` dedupes only
//   `created` rows (and only on policy queues), so a retrying job would not block a new one; this
//   workflow checks for a queued row itself, under a transaction advisory lock on the key.
//   `start` with a queued key returns that job and writes nothing; `schedule` with a queued key
//   moves that job to the new run time, name, and data, keeping its id.
// - `cancel(key)` cancels the queued and parked jobs holding the key (a parked job's wait row goes
//   with it). A running handler is not interrupted.
// - A handler that rejects is retried by pg-boss while retries remain (`retryLimit`, default 0):
//   after 1 s each time, or with `retryBackoff` after 1 to 2 s, 2 to 4 s, 4 to 8 s, and so on up to
//   one hour (pg-boss adds jitter above the in-process scheduler's 1 s, 2 s, 4 s). A retry of a
//   resumed delivery carries the same `job.resumed`.
// - Park, resume, and timeout follow ADR 0012: the `job_waits` delete is the claim. A parked job is
//   a `created` row due in the year 9000 (`PARKED_UNTIL`) marked `parked`; park writes it, completes
//   the running row, and inserts the wait row in one transaction. Resume and timeout delete the wait
//   row and move the parked row's run time to now with `resumed` set, in one transaction.
// - `cron(name, expression, input)` keeps one pg-boss schedule per name; each fire enqueues a plain
//   `name` job. Missed fires collapse into one. Calling `cron` again replaces the expression and
//   input. Expressions take five fields, or six with seconds first.
// - `startPolling` first runs `recover`: jobs left `active` by a crashed process are queued again
//   with the same attempt (unless `recoverActive` is false), and parked jobs whose timeout passed
//   with no pending `timer.wait-timeout` job are timed out (ADR 0012, restart). The requeue assumes
//   one process works this pg-boss schema, as the self-host `docker` provider runs; with several,
//   set `recoverActive: false` and pg-boss's expiry recovers a lost attempt instead (after
//   `expireInSeconds`, as a retry while retries remain).
// - `undefined` input is stored and delivered as `null`.
//
// Logical ids: pg-boss row ids are uuids and a re-enqueued job gets a new row, so the ULID `Job.id`
// is carried in the row's data (envelope.ts) and mapped back on delivery.
//
// Transactions: `withTransaction(tx)` returns a WorkflowPort whose writes join `tx`, a state
// transaction; use it so a resume (or a start, schedule, cancel, or park) commits or rolls back with
// the events it goes with:
//
//   await state.transaction(async (tx) => {
//     await tx.append(incidentId, [tapped], seq);
//     await workflow.withTransaction(tx).resume({ kind: 'tap', eventId }, choice);
//   });

import { sql } from 'kysely';
import { fromKysely, PgBoss, type Db, type JobWithMetadata, type SendOptions } from 'pg-boss';
import { JOB_NAMES, type Job, type JobName } from '../../contracts/jobs.ts';
import type { WaitKey, WorkflowPort } from '../../ports/workflow.ts';
import { parseWaitKey, TIMED_OUT, waitKeyString, waitTimeoutKey } from '../../ports/workflow.ts';
import { inTransaction, type StateContext } from '../../state/context.ts';
import { StateStore } from '../../state/store.ts';
import { ulid } from '../../util/ulid.ts';
import { parseCron } from '../inprocess/cron.ts';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_RETRY_LIMIT,
  isWaitTimeoutData,
  WAIT_TIMEOUT_CONCURRENCY,
  WAIT_TIMEOUT_JOB,
  type WaitTimeoutData,
} from '../inprocess/policy.ts';
import {
  assertUserKey,
  cronJobId,
  decodeEnvelope,
  envelope,
  MAX_RETRY_DELAY_SECONDS,
  PARKED_UNTIL,
  RETRY_DELAY_SECONDS,
  singletonLockKey,
  type Envelope,
} from './envelope.ts';

export * from './envelope.ts';

/** `park` was called for a job that is not running (not `active`). */
export class JobNotActiveError extends Error {
  constructor(readonly jobId: string) {
    super(`park: job ${jobId} is not active`);
    this.name = 'JobNotActiveError';
  }
}

export interface PgBossWorkflowOptions {
  /** Postgres schema for pg-boss's tables; default `pgboss`. Lowercase letters, digits, and `_`. */
  schema?: string;
  /** How often each worker polls for due jobs, in seconds (pg-boss minimum 0.5); default 2. */
  pollingIntervalSeconds?: number;
  /** How often pg-boss checks cron schedules, in seconds (1 to 45); default pg-boss's 30. */
  cronIntervalSeconds?: number;
  /** How long a handler may run before pg-boss expires the attempt, in seconds; default 3600 (B 5 fixer budget is 30 min). */
  expireInSeconds?: number;
  /**
   * Whether `startPolling` queues again the jobs left `active` (a crashed process's), as the
   * in-process scheduler does; default true. Set false when several processes share the schema.
   */
  recoverActive?: boolean;
  /** Called when a handler rejects and when pg-boss reports an error; default does nothing. */
  onError?: (error: unknown, job?: Job) => void;
}

type Handler = (job: Job) => Promise<void>;

interface Worker {
  readonly handler: Handler;
  readonly concurrency: number;
}

/** A pg-boss `job` row, as the raw queries below select it. */
interface BossRow {
  id: string;
  name: string;
  data: unknown;
  retry_count: number;
  retry_limit: number;
  retry_delay: number;
  retry_backoff: boolean;
  retry_delay_max: number | null;
  singleton_key: string | null;
}

const BOSS_COLUMNS = sql.raw('id, name, data, retry_count, retry_limit, retry_delay, retry_backoff, retry_delay_max, singleton_key');

/** State shared by a workflow and every `withTransaction` view of it. */
class Shared {
  /** The state store's root context: workers and recovery run here, never in a caller's transaction. */
  readonly root: StateContext;
  readonly schema: string;
  readonly boss: PgBoss;
  readonly pollingIntervalSeconds: number;
  readonly expireInSeconds: number;
  readonly recoverActive: boolean;
  readonly onError: (error: unknown, job?: Job) => void;
  readonly workers = new Map<string, Worker>();
  /** Logical job id to the pg-boss row this process is running it from. */
  readonly deliveries = new Map<string, { name: string; rowId: string }>();
  readonly registrations: Promise<unknown>[] = [];
  booting: Promise<void> | undefined;
  polling = false;
  stopped = false;

  constructor(root: StateContext, options: PgBossWorkflowOptions) {
    if (root.dialect !== 'postgres') {
      throw new Error('PgBossWorkflow needs the postgres state dialect (SNAPWING_DB=postgres)');
    }
    this.root = root;
    this.schema = options.schema ?? 'pgboss';
    if (!/^[a-z_][a-z0-9_]{0,49}$/.test(this.schema)) {
      throw new Error(`PgBossWorkflow: bad schema name ${JSON.stringify(this.schema)}`);
    }
    this.pollingIntervalSeconds = options.pollingIntervalSeconds ?? 2;
    this.expireInSeconds = options.expireInSeconds ?? 3600;
    this.recoverActive = options.recoverActive ?? true;
    this.onError = options.onError ?? (() => undefined);
    this.boss = new PgBoss({
      db: fromKysely(root.db),
      schema: this.schema,
      ...(options.cronIntervalSeconds === undefined
        ? {}
        : { cronMonitorIntervalSeconds: options.cronIntervalSeconds, cronWorkerIntervalSeconds: options.cronIntervalSeconds }),
    });
    this.boss.on('error', (error) => this.onError(error));
  }
}

export class PgBossWorkflow implements WorkflowPort {
  readonly #ctx: StateContext;
  readonly #shared: Shared;

  /**
   * `source` is the opened (Postgres) state store or its StateContext. Nothing connects until the
   * first call; `startPolling` starts the workers.
   */
  constructor(source: StateStore | StateContext, options: PgBossWorkflowOptions = {}, shared?: Shared) {
    this.#ctx = source instanceof StateStore ? source.ctx : source;
    this.#shared = shared ?? new Shared(this.#ctx, options);
  }

  /** A view of this workflow whose writes join the state transaction `tx`. Workers stay on this workflow. */
  withTransaction(tx: StateStore | StateContext): PgBossWorkflow {
    return new PgBossWorkflow(tx, {}, this.#shared);
  }

  /** The pg-boss schema this workflow uses. */
  get schema(): string {
    return this.#shared.schema;
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
    await this.#boot();
    return inTransaction(this.#ctx, async (tx) => {
      if (opts.singletonKey !== undefined) {
        const queued = await this.#lockQueued(tx, opts.singletonKey);
        if (queued !== undefined) {
          return { jobId: logicalId(queued) };
        }
      }
      const jobId = ulid(tx.now().getTime());
      const env = envelope(opts.singletonKey === undefined ? { id: jobId, data: input } : { id: jobId, data: input, singletonKey: opts.singletonKey });
      await this.#send(tx, name, env, { singletonKey: opts.singletonKey, retryLimit, retryBackoff: opts.retryBackoff ?? false });
      return { jobId };
    });
  }

  async schedule(name: JobName, input: unknown, runAt: Date, opts: { singletonKey?: string } = {}): Promise<{ jobId: string }> {
    assertUserKey(opts.singletonKey);
    await this.#boot();
    return inTransaction(this.#ctx, (tx) => this.#schedule(tx, name, input, runAt, opts.singletonKey));
  }

  async cancel(singletonKey: string): Promise<void> {
    await this.#boot();
    await inTransaction(this.#ctx, async (tx) => {
      await lockKey(tx, singletonKey);
      const { rows } = await sql<BossRow>`
        select ${BOSS_COLUMNS} from ${this.#job()}
        where singleton_key = ${singletonKey} and state in ('created', 'retry')
      `.execute(tx.db);
      for (const row of rows) {
        const env = decodeEnvelope(row.data);
        if (env.parked === true && env.id !== undefined) {
          await tx.db.deleteFrom('job_waits').where('job_id', '=', env.id).execute();
        }
        await this.#boss.cancel(row.name, row.id, { db: bossDb(tx) });
      }
    });
  }

  work(name: JobName, handler: (job: Job) => Promise<void>, opts: { concurrency?: number } = {}): void {
    if (name === WAIT_TIMEOUT_JOB) {
      throw new Error(`work: ${WAIT_TIMEOUT_JOB} is run by the workflow itself (ADR 0012)`);
    }
    if (this.#shared.workers.has(name)) {
      throw new Error(`work: a handler for ${name} is already registered`);
    }
    const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError(`work: concurrency must be a positive integer, got ${concurrency}`);
    }
    const worker: Worker = { handler, concurrency };
    this.#shared.workers.set(name, worker);
    if (this.#shared.polling) {
      this.#register(name, worker);
    }
  }

  async park(jobId: string, waitingOn: WaitKey, timeoutAt?: Date): Promise<void> {
    const waitKey = waitKeyString(waitingOn);
    await this.#boot();
    await inTransaction(this.#ctx, async (tx) => {
      const row = await this.#lockActive(tx, jobId);
      if (row === undefined) {
        throw new JobNotActiveError(jobId);
      }
      const env = decodeEnvelope(row.data);
      const attempt = (env.attempt ?? 1) + row.retry_count;
      const singletonKey = row.singleton_key ?? undefined;
      const parked = envelope({ id: jobId, data: env.data, attempt, parked: true, ...(singletonKey === undefined ? {} : { singletonKey }) });
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
      // The parked job keeps the retries this delivery had left.
      await this.#send(tx, row.name, parked, {
        startAfter: PARKED_UNTIL,
        singletonKey,
        retryLimit: Math.max(0, row.retry_limit - row.retry_count),
        retryBackoff: row.retry_backoff,
      });
      // Completing the running row here, not when the handler returns, makes the park atomic: the
      // handler's own completion then finds no active row and changes nothing.
      await this.#boss.complete(row.name, { id: row.id, retryCount: row.retry_count }, null, { db: bossDb(tx) });
      if (timeoutAt !== undefined) {
        const data: WaitTimeoutData = { jobId, waitKey };
        await this.#schedule(tx, WAIT_TIMEOUT_JOB, data, timeoutAt, waitTimeoutKey(jobId, waitingOn));
      }
    });
  }

  async resume(waitingOn: WaitKey, result: unknown): Promise<{ resumed: number }> {
    await this.#boot();
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
      for (const id of jobIds) {
        await this.#requeueParked(tx, id, result);
      }
      // Correctness does not depend on this cancel (the timer finds no row), it only tidies up.
      for (const key of new Set(jobIds.map((id) => waitTimeoutKey(id, waitingOn)))) {
        const { rows } = await sql<BossRow>`
          select ${BOSS_COLUMNS} from ${this.#job()}
          where name = ${WAIT_TIMEOUT_JOB} and singleton_key = ${key} and state in ('created', 'retry')
        `.execute(tx.db);
        for (const row of rows) {
          await this.#boss.cancel(row.name, row.id, { db: bossDb(tx) });
        }
      }
      return { resumed: jobIds.length };
    });
  }

  async cron(name: JobName, expression: string, input?: unknown): Promise<void> {
    // The in-process parser decides which expressions are valid, so both providers accept the same ones.
    parseCron(expression);
    await this.#boot();
    // Not joined to a caller's transaction: pg-boss stores every schedule option, `db` included, on
    // the schedule row and passes them to each send.
    await this.#boss.schedule(name, expression, envelope({ data: input }), {
      tz: 'UTC',
      missed: 'once',
      retryLimit: DEFAULT_RETRY_LIMIT,
      expireInSeconds: this.#shared.expireInSeconds,
    });
  }

  // Driving the workflow ---------------------------------------------------------------------------

  /** Starts pg-boss, times out overdue parked jobs (`recover`), and starts every registered worker. */
  async startPolling(): Promise<void> {
    if (this.#shared.polling) {
      return;
    }
    await this.#boot();
    this.#shared.polling = true;
    await this.recover();
    this.#register(WAIT_TIMEOUT_JOB, { handler: (job) => this.#fireWaitTimeout(job), concurrency: WAIT_TIMEOUT_CONCURRENCY });
    for (const [name, worker] of this.#shared.workers) {
      this.#register(name, worker);
    }
  }

  /** Stops pg-boss's workers and timers, waiting up to `timeoutMs` for running handlers. Leaves the state store open. */
  async stop(timeoutMs = 30_000): Promise<void> {
    const shared = this.#shared;
    shared.polling = false;
    shared.stopped = true;
    if (shared.booting === undefined) {
      return;
    }
    await shared.booting.catch(() => undefined);
    await Promise.allSettled(shared.registrations);
    await shared.boss.stop({ graceful: true, close: false, timeout: timeoutMs });
  }

  /**
   * Restart recovery (ADR 0012): queues again every job left `active` (when `recoverActive`; no
   * handler of this process runs it before `startPolling`), and times out every parked job whose
   * `timeout_at` has passed and has no pending `timer.wait-timeout` job. Returns how many jobs it
   * touched.
   */
  async recover(): Promise<{ requeued: number; timedOut: number }> {
    await this.#boot();
    return inTransaction(this.#shared.root, async (tx) => {
      let requeued = 0;
      if (this.#shared.recoverActive) {
        // As pg-boss's own restore: with `started_on` cleared, the next claim keeps `retry_count`,
        // so the delivery keeps its attempt.
        const { rows } = await sql<{ id: string }>`
          update ${this.#job()} set state = 'created', started_on = null, heartbeat_on = null
          where state = 'active' and name = any(${[...JOB_NAMES]}::text[])
          returning id
        `.execute(tx.db);
        requeued = rows.length;
      }
      const now = tx.codec.timestamp(tx.now());
      const overdue = await tx.db.selectFrom('job_waits').selectAll().where('timeout_at', 'is not', null).where('timeout_at', '<=', now).execute();
      let timedOut = 0;
      for (const row of overdue) {
        const timer = waitTimeoutKey(row.job_id, parseWaitKey(row.wait_key));
        const { rows } = await sql<{ id: string }>`
          select id from ${this.#job()}
          where name = ${WAIT_TIMEOUT_JOB} and singleton_key = ${timer} and state in ('created', 'retry', 'active')
          limit 1
        `.execute(tx.db);
        if (rows.length === 0 && (await this.#timeOut(tx, { jobId: row.job_id, waitKey: row.wait_key }))) {
          timedOut++;
        }
      }
      return { requeued, timedOut };
    });
  }

  // Internals --------------------------------------------------------------------------------------

  get #boss(): PgBoss {
    return this.#shared.boss;
  }

  #job() {
    return sql.id(this.#shared.schema, 'job');
  }

  /** Starts pg-boss once and creates a queue for every job name. */
  #boot(): Promise<void> {
    const shared = this.#shared;
    if (shared.stopped) {
      return Promise.reject(new Error('PgBossWorkflow: stopped'));
    }
    shared.booting ??= (async () => {
      await shared.boss.start();
      const existing = new Set((await shared.boss.getQueues()).map((q) => q.name));
      for (const name of JOB_NAMES) {
        if (!existing.has(name)) {
          await shared.boss.createQueue(name, { retryLimit: DEFAULT_RETRY_LIMIT, expireInSeconds: shared.expireInSeconds });
        }
      }
    })();
    return shared.booting;
  }

  #register(name: string, worker: Worker): void {
    const shared = this.#shared;
    const registration = shared.boss
      .work(
        name,
        {
          batchSize: 1,
          localConcurrency: worker.concurrency,
          pollingIntervalSeconds: shared.pollingIntervalSeconds,
          includeMetadata: true,
        },
        async ([row]: JobWithMetadata<unknown>[]) => {
          if (row !== undefined) {
            await this.#deliver(name as JobName, worker, row);
          }
        },
      )
      .catch((error: unknown) => shared.onError(error));
    shared.registrations.push(registration);
  }

  async #deliver(name: JobName, worker: Worker, row: JobWithMetadata<unknown>): Promise<void> {
    const env = decodeEnvelope(row.data);
    const id = env.id ?? cronJobId(row.id, row.createdOn);
    const job: Job = { id, name, data: env.data, attempt: (env.attempt ?? 1) + row.retryCount };
    const singletonKey = env.singletonKey ?? row.singletonKey ?? undefined;
    if (singletonKey !== undefined) {
      job.singletonKey = singletonKey;
    }
    if (env.resumed !== undefined) {
      job.resumed = env.resumed;
    }
    const deliveries = this.#shared.deliveries;
    deliveries.set(id, { name, rowId: row.id });
    try {
      await worker.handler(job);
    } catch (error) {
      this.#shared.onError(error, job);
      throw error;
    } finally {
      if (deliveries.get(id)?.rowId === row.id) {
        deliveries.delete(id);
      }
    }
  }

  async #send(
    tx: StateContext,
    name: string,
    env: Envelope,
    opts: { startAfter?: Date; singletonKey: string | undefined; retryLimit: number; retryBackoff: boolean },
  ): Promise<string> {
    const options: SendOptions = {
      db: bossDb(tx),
      retryLimit: opts.retryLimit,
      retryDelay: RETRY_DELAY_SECONDS,
      retryBackoff: opts.retryBackoff,
      expireInSeconds: this.#shared.expireInSeconds,
    };
    if (opts.retryBackoff) {
      options.retryDelayMax = MAX_RETRY_DELAY_SECONDS;
    }
    if (opts.startAfter !== undefined) {
      options.startAfter = opts.startAfter;
    }
    if (opts.singletonKey !== undefined) {
      options.singletonKey = opts.singletonKey;
    }
    const rowId = await this.#boss.send(name, { ...env }, options);
    if (rowId === null) {
      throw new Error(`pg-boss did not create a ${name} job`);
    }
    return rowId;
  }

  async #schedule(tx: StateContext, name: JobName, input: unknown, runAt: Date, singletonKey: string | undefined): Promise<{ jobId: string }> {
    if (singletonKey !== undefined) {
      const queued = await this.#lockQueued(tx, singletonKey);
      if (queued !== undefined) {
        const jobId = logicalId(queued);
        const env = envelope({ ...decodeEnvelope(queued.data), id: jobId, data: input });
        if (queued.name === name) {
          await this.#boss.update(name, { ...env }, { id: queued.id, startAfter: runAt, db: bossDb(tx) });
        } else {
          // pg-boss partitions rows by queue, so a new name is a new row under the same logical id.
          await this.#boss.cancel(queued.name, queued.id, { db: bossDb(tx) });
          await this.#send(tx, name, env, { startAfter: runAt, singletonKey, retryLimit: queued.retry_limit, retryBackoff: queued.retry_backoff });
        }
        return { jobId };
      }
    }
    const jobId = ulid(tx.now().getTime());
    const env = envelope(singletonKey === undefined ? { id: jobId, data: input } : { id: jobId, data: input, singletonKey });
    await this.#send(tx, name, env, { startAfter: runAt, singletonKey, retryLimit: DEFAULT_RETRY_LIMIT, retryBackoff: false });
    return { jobId };
  }

  /** Serializes writers of `key` and returns the queued (not parked) row holding it, if any. */
  async #lockQueued(tx: StateContext, key: string): Promise<BossRow | undefined> {
    await lockKey(tx, key);
    const { rows } = await sql<BossRow>`
      select ${BOSS_COLUMNS} from ${this.#job()}
      where singleton_key = ${key} and state in ('created', 'retry')
        and not coalesce(data @> '{"parked": true}'::jsonb, false)
      order by start_after
      limit 1
    `.execute(tx.db);
    return rows[0];
  }

  /** Locks and returns the active row running logical job `jobId`. */
  async #lockActive(tx: StateContext, jobId: string): Promise<BossRow | undefined> {
    const running = this.#shared.deliveries.get(jobId);
    if (running !== undefined) {
      const { rows } = await sql<BossRow>`
        select ${BOSS_COLUMNS} from ${this.#job()}
        where name = ${running.name} and id = ${running.rowId}::uuid and state = 'active'
        for update
      `.execute(tx.db);
      if (rows[0] !== undefined) {
        return rows[0];
      }
    }
    const { rows } = await sql<BossRow>`
      select ${BOSS_COLUMNS} from ${this.#job()}
      where state = 'active' and data @> jsonb_build_object('v', 1, 'id', ${jobId}::text)
      for update
    `.execute(tx.db);
    return rows[0];
  }

  /** The built-in `timer.wait-timeout` handler (ADR 0012, timeout). */
  async #fireWaitTimeout(job: Job): Promise<void> {
    if (!isWaitTimeoutData(job.data)) {
      throw new TypeError(`${WAIT_TIMEOUT_JOB}: bad job data ${JSON.stringify(job.data)}`);
    }
    const data = job.data;
    await inTransaction(this.#shared.root, (tx) => this.#timeOut(tx, data));
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
    await this.#requeueParked(tx, data.jobId, TIMED_OUT);
    return true;
  }

  /** Makes the parked row of logical job `jobId` due now, delivering `result` as `job.resumed`. */
  async #requeueParked(tx: StateContext, jobId: string, result: unknown): Promise<void> {
    const { rows } = await sql<BossRow>`
      select ${BOSS_COLUMNS} from ${this.#job()}
      where state = 'created' and data @> jsonb_build_object('v', 1, 'parked', true, 'id', ${jobId}::text)
      for update
    `.execute(tx.db);
    for (const row of rows) {
      const { parked: _parked, ...rest } = decodeEnvelope(row.data);
      const env = envelope({ ...rest, resumed: { result: result ?? null } });
      await this.#boss.update(row.name, { ...env }, { id: row.id, startAfter: 0, db: bossDb(tx) });
    }
  }
}

/** The pg-boss database adapter for a state context (its transaction, when it is in one). */
function bossDb(tx: StateContext): Db {
  return fromKysely(tx.db);
}

/** The logical id of a row this workflow wrote. */
function logicalId(row: BossRow): string {
  const env = decodeEnvelope(row.data);
  if (env.id === undefined) {
    throw new Error(`pg-boss job ${row.id} carries no logical id`);
  }
  return env.id;
}

/** A transaction-scoped advisory lock on the key, shared with the in-process scheduler's key space. */
async function lockKey(tx: StateContext, key: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${singletonLockKey(key)}))`.execute(tx.db);
}
