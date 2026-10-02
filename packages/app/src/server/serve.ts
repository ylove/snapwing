// `snapwing serve [--api] [--worker]` (main 14.1, main 14.3, B 10): the API process, the worker
// process, or both in one (the default, and the `local` provider's shape).
//
// Startup: load `snapwing.config.xml` (XSD, then typed parse), the local `.env` secrets provider,
// open the state store (`stateOptionsFromEnv`; migrations run on open), build the workflow for the
// dialect (in-process on SQLite, pg-boss on Postgres), call `compose`, then start the worker and
// the API. Any startup failure closes what was opened and exits 1.
//
// The `local` runtime provider runs the fixer and the repository's tests (untrusted code) on this
// host as the server's own OS user (ADR 0017). With NODE_ENV=production serve refuses it unless
// `--allow-local-runner` is passed; whenever it runs with it, it prints a warning to stderr.
//
// Shutdown on SIGTERM or SIGINT, in order: the API stops accepting and finishes requests in flight;
// the worker stops polling and drains its running handlers; the state store closes. Exit 0.

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadAppConfig, validateAppConfig, type AppConfig } from '@snapwing/pipeline/config/app-config.ts';
import { stateOptionsFromEnv, type StateOptions } from '@snapwing/pipeline/contracts/state.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { createEnvFileSecrets } from '@snapwing/pipeline/providers/local/secrets.ts';
import { openState as defaultOpenState, type OpenStateHooks } from '@snapwing/pipeline/state/db.ts';
import { StateStore } from '@snapwing/pipeline/state/store.ts';
import { InProcessWorkflow } from '@snapwing/pipeline/workflow/inprocess/index.ts';
import { PgBossWorkflow } from '@snapwing/pipeline/workflow/pgboss/index.ts';
import type { CliIo } from '../cli/state.ts';
import { compose as defaultCompose, type ComposeFn } from './compose.ts';
import { createApiServer, type ApiServer } from './http.ts';
import { opsRoutes } from './ops.ts';
import { createWorker, type PollingWorkflow, type Worker } from './worker.ts';

export const SERVE_USAGE = `Usage: snapwing serve [--api] [--worker] [--port <n>] [--host <addr>] [--config <file>] [--env-file <file>] [--allow-local-runner]

  --api            run the API process (HTTP routes, /healthz, /metrics)
  --worker         run the worker process (job handlers on the workflow)
                   with neither flag, both run in this process
  --port <n>       API port; default $PORT, else 3000 (0 picks a free port)
  --host <addr>    API bind address; default $HOST, else 0.0.0.0
  --config <file>  app config; default $SNAPWING_CONFIG, else snapwing.config.xml
  --env-file <f>   secrets file for the local provider; default $SNAPWING_ENV_FILE, else .env
  --allow-local-runner
                   start with <runtime provider="local"> even when NODE_ENV=production; the
                   local runner runs untrusted fixer code on this host (ADR 0017)

Environment: SNAPWING_DB=sqlite|postgres, DATABASE_URL (postgres), SNAPWING_SQLITE_PATH (sqlite file),
NODE_ENV (production refuses the local runner without --allow-local-runner).
Stops cleanly on SIGTERM or SIGINT.`;

export const DEFAULT_PORT = 3000;
export const DEFAULT_CONFIG_PATH = 'snapwing.config.xml';
export const DEFAULT_ENV_FILE = '.env';

export type ShutdownSignal = 'SIGTERM' | 'SIGINT';

/** Printed to stderr whenever serve starts with the `local` runtime provider. */
export const LOCAL_RUNNER_WARNING =
  'warning: runtime provider "local" runs the fixer and pull request tests (untrusted code) on this host as this ' +
  'OS user, able to read any file this user can. It is for development only (ADR 0017); where real secrets are ' +
  'held, use <runtime provider="docker"> or another container or VM provider.';

/** The startup error for the `local` provider under NODE_ENV=production without --allow-local-runner. */
export const LOCAL_RUNNER_REFUSED =
  'refusing to start: runtime provider "local" runs untrusted fixer code on this host and NODE_ENV is production. ' +
  'Use <runtime provider="docker"> (ADR 0017), or pass --allow-local-runner to accept the risk.';

