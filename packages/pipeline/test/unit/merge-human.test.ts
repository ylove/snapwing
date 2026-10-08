// Human in the loop (main 11.2, main 16, main 20.2): reviewer resolution from CODEOWNERS and the
// map, the pr-ready card, and the PR buttons acting as the linked human. Runs over the dialect
// `SNAPWING_DB` selects with the in-process workflow, and fakes for GitHub, CODEOWNERS, linked
// identities, and chat. The log is built up to `ci` (review passed) the way the fixer and review jobs
// leave it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrReadyCard } from '../../src/contracts/adapters.ts';
import type { EventActor, EventPayloads, EventType, IncidentEvent, NewEvent } from '../../src/contracts/events.ts';
import type { FixerRunData } from '../../src/contracts/jobs.ts';
import type { StopInput, StopOutcome } from '../../src/fixer/stop.ts';
import { latest } from '../../src/fixer/job.ts';
import {
  createPrActions,
  humanMerge,
  humanRequestChanges,
  humanRevert,
  humanStop,
  PrActionRefusedError,
  type PrActionsDeps,
} from '../../src/merge/actions.ts';
import {
  ciState,
  requestHumanReview,
  resolveReviewers,
  type ChatTarget,
  type ChatUserRef,
  type CodeownersLookup,
  type HumanGitHub,
  type HumanMap,
  type HumanPullRequest,
  type HumanReviewDeps,
  type IdentityLinks,
  type PrReadyChat,
} from '../../src/merge/human.ts';
import type { MergeResult } from '../../src/merge/job.ts';
import type { RevertOptions, RevertOutcome } from '../../src/merge/revert.ts';
import type { CachePort } from '../../src/ports/cache.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { InProcessWorkflow } from '../../src/workflow/inprocess/index.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../helpers/db.ts';

const T0 = Date.parse('2026-10-02T09:00:00.000Z');
const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6HUMANINC00000000000000';
const REPO = 'fake-org/web';
const PR = 418;
const HEAD = 'a'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);
const THREAD_CHANNEL = 'C-FAKE-THREAD';
const THREAD_TS = '1700000000.000100';
const BUG_CHANNEL = 'C-FAKE-WEB-BUGS';

const DANA = 'U-FAKE-DANA'; // engineer, owns web/checkout, linked as dana-gh
const LEE = 'U-FAKE-LEE'; // engineer, owns web, not linked, handle lee-gh
const PAT = 'U-FAKE-PAT'; // reporter, linked as pat-gh
const SAM = 'U-FAKE-SAM'; // engineer, owns api, linked as sam-gh

const MAP: HumanMap = {
  channels: [
    { id: 'C-FAKE-API-BUGS', name: 'api-bugs', surface: 'api', triggerEmoji: [] },
    { id: BUG_CHANNEL, name: 'web-bugs', surface: 'web', triggerEmoji: [] },
  ],
  people: [
    { slackId: DANA, handle: 'dana', email: 'dana@example.test', role: 'engineer', owns: [{ surface: 'web', component: 'checkout', primary: true }] },
    { slackId: LEE, handle: 'lee-gh', email: 'lee@example.test', role: 'engineer', owns: [{ surface: 'web', primary: false }] },
    { slackId: PAT, handle: 'pat', role: 'reporter', owns: [] },
    { slackId: SAM, handle: 'sam', role: 'engineer', owns: [{ surface: 'api', primary: true }] },
  ],
};

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

