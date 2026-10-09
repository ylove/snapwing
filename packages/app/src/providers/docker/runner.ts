// The `docker` RunnerPort (main 14.3, main 10.2): runs one fixer job as a detached `docker run --rm`
// container on this host (any VPS). The container is the image's own entrypoint; it reads its job
// from `SNAPWING_*` environment variables, works in the checkout mounted at `/work`, leaves its work
// as a bundle in `/out`, and reports through the fixer API (B 9) with its run's token. The runner mounts
// nothing else but the run's credentials directory, and passes nothing secret but that token and the
// per-run model token: no GitHub credential of any kind enters the container (#262).
//
// Credentials (#273): the fixer token and the model token are in no variable. The runner writes them to
// `credentials.json` in a directory of the run's own (`<run>/creds`, 0700, the file 0600) mounted at
// `/run/snapwing`; the image's wrapper reads the file and removes it before any harness starts, so no
// process in the container can read them from a file or from `/proc/*/environ`. Both tokens name the
// run: `revoke(runId)` (the state store) ends them when the fixer container is gone, when `cancel`
// stops it (before `docker stop`), and when a review run returns.
//
// Network (#273): fixer and review containers join `network` (default `snapwing-runs`), a docker
// `--internal` network whose bridge has no address of the host's (`inhibit_ipv4`): it has no route out
// and no way to the host, so no host port, no cloud metadata service (169.254.169.254), no package
// registry, and no internet. The runner creates it when it is missing and refuses to start a run on a
// network that lets either through. With `relay`, the only other thing on it is the relay container (`snapwing-relay`, the image's relay.ts, alias `snapwing-api`, `RELAY_URL`): it
// reaches the server on `relay.network` (default docker's `bridge`) and forwards only the fixer API and
// model proxy paths to `relay.upstream`; the runner (re)starts it when it is missing or was started for
// another image, upstream, or network. Containers of concurrent runs share the internal network. Test
// containers get `--network none` unless `testNetwork` names one.
//
// Env values go to the docker CLI through its own environment and `-e NAME` (no value), so no value ever
// appears in the argv that `ps` shows. The CLI gets only PATH and the few variables it needs to find its
// daemon, not the server's environment.
//
// The work item is prepared on the host before the container starts, because nothing in the
// container can turn an artifact id into a request, and because the clone needs a credential:
// `runFixer` loads the implementation request (and on a retry the review) from `artifacts`, lays out
// `<workdirRoot>/<runId>` as the `local` runner does (fixer/workdir/handoff.ts), makes `work/` a
// checkout on the work branch with `prepareWorkdir` (bot identity, the commit-msg guardrail under
// `.git/snapwing/hooks`, no credential in the remote URL), writes the run record `run.json` beside it,
// and writes the request to `.git/snapwing/implementation-request.xml` and the review to
// `.git/snapwing/review.json`, named in the container as `SNAPWING_PRIOR_REVIEW_FILE` under `/work`.
// The installation token from `git.token` is used for that clone on the host only. The container
// gets `work/` at `/work`, `out/` at `/out`, and `creds/` at `/run/snapwing`, never the run directory
// itself, so it cannot touch the record. The wrapper points `core.hooksPath` at `/work/.git/snapwing/hooks`, so the host paths in
// the prepared `.git/config` are never needed, and once the harness has committed it writes the
// bundle of the work branch (`SNAPWING_WORK_BRANCH` since `SNAPWING_BASE_SHA`) to
// `SNAPWING_HANDOFF_FILE` in `/out`. The server imports that bundle, checks it, and pushes it
// (app/src/fixer-api/handoff.ts); nothing in the container ever pushes or opens a pull request.
//
// The fixer container runs as the server's uid:gid (`--user`, as test and review runs do) with HOME
// and TMPDIR at its `/tmp`, so it can write the host-prepared checkout and the server can remove it.
// After `docker run -d` the runner waits for the container in the background (`docker wait`) and
// removes the scratch directory once the container is gone (`wait(runId)` resolves then). A container
// whose end the runner cannot observe (the daemon unreachable, the server restarted) leaves its
// directory behind (a checkout, maybe a bundle, at most a credentials file the wrapper never took, whose
// tokens expire with the run); `sweep` at the next startup removes it once it is older than the longest
// wall clock plus a margin and no `snapwing-fixer-<runId>` container of
// any state exists (`sweepScratch`, shared with the `local` runner). When docker cannot list its
// containers, the sweep removes nothing.
//
// `runFixer` resolves once `docker run -d` has created the container. It rejects, starting nothing and
// leaving no directory, when the work item cannot be prepared (a missing or wrong-kind artifact, a
// request that does not parse, no token, a failed clone), when the run network is refused, or when
// docker refuses (bad image, bad name, no daemon). `cancel` is `docker stop -t <grace>`: SIGTERM, then SIGKILL after the grace; `--rm`
// removes the container afterwards. A container that is already gone makes `cancel` a no-op.
//
// `runTests` runs one regression-proof test run (main 11.1, ADR 0017) in the same image, as an
// attached `docker run --rm` named `snapwing-tests-<runId>`: the command is `sh -c <command>` in place
// of the image's entrypoint, the caller's prepared tree is the only mount, and the container gets the
// caller's env and nothing else, no token of any kind (the review job checked the tree out on the host).
// It runs as the server's uid and gid, so every file it writes in the tree stays removable by the
// server, with HOME and TMPDIR at the container's `/tmp`. The exit code is the one docker reports for
// the container; docker's own failure (exit 125: no daemon, no image) rejects, so a test command that
// itself exits 125 reads as a runner failure (the review escalates; never a pass). Past the timeout the
// container is killed and the run resolves `timedOut`.
//
// `runReview` runs the review agent (main 11.1, ADR 0017) the same way, attached, as
// `snapwing-review-<runId>`, but with the image's own entrypoint (its wrapper starts the configured
// harness, as for a fixer) and `SNAPWING_ROLE=review`: the caller's self-contained tree at the head is
// the only mount besides its credentials (`<workdirRoot>/<runId>/creds`, only with a model proxy, removed
// when the run returns), the review input file and `SNAPWING_REVIEW_FILE` lie inside it, and there is no
// git credential and no fixer API token (nor `SNAPWING_API_URL`: a reviewer reports nothing to the fixer
// API). Past the review budget's wall clock the container is killed. The pull request's code never
// runs in this container (#263): the agent only reads, the tests run in `runTests` containers that
// mount trees of their own, and the wrapper alone writes `SNAPWING_REVIEW_FILE`, after the agent has
// exited.
//
// Model access (ADR 0017, amendment 1): no model provider key ever enters a container. With
// `env.modelProxy` configured, a fixer or review container gets the server's model proxy URL
// (`SNAPWING_MODEL_PROXY_URL`), the model its role is pinned to (`SNAPWING_HARNESS_MODEL`), and a per-run
// model token (`issueModelToken`, `app/src/model-proxy/`) in its credentials file; the wrapper serves the
// agent's model calls on loopback and adds the token itself. So code in the container can at worst
// spend model calls for its own run, within the proxy's caps, until the run is revoked. Without a proxy
// the container has no model access at all.

