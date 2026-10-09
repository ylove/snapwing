// Merge step (`merge.evaluate`), autopilot, and Revert (main 11.3, main 14.1, B 5). Runs on the
// in-process workflow over the dialect `SNAPWING_DB` selects, with a fake MergeGitHub whose answers
// each test sets. The log is built up to `ci` (review passed) the way the fixer and review jobs leave it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventPayloads, EventType, IncidentEvent, NewEvent } from '../../src/contracts/events.ts';
import { DEFAULT_MERGE_CONFIG, type MergeConfig } from '../../src/config/app-config.ts';
import { latest } from '../../src/fixer/job.ts';
import {
  evaluateMerge,
  registerMergeJobs,
  riskLimits,
  startMergeEvaluate,
  type MergeCombinedStatus,
  type MergeCompareFiles,
  type MergeDeps,
  type MergeGitHub,
  type MergePullRequest,
  type MergePullRequestFile,
  type MergeResult,
} from '../../src/merge/job.ts';
import { registerRevertTimer, revert } from '../../src/merge/revert.ts';
import type { AutonomyOverride, WorkspaceMap } from '../../src/map/types.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { InProcessWorkflow } from '../../src/workflow/inprocess/index.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../helpers/db.ts';

const T0 = Date.parse('2026-10-02T09:00:00.000Z');
const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6MERGEINC00000000000000';
const REPO = 'fake-org/web';
const PR = 418;
const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);
const ENGINEER = { id: 'U-FAKE-DANA', role: 'engineer' } as const;
/** Dana's Revert tap: her own token, and the merge the button named (#264). */
const AS_DANA = { userToken: 'test-user-token-dana', pin: { prNumber: 418, sha: 'c'.repeat(40) } } as const;
const HOUR = 60 * 60_000;

let tdb: TestDatabase;
let state: OpenedState;
let wf: InProcessWorkflow;
let now: number;
let errors: unknown[];

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0;
  errors = [];
  state = await tdb.open({ now: () => new Date(now) });
  wf = new InProcessWorkflow(state, { onError: (e) => errors.push(e) });
});

afterEach(async () => {
  await wf.stop();
  await tdb.drop();
  expect(errors).toEqual([]);
});

// Fakes -------------------------------------------------------------------------------------------

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`GitHub API ${String(status)}: ${message}`);
  }
}

class FakeGitHub implements MergeGitHub {
  pr: MergePullRequest = { number: PR, state: 'open', merged: false, headSha: HEAD, headRef: 'fix/WEB-1042', baseRef: 'main' };
  required: MergeCombinedStatus['required'] = [{ name: 'ci', state: 'success', source: 'check-run' }];
  files: MergePullRequestFile[] = [{ filename: 'src/cart.ts', additions: 30, deletions: 6 }, { filename: 'test/cart.test.ts', additions: 11, deletions: 0 }];
  /** False: GitHub cut the comparison's file list short. */
  filesComplete = true;
  /** Each comparison read: base and head. */
  readonly compared: { base: string; head: string }[] = [];
  /** Answers for successive merges; an Error is thrown. Default: merged. */
  mergeAnswers: (MergeResult | Error)[] = [];
  /** Runs before each merge answer, e.g. to move the head. */
  onMerge: (() => void) | undefined;
  readonly calls: string[] = [];
  readonly merges: { number: number; expectedHeadSha: string }[] = [];
  readonly deleted: string[] = [];
  readonly reverts: { number: number; title?: string; body?: string; userToken: string }[] = [];
  /** An error the next revert is answered with. */
  revertError: Error | undefined;
  statusFor: { sha: string; base: string }[] = [];

  getPullRequest(number: number): Promise<MergePullRequest> {
    this.calls.push(`getPullRequest ${String(number)}`);
    return Promise.resolve({ ...this.pr });
  }

  compareFiles(base: string, head: string): Promise<MergeCompareFiles> {
    this.calls.push(`compareFiles ${base}...${head}`);
    this.compared.push({ base, head });
    return Promise.resolve({ files: this.files.map((f) => ({ ...f })), complete: this.filesComplete });
  }

  combinedStatus(sha: string, baseBranch: string): Promise<MergeCombinedStatus> {
    this.calls.push('combinedStatus');
    this.statusFor.push({ sha, base: baseBranch });
    return Promise.resolve({ required: this.required.map((c) => ({ ...c })) });
  }

