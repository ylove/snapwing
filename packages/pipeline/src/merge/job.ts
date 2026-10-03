// src/merge/job.ts: the merge step (main 11.3, main 14.1, B 5). Revert lives in revert.ts.
//
// Flow:
//   startMergeEvaluate   starts `merge.evaluate` with the singleton key `merge:{incident}`. The review
//                        verdict and the CI completion webhooks both call it (main 14.1); whichever
//                        comes first may find the other not there yet, and the job then waits for it.
//   merge.evaluate       trusts nothing it saw earlier. At run time it re-reads the log, the latest
//                        review for the open PR (and its `review` artifact), the PR's head, the
//                        required checks for that head through `MergeGitHub.combinedStatus`, the files
//                        and line counts, the stop state, and the level re-resolved from the current
//                        map, then calls `evaluateMergeGate` (gate.ts).
//
// Only an incident whose level in force (the last `level-changed`, else the plan's) is 3 is merged
// here; at levels 0, 1, and 2 the job appends nothing but the CI result and a human merges (main
// 11.2). At level 3:
//
// - `merge`: squash merge as the App, pinned to the head sha it evaluated, then `merged` with
//   `levelAtMergeTime`, then the branch is deleted, then `timer.revert` is scheduled with the key
//   `revert:{incident}` at now plus `AppConfig.merge.revertWindow` (default PT72H). When GitHub
//   answers 409 (the head moved between the evaluation and the merge) the whole evaluation runs once
//   more against the new head; a second 409 gives up and appends nothing (the new head's CI webhook
//   starts the job again). A 405, or a merge GitHub reports as not done, is a failed gate.
// - any failed gate: `held { kind: 'gate', reason, gate }` and `level-changed` 3 to 2, so the
//   incident falls back to the level 2 path (main 11.2: review requested, the card says which gate
//   failed and why) and a later run of this job is a no-op.
// - a Stop (`stopped` newer than the last `filed`): nothing; the stop already closed the PR.
// - every gate passes but the workspace instructions hold the merge (A 6.4, `checkInstructions` in
//   instructions.ts, asked only then and only when `instructionsGate` is set): the same `held` and
//   `level-changed` 3 to 2 as a failed gate, with the status sentence as the reason ("Holding for the
//   release window per workspace instructions"). A human's Merge tap on the 11.2 card still merges.
//
// Waiting, not failing: no review for the open PR yet, or required checks still pending with none
// failing while every other gate passes. The job appends nothing and the next webhook starts it again.
// A base branch that requires no checks is never green: `combinedStatus` reports that as a vacuous
// `success`, so this job reads the `required` list and never the combined state.
//
// The level at merge time is the map's level re-resolved now (surface, component, and the priority
// on the incidents row, which follows Jira edits). The risk limits are the stricter of
// `AppConfig.merge` and the map's `policies/riskGate`, and the built-in forbidden paths always apply.
//
// CI first, at every level (#214): while the lifecycle waits for CI (`ci`, `ci-retry`), the job calls
// `recordCiResult` (ci.ts) before anything else, so CI that finished before the review passed is
// recorded without waiting for another check delivery or the reconciler: `ci-green` moves the
// incident to `mergeable` (where a human merge at levels 0 to 2 fits B 5), and `ci-red` starts the
// fixer retry and ends the job (`skipped`, `ci-red`). When the checks turn green between that read
// and the gate's, `ci-green` is appended in the same append as `merged` or `held`, by the same rule
// (`ciResultEvents`), so the lifecycle reaches `mergeable` first (B 5).
//
// Every append passes `expectedSeq` through `appendDecided` and decides again on a conflict.

import type { AutonomyLevel, IncidentEvent, NewEvent } from '../contracts/events.ts';
import { keySegment, timerKey } from '../contracts/jobs.ts';
import { DEFAULT_MERGE_FORBIDDEN, type MergeConfig } from '../config/app-config.ts';
import { appendDecided, currentLevel, instructionsIncident, latest, lastSeqOf, newEvent, stoppedSinceFiled } from '../fixer/job.ts';
import type { JiraPriorityName, WorkspaceMap } from '../map/types.ts';
import { resolveAutonomy } from '../policy/autonomy.ts';
import type { StatePort } from '../ports/state.ts';
import type { WorkflowPort } from '../ports/workflow.ts';
import { parseReviewVerdict } from '../review/verdict.ts';
import { parseDuration } from '../util/duration.ts';
import { repoFullName } from '../util/repo.ts';
import { awaitingCi, ciResultEvents, recordCiResult } from './ci.ts';
import { evaluateMergeGate, type ChangedFile, type MergeGateResult, type RequiredCheck, type ReviewVerdict } from './gate.ts';
import { checkInstructions, type InstructionsGate } from './instructions.ts';

