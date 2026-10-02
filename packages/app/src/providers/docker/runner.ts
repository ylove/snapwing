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

import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FixerJob, RunnerPort } from '@snapwing/pipeline/ports/runner.ts';
import { parseDuration } from '@snapwing/pipeline/util/duration.ts';

export interface DockerRunnerEnv {
  /** The fixer API base URL the container reaches (B 9), as seen from inside the container. */
  apiUrl: string;
  /** The scoped token for the job's work item (`issueFixerToken`); the only secret the container gets. */
  token: (job: FixerJob) => string;
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
}

export const DOCKER_WORKDIR = '/work';
export const DOCKER_NAME_PREFIX = 'snapwing-fixer-';

/** A run id names a container and a directory, so it must be one plain segment (a ULID in practice). */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Variables the docker CLI itself may need to find its daemon and config; none is a secret of ours. */
const CLI_ENV = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'XDG_RUNTIME_DIR'];

export function containerName(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`run id ${JSON.stringify(runId)} is not a plain path segment`);
  return `${DOCKER_NAME_PREFIX}${runId}`;
}

export function createDockerRunner(options: DockerRunnerOptions): RunnerPort {
  const docker = options.docker ?? 'docker';
  const workdirRoot = options.workdirRoot ?? join(tmpdir(), 'snapwing-fixer');
  const graceSec = Math.max(1, Math.ceil(parseDuration(options.killGrace ?? 'PT10S') / 1000));

  const cli = (args: string[], extra: Record<string, string> = {}): Promise<{ code: number; stderr: string }> => {
    const env: Record<string, string> = {};
    for (const k of CLI_ENV) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    Object.assign(env, extra);
    return new Promise((resolve, reject) => {
      execFile(docker, args, { env, encoding: 'utf8' }, (err, _stdout, stderr) => {
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
  };
}

/** The container's whole environment: the job (harness contract variables, docs/harness-generic.md) and API access. */
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
  return out;
}

function firstLine(s: string): string {
  return s.trim().split('\n')[0] ?? '';
}