  mergePullRequest(number: number, input: { expectedHeadSha: string }): Promise<MergeResult> {
    this.calls.push('mergePullRequest');
    this.merges.push({ number, expectedHeadSha: input.expectedHeadSha });
    this.onMerge?.();
    const answer = this.mergeAnswers.shift() ?? { merged: true, sha: MERGE_SHA, message: 'Pull Request successfully merged' };
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  }

  deleteBranch(branch: string): Promise<void> {
    this.calls.push('deleteBranch');
    this.deleted.push(branch);
    return Promise.resolve();
  }

  openRevertPullRequest(number: number, input: { title?: string; body?: string; userToken: string }): Promise<{ number: number; url: string }> {
    this.calls.push('openRevertPullRequest');
    if (this.revertError !== undefined) return Promise.reject(this.revertError);
    this.reverts.push({ number, ...input });
    return Promise.resolve({ number: 420, url: 'https://github.com/fake-org/web/pull/420' });
  }
}

interface World {
  deps: MergeDeps;
  github: FakeGitHub;
  /** `fixer.run` jobs started (the ci-red retry). */
  fixerRuns: unknown[];
  /** `review.run` jobs started (a head no review approved, #264). */
  reviewRuns: unknown[];
  windowClosed: string[];
  map: { policies: WorkspaceMap['policies'] };
}

async function setup(opts: { mapRepo?: string; level?: 0 | 1 | 2 | 3; mapDefault?: 0 | 1 | 2 | 3; overrides?: AutonomyOverride[]; merge?: Partial<MergeConfig>; toCi?: boolean } = {}): Promise<World> {
  const github = new FakeGitHub();
  const windowClosed: string[] = [];
  const map: World['map'] = { policies: { autonomy: { default: opts.mapDefault ?? 3, levels: [], overrides: opts.overrides ?? [] } } };
  const deps: MergeDeps = {
    workspaceId: WS,
    state,
    workflow: wf,
    github: (repo) => {
      if (repo !== REPO) throw new Error(`unexpected repo ${repo}`);
      return github;
    },
    merge: { ...DEFAULT_MERGE_CONFIG, ...opts.merge },
    // A getter, so a test can change the map between filing and merge.
    map: () => Promise.resolve(map),
    clock: () => new Date(now),
    onRevertWindowClosed: (id) => {
      windowClosed.push(id);
      return Promise.resolve();
    },
  };
  registerMergeJobs(deps);
  registerRevertTimer(deps);
  const fixerRuns: unknown[] = [];
  wf.work('fixer.run', (job) => {
    fixerRuns.push(job.data);
    return Promise.resolve();
  });
  const reviewRuns: unknown[] = [];
  wf.work('review.run', (job) => {
    reviewRuns.push(job.data);
    return Promise.resolve();
  });
  await append(...toFiled(opts.level ?? 3, opts.mapRepo ?? REPO));
  if (opts.toCi !== false) {
    await append(...toPr());
    await append(await approved());
  }
  return { deps, github, fixerRuns, reviewRuns, windowClosed, map };
}

function ev<T extends EventType>(type: T, payload: EventPayloads[T], source: 'agent' | 'fixer' | 'github' | 'slack' | 'jira' = 'agent', actor?: { id: string; role: 'engineer' }): NewEvent<T> {
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

function toFiled(level: 0 | 1 | 2 | 3, repo: string = REPO): NewEvent[] {
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
      summary: 'Checkout returns 500 on submit',
      priority: 'High',
      labels: ['snapwing'],
      autonomyLevel: level,
      implementationRequest: { artifactId: '01K6REQUEST0000000000000001', version: 1 },
    }),
    ev('filed', { jiraKey: 'WEB-1042' }),
  ];
}

function toPr(): NewEvent[] {
  return [
    ev('fixer-started', { runId: '01K6RUN0000000000000000001', harness: 'claude-code', attempt: 1 }),
    ev('fixer-done', { prNumber: PR, branch: 'fix/WEB-1042', summary: 'Guard the null cart', testsAdded: ['test/cart.test.ts'] }, 'fixer'),
    ev('pr-opened', { prNumber: PR, branch: 'fix/WEB-1042' }, 'fixer'),
  ];
}

