// src/ports/runner.ts (main 14.3): the runner runtime port, which runs the ephemeral jobs: the fixer
// (main 10) and, on a provider with an isolation boundary, the review agent and the regression proof's
// test runs (main 11.1, ADR 0017). Local: a child process on this machine (providers/local/runner.ts); aws: an ECS Fargate
// task; gcp: a Cloud Run Job; docker: `docker run`.
//
// A runner only starts and stops fixer runs. The fixer inside reports progress and its result through
// the fixer API (B 9), never through the runner and never into the database. A test run and a review
// run are different: the caller awaits them, and their only results are the exit code the runner
// observes and, for a review, the verdict file the agent leaves in the mounted tree.

import type { HarnessAdapter } from '../config/app-config.ts';
import type { ArtifactRef } from '../contracts/events.ts';
import type { HarnessRunOptions, WorkItemRef } from './harness.ts';

/**
 * Which harness runs the fixer (main 14.5, `<harness fixer="...">`). A `generic` harness names
 * one of the config's `<generic id="...">` command templates.
 */
export type HarnessChoice =
  | { adapter: Exclude<HarnessAdapter, 'generic'> }
  | { adapter: 'generic'; templateId: string };

/** The fixer budget (main 10.4): an ISO 8601 wall clock (default `PT30M`) and an attempt cap. */
export type FixerBudget = HarnessRunOptions['budget'];

/** One fixer run to start. */
export interface FixerJob {
  /**
   * The run's id, minted by the caller (a ULID), which appends `fixer-started { runId }` before it
   * calls `runFixer`, so the fixer's first report always finds its run in the log (B 9, #173).
   */
  runId: string;
  workItem: WorkItemRef;
  /** The `implementation-request` artifact (main 9) the fixer implements. */
  implementationRequestArtifactId: string;
  /** Pins an artifact version; the latest when omitted. */
  implementationRequestVersion?: number;
  harness: HarnessChoice;
  budget: FixerBudget;
  /**
   * The `review` artifact of a `request-changes` verdict, on the one retry run (main 11.1). A runner
   * hands it to the harness next to the implementation request; absent on a first run.
   */
  review?: ArtifactRef;
}

/**
 * One run of a pull request's test command inside the runner's isolation boundary (main 11.1, ADR
 * 0017). The caller prepares the tree on the host; the runner never clones and gets no credential.
 */
export interface TestRunJob {
  /** A plain path segment (a ULID), unique per run; names the run (the docker container). */
  runId: string;
  /**
   * The host directory holding the tree to test: a self-contained repository (its own objects, no
   * remote, no credential, no alternates into another checkout). The runner exposes this directory
   * and nothing else of the host to the command, which may change anything in it; the caller runs
   * nothing in it afterwards.
   */
  checkout: string;
  /** Shell command; exit 0 means the tests pass. Runs with the checkout as its working directory. */
  command: string;
  /** Wall clock for the run in milliseconds; past it the run is killed and `timedOut` is set. */
  timeoutMs: number;
  /** Extra environment for the command, for what the repository's tests need. Never a secret. */
  env?: Readonly<Record<string, string>>;
}

/** How a test run ended. A failing or killed command resolves; only a run that cannot start rejects. */
export interface TestRunResult {
  /** The command's exit code; null when it was killed at the timeout. */
  exitCode: number | null;
  timedOut: boolean;
  /** Combined stdout and stderr, cut from the front to a bounded tail. */
  output: string;
}

/** A runner that can run tests inside its boundary. */
export type TestRunner = Required<Pick<RunnerPort, 'runTests'>>;

/**
 * One run of the review harness (`role: 'review'`, main 11.1) inside the runner's isolation boundary
 * (ADR 0017, #239). The caller prepares the tree on the host and writes the review input into it; the
 * runner exposes that tree and nothing else, passes no git credential and no fixer API token, and the
 * caller reads the verdict file back from the tree afterwards, running nothing in it.
 */
export interface ReviewRunJob {
  /** A plain path segment (a ULID), unique per run; names the run (the docker container). */
  runId: string;
  workItem: WorkItemRef;
  /** The configured review harness (`<harness review="...">`), which the image's wrapper starts. */
  harness: HarnessChoice;
  /** The review budget; past `wallClock` the run is killed and `timedOut` is set. */
  budget: FixerBudget;
  /**
   * The host directory holding the tree to review: a self-contained repository at the pull request's
   * head (its own objects, no remote, no credential, no alternates). The run may change anything in
   * it; the caller only reads the verdict file from it afterwards.
   */
  checkout: string;
  /**
   * Path of the review input (prompts/review.xml's `review-request`) inside `checkout`, relative with
   * `/` separators; the harness gets it on stdin (docs/harness-generic.md section 2).
   */
  inputFile: string;
  /** Path inside `checkout`, relative, that the agent writes its verdict to (`SNAPWING_REVIEW_FILE`). */
  verdictFile: string;
}

/** How a review run ended. The verdict is in the tree, not here; only a run that cannot start rejects. */
export type ReviewRunResult = TestRunResult;

/** A runner that can run the review harness inside its boundary. */
export type ReviewRunner = Required<Pick<RunnerPort, 'runReview'>>;

export interface RunnerPort {
  /**
   * Starts the run under `job.runId` and resolves with that id once it has started, not when it ends.
   * Rejects, starting nothing, when the run cannot start; the caller records that as `fixer-failed`.
   */
  runFixer(job: FixerJob): Promise<{ runId: string }>;
  /**
   * Stops the run (the harness gets SIGTERM, then SIGKILL after its grace). Resolves once the stop
   * is delivered; the local provider waits until the run has ended. Cancelling an unknown or
   * finished run is a no-op.
   */
  cancel(runId: string): Promise<void>;
  /**
   * Runs a test command inside the runner's isolation boundary and resolves when it ends (ADR 0017).
   * Providers with a boundary implement it (docker); the `local` provider does not, and the review
   * job then runs the regression proof on the host with #233's guards, for development only. Rejects
   * when the run cannot happen at all (no daemon, no image); the caller treats that as unprovable.
   */
  runTests?(job: TestRunJob): Promise<TestRunResult>;
  /**
   * Runs the review harness inside the runner's isolation boundary and resolves when it ends (ADR
   * 0017, #239). Providers with a boundary implement it (docker); on `local` it is absent and the
   * review job runs the harness on the host, for development only. The run gets no git credential and
   * no fixer API token, and no model provider key: model access is the server's model proxy (ADR 0017,
   * amendment 1). Rejects when the run cannot happen at all; the caller escalates.
   */
  runReview?(job: ReviewRunJob): Promise<ReviewRunResult>;
}

/** The runner as a `TestRunner` when it can run tests inside its boundary. */
export function testRunnerOf(runner: Pick<RunnerPort, 'runTests'> | undefined): TestRunner | undefined {
  const run = runner?.runTests;
  return run === undefined ? undefined : { runTests: (job) => run.call(runner, job) };
}

/** The runner as a `ReviewRunner` when it can run the review harness inside its boundary. */
export function reviewRunnerOf(runner: Pick<RunnerPort, 'runReview'> | undefined): ReviewRunner | undefined {
  const run = runner?.runReview;
  return run === undefined ? undefined : { runReview: (job) => run.call(runner, job) };
}
