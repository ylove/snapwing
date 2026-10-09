// infra/docker/fixer/wrapper.ts: the container side of the docker runner's contract (main 10.2,
// main 14.3, main 14.5, ADR 0003, ADR 0017 with amendment 1, docs/harness-generic.md).
//
// The fixer image's entrypoint (`entrypoint.ts`) calls `runWrapper` with the container's environment,
// which is exactly what `packages/app/src/providers/docker/runner.ts` passes (`fixerEnv`,
// `reviewEnv`, `modelEnv`) and nothing else. The mounts are `SNAPWING_WORKDIR` (`/work`) and, for a
// fixer, the hand-off directory (`/out`).
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
//   No GitHub credential of any kind is in the container (#262). The harness commits on the work
//   branch and never pushes. Once it has ended with `done` (or `failed` with a partial branch), the
//   wrapper writes `git bundle create <SNAPWING_HANDOFF_FILE> <SNAPWING_BASE_SHA>..refs/heads/
//   <SNAPWING_WORK_BRANCH>` into `/out` (pipeline/src/fixer/workdir/handoff.ts) and posts the report.
//   The server imports the bundle, checks it, pushes the work branch, and opens the pull request
//   (app/src/fixer-api/handoff.ts). When it refuses the hand-off (409 `handoff-refused`), the wrapper
//   posts `failed` with the server's reason.
//
// `SNAPWING_ROLE=review` (`snapwing-review-<runId>`, attached):
//   Feeds `SNAPWING_REVIEW_INPUT_FILE` to the configured review harness on stdin. Nothing in this
//   container runs the pull request's code (#263): the built-in adapters give the agent read-only
//   tools and take its verdict from its final message, and the tests run in test containers of their
//   own (`runTests`). The harness never learns `SNAPWING_REVIEW_FILE`, the path in the mount the server
//   reads: its `SNAPWING_REVIEW_FILE` names a file in a private directory outside the mount. Once the
//   harness has exited, the wrapper copies that file, if it is a small regular file, to the mount path,
//   replacing whatever is there, and exits 0; otherwise it exits non-zero. It reports nothing to the
//   fixer API and holds no credential; the server reads and validates the verdict after the container
//   is gone.
//
// Model access (ADR 0017 amendment 1): no provider key ever enters a container. Each CLI's base URL
// is the model proxy (`SNAPWING_MODEL_PROXY_URL`, which already names the work item) and its key is
// the per-run model token. The wrapper rebuilds the CLI variables from the proxy URL and keeps a key
// variable only when it holds a model token (`swm1.`); anything else, a real provider key passed by
// mistake included, is removed before any harness starts. Without a proxy there is no model access.

import { constants } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { bundleWork } from '../../../packages/pipeline/src/fixer/workdir/handoff.ts';
import { createClaudeCodeHarness } from '../../../packages/pipeline/src/harness/claude-code/index.ts';
import { createCodexHarness } from '../../../packages/pipeline/src/harness/codex/index.ts';
import { createGeminiHarness } from '../../../packages/pipeline/src/harness/gemini/index.ts';
import { createGenericHarness } from '../../../packages/pipeline/src/harness/generic/index.ts';
import type { HarnessCheckpoint, HarnessPort, HarnessResult, WorkItemRef } from '../../../packages/pipeline/src/ports/harness.ts';
import { REVIEW_FILE_ENV } from '../../../packages/pipeline/src/review/verdict.ts';

export type Env = Readonly<Record<string, string | undefined>>;

