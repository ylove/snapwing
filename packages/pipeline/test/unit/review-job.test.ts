// Review job (main 11.1, 11.2, 14.5, B 5). Runs on the in-process workflow over the dialect
// `SNAPWING_DB` selects. A local bare repository stands in for GitHub's git (the review checks the PR
// head out of it and proves the regression test there with a real shell command); the review harness,
// the `ReviewGitHub` client, and the fixer's RunnerPort are fakes. The fixer API (B 9) is simulated by
// appending `fixer-done` and `pr-opened` as it does.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArtifactRef, EventPayloads, EventType, IncidentEvent, NewEvent } from '../../src/contracts/events.ts';
import { isReviewRunData, reviewRunKey } from '../../src/contracts/jobs.ts';
import { handleFixerDone, latest, registerFixerJobs, startFixer, type FixerDeps } from '../../src/fixer/job.ts';
import { reviewVerdict, type MergeCombinedStatus } from '../../src/merge/job.ts';
import type { HarnessPort, HarnessResult, HarnessRunOptions, WorkItemRef } from '../../src/ports/harness.ts';
import type { FixerJob, ReviewRunJob, ReviewRunner, ReviewRunResult, RunnerPort, TestRunJob, TestRunner, TestRunResult } from '../../src/ports/runner.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { buildImplementationRequest } from '../../src/prompts/implementation-request.ts';
import {
  AGENT_CONFIG_PATHS,
  combine,
  registerReviewJobs,
  REVIEW_CHECK_NAME,
  REVIEW_FILE_ENV,
  REVIEW_INPUT_PATH,
  REVIEW_VERDICT_PATH,
  runReviewJob,
  startReview,
  type ReviewCheckConclusion,
  type ReviewCheckOutput,
  type ReviewCheckStatus,
  type ReviewDeps,
  type ReviewEvent,
  type ReviewGitHub,
  type ReviewPullRequest,
  type ReviewPullRequestFile,
} from '../../src/review/job.ts';
import { parseReviewVerdict, type ReviewVerdict } from '../../src/review/verdict.ts';
import { InProcessWorkflow } from '../../src/workflow/inprocess/index.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../helpers/db.ts';
import { createBareRepo, git, GIT_ENV, type BareRepo } from '../helpers/git.ts';

const T0 = Date.parse('2026-10-02T09:00:00.000Z');
const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6REVIEWINC000000000000A';
const REPO = 'fake-org/web';
const PR = 418;
const BRANCH = 'fix/WEB-1042';
/** Every `test/*.test.sh` must exit 0. */
const TEST_COMMAND = 'for f in test/*.test.sh; do sh "$f" || exit 1; done';

const REQUEST_BODY = buildImplementationRequest({
  issue: 'WEB-1042',
  intent: 'Checkout total is wrong for an empty cart',
  evidence: [{ kind: 'report', source: 'slack', text: 'Checkout says 500' }],
  constraints: {
    scope: 'Only src/cart and its tests',
    tests: { required: true, text: 'Add a regression test that fails without the fix' },
    forbidden: ['Do not touch .github/workflows'],
  },
  handoff: { mode: 'review', autonomy: 2, branch: BRANCH, base: 'main' },
});

// Pull request contents ---------------------------------------------------------------------------

const FIX = { 'src/cart/total.txt': 'fixed\n' };
const REGRESSION_TEST = { 'test/cart.test.sh': 'grep -q fixed src/cart/total.txt\n' };
const FIXED = { ...FIX, ...REGRESSION_TEST };
const FIXED_OUT_OF_SCOPE = { ...FIXED, 'src/pricing/rules.txt': 'changed\n' };
const NO_TEST = FIX;
const TEST_PASSES_WITHOUT_FIX = { ...FIX, 'test/cart.test.sh': 'true\n' };

const APPROVE: ReviewVerdict = { verdict: 'approve', reasons: [], constraintViolations: [], regressionTest: { path: 'test/cart.test.sh' } };
const REQUEST_CHANGES: ReviewVerdict = { verdict: 'request-changes', reasons: ['Handle the empty cart in the total'], constraintViolations: [] };

// World -------------------------------------------------------------------------------------------

let tdb: TestDatabase;
let state: OpenedState;
let wf: InProcessWorkflow;
let now: number;
let errors: unknown[];
let scratch: string;
let origin: BareRepo;
/** A clone of `origin` the tests push the PR branch from, as a fixer would. */
let clone: string;

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0;
  errors = [];
  state = await tdb.open({ now: () => new Date(now) });
  wf = new InProcessWorkflow(state, { onError: (e) => errors.push(e) });
  scratch = await mkdtemp(join(tmpdir(), 'snapwing-review-job-'));
  origin = await createBareRepo({ files: { 'src/cart/total.txt': 'buggy\n', 'src/pricing/rules.txt': 'rules\n' } });
  clone = join(scratch, 'clone');
  git(scratch, ['clone', '--quiet', origin.url, clone]);
  git(clone, ['checkout', '--quiet', '-b', BRANCH, 'origin/main']);
});