/** The review job's approval of `headSha`, as it appends it: v2, the head recorded (#264). */
async function approved(headSha: string = HEAD): Promise<NewEvent<'review-passed'>> {
  return { ...ev('review-passed', { prNumber: PR, headSha, review: await reviewArtifact('approve') }), v: 2 };
}

async function reviewArtifact(verdict: 'approve' | 'request-changes' | 'escalate' | 'garbage'): Promise<{ artifactId: string; version: number }> {
  const body = verdict === 'garbage' ? 'not json' : JSON.stringify({ verdict, reasons: verdict === 'approve' ? [] : ['scope'], constraintViolations: [] });
  const a = await state.putArtifact({ workspaceId: WS, incidentId: INC, kind: 'review', contentType: 'application/json', body, createdBy: 'review-agent' });
  return { artifactId: a.id, version: a.version };
}

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

/** Event types appended after `count` events. */
async function typesAfter(count: number): Promise<EventType[]> {
  return (await types()).slice(count);
}

async function lastOf<T extends EventType>(type: T): Promise<IncidentEvent<T> | undefined> {
  return latest(await log(), type);
}

async function advance(ms: number): Promise<void> {
  now += ms;
  await wf.drain();
}

async function status(): Promise<string | undefined> {
  return (await state.getIncident(INC))?.status;
}

// Tests -------------------------------------------------------------------------------------------