export { statusOf } from './ci.ts';

/** Prefix of the `level-changed` reason that records a held autopilot merge. */
export const MERGE_HELD_REASON_PREFIX = 'merge-held:';
/** The level a held autopilot merge falls back to (main 11.3: "degrade to 11.2"). */
export const MERGE_HELD_LEVEL: AutonomyLevel = 2;

// The GitHub side --------------------------------------------------------------------------------

/** The fields of a pull request the merge step reads. */
export interface MergePullRequest {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
}

export interface MergePullRequestFile {
  filename: string;
  additions: number;
  deletions: number;
}

export interface MergeRequiredCheck {
  name: string;
  state: 'success' | 'pending' | 'failure';
  /** `null` when nothing has reported under that name yet. */
  source: string | null;
}

export interface MergeCombinedStatus {
  /** The checks the base branch requires. Empty when it requires none (the combined state is then a vacuous `success`). */
  required: readonly MergeRequiredCheck[];
}

export interface MergeResult {
  merged: boolean;
  sha: string;
  message: string;
}

export interface RevertPullRequestResult {
  number: number;
  url: string;
}

/**
 * The GitHub operations the merge step and Revert use, for one repository. The app's `GitHubClient`
 * (`app/src/github/client.ts`) satisfies it as is. Errors carry the HTTP `status`: 409 from
 * `mergePullRequest` means the head moved since `expectedHeadSha`, 405 means GitHub will not merge.
 */
export interface MergeGitHub {
  getPullRequest(number: number): Promise<MergePullRequest>;
  listPullRequestFiles(number: number): Promise<readonly MergePullRequestFile[]>;
  combinedStatus(sha: string, baseBranch: string): Promise<MergeCombinedStatus>;
  /** Squash merge as the App, pinned to `expectedHeadSha`. */
  mergePullRequest(number: number, input: { expectedHeadSha: string; commitTitle?: string; commitMessage?: string }): Promise<MergeResult>;
  deleteBranch(branch: string): Promise<void>;
  /** GraphQL `revertPullRequest`; the pull request must already be merged. */
  openRevertPullRequest(number: number, input?: { title?: string; body?: string }): Promise<RevertPullRequestResult>;
}

/** Where the level is re-resolved from: the loaded map, or a getter that returns the current one. */
export type MergeMapSource = Pick<WorkspaceMap, 'policies'> | (() => Promise<Pick<WorkspaceMap, 'policies'>>);

export interface MergeDeps {
  /** The install's workspace (single tenant), stamped on every event. */
  workspaceId: string;
  state: StatePort;
  workflow: WorkflowPort;
  /** A client for one `owner/name` repository. */
  github: (repo: string) => MergeGitHub;
  /** `AppConfig.merge`. */
  merge: MergeConfig;
  map: MergeMapSource;
  clock: () => Date;
  /** Called when the revert window closes on a merge that was not reverted (B 5: remove the Revert button). */
  onRevertWindowClosed?: (incidentId: string) => Promise<void>;
  /** The live workspace instructions and the model that applies them before an autopilot merge (A 6.4). Absent: no check. */
  instructionsGate?: InstructionsGate;
}

// Jobs -------------------------------------------------------------------------------------------

export interface MergeEvaluateData {
  incidentId: string;
}

export function isMergeEvaluateData(v: unknown): v is MergeEvaluateData {
  return typeof v === 'object' && v !== null && typeof (v as { incidentId?: unknown }).incidentId === 'string' && (v as { incidentId: string }).incidentId !== '';
}

/** Singleton key of an incident's `merge.evaluate` job: one evaluation per incident at a time. */
export function mergeEvaluateKey(incidentId: string): string {
  return `merge:${keySegment(incidentId)}`;
}

export function revertTimerKey(incidentId: string): string {
  return timerKey('revert', { incidentId });
}

/** Registers the `merge.evaluate` handler. `timer.revert` is registered by `registerRevertTimer` (revert.ts). */
export function registerMergeJobs(deps: MergeDeps): void {
  deps.workflow.work('merge.evaluate', async (job) => {
    if (!isMergeEvaluateData(job.data)) throw new Error('merge.evaluate: malformed job data');
    await evaluateMerge(deps, job.data);
  });
}