import { execFile, spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HANDOFF_BUNDLE_FILE, runLayout, writeRunRecord } from '@snapwing/pipeline/fixer/workdir/handoff.ts';
import { prepareWorkdir, SNAPWING_GIT_DIR } from '@snapwing/pipeline/fixer/workdir/index.ts';
import type { WorkItemRef } from '@snapwing/pipeline/ports/harness.ts';
import type { FixerJob, HarnessChoice, ReviewRunJob, ReviewRunner, RunnerPort, TestRunner, TestRunResult } from '@snapwing/pipeline/ports/runner.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { parseImplementationRequest } from '@snapwing/pipeline/prompts/implementation-request.ts';
import { PRIOR_REVIEW_ENV, sweepScratch, type LocalRunnerGit, type ScratchSweep, type ScratchSweeper } from '@snapwing/pipeline/providers/local/runner.ts';
import { parseDuration } from '@snapwing/pipeline/util/duration.ts';

export interface DockerRunnerEnv {
  /** The fixer API base URL the container reaches (B 9), as seen from inside the container (`RELAY_URL` with a relay). */
  apiUrl: string;
  /** The run's fixer token (`issueFixerToken`: the work item and the run); fixer containers only, in the credentials file. */
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
  /** Mints the run's model token (`issueModelToken`): scoped to the work item and the run, short-lived. */
  token: (run: ModelTokenRequest) => string;
  /** The model a role's harness is started with (`SNAPWING_HARNESS_MODEL`); the token pins it at the proxy either way. */
  model?: (role: 'fixer' | 'review') => string | undefined;
}