afterEach(async () => {
  await wf.stop();
  await tdb.drop();
  await origin.remove();
  await rm(scratch, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

/** One scripted review: a verdict to write (an object, or raw text), or a harness result to return as is. */
type Script = ReviewVerdict | { raw: string } | { result: HarnessResult } | ((call: HarnessCall) => Promise<void>);

interface HarnessCall {
  workItem: WorkItemRef;
  input: string;
  workdir: string;
  opts: HarnessRunOptions;
  /** `git rev-parse HEAD` in the workdir, at the time of the run. */
  head: string;
}

class FakeReviewHarness implements HarnessPort {
  readonly calls: HarnessCall[] = [];
  readonly script: Script[] = [];

  async run(workItem: WorkItemRef, input: string, workdir: string, opts: HarnessRunOptions): Promise<HarnessResult> {
    const call: HarnessCall = { workItem, input, workdir, opts, head: git(workdir, ['rev-parse', 'HEAD']) };
    this.calls.push(call);
    const next = this.script.shift() ?? APPROVE;
    if (typeof next === 'function') {
      await next(call);
      return done();
    }
    if ('result' in next) return next.result;
    const file = opts.env?.[REVIEW_FILE_ENV];
    if (file === undefined) throw new Error('no review file in the environment');
    await writeFile(file, 'raw' in next ? next.raw : JSON.stringify(next));
    return done();
  }
}

function done(): HarnessResult {
  return { outcome: 'done', branch: BRANCH, summary: 'reviewed', testsAdded: [] };
}

interface PostedReview {
  number: number;
  event: ReviewEvent;
  body: string;
  commitId?: string;
}

interface FakeCheck {
  id: number;
  headSha: string;
  name?: string;
  history: { status?: ReviewCheckStatus; conclusion?: ReviewCheckConclusion; output?: ReviewCheckOutput }[];
}

class FakeGitHub implements ReviewGitHub {
  pr: ReviewPullRequest = { number: PR, state: 'open', merged: false, headSha: '', headRef: BRANCH, baseRef: 'main' };
  files: ReviewPullRequestFile[] = [];
  readonly reviews: PostedReview[] = [];
  readonly checks: FakeCheck[] = [];
  /** GitHub's answer when an App approves or requests changes on its own PR. */
  rejectOwnReviews = false;
  /** The base branch's required checks for the head. Default: CI still running. */
  required: MergeCombinedStatus['required'] = [{ name: 'ci', state: 'pending', source: 'check-run' }];
  readonly statusFor: string[] = [];

  getPullRequest(number: number): Promise<ReviewPullRequest> {
    if (number !== this.pr.number) return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
    return Promise.resolve({ ...this.pr });
  }

  listPullRequestFiles(): Promise<readonly ReviewPullRequestFile[]> {
    return Promise.resolve(this.files.map((f) => ({ ...f })));
  }

  createReview(number: number, input: { event: ReviewEvent; body: string; commitId?: string }): Promise<unknown> {
    if (this.rejectOwnReviews && input.event !== 'COMMENT') {
      return Promise.reject(Object.assign(new Error('Unprocessable Entity: Can not approve your own pull request'), { status: 422 }));
    }
    this.reviews.push({ number, ...input });
    return Promise.resolve({ id: this.reviews.length });
  }

  createCheckRun(input: { headSha: string; name?: string; status: ReviewCheckStatus; conclusion?: ReviewCheckConclusion; output?: ReviewCheckOutput }): Promise<{ id: number }> {
    const check: FakeCheck = {
      id: 9000 + this.checks.length,
      headSha: input.headSha,
      ...(input.name === undefined ? {} : { name: input.name }),
      history: [{ status: input.status, ...(input.output === undefined ? {} : { output: input.output }) }],
    };
    this.checks.push(check);
    return Promise.resolve({ id: check.id });
  }

  updateCheckRun(id: number, input: { status?: ReviewCheckStatus; conclusion?: ReviewCheckConclusion; output?: ReviewCheckOutput }): Promise<unknown> {
    const check = this.checks.find((c) => c.id === id);
    if (check === undefined) return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
    check.history.push({ ...input });
    return Promise.resolve({ id });
  }

  combinedStatus(sha: string): Promise<MergeCombinedStatus> {
    this.statusFor.push(sha);
    return Promise.resolve({ required: this.required.map((c) => ({ ...c })) });
  }

  /** The final state of the latest check run. */
  lastCheck(): { headSha: string; name?: string; status?: ReviewCheckStatus; conclusion?: ReviewCheckConclusion; output?: ReviewCheckOutput } {
    const check = this.checks.at(-1);
    if (check === undefined) throw new Error('no check run');
    return Object.assign({ headSha: check.headSha, ...(check.name === undefined ? {} : { name: check.name }) }, ...check.history) as ReturnType<FakeGitHub['lastCheck']>;
  }
}

class FakeRunner implements RunnerPort {
  readonly started: FixerJob[] = [];

  runFixer(job: FixerJob): Promise<{ runId: string }> {
    this.started.push(job);
    return Promise.resolve({ runId: job.runId });
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

/** What a test run saw of its tree when the runner got it. */
interface SeenTestRun {
  job: TestRunJob;
  /** `.git/objects/info/alternates` exists: the tree borrows objects from a host checkout. */
  alternates: boolean;
  /** The tree's `.git/config`. */
  config: string;
  total: string;
  testFile: boolean;
}

/**
 * A runner with an isolation boundary, as the docker provider is: `runTests` is the boundary. It runs
 * nothing; it records each job and what its tree holds, and answers scripted exit codes (default: fail
 * at the base, pass at the head).
 */
class FakeIsolatedRunner extends FakeRunner implements TestRunner {
  readonly runs: SeenTestRun[] = [];
  readonly results: (TestRunResult | Error)[] = [];

  async runTests(job: TestRunJob): Promise<TestRunResult> {
    const gitDir = join(job.checkout, '.git');
    this.runs.push({
      job,
      alternates: existsSync(join(gitDir, 'objects', 'info', 'alternates')),
      config: await readFile(join(gitDir, 'config'), 'utf8'),
      total: await readFile(join(job.checkout, 'src', 'cart', 'total.txt'), 'utf8'),
      testFile: existsSync(join(job.checkout, 'test', 'cart.test.sh')),
    });
    const next = this.results.shift() ?? { exitCode: this.runs.length === 1 ? 1 : 0, timedOut: false, output: `run ${this.runs.length}` };
    if (next instanceof Error) throw next;
    return next;
  }
}

/** What a review run saw of its tree when the runner got it. */
interface SeenReviewRun {
  job: ReviewRunJob;
  alternates: boolean;
  config: string;
  head: string;
  input: string;
  total: string;
}

/** What the fake container does with the tree: write a verdict (or raw text), or anything else. */
type ReviewAct = ReviewVerdict | { raw: string } | ((job: ReviewRunJob) => Promise<void>);

/**
 * A runner with an isolation boundary that also runs the review agent, as the docker provider does.
 * Its `runReview` is the container: it records what the tree holds, then acts as the scripted agent
 * would inside it, writing only into the tree.
 */
class FakeReviewingRunner extends FakeIsolatedRunner implements ReviewRunner {
  readonly reviews: SeenReviewRun[] = [];
  readonly acts: ReviewAct[] = [];
  readonly reviewResults: (ReviewRunResult | Error)[] = [];

  async runReview(job: ReviewRunJob): Promise<ReviewRunResult> {
    const gitDir = join(job.checkout, '.git');
    this.reviews.push({
      job,
      alternates: existsSync(join(gitDir, 'objects', 'info', 'alternates')),
      config: await readFile(join(gitDir, 'config'), 'utf8'),
      head: git(job.checkout, ['rev-parse', 'HEAD']),
      input: await readFile(join(job.checkout, job.inputFile), 'utf8'),
      total: await readFile(join(job.checkout, 'src', 'cart', 'total.txt'), 'utf8'),
    });
    const next = this.reviewResults.shift() ?? { exitCode: 0, timedOut: false, output: 'reviewed' };
    if (next instanceof Error) throw next;
    const act = this.acts.shift() ?? APPROVE;
    if (typeof act === 'function') await act(job);
    else await writeFile(join(job.checkout, job.verdictFile), 'raw' in act ? act.raw : JSON.stringify(act));
    return next;
  }
}

interface World {
  deps: ReviewDeps;
  fixer: FixerDeps;
  harness: FakeReviewHarness;
  github: FakeGitHub;
  runner: FakeRunner;
  merges: string[];
  workdirRoot: string;
  /** The repo each installation-token request named. */
  tokenRepos: string[];
}

/** `runner` is the fixer's RunnerPort, which the review job also gets, as the composition root passes it. */
async function setup(config: Partial<ReviewDeps['config']> = {}, runner: FakeRunner = new FakeRunner(), mapRepo: string = REPO): Promise<World> {
  const harness = new FakeReviewHarness();
  const github = new FakeGitHub();
  const workdirRoot = join(scratch, 'reviews');
  const tokenRepos: string[] = [];
  const fixer: FixerDeps = {
    workspaceId: WS,
    state,
    workflow: wf,
    runner,
    github: { markIncomplete: () => Promise.resolve(), closePr: () => Promise.resolve() },
    config: { harness: { adapter: 'claude-code' } },
    clock: () => new Date(now),
  };
  registerFixerJobs(fixer);
  const merges: string[] = [];
  wf.work('merge.evaluate', (job) => {
    merges.push((job.data as { incidentId: string }).incidentId);
    return Promise.resolve();
  });
  const deps: ReviewDeps = {
    workspaceId: WS,
    state,
    workflow: wf,
    github: (repo) => {
      if (repo !== REPO) throw new Error(`unexpected repo ${repo}`);
      return github;
    },
    harness,
    git: {
      token: (workItem) => {
        tokenRepos.push(workItem.repo);
        return Promise.resolve('test-installation-token');
      },
      remoteUrl: () => origin.url,
    },
    workdirRoot,
    config: { testCommand: TEST_COMMAND, regressionTimeout: 'PT1M', ...config },
    clock: () => new Date(now),
    runner,
  };
  registerReviewJobs(deps);

  const put = await state.putArtifact({
    workspaceId: WS,
    incidentId: INC,
    kind: 'implementation-request',
    contentType: 'application/xml',
    body: REQUEST_BODY,
    createdBy: 'orchestrator',
  });
  await append(...toFiled({ artifactId: put.id, version: put.version }, mapRepo));
  return { deps, fixer, harness, github, runner, merges, workdirRoot, tokenRepos };
}

function ev<T extends EventType>(type: T, payload: EventPayloads[T], source: 'agent' | 'fixer' | 'github' = 'agent'): NewEvent<T> {
  return { workspaceId: WS, incidentId: INC, type, v: 1, source, occurredAt: new Date(now).toISOString(), payload } as unknown as NewEvent<T>;
}

function toFiled(request: ArtifactRef, repo: string = REPO): NewEvent[] {
  return [
    ev('captured', {
      kind: 'incident',
      idempotencyKey: `slack:C-FAKE:${INC}`,
      source: 'slack',
      reporter: { id: 'U-FAKE-REPORTER', name: 'Pat', role: 'reporter' },
      anchorText: 'Checkout says 500',
      channelId: 'C-FAKE',
    }),
    ev('context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 2, excludedCount: 0 }),
    ev('resolved', { surfaceId: 'web', componentId: 'checkout', repo, resolvedBy: 'channel-explicit', confidence: 0.9 }),
    ev('dedupe-checked', { candidates: [], decision: 'none' }),
    ev('planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 'Checkout total is wrong for an empty cart',
      priority: 'High',
      labels: ['snapwing'],
      autonomyLevel: 2,
      implementationRequest: request,
    }),
    ev('filed', { jiraKey: 'WEB-1042' }),
  ];
}

async function log(): Promise<IncidentEvent[]> {
  return state.read(INC);
}

async function append(...events: NewEvent[]): Promise<void> {
  const last = (await log()).at(-1)?.seq ?? 0;
  await state.append(INC, events, last);
}

async function lastOf<T extends EventType>(type: T): Promise<IncidentEvent<T> | undefined> {
  return latest(await log(), type);
}

/** Commits `files` on the PR branch and pushes it; GitHub's PR then points at the new head. */
async function push(w: World, files: Record<string, string>): Promise<string> {
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(clone, path)), { recursive: true });
    await writeFile(join(clone, path), body);
  }
  git(clone, ['add', '-A']);
  git(clone, ['commit', '--quiet', '-m', 'WEB-1042 fix']);
  git(clone, ['push', '--quiet', 'origin', `HEAD:refs/heads/${BRANCH}`]);
  const head = git(clone, ['rev-parse', 'HEAD']);
  w.github.pr = { ...w.github.pr, headSha: head };
  w.github.files = changedFiles();
  return head;
}

/** What GitHub lists for the PR: the diff of the branch against main. */
function changedFiles(): ReviewPullRequestFile[] {
  const out = execFileSync('git', ['diff', '--name-status', 'origin/main', 'HEAD'], { cwd: clone, env: GIT_ENV, encoding: 'utf8' });
  const status: Record<string, string> = { A: 'added', M: 'modified', D: 'removed' };
  return out
    .trim()
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const [code = '', filename = ''] = l.split('\t');
      return { filename, status: status[code] ?? 'modified' };
    });
}

