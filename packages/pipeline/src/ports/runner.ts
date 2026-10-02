// src/ports/runner.ts (main 14.3): the runner runtime port, which runs the one ephemeral job type,
// the fixer (main 10). Local: a child process on this machine (providers/local/runner.ts); aws: an
// ECS Fargate task; gcp: a Cloud Run Job; docker: `docker run`.
//
// A runner only starts and stops runs. The fixer inside reports progress and its result through the
// fixer API (B 9), never through the runner and never into the database.

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
}