/** The relay that is the only way out of the run network (#273). */
export interface DockerRelay {
  /** The server's API as the relay reaches it, for example `http://host.docker.internal:3000`. */
  upstream: string;
  /** The network the relay reaches `upstream` on. Default `bridge`. */
  network?: string;
}

export interface DockerRunnerOptions {
  /** The fixer image, for example `registry.example.com/snapwing-fixer:1`. */
  image: string;
  /** The docker binary. Default `docker`, found on PATH. */
  docker?: string;
  /** The internal network fixer and review containers join. Default `DEFAULT_RUN_NETWORK`; one that is not `--internal` is refused. */
  network?: string;
  /** `--network` for test runs. Default `none`. */
  testNetwork?: string;
  /** Starts and keeps the relay on `network` (#273). Without it, something else must make the API reachable there. */
  relay?: DockerRelay;
  /** Revokes a run's tokens (#273): after its fixer container is gone, before `cancel` stops it, and after a review run. */
  revoke?: (runId: string) => Promise<void>;
  env: DockerRunnerEnv;
  /**
   * Where the implementation request and review artifacts are read from. Required by `runFixer`
   * (it rejects without it); a runner used only for test and review runs may omit it.
   */
  artifacts?: Pick<StatePort, 'getArtifact'>;
  /**
   * How the work item's checkout is prepared on the host, as for the `local` runner: an installation
   * token per run for the clone only (it never enters the container), the clone URL, the commit
   * identity. Required by `runFixer` (it rejects without it).
   */
  git?: LocalRunnerGit;
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
   * `--user` for every run (fixer, test, review). Default the server's own `uid:gid`, so the run can
   * write the tree the server prepared and every file it writes there stays removable by the server.
   */
  testUser?: string;
  /** The clock `sweep` ages scratch directories by. Default the system clock. */
  clock?: () => Date;
}

/** A sweep that could not tell which containers exist removes nothing and says why. */
export type DockerScratchSweep = ScratchSweep & { skipped?: string };

export type DockerRunner = RunnerPort &
  TestRunner &
  ReviewRunner &
  ScratchSweeper & {
    sweep(options: { maxWallClock: string }): Promise<DockerScratchSweep>;
    /**
     * Resolves once the fixer container `runId` is gone and its scratch directory removed (or left
     * behind because docker could not say the container ended). Resolves at once for an unknown id.
     */
    wait(runId: string): Promise<void>;
  };

/** The implementation request in the prepared checkout (`FIXER_REQUEST_PATH` in the image's wrapper). */
export const FIXER_REQUEST_FILE = `.git/${SNAPWING_GIT_DIR}/implementation-request.xml`;
/** The prior review on a retry run, beside the request. */
export const FIXER_REVIEW_FILE = `.git/${SNAPWING_GIT_DIR}/review.json`;

export const DOCKER_WORKDIR = '/work';
/** Where the fixer container leaves its bundle (the run's `out/`). */
export const DOCKER_OUTDIR = '/out';
/** The bundle's path in the fixer container (`SNAPWING_HANDOFF_FILE`). */
export const DOCKER_HANDOFF_FILE = `${DOCKER_OUTDIR}/${HANDOFF_BUNDLE_FILE}`;
/** Where a container finds its credentials directory, and the file in it the wrapper reads and removes (#273). */
export const DOCKER_CREDENTIALS_DIR = '/run/snapwing';
export const DOCKER_CREDENTIALS_FILE = `${DOCKER_CREDENTIALS_DIR}/credentials.json`;
/** The internal network fixer and review containers join by default (#273). */
export const DEFAULT_RUN_NETWORK = 'snapwing-runs';
export const RELAY_NAME = 'snapwing-relay';
/** The relay's name on the run network, and the base URL containers reach the server at through it. */
export const RELAY_ALIAS = 'snapwing-api';
export const RELAY_PORT = 8080;
export const RELAY_URL = `http://${RELAY_ALIAS}:${RELAY_PORT}`;
const RELAY_SCRIPT = '/opt/snapwing/infra/docker/fixer/relay.ts';
/** A bridge option that leaves the host no address on the network, so a container cannot reach the host through it. */
const INHIBIT_IPV4 = 'com.docker.network.bridge.inhibit_ipv4';
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

