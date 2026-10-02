// infra/docker/fixer/wrapper.ts: the container side of the docker runner's contract (main 10.2,
// main 14.3, main 14.5, ADR 0003, ADR 0017 with amendment 1, docs/harness-generic.md).
//
// The fixer image's entrypoint (`entrypoint.ts`) calls `runWrapper` with the container's environment,
// which is exactly what `packages/app/src/providers/docker/runner.ts` passes (`fixerEnv`,
// `reviewEnv`, `modelEnv`) and nothing else. The one mount is `SNAPWING_WORKDIR` (`/work`).
//
// `SNAPWING_ROLE=fixer` (`snapwing-fixer-<runId>`, detached):
//   The work item is prepared in the mount: a checkout on the work branch at `SNAPWING_WORKDIR` and
//   the implementation request at `.git/snapwing/implementation-request.xml` inside it
//   (`FIXER_REQUEST_PATH`, beside the review input of the review role). The wrapper holds the fixer
//   token (`SNAPWING_FIXER_TOKEN`) and is the only thing that talks to the fixer API
//   (`SNAPWING_API_URL`, B 9): it checks Stop before starting, reports `cloned` once it has the
//   checkout, runs the configured harness (`SNAPWING_HARNESS`) through the same adapters the `local`
//   runner uses, posts each checkpoint, polls Stop after every checkpoint and every 5 seconds, and
//   posts `done` or `failed` at the end. A pending Stop, a 409 from the API, or SIGTERM (`docker
//   stop`) ends the harness with SIGTERM, then SIGKILL after the grace. The harness never sees the
//   fixer token. A missing work item is reported as `failed`, so the run degrades instead of hanging
//   until its budget timer.
//
//   Git credential (#266): no git token is in the container's environment. Installation tokens
//   expire after an hour and a run may last longer, so while the harness runs the wrapper serves
//   `GET /git-credential` on a unix socket in a private temp directory
//   (`SNAPWING_GIT_CREDENTIAL_SOCKET`), and git's only credential helper is the image's
//   `git-credential` script, which asks that socket. Each ask makes the wrapper fetch
//   `GET /fixer/{workItemId}/git-token` with the fixer token and answer in git's credential format;
//   the token is held in memory only, never written to a file or put in an argv. The harness can ask
//   the socket too (that is how the agent reads a token for the GitHub API, `git credential fill`),
//   but it gets git tokens from it and nothing else: never the fixer token.
//
// `SNAPWING_ROLE=review` (`snapwing-review-<runId>`, attached):
//   Feeds `SNAPWING_REVIEW_INPUT_FILE` to the configured review harness on stdin, with
//   `SNAPWING_REVIEW_FILE` in its environment, and exits 0 only when the harness finished and the
//   verdict file is a regular file. It reports nothing to the fixer API and holds no credential; the
//   server reads and validates the verdict after the container is gone.
//
// Model access (ADR 0017 amendment 1): no provider key ever enters a container. Each CLI's base URL
// is the model proxy (`SNAPWING_MODEL_PROXY_URL`, which already names the work item) and its key is
// the per-run model token. The wrapper rebuilds the CLI variables from the proxy URL and keeps a key
// variable only when it holds a model token (`swm1.`); anything else, a real provider key passed by
// mistake included, is removed before any harness starts. Without a proxy there is no model access.