/** Starts the incident's `merge.evaluate` job (main 14.1). A start while one is queued returns that job. */
export function startMergeEvaluate(deps: Pick<MergeDeps, 'workflow'>, incidentId: string): Promise<{ jobId: string }> {
  return deps.workflow.start('merge.evaluate', { incidentId } satisfies MergeEvaluateData, { singletonKey: mergeEvaluateKey(incidentId) });
}

// merge.evaluate ---------------------------------------------------------------------------------

export type MergeSkip = 'no-pr' | 'no-repo' | 'not-autopilot' | 'already-merged' | 'already-held' | 'stopped' | 'ci-red' | 'not-open' | 'head-moved';

export type MergeOutcome =
  | { outcome: 'merged'; prNumber: number; mergeCommitSha: string; gate: MergeGateResult; branchDeleted: boolean }
  | { outcome: 'held'; prNumber: number; reason: string; gate: MergeGateResult }
  | { outcome: 'waiting'; on: 'review' | 'ci' }
  | { outcome: 'skipped'; reason: MergeSkip; level?: AutonomyLevel };

/** The `merge.evaluate` handler. */
export async function evaluateMerge(deps: MergeDeps, data: MergeEvaluateData): Promise<MergeOutcome> {
  // Pass 2 runs only after a 409: the head moved between the evaluation and the merge.
  for (let pass = 1; ; pass++) {
    const result = await evaluateOnce(deps, data.incidentId);
    if (result !== HEAD_MOVED) return result;
    if (pass >= 2) return { outcome: 'skipped', reason: 'head-moved' };
  }
}

const HEAD_MOVED = Symbol('head-moved');

