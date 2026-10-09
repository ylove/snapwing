// `snapwing serve` in-process on the dialect the run selects: boots on an ephemeral port with
// the example config, mounts a composed test route and job, answers /healthz, and on SIGTERM stops
// the API, drains the worker, and closes the state store.

import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StateOptions } from '@snapwing/pipeline/contracts/state.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { openState, type OpenStateHooks } from '@snapwing/pipeline/state/db.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { main } from '../../src/cli/main.ts';
import type { ComposeFn } from '../../src/server/compose.ts';
import { LOCAL_RUNNER_REFUSED, LOCAL_RUNNER_WARNING, localRunnerCheck, runServe, type ServeDeps } from '../../src/server/serve.ts';

const EXAMPLE_CONFIG = fileURLToPath(new URL('../../../../examples/snapwing.config.example.xml', import.meta.url));
/** The real compose needs secrets and a map; the contract test (compose.test.ts) boots it. */
const EMPTY_COMPOSE: ComposeFn = async () => ({ routes: [], jobs: [] });

let tdb: TestDatabase;
let dir: string;

beforeEach(async () => {
  tdb = await createTestDatabase();
  dir = await mkdtemp(join(tmpdir(), 'snapwing-serve-'));
});

afterEach(async () => {
  await tdb.drop();
  await rm(dir, { recursive: true, force: true });
});

function envFor(db: TestDatabase): Record<string, string> {
  return db.dialect === 'postgres'
    ? { SNAPWING_DB: 'postgres', DATABASE_URL: db.options.url ?? '' }
    : { SNAPWING_DB: 'sqlite', SNAPWING_SQLITE_PATH: db.options.url ?? '' };
}

interface Run {
  code: Promise<number>;
  out: string[];
  err: string[];
  signals: EventEmitter;
  ready: Promise<{ url?: string; port?: number }>;
  closed: () => boolean;
}

function start(args: string[], compose?: ComposeFn, env: Record<string, string> = {}): Run {
  const out: string[] = [];
  const err: string[] = [];
  const signals = new EventEmitter();
  let closed = false;
  let markReady!: (info: { url?: string; port?: number }) => void;
  const ready = new Promise<{ url?: string; port?: number }>((r) => (markReady = r));
  const deps: ServeDeps = {
    signals,
    onReady: markReady,
    // The real openState, with close() observed.
    openState: async (options: StateOptions, hooks?: OpenStateHooks): Promise<OpenedState> => {
      const opened = await openState(options, hooks);
      const close = opened.close.bind(opened);
      opened.close = async () => {
        closed = true;
        await close();
      };
      return opened;
    },
    ...(compose === undefined ? {} : { compose }),
  };
  const code = runServe(
    args,
    { env: { ...envFor(tdb), SNAPWING_ENV_FILE: join(dir, 'absent.env'), ...env }, stdout: (l) => out.push(l), stderr: (l) => err.push(l) },
    deps,
  );
  // Surface a startup failure instead of waiting on `ready` forever.
  void code.then((c) => markReady({ ...(c === 0 ? {} : { url: `failed:${err.join('\n')}` }) }));
  return { code, out, err, signals, ready, closed: () => closed };
}

