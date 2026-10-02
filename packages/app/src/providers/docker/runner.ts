// The `docker` RunnerPort (main 14.3, main 10.2): runs one fixer job as a detached `docker run --rm`
// container on this host (any VPS). The container is the image's own entrypoint; it reads its job
// from `SNAPWING_*` environment variables, works in the one scratch directory mounted at `/work`,
// and reports through the fixer API (B 9) with the per-work-item token. The runner never mounts
// anything else, and passes nothing secret but that token.
//
// Env values go to the docker CLI through its own environment and `-e NAME` (no value), so the token
// never appears in the argv that `ps` shows. The CLI gets only PATH and the few variables it needs to
// find its daemon, not the server's environment.
//
// `runFixer` resolves once `docker run -d` has created the container (it rejects, starting nothing,
// when docker refuses: bad image, bad name, no daemon). `cancel` is `docker stop -t <grace>`: SIGTERM,
// then SIGKILL after the grace; `--rm` removes the container afterwards. A container that is already
// gone makes `cancel` a no-op.
//
// `runTests` runs one regression-proof test run (main 11.1, ADR 0017, #234) in the same image, as an
// attached `docker run --rm` named `snapwing-tests-<runId>`: the command is `sh -c <command>` in place
// of the image's entrypoint, the caller's prepared tree is the only mount, and the container gets the
// caller's env and nothing else, no token of any kind (the review job checked the tree out on the host).
// It runs as the server's uid and gid, so every file it writes in the tree stays removable by the
// server, with HOME and TMPDIR at the container's `/tmp`. The exit code is the one docker reports for
// the container; docker's own failure (exit 125: no daemon, no image) rejects, so a test command that
// itself exits 125 reads as a runner failure (the review escalates; never a pass). Past the timeout the
// container is killed and the run resolves `timedOut`.
//
// `runReview` runs the review agent (main 11.1, ADR 0017, #239) the same way, attached, as
// `snapwing-review-<runId>`, but with the image's own entrypoint (its wrapper starts the configured
// harness, as for a fixer) and `SNAPWING_ROLE=review`: the caller's self-contained tree at the head is
// the only mount, the review input file and `SNAPWING_REVIEW_FILE` lie inside it, and there is no git
// credential and no fixer API token (nor `SNAPWING_API_URL`: a reviewer reports nothing to the fixer
// API). Past the review budget's wall clock the container is killed.
//
// Model access (ADR 0017, amendment 1): no model provider key ever enters a container. With
// `env.modelProxy` configured, a fixer or review container gets the server's model proxy as each CLI's
// base URL and a per-run model token (`issueModelToken`, `app/src/model-proxy/`) under the
// conventional key names, so code in the container can at worst spend model calls for its own work
// item until the token expires. Without it the container has no model access at all.

import { execFile, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkItemRef } from '@snapwing/pipeline/ports/harness.ts';
import type { FixerJob, HarnessChoice, ReviewRunJob, ReviewRunner, RunnerPort, TestRunner, TestRunResult } from '@snapwing/pipeline/ports/runner.ts';
import { parseDuration } from '@snapwing/pipeline/util/duration.ts';

export interface DockerRunnerEnv {
  /** The fixer API base URL the container reaches (B 9), as seen from inside the container. */
  apiUrl: string;
  /** The scoped token for the job's work item (`issueFixerToken`); fixer containers only. */
  token: (job: FixerJob) => string;
  /**
   * The server's model proxy (ADR 0017, amendment 1). Absent: containers get no model access. Never
   * pass a provider key here or anywhere else a container can see.
   */
  modelProxy?: DockerModelProxy;
}

/** One run a model token is minted for. */
export interface ModelTokenRequest {
  runId: string;
  workItem: WorkItemRef;
  role: 'fixer' | 'review';
  /** The run's wall clock budget; the token should expire shortly after it. */
  wallClock: string;
}

export interface DockerModelProxy {
  /**
   * Base URL of the proxy routes as seen from inside the container, for example
   * `http://snapwing-api:8080/model` (`MODEL_PROXY_PREFIX` on the API).
   */
  url: string;
  /** Mints the run's model token (`issueModelToken`): scoped to the work item, short-lived. */
  token: (run: ModelTokenRequest) => string;
}