import { lstat, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { devNull, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCodeHarness } from '../../../packages/pipeline/src/harness/claude-code/index.ts';
import { createCodexHarness } from '../../../packages/pipeline/src/harness/codex/index.ts';
import { createGeminiHarness } from '../../../packages/pipeline/src/harness/gemini/index.ts';
import { createGenericHarness } from '../../../packages/pipeline/src/harness/generic/index.ts';
import type { HarnessCheckpoint, HarnessPort, HarnessResult, WorkItemRef } from '../../../packages/pipeline/src/ports/harness.ts';

export type Env = Readonly<Record<string, string | undefined>>;

/** The implementation request inside the mounted checkout (fixer role). */
export const FIXER_REQUEST_PATH = '.git/snapwing/implementation-request.xml';
/** The checkout's own hooks, re-pointed with `core.hooksPath` when present. */
export const FIXER_HOOKS_PATH = '.git/snapwing/hooks';
/** Where an image keeps generic harness command templates, one file per template id. */
export const DEFAULT_GENERIC_DIR = '/etc/snapwing/generic';
/** The image's git credential helper: asks the wrapper's socket for a fresh token, never a file. */
export const GIT_CREDENTIAL_HELPER = fileURLToPath(new URL('./git-credential', import.meta.url));
/** Names the wrapper's credential socket in the harness environment. */
export const GIT_CREDENTIAL_SOCKET_ENV = 'SNAPWING_GIT_CREDENTIAL_SOCKET';
/** The username GitHub expects with an installation token over HTTPS. */
const GIT_TOKEN_USERNAME = 'x-access-token';
/** A token the wrapper hands to git: printable ASCII without spaces, so it cannot break the protocol. */
const GIT_TOKEN_SHAPE = /^[\x21-\x7e]{1,4096}$/;
/** Stop poll interval while the harness runs (docs/harness-generic.md section 6). */
export const STOP_POLL_MS = 5000;
/** SIGTERM to SIGKILL grace for the harness; under docker stop's default PT10S so the wrapper exits first. */
export const KILL_GRACE_MS = 8000;
/** A model proxy token (`app/src/model-proxy/token.ts`); a provider key never has this prefix. */
export const MODEL_TOKEN_PREFIX = 'swm1.';

export const MODEL_KEY_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY'] as const;
/** Variables a CLI reads for model access; every one is removed unless the proxy sets it. */
export const MODEL_VARS = [...MODEL_KEY_VARS, 'GOOGLE_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'GOOGLE_GEMINI_BASE_URL'] as const;

export const EXIT_OK = 0;
/** The fixer reported `failed`, or the review produced no verdict. */
export const EXIT_FAILED = 1;
/** The container was started without the contract it needs (unknown role, no API URL, ...). */
export const EXIT_MISCONFIGURED = 2;
/** The fixer could not deliver its final report to the API. */
export const EXIT_UNREPORTED = 3;

export interface WrapperDeps {
  /** The container's environment (`process.env`). */
  env: Env;
  /**
   * The environment the adapters copy model variables from (`process.env` in the image). Its model
   * variables are replaced with `modelAccess(env).vars`, and the fixer token is removed from it,
   * before any harness starts.
   */
  processEnv?: Record<string, string | undefined>;
  /** SIGTERM from `docker stop`. */
  signal: AbortSignal;
  /** Log line to stderr. Never given a token. */
  log?: (line: string) => void;
  fetch?: typeof fetch;
  /** Overrides the adapters (tests). */
  resolveHarness?: (name: string, templateId: string | undefined) => Promise<HarnessPort | string>;
  stopPollMs?: number;
  killGraceMs?: number;
  /** Delays between report retries. Default 1 s, then 3 s. */
  retryDelaysMs?: readonly number[];
  /** Parent of the credential socket's private directory. Default the OS temp directory. */
  gitSocketDir?: string;
}

/**
 * The model variables a harness may see: the proxy base URLs and the model token, or nothing. `notes`
 * names every variable that was removed and why (never a value).
 */
export function modelAccess(env: Env): { vars: Record<string, string>; notes: string[] } {
  const notes: string[] = [];
  const raw = env['SNAPWING_MODEL_PROXY_URL']?.trim() ?? '';
  let proxy: string | undefined;
  if (raw !== '') {
    try {
      const u = new URL(raw);
      if (u.protocol === 'http:' || u.protocol === 'https:') proxy = raw.replace(/\/+$/, '');
    } catch {
      // not a URL
    }
    if (proxy === undefined) notes.push('SNAPWING_MODEL_PROXY_URL is not an http(s) URL; no model access');
  } else {
    notes.push('no model proxy (SNAPWING_MODEL_PROXY_URL); the harness has no model access');
  }

  const vars: Record<string, string> = {};
  if (proxy !== undefined) {
    vars['SNAPWING_MODEL_PROXY_URL'] = proxy;
    vars['ANTHROPIC_BASE_URL'] = `${proxy}/anthropic`;
    vars['OPENAI_BASE_URL'] = `${proxy}/openai/v1`;
    vars['GOOGLE_GEMINI_BASE_URL'] = `${proxy}/google`;
  }
  for (const name of MODEL_VARS) {
    const v = env[name];
    if (v === undefined || v === '' || name in vars) continue;
    const isKey = (MODEL_KEY_VARS as readonly string[]).includes(name);
    if (proxy !== undefined && isKey && v.startsWith(MODEL_TOKEN_PREFIX)) vars[name] = v;
    else if (isKey || name === 'GOOGLE_API_KEY') notes.push(`removed ${name}: ${proxy === undefined ? 'no model proxy' : 'not a model proxy token'}`);
  }
  return { vars, notes };
}

/** Replaces every model variable in `env` (the process environment the adapters copy from) with `vars`. */
export function applyModelAccess(env: Record<string, string | undefined>, vars: Readonly<Record<string, string>>): void {
  for (const name of [...MODEL_VARS, 'SNAPWING_MODEL_PROXY_URL']) delete env[name];
  Object.assign(env, vars);
}

export async function runWrapper(deps: WrapperDeps): Promise<number> {
  const log = deps.log ?? ((line: string) => process.stderr.write(`snapwing-wrapper: ${line}\n`));
  const role = deps.env['SNAPWING_ROLE'];
  if (role !== 'fixer' && role !== 'review') {
    log(`SNAPWING_ROLE must be fixer or review, got ${JSON.stringify(role ?? null)}`);
    return EXIT_MISCONFIGURED;
  }
  const job = readJob(deps.env);
  if (typeof job === 'string') {
    log(job);
    return EXIT_MISCONFIGURED;
  }
  const model = modelAccess(deps.env);
  for (const note of model.notes) log(note);
  if (deps.processEnv !== undefined) {
    applyModelAccess(deps.processEnv, model.vars);
    delete deps.processEnv['SNAPWING_FIXER_TOKEN'];
    // Not set by the runner since #266; never passed on if something else sets it.
    delete deps.processEnv['SNAPWING_GIT_TOKEN'];
  }
  return role === 'fixer' ? runFixer(deps, job, model.vars, log) : runReview(deps, job, model.vars, log);
}

// Private ----------------------------------------------------------------------------------------

interface Job {
  workItem: WorkItemRef;
  workdir: string;
  budget: { wallClock: string; attempts: number };
  harness: string;
  templateId: string | undefined;
}

function readJob(env: Env): Job | string {
  const need = ['SNAPWING_WORK_ITEM_ID', 'SNAPWING_ISSUE_KEY', 'SNAPWING_REPO', 'SNAPWING_WORKDIR', 'SNAPWING_BUDGET_WALL_CLOCK', 'SNAPWING_BUDGET_ATTEMPTS', 'SNAPWING_HARNESS'];
  const missing = need.filter((k) => (env[k] ?? '') === '');
  if (missing.length > 0) return `missing ${missing.join(', ')}`;
  const workdir = env['SNAPWING_WORKDIR'] as string;
  if (!isAbsolute(workdir)) return 'SNAPWING_WORKDIR must be an absolute path';
  const attempts = Number(env['SNAPWING_BUDGET_ATTEMPTS']);
  if (!Number.isSafeInteger(attempts) || attempts < 1) return 'SNAPWING_BUDGET_ATTEMPTS must be a positive integer';
  return {
    workItem: { id: env['SNAPWING_WORK_ITEM_ID'] as string, issueKey: env['SNAPWING_ISSUE_KEY'] as string, repo: env['SNAPWING_REPO'] as string },
    workdir,
    budget: { wallClock: env['SNAPWING_BUDGET_WALL_CLOCK'] as string, attempts },
    harness: env['SNAPWING_HARNESS'] as string,
    templateId: env['SNAPWING_HARNESS_TEMPLATE'],
  };
}

const TEMPLATE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

async function defaultResolve(env: Env, name: string, templateId: string | undefined, graceMs: number): Promise<HarnessPort | string> {
  switch (name) {
    case 'claude-code':
      return createClaudeCodeHarness({ killGraceMs: graceMs });
    case 'codex':
      return createCodexHarness({ killGraceMs: graceMs });
    case 'gemini':
      return createGeminiHarness({ killGraceMs: graceMs });
    case 'generic': {
      if (templateId === undefined || !TEMPLATE_ID.test(templateId)) return `generic harness template id ${JSON.stringify(templateId ?? null)} is not a plain name`;
      const dir = env['SNAPWING_GENERIC_DIR'] ?? DEFAULT_GENERIC_DIR;
      let command: string;
      try {
        command = (await readFile(join(dir, templateId), 'utf8')).trim();
      } catch {
        return `generic harness template ${templateId} is not in this image (${dir}/${templateId})`;
      }
      if (command === '') return `generic harness template ${templateId} is empty`;
      return createGenericHarness({ command, killGraceMs: graceMs });
    }
    default:
      return `unknown harness ${JSON.stringify(name)}`;
  }
}

function resolver(deps: WrapperDeps): (name: string, templateId: string | undefined) => Promise<HarnessPort | string> {
  return deps.resolveHarness ?? ((name, templateId) => defaultResolve(deps.env, name, templateId, deps.killGraceMs ?? KILL_GRACE_MS));
}

/** Git reads only the checkout's own config and never prompts (docs/harness-generic.md section 7). */
const GIT_ENV: Readonly<Record<string, string>> = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' };

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((s) => s.isDirectory(), () => false);
}

// Fixer ------------------------------------------------------------------------------------------

type Reply = { kind: 'ok' } | { kind: 'stop' } | { kind: 'error'; message: string };

async function runFixer(deps: WrapperDeps, job: Job, modelVars: Record<string, string>, log: (l: string) => void): Promise<number> {
  const apiUrl = deps.env['SNAPWING_API_URL']?.trim().replace(/\/+$/, '') ?? '';
  const token = deps.env['SNAPWING_FIXER_TOKEN'] ?? '';
  if (apiUrl === '' || token === '') {
    log('the fixer role needs SNAPWING_API_URL and SNAPWING_FIXER_TOKEN');
    return EXIT_MISCONFIGURED;
  }
  const doFetch = deps.fetch ?? fetch;
  const base = `${apiUrl}/fixer/${encodeURIComponent(job.workItem.id)}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const delays = deps.retryDelaysMs ?? [1000, 3000];

  const call = async (method: 'GET' | 'POST', op: string, body?: unknown): Promise<Reply> => {
    let last = '';
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await sleep(delays[attempt - 1] ?? 0);
      try {
        const init: RequestInit = { method, headers };
        if (body !== undefined) init.body = JSON.stringify(body);
        const res = await doFetch(`${base}/${op}`, init);
        await res.body?.cancel();
        if (op === 'stop' && res.status === 204) return { kind: 'stop' };
        if (res.status === 409) return { kind: 'stop' };
        if (res.ok) return { kind: 'ok' };
        last = `${method} ${op}: HTTP ${res.status}`;
        if (res.status < 500) break;
      } catch (e) {
        last = `${method} ${op}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    return { kind: 'error', message: last };
  };
  const report = async (op: 'done' | 'failed', body: unknown): Promise<number> => {
    const r = await call('POST', op, body);
    if (r.kind === 'error') {
      log(`could not report ${op}: ${r.message}`);
      return EXIT_UNREPORTED;
    }
    return op === 'done' ? EXIT_OK : EXIT_FAILED;
  };
  const fail = (reason: string, attempts = 0): Promise<number> => {
    log(reason);
    return report('failed', { reason, attempts });
  };

  if ((await call('GET', 'stop')).kind === 'stop' || deps.signal.aborted) {
    log('stop pending before the run started');
    return EXIT_OK;
  }

  // The work item in the mount.
  if (!(await isDirectory(join(job.workdir, '.git')))) return fail(`fixer container: no checkout at ${job.workdir}`);
  let request: string;
  try {
    request = await readFile(join(job.workdir, FIXER_REQUEST_PATH), 'utf8');
  } catch {
    return fail(`fixer container: no implementation request at ${FIXER_REQUEST_PATH} in the mount`);
  }
  const harness = await resolver(deps)(job.harness, job.templateId);
  if (typeof harness === 'string') return fail(`fixer container: ${harness}`);

  // Git's one credential helper is the image's script (the empty value first drops any other), and
  // the checkout's own hooks replace the host path its config names.
  const gitConfig: [string, string][] = [
    ['credential.helper', ''],
    ['credential.helper', GIT_CREDENTIAL_HELPER],
  ];
  const hooks = join(job.workdir, FIXER_HOOKS_PATH);
  if (await isDirectory(hooks)) gitConfig.push(['core.hooksPath', hooks]);
  const runEnv: Record<string, string> = { ...GIT_ENV, ...modelVars, GIT_CONFIG_COUNT: String(gitConfig.length) };
  gitConfig.forEach(([key, value], i) => Object.assign(runEnv, { [`GIT_CONFIG_KEY_${i}`]: key, [`GIT_CONFIG_VALUE_${i}`]: value }));
  const prior = deps.env['SNAPWING_PRIOR_REVIEW_FILE'];
  if (prior !== undefined && isAbsolute(prior) && inside(job.workdir, prior)) runEnv['SNAPWING_PRIOR_REVIEW_FILE'] = prior;

  // Stop: the API says so (204 or 409), or docker stop sends SIGTERM.
  const stop = new AbortController();
  const onSignal = (): void => stop.abort();
  deps.signal.addEventListener('abort', onSignal, { once: true });
  const pollStop = async (): Promise<void> => {
    if (stop.signal.aborted) return;
    const r = await call('GET', 'stop');
    if (r.kind === 'stop') {
      log('stop requested');
      stop.abort();
    }
  };
  const checkpoint = async (c: HarnessCheckpoint): Promise<void> => {
    const r = await call('POST', 'checkpoint', c.detail === undefined ? { phase: c.phase } : { phase: c.phase, detail: c.detail });
    if (r.kind === 'stop') stop.abort();
    else if (r.kind === 'error') log(`checkpoint ${c.phase} not delivered: ${r.message}`);
    await pollStop();
  };

  /** A fresh installation token from the fixer API, or undefined (logged without any token). */
  const gitToken = async (): Promise<string | undefined> => {
    let last = '';
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await sleep(delays[attempt - 1] ?? 0);
      try {
        const res = await doFetch(`${base}/git-token`, { method: 'GET', headers });
        if (res.ok) {
          const body = (await res.json().catch(() => undefined)) as { token?: unknown } | undefined;
          const token = body?.token;
          if (typeof token === 'string' && GIT_TOKEN_SHAPE.test(token)) return token;
          log('git token: the fixer API answered without a usable token');
          return undefined;
        }
        await res.body?.cancel();
        last = `HTTP ${res.status}`;
        if (res.status === 409) {
          log('git token refused (409): the run has ended');
          stop.abort();
          return undefined;
        }
        if (res.status < 500) break;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
    }
    log(`git token: ${last}`);
    return undefined;
  };

  await checkpoint({ phase: 'cloned' });
  if (stop.signal.aborted) return EXIT_OK;

  let relay: CredentialRelay;
  try {
    relay = await startCredentialRelay(gitToken, deps.gitSocketDir);
  } catch (e) {
    deps.signal.removeEventListener('abort', onSignal);
    return fail(`fixer container: git credential relay: ${e instanceof Error ? e.message : String(e)}`);
  }
  runEnv[GIT_CREDENTIAL_SOCKET_ENV] = relay.socket;

  const poller = setInterval(() => void pollStop(), deps.stopPollMs ?? STOP_POLL_MS);
  let result: HarnessResult;
  try {
    result = await harness.run(job.workItem, request, job.workdir, { role: 'fixer', budget: job.budget, onCheckpoint: checkpoint, signal: stop.signal, env: runEnv });
  } catch (e) {
    result = { outcome: 'failed', reason: `harness error: ${e instanceof Error ? e.message : String(e)}`, attempts: 1 };
  } finally {
    clearInterval(poller);
    deps.signal.removeEventListener('abort', onSignal);
    await relay.close();
  }

  switch (result.outcome) {
    case 'done':
      if (result.prNumber === undefined) {
        return report('failed', { reason: 'the harness finished without opening a pull request', partialBranch: result.branch, attempts: 1 });
      }
      return report('done', { prNumber: result.prNumber, branch: result.branch, summary: result.summary, testsAdded: result.testsAdded });
    case 'failed':
      log(`harness failed: ${result.reason}`);
      return report('failed', result.partialBranch === undefined ? { reason: result.reason, attempts: result.attempts } : { reason: result.reason, partialBranch: result.partialBranch, attempts: result.attempts });
    case 'stopped':
      // The stop is already in the log; the run only acknowledges it.
      log(`stopped at ${result.atPhase}`);
      return EXIT_OK;
  }
}

