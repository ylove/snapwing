// Recording the CI result (B 5, B 8, main 10, main 11): `recordCiResult`, the one place the
// GitHub webhook, the review job, and `merge.evaluate` record `ci-green` or `ci-red`, and the fixer
// retry `ci-red` starts. Runs on the in-process workflow over the dialect `SNAPWING_DB` selects, with a
// fake CiGitHub whose answers each test sets.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventPayloads, EventType, IncidentEvent, NewEvent } from '../../src/contracts/events.ts';
import { isFixerRunData, type FixerRunData } from '../../src/contracts/jobs.ts';
import { latest } from '../../src/fixer/job.ts';
import { ciChecksOf, ciRecorded, ciRedReview, recordCiResult, retryFixerAfterCiRed, type CiDeps, type CiGitHub, type CiPullRequest } from '../../src/merge/ci.ts';
import { evaluateMerge, type MergeCombinedStatus, type MergeDeps } from '../../src/merge/job.ts';
import { DEFAULT_MERGE_CONFIG } from '../../src/config/app-config.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { parseReviewVerdict } from '../../src/review/verdict.ts';
import { InProcessWorkflow } from '../../src/workflow/inprocess/index.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../helpers/db.ts';

const T0 = Date.parse('2026-10-02T09:00:00.000Z');
const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6CIRESULTINC00000000000';
const REPO = 'fake-org/web';
const PR = 418;
const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const HUMAN = { id: 'dana-dev', role: 'human' } as const;

let tdb: TestDatabase;
let state: OpenedState;
let wf: InProcessWorkflow;
let now: number;
let errors: unknown[];
let fixerRuns: FixerRunData[];

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0;
  errors = [];
  fixerRuns = [];
  state = await tdb.open({ now: () => new Date(now) });
  wf = new InProcessWorkflow(state, { onError: (e) => errors.push(e) });
  wf.work('fixer.run', (job) => {
    if (!isFixerRunData(job.data)) throw new Error('malformed fixer.run data');
    fixerRuns.push(job.data);
    return Promise.resolve();
  });
});

afterEach(async () => {
  await wf.stop();
  await tdb.drop();
  expect(errors).toEqual([]);
});

// Fakes -------------------------------------------------------------------------------------------

class FakeGitHub implements CiGitHub {
  pr: CiPullRequest = { state: 'open', merged: false, headSha: HEAD, baseRef: 'main' };
  required: MergeCombinedStatus['required'] = [
    { name: 'build', state: 'success', source: 'check-run' },
    { name: 'test', state: 'success', source: 'check-run' },
  ];
  readonly calls: string[] = [];

  getPullRequest(number: number): Promise<CiPullRequest> {
    this.calls.push(`getPullRequest ${String(number)}`);
    return Promise.resolve({ ...this.pr });
  }

  combinedStatus(sha: string, baseBranch: string): Promise<MergeCombinedStatus> {
    this.calls.push(`combinedStatus ${sha.slice(0, 1)} ${baseBranch}`);
    return Promise.resolve({ required: this.required.map((c) => ({ ...c })) });
  }
}

function setup(): { deps: CiDeps; github: FakeGitHub } {
  const github = new FakeGitHub();
  const deps: CiDeps = {
    workspaceId: WS,
    state,
    workflow: wf,
    github: (repo) => {
      if (repo !== REPO) throw new Error(`unexpected repo ${repo}`);
      return github;
    },
    clock: () => new Date(now),
  };
  return { deps, github };
}

// Log -----------------------------------------------------------------------------------------------

function ev<T extends EventType>(type: T, payload: EventPayloads[T], source: 'agent' | 'fixer' | 'github' = 'agent', actor?: typeof HUMAN): NewEvent<T> {
  return {
    workspaceId: WS,
    incidentId: INC,
    type,
    v: 1,
    source,
    ...(actor === undefined ? {} : { actor }),
    occurredAt: new Date(now).toISOString(),
    payload,
  } as unknown as NewEvent<T>;
}