export interface DockerRunnerOptions {
  /** The fixer image, for example `registry.example.com/snapwing-fixer:1`. */
  image: string;
  /** The docker binary. Default `docker`, found on PATH. */
  docker?: string;
  /** `--network`; the docker default when omitted. */
  network?: string;
  env: DockerRunnerEnv;
  /** Parent of the per-run scratch directories. Default `<tmpdir>/snapwing-fixer`. */
  workdirRoot?: string;
  /** `--memory`. Default `4g`. */
  memory?: string;
  /** `--cpus`. Default `2`. */
  cpus?: string;
  /** `--pids-limit`. Default 512. */
  pidsLimit?: number;
  /** SIGTERM to SIGKILL grace on cancel, ISO 8601. Default `PT10S`. */
  killGrace?: string;
  /**
   * `--user` for test and review runs. Default the server's own `uid:gid`, so the files a run writes
   * in the mounted tree belong to the server and its cleanup can remove them.
   */
  testUser?: string;
}

export const DOCKER_WORKDIR = '/work';
export const DOCKER_NAME_PREFIX = 'snapwing-fixer-';
export const DOCKER_TESTS_PREFIX = 'snapwing-tests-';
export const DOCKER_REVIEW_PREFIX = 'snapwing-review-';
/** The tail of a test run's output kept, in UTF-16 code units. */
export const MAX_TEST_OUTPUT = 64 * 1024;
/** `docker run` exits 125 when docker itself failed to run the container. */
const DOCKER_RUN_FAILED = 125;

/** A run id names a container and a directory, so it must be one plain segment (a ULID in practice). */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Variables the docker CLI itself may need to find its daemon and config; none is a secret of ours. */
const CLI_ENV = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'XDG_RUNTIME_DIR'];

export function containerName(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`run id ${JSON.stringify(runId)} is not a plain path segment`);
  return `${DOCKER_NAME_PREFIX}${runId}`;
}

export function createDockerRunner(options: DockerRunnerOptions): RunnerPort & TestRunner & ReviewRunner {
  const docker = options.docker ?? 'docker';
  const workdirRoot = options.workdirRoot ?? join(tmpdir(), 'snapwing-fixer');
  const graceSec = Math.max(1, Math.ceil(parseDuration(options.killGrace ?? 'PT10S') / 1000));

  const cli = (args: string[], extra: Record<string, string> = {}): Promise<{ code: number; stderr: string }> => {
    return new Promise((resolve, reject) => {
      execFile(docker, args, { env: cliEnv(extra), encoding: 'utf8' }, (err, _stdout, stderr) => {
        if (err === null) return resolve({ code: 0, stderr });
        if (typeof err.code === 'number') return resolve({ code: err.code, stderr });
        reject(err);
      });
    });
  };

  return {
    async runFixer(job) {
      const name = containerName(job.runId);
      const jobEnv = fixerEnv(job, options.env);
      const scratch = join(workdirRoot, job.runId);
      await mkdir(scratch, { recursive: true });

      const args = [
        'run',
        '--rm',
        '-d',
        '--name', name,
        '--memory', options.memory ?? '4g',
        '--cpus', options.cpus ?? '2',
        '--pids-limit', String(options.pidsLimit ?? 512),
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        ...(options.network === undefined ? [] : ['--network', options.network]),
        '-v', `${scratch}:${DOCKER_WORKDIR}`,
        '-w', DOCKER_WORKDIR,
        ...Object.keys(jobEnv).flatMap((k) => ['-e', k]),
        options.image,
      ];
      const r = await cli(args, jobEnv);
      if (r.code !== 0) throw new Error(`docker run failed (exit ${r.code}): ${firstLine(r.stderr)}`);
      return { runId: job.runId };
    },

    async cancel(runId) {
      const name = containerName(runId);
      const r = await cli(['stop', '-t', String(graceSec), name]);
      if (r.code === 0 || /no such (container|object)/i.test(r.stderr)) return;
      throw new Error(`docker stop failed (exit ${r.code}): ${firstLine(r.stderr)}`);
    },

    async runTests(job) {
      const name = testContainerName(job.runId);
      if (!Number.isFinite(job.timeoutMs) || job.timeoutMs <= 0) throw new Error(`invalid test timeout: ${String(job.timeoutMs)}`);
      const env = testEnv(job.env);
      const args = [
        'run',
        '--rm',
        '--name', name,
        '--memory', options.memory ?? '4g',
        '--cpus', options.cpus ?? '2',
        '--pids-limit', String(options.pidsLimit ?? 512),
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        ...(options.network === undefined ? [] : ['--network', options.network]),
        ...user(options.testUser),
        '-v', `${job.checkout}:${DOCKER_WORKDIR}`,
        '-w', DOCKER_WORKDIR,
        ...Object.keys(env).flatMap((k) => ['-e', k]),
        '-e', 'HOME=/tmp',
        '-e', 'TMPDIR=/tmp',
        '--entrypoint', 'sh',
        options.image,
        '-c', job.command,
      ];
      const r = await attached(args, env, job.timeoutMs, () => cli(['kill', name]).then(() => undefined, () => undefined));
      if (r.timedOut) return r;
      if (r.exitCode === DOCKER_RUN_FAILED || r.exitCode === null) {
        throw new Error(`docker run failed (exit ${r.exitCode ?? 'none'}): ${lastLine(r.output)}`);
      }
      return r;
    },

    async runReview(job) {
      const name = reviewContainerName(job.runId);
      const timeoutMs = parseDuration(job.budget.wallClock);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`invalid review wall clock: ${job.budget.wallClock}`);
      const env = reviewEnv(job, options.env);
      const args = [
        'run',
        '--rm',
        '--name', name,
        '--memory', options.memory ?? '4g',
        '--cpus', options.cpus ?? '2',
        '--pids-limit', String(options.pidsLimit ?? 512),
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        ...(options.network === undefined ? [] : ['--network', options.network]),
        ...user(options.testUser),
        '-v', `${job.checkout}:${DOCKER_WORKDIR}`,
        '-w', DOCKER_WORKDIR,
        ...Object.keys(env).flatMap((k) => ['-e', k]),
        '-e', 'HOME=/tmp',
        '-e', 'TMPDIR=/tmp',
        options.image,
      ];
      const r = await attached(args, env, timeoutMs, () => cli(['kill', name]).then(() => undefined, () => undefined));
      if (r.timedOut) return r;
      if (r.exitCode === DOCKER_RUN_FAILED || r.exitCode === null) {
        throw new Error(`docker run failed (exit ${r.exitCode ?? 'none'}): ${lastLine(r.output)}`);
      }
      return r;
    },
  };

  /**
   * Runs the docker CLI attached, keeping a bounded tail of its output. Past `timeoutMs` it calls
   * `kill` (the container) and then kills the CLI itself.
   */
  function attached(args: string[], extra: Record<string, string>, timeoutMs: number, kill: () => Promise<void>): Promise<TestRunResult> {
    return new Promise((resolve, reject) => {
      let out = '';
      let timedOut = false;
      let settled = false;
      const child = spawn(docker, args, { env: cliEnv(extra), stdio: ['ignore', 'pipe', 'pipe'] });
      const keep = (chunk: Buffer): void => {
        out = (out + chunk.toString('utf8')).slice(-MAX_TEST_OUTPUT);
      };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      const timer = setTimeout(() => {
        timedOut = true;
        void kill().finally(() => child.kill('SIGKILL'));
      }, timeoutMs);
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: timedOut ? null : code, timedOut, output: out });
      });
    });
  }
}

