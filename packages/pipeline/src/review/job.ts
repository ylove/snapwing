// src/review/job.ts: the review job (main 11.1, main 11.2, main 14.5, B 5).
//
// Flow:
//   startReview     starts `review.run` for the incident's open PR at its head commit, with the
//                   singleton key `review:{incident}:{headSha}`. The fixer API's `onDone` hook calls it
//                   after `fixer-done` and `pr-opened` (CONTEXT.md: the code that appends the
//                   triggering event starts the follow-up job). The head comes from GitHub unless given.
//   review.run      trusts nothing the fixer reported. It re-reads the log and refuses, appending
//                   nothing, when the PR is not the latest `pr-opened`, a fixer run is going or started
//                   after that `pr-opened`, a `stopped` is newer than the last `filed`, or since the
//                   latest `fixer-started` this head was approved or this PR failed review (an approval
//                   covers only its head, #264). It reads the PR from GitHub
//                   (closed, merged, or a head that moved is a skip; a moved head starts a review of the
//                   new head), opens the `snapwing/review` check run `in_progress`, and then:
//
//   1. Checks out the PR head in a fresh directory of its own under `workdirRoot` with
//      `prepareWorkdir` (never the fixer's checkout, never its transcript or summary).
//   2. Runs the configured review harness with `role: 'review'`. Its input is the request's
//      constraints and the PR diff against the merge base, nothing else (prompts/review.xml). The
//      agent reads the checkout and never runs the PR's code (#263): the built-in adapters give it
//      read-only tools, its tree holds none of the checkout's agent CLI configuration
//      (`AGENT_CONFIG_PATHS`), and its verdict, the end of its final message, reaches `SNAPWING_REVIEW_FILE`
//      only after it has exited, written by the adapter (or the image's wrapper), never by anything
//      the agent ran. `parseReviewVerdict` validates the file. Its environment carries no git
//      credential: a reviewer never pushes. A harness that fails, stops, throws, or writes no valid
//      verdict is `escalate`. With a runner that has an isolation boundary (`runner.runReview`:
//      docker), the agent runs inside it and no host process runs the review harness (ADR 0017): the
//      job builds a self-contained copy of the checkout at the head (no remote, no credential, no
//      alternates), writes the review input into its `.git/snapwing/`, hands that tree to the runner as
//      the only mount, and afterwards only reads the verdict file back, refusing a symlink or anything
//      but a small regular file inside the tree; it never runs git in that tree again. The `local`
//      runner has no boundary, and the harness runs on the host with its guards (development only).
//   3. Runs `checkConstraints` on the PR's changed files as GitHub lists them. The fixer's git hooks
//      are advisory (a harness can push with `--no-verify`), so nothing the fixer reported is used.
//   4. When the request requires tests, runs `proveRegression`, from the merge base to the head, with
//      the configured command, on the test files the reviewed head itself changes: the job's own diff
//      of its checkout at that head, never a later push GitHub lists, the fixer's report, or the
//      reviewer's word (#263). A proven regression test is recorded as one of those files: the
//      reviewer's `regressionTest` when it is one of them. The verdict is read before the first test
//      run starts, and the test runs get trees of their own. With a runner that has an isolation
//      boundary (`runner.runTests`: docker), both test runs happen inside it and no host process runs
//      the PR's test command (ADR 0017); the `local` runner has none, and the proof runs on the host
//      with its guards (development only).
//   5. Combines them: a scope or forbidden violation, or a regression test that is missing, passes
//      without the fix, fails with it, or times out, turns an `approve` into `request-changes`. A
//      proof that cannot run (no test command for the repo, a git error, no checkout) turns an
//      `approve` into `escalate`. A `request-changes` on the fixer's second attempt becomes
//      `escalate` (main 11.1: "a second failure escalates").
//
//   Then it posts the GitHub review pinned to the head (APPROVE, REQUEST_CHANGES, or COMMENT for
//   escalate; GitHub refuses APPROVE and REQUEST_CHANGES from a PR's own author with 422, and the App
//   both opens and reviews fixer PRs, so a 422 is posted again as COMMENT; the check run is what
//   branch protection requires, main 11.2), completes the check run (`success` only for approve),
//   stores the combined verdict as a `review` artifact in exactly the `ReviewVerdict` shape (the
//   merge step parses it with `parseReviewVerdict` and treats anything else as not approved), and
//   appends `review-passed` or `review-failed` with that artifact. `request-changes` then starts the
//   fixer once more (`startFixer` attempt 2 with the review artifact, which the runner hands the
//   harness as `SNAPWING_PRIOR_REVIEW_FILE`). After `review-passed` the lifecycle waits for CI (B 5),
//   and CI often finished first, with no check delivery left to report it: `recordCiResult`
//   (merge/ci.ts) records it for the reviewed head now, and a `ci-red` starts the fixer retry
//   there. Otherwise `approve` and `escalate` start `merge.evaluate` (main 14.1), which merges or
//   holds at level 3 and below it records nothing but a CI result.
//
// Every append passes `expectedSeq` through `appendDecided` and decides again on a conflict.

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { instructionsBlock } from '../config/instructions.ts';
import type { ArtifactRef, IncidentEvent } from '../contracts/events.ts';
import { isReviewRunData, reviewRunKey, type ReviewRunData } from '../contracts/jobs.ts';
import { activeRun, appendDecided, latest, lastSeqOf, newEvent, startFixer, stoppedSinceFiled } from '../fixer/job.ts';
import { prepareWorkdir, SNAPWING_GIT_DIR, type GitIdentity, type PreparedWorkdir } from '../fixer/workdir/index.ts';
import { recordCiResult } from '../merge/ci.ts';
import { httpStatus, startMergeEvaluate, type MergeCombinedStatus } from '../merge/job.ts';
import type { HarnessPort, WorkItemRef } from '../ports/harness.ts';
import { reviewRunnerOf, testRunnerOf, type HarnessChoice, type ReviewRunner, type RunnerPort } from '../ports/runner.ts';
import type { StatePort } from '../ports/state.ts';
import type { WorkflowPort } from '../ports/workflow.ts';
import { parseImplementationRequest, type ImplementationRequest } from '../prompts/implementation-request.ts';
import { repoFullName } from '../util/repo.ts';
import { ulid } from '../util/ulid.ts';
import { isolatedTree, proveRegression, selectTestFiles, type RegressionResult, type RegressionStatus } from './regression.ts';
import { checkConstraints, parseReviewVerdict, REVIEW_FILE_ENV, type ConstraintViolation, type ReviewVerdict } from './verdict.ts';

