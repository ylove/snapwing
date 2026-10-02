// The `local` RunnerPort (main 14.3): runs the fixer as a child process on this machine. The child
// is the configured HarnessPort's (generic or claude-code, both process based over the shared
// supervisor in harness/process.ts), so stop, budget, and checkpoint handling are the harness's;
// this runner adds a prepared checkout per run and cancellation by id.
//
// `runFixer` takes the run id from the job (the fixer job mints it and appends `fixer-started` first,
// #173), loads the implementation request artifact (and the review artifact on a retry), parses the
// request for handoff/@branch and handoff/@base, resolves the harness, and resolves with the run id
// without waiting for the run to end. It rejects, starting nothing, when the run id is not a plain
// path segment or is already known, when an artifact is missing or of the wrong kind, when the
// request does not parse, or when the harness cannot be resolved.
//
// The run itself, in the background:
//   1. `prepareWorkdir` (fixer/workdir) clones the repository into `<workdirRoot>/<runId>` with an
//      installation token from `git.token`, on the work branch (handoff/@branch, else
//      `fix/<issue key>`), with the commit-msg and pre-push guardrails installed. A failure here is a
//      `failed` result with a `workdir:` reason; a Stop here is `stopped` at `cloned`, the floor phase.
//   2. Reports the `cloned` checkpoint (detail `<base>@<sha>`): the runner records it, so the fixer
//      prompt and the generic contract let the harness begin at `branched`.
//   3. Runs the harness in the checkout with the checkout's git environment (prepareWorkdir `env`),
//      plus, on a retry, the review artifact written to `.git/snapwing/review.json` (outside the
//      worktree, so no commit can include it) and named by `SNAPWING_PRIOR_REVIEW_FILE`.
//   4. Removes the run directory, unless the result is `failed` and `keepFailedWorkdir` is set.
//
// Checkpoints and the result go to `onCheckpoint` and `onFinished`, which the app points at the
// fixer API (B 9); errors they throw are swallowed so a reporting failure never kills a run.

import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessConfig } from '../../config/app-config.ts';
import { prepareWorkdir, SNAPWING_GIT_DIR, type GitIdentity, type PreparedWorkdir } from '../../fixer/workdir/index.ts';
import { createClaudeCodeHarness, type ClaudeCodeHarnessConfig } from '../../harness/claude-code/index.ts';
import { createGenericHarness } from '../../harness/generic/index.ts';
import type { HarnessCheckpoint, HarnessPort, HarnessResult, WorkItemRef } from '../../ports/harness.ts';
import type { FixerJob, HarnessChoice, RunnerPort } from '../../ports/runner.ts';
import type { StatePort } from '../../ports/state.ts';
import { parseImplementationRequest } from '../../prompts/implementation-request.ts';

export interface RunInfo {
  runId: string;
  job: FixerJob;
}

/** How the runner reaches the target repository. */
export interface LocalRunnerGit {
  /** A GitHub App installation token scoped to the work item's repository, fetched per run. */
  token: (workItem: WorkItemRef) => Promise<string>;
  /** The clone URL for `owner/name`; default `https://github.com/<repo>.git`. */
  remoteUrl?: (repo: string) => string;
  /** The commit identity; default `DEFAULT_BOT_IDENTITY`. */
  identity?: GitIdentity;
}

export interface LocalRunnerOptions {
  /** The harness for a job's choice; see `harnessResolver` for the one built from config. */
  resolveHarness: (choice: HarnessChoice) => HarnessPort;
  /** Where implementation request and review artifacts are read from. */
  artifacts: Pick<StatePort, 'getArtifact'>;
  /** Parent of the per-run checkouts. */
  workdirRoot: string;
  git: LocalRunnerGit;
  /** Keep the checkout of a `failed` run for inspection. Default false: every checkout is removed. */
  keepFailedWorkdir?: boolean;
  onCheckpoint?: (run: RunInfo, checkpoint: HarnessCheckpoint) => Promise<void>;
  onFinished?: (run: RunInfo, result: HarnessResult) => Promise<void>;
}

export interface LocalRunner extends RunnerPort {
  /** The result of `runId` once it ends (after `onFinished` has returned). Rejects for an unknown id. */
  wait(runId: string): Promise<HarnessResult>;
  /** Ids of the runs not yet ended. */
  active(): string[];
}

export class UnknownRunError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`no run ${runId}`);
    this.name = 'UnknownRunError';
    this.runId = runId;
  }
}

/** A run id names its work directory, so it must be one plain path segment (a ULID in practice). */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The environment variable naming the prior review on a retry run (docs/harness-generic.md 7). */
export const PRIOR_REVIEW_ENV = 'SNAPWING_PRIOR_REVIEW_FILE';

interface Run {
  controller: AbortController;
  done: Promise<HarnessResult>;
  progress: { ended: boolean };
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createLocalRunner(options: LocalRunnerOptions): LocalRunner {
  const runs = new Map<string, Run>();

  const report = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch {
      // Reporting is best effort; the run goes on.
    }
  };