/** The CLI's environment: the few variables it needs to find its daemon, then `extra`. */
function cliEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of CLI_ENV) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return Object.assign(env, extra);
}

/** Variables the test run sets itself, or that would steer the docker CLI if passed through it. */
const RESERVED_TEST_ENV = new Set([...CLI_ENV, 'TMPDIR']);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A test run's variables, passed to the container by name through the CLI's environment. A name the
 * CLI reads itself (PATH, HOME, DOCKER_HOST, ...) or the run sets (TMPDIR) is refused, not dropped.
 */
export function testEnv(env: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!ENV_NAME.test(k)) throw new Error(`test env name ${JSON.stringify(k)} is not a plain variable name`);
    if (RESERVED_TEST_ENV.has(k)) throw new Error(`test env may not set ${k}`);
    out[k] = v;
  }
  return out;
}

function user(configured: string | undefined): string[] {
  if (configured !== undefined) return ['--user', configured];
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid === undefined || gid === undefined ? [] : ['--user', `${uid}:${gid}`];
}

export function testContainerName(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`run id ${JSON.stringify(runId)} is not a plain path segment`);
  return `${DOCKER_TESTS_PREFIX}${runId}`;
}

export function reviewContainerName(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`run id ${JSON.stringify(runId)} is not a plain path segment`);
  return `${DOCKER_REVIEW_PREFIX}${runId}`;
}

/** A relative path inside the mounted tree: no leading slash, no `..` segment, plain characters. */
const TREE_PATH = /^(?!\/)[A-Za-z0-9._/-]+$/;

function inTree(rel: string, what: string): string {
  if (!TREE_PATH.test(rel) || rel.split('/').some((seg) => seg === '..' || seg === '')) {
    throw new Error(`${what} ${JSON.stringify(rel)} is not a plain relative path in the tree`);
  }
  return `${DOCKER_WORKDIR}/${rel}`;
}