/**
 * The `local` runner policy (ADR 0017): an error to refuse startup with, a warning to print, or nothing
 * for another provider.
 */
export function localRunnerCheck(
  provider: string,
  env: Readonly<Record<string, string | undefined>>,
  allowLocalRunner: boolean,
): { refuse: string } | { warn: string } | undefined {
  if (provider !== 'local') return undefined;
  if (env['NODE_ENV']?.trim() === 'production' && !allowLocalRunner) return { refuse: LOCAL_RUNNER_REFUSED };
  return { warn: LOCAL_RUNNER_WARNING };
}

/** The part of `process` serve listens on; tests pass an EventEmitter. */
export interface SignalSource {
  once(event: ShutdownSignal, listener: () => void): unknown;
  off(event: ShutdownSignal, listener: () => void): unknown;
}

export interface ServeDeps {
  openState?: (options: StateOptions, hooks?: OpenStateHooks) => Promise<OpenedState>;
  compose?: ComposeFn;
  signals?: SignalSource;
  /** Called once everything requested is running; `url` is the API's base URL when the API runs. */
  onReady?: (info: { url?: string; port?: number }) => void;
}

/** Runs `snapwing serve <args>` until a shutdown signal and returns the exit code. */
export async function runServe(args: readonly string[], io: CliIo, deps: ServeDeps = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: false,
      options: {
        api: { type: 'boolean', default: false },
        worker: { type: 'boolean', default: false },
        port: { type: 'string' },
        host: { type: 'string' },
        config: { type: 'string' },
        'env-file': { type: 'string' },
        'allow-local-runner': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    io.stderr(`snapwing serve: ${errorMessage(e)}\n${SERVE_USAGE}`);
    return 1;
  }
  const v = parsed.values;
  if (v.help) {
    io.stdout(SERVE_USAGE);
    return 0;
  }
  const both = !v.api && !v.worker;
  const runApi = both || v.api;
  const runWorker = both || v.worker;
  const port = parsePort(v.port ?? nonEmpty(io.env['PORT']) ?? String(DEFAULT_PORT));
  if (port === undefined) {
    io.stderr(`snapwing serve: --port must be an integer from 0 to 65535\n${SERVE_USAGE}`);
    return 1;
  }
  const host = v.host ?? nonEmpty(io.env['HOST']) ?? '0.0.0.0';
  const configPath = v.config ?? nonEmpty(io.env['SNAPWING_CONFIG']) ?? DEFAULT_CONFIG_PATH;
  const envFile = v['env-file'] ?? nonEmpty(io.env['SNAPWING_ENV_FILE']) ?? DEFAULT_ENV_FILE;
  const signals = deps.signals ?? process;
  const log = (line: string): void => io.stdout(`snapwing serve: ${line}`);

  // Listen for the signal before anything starts, so one that arrives during startup still stops us.
  let onSignal: ((signal: ShutdownSignal) => void) | undefined;
  let received: ShutdownSignal | undefined;
  const signalled = new Promise<ShutdownSignal>((resolve) => {
    onSignal = (signal) => {
      received ??= signal;
      resolve(signal);
    };
  });
  const onTerm = (): void => onSignal?.('SIGTERM');
  const onInt = (): void => onSignal?.('SIGINT');
  signals.once('SIGTERM', onTerm);
  signals.once('SIGINT', onInt);

  let state: OpenedState | undefined;
  let workflow: PollingWorkflow | undefined;
  let worker: Worker | undefined;
  let api: ApiServer | undefined;
  let code = 0;
  try {
    const config = await loadConfig(configPath);
    const runnerCheck = localRunnerCheck(config.runtime.provider, io.env, v['allow-local-runner']);
    if (runnerCheck !== undefined && 'refuse' in runnerCheck) throw new Error(runnerCheck.refuse);
    if (runnerCheck !== undefined) io.stderr(`snapwing serve: ${runnerCheck.warn}`);
    const secrets = createEnvFileSecrets({ path: envFile, fallbackEnv: io.env });

    const options = stateOptionsFromEnv(io.env);
    const sqlitePath = nonEmpty(io.env['SNAPWING_SQLITE_PATH']);
    if (options.dialect === 'sqlite' && sqlitePath !== undefined) {
      options.url = sqlitePath;
    }
    const open = deps.openState ?? defaultOpenState;
    const opened = await open(options, { onPoolError: (e) => io.stderr(`snapwing serve: postgres pool: ${e.message}`) });
    state = opened;
    log(`state open (${opened.dialect}), config ${configPath} (runtime ${config.runtime.provider})`);

    workflow = createWorkflow(opened, (e) => io.stderr(`snapwing serve: job error: ${errorMessage(e)}`));
    const composed = await (deps.compose ?? defaultCompose)({ config, secrets, state: opened, workflow, env: io.env });

    if (received === undefined && runWorker) {
      worker = await createWorker({ workflow, jobs: composed.jobs });
      log(`worker polling (${worker.names.length} job types)`);
    }
    let url: string | undefined;
    let boundPort: number | undefined;
    if (received === undefined && runApi) {
      api = createApiServer({
        routes: [...opsRoutes({ state: () => state }), ...composed.routes],
        port,
        host,
        onError: (e, req) => io.stderr(`snapwing serve: ${req.method} ${req.path} failed: ${errorMessage(e)}`),
      });
      const bound = await api.start();
      url = bound.url;
      boundPort = bound.port;
      log(`api listening on ${bound.url} (${composed.routes.length + 2} routes)`);
    }
    deps.onReady?.({ ...(url === undefined ? {} : { url }), ...(boundPort === undefined ? {} : { port: boundPort }) });

    const signal = await signalled;
    log(`${signal}: shutting down`);
  } catch (e) {
    io.stderr(`snapwing serve: ${errorMessage(e)}`);
    code = 1;
  } finally {
    signals.off('SIGTERM', onTerm);
    signals.off('SIGINT', onInt);
    code = (await shutdown({ api, worker, workflow, state, io })) ? code : 1;
    state = undefined;
  }
  if (code === 0) {
    log('stopped');
  }
  return code;
}

