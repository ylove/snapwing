// src/merge/ci.ts: recording the CI result of a pull request, and the fixer retry it starts
// (B 5, B 8, main 10, main 11; #214).
//
// B 5 takes `ci-green` and `ci-red` only in `ci` and `ci-retry`, that is, after `review-passed`. CI
// finishes whenever it finishes, often before the review does, so the result is asked for at each
// moment the lifecycle may have started waiting for it, and every one of those callers goes through
// `recordCiResult`:
//   - the GitHub webhook (app/src/webhooks/github.ts), when a check for the PR's head completes;
//   - the review job (review/job.ts), right after it appends `review-passed`, for CI that finished
//     before the review did;
//   - `merge.evaluate` (merge/job.ts), at every level, before it decides anything else.
// The reconciler (B 8) stays the backstop for a webhook that never arrived.
//
// recordCiResult   re-reads the log and returns before any GitHub call unless the lifecycle waits for
//                  CI (`ci`, `ci-retry`) on the latest `pr-opened`. It reads the PR (closed, merged,
//                  or a head other than the caller's `headSha` records nothing) and the base branch's
//                  required checks for the head. Once every required check has completed it appends
//                  one `ci-green`, or `ci-red` with the failing check names (source `github`). A
//                  required check still running or not yet reported waits; a base branch that requires
//                  no checks is never green (`combinedStatus.state` is vacuously `success` then; this
//                  reads `required` only). After `ci-red` it starts the fixer retry. Starting
//                  `merge.evaluate` after `ci-green` is the caller's: the webhook starts it, the
//                  review job starts it whatever CI says, and `merge.evaluate` is it.
// ciResultEvents   the one rule for what may be appended, decided on the log the append reads (so a
//                  webhook, the review job, and `merge.evaluate` racing on one head append once): the
//                  lifecycle waits for CI, the PR is the latest `pr-opened`, and no `ci-green` or
//                  `ci-red` for that head sha was recorded since it. One result per head sha.
// retryFixerAfterCiRed
//                  consumes `ci-red` (main 10: retry the fixer once with the failing checks). When the
//                  `ci-red` moved the lifecycle to `fixing-retry` (from `ci`; from `ci-retry` it
//                  escalates, B 5) on the fixer's own PR, it stores a `review` artifact in the
//                  `ReviewVerdict` shape (`request-changes`, a reason and a `ci` violation per failing
//                  check) and starts `fixer.run` for the next attempt with it, which the runner hands
//                  the harness as `SNAPWING_PRIOR_REVIEW_FILE`, as a review's retry does (main 11.1).
//                  A human's PR is left to the human. The retry budget is shared with the review: the
//                  retry's review escalates a `request-changes` (review/job.ts `LAST_FIXER_ATTEMPT`)
//                  and its `ci-red` lands in `ci-retry`, which escalates.
//
// Every append passes `expectedSeq` through `appendDecided` and decides again on a conflict.

import type { EventSource, IncidentEvent, NewEvent } from '../contracts/events.ts';
import { appendDecided, latest, lastSeqOf, newEvent, startFixer, stoppedSinceFiled, type FixerDeps } from '../fixer/job.ts';
import { INITIAL_STATUS, nextStatus, type LifecycleStatus } from '../lifecycle/machine.ts';
import type { StatePort } from '../ports/state.ts';
import type { WorkflowPort } from '../ports/workflow.ts';
import type { ReviewVerdict } from '../review/verdict.ts';
import { repoFullName } from '../util/repo.ts';
import type { MergeCombinedStatus, MergeRequiredCheck } from './job.ts';

/** The statuses in which the lifecycle waits for a CI result (B 5). */
export const AWAITING_CI: readonly LifecycleStatus[] = Object.freeze(['ci', 'ci-retry']);
/** `createdBy` of the `review` artifact a `ci-red` retry hands the fixer. */
export const CI_RESULT_AUTHOR = 'ci';

// The GitHub side --------------------------------------------------------------------------------

/** The fields of a pull request `recordCiResult` reads. */
export interface CiPullRequest {
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
  baseRef: string;
}