class FakeGitHub implements HumanGitHub {
  pr: HumanPullRequest = {
    number: PR,
    state: 'open',
    merged: false,
    htmlUrl: `https://github.com/${REPO}/pull/${String(PR)}`,
    headSha: HEAD,
    baseRef: 'main',
    authorLogin: 'snapwing-test[bot]',
    additions: 41,
    deletions: 6,
    changedFiles: 2,
    requestedReviewers: [],
  };
  files = [{ filename: 'src/checkout/cart.ts' }, { filename: 'test/checkout/cart.test.ts' }];
  required: { name: string; state: 'success' | 'pending' | 'failure'; source: string | null }[] = [{ name: 'ci', state: 'success', source: 'check-run' }];
  /** Logins GitHub refuses as reviewers (not collaborators): any request naming one is a 422. */
  notCollaborators = new Set<string>();
  readonly reviewRequests: { users?: readonly string[]; teams?: readonly string[] }[] = [];
  readonly merges: { number: number; expectedHeadSha: string; userToken?: string }[] = [];
  mergeAnswers: (MergeResult | Error)[] = [];

  getPullRequest(): Promise<HumanPullRequest> {
    return Promise.resolve({ ...this.pr, requestedReviewers: [...this.pr.requestedReviewers] });
  }

  listPullRequestFiles(): Promise<readonly { filename: string }[]> {
    return Promise.resolve(this.files.map((f) => ({ ...f })));
  }

  combinedStatus(): Promise<{ required: FakeGitHub['required'] }> {
    return Promise.resolve({ required: this.required.map((c) => ({ ...c })) });
  }

  requestReviewers(_number: number, reviewers: { users?: readonly string[]; teams?: readonly string[] }): Promise<void> {
    this.reviewRequests.push(reviewers);
    if ((reviewers.users ?? []).some((u) => this.notCollaborators.has(u))) return Promise.reject(new HttpError(422, 'Reviews may only be requested from collaborators'));
    this.pr.requestedReviewers = [...this.pr.requestedReviewers, ...(reviewers.users ?? [])];
    return Promise.resolve();
  }

  mergePullRequest(number: number, input: { expectedHeadSha: string; userToken?: string }): Promise<MergeResult> {
    this.merges.push({ number, ...input });
    const answer = this.mergeAnswers.shift() ?? { merged: true, sha: MERGE_SHA, message: 'Pull Request successfully merged' };
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }
}

class FakeCodeowners implements CodeownersLookup {
  owners: string[] = [];
  readonly asked: (readonly string[])[] = [];
  codeownersFor(paths: readonly string[]): Promise<{ owners: readonly string[] }> {
    this.asked.push(paths);
    return Promise.resolve({ owners: [...this.owners] });
  }
}

class FakeIdentity implements IdentityLinks {
  /** Chat user id to GitHub login. */
  readonly links = new Map<string, string>([
    [DANA, 'dana-gh'],
    [PAT, 'pat-gh'],
    [SAM, 'sam-gh'],
  ]);
  readonly tokensIssued: string[] = [];

  linkUrl(user: ChatUserRef): Promise<string> {
    return Promise.resolve(`https://snapwing.example.test/auth/github/start?state=test-state-${user.userId}`);
  }
  getLinkedIdentity(user: ChatUserRef): Promise<{ githubLogin: string } | null> {
    const login = this.links.get(user.userId);
    return Promise.resolve(login === undefined ? null : { githubLogin: login });
  }
  isLinked(user: ChatUserRef): Promise<boolean> {
    return Promise.resolve(this.links.has(user.userId));
  }
  userToken(user: ChatUserRef): Promise<{ token: string; githubLogin: string } | null> {
    const login = this.links.get(user.userId);
    if (login === undefined) return Promise.resolve(null);
    this.tokensIssued.push(user.userId);
    return Promise.resolve({ token: `test-user-token-${login}`, githubLogin: login });
  }
}

class FakeChat implements PrReadyChat {
  readonly cards: { target: ChatTarget; card: PrReadyCard; canMerge: boolean }[] = [];
  readonly prompts: { userId: string; target: ChatTarget; card: PrReadyCard; linkUrl: string }[] = [];
  postPrReady(target: ChatTarget, _incidentId: string, card: PrReadyCard, opts: { canMerge: boolean }): Promise<void> {
    this.cards.push({ target, card, canMerge: opts.canMerge });
    return Promise.resolve();
  }
  postLinkPrompt(userId: string, target: ChatTarget, _incidentId: string, card: PrReadyCard, linkUrl: string): Promise<void> {
    this.prompts.push({ userId, target, card, linkUrl });
    return Promise.resolve();
  }
}