async function evaluateOnce(deps: MergeDeps, incidentId: string): Promise<MergeOutcome | typeof HEAD_MOVED> {
  let log = await deps.state.read(incidentId);
  if (awaitingCi(log)) {
    // At every level: CI that finished before the review is recorded here (#214).
    const ci = await recordCiResult(deps, incidentId);
    if (ci.recorded !== false) log = await deps.state.read(incidentId);
  }
  const opened = latest(log, 'pr-opened');
  if (opened === undefined) return { outcome: 'skipped', reason: 'no-pr' };
  const prNumber = opened.payload.prNumber;
  const pre = precheck(log);
  if (pre !== undefined) return pre;

  const incident = await deps.state.getIncident(incidentId);
  const mapRepo = incident?.repo;
  if (mapRepo === undefined || mapRepo === '') return { outcome: 'skipped', reason: 'no-repo' };
  const repo = repoFullName(mapRepo);

  const review = await reviewVerdict(deps.state, log, prNumber);
  if (review === undefined) return { outcome: 'waiting', on: 'review' };

  const gh = deps.github(repo);
  const pr = await gh.getPullRequest(prNumber);
  if (pr.state !== 'open' || pr.merged) return { outcome: 'skipped', reason: 'not-open' };
  const [status, prFiles, map] = await Promise.all([gh.combinedStatus(pr.headSha, pr.baseRef), gh.listPullRequestFiles(prNumber), loadMap(deps.map)]);

  const requiredChecks: RequiredCheck[] = status.required.map((c) => ({ name: c.name, state: c.source === null ? 'missing' : c.state }));
  const files: ChangedFile[] = prFiles.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions }));
  const plannedPriority = latest(log, 'planned')?.payload.priority;
  const priority = isPriority(incident?.priority) ? incident.priority : (plannedPriority ?? 'Medium');
  const levelAtMergeTime = resolveAutonomy(
    { ...(incident?.surfaceId === undefined ? {} : { surfaceId: incident.surfaceId }), ...(incident?.componentId === undefined ? {} : { componentId: incident.componentId }) },
    { priority },
    map,
  );
  const input = { reviewVerdict: review, requiredChecks, files, stopped: stoppedSinceFiled(log), levelAtMergeTime, limits: riskLimits(deps.merge, map) };
  const gate = evaluateMergeGate(input);

  if (gate.decision === 'hold') return { outcome: 'skipped', reason: 'stopped' };
  if (gate.decision === 'degrade' && ciPending(requiredChecks)) {
    // Pending is not failing: hold now only when another gate fails regardless of CI.
    const ifGreen = evaluateMergeGate({ ...input, requiredChecks: requiredChecks.map((c) => ({ ...c, state: 'success' as const })) });
    if (ifGreen.decision === 'merge') return { outcome: 'waiting', on: 'ci' };
    if (ifGreen.decision === 'hold') return { outcome: 'skipped', reason: 'stopped' };
    return hold(deps, incidentId, prNumber, pr.headSha, { ...gate, reason: ifGreen.reason ?? 'gate failed' });
  }
  if (gate.decision === 'degrade') return hold(deps, incidentId, prNumber, pr.headSha, gate);

  // Every gate passed: the workspace instructions may still hold this merge, never force one (A 6.4).
  const instructed = await checkInstructions(deps.instructionsGate, {
    step: 'merge',
    now: deps.clock(),
    incident: { ...instructionsIncident(log, incident), repo, priority, level: 3 },
    pullRequest: { number: prNumber, files: files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })) },
  });
  if (instructed.hold) return hold(deps, incidentId, prNumber, pr.headSha, { ...gate, decision: 'degrade', reason: instructed.status });

  let merge: MergeResult;
  try {
    merge = await gh.mergePullRequest(prNumber, { expectedHeadSha: pr.headSha });
  } catch (e) {
    if (httpStatus(e) === 409) return HEAD_MOVED;
    if (httpStatus(e) === 405) return hold(deps, incidentId, prNumber, pr.headSha, refused(gate, errorMessage(e)));
    throw e;
  }
  if (!merge.merged) return hold(deps, incidentId, prNumber, pr.headSha, refused(gate, merge.message));

  // GitHub merged it: record that whatever the log now says, so the merge is never unrecorded.
  await appendDecided(deps.state, incidentId, (events) => {
    if (mergedSince(events, prNumber)) return undefined;
    return [
      ...ciGreenFirst(deps, incidentId, events, prNumber, pr.headSha),
      newEvent(deps, incidentId, 'merged', { prNumber, mergeCommitSha: merge.sha, levelAtMergeTime: 3 }),
    ];
  });
  let branchDeleted = true;
  try {
    await gh.deleteBranch(pr.headRef);
  } catch {
    // The repo may delete merged branches itself; a branch left behind never undoes the merge.
    branchDeleted = false;
  }
  const fireAt = new Date(deps.clock().getTime() + parseDuration(deps.merge.revertWindow));
  await deps.workflow.schedule('timer.revert', { incidentId } satisfies MergeEvaluateData, fireAt, { singletonKey: revertTimerKey(incidentId) });
  return { outcome: 'merged', prNumber, mergeCommitSha: merge.sha, gate, branchDeleted };
}

/** Appends `held` and the fall back to level 2, unless the log moved on meanwhile. */
async function hold(deps: MergeDeps, incidentId: string, prNumber: number, headSha: string, gate: MergeGateResult): Promise<MergeOutcome> {
  const reason = gate.reason ?? 'gate failed';
  let skip: MergeSkip = 'already-held';
  const appended = await appendDecided(deps.state, incidentId, (events) => {
    const pre = precheck(events);
    if (pre !== undefined) {
      skip = pre.reason;
      return undefined;
    }
    const ci = gate.ciGreen ? ciGreenFirst(deps, incidentId, events, prNumber, headSha) : [];
    return [
      ...ci,
      newEvent(deps, incidentId, 'held', { kind: 'gate', reason, gate: { ...gate, reason } }),
      newEvent(deps, incidentId, 'level-changed', { from: 3, to: MERGE_HELD_LEVEL, reason: `${MERGE_HELD_REASON_PREFIX} ${reason}` }),
    ];
  });
  if (!appended.appended) return { outcome: 'skipped', reason: skip };
  return { outcome: 'held', prNumber, reason, gate: { ...gate, reason } };
}

/** Why the job does nothing for this log, before any GitHub call. */
function precheck(log: readonly IncidentEvent[]): { outcome: 'skipped'; reason: MergeSkip; level?: AutonomyLevel } | undefined {
  const opened = latest(log, 'pr-opened');
  if (opened === undefined) return { outcome: 'skipped', reason: 'no-pr' };
  if (mergedSince(log, opened.payload.prNumber)) return { outcome: 'skipped', reason: 'already-merged' };
  if (stoppedSinceFiled(log)) return { outcome: 'skipped', reason: 'stopped' };
  // A red head belongs to the fixer retry or, on the retry, to a human (B 5), never to a hold.
  if (lastSeqOf(log, 'ci-red') > opened.seq) return { outcome: 'skipped', reason: 'ci-red' };
  const level = currentLevel(log);
  if (level !== 3) {
    const held = latest(log, 'held');
    if (held !== undefined && held.payload.kind === 'gate' && held.seq > opened.seq) return { outcome: 'skipped', reason: 'already-held' };
    return { outcome: 'skipped', reason: 'not-autopilot', ...(level === undefined ? {} : { level }) };
  }
  return undefined;
}