/** The GitHub calls `recordCiResult` makes, for one repository. The app's `GitHubClient` satisfies it. */
export interface CiGitHub {
  getPullRequest(number: number): Promise<CiPullRequest>;
  combinedStatus(sha: string, baseBranch: string): Promise<MergeCombinedStatus>;
}

export interface CiDeps {
  /** The install's workspace (single tenant), stamped on every event and artifact. */
  workspaceId: string;
  state: StatePort;
  workflow: WorkflowPort;
  /** A client for one `owner/name` repository. */
  github: (repo: string) => CiGitHub;
  clock: () => Date;
}

// Reading the checks -----------------------------------------------------------------------------

/** What the required checks for a head say. */
export type CiChecks = { state: 'pending' } | { state: 'none-required' } | { state: 'green' } | { state: 'red'; failingChecks: string[] };

/** Complete only when every required check has reported and completed; no required checks is never green. */
export function ciChecksOf(required: readonly MergeRequiredCheck[]): CiChecks {
  if (required.length === 0) return { state: 'none-required' };
  if (required.some((c) => c.source === null || c.state === 'pending')) return { state: 'pending' };
  const failingChecks = required.filter((c) => c.state === 'failure').map((c) => c.name);
  return failingChecks.length === 0 ? { state: 'green' } : { state: 'red', failingChecks };
}

// The rule ---------------------------------------------------------------------------------------

/** The lifecycle status the log folds to (B 5), as the incidents projection computes it. */
export function statusOf(events: readonly IncidentEvent[]): LifecycleStatus {
  return events.reduce<LifecycleStatus>((s, e) => nextStatus(s, e), INITIAL_STATUS);
}

/** Whether the lifecycle waits for a CI result (B 5: `ci`, `ci-retry`). */
export function awaitingCi(log: readonly IncidentEvent[]): boolean {
  return AWAITING_CI.includes(statusOf(log));
}

/** A `ci-green` or `ci-red` for PR `prNumber` at `headSha` since the latest `pr-opened`. */
export function ciRecorded(log: readonly IncidentEvent[], prNumber: number, headSha: string): boolean {
  const since = lastSeqOf(log, 'pr-opened');
  return log.some((e) => e.seq > since && (e.type === 'ci-green' || e.type === 'ci-red') && e.payload.prNumber === prNumber && e.payload.headSha === headSha);
}

/**
 * The `ci-green` or `ci-red` to append for PR `prNumber` at `headSha`, or nothing: the one place that
 * keeps a result to the lifecycle's wait for CI and to one per head sha.
 */
export function ciResultEvents(
  deps: Pick<CiDeps, 'workspaceId' | 'clock'>,
  incidentId: string,
  log: readonly IncidentEvent[],
  input: { prNumber: number; headSha: string; checks: Extract<CiChecks, { state: 'green' | 'red' }>; source?: EventSource },
): NewEvent[] {
  const { prNumber, headSha, checks } = input;
  if (latest(log, 'pr-opened')?.payload.prNumber !== prNumber || !awaitingCi(log) || ciRecorded(log, prNumber, headSha)) return [];
  const source = input.source ?? 'github';
  return [
    checks.state === 'green'
      ? newEvent(deps, incidentId, 'ci-green', { prNumber, headSha }, { source })
      : newEvent(deps, incidentId, 'ci-red', { prNumber, headSha, failingChecks: [...checks.failingChecks] }, { source }),
  ];
}

// recordCiResult ---------------------------------------------------------------------------------

export type CiRecordSkip = 'not-awaiting' | 'no-repo' | 'not-open' | 'head-moved' | 'pending' | 'none-required' | 'already-recorded';

export type CiRecordOutcome =
  | { recorded: 'ci-green'; prNumber: number; headSha: string }
  | { recorded: 'ci-red'; prNumber: number; headSha: string; failingChecks: string[]; fixerRestarted: boolean }
  | { recorded: false; reason: CiRecordSkip };

/**
 * Records the CI result of the incident's open PR when the lifecycle waits for it and every required
 * check for the head has completed; after `ci-red`, starts the fixer retry. `headSha`, when given, is
 * the head the caller is about (a check delivery's, the reviewed one): another head records nothing.
 */