/** The implementation request inside the mounted checkout (fixer role). */
export const FIXER_REQUEST_PATH = '.git/snapwing/implementation-request.xml';
/** The checkout's own hooks, re-pointed with `core.hooksPath` when present. */
export const FIXER_HOOKS_PATH = '.git/snapwing/hooks';
/** Where an image keeps generic harness command templates, one file per template id. */
export const DEFAULT_GENERIC_DIR = '/etc/snapwing/generic';
/** Stop poll interval while the harness runs (docs/harness-generic.md section 6). */
export const STOP_POLL_MS = 5000;
/** SIGTERM to SIGKILL grace for the harness; under docker stop's default PT10S so the wrapper exits first. */
export const KILL_GRACE_MS = 8000;
/** Largest verdict file copied to the mount, in bytes; the review job reads no more back (MAX_VERDICT_BYTES). */
export const MAX_VERDICT_BYTES = 1024 * 1024;
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
  /** Parent of the review harness's private verdict directory. Default the OS temp directory. */
  reviewDir?: string;
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
    // No runner sets a git token (#262); never passed on if something else does.
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

/** Where and what the fixer hands back (#262): the work branch since its base, as a bundle file in `/out`. */
interface Handoff {
  branch: string;
  expectedBase: string;
  file: string;
}