/** The check run branch protection requires (main 11.2). Same name as the app client's default. */
export const REVIEW_CHECK_NAME = 'snapwing/review';
/** The environment variable naming the file a review harness leaves its verdict in (review/verdict.ts). */
export { REVIEW_FILE_ENV };
export const DEFAULT_REVIEW_WALL_CLOCK = 'PT30M';
export const DEFAULT_REVIEW_ATTEMPTS = 1;
/** Per run of the test command (base, then head). */
export const DEFAULT_REGRESSION_TIMEOUT = 'PT10M';
/** Largest diff handed to the review agent, in UTF-16 code units; the rest is cut with a note. */
export const MAX_REVIEW_DIFF = 512 * 1024;
/** Where the review input and the verdict live in the tree a runner's review run gets. */
export const REVIEW_INPUT_PATH = `.git/${SNAPWING_GIT_DIR}/review-input.xml`;
export const REVIEW_VERDICT_PATH = `.git/${SNAPWING_GIT_DIR}/verdict.json`;
/** The review harness a runner's container starts when the config names none (main 14.5's default). */
export const DEFAULT_REVIEW_HARNESS: HarnessChoice = Object.freeze({ adapter: 'claude-code' });
/** Largest verdict file read back from an isolated review run, in bytes. */
export const MAX_VERDICT_BYTES = 1024 * 1024;
/**
 * Agent CLI configuration a checkout may carry (MCP servers, hooks, extensions, tool commands). The
 * review agent's working tree never holds it, so no review CLI configures itself from the pull
 * request (#263); the diff still shows any change to it.
 */
export const AGENT_CONFIG_PATHS: readonly string[] = Object.freeze(['.claude', '.codex', '.gemini', '.mcp.json']);
/** `createdBy` of the stored review artifacts. */
export const REVIEW_AGENT = 'review-agent';
/** The fixer attempt whose failed review escalates instead of retrying (main 11.1: retry once). */
export const LAST_FIXER_ATTEMPT = 2;

// The GitHub side --------------------------------------------------------------------------------

/** The fields of a pull request the review job reads. */
export interface ReviewPullRequest {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
}