export async function recordCiResult(deps: CiDeps, incidentId: string, opts: { headSha?: string } = {}): Promise<CiRecordOutcome> {
  const log = await deps.state.read(incidentId);
  const opened = latest(log, 'pr-opened');
  // Before any GitHub call: most callers ask while nothing waits for CI.
  if (opened === undefined || !awaitingCi(log)) return skip('not-awaiting');
  const prNumber = opened.payload.prNumber;
  const mapRepo = (await deps.state.getIncident(incidentId))?.repo;
  if (mapRepo === undefined || mapRepo === '') return skip('no-repo');
  const repo = repoFullName(mapRepo);

  const gh = deps.github(repo);
  const pr = await gh.getPullRequest(prNumber);
  if (pr.state !== 'open' || pr.merged) return skip('not-open');
  if (opts.headSha !== undefined && pr.headSha !== opts.headSha) return skip('head-moved');
  const headSha = pr.headSha;
  if (ciRecorded(log, prNumber, headSha)) return skip('already-recorded');
  const checks = ciChecksOf((await gh.combinedStatus(headSha, pr.baseRef)).required);
  if (checks.state === 'pending' || checks.state === 'none-required') return skip(checks.state);

  const appended = await appendDecided(deps.state, incidentId, (events) => ciResultEvents(deps, incidentId, events, { prNumber, headSha, checks }));
  if (!appended.appended) return skip(awaitingCi(appended.before) ? 'already-recorded' : 'not-awaiting');
  if (checks.state === 'green') return { recorded: 'ci-green', prNumber, headSha };
  const fixerRestarted = await retryFixerAfterCiRed(deps, incidentId);
  return { recorded: 'ci-red', prNumber, headSha, failingChecks: checks.failingChecks, fixerRestarted };
}

// The ci-red retry -------------------------------------------------------------------------------

/**
 * After `ci-red` (main 10): starts `fixer.run` for the next attempt with the failing checks as a
 * `review` artifact, when that `ci-red` moved the fixer's PR to `fixing-retry` and no retry started
 * since. True when it started one. Safe to call again: the fixer job refuses an attempt that ran.
 */
export async function retryFixerAfterCiRed(deps: Pick<FixerDeps, 'workspaceId' | 'state' | 'workflow' | 'clock'>, incidentId: string): Promise<boolean> {
  const log = await deps.state.read(incidentId);
  const red = latest(log, 'ci-red');
  const opened = latest(log, 'pr-opened');
  if (red === undefined || opened === undefined || opened.seq > red.seq) return false;
  // Only the fixer's own PR is the fixer's to retry; a human's PR stays theirs.
  if (opened.source !== 'fixer' || statusOf(log) !== 'fixing-retry' || stoppedSinceFiled(log)) return false;
  if (lastSeqOf(log, 'fixer-started') > red.seq) return false;

  const verdict = ciRedReview(red.payload.failingChecks, red.payload.headSha);
  const put = await deps.state.putArtifact({
    workspaceId: deps.workspaceId,
    incidentId,
    kind: 'review',
    contentType: 'application/json',
    body: JSON.stringify(verdict),
    createdBy: CI_RESULT_AUTHOR,
  });
  const attempt = (latest(log, 'fixer-started')?.payload.attempt ?? 1) + 1;
  await startFixer(deps, { incidentId, attempt, reviewArtifact: { artifactId: put.id, version: put.version } });
  return true;
}

/** The prior review a `ci-red` retry hands the fixer: valid for `parseReviewVerdict`, never an approval. */
export function ciRedReview(failingChecks: readonly string[], headSha: string): ReviewVerdict {
  const names = failingChecks.length > 0 ? failingChecks.join(', ') : 'unnamed';
  return {
    verdict: 'request-changes',
    reasons: [`Required CI checks failed on ${headSha.slice(0, 12)}: ${names}. Make them pass without changing CI configuration.`],
    constraintViolations: failingChecks.map((name) => ({ constraint: 'ci', note: `required check ${name} failed` })),
  };
}

function skip(reason: CiRecordSkip): CiRecordOutcome {
  return { recorded: false, reason };
}