describe(`merge.evaluate (${TEST_DIALECT})`, () => {
  it('all gates pass: merges as the App pinned to the head, deletes the branch, records the level, schedules the revert window', async () => {
    const w = await setup();
    const before = (await log()).length;
    expect(await status()).toBe('ci');

    const a = await startMergeEvaluate(w.deps, INC);
    const b = await startMergeEvaluate(w.deps, INC);
    expect(b.jobId).toBe(a.jobId);
    await wf.drain();

    expect(w.github.merges).toEqual([{ number: PR, expectedHeadSha: HEAD }]);
    // Once to record CI (merge/ci.ts), once for the gate.
    expect(w.github.statusFor).toEqual([
      { sha: HEAD, base: 'main' },
      { sha: HEAD, base: 'main' },
    ]);
    expect(w.github.deleted).toEqual(['fix/WEB-1042']);
    expect(await typesAfter(before)).toEqual(['ci-green', 'merged']);
    const merged = await lastOf('merged');
    expect(merged?.payload).toEqual({ prNumber: PR, mergeCommitSha: MERGE_SHA, levelAtMergeTime: 3 });
    expect(merged?.actor).toBeUndefined();
    expect(await status()).toBe('merged');

    // The revert window (default 72 h): the timer fires once, at the end.
    await advance(71 * HOUR);
    expect(w.windowClosed).toEqual([]);
    await advance(1 * HOUR);
    expect(w.windowClosed).toEqual([INC]);

    // Running again after the merge does nothing.
    expect(await evaluateMerge(w.deps, { incidentId: INC })).toEqual({ outcome: 'skipped', reason: 'already-merged' });
    expect(w.github.merges).toHaveLength(1);
  });

  it('a map-form repo (github.com/owner/name) is normalized to owner/name before any GitHub call', async () => {
    const w = await setup({ mapRepo: `github.com/${REPO}` });
    // The FakeGitHub factory throws for any repo but owner/name, so a completed merge proves it.
    await startMergeEvaluate(w.deps, INC);
    await wf.drain();
    expect(await status()).toBe('merged');
  });

  it('uses the configured revert window', async () => {
    const w = await setup({ merge: { revertWindow: 'PT2H' } });
    await evaluateMerge(w.deps, { incidentId: INC });
    await advance(2 * HOUR);
    expect(w.windowClosed).toEqual([INC]);
  });

  it('no required checks on the base branch is a failed gate at level 3, never a pass', async () => {
    const w = await setup();
    w.github.required = [];
    const before = (await log()).length;
    const out = await evaluateMerge(w.deps, { incidentId: INC });
    expect(out).toMatchObject({ outcome: 'held', gate: { ciGreen: false, decision: 'degrade' } });
    expect(out.outcome === 'held' ? out.reason : '').toMatch(/^ci gate: no required checks/);
    expect(w.github.merges).toEqual([]);
    expect(await typesAfter(before)).toEqual(['held', 'level-changed']);
  });

  it('a failed gate at level 3: held with the gate and reason, then the level 2 path; a second run is a no-op', async () => {
    const w = await setup();
    w.github.files.push({ filename: 'infra/main.tf', additions: 1, deletions: 1 });
    const before = (await log()).length;
    const out = await evaluateMerge(w.deps, { incidentId: INC });
    expect(out.outcome).toBe('held');

    // CI was green, so the lifecycle reaches mergeable first and the hold parks it.
    expect(await typesAfter(before)).toEqual(['ci-green', 'held', 'level-changed']);
    const held = await lastOf('held');
    expect(held?.payload).toMatchObject({
      kind: 'gate',
      reason: 'risk gate: forbidden paths touched: infra/main.tf',
      gate: { decision: 'degrade', ciGreen: true, reviewVerdict: 'approve', levelAtMergeTime: 3, riskGate: { passed: false, forbiddenHits: ['infra/main.tf'] } },
    });
    expect((await lastOf('level-changed'))?.payload).toEqual({ from: 3, to: 2, reason: 'merge-held: risk gate: forbidden paths touched: infra/main.tf' });
    expect(await status()).toBe('held');
    expect((await state.getIncident(INC))?.autonomyLevel).toBe(2);

    expect(await evaluateMerge(w.deps, { incidentId: INC })).toEqual({ outcome: 'skipped', reason: 'already-held' });
    expect(w.github.merges).toEqual([]);
  });

  describe('each gate failing on its own', () => {
    it('review: request-changes', async () => {
      const w = await setup({ toCi: false });
      await append(...toPr(), ev('review-failed', { prNumber: PR, verdict: 'request-changes', reason: 'scope' }));
      const out = await evaluateMerge(w.deps, { incidentId: INC });
      expect(out).toMatchObject({ outcome: 'held', reason: 'review gate: verdict is request-changes, not approve' });
    });

    it('review: a review-passed whose artifact does not approve never approves', async () => {
      const w = await setup({ toCi: false });
      await append(...toPr(), ev('review-passed', { prNumber: PR, review: await reviewArtifact('garbage') }));
      const out = await evaluateMerge(w.deps, { incidentId: INC });
      expect(out).toMatchObject({ outcome: 'held', reason: 'review gate: verdict is escalate, not approve' });
    });

    it('review: the latest review is the one that counts', async () => {
      const w = await setup({ toCi: false });
      // First review asks for changes, the retry's review approves.
      await append(...toPr(), ev('review-failed', { prNumber: PR, verdict: 'request-changes', reason: 'scope' }));
      await append(...toPr(), await approved());
      expect((await evaluateMerge(w.deps, { incidentId: INC })).outcome).toBe('merged');
    });

    it('ci: a failing required check is ci-red and the fixer retry, never a hold (main 10)', async () => {
      const w = await setup();
      w.github.required = [
        { name: 'ci', state: 'success', source: 'check-run' },
        { name: 'lint', state: 'failure', source: 'status' },
      ];
      const before = (await log()).length;
      expect(await evaluateMerge(w.deps, { incidentId: INC })).toEqual({ outcome: 'skipped', reason: 'ci-red' });
      expect(await typesAfter(before)).toEqual(['ci-red']);
      expect((await lastOf('ci-red'))?.payload).toEqual({ prNumber: PR, headSha: HEAD, failingChecks: ['lint'] });
      await wf.drain();
      expect(w.fixerRuns).toEqual([{ incidentId: INC, attempt: 2, reviewArtifact: expect.objectContaining({ version: 1 }) as unknown }]);
      expect(await status()).toBe('fixing-retry');
      expect(w.github.merges).toEqual([]);
      // A second run finds the red head and does nothing.
      expect(await evaluateMerge(w.deps, { incidentId: INC })).toEqual({ outcome: 'skipped', reason: 'ci-red' });
      expect(await typesAfter(before)).toEqual(['ci-red']);
    });

    it('risk: too many files and too many lines, from the config or the stricter map', async () => {
      const w = await setup({ merge: { maxFiles: 1 } });
      const out = await evaluateMerge(w.deps, { incidentId: INC });
      expect(out).toMatchObject({ outcome: 'held', reason: 'risk gate: 2 files touched (limit 1)' });

      const limits = riskLimits(
        { ...DEFAULT_MERGE_CONFIG, forbidden: [] },
        { policies: { autonomy: { default: 3, levels: [], overrides: [] }, riskGate: { maxFilesTouched: 20, maxDiffLines: 40, forbiddenPaths: ['db/**'] } } },
      );
      expect(limits.maxFiles).toBe(DEFAULT_MERGE_CONFIG.maxFiles);
      expect(limits.maxDiffLines).toBe(40);
      expect(limits.forbidden).toEqual(expect.arrayContaining(['.github/**', 'infra/**', 'db/**']));
    });

    it('risk: the map risk gate applies at merge time', async () => {
      const w = await setup();
      w.map.policies.riskGate = { maxFilesTouched: 10, maxDiffLines: 40, forbiddenPaths: [] };
      const out = await evaluateMerge(w.deps, { incidentId: INC });
      expect(out).toMatchObject({ outcome: 'held', reason: 'risk gate: 47 diff lines (limit 40)' });
    });

    it('stop: nothing is merged and nothing is appended', async () => {
      const w = await setup();
      await append(ev('stopped', { reason: 'wrong fix' }, 'slack', ENGINEER));
      const before = (await log()).length;
      expect(await evaluateMerge(w.deps, { incidentId: INC })).toEqual({ outcome: 'skipped', reason: 'stopped' });
      expect(await typesAfter(before)).toEqual([]);
      expect(w.github.calls).toEqual([]);
    });

    it('level: the map changed since filing; the level is re-resolved now', async () => {
      const w = await setup();
      w.map.policies.autonomy.overrides.push({ kind: 'component', surface: 'web', ref: 'checkout', level: 2 });
      const out = await evaluateMerge(w.deps, { incidentId: INC });
      expect(out).toMatchObject({ outcome: 'held', reason: 'level gate: resolved level is 2, not 3', gate: { levelAtMergeTime: 2 } });
    });

    it('level: a Jira priority edit that a priority override caps', async () => {
      const w = await setup({ overrides: [{ kind: 'priority', atLeast: 'Highest', level: 2 }] });
      await append(ev('jira-priority-changed', { jiraKey: 'WEB-1042', from: 'High', to: 'Highest' }, 'jira'));
      const out = await evaluateMerge(w.deps, { incidentId: INC });
      expect(out).toMatchObject({ outcome: 'held', gate: { levelAtMergeTime: 2 } });
    });
  });

  it('waits, appending nothing, for a review that has not landed or for required checks still pending', async () => {
    const w = await setup({ toCi: false });
    await append(...toPr());
    const before = (await log()).length;
    expect(await evaluateMerge(w.deps, { incidentId: INC })).toEqual({ outcome: 'waiting', on: 'review' });

    await append(await approved());
    w.github.required = [
      { name: 'ci', state: 'success', source: 'check-run' },
      { name: 'e2e', state: 'pending', source: null },
    ];
    expect(await evaluateMerge(w.deps, { incidentId: INC })).toEqual({ outcome: 'waiting', on: 'ci' });
    expect(await typesAfter(before)).toEqual(['review-passed']);
    expect(w.github.merges).toEqual([]);

    // Pending CI does not delay a hold another gate already decides.
    w.github.files.push({ filename: '.github/workflows/ci.yml', additions: 2, deletions: 0 });
    const out = await evaluateMerge(w.deps, { incidentId: INC });
    expect(out).toMatchObject({ outcome: 'held', reason: 'risk gate: forbidden paths touched: .github/workflows/ci.yml', gate: { ciGreen: false } });
  });

  it.each([0, 1, 2] as const)('level %i never merges here; it records CI that finished before the review, so a human merge fits', async (level) => {
    const w = await setup({ level });
    const before = (await log()).length;
    expect(await evaluateMerge(w.deps, { incidentId: INC })).toEqual({ outcome: 'skipped', reason: 'not-autopilot', level });
    expect(await typesAfter(before)).toEqual(['ci-green']);
    expect(await status()).toBe('mergeable');
    expect(w.github.calls).toEqual([`getPullRequest ${String(PR)}`, 'combinedStatus']);

    // Once mergeable, a later run calls nothing.
    w.github.calls.length = 0;
    expect(await evaluateMerge(w.deps, { incidentId: INC })).toEqual({ outcome: 'skipped', reason: 'not-autopilot', level });
    expect(await typesAfter(before)).toEqual(['ci-green']);
    expect(w.github.calls).toEqual([]);
  });

  it('below level 3 with CI still running: records nothing and merges nothing', async () => {
    const w = await setup({ level: 2 });
    w.github.required = [{ name: 'ci', state: 'pending', source: 'check-run' }];
    const before = (await log()).length;
    expect(await evaluateMerge(w.deps, { incidentId: INC })).toEqual({ outcome: 'skipped', reason: 'not-autopilot', level: 2 });
    expect(await typesAfter(before)).toEqual([]);
    expect(w.github.merges).toEqual([]);
  });

  it('a level lowered after filing (a claim, a fixer failure) is not autopilot either', async () => {
    const w = await setup();
    await append(ev('level-changed', { from: 3, to: 2, reason: 'claimed by Dana' }));
    expect(await evaluateMerge(w.deps, { incidentId: INC })).toMatchObject({ outcome: 'skipped', reason: 'not-autopilot' });
    expect(w.github.merges).toEqual([]);
    expect(w.github.calls).not.toContain(`compareFiles main...${HEAD}`);
  });

  it('head moved between evaluation and merge (409): the re-evaluation finds the new head unreviewed, merges nothing, and starts its review (#264)', async () => {
    const w = await setup();
    w.github.mergeAnswers = [new HttpError(409, 'Head branch was modified. Review and try the merge again.')];
    w.github.onMerge = () => {
      w.github.pr = { ...w.github.pr, headSha: HEAD2 };
      w.github.required = [{ name: 'ci', state: 'failure', source: 'check-run' }];
      w.github.onMerge = undefined;
    };
    const before = (await log()).length;
    expect(await evaluateMerge(w.deps, { incidentId: INC })).toEqual({ outcome: 'waiting', on: 'review' });
    expect(w.github.merges.map((m) => m.expectedHeadSha)).toEqual([HEAD]);
    // Nothing about the new head is read before its review: no checks, no files.
    expect(w.github.statusFor.map((s) => s.sha)).toEqual([HEAD, HEAD]);
    expect(w.github.compared).toEqual([{ base: 'main', head: HEAD }]);
    expect(await typesAfter(before)).toEqual(['ci-green']);
    await wf.drain();
    expect(w.reviewRuns).toEqual([{ incidentId: INC, prNumber: PR, headSha: HEAD2 }]);
  });

  it('head moved twice: gives up after one re-evaluation and appends nothing but the CI result', async () => {
    const w = await setup();
    w.github.mergeAnswers = [new HttpError(409, 'Head branch was modified'), new HttpError(409, 'Head branch was modified')];
    const before = (await log()).length;
    expect(await evaluateMerge(w.deps, { incidentId: INC })).toEqual({ outcome: 'skipped', reason: 'head-moved' });
    expect(w.github.merges).toHaveLength(2);
    expect(await typesAfter(before)).toEqual(['ci-green']);
  });

  it('once the new head is approved too, the merge is pinned to it (#264)', async () => {
    const w = await setup();
    w.github.pr = { ...w.github.pr, headSha: HEAD2 };
    expect(await evaluateMerge(w.deps, { incidentId: INC })).toEqual({ outcome: 'waiting', on: 'review' });
    await append(await approved(HEAD2));
    expect((await evaluateMerge(w.deps, { incidentId: INC })).outcome).toBe('merged');
    expect(w.github.merges).toEqual([{ number: PR, expectedHeadSha: HEAD2 }]);
    expect(w.github.compared).toEqual([{ base: 'main', head: HEAD2 }]);
    expect(w.github.statusFor.at(-1)).toEqual({ sha: HEAD2, base: 'main' });
  });

  it('GitHub refuses the merge (405): held, never retried as a pass', async () => {
    const w = await setup();
    w.github.mergeAnswers = [new HttpError(405, 'Required status check "ci" is expected.')];
    const out = await evaluateMerge(w.deps, { incidentId: INC });
    expect(out).toMatchObject({ outcome: 'held', reason: 'merge refused by GitHub: GitHub API 405: Required status check "ci" is expected.' });
    expect(await types()).not.toContain('merged');
  });

  it('a PR that is no longer open is skipped', async () => {
    const w = await setup();
    w.github.pr = { ...w.github.pr, state: 'closed' };
    expect(await evaluateMerge(w.deps, { incidentId: INC })).toEqual({ outcome: 'skipped', reason: 'not-open' });
  });
});