export interface ReviewPullRequestFile {
  filename: string;
  /** `added`, `modified`, `removed`, `renamed`, ... as GitHub reports it. */
  status?: string;
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export type ReviewCheckStatus = 'queued' | 'in_progress' | 'completed';
export type ReviewCheckConclusion = 'success' | 'failure' | 'neutral';

export interface ReviewCheckOutput {
  title: string;
  summary: string;
  text?: string;
}

/**
 * The GitHub operations the review job uses, for one repository. The app's `GitHubClient`
 * (`app/src/github/client.ts`) satisfies it as is. Errors carry the HTTP `status`.
 */
export interface ReviewGitHub {
  getPullRequest(number: number): Promise<ReviewPullRequest>;
  /** Every changed file of the PR (paginated by the client); the scope check reads this list. */
  listPullRequestFiles(number: number): Promise<readonly ReviewPullRequestFile[]>;
  createReview(number: number, input: { event: ReviewEvent; body: string; commitId?: string }): Promise<unknown>;
  createCheckRun(input: {
    headSha: string;
    name?: string;
    status: ReviewCheckStatus;
    conclusion?: ReviewCheckConclusion;
    output?: ReviewCheckOutput;
    externalId?: string;
  }): Promise<{ id: number }>;
  updateCheckRun(checkRunId: number, input: { status?: ReviewCheckStatus; conclusion?: ReviewCheckConclusion; output?: ReviewCheckOutput }): Promise<unknown>;
  /** The base branch's required checks for `sha`, for the CI result after `review-passed` (merge/ci.ts). */
  combinedStatus(sha: string, baseBranch: string): Promise<MergeCombinedStatus>;
}

// Dependencies -----------------------------------------------------------------------------------

/** How the review job reaches the target repository for its own checkout. */
export interface ReviewGit {
  /** A GitHub App installation token scoped to the repository; used for the clone only. */
  token: (workItem: WorkItemRef) => Promise<string>;
  /** The clone URL for `owner/name`; default `https://github.com/<repo>.git`. */
  remoteUrl?: (repo: string) => string;
  identity?: GitIdentity;
}

export interface ReviewConfig {
  /** ISO 8601 wall clock for the review harness. Default `PT30M`. */
  wallClock?: string;
  /** Attempts the review harness may make inside one run. Default 1. */
  attempts?: number;
  /**
   * The repository's test command for the regression proof (exit 0 means pass), or a lookup per
   * `owner/name`. No command for a repo whose request requires tests makes an approval `escalate`.
   */
  testCommand: string | ((repo: string) => string | undefined);
  /** ISO 8601 limit per test run of the regression proof. Default `PT10M`. */
  regressionTimeout?: string;
  /**
   * The review harness a runner with a boundary starts in its container (`<harness review="...">`,
   * main 14.5; a `generic` one names its template). Default `claude-code`. The host path uses
   * `ReviewDeps.harness` instead.
   */
  harness?: HarnessChoice;
}

export interface ReviewDeps {
  /** The install's workspace (single tenant), stamped on every event and artifact. */
  workspaceId: string;
  state: StatePort;
  workflow: WorkflowPort;
  /** A client for one `owner/name` repository. */
  github: (repo: string) => ReviewGitHub;
  /**
   * The configured review harness (`<harness review="...">`, main 14.5), run on this host. Used only
   * when `runner` has no `runReview` (the `local` runner, development only).
   */
  harness: HarnessPort;
  git: ReviewGit;
  /** Parent of the review checkouts; each run gets `review-<ulid>` under it. */
  workdirRoot: string;
  config: ReviewConfig;
  clock: () => Date;
  /** Keep the review checkout after the run, for inspection. Default false. */
  keepWorkdir?: boolean;
  /**
   * The RunnerPort the fixer runs on. When it can run tests inside its boundary (`runTests`, the
   * docker provider), the regression proof's test command runs there, never on this host (ADR 0017).
   * Without one (the `local` runner, development only), the proof runs on the host. Likewise, when it
   * can run the review harness inside its boundary (`runReview`), the agent runs there.
   */
  runner?: RunnerPort;
}

// Jobs -------------------------------------------------------------------------------------------

/** Registers the `review.run` handler. */
export function registerReviewJobs(deps: ReviewDeps): void {
  deps.workflow.work('review.run', async (job) => {
    if (!isReviewRunData(job.data)) throw new Error('review.run: malformed job data');
    await runReviewJob(deps, job.data);
  });
}

/**
 * Starts `review.run` for the incident's latest `pr-opened` (or `prNumber`) at its head (or
 * `headSha`). A start while one is queued for that head returns that job. Undefined when the
 * incident has no PR or no repo.
 */
export async function startReview(
  deps: Pick<ReviewDeps, 'state' | 'workflow' | 'github'>,
  input: { incidentId: string; prNumber?: number; headSha?: string },
): Promise<{ jobId: string } | undefined> {
  const { incidentId } = input;
  const prNumber = input.prNumber ?? latest(await deps.state.read(incidentId), 'pr-opened')?.payload.prNumber;
  if (prNumber === undefined) return undefined;
  let headSha = input.headSha;
  if (headSha === undefined) {
    const mapRepo = (await deps.state.getIncident(incidentId))?.repo;
    if (mapRepo === undefined || mapRepo === '') return undefined;
    const repo = repoFullName(mapRepo);
    headSha = (await deps.github(repo).getPullRequest(prNumber)).headSha;
  }
  const data: ReviewRunData = { incidentId, prNumber, headSha };
  return deps.workflow.start('review.run', data, { singletonKey: reviewRunKey(incidentId, headSha) });
}

export type ReviewSkip = 'not-latest-pr' | 'fixer-running' | 'stopped' | 'already-reviewed' | 'no-repo' | 'no-request' | 'not-open' | 'head-moved';

export type ReviewOutcome =
  | { outcome: 'reviewed'; verdict: ReviewVerdict; review: ArtifactRef; fixerRestarted: boolean }
  | { outcome: 'skipped'; reason: ReviewSkip };

/** The `review.run` handler. */
export async function runReviewJob(deps: ReviewDeps, data: ReviewRunData): Promise<ReviewOutcome> {
  const { incidentId, prNumber, headSha } = data;
  const log = await deps.state.read(incidentId);
  const pre = precheck(log, prNumber, headSha);
  if (pre !== undefined) return skipped(pre);

  const incident = await deps.state.getIncident(incidentId);
  const mapRepo = incident?.repo;
  if (mapRepo === undefined || mapRepo === '') return skipped('no-repo');
  const repo = repoFullName(mapRepo);
  const issueKey = incident?.jiraKey ?? latest(log, 'filed')?.payload.jiraKey;
  const requestRef = latest(log, 'planned')?.payload.implementationRequest;
  if (requestRef === undefined || issueKey === undefined) return skipped('no-request');
  const requestArtifact = await deps.state.getArtifact(requestRef.artifactId);
  if (requestArtifact.kind !== 'implementation-request') {
    throw new Error(`review.run: artifact ${requestArtifact.id} is a ${requestArtifact.kind}, not an implementation-request`);
  }
  const request = parseImplementationRequest(requestArtifact.body);

  const gh = deps.github(repo);
  const pr = await gh.getPullRequest(prNumber);
  if (pr.state !== 'open' || pr.merged) return skipped('not-open');
  if (pr.headSha !== headSha) {
    // A newer push is what needs reviewing; its own job (keyed by its sha) does that.
    await startReview(deps, { incidentId, prNumber, headSha: pr.headSha });
    return skipped('head-moved');
  }

  const check = await gh.createCheckRun({
    headSha,
    name: REVIEW_CHECK_NAME,
    status: 'in_progress',
    output: { title: 'Review in progress', summary: `The Snapwing review agent is reviewing ${shortSha(headSha)}.` },
    externalId: incidentId,
  });

  // GitHub's list of changed files, never the fixer's report.
  const files = await gh.listPullRequestFiles(prNumber);
  const changed = files.map((f) => f.filename);
  const attempt = latest(log, 'fixer-started')?.payload.attempt ?? 1;

  const workdir = join(deps.workdirRoot, `review-${ulid()}`);
  const agentTree = `${workdir}-agent`;
  let verdict: ReviewVerdict;
  try {
    verdict = await reviewInCheckout(deps, { workItem: { id: incidentId, issueKey, repo }, pr, request, changed, attempt, workdir, agentTree });
  } finally {
    if (deps.keepWorkdir !== true) {
      for (const dir of [workdir, agentTree]) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // The log may have moved while the agent ran (a Stop, a duplicate job); decide again first.
  const again = precheck(await deps.state.read(incidentId), prNumber, headSha);
  if (again !== undefined) {
    await gh.updateCheckRun(check.id, {
      status: 'completed',
      conclusion: 'neutral',
      output: { title: 'Review discarded', summary: `The review of ${shortSha(headSha)} was discarded: ${again}.` },
    });
    return skipped(again);
  }

  const body = reviewBody(verdict, headSha);
  await postReview(gh, prNumber, headSha, verdict, body);
  await gh.updateCheckRun(check.id, {
    status: 'completed',
    conclusion: verdict.verdict === 'approve' ? 'success' : 'failure',
    output: { title: checkTitle(verdict), summary: body },
  });

  const put = await deps.state.putArtifact({
    workspaceId: deps.workspaceId,
    incidentId,
    kind: 'review',
    contentType: 'application/json',
    body: JSON.stringify(verdict),
    createdBy: REVIEW_AGENT,
  });
  const review: ArtifactRef = { artifactId: put.id, version: put.version };

  let refused: ReviewSkip = 'already-reviewed';
  const appended = await appendDecided(deps.state, incidentId, (events) => {
    const skip = precheck(events, prNumber, headSha);
    if (skip !== undefined) {
      refused = skip;
      return undefined;
    }
    // The approval names the head it reviewed: nothing merges any other (#264).
    if (verdict.verdict === 'approve') return [newEvent(deps, incidentId, 'review-passed', { prNumber, headSha, review })];
    return [newEvent(deps, incidentId, 'review-failed', { prNumber, verdict: verdict.verdict, reason: failureReason(verdict), review })];
  });
  if (!appended.appended) return skipped(refused);

  if (verdict.verdict === 'request-changes') {
    await startFixer(deps, { incidentId, attempt: attempt + 1, reviewArtifact: review });
    return { outcome: 'reviewed', verdict, review, fixerRestarted: true };
  }
  if (verdict.verdict === 'approve') {
    // CI that finished before the review did.
    const ci = await recordCiResult(deps, incidentId, { headSha });
    if (ci.recorded === 'ci-red') return { outcome: 'reviewed', verdict, review, fixerRestarted: ci.fixerRestarted };
  }
  await startMergeEvaluate(deps, incidentId);
  return { outcome: 'reviewed', verdict, review, fixerRestarted: false };
}

// The review itself ------------------------------------------------------------------------------

interface CheckoutInput {
  workItem: WorkItemRef;
  pr: ReviewPullRequest;
  request: ImplementationRequest;
  changed: readonly string[];
  attempt: number;
  workdir: string;
  /** The self-contained tree a runner's review run gets; built only on that path. */
  agentTree: string;
}

/** What the regression proof concluded, for `combine`. */
export type RegressionCheck =
  | { kind: 'not-required' }
  | { kind: 'proven'; testPath: string }
  | { kind: 'failed'; status: RegressionStatus; note: string; file?: string }
  | { kind: 'unprovable'; note: string };

async function reviewInCheckout(deps: ReviewDeps, input: CheckoutInput): Promise<ReviewVerdict> {
  const { workItem, pr, request } = input;
  const mechanical = checkConstraints(input.changed, request);
  const testsRequired = request.kind === 'single' && request.constraints.tests.required;

  let prepared: PreparedWorkdir;
  let mergeBase: string;
  try {
    const token = await deps.git.token(workItem);
    prepared = await prepareWorkdir({
      repo: workItem.repo,
      base: pr.baseRef,
      branch: pr.headRef,
      issueKey: workItem.issueKey,
      token,
      workdir: input.workdir,
      ...(deps.git.remoteUrl === undefined ? {} : { remoteUrl: deps.git.remoteUrl(workItem.repo) }),
      ...(deps.git.identity === undefined ? {} : { identity: deps.git.identity }),
    });
    const gitEnv = { ...prepared.env };
    await git(prepared.workdir, gitEnv, ['checkout', '--quiet', '--detach', pr.headSha]);
    mergeBase = (await git(prepared.workdir, gitEnv, ['merge-base', prepared.baseSha, pr.headSha])).trim();
  } catch (e) {
    const note = `could not check out ${shortSha(pr.headSha)}: ${message(e)}`;
    return combine({ failure: note }, mechanical, testsRequired ? { kind: 'unprovable', note } : { kind: 'not-required' }, input.attempt);
  }

  const agent = await runAgent(deps, input, prepared, mergeBase);
  const regression = testsRequired ? await regressionCheck(deps, input, prepared.workdir, mergeBase, agent) : ({ kind: 'not-required' } as const);
  return combine(agent, mechanical, regression, input.attempt);
}

/** Runs the review harness in the checkout; its verdict, or why there is none. */
async function runAgent(deps: ReviewDeps, input: CheckoutInput, prepared: PreparedWorkdir, mergeBase: string): Promise<ReviewVerdict | { failure: string }> {
  const { pr } = input;
  // No credential: the reviewer reads and runs, it never fetches or pushes.
  const env: Record<string, string> = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' };
  let diff: string;
  try {
    diff = await git(prepared.workdir, env, ['diff', '--no-color', '--no-ext-diff', mergeBase, pr.headSha]);
  } catch (e) {
    return { failure: `could not diff the pull request: ${message(e)}` };
  }
  const reviewInput = buildReviewInput(input.request, pr, mergeBase, diff);
  const isolated = reviewRunnerOf(deps.runner);
  if (isolated !== undefined) return runAgentIsolated(deps, isolated, input, prepared.workdir, reviewInput);

  const reviewFile = join(prepared.workdir, REVIEW_VERDICT_PATH);
  env[REVIEW_FILE_ENV] = reviewFile;

  let outcome: string;
  try {
    // The proof reads commits, never this worktree, so the configuration can go from it too.
    await withoutAgentConfig(prepared.workdir);
    const result = await deps.harness.run(input.workItem, reviewInput, prepared.workdir, {
      role: 'review',
      budget: reviewBudget(deps),
      onCheckpoint: () => Promise.resolve(),
      signal: new AbortController().signal,
      env,
    });
    outcome = result.outcome === 'done' ? '' : result.outcome === 'failed' ? `failed: ${result.reason}` : `stopped at ${result.atPhase}`;
  } catch (e) {
    outcome = `error: ${message(e)}`;
  }
  if (outcome !== '') return { failure: `the review agent ${outcome}` };

  let text: string;
  try {
    text = await readFile(reviewFile, 'utf8');
  } catch {
    return { failure: 'the review agent wrote no verdict file' };
  }
  const parsed = parseReviewVerdict(text);
  return parsed.ok ? parsed.verdict : { failure: `the review agent's verdict is invalid: ${parsed.error.message}` };
}

/** Removes `AGENT_CONFIG_PATHS` from a review agent's working tree (a link is removed, never followed). */
async function withoutAgentConfig(tree: string): Promise<void> {
  for (const path of AGENT_CONFIG_PATHS) await rm(join(tree, path), { recursive: true, force: true });
}

/**
 * Runs the review harness inside the runner's boundary. The tree is a self-contained copy at the
 * head; afterwards nothing here runs in it, and only the verdict file is read back from it.
 */
async function runAgentIsolated(
  deps: ReviewDeps,
  runner: ReviewRunner,
  input: CheckoutInput,
  checkout: string,
  reviewInput: string,
): Promise<ReviewVerdict | { failure: string }> {
  const tree = input.agentTree;
  try {
    const built = await isolatedTree(checkout, tree, input.pr.headSha);
    if (!built.ok) return { failure: `could not prepare the review agent's tree: ${firstLine(built.out)}` };
    await withoutAgentConfig(tree);
    await mkdir(join(tree, '.git', SNAPWING_GIT_DIR), { recursive: true });
    await writeFile(join(tree, REVIEW_INPUT_PATH), reviewInput);
  } catch (e) {
    return { failure: `could not prepare the review agent's tree: ${message(e)}` };
  }

  const budget = reviewBudget(deps);
  let result;
  try {
    result = await runner.runReview({
      runId: ulid(),
      workItem: input.workItem,
      harness: deps.config.harness ?? DEFAULT_REVIEW_HARNESS,
      budget,
      checkout: tree,
      inputFile: REVIEW_INPUT_PATH,
      verdictFile: REVIEW_VERDICT_PATH,
    });
  } catch (e) {
    return { failure: `the review agent could not run: runner: ${message(e)}` };
  }
  if (result.timedOut) return { failure: `the review agent ran past its ${budget.wallClock} budget` };
  if (result.exitCode !== 0) return { failure: `the review agent failed: exit ${result.exitCode ?? 'none'}` };

  const text = await readVerdictFile(tree, REVIEW_VERDICT_PATH, MAX_VERDICT_BYTES);
  if (typeof text !== 'string') return { failure: `the review agent ${text.problem}` };
  const parsed = parseReviewVerdict(text);
  return parsed.ok ? parsed.verdict : { failure: `the review agent's verdict is invalid: ${parsed.error.message}` };
}

/**
 * Reads `rel` from a tree an untrusted run had: only a regular file of at most `maxBytes` that lies in
 * the tree with no symlink on its path (a link to a host file must not be read here), opened without
 * following a link or blocking on a FIFO.
 */
export async function readVerdictFile(tree: string, rel: string, maxBytes: number): Promise<string | { problem: string }> {
  const path = join(tree, rel);
  let real: string;
  let expected: string;
  try {
    real = await realpath(path);
    expected = join(await realpath(tree), rel);
  } catch {
    return { problem: 'wrote no verdict file' };
  }
  if (real !== expected) return { problem: 'left a verdict file that is a link' };
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { problem: 'left a verdict file that cannot be read' };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { problem: 'left a verdict file that is not a regular file' };
    if (st.size > maxBytes) return { problem: `left a verdict file over ${maxBytes} bytes` };
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function reviewBudget(deps: ReviewDeps): { wallClock: string; attempts: number } {
  return { wallClock: deps.config.wallClock ?? DEFAULT_REVIEW_WALL_CLOCK, attempts: deps.config.attempts ?? DEFAULT_REVIEW_ATTEMPTS };
}

async function regressionCheck(
  deps: ReviewDeps,
  input: CheckoutInput,
  workdir: string,
  mergeBase: string,
  agent: ReviewVerdict | { failure: string },
): Promise<RegressionCheck> {
  const repo = input.workItem.repo;
  const command = typeof deps.config.testCommand === 'function' ? deps.config.testCommand(repo) : deps.config.testCommand;
  if (command === undefined || command.trim() === '') return { kind: 'unprovable', note: `no test command is configured for ${repo}` };
  // The reviewed head's own test files (#263): this checkout's diff at that head. Never GitHub's list
  // (it may already show a later push) and never a path the reviewer or the fixer named, so nothing
  // but a test file the head changes is applied at the base.
  let headFiles: string;
  try {
    headFiles = await git(workdir, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' }, [
      'diff', '--name-only', '--no-renames', '--diff-filter=d', '-z', mergeBase, input.pr.headSha,
    ]);
  } catch (e) {
    return { kind: 'unprovable', note: `the regression proof could not list the head's files: ${message(e)}` };
  }
  const testFiles = selectTestFiles(headFiles.split('\0').filter((f) => f !== ''));
  const named = 'verdict' in agent ? agent.regressionTest?.path : undefined;
  const result = await proveRegression({
    workdir,
    baseSha: mergeBase,
    headSha: input.pr.headSha,
    testFiles,
    testCommand: command,
    timeout: deps.config.regressionTimeout ?? DEFAULT_REGRESSION_TIMEOUT,
    runner: testRunnerOf(deps.runner),
  });
  return regressionOf(result, testFiles, named);
}

/** `named` (the reviewer's `regressionTest`) is the proven test path only when the proof covered it. */
function regressionOf(result: RegressionResult, testFiles: readonly string[], named: string | undefined): RegressionCheck {
  switch (result.status) {
    case 'proven':
      return { kind: 'proven', testPath: named !== undefined && testFiles.includes(named) ? named : (testFiles[0] ?? '') };
    case 'no-test-files':
      return { kind: 'failed', status: result.status, note: 'the pull request adds or changes no test file, so no regression test proves the fix' };
    case 'missing-test-file':
      return {
        kind: 'failed',
        status: result.status,
        note: `the regression test is not in the head commit: ${(result.missingFiles ?? []).join(', ')}`,
        ...(result.missingFiles?.[0] === undefined ? {} : { file: result.missingFiles[0] }),
      };
    case 'passes-without-fix':
      return { kind: 'failed', status: result.status, note: 'the tests pass without the fix, so they do not prove it' };
    case 'fails-with-fix':
      return { kind: 'failed', status: result.status, note: 'the tests fail with the fix applied' };
    case 'timeout':
      return { kind: 'failed', status: result.status, note: `the test command timed out at the ${result.phase ?? 'head'}` };
    case 'git-error':
      return { kind: 'unprovable', note: `the regression proof could not run: ${firstLine(result.output)}` };
  }
}

/**
 * The verdict the job records: the agent's, overridden by the mechanical checks, then escalated when
 * the fixer has used its one retry. Always a valid `ReviewVerdict` (`parseReviewVerdict` accepts it).
 */
export function combine(
  agent: ReviewVerdict | { failure: string },
  mechanical: readonly ConstraintViolation[],
  regression: RegressionCheck,
  attempt: number,
): ReviewVerdict {
  const base: ReviewVerdict =
    'verdict' in agent
      ? { ...agent, reasons: [...agent.reasons], constraintViolations: [...agent.constraintViolations] }
      : { verdict: 'escalate', reasons: [agent.failure], constraintViolations: [] };
  let kind = base.verdict;
  const reasons = base.reasons.filter((r) => r.trim() !== '');
  const violations = [...base.constraintViolations];
  const add = (v: ConstraintViolation): void => {
    if (!violations.some((x) => x.constraint === v.constraint && x.file === v.file)) violations.push(v);
  };

  for (const v of mechanical) {
    add(v);
    reasons.push(v.file === undefined ? v.note : `${v.file}: ${v.note}`);
  }
  if (mechanical.length > 0 && kind === 'approve') kind = 'request-changes';

  if (regression.kind === 'failed') {
    add({ constraint: 'tests', ...(regression.file === undefined ? {} : { file: regression.file }), note: regression.note });
    reasons.push(`Regression test not proven: ${regression.note}`);
    if (kind === 'approve') kind = 'request-changes';
  } else if (regression.kind === 'unprovable') {
    reasons.push(`Regression test could not be checked: ${regression.note}`);
    if (kind === 'approve') kind = 'escalate';
  }

  if (kind === 'request-changes' && attempt >= LAST_FIXER_ATTEMPT) {
    kind = 'escalate';
    reasons.push(`The fixer already used its one retry (attempt ${attempt}); a human must take over.`);
  }
  if (kind !== 'approve' && reasons.length === 0) reasons.push(`The review ended in ${kind}.`);

  const out: ReviewVerdict = { verdict: kind, reasons, constraintViolations: violations };
  // A proven regression test is recorded as the file the proof covered (#263), never only the reviewer's word.
  const testPath = regression.kind === 'proven' && regression.testPath !== '' ? regression.testPath : base.regressionTest?.path;
  if (testPath !== undefined) out.regressionTest = { path: testPath };
  return out;
}

/**
 * The review agent's input (prompts/review.xml): the request's constraints, the workspace instructions
 * the request carries (A 6.3), and the diff, nothing of the fixer's. XML, as every machine-shaped
 * prompt input is.
 */
export function buildReviewInput(request: ImplementationRequest, pr: Pick<ReviewPullRequest, 'number' | 'headSha' | 'baseRef'>, mergeBase: string, diff: string): string {
  const lines = [
    `<review-request issue="${xmlAttr(request.issue)}" pr="${pr.number}" base="${xmlAttr(pr.baseRef)}" merge-base="${xmlAttr(mergeBase)}" head="${xmlAttr(pr.headSha)}">`,
    '  <constraints>',
  ];
  if (request.kind === 'single') {
    const c = request.constraints;
    lines.push(`    <scope>${xmlText(c.scope)}</scope>`);
    lines.push(`    <tests required="${c.tests.required}">${xmlText(c.tests.text)}</tests>`);
    for (const f of c.forbidden) lines.push(`    <forbidden>${xmlText(f)}</forbidden>`);
  } else {
    for (const wi of request.workItems) lines.push(`    <scope repo="${xmlAttr(wi.repo)}">${xmlText(wi.scope)}</scope>`);
  }
  lines.push('  </constraints>');
  if (request.workspaceInstructions !== undefined) lines.push(instructionsBlock(request.workspaceInstructions));
  const cut = diff.length > MAX_REVIEW_DIFF;
  const shown = cut ? diff.slice(0, MAX_REVIEW_DIFF) : diff;
  lines.push(`  <diff${cut ? ` truncated="true" length="${diff.length}"` : ''}><![CDATA[${shown.replaceAll(']]>', ']]]]><![CDATA[>')}]]></diff>`);
  lines.push('</review-request>');
  return `${lines.join('\n')}\n`;
}

// GitHub output ----------------------------------------------------------------------------------

const REVIEW_EVENTS: { readonly [K in ReviewVerdict['verdict']]: ReviewEvent } = {
  approve: 'APPROVE',
  'request-changes': 'REQUEST_CHANGES',
  escalate: 'COMMENT',
};

/** Posts the review pinned to `headSha`; a 422 (the App reviewing its own PR) is posted again as COMMENT. */
async function postReview(gh: ReviewGitHub, prNumber: number, headSha: string, verdict: ReviewVerdict, body: string): Promise<void> {
  const event = REVIEW_EVENTS[verdict.verdict];
  try {
    await gh.createReview(prNumber, { event, body, commitId: headSha });
  } catch (e) {
    if (event === 'COMMENT' || httpStatus(e) !== 422) throw e;
    await gh.createReview(prNumber, { event: 'COMMENT', body, commitId: headSha });
  }
}

function checkTitle(v: ReviewVerdict): string {
  if (v.verdict === 'approve') return 'Review agent: approve';
  if (v.verdict === 'request-changes') return 'Review agent: request changes';
  return 'Review agent: escalate to a human';
}

/** The review body and check run summary: the verdict, its reasons, and each violation. */
export function reviewBody(v: ReviewVerdict, headSha: string): string {
  const lines = [`**Snapwing review agent: ${v.verdict}** (${shortSha(headSha)})`];
  if (v.reasons.length > 0) {
    lines.push('', ...v.reasons.map((r) => `- ${r}`));
  }
  if (v.constraintViolations.length > 0) {
    lines.push('', 'Constraint violations:', ...v.constraintViolations.map((c) => `- ${c.constraint}${c.file === undefined ? '' : ` \`${c.file}\``}: ${c.note}`));
  }
  if (v.regressionTest !== undefined) lines.push('', `Regression test: \`${v.regressionTest.path}\``);
  return lines.join('\n');
}

function failureReason(v: ReviewVerdict): string {
  return v.reasons.join('; ');
}

// Log reading ------------------------------------------------------------------------------------

/**
 * Why `review.run` does nothing for this log, before and again after the review. An approval covers
 * only the head it recorded (#264): a new head of an approved PR is reviewed again, and so is the head
 * of a PR whose approval recorded none. A failed review still ends the PR's reviews until the next run.
 */
function precheck(log: readonly IncidentEvent[], prNumber: number, headSha: string): ReviewSkip | undefined {
  const opened = latest(log, 'pr-opened');
  if (opened === undefined || opened.payload.prNumber !== prNumber) return 'not-latest-pr';
  if (stoppedSinceFiled(log)) return 'stopped';
  if (activeRun(log) !== undefined || lastSeqOf(log, 'fixer-started') > opened.seq) return 'fixer-running';
  const since = lastSeqOf(log, 'fixer-started');
  const reviewed = log.some(
    (e) =>
      e.seq > since &&
      ((e.type === 'review-passed' && e.payload.prNumber === prNumber && e.payload.headSha === headSha) ||
        (e.type === 'review-failed' && e.payload.prNumber === prNumber)),
  );
  return reviewed ? 'already-reviewed' : undefined;
}

// Private ----------------------------------------------------------------------------------------

function skipped(reason: ReviewSkip): ReviewOutcome {
  return { outcome: 'skipped', reason };
}

function git(cwd: string, env: Record<string, string>, args: string[]): Promise<string> {
  const path = process.env['PATH'];
  const fullEnv = path === undefined ? env : { PATH: path, ...env };
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: fullEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err === null) resolve(stdout);
      else reject(new Error(`git ${args[0] ?? ''} failed: ${stderr.trim() || err.message}`));
    });
  });
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim() !== '')?.trim() ?? 'unknown error';
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function xmlText(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function xmlAttr(s: string): string {
  return xmlText(s).replaceAll('"', '&quot;');
}