/**
 * One fixer attempt that ends in a PR: `fixer.run` starts (attempt 1 here; attempt 2 is started by the
 * review job), the fixer pushes `files`, and the fixer API records `fixer-done` and `pr-opened`.
 */
async function fixerOpensPr(w: World, files: Record<string, string>, attempt: 1 | 2 = 1): Promise<string> {
  if (attempt === 1) await startFixer(w.fixer, { incidentId: INC, attempt: 1 });
  await wf.drain();
  const started = await lastOf('fixer-started');
  expect(started?.payload.attempt).toBe(attempt);
  const head = await push(w, files);
  await append(
    // The fixer's own report names none of the files; the review never reads it.
    ev('fixer-done', { prNumber: PR, branch: BRANCH, summary: 'FIXER-SUMMARY-SECRET-REASONING', testsAdded: [] }, 'fixer'),
    ev('pr-opened', { prNumber: PR, branch: BRANCH }, 'fixer'),
  );
  await handleFixerDone(w.fixer, INC);
  return head;
}

/** The fixer API's `onDone` hook: start the review, then let the workflow run it. */
async function review(w: World): Promise<void> {
  const started = await startReview(w.deps, { incidentId: INC });
  expect(started).toBeDefined();
  await wf.drain();
}

/** The `review` artifact an event references, parsed as the merge step parses it. */
async function storedVerdict(ref: ArtifactRef | undefined): Promise<ReviewVerdict> {
  if (ref === undefined) throw new Error('no review artifact');
  const artifact = await state.getArtifact(ref.artifactId, ref.version);
  expect(artifact.kind).toBe('review');
  expect(artifact.contentType).toBe('application/json');
  const parsed = parseReviewVerdict(artifact.body);
  if (!parsed.ok) throw new Error(`stored review does not parse: ${parsed.error.message}`);
  // Exactly the ReviewVerdict shape: parsing drops nothing.
  expect(JSON.parse(artifact.body)).toEqual(parsed.verdict);
  return parsed.verdict;
}