describe(`merge.evaluate is pinned to the reviewed commit (${TEST_DIALECT}; #264)`, () => {
  it('a push after the review: nothing merges, nothing about the new head is read, and its review starts', async () => {
    const w = await setup();
    w.github.pr = { ...w.github.pr, headSha: HEAD2 };
    const before = (await log()).length;
    expect(await evaluateMerge(w.deps, { incidentId: INC })).toEqual({ outcome: 'waiting', on: 'review' });
    expect(w.github.merges).toEqual([]);
    expect(w.github.compared).toEqual([]);
    // CI is recorded for the PR's head as before; it never stands in for that head's review.
    expect(await typesAfter(before)).toEqual(['ci-green']);
    expect((await lastOf('ci-green'))?.payload.headSha).toBe(HEAD2);
    // Asked again while that review is queued: the same job, no second one.
    expect(await evaluateMerge(w.deps, { incidentId: INC })).toEqual({ outcome: 'waiting', on: 'review' });
    await wf.drain();
    expect(w.reviewRuns).toEqual([{ incidentId: INC, prNumber: PR, headSha: HEAD2 }]);
  });

  it('a v1 review-passed (recorded before heads were pinned) reads back as v2 without a head, and never merges', async () => {
    const w = await setup({ toCi: false });
    await append(...toPr(), ev('review-passed', { prNumber: PR, review: await reviewArtifact('approve') }));
    const stored = await lastOf('review-passed');
    expect(stored?.v).toBe(2);
    expect(stored?.payload).not.toHaveProperty('headSha');
    expect(await evaluateMerge(w.deps, { incidentId: INC })).toEqual({ outcome: 'waiting', on: 'review' });
    expect(w.github.merges).toEqual([]);
    await wf.drain();
    expect(w.reviewRuns).toEqual([{ incidentId: INC, prNumber: PR, headSha: HEAD }]);
  });

  it('reads the files, the checks, and merges for exactly the reviewed commit', async () => {
    const w = await setup();
    expect((await evaluateMerge(w.deps, { incidentId: INC })).outcome).toBe('merged');
    expect(w.github.compared).toEqual([{ base: 'main', head: HEAD }]);
    expect(w.github.statusFor.at(-1)).toEqual({ sha: HEAD, base: 'main' });
    expect(w.github.merges).toEqual([{ number: PR, expectedHeadSha: HEAD }]);
  });

  it('a file renamed out of a forbidden path is a risk gate failure by its old path', async () => {
    const w = await setup();
    w.github.files = [{ filename: 'src/deploy.tf', previousFilename: 'infra/deploy.tf', additions: 0, deletions: 0 }];
    const out = await evaluateMerge(w.deps, { incidentId: INC });
    expect(out).toMatchObject({ outcome: 'held', reason: 'risk gate: forbidden paths touched: infra/deploy.tf', gate: { riskGate: { forbiddenHits: ['infra/deploy.tf'] } } });
    expect(w.github.merges).toEqual([]);
  });

  it('a file list GitHub cut short fails the risk gate', async () => {
    const w = await setup();
    w.github.filesComplete = false;
    const out = await evaluateMerge(w.deps, { incidentId: INC });
    expect(out).toMatchObject({ outcome: 'held', reason: 'risk gate: the list of changed files is incomplete' });
    expect(w.github.merges).toEqual([]);
  });
});