class MemoryCache implements CachePort {
  readonly values = new Map<string, string>();
  get(k: string): Promise<string | null> {
    return Promise.resolve(this.values.get(k) ?? null);
  }
  set(k: string, v: string): Promise<void> {
    this.values.set(k, v);
    return Promise.resolve();
  }
  setIfAbsent(k: string, v: string): Promise<boolean> {
    if (this.values.has(k)) return Promise.resolve(false);
    this.values.set(k, v);
    return Promise.resolve(true);
  }
  delete(k: string): Promise<void> {
    this.values.delete(k);
    return Promise.resolve();
  }
}

interface World {
  deps: HumanReviewDeps & PrActionsDeps;
  github: FakeGitHub;
  codeowners: FakeCodeowners;
  identity: FakeIdentity;
  chat: FakeChat;
  stops: StopInput[];
  reverts: { incidentId: string; actor: EventActor; opts?: RevertOptions }[];
  fixerRuns: FixerRunData[];
}

async function setup(opts: { level?: 1 | 2 | 3; toCi?: boolean; source?: 'slack' | 'teams'; map?: HumanMap } = {}): Promise<World> {
  const github = new FakeGitHub();
  const codeowners = new FakeCodeowners();
  const identity = new FakeIdentity();
  const chat = new FakeChat();
  const stops: StopInput[] = [];
  const reverts: World['reverts'] = [];
  const fixerRuns: FixerRunData[] = [];
  const deps: World['deps'] = {
    workspaceId: WS,
    state,
    workflow: wf,
    chat: 'slack',
    github: (repo) => {
      if (repo !== REPO) throw new Error(`unexpected repo ${repo}`);
      return github;
    },
    codeowners: (repo) => {
      if (repo !== REPO) throw new Error(`unexpected repo ${repo}`);
      return codeowners;
    },
    identity,
    map: () => Promise.resolve(opts.map ?? MAP),
    clock: () => new Date(now),
    chatOut: chat,
    cache: new MemoryCache(),
    onError: (e) => errors.push(e),
    stopIncident: (input) => {
      stops.push(input);
      return Promise.resolve({ stopped: true } satisfies StopOutcome);
    },
    revert: (incidentId, actor, revertOpts) => {
      reverts.push({ incidentId, actor, ...(revertOpts === undefined ? {} : { opts: revertOpts }) });
      return Promise.resolve({ reverted: true, prNumber: PR, revertPrNumber: 420, revertPrUrl: `https://github.com/${REPO}/pull/420` } satisfies RevertOutcome);
    },
  };
  wf.work('fixer.run', (job) => {
    fixerRuns.push(job.data as FixerRunData);
    return Promise.resolve();
  });
  await append(...toFiled(opts.level ?? 2, opts.source));
  if (opts.toCi !== false) {
    await append(...toPr());
    await append(ev('review-passed', { prNumber: PR, review: await reviewArtifact('approve') }));
  }
  return { deps, github, codeowners, identity, chat, stops, reverts, fixerRuns };
}

function ev<T extends EventType>(type: T, payload: EventPayloads[T], source: 'agent' | 'fixer' | 'github' = 'agent'): NewEvent<T> {
  return { workspaceId: WS, incidentId: INC, type, v: 1, source, occurredAt: new Date(now).toISOString(), payload } as unknown as NewEvent<T>;
}