  return {
    async runFixer(job) {
      const { runId } = job;
      if (!RUN_ID.test(runId)) throw new Error(`run id ${JSON.stringify(runId)} is not a plain path segment`);
      if (runs.has(runId)) throw new Error(`run ${runId} already exists`);
      const artifact = await options.artifacts.getArtifact(job.implementationRequestArtifactId, job.implementationRequestVersion);
      if (artifact.kind !== 'implementation-request') {
        throw new Error(`artifact ${artifact.id} is a ${artifact.kind}, not an implementation-request`);
      }
      const { handoff } = parseImplementationRequest(artifact.body);
      let review: string | undefined;
      if (job.review !== undefined) {
        const r = await options.artifacts.getArtifact(job.review.artifactId, job.review.version);
        if (r.kind !== 'review') throw new Error(`artifact ${r.id} is a ${r.kind}, not a review`);
        review = r.body;
      }
      const harness = options.resolveHarness(job.harness);
      // Checked again after the awaits: two starts of one id race no further than here.
      if (runs.has(runId)) throw new Error(`run ${runId} already exists`);

      const info: RunInfo = { runId, job };
      const workdir = join(options.workdirRoot, runId);
      const controller = new AbortController();
      const progress = { ended: false };
      const onCheckpoint = async (c: HarnessCheckpoint): Promise<void> => {
        const hook = options.onCheckpoint;
        if (hook !== undefined) await report(() => hook(info, c));
      };

      const execute = async (): Promise<HarnessResult> => {
        let prepared: PreparedWorkdir;
        try {
          const token = await options.git.token(job.workItem);
          prepared = await prepareWorkdir({
            repo: job.workItem.repo,
            base: handoff.base,
            branch: handoff.branch ?? `fix/${job.workItem.issueKey}`,
            issueKey: job.workItem.issueKey,
            token,
            workdir,
            ...(options.git.remoteUrl === undefined ? {} : { remoteUrl: options.git.remoteUrl(job.workItem.repo) }),
            ...(options.git.identity === undefined ? {} : { identity: options.git.identity }),
            signal: controller.signal,
          });
        } catch (e) {
          if (controller.signal.aborted) return { outcome: 'stopped', atPhase: 'cloned' };
          return { outcome: 'failed', reason: `workdir: ${message(e)}`, attempts: 0 };
        }
        await onCheckpoint({ phase: 'cloned', detail: `${prepared.base}@${prepared.baseSha.slice(0, 12)}` });
        if (controller.signal.aborted) return { outcome: 'stopped', atPhase: 'cloned' };

        const env: Record<string, string> = { ...prepared.env };
        if (review !== undefined) {
          const reviewFile = join(prepared.workdir, '.git', SNAPWING_GIT_DIR, 'review.json');
          await writeFile(reviewFile, review, { mode: 0o600 });
          env[PRIOR_REVIEW_ENV] = reviewFile;
        }
        try {
          return await harness.run(job.workItem, artifact.body, prepared.workdir, {
            role: 'fixer',
            budget: job.budget,
            signal: controller.signal,
            onCheckpoint,
            env,
          });
        } catch (e) {
          return { outcome: 'failed', reason: `harness error: ${message(e)}`, attempts: 1 };
        }
      };

      const done = (async (): Promise<HarnessResult> => {
        let result: HarnessResult;
        try {
          result = await execute();
        } catch (e) {
          result = { outcome: 'failed', reason: `runner error: ${message(e)}`, attempts: 0 };
        }
        if (result.outcome !== 'failed' || options.keepFailedWorkdir !== true) {
          await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
        }
        const onFinished = options.onFinished;
        if (onFinished !== undefined) await report(() => onFinished(info, result));
        progress.ended = true;
        return result;
      })();
      runs.set(runId, { controller, done, progress });
      return { runId };
    },

    async cancel(runId) {
      const run = runs.get(runId);
      if (run === undefined || run.progress.ended) return;
      run.controller.abort();
      await run.done;
    },

    wait(runId) {
      const run = runs.get(runId);
      return run === undefined ? Promise.reject(new UnknownRunError(runId)) : run.done;
    },

    active() {
      return [...runs].filter(([, r]) => !r.progress.ended).map(([id]) => id);
    },
  };
}

export interface HarnessResolverOptions {
  /** Extra environment for generic harness processes (for example secrets from the SecretsPort). */
  env?: Readonly<Record<string, string>>;
  claudeCode?: ClaudeCodeHarnessConfig;
  /** SIGTERM to SIGKILL grace for generic harnesses, in milliseconds. Tests shorten it. */
  killGraceMs?: number;
}

/**
 * Resolves a job's harness choice against the `<harness>` config (main 14.5): `claude-code` and each
 * `<generic id>` template become one adapter instance each, made on first use. `codex` and `gemini`
 * have no adapter yet and throw.
 */
export function harnessResolver(config: HarnessConfig, options: HarnessResolverOptions = {}): (choice: HarnessChoice) => HarnessPort {
  const made = new Map<string, HarnessPort>();
  const once = (key: string, make: () => HarnessPort): HarnessPort => {
    let h = made.get(key);
    if (h === undefined) {
      h = make();
      made.set(key, h);
    }
    return h;
  };

  return (choice) => {
    switch (choice.adapter) {
      case 'claude-code':
        return once('claude-code', () => createClaudeCodeHarness(options.claudeCode ?? {}));
      case 'generic': {
        const template = config.generic.find((g) => g.id === choice.templateId);
        if (template === undefined) throw new Error(`no <generic id="${choice.templateId}"> harness template in the config`);
        return once(`generic:${template.id}`, () =>
          createGenericHarness({
            command: template.command,
            timeout: template.timeout,
            ...(options.env === undefined ? {} : { env: options.env }),
            ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
          }),
        );
      }
      case 'codex':
      case 'gemini':
        throw new Error(`the ${choice.adapter} harness adapter is not implemented yet`);
    }
  };
}