/** A `merged` for PR `prNumber` after its latest `pr-opened`. */
function mergedSince(events: readonly IncidentEvent[], prNumber: number): boolean {
  const since = lastSeqOf(events, 'pr-opened');
  return events.some((e) => e.seq > since && e.type === 'merged' && e.payload.prNumber === prNumber);
}

/** `ci-green` for the head, when the lifecycle still waits for it (status `ci` or `ci-retry`) and it is not recorded. */
function ciGreenFirst(deps: MergeDeps, incidentId: string, events: readonly IncidentEvent[], prNumber: number, headSha: string): NewEvent[] {
  return ciResultEvents(deps, incidentId, events, { prNumber, headSha, checks: { state: 'green' } });
}

/**
 * The verdict of the latest review of PR `prNumber` since the latest fixer run started (a retry's
 * review replaces the first one), or undefined when that PR has not been reviewed yet. A
 * `review-passed` approves only when its `review` artifact, when it has one, parses to `approve`;
 * an unreadable or disagreeing artifact never approves.
 */
export async function reviewVerdict(state: StatePort, log: readonly IncidentEvent[], prNumber: number): Promise<ReviewVerdict | undefined> {
  const since = lastSeqOf(log, 'fixer-started');
  let review: IncidentEvent<'review-passed'> | IncidentEvent<'review-failed'> | undefined;
  for (const e of log) {
    if (e.seq <= since) continue;
    if ((e.type === 'review-passed' || e.type === 'review-failed') && e.payload.prNumber === prNumber) review = e;
  }
  if (review === undefined) return undefined;
  if (review.type === 'review-failed') return review.payload.verdict;
  const ref = review.payload.review;
  if (ref === undefined) return 'approve';
  const artifact = await state.getArtifact(ref.artifactId, ref.version);
  if (artifact.kind !== 'review') return 'escalate';
  const parsed = parseReviewVerdict(artifact.body);
  return parsed.ok ? parsed.verdict.verdict : 'escalate';
}

/** The stricter of `AppConfig.merge` and the map's risk gate; the built-in forbidden paths always apply. */
export function riskLimits(config: MergeConfig, map: Pick<WorkspaceMap, 'policies'>): Pick<MergeConfig, 'maxFiles' | 'maxDiffLines' | 'forbidden'> {
  const fromMap = map.policies.riskGate;
  return {
    maxFiles: fromMap === undefined ? config.maxFiles : Math.min(config.maxFiles, fromMap.maxFilesTouched),
    maxDiffLines: fromMap === undefined ? config.maxDiffLines : Math.min(config.maxDiffLines, fromMap.maxDiffLines),
    forbidden: [...new Set([...DEFAULT_MERGE_FORBIDDEN, ...config.forbidden, ...(fromMap?.forbiddenPaths ?? [])])],
  };
}

function ciPending(checks: readonly RequiredCheck[]): boolean {
  return checks.length > 0 && !checks.some((c) => c.state === 'failure') && checks.some((c) => c.state !== 'success');
}

function refused(gate: MergeGateResult, message: string): MergeGateResult {
  const why = message.trim() === '' ? 'GitHub did not merge the pull request' : message.trim();
  return { ...gate, decision: 'degrade', reason: `merge refused by GitHub: ${why}` };
}

async function loadMap(source: MergeMapSource): Promise<Pick<WorkspaceMap, 'policies'>> {
  return typeof source === 'function' ? source() : source;
}

const PRIORITIES: readonly string[] = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];

function isPriority(v: string | undefined): v is JiraPriorityName {
  return v !== undefined && PRIORITIES.includes(v);
}

/** The HTTP status an error carries (`GitHubApiError.status`), if any. */
export function httpStatus(e: unknown): number | undefined {
  const status = typeof e === 'object' && e !== null ? (e as { status?: unknown }).status : undefined;
  return typeof status === 'number' ? status : undefined;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