function toFiled(level: 1 | 2 | 3, source: 'slack' | 'teams' = 'slack'): NewEvent[] {
  return [
    ev('captured', {
      kind: 'incident',
      idempotencyKey: `${source}:${THREAD_CHANNEL}:${INC}`,
      source: source,
      reporter: { id: PAT, name: 'Pat', role: 'reporter' },
      anchorText: 'Checkout says 500',
      channelId: THREAD_CHANNEL,
      threadId: THREAD_TS,
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

function toPr(): NewEvent[] {
  return [
    ev('fixer-started', { runId: '01K6RUN0000000000000000001', harness: 'claude-code', attempt: 1 }),
    ev('fixer-done', { prNumber: PR, branch: 'fix/WEB-1042', summary: 'Guard the null cart', testsAdded: ['test/checkout/cart.test.ts'] }, 'fixer'),
    ev('pr-opened', { prNumber: PR, branch: 'fix/WEB-1042' }, 'fixer'),
  ];
}

async function reviewArtifact(verdict: 'approve' | 'request-changes'): Promise<{ artifactId: string; version: number }> {
  const body = JSON.stringify({ verdict, reasons: verdict === 'approve' ? [] : ['scope'], constraintViolations: [] });
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

async function typesAfter(count: number): Promise<EventType[]> {
  return (await log()).slice(count).map((e) => e.type);
}

async function status(): Promise<string | undefined> {
  return (await state.getIncident(INC))?.status;
}

const tap = (userId: string, extra: { prNumber?: number; comment?: string } = {}) => ({
  incidentId: INC,
  // The role the caller claims is ignored; the map's is used.
  actor: { id: userId, role: 'engineer' as const },
  prNumber: PR,
  repo: REPO,
  ...extra,
});

// Reviewer resolution -----------------------------------------------------------------------------

describe(`resolveReviewers (${TEST_DIALECT})`, () => {
  it('CODEOWNERS for the touched paths: users, teams by slug, emails the map knows; linked logins win over handles', async () => {
    const w = await setup();
    w.codeowners.owners = ['@someone-else', '@fake-org/web-team', 'dana@example.test', 'nobody@example.test', '@snapwing-test[bot]'];
    const r = await resolveReviewers(w.deps, { repo: REPO, paths: ['src/checkout/cart.ts'], surfaceId: 'web', authorLogin: 'snapwing-test[bot]' });
    expect(w.codeowners.asked).toEqual([['src/checkout/cart.ts']]);
    expect(r.source).toBe('codeowners');
    // dana's email resolves to her linked login, not her map handle; the PR author is left out.
    expect(r.users).toEqual(['someone-else', 'dana-gh']);
    expect(r.teams).toEqual(['web-team']);
    expect(r.people).toEqual([{ handle: 'dana', chatUserId: DANA, login: 'dana-gh', linked: true }]);
  });

  it('a CODEOWNERS login matches a map person through their linked identity, case-insensitively', async () => {
    const w = await setup();
    w.codeowners.owners = ['@Dana-GH', '@lee-gh'];
    const r = await resolveReviewers(w.deps, { repo: REPO, paths: ['src/checkout/cart.ts'], surfaceId: 'web' });
    expect(r.users).toEqual(['Dana-GH', 'lee-gh']);
    expect(r.people.map((p) => [p.chatUserId, p.linked])).toEqual([
      [DANA, true],
      [LEE, false],
    ]);
  });

  it('no CODEOWNERS owner: falls back to the map people who own the component, else the surface', async () => {
    const w = await setup();
    const component = await resolveReviewers(w.deps, { repo: REPO, paths: ['src/checkout/cart.ts'], surfaceId: 'web', componentId: 'checkout' });
    expect(component.source).toBe('map');
    expect(component.users).toEqual(['dana-gh']);

    const surface = await resolveReviewers(w.deps, { repo: REPO, paths: ['src/search.ts'], surfaceId: 'web', componentId: 'search' });
    expect(surface.source).toBe('map');
    // lee is not linked, so their map handle is their login.
    expect(surface.users).toEqual(['dana-gh', 'lee-gh']);
    expect(surface.people.map((p) => p.chatUserId)).toEqual([DANA, LEE]);

    const none = await resolveReviewers(w.deps, { repo: REPO, paths: ['x'] });
    expect(none).toEqual({ source: 'map', users: [], teams: [], people: [] });
  });

  it('ciState reads the required checks, else everything reported', () => {
    expect(ciState({ required: [{ name: 'ci', state: 'success', source: 'check-run' }] })).toBe('green');
    expect(ciState({ required: [{ name: 'ci', state: 'success', source: null }] })).toBe('pending');
    expect(ciState({ required: [{ name: 'ci', state: 'failure', source: 'status' }] })).toBe('red');
    expect(ciState({ required: [], all: [{ state: 'success' }] })).toBe('green');
    expect(ciState({ required: [] })).toBe('pending');
  });
});

// The card ----------------------------------------------------------------------------------------

describe(`requestHumanReview (${TEST_DIALECT})`, () => {
  it('review-passed at level 2: requests the surface owners, posts the card in the thread and the bug channel, prompts the unlinked reviewer', async () => {
    const w = await setup({ level: 2 });
    const out = await requestHumanReview(w.deps, INC);
    expect(out.requested).toBe(true);
    if (!out.requested) return;

    expect(out.reviewers.source).toBe('map');
    expect(w.github.reviewRequests).toEqual([{ users: ['dana-gh'] }]);
    const card: PrReadyCard = {
      kind: 'pr-ready',
      prNumber: PR,
      prUrl: `https://github.com/${REPO}/pull/${String(PR)}`,
      issueKey: 'WEB-1042',
      reviewVerdict: 'approve',
      ciState: 'green',
      filesChanged: 2,
      additions: 41,
      deletions: 6,
      reviewerUserIds: [DANA],
    };
    expect(w.chat.cards).toEqual([
      { target: { channel: THREAD_CHANNEL, threadId: THREAD_TS }, card, canMerge: true },
      { target: { channel: BUG_CHANNEL }, card, canMerge: true },
    ]);
    expect(w.chat.prompts).toEqual([]);
  });

  describe('the bug channel is on the platform of the incident', () => {
    const TEAMS_BUGS = '19:fake-web-bugs@thread.tacv2';
    const BOTH: HumanMap = {
      ...MAP,
      channels: [
        { id: TEAMS_BUGS, name: 'web-bugs-teams', surface: 'web', platform: 'teams', teamId: 'fake-team', triggerEmoji: [] },
        { id: BUG_CHANNEL, name: 'web-bugs', surface: 'web', triggerEmoji: [] },
      ],
    };
    const SLACK_ONLY: HumanMap = { ...MAP, channels: [{ id: BUG_CHANNEL, name: 'web-bugs', surface: 'web', triggerEmoji: [] }] };

    it('a Teams incident posts to the Teams channel, not the Slack one', async () => {
      const w = await setup({ source: 'teams', map: BOTH });
      await requestHumanReview(w.deps, INC);
      expect(w.chat.cards.map((c) => c.target.channel)).toEqual([THREAD_CHANNEL, TEAMS_BUGS]);
    });

    it('a Slack incident posts to the Slack channel, not the Teams one', async () => {
      const w = await setup({ source: 'slack', map: BOTH });
      await requestHumanReview(w.deps, INC);
      expect(w.chat.cards.map((c) => c.target.channel)).toEqual([THREAD_CHANNEL, BUG_CHANNEL]);
    });

    it('a surface with a channel only on the other platform posts to the thread only', async () => {
      const w = await setup({ source: 'teams', map: SLACK_ONLY });
      await requestHumanReview(w.deps, INC);
      expect(w.chat.cards.map((c) => c.target.channel)).toEqual([THREAD_CHANNEL]);
    });
  });

  it('an unlinked reviewer gets the Open PR only card and the link to /auth/github/start; with no linked reviewer the card has no Merge', async () => {
    const w = await setup({ level: 1 });
    w.codeowners.owners = ['@lee-gh'];
    const out = await requestHumanReview(w.deps, INC);
    expect(out).toMatchObject({ requested: true, canMerge: false, linkPrompts: [LEE] });
    expect(w.github.reviewRequests).toEqual([{ users: ['lee-gh'] }]);
    expect(w.chat.cards.map((c) => [c.target.channel, c.canMerge, c.card.reviewerUserIds])).toEqual([
      [THREAD_CHANNEL, false, [LEE]],
      [BUG_CHANNEL, false, [LEE]],
    ]);
    expect(w.chat.prompts).toHaveLength(1);
    expect(w.chat.prompts[0]).toMatchObject({ userId: LEE, target: { channel: THREAD_CHANNEL, threadId: THREAD_TS } });
    expect(w.chat.prompts[0]?.linkUrl).toMatch(/\/auth\/github\/start\?state=/);
  });

  it('is idempotent: a second call posts nothing and requests nobody twice', async () => {
    const w = await setup({ level: 2 });
    w.codeowners.owners = ['@dana-gh', '@lee-gh'];
    await requestHumanReview(w.deps, INC);
    const again = await requestHumanReview(w.deps, INC);
    expect(again).toMatchObject({ requested: true, posted: [], linkPrompts: [] });
    expect(w.github.reviewRequests).toEqual([{ users: ['dana-gh', 'lee-gh'] }]);
    expect(w.chat.cards).toHaveLength(2);
    expect(w.chat.prompts).toHaveLength(1);
  });

  it('a 422 (not a collaborator) retries one reviewer at a time and reports the refused', async () => {
    const w = await setup({ level: 2 });
    w.codeowners.owners = ['@dana-gh', '@outsider', '@fake-org/web-team'];
    w.github.notCollaborators.add('outsider');
    const out = await requestHumanReview(w.deps, INC);
    expect(out).toMatchObject({ requested: true, refused: ['outsider'] });
    expect(w.github.reviewRequests).toEqual([
      { users: ['dana-gh', 'outsider'], teams: ['web-team'] },
      { users: ['dana-gh'] },
      { users: ['outsider'] },
      { teams: ['web-team'] },
    ]);
    expect(w.chat.cards).toHaveLength(2);
  });

  it('level 3 waits for the merge step; after a gate hold the human path starts', async () => {
    const w = await setup({ level: 3 });
    expect(await requestHumanReview(w.deps, INC)).toEqual({ requested: false, reason: 'level' });
    expect(w.chat.cards).toEqual([]);

    const reason = 'risk gate: infra/main.tf is forbidden';
    await append(ev('held', { kind: 'gate', reason }), ev('level-changed', { from: 3, to: 2, reason: `merge-held: ${reason}` }));
    const out = await requestHumanReview(w.deps, INC);
    expect(out.requested).toBe(true);
    expect(w.chat.cards).toHaveLength(2);
  });

  it('skips a PR that is not reviewed, stopped, merged, or closed', async () => {
    const w = await setup({ level: 2, toCi: false });
    expect(await requestHumanReview(w.deps, INC)).toEqual({ requested: false, reason: 'no-pr' });
    await append(...toPr());
    expect(await requestHumanReview(w.deps, INC)).toEqual({ requested: false, reason: 'not-reviewed' });
    await append(ev('review-passed', { prNumber: PR, review: await reviewArtifact('approve') }));
    w.github.pr.state = 'closed';
    expect(await requestHumanReview(w.deps, INC)).toEqual({ requested: false, reason: 'not-open' });
    await append(ev('stopped', {}));
    expect(await requestHumanReview(w.deps, INC)).toEqual({ requested: false, reason: 'stopped' });
    expect(w.chat.cards).toEqual([]);
  });
});

// The buttons -------------------------------------------------------------------------------------

describe(`PR actions (${TEST_DIALECT})`, () => {
  it('merge: a linked requested reviewer merges with their own token, pinned to the head; merged names them', async () => {
    const w = await setup({ level: 2 });
    w.github.pr.requestedReviewers = ['dana-gh'];
    const before = (await log()).length;

    const out = await humanMerge(w.deps, tap(DANA));
    expect(out).toEqual({ done: true, action: 'merge', prNumber: PR, mergeCommitSha: MERGE_SHA, githubLogin: 'dana-gh' });
    expect(w.github.merges).toEqual([{ number: PR, expectedHeadSha: HEAD, userToken: 'test-user-token-dana-gh' }]);
    expect(await typesAfter(before)).toEqual(['ci-green', 'merged']);
    const merged = latest(await log(), 'merged');
    expect(merged?.payload).toEqual({ prNumber: PR, mergeCommitSha: MERGE_SHA, levelAtMergeTime: 2 });
    expect(merged?.actor).toEqual({ id: DANA, role: 'engineer' });
    expect(merged?.source).toBe('slack');
    expect(await status()).toBe('merged');

    // A second tap: already merged, nothing sent to GitHub.
    expect(await humanMerge(w.deps, tap(DANA))).toMatchObject({ done: false, reason: 'merged' });
    expect(w.github.merges).toHaveLength(1);
  });

  it('merge: a reviewer GitHub dropped from the requested list after reviewing still merges (CODEOWNERS re-resolved)', async () => {
    const w = await setup({ level: 1 });
    w.codeowners.owners = ['@dana-gh'];
    w.github.pr.requestedReviewers = [];
    expect(await humanMerge(w.deps, tap(DANA))).toMatchObject({ done: true, githubLogin: 'dana-gh' });
  });

  it('merge: a user without a linked identity is refused with the link, and nothing reaches GitHub', async () => {
    const w = await setup({ level: 2 });
    w.github.pr.requestedReviewers = ['lee-gh'];
    const before = (await log()).length;
    const out = await humanMerge(w.deps, tap(LEE));
    expect(out).toMatchObject({ done: false, action: 'merge', reason: 'not-linked', deny: 'linked-identity-required' });
    expect(out.done === false ? out.linkUrl : '').toMatch(/\/auth\/github\/start\?state=test-state-U-FAKE-LEE$/);
    expect(w.github.merges).toEqual([]);
    expect(w.identity.tokensIssued).toEqual([]);
    expect(await typesAfter(before)).toEqual([]);

    // Through the PrActions interface the refusal rejects, so the card is never marked merged.
    const actions = createPrActions(w.deps);
    await expect(actions.merge(tap(LEE))).rejects.toBeInstanceOf(PrActionRefusedError);
  });

  it('merge: a linked user who is not a reviewer is refused', async () => {
    const w = await setup({ level: 2 });
    w.github.pr.requestedReviewers = ['dana-gh'];
    w.codeowners.owners = ['@dana-gh'];
    const out = await humanMerge(w.deps, tap(SAM));
    expect(out).toMatchObject({ done: false, reason: 'not-reviewer' });
    expect(w.github.merges).toEqual([]);
    await expect(createPrActions(w.deps).merge(tap(SAM))).rejects.toThrow(/requested reviewer/);
  });

  it('merge: GitHub refusals come back as refusals (405 branch protection, 409 head moved), and nothing is recorded', async () => {
    const w = await setup({ level: 2 });
    w.github.pr.requestedReviewers = ['dana-gh'];
    const before = (await log()).length;
    w.github.mergeAnswers = [new HttpError(405, 'At least 1 approving review is required'), new HttpError(409, 'Head branch was modified')];
    const first = await humanMerge(w.deps, tap(DANA));
    expect(first).toMatchObject({ done: false, reason: 'not-mergeable' });
    expect(first.done === false ? first.message : '').toMatch(/approving review is required/);
    expect(await humanMerge(w.deps, tap(DANA))).toMatchObject({ done: false, reason: 'head-moved' });
    expect(await typesAfter(before)).toEqual([]);
  });

  it('merge: a tap on an older PR card is refused', async () => {
    const w = await setup({ level: 2 });
    w.github.pr.requestedReviewers = ['dana-gh'];
    expect(await humanMerge(w.deps, tap(DANA, { prNumber: 417 }))).toMatchObject({ done: false, reason: 'stale-pr' });
    expect(w.github.merges).toEqual([]);
  });

  it('merge: at level 3 the agent merges, not a human', async () => {
    const w = await setup({ level: 3 });
    w.github.pr.requestedReviewers = ['dana-gh'];
    expect(await humanMerge(w.deps, tap(DANA))).toMatchObject({ done: false, reason: 'denied', deny: 'agent-merges' });
    expect(w.github.merges).toEqual([]);
  });

  it('request changes: restarts the fixer once with the comment as the prior review', async () => {
    const w = await setup({ level: 2 });
    const before = (await log()).length;
    const out = await humanRequestChanges(w.deps, tap(DANA, { comment: 'Keep the old error message for API clients.' }));
    expect(out).toMatchObject({ done: true, action: 'request_changes', prNumber: PR, attempt: 2 });
    if (!out.done || out.action !== 'request_changes') return;

    const artifact = await state.getArtifact(out.review.artifactId, out.review.version);
    expect(artifact.kind).toBe('review');
    expect(JSON.parse(artifact.body)).toEqual({ verdict: 'request-changes', reasons: ['Keep the old error message for API clients.'], constraintViolations: [] });
    expect(artifact.createdBy).toBe(DANA);

    expect(await typesAfter(before)).toEqual(['review-failed']);
    const failed = latest(await log(), 'review-failed');
    expect(failed?.payload).toMatchObject({ prNumber: PR, verdict: 'request-changes', review: out.review });
    expect(failed?.payload.reason).toBe(`changes-requested: by ${DANA}: Keep the old error message for API clients.`);
    expect(failed?.actor).toEqual({ id: DANA, role: 'engineer' });
    expect(await status()).toBe('fixing-retry');

    await wf.drain();
    expect(w.fixerRuns).toEqual([{ incidentId: INC, attempt: 2, reviewArtifact: out.review }]);

    // Once: a second request is refused and starts nothing.
    expect(await humanRequestChanges(w.deps, tap(DANA, { comment: 'And rename it.' }))).toMatchObject({ done: false, reason: 'already-requested' });
    await wf.drain();
    expect(w.fixerRuns).toHaveLength(1);
  });

  it('request changes: needs an engineer', async () => {
    const w = await setup({ level: 2 });
    expect(await humanRequestChanges(w.deps, tap(PAT, { comment: 'please' }))).toMatchObject({ done: false, reason: 'denied', deny: 'engineer-required' });
    await wf.drain();
    expect(w.fixerRuns).toEqual([]);
  });

  it('stop calls stopIncident with the tapper', async () => {
    const w = await setup({ level: 2 });
    expect(await humanStop(w.deps, { ...tap(PAT), reason: 'wrong fix' })).toMatchObject({ done: true, action: 'stop' });
    expect(w.stops).toEqual([{ incidentId: INC, actor: { id: PAT, role: 'reporter' }, source: 'slack', reason: 'wrong fix' }]);
  });

  it('revert authorizes first: an unlinked user never reaches revert; a linked one does', async () => {
    const w = await setup({ level: 3 });
    expect(await humanRevert(w.deps, tap(LEE))).toMatchObject({ done: false, reason: 'not-linked' });
    expect(w.reverts).toEqual([]);

    await createPrActions(w.deps).revert(tap(DANA));
    expect(w.reverts).toEqual([{ incidentId: INC, actor: { id: DANA, role: 'engineer' }, opts: { source: 'slack' } }]);
  });
});