describe(`revert (${TEST_DIALECT})`, () => {
  it('inside the window: opens a revert PR, appends reverted and level-changed to 2, and cancels the window timer', async () => {
    const w = await setup();
    await evaluateMerge(w.deps, { incidentId: INC });
    await advance(10 * HOUR);
    const before = (await log()).length;

    const out = await revert(w.deps, INC, ENGINEER, { ...AS_DANA, source: 'slack' });
    expect(out).toEqual({ reverted: true, prNumber: PR, revertPrNumber: 420, revertPrUrl: 'https://github.com/fake-org/web/pull/420' });
    // Opened as Dana, with her own token, never as the App (#264).
    expect(w.github.reverts).toEqual([
      {
        number: PR,
        title: 'Revert #418 for WEB-1042',
        body: 'Reverts #418, merged automatically by Snapwing. Revert requested by U-FAKE-DANA.',
        userToken: 'test-user-token-dana',
      },
    ]);
    expect(await typesAfter(before)).toEqual(['reverted', 'level-changed']);
    const reverted = await lastOf('reverted');
    expect(reverted?.payload).toEqual({ prNumber: PR, revertPrNumber: 420 });
    expect(reverted?.actor).toEqual(ENGINEER);
    expect((await lastOf('level-changed'))?.payload).toEqual({ from: 3, to: 2, reason: 'reverted: PR #418 reverted by U-FAKE-DANA' });
    expect(await status()).toBe('reverted');

    // The timer was cancelled: nothing fires at the end of the window.
    await advance(72 * HOUR);
    expect(w.windowClosed).toEqual([]);

    expect(await revert(w.deps, INC, ENGINEER, AS_DANA)).toEqual({ reverted: false, reason: 'already-reverted' });
    expect(w.github.reverts).toHaveLength(1);
  });

  it('a Revert whose button names another merge than the latest is refused as out of date, and nothing is opened (#264)', async () => {
    const w = await setup();
    await evaluateMerge(w.deps, { incidentId: INC });
    const before = (await log()).length;
    expect(await revert(w.deps, INC, ENGINEER, { ...AS_DANA, pin: { prNumber: PR, sha: HEAD } })).toEqual({ reverted: false, reason: 'stale-card' });
    expect(await revert(w.deps, INC, ENGINEER, { ...AS_DANA, pin: { prNumber: 417, sha: MERGE_SHA } })).toEqual({ reverted: false, reason: 'stale-card' });
    expect(w.github.reverts).toEqual([]);
    expect(await typesAfter(before)).toEqual([]);
  });

  it('GitHub refusing the person (a dead link, no access) is a refusal, and nothing is recorded', async () => {
    const w = await setup();
    await evaluateMerge(w.deps, { incidentId: INC });
    const before = (await log()).length;
    w.github.revertError = new HttpError(401, 'Bad credentials');
    expect(await revert(w.deps, INC, ENGINEER, AS_DANA)).toEqual({ reverted: false, reason: 'not-linked' });
    w.github.revertError = new HttpError(403, 'Resource not accessible by integration');
    expect(await revert(w.deps, INC, ENGINEER, AS_DANA)).toEqual({ reverted: false, reason: 'forbidden' });
    expect(await typesAfter(before)).toEqual([]);
  });

  it('after the timer fires the action is refused and nothing is opened', async () => {
    const w = await setup();
    await evaluateMerge(w.deps, { incidentId: INC });
    await advance(72 * HOUR);
    expect(w.windowClosed).toEqual([INC]);
    const before = (await log()).length;
    expect(await revert(w.deps, INC, ENGINEER, AS_DANA)).toEqual({ reverted: false, reason: 'window-closed' });
    expect(w.github.reverts).toEqual([]);
    expect(await typesAfter(before)).toEqual([]);
  });

  it('is refused one millisecond before the end of the window is still allowed', async () => {
    const w = await setup();
    await evaluateMerge(w.deps, { incidentId: INC });
    now += 72 * HOUR - 1;
    expect((await revert(w.deps, INC, ENGINEER, AS_DANA)).reverted).toBe(true);
  });

  it('refuses with no merge, and for a merge a human made (no window)', async () => {
    const w = await setup();
    expect(await revert(w.deps, INC, ENGINEER, AS_DANA)).toEqual({ reverted: false, reason: 'not-merged' });
    await append(ev('ci-green', { prNumber: PR, headSha: HEAD }, 'github'), ev('merged', { prNumber: PR, mergeCommitSha: MERGE_SHA, levelAtMergeTime: 2 }, 'github'));
    expect(await revert(w.deps, INC, ENGINEER, AS_DANA)).toEqual({ reverted: false, reason: 'not-autopilot' });
    expect(w.github.reverts).toEqual([]);
  });
});