describe('snapwing serve', () => {
  it('boots API and worker, serves /healthz and a composed route, runs a composed job, and stops on SIGTERM', async () => {
    let received: Uint8Array | undefined;
    const ran: unknown[] = [];
    const compose: ComposeFn = async ({ workflow }) => ({
      routes: [
        {
          method: 'POST',
          path: '/test/echo',
          handler: async (req) => {
            received = new Uint8Array(await req.arrayBuffer());
            await workflow.start('reconcile', { from: 'route' }, {});
            return new Response(null, { status: 202 });
          },
        },
      ],
      jobs: [
        {
          name: 'reconcile',
          handler: async (job) => {
            ran.push(job.data);
          },
        },
      ],
    });
    const run = start(['--port', '0', '--host', '127.0.0.1', '--config', EXAMPLE_CONFIG], compose, { SNAPWING_OPS_TOKEN: 'ops-token-for-tests-0123456789' });
    const { url } = await run.ready;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const health = await fetch(`${url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
    // #272: the metrics take the ops token.
    expect((await fetch(`${url}/metrics`)).status).toBe(401);
    const metrics = await fetch(`${url}/metrics`, { headers: { authorization: 'Bearer ops-token-for-tests-0123456789' } });
    expect(metrics.status).toBe(200);
    const metricsText = await metrics.text();
    expect(metricsText).toContain('snapwing_jobs_parked 0');
    expect(metricsText).toContain('snapwing_event_log_watermark_lag_rows 0');

    const body = Uint8Array.from([0x00, 0xff, 0x0d, 0x0a, 0x41]);
    const posted = await fetch(`${url}/test/echo`, { method: 'POST', body });
    expect(posted.status).toBe(202);
    expect(received).toEqual(body);
    await vi.waitFor(() => expect(ran).toHaveLength(1), { timeout: 15_000, interval: 25 });
    expect(ran).toEqual([{ from: 'route' }]);

    expect(run.closed()).toBe(false);
    run.signals.emit('SIGTERM');
    expect(await run.code).toBe(0);
    expect(run.closed()).toBe(true);
    // The example config uses the local runner, which always warns (ADR 0017).
    expect(run.err).toEqual([`snapwing serve: ${LOCAL_RUNNER_WARNING}`]);
    expect(run.out.join('\n')).toContain('SIGTERM: shutting down');
    expect(run.out.join('\n')).not.toContain('SNAPWING_OPS_TOKEN is not set');
    await expect(fetch(`${url}/healthz`)).rejects.toThrow();
  });

  it('says once that /metrics is closed when SNAPWING_OPS_TOKEN is not set', async () => {
    const run = start(['--port', '0', '--host', '127.0.0.1', '--config', EXAMPLE_CONFIG], EMPTY_COMPOSE);
    const { url } = await run.ready;
    expect((await fetch(`${url}/metrics`, { headers: { authorization: 'Bearer anything' } })).status).toBe(401);
    run.signals.emit('SIGTERM');
    expect(await run.code).toBe(0);
    expect(run.out.filter((l) => l.includes('SNAPWING_OPS_TOKEN is not set'))).toHaveLength(1);
  });

  it('runs the worker alone with --worker and still closes the store on SIGTERM', async () => {
    const run = start(['--worker', '--config', EXAMPLE_CONFIG], EMPTY_COMPOSE);
    const info = await run.ready;
    expect(info.url).toBeUndefined();
    expect(run.out.join('\n')).toContain('worker polling');
    run.signals.emit('SIGTERM');
    expect(await run.code).toBe(0);
    expect(run.closed()).toBe(true);
  });

  it('exits 1 without opening the store when the config is missing or invalid', async () => {
    const missing = start(['--config', join(dir, 'nope.xml')]);
    expect(await missing.code).toBe(1);
    expect(missing.err.join('\n')).toContain('cannot read config');
    expect(missing.closed()).toBe(false);

    const bad = join(dir, 'bad.xml');
    await writeFile(bad, '<snapwing xmlns="urn:snapwing:config:v1" version="1"><runtime provider="mars"/></snapwing>');
    const invalid = start(['--config', bad]);
    expect(await invalid.code).toBe(1);
    expect(invalid.err.join('\n')).toContain('is not valid');
  });

  it('refuses the local runner with NODE_ENV=production, before opening the store', async () => {
    const run = start(['--config', EXAMPLE_CONFIG], undefined, { NODE_ENV: 'production' });
    expect(await run.code).toBe(1);
    expect(run.err.join('\n')).toContain(LOCAL_RUNNER_REFUSED);
    expect(run.err.join('\n')).toContain('--allow-local-runner');
    expect(run.closed()).toBe(false);
    expect(run.out.join('\n')).not.toContain('state open');
  });

  it('starts the local runner in production with --allow-local-runner, and warns', async () => {
    const run = start(['--worker', '--allow-local-runner', '--config', EXAMPLE_CONFIG], EMPTY_COMPOSE, { NODE_ENV: 'production' });
    await run.ready;
    expect(run.out.join('\n')).toContain('worker polling');
    expect(run.err).toEqual([`snapwing serve: ${LOCAL_RUNNER_WARNING}`]);
    run.signals.emit('SIGTERM');
    expect(await run.code).toBe(0);
  });

  it('decides the local runner policy from the provider, NODE_ENV, and the flag', () => {
    expect(localRunnerCheck('docker', { NODE_ENV: 'production' }, false)).toBeUndefined();
    expect(localRunnerCheck('local', { NODE_ENV: 'production' }, false)).toEqual({ refuse: LOCAL_RUNNER_REFUSED });
    expect(localRunnerCheck('local', { NODE_ENV: ' production ' }, false)).toEqual({ refuse: LOCAL_RUNNER_REFUSED });
    expect(localRunnerCheck('local', { NODE_ENV: 'production' }, true)).toEqual({ warn: LOCAL_RUNNER_WARNING });
    expect(localRunnerCheck('local', { NODE_ENV: 'development' }, false)).toEqual({ warn: LOCAL_RUNNER_WARNING });
    expect(localRunnerCheck('local', {}, false)).toEqual({ warn: LOCAL_RUNNER_WARNING });
  });

  it('is reachable from the CLI and prints its usage', async () => {
    const out: string[] = [];
    const code = await main(['serve', '--help'], { env: {}, stdout: (l) => out.push(l), stderr: () => undefined });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('snapwing serve [--api] [--worker]');
    expect(out.join('\n')).toContain('--allow-local-runner');
  });
});