const HANDOFF_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const HANDOFF_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function readHandoff(env: Env, workdir: string): Handoff | string {
  const branch = env['SNAPWING_WORK_BRANCH'] ?? '';
  const expectedBase = env['SNAPWING_BASE_SHA'] ?? '';
  const file = env['SNAPWING_HANDOFF_FILE'] ?? '';
  if (!HANDOFF_BRANCH.test(branch) || branch.includes('..')) return 'the fixer role needs SNAPWING_WORK_BRANCH, a plain branch name';
  if (!HANDOFF_SHA.test(expectedBase)) return 'the fixer role needs SNAPWING_BASE_SHA, a commit id';
  if (!isAbsolute(file) || file === workdir || inside(workdir, file)) return 'the fixer role needs SNAPWING_HANDOFF_FILE, an absolute path outside the checkout';
  return { branch, expectedBase, file };
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

/** A 409 is a stop, except `handoff-refused` on `done`, which carries the server's reason. */
type Reply = { kind: 'ok' } | { kind: 'stop' } | { kind: 'refused'; reason: string } | { kind: 'error'; message: string };

async function runFixer(deps: WrapperDeps, job: Job, modelVars: Record<string, string>, log: (l: string) => void): Promise<number> {
  const apiUrl = deps.env['SNAPWING_API_URL']?.trim().replace(/\/+$/, '') ?? '';
  const token = deps.env['SNAPWING_FIXER_TOKEN'] ?? '';
  if (apiUrl === '' || token === '') {
    log('the fixer role needs SNAPWING_API_URL and SNAPWING_FIXER_TOKEN');
    return EXIT_MISCONFIGURED;
  }
  const handoff = readHandoff(deps.env, job.workdir);
  if (typeof handoff === 'string') {
    log(handoff);
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
        if (res.status === 409) {
          const answer = (await res.json().catch(() => undefined)) as { error?: unknown; reason?: unknown } | undefined;
          if (op === 'done' && answer?.error === 'handoff-refused') {
            return { kind: 'refused', reason: typeof answer.reason === 'string' ? answer.reason.slice(0, 2000) : 'no reason given' };
          }
          return { kind: 'stop' };
        }
        await res.body?.cancel();
        if (op === 'stop' && res.status === 204) return { kind: 'stop' };
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
    if (r.kind === 'refused') {
      // The server recorded nothing; the run ends as a failure with its reason.
      log(`hand-off refused: ${r.reason}`);
      return report('failed', { reason: `handoff refused: ${r.reason}`, attempts: 1 });
    }
    return op === 'done' ? EXIT_OK : EXIT_FAILED;
  };
  /** The bundle of the work branch for the server (#262); without one the server refuses the hand-off. */
  const bundle = async (): Promise<boolean> => {
    try {
      await bundleWork({ checkout: job.workdir, branch: handoff.branch, expectedBase: handoff.expectedBase, file: handoff.file, env: pathEnv() });
      return true;
    } catch (e) {
      log(`no bundle of ${handoff.branch}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
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

  // The checkout's own hooks replace the host path its config names. No credential helper, no token:
  // nothing in here can push (#262).
  const gitConfig: [string, string][] = [];
  const hooks = join(job.workdir, FIXER_HOOKS_PATH);
  if (await isDirectory(hooks)) gitConfig.push(['core.hooksPath', hooks]);
  const runEnv: Record<string, string> = { ...GIT_ENV, ...modelVars };
  if (gitConfig.length > 0) runEnv['GIT_CONFIG_COUNT'] = String(gitConfig.length);
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

  await checkpoint({ phase: 'cloned' });
  if (stop.signal.aborted) {
    deps.signal.removeEventListener('abort', onSignal);
    return EXIT_OK;
  }

  const poller = setInterval(() => void pollStop(), deps.stopPollMs ?? STOP_POLL_MS);
  let result: HarnessResult;
  try {
    result = await harness.run(job.workItem, request, job.workdir, { role: 'fixer', budget: job.budget, onCheckpoint: checkpoint, signal: stop.signal, env: runEnv });
  } catch (e) {
    result = { outcome: 'failed', reason: `harness error: ${e instanceof Error ? e.message : String(e)}`, attempts: 1 };
  } finally {
    clearInterval(poller);
    deps.signal.removeEventListener('abort', onSignal);
  }

  switch (result.outcome) {
    case 'done':
      // The branch and any pull request number the harness names are not reported: the server pushes
      // the run's own branch from the bundle and opens the pull request itself.
      await bundle();
      return report('done', { summary: result.summary, testsAdded: result.testsAdded });
    case 'failed':
      log(`harness failed: ${result.reason}`);
      if (result.partialBranch !== undefined && (await bundle())) {
        return report('failed', { reason: result.reason, partialBranch: handoff.branch, attempts: result.attempts });
      }
      return report('failed', { reason: result.reason, attempts: result.attempts });
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

  // The harness's verdict file: private to this run and outside the mount (#263).
  const own = await mkdtemp(join(deps.reviewDir ?? tmpdir(), 'snapwing-review-'));
  try {
    const ownFile = join(own, 'verdict.json');
    let result: HarnessResult;
    try {
      result = await harness.run(job.workItem, input, job.workdir, {
        role: 'review',
        budget: job.budget,
        onCheckpoint: () => Promise.resolve(),
        signal: deps.signal,
        env: { ...GIT_ENV, ...modelVars, [REVIEW_FILE_ENV]: ownFile },
      });
    } catch (e) {
      log(`review harness error: ${e instanceof Error ? e.message : String(e)}`);
      return EXIT_FAILED;
    }
    if (result.outcome !== 'done') {
      log(result.outcome === 'failed' ? `review harness failed: ${result.reason}` : `review harness stopped at ${result.atPhase}`);
      return EXIT_FAILED;
    }
    const verdict = await readSmallFile(ownFile, MAX_VERDICT_BYTES);
    if (verdict === undefined) {
      log('the review harness wrote no verdict file');
      return EXIT_FAILED;
    }
    // Written once, here, after the harness has exited; anything else at the mount path is replaced.
    try {
      await rm(verdictFile, { force: true });
      await writeFile(verdictFile, verdict, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode: 0o600 });
    } catch (e) {
      log(`could not write the verdict to the mount: ${e instanceof Error ? e.message : String(e)}`);
      return EXIT_FAILED;
    }
    return EXIT_OK;
  } finally {
    await rm(own, { recursive: true, force: true });
  }
}

/** A regular file of at most `maxBytes`, opened without following a link or blocking on a FIFO; else undefined. */
async function readSmallFile(path: string, maxBytes: number): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > maxBytes) return undefined;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Where the wrapper's own git is found, for the bundle; nothing else of its environment. */
function pathEnv(): Record<string, string> {
  const path = process.env['PATH'];
  return path === undefined ? {} : { PATH: path };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