export function createDockerRunner(options: DockerRunnerOptions): DockerRunner {
  const docker = options.docker ?? 'docker';
  const workdirRoot = options.workdirRoot ?? join(tmpdir(), 'snapwing-fixer');
  const graceSec = Math.max(1, Math.ceil(parseDuration(options.killGrace ?? 'PT10S') / 1000));
  const network = options.network ?? DEFAULT_RUN_NETWORK;
  /** Fixer runs being prepared or whose container has not been seen to end. */
  const runs = new Map<string, Promise<void>>();
  const revoke = async (runId: string): Promise<void> => {
    await options.revoke?.(runId);
  };

  const cli = (args: string[], extra: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> => {
    return new Promise((resolve, reject) => {
      execFile(docker, args, { env: cliEnv(extra), encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err === null) return resolve({ code: 0, stdout, stderr });
        if (typeof err.code === 'number') return resolve({ code: err.code, stdout, stderr });
        reject(err);
      });
    });
  };

  /** What every run container gets: a name, limits, no capabilities, and the server's uid:gid. */
  const common = (name: string, net: string): string[] => [
    '--name', name,
    '--memory', options.memory ?? '4g',
    '--cpus', options.cpus ?? '2',
    '--pids-limit', String(options.pidsLimit ?? 512),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--network', net,
    ...user(options.testUser),
  ];

  /** One preparation at a time, so two runs starting together never race on the network or the relay. */
  let egressQueue: Promise<void> = Promise.resolve();
  const prepareEgress = (): Promise<void> => {
    const next = egressQueue.then(ensureEgress);
    egressQueue = next.catch(() => undefined);
    return next;
  };

  /**
   * The run network and, with `relay`, the relay on it. The network is created when missing, internal
   * and with no address of the host's on its bridge (`inhibit_ipv4`), so neither the internet nor the
   * host is reachable from it; one that lets either through is refused.
   */
  async function ensureEgress(): Promise<void> {
    const inspect = (): ReturnType<typeof cli> => cli(['network', 'inspect', '--format', `{{.Internal}} {{.Driver}} {{index .Options "${INHIBIT_IPV4}"}}`, network]);
    let net = await inspect();
    if (net.code !== 0 && /not found|no such network/i.test(net.stderr)) {
      const created = await cli(['network', 'create', '--internal', '-o', `${INHIBIT_IPV4}=true`, '--label', 'snapwing.managed=true', network]);
      if (created.code !== 0 && !/already exists/i.test(created.stderr)) throw new Error(`docker network create failed (exit ${created.code}): ${firstLine(created.stderr)}`);
      net = await inspect();
    }
    if (net.code !== 0) throw new Error(`docker network inspect failed (exit ${net.code}): ${firstLine(net.stderr)}`);
    const [internal, driver, inhibit] = net.stdout.trim().split(/\s+/);
    if (internal !== 'true' || (driver === 'bridge' && inhibit !== 'true')) {
      throw new Error(`docker network ${network} lets run containers reach ${internal === 'true' ? 'the host' : 'the host and the internet'}; remove it (snapwing creates it --internal with ${INHIBIT_IPV4}) or name another`);
    }
    if (options.relay === undefined) return;
    const relayNet = options.relay.network ?? 'bridge';
    const label = `${options.image} ${options.relay.upstream} ${relayNet} ${network}`;
    const running = async (): Promise<boolean> => {
      const r = await cli(['inspect', '--format', '{{.State.Running}} {{index .Config.Labels "snapwing.relay"}}', RELAY_NAME]);
      if (r.code === 0 && r.stdout.trim() === `true ${label}`) return true;
      if (r.code === 0) await cli(['rm', '-f', RELAY_NAME]);
      return false;
    };
    if (await running()) return;
    const relayEnv = { SNAPWING_RELAY_UPSTREAM: options.relay.upstream };
    const started = await cli(
      [
        'run', '-d',
        '--name', RELAY_NAME,
        '--label', `snapwing.relay=${label}`,
        '--restart', 'unless-stopped',
        '--read-only',
        '--memory', '256m',
        '--pids-limit', '64',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--network', relayNet,
        '--add-host', 'host.docker.internal:host-gateway',
        '-e', 'SNAPWING_RELAY_UPSTREAM',
        '--entrypoint', 'node',
        options.image,
        '--disable-warning=ExperimentalWarning', RELAY_SCRIPT,
      ],
      relayEnv,
    );
    if (started.code !== 0) {
      // Another process started it first.
      if (/already in use/i.test(started.stderr) && (await running())) return;
      throw new Error(`docker run ${RELAY_NAME} failed (exit ${started.code}): ${firstLine(started.stderr)}`);
    }
    const joined = await cli(['network', 'connect', '--alias', RELAY_ALIAS, network, RELAY_NAME]);
    if (joined.code !== 0 && !/already exists/i.test(joined.stderr)) throw new Error(`docker network connect failed (exit ${joined.code}): ${firstLine(joined.stderr)}`);
  }

  /** The run's credentials file in `dir/creds`, and the mount the container reads it from. */
  async function credentialsMount(dir: string, credentials: RunCredentials): Promise<string[]> {
    const creds = join(dir, 'creds');
    await mkdir(creds, { mode: 0o700 });
    await writeFile(join(creds, 'credentials.json'), JSON.stringify(credentials), { mode: 0o600 });
    return ['-v', `${creds}:${DOCKER_CREDENTIALS_DIR}`];
  }

  return {
    async runFixer(job) {
      const name = containerName(job.runId);
      const { artifacts, git } = options;
      if (artifacts === undefined || git === undefined) throw new Error('the docker runner needs `artifacts` and `git` to prepare a fixer run');
      if (runs.has(job.runId)) throw new Error(`run ${job.runId} already exists`);
      let settle: () => void = () => undefined;
      runs.set(job.runId, new Promise<void>((resolve) => (settle = resolve)));
      const scratch = join(workdirRoot, job.runId);
      const layout = runLayout(scratch);
      let created = false;
      try {
        const work = await loadWorkItem(job, artifacts);
        await mkdir(workdirRoot, { recursive: true });
        // Not recursive: a directory left by an earlier run of this id is never reused or removed.
        await mkdir(scratch, { mode: 0o700 });
        created = true;
        await mkdir(layout.out);
        const token = await git.token(job.workItem);
        let prepared;
        try {
          prepared = await prepareWorkdir({
            repo: job.workItem.repo,
            base: work.base,
            branch: work.branch ?? `fix/${job.workItem.issueKey}`,
            issueKey: job.workItem.issueKey,
            token,
            workdir: layout.checkout,
            ...(git.remoteUrl === undefined ? {} : { remoteUrl: git.remoteUrl(job.workItem.repo) }),
            ...(git.identity === undefined ? {} : { identity: git.identity }),
          });
        } catch (e) {
          throw new Error(`workdir: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
        }
        await writeRunRecord(scratch, { runId: job.runId, repo: job.workItem.repo, issueKey: job.workItem.issueKey, branch: prepared.branch, base: prepared.base, expectedBase: prepared.expectedBase });
        const jobEnv = fixerEnv(job, options.env, { branch: prepared.branch, expectedBase: prepared.expectedBase });
        await writeFile(join(layout.checkout, FIXER_REQUEST_FILE), work.request, { mode: 0o600 });
        if (work.review !== undefined) {
          await writeFile(join(layout.checkout, FIXER_REVIEW_FILE), work.review, { mode: 0o600 });
          jobEnv[PRIOR_REVIEW_ENV] = `${DOCKER_WORKDIR}/${FIXER_REVIEW_FILE}`;
        }
        const creds = await credentialsMount(scratch, fixerCredentials(job, options.env));
        await prepareEgress();

        const args = [
          'run',
          '--rm',
          '-d',
          ...common(name, network),
          '-v', `${layout.checkout}:${DOCKER_WORKDIR}`,
          '-v', `${layout.out}:${DOCKER_OUTDIR}`,
          ...creds,
          '-w', DOCKER_WORKDIR,
          ...Object.keys(jobEnv).flatMap((k) => ['-e', k]),
          '-e', 'HOME=/tmp',
          '-e', 'TMPDIR=/tmp',
          options.image,
        ];
        const r = await cli(args, jobEnv);
        if (r.code !== 0) throw new Error(`docker run failed (exit ${r.code}): ${firstLine(r.stderr)}`);
      } catch (e) {
        if (created) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
        await revoke(job.runId).catch(() => undefined);
        runs.delete(job.runId);
        settle();
        throw e;
      }
      // A run whose end docker could not show may still be going: its tokens end with its budget instead.
      void afterExit(name, scratch)
        .then((ended) => (ended ? revoke(job.runId) : undefined))
        .catch(() => undefined)
        .finally(() => {
          runs.delete(job.runId);
          settle();
        });
      return { runId: job.runId };
    },

    async wait(runId) {
      await runs.get(runId);
    },

    async sweep({ maxWallClock }) {
      const now = (options.clock ?? (() => new Date()))();
      // Every fixer container docker still has, in any state: its directory may be in use.
      const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        execFile(docker, ['ps', '-a', '--filter', `name=${DOCKER_NAME_PREFIX}`, '--format', '{{.Names}}'], { env: cliEnv({}), encoding: 'utf8' }, (err, stdout, stderr) =>
          resolve({ code: err === null ? 0 : typeof err.code === 'number' ? err.code : -1, stdout, stderr: err !== null && stderr === '' ? err.message : stderr }),
        );
      });
      if (r.code !== 0) return { removed: [], kept: [], skipped: `docker ps failed (exit ${r.code}): ${firstLine(r.stderr)}` };
      const containers = new Set(r.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== ''));
      return sweepScratch({
        root: workdirRoot,
        maxWallClock,
        now,
        inUse: (name) => runs.has(name) || containers.has(`${DOCKER_NAME_PREFIX}${name}`),
      });
    },

    async cancel(runId) {
      const name = containerName(runId);
      // The tokens end first: nothing the container does in its grace period is accepted.
      await revoke(runId).catch(() => undefined);
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
        ...common(name, options.testNetwork ?? 'none'),
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
      const credentials = reviewCredentials(job, options.env);
      // The credentials directory is the run's own, removed with the run.
      const scratch = join(workdirRoot, job.runId);
      let created = false;
      try {
        await mkdir(workdirRoot, { recursive: true });
        await mkdir(scratch, { mode: 0o700 });
        created = true;
        const creds = credentials === undefined ? [] : await credentialsMount(scratch, credentials);
        await prepareEgress();
        const args = [
          'run',
          '--rm',
          ...common(name, network),
          '-v', `${job.checkout}:${DOCKER_WORKDIR}`,
          ...creds,
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
      } finally {
        await revoke(job.runId).catch(() => undefined);
        if (created) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };

  /**
   * Waits for a detached fixer container to end (`docker wait`; with `--rm` it may already be gone,
   * which docker reports as no such container) and then removes its scratch directory. When docker
   * cannot say the container ended, the directory stays: removing it under a live run would be worse.
   */
  async function afterExit(name: string, scratch: string): Promise<boolean> {
    for (let attempt = 1; attempt <= WAIT_ATTEMPTS; attempt++) {
      const r = await cli(['wait', name]).catch((e: unknown) => ({ code: -1, stderr: e instanceof Error ? e.message : String(e) }));
      if (r.code === 0 || /no such (container|object)/i.test(r.stderr)) {
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
        return true;
      }
      if (attempt < WAIT_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, WAIT_RETRY_MS));
    }
    return false;
  }

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

/** `docker wait` attempts before a fixer's scratch directory is left behind. */
const WAIT_ATTEMPTS = 3;
const WAIT_RETRY_MS = 2000;

interface WorkItemFiles {
  request: string;
  base: string | undefined;
  branch: string | undefined;
  review: string | undefined;
}

/**
 * The implementation request (and on a retry the review) a fixer run needs in its mount. Rejects for a
 * missing or wrong-kind artifact or a request that does not parse, as the `local` runner does.
 */
async function loadWorkItem(job: FixerJob, artifacts: Pick<StatePort, 'getArtifact'>): Promise<WorkItemFiles> {
  const artifact = await artifacts.getArtifact(job.implementationRequestArtifactId, job.implementationRequestVersion);
  if (artifact.kind !== 'implementation-request') throw new Error(`artifact ${artifact.id} is a ${artifact.kind}, not an implementation-request`);
  const { handoff } = parseImplementationRequest(artifact.body);
  let review: string | undefined;
  if (job.review !== undefined) {
    const r = await artifacts.getArtifact(job.review.artifactId, job.review.version);
    if (r.kind !== 'review') throw new Error(`artifact ${r.id} is a ${r.kind}, not a review`);
    review = r.body;
  }
  return { request: artifact.body, base: handoff.base, branch: handoff.branch, review };
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

/** What the runner writes to a run's credentials file for the wrapper alone (#273). */
export interface RunCredentials {
  fixerToken?: string;
  modelToken?: string;
}

function modelRun(job: FixerJob | ReviewRunJob, role: 'fixer' | 'review'): ModelTokenRequest {
  return { runId: job.runId, workItem: job.workItem, role, wallClock: job.budget.wallClock };
}

/** A fixer run's credentials: its fixer token, and its model token with a model proxy. */
export function fixerCredentials(job: FixerJob, env: DockerRunnerEnv): RunCredentials {
  return { fixerToken: env.token(job), ...(env.modelProxy === undefined ? {} : { modelToken: env.modelProxy.token(modelRun(job, 'fixer')) }) };
}

/** A review run's credentials: its model token with a model proxy, else none. */
export function reviewCredentials(job: ReviewRunJob, env: DockerRunnerEnv): RunCredentials | undefined {
  return env.modelProxy === undefined ? undefined : { modelToken: env.modelProxy.token(modelRun(job, 'review')) };
}

/**
 * A review container's whole environment (docs/harness-generic.md section 7): the harness contract
 * variables with `SNAPWING_ROLE=review`, the input and verdict files inside the mount, and the model
 * proxy and credentials file when configured. No git credential, no token, no API URL.
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
  return { ...out, ...modelEnv(env.modelProxy, modelRun(job, 'review')) };
}

function harnessEnv(harness: HarnessChoice): Record<string, string> {
  return harness.adapter === 'generic' ? { SNAPWING_HARNESS: 'generic', SNAPWING_HARNESS_TEMPLATE: harness.templateId } : { SNAPWING_HARNESS: harness.adapter };
}

/**
 * The model proxy for the wrapper (ADR 0017, amendment 1): its URL, which carries the work item the
 * proxy checks against the token, the credentials file the token is in, and the role's pinned model.
 * Empty without a proxy. No token: that is in the credentials file (#273).
 */
export function modelEnv(proxy: DockerModelProxy | undefined, run: ModelTokenRequest): Record<string, string> {
  if (proxy === undefined) return {};
  const model = proxy.model?.(run.role);
  return {
    SNAPWING_MODEL_PROXY_URL: `${proxy.url.replace(/\/+$/, '')}/${encodeURIComponent(run.workItem.id)}`,
    SNAPWING_CREDENTIALS_FILE: DOCKER_CREDENTIALS_FILE,
    ...(model === undefined || model === '' ? {} : { SNAPWING_HARNESS_MODEL: model }),
  };
}

/** What the hand-off needs from the prepared checkout: the work branch and the commit its bundle starts after. */
export interface FixerHandoffEnv {
  branch: string;
  expectedBase: string;
}

/**
 * The container's environment: the harness contract variables (docs/harness-generic.md), the API URL
 * and the credentials file the fixer token is in (#273), the hand-off (the work branch, the commit its
 * bundle starts after, and where the bundle goes) once the checkout is prepared, and the model proxy
 * when configured. `runFixer` adds `SNAPWING_PRIOR_REVIEW_FILE` on a retry. There is no token and no
 * GitHub credential of any kind in it (#262).
 */
export function fixerEnv(job: FixerJob, env: DockerRunnerEnv, handoff?: FixerHandoffEnv): Record<string, string> {
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
    SNAPWING_CREDENTIALS_FILE: DOCKER_CREDENTIALS_FILE,
  };
  if (job.harness.adapter === 'generic') out['SNAPWING_HARNESS_TEMPLATE'] = job.harness.templateId;
  if (handoff !== undefined) {
    out['SNAPWING_WORK_BRANCH'] = handoff.branch;
    out['SNAPWING_BASE_SHA'] = handoff.expectedBase;
    out['SNAPWING_HANDOFF_FILE'] = DOCKER_HANDOFF_FILE;
  }
  if (job.implementationRequestVersion !== undefined) out['SNAPWING_IMPLEMENTATION_REQUEST_VERSION'] = String(job.implementationRequestVersion);
  if (job.review !== undefined) out['SNAPWING_REVIEW_ARTIFACT'] = JSON.stringify(job.review);
  return { ...out, ...modelEnv(env.modelProxy, modelRun(job, 'fixer')) };
}

function lastLine(s: string): string {
  return s.trim().split('\n').at(-1) ?? '';
}

function firstLine(s: string): string {
  return s.trim().split('\n')[0] ?? '';
}