async function status(): Promise<string | undefined> {
  return (await state.getIncident(INC))?.status;
}

// Tests -------------------------------------------------------------------------------------------

describe(`review job (${TEST_DIALECT})`, () => {
  it('approve: reviews the head in a checkout of its own, stores the verdict, approves on GitHub, passes the check, starts the merge step', async () => {
    const w = await setup();
    const head = await fixerOpensPr(w, FIXED);
    w.harness.script.push(APPROVE);

    await review(w);

    // The harness: role review, a fresh checkout at the PR head, no credential, no prior review.
    expect(w.harness.calls).toHaveLength(1);
    const call = w.harness.calls[0];
    if (call === undefined) throw new Error('unreachable');
    expect(call.opts.role).toBe('review');
    expect(call.head).toBe(head);
    expect(call.workdir.startsWith(join(w.workdirRoot, 'review-'))).toBe(true);
    expect(call.workItem).toEqual({ id: INC, issueKey: 'WEB-1042', repo: REPO });
    const env = call.opts.env ?? {};
    expect(env[REVIEW_FILE_ENV]).toBe(join(call.workdir, '.git', 'snapwing', 'verdict.json'));
    expect(Object.keys(env)).not.toContain('SNAPWING_GIT_TOKEN');
    expect(Object.keys(env)).not.toContain('GIT_ASKPASS');
    expect(Object.keys(env)).not.toContain('SNAPWING_PRIOR_REVIEW_FILE');
    // Its input: the constraints and the diff, nothing of the fixer's.
    expect(call.input).toContain('<scope>Only src/cart and its tests</scope>');
    expect(call.input).toContain('<forbidden>Do not touch .github/workflows</forbidden>');
    expect(call.input).toContain('+fixed');
    expect(call.input).toContain('test/cart.test.sh');
    expect(call.input).not.toContain('FIXER-SUMMARY-SECRET-REASONING');
    // The checkout is gone afterwards.
    expect(existsSync(call.workdir)).toBe(false);

    const passed = await lastOf('review-passed');
    expect(passed?.payload.prNumber).toBe(PR);
    expect(await storedVerdict(passed?.payload.review)).toEqual(APPROVE);
    expect(await lastOf('review-failed')).toBeUndefined();
    // The merge step reads it as an approval.
    expect(await reviewVerdict(state, await log(), PR)).toBe('approve');

    expect(w.github.reviews).toEqual([{ number: PR, event: 'APPROVE', body: expect.stringContaining('approve') as unknown as string, commitId: head }]);
    expect(w.github.checks).toHaveLength(1);
    expect(w.github.checks[0]?.history[0]?.status).toBe('in_progress');
    expect(w.github.lastCheck()).toMatchObject({ headSha: head, name: REVIEW_CHECK_NAME, status: 'completed', conclusion: 'success' });

    expect(w.merges).toEqual([INC]);
    expect(w.runner.started).toHaveLength(1);
    expect(await status()).toBe('ci');
  });

  it('a map-form repo (github.com/owner/name) reaches the harness env, the token request, and GitHub as owner/name', async () => {
    const w = await setup({}, new FakeRunner(), `github.com/${REPO}`);
    await fixerOpensPr(w, FIXED);
    w.harness.script.push(APPROVE);

    await review(w);

    const call = w.harness.calls[0];
    if (call === undefined) throw new Error('unreachable');
    expect(call.workItem).toEqual({ id: INC, issueKey: 'WEB-1042', repo: REPO });
    expect(w.tokenRepos).toEqual([REPO]);
    // The FakeGitHub factory throws for any repo but owner/name, so an approval proves the GitHub calls too.
    expect(w.github.reviews).toHaveLength(1);
    expect((await lastOf('review-passed'))?.payload.prNumber).toBe(PR);
  });

  it('CI that finished green before the review passed is recorded when the review passes', async () => {
    const w = await setup();
    const head = await fixerOpensPr(w, FIXED);
    w.github.required = [{ name: 'ci', state: 'success', source: 'check-run' }];
    w.harness.script.push(APPROVE);

    await review(w);

    const types = (await log()).map((e) => e.type);
    expect(types.slice(types.indexOf('review-passed'))).toEqual(['review-passed', 'ci-green']);
    expect((await lastOf('ci-green'))?.payload).toEqual({ prNumber: PR, headSha: head });
    expect(w.github.statusFor).toEqual([head]);
    expect(await status()).toBe('mergeable');
    expect(w.merges).toEqual([INC]);
  });

  it('CI that finished red before the review passed: ci-red, then the fixer retry with the failing checks (main 10)', async () => {
    const w = await setup();
    const head = await fixerOpensPr(w, FIXED);
    w.github.required = [
      { name: 'build', state: 'success', source: 'check-run' },
      { name: 'test', state: 'failure', source: 'check-run' },
    ];
    w.harness.script.push(APPROVE);

    await review(w);

    expect((await lastOf('ci-red'))?.payload).toEqual({ prNumber: PR, headSha: head, failingChecks: ['test'] });
    expect(w.merges).toEqual([]);
    expect(w.runner.started).toHaveLength(2);
    expect(w.runner.started[1]?.review).toBeDefined();
    const prior = await storedVerdict(w.runner.started[1]?.review);
    expect(prior.verdict).toBe('request-changes');
    expect(prior.constraintViolations).toEqual([{ constraint: 'ci', note: 'required check test failed' }]);
    expect((await lastOf('fixer-started'))?.payload.attempt).toBe(2);
    expect(await status()).toBe('fixing-retry');
  });

  it('request-changes, then approve: the fixer runs once more with the review, and the second review passes', async () => {
    const w = await setup();
    const head1 = await fixerOpensPr(w, FIXED);
    w.harness.script.push(REQUEST_CHANGES, APPROVE);

    await review(w);

    const failed = await lastOf('review-failed');
    expect(failed?.payload).toMatchObject({ prNumber: PR, verdict: 'request-changes', reason: 'Handle the empty cart in the total' });
    expect(await storedVerdict(failed?.payload.review)).toEqual({ ...REQUEST_CHANGES, regressionTest: { path: 'test/cart.test.sh' } });
    expect(w.github.reviews.map((r) => [r.event, r.commitId])).toEqual([['REQUEST_CHANGES', head1]]);
    expect(w.github.lastCheck()).toMatchObject({ status: 'completed', conclusion: 'failure' });
    expect(w.merges).toEqual([]);

    // The retry: fixer.run attempt 2 with the review artifact (the runner writes it to SNAPWING_PRIOR_REVIEW_FILE).
    const head2 = await fixerOpensPr(w, { 'src/cart/total.txt': 'fixed\n// empty cart handled\n' }, 2);
    expect(w.runner.started).toHaveLength(2);
    expect(w.runner.started[1]?.review).toEqual(failed?.payload.review);
    expect(await status()).toBe('in-review-retry');

    await review(w);

    expect(w.harness.calls.map((c) => c.head)).toEqual([head1, head2]);
    expect(w.harness.calls[1]?.workdir).not.toBe(w.harness.calls[0]?.workdir);
    const passed = await lastOf('review-passed');
    expect(passed?.payload.prNumber).toBe(PR);
    expect(await storedVerdict(passed?.payload.review)).toEqual(APPROVE);
    expect(await reviewVerdict(state, await log(), PR)).toBe('approve');
    expect(w.github.reviews.map((r) => [r.event, r.commitId])).toEqual([
      ['REQUEST_CHANGES', head1],
      ['APPROVE', head2],
    ]);
    expect(w.merges).toEqual([INC]);
    expect(w.runner.started).toHaveLength(2);
    expect(await status()).toBe('ci-retry');
  });

  it('request-changes twice escalates: review-failed with escalate, no third fixer run', async () => {
    const w = await setup();
    await fixerOpensPr(w, FIXED);
    w.harness.script.push(REQUEST_CHANGES, { ...REQUEST_CHANGES, reasons: ['Still wrong for an empty cart'] });

    await review(w);
    await fixerOpensPr(w, { 'src/cart/total.txt': 'fixed\n// second try\n' }, 2);
    await review(w);

    const failures = (await log()).filter((e): e is IncidentEvent<'review-failed'> => e.type === 'review-failed');
    expect(failures.map((e) => e.payload.verdict)).toEqual(['request-changes', 'escalate']);
    const second = failures[1];
    expect(second?.payload.reason).toContain('Still wrong for an empty cart');
    expect(second?.payload.reason).toContain('one retry');
    const stored = await storedVerdict(second?.payload.review);
    expect(stored.verdict).toBe('escalate');
    expect(await reviewVerdict(state, await log(), PR)).toBe('escalate');

    expect(w.github.reviews.map((r) => r.event)).toEqual(['REQUEST_CHANGES', 'COMMENT']);
    expect(w.github.lastCheck()).toMatchObject({ status: 'completed', conclusion: 'failure' });
    await wf.drain();
    expect(w.runner.started).toHaveLength(2);
    expect(w.merges).toEqual([INC]);
    expect(await status()).toBe('escalated');
  });

  it('a scope violation overrides an approval: request-changes, from the files GitHub lists', async () => {
    const w = await setup();
    await fixerOpensPr(w, FIXED_OUT_OF_SCOPE);
    w.harness.script.push(APPROVE);

    await review(w);

    expect(await lastOf('review-passed')).toBeUndefined();
    const failed = await lastOf('review-failed');
    expect(failed?.payload.verdict).toBe('request-changes');
    expect(failed?.payload.reason).toContain('src/pricing/rules.txt');
    const stored = await storedVerdict(failed?.payload.review);
    expect(stored.verdict).toBe('request-changes');
    expect(stored.constraintViolations).toEqual([{ constraint: 'scope', file: 'src/pricing/rules.txt', note: expect.stringContaining('outside the request scope') as unknown as string }]);
    expect(w.github.reviews.map((r) => r.event)).toEqual(['REQUEST_CHANGES']);
    expect(w.github.lastCheck()).toMatchObject({ conclusion: 'failure' });
    // The fixer gets its one retry with this review.
    await wf.drain();
    expect(w.runner.started.at(-1)?.review).toEqual(failed?.payload.review);
  });

  it('checks the file list from GitHub, not the checkout or the fixer: a forbidden path GitHub reports is flagged', async () => {
    const w = await setup();
    await fixerOpensPr(w, FIXED);
    w.github.files = [...w.github.files, { filename: '.github/workflows/ci.yml', status: 'modified' }];
    w.harness.script.push(APPROVE);

    await review(w);

    const failed = await lastOf('review-failed');
    expect(failed?.payload.verdict).toBe('request-changes');
    const stored = await storedVerdict(failed?.payload.review);
    expect(stored.constraintViolations).toEqual([
      { constraint: 'forbidden', file: '.github/workflows/ci.yml', note: expect.stringContaining('forbids') as unknown as string },
    ]);
  });

  it.each([
    ['no regression test in the PR', NO_TEST, 'no test file'],
    ['a regression test that passes without the fix', TEST_PASSES_WITHOUT_FIX, 'pass without the fix'],
  ])('%s forces request-changes over an approval', async (_name, files, note) => {
    const w = await setup();
    await fixerOpensPr(w, files);
    w.harness.script.push({ verdict: 'approve', reasons: [], constraintViolations: [] });

    await review(w);

    const failed = await lastOf('review-failed');
    expect(failed?.payload.verdict).toBe('request-changes');
    expect(failed?.payload.reason).toContain(note);
    const stored = await storedVerdict(failed?.payload.review);
    expect(stored.constraintViolations).toEqual([expect.objectContaining({ constraint: 'tests' })]);
  });

  it('a proven regression test with no path from the reviewer is recorded as the regression test', async () => {
    const w = await setup();
    await fixerOpensPr(w, FIXED);
    w.harness.script.push({ verdict: 'approve', reasons: [], constraintViolations: [] });

    await review(w);

    expect(await storedVerdict((await lastOf('review-passed'))?.payload.review)).toEqual(APPROVE);
  });

  it.each([
    ['writes an invalid verdict', { raw: 'looks good to me' }, 'verdict is invalid'],
    ['writes no verdict file', { result: done() }, 'no verdict file'],
    ['fails', { result: { outcome: 'failed', reason: 'model unavailable', attempts: 1 } }, 'failed: model unavailable'],
  ] as const)('a review agent that %s escalates without a fixer retry', async (_name, script, reason) => {
    const w = await setup();
    await fixerOpensPr(w, FIXED);
    w.harness.script.push(script as Script);

    await review(w);

    const failed = await lastOf('review-failed');
    expect(failed?.payload.verdict).toBe('escalate');
    expect(failed?.payload.reason).toContain(reason);
    expect((await storedVerdict(failed?.payload.review)).verdict).toBe('escalate');
    expect(w.github.reviews.map((r) => r.event)).toEqual(['COMMENT']);
    expect(w.runner.started).toHaveLength(1);
    expect(w.merges).toEqual([INC]);
  });

  it('no test command for the repo: an approval escalates, since the regression cannot be proven', async () => {
    const w = await setup({ testCommand: () => undefined });
    await fixerOpensPr(w, FIXED);
    w.harness.script.push(APPROVE);

    await review(w);

    const failed = await lastOf('review-failed');
    expect(failed?.payload.verdict).toBe('escalate');
    expect(failed?.payload.reason).toContain('no test command is configured for fake-org/web');
  });

  it('GitHub refusing the App a review of its own PR (422) is posted again as a comment', async () => {
    const w = await setup();
    const head = await fixerOpensPr(w, FIXED);
    w.github.rejectOwnReviews = true;

    await review(w);

    expect(w.github.reviews.map((r) => [r.event, r.commitId])).toEqual([['COMMENT', head]]);
    expect(w.github.lastCheck()).toMatchObject({ conclusion: 'success' });
    expect(await lastOf('review-passed')).toBeDefined();
  });

  it('one review per head: a second start adds nothing; a head that moved is reviewed at the new head', async () => {
    const w = await setup();
    const head1 = await fixerOpensPr(w, FIXED);
    const a = await startReview(w.deps, { incidentId: INC });
    const b = await startReview(w.deps, { incidentId: INC });
    expect(b?.jobId).toBe(a?.jobId);
    expect(reviewRunKey(INC, head1)).toBe(`review:${INC}:${head1}`);

    // A push lands before the queued review runs: it skips and reviews the new head instead.
    const head2 = await push(w, { 'src/cart/total.txt': 'fixed\n// tidy\n' });
    expect(await runReviewJob(w.deps, { incidentId: INC, prNumber: PR, headSha: head1 })).toEqual({ outcome: 'skipped', reason: 'head-moved' });
    await wf.drain();
    expect(w.harness.calls.map((c) => c.head)).toEqual([head2]);
    expect((await log()).filter((e) => e.type === 'review-passed')).toHaveLength(1);

    // Reviewed since the latest fixer run: a later job for the same PR appends nothing.
    expect(await runReviewJob(w.deps, { incidentId: INC, prNumber: PR, headSha: head2 })).toEqual({ outcome: 'skipped', reason: 'already-reviewed' });
    expect(w.harness.calls).toHaveLength(1);
  });

  it('a Stop that lands during the review discards it: no event, no GitHub review, a neutral check', async () => {
    const w = await setup();
    await fixerOpensPr(w, FIXED);
    w.harness.script.push(async (call) => {
      await append(ev('stopped', { reason: 'tapped Stop' }));
      const file = call.opts.env?.[REVIEW_FILE_ENV] ?? '';
      await writeFile(file, JSON.stringify(APPROVE));
    });

    await review(w);

    const types = (await log()).map((e) => e.type);
    expect(types).not.toContain('review-passed');
    expect(types).not.toContain('review-failed');
    expect(w.github.reviews).toEqual([]);
    expect(w.github.lastCheck()).toMatchObject({ status: 'completed', conclusion: 'neutral' });
    expect(w.merges).toEqual([]);
  });

  it('refuses without a PR, while a fixer runs, and for a closed PR', async () => {
    const w = await setup();
    expect(await startReview(w.deps, { incidentId: INC })).toBeUndefined();
    expect(await runReviewJob(w.deps, { incidentId: INC, prNumber: PR, headSha: 'abc' })).toEqual({ outcome: 'skipped', reason: 'not-latest-pr' });

    await fixerOpensPr(w, FIXED);
    w.github.pr = { ...w.github.pr, state: 'closed' };
    expect(await runReviewJob(w.deps, { incidentId: INC, prNumber: PR, headSha: w.github.pr.headSha })).toEqual({ outcome: 'skipped', reason: 'not-open' });
    expect(w.github.checks).toEqual([]);
    expect(w.harness.calls).toEqual([]);
  });
});