function toFiled(level: 0 | 1 | 2 | 3): NewEvent[] {
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
    ev('resolved', { surfaceId: 'web', componentId: 'checkout', repo: REPO, resolvedBy: 'channel-explicit', confidence: 0.9 }),
    ev('dedupe-checked', { candidates: [], decision: 'none' }),
    ev('planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 'Checkout returns 500 on submit',
      priority: 'High',
      labels: ['snapwing'],
      autonomyLevel: level,
      implementationRequest: { artifactId: '01K6REQUEST0000000000000001', version: 1 },
    }),
    ev('filed', { jiraKey: 'WEB-1042' }),
  ];
}

/** The fixer's attempt `attempt` ends in PR `PR` (status `in-review`, or `in-review-retry` on attempt 2). */
function fixerPr(attempt: 1 | 2 = 1): NewEvent[] {
  return [
    ev('fixer-started', { runId: `01K6RUN000000000000000000${String(attempt)}`, harness: 'claude-code', attempt }),
    ev('fixer-done', { prNumber: PR, branch: 'fix/WEB-1042', summary: 'Guard the null cart', testsAdded: ['test/cart.test.ts'] }, 'fixer'),
    ev('pr-opened', { prNumber: PR, branch: 'fix/WEB-1042' }, 'fixer'),
  ];
}

const reviewPassed = (): NewEvent => ({ ...ev('review-passed', { prNumber: PR, headSha: HEAD }), v: 2 }) as NewEvent;

async function log(): Promise<IncidentEvent[]> {
  return state.read(INC);
}

async function append(...events: NewEvent[]): Promise<void> {
  const last = (await log()).at(-1)?.seq ?? 0;
  await state.append(INC, events, last);
}

async function types(): Promise<EventType[]> {
  return (await log()).map((e) => e.type);
}

async function status(): Promise<string | undefined> {
  return (await state.getIncident(INC))?.status;
}

/** In `ci`: filed at `level`, the fixer's PR, the review passed. */
async function awaitingCi(level: 0 | 1 | 2 | 3 = 2): Promise<void> {
  await append(...toFiled(level), ...fixerPr(), reviewPassed());
}

// Tests -------------------------------------------------------------------------------------------

describe('ciChecksOf', () => {
  it('is complete only when every required check reported and completed; no required checks is never green', () => {
    expect(ciChecksOf([])).toEqual({ state: 'none-required' });
    expect(ciChecksOf([{ name: 'build', state: 'success', source: 'check-run' }])).toEqual({ state: 'green' });
    expect(ciChecksOf([{ name: 'build', state: 'success', source: null }])).toEqual({ state: 'pending' });
    expect(
      ciChecksOf([
        { name: 'build', state: 'failure', source: 'check-run' },
        { name: 'test', state: 'pending', source: 'check-run' },
      ]),
    ).toEqual({ state: 'pending' });
    expect(
      ciChecksOf([
        { name: 'build', state: 'failure', source: 'check-run' },
        { name: 'test', state: 'success', source: 'status' },
        { name: 'lint', state: 'failure', source: 'status' },
      ]),
    ).toEqual({ state: 'red', failingChecks: ['build', 'lint'] });
  });

  it('the prior review a ci-red retry hands the fixer parses as a request-changes verdict', () => {
    const review = ciRedReview(['test', 'lint'], HEAD);
    const parsed = parseReviewVerdict(JSON.stringify(review));
    expect(parsed).toEqual({ ok: true, verdict: review });
    expect(review.verdict).toBe('request-changes');
    expect(review.reasons[0]).toContain('test, lint');
    expect(review.constraintViolations.map((v) => v.note)).toEqual(['required check test failed', 'required check lint failed']);
  });
});

