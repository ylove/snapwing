// The `local` RunnerPort (main 14.3): runs the fixer as a child process on this machine. The child
// is the configured HarnessPort's (generic or claude-code, both process based over the shared
// supervisor in harness/process.ts), so stop, budget, and checkpoint handling are the harness's;
// this runner adds run ids, a work directory per run, and cancellation by id.
//
// `runFixer` loads the implementation request artifact, resolves the harness, makes
// `<workdirRoot>/<runId>`, starts the run, and resolves with the run id without waiting for the run
// to end. It rejects, starting nothing, when the artifact is missing or not an implementation
// request, or when the harness cannot be resolved. Checkpoints and the result go to `onCheckpoint`
// and `onFinished`, which the app points at the fixer API (B 9); errors they throw are swallowed so
// a reporting failure never kills a run.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessConfig } from '../../config/app-config.ts';
import { createClaudeCodeHarness, type ClaudeCodeHarnessConfig } from '../../harness/claude-code/index.ts';
import { createGenericHarness } from '../../harness/generic/index.ts';
import type { HarnessCheckpoint, HarnessPort, HarnessResult } from '../../ports/harness.ts';
import type { FixerJob, HarnessChoice, RunnerPort } from '../../ports/runner.ts';
import type { StatePort } from '../../ports/state.ts';
import { ulid } from '../../util/ulid.ts';

export interface RunInfo {
  runId: string;
  job: FixerJob;
}

export interface LocalRunnerOptions {
  /** The harness for a job's choice; see `harnessResolver` for the one built from config. */
  resolveHarness: (choice: HarnessChoice) => HarnessPort;
  /** Where implementation request artifacts are read from. */
  artifacts: Pick<StatePort, 'getArtifact'>;
  /** Parent of the per-run work directories. */
  workdirRoot: string;
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

interface Run {
  controller: AbortController;
  done: Promise<HarnessResult>;
  progress: { ended: boolean };
}

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
      const artifact = await options.artifacts.getArtifact(job.implementationRequestArtifactId, job.implementationRequestVersion);
      if (artifact.kind !== 'implementation-request') {
        throw new Error(`artifact ${artifact.id} is a ${artifact.kind}, not an implementation-request`);
      }
      const harness = options.resolveHarness(job.harness);
      const runId = ulid();
      const workdir = join(options.workdirRoot, runId);
      await mkdir(workdir, { recursive: true });

      const info: RunInfo = { runId, job };
      const controller = new AbortController();
      const progress = { ended: false };
      const done = (async (): Promise<HarnessResult> => {
        let result: HarnessResult;
        try {
          result = await harness.run(job.workItem, artifact.body, workdir, {
            role: 'fixer',
            budget: job.budget,
            signal: controller.signal,
            onCheckpoint: async (c) => {
              const onCheckpoint = options.onCheckpoint;
              if (onCheckpoint !== undefined) await report(() => onCheckpoint(info, c));
            },
          });
        } catch (e) {
          result = { outcome: 'failed', reason: `harness error: ${e instanceof Error ? e.message : String(e)}`, attempts: 1 };
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