describe(`review job on a runner with a boundary (${TEST_DIALECT}; ADR 0017)`, () => {
  /** Prepended to the test command: a host process running it leaves this file behind. */
  const marker = (): string => join(scratch, 'host-ran-the-test-command');
  const markedCommand = (): string => `touch '${marker()}'; ${TEST_COMMAND}`;

  it('no host process runs the PR test command: both runs go to runTests, each in a self-contained tree', async () => {
    const runner = new FakeIsolatedRunner();
    const w = await setup({ testCommand: markedCommand() }, runner);
    const head = await fixerOpensPr(w, FIXED);
    w.harness.script.push(APPROVE);

    await review(w);

    expect(existsSync(marker())).toBe(false);
    expect(runner.runs).toHaveLength(2);
    const [base, atHead] = runner.runs;
    if (base === undefined || atHead === undefined) throw new Error('unreachable');
    for (const run of runner.runs) {
      expect(run.job.command).toBe(markedCommand());
      expect(run.job.timeoutMs).toBe(60_000);
      expect(run.job.env).toBeUndefined();
      // Its own objects, no remote, no credential: nothing to reach back into the host checkout.
      expect(run.alternates).toBe(false);
      expect(run.config).not.toContain('[remote');
      expect(run.config).not.toContain('test-installation-token');
      expect(run.config).not.toContain('credential');
      // Never the review's own checkout.
      expect(run.job.checkout.startsWith(w.workdirRoot)).toBe(false);
    }
    expect(base.job.runId).not.toBe(atHead.job.runId);
    // The base with the head's test applied, then the head.
    expect([base.total, base.testFile]).toEqual(['buggy\n', true]);
    expect([atHead.total, atHead.testFile]).toEqual(['fixed\n', true]);
    // The scratch trees are gone afterwards.
    expect(runner.runs.some((r) => existsSync(r.job.checkout))).toBe(false);

    const passed = await lastOf('review-passed');
    expect(await storedVerdict(passed?.payload.review)).toEqual(APPROVE);
    expect(w.github.lastCheck()).toMatchObject({ headSha: head, conclusion: 'success' });
  });

  it('a runner without runTests (local) leaves the proof on the host', async () => {
    const w = await setup({ testCommand: markedCommand() });
    await fixerOpensPr(w, FIXED);
    w.harness.script.push(APPROVE);

    await review(w);

    expect(existsSync(marker())).toBe(true);
    expect(await lastOf('review-passed')).toBeDefined();
  });

  it('the exit codes the runner observes decide: passing at the base is request-changes', async () => {
    const runner = new FakeIsolatedRunner();
    runner.results.push({ exitCode: 0, timedOut: false, output: 'ok' });
    const w = await setup({}, runner);
    await fixerOpensPr(w, FIXED);
    w.harness.script.push(APPROVE);

    await review(w);

    expect(runner.runs).toHaveLength(1);
    const failed = await lastOf('review-failed');
    expect(failed?.payload.verdict).toBe('request-changes');
    expect(failed?.payload.reason).toContain('the tests pass without the fix');
  });

  it('a run the runner timed out is request-changes naming the phase', async () => {
    const runner = new FakeIsolatedRunner();
    runner.results.push({ exitCode: 1, timedOut: false, output: 'FAIL' }, { exitCode: null, timedOut: true, output: 'still going' });
    const w = await setup({}, runner);
    await fixerOpensPr(w, FIXED);
    w.harness.script.push(APPROVE);

    await review(w);

    const failed = await lastOf('review-failed');
    expect(failed?.payload.verdict).toBe('request-changes');
    expect(failed?.payload.reason).toContain('timed out at the head');
  });

  it('the proof applies at the base only the test files the reviewed head changes, whatever the reviewer names (#263)', async () => {
    const runner = new FakeIsolatedRunner();
    const w = await setup({}, runner);
    await fixerOpensPr(w, FIXED);
    // A path that is not a test file the head changes: applying the head's copy at the base would let
    // the base run be decided by something other than the regression test.
    w.harness.script.push({ ...APPROVE, regressionTest: { path: 'src/cart/total.txt' } });

    await review(w);

    const [base] = runner.runs;
    expect([base?.total, base?.testFile]).toEqual(['buggy\n', true]);
    // The recorded regression test is the file the proof covered.
    expect(await storedVerdict((await lastOf('review-passed'))?.payload.review)).toEqual(APPROVE);
  });

  it('the proof takes the test files from the reviewed head itself, not from the list GitHub shows (#263)', async () => {
    const runner = new FakeIsolatedRunner();
    const w = await setup({}, runner);
    await fixerOpensPr(w, FIXED);
    // GitHub's list may already describe another push: here it lacks the head's test and names one the head does not have.
    w.github.files = [{ filename: 'src/cart/total.txt', status: 'modified' }, { filename: 'test/later.test.sh', status: 'added' }];
    w.harness.script.push(APPROVE);

    await review(w);

    expect(runner.runs).toHaveLength(2);
    expect(runner.runs[0]?.testFile).toBe(true);
    expect(await storedVerdict((await lastOf('review-passed'))?.payload.review)).toEqual(APPROVE);
  });

  it('a runner that cannot run the tests escalates, and the host does not run them instead', async () => {
    const runner = new FakeIsolatedRunner();
    runner.results.push(new Error('Cannot connect to the Docker daemon'));
    const w = await setup({ testCommand: markedCommand() }, runner);
    await fixerOpensPr(w, FIXED);
    w.harness.script.push(APPROVE);

    await review(w);

    expect(existsSync(marker())).toBe(false);
    const failed = await lastOf('review-failed');
    expect(failed?.payload.verdict).toBe('escalate');
    expect(failed?.payload.reason).toContain('runner: Cannot connect to the Docker daemon');
  });
});