/**
 * A review container's whole environment (docs/harness-generic.md section 7): the harness contract
 * variables with `SNAPWING_ROLE=review`, the input and verdict files inside the mount, and the model
 * proxy when configured. No git credential, no fixer token, no API URL.
 */
export function reviewEnv(job: ReviewRunJob, env: DockerRunnerEnv): Record<string, string> {
  const out: Record<string, string> = {
    SNAPWING_HARNESS_CONTRACT: '1',
    SNAPWING_ROLE: 'review',
    SNAPWING_RUN_ID: job.runId,
    SNAPWING_WORK_ITEM_ID: job.workItem.id,
    SNAPWING_ISSUE_KEY: job.workItem.issueKey,
    SNAPWING_REPO: job.workItem.repo,
    SNAPWING_WORKDIR: DOCKER_WORKDIR,
    SNAPWING_BUDGET_WALL_CLOCK: job.budget.wallClock,
    SNAPWING_BUDGET_ATTEMPTS: String(job.budget.attempts),
    ...harnessEnv(job.harness),
    SNAPWING_REVIEW_INPUT_FILE: inTree(job.inputFile, 'review input file'),
    SNAPWING_REVIEW_FILE: inTree(job.verdictFile, 'review verdict file'),
  };
  return { ...out, ...modelEnv(env.modelProxy, { runId: job.runId, workItem: job.workItem, role: 'review', wallClock: job.budget.wallClock }) };
}

function harnessEnv(harness: HarnessChoice): Record<string, string> {
  return harness.adapter === 'generic' ? { SNAPWING_HARNESS: 'generic', SNAPWING_HARNESS_TEMPLATE: harness.templateId } : { SNAPWING_HARNESS: harness.adapter };
}

/**
 * The model proxy as each CLI's base URL, and the run's model token under the conventional key names
 * (ADR 0017, amendment 1). Empty without a proxy. The base URL carries the work item, which the proxy
 * checks against the token.
 */
export function modelEnv(proxy: DockerModelProxy | undefined, run: ModelTokenRequest): Record<string, string> {
  if (proxy === undefined) return {};
  const base = `${proxy.url.replace(/\/+$/, '')}/${encodeURIComponent(run.workItem.id)}`;
  const token = proxy.token(run);
  return {
    SNAPWING_MODEL_PROXY_URL: base,
    ANTHROPIC_BASE_URL: `${base}/anthropic`,
    ANTHROPIC_API_KEY: token,
    OPENAI_BASE_URL: `${base}/openai/v1`,
    OPENAI_API_KEY: token,
    CODEX_API_KEY: token,
    GOOGLE_GEMINI_BASE_URL: `${base}/google`,
    GEMINI_API_KEY: token,
  };
}

/** The container's whole environment: the job (harness contract variables, docs/harness-generic.md), API access, and the model proxy when configured. */
export function fixerEnv(job: FixerJob, env: DockerRunnerEnv): Record<string, string> {
  const out: Record<string, string> = {
    SNAPWING_HARNESS_CONTRACT: '1',
    SNAPWING_ROLE: 'fixer',
    SNAPWING_RUN_ID: job.runId,
    SNAPWING_WORK_ITEM_ID: job.workItem.id,
    SNAPWING_ISSUE_KEY: job.workItem.issueKey,
    SNAPWING_REPO: job.workItem.repo,
    SNAPWING_WORKDIR: DOCKER_WORKDIR,
    SNAPWING_BUDGET_WALL_CLOCK: job.budget.wallClock,
    SNAPWING_BUDGET_ATTEMPTS: String(job.budget.attempts),
    SNAPWING_HARNESS: job.harness.adapter,
    SNAPWING_IMPLEMENTATION_REQUEST_ARTIFACT: job.implementationRequestArtifactId,
    SNAPWING_API_URL: env.apiUrl,
    SNAPWING_FIXER_TOKEN: env.token(job),
  };
  if (job.harness.adapter === 'generic') out['SNAPWING_HARNESS_TEMPLATE'] = job.harness.templateId;
  if (job.implementationRequestVersion !== undefined) out['SNAPWING_IMPLEMENTATION_REQUEST_VERSION'] = String(job.implementationRequestVersion);
  if (job.review !== undefined) out['SNAPWING_REVIEW_ARTIFACT'] = JSON.stringify(job.review);
  return { ...out, ...modelEnv(env.modelProxy, { runId: job.runId, workItem: job.workItem, role: 'fixer', wallClock: job.budget.wallClock }) };
}

function lastLine(s: string): string {
  return s.trim().split('\n').at(-1) ?? '';
}

function firstLine(s: string): string {
  return s.trim().split('\n')[0] ?? '';
}