/** Stops the API, then the worker (or the idle workflow), then closes the store. False if a step failed. */
async function shutdown(parts: {
  api: ApiServer | undefined;
  worker: Worker | undefined;
  workflow: PollingWorkflow | undefined;
  state: OpenedState | undefined;
  io: CliIo;
}): Promise<boolean> {
  let ok = true;
  const step = async (what: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      ok = false;
      parts.io.stderr(`snapwing serve: ${what}: ${errorMessage(e)}`);
    }
  };
  const { api, worker, workflow, state } = parts;
  if (api !== undefined) {
    await step('stopping the api', () => api.stop());
  }
  if (worker !== undefined) {
    await step('draining the worker', () => worker.stop());
  } else if (workflow !== undefined) {
    // An API-only process still starts jobs; pg-boss boots on the first one and must stop too.
    await step('stopping the workflow', () => workflow.stop());
  }
  if (state !== undefined) {
    await step('closing the state store', () => state.close());
  }
  return ok;
}

function createWorkflow(state: OpenedState, onError: (e: unknown) => void): PollingWorkflow {
  if (!(state instanceof StateStore)) {
    throw new Error('serve needs the store openState returned');
  }
  return state.dialect === 'postgres' ? new PgBossWorkflow(state, { schema: 'pgboss', onError }) : new InProcessWorkflow(state, { onError });
}

async function loadConfig(path: string): Promise<AppConfig> {
  let xml: string;
  try {
    xml = await readFile(path, 'utf8');
  } catch (e) {
    throw new Error(`cannot read config ${path}: ${errorMessage(e)}`, { cause: e });
  }
  const result = await validateAppConfig(xml);
  if (!result.valid) {
    const details = result.errors.map((e) => (e.line === undefined ? e.message : `line ${e.line}: ${e.message}`)).join('; ');
    throw new Error(`config ${path} is not valid: ${details}`);
  }
  return loadAppConfig(xml);
}

function parsePort(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) {
    return undefined;
  }
  const n = Number(raw);
  return n <= 65535 ? n : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