describe(`review agent on a runner with a boundary (${TEST_DIALECT}; ADR 0017)`, () => {
  it('no host process runs the review harness: the runner gets a self-contained tree at the head, the input in it, no credential', async () => {
    const runner = new FakeReviewingRunner();
    const w = await setup({ wallClock: 'PT20M' }, runner);
    const head = await fixerOpensPr(w, FIXED);
    runner.acts.push(APPROVE);

    await review(w);

    // The host harness never ran.
    expect(w.harness.calls).toEqual([]);
    expect(runner.reviews).toHaveLength(1);
    const seen = runner.reviews[0];
    if (seen === undefined) throw new Error('unreachable');
    const { job } = seen;
    expect(job.workItem).toEqual({ id: INC, issueKey: 'WEB-1042', repo: REPO });
    expect(job.harness).toEqual({ adapter: 'claude-code' });
    expect(job.budget).toEqual({ wallClock: 'PT20M', attempts: 1 });
    expect(job.inputFile).toBe(REVIEW_INPUT_PATH);
    expect(job.verdictFile).toBe(REVIEW_VERDICT_PATH);
    expect(REVIEW_VERDICT_PATH.startsWith('.git/snapwing/')).toBe(true);
    // A copy at the head with its own objects, no remote, no credential; never the review's checkout.
    expect(seen.head).toBe(head);
    expect(seen.total).toBe('fixed\n');
    expect(seen.alternates).toBe(false);
    expect(seen.config).not.toContain('[remote');
    expect(seen.config).not.toContain('test-installation-token');
    expect(seen.config).not.toContain('credential');
    expect(seen.config).not.toContain('hooksPath');
    expect(existsSync(join(job.checkout, '.git', 'snapwing', 'askpass'))).toBe(false);
    // The input is the review request: constraints and the diff, nothing of the fixer's.
    expect(seen.input).toContain('<scope>Only src/cart and its tests</scope>');
    expect(seen.input).toContain('+fixed');
    expect(seen.input).not.toContain('FIXER-SUMMARY-SECRET-REASONING');
    // Gone afterwards.
    expect(existsSync(job.checkout)).toBe(false);

    const passed = await lastOf('review-passed');
    expect(await storedVerdict(passed?.payload.review)).toEqual(APPROVE);
    expect(w.github.lastCheck()).toMatchObject({ headSha: head, conclusion: 'success' });
    // The regression proof still ran inside the runner too.
    expect(runner.runs).toHaveLength(2);
  });

  it('passes the configured review harness to the runner', async () => {
    const runner = new FakeReviewingRunner();
    const w = await setup({ harness: { adapter: 'generic', templateId: 'aider' } }, runner);
    await fixerOpensPr(w, FIXED);

    await review(w);

    expect(runner.reviews[0]?.job.harness).toEqual({ adapter: 'generic', templateId: 'aider' });
    expect(await lastOf('review-passed')).toBeDefined();
  });

  it('a request-changes verdict read from the tree starts the fixer retry', async () => {
    const runner = new FakeReviewingRunner();
    const w = await setup({}, runner);
    await fixerOpensPr(w, FIXED);
    runner.acts.push(REQUEST_CHANGES);

    await review(w);

    const failed = await lastOf('review-failed');
    expect(failed?.payload.verdict).toBe('request-changes');
    expect(await storedVerdict(failed?.payload.review)).toMatchObject({ verdict: 'request-changes', reasons: ['Handle the empty cart in the total'] });
  });

  it('the agent\'s tree, on a runner or on the host, holds none of the checkout\'s agent CLI configuration (#263)', async () => {
    const config = { '.claude/settings.json': '{}\n', '.codex/config.toml': '\n', '.gemini/settings.json': '{}\n', '.mcp.json': '{}\n' };
    const seen = (dir: string): string[] => AGENT_CONFIG_PATHS.filter((p) => existsSync(join(dir, p)));
    const visible: string[][] = [];

    const runner = new FakeReviewingRunner();
    const w = await setup({}, runner);
    await fixerOpensPr(w, { ...FIXED, ...config });
    runner.acts.push(async (job) => {
      visible.push(seen(job.checkout));
      await writeFile(join(job.checkout, job.verdictFile), JSON.stringify(REQUEST_CHANGES));
    });
    await review(w);
    expect(visible).toEqual([[]]);
    expect(runner.reviews[0]?.input).toContain('.gemini/settings.json');
    expect(runner.reviews[0]?.total).toBe('fixed\n');
  });

  it('on the host too, the review agent\'s working tree holds none of the checkout\'s agent CLI configuration (#263)', async () => {
    const config = { '.claude/settings.json': '{}\n', '.codex/config.toml': '\n', '.gemini/settings.json': '{}\n', '.mcp.json': '{}\n' };
    const visible: string[][] = [];
    const w = await setup();
    await fixerOpensPr(w, { ...FIXED, ...config });
    w.harness.script.push(async (call) => {
      visible.push(AGENT_CONFIG_PATHS.filter((p) => existsSync(join(call.workdir, p))));
      await writeFile(call.opts.env?.[REVIEW_FILE_ENV] ?? '', JSON.stringify(REQUEST_CHANGES));
    });
    await review(w);
    expect(visible).toEqual([[]]);
    expect(w.harness.calls[0]?.input).toContain('.codex/config.toml');
  });

  it('the verdict is read before the first test run: PR code in a test run that writes a verdict changes nothing (#263)', async () => {
    const approve = JSON.stringify(APPROVE);
    const reached: string[] = [];
    /** Test runs stand in for the PR's code: each writes an approval into its own tree and, as if it could, into the agent's. */
    class TamperingRunner extends FakeReviewingRunner {
      override async runTests(job: TestRunJob): Promise<TestRunResult> {
        await mkdir(join(job.checkout, '.git', 'snapwing'), { recursive: true });
        await writeFile(join(job.checkout, REVIEW_VERDICT_PATH), approve);
        const agentTree = this.reviews[0]?.job.checkout;
        if (agentTree !== undefined && existsSync(join(agentTree, '.git', 'snapwing'))) {
          await writeFile(join(agentTree, REVIEW_VERDICT_PATH), approve);
          reached.push(agentTree);
        }
        return super.runTests(job);
      }
    }
    const runner = new TamperingRunner();
    const w = await setup({}, runner);
    await fixerOpensPr(w, FIXED);
    runner.acts.push(REQUEST_CHANGES);

    await review(w);

    expect(runner.runs).toHaveLength(2);
    expect(reached).toHaveLength(2);
    const failed = await lastOf('review-failed');
    expect(failed?.payload.verdict).toBe('request-changes');
    expect(await storedVerdict(failed?.payload.review)).toEqual({ ...REQUEST_CHANGES, regressionTest: { path: 'test/cart.test.sh' } });
    expect(w.github.reviews.map((r) => r.event)).toEqual(['REQUEST_CHANGES']);
  });

  it('a verdict file that links to a host file is not read: escalate', async () => {
    const runner = new FakeReviewingRunner();
    const w = await setup({}, runner);
    await fixerOpensPr(w, FIXED);
    // A host file holding a valid approval, which the container must not be able to make us read.
    const hostFile = join(scratch, 'host-approval.json');
    await writeFile(hostFile, JSON.stringify(APPROVE));
    runner.acts.push((job) => symlink(hostFile, join(job.checkout, job.verdictFile)));

    await review(w);

    const failed = await lastOf('review-failed');
    expect(failed?.payload.verdict).toBe('escalate');
    expect(failed?.payload.reason).toContain('the review agent left a verdict file that is a link');
  });

  it('a linked .git/snapwing directory is not followed either', async () => {
    const runner = new FakeReviewingRunner();
    const w = await setup({}, runner);
    await fixerOpensPr(w, FIXED);
    const hostDir = join(scratch, 'host-dir');
    await mkdir(hostDir);
    await writeFile(join(hostDir, 'verdict.json'), JSON.stringify(APPROVE));
    runner.acts.push(async (job) => {
      const own = join(job.checkout, '.git', 'snapwing');
      await rm(own, { recursive: true, force: true });
      await symlink(hostDir, own);
    });

    await review(w);

    expect((await lastOf('review-failed'))?.payload.reason).toContain('the review agent left a verdict file that is a link');
  });

  const escalations: { name: string; act?: ReviewAct; result?: ReviewRunResult | Error; reason: string }[] = [
    { name: 'no verdict file', act: () => Promise.resolve(), reason: 'the review agent wrote no verdict file' },
    { name: 'an invalid verdict', act: { raw: '{"verdict":"ship-it"}' }, reason: "the review agent's verdict is invalid" },
    { name: 'a failing exit', result: { exitCode: 2, timedOut: false, output: 'boom' }, reason: 'the review agent failed: exit 2' },
    { name: 'a timeout', result: { exitCode: null, timedOut: true, output: '' }, reason: 'the review agent ran past its PT30M budget' },
    {
      name: 'a runner that cannot run',
      result: new Error('Cannot connect to the Docker daemon'),
      reason: 'the review agent could not run: runner: Cannot connect to the Docker daemon',
    },
  ];
  it.each(escalations)('$name escalates, and the host harness never runs', async (c) => {
    const runner = new FakeReviewingRunner();
    if (c.act !== undefined) runner.acts.push(c.act);
    if (c.result !== undefined) runner.reviewResults.push(c.result);
    const w = await setup({}, runner);
    await fixerOpensPr(w, FIXED);

    await review(w);

    const failed = await lastOf('review-failed');
    expect(failed?.payload.verdict).toBe('escalate');
    expect(failed?.payload.reason).toContain(c.reason);
    expect(w.harness.calls).toEqual([]);
  });

  it('a runner with runTests but no runReview keeps the review harness on the host', async () => {
    const runner = new FakeIsolatedRunner();
    const w = await setup({}, runner);
    await fixerOpensPr(w, FIXED);
    w.harness.script.push(APPROVE);

    await review(w);

    expect(w.harness.calls).toHaveLength(1);
    expect(await lastOf('review-passed')).toBeDefined();
  });
});