describe(`recordCiResult (${TEST_DIALECT})`, () => {
  it.each([0, 1, 2, 3] as const)('level %i: CI that finished before review-passed moves ci to mergeable, once', async (level) => {
    const { deps, github } = setup();
    await awaitingCi(level);
    expect(await status()).toBe('ci');

    expect(await recordCiResult(deps, INC)).toEqual({ recorded: 'ci-green', prNumber: PR, headSha: HEAD });
    expect(await status()).toBe('mergeable');
    const green = latest(await log(), 'ci-green');
    expect(green).toMatchObject({ source: 'github', payload: { prNumber: PR, headSha: HEAD } });

    // Asked again (a late check delivery, merge.evaluate): nothing waits, so no GitHub call and no event.
    github.calls.length = 0;
    expect(await recordCiResult(deps, INC, { headSha: HEAD })).toEqual({ recorded: false, reason: 'not-awaiting' });
    expect(github.calls).toEqual([]);
    expect((await types()).filter((t) => t === 'ci-green')).toHaveLength(1);
    await wf.drain();
    expect(fixerRuns).toEqual([]);
  });

  it('records nothing and calls nothing while the review is still running (B 5)', async () => {
    const { deps, github } = setup();
    await append(...toFiled(2), ...fixerPr());
    expect(await recordCiResult(deps, INC)).toEqual({ recorded: false, reason: 'not-awaiting' });
    expect(github.calls).toEqual([]);
    expect(await status()).toBe('in-review');
  });

  it('waits while a required check runs or has not reported, and never calls an unprotected branch green', async () => {
    const { deps, github } = setup();
    await awaitingCi();
    github.required = [
      { name: 'build', state: 'failure', source: 'check-run' },
      { name: 'test', state: 'pending', source: 'check-run' },
    ];
    expect(await recordCiResult(deps, INC)).toEqual({ recorded: false, reason: 'pending' });
    github.required = [{ name: 'build', state: 'success', source: null }];
    expect(await recordCiResult(deps, INC)).toEqual({ recorded: false, reason: 'pending' });
    github.required = [];
    expect(await recordCiResult(deps, INC)).toEqual({ recorded: false, reason: 'none-required' });
    expect(await status()).toBe('ci');
    expect((await log()).at(-1)?.type).toBe('review-passed');
    expect(github.calls).toContain('combinedStatus a main');
  });

  it('a head other than the caller\'s, or a PR no longer open, records nothing', async () => {
    const { deps, github } = setup();
    await awaitingCi();
    expect(await recordCiResult(deps, INC, { headSha: HEAD2 })).toEqual({ recorded: false, reason: 'head-moved' });
    github.pr = { ...github.pr, state: 'closed' };
    expect(await recordCiResult(deps, INC)).toEqual({ recorded: false, reason: 'not-open' });
    github.pr = { ...github.pr, state: 'open', merged: true };
    expect(await recordCiResult(deps, INC)).toEqual({ recorded: false, reason: 'not-open' });
    expect(await status()).toBe('ci');
  });

  it('one result per head sha across the webhook, the review step, and merge.evaluate racing', async () => {
    const { deps, github } = setup();
    await awaitingCi(2);
    const merge: MergeDeps = {
      ...deps,
      github: () => ({
        ...github,
        getPullRequest: (n: number) => github.getPullRequest(n).then((p) => ({ ...p, number: n, headRef: 'fix/WEB-1042' })),
        combinedStatus: (sha: string, base: string) => github.combinedStatus(sha, base),
        compareFiles: () => Promise.resolve({ files: [], complete: true }),
        mergePullRequest: () => Promise.reject(new Error('never merges below level 3')),
        deleteBranch: () => Promise.resolve(),
        openRevertPullRequest: () => Promise.reject(new Error('unused')),
      }),
      merge: DEFAULT_MERGE_CONFIG,
      map: { policies: { autonomy: { default: 2, levels: [], overrides: [] } } },
    };
    const out = await Promise.all([recordCiResult(deps, INC, { headSha: HEAD }), recordCiResult(deps, INC, { headSha: HEAD }), evaluateMerge(merge, { incidentId: INC })]);
    expect(out[2]).toEqual({ outcome: 'skipped', reason: 'not-autopilot', level: 2 });
    expect((await types()).filter((t) => t === 'ci-green' || t === 'ci-red')).toEqual(['ci-green']);
    expect(await status()).toBe('mergeable');
    expect(ciRecorded(await log(), PR, HEAD)).toBe(true);
  });

  it('ci-red in ci: the fixer retries once with the failing checks as its prior review (main 10)', async () => {
    const { deps, github } = setup();
    await awaitingCi(3);
    github.required = [
      { name: 'build', state: 'success', source: 'check-run' },
      { name: 'test', state: 'failure', source: 'check-run' },
      { name: 'lint', state: 'failure', source: 'status' },
    ];

    expect(await recordCiResult(deps, INC, { headSha: HEAD })).toEqual({ recorded: 'ci-red', prNumber: PR, headSha: HEAD, failingChecks: ['test', 'lint'], fixerRestarted: true });
    const red = latest(await log(), 'ci-red');
    expect(red).toMatchObject({ source: 'github', payload: { prNumber: PR, headSha: HEAD, failingChecks: ['test', 'lint'] } });
    expect(await status()).toBe('fixing-retry');

    await wf.drain();
    expect(fixerRuns).toHaveLength(1);
    const run = fixerRuns[0];
    expect(run).toMatchObject({ incidentId: INC, attempt: 2 });
    if (run?.reviewArtifact === undefined) throw new Error('no prior review');
    const artifact = await state.getArtifact(run.reviewArtifact.artifactId, run.reviewArtifact.version);
    expect(artifact).toMatchObject({ kind: 'review', contentType: 'application/json', createdBy: 'ci', incidentId: INC });
    expect(JSON.parse(artifact.body)).toEqual(ciRedReview(['test', 'lint'], HEAD));

    // The retry's run started: asking again starts nothing more, and no second result lands.
    await append(ev('fixer-started', { runId: '01K6RUN0000000000000000002', harness: 'claude-code', attempt: 2 }));
    expect(await retryFixerAfterCiRed(deps, INC)).toBe(false);
    expect(await recordCiResult(deps, INC)).toEqual({ recorded: false, reason: 'not-awaiting' });
    await wf.drain();
    expect(fixerRuns).toHaveLength(1);
  });

  it('the retry\'s ci-red escalates (ci-retry, B 5) and starts no third run', async () => {
    const { deps, github } = setup();
    await awaitingCi();
    github.required = [{ name: 'test', state: 'failure', source: 'check-run' }];
    await recordCiResult(deps, INC);
    await wf.drain();
    expect(fixerRuns).toHaveLength(1);

    // The retry pushes a new head, opens the PR again, and its review passes: `ci-retry`.
    await append(...fixerPr(2), reviewPassed());
    expect(await status()).toBe('ci-retry');
    github.pr = { ...github.pr, headSha: HEAD2 };
    expect(await recordCiResult(deps, INC)).toEqual({ recorded: 'ci-red', prNumber: PR, headSha: HEAD2, failingChecks: ['test'], fixerRestarted: false });
    expect(await status()).toBe('escalated');
    await wf.drain();
    expect(fixerRuns).toHaveLength(1);
  });

  it('the retry\'s green CI reaches mergeable from ci-retry', async () => {
    const { deps, github } = setup();
    await awaitingCi();
    github.required = [{ name: 'test', state: 'failure', source: 'check-run' }];
    await recordCiResult(deps, INC);
    await append(...fixerPr(2), reviewPassed());
    github.pr = { ...github.pr, headSha: HEAD2 };
    github.required = [{ name: 'test', state: 'success', source: 'check-run' }];
    expect(await recordCiResult(deps, INC)).toEqual({ recorded: 'ci-green', prNumber: PR, headSha: HEAD2 });
    expect(await status()).toBe('mergeable');
    await wf.drain();
  });

  it('a human\'s PR with red CI is recorded but left to the human: no fixer retry', async () => {
    const { deps, github } = setup();
    await append(...toFiled(2), ev('pr-opened', { prNumber: PR, branch: 'fix/web-1042-total' }, 'github', HUMAN), reviewPassed());
    expect(await status()).toBe('ci');
    github.required = [{ name: 'test', state: 'failure', source: 'check-run' }];
    expect(await recordCiResult(deps, INC)).toMatchObject({ recorded: 'ci-red', fixerRestarted: false });
    await wf.drain();
    expect(fixerRuns).toEqual([]);
  });

  it('after a Stop, a later retry request (the reconciler\'s follow-up) starts nothing', async () => {
    const { deps, github } = setup();
    await awaitingCi();
    github.required = [{ name: 'test', state: 'failure', source: 'check-run' }];
    const recorded = await recordCiResult(deps, INC);
    expect(recorded.recorded).toBe('ci-red');
    await append(ev('stopped', { reason: 'wrong fix' }));
    expect(await retryFixerAfterCiRed(deps, INC)).toBe(false);
    await wf.drain();
  });
});
