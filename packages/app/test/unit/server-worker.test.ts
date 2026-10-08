// createWorker and the ops routes on the dialect the run selects: the in-process scheduler
// on SQLite, pg-boss on Postgres, as `snapwing serve` picks them. Both poll on a real clock, so the
// tests poll for effects with `until`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '@snapwing/pipeline/ports/workflow.ts';
import { StateStore } from '@snapwing/pipeline/state/store.ts';
import { InProcessWorkflow } from '@snapwing/pipeline/workflow/inprocess/index.ts';
import { PgBossWorkflow } from '@snapwing/pipeline/workflow/pgboss/index.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { opsRoutes, PROMETHEUS_CONTENT_TYPE } from '../../src/server/ops.ts';
import { createApiServer } from '../../src/server/http.ts';
import { createWorker, DuplicateJobModuleError, type PollingWorkflow, type Worker } from '../../src/server/worker.ts';

let tdb: TestDatabase;
let state: StateStore;
let workflow: PollingWorkflow;
let worker: Worker | undefined;

beforeEach(async () => {
  tdb = await createTestDatabase();
  const s = await tdb.open();
  if (!(s instanceof StateStore)) {
    throw new Error('expected a StateStore');
  }
  state = s;
  workflow =
    s.dialect === 'postgres' ? new PgBossWorkflow(s, { schema: 'pgboss', pollingIntervalSeconds: 0.5 }) : new InProcessWorkflow(s, { pollIntervalMs: 10 });
  worker = undefined;
});

afterEach(async () => {
  await (worker?.stop() ?? workflow.stop());
  await tdb.drop();
});

async function until<T>(probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('until: timed out');
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('createWorker', () => {
  it('runs a test job through the worker', async () => {
    const seen: Job[] = [];
    worker = await createWorker({
      workflow,
      jobs: [
        {
          name: 'reconcile',
          handler: async (job) => {
            seen.push(job);
          },
          concurrency: 2,
        },
      ],
    });
    expect(worker.names).toEqual(['reconcile']);
    const { jobId } = await workflow.start('reconcile', { scope: 'test' }, {});
    const job = await until(() => seen[0]);
    expect(job.id).toBe(jobId);
    expect(job.data).toEqual({ scope: 'test' });
  });

  it('stop() waits for the handler in flight to finish', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    let finished = false;
    worker = await createWorker({
      workflow,
      jobs: [
        {
          name: 'incident.process',
          handler: async () => {
            started = true;
            await gate;
            finished = true;
          },
        },
      ],
    });
    await workflow.start('incident.process', {}, {});
    await until(() => (started ? true : undefined));
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(finished).toBe(true);
  });

  it('refuses two modules for one job name', async () => {
    const handler = async (): Promise<void> => undefined;
    await expect(
      createWorker({
        workflow,
        jobs: [
          { name: 'reconcile', handler },
          { name: 'reconcile', handler },
        ],
      }),
    ).rejects.toBeInstanceOf(DuplicateJobModuleError);
  });
});

describe('ops routes', () => {
  it('/healthz is 503 before the store is open and 200 once it is', async () => {
    let current: StateStore | undefined;
    const api = createApiServer({ routes: opsRoutes({ state: () => current }), port: 0, host: '127.0.0.1' });
    const { url } = await api.start();
    try {
      expect((await fetch(`${url}/healthz`)).status).toBe(503);
      current = state;
      const ok = await fetch(`${url}/healthz`);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true });
    } finally {
      await api.stop();
    }
  });

  it('/metrics reports outbox depth and oldest age per target and the parked job count', async () => {
    const now = Date.now();
    const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();
    const item = (id: string, target: 'jira' | 'slack', msAgo: number): Parameters<StateStore['enqueueOutbox']>[0] => ({
      id,
      workspaceId: '01JZ0000000000000000000001',
      target,
      op: 'add-comment',
      payload: {},
      attempts: 0,
      nextAttempt: iso(msAgo),
      createdAt: iso(msAgo),
    });
    await state.enqueueOutbox(item('01JZ00000000000000000000J1', 'jira', 120_000));
    await state.enqueueOutbox(item('01JZ00000000000000000000J2', 'jira', 30_000));
    await state.enqueueOutbox(item('01JZ00000000000000000000S1', 'slack', 10_000));
    await state.enqueueOutbox(item('01JZ00000000000000000000S2', 'slack', 600_000));
    await state.ackOutbox(['01JZ00000000000000000000S2']);

    // A job that parks on a tap, through the worker, so the count comes from a real park.
    worker = await createWorker({
      workflow,
      jobs: [{ name: 'incident.process', handler: (job) => workflow.park(job.id, { kind: 'tap', eventId: '01JZ0000000000000000000E01' }) }],
    });
    await workflow.start('incident.process', {}, {});

    const routes = opsRoutes({ state: () => state });
    const metrics = routes.find((r) => r.path === '/metrics');
    if (metrics === undefined) {
      throw new Error('no /metrics route');
    }
    const read = async (): Promise<string> => {
      const res = await metrics.handler(new Request('http://local/metrics'), { params: {} });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(PROMETHEUS_CONTENT_TYPE);
      return res.text();
    };
    const body = await until(async () => {
      const text = await read();
      return text.includes('snapwing_jobs_parked 1') ? text : undefined;
    });
    expect(body).toContain('# TYPE snapwing_outbox_depth gauge');
    expect(body).toContain('snapwing_outbox_depth{target="jira"} 2');
    expect(body).toContain('snapwing_outbox_depth{target="slack"} 1');
    expect(body).toContain('snapwing_outbox_depth{target="github"} 0');
    expect(body).toContain('snapwing_outbox_oldest_age_seconds{target="github"} 0');
    const age = (target: string): number => Number(new RegExp(`snapwing_outbox_oldest_age_seconds\\{target="${target}"\\} ([0-9.]+)`).exec(body)?.[1]);
    expect(age('jira')).toBeGreaterThanOrEqual(120);
    expect(age('jira')).toBeLessThan(180);
    // The acked slack row is ten minutes old but drained, so it does not count.
    expect(age('slack')).toBeGreaterThanOrEqual(10);
    expect(age('slack')).toBeLessThan(60);
  });
});