describe('review job contracts', () => {
  it('validates review.run job data', () => {
    expect(isReviewRunData({ incidentId: INC, prNumber: PR, headSha: 'abc123' })).toBe(true);
    expect(isReviewRunData({ incidentId: INC, prNumber: 0, headSha: 'abc123' })).toBe(false);
    expect(isReviewRunData({ incidentId: INC, prNumber: PR })).toBe(false);
  });

  it('combine always yields a verdict parseReviewVerdict accepts unchanged', () => {
    const cases: ReviewVerdict[] = [
      combine(APPROVE, [], { kind: 'not-required' }, 1),
      combine(APPROVE, [{ constraint: 'scope', file: 'a/b.ts', note: 'outside' }], { kind: 'proven', testPath: 'test/x.test.ts' }, 1),
      combine({ failure: 'no verdict' }, [], { kind: 'unprovable', note: 'no command' }, 2),
      combine(REQUEST_CHANGES, [], { kind: 'failed', status: 'fails-with-fix', note: 'fails' }, 2),
      combine({ verdict: 'request-changes', reasons: [' '], constraintViolations: [] }, [], { kind: 'not-required' }, 1),
    ];
    for (const v of cases) {
      const parsed = parseReviewVerdict(JSON.stringify(v));
      expect(parsed).toEqual({ ok: true, verdict: v });
    }
    expect(cases.map((v) => v.verdict)).toEqual(['approve', 'request-changes', 'escalate', 'escalate', 'request-changes']);
  });
});