// Review -----------------------------------------------------------------------------------------

async function runReview(deps: WrapperDeps, job: Job, modelVars: Record<string, string>, log: (l: string) => void): Promise<number> {
  const inputFile = deps.env['SNAPWING_REVIEW_INPUT_FILE'] ?? '';
  const verdictFile = deps.env['SNAPWING_REVIEW_FILE'] ?? '';
  for (const [name, path] of [['SNAPWING_REVIEW_INPUT_FILE', inputFile], ['SNAPWING_REVIEW_FILE', verdictFile]] as const) {
    if (!isAbsolute(path) || !inside(job.workdir, path)) {
      log(`${name} must be an absolute path inside ${job.workdir}`);
      return EXIT_MISCONFIGURED;
    }
  }
  let input: string;
  try {
    input = await readFile(inputFile, 'utf8');
  } catch {
    log(`no review input at ${inputFile}`);
    return EXIT_FAILED;
  }
  const harness = await resolver(deps)(job.harness, job.templateId);
  if (typeof harness === 'string') {
    log(harness);
    return EXIT_FAILED;
  }

  let result: HarnessResult;
  try {
    result = await harness.run(job.workItem, input, job.workdir, {
      role: 'review',
      budget: job.budget,
      onCheckpoint: () => Promise.resolve(),
      signal: deps.signal,
      env: { ...GIT_ENV, ...modelVars, SNAPWING_REVIEW_FILE: verdictFile },
    });
  } catch (e) {
    log(`review harness error: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_FAILED;
  }
  if (result.outcome !== 'done') {
    log(result.outcome === 'failed' ? `review harness failed: ${result.reason}` : `review harness stopped at ${result.atPhase}`);
    return EXIT_FAILED;
  }
  const written = await lstat(verdictFile).then((s) => s.isFile(), () => false);
  if (!written) {
    log('the review harness wrote no verdict file');
    return EXIT_FAILED;
  }
  return EXIT_OK;
}

// Git credential relay ---------------------------------------------------------------------------

interface CredentialRelay {
  /** The unix socket the `git-credential` helper asks. */
  socket: string;
  close(): Promise<void>;
}

/**
 * Serves `GET /git-credential` on a unix socket in a fresh `0700` directory: each request fetches a
 * token with `fetchToken` and answers in git's credential format (`username=`, `password=`), or 503.
 * The token stays in memory; nothing is cached or written.
 */
async function startCredentialRelay(fetchToken: () => Promise<string | undefined>, parent: string | undefined): Promise<CredentialRelay> {
  const dir = await mkdtemp(join(parent ?? tmpdir(), 'snapwing-git-'));
  const socket = join(dir, 'credential.sock');
  const server = createServer((req, res) => {
    req.resume();
    if (req.method !== 'GET' || req.url !== '/git-credential') {
      res.writeHead(404).end();
      return;
    }
    fetchToken().then(
      (token) => {
        if (token === undefined) res.writeHead(503).end();
        else res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end(`username=${GIT_TOKEN_USERNAME}\npassword=${token}\n`);
      },
      () => res.writeHead(503).end(),
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, () => resolve());
    });
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
  return {
    socket,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
